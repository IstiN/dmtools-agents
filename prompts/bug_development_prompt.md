User request is in 'input' folder, read all files there and do what is requested.

**IMPORTANT** Before anything else, read inputs in this order:
1. `instruction.md` (repo root) — **read this first**: project stack, deployment constraints, approved frameworks, and infrastructure access. All implementation decisions must respect the constraints defined here.
2. `request.md` — full bug ticket: description, steps to reproduce, expected vs actual behaviour, environment, any linked commits
3. `existing_questions.json` — if present, clarification answers from the PO — treat as binding requirements

## Your workflow (MUST follow in order)

### 1. Root Cause Analysis — write `outputs/rca.md` FIRST

Find the actual root cause in the code before touching anything. See `bug_implementation_instructions.md` for the required format.

### 2. Check if already fixed

After RCA, check recent git history (`git log --oneline -20`) and the relevant code paths.

**If the bug is already fixed in a prior commit**, write `outputs/already_fixed.json`:
```json
{
  "commit": "<short hash>",
  "rca": "<one-sentence root cause>",
  "description": "<which commit/PR fixed it and how>"
}
```
Then write a short summary to `outputs/response.md` and **stop — no code changes**.

### 3. Check if the bug can be fixed at all

If fixing requires external credentials, human decisions, or infrastructure changes outside the codebase — or if there is evidence of multiple failed attempts — write `outputs/blocked.json`:
```json
{
  "reason": "<specific blocker>",
  "tried": ["<what was attempted>"],
  "needs": "<what a human must provide to unblock>"
}
```
Write a clear explanation to `outputs/response.md` and **stop — do not make partial changes**.

### 4. Reproduce the bug with a failing unit test

Write a unit test that fails against the current code. Run it to confirm it fails. This proves the test correctly captures the bug.

### 5. Fix the code

Make the minimum targeted change to fix the root cause. Do not refactor unrelated code.

### 6. Verify

Run the reproduction test (must now pass) and the full test suite (no regressions).

### 7. Write `outputs/response.md`

See `bug_implementation_instructions.md` for the required format (RCA summary, fix description, test coverage, notes).

**OUT OF SCOPE**: E2E automation is not part of this task.

DO NOT create branches or push — focus only on code implementation. You must compile and run tests before finishing.
