#!/usr/bin/env bash
# Install the Fa CLI (fa) — Dart-based AI agent harness.
#
# Primary source: GitHub Releases of IstiN/flutter_agent_harness — the
# platform bundle (fa-<os>-<arch>.tar.gz) carries bin/fa + lib/ (the AOT
# binary loads its shared libs from ../lib, mirroring install_local.sh).
# Fallback: the fa1.dev upstream installer.
#
# Usage:
#   fa.sh [version]        e.g. fa.sh v0.1.324 (default: latest release)
#   FA_VERSION=v0.1.324 fa.sh
#   FA_INSTALL_DIR=... fa.sh   (default: ~/.local/bin; lib/ goes to ../lib)
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

FA_BIN_DIR="${FA_INSTALL_DIR:-${HOME}/.local/bin}"
FA_LIB_DIR="$(dirname "${FA_BIN_DIR}")/lib"
FA_VERSION="${1:-${FA_VERSION:-latest}}"
FA_REPO="IstiN/flutter_agent_harness"

# ── Configure the deterministic session for AI Teammate runs ─────────────────
_configure_session() {
  if [ -z "${AI_TEAMMATE_CONFIG_FILE:-}" ]; then
    return 0
  fi
  if [ -f "${SCRIPT_DIR}/fa-session.sh" ]; then
    # shellcheck source=/dev/null
    source "${SCRIPT_DIR}/fa-session.sh" env
  fi
}

echo "⚡ Fa CLI"

# ── Already installed? ────────────────────────────────────────────────────────
if is_installed fa || is_installed fah; then
  echo "✅ fa already installed: $(fa --version 2>/dev/null || fah --version 2>/dev/null || echo "cached")"
  register_path "${FA_BIN_DIR}"
  _configure_session
  exit 0
fi

if [ -x "${FA_BIN_DIR}/fa" ]; then
  register_path "${FA_BIN_DIR}"
  echo "✅ fa already installed: ${FA_BIN_DIR}/fa"
  _configure_session
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing fa (${FA_VERSION})..."

install_from_github_release() {
  local os arch asset tmp
  case "$(uname -s)" in
    Darwin) os="macos" ;;
    Linux)  os="linux" ;;
    *) echo "  unsupported OS ($(uname -s)) for the release bundle" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64)        arch="x64" ;;
    *) echo "  unsupported arch ($(uname -m))" >&2; return 1 ;;
  esac
  asset="fa-${os}-${arch}.tar.gz"
  tmp="$(mktemp -d)"

  local url="https://github.com/${FA_REPO}/releases/${FA_VERSION}/download/${asset}"
  [ "${FA_VERSION}" = "latest" ] && \
    url="https://github.com/${FA_REPO}/releases/latest/download/${asset}"
  echo "  → ${url}"
  curl -fsSL "$url" -o "${tmp}/${asset}" || {
    echo "  release bundle download failed" >&2
    return 1
  }
  tar -xzf "${tmp}/${asset}" -C "${tmp}"
  mkdir -p "${FA_BIN_DIR}" "${FA_LIB_DIR}"
  cp "${tmp}/bundle/bin/fa" "${FA_BIN_DIR}/fa"
  chmod +x "${FA_BIN_DIR}/fa"
  # Shared libs load from ../lib relative to the binary — same layout the
  # release bundle and install_local.sh produce.
  if [ -d "${tmp}/bundle/lib" ]; then
    cp -R "${tmp}/bundle/lib/." "${FA_LIB_DIR}/"
  fi
  rm -rf "${tmp}"
}

if install_from_github_release && [ -x "${FA_BIN_DIR}/fa" ]; then
  register_path "${FA_BIN_DIR}"
  echo "✅ fa installed: ${FA_BIN_DIR}/fa ($(${FA_BIN_DIR}/fa --version 2>/dev/null || echo 'version n/a'))"
  _configure_session
  exit 0
fi

# ── Fallback: upstream installer ──────────────────────────────────────────────
echo "  falling back to the fa1.dev installer..."
FA_INSTALL_DIR="${FA_BIN_DIR}" bash -c \
  'curl -fsSL "https://fa1.dev/install.sh?v=2" | sh'

if [ -x "${FA_BIN_DIR}/fa" ]; then
  register_path "${FA_BIN_DIR}"
  echo "✅ fa installed: ${FA_BIN_DIR}/fa"
  _configure_session
else
  echo "⚠️  fa could not be installed automatically."
  echo "    Install manually: curl -fsSL \"https://fa1.dev/install.sh?v=2\" | sh"
fi
