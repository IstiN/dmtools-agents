#!/usr/bin/env bash
# Runs `mvn spotbugs:check` scoped ONLY to the Maven module(s) actually touched by the
# current branch's changes, instead of the whole multi-module reactor.
#
# Why: spotbugs:check run on a full reactor also re-flags every pre-existing finding in
# modules the current ticket/PR never touched. On a large legacy codebase this routinely
# fails the gate on unrelated technical debt (e.g. SE_BAD_FIELD in a DTO class from a
# completely different module), which then blocks the whole rework/push flow for no reason
# connected to the actual change being reviewed.
#
# How it works:
#   1. Diff the current HEAD against a base ref (first argument, or auto-detected as
#      origin/master / origin/main) to get the list of changed *.java files.
#   2. For each changed file, walk up its directory tree to find the nearest pom.xml —
#      that directory is its Maven module.
#   3. Run `mvn -pl <module1>,<module2>,... compile spotbugs:check` scoped to just those
#      modules (NOT -am/--also-make, since the "compile" gate that runs immediately before
#      this one is expected to `mvn install` the full reactor first, publishing every
#      module's jar to the local repo so scoped builds can resolve cross-module
#      dependencies without rebuilding them).
#   4. If no changed .java file maps to any Maven module (e.g. only non-Java files
#      changed), the check is skipped entirely — nothing to scope it to.
#
# Usage:
#   bash spotbugs_diff_scope.sh <maven-root> <settings-path-relative-to-maven-root> [base-ref]
#
# Example (matches the gens-igt quality gate config):
#   bash agents/scripts/spotbugs_diff_scope.sh tools-app mvn/settings.xml
#
# Must be run with the working directory set to the target repo checkout (same
# `workingDir` used by the other feedbackLoop.qualityGates gate commands).
set -euo pipefail

MAVEN_ROOT="${1:?maven root required, e.g. tools-app}"
SETTINGS_PATH="${2:?settings path (relative to maven root) required, e.g. mvn/settings.xml}"
BASE_REF="${3:-}"

if [ -z "${BASE_REF}" ]; then
  for candidate in origin/master origin/main; do
    if git rev-parse --verify "${candidate}" >/dev/null 2>&1; then
      BASE_REF="${candidate}"
      break
    fi
  done
fi

if [ -z "${BASE_REF}" ]; then
  echo "spotbugs_diff_scope: could not determine a base ref to diff against (tried origin/master, origin/main) — skipping scoped spotbugs check"
  exit 0
fi

MERGE_BASE="$(git merge-base "${BASE_REF}" HEAD 2>/dev/null || echo "${BASE_REF}")"

CHANGED_FILES="$(git diff --name-only "${MERGE_BASE}"...HEAD -- '*.java' 2>/dev/null || true)"

if [ -z "${CHANGED_FILES}" ]; then
  echo "spotbugs_diff_scope: no changed .java files vs ${BASE_REF} — skipping spotbugs check"
  exit 0
fi

MODULE_LIST=""

module_already_listed() {
  case ",${MODULE_LIST}," in
    *",${1},"*) return 0 ;;
    *) return 1 ;;
  esac
}

while IFS= read -r file; do
  [ -z "${file}" ] && continue
  dir="$(dirname "${file}")"
  while [ -n "${dir}" ] && [ "${dir}" != "." ] && [ "${dir}" != "/" ]; do
    if [ -f "${dir}/pom.xml" ]; then
      case "${dir}" in
        "${MAVEN_ROOT}"/*)
          rel="${dir#"${MAVEN_ROOT}"/}"
          ;;
        "${MAVEN_ROOT}")
          rel="."
          ;;
        *)
          rel="${dir}"
          ;;
      esac
      if ! module_already_listed "${rel}"; then
        if [ -z "${MODULE_LIST}" ]; then
          MODULE_LIST="${rel}"
        else
          MODULE_LIST="${MODULE_LIST},${rel}"
        fi
      fi
      break
    fi
    dir="$(dirname "${dir}")"
  done
done <<< "${CHANGED_FILES}"

if [ -z "${MODULE_LIST}" ]; then
  echo "spotbugs_diff_scope: could not map any changed .java file to a Maven module under ${MAVEN_ROOT} — skipping spotbugs check"
  exit 0
fi

echo "spotbugs_diff_scope: scoping spotbugs:check to changed module(s): ${MODULE_LIST}"
mvn --batch-mode -f "${MAVEN_ROOT}/pom.xml" -s "${MAVEN_ROOT}/${SETTINGS_PATH}" -T 1C -pl "${MODULE_LIST}" compile spotbugs:check -q
