#!/usr/bin/env bash
# Run the full AI Teammate pipeline locally and synchronously — no GitHub Actions
# runner involved. Mirrors the "Install AI Teammate tools" + "Run AI Teammate" steps
# of ai-teammate.yml, but executes `dmtools run` directly on the calling machine.
#
# Invoked by js/smAgent.js when a rule has `localTeammate: true` instead of
# dispatching a workflow_dispatch. Can also be run standalone for manual/ad-hoc runs.
#
# Usage:
#   run-teammate-local.sh --config-file agents/story_development.json --ticket SOHO-123 \
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
  --ticket               KEY    Jira ticket key, e.g. SOHO-123 (required)
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

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🖥️  Local Teammate run"
echo "   config:  ${CONFIG_FILE}"
echo "   ticket:  ${TICKET_KEY}"
echo "   project: ${PROJECT_KEY:-<default>}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Guard: refuse to run on a dirty working tree ─────────────────────────────
# See the module docstring above — protects uncommitted work (this run's own repo
# is reused across tickets, unlike an ephemeral GitHub Actions checkout).
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Working tree is dirty — refusing to run (commit/stash your changes first)." >&2
  git status --short >&2
  exit 1
fi

# ── Sync base branch before every ticket ─────────────────────────────────────
echo "🔄 Syncing ${BASE_BRANCH}..."
git fetch origin "${BASE_BRANCH}"
git checkout "${BASE_BRANCH}"
git pull --ff-only origin "${BASE_BRANCH}"

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
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  Working tree is dirty after the run — ${CONFIG_FILE} may not have committed/pushed everything." >&2
  git status --short >&2
  echo "   Log: ${LOG_FILE}" >&2
  exit 1
fi

echo "✅ Local run complete for ${TICKET_KEY} — log: ${LOG_FILE}"
