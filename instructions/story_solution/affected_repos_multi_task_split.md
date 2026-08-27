# Affected Repositories — Multi-Task Splitting (opt-in)

This instruction extends the base `affected_repos_flow.md` output format. It is
only included in SA agents that want to split the work inside a single
repository into several independently trackable Sub-tasks (instead of exactly
one Sub-task per repository). If this file is not in your `cliPrompts`, ignore
it — keep emitting the plain per-repository schema.

---

## When to split a repository into multiple tasks

Add a `tasks` array to a repository entry only when the work inside that one
repository is naturally separable into pieces that can be **developed,
reviewed, and tested independently** — for example:

- A schema/migration change vs. the business logic that consumes it.
- A backend API/entity change vs. a client-only follow-up in the same repo.
- Two unrelated modules/packages within a monorepo-style repository that don't
  share files and could be picked up by different developers in parallel.

Do **not** split when:

- The pieces are small and tightly coupled (same class/file, same PR anyway).
- Splitting would only produce artificial "step 1 / step 2" tickets that must
  always be worked by the same person in the same sitting — that's still one
  task, just phrase the `reason` as a short ordered list instead.
- There is genuinely only one repository‑scoped unit of work — most tickets
  should still end up with a plain single-task-per-repo entry.

When in doubt, prefer **not** splitting. Over-splitting creates Jira overhead
(more tickets to triage, review, and close) without a real parallelization or
tracking benefit.

### Mandatory self-check before writing the final `reason`

A single "big" `reason` string is a smell, not automatically a valid single
task. Before finalizing a repository entry, **write out (in your reasoning,
not in the JSON) a numbered list of the distinct new/changed classes, modules,
endpoints, or components you identified for that repository** (ignore
config/wiring one-liners), then state the verdict explicitly:

```
Repo: gens-igt
Distinct items:
  1. New workflow type PACBIO_FP_CREATION + WorkflowType enum branch
  2. New step ID DEFINE_PACBIO_FC_POOL + processor
  3. PairingService with max-weight matching algorithm
  4. Dynamic pipetting volume calculator
  5. File exports (PacBio Pipette Template, Standard Quant)
  6. DB migrations + ConfigTableName keys
Self-check: 6 items → split required (criteria: schema/migrations vs business
logic vs algorithm are independently reviewable PRs)
```

Only after this written self-check, apply the rules below. Do not skip the
listing step — if you cannot list the items, you have not analyzed the
repository's scope.

- **0–2 distinct items**, or all items are in the same file/class: keep it as
  one task — write the plain `reason`.
- **3 or more distinct items** in one repository: do not silently fold them
  into one `reason` sentence just because they ship for the same feature.
  Re-apply the split criteria above to each item individually. If at least two
  of them could realistically be reviewed/merged as separate PRs (even if all
  are needed before the feature works end-to-end), emit a `tasks` array — one
  task per independently reviewable item, with `depends_on` capturing the
  build order. Only keep it as a single task if you can state a concrete
  reason two of the items cannot be separated (e.g. they are the same class,
  or one is a one-line call inside the other).
- A shared theme ("all needed for the same new feature") is **not** by itself
  a reason to keep items merged — features regularly span multiple
  independently reviewable pieces within one repository.

---

## Schema

A repository entry MAY add a `tasks` array. When present, it takes precedence
over the top-level `reason` for Sub-task creation (the top-level `reason` is
still shown in the Affected Repositories table as a one-line rollup summary).

```json
{
  "name": "repo-a",
  "reason": "One-line rollup summary shown in the table.",
  "depends_on": ["repo-z"],
  "tasks": [
    {
      "id": "schema",
      "title": "Add new table migration",
      "reason": "Migration + entity for the new table.",
      "depends_on": []
    },
    {
      "id": "processor",
      "title": "Implement OrderStatusProcessor",
      "reason": "Business logic consuming the new schema; depends on the migration landing first.",
      "depends_on": ["schema"]
    }
  ]
}
```

| Field | Required | Description |
| --- | --- | --- |
| `id` | ✅ (when `tasks` is used) | Short, unique-within-this-repo slug (kebab-case). Referenced by other tasks' `depends_on`. |
| `title` | ✅ | Short Sub-task summary suffix — final Jira summary is `[repo-a] <title>`. |
| `reason` | ✅ | One sentence: what this specific task changes and why. |
| `depends_on` | ☐ | Array of prerequisite references (see below). Omit if none. |

### `depends_on` reference forms (task-level, only inside a `tasks` array)

- `"schema"` — another task's `id` **within the same repo**.
- `"repo-z:some-id"` — a specific task in **another repo** (`repo:id`).
- `"repo-z"` — a bare repo name — depends on **all** of that repo's tasks (or
  its single implicit task if that repo has no `tasks` array). Same meaning as
  the repo-level `depends_on` in the base schema.

---

## Rules

- Every `id` must be unique within its repo's `tasks` array (not globally —
  `repo-a:schema` and `repo-b:schema` can coexist).
- Do not repeat information between a task's `reason` and its parent repo's
  rollup `reason` — the rollup should read as a one-sentence summary of all
  the repo's tasks combined, not a duplicate of the first task.
- If a repository entry has no `tasks` array, it is still processed as exactly
  one Sub-task, identical to the base (non-multi) flow — this keeps the schema
  backward compatible with `affected_repos_flow.md`.
