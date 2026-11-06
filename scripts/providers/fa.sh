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
#   FA_QUOTA_PROBE       (optional, default on) set `off`/`0`/`false` to
#                        skip the pre-leg z.ai quota probe (gh-1385) that
#                        re-orders the queue most-unspent-first by each
#                        key's remaining 5-hour-window quota; any probe
#                        failure keeps the static order — never fatal
#
# Sessions (when agents/setup/fa-session.sh is present, e.g. AI Teammate
# runs): --session "$FA_SESSION_NAME" --session-root "$FA_SESSION_ROOT"
# resume-or-create the deterministic named session for repo:ticket:group.

# Single source of truth for catalog default base URLs and allowed legacy
# FA_PROVIDER_CONFIG keys (stripped of queue-only connectTimeoutMs /
# streamIdleTimeoutMs so pre-flutter_agent_harness#1781 binaries never reject).
_FA_DEFAULT_URLS_JSON='{"zai":"https://api.z.ai/api/coding/paas/v4","copilot":"https://api.enterprise.githubcopilot.com","anthropic":"https://api.anthropic.com","openai":"https://api.openai.com/v1","openrouter":"https://openrouter.ai/api/v1","google":"https://generativelanguage.googleapis.com/v1beta"}'
_FA_ALLOWED_CFG_KEYS_JSON='["baseUrl","model","input","thinkingLevel","contextWindow","maxTokens","wire"]'

_fa_derive_from_queue() {
  local queue_raw="${FA_PROVIDERS_QUEUE:-}"
  if [ -z "${queue_raw}" ]; then
    return 0
  fi

  local derived=""
  if command -v node >/dev/null 2>&1; then
    derived="$(FA_DEFAULT_URLS_JSON="${_FA_DEFAULT_URLS_JSON}" FA_ALLOWED_CFG_KEYS_JSON="${_FA_ALLOWED_CFG_KEYS_JSON}" node -e '
      const fs = require("fs");
      let raw = process.env.FA_PROVIDERS_QUEUE || "";
      if (raw.startsWith("@")) raw = fs.readFileSync(raw.slice(1), "utf8");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) process.exit(0);
      const defaults = JSON.parse(process.env.FA_DEFAULT_URLS_JSON);
      const allowed = JSON.parse(process.env.FA_ALLOWED_CFG_KEYS_JSON);
      const entry = arr.find(e => {
        const k = e && e.provider_config && (e.provider_config.apiKeyEnv || e.provider_config.apiKeyEnvVar);
        return k && (process.env[k] || process.env[k + "_BASE64"]);
      }) || arr[0];
      if (!entry || !entry.provider_type || !entry.provider_config) process.exit(0);
      const ptype = String(entry.provider_type);
      const src = entry.provider_config;
      const baseUrl = src.baseUrl || defaults[ptype] || "";
      if (!baseUrl) process.exit(0);
      const cfg = { baseUrl };
      for (const k of allowed) {
        if (k !== "baseUrl" && src[k] !== undefined) cfg[k] = src[k];
      }
      const keyEnv = src.apiKeyEnv || src.apiKeyEnvVar;
      if (keyEnv) cfg.apiKeyEnvVar = keyEnv;
      process.stdout.write(ptype + "\n" + JSON.stringify(cfg));
    ' 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1; then
    derived="$(FA_DEFAULT_URLS_JSON="${_FA_DEFAULT_URLS_JSON}" FA_ALLOWED_CFG_KEYS_JSON="${_FA_ALLOWED_CFG_KEYS_JSON}" python3 -c '
import json, os, sys
raw = os.environ.get("FA_PROVIDERS_QUEUE", "")
if raw.startswith("@"):
    with open(raw[1:], "r", encoding="utf-8") as f:
        raw = f.read()
arr = json.loads(raw)
if not isinstance(arr, list) or not arr:
    sys.exit(0)
defaults = json.loads(os.environ["FA_DEFAULT_URLS_JSON"])
allowed = json.loads(os.environ["FA_ALLOWED_CFG_KEYS_JSON"])
entry = next((e for e in arr if isinstance(e, dict) and isinstance(e.get("provider_config"), dict) and (lambda k: bool(k and (os.environ.get(k) or os.environ.get(k + "_BASE64"))))(e["provider_config"].get("apiKeyEnv") or e["provider_config"].get("apiKeyEnvVar"))), arr[0])
if not isinstance(entry, dict) or not entry.get("provider_type") or not isinstance(entry.get("provider_config"), dict):
    sys.exit(0)
