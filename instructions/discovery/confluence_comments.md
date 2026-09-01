# Confluence inline comments (discovery page tree)

Same principle as the story_solution/story_description agents' Confluence output flow, adapted for a discovery run's whole page tree (not just one page).

## Reading comments

On an iteration run, `input/<ticket>/discovery_comments.md` and `.json` (if present) list the inline (annotation) comments collected from **every page already published for this ticket** — the ticket's own page and every child/descendant page, at any depth (not just the source pages referenced by the ticket). Each entry carries `pageId`, `pageTitle`, `resolved`, `author`, and `body`. Match `pageTitle` against the file you are editing in `outputs/discovery/` (same title, same sanitized filename) to know which comment belongs to which of your output files.

- Treat **unresolved** comments as review feedback: if a comment points out a mistake, asks a clarifying question, disagrees with a conclusion, or requests a change — go through **every single one**, not just the ones that are easiest to address. Don't silently skip a comment because it doesn't fit neatly into the current delta; if it's genuinely out of scope for this run, still leave a factual reply (see below) explaining that rather than leaving it unanswered.
- Already **resolved** comments need no action, but may provide useful context.
- If a comment is itself a question the reader is asking you (not just feedback on a conclusion), answer it directly — both in the updated page content (if the answer belongs there) and in your reply (see below).

## Inline comment anchors (`[[ic:...]]` placeholders)

Each snapshotted file under `outputs/discovery/` may contain placeholders like `[[ic:550e8400-e29b-41d4-a716-446655440000]]anchored text[[/ic]]`. Each one marks the text fragment an inline comment is anchored to on the published page. On publish, the Confluence Markdown sync converts these placeholders back into real page anchors; if you drop or mangle them, the comment loses its anchor and disappears from the page.

Rules:

- **Always preserve** every `[[ic:REF]]...[[/ic]]` placeholder, wrapped around the same text it currently marks.
- If you rephrase the anchored text, **move the placeholder** so it wraps the new equivalent fragment.
- On headings, place the placeholder **inside** the heading, after the `#` markers — `## [[ic:REF]]Purpose[[/ic]]`, never `[[ic:REF]]## Purpose[[/ic]]` (wrapping the `#` prefix breaks heading rendering).
- The same applies to list items and quotes: keep `-`, `1.`, `>` outside the placeholder.
- Remove a placeholder only when you intentionally remove the commented content itself.
- Never invent new `[[ic:...]]` refs — only the ones already present are valid.

## Replying to comments

When your update directly addresses an unresolved comment — whether by changing the content, or by explicitly explaining why you didn't — add a reply entry to `outputs/confluence_replies.json`. The file must be a JSON array, and can contain replies to comments on **any page in the tree**, not just the root:

```json
[
  {
    "pageId": "12345678",
    "commentId": "98765432",
    "body": "Updated the recommendation to account for this — see the Recommendations page."
  }
]
```

Rules:

- `pageId` and `commentId` must come from `input/<ticket>/discovery_comments.md`/`.json` — never invented.
- Reply to every unresolved comment you addressed this run, even briefly — a comment left silently unanswered looks ignored to the reader even if you did act on it elsewhere in the page tree.
- Keep replies concise and professional. If the comment asked a direct question, the reply should contain the actual answer (or point to the exact section that does), not just "addressed."
- If no comment needs a reply, omit the file or write an empty array `[]`.
