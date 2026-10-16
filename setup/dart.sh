#!/usr/bin/env bash
# Install the Dart SDK — cached, channel-aware provisioner for machine-factory
# leg sessions (gh-918).
#
# WHY: factory legs (dev/review/rework) on Dart repos had NO dart SDK on PATH —
# they could not run `dart analyze/test/format` or `crap4dart check`, so they
# could neither see nor verify quality-gate violations (CRAP / method_size /
# format) and claimed success while violations stayed in place. Same pattern
# as the golden-test Flutter toolchain for fa legs: the SDK is cached per
# resolved version and exposed on PATH for the leg session, resolving the SAME
# channel (and pinned version, when CI pins one) the checked-out repo's
# quality workflow uses — the `dart-lang/setup-dart` step's `channel:`/`sdk:`
# inputs in `.github/workflows/*.yml`. The SDK itself downloads from the same
# dart-archive CDN `dart-lang/setup-dart` uses, so leg-local gate output
# matches CI gate output.
#
# Version-aware like setup/fa.sh: an installed-but-stale SDK is reinstalled on
# mismatch — pool VMs keep a PERSISTENT $HOME, so a presence-only check lets
# an ancient binary shadow the requested toolchain forever.
#
# Usage:
#   dart.sh [stable|beta|dev|<version>]  # default: dart-lang/setup-dart detection, else stable
#   DART_VERSION=beta dart.sh
#   DART_INSTALL_DIR=... dart.sh         # default: ~/.dart-sdk (SDK lands at <dir>/dart-sdk)
#
# Network-free subcommands (unit-test surface — js/unit-tests/test_dartSetup.js):
#   dart.sh plan [stable|beta|dev|<version>]
#       print the resolved target/URL/layout as key=value — no download
#   dart.sh status
#       print installed=<version from the dart --version banner> ('' when absent)
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

DART_ARCHIVE="https://storage.googleapis.com/dart-archive"
DART_INSTALL_DIR="${DART_INSTALL_DIR:-${HOME}/.dart-sdk}"
SDK_HOME="${DART_INSTALL_DIR}/dart-sdk"
SDK_BIN="${SDK_HOME}/bin"

# ── Platform ──────────────────────────────────────────────────────────────────
# dart-archive bundle naming: dartsdk-<os>-<arch>-release.zip (x64/arm64).
os_arch() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *) echo "❌ unsupported OS ($(uname -s)) for the dart-archive SDK bundle" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64)        ARCH="x64" ;;
    *) echo "❌ unsupported arch ($(uname -m)) for the dart-archive SDK bundle" >&2; exit 1 ;;
  esac
}

# ── Version probes ────────────────────────────────────────────────────────────
# Installed version from the `dart --version` banner. Checks the MANAGED
# install first, then PATH — a cache-restored SDK is real even before its bin
# dir is registered on PATH, and a foreign PATH dart (not the one this script
# installs) must never satisfy the cache-hit branch: that branch registers
# ${SDK_BIN} on PATH and points DART_HOME at it, which would be a lie for a
# dart the script doesn't own.
# The banner token is captured IN FULL (`[^ )]*`) — beta/dev banners carry
# pre-release suffixes (Dart SDK version: 3.14.0-315.1.beta (beta) ...), and
# truncating at the first "-" makes the version-aware cache check below see a
# permanent mismatch (SDK wiped and re-downloaded on every leg).
installed_version() {
  local d=""
  if [ -x "${SDK_BIN}/dart" ]; then
    d="${SDK_BIN}/dart"
  elif command -v dart >/dev/null 2>&1; then
    d="$(command -v dart)"
  fi
  [ -n "${d}" ] || { echo ""; return 0; }
  "${d}" --version 2>&1 \
    | sed -n 's/^Dart SDK version: \([^ )]*\).*/\1/p' | head -1
}

