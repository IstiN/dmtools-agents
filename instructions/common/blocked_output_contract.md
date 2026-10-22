# Blocked Output Contract (`outputs/blocked.json`)

When work cannot proceed because required credentials, secrets, permissions, test data, or external human decisions are missing:

1. Do **not** guess, hardcode, or fake a passing result.
2. Write `outputs/blocked.json` at the repository root with the exact blocker details:
   ```json
   {
     "reason": "Specific external blocker preventing completion",
     "tried": ["What was checked or attempted"],
     "needs": "Exact secret, permission, data, or decision a human must provide"
   }
   ```
3. Also write `outputs/response.md` summarizing the blocker so the human sees the explanation in the ticket/PR comment.
