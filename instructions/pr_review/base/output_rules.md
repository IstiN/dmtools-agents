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
