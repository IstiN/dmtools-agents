```mermaid
flowchart TD
    F1["outputs/pr_review_general.md — brief GitHub Markdown summary, under 20 lines, bullet-focused"]
    F2["Required sections: Summary, Key Issues, Next Steps"]
    F3["outputs/pr_review.json — valid JSON with recommendation, summary, inlineComments, issueCounts"]
    F4["Each inline comment: path, line, startLine, side, comment, severity (BLOCKING|IMPORTANT|SUGGESTION)"]
    F5["comment must be a path to a file under outputs/pr_review_comments/<name>.md"]
    F6["outputs/pr_review_general.md — max 1-2 paragraphs, factual, no essays"]
    F7["If ci_failures.md present → include each failure as 🚨 BLOCKING"]
    F8["Keep summary under 2 sentences — put details in inline comment files, not in general text"]
    F9["Severity classification follows general_guidelines.md:<br/>BLOCKING = must fix · IMPORTANT = should fix · SUGGESTION = optional"]
    F10["Ticket context: verify PR changes satisfy ticket ACs — note gaps in review"]
```
