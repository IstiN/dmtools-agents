#!/usr/bin/env bash
# Install Android SDK command-line tools and accept licenses.
# On GitHub Actions use `android-actions/setup-android` instead (faster).
# This script is useful for self-hosted runners or local CI setups.
#
# Usage:
#   android.sh                        # install cmdline-tools, accept licenses
#   android.sh 36                     # install platform android-36 explicitly
#   ANDROID_COMPILE_SDK=36 android.sh
#
# Bash 3.2 compatible (macOS system bash).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

COMPILE_SDK="${1:-${ANDROID_COMPILE_SDK:-36}}"
BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-36.0.0}"

echo "🤖 Android SDK [compileSdk=${COMPILE_SDK} buildTools=${BUILD_TOOLS} CI=$(detect_ci)]"

# ── On GitHub Actions, setup-android@v4 action is preferred ──────────────────
if [ "$(detect_ci)" = "github" ] && [ -n "${ANDROID_HOME:-}" ]; then
  echo "✅ ANDROID_HOME already set by actions/setup-android — skipping manual install"
  echo "   ANDROID_HOME=${ANDROID_HOME}"
  exit 0
fi

# ── Locate or set ANDROID_HOME ────────────────────────────────────────────────
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -d "${HOME}/Android/Sdk" ]; then
    ANDROID_HOME="${HOME}/Android/Sdk"
  elif [ -d "${HOME}/Library/Android/sdk" ]; then
    ANDROID_HOME="${HOME}/Library/Android/sdk"
  elif [ -d "/usr/local/lib/android/sdk" ]; then
    ANDROID_HOME="/usr/local/lib/android/sdk"
  else
    ANDROID_HOME="${HOME}/Android/Sdk"
    mkdir -p "${ANDROID_HOME}"
  fi
fi

export_var "ANDROID_HOME" "${ANDROID_HOME}"
register_path "${ANDROID_HOME}/cmdline-tools/latest/bin"
register_path "${ANDROID_HOME}/platform-tools"

OS="$(detect_os)"

# ── Install sdkmanager if missing ─────────────────────────────────────────────
if ! is_installed sdkmanager; then
  echo "📥 Installing Android cmdline-tools..."
  CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  if [ "${OS}" = "macos" ]; then
    CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip"
  fi

  TMP_ZIP="/tmp/cmdline-tools.zip"
  curl -fsSL "${CMDLINE_TOOLS_URL}" -o "${TMP_ZIP}"
  mkdir -p "${ANDROID_HOME}/cmdline-tools"
  unzip -q "${TMP_ZIP}" -d "${ANDROID_HOME}/cmdline-tools/"
  mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" 2>/dev/null || true
  rm -f "${TMP_ZIP}"
  register_path "${ANDROID_HOME}/cmdline-tools/latest/bin"
  echo "✅ Android cmdline-tools installed"
fi

# ── Accept licenses ───────────────────────────────────────────────────────────
echo "📋 Accepting Android SDK licenses..."
yes | sdkmanager --licenses > /dev/null 2>&1 || true

# ── Install required SDK packages ─────────────────────────────────────────────
echo "📥 Installing SDK packages: platform-${COMPILE_SDK}, build-tools-${BUILD_TOOLS}..."
sdkmanager \
  "platforms;android-${COMPILE_SDK}" \
  "build-tools;${BUILD_TOOLS}" \
  "platform-tools" \
  --sdk_root="${ANDROID_HOME}" > /dev/null

echo "✅ Android SDK ready (ANDROID_HOME=${ANDROID_HOME})"
