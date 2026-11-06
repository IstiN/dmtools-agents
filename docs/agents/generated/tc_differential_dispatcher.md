# Tc Differential Dispatcher

Scripted CI dispatcher for parked differential rerun requests (TC-failure attribution, gh-1329 follow-up). A pure local-execution job — no AI CLI, the run is the verdict.

When a validated TC fails and the automation leg's evidence cannot attribute the failure, the bug parks a differential rerun request in the TC maintenance ledger and carries the `tc_differential_pending` label (the SM rule queries it). Validated guards and validated own-oracle TCs alike park these requests (gh-1354 routes the bug's own oracle through the mechanical triage table too). This job — dispatched on the next SM tick, before any TC generator re-dispatches the bug — settles the request mechanically:

1. **Run** — checkout the request's recorded last-green build (`lastGreenSha`) in the target repo and run the single TC script. Nothing but the build varies.
2. **Route** — green on the old build → the change range caused the failure. A guard request earns its bounce (moved to Ready For Development, evidence named in the comment); an own-oracle request hands to the AC re-check instead (a `rework` route — the AC verdict decides the bounce on the next automation lap, never an un-gated bounce). Red on the old build → the failure predates the change: the finding reopens as maintenance-debt sweep work (any role). The bounce cap reached → owner escalation. A sibling-guard request never bounces its own bug.
3. **Resolve** — post the updated ledger marker (the consumed parked section disappears), post the route report, and clear the park label when nothing remains parked.

Unrunnable requests (no checkout target, no run command configured) stay parked fail-safe: one explanation comment on first attempt, quiet bumps afterwards, and the request remains visible in every ledger digest — an attribution stall is never silent.

The dispatcher validates the ledger-controlled inputs before any command is built: `lastGreenSha` must be a 7–64 char hex git SHA and `testPath` a plain repo-relative path (no shell metacharacters, no leading dash, no `..`). A rejected value routes to the `unavailable` fail-safe — nothing is executed and the request stays parked.

The deployment guard also applies here: with no `machineAuthor` allowlist configured (`params.jobParams.machineAuthor` or `config.machineAuthor`), the maintenance ledger parse fails closed and cannot see parked requests — the dispatcher bails (`unconfigured_parked`) without clearing the park label, and drops only its own `sm_tc_differential_triggered` lock so the next tick retries once the allowlist is fixed. When a dispatch finishes with nothing left parked, the job removes both the `tc_differential_pending` park label and its `sm_tc_differential_triggered` trigger label — the SM-side `addLabel` stays the in-flight crash guard, and a later park on the same bug dispatches again.

## Parameters

- `tcRunCommand` (customParams) — the single-TC command template with a `{testPath}` placeholder (e.g. `pytest {testPath}`). Required for any request to run; without it all requests stay parked with an explanation comment.
- `workingDir` (customParams) — the target-repo checkout the TC scripts and git commands run in (default: project config `workingDir`).
- `maxReworkRounds` (customParams) — the earned-bounce cap before owner escalation (default: the triage engine's default).
- `parkLabel` (customParams) — the SM-matching park label (default `tc_differential_pending`). When overridden, the SM rule's JQL (`labels = tc_differential_pending`) must be overridden to match.

The corresponding SM rule lives in `sm.json` (`Parked differential rerun requests → scripted CI dispatch`): it matches bugs carrying the park label, stamps its own `sm_tc_differential_triggered` crash-recovery label, and runs before the bug TC-generator rule so a parked bug is settled before a fresh generation dispatch (the generator rule also skips `tc_differential_pending` bugs).

_Human doc: [`agents/docs/agents/tc_differential_dispatcher.md`](agents/docs/agents/tc_differential_dispatcher.md)_

## Attributes

| Attribute | Value |
|---|---|
| Job | `JSRunner` |
| Config | `tc_differential_dispatcher.json` |
| ContextId | `—` |
| outputType | `—` |
| skipAIProcessing | `false` |

## Prompt snapshot

Full prompt / instruction set: [`agents/snapshots/tc_differential_dispatcher.md`](agents/snapshots/tc_differential_dispatcher.md)

## Actions




### postJSAction: `tcDifferentialDispatcher.js`

_tcDifferentialDispatcher.js — the gh-1345 scripted CI dispatcher for parked_

- Source: `agents/js/tcDifferentialDispatcher.js`
- Side effects:
  - post ticket comment (via tracker)
  - move ticket to status (via tracker)
- Parameters (customParams):
  - `maxReworkRounds`
  - `parkLabel`
  - `tcRunCommand`
  - `workingDir`


## LLM step

- outputType: `none`
- Prompt snapshot: `agents/snapshots/tc_differential_dispatcher.md`

## Custom params

- `maxReworkRounds` _(used by JS action)_
- `parkLabel` _(used by JS action)_
- `tcRunCommand` _(used by JS action)_
- `workingDir` _(used by JS action)_

---
_Generated by js/agentDocGenerator.js_