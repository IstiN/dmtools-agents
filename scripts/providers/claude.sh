#!/bin/bash
# Claude Code provider for run-agent.sh
# Uses Anthropic Claude Code CLI (claude -p) via Bedrock proxy.
#
# Required env vars (all CLAUDE_CODE_ prefixed):
#   CLAUDE_CODE_API_KEY   - API key for the Bedrock proxy
#   CLAUDE_CODE_BASE_URL  - Base URL of the proxy (e.g. https://host/api/agent_name)
# Optional:
#   CLAUDE_CODE_MODEL     - Model ID (default: claude-sonnet-4-6)
#   CLAUDE_CODE_MAX_TURNS - Max agentic turns (default: 10)
#
# Note: ANTHROPIC_* vars are set locally inside this script only (required by Claude Code SDK).
# They are never exported at the workflow level to avoid conflicts with DMTools ANTHROPIC_* vars.

run_claude_code() {
  if [ -z "${CLAUDE_CODE_API_KEY:-}" ]; then
    echo "Error: CLAUDE_CODE_API_KEY environment variable is required for claude-code provider" >&2
    return 1
  fi

  if [ -z "${CLAUDE_CODE_BASE_URL:-}" ]; then
    echo "Error: CLAUDE_CODE_BASE_URL environment variable is required for claude-code provider" >&2
    return 1
  fi

  local claude_code_model="${CLAUDE_CODE_MODEL:-claude-sonnet-4-6}"
  local claude_code_max_turns="${CLAUDE_CODE_MAX_TURNS:-10}"

  if ! command -v claude >/dev/null 2>&1; then
    echo "Error: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code" >&2
    return 1
  fi

  # Map CLAUDE_CODE_* → ANTHROPIC_* required by Claude Code SDK (subprocess scope only).
  export ANTHROPIC_BASE_URL="${CLAUDE_CODE_BASE_URL}"
  export ANTHROPIC_API_KEY="${CLAUDE_CODE_API_KEY}"
  export ANTHROPIC_MODEL="${claude_code_model}"

  echo "Claude Code Configuration:"
  echo "  Model:       ${claude_code_model}"
  echo "  Base URL:    ${CLAUDE_CODE_BASE_URL}"
  echo "  Max turns:   ${claude_code_max_turns}"
  echo "Working directory: $(pwd)"
  echo ""

  local claude_code_exit_code=0
  local claude_code_log
  claude_code_log="$(new_agent_log_file "claude-code")"
  # Session resume: if .claude-session-id exists from a previous run, continue that session.
  local claude_resume_args=()
  local claude_is_resuming=false
  if [ -f ".claude-session-id" ]; then
    local prev_session_id
    prev_session_id="$(cat .claude-session-id | tr -d '[:space:]')"
    if [ -n "${prev_session_id}" ]; then
      claude_resume_args=(--resume "${prev_session_id}")
      claude_is_resuming=true
      echo "♻️  Resuming Claude session: ${prev_session_id}"
    fi
  fi

  # Force a fresh re-read of input/*.md on resume; see resumed_session_reread_notice()
  # in _common.sh for why. Only applies when we're actually continuing a prior session.
  local claude_resume_notice=""
  if [ "${claude_is_resuming}" = "true" ]; then
    claude_resume_notice="$(resumed_session_reread_notice)"
  fi

  set +e
  if [ -f "${PROMPT_ARG}" ]; then
    echo "Running: claude --allowedTools all --output-format stream-json --verbose --model ${claude_code_model} --max-turns ${claude_code_max_turns} -p (prompt: ${PROMPT_BYTES} bytes via stdin)"
    echo ""
    # Use stdin redirect to avoid "Argument list too long" for large prompts (E2BIG).
    local claude_prompt_stdin_file
    claude_prompt_stdin_file="$(mktemp)"
    if [ -n "${claude_resume_notice}" ]; then
      printf "%s" "${claude_resume_notice}" > "${claude_prompt_stdin_file}"
    fi
    cat "${PROMPT_ARG}" >> "${claude_prompt_stdin_file}"
    claude --allowedTools all \
      --output-format stream-json \
      --verbose \
      --model "${claude_code_model}" \
      --max-turns "${claude_code_max_turns}" \
      ${claude_resume_args[@]+"${claude_resume_args[@]}"} \
      ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} \
      -p < "${claude_prompt_stdin_file}" \
      2>&1 | tee "${claude_code_log}"
    rm -f "${claude_prompt_stdin_file}"
  else
    echo "Running: claude --allowedTools all --output-format stream-json --verbose --model ${claude_code_model} --max-turns ${claude_code_max_turns} -p (inline prompt: ${PROMPT_BYTES} bytes)"
    echo ""
    claude --allowedTools all \
      --output-format stream-json \
      --verbose \
      --model "${claude_code_model}" \
      --max-turns "${claude_code_max_turns}" \
      ${claude_resume_args[@]+"${claude_resume_args[@]}"} \
      ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} \
      -p "${claude_resume_notice}${PROMPT}" \
      2>&1 | tee "${claude_code_log}"
  fi
  claude_code_exit_code=${PIPESTATUS[0]}
  set -e

  record_codegraph_usage "${claude_code_log}"

  # Claude Code's stream-json output carries aggregate usage in the final
  # result.modelUsage object. Normalize it to the same provider-neutral JSON
  # schema used by the Jira token-usage comment helper. Reporting is strictly
  # best-effort and must never replace the Claude process exit code.
  local provider_script_dir usage_name usage_file usage_exit_code manifest_exit_code
  provider_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  usage_name="${AI_AGENT_USAGE_NAME:-claude-code}"
  usage_file="outputs/${usage_name}_usage.json"
  rm -f "${usage_file}" 2>/dev/null || true
  usage_exit_code=0
  python3 "${provider_script_dir}/claude_usage.py" "${claude_code_log}" "${usage_file}" || usage_exit_code=$?
  if [ "${usage_exit_code}" -eq 0 ]; then
    manifest_exit_code=0
    record_usage_file "${usage_file}" || manifest_exit_code=$?
    if [ "${manifest_exit_code}" -ne 0 ]; then
      echo "⚠️  Claude token usage was extracted but could not be added to the manifest (exit ${manifest_exit_code}); continuing with agent exit ${claude_code_exit_code}."
    fi
  else
    echo "⚠️  Claude token usage could not be recorded (extractor exit ${usage_exit_code}); continuing with agent exit ${claude_code_exit_code}."
  fi

  # Save session ID for the next run to resume from.
  local saved_session_id
  saved_session_id="$(grep -o '"session_id":"[^"]*"' "${claude_code_log}" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"')"
  if [ -n "${saved_session_id}" ]; then
    echo "${saved_session_id}" > .claude-session-id
    echo "💾 Claude session saved: ${saved_session_id}"
  fi

  echo "Full transcript saved to: ${claude_code_log}"

  echo ""
  echo "=== Agent completed with exit code: $claude_code_exit_code ==="
  return $claude_code_exit_code
}