pt = str(entry["provider_type"])
src = entry["provider_config"]
url = src.get("baseUrl") or defaults.get(pt, "")
if not pt or not url:
    sys.exit(0)
cfg = {"baseUrl": url}
for k in allowed:
    if k != "baseUrl" and k in src:
        cfg[k] = src[k]
ke = src.get("apiKeyEnv") or src.get("apiKeyEnvVar")
if ke:
    cfg["apiKeyEnvVar"] = ke
sys.stdout.write(pt + "\n" + json.dumps(cfg, separators=(",", ":")))
' 2>/dev/null || true)"
  else
    echo "Error: node or python3 is required to derive FA_PROVIDER_TYPE/FA_PROVIDER_CONFIG from FA_PROVIDERS_QUEUE" >&2
    return 1
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

# gh-1381: provider-key failover — auto-append fallback queue entries.
# For each queue entry whose key env var is E, every set variant E_1..E_5
# (and E_N_BASE64 twins) is appended as a failover entry cloning the base
# entry's provider/model with apiKeyEnv swapped to the fallback var.
# Deployment = add a secret named E_1; no queue-JSON editing. Already-
# referenced variants are skipped (no duplicates); unset/empty variants are
# skipped; with node unavailable or nothing appended the queue is returned
# byte-identical (the pre-gh-1381 behavior).
_fa_append_fallback_keys() {
  command -v node >/dev/null 2>&1 || return 0
  [ -n "${FA_PROVIDERS_QUEUE:-}" ] || return 0
  local enriched
  enriched="$(FA_PROVIDERS_QUEUE="${FA_PROVIDERS_QUEUE}" FA_DEFAULT_URLS_JSON="${_FA_DEFAULT_URLS_JSON}" node -e '
    const fs = require("fs");
    let raw = process.env.FA_PROVIDERS_QUEUE || "";
    if (raw.startsWith("@")) raw = fs.readFileSync(raw.slice(1), "utf8");
    let arr;
    try { arr = JSON.parse(raw); } catch (e) { process.exit(0); }
    if (!Array.isArray(arr) || arr.length === 0) process.exit(0);
    const defaults = JSON.parse(process.env.FA_DEFAULT_URLS_JSON);
    const refOf = (e) => (e && e.provider_config && (e.provider_config.apiKeyEnv || e.provider_config.apiKeyEnvVar)) || null;
    const seen = new Set(arr.map(refOf).filter(Boolean));
    const out = [];
    const appended = [];
    for (const entry of arr) {
      out.push(entry);
      const k = refOf(entry);
      if (!k || !entry.provider_type || !entry.provider_config) continue;
      for (let i = 1; i <= 5; i++) {
        const fb = k + "_" + i;
        if (seen.has(fb)) break;
        if (!process.env[fb] && !process.env[fb + "_BASE64"]) continue;
        const clone = JSON.parse(JSON.stringify(entry.provider_config));
        if (clone.apiKeyEnv !== undefined) clone.apiKeyEnv = fb;
        else if (clone.apiKeyEnvVar !== undefined) clone.apiKeyEnvVar = fb;
        else clone.apiKeyEnv = fb;
        if (!clone.baseUrl) {
          const d = defaults[entry.provider_type];
          if (!d) continue;
          clone.baseUrl = d;
        }
        const ne = { provider_type: entry.provider_type, provider_config: clone };
        if (entry.name) ne.name = entry.name + "-" + i;
        out.push(ne);
        seen.add(fb);
        appended.push(fb);
      }
    }
    if (appended.length === 0) process.exit(0);
    process.stderr.write("[providers/fa.sh] fallback provider keys appended to the queue: " + appended.join(", ") + "\n");
    process.stdout.write(JSON.stringify(out));
  ')" || return 0
  if [ -n "${enriched}" ]; then
    export FA_PROVIDERS_QUEUE="${enriched}"
  fi
  return 0
}

