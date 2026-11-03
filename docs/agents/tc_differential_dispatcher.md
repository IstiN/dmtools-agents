# tc differential dispatcher

Scripted CI dispatcher for parked differential rerun requests (TC-failure attribution, gh-1329 follow-up). A pure local-execution job — no AI CLI, the run is the verdict.

When a validated guard TC fails and the automation leg's evidence cannot attribute the failure, the bug parks a differential rerun request in the TC maintenance ledger and carries the `tc_differential_pending` label (the SM rule queries it). This job — dispatched on the next SM tick, before any TC generator re-dispatches the bug — settles the request mechanically:

1. **Run** — checkout the request's recorded last-green build (`lastGreenSha`) in the target repo and run the single TC script. Nothing but the build varies.
2. **Route** — green on the old build → the change range caused the failure: the bug earns its bounce (moved to Ready For Development, evidence named in the comment). Red on the old build → the failure predates the change: the finding reopens as maintenance-debt sweep work. The bounce cap reached → owner escalation. A sibling-guard request never bounces its own bug.
3. **Resolve** — post the updated ledger marker (the consumed parked section disappears), post the route report, and clear the park label when nothing remains parked.

Unrunnable requests (no checkout target, no run command configured) stay parked fail-safe: one explanation comment on first attempt, quiet bumps afterwards, and the request remains visible in every ledger digest — an attribution stall is never silent.

## Parameters

- `customParams.tcRunCommand` — the single-TC command template with a `{testPath}` placeholder (e.g. `pytest {testPath}`). Required for any request to run; without it all requests stay parked with an explanation comment.
- `customParams.workingDir` — the target-repo checkout the TC scripts and git commands run in (default: project config `workingDir`).
- `customParams.maxReworkRounds` — the earned-bounce cap before owner escalation (default: the triage engine's default).
- `customParams.parkLabel` — the SM-matching park label (default `tc_differential_pending`). When overridden, the SM rule's JQL (`labels = tc_differential_pending`) must be overridden to match.

The corresponding SM rule lives in `sm.json` (`Parked differential rerun requests → scripted CI dispatch`): it matches bugs carrying the park label, stamps its own `sm_tc_differential_triggered` crash-recovery label, and runs before the bug TC-generator rule so a parked bug is settled before a fresh generation dispatch (the generator rule also skips `tc_differential_pending` bugs).
