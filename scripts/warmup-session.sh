#!/usr/bin/env bash
# Bootstrap a fresh dev-environment session (e.g. a Bitrise/Codespaces cloud
# session, or any throwaway VM/container) so that DF dmtools agents can run
# locally afterwards, including in `localTeammate: true` mode.
#
# Meant to be used as the "warmup" script of a session template: it runs once
# when the session is first created, clones the target repo (with the
# `agents` submodule) into the target directory, and pre-installs/pre-warms
# the toolchain (java, node, dmtools, copilot, gradle, android, konan, ...).
#
# Secrets (JIRA_*, GH_TOKEN/PAT_TOKEN, COPILOT_GITHUB_TOKEN, ...) are expected
# to already be exposed as real environment variables by the session
# template (dmtools/run-teammate-local.sh reads them directly) — this script
# does NOT create or touch any dmtools.env file and does NOT run the agent
# pipeline itself.
#
# Usage:
#   warmup-session.sh --repo <git-url> --dir <target-dir> [--branch <name>] \
#     [--exclude "tool1 tool2 ..."] [--install-args "extra args for install.sh"]
#
# Examples:
#   warmup-session.sh --repo https://github.com/EPAM-DarkFactory/SH_ANDR_WIP.git \
#     --dir SH_ANDR_WIP --branch master --exclude "cursor codemie kimi maestro playwright"
#
#   # Re-run against an already-cloned dir (updates + re-installs, idempotent)
#   warmup-session.sh --repo https://github.com/EPAM-DarkFactory/SH_ANDR_WIP.git \
#     --dir SH_ANDR_WIP --branch master
set -euo pipefail

REPO_URL=""
TARGET_DIR=""
TARGET_BRANCH=""
EXCLUDE_TOOLS=""
INSTALL_ARGS=""

usage() {
  echo "Usage: $0 --repo <git-url> --dir <target-dir> [--branch <name>] [--exclude \"tool1 tool2\"] [--install-args \"...\"]"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_URL="$2"; shift 2 ;;
    --dir) TARGET_DIR="$2"; shift 2 ;;
    --branch) TARGET_BRANCH="$2"; shift 2 ;;
    --exclude) EXCLUDE_TOOLS="$2"; shift 2 ;;
    --install-args) INSTALL_ARGS="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "${REPO_URL}" ] || { echo "❌ --repo is required" >&2; usage; }
[ -n "${TARGET_DIR}" ] || { echo "❌ --dir is required" >&2; usage; }

# ── Auto-configure GitHub HTTPS auth for private repos ───────────────────────
# A fresh cloud session (Bitrise Dev Environments, throwaway VM/container, ...)
# has no git credential helper and no TTY, so a plain `git clone
# https://github.com/...` against a private repo fails hard with:
#   fatal: could not read Username for 'https://github.com': Device not configured
# If GH_TOKEN or PAT_TOKEN is already exported (as it should be — see the
# "Secrets" note above), rewrite all https://github.com/ URLs to embed it, so
# every clone/fetch/pull/submodule-update below (and anything a later
# `run-agent.sh`/`run-teammate-local.sh` does) authenticates transparently —
# including submodules hosted under a different GitHub org (e.g. this
# `agents` submodule). No-op if neither var is set (public repo, or the
# session template already configured its own credential helper/SSH key).
GH_AUTH_TOKEN="${GH_TOKEN:-${PAT_TOKEN:-}}"
if [ -n "${GH_AUTH_TOKEN}" ]; then
  git config --global "url.https://x-access-token:${GH_AUTH_TOKEN}@github.com/.insteadOf" "https://github.com/"
  echo "🔑 Configured git to authenticate github.com HTTPS clones with GH_TOKEN/PAT_TOKEN"
fi

echo "── Bootstrapping session ──────────────────────────────────────────────"
echo "Repo:    ${REPO_URL}"
echo "Dir:     ${TARGET_DIR}"
echo "Branch:  ${TARGET_BRANCH:-<default>}"
echo "Exclude: ${EXCLUDE_TOOLS:-<none>}"

if [ -d "${TARGET_DIR}/.git" ]; then
  echo "── Directory already exists — syncing instead of cloning ─────────────"
  git -C "${TARGET_DIR}" fetch origin
  if [ -n "${TARGET_BRANCH}" ]; then
    git -C "${TARGET_DIR}" checkout "${TARGET_BRANCH}"
    git -C "${TARGET_DIR}" pull --ff-only origin "${TARGET_BRANCH}"
  else
    git -C "${TARGET_DIR}" pull --ff-only
  fi
  git -C "${TARGET_DIR}" submodule update --init --recursive
else
  CLONE_ARGS=(--recurse-submodules)
  [ -n "${TARGET_BRANCH}" ] && CLONE_ARGS+=(--branch "${TARGET_BRANCH}")
  git clone "${CLONE_ARGS[@]}" "${REPO_URL}" "${TARGET_DIR}"
fi

AGENTS_DIR="${TARGET_DIR}/agents"
if [ ! -f "${AGENTS_DIR}/setup/install.sh" ]; then
  echo "❌ ${AGENTS_DIR}/setup/install.sh not found — is the 'agents' submodule checked out?" >&2
  exit 1
fi

# Build the exclusion flags for install.sh ("all -tool1 -tool2 ...")
EXCLUDE_FLAGS=()
for tool in ${EXCLUDE_TOOLS}; do
  EXCLUDE_FLAGS+=("-${tool}")
done

echo "── Installing/pre-warming toolchain ───────────────────────────────────"
# Run install.sh with the product repo as CWD — several tools resolve
# relative to the current working directory (gradle.sh looks for ./gradlew
# to pre-warm; CodeGraph's auto-init checks whether CWD is a git repo before
# indexing it). Without this, both silently no-op when warmup-session.sh
# itself was invoked from outside the target repo (the common case: the
# Bitrise "warmup" script field clones into --dir first, then calls this
# script from the session's home directory, not from inside --dir).
# shellcheck disable=SC2086
( cd "${TARGET_DIR}" && bash "${AGENTS_DIR}/setup/install.sh" all "${EXCLUDE_FLAGS[@]}" ${INSTALL_ARGS} )

echo "✅ Session warmed up. Repo is at ${TARGET_DIR} (branch: $(git -C "${TARGET_DIR}" rev-parse --abbrev-ref HEAD))."
