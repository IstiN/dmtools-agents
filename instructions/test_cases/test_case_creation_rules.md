# Test Case Creation Rules

## Naming Convention

Use the format: *Test: [Action or Feature] — [Expected Outcome]*

Examples:
- Test: Create Jira ticket via AI agent — ticket created with correct fields
- Test: Run agent with WIP label present — processing skipped, comment posted
- Test: Push branch without open PR — error returned, no status change

## Structure

Every test case must contain the following sections using the target tracker format:

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
- Main integration points with external systems (tracker, SCM, AI providers, or project services)
- Error handling and failure scenarios described in the story
- Security-relevant behaviors (permissions, token handling, unauthorized access)

## When the Input Ticket is a Bug

When the ticket type is *Bug*, the *Solution* field contains a structured RCA written by the development agent (Root Cause, Fix Applied, Prevention).

Use the bug description and the Solution field to understand what broke and how it was fixed.

### Strict limits for bug-sourced test cases

**Create at most 2 new test cases per bug ticket:**

1. *Regression test* (mandatory) — the exact scenario that triggered the bug. This verifies the specific failure cannot silently recur.
2. *Prevention test* (optional, only if mechanically distinct) — a test that targets the root cause fix directly and covers a scenario not already tested by the regression test.

**Do NOT generate for bugs:**
- Positive/happy-path scenarios (these belong to the original story)
- Negative or boundary variants of the bug scenario (one regression test is sufficient)
- Tests for related bugs found via ticket links — only test THIS bug's scenario
- Multiple tests for different prevention points listed in the RCA — pick the most critical one

**Before creating any test case for a bug:**
1. Check the existing test cases listed in the context.
2. If an existing test case title shares 5 or more meaningful words with your proposed title, skip creation and link the existing one instead.
3. If the existing test case covers the same component + same failure symptom, link it — do not create a new one.

For bug test case names use the format:
*Test: [Scenario that triggered the bug] — [Expected correct behaviour]*

### Deduplication check (mandatory before creating)

Before creating any test case (for bugs or stories), scan the existing test case list for semantic overlap:
- If an existing TC verifies the same component/feature AND the same expected outcome → link it, skip creation.
- If the existing TC summary shares the same subject + verb + component → link it, skip creation.
- When in doubt, link the closest existing TC and add a note explaining the overlap.
