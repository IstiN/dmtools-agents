#!/bin/bash
# Exercises run_copilot_once_guarded()'s job-control-based loop detection and
# recovery (see scripts/loop_guard.py and the run_copilot_once_guarded()
# comment block in ../copilot.sh for the full rationale). Uses a fake
# `copilot` binary that repeats the same tool-call block forever until
# killed, to simulate the real-world stuck-agent transcripts that motivated
# this feature (see loop_guard.py's module docstring).
set -euo pipefail

PROVIDERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

source "${PROVIDERS_DIR}/_common.sh"
source "${PROVIDERS_DIR}/copilot.sh"

# Writes a fake `copilot` binary that:
#  - on --help, behaves like the real CLI (needed by copilot-session.sh probing)
#  - otherwise increments a shared attempt counter (persisted in a file, so it
#    survives across the separate process invocations the guard's retries are)
#  - keeps repeating the identical "stuck" tool-call block forever until its
#    attempt number reaches SUCCEED_ON_ATTEMPT, at which point it prints a
#    normal successful transcript + usage footer and exits 0
write_fake_copilot() {
  local fake_bin="$1"
  local attempt_marker="$2"
  local succeed_on_attempt="$3"
  cat > "${fake_bin}/copilot" << BINEOF
#!/bin/bash
if [ "\${1:-}" = "--help" ]; then
  echo "  --session-id"
  exit 0
fi
attempt=1
if [ -f "${attempt_marker}" ]; then
  attempt=\$(( \$(cat "${attempt_marker}") + 1 ))
fi
echo "\${attempt}" > "${attempt_marker}"

if [ "\${attempt}" -ge "${succeed_on_attempt}" ]; then
  echo "● Read some_file.java (read)"
  echo "  │ some_file.java"
  echo "  └ ok"
  printf 'Changes    +1 -1\nAI Credits 1 (1s)\nTokens     \u2191 10 (0 cached) \u2022 \u2193 5 (0 reasoning)\n'
  exit 0
fi

while true; do
  echo "● Checking again (shell)"
  echo "  │ echo stuck"
  echo "  └ stuck"
  sleep 0.2
done
BINEOF
  chmod +x "${fake_bin}/copilot"
}

run_case_env() {
  local case_dir="$1"
  local fake_bin="${case_dir}/bin"
  export HOME="${case_dir}"
  export PATH="${fake_bin}:${PATH}"
  export COPILOT_HOME="${case_dir}/copilot-home"
  export COPILOT_GITHUB_TOKEN="test-token"
  export COPILOT_SESSION_ENABLED="false"
  export AI_AGENT_USAGE_NAME="story_development"
  export DMTOOLS_CLI_LOG_DIR="${case_dir}/logs"
  # Isolate this test from the outer rate-limit/model-fallback retry loop
  # (a completely separate concept from the loop-guard) so only the guard's
  # own internal retries are exercised.
  export COPILOT_RATE_LIMIT_RETRIES=1
  export COPILOT_LOOP_GUARD_THRESHOLD=3
  export COPILOT_LOOP_GUARD_POLL_SECONDS=0.3
  unset COPILOT_SESSION_ID COPILOT_USD_PER_CREDIT
  PROMPT_ARG="test prompt"
  PROMPT="test prompt"
  PROMPT_BYTES=11
  PASS_ARGS=()
}

