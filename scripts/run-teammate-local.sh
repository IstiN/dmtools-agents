#!/usr/bin/env bash
# Run the full AI Teammate pipeline locally and synchronously — no GitHub Actions
# runner involved. Mirrors the "Install AI Teammate tools" + "Run AI Teammate" steps
# of ai-teammate.yml, but executes `dmtools run` directly on the calling machine.
#
# Invoked by js/smAgent.js when a rule has `localTeammate: true` instead of
# dispatching a workflow_dispatch. Can also be run standalone for manual/ad-hoc runs.
#
# Usage:
#   run-teammate-local.sh --config-file agents/story_development.json --ticket PROJ-123 \
#     [--encoded-config-file PATH] [--project-key myproject] [--base-branch main] \
#     [--install-tools "java:17 node:20 dmtools:v1.7.215"] [--dmtools-bin PATH]
#
# Secrets:
#   Read from the calling shell's environment first; any variable not already set is
#   filled in from ./dmtools.env if present (same KEY=VALUE format used by
#   scripts/run-agent.sh). Real environment variables always win — dmtools.env only
#   fills gaps. Typical required vars: JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_PATH,
#   GH_TOKEN/PAT_TOKEN, and whatever the configured AI_AGENT_PROVIDER needs
#   (e.g. COPILOT_GITHUB_TOKEN, CURSOR_API_KEY).
#
# Branch handling (no git worktrees — single checkout, reused across tickets):
#   Before every ticket this script syncs --base-branch (default: main) and REFUSES
#   to proceed if the working tree is dirty (protects any uncommitted local work,
#   including a previous run that failed to commit/push). The teammate agent's own
#   postJSAction is responsible for creating/checking out the ticket branch,
#   committing, and pushing — exactly as it does on a GitHub Actions runner. After a
#   successful run the tree must be clean again; if it isn't, this script fails
#   loudly instead of silently discarding or carrying over uncommitted changes into
#   the next ticket.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../setup/_common.sh"

CONFIG_FILE=""
TICKET_KEY=""
ENCODED_CONFIG_FILE=""
PROJECT_KEY=""
BASE_BRANCH="main"
INSTALL_TOOLS=""
DMTOOLS_BIN="${DMTOOLS_BIN:-dmtools}"

