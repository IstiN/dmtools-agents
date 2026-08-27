#!/bin/bash
set -euo pipefail

PROVIDERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

source "${PROVIDERS_DIR}/_common.sh"
source "${PROVIDERS_DIR}/kimi.sh"

# A resumed Kimi session (existing session directory found on disk) must be
# pointed at a file to re-read fresh via its own Read tool, rather than having
# the prompt text pasted into the message body again; a run whose
# deterministic session directory does not exist yet (first ever run) must
# keep the plain inline-prompt behavior.
run_resume_notice_case() {
  local case_name="$1"
  local seed_session_dir="$2"
  local expect_pointer="$3"
  local case_dir="${TEST_ROOT}/${case_name}"
  local fake_bin="${case_dir}/bin"
  local kimi_home="${case_dir}/kimi-home"
  mkdir -p "${fake_bin}" "${case_dir}/outputs" "${kimi_home}"

  if [ "${seed_session_dir}" = "yes" ]; then
    mkdir -p "${kimi_home}/sessions/wd/session_deterministic-id-1"
    echo '[]' > "${kimi_home}/session_index.jsonl"
  fi

  cat > "${fake_bin}/kimi" << 'BINEOF'
#!/bin/bash
if [ "$1" = "provider" ]; then
  echo "managed:kimi-code source=api_key"
  exit 0
fi
: > "${CAPTURED_STDIN_FILE}"
printf '%s\n' "$*" >> "${CAPTURED_STDIN_FILE}"
if [ ! -t 0 ]; then cat >> "${CAPTURED_STDIN_FILE}"; fi
# If the message points at a prompt file (the new resume behavior), snapshot
# its content now, before the caller deletes it right after this exits.
_referenced_file="$(grep -A1 'instructions for this run are in this file' "${CAPTURED_STDIN_FILE}" | tail -1 | tr -d '[:space:]')"
if [ -n "${_referenced_file}" ] && [ -f "${_referenced_file}" ]; then
  echo "===REFERENCED_FILE_CONTENT===" >> "${CAPTURED_STDIN_FILE}"
  cat "${_referenced_file}" >> "${CAPTURED_STDIN_FILE}"
fi
echo '{"type":"result","session_id":"session_deterministic-id-1"}'
exit 0
BINEOF
  chmod +x "${fake_bin}/kimi"

  (
    cd "${case_dir}"
    export PATH="${fake_bin}:${PATH}"
    export KIMI_API_KEY="test-key"
    export KIMI_CODE_HOME="${kimi_home}"
    export KIMI_SESSION_ID="deterministic-id-1"
    export CAPTURED_STDIN_FILE="${case_dir}/captured.txt"
    export DMTOOLS_CLI_LOG_DIR="${case_dir}/logs"
    PROMPT_ARG="nonexistent-file"
    PROMPT="test prompt marker for resume notice test"
    PROMPT_BYTES=11
    PASS_ARGS=()

    run_kimi >/dev/null 2>&1 || true

    if [ "${expect_pointer}" = "yes" ]; then
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
        echo "[${case_name}] resume pointer notice must not appear for a first-ever run" >&2
        exit 1
      fi
      grep -q "test prompt marker for resume notice test" "${CAPTURED_STDIN_FILE}" \
        || { echo "[${case_name}] original prompt content missing" >&2; exit 1; }
    fi
  )
}
run_resume_notice_case "resume-gets-notice" "yes" "yes"
run_resume_notice_case "first-run-no-notice" "no" "no"

echo "Kimi provider integration tests passed"
