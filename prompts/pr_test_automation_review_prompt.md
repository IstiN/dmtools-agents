User request is in the 'input' folder. Read all files there.

**IMPORTANT**: Read in order:
1. `ticket.md` — the Test Case ticket (objective, steps, expected result)
2. `pr_info.md` — PR metadata and current test result (PASSED or FAILED)
3. `pr_diff.txt` — all code changes in this PR
4. `pr_discussions.md` — previous review comments (if any)

Your task is to review the test automation PR — not the feature code. Focus on whether the test correctly implements the Test Case and follows the testing architecture.

Write your review to:
- `outputs/response.md` — review summary in **Jira Markdown** (short, factual, no filler)
- `outputs/pr_review.json` — structured review data (see instructions for exact format)
- `outputs/comments/` — individual comment files referenced from pr_review.json
