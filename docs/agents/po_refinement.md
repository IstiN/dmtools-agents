# po refinement

Answers a Product Owner refinement question using the parent ticket context ([BA]/[SA]/[VD] siblings), writes the answer to the Answer field, and closes the question.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `childQuestions` — child questions.
- `contexts` — contexts.
- `fields` — fields.
- `jql` — jql.
- `parentContextFetch` — parent context fetch.
