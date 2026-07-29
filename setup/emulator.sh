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

# ── Linux headless prerequisites (confirmed live on a Bitrise Linux Dev
# Environment; both of these silently kill the emulator with no snapshot/
# crash-log trail, so fix them proactively rather than let every run hit the
# same wall) ───────────────────────────────────────────────────────────────
KVM_SG_WRAP=()
if [ "$(detect_os)" = "linux" ]; then
  # 1) KVM group membership. The emulator hard-requires read/write access to
  #    /dev/kvm to run x86_64 images with acceleration ("x86_64 emulation
  #    currently requires hardware acceleration!") — Bitrise Linux Dev
  #    Environments DO expose /dev/kvm and CPU virtualization extensions
  #    (vmx/svm), but the default user isn't a member of the `kvm` group
  #    that owns the device node, so every boot failed until this was fixed.
  if [ -e /dev/kvm ]; then
    if ! id -nG "$(id -un)" | tr ' ' '\n' | grep -qx kvm; then
      echo "🔐 Adding $(id -un) to the 'kvm' group for hardware-accelerated emulation..."
      $(sudo_cmd) gpasswd -a "$(id -un)" kvm > /dev/null 2>&1 || true
    fi
    # A group added just now (or even in a prior run, on a fresh login shell
    # that hasn't re-authenticated yet) doesn't take effect for the CURRENT
    # process tree until re-login — `sg kvm -c '...'` runs a command with
    # kvm as an active supplementary group immediately, without needing to
    # log out/in. Confirmed necessary live: `id` in the current shell still
    # showed the old group list right after `gpasswd -a`.
    is_installed sg && KVM_SG_WRAP=(sg kvm -c)
  else
    echo "⚠️  /dev/kvm not found — emulator will run unaccelerated (or fail) on this host" >&2
  fi

  # 2) Headless X11 libs. The emulator's gfxstream/Vulkan renderer dlopens
  #    libX11-xcb even with -no-window, and a minimal Ubuntu image doesn't
  #    ship it — the process dies right after printing "Could not open
  #    libX11-xcb.so.1, give up" with no separate crash report (it's just
  #    backgrounded via nohup, so the death is silent unless you tail the
  #    log). Installing these small libs upfront avoids that.
  if is_installed apt-get && ! ldconfig -p 2>/dev/null | grep -q 'libX11-xcb\.so\.1'; then
    echo "📥 Installing headless X11 libraries required by the emulator's renderer..."
    $(sudo_cmd) apt-get install -y libx11-xcb1 libxcb-dri3-0 libxcb-xkb1 libxkbcommon-x11-0 -qq 2>/dev/null || true
  fi
fi

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

# A merely-existing IMAGE_DIR (or even a package.xml inside it) is NOT
# reliable proof that avdmanager will recognize the package: confirmed live
# on a re-run Bitrise session where the script printed "present on disk"
# (package.xml existed) yet avdmanager still failed with "Package path is
# not valid. Valid system image paths are: null" — meaning avdmanager's own
# repository scan came up empty despite package.xml being there (e.g. a
# malformed/truncated XML, or a source.properties inconsistency, can each
# independently break avdmanager's parser without affecting a bare file
# existence check). `sdkmanager --list_installed` walks the SAME underlying
# repository-parsing code (com.android.sdklib) that avdmanager itself
# consults to build its system-image list — so if this doesn't list the
# package, avdmanager won't see it either, and vice versa. That makes it a
# much stronger signal than checking for any specific file on disk.
image_installed() {
  sdkmanager --list_installed --sdk_root="${ANDROID_HOME}" 2>/dev/null | grep -qF "${IMAGE}"
}

install_image || true
if ! image_installed; then
  # Bitrise Dev Environments sessions run on a persistent disk (survives
  # session restarts), so a half-downloaded package directory from a prior
  # failed attempt can still be sitting there. Remove it before retrying —
  # letting sdkmanager "resume into" a directory that already has some
  # (possibly corrupt) files is far less predictable than a clean re-fetch.
  echo "⚠️  sdkmanager does not (yet) list ${IMAGE} as installed after first attempt — cleaning up and retrying once..."
  rm -rf "${IMAGE_DIR}"
  install_image || true
fi
if ! image_installed; then
  echo "❌ System image did not install completely: sdkmanager does not list ${IMAGE} as installed after 2 attempts." >&2
  echo "── sdkmanager output (${SDK_INSTALL_LOG}) ──────────────────────────" >&2
  tail -n 40 "${SDK_INSTALL_LOG}" >&2 || true
  exit 1
