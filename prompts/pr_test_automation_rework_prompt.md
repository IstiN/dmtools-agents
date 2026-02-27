User request is in the 'input' folder. Read all files there.

**IMPORTANT**: Read in order:
1. `ticket.md` — the Test Case ticket (objective, steps, expected result)
2. `pr_info.md` — PR metadata
3. `pr_diff.txt` — current test code
4. `pr_discussions.md` — review comments that must be addressed
5. `pr_discussions_raw.json` — structured thread data with IDs for replies

The feature code is **already in main branch**. Your job is to:
1. Fix all issues raised in the PR review comments (address every thread)
2. Re-run the test and capture the new result
3. Write output files

**You may ONLY write code inside the `testing/` folder.**

## Output files

- `outputs/response.md` — rework summary in **Jira Markdown** (short, factual): what was fixed + new test result
- `outputs/pr_body.md` — same in **GitHub Markdown**
- `outputs/test_automation_result.json` — new test result (see instructions for format)
- `outputs/review_replies.json` — replies per thread: `{ "replies": [{ "inReplyToId": 123, "threadId": "PRRT_...", "reply": "Fixed: ..." }] }`
- `outputs/bug_description.md` — updated bug description in Jira Markdown (only if test still FAILED)
