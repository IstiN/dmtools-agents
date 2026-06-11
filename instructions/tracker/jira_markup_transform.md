# Jira Markup Reference

When the target tracker is Jira, replace every generic placeholder tag from the Solution Design template with the Jira wiki markup shown below. Do not write literal XML-style tags in the final output.

| Generic placeholder | Jira wiki markup | Example |
|---------------------|------------------|---------|
| `<bold>X</bold>` | `*X*` | `*Background:*` |
| `<italic>X</italic>` | `_X_` | `_hint_` |
| `<strike>X</strike>` | `-X-` | `-deprecated-` |
| `<underline>X</underline>` | `+X+` | `+important+` |
| `<code>X</code>` | `{{X}}` | `{{main.dart}}` |
| `<codeblock>X</codeblock>` | `{code}X{code}` | `{code}void main() {}{code}` |
| `<codeblock:lang>X</codeblock:lang>` | `{code:lang}X{code}` | `{code:dart}void main() {}{code}` |
| `<bullet> text` | `* text` | `* Option A` |
| `<numbered> text` | `# text` | `# Step one` |
| `<heading1>X</heading1>` | `h1. X` | `h1. Title` |
| `<heading2>X</heading2>` | `h2. X` | `h2. Section` |
| `<heading3>X</heading3>` | `h3. X` | `h3. Subsection` |
| `<link>text\|url</link>` | `[text\|url]` | `[TS-24\|https://jira.example.com/browse/TS-24]` |
| `<image>url</image>` | `!url!` | `!https://.../diagram.png!` |
| `<image-thumb>url</image-thumb>` | `!url\|thumbnail!` | `!https://.../diagram.png\|thumbnail!` |
| `<quote>X</quote>` | `{quote}X{quote}` | `{quote}cited text{quote}` |
| `<panel>X</panel>` | `{panel}X{panel}` | `{panel}note{panel}` |
| `<color color="red">X</color>` | `{color:red}X{color}` | `{color:red}alert{color}` |
| `<hr>` | `----` | `----` |

## Rules

- Replace every placeholder tag with the Jira wiki markup shown above.
- Do NOT use Markdown syntax in Jira output: no `**bold**`, no `- item` bullets, no `# headings`, no triple backticks.
- Use `* item` for bullets and `# item` for numbered lists.
- For Mermaid diagrams in Jira fields that support them, wrap the diagram in `{code:mermaid}...{code}`.
- For plain preformatted blocks, use `{noformat}...{noformat}`.

## Full Jira wiki markup reference (Atlassian)

- `*text*` — bold
- `_text_` — italic
- `-text-` — strikethrough
- `+text+` — underline
- `^text^` — superscript
- `~text~` — subscript
- `{{text}}` — monospaced inline code
- `{code}...{code}` — code block
- `{code:java}...{code}` — language-specific code block
- `{noformat}...{noformat}` — preformatted block
- `[text\|url]` — link
- `!image.png!` — embedded image
- `h1.` ... `h6.` — headings
- `* item` — bullet list
- `# item` — numbered list
- `||header||header||` / `|cell|cell|` — tables
- `{quote}...{quote}` — block quote
- `{panel}...{panel}` — panel
- `{color:red}...{color}` — colored text
- `----` — horizontal rule
