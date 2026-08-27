#!/bin/bash
set -euo pipefail

PROVIDERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_DIR="$(cd "${PROVIDERS_DIR}/../../setup" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

source "${PROVIDERS_DIR}/_common.sh"
source "${PROVIDERS_DIR}/cursor.sh"

# A resumed Cursor chat (existing session directory found on disk) must be
# pointed at a file to re-read fresh via its own Read tool, rather than having
# the prompt text pasted into the message body again; a run that has to
# create a brand-new chat (no cached session yet) must keep the plain
# inline-prompt behavior — it has no prior-turn memory to distrust.
run_resume_notice_case() {
  local case_name="$1"
  local seed_session_dir="$2"
  local expect_notice="$3"
  local case_dir="${TEST_ROOT}/${case_name}"
  local fake_bin="${case_dir}/bin"
  local home="${case_dir}/home"
  mkdir -p "${fake_bin}" "${case_dir}/outputs" "${home}/.cursor/chats"

  cat > "${fake_bin}/cursor-agent" << 'BINEOF'
#!/bin/bash
if [ "$1" = "create-chat" ]; then
  echo "created new-chat-not-used"
  exit 0
fi
: > "${CAPTURED_STDIN_FILE}"
printf '%s\n' "$*" >> "${CAPTURED_STDIN_FILE}"
# If the message points at a prompt file (the new resume behavior), snapshot
# its content now, before the caller deletes it right after this exits.
_referenced_file="$(grep -A1 'instructions for this run are in this file' "${CAPTURED_STDIN_FILE}" | tail -1 | tr -d '[:space:]')"
if [ -n "${_referenced_file}" ] && [ -f "${_referenced_file}" ]; then
  echo "===REFERENCED_FILE_CONTENT===" >> "${CAPTURED_STDIN_FILE}"
  cat "${_referenced_file}" >> "${CAPTURED_STDIN_FILE}"
fi
echo '{"session_id":"whatever"}'
exit 0
BINEOF
  chmod +x "${fake_bin}/cursor-agent"

  (
    cd "${case_dir}"
    export HOME="${home}"
    export PATH="${fake_bin}:${PATH}"
    export CAPTURED_STDIN_FILE="${case_dir}/captured.txt"
    export DMTOOLS_CLI_LOG_DIR="${case_dir}/logs"
    export AI_TEAMMATE_CONFIG_FILE="story_development.json"

    # Learn the deterministic session id the same way cursor.sh derives it, then
    # (for the "seed" case) pre-create that exact session dir so cursor.sh sees
    # an existing, resumable session on the single run below.
    # shellcheck source=/dev/null
    source "${SETUP_DIR}/cursor-session.sh" env >/dev/null
    if [ "${seed_session_dir}" = "yes" ]; then
      mkdir -p "${home}/.cursor/chats/${CURSOR_SESSION_ID}"
      touch "${home}/.cursor/chats/${CURSOR_SESSION_ID}/store.db"
    fi

    PROMPT_ARG="nonexistent-file"
    PROMPT="test prompt marker for resume notice test"
    PROMPT_BYTES=11
    PASS_ARGS=()

    run_cursor >/dev/null 2>&1 || true

    if [ "${expect_notice}" = "yes" ]; then
      grep -q "resumed session" "${CAPTURED_STDIN_FILE}" \
        || { echo "[${case_name}] expected resume pointer notice, none found" >&2; exit 1; }
      if sed '/===REFERENCED_FILE_CONTENT===/q' "${CAPTURED_STDIN_FILE}" | grep -q "test prompt marker for resume notice test"; then
        echo "[${case_name}] full prompt text must NOT be inlined into the resume message body" >&2
        exit 1
      fi
      sed '1,/===REFERENCED_FILE_CONTENT===/d' "${CAPTURED_STDIN_FILE}" | grep -q "test prompt marker for resume notice test" \
        || { echo "[${case_name}] referenced prompt file does not contain the actual prompt" >&2; exit 1; }
    else
      if grep -q "resumed session" "${CAPTURED_STDIN_FILE}"; then
        echo "[${case_name}] resume pointer notice must not appear for a freshly created chat" >&2
        exit 1
      fi
      grep -q "test prompt marker for resume notice test" "${CAPTURED_STDIN_FILE}" \
        || { echo "[${case_name}] original prompt content missing" >&2; exit 1; }
    fi
  )
}
run_resume_notice_case "resume-gets-notice" "yes" "yes"
run_resume_notice_case "fresh-chat-no-notice" "no" "no"

echo "Cursor provider integration tests passed"
