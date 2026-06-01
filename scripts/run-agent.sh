#!/bin/bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") "prompt"

Runs the configured AI agent with the provided prompt.
Provider is controlled by AI_AGENT_PROVIDER environment variable (default: cursor).

Providers:
  cursor   - Uses cursor-agent (default)
  codemie  - Uses codemie-claude
  copilot  - Uses GitHub Copilot CLI (npx @github/copilot)

Example:
  $(basename "$0") "process the input folder"

Notes:
  - Provide the prompt as a single argument
  - Extra arguments before the prompt are passed through to the agent (cursor and codemie)
  - Useful for resume: $(basename "$0") --continue --resume "fix the push error"
  - For codemie: requires CODEMIE_API_KEY and CODEMIE_BASE_URL environment variables
  - For copilot: requires COPILOT_GITHUB_TOKEN or GITHUB_TOKEN environment variable
  - For cursor: optional CURSOR_MODEL env var (default: auto)
  - Final response is written to outputs/response.md
EOF
}

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

record_codegraph_usage() {
  local log_file="$1"
  if [ ! -s "$log_file" ]; then
    return 0
  fi

  local matches
  matches="$(grep -E '(^|[[:space:];|&])codegraph[[:space:]]+(context|query|callees|callers|impact|node|files|sync|affected|status)([[:space:]]|$)' "$log_file" || true)"
  if [ -z "$matches" ]; then
    return 0
  fi

  mkdir -p .dmtools
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" >> .dmtools/codegraph-usage.log
  done <<< "$matches"
}

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

