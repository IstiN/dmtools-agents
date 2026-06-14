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

## When to skip

Only skip a failed TC as a `skipped` entry when you are confident the failure is purely:
- test-code issue,
- infra/flake,
- outdated selector/locator.

Prefer creating a bug over skipping.

## Grouping

If multiple failed TCs share the same root cause, group them under one `newBugs` entry with all linked TC keys.
