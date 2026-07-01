#!/usr/bin/env bash
# Install Gradle wrapper validation + optionally pin a Gradle version.
# In most Android projects the Gradle wrapper (gradlew) is already committed, so
# this script primarily ensures the wrapper is executable and the Gradle
# distribution is pre-downloaded (warming the ~/.gradle/wrapper cache).
#
# Usage:
#   gradle.sh                  # validate wrapper, pre-download distribution
#   gradle.sh 8.11.2           # assert wrapper version matches, then pre-download
#   GRADLE_VERSION=8.11.2 gradle.sh
#
# Bash 3.2 compatible (macOS system bash).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

GRADLE_VERSION="${1:-${GRADLE_VERSION:-}}"

echo "🐘 Gradle setup [CI=$(detect_ci)]"

# ── Ensure wrapper script is executable ──────────────────────────────────────
if [ -f "./gradlew" ]; then
  chmod +x ./gradlew
  echo "✅ gradlew is executable"
else
  echo "⚠️  No gradlew found in working directory — skipping"
  exit 0
fi

# ── Optionally assert wrapper version ─────────────────────────────────────────
if [ -n "${GRADLE_VERSION}" ] && [ -f "gradle/wrapper/gradle-wrapper.properties" ]; then
  WRAPPER_URL="$(grep distributionUrl gradle/wrapper/gradle-wrapper.properties | cut -d= -f2 || true)"
  if echo "${WRAPPER_URL}" | grep -q "${GRADLE_VERSION}"; then
    echo "✅ Gradle wrapper version ${GRADLE_VERSION} confirmed"
  else
    echo "⚠️  Wrapper URL does not contain expected version ${GRADLE_VERSION}: ${WRAPPER_URL}"
  fi
fi

# ── Pre-download Gradle distribution (warms ~/.gradle/wrapper cache) ──────────
echo "📥 Pre-downloading Gradle distribution..."
./gradlew --version 2>&1 | tail -5

echo "✅ Gradle distribution ready"
