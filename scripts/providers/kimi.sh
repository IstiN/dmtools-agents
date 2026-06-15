#!/bin/bash
# Kimi provider for run-agent.sh

# Run the Kimi Code CLI agent and report token usage.
# Depends on global variables set by run-agent.sh:
#   PROMPT, PROMPT_BYTES, PASS_ARGS, KIMI_API_KEY, KIMI_BASE_URL, KIMI_MODEL
run_kimi() {
  if ! command -v kimi >/dev/null 2>&1; then
    echo "Error: kimi not found in PATH" >&2
    echo "Install Kimi Code CLI: https://code.kimi.com/kimi-code/install.sh" >&2
    return 127
  fi

  # Kimi can authenticate via OAuth (local installs) or API key (CI).
  # Only require KIMI_API_KEY when OAuth is not configured.
  local kimi_auth_source=""
  kimi_auth_source="$(kimi provider list 2>/dev/null | grep 'managed:kimi-code' | grep -o 'source=[^ ]*' | cut -d'=' -f2 || true)"
  if [ "${kimi_auth_source:-}" != "oauth" ] && [ -z "${KIMI_API_KEY:-}" ]; then
    echo "Error: KIMI_API_KEY environment variable is required for kimi provider" >&2
    echo "Set it in dmtools.env or as an environment variable" >&2
    return 1
  fi

  echo "Kimi Configuration:"
  echo "  Auth source: ${kimi_auth_source:-api_key}"
  if [ -n "${KIMI_BASE_URL:-}" ]; then
    echo "  Base URL: ${KIMI_BASE_URL}"
  fi
  if [ -n "${KIMI_MODEL:-}" ]; then
    echo "  Model: ${KIMI_MODEL}"
  fi
  echo "Working directory: $(pwd)"
  echo ""

  # Build kimi command.
  # PASS_ARGS support: flags like --continue --resume --session are forwarded.
  # By default we do NOT pass --model unless KIMI_MODEL is explicitly set.
  local kimi_model_args=()
  if [ -n "${KIMI_MODEL:-}" ]; then
    kimi_model_args=(--model "${KIMI_MODEL}")
  fi

  # Detect resume/continue mode. Kimi in non-interactive prompt mode cannot use
  # --continue without an explicit session id (it would try to open an interactive
  # session picker). When resume is requested, resolve the session id from
  # KIMI_SESSION_ID or the persisted file from the previous run and replace the
  # generic --continue/--resume flags with --session <id>.
  local kimi_has_resume_arg=false
  local kimi_has_session_arg=false
  local pass_arg
  if [ "${#PASS_ARGS[@]}" -gt 0 ]; then
    for pass_arg in "${PASS_ARGS[@]}"; do
      case "$pass_arg" in
        --continue|--resume|--resume=*)
          kimi_has_resume_arg=true
          ;;
        --session|--session=*|-S|-S=*)
          kimi_has_session_arg=true
          ;;
      esac
    done
  fi

  local kimi_session_id="${KIMI_SESSION_ID:-}"
  local kimi_session_args=()
  local kimi_pass_args=()
  if [ "${#PASS_ARGS[@]}" -gt 0 ]; then
    kimi_pass_args=("${PASS_ARGS[@]}")
  fi

  _kimi_session_dir() {
    local sid="$1"
    local home="${KIMI_CODE_HOME:-${HOME}/.kimi-code}"
    find "${home}/sessions" -maxdepth 2 -type d -name "session_${sid}" 2>/dev/null | head -1
  }

  _kimi_session_exists() {
    [ -n "$(_kimi_session_dir "$1")" ]
  }

  _kimi_index_file() {
    local home="${KIMI_CODE_HOME:-${HOME}/.kimi-code}"
    printf '%s/session_index.jsonl' "${home}"
  }

  _kimi_canonical_work_dir() {
    # Use the physical current directory; Kimi indexes sessions by the
    # canonical work-dir path, and symlinks such as /tmp -> /private/tmp
    # must be resolved for the index lookup to succeed.
    pwd -P
  }

  # Update Kimi's session index so that the deterministic session id can be
  # found by --session on the next run. Kimi resolves sessions through the
  # index (session_index.jsonl), not only by scanning the sessions tree, so
  # after we rename a freshly-created session we must rewrite the index entry.
  _kimi_update_session_index() {
    local home="$1"
    local work_dir="$2"
    local session_id="$3"
    local session_dir="$4"
    local index_file
    index_file="$(_kimi_index_file)"
    if [ ! -f "${index_file}" ]; then
      return 0
    fi
    if ! command -v python3 >/dev/null 2>&1; then
      echo "⚠️  python3 not available; cannot update Kimi session index" >&2
      return 0
    fi
    python3 - "${index_file}" "${work_dir}" "${session_id}" "${session_dir}" <<'PY'
import json, sys
index_file, work_dir, session_id, session_dir = sys.argv[1:5]
out = []
updated = False
with open(index_file, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        rec_session_id = rec.get("sessionId", "")
        rec_work_dir = rec.get("workDir", "")
        # Drop stale entries that point to the same session or same work-dir/session combo.
        if rec_session_id == session_id or (rec_work_dir == work_dir and rec.get("sessionDir", "") == session_dir):
            if not updated:
                out.append(json.dumps({"sessionId": session_id, "sessionDir": session_dir, "workDir": work_dir}, ensure_ascii=False))
                updated = True
            continue
        out.append(json.dumps(rec, ensure_ascii=False))
if not updated:
    out.append(json.dumps({"sessionId": session_id, "sessionDir": session_dir, "workDir": work_dir}, ensure_ascii=False))
with open(index_file, "w", encoding="utf-8") as f:
    for line in out:
        f.write(line + "\n")
PY
  }

  # If a cached session directory exists but the index does not reference it
  # (e.g. restored from an older cache or after manual fs changes), add the
  # missing index entry so Kimi can resume it.
  _kimi_ensure_session_index() {
    local sid="$1"
    local session_dir
    session_dir="$(_kimi_session_dir "${sid}")"
    if [ -z "${session_dir}" ]; then
      return 0
    fi
    local home="${KIMI_CODE_HOME:-${HOME}/.kimi-code}"
    local work_dir
    work_dir="$(_kimi_canonical_work_dir)"
    _kimi_update_session_index "${home}" "${work_dir}" "session_${sid}" "${session_dir}"
  }

  if [ "${kimi_has_resume_arg}" = "true" ] && [ "${kimi_has_session_arg}" = "false" ]; then
    if [ -z "${kimi_session_id}" ] && [ -f "outputs/kimi_session_id.txt" ]; then
      kimi_session_id="$(tr -d '[:space:]' < outputs/kimi_session_id.txt || true)"
      # Normalise: older runs may have persisted the full directory name (session_<uuid>).
      kimi_session_id="${kimi_session_id#session_}"
    fi
    if [ -z "${kimi_session_id}" ]; then
      echo "Error: Kimi resume requested but no session id is available." >&2
      echo "Set KIMI_SESSION_ID or run a non-resume agent first so the session id can be persisted." >&2
      return 1
    fi
    # Make sure the index references the session we are about to resume.
    _kimi_ensure_session_index "${kimi_session_id}"
    echo "Resuming Kimi session: ${kimi_session_id}"
    kimi_session_args=(--session "session_${kimi_session_id}")
    # Drop --continue/--resume flags; keep any other pass-through args.
    kimi_pass_args=()
    if [ "${#PASS_ARGS[@]}" -gt 0 ]; then
      for pass_arg in "${PASS_ARGS[@]}"; do
        case "$pass_arg" in
          --continue|--resume|--resume=*) ;;
          *) kimi_pass_args+=("$pass_arg") ;;
        esac
      done
    fi
  elif [ -n "${kimi_session_id}" ] && [ "${kimi_has_session_arg}" = "false" ]; then
    # AI Teammate session persistence: every normal run for a given ticket/group
    # should resume the same session across CI runs. The session id is made
    # deterministic by agents/setup/kimi-session.sh and the session tree is cached.
    if _kimi_session_exists "${kimi_session_id}"; then
      # Make sure Kimi's session index points the current work-dir at the cached
      # session directory; otherwise --session will report "Session not found"
      # even though the directory exists.
      _kimi_ensure_session_index "${kimi_session_id}"
      echo "Resuming Kimi session: ${kimi_session_id}"
      kimi_session_args=(--session "session_${kimi_session_id}")
    else
      echo "Kimi session ${kimi_session_id} not found; starting new session (will normalize to deterministic id after run)"
    fi
  fi

  # Always use -p (non-interactive prompt mode) when stdin is not a TTY (CI).
  # Stdin mode causes kimi to enter interactive TUI which hangs/does nothing in CI.
  # For local interactive use, stdin is fine but -p is still preferred for reliability.
  local kimi_log
  kimi_log="$(mktemp)"
  echo "Running: kimi ${kimi_model_args[*]:-} ${kimi_session_args[*]:-} ${kimi_pass_args[*]:-} -p <prompt:${PROMPT_BYTES} bytes>"
  echo ""
  set +e
  kimi ${kimi_model_args[@]+"${kimi_model_args[@]}"} ${kimi_session_args[@]+"${kimi_session_args[@]}"} ${kimi_pass_args[@]+"${kimi_pass_args[@]}"} --output-format "stream-json" -p "${PROMPT}" 2>&1 | tee "$kimi_log"
  local exit_code=${PIPESTATUS[0]}
  set -e

  record_codegraph_usage "$kimi_log"

  # Extract the session id from Kimi's output so we can locate the wire file
  # for this specific run and resume later if a quality gate fails.
  # Kimi stores runtime data under KIMI_CODE_HOME.
  local new_session_id=""
  new_session_id="$(grep -o '"session_id":"[^"]*"' "$kimi_log" | head -1 | cut -d'"' -f4 || true)"

  # Normalize the Kimi-generated session id to the deterministic id configured
  # by agents/setup/kimi-session.sh. This makes the cached session path stable
  # across CI runs for the same ticket/agent-group pair.
  local effective_session_id="${kimi_session_id:-${new_session_id}}"
  if [ -n "${KIMI_SESSION_ID:-}" ] && [ -n "${new_session_id}" ] && [ "${new_session_id}" != "session_${KIMI_SESSION_ID}" ] && [ "${new_session_id}" != "${KIMI_SESSION_ID}" ]; then
    local home="${KIMI_CODE_HOME:-${HOME}/.kimi-code}"
    local new_uuid="${new_session_id#session_}"
    local src_dir=""
    src_dir="$(find "${home}/sessions" -maxdepth 2 -type d -name "session_${new_uuid}" 2>/dev/null | head -1 || true)"
    if [ -n "${src_dir}" ]; then
      local dest_dir="${src_dir%/*}/session_${KIMI_SESSION_ID}"
      if [ "${src_dir}" != "${dest_dir}" ] && [ ! -e "${dest_dir}" ]; then
        mv "${src_dir}" "${dest_dir}"
        echo "✅ Normalized Kimi session id to deterministic id: ${KIMI_SESSION_ID}"
      fi
      # Kimi resolves sessions through its index, so after renaming we must
      # update the index entry to point at the new directory/id.
      local work_dir
      work_dir="$(_kimi_canonical_work_dir)"
      _kimi_update_session_index "${home}" "${work_dir}" "session_${KIMI_SESSION_ID}" "${dest_dir}"
    fi
    effective_session_id="${KIMI_SESSION_ID}"
  fi

  if [ -n "${effective_session_id}" ]; then
    mkdir -p outputs
    printf '%s\n' "${effective_session_id}" > outputs/kimi_session_id.txt
  fi

  print_kimi_usage_summary_and_write_json "${effective_session_id}"

  rm -f "$kimi_log"

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return $exit_code
}

