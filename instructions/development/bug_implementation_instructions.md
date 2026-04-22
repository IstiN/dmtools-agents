# Bug Fix Additional Instructions

These instructions extend `implementation_instructions.md` for bug tickets specifically.

## ⚠️ MANDATORY: Do RCA Before Touching Any Code

**Step 1 — Root Cause Analysis (RCA)**

Before writing or changing a single line of code:
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
   ```

**Step 2 — Check if the Bug is Already Fixed**

After RCA, check recent commits and the current codebase:
- Run `git log --oneline -20` to see recent commits
- Check if the code path identified in RCA already has the correct logic
- If the bug **is already fixed** in a prior commit:
  - Write `outputs/already_fixed.json`:
    ```json
    {
      "commit": "abc1234",
      "rca": "Brief root cause summary",
      "description": "Fixed in commit abc1234 as part of [ticket/description]. No code changes needed."
    }
    ```
  - Write a summary to `outputs/response.md`
  - **STOP — do not make any code changes**

**Step 3 — Check if the Bug Can Be Fixed**

If you identify that fixing requires:
- External credentials, API keys, or secrets you don't have access to
- Human decisions or product decisions that are ambiguous
- Infrastructure changes outside the codebase
- Multiple previous attempts have failed (detected from git history or comments)

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

### Fix
[What was changed, in which files, and why]

### Test Coverage
- Reproduction test added: `[test file path]` — `[test name]`
- Full test suite: PASSED / N failures (describe if any)

### Notes
[Any important warnings or assumptions for the reviewer]
```
