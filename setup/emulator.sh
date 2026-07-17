#!/usr/bin/env bash
# Create (and by default boot) an Android emulator (AVD) so AI agents can run
# real on-device/on-emulator tests without any manual setup. Requires the
# Android SDK to already be present (run android.sh first, or `install.sh
# android emulator`) — reuses its ANDROID_HOME resolution.
#
# Usage:
#   emulator.sh                       # create (if missing) + boot the AVD
#   ANDROID_AVD_NAME=my_avd emulator.sh
#   EMULATOR_AUTOSTART=false emulator.sh   # only create/update the AVD, don't boot it
#
# Env overrides (all optional, sane defaults below):
#   ANDROID_AVD_NAME     — AVD name.                    Default: agent_avd
#   ANDROID_AVD_API       — platform API level.          Default: 35
#   ANDROID_AVD_TAG       — system-image tag.            Default: google_apis
#   ANDROID_AVD_PROFILE   — avdmanager device profile.   Default: pixel_6
#   EMULATOR_AUTOSTART    — boot the AVD after creating. Default: true
#   EMULATOR_HEADLESS     — boot with -no-window.        Default: true
#   EMULATOR_BOOT_TIMEOUT — seconds to wait for boot.     Default: 180
#
# ABI is auto-detected from the host arch (arm64-v8a on Apple Silicon / arm64
# Linux, x86_64 elsewhere) — an x86_64 image on an M-series Mac would run
# under emulation and be unusably slow, so this is not overridable.
#
# Bash 3.2 compatible (macOS system bash).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

AVD_NAME="${ANDROID_AVD_NAME:-agent_avd}"
API="${ANDROID_AVD_API:-35}"
TAG="${ANDROID_AVD_TAG:-google_apis}"
PROFILE="${ANDROID_AVD_PROFILE:-pixel_6}"
AUTOSTART="${EMULATOR_AUTOSTART:-true}"
HEADLESS="${EMULATOR_HEADLESS:-true}"
BOOT_TIMEOUT="${EMULATOR_BOOT_TIMEOUT:-180}"

# ── Resolve ANDROID_HOME (same search order as android.sh) ───────────────────
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -d "${HOME}/Android/Sdk" ]; then
    ANDROID_HOME="${HOME}/Android/Sdk"
  elif [ -d "${HOME}/Library/Android/sdk" ]; then
    ANDROID_HOME="${HOME}/Library/Android/sdk"
  elif [ -d "/usr/local/lib/android/sdk" ]; then
    ANDROID_HOME="/usr/local/lib/android/sdk"
  else
    echo "❌ ANDROID_HOME not set and no SDK found — run 'install.sh android' first" >&2
    exit 1
  fi
fi
export ANDROID_HOME
register_path "${ANDROID_HOME}/cmdline-tools/latest/bin"
register_path "${ANDROID_HOME}/platform-tools"
register_path "${ANDROID_HOME}/emulator"

if ! is_installed sdkmanager || ! is_installed avdmanager; then
  echo "❌ sdkmanager/avdmanager not found under ${ANDROID_HOME} — run 'install.sh android' first" >&2
  exit 1
fi

# ── Pick the right ABI for the host arch ──────────────────────────────────────
ARCH="$(uname -m)"
case "${ARCH}" in
  arm64|aarch64) ABI="arm64-v8a" ;;
  *)             ABI="x86_64" ;;
esac

IMAGE="system-images;android-${API};${TAG};${ABI}"
IMAGE_DIR="${ANDROID_HOME}/system-images/android-${API}/${TAG}/${ABI}"
echo "🤖 Android emulator [avd=${AVD_NAME} image=${IMAGE} profile=${PROFILE} arch=${ARCH}]"

# ── Install the system image + emulator binary (idempotent) ──────────────────
# `sdkmanager` can exit 0 without actually laying the package down on disk if
# an unexpected license prompt eats stdin mid-install (only --licenses' own
# prompts are pre-answered by the `yes` below, not ones triggered later by
# this specific package) or a transient network blip drops the download —
# and it prints nothing distinctive when that happens. Rather than trust the
# exit code, verify the package actually landed under IMAGE_DIR afterwards,
# retry once, and only then fail loudly with the captured log tail — this
# turns what was previously a silent no-op into either a working emulator or
# an actionable error (instead of avdmanager's cryptic downstream
# "Package path is not valid ... null").
echo "📥 Ensuring ${IMAGE} + emulator package are installed..."
yes | sdkmanager --licenses > /dev/null 2>&1 || true

SDK_INSTALL_LOG="/tmp/sdkmanager-install-${AVD_NAME}.log"
install_image() {
  yes | sdkmanager "emulator" "${IMAGE}" --sdk_root="${ANDROID_HOME}" > "${SDK_INSTALL_LOG}" 2>&1
}

