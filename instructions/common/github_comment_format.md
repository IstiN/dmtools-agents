# GitHub tracker comment

Use GitHub-flavored Markdown in `outputs/response.md` for GitHub issue
comments and descriptions. Your output is posted to the issue as-is — every
construct must render natively on GitHub.

- Headings: `##`, `###`
- Bullets: `- item`
- Numbered lists: `1. item`
- Bold: `**text**`
- Inline code: `` `code` ``
- Code block: ` ```lang ... ``` ` with a language tag (`dart`, `bash`, `json`)
- Link: `[text](url)`
- Tables: standard GFM table syntax (`|---|` separator row)

Do not use Jira wiki markup in GitHub fields: no `{code}...{code}` blocks,
no `{panel}` macros, no `h1.`/`h2.`/`h3.` heading prefixes, no
`{{monospace}}` inline code, no `[title|url]` links. None of it renders on
GitHub — a comment full of `{code}` fences and `h3.` headers is unreadable.

**IMPORTANT** When the issue references a parent story or related issues,
get them for full context using: `dmtools github_get_issue OWNER/REPO#NUMBER`
(the composite key form works directly).
