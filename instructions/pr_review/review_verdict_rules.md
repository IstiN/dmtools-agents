# Review verdict rules — machine protocol (binding)

The review↔rework loop is a machine, not a conversation: your
`recommendation` in `outputs/pr_review.json` is parsed mechanically and
drives issue labels, rework runs and CI (each wasted round costs 15–20 CI
minutes). These rules govern the verdict; every other instruction
(severity definitions, output files, thread etiquette) is unchanged.

## Verdict mapping

Classify findings into 4 tiers:

- 🚨 **BLOCKING** — correctness/bug findings: broken behavior, failing
  gates (red CI), scope violations, security issues, data loss.
- ⚠️ **IMPORTANT** — real maintainability debt worth fixing, but the PR
  works as shipped.
- 💡 **SUGGESTION** — clarity of the documented/behavioral surface:
  missing docs, unclear contract, better API shape.
- 🪶 **NIT** — changes nothing behavioral and nothing documented: style,
  formatting, naming micro-preferences.

Then map to the verdict (the machine recomputes it from the census —
`postPRReviewComments` treats your token as advisory):

| Findings | `recommendation` |
|---|---|
| Any 🚨 BLOCKING | `REQUEST_CHANGES` — or `BLOCK` for security / data loss |
| Any ⚠️ IMPORTANT (no 🚨) | `REQUEST_CHANGES` (gates approval — policy default) |
| Only 💡 / 🪶 remain | `APPROVE` — the cycle converges |

**Downgrade protocol:** when the rework lap downgraded a specific ⚠️ to 💡 **with a
written justification in the census** (the thread reply states why the finding is not
maintainability debt), classify that finding 💡 in this round's census — the false-⚠️ review
converges to APPROVE without a code change. Without the written justification, keep ⚠️: a silent
downgrade does not exist, and the machine recomputes the verdict from the census you post.

`APPROVE` with remaining 💡/🪶 findings is the expected terminal state
(the resolved policy's `allowApproveWithSuggestions` derives from the
tier table — SUGGESTION rounds polish, NIT rounds none): post every
remaining finding as before (inline threads + general comment) — they do
**not** block the merge and must **not** trigger another rework round.
An open ⚠️ **does** gate approval unless the project's `reviewPolicy`
explicitly weakens it (owner standing-approval doctrine, epic §4.4).

## Anti-patterns

- ❌ Returning `REQUEST_CHANGES` because a re-review surfaced new
  suggestion-level nits (docs wording, import style, doc-comment refs). A cycle
  with only suggestion-level findings **must** converge to `APPROVE`.
- ❌ `REQUEST_CHANGES` while `issueCounts.blocking` is `0` — the machine
  treats that as an approval and skips the rework round. Keep
  `issueCounts` accurate: it is the machine's source of truth, not prose.
  The machine also cross-checks the counter against your inline comments
  (a `severity: "BLOCKING"` entry or a 🚨 marker in the referenced comment
  file) before honoring a blocking-0 approval — if any finding is truly
  blocking, set `recommendation: REQUEST_CHANGES` with `blocking: 1`+.
- ❌ Verdict-by-prose: never phrase the verdict only in the summary text.
  The `recommendation` field of `outputs/pr_review.json` is the verdict.
- ❌ 🚨 BLOCKING driven by an uncited external-spec claim ("the spec says X"
  without a `file:line` / doc URL the leg actually read).
  Downgrade it to a ⚠️ question; the machine treats BLOCKING threads as
  ground truth and arms rework on them. (Note: the post-action also
  downgrades such findings mechanically — keep the JSON consistent with
  the demoted severity so the census cross-check stays clean.)
- ❌ Re-opening a thread that the rework demonstrably fixed in this diff —
  add its id to `resolvedThreadIds` instead.

## Label guard rails — the chore:pin lane

`chore:pin` is a trusted, **non-exclusive** factory fast-lane: several PRs
may carry it at the same time (a release bump `chore/release-vX.Y.Z` AND a
factory pin `chore/factory-pin-*` are both legitimate holders — they ride
the lane independently). Reviews must therefore:

- ❌ **NEVER remove `chore:pin` from any PR** — not as a "one pin" dedup,
  not as a side-effect of closing a related PR as superseded. Removing it
  from a release bump or pin PR strands that PR behind the standard queue.
- ✅ When a PR is superseded (e.g. a workflow change already shipped via
  another PR), close **only that PR** and leave every label on every other
  PR untouched. Label restoration is a keeper action, not yours.
- ✅ If you believe two `chore:pin` holders conflict, SAY SO in the review
  comment and keep both labels — the owner resolves the lane, the machine
  only merges.
