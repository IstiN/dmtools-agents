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
# — E2BIG past 128 KiB, the same rule the token-usage publisher learned).
set -u

REPO="${GITHUB_REPOSITORY:-}"
NUMBER="${NUMBER:-}"
OUTCOME="${OUTCOME:-}"

if [ -z "$NUMBER" ] || [ -z "$REPO" ]; then
  echo "::warning::report-leg-failure: NUMBER/GITHUB_REPOSITORY unset — nothing to notice on"
  exit 0
fi

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
# depend on the enrichment stack.
leg_failure_outcome_line() {
  node -e 'const kit = require(process.argv[1]); process.stdout.write(kit.outcomeLine(process.argv[2], process.argv[3]))' \
    "$KIT_JS" "$1" "$2" 2>/dev/null \
    || printf '🤖 AI Teammate run %s: %s' "$1" "$2"
}
# AC6 — the success path stays the historical bare-link line.
if [ "$OUTCOME" = "success" ] || [ -z "$OUTCOME" ]; then
  gh issue comment "$NUMBER" --repo "$REPO" \
    --body "$(leg_failure_outcome_line "${OUTCOME:-success}" "$RUN_URL")"
  exit $?
fi

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
  --argjson priorBodies "$PRIOR_BODIES" \
  '{workflow: $workflow, step: $step, message: $message, phase: $phase,
    runId: $runId, runUrl: $runUrl, preflightLine: $preflightLine,
    excerpt: $excerpt, priorBodies: $priorBodies}' || echo '{}')"

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

