#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load shared helpers and provider implementations.
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/providers/_common.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/providers/codemie.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/providers/copilot.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/providers/kimi.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/providers/cursor.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") "prompt"

Runs the configured AI agent with the provided prompt.
Provider is controlled by AI_AGENT_PROVIDER environment variable (default: cursor).

Providers:
  cursor   - Uses cursor-agent (default)
  codemie  - Uses codemie-claude
  copilot  - Uses GitHub Copilot CLI (npx @github/copilot)
  kimi     - Uses Kimi Code CLI (kimi)

Example:
  $(basename "$0") "process the input folder"

Notes:
  - Provide the prompt as a single argument
  - Extra arguments before the prompt are passed through to the agent (cursor and codemie)
  - Useful for resume: $(basename "$0") --continue --resume "fix the push error"
  - For codemie: requires CODEMIE_API_KEY and CODEMIE_BASE_URL environment variables
  - For copilot: requires COPILOT_GITHUB_TOKEN or GITHUB_TOKEN environment variable
  - For cursor: optional CURSOR_MODEL env var (default: auto)
  - For kimi: requires KIMI_API_KEY environment variable unless authenticated via OAuth;
              optional KIMI_BASE_URL and KIMI_MODEL
  - Final response is written to outputs/response.md
EOF
}

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

# --skip: print prompt and exit without running any agent (for post-action testing)
for arg in "$@"; do
  if [ "$arg" = "--skip" ]; then
    PROMPT_FILE="${!#}"
    echo "=== --skip mode: printing prompt ==="
    echo ""
    cat "$PROMPT_FILE"
    echo ""
    echo "=== skipped agent execution ==="
    exit 0
  fi
done

# Load dmtools.env if exists (for local runs)
# Uses grep to filter only valid KEY=VALUE lines — avoids bash executing bare values
# (e.g. a multi-line API key where the continuation line has no KEY= prefix)
if [ -f "dmtools.env" ]; then
  echo "Loading environment from dmtools.env"
  set -a
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' dmtools.env)
  set +a
fi

# Extract prompt (last argument).
# When cliPrompt is used, DMTools passes the prompt as a temp file path — read it if so.
PROMPT_ARG="${!#}"
PROMPT_SOURCE="inline-argument"

if [ -f "$PROMPT_ARG" ]; then
  PROMPT="$(cat "$PROMPT_ARG")"
  PROMPT_SOURCE="$PROMPT_ARG"
else
  PROMPT="$PROMPT_ARG"
fi

if [ -z "$PROMPT" ]; then
  echo "Error: prompt argument is required" >&2
  usage
  exit 1
fi

PROMPT_BYTES=$(printf "%s" "$PROMPT" | wc -c | tr -d ' ')
echo "=== AGENT PROMPT START ==="
echo "Prompt source: ${PROMPT_SOURCE}"
echo "Prompt size: ${PROMPT_BYTES} bytes"
echo ""
printf "%s\n" "$PROMPT"
echo ""
echo "=== AGENT PROMPT END ==="
echo ""

# Extract extra arguments (everything except the last — the prompt)
# These are passed through to the agent to support flags like --continue --resume
PASS_ARGS=()
if [ $# -gt 1 ]; then
  PASS_ARGS=("${@:1:$#-1}")
fi

# Determine provider
PROVIDER="${AI_AGENT_PROVIDER:-cursor}"
echo "AI Agent Provider: $PROVIDER"

# Derive a human-readable usage name for token-report files.
# Prefer the agent config name (e.g. story_acceptance_criteria from CONFIG_FILE),
# then fall back to the workflow-provided AI_TEAMMATE_CONFIG_FILE,
# and finally fall back to the provider name for standalone/local runs.
AI_AGENT_USAGE_NAME="${PROVIDER}"
CONFIG_FILE="${CONFIG_FILE:-${AI_TEAMMATE_CONFIG_FILE:-}}"
if [ -n "${CONFIG_FILE:-}" ]; then
  AI_AGENT_USAGE_NAME="$(basename "${CONFIG_FILE}" .json)"
fi
export AI_AGENT_USAGE_NAME
echo "AI Agent Usage Name: ${AI_AGENT_USAGE_NAME}"

exit_code=0
case "$PROVIDER" in
  codemie)
    run_codemie || exit_code=$?
    ;;
  copilot)
    run_copilot || exit_code=$?
    ;;
  kimi)
    run_kimi || exit_code=$?
    ;;
  cursor)
    run_cursor || exit_code=$?
    ;;
  *)
    echo "Error: unknown provider '$PROVIDER'" >&2
    usage
    exit 1
    ;;
esac

exit $exit_code
