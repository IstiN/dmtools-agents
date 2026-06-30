# Affected Repositories Section Format

> **IMPORTANT: Do NOT write this section to `outputs/response.md`.**
> The post-action script appends it automatically after saving the solution to Jira.
> Your job is only to produce `outputs/affected_repos.json` with the correct data.

The post-action appends an *Affected Repositories* section to the ticket description
after the solution is written. Format the section according to the tracker-specific
markup rules already defined in `jira_markup_transform.md` (Jira) or
`ado_markup_transform.md` (ADO). This file only describes the **structure**.

---

## Structure

The section contains three parts in order:

1. **Table** — ordered list of affected repositories (topological order, prerequisites first)

   | Column | Content |
   |---|---|
   | `#` | Sequential number (1, 2, …) |
   | Repository | Short repo name, no org prefix |
   | Reason | One sentence: what changes and why |
   | Depends On | Comma-separated prerequisite repo names, or `—` if none |

2. **Dependency flow diagram** — Mermaid `graph LR` showing `depends_on` edges.
   Omit entirely when no repo has `depends_on`.

3. **JSON anchor** — the raw JSON array from `outputs/affected_repos.json`,
   wrapped in a labeled code block so the `createRepoTasks` script can locate and parse it.
   The label must be exactly `affected_repos`.

---

## Jira example

```
<hr>
<heading2>Affected Repositories</heading2>

||#||Repository||Reason||Depends On||
|1|repo-a|Short explanation.|—|
|2|repo-b|Short explanation.|repo-a|

<codeblock:mermaid>
graph LR
    repo-a --> repo-b
</codeblock:mermaid>

{code:json|title=affected_repos}
[{"name":"repo-a","reason":"..."},{"name":"repo-b","reason":"...","depends_on":["repo-a"]}]
{code}
<hr>
```

## ADO example

```
<hr>
<heading2>Affected Repositories</heading2>

|#|Repository|Reason|Depends On|
|---|---|---|---|
|1|repo-a|Short explanation.|—|
|2|repo-b|Short explanation.|repo-a|

<codeblock:mermaid>
graph LR
    repo-a --> repo-b
</codeblock:mermaid>

<codeblock:json>
[{"name":"repo-a","reason":"..."},{"name":"repo-b","reason":"...","depends_on":["repo-a"]}]
</codeblock:json>
<hr>
```

---

## Machine-parsing anchor

The `createRepoTasks` script locates the JSON by searching for
`{code:json|title=affected_repos}` (Jira) or the ` ```json ` block immediately
following `## Affected Repositories` (ADO), then:

1. Parses the JSON array
2. Topological-sorts by `depends_on`
3. Creates Sub-tasks in order and links them with *Blocks* Jira links
