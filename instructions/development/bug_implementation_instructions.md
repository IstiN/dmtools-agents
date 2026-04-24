# Bug Fix Additional Instructions

These instructions extend `implementation_instructions.md` for bug tickets specifically.

## ⚠️ STEP 0 — Read EVERYTHING in the Ticket Context Before Anything Else

The Teammate job has already prepared the full ticket context in the `input/<TICKET-KEY>/` folder. **Read every file** before you start thinking about a fix:

1. **`request.md`** — ticket summary, description, acceptance criteria, and the **Root Cause Analysis (RCA)** section written by the `bug_rca` job. The RCA is the authoritative diagnosis — do not re-do it from scratch unless it is clearly wrong.
2. **`comments.md`** — every Jira comment on the ticket, oldest first. Read carefully for:
   - Prior AI-agent attempts (look for "Implementation Completed", "Development Interrupted", "No Code Changes Needed", PR links)
   - QA / reviewer feedback after failed previous fixes ("still reproducing on iOS", "not fixed in build X")
   - Human notes clarifying the bug, edge cases, or reproduction steps
3. **`existing_questions.json`** — questions previously asked and their answers.
4. **`linked_tests.md`** — linked test cases, if any.

## ⚠️ STEP 0.1 — Bug Returned to Development = Previous Fix Did NOT Work

If `comments.md` shows that **this ticket has been through development before** (e.g. a prior PR was merged for it, or a previous "Implementation Completed" comment exists, and the ticket has since been moved back to *Ready For Development* or *In Development*), treat it as a **regression / incomplete fix**. This is mandatory:

1. **Identify the previous PR(s)** — find the PR link(s) in comments. Read the previous PR's diff via `gh pr view <number> --repo <owner>/<repo>` and `gh pr diff <number> --repo <owner>/<repo>`.
2. **Understand what was attempted and why it did not work** — compare previous fix against the RCA and the latest QA feedback in comments. Ask yourself: *did the previous fix address a symptom instead of the root cause? did it miss a platform (iOS vs Android)? did it handle the happy path only?*
3. **DO NOT repeat the same approach** — if the previous fix modified file X to add a null check, and the bug is still happening, the null check is not the root cause. Dig deeper.
4. **DO NOT assume "it was fixed in #NNN"** — the whole reason the ticket is back is that #NNN did not actually fix the problem (or fixed it incompletely). Never write `outputs/already_fixed.json` for a returned bug.
5. Document in `outputs/rca.md` what the previous attempt missed and why your new approach is different.

## ⚠️ STEP 0.2 — Verify the Bug Actually Reproduces NOW

Before claiming "already fixed" on any bug (returned or not):

1. Check out the target branch (`develop`/`main`) at HEAD, not an old commit.
2. Locate the code path from the RCA and **read the current code** — not the code as the RCA described it, which may be stale.
3. Write a unit test that exercises the exact failure scenario from the ticket. Run it.
   - If the test **FAILS** → the bug is real, proceed to fix.
   - If the test **PASSES** against current code → the bug may genuinely be fixed. Before writing `already_fixed.json`:
     - Re-read the latest comments — has QA confirmed the fix, or are they still reporting it broken?
     - Check the platform / build / environment the reporter mentioned — maybe it's only broken on one platform.
     - Only after all of the above, if you are still confident, write `already_fixed.json`.

## Step 1 — Root Cause Analysis (RCA)

If the ticket has no RCA section or the RCA is clearly wrong:
1. Read the bug report carefully — steps to reproduce, expected vs actual behaviour
2. Search the codebase to find where the fault originates (not just where the symptom appears)
3. Identify the exact root cause: wrong condition, missing null check, race condition, wrong type, etc.
4. Write the RCA to `outputs/rca.md`:
   ```markdown
   ## Root Cause Analysis
   **Bug**: [one-sentence description]
   **Root cause**: [exact technical reason — file, function, line if possible]
   **Impact**: [what is broken and under what conditions]
   **Fix approach**: [what needs to change and why]
   **Previous attempt (if ticket returned)**: [PR #, what it changed, why it was insufficient]
   ```

