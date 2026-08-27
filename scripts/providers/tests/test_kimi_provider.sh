#!/bin/bash
set -euo pipefail

PROVIDERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

source "${PROVIDERS_DIR}/_common.sh"
source "${PROVIDERS_DIR}/kimi.sh"

# A resumed Kimi session (existing session directory found on disk) must be
# told to re-read input/*.md fresh instead of relying on memory from a prior
# turn; a run whose deterministic session directory does not exist yet (first
# ever run) must not carry that notice.
run_resume_notice_case() {
  local case_name="$1"
  local seed_session_dir="$2"
  local expect_notice="$3"
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
    PROMPT="test prompt marker for resume notice test"
    PROMPT_BYTES=11
    PASS_ARGS=()

    run_kimi >/dev/null 2>&1 || true

    if [ "${expect_notice}" = "yes" ]; then
      grep -q "resumed session" "${CAPTURED_STDIN_FILE}" \
        || { echo "[${case_name}] expected resume re-read notice, none found" >&2; exit 1; }
    else
      if grep -q "resumed session" "${CAPTURED_STDIN_FILE}"; then
        echo "[${case_name}] resume re-read notice must not appear for a first-ever run" >&2
        exit 1
      fi
    fi
    grep -q "test prompt marker for resume notice test" "${CAPTURED_STDIN_FILE}" \
      || { echo "[${case_name}] original prompt content missing" >&2; exit 1; }
  )
}
run_resume_notice_case "resume-gets-notice" "yes" "yes"
run_resume_notice_case "first-run-no-notice" "no" "no"

echo "Kimi provider integration tests passed"
