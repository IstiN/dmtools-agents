#!/bin/bash
# Fa provider for run-agent.sh
#
#   FA_PROVIDERS_QUEUE   (recommended, JSON array or @path) provider failover
#                        queue: [{"provider_type": ..., "provider_config":
#                        {"baseUrl": ..., "model": ..., "apiKeyEnv": ...}}]
#                        (or "$VAR_NAME" indirect env reference).
#   FA_PROVIDER_TYPE     (required when FA_PROVIDERS_QUEUE is unset) catalog
#                        provider kind: anthropic, google, dial,
#                        openai-completions, zai, aiin, minimax, chatgpt-codex,
#                        copilot, codemie, ollama, openai, openrouter, kimi, …
#   FA_PROVIDER_CONFIG   (required when FA_PROVIDERS_QUEUE is unset, JSON)
#                        {"baseUrl": …, "model": …, "apiKeyEnvVar": …} —
#                        baseUrl and model are mandatory, apiKeyEnvVar names
#                        the env var that carries the API key (its _BASE64
#                        twin also accepted)
#   FA_PROVIDER_NAME     (optional) unique entry name override
#   FA_PROVIDER_API_KEY  (optional) convenience: mapped into the env var
#                        the config's apiKeyEnvVar names — ONLY inside
#                        the fa subprocess scope
#
# Sessions (when agents/setup/fa-session.sh is present, e.g. AI Teammate
# runs): --session "$FA_SESSION_NAME" --session-root "$FA_SESSION_ROOT"
# resume-or-create the deterministic named session for repo:ticket:group.

_fa_default_base_url() {
  case "${1:-}" in
    zai) echo "https://api.z.ai/api/coding/paas/v4" ;;
    copilot) echo "https://api.enterprise.githubcopilot.com" ;;
    anthropic) echo "https://api.anthropic.com" ;;
    openai) echo "https://api.openai.com/v1" ;;
    openrouter) echo "https://openrouter.ai/api/v1" ;;
    google) echo "https://generativelanguage.googleapis.com/v1beta" ;;
    *) echo "" ;;
  esac
}

