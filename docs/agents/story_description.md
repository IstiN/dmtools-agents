# story description

Writes an enhanced Story `Description` from `input/` context and answered `existing_questions.json` sub-tickets while preserving all original attachment and link references (`preserve_references.md`), then assigns the ticket back for review.

## Parameters

- `contentOutput` — destination configuration (`target`: `jira_field` | `confluence` | `both`, `field`: `Description`, `operationType`: `replace`, `assignForReview`: `true`, plus Confluence page settings `space`, `parentPageId`, `pageTitleSuffix`, `includeInlineComments`, `updateTrackerField`).
