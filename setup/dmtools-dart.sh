#!/usr/bin/env bash
# Install the dmtools CLI — the Dart orchestrator port (epam/dmtools-dart).
#
# OPT-IN tool: NOT part of `install.sh all`. Install explicitly:
#   install.sh dmtools-dart        (or: setup/dmtools-dart.sh [version])
#
# The default dmtools tool remains the Java CLI (epam/dm.ai). This port is
# installed SIDE-BY-SIDE under ~/.dmtools-dart (both ship a `dmtools`
# binary — PATH order decides which one wins when both dirs are on PATH).
#
# Usage:
#   dmtools-dart.sh [version]                      # e.g. v0.1.0
#   DMTOOLS_VERSION=v0.1.0 dmtools-dart.sh
#   DMTOOLS_INSTALL_DIR=... dmtools-dart.sh        # default: ~/.dmtools-dart
#
# Install source: https://github.com/epam/dmtools-dart/releases
#   (the upstream install.sh detects OS/arch, downloads the AOT binary +
#   the QuickJS shared library, and installs both under <dir>/bin)
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

export DMTOOLS_VERSION="${1:-${DMTOOLS_VERSION:-latest}}"
# Side-by-side root (the upstream installer defaults to ~/.dmtools — that
# is the Java CLI's home; the Dart port must not clobber it).
export DMTOOLS_INSTALL_DIR="${DMTOOLS_INSTALL_DIR:-${HOME}/.dmtools-dart}"
DMTOOLS_BIN="${DMTOOLS_INSTALL_DIR}/bin"

echo "🛠  dmtools-dart (Dart orchestrator, epam/dmtools-dart) ${DMTOOLS_VERSION}"

# ── Already installed? ────────────────────────────────────────────────────────
if [ -x "${DMTOOLS_BIN}/dmtools" ]; then
  INSTALLED_VERSION="$("${DMTOOLS_BIN}/dmtools" --version 2>/dev/null || true)"
  echo "✅ dmtools-dart already installed: ${INSTALLED_VERSION:-${DMTOOLS_BIN}/dmtools}"
  register_path "${DMTOOLS_BIN}"
  export_var "DMTOOLS_DART_HOME" "${DMTOOLS_INSTALL_DIR}"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing dmtools-dart (${DMTOOLS_VERSION})..."

# The upstream installer honors DMTOOLS_VERSION + DMTOOLS_INSTALL_DIR and
# pins a concrete release when a version argument is passed.
if [ "${DMTOOLS_VERSION}" != "latest" ]; then
  curl -fsSL \
    "https://github.com/epam/dmtools-dart/releases/latest/download/install.sh" \
    | sh -s -- "${DMTOOLS_VERSION}"
else
  curl -fsSL \
    "https://github.com/epam/dmtools-dart/releases/latest/download/install.sh" \
    | sh
fi

if [ -x "${DMTOOLS_BIN}/dmtools" ]; then
  register_path "${DMTOOLS_BIN}"
  export_var "DMTOOLS_DART_HOME" "${DMTOOLS_INSTALL_DIR}"
  echo "✅ dmtools-dart installed: ${DMTOOLS_BIN}/dmtools ($("${DMTOOLS_BIN}/dmtools" --version 2>/dev/null || echo 'version n/a'))"
else
  echo "⚠️  dmtools-dart could not be installed automatically." >&2
  echo "    Install manually: curl -fsSL \"https://github.com/epam/dmtools-dart/releases/latest/download/install.sh\" | sh" >&2
  exit 1
fi
