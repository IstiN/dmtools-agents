#!/usr/bin/env bash
# report-leg-failure.sh — the enriched leg-failure notice (gh-1363).
#
# Engine-side factory glue (the flip target of the factory workflow's
# «Link the run back to the issue» step — the bare-link poster). Ships in
# the factory-setup asset next to the other engine scripts; the workflow
# step becomes a thin caller:
#
#   run: bash -e "${RUNNER_TEMP}/factory-setup/scripts/report-leg-failure.sh"
#
# Behavior contract (gh-1363):
#   success      → the historical bare-link line, byte-identical (AC6 — no
#                  new comments on success paths).
#   unset        → a ::warning:: and no comment at all — a missing OUTCOME
#                  is a misconfiguration, never a fabricated "run success"
#                  (gh-1363 review).
#   otherwise    → ONE enriched comment built by the shipped pure builder
#                  js/common/legFailureReport.js (same factory-setup asset):
#                  phase, failing step name (jobs API), ≤30-line excerpt of
#                  `gh run view --log-failed`, run id + link, the leg-start
#                  pre-flight line when available, and the repeat count
#                  against prior `failure-signature:` lines on the issue.
#   degradation  → every probe failure drops its section, never the notice:
#                  if the builder output cannot be produced at all, the
#                  historical bare-link line is posted as the fallback.
#
# Env block of the calling workflow step (all optional unless noted):
#   NUMBER            issue to comment on (required — absent → exit 0, the
#                     PR-anchored lane has no issue to notice on)
#   OUTCOME           success | failure | cancelled | <other>
#   CI_RUN_URL        run URL (empty → built from GITHUB_* env)
#   PHASE             setup | ai-work | reporting (default ai-work — the
#                     notice covers the whole job; the setup path reports
#                     its own phase through the ticket comment)
#   PREFLIGHT_LINE    the canonical `git pre-flight: …` line captured at leg
#                     start (optional — the report includes it when available)
#   WORKFLOW_FILE     the leg workflow filename for the signature (default
#                     ai-teammate.yml)
#   GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID   (runner-provided)
#   GH_TOKEN / SOURCE_GITHUB_TOKEN  (gh auth, runner-provided)
#
# Rendering rides node (present on GH runners) + the shipped builder —
# ONE canonical implementation of the signature math and the report shape;
# this script is transport only. Payload bytes travel via stdin (never argv
# — E2BIG past 128 KiB, the same rule the token-usage publisher learned):
# the comment history enters the payload through `jq --slurpfile` fed by a
# process substitution, so the largest component never touches argv either.
#
# --self-test: `bash scripts/report-leg-failure.sh --self-test` exercises
# the contract end-to-end with a stub `gh` on PATH (node + jq run for real):
# the success byte-shape, the unset-outcome guard, the enriched failure
# report (incl. repeat count), the >128 KiB comment history (E2BIG rule)
# and the builder-unavailable fallback. Exit 0 only when every scenario
# holds — the advertised verification command actually verifies.
set -u

REPO="${GITHUB_REPOSITORY:-}"
NUMBER="${NUMBER:-}"
OUTCOME="${OUTCOME:-}"