# Case 1: a stuck agent is detected and killed, then recovers on retry #1 on
# the SAME model (no fallback) -- overall run_copilot must still succeed, and
# every attempt (including the loop-guard's own extra retry) must leave a
# transcript file behind.
test_recovers_on_retry() {
  local case_dir="${TEST_ROOT}/recovers"
  mkdir -p "${case_dir}/bin" "${case_dir}/outputs"
  write_fake_copilot "${case_dir}/bin" "${case_dir}/.attempts" 2

  (
    cd "${case_dir}"
    run_case_env "${case_dir}"
    export COPILOT_LOOP_GUARD_MAX_RETRIES=2

    output="$(run_copilot 2>&1)"
    status=$?

    if [ "$status" -ne 0 ]; then
      echo "[recovers-on-retry] expected run_copilot to succeed, got exit ${status}" >&2
      echo "$output" >&2
      exit 1
    fi
    if ! grep -q "loop-guard: .*detected" <<< "$output"; then
      echo "[recovers-on-retry] expected a loop-guard detection message" >&2
      echo "$output" >&2
      exit 1
    fi
    if ! grep -q "retrying 1/2 on the SAME model" <<< "$output"; then
      echo "[recovers-on-retry] expected a same-model retry message" >&2
      echo "$output" >&2
      exit 1
    fi
    if ! find logs -name '*loopguard1*' | grep -q .; then
      echo "[recovers-on-retry] expected a *-loopguard1* transcript file" >&2
      exit 1
    fi
    # The attempt that finally succeeded must have real activity in its log,
    # not the stuck-loop content.
    if ! grep -rl "some_file.java" logs > /dev/null; then
      echo "[recovers-on-retry] expected the successful attempt's transcript to be preserved" >&2
      exit 1
    fi
  )
}

# Case 2: the agent never recovers -- the guard must give up after its
# configured retry budget and return a non-zero exit code (so the job fails
# visibly) rather than looping until the CI timeout.
test_gives_up_after_max_retries() {
  local case_dir="${TEST_ROOT}/gives-up"
  mkdir -p "${case_dir}/bin" "${case_dir}/outputs"
  write_fake_copilot "${case_dir}/bin" "${case_dir}/.attempts" 999

  (
    cd "${case_dir}"
    run_case_env "${case_dir}"
    export COPILOT_LOOP_GUARD_MAX_RETRIES=1

    output="$(run_copilot 2>&1)" && status=0 || status=$?

    if [ "$status" -eq 0 ]; then
      echo "[gives-up-after-max-retries] expected a non-zero exit code" >&2
      echo "$output" >&2
      exit 1
    fi
    if ! grep -q "repeat limit (1 retries) exhausted" <<< "$output"; then
      echo "[gives-up-after-max-retries] expected the give-up message" >&2
      echo "$output" >&2
      exit 1
    fi
    # Exactly the initial attempt + 1 retry worth of transcripts, no more.
    attempt_count="$(cat .attempts)"
    if [ "${attempt_count}" -ne 2 ]; then
      echo "[gives-up-after-max-retries] expected exactly 2 copilot invocations, saw ${attempt_count}" >&2
      exit 1
    fi
  )
}

# Case 3: with the guard disabled, behavior must be a plain passthrough to
# run_copilot_once -- a single invocation, no guard messages, no marker
# files, regardless of how "stuck" the agent looks.
test_disabled_is_passthrough() {
  local case_dir="${TEST_ROOT}/disabled"
  mkdir -p "${case_dir}/bin" "${case_dir}/outputs"
  write_fake_copilot "${case_dir}/bin" "${case_dir}/.attempts" 1

  (
    cd "${case_dir}"
    run_case_env "${case_dir}"
    export COPILOT_LOOP_GUARD_ENABLED="false"

    output="$(run_copilot 2>&1)"
    status=$?

    if [ "$status" -ne 0 ]; then
      echo "[disabled-is-passthrough] expected run_copilot to succeed, got exit ${status}" >&2
      echo "$output" >&2
      exit 1
    fi
    if grep -q "loop-guard" <<< "$output"; then
      echo "[disabled-is-passthrough] loop-guard must not engage when disabled" >&2
      echo "$output" >&2
      exit 1
    fi
    attempt_count="$(cat .attempts)"
    if [ "${attempt_count}" -ne 1 ]; then
      echo "[disabled-is-passthrough] expected exactly 1 copilot invocation, saw ${attempt_count}" >&2
      exit 1
    fi
  )
}

test_recovers_on_retry
test_gives_up_after_max_retries
test_disabled_is_passthrough

echo "Copilot loop-guard tests passed"
