#!/bin/bash
set -euo pipefail

PROVIDERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

source "${PROVIDERS_DIR}/_common.sh"
source "${PROVIDERS_DIR}/copilot.sh"

SESSION_ID="5970236a-c0cb-46b0-85da-db6898163d11"

# Seeds the Copilot session store the same way the real CLI does: schema on
# first use, then one usage row per model request.
write_store_seeder() {
  cat > "$1" << 'PYEOF'
import sqlite3
import sys

store, session_id, input_tokens, output_tokens, nano_aiu = sys.argv[1:6]
connection = sqlite3.connect(store)
connection.execute(
    "CREATE TABLE IF NOT EXISTS assistant_usage_events ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, model TEXT NOT NULL, "
    "input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, "
    "cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER, "
    "duration_ms INTEGER)"
)
connection.execute(
    "INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, "
    "cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, duration_ms) "
    "VALUES (?, 'claude-sonnet-5', ?, ?, 0, 0, 0, ?, 10)",
    (session_id, int(input_tokens), int(output_tokens), int(nano_aiu)),
)
connection.commit()
connection.close()
PYEOF
}

run_provider_case() {
  local case_name="$1"
  local fake_exit_code="$2"
  local fake_output="$3"
  local expected_artifacts="$4"
  local seed_store="$5"
  local case_dir="${TEST_ROOT}/${case_name}"
  local fake_bin="${case_dir}/bin"
  local copilot_home="${case_dir}/copilot-home"
  mkdir -p "${fake_bin}" "${case_dir}/outputs" "${copilot_home}"

  write_store_seeder "${case_dir}/seed_store.py"

  # A stale row for the same session, as a restored COPILOT_HOME cache would
  # contain. It must NOT leak into this run's reported usage.
  if [ "${seed_store}" = "seed" ]; then
    python3 "${case_dir}/seed_store.py" "${copilot_home}/session-store.db" "${SESSION_ID}" 999999 88888 9000000000
  fi

  cat > "${fake_bin}/copilot" << 'BINEOF'
#!/bin/bash
if [ "${1:-}" = "--help" ]; then
  echo "  --session-id"
  exit 0
fi
if [ "${FAKE_COPILOT_RECORD_USAGE}" != "none" ]; then
  python3 "${FAKE_COPILOT_SEEDER}" "${COPILOT_HOME}/session-store.db" "${FAKE_COPILOT_SESSION_ID}" 1500 50 2000000000
fi
printf '%s\n' "${FAKE_COPILOT_OUTPUT}"
exit "${FAKE_COPILOT_EXIT_CODE}"
BINEOF
  chmod +x "${fake_bin}/copilot"

  (
    cd "${case_dir}"
    export HOME="${case_dir}"
    export PATH="${fake_bin}:${PATH}"
    export COPILOT_HOME="${copilot_home}"
    export FAKE_COPILOT_OUTPUT="${fake_output}"
    export FAKE_COPILOT_EXIT_CODE="${fake_exit_code}"
    export FAKE_COPILOT_SEEDER="${case_dir}/seed_store.py"
    export FAKE_COPILOT_SESSION_ID="${SESSION_ID}"
    export FAKE_COPILOT_RECORD_USAGE="${seed_store}"
    export COPILOT_GITHUB_TOKEN="test-token"
    export COPILOT_SESSION_ENABLED="false"
    export AI_AGENT_USAGE_NAME="story_development"
    export DMTOOLS_CLI_LOG_DIR="${case_dir}/logs"
    unset COPILOT_SESSION_ID COPILOT_USD_PER_CREDIT
    PROMPT_ARG="test prompt"
    PROMPT="test prompt"
    PROMPT_BYTES=11
    PASS_ARGS=()

    if [ "${expected_artifacts}" = "usage-only" ]; then
      record_usage_file() { return 23; }
    fi

    actual_exit_code=0
    if [ "${fake_exit_code}" -eq 0 ]; then
      # run-agent.sh runs providers under `set -e`; calling run_copilot outside
      # an `||` list keeps errexit active inside it, so any non-zero step in the
      # best-effort usage reporting would abort the provider here.
      run_copilot >/dev/null 2>&1
    else
      run_copilot >/dev/null 2>&1 || actual_exit_code=$?
    fi

    if [ "${actual_exit_code}" -ne "${fake_exit_code}" ]; then
      echo "[${case_name}] expected provider exit ${fake_exit_code}, got ${actual_exit_code}" >&2
      exit 1
    fi

    if [ "${expected_artifacts}" = "usage-and-manifest" ]; then
      test -f outputs/story_development_usage.json
      test -f outputs/token_usage_files.json
      grep -q 'outputs/story_development_usage.json' outputs/token_usage_files.json
      python3 - "outputs/story_development_usage.json" << 'PYEOF'
import json
import sys

usage = json.load(open(sys.argv[1], encoding="utf-8"))
expected = {
    "provider": "copilot",
    "models": ["claude-sonnet-5"],
    "usage_records": 1,
    "input_other": 1500,
    "output": 50,
    "total_tokens": 1550,
    "ai_credits": 2.0,
    "source": "session-store",
}
for key, value in expected.items():
    if usage.get(key) != value:
        raise SystemExit(f"expected {key}={value}, got {usage.get(key)}")
if "cost_usd" in usage:
    raise SystemExit("cost_usd must be omitted unless COPILOT_USD_PER_CREDIT is set")
PYEOF
    elif [ "${expected_artifacts}" = "usage-only" ]; then
      test -f outputs/story_development_usage.json
      test ! -e outputs/token_usage_files.json
    elif [ "${expected_artifacts}" = "transcript-fallback" ]; then
      test -f outputs/story_development_usage.json
      grep -q '"source": "transcript-summary"' outputs/story_development_usage.json
      grep -q '"approximate": true' outputs/story_development_usage.json
    else
      test ! -e outputs/story_development_usage.json
      test ! -e outputs/token_usage_files.json
    fi
  )
}

FOOTER=$'Changes    +2 -2\nAI Credits 2 (12s)\nTokens     \u2191 1.5k (0 cached) \u2022 \u2193 50 (0 reasoning)\nResume     copilot --resume='"${SESSION_ID}"

# Usage must be reported even when the agent itself fails, and stale rows from a
# restored session-store cache must not be counted.
run_provider_case "usage-on-failure" 7 "${FOOTER}" usage-and-manifest seed
# The happy path also runs with errexit active (see run_provider_case).
run_provider_case "usage-on-success" 0 "${FOOTER}" usage-and-manifest seed
# A manifest write failure is a warning, never a change of the agent exit code.
run_provider_case "manifest-failure" 11 "${FOOTER}" usage-only seed
# No session store at all: fall back to the (rounded) transcript footer.
run_provider_case "transcript-fallback" 0 "${FOOTER}" transcript-fallback none
# Nothing to report: no store, no footer.
run_provider_case "missing-usage" 9 "agent ran but printed no summary" none none

echo "Copilot provider integration tests passed"
