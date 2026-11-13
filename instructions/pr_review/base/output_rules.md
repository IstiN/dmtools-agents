# PR Review Output Rules — the machine contract (base, gh-1406)

Reviewer-agnostic: every reviewer leg writes the same structured review
artifacts; the machine parses them (gh-1350/1351). The lens may add
reviewer-specific files but never changes this contract.

```mermaid
flowchart TD
    O1["Write outputs/pr_review.json — structured data for the PR review"]
    O2["Write outputs/pr_review_general.md — brief general PR comment (1-2 paragraphs max)"]
    O3["Write outputs/pr_review_comments/*.md — detailed inline comment files"]
    O4["Always reference inline comment files via the 'comment' field — do NOT use inline 'body'"]
    O5["Inline comments MUST use a line number that exists in the PR diff"]
    O6["If a finding is on unchanged code outside the diff, put it in outputs/pr_review_general.md instead"]
    O1 --> O2 --> O3 --> O4 --> O5 --> O6
```

## The contract

- `outputs/pr_review.json` — valid JSON with `recommendation`
  (APPROVE | REQUEST_CHANGES | BLOCK), `summary`, `generalComment`,
  `inlineComments`, `issueCounts`.
- `outputs/pr_review_general.md` — the general PR comment body; max 1-2
  paragraphs, factual, no essays.
- `outputs/pr_review_comments/<name>.md` — one file per detailed inline
  comment; the `comment` field carries the file PATH, never the text itself.
- Each inline comment: `path`, `line`, `startLine`, `side`, `comment`,
  `severity` (BLOCKING | IMPORTANT | SUGGESTION | NIT).
- Inline comments MUST target a line that appears in the PR diff (use line
  numbers from the right-hand side of diff hunks; if `pr_diff.txt` is
  truncated, run `git diff origin/{baseBranch}...HEAD` to locate the exact
  line). A finding on unchanged code outside the diff goes to
  `pr_review_general.md` — never an inline thread.
- If `ci_failures.md` is present → include each failure as 🚨 BLOCKING
  (full logs in `ci_failures_full.log`).
- Keep `summary` under 2 sentences — details live in the inline comment
  files, not the general text.
- Ticket context: verify the PR changes satisfy the ticket ACs — note gaps
  in the review.
- The verdict is a MACHINE decision recomputed from `issueCounts` + the
  resolved `reviewPolicy` — the census is the machine's source of truth;
  keep it accurate.

## The candidates-only contract (specialist legs, gh-1471)

A SPECIALIST leg (input/TICKET/reviewer_leg.md present — see
input_context.md) writes ONE file and nothing else:

`outputs/pr_review_candidates.json`

```json
{
  "reviewer": "<the reviewer name from reviewer_leg.md>",
  "candidates": [
    {"id": 1, "path": "src/auth/UserService.js", "line": 45,
     "severity": "BLOCKING", "claim": "one-paragraph statement of the finding"},
    {"id": 2, "path": "docs/arch.md", "line": null,
     "severity": "SUGGESTION", "claim": "a digest candidate — no diff line"}
  ]
}
```

- `claim` is the finding's substance: what is wrong, where the evidence
  is, why it matters. No severity header line, no verdict language — the
  tier rides the `severity` field (BLOCKING | IMPORTANT | SUGGESTION |
  NIT) and the machine classifies the posted thread from it.
- `id` numbers the candidates within the file (1..n). `path` is
  repo-relative; `line` is the diff line (right-hand side) or `null` for a
  digest candidate — findings anchored outside the diff are allowed as
  digest candidates, never as invented line numbers.
- Write NOTHING else: no `outputs/pr_review.json`, no
  `pr_review_general.md`, no `pr_review_comments/*`, no `response.md`. Do
  not post, label, resolve threads, or change statuses — the post action
  does all machine bookkeeping (candidates marker + completion marker).
- Severity discipline still applies: raise only what the lens hunt
  justifies; an empty candidates list is a valid answer (the leg completes
  with zero findings).
- The candidates pass the gh-1403 filter like every other finding (fresh
  verification, weighted retention for high-weight reviewers) and the
  posting leg merges them into ONE review — a specialist never posts a
  second review.
