#!/bin/bash
# Codemie provider for run-agent.sh

run_codemie() {
  if [ -z "${CODEMIE_API_KEY:-}" ]; then
    echo "Error: CODEMIE_API_KEY environment variable is required for codemie provider" >&2
    return 1
  fi

  if [ -z "${CODEMIE_BASE_URL:-}" ]; then
    echo "Error: CODEMIE_BASE_URL environment variable is required for codemie provider" >&2
    return 1
  fi

  echo "Codemie Configuration:"
  echo "  Base URL: ${CODEMIE_BASE_URL}"
  echo "  Model: ${CODEMIE_MODEL:-claude-4-5-sonnet}"
  echo "  Max Turns: ${CODEMIE_MAX_TURNS:-50}"

  local cmd
  if [ ${#PASS_ARGS[@]} -eq 0 ]; then
    cmd=(codemie-claude
      --base-url "${CODEMIE_BASE_URL}"
      --api-key "${CODEMIE_API_KEY}"
      --model "${CODEMIE_MODEL:-claude-4-5-sonnet}"
      --provider "litellm"
      -p "$PROMPT"
      --max-turns "${CODEMIE_MAX_TURNS:-50}"
      --dangerously-skip-permissions
      --allowedTools "Bash(*),Read(*),Curl(*)")
  else
    cmd=(codemie-claude
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

  echo "Working directory: $(pwd)"
  echo ""
  echo "Running: ${cmd[*]}"
  echo ""

  local agent_log
  agent_log="$(new_agent_log_file "codemie")"
  set +e
  if [ "$(id -u)" = "0" ]; then
    # codemie-claude blocks --dangerously-skip-permissions when running as root.
    # Create a non-root user and delegate execution to it.
    useradd -m -s /bin/bash _aiagent 2>/dev/null || true
    for _bin in codemie-claude node npm npx; do
      _src="$(command -v "$_bin" 2>/dev/null)" || continue
      ln -sf "$_src" "/usr/local/bin/$_bin" 2>/dev/null || true
    done
    su _aiagent -c "git config --global user.name 'dm.ai'; git config --global user.email 'dm.ai@epam.com'" 2>/dev/null || true
    chown -R _aiagent:_aiagent "$(pwd)"
    local _quoted_cmd
    _quoted_cmd=$(printf ' %q' "${cmd[@]}")
    local _work_dir
    _work_dir=$(pwd)
    su -m _aiagent -c "HOME=/home/_aiagent && cd $(printf '%q' "$_work_dir") && ${_quoted_cmd}" 2>&1 | tee "$agent_log"
  else
    "${cmd[@]}" 2>&1 | tee "$agent_log"
  fi
  local exit_code=${PIPESTATUS[0]}
  set -e
  record_codegraph_usage "$agent_log"
  echo "Full transcript saved to: ${agent_log}"

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return $exit_code
}
