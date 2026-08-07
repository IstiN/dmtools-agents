#!/bin/bash
# Copilot provider for run-agent.sh

run_copilot() {
  # Export COPILOT_GITHUB_TOKEN if not set but GITHUB_TOKEN is available
  if [ -z "${COPILOT_GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
    export COPILOT_GITHUB_TOKEN="${GITHUB_TOKEN}"
    echo "Using GITHUB_TOKEN as COPILOT_GITHUB_TOKEN"
  fi

  # The local Copilot CLI can use cached device-code credentials in
  # ~/.config/github-copilot/auth.db when no token env var is set. Allow that
  # mode by skipping the hard error if gh CLI reports an active account.
  if [ -z "${COPILOT_GITHUB_TOKEN:-}" ]; then
    if command -v copilot >/dev/null 2>&1; then
      # Try a tiny non-interactive prompt. If the CLI produces output and exits 0,
      # cached credentials are working. This avoids depending on the exact wording
      # of `gh auth status` while still requiring a working Copilot session.
      local probe_output
      probe_output=$(printf 'Reply exactly: ok' | copilot --allow-all -p "Reply exactly: ok" 2>&1 || true)
      if echo "$probe_output" | grep -Eq "^ok$"; then
        echo "Copilot CLI authenticated via cached credentials (no token env var needed)"
      else
        echo "Error: COPILOT_GITHUB_TOKEN or GITHUB_TOKEN environment variable is required for copilot provider" >&2
        echo "Set it in dmtools.env or as an environment variable, or run 'copilot auth login'" >&2
        return 1
      fi
    else
      echo "Error: COPILOT_GITHUB_TOKEN or GITHUB_TOKEN environment variable is required for copilot provider" >&2
      echo "Set it in dmtools.env or as an environment variable" >&2
      return 1
    fi
  fi

  local copilot_default_model copilot_model_value script_dir
  copilot_default_model="${COPILOT_DEFAULT_MODEL:-gpt-5-mini}"
  copilot_model_value="${COPILOT_MODEL:-$copilot_default_model}"
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ "${COPILOT_SESSION_ENABLED:-true}" != "false" ] && [ -f "${script_dir}/../../setup/copilot-session.sh" ]; then
    # shellcheck source=/dev/null
    source "${script_dir}/../../setup/copilot-session.sh" env
  fi

  local copilot_cmd
  copilot_cmd=(copilot)
  if ! command -v copilot >/dev/null 2>&1; then
    copilot_cmd=(npx @github/copilot@1.0.44)
  fi

  copilot_supports_flag() {
    "${copilot_cmd[@]}" --help 2>/dev/null | grep -q -- "$1"
  }

  local copilot_session_args=()
  local copilot_session_mode="none"
  local copilot_has_resume_arg=false
  local pass_arg
  for pass_arg in "${PASS_ARGS[@]:-}"; do
    case "${pass_arg}" in
      --continue|--resume|--resume=*|--session-id|--session-id=*)
        copilot_has_resume_arg=true
        ;;
    esac
  done
  if [ "${COPILOT_SESSION_ENABLED:-true}" != "false" ] && [ "${copilot_has_resume_arg}" = "false" ] && [ -n "${COPILOT_SESSION_ID:-}" ]; then
    if [ -n "${COPILOT_SESSION_NAME:-}" ]; then
      copilot_session_args=(--resume "${COPILOT_SESSION_NAME}")
      copilot_session_mode="resume-name"
      echo "Copilot session restore enabled; trying --resume ${COPILOT_SESSION_NAME} first"
    elif copilot_supports_flag "--session-id"; then
      copilot_session_args=(--session-id "${COPILOT_SESSION_ID}")
      copilot_session_mode="session-id"
    fi
  fi

  echo "Copilot Configuration:"
  echo "  Model: ${copilot_model_value}"
  if [ -n "${COPILOT_SESSION_ID:-}" ]; then
    echo "  Session: ${COPILOT_SESSION_NAME:-${COPILOT_SESSION_ID}} (${COPILOT_SESSION_GROUP:-default})"
    echo "  COPILOT_HOME: ${COPILOT_HOME:-}"
  fi
  echo "Working directory: $(pwd)"
  echo ""

  # Avoid passing very large prompts via "-p", which can exceed Linux MAX_ARG_STRLEN.
  # Prefer stdin when a prompt file is available (the normal DMTools path), including
  # session flags such as --resume/--continue.
  local copilot_prompt_arg_max_bytes="${COPILOT_PROMPT_ARG_MAX_BYTES:-120000}"

  copilot_should_use_stdin_prompt() {
    if [ -f "${PROMPT_ARG}" ]; then
      return 0
    fi
    if [ "${PROMPT_BYTES}" -gt "${copilot_prompt_arg_max_bytes}" ]; then
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
      echo "Running: ${copilot_cmd[*]} --allow-all --model ${model} ${copilot_session_args[*]:-} ${PASS_ARGS[*]:-} (prompt: ${PROMPT_BYTES} bytes via stdin)"
      echo ""
      "${copilot_cmd[@]}" --allow-all --model "${model}" ${copilot_session_args[@]+"${copilot_session_args[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} < "${prompt_stdin_file}" 2>&1 | tee "$log_file"
    else
      echo "Running: ${copilot_cmd[*]} --allow-all --model ${model} ${copilot_session_args[*]:-} ${PASS_ARGS[*]:-} -p <inline prompt>"
      echo ""
      "${copilot_cmd[@]}" --allow-all --model "${model}" ${copilot_session_args[@]+"${copilot_session_args[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -p "${PROMPT}" 2>&1 | tee "$log_file"
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

    if [ "${copilot_session_mode}" != "resume-name" ]; then
      return 1
    fi

    if grep -Eiq "No session, task, or name matched" "$log_file"; then
      echo ""
      echo "Copilot session ${COPILOT_SESSION_NAME} was not found; starting a new named session"
      copilot_session_args=(--name "${COPILOT_SESSION_NAME}")
      copilot_session_mode="name"
    elif grep -Eiq "Multiple sessions match the name" "$log_file"; then
      resume_id="$(grep -Eo '^[[:space:]]+[0-9a-fA-F-]{36}[[:space:]]*$' "$log_file" | head -n 1 | tr -d '[:space:]')"
      if [ -z "${resume_id}" ]; then
        echo "Copilot reported multiple matching sessions, but no session id could be parsed"
        return 1
      fi
      echo ""
      echo "Copilot found multiple sessions named ${COPILOT_SESSION_NAME}; resuming first match ${resume_id}"
      copilot_session_args=(--resume "${resume_id}")
      copilot_session_mode="resume-id"
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

  local max_attempts="${COPILOT_RATE_LIMIT_RETRIES:-2}"
  local retry_delay="${COPILOT_RATE_LIMIT_RETRY_DELAY_SECONDS:-90}"
  local attempt=1
  local exit_code=1
  # Every attempt (including model-fallback and rate-limit retries) gets its
  # own persisted transcript file — unlike the old mktemp+rm pattern, none of
  # these are deleted, so a full history of what Copilot actually did/said
  # across retries is recoverable after the job finishes.
  local copilot_log_files=()

  while [ "$attempt" -le "$max_attempts" ]; do
    local copilot_log
    copilot_log="$(new_agent_log_file "copilot-attempt${attempt}")"
    copilot_log_files+=("$copilot_log")
    set +e
    run_copilot_once "$copilot_log" "$copilot_model_value"
    exit_code=$?
    set -e

    if [ "$exit_code" -ne 0 ] && retry_copilot_session_selection "$copilot_log" "$copilot_model_value"; then
      :
    fi

    if [ "$exit_code" -eq 0 ]; then
      record_codegraph_usage "$copilot_log"
      break
    fi

    if grep -Eiq 'Model ".+" from --model flag is not available' "$copilot_log" && [ "$copilot_model_value" != "$copilot_default_model" ]; then
      echo ""
      echo "Copilot model ${copilot_model_value} is unavailable; retrying with ${copilot_default_model}"
      record_codegraph_usage "$copilot_log"
      copilot_log="$(new_agent_log_file "copilot-attempt${attempt}-fallback")"
      copilot_log_files+=("$copilot_log")
      set +e
      run_copilot_once "$copilot_log" "$copilot_default_model"
      exit_code=$?
      set -e
      copilot_model_value="$copilot_default_model"
      if [ "$exit_code" -eq 0 ]; then
        record_codegraph_usage "$copilot_log"
        break
      fi
    fi

    if grep -Eiq "rate limit|limit reset|You've hit your rate limit" "$copilot_log" && [ "$attempt" -lt "$max_attempts" ]; then
      echo ""
      echo "Copilot rate limit detected; retrying in ${retry_delay}s (attempt $((attempt + 1))/${max_attempts})"
      record_codegraph_usage "$copilot_log"
      sleep "$retry_delay"
      attempt=$((attempt + 1))
      continue
    fi

    record_codegraph_usage "$copilot_log"
    break
  done

  echo ""
  echo "Full transcript(s) saved to:"
  printf '  %s\n' "${copilot_log_files[@]}"

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return $exit_code
}
