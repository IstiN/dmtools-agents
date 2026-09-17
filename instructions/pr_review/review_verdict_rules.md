# Review verdict rules — machine protocol (binding)

The review↔rework loop is a machine, not a conversation: your
`recommendation` in `outputs/pr_review.json` is parsed mechanically and
drives issue labels, rework runs and CI (each wasted round costs 15–20 CI
minutes — gh-71). These rules govern the verdict; every other instruction
(severity definitions, output files, thread etiquette) is unchanged.

## Verdict mapping

Classify findings exactly as instructed:

- 🚨 **BLOCKING** — correctness/bug findings: broken behavior, failing
  gates (red CI), scope violations, security issues, data loss.
- ⚠️ **IMPORTANT** — real maintainability debt worth fixing, but the PR
  works as shipped.
- 💡 **SUGGESTION** — style, wording, import order, dartdoc refs, polish.

Then map to the verdict:

| Findings | `recommendation` |
|---|---|
| Any 🚨 BLOCKING (correctness/bug) | `REQUEST_CHANGES` — or `BLOCK` for security / data loss |
| No 🚨 BLOCKING — only ⚠️ / 💡 remain | `APPROVE` |

`APPROVE` with remaining ⚠️/💡 findings is the expected terminal state
(`allowApproveWithSuggestions: true`): post every remaining finding as
before (inline threads + general comment) — they do **not** block the merge
and must **not** trigger another rework round.

## Anti-patterns (observed live, gh-71)

- ❌ Returning `REQUEST_CHANGES` because a re-review surfaced new
  suggestion-level nits (docs wording, import style, dartdoc refs). A cycle
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
- ❌ Re-opening a thread that the rework demonstrably fixed in this diff —
  add its id to `resolvedThreadIds` instead.
