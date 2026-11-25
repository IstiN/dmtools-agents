#!/bin/bash
# Tests for the Copilot permission / env-allowlist / sandbox settings (#1535).
# Uses a stub `copilot` binary that dumps its argv and environment; no network.
set -euo pipefail

PROVIDERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

source "${PROVIDERS_DIR}/_common.sh"
source "${PROVIDERS_DIR}/copilot.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

NEW_VARS=(COPILOT_PERMISSION_MODE COPILOT_ALLOW_TOOLS COPILOT_DENY_TOOLS COPILOT_AVAILABLE_TOOLS
  COPILOT_ENV_ALLOWLIST COPILOT_SANDBOX COPILOT_SANDBOX_SETTINGS COPILOT_SANDBOX_AVAILABLE)

# Runs run_copilot in a subshell with a stub copilot; extra args are VAR=value
# exports. Leaves args (one per line), env and stdout under $TEST_ROOT/<case>.
run_case() {
  local name="$1"; shift
  local dir="${TEST_ROOT}/${name}"
  mkdir -p "${dir}/bin" "${dir}/outputs"
  cat > "${dir}/bin/copilot" << 'BINEOF'
#!/bin/bash
if [ "${1:-}" = "--help" ]; then
  echo "  --sandbox"
  exit 0
fi
printf '%s\n' "$@" > "${STUB_DIR}/args"
env > "${STUB_DIR}/env"
echo "stub done"
exit 0
BINEOF
  # STUB_DIR must survive `env -i`, so bake it into the stub.
  sed -i.bak "2i\\
STUB_DIR='${dir}'
" "${dir}/bin/copilot" && rm -f "${dir}/bin/copilot.bak"
  chmod +x "${dir}/bin/copilot"
  (
    cd "${dir}"
    unset "${NEW_VARS[@]}" COPILOT_SESSION_ID COPILOT_USD_PER_CREDIT
    export HOME="${dir}"
    export PATH="${dir}/bin:${PATH}"
    export COPILOT_HOME="${dir}/copilot-home"
    export COPILOT_GITHUB_TOKEN="test-token"
    export COPILOT_SESSION_ENABLED="false"
    export COPILOT_LOOP_GUARD_ENABLED="false"
    export AI_AGENT_USAGE_NAME="pr_review"
    export DMTOOLS_CLI_LOG_DIR="${dir}/logs"
    export SECRET_SHOULD_NOT_LEAK="leak-me"
    local kv
    for kv in "$@"; do export "${kv?}"; done
    PROMPT_ARG="test prompt"; PROMPT="test prompt"; PROMPT_BYTES=11; PASS_ARGS=()
    rc=0
    run_copilot > "${dir}/stdout" 2>&1 || rc=$?
    echo "${rc}" > "${dir}/rc"
  )
}

has_arg() { grep -qxF -- "$2" "${TEST_ROOT}/$1/args"; }

# 1. Default: identical command line (--allow-all first, nothing new).
run_case default
[ "$(cat "${TEST_ROOT}/default/rc")" = 0 ] || fail "default rc"
[ "$(head -1 "${TEST_ROOT}/default/args")" = "--allow-all" ] || fail "default first arg"
[ "$(sed -n 2p "${TEST_ROOT}/default/args")" = "--model" ] || fail "default second arg"
for f in --disallow-temp-dir --sandbox --available-tools; do
  has_arg default "$f" && fail "default unexpectedly has $f"
done
grep -q '^Running: copilot --allow-all --model ' "${TEST_ROOT}/default/stdout" || fail "default Running: line changed"
grep -q '^SECRET_SHOULD_NOT_LEAK=leak-me$' "${TEST_ROOT}/default/env" || fail "default env should be inherited"

# 2. Restricted with tool lists.
run_case restricted COPILOT_PERMISSION_MODE=restricted \
  "COPILOT_ALLOW_TOOLS=read, shell(git:*)" "COPILOT_DENY_TOOLS=shell(curl),write" \
  "COPILOT_AVAILABLE_TOOLS=view,grep,glob"
