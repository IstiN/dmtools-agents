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
# Installed version from the `dart --version` banner. Probes OUR managed
# install dir FIRST, then PATH — the cache-hit decision in do_install
# registers <SDK_BIN> on PATH and points DART_HOME at it, so it must describe
# the SDK this script owns, never a foreign dart (e.g. a Flutter-bundled one)
# that happens to sit on PATH. The banner capture takes the FULL version
# token — beta/dev banners are "3.14.0-315.1.beta (beta) …", and truncating at
# the first "-" would never equal the version channel_latest resolves, so the
# version-aware cache hit would never fire on non-stable channels.
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
  # Comment lines never contribute — neither a commented-out step
  # ("# - uses: dart-lang/setup-dart@v1") nor a stale "# channel: beta" note.
  inb && /^[[:space:]]*#/ { next }
  # The step marker must be a live list item ("  - uses: …"), optionally with
  # a QUOTED action ref (uses: "dart-lang/setup-dart@v1" — legal YAML, common
  # in generated/templated workflows).
  /^[[:space:]]*-[[:space:]]*uses:[[:space:]]*"?(dart-lang\/setup-dart)/ { inb = 1; print "step=1"; next }
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

# ── Usage ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
Usage: dart.sh [stable|beta|dev|latest|<version>]
            # default target: the repo's quality.yml dart-lang/setup-dart
            # channel/sdk detection, else stable
       DART_VERSION=<channel|version> dart.sh
       dart.sh plan [stable|beta|dev|latest|<version>]   # network-free preview
       dart.sh status                                    # installed version + dir
EOF
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

  # Validate the target BEFORE it becomes a URL — a mistyped argument
  # ("--help", "instal") used to resolve as a version and die much later as a
  # bare curl 404 on .../release/--help/sdk/dartsdk-….zip, reading like a CDN
  # problem instead of a usage error.
  # A leading `v` is muscle memory from the v-prefixed pins of the sibling
  # installers (fa.sh v0.1.324 / dmtools.sh) — dart-archive URLs are
  # unprefixed, so strip it.
  TARGET="${TARGET#v}"
  case "${TARGET}" in
    ""|latest|stable|beta|dev) ;;
    [0-9]*.[0-9]*.[0-9]*) ;;  # full version tokens: 3.9.4 / 3.14.0-315.1.beta
    *)
      echo "❌ unknown target '${TARGET}' (stable|beta|dev|latest|<version> like 3.9.4)" >&2
      usage >&2
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

# dart-archive publishes the checksum sidecar as <bundle>.sha256sum (NOT
# .sha256 — that path 404s, verified live). The payload is a canonical
# sha256sum line: "<64-hex> *<bundle-name>". Verify the downloaded zip against
# it — cheap supply-chain insurance for a ~215 MB fetch that runs on every
# Dart-repo leg. A mismatch is fatal; a MISSING sidecar (or no sha256 tool on
# PATH) only warns, so a CDN hiccup cannot red the whole leg on an
# already-downloaded artifact.
verify_sha256() {
  local file="$1" sum_url="$2" expected actual
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    echo "⚠️  no sha256sum/shasum on PATH — skipping SDK checksum verification" >&2
    return 0
  fi
  if ! curl -fsSL --connect-timeout 30 --retry 3 --retry-delay 5 "${sum_url}" -o "${file}.sha256sum"; then
    echo "⚠️  sha256 sidecar unavailable (${sum_url}) — skipping checksum verification" >&2
    return 0
  fi
  # Take only the hash field — the payload line carries the bundle name
  # ("<hash> *dartsdk-….zip"); comparing the whole line would always mismatch.
  expected="$(cut -d' ' -f1 "${file}.sha256sum" | head -1)"
  actual="$(hash_file "${file}")"
  if [ -z "${expected}" ] || [ "${actual}" != "${expected}" ]; then
    echo "❌ Dart SDK checksum mismatch (expected ${expected:-<none>}, got ${actual})" >&2
    return 1
  fi
  echo "🔐 Dart SDK checksum verified (${actual})"
}

# Exports DART_HOME for subsequent leg steps. DART_VERSION is deliberately NOT
# re-exported with the installed version: it is a pure INPUT pin here.
# Re-exporting it would (a) make a later bare `dart.sh` in the same job pin to
# the previously installed version instead of re-resolving the channel, and
# (b) flip the key `setup/cache.sh save dart` derives after the install to
# dart-<installed>-… — a key the earlier `cache.sh keys dart` (restore) step
# never looked for, breaking the cache round-trip.
export_dart_env() {
  export_var "DART_HOME" "${SDK_HOME}"
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

  # The -x guard keeps the hit honest: `have` must come from the managed
  # install (installed_version probes <SDK_BIN>/dart first), and the managed
  # dart must actually exist — a matching FOREIGN PATH dart never takes this
  # branch (it would register a nonexistent <SDK_BIN> and point DART_HOME at
  # nothing).
  if [ -n "${resolved}" ] && [ "${have}" = "${resolved}" ] && [ -x "${SDK_BIN}/dart" ]; then
    echo "✅ Dart SDK already installed: ${have} — cache hit"
    register_path "${SDK_BIN}"
    export_dart_env
    exit 0
  fi
  if [ -n "${have}" ] && [ -z "${resolved}" ]; then
    # Degraded mode: channel-latest resolution failed (network hiccup) but a
    # usable SDK exists — keep it (unverified) rather than red the whole leg.
    echo "⚠️  could not resolve ${CHANNEL} latest — keeping installed SDK ${have} (unverified)" >&2
    if [ -x "${SDK_BIN}/dart" ]; then
      register_path "${SDK_BIN}"
      export_dart_env
    else
      # `have` came from a FOREIGN PATH dart (installed_version probes the
      # managed install first). Registering the nonexistent <SDK_BIN> into
      # PATH/GITHUB_PATH and pointing DART_HOME at it would lie to every
      # downstream consumer — the foreign dart is already on PATH, so leave
      # both untouched.
      echo "⚠️  ${have} is a foreign PATH dart — DART_HOME/PATH left untouched" >&2
    fi
    exit 0
  fi
  if [ -n "${have}" ]; then
    echo "🔄 Dart SDK ${have} installed but ${resolved:-${CHANNEL}} requested — reinstalling"
  fi

  local url tmp
  tmp="$(mktemp -d)"
  # The ~215 MB fetch must never hang the leg until the workflow-level
  # timeout, and the temp dir must not leak on a failed transfer.
  trap 'rm -rf "${tmp}"' EXIT
  url="$(sdk_url "${resolved}")"
  echo "📥 Installing Dart SDK (${CHANNEL} ${resolved:-latest})..."
  echo "  → ${url}"
  curl -fsSL --connect-timeout 30 --retry 3 --retry-delay 5 "${url}" -o "${tmp}/dartsdk.zip"
  verify_sha256 "${tmp}/dartsdk.zip" "${url}.sha256sum" || exit 1
  rm -rf "${DART_INSTALL_DIR}"
  mkdir -p "${DART_INSTALL_DIR}"
  extract_zip "${tmp}/dartsdk.zip" "${DART_INSTALL_DIR}"
  rm -rf "${tmp}"

  if [ ! -x "${SDK_BIN}/dart" ]; then
    echo "❌ Dart SDK bundle extracted but ${SDK_BIN}/dart is missing" >&2
    exit 1
  fi
  register_path "${SDK_BIN}"
  export_dart_env
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
  help|-h|--help)
    usage
    exit 0
    ;;
  *)
    os_arch
    resolve_target "${CMD}"
    do_install
    ;;
esac