if [ "$PROVIDER" = "codemie" ]; then
  if [ -z "${CODEMIE_API_KEY:-}" ]; then
    echo "Error: CODEMIE_API_KEY environment variable is required for codemie provider" >&2
    exit 1
  fi

  if [ -z "${CODEMIE_BASE_URL:-}" ]; then
    echo "Error: CODEMIE_BASE_URL environment variable is required for codemie provider" >&2
    exit 1
  fi

  echo "Codemie Configuration:"
  echo "  Base URL: ${CODEMIE_BASE_URL}"
  echo "  Model: ${CODEMIE_MODEL:-claude-4-5-sonnet}"
  echo "  Max Turns: ${CODEMIE_MAX_TURNS:-50}"

  if [ ${#PASS_ARGS[@]} -eq 0 ]; then
    CMD=(codemie-claude
      --base-url "${CODEMIE_BASE_URL}"
      --api-key "${CODEMIE_API_KEY}"
      --model "${CODEMIE_MODEL:-claude-4-5-sonnet}"
      --provider "litellm"
      -p "$PROMPT"
      --max-turns "${CODEMIE_MAX_TURNS:-50}"
      --dangerously-skip-permissions
      --allowedTools "Bash(*),Read(*),Curl(*)")
  else
    CMD=(codemie-claude
      --base-url "${CODEMIE_BASE_URL}"
      --api-key "${CODEMIE_API_KEY}"
      --model "${CODEMIE_MODEL:-claude-4-5-sonnet}"
      --provider "litellm"
      ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
      -p "$PROMPT"
      --max-turns "${CODEMIE_MAX_TURNS:-50}"
      --dangerously-skip-permissions
      --allowedTools "Bash(*),Read(*),Curl(*)")
  fi

elif [ "$PROVIDER" = "copilot" ]; then
  # Export COPILOT_GITHUB_TOKEN if not set but GITHUB_TOKEN is available
  if [ -z "${COPILOT_GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
    export COPILOT_GITHUB_TOKEN="${GITHUB_TOKEN}"
    echo "Using GITHUB_TOKEN as COPILOT_GITHUB_TOKEN"
  fi

  if [ -z "${COPILOT_GITHUB_TOKEN:-}" ]; then
    echo "Error: COPILOT_GITHUB_TOKEN or GITHUB_TOKEN environment variable is required for copilot provider" >&2
    echo "Set it in dmtools.env or as an environment variable" >&2
    exit 1
  fi

  COPILOT_DEFAULT_MODEL="${COPILOT_DEFAULT_MODEL:-gpt-5-mini}"
  COPILOT_MODEL_VALUE="${COPILOT_MODEL:-$COPILOT_DEFAULT_MODEL}"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ "${COPILOT_SESSION_ENABLED:-true}" != "false" ] && [ -f "${SCRIPT_DIR}/../setup/copilot-session.sh" ]; then
    # shellcheck source=/dev/null
    source "${SCRIPT_DIR}/../setup/copilot-session.sh" env
  fi

  COPILOT_SESSION_ARGS=()
  COPILOT_HAS_RESUME_ARG=false
  for pass_arg in "${PASS_ARGS[@]:-}"; do
    case "${pass_arg}" in
      --continue|--resume|--resume=*|--session-id|--session-id=*)
        COPILOT_HAS_RESUME_ARG=true
        ;;
    esac
  done
  if [ "${COPILOT_SESSION_ENABLED:-true}" != "false" ] && [ "${COPILOT_HAS_RESUME_ARG}" = "false" ] && [ -n "${COPILOT_SESSION_ID:-}" ]; then
    COPILOT_SESSION_ARGS=(--session-id "${COPILOT_SESSION_ID}")
    if [ -n "${COPILOT_SESSION_NAME:-}" ]; then
      COPILOT_SESSION_ARGS+=(--name "${COPILOT_SESSION_NAME}")
    fi
  fi

  echo "Copilot Configuration:"
  echo "  Model: ${COPILOT_MODEL_VALUE}"
  if [ -n "${COPILOT_SESSION_ID:-}" ]; then
    echo "  Session: ${COPILOT_SESSION_NAME:-${COPILOT_SESSION_ID}} (${COPILOT_SESSION_GROUP:-default})"
    echo "  COPILOT_HOME: ${COPILOT_HOME:-}"
  fi
  echo "Working directory: $(pwd)"
  echo ""

  # For large prompts, passing -p "$PROMPT" as a CLI argument can exceed Linux ARG_MAX
  # (E2BIG / "Argument list too long"). Use stdin redirect instead: the CLI reads from
  # stdin when it is not a TTY (e.g. inside CI pipes). The prompt file path is already
  # available as $PROMPT_ARG when DMTools calls this script with cliPrompt.
  # PASS_ARGS support: flags like --continue --resume are forwarded to the copilot CLI.
  COPILOT_CMD=(copilot)
  if ! command -v copilot >/dev/null 2>&1; then
    COPILOT_CMD=(npx @github/copilot@1.0.44)
  fi
  run_copilot_once() {
    local log_file="$1"
    local model="$2"

    set +e
    if [ -f "${PROMPT_ARG}" ]; then
      echo "Running: ${COPILOT_CMD[*]} --allow-all --model ${model} ${COPILOT_SESSION_ARGS[*]:-} ${PASS_ARGS[*]:-} (prompt: ${PROMPT_BYTES} bytes via stdin)"
      echo ""
      "${COPILOT_CMD[@]}" --allow-all --model "${model}" ${COPILOT_SESSION_ARGS[@]+"${COPILOT_SESSION_ARGS[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} < "${PROMPT_ARG}" 2>&1 | tee "$log_file"
    else
      echo "Running: ${COPILOT_CMD[*]} --allow-all --model ${model} ${COPILOT_SESSION_ARGS[*]:-} ${PASS_ARGS[*]:-} -p <inline prompt>"
      echo ""
      "${COPILOT_CMD[@]}" --allow-all --model "${model}" ${COPILOT_SESSION_ARGS[@]+"${COPILOT_SESSION_ARGS[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -p "${PROMPT}" 2>&1 | tee "$log_file"
    fi
    local status=${PIPESTATUS[0]}
    return "$status"
  }

  max_attempts="${COPILOT_RATE_LIMIT_RETRIES:-2}"
  retry_delay="${COPILOT_RATE_LIMIT_RETRY_DELAY_SECONDS:-90}"
  attempt=1
  exit_code=1

  while [ "$attempt" -le "$max_attempts" ]; do
    copilot_log="$(mktemp)"
    set +e
    run_copilot_once "$copilot_log" "$COPILOT_MODEL_VALUE"
    exit_code=$?
    set -e

    if [ "$exit_code" -eq 0 ]; then
      record_codegraph_usage "$copilot_log"
      rm -f "$copilot_log"
      break
    fi

    if grep -Eiq 'Model ".+" from --model flag is not available' "$copilot_log" && [ "$COPILOT_MODEL_VALUE" != "$COPILOT_DEFAULT_MODEL" ]; then
      echo ""
      echo "Copilot model ${COPILOT_MODEL_VALUE} is unavailable; retrying with ${COPILOT_DEFAULT_MODEL}"
      record_codegraph_usage "$copilot_log"
      rm -f "$copilot_log"
      copilot_log="$(mktemp)"
      set +e
      run_copilot_once "$copilot_log" "$COPILOT_DEFAULT_MODEL"
      exit_code=$?
      set -e
      COPILOT_MODEL_VALUE="$COPILOT_DEFAULT_MODEL"
      if [ "$exit_code" -eq 0 ]; then
        record_codegraph_usage "$copilot_log"
        rm -f "$copilot_log"
        break
      fi
    fi

    if grep -Eiq "rate limit|limit reset|You've hit your rate limit" "$copilot_log" && [ "$attempt" -lt "$max_attempts" ]; then
      echo ""
      echo "Copilot rate limit detected; retrying in ${retry_delay}s (attempt $((attempt + 1))/${max_attempts})"
      record_codegraph_usage "$copilot_log"
      rm -f "$copilot_log"
      sleep "$retry_delay"
      attempt=$((attempt + 1))
      continue
    fi

    record_codegraph_usage "$copilot_log"
    rm -f "$copilot_log"
    break
  done

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  exit $exit_code

else
  # Default to cursor
  if ! command -v cursor-agent >/dev/null 2>&1; then
    echo "Error: cursor-agent not found in PATH" >&2
    exit 127
  fi

  CURSOR_MODEL_VALUE="${CURSOR_MODEL:-auto}"
  echo "Cursor Configuration:"
  echo "  Model: ${CURSOR_MODEL_VALUE}"

  # Build command with defaults if no options provided
  if [ ${#PASS_ARGS[@]} -eq 0 ]; then
    CMD=(cursor-agent --force --print --model "${CURSOR_MODEL_VALUE}" --output-format=text "$PROMPT")
  else
    CMD=(cursor-agent "${PASS_ARGS[@]}" --output-format=text "$PROMPT")
  fi

fi

echo "Working directory: $(pwd)"
echo ""
echo "Running: ${CMD[*]}"
echo ""

# Execute Command
agent_log="$(mktemp)"
set +e
"${CMD[@]}" 2>&1 | tee "$agent_log"
exit_code=${PIPESTATUS[0]}
set -e
record_codegraph_usage "$agent_log"
rm -f "$agent_log"

echo ""
echo "=== Agent completed with exit code: $exit_code ==="

exit $exit_code