fi
echo "✅ ${IMAGE} present on disk"
# Visibility for the log — cheap to print, and confirms exactly what
# sdkmanager (and by extension avdmanager) thinks is installed at this
# point, without needing a separate diagnostic round-trip if something
# downstream still doesn't add up.
echo "── sdkmanager --list_installed ──────────────────────────────────────"
sdkmanager --list_installed --sdk_root="${ANDROID_HOME}" 2>/dev/null || true

# ── Create the AVD if it doesn't already exist (idempotent) ──────────────────
AVD_CREATE_LOG="/tmp/avdmanager-create-${AVD_NAME}.log"
dump_avd_diagnostics() {
  echo "── avdmanager create avd output (${AVD_CREATE_LOG}) ────────────────" >&2
  cat "${AVD_CREATE_LOG}" >&2 2>/dev/null || true
  echo "── avdmanager list target ───────────────────────────────────────────" >&2
  avdmanager list target >&2 2>&1 || true
  echo "── ls -la ${IMAGE_DIR} ──────────────────────────────────────────────" >&2
  ls -la "${IMAGE_DIR}" >&2 2>&1 || true
  echo "── ANDROID_HOME=${ANDROID_HOME} / ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-<unset>}" >&2
}

# `-x` requires an exact whole-line match, but avdmanager indents its
# "Name: ..." lines (e.g. "    Name: agent_avd") — so this NEVER matched,
# and the AVD was silently recreated (via --force) on every single run
# instead of being skipped. Anchoring with a leading `[[:space:]]*` instead
# of requiring the whole line tolerates that indentation.
if avdmanager list avd | grep -qE "^[[:space:]]*Name: ${AVD_NAME}\$"; then
  echo "✅ AVD '${AVD_NAME}' already exists — skipping creation"
else
  echo "🛠  Creating AVD '${AVD_NAME}'..."
  # `echo no` answers avdmanager's "Do you wish to create a custom hardware
  # profile [no]" prompt. Falls back to no --device if the requested profile
  # isn't in this SDK's device list (fresh cmdline-tools installs always have
  # pixel_6, but don't hard-fail on older/newer tools that don't).
  # Output is captured to a log file (instead of going straight to the
  # terminal) so a failure here can be diagnosed from a single dump instead
  # of another round-trip: what avdmanager itself printed, what
  # `avdmanager list target` currently sees, and what's actually on disk.
  if avdmanager list device | grep -qi "id: .*or \"${PROFILE}\"" || avdmanager list device | grep -qi "\"${PROFILE}\""; then
    CREATE_CMD=(avdmanager create avd -n "${AVD_NAME}" -k "${IMAGE}" --device "${PROFILE}" --force)
  else
    echo "⚠️  Device profile '${PROFILE}' not found — creating AVD without a device profile"
    CREATE_CMD=(avdmanager create avd -n "${AVD_NAME}" -k "${IMAGE}" --force)
  fi
  if ! (echo no | "${CREATE_CMD[@]}") > "${AVD_CREATE_LOG}" 2>&1; then
    echo "❌ avdmanager create avd failed for '${AVD_NAME}'" >&2
    dump_avd_diagnostics
    exit 1
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
  if [ "${#KVM_SG_WRAP[@]}" -gt 0 ]; then
    # `sg kvm -c "cmd &"` backgrounds *inside* the subshell sg spawns — a
    # bare inline `sg kvm -c "... &" ; disown` does NOT reliably detach it
    # (confirmed live: the emulator process vanished within seconds), so
    # the backgrounding + disown must happen INSIDE the script sg runs.
    EMU_LAUNCH_SCRIPT="$(mktemp)"
    cat > "${EMU_LAUNCH_SCRIPT}" <<EOF
#!/usr/bin/env bash
nohup "${ANDROID_HOME}/emulator/emulator" -avd "${AVD_NAME}" ${EMU_FLAGS} \
  > /tmp/emulator-${AVD_NAME}.log 2>&1 &
disown
EOF
    chmod +x "${EMU_LAUNCH_SCRIPT}"
    "${KVM_SG_WRAP[@]}" "${EMU_LAUNCH_SCRIPT}"
    rm -f "${EMU_LAUNCH_SCRIPT}"
  else
    # shellcheck disable=SC2086
    nohup "${ANDROID_HOME}/emulator/emulator" -avd "${AVD_NAME}" ${EMU_FLAGS} \
      > /tmp/emulator-"${AVD_NAME}".log 2>&1 &
    disown || true
  fi

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
