```mermaid
flowchart TD
    START([Test automation PR ready for review]) --> PROJ["Read instruction.md from repo root if it exists"]
    PROJ --> INPUT["Read PR context from input folder"]
    INPUT --> INPUTS["ticket.md, review_policy.md, pr_info.md, pr_diff.txt, pr_files.txt, ci_failures.md, ci_failures_full.log, pr_discussions.md, pr_discussions_raw.json"]
    INPUTS --> EXPLORE["Explore codebase structure in testing/ folder"]
    EXPLORE --> SCOPE["Confirm scope: review test code only inside testing/"]
    SCOPE --> CORRECT["Compare test steps against Test Case: objective, preconditions, steps, expected result"]
    CORRECT --> ARCH["Verify architecture compliance: tests → components → frameworks → core"]
    ARCH --> OOP["Verify OOP principles: single responsibility, dependency injection, interfaces from core/interfaces/"]
    OOP --> QUALITY["Check code quality: no hardcoded secrets, proper setup/teardown, no duplicated logic"]
    QUALITY --> MODERN["Check modern framework usage: explicit waits, typed service objects"]
    MODERN --> DATA["Check test data self-sufficiency: generate → download → approve blocked_by_human only when genuinely required"]
    DATA --> RESULT{Test result in PR description}
    RESULT -->|PASSED| PASSED_REVIEW["Verify the PASSED result is meaningful — not a false positive"]
    RESULT -->|FAILED| FAILED_REVIEW["Verify the test fails for the right reason — not a test code issue"]
    PASSED_REVIEW --> OUTPUT[Write outputs per the base contract + this leg's tracker summary]
    FAILED_REVIEW --> OUTPUT
    OUTPUT --> END([End])
```

## Outputs (this leg's specifics on top of the base contract)

The reviewer-agnostic output contract (`outputs/pr_review.json`,
`outputs/pr_review_general.md`, `outputs/pr_review_comments/*.md`, inline
anchoring) lives in `instructions/pr_review/base/` and is assembled around
this lens. This leg adds its own tracker-facing summary:

- **Write `outputs/response.md`** — concise tracker-agnostic Markdown
  summary, under 20 lines, bullet-focused. Required sections: Summary,
  Correctness, Architecture, Code Quality, Framework Usage, Test Data,
  Recommendation.
- Tracker-specific formatting is injected via `cliPromptsByTracker` — do
  NOT hardcode Jira/ADO markup in `response.md`.
- If `pr_discussions.md` is present → include `resolvedThreadIds` in
  `outputs/pr_review.json`.
