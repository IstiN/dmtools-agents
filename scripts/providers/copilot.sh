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
    # Fall back to npx. Version is configurable (COPILOT_VERSION, same knob
    # setup/copilot.sh uses) and defaults to the latest release — do not pin
    # a stale version here.
    copilot_cmd=(npx "@github/copilot@${COPILOT_VERSION:-latest}")
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

  # When Copilot resumes a previously cached session (--resume), the model
  # carries over its full prior conversation history/memory, including
  # assumptions about input/*.md files it already looked at in an earlier
  # run. Those files (comments.md, confluence_output_comments.md,
  # confluence_output_current.md, request.md, ...) are regenerated fresh on
  # every job run and can contain materially new content (e.g. new inline
  # comments), but a resumed model can silently skip re-reading them because
  # it "remembers" checking them before. Force a fresh, full re-read by
  # prepending a short notice ahead of the real prompt whenever we are
  # actually resuming (not just starting a freshly named session).
  #
  # copilot_session_mode can change between attempts (e.g. an unresolved
  # --resume falls back to a brand-new --name session), so this is
  # evaluated fresh on every call rather than cached once up front.
  current_resume_reread_notice() {
    if [ "${copilot_session_mode}" = "resume-name" ] || [ "${copilot_session_mode}" = "resume-id" ]; then
      printf '%s' "**IMPORTANT — resumed session:** this is a re-run of this job for the same ticket. The \`input/\` folder has been freshly re-downloaded for this run and may contain new or changed content compared to what you saw in a prior turn (ticket description, comments, tracker page content, inline comments). Do NOT rely on memory from a previous turn. Re-read the full prompt below and every file it references (including \`request.md\`, \`comments.md\`, and any \`confluence_output_comments.md\` / \`confluence_output_current.md\`) from scratch before doing anything else.

---

"
    fi
  }

  run_copilot_once() {
    local log_file="$1"
    local model="$2"
    local prompt_stdin_file=""
    local cleanup_prompt_stdin_file=0
    local resume_reread_notice
    resume_reread_notice="$(current_resume_reread_notice)"

    set +e
    if copilot_should_use_stdin_prompt; then
      prompt_stdin_file="$(mktemp)"
      cleanup_prompt_stdin_file=1
      if [ -n "${resume_reread_notice}" ]; then
        printf "%s" "${resume_reread_notice}" > "${prompt_stdin_file}"
      fi
      if [ -f "${PROMPT_ARG}" ]; then
        cat "${PROMPT_ARG}" >> "${prompt_stdin_file}"
      else
        printf "%s" "${PROMPT}" >> "${prompt_stdin_file}"
      fi
      echo "Running: ${copilot_cmd[*]} --allow-all --model ${model} ${copilot_session_args[*]:-} ${PASS_ARGS[*]:-} (prompt: ${PROMPT_BYTES} bytes via stdin)"
      echo ""
      "${copilot_cmd[@]}" --allow-all --model "${model}" ${copilot_session_args[@]+"${copilot_session_args[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} < "${prompt_stdin_file}" 2>&1 | tee "$log_file"
    else
      echo "Running: ${copilot_cmd[*]} --allow-all --model ${model} ${copilot_session_args[*]:-} ${PASS_ARGS[*]:-} -p <inline prompt>"
      echo ""
      "${copilot_cmd[@]}" --allow-all --model "${model}" ${copilot_session_args[@]+"${copilot_session_args[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -p "${resume_reread_notice}${PROMPT}" 2>&1 | tee "$log_file"
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

  # COPILOT_HOME is cached and restored across CI runs, and the same session is
  # resumed for a given ticket/group, so the session store can already contain
  # usage rows from previous runs. Snapshot the highest row id now and report
  # only what this run adds.
  local copilot_usage_baseline_id=0
  copilot_usage_baseline_id="$(python3 "${script_dir}/copilot_usage.py" --baseline 2>/dev/null || echo 0)"
  case "${copilot_usage_baseline_id}" in
    ''|*[!0-9]*) copilot_usage_baseline_id=0 ;;
  esac

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

    # Detect "empty resume": --resume on a completed/terminal session can exit 0
    # after printing only the old session trailer (Changes/AI Units/Tokens) without
    # processing the new prompt at all. A productive run always shows tool-call
    # markers ("●"); a bare trailer means the prompt was never processed.
    # Self-heal by starting a fresh session under a suffixed name.
    if [ "$exit_code" -eq 0 ] && [ "${copilot_session_mode}" = "resume-name" ]; then
      if ! grep -q "●" "$copilot_log"; then
        echo ""
        echo "Copilot resumed session ${COPILOT_SESSION_NAME} but produced no activity (terminal session state?)"
        echo "Starting a fresh session with a new name instead"
        COPILOT_SESSION_NAME="${COPILOT_SESSION_NAME}-r$(date +%s)"
        copilot_session_args=(--name "${COPILOT_SESSION_NAME}")
        copilot_session_mode="name"
        copilot_log="$(new_agent_log_file "copilot-attempt${attempt}-fresh")"
        copilot_log_files+=("$copilot_log")
        set +e
        run_copilot_once "$copilot_log" "$copilot_model_value"
        exit_code=$?
        set -e
      fi
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

  report_copilot_usage "${exit_code}" "${copilot_usage_baseline_id}" "${copilot_log_files[@]}"

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return $exit_code
}

# Normalize the Copilot CLI's token usage into the same provider-neutral JSON
# schema the Jira token-usage comment helper consumes, and register it in the
# outputs manifest. Reporting is strictly best-effort and must never replace
# the Copilot process exit code.
report_copilot_usage() {
  local agent_exit_code="$1"
  local baseline_id="$2"
  shift 2

  local provider_script_dir usage_name usage_file usage_exit_code manifest_exit_code
  provider_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  usage_name="${AI_AGENT_USAGE_NAME:-copilot}"
  usage_file="outputs/${usage_name}_usage.json"
  rm -f "${usage_file}" 2>/dev/null || true

  local usage_args=(--output "${usage_file}" --since-id "${baseline_id}")
  if [ -n "${COPILOT_SESSION_ID:-}" ]; then
    usage_args+=(--session-id "${COPILOT_SESSION_ID}")
  fi
  local log_file
  for log_file in "$@"; do
    if [ -n "${log_file}" ]; then
      usage_args+=(--transcript "${log_file}")
    fi
  done

  echo ""
  usage_exit_code=0
  python3 "${provider_script_dir}/copilot_usage.py" "${usage_args[@]}" || usage_exit_code=$?
  if [ "${usage_exit_code}" -eq 0 ]; then
    manifest_exit_code=0
    record_usage_file "${usage_file}" || manifest_exit_code=$?
    if [ "${manifest_exit_code}" -ne 0 ]; then
      echo "⚠️  Copilot token usage was extracted but could not be added to the manifest (exit ${manifest_exit_code}); continuing with agent exit ${agent_exit_code}."
    fi
  else
    echo "⚠️  Copilot token usage could not be recorded (extractor exit ${usage_exit_code}); continuing with agent exit ${agent_exit_code}."
  fi

  return 0
}
