# `outputs/diagram.md` — Single Source of Truth

Any agent that writes `outputs/diagram.md` (Solution Design, Solution Description,
and their variants) MUST follow this exact contract. It replaces every other,
possibly conflicting, phrasing of "write a diagram" you may see elsewhere in
this prompt — if another instruction seems to disagree with this file, this
file wins.

## Rules

1. **Exactly one Mermaid diagram, in one file.** Do not write two separate
   diagrams (e.g. one for the architecture and a second one for affected
   repositories) — see rule 3 for how to combine them.
2. **Plain Mermaid syntax only. No fences, no markup tags.** The file must
   start directly with a Mermaid diagram-type keyword (`graph TD`,
   `flowchart TD`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, ...).
   Do **NOT** wrap the content in triple backticks (`` ```mermaid ... ``` ``),
   HTML/XML-style tags (`<codeblock:mermaid>`), or any other markup — the
   post-action script wraps the raw content in the correct macro/fence for
   the target (Jira, Confluence, ADO) automatically. Adding your own
   fence around it results in a double-wrapped, unrenderable diagram.
3. **Need to show affected repositories or a dependency chain?** Add it as an
   additional `subgraph` **inside this same diagram** (not a second,
   separate diagram) — see any repository-specific guidance in your prompt
   for exact conventions. Do not duplicate a repo-dependency graph that a
   post-action already renders automatically from `outputs/affected_repos.json`
   (check whether your job's `affected_repos_*` instructions say the
   dependency chain is auto-rendered — if so, do not draw it again yourself).
4. **One diagram type for the whole file.** Pick the Mermaid diagram type
   that best represents the solution (`graph`/`flowchart` for architecture
   and component relationships, `sequenceDiagram` for request/response
   flows, `classDiagram` for data models, `stateDiagram-v2` for workflow
   states) and stay consistent — do not mix unrelated diagram types in the
   same file.

## Example content for `outputs/diagram.md`

```
flowchart TD
    A[User Request] --> B[Workflow Engine]
    B --> C[AI Analysis]
    C --> D[Enhanced Description]
    D --> E[Jira Update]

    subgraph Affected Repositories
        R1[repo-a<br/>new REST endpoint]
        R2[repo-b<br/>UI component]
    end
    B --> R1
    C --> R2
```

(The fenced code block above is only to show you the example text in this
instruction document — do not include the fence in your actual
`outputs/diagram.md` file, only the Mermaid content itself.)