RUN_URL="${CI_RUN_URL:-}"
if [ -z "$RUN_URL" ] && [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
  RUN_URL="$GITHUB_SERVER_URL/$REPO/actions/runs/$GITHUB_RUN_ID"
fi

KIT_ROOT="${FACTORY_SETUP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
KIT_JS="$KIT_ROOT/js/common/legFailureReport.js"
KIT_MARKUP="$KIT_ROOT/js/common/commentMarkup.js"
KIT_SHAPES="$KIT_ROOT/js/common/ticketKeyShapes.js"

# The historical bare-link line via the shipped builder, with a plain-shell
# fallback when node/the kit is unavailable — the notice itself must never
# depend on the enrichment stack. The fallback default keeps both layers
# byte-aligned when no run URL is known (gh-1363 review).
leg_failure_outcome_line() {
  node -e 'const kit = require(process.argv[1]); process.stdout.write(kit.outcomeLine(process.argv[2], process.argv[3]))' \
    "$KIT_JS" "$1" "$2" 2>/dev/null \
    || printf '🤖 AI Teammate run %s: %s' "$1" "${2:-<run-url-unavailable>}"
}

# ── --self-test ──────────────────────────────────────────────────────────────
# End-to-end contract check with a stub `gh` on PATH (node + jq run for
# real). Covers: the success byte-shape (AC6), the unset-outcome guard, the
# enriched failure report incl. repeat count, the >128 KiB comment history
# (payload never travels argv — E2BIG) and the builder-unavailable fallback.
# Exit 0 only when every scenario holds.
self_test() {
  local fails=0 tmp stubs rec out body rc script
  script="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  tmp="$(mktemp -d)"
  stubs="$tmp/stubs"
  mkdir -p "$stubs" "$tmp/no-kit"

  # gh test double: records posted bodies to $GH_STUB_RECORD (separated by a
  # --BOUNDARY-- line), serves canned payloads from the FILES $GH_STUB_JOBS /
  # $GH_STUB_LOG / $GH_STUB_COMENTS point at — a big fixture must not travel
  # env/argv either. jq filters are applied with the real jq, like gh does.
  cat > "$stubs/gh" <<'STUB_EOF'
#!/usr/bin/env bash
REC="${GH_STUB_RECORD:?GH_STUB_RECORD unset}"
case "$1 $2" in
  "issue comment")
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--body-file" ]; then cat >> "$REC"; fi
      if [ "$prev" = "--body" ]; then printf '%s' "$a" >> "$REC"; fi
      prev="$a"
    done
    printf '\n--BOUNDARY--\n' >> "$REC"
    exit 0 ;;
  "run view")
    case "$*" in
      *--log-failed*) [ -n "${GH_STUB_LOG:-}" ] && cat "$GH_STUB_LOG" ;;
      *)
        prev=""
        for a in "$@"; do
          if [ "$prev" = "--jq" ]; then [ -n "${GH_STUB_JOBS:-}" ] && jq -r "$a" < "$GH_STUB_JOBS" 2>/dev/null; fi
          prev="$a"
        done ;;
    esac
    exit 0 ;;
  "issue view")
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--jq" ]; then [ -n "${GH_STUB_COMENTS:-}" ] && jq -c "$a" < "$GH_STUB_COMENTS" 2>/dev/null; fi
      prev="$a"
    done
    exit 0 ;;
