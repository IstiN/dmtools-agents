#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# (step: Publish leg token usage (fa-tokens ledger -> factory-data)) — stage-1 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block + always() stay on the workflow step.
set -eu
if [ ! -s "${RUN_OUTPUT}" ]; then
  echo "::warning::no run output captured — skipping token publish"
  exit 0
fi
# Sum every fa-tokens ledger line (resume-aware: one line per
# session segment). Balanced-brace JSON after the marker.
read -r SUM_IN SUM_OUT SUM_CR MODEL < <(python3 - "${RUN_OUTPUT}" <<'PY' || true
import json, re, sys
inp = out = cr = 0
model = ""
try:
    text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
except OSError:
    print(0, 0, 0, ""); raise SystemExit
for m in re.finditer(r"fa-tokens:[ \t]*(\{)", text):
    depth, i = 0, m.start(1)
    for i in range(m.start(1), len(text)):
        if text[i] == "{": depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0: break
    try:
        rec = json.loads(text[m.start(1):i + 1])
        inp += int(rec.get("input") or 0)
        out += int(rec.get("output") or 0)
        # fa-tokens carries cacheRead per segment (gh-1241); the
        # board prices it (model-pricing cacheRead rates) and
        # renders an `input cached` column — sum it like in/out.
        cr += int(rec.get("cacheRead") or 0)
        # last-seen model wins (fa ledger carries it once gh-1241
        # grows the field; absent today — stay empty, consumers
        # render tokens-only)
        if rec.get("model"):
            model = str(rec["model"])
    except Exception:
        continue
print(inp, out, cr, model)
PY
) || true
SUM_IN="${SUM_IN:-0}"
SUM_OUT="${SUM_OUT:-0}"
SUM_CR="${SUM_CR:-0}"
MODEL="${MODEL:-}"
if [ "${SUM_IN}" = "0" ] && [ "${SUM_OUT}" = "0" ]; then
  echo "::warning::no fa-tokens ledger line in run output — skipping token publish"
  exit 0
fi
# The guard collapses the rework slot into kind="dev" (rework legs run the
# dev pipeline); recover the true leg from the runner config basename.
case "$(basename "${CONFIG:-}" .json)" in
  *rework*) LEG="rework" ;;
  *) LEG="${KIND:-dev}" ;;
esac
case "${ANCHOR}" in
  pr-*) KEY="${ANCHOR}" ;;
  gh-*) KEY="issue-${ANCHOR#gh-}" ;;
  *) echo "::warning::unrecognized anchor '${ANCHOR}' — skipping token publish"; exit 0 ;;
esac
AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ROW="$(printf '{"leg":"%s","at":"%s","prompt":%s,"completion":%s,"total":%s,"cacheRead":%s,"model":"%s"}' \
  "${LEG}" "${AT}" "${SUM_IN}" "${SUM_OUT}" "$((SUM_IN + SUM_OUT))" "${SUM_CR}" "${MODEL}")"
echo "leg tokens: ${KEY} ${LEG} prompt=${SUM_IN} completion=${SUM_OUT} cached=${SUM_CR} model=${MODEL:-none}"
# Bootstrap the data branch exactly like the tick's state publish
# (422 "already exists" is the normal case) — then PUT with the
# existing sha; 3 attempts absorb concurrent leg publishes.
gh api "repos/${REPO}/git/ref/heads/$(gh api "repos/${REPO}" --jq .default_branch)" \
  --jq .object.sha \
  | xargs -I{} gh api -X POST "repos/${REPO}/git/refs" -f ref="refs/heads/${DATA_BRANCH}" -f sha={} || true
NEXT_FILE="$(mktemp "${TMPDIR:-/tmp}/fa-tokens-next.XXXXXX")"
BODY_FILE=""
trap 'rm -f "${NEXT_FILE}" "${BODY_FILE}"' EXIT
BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/fa-tokens-body.XXXXXX")"
ok=0
for attempt in 1 2 3; do
  SHA=""
  CUR="{}"
  if META="$(gh api "repos/${REPO}/contents/${DATA_PATH}?ref=${DATA_BRANCH}" 2>/dev/null)"; then
    SHA="$(printf %s "${META}" | jq -r .sha)"
    CUR="$(printf %s "${META}" | jq -r .content | tr -d '\n' | base64 -d 2>/dev/null || echo '{}')"
    printf %s "${CUR}" | jq empty >/dev/null 2>&1 || CUR='{}'
  fi
  CUTOFF="$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=14)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
  printf %s "${CUR}" | jq --argjson row "${ROW}" --arg key "${KEY}" --arg cutoff "${CUTOFF}" \
    '.[$key] = ((.[$key] // []) + [$row])
     | with_entries(.value |= (map(select((.at // "") >= $cutoff)) | .[-40:]))
     | with_entries(select(.value | length > 0))' > "${NEXT_FILE}"
  jq -n \
    --rawfile next "${NEXT_FILE}" \
    --arg branch "${DATA_BRANCH}" \
    --arg message "leg tokens — ${KEY} ${LEG} [skip ci]" \
    --arg sha "${SHA}" \
    '{branch: $branch, message: $message, content: ($next | @base64)} + (if $sha != "" then {sha: $sha} else {} end)' > "${BODY_FILE}"
  if gh api -X PUT "repos/${REPO}/contents/${DATA_PATH}" --input "${BODY_FILE}"; then ok=1; break; fi
  echo "token publish attempt ${attempt} conflicted — refetching"
  sleep $((attempt * 2))
done
if [ "${ok}" != "1" ]; then
  echo "::warning::token publish gave up after 3 attempts (concurrent writes) — rows are decorative, next legs retry"
fi
