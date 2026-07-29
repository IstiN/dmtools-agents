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

# ── Install sdkmanager if missing OR outdated ─────────────────────────────────
# Google's repository has no stable "latest" URL alias — build numbers are
# baked into the filename and go stale. This was pinned at build 11076708
# (cmdline-tools revision 11.0, ~Aug 2024) for a long time, which is old
# enough that avdmanager silently fails to recognize newer system images:
# confirmed live — sdkmanager installed system-images;android-35;google_apis;
# arm64-v8a correctly (verified complete on disk, and via
# `sdkmanager --list_installed`), yet avdmanager still failed with
# "Package path is not valid. Valid system image paths are: null" on
# every attempt, while the SAME package installed under a locally-tested
# newer cmdline-tools revision (12.0+) created the AVD without issue.
#
# Bitrise "Dev Environments" sessions run on a persistent disk, so an old
# cmdline-tools installation from a PREVIOUS session can survive even after
# the VM itself is recreated — a plain `is_installed sdkmanager` check alone
# is not enough, since it only checks *presence*, not *version*, and would
# silently skip reinstalling a stale-but-present sdkmanager forever. So we
# also read the installed revision from source.properties and force a
# reinstall whenever it is older than the minimum required version.
REQUIRED_CMDLINE_TOOLS_MAJOR=22
CURRENT_CMDLINE_TOOLS_REVISION=""
if [ -f "${ANDROID_HOME}/cmdline-tools/latest/source.properties" ]; then
  CURRENT_CMDLINE_TOOLS_REVISION="$(grep '^Pkg.Revision=' "${ANDROID_HOME}/cmdline-tools/latest/source.properties" 2>/dev/null | cut -d= -f2)"
fi
CURRENT_CMDLINE_TOOLS_MAJOR="${CURRENT_CMDLINE_TOOLS_REVISION%%.*}"

NEED_CMDLINE_TOOLS_INSTALL=0
if ! is_installed sdkmanager; then
  NEED_CMDLINE_TOOLS_INSTALL=1
elif [ -z "${CURRENT_CMDLINE_TOOLS_MAJOR}" ]; then
  # sdkmanager is on PATH but we can't determine its revision — reinstall to be safe.
  NEED_CMDLINE_TOOLS_INSTALL=1
elif ! [ "${CURRENT_CMDLINE_TOOLS_MAJOR}" -ge "${REQUIRED_CMDLINE_TOOLS_MAJOR}" ] 2>/dev/null; then
  NEED_CMDLINE_TOOLS_INSTALL=1
fi

if [ "${NEED_CMDLINE_TOOLS_INSTALL}" = "1" ]; then
  if [ -n "${CURRENT_CMDLINE_TOOLS_REVISION}" ]; then
    echo "📥 Installed cmdline-tools revision ${CURRENT_CMDLINE_TOOLS_REVISION} is older than required ${REQUIRED_CMDLINE_TOOLS_MAJOR}.0 — reinstalling..."
  else
    echo "📥 Installing Android cmdline-tools..."
  fi
  # Bumped to build 15859902 (revision 22.0, current as of this fix) — and,
  # for Apple Silicon specifically, to the native mac_arm64 variant instead
  # of the x86_64 build (avoids running the SDK tools under Rosetta).
  CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip"
  if [ "${OS}" = "macos" ]; then
    if [ "$(uname -m)" = "arm64" ]; then
      CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-mac_arm64-15859902_latest.zip"
    else
      CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-mac_x86_64-15859902_latest.zip"
    fi
  fi

  TMP_ZIP="/tmp/cmdline-tools.zip"
  curl -fsSL "${CMDLINE_TOOLS_URL}" -o "${TMP_ZIP}"
  rm -rf "${ANDROID_HOME}/cmdline-tools/latest"
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
