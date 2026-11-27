# ci_analyst

CI failure analyst leg — the first stage of the CI self-heal loop (state machine
v2.3). It reads a prepared CI context file, classifies the failing workflow runs
with a three-way routing verdict — **repo-fixable** (root cause is in tracked repo files — a PR can close it; dev leg gets
an assigned issue), **needs-human** (infra/token/flaky, unassigned escalation
issue), **noise** (silent close) — and emits a strict verdict JSON. The post
action owns all GitHub side effects; dry-run and noise verdicts never touch GitHub.

Teammate-type agent (CLI-driven, `run-agent.sh`), tracker-free: no `inputJql`.
The caller passes everything through `customParams`; the engine's
issues-driven pass-through (`input/ticket.md`) arms the run.

## Parameters (customParams)

Configured via `customParams` in the runner config or the caller (values here are safe defaults).

| Param | Type | Meaning |
|---|---|---|
| `contextPath` | string (required) | Path to the CI context JSON file (absolute or repo-root-relative). Missing/unreadable => the run fails loudly before the CLI starts. |
| `dryRun` | bool/string | `true` (default): classify only — never create an issue. |
| `machineAuthor` | string | Login the follow-up dev leg gets assigned to. REQUIRED for `repo-fixable` verdicts (not dry-run): empty/missing => loud business failure ({success:false} record + throw) BEFORE any GitHub call — assignment is the dev-leg arming act, a silent unassigned issue would stall the loop. Not required for `needs-human`/`noise`. |
| `targetRepository` | string/object | `"owner/repo"` (or `{repository}`) the runs belong to; absent => the runtime-configured GitHub repo applies. |
| `previousIncidents` | array (optional) | `[{issue, title, closedAt, closedByCommit}]` follow-up anchors. Normally staged inside the context file; customParams is a fallback. Passed through verbatim. |

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
  ],
  "previousIncidents": [
    {"issue": 12, "title": "[ci-heal] ci: failing", "closedAt": "2026-11-24T10:00:00Z", "closedByCommit": "abc1234def"}
  ]
}
```

`previousIncidents` is optional and passed through verbatim. The kicker resolves
descendants (git compare) BEFORE the leg runs; the analyst treats failing runs at
or below a `closedByCommit` as that incident's history (stale for the same cause)
and only SHAs strictly newer than all closure commits as live evidence.

## Verdict contract (v2.3)

First line of `outputs/response.md`, strict JSON:

```json
{"verdict": "repo-fixable|needs-human|noise", "classification": "<tag>", "reason": "<tag>", "summary": "…", "suspected_cause": "…", "suggestedFix": "…"}
```

- `verdict` — the routing key: `repo-fixable`, `needs-human`, `noise`.
- `classification` — open value list: `test_regression`/`build_break`/`config_error` (repo-fixable); `workflow_infra`/`infra`/`token`/`flaky` (needs-human); `network_flake`/`runner_infra`/`cancelled`/`stale_red_sha_reset`/`rate_limit` (noise).

A legacy v0.0.1 line carrying only `"repo-fixable": true|false` is still accepted
(true → repo-fixable, false → noise).

## Routing (post action)

| Verdict | GitHub side effects |
|---|---|
| `repo-fixable` | dedupe by title → create ONE `[ci-heal] <wf1,wf2>: failing` issue; labels `ci-heal`, `agent:dev`, `wf:<name>` per affected workflow; ASSIGN `machineAuthor` (arming act). Body carries summary, suspected cause, failing-run links, enumerated work list, log tail spoiler, and the `Closes #N` fix-protocol instruction (native close = closure-commit state anchor). Empty `machineAuthor` or a failed assignment => loud failure ({success:false} + throw). |
| `needs-human` | dedupe by title → create ONE `[ci-heal] <wf1,wf2>: failing (needs-human)` issue; labels `ci-heal`, `needs-human`, `agent:skip`, `wf:<name>`; NO assignment. Body adds an escalation paragraph and NO `Closes` instruction (manual triage). `agent:skip` sits in dev-on-assignment's notLabels — belt and suspenders against a later manual assignment. |
| `noise` | zero GitHub calls. |
| any, dryRun | zero GitHub calls. |

NO reopen of previous issues, ever: follow-ups are NEW issues whose bodies carry
`Follows up #<issue> (closed at <short sha>)` per `previousIncidents` entry. The
post action structurally never calls a reopen/update-issue API.

## Lifecycle

1. `preCliJSAction` (`js/ciAnalystContext.js`) — reads `customParams.contextPath`,
   stages the context content VERBATIM (unknown fields like `previousIncidents`
   survive) to `input/ci_analyst_context.md` and the resolved flags to
   `input/ci_analyst_params.json` (both fixed paths the prompt references).
2. CLI agent (`prompts/ci_analyst.md`) — reads the context, classifies each run
   (sha-aware, closed-incident aware), writes `outputs/response.md` whose FIRST
   line is the strict verdict JSON above.
3. `postJSAction` (`js/ciAnalystPost.js`) — parses the verdict and routes (table
   above), recording `outputs/ci_analyst_result.json`.

## Output

- `outputs/response.md` — verdict JSON line + human-readable per-run explanation with the enumerated live-cause work list (always).
- `outputs/ci_analyst_result.json` — `{dryRun, verdictParsed, verdict, repo-fixable, classification?, issueCreated, duplicate, issueUrl?, issueNumber?, labels?, assignedTo?, needsHuman?, success?:false, error?/assignError?}`.