_fa_derive_from_queue() {
  local queue_raw="${FA_PROVIDERS_QUEUE:-}"
  if [ -z "${queue_raw}" ]; then
    return 0
  fi

  local derived=""
  if command -v node >/dev/null 2>&1; then
    derived="$(node -e '
      const fs = require("fs");
      let raw = process.env.FA_PROVIDERS_QUEUE || "";
      if (raw.startsWith("@")) {
        raw = fs.readFileSync(raw.slice(1), "utf8");
      }
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) process.exit(0);
      const defaults = {
        zai: "https://api.z.ai/api/coding/paas/v4",
        copilot: "https://api.enterprise.githubcopilot.com",
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com/v1",
        openrouter: "https://openrouter.ai/api/v1",
        google: "https://generativelanguage.googleapis.com/v1beta"
      };
      let entry = arr.find(e => {
        const k = e && e.provider_config && (e.provider_config.apiKeyEnv || e.provider_config.apiKeyEnvVar);
        return k && (process.env[k] || process.env[k + "_BASE64"]);
      }) || arr[0];
      if (!entry || !entry.provider_type || !entry.provider_config) process.exit(0);
      const ptype = String(entry.provider_type);
      const src = entry.provider_config;
      const baseUrl = src.baseUrl || defaults[ptype] || "";
      if (!baseUrl) process.exit(0);
      const allowed = ["baseUrl", "model", "input", "thinkingLevel", "contextWindow", "maxTokens", "wire"];
      const cfg = { baseUrl };
      for (const k of allowed) {
        if (k !== "baseUrl" && src[k] !== undefined) cfg[k] = src[k];
      }
      const keyEnv = src.apiKeyEnv || src.apiKeyEnvVar;
      if (keyEnv) cfg.apiKeyEnvVar = keyEnv;
      process.stdout.write(ptype + "\n" + JSON.stringify(cfg));
    ' 2>/dev/null || true)"
  elif command -v jq >/dev/null 2>&1; then
    local queue_json="${queue_raw}"
    if [[ "${queue_raw}" == @* ]] && [ -f "${queue_raw#@}" ]; then
      queue_json="$(cat "${queue_raw#@}")"
    fi
    derived="$(printf '%s' "${queue_json}" | jq -r '
      if type == "array" and length > 0 then
        (map(select(
          (.provider_config.apiKeyEnv // .provider_config.apiKeyEnvVar // "") as $k |
          ($k != "" and ((env[$k] // "") != "" or (env[$k + "_BASE64"] // "") != ""))
        ))[0] // .[0]) as $e |
        ($e.provider_type // "") as $pt |
        ({
          zai: "https://api.z.ai/api/coding/paas/v4",
          copilot: "https://api.enterprise.githubcopilot.com",
          anthropic: "https://api.anthropic.com",
          openai: "https://api.openai.com/v1",
          openrouter: "https://openrouter.ai/api/v1",
          google: "https://generativelanguage.googleapis.com/v1beta"
        }[$pt] // "") as $defUrl |
        ($e.provider_config.baseUrl // $defUrl) as $url |
        if $pt != "" and $url != "" then
          $pt,
          (($e.provider_config | with_entries(select(.key | IN("baseUrl", "model", "input", "thinkingLevel", "contextWindow", "maxTokens", "wire"))))
            + {baseUrl: $url}
            + (if ($e.provider_config.apiKeyEnv // $e.provider_config.apiKeyEnvVar) then {apiKeyEnvVar: ($e.provider_config.apiKeyEnv // $e.provider_config.apiKeyEnvVar)} else {} end)
            | tojson)
        else empty end
      else empty end
    ' 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1; then
    derived="$(python3 -c '
import json, os, sys
raw = os.environ.get("FA_PROVIDERS_QUEUE", "")
if raw.startswith("@"):
    with open(raw[1:], "r", encoding="utf-8") as f:
        raw = f.read()
arr = json.loads(raw)
if not isinstance(arr, list) or not arr:
    sys.exit(0)
defaults = {
    "zai": "https://api.z.ai/api/coding/paas/v4",
    "copilot": "https://api.enterprise.githubcopilot.com",
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
}
entry = None
for e in arr:
    pc = (e or {}).get("provider_config") or {}
    k = pc.get("apiKeyEnv") or pc.get("apiKeyEnvVar")
    if k and (os.environ.get(k) or os.environ.get(k + "_BASE64")):
        entry = e
        break
if entry is None:
    entry = arr[0]
pt = (entry or {}).get("provider_type") or ""
src = (entry or {}).get("provider_config") or {}
url = src.get("baseUrl") or defaults.get(pt, "")
if not pt or not url:
    sys.exit(0)
allowed = ("baseUrl", "model", "input", "thinkingLevel", "contextWindow", "maxTokens", "wire")
cfg = {"baseUrl": url}
for k in allowed:
    if k != "baseUrl" and k in src:
        cfg[k] = src[k]
ke = src.get("apiKeyEnv") or src.get("apiKeyEnvVar")
if ke:
    cfg["apiKeyEnvVar"] = ke
sys.stdout.write(pt + "\n" + json.dumps(cfg, separators=(",", ":")))
' 2>/dev/null || true)"
  fi

  if [ -z "${derived}" ]; then
    # POSIX/sed fallback on entry 0
    local queue_json="${queue_raw}"
    if [[ "${queue_raw}" == @* ]] && [ -f "${queue_raw#@}" ]; then
      queue_json="$(cat "${queue_raw#@}")"
    fi
    local ptype
    ptype="$(printf '%s' "${queue_json}" | sed -n 's/.*"provider_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    local pcfg
    pcfg="$(printf '%s' "${queue_json}" | sed -n 's/.*"provider_config"[[:space:]]*:[[:space:]]*\({[^}]*}\).*/\1/p' | head -n 1)"
    if [ -n "${ptype}" ] && [ -n "${pcfg}" ]; then
      pcfg="$(printf '%s' "${pcfg}" | sed 's/"apiKeyEnv"/"apiKeyEnvVar"/g')"
      if ! printf '%s' "${pcfg}" | grep -q '"baseUrl"'; then
        local def_url
        def_url="$(_fa_default_base_url "${ptype}")"
        if [ -n "${def_url}" ]; then
          pcfg="$(printf '%s' "${pcfg}" | sed "s|^{|{\"baseUrl\":\"${def_url}\",|")"
        else
          pcfg=""
        fi
      fi
      if [ -n "${pcfg}" ]; then
        derived="$(printf '%s\n%s' "${ptype}" "${pcfg}")"
      fi
    fi
  fi

  if [ -n "${derived}" ]; then
    local d_type d_cfg
    d_type="$(printf '%s\n' "${derived}" | sed -n '1p')"
    d_cfg="$(printf '%s\n' "${derived}" | sed -n '2p')"
    if [ -n "${d_type}" ] && [ -n "${d_cfg}" ]; then
      [ -z "${FA_PROVIDER_TYPE:-}" ] && export FA_PROVIDER_TYPE="${d_type}"
      [ -z "${FA_PROVIDER_CONFIG:-}" ] && export FA_PROVIDER_CONFIG="${d_cfg}"
    fi
  fi
}

_fa_resolve_env() {
  if [ -z "${FA_PROVIDER_TYPE:-}" ] && [ -z "${FA_PROVIDERS_QUEUE:-}" ]; then
    echo "Error: FA_PROVIDERS_QUEUE or FA_PROVIDER_TYPE + FA_PROVIDER_CONFIG environment variable is required for fa provider" >&2
    return 1
  fi

  if [ -n "${FA_PROVIDERS_QUEUE:-}" ]; then
    if [[ "${FA_PROVIDERS_QUEUE}" =~ ^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$ ]]; then
      local var_name="${BASH_REMATCH[1]}"
      local resolved_val="${!var_name:-}"
      if [ -z "${resolved_val}" ]; then
        echo "Error: FA_PROVIDERS_QUEUE references unset environment variable ${FA_PROVIDERS_QUEUE}" >&2
        return 1
      fi
      export FA_PROVIDERS_QUEUE="${resolved_val}"
    fi

    if [ -z "${FA_PROVIDER_TYPE:-}" ] || [ -z "${FA_PROVIDER_CONFIG:-}" ]; then
      _fa_derive_from_queue
    fi
  else
    if [ -z "${FA_PROVIDER_CONFIG:-}" ]; then
      echo "Error: FA_PROVIDER_CONFIG is required for fa provider — a JSON object with at least {\"baseUrl\", \"model\"} (fa never guesses catalog defaults), e.g." >&2
      echo "  FA_PROVIDER_CONFIG='{\"baseUrl\":\"https://ai-proxy.lab.epam.com\",\"model\":\"gpt-4o\",\"apiKeyEnvVar\":\"DIAL_API_KEY\"}'" >&2
      return 1
    fi
  fi

  # Surface the config's key env var name so the runner can map
  # FA_PROVIDER_API_KEY into it for the subprocess when the var itself
  # is unset.
  FA_KEY_ENV_VAR=""
  if [ -n "${FA_PROVIDER_CONFIG:-}" ]; then
    FA_KEY_ENV_VAR="$(printf '%s' "${FA_PROVIDER_CONFIG}" | sed -n 's/.*"apiKeyEnvVar"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  fi
}

run_fa() {
  _fa_resolve_env || return 1

  _fa_configure_session

  echo "Fa Configuration:"
  [ -n "${FA_PROVIDERS_QUEUE:-}" ] && echo "  Provider Queue: ${FA_PROVIDERS_QUEUE}"
  [ -n "${FA_PROVIDER_TYPE:-}" ] && echo "  Provider Type: ${FA_PROVIDER_TYPE}"
  [ -n "${FA_PROVIDER_NAME:-}" ] && echo "  Entry Name: ${FA_PROVIDER_NAME}"
  [ -n "${FA_PROVIDER_CONFIG:-}" ] && echo "  Config: ${FA_PROVIDER_CONFIG}"

  # Detect whether a prior fa session already exists on disk under
  # FA_SESSION_ROOT (excluding sidecar manifest files). When resuming an
  # existing session across legs (and NOT an intra-leg feedbackLoop `--continue`
  # / `--resume` call whose short prompt is already a targeted follow-up),
  # send the composite resume notice (`resumed_session_reread_pointer_notice`)
  # instead of re-sending the 50KB+ static prompt inline (gh-1064).
  local fa_has_explicit_resume_flag=false
  local pass_args=()
  local arg
  for arg in ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}; do
    case "$arg" in
      --continue|--resume)
        fa_has_explicit_resume_flag=true
        ;;
      *) pass_args+=("$arg") ;;
    esac
  done

  local fa_is_actual_resume=false
  if [ "${fa_has_explicit_resume_flag}" = "false" ] \
     && [ -n "${FA_SESSION_NAME:-}" ] && [ -n "${FA_SESSION_ROOT:-}" ] \
     && _fa_session_exists_on_disk "${FA_SESSION_ROOT}"; then
    fa_is_actual_resume=true
    echo "♻️  Resuming existing fa session in ${FA_SESSION_ROOT}"
  fi

  local fa_prompt_message="${PROMPT}"
  local fa_prompt_file="" fa_cleanup_prompt_file=false
  if [ "${fa_is_actual_resume}" = "true" ] && command -v resumed_session_reread_pointer_notice >/dev/null 2>&1; then
    fa_prompt_file="$(ensure_prompt_file)"
    if [ ! -f "${PROMPT_ARG:-}" ]; then
      fa_cleanup_prompt_file=true
    fi
    fa_prompt_message="$(resumed_session_reread_pointer_notice "${fa_prompt_file}")"
  fi

  # Provider selection is driven entirely by the FA_PROVIDER_* env
  # preconfig (fa precedence: explicit flags > preconfig > saved config).
  # No --provider/--model/--base-url flags here — the env declaration is
  # the single source of truth and pins every model role.
  local cmd
  cmd=(fa)
  if [ -n "${FA_SESSION_NAME:-}" ] && [ -n "${FA_SESSION_ROOT:-}" ]; then
    cmd+=(--session "${FA_SESSION_NAME}" --session-root "${FA_SESSION_ROOT}")
  fi
  # FA_LOG_FILE (optional): tee fa's full stdout trace (assistant text, tool
  # calls) to this file — untruncated, unlike the terminal-width trajectory
  # rows. CI tails/uploads it; requires fa >= v0.1.335 (--log-file).
  # Callers can still pass --log-file explicitly via PASS_ARGS.
  if [ -n "${FA_LOG_FILE:-}" ] \
    && ! printf '%s\n' ${pass_args[@]+"${pass_args[@]}"} | grep -qx -- '--log-file'; then
    mkdir -p "$(dirname "${FA_LOG_FILE}")"
    cmd+=(--log-file "${FA_LOG_FILE}")
  fi
  cmd+=(${pass_args[@]+"${pass_args[@]}"} -p "$fa_prompt_message")

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

  if [ "${fa_cleanup_prompt_file}" = "true" ] && [ -n "${fa_prompt_file}" ]; then
    rm -f "${fa_prompt_file}"
  fi

  if [ "${exit_code}" -eq 0 ] && command -v promote_pending_session_manifest >/dev/null 2>&1; then
    promote_pending_session_manifest "${exit_code}" || true
  fi

  record_codegraph_usage "$agent_log"
  rm -f "$agent_log"

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return $exit_code
}

# True when FA_SESSION_ROOT already contains at least one non-manifest session
# file (e.g. a `.jsonl` transcript from a previous leg).
_fa_session_exists_on_disk() {
  local root="${1:-}"
  if [ -z "${root}" ] || [ ! -d "${root}" ]; then
    return 1
  fi
  local found
  found="$(find "${root}" -type f \
    ! -name '.session-input-manifest.json' \
    ! -name '.pending-input-manifest.json' \
    -print -quit 2>/dev/null || true)"
  [ -n "${found}" ]
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
