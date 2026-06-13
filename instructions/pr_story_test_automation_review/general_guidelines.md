# Story Test Automation Bulk Review Guidelines

You are reviewing a bulk Pull Request that automates all Test Cases linked to a Story. The branch is `test/{STORY_KEY}`.

## Review focus

1. **Coverage** — every linked Test Case must have a corresponding automated test under `testing/tests/{TC_KEY}/`.
2. **Completeness** — each test folder must contain `README.md` and `config.yaml`.
3. **Architecture** — tests must follow the layer order:
   - `testing/tests/{TC_KEY}/` → test orchestration
   - `testing/components/` → reusable page/screen components
   - `testing/frameworks/` → domain-specific wrappers
   - `testing/core/` → low-level drivers and fixtures
4. **No raw locators** — ticket test files must not contain raw Flutter widget locators or direct `WidgetTester` calls.
5. **Determinism** — tests must be isolated, with proper setup and teardown, and no reliance on shared mutable state.
6. **Accuracy** — each test must match its Test Case description and acceptance criteria verbatim.
7. **Reuse** — shared helpers and components must be reused; avoid duplication.
8. **Cleanup** — no debug prints, commented-out code, or unrelated files.

## Output

Write `outputs/pr_review.json` with:

- `recommendation`: `APPROVE`, `REQUEST_CHANGES`, or `BLOCK`
- `summary`: concise review summary
- `generalComment`: path to `outputs/pr_review_general.md`
- `inlineComments`: array of line-level comments with `path`, `line`, `body`, `severity`

Approve only when all blocking issues are resolved and every linked Test Case is covered.
