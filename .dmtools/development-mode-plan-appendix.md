## Development Mode: Plan (plan-mode protocol appendix)

This leg runs in **plan mode**: work through an explicit, committed task
plan instead of free-form execution. Everything else in the instruction
pack still applies unchanged — this appendix only structures HOW you work.
`<KEY>` below is the current ticket key.

### 1. Decompose before editing

- Before writing any production code, break the ticket into numbered tasks
  `T1..Tn` in `outputs/<KEY>/plan.md` (the working copy).
- Every task carries exactly two fields:
  - `what` — the concrete change this task makes;
  - `verify` — how to check it passed (the command to run and the expected
    result).
- End the plan with two sections:
  - `## Decisions` — the chosen approach for every open point;
  - `## Open questions` — anything unresolved, with the workaround you picked.

### 2. Mirror the plan into a committed snapshot

- Mirror the plan to `.dmtools/plan-snapshot.md` and commit it on the dev
  branch right away: commit subject `<KEY>: plan`.
- The snapshot — not the working copy — is the durable artifact: it survives
  interruption windows and CI session-cache loss. (`outputs/` never rides
  commits.)
- When a task completes: mark its checkbox `[x]` in BOTH files and commit
  the snapshot update: `<KEY>: plan update T# done` (one commit per task).
- The periodic WIP auto-save commits keep running as usual; your plan
  commits coexist with them.

### 3. Resume rule (continuation legs)

- At leg start: if a plan file (`outputs/<KEY>/plan.md` or
  `.dmtools/plan-snapshot.md`) already exists, or the branch already carries
  commits, this leg is a CONTINUATION, not a fresh start:
  1. Read the plan and `git log`.
  2. Reconcile the plan checkboxes against the actual branch diff — a task
     whose change is already on the branch is done, checkbox or not.
  3. Execute ONLY the still-pending tasks.