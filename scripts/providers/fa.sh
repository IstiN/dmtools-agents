#!/bin/bash
# Fa provider for run-agent.sh
#
# Env contract:
#   FA_PROVIDER_TYPE     (required) fa provider kind: dial | anthropic |
#                         google | openai-completions
#   FA_PROVIDER_MODEL    (required) model id / deployment name (--model)
#   FA_PROVIDER_BASE_URL (optional) endpoint override (--base-url)
#   FA_PROVIDER_API_KEY  (optional) API key; mapped per kind to the env var
#                         fa itself reads (DIAL_API_KEY, ANTHROPIC_API_KEY,
#                         GOOGLE_API_KEY, OPENROUTER_API_KEY) and exported
#                         ONLY into the fa subprocess scope
#
# Sessions (when agents/setup/fa-session.sh is present, e.g. AI Teammate
# runs): --session "$FA_SESSION_NAME" --session-root "$FA_SESSION_ROOT"
# resume-or-create the deterministic named session for repo:ticket:group.

_fa_key_env_for_type() {
  case "$1" in
    dial)               echo "DIAL_API_KEY" ;;
    anthropic)          echo "ANTHROPIC_API_KEY" ;;
    google)             echo "GOOGLE_API_KEY" ;;
    openai-completions) echo "OPENROUTER_API_KEY" ;;
    *)                  echo "" ;;
  esac
}

run_fa() {
  if [ -z "${FA_PROVIDER_TYPE:-}" ]; then
    echo "Error: FA_PROVIDER_TYPE environment variable is required for fa provider" >&2
    return 1
  fi

  local key_env
  key_env="$(_fa_key_env_for_type "${FA_PROVIDER_TYPE}")"
  if [ -z "$key_env" ]; then
    echo "Error: unsupported FA_PROVIDER_TYPE '${FA_PROVIDER_TYPE}' (expected dial, anthropic, google, or openai-completions)" >&2
    return 1
  fi

  if [ -z "${FA_PROVIDER_MODEL:-}" ]; then
    echo "Error: FA_PROVIDER_MODEL environment variable is required for fa provider" >&2
    return 1
  fi

  _fa_configure_session

  echo "Fa Configuration:"
  echo "  Provider Type: ${FA_PROVIDER_TYPE}"
  echo "  Base URL: ${FA_PROVIDER_BASE_URL:-<provider default>}"
  echo "  Model: ${FA_PROVIDER_MODEL}"
  if [ -n "${FA_SESSION_NAME:-}" ]; then
    echo "  Session: ${FA_SESSION_NAME}"
  fi

  # fa has no --continue/--resume flags: the named session resumes natively.
  # Drop them from the pass-through args (kimi.sh rewrites them the same way).
  local pass_args=()
  local arg
  for arg in ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}; do
    case "$arg" in
      --continue|--resume) ;;
      *) pass_args+=("$arg") ;;
    esac
  done

  local cmd
  cmd=(fa
    --provider "${FA_PROVIDER_TYPE}"
    --model "${FA_PROVIDER_MODEL}")
  if [ -n "${FA_PROVIDER_BASE_URL:-}" ]; then
    cmd+=(--base-url "${FA_PROVIDER_BASE_URL}")
  fi
  if [ -n "${FA_SESSION_NAME:-}" ] && [ -n "${FA_SESSION_ROOT:-}" ]; then
    cmd+=(--session "${FA_SESSION_NAME}" --session-root "${FA_SESSION_ROOT}")
  fi
  cmd+=(${pass_args[@]+"${pass_args[@]}"} -p "$PROMPT")

  echo "Working directory: $(pwd)"
  echo ""
  echo "Running: ${cmd[*]}"
  echo ""

  local agent_log
  agent_log="$(mktemp)"

  # Export the mapped key env var ONLY for the fa subprocess (claude.sh maps
  # CLAUDE_CODE_* → ANTHROPIC_* the same way) so it never leaks into the
  # surrounding job environment.
  set +e
  if [ -n "${FA_PROVIDER_API_KEY:-}" ]; then
    env "${key_env}=${FA_PROVIDER_API_KEY}" "${cmd[@]}" 2>&1 | tee "$agent_log"
  else
    "${cmd[@]}" 2>&1 | tee "$agent_log"
  fi
  local exit_code=${PIPESTATUS[0]}
  set -e

  record_codegraph_usage "$agent_log"
  rm -f "$agent_log"

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return $exit_code
}

# Configure the deterministic session when the setup script is available
# (repo-local runs may not have it — fa then runs without a named session).
# Runs inside run_fa's caller context, NOT at source time: sourcing here
# would otherwise run before the provider env validation and leak setup
# vars into unrelated shells.
_fa_configure_session() {
  local setup_dir
  setup_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../setup" && pwd)"
  if [ -z "${FA_SESSION_NAME:-}" ] && [ -f "${setup_dir}/fa-session.sh" ]; then
    # shellcheck source=/dev/null
    source "${setup_dir}/fa-session.sh" env
  fi
}
