User request is in 'input' folder, read all files there and do what is requested.

**IMPORTANT** Before anything else, read inputs in this order:
1. `instruction.md` (repo root) — **read this first**: project stack, deployment constraints, approved frameworks, and infrastructure access. All implementation decisions must respect the constraints defined here.
2. `request.md` — full bug ticket: description, steps to reproduce, expected vs actual behaviour, environment, any linked commits
3. `comments.md` *(if present)* — ticket comment history with additional context, prior analysis, or linked PR information
4. `linked_tests.md` *(if present)* — **CRITICAL**: linked test cases that are failing and triggered this bug report.
   - Read the **test steps and assertions** carefully — your fix must satisfy exactly what the test checks.
   - Read the **test run comments** to understand prior fix attempts and why they didn't work.
   - If a previous comment says "Bug Already Fixed" but the test is still failing, the fix was **incomplete or the test has timing/async requirements** that the code doesn't yet satisfy.
   - Before writing `already_fixed.json`, verify the linked test actually passes with the current code.
5. `existing_questions.json` — if present, clarification answers from the PO — treat as binding requirements

## ⚠️ CRITICAL: Understand the bug BEFORE looking at code

**Always start by deeply understanding what the user actually experiences**, not what the code looks like.

### Step 0: Reproduce or simulate the bug FIRST

Before reading any source code, do ALL of the following:

1. **Read the Steps to Reproduce carefully** — what does the user click/navigate/do? What is the actual symptom vs expected?
2. **Try to reproduce it**: run the app, open the URL, execute the failing test, or simulate the user action in any way possible.
3. **If a linked test case exists in `request.md`** — run it first. A failing automated test is the fastest way to confirm the root cause. Study what the test actually asserts — it may pinpoint the real problem layer (routing, config, data, UI).
4. **The real root cause may be in routing, configuration, infrastructure, or data** — not in the component named in the ticket title. Follow the symptom, not the title.

**Only if you cannot reproduce the bug** (no browser, no live server, no runnable test) — then fall back to static code analysis. Document in `outputs/rca.md` that reproduction was not possible and why.

## Your workflow (MUST follow in order)

### 1. Root Cause Analysis — write `outputs/rca.md` FIRST

Find the actual root cause in the code before touching anything. See `bug_implementation_instructions.md` for the required format.

> ⚠️ **Write `outputs/rca.md` as soon as you form your first hypothesis** — even if incomplete. Update it as you learn more. This ensures your analysis is preserved if the session is interrupted (e.g. rate limit). An incomplete RCA file is better than no file at all.

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

> ⚠️ **Before writing already_fixed.json — stop and think:**
> This ticket was created (or re-opened) by a human or an automated system **after** that commit existed.
> Ask yourself: *why would someone report a bug that is already fixed?*
>
> Likely answers:
> - The fix is in the code but **not yet deployed** — the bug is still visible in production
> - The fix addressed a **different root cause** — this is a new manifestation of the same symptom
> - The "fix" was incomplete — it works in some cases but **not the one described in this ticket**
> - The ticket was created from a **failed test run** that ran against the unfixed version
>
> **If `linked_tests.md` is present**: run the linked test(s) FIRST. Only write `already_fixed.json` if the test actually passes. A fix that's in git but doesn't pass the automated test is **not done**.
>
> Only write `already_fixed.json` if you are **certain** the exact scenario in this ticket is fully resolved AND the fix was deployed before the ticket was created. When in doubt — fix it.

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
