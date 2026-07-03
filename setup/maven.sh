#!/usr/bin/env bash
# Install Apache Maven (binary distribution from apache.org archive, apt fallback on Linux).
# Bash 3.2 compatible (macOS system bash).
#
# Usage:
#   maven.sh [version]              # e.g. maven.sh 3.8.6
#   MAVEN_VERSION=3.8.6 maven.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

MAVEN_VERSION="${1:-${MAVEN_VERSION:-3.9.9}}"
INSTALL_DIR="${MAVEN_INSTALL_DIR:-$HOME/.maven}"

echo "🔨 Maven ${MAVEN_VERSION} [CI=$(detect_ci)]"

# IMPORTANT: dmtools' cli_execute_command spawns a brand-new subprocess for every
# invocation, always extending its PATH with /usr/local/bin, /opt/homebrew/bin,
# /usr/bin, /bin — but nothing this script exports via register_path (that only
# affects THIS script's own process). If a caller installs Maven here via one
# cli_execute_command call and then runs "mvn ..." via a SEPARATE cli_execute_command
# call (e.g. a quality gate), that second call needs mvn discoverable WITHOUT any
# prior PATH export — hence the /usr/local/bin symlink below, done on every code
# path (fresh install, cache-hit, or apt fallback).
link_mvn_into_usr_local_bin() {
  local mvn_bin="$1"
  local sudo_cmd_result
  sudo_cmd_result="$(sudo_cmd)"
  ${sudo_cmd_result} ln -sf "${mvn_bin}" /usr/local/bin/mvn 2>/dev/null \
    || echo "⚠️  Could not symlink mvn into /usr/local/bin (no write access?) — mvn may only be visible within this script's own process."
}

version_matches() {
  local mvn_bin="$1"
  "${mvn_bin}" -v 2>/dev/null | head -1 | grep -q "${MAVEN_VERSION}"
}

# ── Fast path 1: already on PATH with the right version (e.g. pre-baked image) ─
if is_installed mvn && version_matches "$(command -v mvn)"; then
  echo "✅ Maven ${MAVEN_VERSION} already available on PATH — skipping install"
  exit 0
fi

# ── Fast path 2: binary already present at INSTALL_DIR (e.g. restored from CI
#    cache) but not yet linked into this fresh container's /usr/local/bin ──────
if [ -x "${INSTALL_DIR}/bin/mvn" ] && version_matches "${INSTALL_DIR}/bin/mvn"; then
  echo "✅ Maven ${MAVEN_VERSION} found at ${INSTALL_DIR} (cache hit) — linking, skipping download"
  register_path "${INSTALL_DIR}/bin"
  link_mvn_into_usr_local_bin "${INSTALL_DIR}/bin/mvn"
  exit 0
fi

# ── Install from Apache archive (works on Linux and macOS) ───────────────────
echo "📥 Installing Maven ${MAVEN_VERSION}..."
mkdir -p "${INSTALL_DIR}"
ARCHIVE="apache-maven-${MAVEN_VERSION}-bin.tar.gz"
BASE_URL="https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries"

download() {
  local url="$1" out="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL "${url}" -o "${out}"
  elif command -v wget &>/dev/null; then
    wget -q "${url}" -O "${out}"
  else
    echo "❌ Neither curl nor wget available to download Maven" >&2
    exit 1
  fi
}

if ! download "${BASE_URL}/${ARCHIVE}" "/tmp/${ARCHIVE}"; then
  echo "❌ Failed to download Maven ${MAVEN_VERSION} from ${BASE_URL}" >&2
  echo "   Falling back to apt (version may differ from requested)..." >&2
  OS="$(detect_os)"
  if [ "${OS}" = "linux" ]; then
    SUDO="$(sudo_cmd)"
    ${SUDO} apt-get update -qq && ${SUDO} apt-get install -y maven -qq
    # apt installs mvn via update-alternatives, already on the standard PATH —
    # no /usr/local/bin symlink needed for this fallback.
    exit 0
  fi
  exit 1
fi

tar -xzf "/tmp/${ARCHIVE}" -C "${INSTALL_DIR}" --strip-components=1
rm -f "/tmp/${ARCHIVE}"

register_path "${INSTALL_DIR}/bin"
link_mvn_into_usr_local_bin "${INSTALL_DIR}/bin/mvn"

echo "✅ Maven $("${INSTALL_DIR}/bin/mvn" -v 2>&1 | head -1)"
