# Ci Analyst

CI failure analyst leg — the first stage of the CI self-heal loop (state machine
v2.3). It reads a prepared CI context file, classifies the failing workflow runs
with a three-way routing verdict — **repo-fixable** (root cause is in tracked repo files — a PR can close it; the repair agent gets
an assigned work item), **needs-human** (infra/token/flaky, unassigned escalation
issue), **noise** (silent close) — and emits a strict verdict JSON. The post
action owns all tracker side effects; dry-run and noise verdicts never touch the tracker or the SCM.

Teammate-type agent (CLI-driven, `run-agent.sh`), tracker-free: no `inputJql`.
The caller passes everything through `customParams`; the engine's
issues-driven pass-through (`input/ticket.md`) arms the run.

## Parameters (customParams)

Configured via `customParams` in the runner config or the caller (values here are safe defaults).

| Param | Type | Meaning |
|---|---|---|
| `contextPath` | string (required) | Path to the CI context JSON file (absolute or repo-root-relative). Missing/unreadable => the run fails loudly before the CLI starts. |
| `dryRun` | bool/string | `true` (default): classify only — never create an issue. |
| `machineAuthor` | string | Login the repair agent assignment goes to. REQUIRED for `repo-fixable` verdicts (not dry-run): empty/missing => loud business failure ({success:false} record + throw) BEFORE any tracker call — assignment is the repair-agent arming act, a silent unassigned work item would stall the loop. Not required for `needs-human`/`noise`. |
| `targetRepository` | string/object | `"owner/repo"` (or `{repository}`) the runs belong to; absent => the runtime-configured repository applies. |
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
- `classification` — open value list: `test_regression`/`build_break`/`config_error` (repo-fixable); `workflow_infra`/`infra`/`token`/`flaky`/`external_dependency` (needs-human); `network_flake`/`runner_infra`/`cancelled`/`stale_red_sha_reset`/`rate_limit`/`intentional_red` (noise). The list is open — pick the most precise tag.

A legacy v0.0.1 line carrying only `"repo-fixable": true|false` is still accepted
(true → repo-fixable, false → noise).

## Routing (post action)

| Verdict | Tracker side effects |
|---|---|
| `repo-fixable` | dedupe by title → create ONE `[ci-heal] <wf1,wf2>: failing` issue; labels `ci-heal`, `agent:dev`, `wf:<name>` per affected workflow; ASSIGN `machineAuthor` (arming act). Body carries summary, suspected cause, failing-run links, enumerated work list, log tail spoiler, and the `Closes #N` fix-protocol instruction (native close = closure-commit state anchor). Empty `machineAuthor` or a failed assignment => loud failure ({success:false} + throw). |
| `needs-human` | dedupe by title → create ONE `[ci-heal] <wf1,wf2>: failing (needs-human)` issue; labels `ci-heal`, `needs-human`, `agent:skip`, `wf:<name>`; NO assignment. Body adds an escalation paragraph and NO `Closes` instruction (manual triage). `agent:skip` sits in dev-on-assignment's notLabels — belt and suspenders against a later manual assignment. |
| `noise` | zero tracker calls. |
| any, dryRun | zero tracker calls. |

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

## Prompt structure (v0.0.6)

`prompts/ci_analyst.md` is platform-neutral (no tracker/SCM brand names) and
self-contained: Persona → **Hard rules** (classify-never-fix; zero side effects;
reason only over the context files; hard verdict contract) → **Glossary**
(lane, live sha, run window, tracked file, incident, repair agent, arming,
machineAuthor) → routing predicates (P0 noise / P1 needs-human / P2
repo-fixable / P3 undecidable, first match wins; 1a closed-incidents anchor;
1b open-incident linkage) → verdict line → report → loop routing → write path.
P0 includes INTENTIONAL RED (a tracked file declares its own failure by
design); P1 includes waiting-on-external-material; P2 is invariant-first with
a non-exhaustive example list. The prompt carries no version tags; the pack
version lives in the compiled artifact only.

_Human doc: [`agents/docs/agents/ci_analyst.md`](agents/docs/agents/ci_analyst.md)_

## Attributes

| Attribute | Value |
|---|---|
| Job | `Teammate` |
| Config | `ci_analyst.json` |
| ContextId | `ci_analyst` |
| outputType | `none` |
| skipAIProcessing | `true` |

## Actions


### preCliJSAction: `ciAnalystContext.js`

_CI Analyst — preCliJSAction: stage the CI failure context into the input folder._

- Source: `agents/js/ciAnalystContext.js`
- Parameters (customParams):
  - `contextPath`


### postJSAction: `ciAnalystPost.js`

_CI Analyst — postJSAction: parse the verdict, create ONE GitHub issue._

- Source: `agents/js/ciAnalystPost.js`
- Parameters (customParams):
  - `machineAuthor`
  - `targetRepository`


## LLM step

- outputType: `none`

## Custom params

- `contextPath`: `""`
- `dryRun`: `true`
- `machineAuthor`: `""`
- `targetRepository`: `""`

---
_Generated by js/agentDocGenerator.js_