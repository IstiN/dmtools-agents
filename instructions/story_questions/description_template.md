Each question `.md` file (referenced from `questions.json` as `description`) must follow this template. If a tracker-specific template is provided in the instructions, use that instead.

The block below is a **structural template / example only**. The tags such as `<bold>` and `<bullet>` are placeholders that show the required shape of the document.

**CRITICAL: Never write the final question description using these literal metatags.** Use the tracker-specific markup transformation table included in this prompt to convert every placeholder into the correct tracker markup.

Structure:
```
<bold>Background</bold>: [Brief context — 1-2 sentences explaining why this matters]

<bold>Question</bold>: [Clear, specific question]

<bold>Options</bold>:
<bullet> Option A: [Brief description]
<bullet> Option B: [Brief description]
<bullet> Option C: [Brief description if needed]

<bold>Recommended Decision</bold>: [Write your proposed answer here]
```

Rules:
- Do NOT repeat the summary in the description — start directly with <bold>Background</bold>
- <bold>Recommended Decision</bold> is required — always provide your best guess even if uncertain
- Keep options focused: 2–3 max; omit if only one valid path exists
- Replace every placeholder tag with the equivalent markup defined in the tracker-specific transformation table
- Do NOT leave literal XML-style tags such as `<bold>` or `<bullet>` in the final question description