esac
exit 0
STUB_EOF
  chmod 755 "$stubs/gh"

  # The recorded posted body (everything before the first boundary line).
  first_body() { sed '/^--BOUNDARY--$/,$d' "$1"; }

  # One scenario invocation of this very script: scrubbed ambient CI env +
  # the stub PATH + per-scenario vars.
  scenario_env() {
    env -u NUMBER -u OUTCOME -u CI_RUN_URL -u PHASE -u PREFLIGHT_LINE \
        -u WORKFLOW_FILE -u GITHUB_REPOSITORY -u GITHUB_SERVER_URL \
        -u GITHUB_RUN_ID -u FACTORY_SETUP_ROOT \
        PATH="$stubs:$PATH" GH_STUB_RECORD="$1" "${@:2}"
  }

  assert_contains() {
    if [ "$2" != "${2#*"$3"}" ]; then
      echo "ok - $1"
    else
      echo "self-test FAIL: $1"
      fails=$((fails + 1))
    fi
  }

  assert_equals() {
    if [ "$2" = "$3" ]; then
      echo "ok - $1"
    else
      echo "self-test FAIL: $1 — got [$2]"
      fails=$((fails + 1))
    fi
  }

  # Canned failing-job payload + log excerpt + the matching fixture signature.
  cat > "$tmp/jobs.json" <<'JOBS_EOF'
{"jobs":[{"conclusion":"failure","steps":[{"name":"Build","conclusion":"success"},{"name":"Test","conclusion":"failure"}]}]}
JOBS_EOF
  printf 'log line A\nlog line B' > "$tmp/log.txt"
  if ! sig="$(node -e 'const kit=require(process.argv[1]);process.stdout.write(kit.failureSignature({workflow:"ai-teammate.yml",step:"Test",message:"Test\nlog line A\nlog line B"}))' "$KIT_JS")"; then
    echo "report-leg-failure self-test: FAIL — cannot derive the fixture signature (node/KIT_JS broken)"
    rm -rf "$tmp"
    return 1
  fi
  jq -cn --arg sig "$sig" \
    '{comments: [{author: {login: "bot"}, body: ("older notice\nfailure-signature: " + $sig)}]}' \
    > "$tmp/comments.json"
  # A >128 KiB comment history (MAX_ARG_STRLEN): pad comment first (older),
  # the matching signature line last — the E2BIG-rule fixture.
  node -e 'process.stdout.write("x".repeat(150000))' > "$tmp/pad.txt"
  jq -cn --arg sig "$sig" --rawfile pad "$tmp/pad.txt" \
    '{comments: [{author: {login: "bot"}, body: $pad},
                 {author: {login: "bot"}, body: ("failure-signature: " + $sig)}]}' \
    > "$tmp/comments-big.json"

  # 1 — success keeps the historical bare-link line, byte-exact (AC6).
  rec="$tmp/r1"; : > "$rec"
  out="$(scenario_env "$rec" NUMBER=12 GITHUB_REPOSITORY=acme/widgets OUTCOME=success \
      CI_RUN_URL=https://github.com/acme/widgets/actions/runs/42 bash "$script" 2>&1)"; rc=$?
  assert_equals "success exits 0" "$rc" "0"
  assert_equals "success posts the bare-link line byte-shape (AC6)" \
    "$(first_body "$rec")" \
    '🤖 AI Teammate run success: https://github.com/acme/widgets/actions/runs/42'

  # 2 — an UNSET outcome is a warning + skipped notice, never a fake success.
  rec="$tmp/r2"; : > "$rec"
  out="$(scenario_env "$rec" NUMBER=12 GITHUB_REPOSITORY=acme/widgets bash "$script" 2>&1)"; rc=$?
  assert_equals "unset outcome exits 0" "$rc" "0"
  assert_contains "unset outcome warns and skips (nothing fabricated)" \
    "$out$( [ -s "$rec" ] && echo ' POSTED-SOMETHING' )" \
    "::warning::report-leg-failure: OUTCOME unset"
  if [ -s "$rec" ]; then
    echo "self-test FAIL: unset outcome must not post — got [$(cat "$rec")]"
    fails=$((fails + 1))
  else
    echo "ok - unset outcome posts nothing"
  fi

  # 3 — failure renders ONE enriched comment with the repeat count.
  rec="$tmp/r3"; : > "$rec"
  out="$(scenario_env "$rec" NUMBER=12 GITHUB_REPOSITORY=acme/widgets OUTCOME=failure \
      GITHUB_SERVER_URL=https://github.com GITHUB_RUN_ID=4242 PHASE=ai-work \
      GH_STUB_JOBS="$tmp/jobs.json" GH_STUB_LOG="$tmp/log.txt" \
      GH_STUB_COMENTS="$tmp/comments.json" bash "$script" 2>&1)"; rc=$?
  assert_equals "enriched failure exits 0" "$rc" "0"
  body="$(first_body "$rec")"
  assert_contains "enriched failure carries the report heading" "$body" '### 🤖 AI Teammate run failed'
  assert_contains "enriched failure carries the failing step" "$body" '**Failing step:** Test'
  assert_contains "enriched failure carries the phase" "$body" '**Phase:** ai-work'
  assert_contains "enriched failure carries the bounded excerpt" "$body" 'log line B'
  assert_contains "enriched failure carries the repeat count" "$body" 'identical failure #2 in a row'
  assert_contains "enriched failure carries the signature line" "$body" \
    'failure-signature: ai-teammate.yml | Test |'

  # 4 — a >128 KiB comment history still enriches (payload never on argv).
  rec="$tmp/r4"; : > "$rec"
  out="$(scenario_env "$rec" NUMBER=12 GITHUB_REPOSITORY=acme/widgets OUTCOME=failure \
      GITHUB_SERVER_URL=https://github.com GITHUB_RUN_ID=4242 PHASE=ai-work \
      GH_STUB_JOBS="$tmp/jobs.json" GH_STUB_LOG="$tmp/log.txt" \
      GH_STUB_COMENTS="$tmp/comments-big.json" bash "$script" 2>&1)"; rc=$?
  assert_equals "E2BIG history exits 0" "$rc" "0"
  body="$(first_body "$rec")"
  assert_contains "150 KiB history still carries the failing step" "$body" '**Failing step:** Test'
  assert_contains "150 KiB history still carries the repeat count (payload off argv)" "$body" \
    'identical failure #2 in a row'

  # 5 — builder unavailable → bare-link fallback keeps the placeholder.
  rec="$tmp/r5"; : > "$rec"
  out="$(scenario_env "$rec" NUMBER=12 GITHUB_REPOSITORY=acme/widgets OUTCOME=failure \
      FACTORY_SETUP_ROOT="$tmp/no-kit" bash "$script" 2>&1)"; rc=$?
  assert_equals "builder-unavailable exits 0" "$rc" "0"
  assert_equals "fallback keeps the run-url placeholder (never a dangling colon)" \
    "$(first_body "$rec")" '🤖 AI Teammate run failure: <run-url-unavailable>'

  rm -rf "$tmp"
  if [ "$fails" -eq 0 ]; then
    echo "report-leg-failure self-test: PASS"
    return 0
  fi
  echo "report-leg-failure self-test: FAIL ($fails assertion(s) failed)"
  return 1
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

if [ -z "$NUMBER" ] || [ -z "$REPO" ]; then
  echo "::warning::report-leg-failure: NUMBER/GITHUB_REPOSITORY unset — nothing to notice on"
  exit 0
fi

