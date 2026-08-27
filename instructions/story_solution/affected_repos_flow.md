# Affected Repositories Output

## Purpose

After writing the solution design, produce `outputs/affected_repos.json` — a structured
list of every repository where code, configuration, migrations, or schema changes are needed.
This file is consumed by the post-action script to label the Jira ticket and generate a
visual dependency map.

---

## Output format

```json
[
  {
    "name": "repo-a",
    "reason": "Short explanation of what must change and why."
  },
  {
    "name": "repo-b",
    "reason": "Short explanation of what must change and why."
  },
  {
    "name": "repo-c",
    "reason": "Depends on schema from repo-a and API from repo-b.",
    "depends_on": ["repo-a", "repo-b"]
  }
]
```

| Field | Required | Description |
| --- | --- | --- |
| `name` | ✅ | Exact short repository name (no org prefix, no URL). |
| `reason` | ✅ | One sentence: what changes and why it is needed. |
| `depends_on` | ☐ | Names of other affected repos that must be completed first. Omit if no ordering constraint. |

---

## How to determine affected repositories

Include a repository when any of the following are true:

- Source code must be added or modified (new endpoint, new model field, new UI component, etc.)
- Database schema or migration script must be created
- Configuration or environment variable must be added
- API contract change requires the consumer to adapt
- Test suite must be updated to cover new behaviour

**Do NOT include** repositories that are only read at runtime (no code changes needed),
or that are affected only indirectly through a shared library version bump that requires
no code change.

---

## Dependency chain — auto-rendered, do not draw it yourself

The `depends_on` field expresses a *must complete before* ordering constraint.
Use it whenever a change in one repo cannot be deployed or tested without a
prior change in another. Whenever three or more repositories form a chain,
the post-action script **automatically renders this exact dependency chain
as its own Mermaid diagram** from `outputs/affected_repos.json`, for example:

```mermaid
flowchart LR
    A["repo-a\n(schema change)"]
    B["repo-b\n(API change)"]
    C["repo-c\n(UI + test update)"]

    A -->|"prerequisite"| B
    B -->|"prerequisite"| C
```

**Do NOT add this diagram, or any other repository-dependency diagram, to
`outputs/diagram.md` yourself** — it is generated automatically and adding
your own copy produces a duplicate. `outputs/diagram.md` must contain only
the single architecture/workflow diagram described in
`common/diagram_output_contract.md` (which may include an `Affected
Repositories` subgraph if your job's instructions ask for one — see rule 3
there — but never a second full diagram).
**Do NOT write an "Affected Repositories" section or table to `outputs/response.md`** — the post-action script appends that section automatically after saving the solution to Jira.

---

## Empty result

If the solution requires no repository changes (pure configuration, Jira-only update, etc.):

```json
[]
```
