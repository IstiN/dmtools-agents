You are fixing code issues identified in a Pull Request review.

**IMPORTANT**: Before starting, list the `input/` directory to find the ticket subfolder (e.g. `input/PROJ-123/`), then read ALL files from that subfolder in this order:
1. `request.md` — original ticket requirements and acceptance criteria
2. `comments.md` *(if present)* — ticket comment history with additional context or prior decisions
3. `existing_questions.json` *(if present)* — clarification questions with PO answers; treat answered questions as binding requirements
4. `parent_context_ba.md` *(if present)* — **Business Analysis**: acceptance criteria, business rules, and user flows from the parent Epic. Use to understand what must be implemented and verify the rework addresses all ACs.
5. `parent_context_sa.md` *(if present)* — **Solution Architecture**: technical design, API contracts, and architectural decisions from the parent Epic. Follow this design when applying fixes.
6. `parent_context_vd.md` *(if present)* — **Visual Design**: UI mockups, component specs, and design notes from the parent Epic. Align the rework with the expected look and feel.
7. `pr_info.md` — Pull Request metadata (PR number, URL, branch)
8. `pr_diff.txt` — Current code changes already in the PR (what was implemented)
9. `merge_conflicts.md` *(if present)* — **Merge conflicts that MUST be resolved FIRST** before any rework
10. `ci_failures.md` *(if present)* — **CI check failures with error logs that MUST be fixed**
11. `pr_discussions.md` — **ALL open (unresolved) review threads that MUST be fixed** — this file contains ONLY threads that are still open on GitHub. Already-resolved threads are excluded. **Every single thread in this file requires a code fix AND a reply entry in `review_replies.json` — no exceptions.**
12. `pr_discussions_raw.json` — Same threads with numeric IDs — use `rootCommentId` as `inReplyToId` and `id` as `threadId` when writing `outputs/review_replies.json`. **The number of reply entries MUST equal the number of threads in `pr_discussions.md`.**

**If `merge_conflicts.md` is present**: The branch was automatically merged with the base branch before you started. There are unresolved conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in the listed files. **Resolve all conflicts first** — open each conflicting file, fix the markers keeping the correct code, then `git add <file>`. Only after all conflicts are staged should you proceed with review fixes.

**If `ci_failures.md` is present**: CI checks are currently failing on this PR. Read the error logs in that file carefully to identify the root cause, then fix the code. CI failures are **blocking** — they must be resolved along with the review comments. After pushing, CI will re-run automatically.

Your mission is to address every issue raised in `pr_discussions.md`. This file contains ONLY open (unresolved) threads from **human reviewers** — already-resolved threads and bot-generated threads (e.g. test automation results from `github-actions[bot]`) are excluded automatically. If `pr_discussions.md` contains NO review threads (empty or only informational headers), then there is **nothing to fix** — write a short `outputs/response.md` stating "No open review comments to address" and an empty `outputs/review_replies.json` (`{ "replies": [] }`), then exit. **Do NOT post multiple acknowledgment comments.** For each thread:
1. Understand the issue described by the reviewer
2. Locate the relevant code in the codebase
3. Apply the required fix
4. **Search the entire codebase for the same pattern** and fix ALL similar occurrences — not just the exact line the reviewer flagged. For example, if the reviewer flags a missing `accessibilityLabel`, search all similar components for the same omission and fix them too. This prevents the reviewer from raising the same issue again in the next cycle.
5. Write a reply entry in `outputs/review_replies.json` — mention all files you fixed (both the flagged one and the similar ones found by search)

**Every thread in `pr_discussions.md` must have exactly one matching entry in `review_replies.json`. Do not skip any thread.**

After fixing all issues, compile and run all tests to confirm they pass. If tests fail, fix them before finishing.

## BICE Project — Maven Build Commands

This is a Java/Maven project using the Cosmo test framework. **Always use `$JAVA_HOME_COSMO`** when running Maven (Java 17, pre-configured by the dependency setup).

**Verify build compiles cleanly** (run this first after any code change):
```bash
cd dependencies/PostNL-commercial/tests/cosmo && \
  JAVA_HOME=$JAVA_HOME_COSMO mvn install -DskipTests --no-transfer-progress 2>&1 | grep -E 'BUILD|ERROR'
```
Expected: `[INFO] BUILD SUCCESS`. If you see `[ERROR] COMPILATION ERROR`, fix compile errors before proceeding.

**Run unit tests** (replace `<ModuleName>` and `<TestClassName>` with the actual values):
```bash
cd dependencies/PostNL-commercial/tests/cosmo && \
  JAVA_HOME=$JAVA_HOME_COSMO mvn test -pl <ModuleName> -Dtest=<TestClassName> -Denforcer.skip=true \
  --no-transfer-progress 2>&1 | tail -30
```
Example for `cosmo-core`: `-pl cosmo-core`

**Run all unit tests in a module**:
```bash
cd dependencies/PostNL-commercial/tests/cosmo && \
  JAVA_HOME=$JAVA_HOME_COSMO mvn test -pl cosmo-core -Denforcer.skip=true \
  --no-transfer-progress 2>&1 | tail -30
```

**Check E2E test availability** (always check before attempting E2E):
```bash
echo "BICE_E2E_AVAILABLE=$BICE_E2E_AVAILABLE"
```

**Run E2E tests** (only if `BICE_E2E_AVAILABLE=true`):
```bash
cd dependencies/PostNL-commercial/tests/cosmo && \
  JAVA_HOME=$JAVA_HOME_COSMO mvn verify -f cosmo-commercie/pom.xml \
  -Dcucumber.filter.tags="@TICKET-KEY" -Dtags="@TICKET-KEY" \
  -DPOSTNL_UI_HEADLESS=true --no-transfer-progress 2>&1 | tail -50
```

**⚠️ E2E Guice failure diagnosis**: If E2E fails with `Guice Injector creation previously failed` or `Runtime Configuration failed` AND `BICE_E2E_AVAILABLE=true`, this is **NOT** a credentials/secrets issue. Investigate the actual Guice configuration error — it is a real infrastructure or config problem that needs to be diagnosed and reported clearly in `outputs/response.md`.

**⚠️ CRITICAL: All output files MUST be written to `outputs/` at the repository root** (e.g. `/home/runner/work/repo/repo/outputs/`).
Do NOT write them inside `input/`, `input/TICKET-KEY/`, or any subfolder of `input/`. The post-processing script reads from `outputs/` at the repo root — writing elsewhere means all results will be silently lost.

Run `mkdir -p outputs` first to ensure the directory exists.

Write two output files:

**`outputs/review_replies.json`** — **PRIMARY OUTPUT**: a reply for each review thread, posted inline inside the discussion. This is the main way the developer sees what was fixed. Be specific per thread — what exactly changed, which file/line, and why:
```json
{
  "replies": [
    {
      "inReplyToId": <rootCommentId from pr_discussions_raw.json>,
      "threadId": "<id from pr_discussions_raw.json>",
      "reply": "Fixed: <concise but complete description — what changed, in which file, and why>"
    }
  ]
}
```

**`outputs/response.md`** — **SHORT** general PR comment (5-10 lines max). Do NOT repeat what is already in the thread replies. Include only:
- One line confirming all review comments were addressed (or listing any that could NOT be fixed)
- Test status: pass/fail and number of tests
- Any cross-cutting concern worth calling out once (e.g. lint status)

DO NOT create branches, commit, or push — git operations are handled automatically.
