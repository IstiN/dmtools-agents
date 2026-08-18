#!/usr/bin/env bash
# Install DMtools CLI from epam/dm.ai.
#
# Usage:
#   dmtools.sh [version]                # positional arg
#   DMTOOLS_VERSION=v1.7.195 dmtools.sh # env override
#
# Version examples: v1.7.195 (default)
# Install source: https://raw.githubusercontent.com/epam/dm.ai/main/install
# Cache path: ~/.dmtools
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

DMTOOLS_VERSION="${1:-${DMTOOLS_VERSION:-v1.7.232}}"
DMTOOLS_HOME="${HOME}/.dmtools"
DMTOOLS_BIN="${DMTOOLS_HOME}/bin"

echo "🛠  DMtools ${DMTOOLS_VERSION}"

# ── Already installed? ────────────────────────────────────────────────────────
INSTALLED_VERSION=""
if [ -x "${DMTOOLS_BIN}/dmtools" ]; then
  INSTALLED_VERSION="$(${DMTOOLS_BIN}/dmtools -v 2>/dev/null || true)"
fi

# Normalize versions for comparison (strip leading 'v' if present)
NORMALIZED_REQUESTED="${DMTOOLS_VERSION#v}"
NORMALIZED_INSTALLED="${INSTALLED_VERSION#DMTools }"
NORMALIZED_INSTALLED="${NORMALIZED_INSTALLED#v}"

if [ -n "${INSTALLED_VERSION}" ] && [ "${NORMALIZED_INSTALLED}" = "${NORMALIZED_REQUESTED}" ]; then
  echo "✅ DMtools already installed (cache hit): ${INSTALLED_VERSION}"
  register_path "${DMTOOLS_BIN}"
  export_var "DMTOOLS_HOME" "${DMTOOLS_HOME}"
  exit 0
fi

if [ -n "${INSTALLED_VERSION}" ] && [ "${NORMALIZED_INSTALLED}" != "${NORMALIZED_REQUESTED}" ]; then
  echo "🔄 DMtools version mismatch: installed ${INSTALLED_VERSION}, requested ${DMTOOLS_VERSION}"
  echo "📥 Re-installing DMtools ${DMTOOLS_VERSION}..."
  rm -rf "${DMTOOLS_HOME}"
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing DMtools ${DMTOOLS_VERSION}..."

# Download install script separately so curl failures (e.g. 429 rate-limit)
# are detectable — piping curl directly to bash masks the curl exit code.
_DMTOOLS_INSTALL_SCRIPT="$(mktemp)"
_MAX_ATTEMPTS=3
_ATTEMPT=0
while [ "${_ATTEMPT}" -lt "${_MAX_ATTEMPTS}" ]; do
  _ATTEMPT=$((_ATTEMPT + 1))
  if curl -fsSL "https://raw.githubusercontent.com/epam/dm.ai/${DMTOOLS_VERSION}/install.sh" \
       -o "${_DMTOOLS_INSTALL_SCRIPT}"; then
    break
  fi
  if [ "${_ATTEMPT}" -lt "${_MAX_ATTEMPTS}" ]; then
    _SLEEP=$((_ATTEMPT * 15))
    echo "⚠️  Download attempt ${_ATTEMPT}/${_MAX_ATTEMPTS} failed — retrying in ${_SLEEP}s..."
    sleep "${_SLEEP}"
  else
    echo "❌ Failed to download DMtools install script after ${_MAX_ATTEMPTS} attempts" >&2
    rm -f "${_DMTOOLS_INSTALL_SCRIPT}"
    exit 1
  fi
done
DMTOOLS_VERSION="${DMTOOLS_VERSION}" bash "${_DMTOOLS_INSTALL_SCRIPT}" "${DMTOOLS_VERSION}"
rm -f "${_DMTOOLS_INSTALL_SCRIPT}"

# Verify the binary is actually present before reporting success
if [ ! -x "${DMTOOLS_BIN}/dmtools" ]; then
  echo "❌ DMtools installation failed — binary not found at ${DMTOOLS_BIN}/dmtools" >&2
  exit 1
fi

register_path "${DMTOOLS_BIN}"
export_var "DMTOOLS_HOME" "${DMTOOLS_HOME}"

echo "✅ DMtools $(${DMTOOLS_BIN}/dmtools -v 2>/dev/null || echo "${DMTOOLS_VERSION}")"
