# Bulk Bug Creation Output Rules

## Required JSON

Write `outputs/bulk_bug_decisions.json`:

```json
{
  "processed": ["TS-984", "TS-954", "TS-909"],
  "newBugs": [
    {
      "summary": "...",
      "priority": "High|Medium|Low",
      "descriptionFile": "outputs/bug_001_description.md",
      "linkedTCs": ["TS-984", "TS-954"]
    }
  ],
  "links": [
    { "tcKey": "TS-909", "bugKey": "TS-123" }
  ],
  "skipped": [
    {
      "tcKey": "TS-800",
      "reason": "Detailed reason why this is a test-code issue"
    }
  ]
}
```

### Rules

- `processed` must list every TC the AI made a decision for.
- `newBugs[].descriptionFile` must point to an existing `outputs/bug_NNN_description.md`.
- The description file must incorporate the TC's `failedReason` field and any attached failed-description file content.
- Do not embed multi-line description text directly inside `bulk_bug_decisions.json`.
- Do not output `fixedByBug` — Done bugs are excluded from matching.
- `skipped[].reason` must be detailed and specific.
