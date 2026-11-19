#!/usr/bin/env bash
# Extracted from the awf factory-teammate.yml step «Publish leg token usage».
# Owner directive 2026-11-19: the target path is the ONE hardcoded constant
# `data/agents-tokens.json` (branch `factory-data`) — no DATA_PATH /
# DATA_BRANCH env; the JS producer (js/factory/token_usage.js
# DEFAULT_DATA_PATH) and the SM tick reader (js/factoryState.js
# FACTORY_TOKENS_ASSET) pin the same literals.
set -eu
if [ ! -s "${RUN_OUTPUT}" ]; then
  echo "::warning::no run output captured — skipping token publish"
  exit 0
fi

# gh-1450: a >1h leg outlives GitHub's fixed 1-hour App-token TTL — apply the
# freshest credential before the first gh call (no-op when the helper is
# absent; see scripts/gh-auth-refresh.sh).
if [ -f "$(dirname "$0")/gh-auth-refresh.sh" ]; then
  . "$(dirname "$0")/gh-auth-refresh.sh"
  gh_auth_refresh_apply
fi
# Sum every fa-tokens ledger line (resume-aware: one line per
# session segment). Balanced-brace JSON after the marker.
read -r SUM_IN SUM_OUT SUM_CR MODEL < <(python3 - "${RUN_OUTPUT}" <<'PY' || true
import json, re, sys
inp = out = cr = req = 0
model = ""
sources = set()
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
        # requests: the ledger's per-segment request count — the row
        # answers "how expensive is a leg with the cache priced in".
        # int() parity with input/output: absent → 0, non-numeric
        # skips the whole record.
        req += int(rec.get("requests") or 0)
        # source kinds (reported | estimated) — 'mixed' when both
        # appear in one ledger (owner 2026-11-19: cold-restart
        # visibility; same discipline as the fa reporter).
        if rec.get("source") in ("reported", "estimated"):
            sources.add(rec["source"])
        # last-seen model wins (fa ledger carries it once gh-1241
        # grows the field; absent today — stay empty, consumers
        # render tokens-only)
        if rec.get("model"):
            model = str(rec["model"])
    except Exception:
        continue
src = ""
if len(sources) == 1:
    src = next(iter(sources))
elif len(sources) > 1:
    src = "mixed"
print(inp, out, cr, req, src, model)
PY
) || true
SUM_IN="${SUM_IN:-0}"
SUM_OUT="${SUM_OUT:-0}"
SUM_CR="${SUM_CR:-0}"
SUM_REQ="${SUM_REQ:-0}"
SOURCE="${SOURCE:-}"
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
ROW="$(printf '{"leg":"%s","at":"%s","prompt":%s,"completion":%s,"total":%s,"cacheRead":%s,"requests":%s,"source":"%s","model":"%s"}' \
  "${LEG}" "${AT}" "${SUM_IN}" "${SUM_OUT}" "$((SUM_IN + SUM_OUT))" "${SUM_CR}" "${SUM_REQ}" "${SOURCE}" "${MODEL}")"
echo "leg tokens: ${KEY} ${LEG} prompt=${SUM_IN} completion=${SUM_OUT} cached=${SUM_CR} requests=${SUM_REQ} source=${SOURCE:-none} model=${MODEL:-none}"
# Bootstrap the data branch exactly like the tick's state publish
# (422 "already exists" is the normal case) — then PUT with the
# existing sha; 3 attempts absorb concurrent leg publishes.
gh api "repos/${REPO}/git/ref/heads/$(gh api "repos/${REPO}" --jq .default_branch)" \
  --jq .object.sha \
  | xargs -I{} gh api -X POST "repos/${REPO}/git/refs" -f ref="refs/heads/factory-data" -f sha={} || true
NEXT_FILE="$(mktemp "${TMPDIR:-/tmp}/fa-tokens-next.XXXXXX")"
BODY_FILE=""
trap 'rm -f "${NEXT_FILE}" "${BODY_FILE}"' EXIT
BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/fa-tokens-body.XXXXXX")"
ok=0
for attempt in 1 2 3; do
  SHA=""
  CUR="{}"
  if META="$(gh api "repos/${REPO}/contents/data/agents-tokens.json?ref=factory-data" 2>/dev/null)"; then
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
    --arg branch "factory-data" \
    --arg message "leg tokens — ${KEY} ${LEG} [skip ci]" \
    --arg sha "${SHA}" \
    '{branch: $branch, message: $message, content: ($next | @base64)} + (if $sha != "" then {sha: $sha} else {} end)' > "${BODY_FILE}"
  if gh api -X PUT "repos/${REPO}/contents/data/agents-tokens.json" --input "${BODY_FILE}"; then ok=1; break; fi
  echo "token publish attempt ${attempt} conflicted — refetching"
  sleep $((attempt * 2))
done
if [ "${ok}" != "1" ]; then
  echo "::warning::token publish gave up after 3 attempts (concurrent writes) — rows are decorative, next legs retry"
fi
