# Test Case Relation Rules

## When to Link an Existing Test Case

Link an existing test case to the current story when *all* of the following are true:

1. The test case verifies a behavior that is *directly affected* by the story being implemented
2. The test case will need to be *executed or updated* as part of validating this story
3. The overlap is on *functional behavior*, not just general area or module name

## When NOT to Link

Do not link an existing test case if:

- It only shares a keyword or module name but tests unrelated behavior
- It was written for a different version of the feature with incompatible preconditions
- It duplicates a new test case being generated for this story (prefer the new one)
- The connection is too generic (e.g., "both test Jira integration")

## Relevance Scoring Guidance

Treat a test case as *strongly related* if it:
- References the same Jira field, GitHub action, or AI agent workflow as the story
- Tests the same status transition, trigger condition, or API endpoint
- Was previously linked to a parent epic or sibling story of the current ticket

Treat a test case as *weakly related* (do not link) if it only:
- Mentions the same project or component in passing
- Tests a shared utility used across many features

## Deduplication

If an existing test case covers the same scenario as a new test case being generated:
- Do *not* create a new duplicate
- Link the existing test case instead
- Note in the comment that the existing test case covers this scenario

## Link Relationship

Use relationship *"relates to"* for all linked test cases.
