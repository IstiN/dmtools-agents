#!/bin/bash
set -euo pipefail

PROVIDERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

source "${PROVIDERS_DIR}/_common.sh"
source "${PROVIDERS_DIR}/claude.sh"

run_provider_case() {
  local case_name="$1"
  local fake_exit_code="$2"
  local fake_output="$3"
  local expected_artifacts="$4"
  local case_dir="${TEST_ROOT}/${case_name}"
  local fake_bin="${case_dir}/bin"
  mkdir -p "${fake_bin}" "${case_dir}/outputs"

  printf '#!/bin/bash\nprintf "%%s\\n" "$FAKE_CLAUDE_OUTPUT"\nexit "$FAKE_CLAUDE_EXIT_CODE"\n' > "${fake_bin}/claude"
  chmod +x "${fake_bin}/claude"

  (
    cd "${case_dir}"
    export PATH="${fake_bin}:${PATH}"
    export FAKE_CLAUDE_OUTPUT="${fake_output}"
    export FAKE_CLAUDE_EXIT_CODE="${fake_exit_code}"
    export CLAUDE_CODE_API_KEY="test-key"
    export CLAUDE_CODE_BASE_URL="https://example.com"
    export AI_AGENT_USAGE_NAME="story_development"
    export DMTOOLS_CLI_LOG_DIR="${case_dir}/logs"
    PROMPT_ARG="test prompt"
    PROMPT="test prompt"
    PROMPT_BYTES=11
    PASS_ARGS=()

    if [ "${expected_artifacts}" = "usage-only" ]; then
      record_usage_file() { return 23; }
    fi

    actual_exit_code=0
    run_claude_code >/dev/null 2>&1 || actual_exit_code=$?

    if [ "${actual_exit_code}" -ne "${fake_exit_code}" ]; then
      echo "Expected provider exit ${fake_exit_code}, got ${actual_exit_code}" >&2
      exit 1
    fi

    if [ "${expected_artifacts}" = "usage-and-manifest" ]; then
      test -f outputs/story_development_usage.json
      test -f outputs/token_usage_files.json
      grep -q 'outputs/story_development_usage.json' outputs/token_usage_files.json
    elif [ "${expected_artifacts}" = "usage-only" ]; then
      test -f outputs/story_development_usage.json
      test ! -e outputs/token_usage_files.json
    else
      test ! -e outputs/story_development_usage.json
      test ! -e outputs/token_usage_files.json
    fi
  )
}

VALID_RESULT='{"type":"result","total_cost_usd":0.25,"modelUsage":{"example-model":{"inputTokens":2,"outputTokens":3,"cacheReadInputTokens":5,"cacheCreationInputTokens":7,"costUSD":0.25}}}'
run_provider_case "usage-on-failure" 7 "${VALID_RESULT}" usage-and-manifest
run_provider_case "manifest-failure" 11 "${VALID_RESULT}" usage-only
run_provider_case "missing-usage" 9 '{"type":"result","modelUsage":{}}' none

# A resumed session (.claude-session-id present from a prior run) must be told
# to re-read input/*.md fresh instead of relying on memory from a prior turn;
# a first-ever run with no saved session id must not carry that notice.
run_resume_notice_case() {
  local case_name="$1"
  local seed_session_file="$2"
  local expect_notice="$3"
  local case_dir="${TEST_ROOT}/${case_name}"
  local fake_bin="${case_dir}/bin"
  mkdir -p "${fake_bin}" "${case_dir}/outputs"

  cat > "${fake_bin}/claude" << 'BINEOF'
#!/bin/bash
: > "${CAPTURED_STDIN_FILE}"
printf '%s\n' "$*" >> "${CAPTURED_STDIN_FILE}"
if [ ! -t 0 ]; then cat >> "${CAPTURED_STDIN_FILE}"; fi
echo '{"type":"result","session_id":"abc-123"}'
exit 0
BINEOF
  chmod +x "${fake_bin}/claude"

  (
    cd "${case_dir}"
    export PATH="${fake_bin}:${PATH}"
    export CLAUDE_CODE_API_KEY="test-key"
    export CLAUDE_CODE_BASE_URL="https://example.com"
    export CAPTURED_STDIN_FILE="${case_dir}/captured.txt"
    export DMTOOLS_CLI_LOG_DIR="${case_dir}/logs"
    if [ "${seed_session_file}" = "yes" ]; then
      echo "prev-session-id" > .claude-session-id
    fi
    PROMPT_ARG="nonexistent-file"
    PROMPT="test prompt marker for resume notice test"
    PROMPT_BYTES=11
    PASS_ARGS=()

    run_claude_code >/dev/null 2>&1 || true

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

echo "Claude provider integration tests passed"
