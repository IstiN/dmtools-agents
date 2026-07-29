#!/usr/bin/env bash
# Runs a local SpotBugs "new findings only" check, scoped ONLY to lines actually
# added/changed by the current branch — a fast local approximation of how modern
# SAST/SonarQube gates report "new issues" instead of every pre-existing finding.
#
# Why this exists: `mvn spotbugs:check` scoped only by MAVEN MODULE (compiling and
# checking every changed file's containing module) still re-flags every PRE-EXISTING
# finding across the ENTIRE touched module — including legacy technical debt the
# current change never touched. On a large legacy codebase this routinely fails the
# gate on unrelated findings that have nothing to do with the actual diff, which then
# forces exclude-file / suppression-plugin workarounds just to get an unrelated gate
# to pass — churn that fights code review (reviewers reasonably ask "why is this
# unrelated suppression config here?") and can flip back and forth across review
# rounds. This script gives a precise "did THIS diff introduce a new finding" signal
# instead, so pre-existing findings elsewhere in the module no longer block the gate.
#
# How it works:
#   1. Diff HEAD against a base ref (arg 3, or auto-detected origin/master / origin/main)
#      to find changed *.java files.
#   2. Map each changed file to its Maven module (nearest ancestor pom.xml).
#   3. Run `mvn spotbugs:spotbugs` (report-only — does NOT fail the build) scoped to
#      those modules (NOT -am, matching the compile gate's convention of installing
#      the full reactor first so scoped module builds can resolve cross-module
#      dependencies from the local repo), producing each module's
#      target/spotbugsXml.xml.
#   4. Parse every <BugInstance>'s <SourceLine sourcepath="..." start="N" end="M"/>
#      and keep only findings whose sourcepath matches one of the changed files AND
#      whose [start,end] line range overlaps that file's *added* line numbers (same
#      diff-hunk-parsing approach as coverage_diff_scope.sh's "new code" definition).
#   5. Fail (exit 1) only if any such NEW findings remain after filtering, with a
#      per-finding breakdown. Pre-existing findings elsewhere in the module (or on
#      lines this diff didn't touch) are ignored — no excludeFilterFile/suppression
#      config is needed for this gate to pass.
#   6. If no changed .java file maps to a module, or no findings land on changed
#      lines, the check passes (exit 0).
#
# ⚠️ If THIS check fails, the fix is: fix the actual bug SpotBugs flagged in the new/
# changed lines it lists (or, if it's a deliberate false positive, add a scoped
# @SuppressFBWarnings annotation on that specific method/field — not a broad
# excludeFilterFile/spotbugs-exclude.xml that also silences unrelated legacy findings).
#
# Usage:
#   bash spotbugs_diff_scope.sh <maven-root> <settings-path-relative-to-cwd> [base-ref]
#
# Example (settings.xml lives at the repo checkout root, consistent with the
# preceding compile/coverage gates):
#   bash agents/scripts/spotbugs_diff_scope.sh tools-app mvn/settings.xml
#
# Must be run with the working directory set to the target repo checkout (same
# `workingDir` used by the other feedbackLoop.qualityGates gate commands).
set -euo pipefail

MAVEN_ROOT="${1:?maven root required, e.g. tools-app}"
SETTINGS_PATH="${2:?settings path (relative to the working directory, e.g. mvn/settings.xml) required}"
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

# ── Map changed files to Maven modules (walk up to nearest pom.xml) ──────────
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

echo "spotbugs_diff_scope: scoping spotbugs to changed module(s): ${MODULE_LIST}"
# Report-only (spotbugs:spotbugs), NOT spotbugs:check — the module may have
# pre-existing findings we intentionally do not want to fail the build on; the
# actual pass/fail decision happens below, after filtering to new-code findings.
mvn --batch-mode -f "${MAVEN_ROOT}/pom.xml" -s "${SETTINGS_PATH}" -T 1C -pl "${MODULE_LIST}" compile spotbugs:spotbugs -q

DIFF_DATA_FILE="$(mktemp)"
trap 'rm -f "${DIFF_DATA_FILE}"' EXIT

