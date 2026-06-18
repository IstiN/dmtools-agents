#!/bin/bash
# Claude Code provider for run-agent.sh
# Uses Anthropic Claude Code CLI (claude -p) via ANTHROPIC_BASE_URL proxy.
#
# Required env vars:
#   ANTHROPIC_API_KEY     - API key for the proxy
#   ANTHROPIC_BASE_URL    - Base URL of the proxy (e.g. https://host/api/agent_name)
# Optional:
#   ANTHROPIC_MODEL       - Model ID (default: claude-sonnet-4-6)
#   CLAUDE_CODE_MAX_TURNS - Max agentic turns (default: 10)

run_claude_code() {
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "Error: ANTHROPIC_API_KEY environment variable is required for claude-code provider" >&2
    echo "Set ANTHROPIC_API_KEY (proxy key) in the workflow or dmtools.env" >&2
    return 1
  fi

  if [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
    echo "Error: ANTHROPIC_BASE_URL environment variable is required for claude-code provider" >&2
    echo "Set ANTHROPIC_BASE_URL to your proxy base URL" >&2
    return 1
  fi

  local claude_model="${ANTHROPIC_MODEL:-${CLAUDE_CODE_MODEL:-claude-sonnet-4-6}}"
  local max_turns="${CLAUDE_CODE_MAX_TURNS:-10}"

  if ! command -v claude >/dev/null 2>&1; then
    echo "Error: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code" >&2
    return 1
  fi

  echo "Claude Code Configuration:"
  echo "  Model:       ${claude_model}"
  echo "  Base URL:    ${ANTHROPIC_BASE_URL}"
  echo "  Max turns:   ${max_turns}"
  echo "Working directory: $(pwd)"
  echo ""

  local exit_code=0
  local claude_log
  claude_log="$(mktemp)"

  set +e
  if [ -f "${PROMPT_ARG}" ]; then
    echo "Running: claude --allowedTools all --model ${claude_model} --max-turns ${max_turns} -p (prompt: ${PROMPT_BYTES} bytes via file)"
    echo ""
    claude --allowedTools all \
      --model "${claude_model}" \
      --max-turns "${max_turns}" \
      -p "$(cat "${PROMPT_ARG}")" \
      ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} \
      2>&1 | tee "${claude_log}"
  else
    echo "Running: claude --allowedTools all --model ${claude_model} --max-turns ${max_turns} -p (inline prompt: ${PROMPT_BYTES} bytes)"
    echo ""
    claude --allowedTools all \
      --model "${claude_model}" \
      --max-turns "${max_turns}" \
      -p "${PROMPT}" \
      ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} \
      2>&1 | tee "${claude_log}"
  fi
  exit_code=${PIPESTATUS[0]}
  set -e

  record_codegraph_usage "${claude_log}"
  rm -f "${claude_log}"

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return $exit_code
}