usage() {
  cat <<EOF
Usage: $(basename "$0") --config-file PATH --ticket KEY [options]

Options:
  --config-file          PATH   agents/*.json config to run (required)
  --ticket               KEY    Jira ticket key, e.g. PROJ-123 (required)
  --encoded-config-file  PATH   file containing a pre-built encoded_config JSON blob (optional)
  --project-key          KEY    project_key value for multi-project dependency setup (optional)
  --base-branch          NAME   branch to sync before every run (default: main)
  --install-tools        LIST   tools to pass to setup/install.sh before running,
                                 e.g. "java:17 node:20 dmtools:v1.7.215" (optional —
                                 by default assumes required CLIs are already on PATH)
  --dmtools-bin          PATH   dmtools binary/command (default: dmtools, or \$DMTOOLS_BIN)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-file)         CONFIG_FILE="$2"; shift 2 ;;
    --ticket)               TICKET_KEY="$2"; shift 2 ;;
    --encoded-config-file)  ENCODED_CONFIG_FILE="$2"; shift 2 ;;
    --project-key)          PROJECT_KEY="$2"; shift 2 ;;
    --base-branch)          BASE_BRANCH="$2"; shift 2 ;;
    --install-tools)        INSTALL_TOOLS="$2"; shift 2 ;;
    --dmtools-bin)          DMTOOLS_BIN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "${CONFIG_FILE}" ] || [ -z "${TICKET_KEY}" ]; then
  echo "❌ --config-file and --ticket are required" >&2
  usage
  exit 1
fi

# ── Load secrets: real env vars win; dmtools.env only fills gaps ─────────────
if [ -f "dmtools.env" ]; then
  echo "🔑 Loading missing secrets from dmtools.env (existing env vars are never overridden)"
  while IFS='=' read -r k v; do
    [[ "${k}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [ -z "${!k:-}" ]; then
      export "${k}=${v}"
    fi
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' dmtools.env)
fi

if [ -n "${PROJECT_KEY}" ]; then
  export AI_TEAMMATE_PROJECT_KEY="${PROJECT_KEY}"
fi

# Export these so downstream child processes (dmtools' cliCommands ->
# run-agent.sh -> setup/copilot-session.sh) can see which config/ticket is
# running. Without this, copilot-session.sh's config/key resolution falls
# back to "unknown"/the current git branch, so every ticket and every agent
# type run locally on the same branch collides onto the exact same Copilot
# session name/cache dir and --resume's the same conversation — the same
# env vars ai-teammate.yml sets as GitHub Actions job inputs, just wired
# here for the local-execution path instead.
export AI_TEAMMATE_CONFIG_FILE="${CONFIG_FILE}"
export AI_TEAMMATE_DISPLAY_KEY="${TICKET_KEY}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🖥️  Local Teammate run"
echo "   config:  ${CONFIG_FILE}"
echo "   ticket:  ${TICKET_KEY}"
echo "   project: ${PROJECT_KEY:-<default>}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Self-ignore this script's own scratch files/dirs — no per-project
# .gitignore edits required. Written to .git/info/exclude (local-only,
# per-clone, never committed) rather than the tracked .gitignore, so any
# consumer repo just works out of the box. Idempotent — only appended once.
# Covers: this script's own encoded-config blobs + run logs (.dmtools/local-run-*),
# plus the input/ and outputs/ scratch dirs that every CLI-agent run
# (run-agent.sh and the js/*.js agents themselves, e.g. developTicketAndCreatePR.js,
# postPRReviewComments.js, intakePreAction.js) creates in the repo root for
# prompt/response file exchange with the AI CLI — untracked by construction,
# same self-tripping-dirty-tree-guard problem as the .dmtools/ scratch files.
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
EXCLUDE_FILE="${GIT_DIR}/info/exclude"
SCRATCH_PATTERNS=(".dmtools/local-run-*" ".dmtools/codegraph-usage.log" "input/" "outputs/")

# Also self-ignore project dependency checkouts (e.g. an iOS reference repo)
# declared in .dmtools/repositories.json — see setup/checkout.sh below. These
# are checked out at the repo root (same convention as ai-teammate.yml's
# "Checkout project dependencies" step), so they are untracked by construction
# just like the other scratch paths above and would otherwise falsely trip the
# dirty-tree guard on every run. Gathered from ALL project keys in the config
# (not just the auto-detected one) so the exclusion is a safe superset.
DEPS_REPO_CONFIG=".dmtools/repositories.json"
if [ -f "${DEPS_REPO_CONFIG}" ] && is_installed jq; then
  while IFS= read -r repo_name; do
    [ -n "${repo_name}" ] || continue
    SCRATCH_PATTERNS+=("${repo_name}/")
  done < <(jq -r '.repositories // {} | to_entries[].value[]?.repo | split("/") | last' "${DEPS_REPO_CONFIG}" 2>/dev/null || true)
fi

mkdir -p "$(dirname "${EXCLUDE_FILE}")"
touch "${EXCLUDE_FILE}"
for pattern in "${SCRATCH_PATTERNS[@]}"; do
  if ! grep -qxF "${pattern}" "${EXCLUDE_FILE}" 2>/dev/null; then
    {
      echo ""
      echo "# Auto-added by run-teammate-local.sh — SM local-run scratch files/dirs,"
      echo "# never meant to be committed."
      echo "${pattern}"
    } >> "${EXCLUDE_FILE}"
  fi
done

# ── Guard: refuse to run on a dirty working tree ─────────────────────────────
# See the module docstring above — protects uncommitted work (this run's own repo
# is reused across tickets, unlike an ephemeral GitHub Actions checkout). Excludes
# this script's own scratch patterns via pathspec too, as defense-in-depth in case
# the .git/info/exclude write above didn't take effect (e.g. read-only .git dir).
DIRTY_PATHSPEC=(-- .)
for pattern in "${SCRATCH_PATTERNS[@]}"; do
  DIRTY_PATHSPEC+=(":(exclude)${pattern}")
done
if [ -n "$(git status --porcelain "${DIRTY_PATHSPEC[@]}")" ]; then
  echo "❌ Working tree is dirty — refusing to run (commit/stash your changes first)." >&2
  git status --short "${DIRTY_PATHSPEC[@]}" >&2
  exit 1
fi

# ── Sync base branch before every ticket ─────────────────────────────────────
echo "🔄 Syncing ${BASE_BRANCH}..."
git fetch origin "${BASE_BRANCH}"
git checkout "${BASE_BRANCH}"
git pull --ff-only origin "${BASE_BRANCH}"

# ── Checkout project dependencies (e.g. an iOS reference repo) if configured ──
# Mirrors the "Checkout project dependencies" step in ai-teammate.yml — without
# this, agents running via localTeammate/forceLocalTeammate never see the same
# reference repos a GitHub Actions run would have checked out, silently degrading
# their context. Safe no-op if .dmtools/repositories.json doesn't exist or has no
# repositories (most projects never define it) — see setup/checkout.sh for the
# config format. Uses --dest . to match ai-teammate.yml's convention (checked out
# at the repo root, e.g. ./ios-reference/), not the script's ./dependencies
# default.
if [ -f "${SCRIPT_DIR}/../setup/checkout.sh" ]; then
  bash "${SCRIPT_DIR}/../setup/checkout.sh" --dest .
fi

# ── Optional tool install (idempotent — reuses whatever setup/cache.sh cached) ─
if [ -n "${INSTALL_TOOLS}" ]; then
  # shellcheck disable=SC2086
  bash "${SCRIPT_DIR}/../setup/install.sh" ${INSTALL_TOOLS}
fi

# ── Run the agent via dmtools (same entrypoint ai-teammate.yml uses) ────────
mkdir -p .dmtools
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE=".dmtools/local-run-${TICKET_KEY}-${TIMESTAMP}.log"
CI_RUN_URL="local://$(hostname)/${TICKET_KEY}/${TIMESTAMP}"

ENCODED_CONFIG=""
if [ -n "${ENCODED_CONFIG_FILE}" ] && [ -f "${ENCODED_CONFIG_FILE}" ]; then
  ENCODED_CONFIG="$(cat "${ENCODED_CONFIG_FILE}")"
fi

DMTOOLS_ARGS=(--debug run "${CONFIG_FILE}")
if [ -n "${ENCODED_CONFIG}" ]; then
  DMTOOLS_ARGS+=("${ENCODED_CONFIG}")
fi
DMTOOLS_ARGS+=(--inputJql "key = ${TICKET_KEY}" --ciRunUrl "${CI_RUN_URL}")

echo "▶ ${DMTOOLS_BIN} --debug run ${CONFIG_FILE} ... --inputJql \"key = ${TICKET_KEY}\" --ciRunUrl ${CI_RUN_URL}"
set -o pipefail
"${DMTOOLS_BIN}" "${DMTOOLS_ARGS[@]}" 2>&1 | tee "${LOG_FILE}"

LAST_JS_RESULT="$(grep 'JavaScriptExecutor - JavaScript executed successfully:' "${LOG_FILE}" | tail -n 1 || true)"
if [ -n "${LAST_JS_RESULT}" ] && echo "${LAST_JS_RESULT}" | grep -q '"success":false'; then
  echo "❌ ${CONFIG_FILE} JavaScript action returned success:false. See ${LOG_FILE} for details." >&2
  exit 1
fi

# ── Post-guard: the agent is expected to leave a clean tree (committed + pushed) ─
# Same scratch-pattern exclusion as the pre-guard — LOG_FILE (this run's own
# ".dmtools/local-run-*.log") would otherwise always show up as untracked and
# falsely fail this check on every single successful run.
if [ -n "$(git status --porcelain "${DIRTY_PATHSPEC[@]}")" ]; then
  echo "⚠️  Working tree is dirty after the run — ${CONFIG_FILE} may not have committed/pushed everything." >&2
  git status --short "${DIRTY_PATHSPEC[@]}" >&2
  echo "   Log: ${LOG_FILE}" >&2
  exit 1
fi

echo "✅ Local run complete for ${TICKET_KEY} — log: ${LOG_FILE}"