: > "${DIFF_DATA_FILE}"
while IFS= read -r file; do
  [ -z "${file}" ] && continue
  {
    echo "===FILE:${file}==="
    git diff --unified=0 "${MERGE_BASE}" HEAD -- "${file}"
  } >> "${DIFF_DATA_FILE}"
done <<< "${CHANGED_FILES}"

python3 - "${MAVEN_ROOT}" "${DIFF_DATA_FILE}" <<'PYEOF'
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

maven_root, diff_data_file = sys.argv[1], sys.argv[2]

# Parse the diff file into { changed_file_path: set(added_line_numbers) } — identical
# "new code" definition (added/changed lines only) used by coverage_diff_scope.sh.
added_lines_by_file = {}
current_file = None
current_new_line = None
hunk_re = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@')

with open(diff_data_file, 'r', errors='replace') as f:
    for line in f:
        if line.startswith('===FILE:'):
            current_file = line[len('===FILE:'):-len('===\n')]
            added_lines_by_file.setdefault(current_file, set())
            current_new_line = None
            continue
        m = hunk_re.match(line)
        if m:
            current_new_line = int(m.group(1))
            continue
        if current_file is None or current_new_line is None:
            continue
        if line.startswith('+') and not line.startswith('+++'):
            added_lines_by_file[current_file].add(current_new_line)
            current_new_line += 1
        elif line.startswith('-') and not line.startswith('---'):
            pass  # removed line, doesn't consume a new-line-number slot
        elif line.startswith('\\'):
            pass  # "\ No newline at end of file"

def find_spotbugs_reports(maven_root):
    return glob.glob(os.path.join(maven_root, '**', 'target', 'spotbugsXml.xml'), recursive=True)

def match_source_key(file_path):
    # file_path looks like <maven-root>/<module>/src/main/java/com/foo/Bar.java —
    # SpotBugs' SourceLine@sourcepath is relative to src/main/java, e.g. com/foo/Bar.java.
    marker = 'src/main/java/'
    idx = file_path.find(marker)
    if idx == -1:
        return None
    return file_path[idx + len(marker):]

# Build lookup: sourcepath (as SpotBugs reports it) -> changed file's added-line set
added_lines_by_sourcepath = {}
for file_path, lines in added_lines_by_file.items():
    key = match_source_key(file_path)
    if key is not None:
        added_lines_by_sourcepath[key] = lines

new_findings = []
for report in find_spotbugs_reports(maven_root):
    try:
        tree = ET.parse(report)
    except ET.ParseError:
        continue
    for bug in tree.getroot().findall('.//BugInstance'):
        src = bug.find('SourceLine')
        if src is None:
            continue
        sourcepath = src.get('sourcepath') or ''
        added_lines = added_lines_by_sourcepath.get(sourcepath)
        if not added_lines:
            continue  # this finding's file wasn't touched by this diff at all

        start = src.get('start')
        end = src.get('end') or start
        if start is None:
            continue
        start, end = int(start), int(end)
        if not any(start <= ln <= end for ln in added_lines):
            continue  # pre-existing finding, not on a line this diff added/changed

        short_msg = bug.find('ShortMessage')
        text = short_msg.text if short_msg is not None else (bug.get('type') or 'SpotBugs finding')
        new_findings.append("%s:%s-%s: [%s] %s" % (sourcepath, start, end, bug.get('type'), text))

if new_findings:
    print("spotbugs_diff_scope: FAILED — new SpotBugs finding(s) introduced by this change:")
    for f in new_findings:
        print("  - %s" % f)
    print("")
    print("Fix the flagged code, or if it's a deliberate false positive, add a scoped")
    print("@SuppressFBWarnings annotation on that method/field — do not add a broad")
    print("excludeFilterFile/spotbugs-exclude.xml, which would also silence unrelated")
    print("pre-existing findings in this module.")
    sys.exit(1)

print("spotbugs_diff_scope: no new SpotBugs findings on changed lines — pre-existing findings elsewhere in the module are ignored")
sys.exit(0)
PYEOF
