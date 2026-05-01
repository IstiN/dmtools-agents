User request is in the 'input' folder. Read all files there.

**IMPORTANT**: Before writing any test, read and follow these inputs in order:
1. `request.md` — the Test Case ticket: objective, preconditions, steps, expected result, and priority.
2. `comments.md` *(if present)* — ticket comment history; recent comments may contain prior test run results, failure analysis, or reviewer feedback.
3. `linked_bugs.md` *(if present)* — **CRITICAL**: linked bugs that block or are related to this test case.
   - Read the **Solution** field and **AI Fix Comments** for each bug carefully.
   - If the fix introduced **timing or async behavior** (e.g., a heartbeat probe with a delay, a polling interval, a retry timeout) — your test **MUST** wait long enough to observe the effect. Do NOT assert immediately after triggering the action.
   - Example: if a bug was fixed by adding a heartbeat probe that runs every 5 seconds, your test must wait at least 5–10 seconds after blocking auth domains before asserting the error appears.
   - If the bug status is `Done` or `In Testing`, the fix is deployed — **run the test against the live implementation** and expect it to pass.
4. Any other files present in the input folder for additional context.

The feature code is **already implemented** in the `main` branch and **deployed**. Your job is to automate this test case — not to implement features.

## Your task

1. Analyze the Test Case: understand what needs to be verified, what type it is (web, mobile, API), and which framework fits best.
2. Check `testing/` for existing components (pages, screens, services) and core utilities you can reuse.
3. **Check if test already exists** in `testing/tests/{TICKET-KEY}/`. If it does, reuse and update it rather than rewriting from scratch. Only modify what is necessary.
4. Write the automated test in `testing/tests/{TICKET-KEY}/` following the architecture rules in `agents/instructions/test_automation/test_automation_architecture.md`.
5. **Run the test** and capture the result.
6. Perform a real human-style verification of the scenario from the user's perspective.
7. Write output files.

**You may ONLY write code inside the `testing/` folder.**

## Output files

**⚠️ CRITICAL: All output files MUST be written to `outputs/` at the repository root** (e.g. `/home/runner/work/repo/repo/outputs/`).
Do NOT write them inside `input/`, `input/TICKET-KEY/`, or any subfolder of `input/`. The post-processing script reads from `outputs/` at the repo root — writing elsewhere means all results will be silently lost.

Run `mkdir -p outputs` first to ensure the directory exists.

- `outputs/jira_comment.md` — Jira wiki markup test result summary
- `outputs/pr_body.md` — GitHub Markdown PR body
- `outputs/response.md` — backward-compatible Markdown summary
- `outputs/test_automation_result.json` — **MANDATORY — always write this file**, even if the test failed or errored. Use exactly this format:
  ```json
  { "status": "passed", "passed": 1, "failed": 0, "skipped": 0, "summary": "1 passed, 0 failed" }
  ```
  or for failure:
  ```json
  { "status": "failed", "passed": 0, "failed": 1, "skipped": 0, "summary": "0 passed, 1 failed", "error": "AssertionError: <exact error message>" }
  ```
  The `"status"` field **must** be exactly `"passed"` or `"failed"` (lowercase). Missing or wrong field name causes the pipeline to break.
- `outputs/bug_description.md` — detailed tracker-formatted bug report (only if test FAILED)

`jira_comment.md` and `pr_body.md` contain the same facts but are formatted for different consumers: Jira wiki markup vs GitHub Markdown. Do not put GitHub Markdown into `jira_comment.md`.

## Real human-style verification

In addition to automated assertions, verify the behavior as a user would experience it.

For UI and content-heavy cases, this is especially important:
- Check visible text, labels, headings, descriptions, validation messages, placeholders, button text, empty states, and error messages.
- Verify the text is shown in the correct place and state, not merely present somewhere in HTML/source/API output.
- Prefer user-facing selectors and observations (role, label, visible text, screenshots/logs) over implementation details.
- If the test case is about content correctness, compare the meaningful text precisely enough to catch wording regressions.

For API/background cases:
- Verify the observable outcome that a user, UI, or integrated client depends on.
- Do not mark the test passed only because an internal call returned success if the expected user-facing result was not confirmed.

Document this verification in `outputs/jira_comment.md` and `outputs/pr_body.md`:
- what was checked by automation;
- what was checked as a real user/human-style scenario;
- what was observed;
- whether it matched the expected result.

## ⚠️ CRITICAL: When the test FAILS — write a detailed bug report

If the test fails, `outputs/bug_description.md` **must** contain enough detail for a developer to reproduce and fix the bug without running the test themselves. Generic descriptions like "the test failed" or "element not found" are NOT acceptable.

**Required in `bug_description.md`:**

1. **Exact steps to reproduce** — copy the test steps from `request.md` and annotate each one with what actually happened:
   - Which step passed ✅
   - Which step failed ❌ and with what error/behaviour
   - What was on screen / in the response at the point of failure

2. **Exact error message or assertion failure** — paste the full stack trace or assertion output from the test runner, not a summary.

3. **Actual vs Expected** — be specific:
   - ❌ Bad: "the page did not load"
   - ✅ Good: "navigating to `/v/0097a85a-a616-4708-9dbd-8c2d81d47c38/` returned HTTP 404 and rendered the home page layout instead of the video watch page"

4. **Environment details** — URL, browser, OS, any relevant config values used during the run.

5. **Screenshots or logs** — if Playwright, attach screenshot path; paste relevant log lines.

The same level of detail applies to `outputs/jira_comment.md` — the Jira comment must clearly state **which step failed and why**, not just "FAILED".

Do NOT create branches or push. Do NOT modify any code outside `testing/`.
