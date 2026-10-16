#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Apply the review verdict (review runs only)) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "::warning::SOURCE_GITHUB_TOKEN not set — verdict labels would not trigger workflows; skipping (a maintainer must label manually)"
    exit 0
  fi
  repo="${GITHUB_REPOSITORY}"
  labels="$(gh issue view "$NUMBER" --repo "$repo" --json labels \
    --jq '[.labels[].name] | join(" ")' 2>/dev/null || echo '')"
  find_linked_pr() {
    gh pr list --repo "$repo" --state open \
      --json number,body,headRefName --jq '
      [.[] | select(
          ((.body // "") | test("(?i)\\b(closes|fixes|resolves)\\s+#'"$NUMBER"'\\b"))
          or (.headRefName | test("^'"$NUMBER"'[-_.]"))
          or (.headRefName | test("(^|[-_./])gh-0*'"$NUMBER"'$")))
        | .number] | first // empty'
  }
  pr="$(find_linked_pr)"
  # Verdict fallback sources beyond the run output (gh-305): what
  # the leg itself wrote on the PR (comments + review bodies) and
  # on the issue. A failed fetch leaves the file absent — the
  # parser's diagnosis reports it as `missing`, never a hard stop.
  verdict_dir="$(mktemp -d)"
  trap 'rm -rf "$verdict_dir"' EXIT
  pr_comments_json="${verdict_dir}/pr_comments.json"
  issue_comments_json="${verdict_dir}/issue_comments.json"
  if [ -n "$pr" ]; then
    gh pr view "$pr" --repo "$repo" --json comments,reviews \
      --jq '[(.comments // [])[] | {author: (.author.login // ""), body}] + [(.reviews // [])[] | {author: (.author.login // ""), body}]' \
      > "$pr_comments_json" 2>/dev/null || rm -f "$pr_comments_json"
  fi
  gh issue view "$NUMBER" --repo "$repo" --json comments \
    --jq '[(.comments // [])[] | {author: (.author.login // ""), body}]' \
    > "$issue_comments_json" 2>/dev/null || rm -f "$issue_comments_json"
  # machineAuthor resolution order #2 (js/common/machineAuthor.js):
  # deployments that set the per-repo .dmtools/config.js knob but
  # not the workflow input. Best-effort — empty on miss (then only
  # *[bot] comment authors are trusted).
  if [ -z "${MACHINE_AUTHOR:-}" ] && [ -r .dmtools/config.js ]; then
    MACHINE_AUTHOR="$(sed -nE 's/.*machineAuthor["'\'']?[[:space:]]*:[[:space:]]*["'\'']([A-Za-z0-9._-]+)["'\''].*/\1/p' .dmtools/config.js | head -1)"
  fi
  # Wave 2 (owner 2026-10-01): the verdict logic versions WITH the
  # reviewed pack — the unpacked pack's loop/verdict.sh WINS; the
  # legacy delegation `bash factory-agents/setup/review-verdict.sh decide`
  # remains the fallback for old pins. The pack cache
  # (~/.dmtools/packs/<agent>-<version>/) is guaranteed populated
  # here: the agent run above resolved the review pack parent.
  VERDICT_SH="${FACTORY_ROOT}/setup/review-verdict.sh"
  review_agent="$(basename "${CONFIG}" .json)"
  pack_verdict="$(ls -1 "${HOME}"/.dmtools/packs/"${review_agent}"-*/loop/verdict.sh 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "${pack_verdict}" ]; then
    VERDICT_SH="${pack_verdict}"
    echo "→ verdict logic: pack ${VERDICT_SH}"
  else
    echo "→ verdict logic: legacy tree ${VERDICT_SH} (no ${review_agent} pack loop/verdict.sh unpacked)"
  fi
  # Decision (pure logic, eval-safe key=value output): decision,
  # source, override, blocking_markers, rounds_done, next_round,
  # escalate, round_labels, diagnosis.
  eval "$(MAX_ROUNDS="${MAX_ROUNDS}" \
    PR_REVIEW_JSON="outputs/pr_review.json" \
    PR_REVIEW_JSON_ALT="outputs/gh-${NUMBER}/pr_review.json" \
    RUN_OUTPUT="${RUN_OUTPUT}" \
    PR_COMMENTS_JSON="${pr_comments_json}" \
    ISSUE_COMMENTS_JSON="${issue_comments_json}" \
    MACHINE_AUTHOR="${MACHINE_AUTHOR:-}" \
    ISSUE_LABELS="${labels}" \
    bash "${VERDICT_SH}" decide)"
  decision="${decision:-unknown}"
  escalate="${escalate:-false}"
  rounds_done="${rounds_done:-0}"
  next_round="${next_round:-0}"
  echo "→ review decision: ${decision} (source=${source:-none}, override=${override:-false}, rounds_done=${rounds_done})"
  strip_round_labels() {
    for lbl in ${round_labels:-}; do
      gh issue edit "$NUMBER" --repo "$repo" --remove-label "$lbl" || true
    done
  }
  # bash -e: a missing label would abort the verdict transition —
  # create-or-update first (--force is an idempotent no-op).
  ensure_label() {
    gh label create "$1" --repo "$repo" --color "$2" --force >/dev/null 2>&1 || true
  }
  if [ "$decision" = "rework" ]; then
    if [ "$escalate" = "true" ]; then
      strip_round_labels
      ensure_label "needs-human" "B60205"
      gh issue edit "$NUMBER" --repo "$repo" --add-label "needs-human"
      thread_summary=""
      if [ -n "$pr" ]; then
        owner="${GITHUB_REPOSITORY%%/*}"
        name="${GITHUB_REPOSITORY#*/}"
        threads_json="$(mktemp)"
        if gh api graphql \
          -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved path line comments(first:1){nodes{body author{login}}}}}}}}' \
          -f owner="$owner" -f name="$name" -F number="$pr" \
          > "$threads_json"; then
          thread_summary="$(bash "${VERDICT_SH}" threads "$threads_json")"
        else
          echo "::warning::reviewThreads fetch failed — the findings live in the PR review comments"
        fi
        rm -f "$threads_json"
      fi
      body_file="$(mktemp)"
      {
        echo "🛑 **Auto-rework loop capped** — ${rounds_done} automatic rework rounds without an APPROVE verdict (cap: ${MAX_ROUNDS}). The machine stopped labeling \`agent:rework\`."
        echo ""
        if [ -n "$pr" ]; then
          echo "### Unresolved review threads on PR #${pr}"
          echo ""
          if [ -n "$thread_summary" ]; then
            printf '%s\n' "$thread_summary"
          fi
          echo ""
          echo "_If no threads are listed, the findings live in the PR general comments._"
        else
          echo "_No linked open PR found for this issue._"
        fi
        echo ""
        echo "**Next step (human):** fix the remaining findings directly and re-label \`agent:review\` for a fresh review — or re-label \`agent:rework\` to re-arm the agent loop with a fresh round cap."
      } > "$body_file"
      gh issue comment "$NUMBER" --repo "$repo" --body-file "$body_file"
      rm -f "$body_file"
      echo "→ labeled needs-human — auto-rework capped after ${rounds_done} round(s)"
      exit 0
    fi
    # agent:rework FIRST (ordering is load-bearing: the round-label
    # event must not outrank the rework queue label), then the counter.
    gh issue edit "$NUMBER" --repo "$repo" --remove-label "needs-human" || true
    strip_round_labels
    gh issue edit "$NUMBER" --repo "$repo" --add-label "agent:rework"
    ensure_label "rework-round-${next_round}" "BFD4F2"
    gh issue edit "$NUMBER" --repo "$repo" --add-label "rework-round-${next_round}"
    echo "→ labeled agent:rework (round ${next_round}/${MAX_ROUNDS}) — rework run queued (re-review follows automatically)"
    exit 0
  fi
  if [ "$decision" != "approve" ]; then
    # gh-305: the old `::warning:: … skipping labeling` STRANDED
    # the cycle post-review (no REQUEST_CHANGES → rework, no
    # approval → merge) with nothing but a warning line. Fail
    # LOUDLY and leave a diagnosable marker: ::error:: annotation
    # (red step), needs-human label, per-source diagnosis comment.
    echo "::error::no verdict found in any source (pr_review.json / run output / PR comments / issue comments) — the review cycle cannot be labeled (gh-305)"
    echo "→ diagnosis: ${diagnosis:-none}"
    ensure_label "needs-human" "B60205"
    gh issue edit "$NUMBER" --repo "$repo" --add-label "needs-human"
    body_file="$(mktemp)"
    {
      echo "🛑 **Review verdict missing** — the review leg finished, but no verdict (APPROVE / REQUEST_CHANGES / BLOCK) was found in any source, so the cycle cannot be labeled."
      echo ""
      echo "Per-source diagnosis: \`${diagnosis:-n/a}\`"
      echo ""
      echo "_Next step (human):_ read the review leg's run output, then label \`pr_approved\` (approve) or \`agent:rework\` (changes requested) — or re-run the review leg."
    } > "$body_file"
    gh issue comment "$NUMBER" --repo "$repo" --body-file "$body_file"
    rm -f "$body_file"
    exit 1
  fi
  echo "→ review verdict: approve"
  if [ -z "$pr" ]; then
    echo "::warning::APPROVE verdict but no linked open PR for #${NUMBER} — skipping pr_approved"
    exit 0
  fi
  echo "→ linked PR #${pr} — waiting for green checks (≤10 min)"
  deadline=$((SECONDS + 600))
  while :; do
    states="$(gh pr view "$pr" --repo "$repo" --json statusCheckRollup \
      --jq '.statusCheckRollup[] | if .status and .status != "COMPLETED"
            then "PENDING" else (.conclusion // .state // "PENDING") end' \
      2>/dev/null || true)"
    if [ -n "$states" ]; then
      if echo "$states" | grep -qxE 'FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE'; then
        echo "::warning::PR #${pr} checks FAILED — verdict not trusted, no label (a fresh dev/rework round must fix CI first)"
        exit 0
      fi
      if ! echo "$states" | grep -qvxE 'SUCCESS|SKIPPED|NEUTRAL'; then
        echo "→ PR #${pr} checks green"
        break
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "::warning::PR #${pr} checks still pending after 10 min — skipping pr_approved (re-label or re-run to retry)"
      exit 0
    fi
    sleep 30
  done
  strip_round_labels
  gh issue edit "$NUMBER" --repo "$repo" --remove-label "needs-human" || true
  gh issue edit "$NUMBER" --repo "$repo" --add-label "pr_approved"
  echo "→ labeled pr_approved — merge-trigger will squash-merge PR #${pr} once CLEAN"
