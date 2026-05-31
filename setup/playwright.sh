#!/usr/bin/env bash
# Install Playwright Python package and Chromium browser dependencies.
#
# Usage:
#   playwright.sh [version]                  # Python package version
#   PLAYWRIGHT_VERSION=1.52.0 playwright.sh  # env override
#
# Version examples: latest (default), 1.52.0
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

PLAYWRIGHT_VERSION="${1:-${PLAYWRIGHT_VERSION:-latest}}"

echo "🎭 Playwright (${PLAYWRIGHT_VERSION})"

if ! is_installed python3; then
  echo "❌ python3 not found. Install Python before Playwright." >&2
  exit 1
fi

python3 -m pip install --upgrade pip

if [ "${PLAYWRIGHT_VERSION}" = "latest" ] || [ -z "${PLAYWRIGHT_VERSION}" ]; then
  python3 -m pip install playwright pytest
else
  python3 -m pip install "playwright==${PLAYWRIGHT_VERSION}" pytest
fi

python3 -m playwright install --with-deps chromium

echo "✅ Playwright $(python3 -m playwright --version 2>/dev/null || echo "${PLAYWRIGHT_VERSION}")"
