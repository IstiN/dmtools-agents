#!/bin/bash
# Codemie provider for run-agent.sh

_fetch_codemie_jwt_token() {
  if [ -z "${CODEMIE_AUTH_URL:-}" ]; then
    echo "Error: CODEMIE_AUTH_URL is required for JWT auth" >&2
    return 1
  fi
  local response token
  response=$(curl -fsSL \
    --location "${CODEMIE_AUTH_URL}" \
    --header 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "client_id=${CODEMIE_AUTH_CLIENT_ID}" \
    --data-urlencode "grant_type=${CODEMIE_AUTH_GRANT_TYPE}" \
    --data-urlencode "client_secret=${CODEMIE_AUTH_CLIENT_SECRET}") || {
    echo "Error: failed to fetch JWT token from codemie auth endpoint" >&2
    return 1
  }
  token=$(echo "$response" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
  if [ -z "$token" ]; then
    echo "Error: access_token not found in auth response" >&2
    return 1
  fi
  echo "$token"
}

run_codemie() {
  local use_jwt=false

  if [ -n "${CODEMIE_AUTH_CLIENT_ID:-}" ] && [ -n "${CODEMIE_AUTH_CLIENT_SECRET:-}" ]; then
    use_jwt=true
  fi

  if $use_jwt; then
    echo "Fetching JWT token from codemie auth endpoint..."
    local jwt_token
    jwt_token="$(_fetch_codemie_jwt_token)" || return 1
    export CODEMIE_JWT_TOKEN="$jwt_token"
    echo "JWT token acquired"
  else
    if [ -z "${CODEMIE_API_KEY:-}" ]; then
      echo "Error: CODEMIE_API_KEY is required (or set CODEMIE_AUTH_CLIENT_ID + CODEMIE_AUTH_CLIENT_SECRET for JWT auth)" >&2
      return 1
    fi
    if [ -z "${CODEMIE_BASE_URL:-}" ]; then
      echo "Error: CODEMIE_BASE_URL environment variable is required for codemie provider" >&2
      return 1
    fi
  fi

  echo "Codemie Configuration:"
  if $use_jwt; then
    echo "  Auth: JWT bearer"
    echo "  Model: ${CODEMIE_MODEL:-claude-sonnet-4-6}"
  else
    echo "  Base URL: ${CODEMIE_BASE_URL}"
    echo "  Model: ${CODEMIE_MODEL:-claude-4-5-sonnet}"
  fi
  echo "  Max Turns: ${CODEMIE_MAX_TURNS:-50}"

  local cmd
  if $use_jwt; then
    if [ ${#PASS_ARGS[@]} -eq 0 ]; then
      cmd=(codemie-claude
        --model "${CODEMIE_MODEL:-claude-sonnet-4-6}"
        -p "$PROMPT"
        --max-turns "${CODEMIE_MAX_TURNS:-50}"
        --dangerously-skip-permissions
        --allowedTools "Bash(*),Read(*),Curl(*)")
    else
      cmd=(codemie-claude
        --model "${CODEMIE_MODEL:-claude-sonnet-4-6}"
        ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
        -p "$PROMPT"
        --max-turns "${CODEMIE_MAX_TURNS:-50}"
        --dangerously-skip-permissions
        --allowedTools "Bash(*),Read(*),Curl(*)")
    fi
  else
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
    # Make all of root's home world-readable/executable so _aiagent can find
    # binaries installed under $HOME (codemie-claude, the claude binary from
    # 'codemie install claude', etc.).
    chmod -R a+rwX "${HOME}" 2>/dev/null || true
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
    su -m _aiagent -c "cd $(printf '%q' "$_work_dir") && ${_quoted_cmd}" 2>&1 | tee "$agent_log"
  else
    "${cmd[@]}" 2>&1 | tee "$agent_log"
  fi
  local exit_code=${PIPESTATUS[0]}
  set -e
  record_codegraph_usage "$agent_log"
  echo "Full transcript saved to: ${agent_log}"

  echo ""
  echo "=== Agent Transcript ==="
  cat "$agent_log" 2>/dev/null || echo "(transcript file not found)"
  echo "=== End Transcript ==="

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return $exit_code
}
