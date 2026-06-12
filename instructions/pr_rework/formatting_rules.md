```mermaid
flowchart TD
    F1["outputs/response.md must be Markdown (# headings, - bullets, ``` code fences)"]
    F2["Required sections: ## Issues/Notes (if any), ## Approach, ## Files Modified, ## Test Coverage"]
    F3["Be surgical but thorough — fix exact issues flagged, then check same pattern across codebase"]
    F4["Do NOT refactor unrelated code or add unrequested features"]
    F5["When open PR review threads exist, create outputs/review_replies/*.md files and reference them from outputs/review_replies.json"]
```

- When `input/<TICKET>/pr_discussions_raw.json` contains open PR review threads:
  - Write one Markdown file per open thread under `outputs/review_replies/`.
  - Write `outputs/review_replies.json` with one entry per open thread, including `inReplyToId`, `threadId`, and a `reply` field that contains the path to the matching `.md` file.
  - Do **not** put reply bodies inline in the JSON.
