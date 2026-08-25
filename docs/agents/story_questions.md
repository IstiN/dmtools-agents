# story questions

Collects open business questions for a story and creates them as question sub-tickets assigned for review.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js` (project values win).

- `autoStartQuestionAnswer` — when `true`, automatically trigger the question-answering workflow for created question tickets.
- `autoStartQuestionAnswerConfigFile` — agent config file used for the auto-started question-answering workflow.
- `priorityMap` — maps question priorities to tracker priority names.