# A merely-existing IMAGE_DIR is NOT proof of a complete install: sdkmanager
# creates the directory up front and can still leave it truncated (e.g. a
# dropped download mid-transfer) while still exiting 0 and even reaching this
# far. The one file every complete SDK package always has — and the same
# manifest avdmanager itself reads to build its "valid system image paths"
# list — is package.xml directly under the package directory. Checking for
# it (instead of just `-d`) is what actually predicts whether avdmanager
# will recognize the image, rather than just whether *some* files landed.
image_installed() { [ -f "${IMAGE_DIR}/package.xml" ]; }

install_image || true
if ! image_installed; then
  # Bitrise Dev Environments sessions run on a persistent disk (survives
  # session restarts), so a half-downloaded package directory from a prior
  # failed attempt can still be sitting there. Remove it before retrying —
  # letting sdkmanager "resume into" a directory that already has some
  # (possibly corrupt) files is far less predictable than a clean re-fetch.
  echo "⚠️  ${IMAGE_DIR}/package.xml missing after first attempt — cleaning up and retrying once..."
  rm -rf "${IMAGE_DIR}"
  install_image || true
fi
if ! image_installed; then
  echo "❌ System image did not install completely: ${IMAGE_DIR}/package.xml not found after 2 attempts." >&2
  echo "── sdkmanager output (${SDK_INSTALL_LOG}) ──────────────────────────" >&2
  tail -n 40 "${SDK_INSTALL_LOG}" >&2 || true
  exit 1
fi
echo "✅ ${IMAGE} present on disk"

# ── Create the AVD if it doesn't already exist (idempotent) ──────────────────
if avdmanager list avd | grep -qx "Name: ${AVD_NAME}"; then
  echo "✅ AVD '${AVD_NAME}' already exists — skipping creation"
else
  echo "🛠  Creating AVD '${AVD_NAME}'..."
  # `echo no` answers avdmanager's "Do you wish to create a custom hardware
  # profile [no]" prompt. Falls back to no --device if the requested profile
  # isn't in this SDK's device list (fresh cmdline-tools installs always have
  # pixel_6, but don't hard-fail on older/newer tools that don't).
  if avdmanager list device | grep -qi "id: .*or \"${PROFILE}\"" || avdmanager list device | grep -qi "\"${PROFILE}\""; then
    echo no | avdmanager create avd -n "${AVD_NAME}" -k "${IMAGE}" --device "${PROFILE}" --force
  else
    echo "⚠️  Device profile '${PROFILE}' not found — creating AVD without a device profile"
    echo no | avdmanager create avd -n "${AVD_NAME}" -k "${IMAGE}" --force
  fi
  echo "✅ AVD '${AVD_NAME}' created"
fi

export_var "ANDROID_AVD" "${AVD_NAME}"
export_var "ANDROID_SDK_ROOT" "${ANDROID_HOME}"

if [ "${AUTOSTART}" != "true" ]; then
  echo "ℹ️  EMULATOR_AUTOSTART=false — AVD created but not booted"
  exit 0
fi

# ── Boot it (skip if a device is already online — never boot a 2nd one) ─────
SERIAL="$(adb devices | awk '$2=="device"{print $1; exit}')"
if [ -n "${SERIAL}" ]; then
  echo "✅ A device is already online (${SERIAL}) — not booting a second emulator"
else
  EMU_FLAGS="-no-snapshot-save -no-boot-anim -no-audio"
  [ "${HEADLESS}" = "true" ] && EMU_FLAGS="${EMU_FLAGS} -no-window"
  echo "🚀 Booting AVD '${AVD_NAME}' (${EMU_FLAGS})..."
  # shellcheck disable=SC2086
  nohup "${ANDROID_HOME}/emulator/emulator" -avd "${AVD_NAME}" ${EMU_FLAGS} \
    > /tmp/emulator-"${AVD_NAME}".log 2>&1 &
  disown || true

  for _ in $(seq 1 "${BOOT_TIMEOUT}"); do
    SERIAL="$(adb devices | awk '$2=="device"{print $1; exit}')"
    [ -n "${SERIAL}" ] && break
    sleep 1
  done
  [ -n "${SERIAL}" ] || { echo "❌ No emulator came online within ${BOOT_TIMEOUT}s — see /tmp/emulator-${AVD_NAME}.log" >&2; exit 1; }

  BOOT_OK=0
  for _ in $(seq 1 "${BOOT_TIMEOUT}"); do
    [ "$(adb -s "${SERIAL}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && { BOOT_OK=1; break; }
    sleep 1
  done
  [ "${BOOT_OK}" = "1" ] || { echo "❌ AVD did not finish booting within ${BOOT_TIMEOUT}s (serial=${SERIAL})" >&2; exit 1; }
  echo "✅ Emulator booted and online: ${SERIAL}"
fi
