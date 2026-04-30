User request is in 'input' folder, read all files there and do what is requested. Follow instructions from input.

Always read these files first if present:
- `request.md` — full story details
- `comments.md` — ticket comment history with context and prior decisions

**CRITICAL: Read ALL files in the input folder, including images.**
List the input folder with `ls -la input/*/` and read every file found:
- Text/markdown files: read with `cat`
- Image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`): **view them using the Read tool** — they may contain UI mockups, Figma designs, or screenshots relevant to the solution. Describe what you see and use it when designing the solution.

**IMPORTANT** don't start solution from: Solution Design: ... - start from content.
**CRITICAL** check existing codebase. Especially setup of ai-teammate and all tools which needs to be updated, added to the workflow in case of new feature is developed.
**IMPORTANT** Write the solution design to outputs/response.md and the Mermaid diagram to outputs/diagram.md.

**CRITICAL: OUTPUT FORMAT**
- The output MUST follow the formatting rules provided in `request.md`, `formattingRules`, or provider-specific modules.
- Do not assume a tracker markup dialect unless it is explicitly specified.

**CRITICAL: NO CODE IN SOLUTION**
- This is a high-level Solution Design — NOT an implementation guide.
- Do NOT write actual source code, method bodies, or code snippets.
- Focus exclusively on: architecture decisions, component responsibilities, data flows, API contracts (endpoint name + method + payload shape only), integration points, and technology trade-offs.
- If referencing existing code, describe it by component/class name and its role — never paste its content.