# Extract token usage from the wire file Kimi CLI wrote during the run and write
# a machine-readable JSON summary to outputs/kimi_usage.json.
# Wire file locations (Kimi layout changed across releases):
#   - newer: $KIMI_CODE_HOME/sessions/<work-dir-hash>/<session-id>/wire.jsonl
#   - legacy: $KIMI_CODE_HOME/sessions/<work-dir-hash>/<session-id>/agents/main/wire.jsonl
print_kimi_usage_summary_and_write_json() {
  local session_id="$1"
  local kimi_code_home="${KIMI_CODE_HOME:-${HOME}/.kimi-code}"
  local wire_file=""

  echo "  KIMI_CODE_HOME: ${kimi_code_home}"
  echo "  Session ID: ${session_id}"

  if [ -n "${session_id}" ]; then
    # Kimi session directories may be named either <session_id> or session_<session_id>,
    # and the wire file may live at the session root or under agents/main/.
    local sid="${session_id#session_}"
    wire_file="$(find "${kimi_code_home}/sessions" -type f \( \
      -path "*/${sid}/wire.jsonl" -o \
      -path "*/${sid}/agents/main/wire.jsonl" -o \
      -path "*/session_${sid}/wire.jsonl" -o \
      -path "*/session_${sid}/agents/main/wire.jsonl" \
    \) 2>/dev/null | head -1 || true)"
  fi

  if [ -z "${wire_file}" ] || [ ! -f "${wire_file}" ]; then
    echo "⚠️  No Kimi wire file found; cannot report token usage."
    echo "  Sessions tree under ${kimi_code_home}:"
    find "${kimi_code_home}" -maxdepth 4 -type d 2>/dev/null | sed 's/^/    /' || true
    return 0
  fi

  local wire_size
  wire_size="$(wc -c < "${wire_file}" | tr -d ' ')"
  echo "  Wire file: ${wire_file}"
  echo "  Wire file size: ${wire_size} bytes"

  if [ "${KIMI_PRINT_WIRE_FILE:-}" = "1" ]; then
    echo "  Wire file contents:"
    cat "${wire_file}"
  else
    echo "  First 10 lines of wire file:"
    head -n 10 "${wire_file}" | sed 's/^/    /'
  fi

  local usage_name
  usage_name="${AI_AGENT_USAGE_NAME:-kimi}"
  mkdir -p outputs
  python3 - "$wire_file" "$usage_name" << 'PYEOF'
import json
import os
import sys

wire_file = sys.argv[1]
usage_name = sys.argv[2]

total_input_other = 0
total_output = 0
total_input_cache_read = 0
total_input_cache_creation = 0
count = 0
models = set()

with open(wire_file, 'r', encoding='utf-8') as f:
    for line in f:
        if '"type":"usage.record"' not in line:
            continue
        try:
            obj = json.loads(line)
            if obj.get('type') != 'usage.record':
                continue
            usage = obj.get('usage', {})
            total_input_other += usage.get('inputOther', 0)
            total_output += usage.get('output', 0)
            total_input_cache_read += usage.get('inputCacheRead', 0)
            total_input_cache_creation += usage.get('inputCacheCreation', 0)
            models.add(obj.get('model', 'unknown'))
            count += 1
        except Exception:
            continue

total_input = total_input_other + total_input_cache_read + total_input_cache_creation
total = total_input + total_output

summary = {
    "provider": "kimi",
    "models": sorted(models),
    "usage_records": count,
    "input_other": total_input_other,
    "input_cache_read": total_input_cache_read,
    "input_cache_creation": total_input_cache_creation,
    "output": total_output,
    "total_input": total_input,
    "total_tokens": total
}

out_path = os.path.join('outputs', usage_name + '_usage.json')
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(summary, f, indent=2)

print("")
print("=== Kimi Token Usage Summary ===")
print(f"  Model(s): {', '.join(sorted(models))}")
print(f"  Usage records: {count}")
print(f"  Input (other):          {total_input_other:,}")
print(f"  Input (cache read):     {total_input_cache_read:,}")
print(f"  Input (cache creation): {total_input_cache_creation:,}")
print(f"  Output:                 {total_output:,}")
print(f"  Total input:            {total_input:,}")
print(f"  Total tokens:           {total:,}")
print(f"  Written to:             {out_path}")
print("================================")
PYEOF

  record_usage_file "outputs/${usage_name}_usage.json"
}
