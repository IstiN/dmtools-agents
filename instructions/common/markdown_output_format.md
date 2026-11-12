# Pull request output format

`outputs/response.md` in this workflow is posted to the pull request (GitHub / GitLab / Azure DevOps), so write it in GitHub-Flavored Markdown:

- Headings: `##`, `###`
- Inline code: backticks; code blocks: fenced with three backticks
- Tables: `| a | b |` followed by a `| --- | --- |` separator row
- Links: `[title](url)`

Never use Jira wiki markup (`h3.`, `{{code}}`, `{code}`, `{noformat}`, `|| header ||`, `[title|url]`), even when the ticket lives in Jira.
