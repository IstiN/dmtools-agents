# ci_analyst

CI failure analyst leg — the first stage of the CI self-heal loop. It reads a
prepared CI context file, classifies the failing workflow runs as either an
adequate failure (broken code/tests/config) or pipeline noise (network flakes,
runner infra, cancellations, stale reds already reset green on a newer sha),
and emits a strict verdict. When the verdict is adequate and `dryRun` is off,
the post action files exactly ONE GitHub issue (`[ci-heal] …`) that the follow-up
dev leg consumes; dry-run and noise verdicts never touch GitHub.

Teammate-type agent (CLI-driven, `run-agent.sh`), tracker-free: no `inputJql`.
The caller passes everything through `customParams`; the engine's
issues-driven pass-through (`input/ticket.md`) arms the run.

## Parameters (customParams)

Configured via `customParams` in the runner config or the caller (values here are safe defaults).

| Param | Type | Meaning |
|---|---|---|
| `contextPath` | string (required) | Path to the CI context JSON file (absolute or repo-root-relative). Missing/unreadable => the run fails loudly before the CLI starts. |
| `dryRun` | bool/string | `true` (default): classify only — never create an issue. |
| `machineAuthor` | string | Login the follow-up dev leg gets assigned to (written into the issue when the verdict is adequate). |
| `targetRepository` | string/object | `"owner/repo"` (or `{repository}`) the runs belong to; absent => the runtime-configured GitHub repo applies. |

## CI context file format

```json
{
  "targetRepository": "owner/repo",
  "machineAuthor": "machine-user",
  "dryRun": false,
  "monitoredWorkflows": ["ci", "release"],
  "runs": [
    {"workflow": "ci", "url": "https://…/runs/1", "sha": "abc1234", "conclusion": "failure", "logTail": "…last ~200 lines…"},
    {"workflow": "ci", "url": "https://…/runs/2", "sha": "def5678", "conclusion": "success"}
  ]
}
```

## Lifecycle

1. `preCliJSAction` (`js/ciAnalystContext.js`) — reads `customParams.contextPath`,
   stages the content to `input/ci_analyst_context.md` and the resolved flags to
   `input/ci_analyst_params.json` (both fixed paths the prompt references).
2. CLI agent (`prompts/ci_analyst.md`) — reads the context, classifies each run
   (sha-aware: a failing old sha with a green newer sha is noise), writes
   `outputs/response.md` whose FIRST line is the strict verdict JSON
   `{"adequate": bool, "reason": str, "summary": str, "suspected_cause": str}`.
3. `postJSAction` (`js/ciAnalystPost.js`) — parses the verdict; when adequate
   and not dry-run: dedupe-searches open `ci-heal` issues with the same title,
   then creates ONE issue (labels `ci-heal`, `wf:<name>` per affected workflow,
   `agent:dev`; assignee `machineAuthor`) via `github_create_issue` /
   `github_add_labels` / `github_assign_issue`, recording
   `outputs/ci_analyst_result.json`.

## Output

- `outputs/response.md` — verdict JSON line + human-readable per-run explanation (always).
- `outputs/ci_analyst_result.json` — `{dryRun, verdictParsed, adequate, issueCreated, duplicate, issueUrl?…}`.
