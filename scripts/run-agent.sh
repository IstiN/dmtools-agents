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
  - For kimi: requires KIMI_API_KEY environment variable; optional KIMI_BASE_URL and KIMI_MODEL
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

  COPILOT_CMD=(copilot)
  if ! command -v copilot >/dev/null 2>&1; then
    COPILOT_CMD=(npx @github/copilot@1.0.44)
  fi

  copilot_supports_flag() {
    "${COPILOT_CMD[@]}" --help 2>/dev/null | grep -q -- "$1"
  }

  COPILOT_SESSION_ARGS=()
  COPILOT_SESSION_MODE="none"
  COPILOT_HAS_RESUME_ARG=false
  for pass_arg in "${PASS_ARGS[@]:-}"; do
    case "${pass_arg}" in
      --continue|--resume|--resume=*|--session-id|--session-id=*)
        COPILOT_HAS_RESUME_ARG=true
        ;;
    esac
  done
  if [ "${COPILOT_SESSION_ENABLED:-true}" != "false" ] && [ "${COPILOT_HAS_RESUME_ARG}" = "false" ] && [ -n "${COPILOT_SESSION_ID:-}" ]; then
    if [ -n "${COPILOT_SESSION_NAME:-}" ]; then
      COPILOT_SESSION_ARGS=(--resume "${COPILOT_SESSION_NAME}")
      COPILOT_SESSION_MODE="resume-name"
      echo "Copilot session restore enabled; trying --resume ${COPILOT_SESSION_NAME} first"
    elif copilot_supports_flag "--session-id"; then
      COPILOT_SESSION_ARGS=(--session-id "${COPILOT_SESSION_ID}")
      COPILOT_SESSION_MODE="session-id"
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

  # Avoid passing very large prompts via "-p", which can exceed Linux MAX_ARG_STRLEN.
  # Prefer stdin when a prompt file is available (the normal DMTools path), including
  # session flags such as --resume/--continue.
  COPILOT_PROMPT_ARG_MAX_BYTES="${COPILOT_PROMPT_ARG_MAX_BYTES:-120000}"

  copilot_should_use_stdin_prompt() {
    if [ -f "${PROMPT_ARG}" ]; then
      return 0
    fi
    if [ "${PROMPT_BYTES}" -gt "${COPILOT_PROMPT_ARG_MAX_BYTES}" ]; then
      return 0
    fi
    return 1
  }

  run_copilot_once() {
    local log_file="$1"
    local model="$2"
    local prompt_stdin_file=""
    local cleanup_prompt_stdin_file=0

    set +e
    if copilot_should_use_stdin_prompt; then
      if [ -f "${PROMPT_ARG}" ]; then
        prompt_stdin_file="${PROMPT_ARG}"
      else
        prompt_stdin_file="$(mktemp)"
        printf "%s" "${PROMPT}" > "${prompt_stdin_file}"
        cleanup_prompt_stdin_file=1
      fi
      echo "Running: ${COPILOT_CMD[*]} --allow-all --model ${model} ${COPILOT_SESSION_ARGS[*]:-} ${PASS_ARGS[*]:-} (prompt: ${PROMPT_BYTES} bytes via stdin)"
      echo ""
      "${COPILOT_CMD[@]}" --allow-all --model "${model}" ${COPILOT_SESSION_ARGS[@]+"${COPILOT_SESSION_ARGS[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} < "${prompt_stdin_file}" 2>&1 | tee "$log_file"
    else
      echo "Running: ${COPILOT_CMD[*]} --allow-all --model ${model} ${COPILOT_SESSION_ARGS[*]:-} ${PASS_ARGS[*]:-} -p <inline prompt>"
      echo ""
      "${COPILOT_CMD[@]}" --allow-all --model "${model}" ${COPILOT_SESSION_ARGS[@]+"${COPILOT_SESSION_ARGS[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -p "${PROMPT}" 2>&1 | tee "$log_file"
    fi
    local status=${PIPESTATUS[0]}
    if [ "${cleanup_prompt_stdin_file}" -eq 1 ] && [ -n "${prompt_stdin_file}" ]; then
      rm -f "${prompt_stdin_file}"
    fi
    return "$status"
  }

  retry_copilot_session_selection() {
    local log_file="$1"
    local model="$2"
    local resume_id=""

    if [ "${COPILOT_SESSION_MODE}" != "resume-name" ]; then
      return 1
    fi

    if grep -Eiq "No session, task, or name matched" "$log_file"; then
      echo ""
      echo "Copilot session ${COPILOT_SESSION_NAME} was not found; starting a new named session"
      COPILOT_SESSION_ARGS=(--name "${COPILOT_SESSION_NAME}")
      COPILOT_SESSION_MODE="name"
    elif grep -Eiq "Multiple sessions match the name" "$log_file"; then
      resume_id="$(grep -Eo '^[[:space:]]+[0-9a-fA-F-]{36}[[:space:]]*$' "$log_file" | head -n 1 | tr -d '[:space:]')"
      if [ -z "${resume_id}" ]; then
        echo "Copilot reported multiple matching sessions, but no session id could be parsed"
        return 1
      fi
      echo ""
      echo "Copilot found multiple sessions named ${COPILOT_SESSION_NAME}; resuming first match ${resume_id}"
      COPILOT_SESSION_ARGS=(--resume "${resume_id}")
      COPILOT_SESSION_MODE="resume-id"
    else
      return 1
    fi

    record_codegraph_usage "$log_file"
    set +e
    run_copilot_once "$log_file" "$model"
    exit_code=$?
    set -e
    return 0
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

    if [ "$exit_code" -ne 0 ] && retry_copilot_session_selection "$copilot_log" "$COPILOT_MODEL_VALUE"; then
      :
    fi

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

elif [ "$PROVIDER" = "kimi" ]; then
  if [ -z "${KIMI_API_KEY:-}" ]; then
    echo "Error: KIMI_API_KEY environment variable is required for kimi provider" >&2
    echo "Set it in dmtools.env or as an environment variable" >&2
    exit 1
  fi

  if ! command -v kimi >/dev/null 2>&1; then
    echo "Error: kimi not found in PATH" >&2
    echo "Install Kimi Code CLI: https://code.kimi.com/kimi-code/install.sh" >&2
    exit 127
  fi

  echo "Kimi Configuration:"
  if [ -n "${KIMI_BASE_URL:-}" ]; then
    echo "  Base URL: ${KIMI_BASE_URL}"
  fi
  if [ -n "${KIMI_MODEL:-}" ]; then
    echo "  Model: ${KIMI_MODEL}"
  fi
  echo "Working directory: $(pwd)"
  echo ""

  # Build kimi command.
  # PASS_ARGS support: flags like --continue --resume --session are forwarded.
  # By default we do NOT pass --model unless KIMI_MODEL is explicitly set.
  KIMI_MODEL_ARGS=()
  if [ -n "${KIMI_MODEL:-}" ]; then
    KIMI_MODEL_ARGS=(--model "${KIMI_MODEL}")
  fi

  # For large prompts, stdin is safer than -p to avoid ARG_MAX limits.
  # When PASS_ARGS contains session-related flags, use -p explicitly because
  # kimi may not read stdin when resuming a session.
  kimi_should_use_prompt_flag() {
    for pass_arg in "${PASS_ARGS[@]:-}"; do
      case "${pass_arg}" in
        --continue|--resume|--resume=*|--session|--session=*)
          return 0
          ;;
      esac
    done
    return 1
  }

  kimi_log="$(mktemp)"
  if kimi_should_use_prompt_flag; then
    echo "Running: kimi ${KIMI_MODEL_ARGS[*]:-} ${PASS_ARGS[*]:-} -p <prompt:${PROMPT_BYTES} bytes>"
    echo ""
    set +e
    kimi ${KIMI_MODEL_ARGS[@]+"${KIMI_MODEL_ARGS[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -p "${PROMPT}" 2>&1 | tee "$kimi_log"
    exit_code=${PIPESTATUS[0]}
    set -e
  elif [ -f "${PROMPT_ARG}" ]; then
    echo "Running: kimi ${KIMI_MODEL_ARGS[*]:-} ${PASS_ARGS[*]:-} (prompt: ${PROMPT_BYTES} bytes via stdin)"
    echo ""
    set +e
    kimi ${KIMI_MODEL_ARGS[@]+"${KIMI_MODEL_ARGS[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} < "${PROMPT_ARG}" 2>&1 | tee "$kimi_log"
    exit_code=${PIPESTATUS[0]}
    set -e
  else
    echo "Running: kimi ${KIMI_MODEL_ARGS[*]:-} ${PASS_ARGS[*]:-} -p <inline prompt>"
    echo ""
    set +e
    kimi ${KIMI_MODEL_ARGS[@]+"${KIMI_MODEL_ARGS[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -p "${PROMPT}" 2>&1 | tee "$kimi_log"
    exit_code=${PIPESTATUS[0]}
    set -e
  fi

  record_codegraph_usage "$kimi_log"
  rm -f "$kimi_log"

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
