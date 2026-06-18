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
  claude_code_log="$(mktemp)"

  set +e
  if [ -f "${PROMPT_ARG}" ]; then
    echo "Running: claude --allowedTools all --output-format stream-json --verbose --model ${claude_code_model} --max-turns ${claude_code_max_turns} -p (prompt: ${PROMPT_BYTES} bytes via stdin)"
    echo ""
    # Use stdin redirect to avoid "Argument list too long" for large prompts (E2BIG).
    claude --allowedTools all \
      --output-format stream-json \
      --verbose \
      --model "${claude_code_model}" \
      --max-turns "${claude_code_max_turns}" \
      ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} \
      -p < "${PROMPT_ARG}" \
      2>&1 | tee "${claude_code_log}"
  else
    echo "Running: claude --allowedTools all --output-format stream-json --verbose --model ${claude_code_model} --max-turns ${claude_code_max_turns} -p (inline prompt: ${PROMPT_BYTES} bytes)"
    echo ""
    claude --allowedTools all \
      --output-format stream-json \
      --verbose \
      --model "${claude_code_model}" \
      --max-turns "${claude_code_max_turns}" \
      -p "${PROMPT}" \
      ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} \
      2>&1 | tee "${claude_code_log}"
  fi
  claude_code_exit_code=${PIPESTATUS[0]}
  set -e

  record_codegraph_usage "${claude_code_log}"
  rm -f "${claude_code_log}"

  echo ""
  echo "=== Agent completed with exit code: $claude_code_exit_code ==="
  return $claude_code_exit_code
}
