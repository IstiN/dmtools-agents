Example bulk bug decisions output:

```json
{
  "processed": ["TS-984", "TS-954", "TS-909"],
  "newBugs": [
    {
      "summary": "Login button unresponsive on iOS Safari",
      "priority": "High",
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
      "reason": "Flaky CSS selector '.btn-primary' no longer matches after UI refactor — test code issue, not app bug"
    }
  ]
}
```
