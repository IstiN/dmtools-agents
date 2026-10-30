# TDD Test Directory Rules

Write failing unit tests in the repository's existing unit-test tree **only**:

- Discover the unit-test directory from the existing build and test configuration and from nearby tests for the code being changed.
- Follow the naming, layout, and test-runner conventions already established in that directory.

❌ **Never** place development TDD tests under `testing/`.
`testing/` is owned by test-automation agents (regression probes, workflow observation tests, accessibility gates, etc.). If your production changes break existing tests there, leave them untouched and mention the breakage in `outputs/response.md` so the test-automation agent can update them.
