#!/bin/bash
# Fa provider for run-agent.sh
#
# fa headless contract (env preconfig — the declaration is machine-written
# and self-contained; fa never guesses catalog defaults):
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
# Sessions (when agents/setup/fa-session.sh is present, e.g. AI Teammate
# runs): --session "$FA_SESSION_NAME" --session-root "$FA_SESSION_ROOT"
# resume-or-create the deterministic named session for repo:ticket:group.

_fa_resolve_env() {
  if [ -z "${FA_PROVIDER_TYPE:-}" ]; then
    echo "Error: FA_PROVIDER_TYPE environment variable is required for fa provider" >&2
    return 1
  fi

  if [ -z "${FA_PROVIDER_CONFIG:-}" ]; then
    echo "Error: FA_PROVIDER_CONFIG is required for fa provider — a JSON object with at least {\"baseUrl\", \"model\"} (fa never guesses catalog defaults), e.g." >&2
    echo "  FA_PROVIDER_CONFIG='{\"baseUrl\":\"https://ai-proxy.lab.epam.com\",\"model\":\"gpt-4o\",\"apiKeyEnvVar\":\"DIAL_API_KEY\"}'" >&2
    return 1
  fi

  # Surface the config's key env var name so the runner can map
  # FA_PROVIDER_API_KEY into it for the subprocess when the var itself
  # is unset.
  FA_KEY_ENV_VAR="$(printf '%s' "${FA_PROVIDER_CONFIG}" | sed -n 's/.*"apiKeyEnvVar"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
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
