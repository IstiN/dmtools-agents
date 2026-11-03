# story done check

Verifies that a story can move to Done: checks that tests passed and PRs merged, then transitions the ticket or reports what is missing.

Since gh-1330 the Done report is truthful about skipped work: when linked Test Cases ended as Skipped or Irrelevant, the completion comment lists the per-status buckets instead of claiming "All Test Cases Passed", and every skipped Test Case is stamped with a machine-parseable skip marker (`[tc-skip-marker] skipped at <STORY> done-check (<reason>), never executed — <date>` comment plus a `skipped_at_<STORY>` label).

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `customStatuses` — status name overrides for this workflow (maps logical statuses to project-specific names).
- `removeLabel` — label removed from the ticket after a successful run (idempotency cleanup).
- `skipReason` — optional reason recorded in the per-TC skip markers (default: `no reason recorded`).
- `skipsNeedHuman` — opt-in: when skipped Test Cases exist, flag the story with a `needs_human_skips` label and a needs-human comment instead of moving it to Done (default off — the story still completes).
