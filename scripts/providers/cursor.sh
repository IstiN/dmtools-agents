#!/bin/bash
# Cursor provider for run-agent.sh

run_cursor() {
  if ! command -v cursor-agent >/dev/null 2>&1; then
    echo "Error: cursor-agent not found in PATH" >&2
    return 127
  fi

  local cursor_model_value script_dir
  cursor_model_value="${CURSOR_MODEL:-auto}"
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  local cursor_session_enabled=true
  if [ "${CURSOR_SESSION_ENABLED:-true}" = "false" ]; then
    cursor_session_enabled=false
  fi

  local teammate_session_enabled=false
  if [ "${cursor_session_enabled}" = "true" ] && [ -n "${AI_TEAMMATE_CONFIG_FILE:-}" ]; then
    teammate_session_enabled=true
    if [ -f "${script_dir}/../../setup/cursor-session.sh" ]; then
      # shellcheck source=/dev/null
      source "${script_dir}/../../setup/cursor-session.sh" env
    fi
  fi

  _cursor_chats_root() {
    printf '%s' "${HOME}/.cursor/chats"
  }

  _cursor_session_dir() {
    local sid="$1"
    find "$(_cursor_chats_root)" -maxdepth 2 -type d -name "${sid}" 2>/dev/null | head -1
  }

  _cursor_session_exists() {
    local sid="$1"
    local session_dir
    session_dir="$(_cursor_session_dir "${sid}")"
    [ -n "${session_dir}" ] && [ -f "${session_dir}/store.db" ]
  }

  _cursor_extract_uuid() {
    local text="$1"
    local uuid
    uuid="$(printf '%s' "${text}" | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | head -1 || true)"
    printf '%s' "${uuid}"
  }

  _cursor_is_uuid() {
    printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  }

  _cursor_normalize_session_id() {
    local src_id="$1"
    local dest_id="$2"
    local src_dir dest_dir parent

    if [ -z "${src_id}" ] || [ -z "${dest_id}" ] || [ "${src_id}" = "${dest_id}" ]; then
      return 0
    fi

    src_dir="$(_cursor_session_dir "${src_id}")"
    if [ -z "${src_dir}" ]; then
      return 1
    fi

    parent="$(dirname "${src_dir}")"
    dest_dir="${parent}/${dest_id}"
    if [ "${src_dir}" != "${dest_dir}" ] && [ ! -e "${dest_dir}" ]; then
      mv "${src_dir}" "${dest_dir}"
      echo "✅ Normalized Cursor session id to deterministic id: ${dest_id}"
    fi
  }

  _cursor_create_chat_id() {
    local create_output new_id
    create_output="$(cursor-agent create-chat 2>&1 || true)"
    new_id="$(_cursor_extract_uuid "${create_output}")"
    printf '%s' "${new_id}"
  }

  _cursor_strip_resume_flags() {
    local skip_next=false
    local pass_arg

    cursor_pass_args=()
    if [ "${#PASS_ARGS[@]}" -eq 0 ]; then
      return 0
    fi

    for pass_arg in "${PASS_ARGS[@]}"; do
      if [ "${skip_next}" = "true" ]; then
        skip_next=false
        continue
      fi
      case "$pass_arg" in
        --resume)
          if [ "${cursor_has_explicit_resume_id}" = "true" ]; then
            skip_next=true
          fi
          ;;
        --resume=*|--continue) ;;
        *) cursor_pass_args+=("$pass_arg") ;;
      esac
    done
  }

  local cursor_has_resume_arg=false
  local cursor_has_explicit_resume_id=false
  local cursor_explicit_resume_id=""
  local pass_arg pass_idx next_arg
  if [ "${#PASS_ARGS[@]}" -gt 0 ]; then
    pass_idx=0
    while [ "${pass_idx}" -lt "${#PASS_ARGS[@]}" ]; do
      pass_arg="${PASS_ARGS[$pass_idx]}"
      case "$pass_arg" in
        --continue)
          cursor_has_resume_arg=true
          ;;
        --resume)
          cursor_has_resume_arg=true
          next_arg="${PASS_ARGS[$((pass_idx + 1))]:-}"
          if _cursor_is_uuid "${next_arg}"; then
            cursor_has_explicit_resume_id=true
            cursor_explicit_resume_id="${next_arg}"
          fi
          ;;
        --resume=*)
          cursor_has_resume_arg=true
          cursor_has_explicit_resume_id=true
          cursor_explicit_resume_id="${pass_arg#--resume=}"
          ;;
      esac
      pass_idx=$((pass_idx + 1))
    done
  fi

  local cursor_session_id="${CURSOR_SESSION_ID:-}"
  local cursor_session_args=()
  local cursor_pass_args=()
  if [ "${#PASS_ARGS[@]}" -gt 0 ]; then
    cursor_pass_args=("${PASS_ARGS[@]}")
  fi

  if [ "${cursor_session_enabled}" = "false" ]; then
    :
  elif [ "${cursor_has_explicit_resume_id}" = "true" ]; then
    echo "Resuming Cursor session: ${cursor_explicit_resume_id}"
    cursor_session_args=(--resume "${cursor_explicit_resume_id}")
    cursor_session_id="${cursor_explicit_resume_id}"
    _cursor_strip_resume_flags
  elif [ "${cursor_has_resume_arg}" = "true" ] && [ "${teammate_session_enabled}" = "true" ]; then
    if [ -z "${cursor_session_id}" ] && [ -f "outputs/cursor_session_id.txt" ]; then
      cursor_session_id="$(tr -d '[:space:]' < outputs/cursor_session_id.txt || true)"
    fi
    if [ -z "${cursor_session_id}" ]; then
      echo "Error: Cursor resume requested but no session id is available." >&2
      echo "Set CURSOR_SESSION_ID or run a non-resume agent first so the session id can be persisted." >&2
      return 1
    fi
    echo "Resuming Cursor session: ${cursor_session_id}"
    cursor_session_args=(--resume "${cursor_session_id}")
    _cursor_strip_resume_flags
  elif [ -n "${cursor_session_id}" ] && [ "${teammate_session_enabled}" = "true" ]; then
    if _cursor_session_exists "${cursor_session_id}"; then
      echo "Resuming Cursor session: ${cursor_session_id}"
      cursor_session_args=(--resume "${cursor_session_id}")
    else
      echo "Cursor session ${cursor_session_id} not found; creating chat (will normalize to deterministic id)"
      local created_id=""
      created_id="$(_cursor_create_chat_id)"
      if [ -n "${created_id}" ] && [ "${created_id}" != "${cursor_session_id}" ]; then
        _cursor_normalize_session_id "${created_id}" "${cursor_session_id}"
      fi
      if _cursor_session_exists "${cursor_session_id}"; then
        cursor_session_args=(--resume "${cursor_session_id}")
      elif [ -n "${created_id}" ]; then
        cursor_session_args=(--resume "${created_id}")
        cursor_session_id="${created_id}"
      fi
    fi
  fi

  local cursor_output_format="text"
  if [ "${cursor_session_enabled}" = "true" ] && [ -n "${CURSOR_SESSION_ID:-}" ]; then
    cursor_output_format="stream-json"
  fi

  echo "Cursor Configuration:"
  echo "  Model: ${cursor_model_value}"
  if [ -n "${CURSOR_SESSION_ID:-}" ]; then
    echo "  Session: ${CURSOR_SESSION_NAME:-${CURSOR_SESSION_ID}} (${CURSOR_SESSION_GROUP:-default})"
    echo "  Session cache path: ${CURSOR_SESSION_CACHE_PATH:-$(_cursor_chats_root)}"
  fi
  echo "Working directory: $(pwd)"
  echo ""

  local cmd
  cmd=(cursor-agent --force --print --model "${cursor_model_value}" \
    ${cursor_session_args[@]+"${cursor_session_args[@]}"} \
    ${cursor_pass_args[@]+"${cursor_pass_args[@]}"} \
    --output-format="${cursor_output_format}" "$PROMPT")

  echo "Running: cursor-agent --force --print --model ${cursor_model_value} ${cursor_session_args[*]:-} ${cursor_pass_args[*]:-} --output-format=${cursor_output_format} <prompt:${PROMPT_BYTES} bytes>"
  echo ""

  local agent_log
  agent_log="$(new_agent_log_file "cursor")"
  set +e
  "${cmd[@]}" 2>&1 | tee "$agent_log"
  local exit_code=${PIPESTATUS[0]}
  set -e
  record_codegraph_usage "$agent_log"

  if [ "${teammate_session_enabled}" = "true" ] && [ "${cursor_has_explicit_resume_id}" = "false" ]; then
    local new_session_id=""
    new_session_id="$(grep -o '"session_id":"[^"]*"' "$agent_log" | head -1 | cut -d'"' -f4 || true)"
    if [ -z "${new_session_id}" ]; then
      new_session_id="$(_cursor_extract_uuid "$(cat "$agent_log" 2>/dev/null || true)")"
    fi

    local effective_session_id="${cursor_session_id:-${new_session_id}}"
    if [ -n "${CURSOR_SESSION_ID:-}" ] && [ -n "${new_session_id}" ] && [ "${new_session_id}" != "${CURSOR_SESSION_ID}" ]; then
      _cursor_normalize_session_id "${new_session_id}" "${CURSOR_SESSION_ID}"
      effective_session_id="${CURSOR_SESSION_ID}"
    fi

    if [ -n "${effective_session_id}" ]; then
      mkdir -p outputs
      printf '%s\n' "${effective_session_id}" > outputs/cursor_session_id.txt
    fi
  fi

  echo "Full transcript saved to: ${agent_log}"

  echo ""
  echo "=== Agent completed with exit code: $exit_code ==="
  return "$exit_code"
}
