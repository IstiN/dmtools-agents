# Test Case Creation Rules

## Naming Convention

Use the format: *Test: [Action or Feature] — [Expected Outcome]*

Examples:
- Test: Create Jira ticket via AI agent — ticket created with correct fields
- Test: Run agent with WIP label present — processing skipped, comment posted
- Test: Push branch without open PR — error returned, no status change

## Structure

Every test case must contain the following sections in Jira Markdown:

```
h4. Objective
One sentence describing what behavior is being verified.

h4. Preconditions
List of conditions that must be true before the test is executed.
Omit this section if there are no preconditions.

h4. Steps
# Step one
# Step two
# Step three

h4. Expected Result
Concrete, verifiable outcome. What the system must do or show.
```

## Coverage Requirements

For each acceptance criterion or feature, generate:

1. *Positive scenario* — the happy path where everything works as expected
2. *Negative scenario* — invalid input, missing data, or unauthorized access
3. *Boundary/edge case* — empty values, maximum length, concurrent execution, or retry behavior (where applicable)

## Priority Assignment

|| Priority || When to assign ||
| *High* | Core user journeys, authentication/authorization, data integrity, critical integrations, blocking workflows |
| *Medium* | Secondary features, error handling, alternative flows, non-critical integrations |
| *Low* | UI/UX validations, cosmetic checks, optional features, convenience scenarios |

## Quality Rules

- *Atomicity*: Each test case must verify exactly one behavior. Do not combine multiple assertions.
- *Independence*: Tests must be runnable in isolation without depending on the result of other tests.
- *Clarity*: Steps must be unambiguous — a person unfamiliar with the system must be able to execute them without guessing.
- *Completeness*: Every step must have a verifiable expected result.
- *Traceability*: Every test case must be linked to the story or requirement it verifies.

## Scope

Generate test cases that cover:
- All acceptance criteria listed in the story
- Main integration points with external systems (Jira, GitHub, AI providers)
- Error handling and failure scenarios described in the story
- Security-relevant behaviors (permissions, token handling, unauthorized access)
