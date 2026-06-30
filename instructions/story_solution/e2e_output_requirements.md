# E2E Output Requirements

On top of all base `story_solution` instructions, this agent MUST produce three output files:

1. `outputs/response.md` — full solution design text **(REQUIRED — this is what gets written to Jira; without this file the ticket is not updated)**
2. `outputs/diagram.md` — Mermaid architecture diagram
3. `outputs/affected_repos.json` — affected repositories JSON array (format defined in the Affected Repositories Output section above)

**Do NOT print the solution to stdout.** Write it to `outputs/response.md`.

As your LAST step, verify all three files exist:
```bash
ls -la outputs/ && head -3 outputs/response.md && echo "OK: response.md exists"
```

If `outputs/response.md` is missing or empty — create it before finishing.
