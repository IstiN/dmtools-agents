# Solution Design Output Format

Write the enhanced SD CORE technical description to `outputs/response.md` and a valid Mermaid diagram to `outputs/diagram.md`.

The block below is a **structural template / example only**. The tags such as `<bold>`, `<bullet>`, `<code>`, and `<link>` are placeholders that show the required shape of the document.

**CRITICAL: Never write the final `outputs/response.md` using these literal metatags.** Use the tracker-specific transformation table (for example `agents/instructions/tracker/jira_markup_transform.md` when the tracker is Jira) to convert every placeholder into the correct tracker markup.

```
<bold>Purpose:</bold>
[One-paragraph summary of the solution goal and scope.]

<bold>Background and Constraints:</bold>
<bullet> Existing workflow, system, or business constraint.
<bullet> Relevant prior decision or dependency.
<bullet> Non-negotiable technical or process limitation.

<bold>Architecture Decisions:</bold>
<bullet> Decision: [chosen approach] — Rationale: [why it fits best].
<bullet> Decision: [alternative considered and rejected] — Rationale: [trade-off].

<bold>Component Responsibilities:</bold>
<bullet> <code>ComponentName</code>: [what it does and how it interacts with others].
<bullet> <code>AnotherComponent</code>: [responsibility].

<bold>Data Flow:</bold>
<bullet> Step 1: [actor / trigger → component].
<bullet> Step 2: [component → component / store].
<bullet> Step 3: [result / side effect].

<bold>API Contracts:</bold>
<bullet> <code>POST /api/example</code>: [request payload shape] → [response shape].
<bullet> <code>GET /api/example/{id}</code>: [purpose and return shape].

<bold>AC Coverage:</bold>
The Acceptance Criteria are defined in the BA ticket (<link>BA-TICKET|https://jira.example.com/browse/BA-TICKET</link>) and are the single source of truth.
<bullet> AC1 (Feature Display) → Addressed by [component / flow].
<bullet> AC2 (Dialog Content) → Addressed by [component / flow].
<bullet> AC3 (Core Logic) → Addressed by [component / flow].
<bullet> AC4 (Error Handling) → Addressed by [component / flow].

<bold>Out of Scope:</bold>
<bullet> Item deliberately not covered by this solution.

<bold>Risks and Security Notes:</bold>
<bullet> Risk: [description] — Mitigation: [approach].
<bullet> Security: [credential, secret, or permission consideration].
```

## Rules

- The template above is a structural example. Replace every `<bold>`, `<italic>`, `<strike>`, `<underline>`, `<code>`, `<codeblock>`, `<bullet>`, `<numbered>`, `<heading1>`, `<heading2>`, `<heading3>`, `<link>`, `<image>`, `<quote>`, `<panel>`, `<color>`, and `<hr>` placeholder with the equivalent markup defined in the tracker-specific transformation table.
- Do NOT leave literal XML-style tags such as `<bold>` or `<code>` in the final `outputs/response.md`.
- Do NOT use Markdown syntax in Jira output: no `**bold**`, no `- item` bullets, no `# headings`, no triple backticks.
- Use the tracker-specific link format when referencing tickets or URLs.
- Write the Mermaid diagram to `outputs/diagram.md` using plain Mermaid syntax — do not wrap it in markup tags.
