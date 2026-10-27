# ADO Markup Reference

When the target tracker is Azure DevOps, replace every generic placeholder tag from the template with the GitHub-flavored Markdown from the **GitHub-Flavored Markdown Placeholder Table** section. Do not write literal XML-style tags in the final output.
## Rules

- Replace every placeholder tag with the Markdown shown above.
- Do NOT use Jira wiki markup in ADO output: no `*bold*`, no `* item` bullets, no `h2.` headings, no `{code}...{code}` blocks.
- Use `- item` for bullets and `1. item` for numbered lists.
- For Mermaid diagrams in ADO fields that support them, wrap the diagram in ` ```mermaid\n...\n``` `.
- Whenever referencing an ADO work item / ticket ID in any message, comment, or description, always prefix numeric ADO work item IDs with `#` (e.g. `#12345`, `see details in #12345` instead of `see details in 12345`) so Azure DevOps automatically generates a link to the mentioned work item.
