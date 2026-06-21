# Bulk Bugs Creation Guidelines

When a Test Case fails and the failure is a real application bug, create or link a Bug ticket.

## Primary failure evidence

1. **`failedReason`** field from the Test Case — this is the most authoritative failure summary.
2. **Attached failed-description file** — the full failure report written by test automation.
3. **Last comment** on the Test Case — supplementary discussion/context.

Use the `failedReason` and attachment content as the basis for every bug `descriptionFile`. Do not rely only on the last comment or test summary.

## Matching existing bugs

Before creating a new bug, check `input/open_bugs.json` for non-Done bugs with:
- the same component/symptom,
- functionally identical summary,
- overlapping reproduction steps (≥70%).

If a match exists, add a `links` entry instead of a `newBugs` entry.

## When to skip (very restrictive)

Do **not** skip a failed Test Case just because the failure looks environment-specific, flaky, or infra-related. If a Test Case fails in CI, treat it as a real bug unless you have direct, incontrovertible evidence that the product behavior is correct and **only** the test code is wrong.

You may only output a `skipped` entry when **both** of the following are true:
- the test code itself is provably wrong (e.g., outdated selector, incorrect assertion, missing mock), AND
- the product behavior described in the Test Case is demonstrably correct.

In all other cases — including environment timeouts, live-service flakes, infrastructure hangs, or unclear root cause — **create a Bug ticket**. These failures should flow through the bug-fix pipeline so the agents can fix them and the tests can be re-run.

Prefer creating a bug over skipping.

## Grouping

If multiple failed TCs share the same root cause, group them under one `newBugs` entry with all linked TC keys.
