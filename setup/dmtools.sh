#!/usr/bin/env bash
# Install the dmtools CLI — the Dart orchestrator (epam/dmtools-dart).
#
# This is the port that replaces the Java/GraalJS dm.ai CLI as the AI
# Teammate runtime: identical config JSON, tool names, and CLI surface
# (`dmtools run <config> [override]`, `list`, `doctor`, `--version`).
#
# Usage:
#   dmtools.sh [version]                  # positional arg (e.g. v0.1.0)
#   DMTOOLS_VERSION=v0.1.0 dmtools.sh     # env override
#   DMTOOLS_INSTALL_DIR=... dmtools.sh    # default: ~/.dmtools
#
# Install source: https://github.com/epam/dmtools-dart/releases
#   (the upstream install.sh detects OS/arch, downloads the AOT binary +
#   the QuickJS shared library, and installs both under ~/.dmtools/bin)
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

DMTOOLS_VERSION="${1:-${DMTOOLS_VERSION:-latest}}"
DMTOOLS_INSTALL_DIR="${DMTOOLS_INSTALL_DIR:-${HOME}/.dmtools}"
DMTOOLS_BIN="${DMTOOLS_INSTALL_DIR}/bin"

echo "🛠  dmtools (Dart orchestrator, epam/dmtools-dart) ${DMTOOLS_VERSION}"

# ── Already installed? ────────────────────────────────────────────────────────
if [ -x "${DMTOOLS_BIN}/dmtools" ]; then
  INSTALLED_VERSION="$("${DMTOOLS_BIN}/dmtools" --version 2>/dev/null || true)"
  echo "✅ dmtools already installed: ${INSTALLED_VERSION:-${DMTOOLS_BIN}/dmtools}"
  register_path "${DMTOOLS_BIN}"
  export_var "DMTOOLS_HOME" "${DMTOOLS_INSTALL_DIR}"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing dmtools (${DMTOOLS_VERSION})..."

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
  export_var "DMTOOLS_HOME" "${DMTOOLS_INSTALL_DIR}"
  echo "✅ dmtools installed: ${DMTOOLS_BIN}/dmtools ($("${DMTOOLS_BIN}/dmtools" --version 2>/dev/null || echo 'version n/a'))"
else
  echo "⚠️  dmtools could not be installed automatically." >&2
  echo "    Install manually: curl -fsSL \"https://github.com/epam/dmtools-dart/releases/latest/download/install.sh\" | sh" >&2
  exit 1
fi
