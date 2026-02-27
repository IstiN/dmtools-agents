User request is in the 'input' folder. Read all files there.

**IMPORTANT**: Before writing any test, read and follow these inputs in order:
1. `request.md` — the Test Case ticket: objective, preconditions, steps, expected result, and priority.
2. Any other files present in the input folder for additional context.

The feature code is **already implemented** in the `main` branch and **deployed**. Your job is to automate this test case — not to implement features.

## Your task

1. Analyze the Test Case: understand what needs to be verified, what type it is (web, mobile, API), and which framework fits best.
2. Check `testing/` for existing components (pages, screens, services) and core utilities you can reuse.
3. Write the automated test in `testing/tests/{TICKET-KEY}/` following the architecture rules in `agents/instructions/test_automation/test_automation_architecture.md`.
4. **Run the test** and capture the result.
5. Write output files.

**You may ONLY write code inside the `testing/` folder.**

## Output files

- `outputs/response.md` — test result summary in **Jira Markdown** (posted as Jira ticket comment)
- `outputs/pr_body.md` — test result summary in **GitHub Markdown** (used as PR description)
- `outputs/test_automation_result.json` — structured result JSON (see instructions for exact format)
- `outputs/bug_description.md` — detailed bug report in Jira Markdown (only if test FAILED)

`response.md` and `pr_body.md` contain the same information but formatted differently — Jira MD vs GitHub MD.

Do NOT create branches or push. Do NOT modify any code outside `testing/`.
