# Test Case Creation Rules

## Naming

Format: *Test: [Action or Feature] — [Expected Outcome]*

Examples:
- Test: Create Jira ticket via AI agent — ticket created with correct fields
- Test: Run agent with WIP label present — processing skipped, comment posted

## Structure

```mermaid
flowchart TD
    subgraph SECTIONS["Required Sections"]
        S1["h4. Objective<br/>One sentence: what behavior is verified"]
        S2["h4. Preconditions<br/>Conditions before execution (omit if none)"]
        S3["h4. Steps<br/># Step one<br/># Step two"]
        S4["h4. Expected Result<br/>Concrete, verifiable outcome"]
    end
```

## Coverage

```mermaid
flowchart TD
    COVER["For each AC/feature, generate:"] --> P["✅ Positive — happy path"]
    COVER --> N["❌ Negative — invalid input, unauthorized"]
    COVER --> B["🔀 Boundary — empty, max length, concurrent, retry"]
```

## Priority

```mermaid
flowchart TD
    H["High — core journeys, auth, data integrity, blocking workflows"]
    M["Medium — secondary features, error handling, alternative flows"]
    L["Low — UI/UX validations, cosmetic, optional features"]
```

## Quality Rules

```mermaid
flowchart TD
    Q1["Atomicity — one behavior per test case"]
    Q2["Independence — runnable in isolation"]
    Q3["Clarity — unfamiliar person can execute without guessing"]
    Q4["Completeness — every step has verifiable expected result"]
    Q5["Traceability — linked to story/requirement"]
```

## Scope

Cover:
- All acceptance criteria in the story
- Main integration points (tracker, SCM, AI providers)
- Error handling and failure scenarios
- Security-relevant behaviors (permissions, tokens, unauthorized access)

## Bug Test Cases — Strict Limits

```mermaid
flowchart TD
    BUG["Ticket type = Bug"] --> CHECK{"Existing TC covers same<br/>component + failure symptom?"}
    CHECK -->|Yes| LINK["Link existing TC — skip creation"]
    CHECK -->|No| MAX["Max 2 new TCs per bug"]

    MAX --> R["1. Regression test (mandatory)<br/>Exact scenario that triggered bug"]
    MAX --> P2["2. Prevention test (optional)<br/>Targets root cause fix directly"]

    FORBIDDEN["❌ Do NOT create:"]
    F1["Positive/happy-path scenarios"]
    F2["Negative/boundary variants of bug"]
    F3["Tests for related bugs via ticket links"]
    F4["Multiple prevention tests — pick most critical"]

    MAX --> FORBIDDEN
```

### Role stamping (gh-1329 — mandatory for bug TCs)

Every Test Case generated for a Bug carries its role in the description, so the
automation pipeline can attribute failures before bouncing the bug:

- The mandatory regression test (the bug's acceptance oracle) must state on its
  first description line: `Verifies: <BUG-KEY>` — the key of the bug it pins.
- A prevention test must state `Regression guard: <scope>` — the pinned behavior
  it protects (and `Verifies: <BUG-KEY>` when the pinned behavior belongs to a
  DIFFERENT bug; the pipeline then treats it as that bug's sibling).
- The bug's verdict is gated only by its own oracle TC; guard and sibling
  failures are triaged mechanically (retry → fingerprint → differential rerun)
  and route to the TC maintenance ledger instead of bouncing the bug.

## Deduplication (mandatory before creating)

```mermaid
flowchart TD
    D["Scan existing TCs for semantic overlap:"] --> D1["Same component/feature + same outcome → link"]
    D --> D2["Same subject + verb + component → link"]
    D --> D3["In doubt → link closest + add overlap note"]
```