# Latest concrete version of a channel (dart-lang/setup-dart resolves "latest"
# through the same VERSION file).
channel_latest() {
  curl -fsSL --max-time 30 "${DART_ARCHIVE}/channels/$1/release/latest/VERSION" \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

# ── Quality-workflow detection ("same channel the repo's quality.yml uses") ──
# Scan the checked-out repo's workflows for the dart-lang/setup-dart step and
# read its with: inputs. Echoes "found|sdk|channel" (any field may be empty).
quality_detection() {
  local f kv found=0 sdk="" channel=""
  for f in "${PWD}"/.github/workflows/*.yml "${PWD}"/.github/workflows/*.yaml; do
    [ -f "${f}" ] || continue
    while IFS= read -r kv; do
      case "${kv}" in
        step=*)    found=1 ;;
        sdk=*)     if [ -n "${kv#sdk=}" ] && [ -z "${sdk}" ]; then sdk="${kv#sdk=}"; found=1; fi ;;
        channel=*) if [ -n "${kv#channel=}" ] && [ -z "${channel}" ]; then channel="${kv#channel=}"; found=1; fi ;;
      esac
    done <<EOF
$(awk -v sq="'" '
  # Skip comment lines FIRST — a commented-out step (# - uses: dart-lang/…)
  # must neither trigger detection nor leak its commented channel/sdk inputs.
  /^[[:space:]]*#/ { next }
  /uses:[[:space:]]*"?(dart-lang\/setup-dart)/ { inb = 1; print "step=1"; next }
  inb && /^[[:space:]]*-[[:space:]]*(name|uses|run):[[:space:]]/ { inb = 0 }
  inb && /sdk:/ {
    sub(/.*sdk:[[:space:]]*/, ""); gsub(/["]/, ""); gsub(sq, "")
    sub(/[[:space:]]*#.*/, ""); gsub(/[[:space:]]/, ""); print "sdk=" $0
  }
  inb && /channel:/ {
    sub(/.*channel:[[:space:]]*/, ""); gsub(/["]/, ""); gsub(sq, "")
    sub(/[[:space:]]*#.*/, ""); gsub(/[[:space:]]/, ""); print "channel=" $0
  }
' "${f}" 2>/dev/null)
EOF
  done
  echo "${found}|${sdk}|${channel}"
}

# ── Target resolution ─────────────────────────────────────────────────────────
# Precedence (sets TARGET/MODE/CHANNEL/VERSION/SOURCE):
#   1. explicit argument           → source=argument
#   2. DART_VERSION env            → source=environment
#   3. quality.yml sdk:/channel:   → source=quality workflow
#   4. stable                      → source=default
# A pinned version rides the DETECTED channel (setup-dart keeps using the
# channel for a full version), so leg output keeps matching CI exactly.
resolve_target() {
  local arg="${1:-}"
  TARGET="${arg:-${DART_VERSION:-}}"
  SOURCE="default"
  if [ -n "${arg}" ]; then
    SOURCE="argument"
  elif [ -n "${DART_VERSION:-}" ]; then
    SOURCE="environment"
  fi

  local det found det_sdk det_channel
  det="$(quality_detection)"
  found="${det%%|*}"; det="${det#*|}"
  det_sdk="${det%%|*}"; det_channel="${det#*|}"

  if [ -z "${TARGET}" ]; then
    [ "${found}" = "1" ] && SOURCE="quality workflow"
    # A quality-workflow `sdk:` pin IS a target — the leg runs the exact
    # version CI runs; its `channel:` (or stable) then carries the download.
    [ -n "${det_sdk}" ] && TARGET="${det_sdk}"
  fi

  # Accept a `v`-prefixed pin (fa.sh/dmtools.sh muscle memory) — dart-archive
  # release URLs are UNprefixed, so strip it before URL building.
  case "${TARGET}" in v[0-9]*) TARGET="${TARGET#v}" ;; esac

  # Validate the target BEFORE it becomes a URL: a mistyped argument used to
  # fall through to version mode and die much later as a bare curl 404 on
  # .../release/--help/sdk/dartsdk-...zip — reading like a CDN problem
  # instead of the usage error it is.
  case "${TARGET}" in
    ""|latest|stable|beta|dev) ;;
    [0-9]*.[0-9]*.[0-9]*) ;;  # 3.9.4 / 3.14.0-315.1.beta
    *)
      echo "❌ unknown target '${TARGET}' (stable|beta|dev|latest|<version>)" >&2
      exit 1
      ;;
  esac

  case "${TARGET}" in
    ""|latest|stable|beta|dev)
      MODE="channel"
      CHANNEL="${TARGET}"
      if [ -z "${CHANNEL}" ] || [ "${CHANNEL}" = "latest" ]; then CHANNEL="${det_channel}"; fi
      if [ -z "${CHANNEL}" ]; then CHANNEL="${det_sdk:+stable}"; fi
      [ -z "${CHANNEL}" ] && CHANNEL="stable"
      case "${CHANNEL}" in stable|beta|dev) ;; *) CHANNEL="stable" ;; esac
      VERSION=""
      ;;
    *)
      MODE="version"
      VERSION="${TARGET}"
      CHANNEL="${det_channel}"
      [ -z "${CHANNEL}" ] && CHANNEL="stable"
      case "${CHANNEL}" in stable|beta|dev) ;; *) CHANNEL="stable" ;; esac
      ;;
  esac
}

# dart-archive release URL. Channel mode resolves to `latest` until the
# concrete version is fetched at install time.
sdk_url() {
  local ver="${1:-${VERSION:-latest}}"
  [ -n "${ver}" ] || ver="latest"
  echo "${DART_ARCHIVE}/channels/${CHANNEL}/release/${ver}/sdk/dartsdk-${OS}-${ARCH}-release.zip"
}

print_plan() {
  if [ "${MODE}" = "version" ]; then
    echo "requested=${VERSION}"
  else
    echo "requested=${CHANNEL}"
  fi
  echo "mode=${MODE}"
  echo "channel=${CHANNEL}"
  echo "version=${VERSION:-latest}"
  echo "source=${SOURCE}"
  echo "install_dir=${DART_INSTALL_DIR}"
  echo "sdk_home=${SDK_HOME}"
  echo "sdk_bin_dir=${SDK_BIN}"
  echo "sdk_url=$(sdk_url)"
  echo "register_path=${SDK_BIN}"
}

