#!/usr/bin/env bash
# Installs a project's Maven settings.xml (e.g. one pointing at an internal Nexus mirror,
# using ${env.VAR} placeholders for credentials) as the user-level default settings.xml
# (~/.m2/settings.xml), so that EVERY mvn/mvnw invocation resolves internal dependencies
# correctly — not just the ones that explicitly pass `-s <path>`.
#
# Why this is needed: quality gates in repo-agents/*/pr_rework.json explicitly pass
# `-s mvn/settings.xml`, so they resolve internal artifacts fine. But the CLI coding
# agent (Copilot) has no reason to know about that flag, so its own ad-hoc
# `mvn compile` / `./mvnw compile` calls during development use Maven's default
# settings resolution (~/.m2/settings.xml, or Maven's built-in defaults if absent) —
# which only points at Maven Central, not the internal Nexus mirror. This causes
# internal parent POMs / artifacts to fail to resolve with errors like:
#   "Non-resolvable parent POM for com.example:my-parent:${revision}"
# even though the exact same repo's automated quality gate compiles successfully.
#
# This script does NOT bake in any secrets: settings.xml files using ${env.VAR}
# placeholders (Maven's standard env-var interpolation) keep working exactly the same
# after being copied to ~/.m2/settings.xml, since those placeholders are resolved by
# Maven at runtime from the process environment, not from the file contents.
#
# Usage:
#   bash install_global_maven_settings.sh <path-to-settings.xml-relative-to-cwd>
#
# Example (matches the gens-igt quality gate config, run with workingDir "."
# from ai-teammate root, after the target repo has already been checked out):
#   bash agents/scripts/install_global_maven_settings.sh dependencies/gens-igt/mvn/settings.xml
set -euo pipefail

SOURCE_SETTINGS="${1:?path to settings.xml required, e.g. dependencies/gens-igt/mvn/settings.xml}"

if [ ! -f "${SOURCE_SETTINGS}" ]; then
  echo "install_global_maven_settings: source file not found: ${SOURCE_SETTINGS} — skipping"
  exit 0
fi

mkdir -p "${HOME}/.m2"
cp "${SOURCE_SETTINGS}" "${HOME}/.m2/settings.xml"
echo "install_global_maven_settings: installed ${SOURCE_SETTINGS} -> ${HOME}/.m2/settings.xml"
echo "  (all subsequent mvn/mvnw invocations in this job will use it by default, even without -s)"
