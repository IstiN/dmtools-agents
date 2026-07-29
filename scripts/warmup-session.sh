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
# template (dmtools/run-teammate-local.sh reads them directly). This script
# does NOT run the agent pipeline itself, but it DOES snapshot whichever of
# those secrets are currently exported into <TARGET_DIR>/dmtools.env the
# first time it creates that directory (never overwritten afterwards) — so
# a later ad-hoc shell/SSH session on the same disk (e.g. after a manual VM
# restart, days after the original template bootstrap) still has working
# credentials instead of `dmtools doctor` reporting everything missing.
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

# ── Snapshot session-template secrets into dmtools.env ───────────────────────
# The "Secrets" note above (top of this file) assumes every future
# run-agent.sh/run-teammate-local.sh invocation happens inside the SAME
# session template that originally exported JIRA_*/GEMINI_API_KEY/etc as real
# env vars. In practice a cloud VM/container gets reconnected to or manually
# restarted long after the template's bootstrap ran (its env vars die with
# that shell/process), while the checked-out repo + installed toolchain on
# disk survive untouched. Any later ad-hoc SSH session then sees a fully
# working `dmtools`/`gradlew` but `dmtools doctor` reports every integration
# missing, and `dmtools run agents/sm.json ...` fails immediately with
# "Failed to create TrackerClient instance" — the run never even starts.
# Snapshot whichever known secret vars ARE currently exported into
# TARGET_DIR/dmtools.env (already .gitignore'd, and already the exact format
# run-agent.sh/run-teammate-local.sh parse via `while IFS='=' read ...`), so
# any later shell on this same disk keeps working. Only runs once — never
# overwrites an existing dmtools.env (e.g. one placed there deliberately, or
# a previous warmup's snapshot with hand-added extra keys).
ENV_SNAPSHOT_FILE="${TARGET_DIR}/dmtools.env"
if [ ! -f "${ENV_SNAPSHOT_FILE}" ]; then
  SECRET_VAR_PATTERN='^(JIRA_|CONFLUENCE_|FIGMA_|GH_TOKEN$|PAT_TOKEN$|SOURCE_GITHUB_TOKEN$|GITHUB_TOKEN$|COPILOT_GITHUB_TOKEN$|GITLAB_|BITBUCKET_|ADO_|RALLY_|TESTRAIL_|BITRISE_TOKEN$|XRAY_|GEMINI_|OPENAI_|ANTHROPIC_|BEDROCK_|DIAL_|OLLAMA_|DEFAULT_TRACKER$|DEFAULT_LLM$)'
  SNAPSHOT_VARS="$(env | grep -E "${SECRET_VAR_PATTERN}" || true)"
  if [ -n "${SNAPSHOT_VARS}" ]; then
    {
      echo "# Auto-snapshotted by warmup-session.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "# from this session template's env vars, so a later ad-hoc shell on the"
      echo "# same VM/container (e.g. after a manual restart, days later) still has"
      echo "# working credentials. NEVER commit this file."
      echo "${SNAPSHOT_VARS}"
    } > "${ENV_SNAPSHOT_FILE}"
    echo "💾 Snapshotted $(echo "${SNAPSHOT_VARS}" | wc -l | tr -d ' ') secret var(s) into ${ENV_SNAPSHOT_FILE}"
  else
    echo "⚠️  No known secret env vars found to snapshot — ${ENV_SNAPSHOT_FILE} was NOT created. If this session's secrets use different variable names, a manual restart will lose them until dmtools.env is created by hand."
  fi
else
  echo "ℹ️  ${ENV_SNAPSHOT_FILE} already exists — leaving it untouched (not re-snapshotting)."
fi

AGENTS_DIR="${TARGET_DIR}/agents"
if [ ! -f "${AGENTS_DIR}/setup/install.sh" ]; then
  echo "❌ ${AGENTS_DIR}/setup/install.sh not found — is the 'agents' submodule checked out?" >&2
  exit 1
fi
# Resolve to an absolute path NOW, before the `cd "${TARGET_DIR}"` below —
# TARGET_DIR is typically a relative path (e.g. "repo"), so a relative
# AGENTS_DIR would otherwise be re-resolved against the new CWD after cd'ing
# INTO that same directory (producing "repo/repo/agents/..." — "No such
# file or directory").
AGENTS_DIR="$(cd "${AGENTS_DIR}" && pwd)"

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
