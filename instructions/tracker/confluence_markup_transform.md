# Confluence Markup Reference

When the generated content is published to Confluence (contentOutput target `confluence`), the body is synced as **Markdown** and converted to Confluence storage format automatically. Replace every generic placeholder tag from the template with the GitHub-flavored Markdown from the **GitHub-Flavored Markdown Placeholder Table** section. Do not write literal XML-style tags in the final output.
## Rules

- Replace every placeholder tag with the Markdown shown above.
- Do NOT use tracker-specific wiki markup in Confluence output: no `h2.` headings, no `{code}...{code}` blocks, no `{{monospace}}`, no `[text|url]` links.
- Use `- item` for bullets and `1. item` for numbered lists.
- For Mermaid diagrams, wrap the diagram in a fenced code block with the `mermaid` language tag: ` ```mermaid\n...\n``` `.
