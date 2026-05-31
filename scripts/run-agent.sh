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

  echo "Copilot Configuration:"
  echo "  Model: ${COPILOT_MODEL:-gpt-5-mini}"
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
    set +e
    if [ -f "${PROMPT_ARG}" ]; then
      echo "Running: ${COPILOT_CMD[*]} --allow-all --model ${COPILOT_MODEL:-gpt-5-mini} ${PASS_ARGS[*]:-} (prompt: ${PROMPT_BYTES} bytes via stdin)"
      echo ""
      "${COPILOT_CMD[@]}" --allow-all --model "${COPILOT_MODEL:-gpt-5-mini}" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} < "${PROMPT_ARG}" 2>&1 | tee "$log_file"
    else
      echo "Running: ${COPILOT_CMD[*]} --allow-all --model ${COPILOT_MODEL:-gpt-5-mini} ${PASS_ARGS[*]:-} -p <inline prompt>"
      echo ""
      "${COPILOT_CMD[@]}" --allow-all --model "${COPILOT_MODEL:-gpt-5-mini}" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -p "${PROMPT}" 2>&1 | tee "$log_file"
    fi
    local status=${PIPESTATUS[0]}
    set -e
    return "$status"
  }

  max_attempts="${COPILOT_RATE_LIMIT_RETRIES:-2}"
  retry_delay="${COPILOT_RATE_LIMIT_RETRY_DELAY_SECONDS:-90}"
  attempt=1
  exit_code=1

  while [ "$attempt" -le "$max_attempts" ]; do
    copilot_log="$(mktemp)"
    run_copilot_once "$copilot_log"
    exit_code=$?

    if [ "$exit_code" -eq 0 ]; then
      rm -f "$copilot_log"
      break
    fi

    if grep -Eiq "rate limit|limit reset|You've hit your rate limit" "$copilot_log" && [ "$attempt" -lt "$max_attempts" ]; then
      echo ""
      echo "Copilot rate limit detected; retrying in ${retry_delay}s (attempt $((attempt + 1))/${max_attempts})"
      rm -f "$copilot_log"
      sleep "$retry_delay"
      attempt=$((attempt + 1))
      continue
    fi

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
"${CMD[@]}"

exit_code=$?

echo ""
echo "=== Agent completed with exit code: $exit_code ==="

exit $exit_code
