#!/usr/bin/env bash
set -euo pipefail

git merge-base "$1" "$2" 2>/dev/null || true