# ── Install ───────────────────────────────────────────────────────────────────
extract_zip() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$1" -d "$2"
  elif [ "$(detect_os)" = "macos" ] && command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$1" "$2"
  else
    echo "❌ neither unzip nor ditto available to extract $1" >&2
    exit 1
  fi
}

# dart-archive publishes a `.sha256` sidecar next to every SDK bundle. Verify
# the ~215MB download against it before extraction — cheap supply-chain
# insurance for a script that runs on every Dart-repo leg.
verify_sha256() {
  local file="$1" sidecar="$2" sum ok=1
  sum="$(curl -fsSL --connect-timeout 30 --max-time 30 --retry 3 --retry-delay 5 "${sidecar}" || true)"
  if [ -z "${sum}" ]; then
    echo "❌ could not fetch the sha256 sidecar (${sidecar})" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    echo "${sum}  ${file}" | sha256sum -c - >/dev/null 2>&1 || ok=0
  elif command -v shasum >/dev/null 2>&1; then
    echo "${sum}  ${file}" | shasum -a 256 -c - >/dev/null 2>&1 || ok=0
  else
    echo "⚠️  no sha256sum/shasum on PATH — skipping archive verification" >&2
    return 0
  fi
  if [ "${ok}" = "0" ]; then
    echo "❌ sha256 mismatch for ${file} (expected ${sum})" >&2
    exit 1
  fi
  echo "🔐 sha256 verified: ${file}"
}

export_dart_env() {
  export_var "DART_HOME" "${SDK_HOME}"
  export_var "DART_VERSION" "$1"
}

do_install() {
  echo "🎯 Dart SDK [target=${TARGET:-<detect>} mode=${MODE} channel=${CHANNEL} os=${OS} arch=${ARCH} ci=$(detect_ci)]"

  # Resolve the concrete version for channel mode — it drives BOTH the
  # version-aware cache check below and the cache key.
  local resolved=""
  if [ "${MODE}" = "channel" ]; then
    resolved="$(channel_latest "${CHANNEL}" || true)"
  else
    resolved="${VERSION}"
  fi

  local have
  have="$(installed_version)"

  if [ -n "${resolved}" ] && [ "${have}" = "${resolved}" ]; then
    echo "✅ Dart SDK already installed: ${have} — cache hit"
    register_path "${SDK_BIN}"
    export_dart_env "${have}"
    exit 0
  fi
  if [ -n "${have}" ] && [ -z "${resolved}" ]; then
    # Degraded mode: channel-latest resolution failed (network hiccup) but a
    # usable SDK exists — keep it (unverified) rather than red the whole leg.
    echo "⚠️  could not resolve ${CHANNEL} latest — keeping installed SDK ${have} (unverified)" >&2
    register_path "${SDK_BIN}"
    export_dart_env "${have}"
    exit 0
  fi
  if [ -n "${have}" ]; then
    echo "🔄 Dart SDK ${have} installed but ${resolved:-${CHANNEL}} requested — reinstalling"
  fi

  local url tmp
  tmp="$(mktemp -d)"
  # Clean the ~215MB scratch dir on EVERY exit path — a failed curl used to
  # leak it (the error abort aborted the script before the rm -rf ran).
  trap 'rm -rf "${tmp}"' EXIT
  url="$(sdk_url "${resolved}")"
  echo "📥 Installing Dart SDK (${CHANNEL} ${resolved:-latest})..."
  echo "  → ${url}"
  curl -fsSL --connect-timeout 30 --retry 3 --retry-delay 5 "${url}" -o "${tmp}/dartsdk.zip"
  verify_sha256 "${tmp}/dartsdk.zip" "${url}.sha256"
  rm -rf "${DART_INSTALL_DIR}"
  mkdir -p "${DART_INSTALL_DIR}"
  extract_zip "${tmp}/dartsdk.zip" "${DART_INSTALL_DIR}"
  rm -rf "${tmp}"
  trap - EXIT

  if [ ! -x "${SDK_BIN}/dart" ]; then
    echo "❌ Dart SDK bundle extracted but ${SDK_BIN}/dart is missing" >&2
    exit 1
  fi
  register_path "${SDK_BIN}"
  export_dart_env "$(installed_version)"
  echo "✅ Dart SDK installed: $(dart --version 2>&1 | head -1)"
}

# ── Main ──────────────────────────────────────────────────────────────────────
CMD="${1:-}"
[ $# -gt 0 ] && shift

case "${CMD}" in
  plan)
    os_arch
    resolve_target "$@"
    print_plan
    ;;
  status)
    echo "installed=$(installed_version)"
    echo "install_dir=${DART_INSTALL_DIR}"
    ;;
  *)
    os_arch
    resolve_target "${CMD}"
    do_install
    ;;
esac
