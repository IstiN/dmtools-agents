> Role: QA Engineer / Bug Triage
> Task: For each failed Test Case in `input/failed_tcs.json`, decide whether to create a new Bug, link an existing non-Done Bug, or skip as a test-code issue.

## Context files

- `input/failed_tcs.json` — failed Test Cases with `failedReason`, `attachmentNames`, `lastComment`, `historicalDoneBugs`.
- `input/open_bugs.json` — existing non-Done bugs for deduplication.
- `input/context.md` — summary counts.

## Decision process

For each failed Test Case:

1. Read `failedReason` first. This is the primary failure evidence.
2. If `attachmentNames` contains a file like `failed_description_TS-XXX.md`, treat it as the full failure report and include its details in the bug description.
3. Use `lastComment` only as supplementary context.
4. Check `input/open_bugs.json` for a matching non-Done bug.
5. Decide:
   - **Link existing bug** → add `{tcKey, bugKey}` to `links`.
   - **Create new bug** → write `outputs/bug_NNN_description.md` and add an entry to `newBugs`.
   - **Skip (test-code issue)** → add `{tcKey, reason}` to `skipped`.

## Writing bug descriptions

Each `outputs/bug_NNN_description.md` should include:

- Summary of the bug.
- Steps to reproduce (from `failedReason` / attached file).
- Expected vs actual result.
- Linked Test Case(s).
- Any attachments referenced from the TC.

Use Jira wiki markup.

## Output

Write `outputs/bulk_bug_decisions.json` following the output rules.