## Step 2 — Check if the Bug is Already Fixed

**Skip this step if the ticket has returned to development** (see Step 0.1 — returned bugs are by definition not fixed).

Otherwise, after RCA, check recent commits and the current codebase:
- Run `git log --oneline -20` to see recent commits
- Check if the code path identified in RCA already has the correct logic
- Run the reproduction test from Step 0.2 — it must FAIL before you can claim the bug exists
- If the reproduction test PASSES on current code AND no QA comment disputes this:
  - Write `outputs/already_fixed.json`:
    ```json
    {
      "commit": "abc1234",
      "rca": "Brief root cause summary",
      "description": "Fixed in commit abc1234 as part of [ticket/description]. Verified by reproduction test [path] which now passes.",
      "verification_test": "path/to/test.tsx::test name"
    }
    ```
  - Write a summary to `outputs/response.md`
  - **STOP — do not make any code changes**

## Step 3 — Check if the Bug Can Be Fixed

If you identify that fixing requires:
- External credentials, API keys, or secrets you don't have access to
- Human decisions or product decisions that are ambiguous
- Infrastructure changes outside the codebase
- Multiple previous attempts have failed (detected from git history or comments) AND the RCA still cannot pinpoint the root cause

Then write `outputs/blocked.json`:
```json
{
  "reason": "Specific reason why the fix cannot be completed",
  "tried": ["What was attempted 1", "What was attempted 2"],
  "needs": "What specifically is needed from a human to unblock this"
}
```
Write a summary to `outputs/response.md` explaining the blocker clearly.
**STOP — do not make incomplete changes.**

## Step 4 — Reproduce the Bug with a Unit Test First

**Only after confirming the bug is NOT already fixed and NOT blocked:**

1. Write a unit test that **reproduces the bug** — it must FAIL before the fix
2. Run the test to confirm it fails (this proves the bug exists and the test is correct)
3. Only then proceed to fix the code

This TDD approach ensures:
- The fix is verified automatically
- The test becomes a regression guard
- The PR reviewer can see exactly what was broken

## Step 5 — Minimal, Targeted Fix

- Change **only what is necessary** to fix the root cause identified in RCA
- Do not refactor unrelated code
- Do not add unrequested features
- Preserve existing behaviour everywhere except the bug
- **If this is a returned bug**: your fix must be meaningfully different from the previous attempt (see Step 0.1)

## Step 6 — Verify

1. Run the reproduction test — it must now PASS
2. Run the full test suite — no regressions
3. If any existing tests break, investigate: either the test was wrong or the fix is too broad

## Step 7 — Check Git Status for Secrets

Before finishing, run `git status` to review every new and modified file. Check for any sensitive files that must NOT be committed:
- Credential / service-account files (`gha-creds-*.json`, `*-credentials.json`, `*.pem`, `*.key`, `id_rsa`, `keystore.*`)
- Environment files (`.env`, `.env.*`, `*.env`)
- Token files (`*.token`, `*.secret`)
- Any file created by tools, test runners, or the OS that is not part of the codebase

For each such file found: **add the appropriate pattern to `.gitignore`** before finishing. The post-processing step runs `git add .` — every untracked file in the working tree will be staged and committed.

## Output — `outputs/response.md`

For a normal fix, write:
```markdown
## Bug Fix Summary

### Root Cause
[Copy from rca.md — 2-3 sentences]

### Previous Attempt (only if ticket returned to development)
[PR # and what it changed, why it did not fully fix the bug]

### Fix
[What was changed, in which files, and why — and how it differs from the previous attempt if applicable]

### Test Coverage
- Reproduction test added: `[test file path]` — `[test name]`
- Full test suite: PASSED / N failures (describe if any)

### Notes
[Any important warnings or assumptions for the reviewer]
```
