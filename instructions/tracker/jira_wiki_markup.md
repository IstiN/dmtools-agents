# Jira wiki markup

Use this only when the target tracker field/comment expects Jira wiki markup.

- Headings: `h2.`, `h3.`
- Bold: `*bold*`
- Italic: `_italic_`
- Bullet lists: `* item`
- Tables: `||Header||` and `|value|`
- Code blocks: `{code}...{code}` or `{noformat}...{noformat}`
- Mermaid diagrams: `{code:mermaid}...{code}` if supported by the target field.
- Do not use Markdown headings, triple backticks, or Markdown tables in Jira wiki fields.

**IMPORTANT** You must check child tickets and parent story for better context using: `dmtools jira_search_by_jql`.

