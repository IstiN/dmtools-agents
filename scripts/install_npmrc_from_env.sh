#!/usr/bin/env bash
# Installs a project's .npmrc (e.g. one pointing at an internal npm registry,
# with an auth token baked in) from a base64-encoded environment variable —
# the same convention already used by these projects' own GitLab CI pipelines
# (`echo $NPM_RC | base64 -d >> .npmrc`), so a locally-run agent's `npm i`
# resolves internal-scoped packages exactly the same way CI does.
#
# Why this is needed: quality gates and setup commands in repo-agents/*.json
# run `npm i`/`npm run build`/`npm run test:cov` etc. with an explicit
# workingDir, so they'd otherwise silently fall back to the public npm
# registry (or a stale/absent ~/.npmrc) and fail to resolve internal-scoped
# packages that only exist on a private registry.
#
# This script does NOT bake in any secret itself: it only decodes whatever
# base64 content the named environment variable holds at runtime and writes
# it to disk — the actual credential/registry URL lives entirely in that env
# var (e.g. an NPM_RC CI/CD variable), never in this repo.
#
# Usage:
#   bash install_npmrc_from_env.sh <ENV_VAR_NAME> <target-dir>
#
# Example (matches a Node repo's own .gitlab-ci.yml before_script, run with
# workingDir "." from ai-teammate root, after the target repo has already
# been checked out):
#   bash agents/scripts/install_npmrc_from_env.sh NPM_RC dependencies/admin-ui
set -euo pipefail

ENV_VAR_NAME="${1:?environment variable name required, e.g. NPM_RC}"
TARGET_DIR="${2:?target directory required, e.g. dependencies/admin-ui}"

ENCODED_VALUE="${!ENV_VAR_NAME:-}"
if [ -z "${ENCODED_VALUE}" ]; then
  echo "install_npmrc_from_env: \$${ENV_VAR_NAME} is not set — skipping (no .npmrc installed)"
  exit 0
fi

if [ ! -d "${TARGET_DIR}" ]; then
  echo "install_npmrc_from_env: target directory not found: ${TARGET_DIR} — skipping"
  exit 0
fi

echo "${ENCODED_VALUE}" | base64 -d >> "${TARGET_DIR}/.npmrc"
echo "install_npmrc_from_env: decoded \$${ENV_VAR_NAME} -> ${TARGET_DIR}/.npmrc"
echo "  (all subsequent npm invocations with cwd=${TARGET_DIR} will use it)"
