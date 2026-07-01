#!/usr/bin/env bash
# Install/verify the Kotlin/KMP native toolchain cache (~/.konan).
# The toolchain is downloaded automatically by the Kotlin Gradle plugin on first
# use; this script pre-warms it so CI jobs hit the cache on subsequent runs.
#
# Usage:
#   konan.sh              # pre-warm via a minimal Gradle task
#   konan.sh skip         # skip pre-warm (just export KONAN_DATA_DIR)
#
# Bash 3.2 compatible (macOS system bash).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

SKIP="${1:-}"

# Default Kotlin/Konan data dir
KONAN_DIR="${KONAN_DATA_DIR:-${HOME}/.konan}"

echo "🎯 Kotlin/Konan native toolchain [dir=${KONAN_DIR}]"

export_var "KONAN_DATA_DIR" "${KONAN_DIR}"

if [ "${SKIP}" = "skip" ]; then
  echo "ℹ️  Skipping Konan pre-warm (skip flag set)"
  exit 0
fi

# If konan dir already exists and has content, toolchain is cached — skip download
if [ -d "${KONAN_DIR}" ] && [ "$(ls -A "${KONAN_DIR}" 2>/dev/null | wc -l)" -gt 2 ]; then
  echo "✅ Konan toolchain already present at ${KONAN_DIR} — cache hit"
  exit 0
fi

# Pre-warm by running a lightweight Gradle task (tasks --all is read-only)
if [ -f "./gradlew" ]; then
  echo "📥 Pre-warming Kotlin/Konan toolchain via Gradle..."
  ./gradlew tasks --all -q 2>&1 | tail -3 || true
  echo "✅ Konan toolchain pre-warm complete"
else
  echo "ℹ️  No gradlew found — Konan will be downloaded on first compile"
fi
