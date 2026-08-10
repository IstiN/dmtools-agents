## Knowledge Update — Output Rules

This agent does not open a PR/MR and does not post review replies — it only edits
files under `<knowledgeDir>` (named in `input/<TICKET>/knowledge_task.md`) and writes
a short summary.

### Constraints

- Touch **only** files under `<knowledgeDir>`. Never edit product source code, tests,
  or any other part of the repository in this flow.
- Never delete or rewrite an existing heuristic's core rule without a clear semantic
  match justifying it — see general_guidelines.md's dedup rule.
- Each heuristic body is ONE sentence. The optional `> why:` line is at most 12 words.
- Compaction (merging near-duplicates, deleting stale `weight: 1` heuristics older than
  ~90 days) is a separate, occasional pass — do not attempt it automatically as part of
  a single PR's lesson extraction unless `<knowledgeDir>/README.md` explicitly asks for
  it every run.

### Required file

`outputs/response.md` — a concise Markdown summary:

```markdown
## Knowledge Update

| action | id | rule | reason |
|---|---|---|---|
| new | <id> | <one-line rule> | <why> |
| reinforced | <id> | <one-line rule> | <why> |

(or, if nothing qualified:)
No generalizable lesson found — <short reason, e.g. "routine dependency bump, no review pushback">.
```