# AC6 — the success path stays the historical bare-link line. An UNSET
# outcome is never a success: warn and skip (a missing env var must not
# fabricate a "run success" comment — gh-1363 review).
case "$OUTCOME" in
  success)
    gh issue comment "$NUMBER" --repo "$REPO" \
      --body "$(leg_failure_outcome_line success "$RUN_URL")"
    exit $?
    ;;
  '')
    echo "::warning::report-leg-failure: OUTCOME unset — notice skipped"
    exit 0
    ;;
esac

# The failed step name: first failed step of the first failed job.
STEP_NAME="$(gh run view "${GITHUB_RUN_ID:-}" --repo "$REPO" --json jobs \
  --jq 'first(.jobs[] | select(.conclusion == "failure") | .steps[] | select(.conclusion == "failure") | .name) // empty' \
  2>/dev/null || true)"
# older gh --jq prints JSON-encoded strings — strip a wrapping pair of quotes
STEP_NAME="${STEP_NAME%\"}"
STEP_NAME="${STEP_NAME#\"}"

# The excerpt: tail of the failed-step log, hard cap 30 (AC5).
EXCERPT="$(gh run view "${GITHUB_RUN_ID:-}" --repo "$REPO" --log-failed 2>/dev/null | tail -n 30 || true)"

# Prior signature history: this issue's own comments (existing surface —
# no new persistence), most recent last. A failed/empty read degrades to []
# — every probe failure must drop its section, never kill the notice.
PRIOR_BODIES="$(gh issue view "$NUMBER" --repo "$REPO" --json comments \
  --jq '[.comments[].body]' 2>/dev/null || true)"
PRIOR_BODIES="${PRIOR_BODIES:-[]}"
case "$PRIOR_BODIES" in
  \[*) : ;; # a JSON array — usable
  *) PRIOR_BODIES="[]" ;;
esac

# Build the enriched comment with the shipped builder. Payload via stdin.
NODE_PROG="$(cat <<'PROG_EOF'
const fs = require('fs');
// node -e argv: [node, kitJs, kitMarkup, kitShapes] — user args start at 1.
const kit = require(process.argv[1]);
const markup = require(process.argv[2]);
process.argv[3] && require(process.argv[3]);
const env = JSON.parse(fs.readFileSync(0, 'utf8'));
const signature = kit.failureSignature({
  workflow: env.workflow, step: env.step, message: env.message
});
const repeat = kit.consecutiveRepeatCount(
  signature, kit.parseSignatureLines(env.priorBodies));
const body = kit.buildFailureComment({
  phase: env.phase,
  step: env.step,
  runId: env.runId,
  runUrl: env.runUrl,
  preflightLine: env.preflightLine,
  excerpt: env.excerpt,
  repeatCount: repeat,
  signature: signature
}, markup.forFlavor('markdown'));
process.stdout.write(body);
PROG_EOF
)"

# PRIOR_BODIES — the whole comment history, the largest payload component —
# enters through --slurpfile + process substitution: argv carries only an
# fd path, so a >128 KiB history cannot hit E2BIG (the stdin rule this
# script exists on). `|| echo '{}'` keeps the bare-link fallback for a
# broken read, as before.
PAYLOAD="$(jq -n \
  --arg workflow "${WORKFLOW_FILE:-ai-teammate.yml}" \
  --arg step "${STEP_NAME:-}" \
  --arg message "${STEP_NAME:-}
$EXCERPT" \
  --arg phase "${PHASE:-ai-work}" \
  --arg runId "${GITHUB_RUN_ID:-}" \
  --arg runUrl "$RUN_URL" \
  --arg preflightLine "${PREFLIGHT_LINE:-}" \
  --arg excerpt "$EXCERPT" \
  --slurpfile priorBodies <(printf '%s' "$PRIOR_BODIES") \
  '{workflow: $workflow, step: $step, message: $message, phase: $phase,
    runId: $runId, runUrl: $runUrl, preflightLine: $preflightLine,
    excerpt: $excerpt} * {priorBodies: $priorBodies[0]}' || echo '{}')"

BODY="$(printf '%s' "${PAYLOAD:-{\}}" | node -e "$NODE_PROG" "$KIT_JS" "$KIT_MARKUP" "$KIT_SHAPES" 2>/dev/null || true)"

if [ -n "$BODY" ]; then
  printf '%s' "$BODY" | gh issue comment "$NUMBER" --repo "$REPO" --body-file - && exit 0
  echo "::warning::report-leg-failure: enriched notice posting failed — falling back to the bare link"
else
  echo "::warning::report-leg-failure: enriched notice unavailable (node/builder failure) — bare-link fallback"
fi

# Fallback: never lose the notice entirely.
gh issue comment "$NUMBER" --repo "$REPO" \
  --body "$(leg_failure_outcome_line "$OUTCOME" "$RUN_URL")"