[ "$(cat "${TEST_ROOT}/restricted/rc")" = 0 ] || fail "restricted rc"
grep -qE -- '^--allow-all' "${TEST_ROOT}/restricted/args" && fail "restricted has --allow-all*"
has_arg restricted --disallow-temp-dir || fail "restricted missing --disallow-temp-dir"
has_arg restricted '--allow-tool=read' || fail "allow read"
has_arg restricted '--allow-tool=shell(git:*)' || fail "allow git"
has_arg restricted '--deny-tool=shell(curl)' || fail "deny curl"
has_arg restricted '--deny-tool=write' || fail "deny write"
grep -A4 -xF -- '--available-tools' "${TEST_ROOT}/restricted/args" | tr '\n' ' ' | grep -qF -- '--available-tools view grep glob --model' || fail "available tools"

# 3. Invalid mode fails closed.
run_case badmode COPILOT_PERMISSION_MODE=yolo
[ "$(cat "${TEST_ROOT}/badmode/rc")" != 0 ] || fail "invalid mode should fail"
[ ! -f "${TEST_ROOT}/badmode/args" ] || fail "invalid mode must not run copilot"

# 4. Env allowlist: only listed vars (+HOME/PATH/COPILOT_HOME) reach the CLI.
run_case envlist COPILOT_ENV_ALLOWLIST=COPILOT_GITHUB_TOKEN,COPILOT_MODEL COPILOT_MODEL=gpt-test
[ "$(cat "${TEST_ROOT}/envlist/rc")" = 0 ] || fail "envlist rc"
envf="${TEST_ROOT}/envlist/env"
grep -q '^COPILOT_GITHUB_TOKEN=test-token$' "${envf}" || fail "token missing"
grep -q '^COPILOT_MODEL=gpt-test$' "${envf}" || fail "model missing"
grep -q '^HOME=' "${envf}" || fail "HOME missing"
grep -q '^PATH=' "${envf}" || fail "PATH missing"
grep -q '^SECRET_SHOULD_NOT_LEAK=' "${envf}" && fail "non-allowlisted secret leaked"
grep -q '^COPILOT_ENV_ALLOWLIST=' "${envf}" && fail "allowlist var itself leaked"
grep -q 'leak-me' "${TEST_ROOT}/envlist/stdout" && fail "secret printed in log"

# 5. Sandbox required + unavailable fails closed without running copilot.
run_case sbx_required COPILOT_SANDBOX=required COPILOT_SANDBOX_AVAILABLE=false
[ "$(cat "${TEST_ROOT}/sbx_required/rc")" != 0 ] || fail "required sandbox should fail"
[ ! -f "${TEST_ROOT}/sbx_required/args" ] || fail "required sandbox must not run copilot"
grep -q 'COPILOT_SANDBOX=required' "${TEST_ROOT}/sbx_required/stdout" || fail "missing clear error"

# 6. Sandbox auto + unavailable proceeds without --sandbox; available adds it.
run_case sbx_auto COPILOT_SANDBOX=auto COPILOT_SANDBOX_AVAILABLE=false
[ "$(cat "${TEST_ROOT}/sbx_auto/rc")" = 0 ] || fail "auto rc"
has_arg sbx_auto --sandbox && fail "auto unavailable should not pass --sandbox"
printf '{"sandbox":{}}' > "${TEST_ROOT}/policy.json"
run_case sbx_on COPILOT_SANDBOX=required COPILOT_SANDBOX_AVAILABLE=true "COPILOT_SANDBOX_SETTINGS=${TEST_ROOT}/policy.json"
[ "$(cat "${TEST_ROOT}/sbx_on/rc")" = 0 ] || fail "sandbox on rc"
has_arg sbx_on --sandbox || fail "sandbox on missing --sandbox"
cmp -s "${TEST_ROOT}/policy.json" "${TEST_ROOT}/sbx_on/copilot-home/settings.json" || fail "sandbox settings not installed"

# 7. Pure builder: default yields exactly --allow-all and no env prefix.
(
  unset "${NEW_VARS[@]}"
  build_copilot_permission_args copilot
  [ "${COPILOT_PERMISSION_ARGS[*]}" = "--allow-all" ] || fail "builder default"
  [ "${#COPILOT_ENV_PREFIX[@]}" -eq 0 ] || fail "builder default prefix"
)

echo "Copilot permission tests passed"
