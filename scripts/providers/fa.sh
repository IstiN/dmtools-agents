#!/bin/bash
# Fa provider for run-agent.sh
#
# Current fa contract (env preconfig, fa ≥ 0.1.32x — the declaration is
# machine-written and self-contained; fa never guesses catalog defaults):
#   FA_PROVIDER_TYPE     (required) catalog provider kind: anthropic,
#                        google, dial, openai-completions, zai, aiin,
#                        minimax, chatgpt-codex, copilot, codemie,
#                        ollama, openai, openrouter, kimi, …
#   FA_PROVIDER_CONFIG   (required, JSON) {"baseUrl": …, "model": …,
#                        "apiKeyEnvVar": …} — baseUrl and model are
#                        mandatory (fa fails the boot without them),
#                        apiKeyEnvVar names the env var that carries the
#                        API key (its _BASE64 twin also accepted)
#   FA_PROVIDER_NAME     (optional) unique entry name override
#   FA_PROVIDER_API_KEY  (optional) convenience: mapped into the env var
#                        the config's apiKeyEnvVar names — ONLY inside
#                        the fa subprocess scope
#
# Legacy shim (pre-2026-09 contract, kept for old job definitions):
#   FA_PROVIDER_MODEL    model id
#   FA_PROVIDER_BASE_URL endpoint (optional — kind default used)
#   FA_PROVIDER_API_KEY  key
# When FA_PROVIDER_CONFIG is unset, the script composes it from these
# legacy vars (apiKeyEnvVar defaults to the kind's conventional name) —
# so old job env blocks keep working unmodified.
#
# Sessions (when agents/setup/fa-session.sh is present, e.g. AI Teammate
# runs): --session "$FA_SESSION_NAME" --session-root "$FA_SESSION_ROOT"
# resume-or-create the deterministic named session for repo:ticket:group.

# Legacy kind → conventional API-key env name (used only to compose
# FA_PROVIDER_CONFIG from the legacy vars).
_fa_key_env_for_type() {
  case "$1" in
    dial)               echo "DIAL_API_KEY" ;;
    anthropic)          echo "ANTHROPIC_API_KEY" ;;
    google)             echo "GOOGLE_API_KEY" ;;
    openai-completions) echo "OPENROUTER_API_KEY" ;;
    *)                  echo "" ;;
  esac
}

_fa_resolve_env() {
  if [ -z "${FA_PROVIDER_TYPE:-}" ]; then
    echo "Error: FA_PROVIDER_TYPE environment variable is required for fa provider" >&2
    return 1
  fi

  if [ -n "${FA_PROVIDER_CONFIG:-}" ]; then
    # Current contract: the declaration is authoritative. Surface the
    # config's key env var name so the runner can map FA_PROVIDER_API_KEY
    # into it for the subprocess when the var itself is unset.
    FA_KEY_ENV_VAR="$(printf '%s' "${FA_PROVIDER_CONFIG}" | sed -n 's/.*"apiKeyEnvVar"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    return 0
  fi

  # Legacy shim: compose FA_PROVIDER_CONFIG from the old flat vars.
  if [ -z "${FA_PROVIDER_MODEL:-}" ]; then
    echo "Error: FA_PROVIDER_CONFIG (or legacy FA_PROVIDER_MODEL) is required for fa provider" >&2
    return 1
  fi
  local key_env
  key_env="$(_fa_key_env_for_type "${FA_PROVIDER_TYPE}")"
  if [ -z "${FA_PROVIDER_BASE_URL:-}" ]; then
    echo "Error: FA_PROVIDER_BASE_URL is required with the legacy FA_PROVIDER_MODEL contract (fa no longer guesses catalog defaults)" >&2
    return 1
  fi
  echo "⚠️  Legacy fa provider env detected (FA_PROVIDER_MODEL/BASE_URL) — composing FA_PROVIDER_CONFIG" >&2
  FA_PROVIDER_CONFIG="$(printf '{"baseUrl":"%s","model":"%s","apiKeyEnvVar":"%s"}' \
    "${FA_PROVIDER_BASE_URL}" "${FA_PROVIDER_MODEL}" "${key_env}")"
  FA_KEY_ENV_VAR="${key_env}"
}

run_fa() {
  _fa_resolve_env || return 1

  _fa_configure_session

  echo "Fa Configuration:"
  echo "  Provider Type: ${FA_PROVIDER_TYPE}"
  [ -n "${FA_PROVIDER_NAME:-}" ] && echo "  Entry Name: ${FA_PROVIDER_NAME}"
  echo "  Config: ${FA_PROVIDER_CONFIG}"
  local pass_args=()
  local arg
  for arg in ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}; do
    case "$arg" in
      --continue|--resume) ;;
      *) pass_args+=("$arg") ;;
    esac
  done

  # Provider selection is driven entirely by the FA_PROVIDER_* env
  # preconfig (fa precedence: explicit flags > preconfig > saved config).
  # No --provider/--model/--base-url flags here — the env declaration is
  # the single source of truth and pins every model role.
  local cmd
  cmd=(fa)
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

  # Map FA_PROVIDER_API_KEY into the env var the config's apiKeyEnvVar
  # names — ONLY for the fa subprocess (claude.sh maps CLAUDE_CODE_* →
  # ANTHROPIC_* the same way) so it never leaks into the surrounding job
  # environment. When the caller already exported the named var, fa reads
  # it directly and nothing is injected.
  set +e
  if [ -n "${FA_PROVIDER_API_KEY:-}" ] && [ -n "${FA_KEY_ENV_VAR:-}" ] \
     && [ -z "$(eval "echo \${${FA_KEY_ENV_VAR}:-}")" ]; then
    env "${FA_KEY_ENV_VAR}=${FA_PROVIDER_API_KEY}" "${cmd[@]}" 2>&1 | tee "$agent_log"
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
  setup_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../setup" 2>/dev/null && pwd || true)"
  if [ -z "${FA_SESSION_NAME:-}" ] && [ -f "${setup_dir}/fa-session.sh" ]; then
    # shellcheck source=/dev/null
    source "${setup_dir}/fa-session.sh" env
  fi
}
