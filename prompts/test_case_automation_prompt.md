User request is in 'input' folder, read all files there and do what is requested.

**IMPORTANT** Before writing tests, read and follow these inputs in order:
1. `request.md` — full ticket details including Acceptance Criteria, Solution field (solution design), and Diagrams field (architecture diagram). Each Acceptance Criterion must be covered by at least one automated test.
2. `existing_questions.json` — clarification questions with answers from the PO. Treat answered questions as binding requirements when defining test cases.

Your task is to write automated test coverage for this ticket only — not to implement feature code. Focus exclusively on:
- Unit tests for all functions, methods, and classes introduced or modified by this ticket
- Integration tests where the ticket introduces interaction between components
- Aim for 100% coverage of all Acceptance Criteria — every AC must have a corresponding test

**OUT OF SCOPE**: E2E browser automation, manual test scripts, test plans or documentation.

Write a summary to outputs/response.md listing: tests added, ACs covered, coverage achieved, and any gaps or assumptions.

DO NOT create branches or push — focus only on test implementation. You must run all tests and confirm they pass before finishing.
