# story acceptance criteria

Generates structured, testable Acceptance Criteria for a Story from `input/` context (description, designs, and answered question sub-tickets), enforcing `acceptance_criteria_quality.md` and replacing the ticket's `Acceptance Criteria` field (or syncing to Confluence when configured), then advancing the story via `assignForSolutionArchitecture.js`.

## Parameters

- `contentOutput` — destination routing (`target`: `jira_field` | `confluence` | `both`, `field`: `Acceptance Criteria`, `operationType`: `replace`, `thenAction`: `assignForSolutionArchitecture.js`, `assignForReview`: `false`).
- `autoStartSolution` / `autoStartSolutionConfigFile` — optionally chains the solution design agent after Acceptance Criteria are saved.