# gh-1385: quota-aware provider ordering — probe every zai queue entry's key
# ONCE against the coding-plan quota endpoint and re-order the queue
# most-unspent-first (score = `remaining` of the rolling 5-hour window — the
# window provider storms exhaust). Key topology note: entries are keyed by
# the KEY VALUE, so same-account key sets collapse to one probe and equal
# scores keep the static order (no churn). Score-0 (exhausted) and 401/403
# keys move to the END (not dropped — a reset may be nearer than a cold
# key); every other probe failure (non-200, timeout, unparseable/changed
# shape, missing curl/node) leaves that entry at its static position and
# NEVER fails the leg — the endpoint is undocumented, its shape can change
# without notice. Kill switch: FA_QUOTA_PROBE=off (or 0/false, any case)
# skips probing entirely; default ON, zai entries only — other providers are
# never probed. One HTTP call per distinct key per resolution, single
# attempt, short timeout (no retry storms). Entries whose baseUrl leaves
# api.z.ai (e.g. china-platform keys) are not probed — out of scope (the
# host check is boundary-exact: only https://api.z.ai or https://api.z.ai/
# prefixed baseUrls are probed, never api.z.ai.cn or other siblings).
# The whole probe step runs under an aggregate per-leg budget (default 10 s,
# override with FA_QUOTA_PROBE_BUDGET_MS, clamped to 500 ms..120 s) — once
# spent, unprobed keys keep their static slot ("probe-budget"), so a slow or
# unreachable endpoint costs every leg at most the budget, not N x timeout.
# The API key is handed to curl via a stdin config (-K -), never as an argv
# element, so it cannot leak through ps//proc cmdline.
_fa_order_queue_by_quota() {
  [ -n "${FA_PROVIDERS_QUEUE:-}" ] || return 0
  case "$(printf '%s' "${FA_QUOTA_PROBE:-on}" | tr '[:upper:]' '[:lower:]')" in
    off|0|false) return 0 ;;
  esac
  command -v node >/dev/null 2>&1 || return 0
  command -v curl >/dev/null 2>&1 || return 0
  local ordered
  ordered="$(FA_PROVIDERS_QUEUE="${FA_PROVIDERS_QUEUE}" node -e '
    const fs = require("fs");
    const cp = require("child_process");
    let raw = process.env.FA_PROVIDERS_QUEUE || "";
    if (raw.startsWith("@")) raw = fs.readFileSync(raw.slice(1), "utf8");
    let arr;
    try { arr = JSON.parse(raw); } catch (e) { process.exit(0); }
    if (!Array.isArray(arr) || arr.length === 0) process.exit(0);
    const ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
    const PROBE_TIMEOUT_S = 5;
    const BUDGET_RAW = parseInt(process.env.FA_QUOTA_PROBE_BUDGET_MS || "", 10);
    const BUDGET_MS = isFinite(BUDGET_RAW) && BUDGET_RAW >= 500 ? Math.min(BUDGET_RAW, 120000) : 10000;
    const startedAt = Date.now();
    const cache = new Map();
    const keyOf = (entry) => {
      const cfg = entry && entry.provider_config;
      if (!cfg) return null;
      const name = cfg.apiKeyEnv || cfg.apiKeyEnvVar;
      if (!name) return null;
      if (process.env[name]) return process.env[name];
      const b64 = process.env[name + "_BASE64"];
      if (!b64) return null;
      try { return Buffer.from(b64, "base64").toString("utf8"); } catch (e) { return null; }
    };
    const scoreOf = (limits) => {
      let win = null;
      for (const l of limits) { if (l && l.number === 5 && l.unit === 3) { win = l; break; } }
      if (!win) {
        const rs = limits.filter(l => l && typeof l.nextResetTime === "number").sort((a, b) => a.nextResetTime - b.nextResetTime);
        if (rs.length > 0) win = rs[0];
      }
      if (!win) { for (const l of limits) { if (l && typeof l.remaining === "number") { win = l; break; } } }
      if (!win || typeof win.remaining !== "number" || !isFinite(win.remaining)) return null;
      return win.remaining;
    };
    const probe = (key) => {
      let out = null;
      let errWhy = "timeout";
      try {
        out = cp.execFileSync("curl", ["-sS", "-m", String(PROBE_TIMEOUT_S), "-K", "-", "-w", "\n%{http_code}", ENDPOINT], { encoding: "utf8", timeout: (PROBE_TIMEOUT_S + 2) * 1000, input: "header = \"Authorization: Bearer " + key + "\"\n", stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        out = null;
        if (e && (e.killed || e.signal)) errWhy = "timeout";
        else if (e && e.status === 28) errWhy = "timeout";
        else if (e && typeof e.status === "number" && e.status > 0) errWhy = "curl-exit " + e.status;
        else errWhy = "timeout";
      }
      if (out === null) return { group: 2, score: null, why: errWhy };
      const nl = out.lastIndexOf("\n");
      const status = parseInt(out.slice(nl + 1).trim(), 10);
      const body = out.slice(0, nl);
      if (status === 401 || status === 403) return { group: 3, score: null, why: "unauthorized" };
      if (status !== 200) return { group: 2, score: null, why: "http " + (isNaN(status) ? "?" : status) };
      let limits = null;
      try {
        const parsed = JSON.parse(body);
        limits = parsed && parsed.data && Array.isArray(parsed.data.limits) ? parsed.data.limits : null;
      } catch (e) { limits = null; }
      if (!limits) return { group: 2, score: null, why: "shape" };
      const score = scoreOf(limits);
      if (score === null) return { group: 2, score: null, why: "shape" };
      if (score > 0) return { group: 1, score: score, why: String(score) };
      return { group: 3, score: 0, why: "exhausted" };
    };
    const decorated = arr.map((entry, idx) => {
      const cfg = entry && entry.provider_config;
      const baseUrl = cfg ? (cfg.baseUrl || "") : "";
      const sameHost = !baseUrl ||
        baseUrl === "https://api.z.ai" ||
        baseUrl.indexOf("https://api.z.ai/") === 0;
      const key = entry && entry.provider_type === "zai" && sameHost ? keyOf(entry) : null;
      let cls = { group: 2, score: null, why: "not-probed" };
      if (key) {
        if (!cache.has(key)) {
          if (Date.now() - startedAt >= BUDGET_MS) {
            cache.set(key, { group: 2, score: null, why: "probe-budget" });
          } else {
            cache.set(key, probe(key));
          }
        }
        cls = cache.get(key);
      }
      const ref = (cfg && (cfg.apiKeyEnv || cfg.apiKeyEnvVar)) || ("#" + idx);
      return { entry: entry, idx: idx, group: cls.group, score: cls.score, why: cls.why, ref: entry && entry.name ? entry.name : ref };
    });
    decorated.sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      if (a.group === 1 && a.score !== b.score) return b.score - a.score;
      return a.idx - b.idx;
    });
    if (decorated.every((d, i) => d.idx === i)) process.exit(0);
    process.stderr.write("[providers/fa.sh] queue re-ordered by remaining z.ai quota (5h window first): " + decorated.map(d => d.ref + "=" + d.why).join(", ") + "\n");
    process.stdout.write(JSON.stringify(decorated.map(d => d.entry)));
  ')" || return 0
  if [ -n "${ordered}" ]; then
    export FA_PROVIDERS_QUEUE="${ordered}"
  fi
  return 0
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

    _fa_append_fallback_keys
    _fa_order_queue_by_quota
    if [ -z "${FA_PROVIDER_TYPE:-}" ] || [ -z "${FA_PROVIDER_CONFIG:-}" ]; then
      _fa_derive_from_queue || return 1
    fi
    if [ -z "${FA_PROVIDER_TYPE:-}" ] || [ -z "${FA_PROVIDER_CONFIG:-}" ]; then
      echo "Error: failed to derive FA_PROVIDER_TYPE/FA_PROVIDER_CONFIG from FA_PROVIDERS_QUEUE (invalid JSON, empty queue, unknown provider_type without baseUrl, or unreadable @path?)" >&2
      return 1
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
    local extracted_key
    extracted_key="$(printf '%s' "${FA_PROVIDER_CONFIG}" | sed -n 's/.*"apiKeyEnvVar"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [[ "${extracted_key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      FA_KEY_ENV_VAR="${extracted_key}"
    fi
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
     && [ -z "${!FA_KEY_ENV_VAR:-}" ]; then
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
