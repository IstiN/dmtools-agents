# gh-1351 dry-run evidence — reviewPolicy config + verdict layer

Dry-run of the gh-1351 leg (epic gh-1328 step 2/4) in a non-production test
deployment: the `dmtools` GraalJS runtime (v0.1.88, the same runner the
agent-pack release job gates on) executing the real leg actions end-to-end
with mock-injected SCM/tracker/file boundaries — no external service is
touched, nothing is posted. Every acceptance replay case below ran through
`dmtools run js/unit-tests/run_<suite>.json` and passed.

## Suite results (production runtime, this deployment)

| Suite | Cases | Result |
|---|---|---|
| `run_reviewPolicy.json` | 66 | ✅ 0 failed |
| `run_postPRReviewComments.json` | 159 | ✅ 0 failed |
| `run_reviewVerdicts.json` | 100 | ✅ 0 failed |
| `run_preparePRForReview.json` | 37 | ✅ 0 failed |
| `run_prepareTestPRForReview.json` | 38 | ✅ 0 failed |
| `run_preCliReworkSetup.json` | 91 | ✅ 0 failed |
| `run_preCliTestReworkSetup.json` | 39 | ✅ 0 failed |
| `run_preCliStoryTestAutomationSetup.json` | 32 | ✅ 0 failed |
| `run_all.json` (full suite) | 8430 | ✅ 0 failed |

## Acceptance replays → observed evidence

### 1. Policy replays

| Case | Evidence (captured line) |
|---|---|
| `fix-everything` nit-only round runs polish-shaped budget checks | `✅ fix-everything preset: nits always fixed (polish + mandatory)` |
| `relaxed` repo suggestion-only APPROVEs | `✅ relaxed policy still gates on blocking/important; suggestion-only census is clean` + `✅ machineApprovalDecision: REQUEST_CHANGES + only suggestions/nits → recomputed APPROVE (convergence)` |
| `investigation` repo closes 🚨 via triage config | `✅ investigation policy: nothing gates — every census is clean` + `✅ machineApprovalDecision: investigation policy approves over a blocking census (explicit owner config)` |
| missing config → default silently | `✅ missing config + missing jobParams → built-in default, silent` |
| unknown tier → leg fails with validation message | all four legs fail at start: `ReviewPolicyValidationError: reviewPolicy.severities has unknown tier(s): BOGUS/WAT/NOPE/HUH — known tiers: BLOCKING, IMPORTANT, SUGGESTION, NIT` (preparePRForReview, prepareTestPRForReview, preCliTestReworkSetup, preCliStoryTestAutomationSetup logs) |

### 2. IMPORTANT replay

| Case | Evidence |
|---|---|
| review with ⚠️ open → REQUEST_CHANGES | `⚖️ Machine enforcement (gh-1351): advisory APPROVE → effective REQUEST_CHANGES — ⚠️ IMPORTANT open (1) — gates approval per reviewPolicy` + `✅ IMPORTANT gates approval (gh-1351): allowApproveWithSuggestions cannot approve an open ⚠️` |
| rework → census important 0 → APPROVE | `⚖️ Machine enforcement (gh-1351): advisory REQUEST_CHANGES → effective APPROVE — no rework-tier threads open (only polish/none tiers) — converges per reviewPolicy` |
| rework armed on open ⚠️ | `✅ armReworkDecision: APPROVE + important > 0 arms important-threads` + `✅ reconcileDecision: APPROVE winner with important > 0 keeps the rework arm (census exception)` |
| false ⚠️ → downgrade-with-justification converges | downgrade protocol is contractual, no code change: `review_policy.md` run context + `instructions/pr_review/review_verdict_rules.md` carry it (`✅ carries the downgrade protocol wording (epic §3 escape hatch)`); the review instructions classify a justified downgrade 💡 in the next census, so the same machine gate converges to APPROVE |

### 3. Density replay

| Case | Evidence |
|---|---|
| cap formula calibration | `✅ calibrated formula: 20→3 · 50→4 · 200→5 · 800→8` |
| 10 💡 on a 50-line diff → ranked digest overflow | `density audit (gh-1351): 10 💡/🪶 threads posted on a ~50-line diff — the policy cap allows 4; rank findings, post top-K as threads, overflow becomes a ranked digest list in the general comment` (warn-only, leg stays green: `✅ density audit: over-posted 💡 threads warn (never fail the leg)`); census counts posted threads + digest: `✅ densityAudit: digest lines are not posted threads — 2 posted + 8 digest does not overflow` (census `threads=2, digest=8` = 10 findings) |
| 1 💡 on a 1000-line diff uncapped | `✅ 1 suggestion on a 1000-line diff is uncapped (allowed 8 ≥ 1)` |
| 🚨/⚠️ never capped | `✅ densityAudit: blocking/important threads never cap (not counted as posted 💡/🪶)` |

### 4. Legacy-knob replay

| Case | Evidence |
|---|---|
| `allowApproveWithSuggestions` conflict logged + policy wins | `✅ allowApproveWithSuggestions=false conflicts → logged, policy wins` + action-level `✅ legacy knob conflict: allowApproveWithSuggestions=false + suggestion-only census → policy wins, conflict logged`; agreeing value stays silent (`✅ allowApproveWithSuggestions=true agrees with the policy — no conflict line`) |
| `importantBlocksApproval` derived from the policy | `✅ importantBlocksApproval is derived from the policy table` + `✅ importantBlocksApproval=false conflicts with a rework-round IMPORTANT → logged` |
| `maxReviewThreadsBeforeForceApprove` rejected | `✅ maxReviewThreadsBeforeForceApprove is rejected alongside the policy (density bounds own budgets)` — the force-approve machinery is removed; thread budgets are policy bounds |

### 5. Policy stamp into run contexts

`review_policy.md` stamped on every review/rework leg (captured on all five
setup actions):

```
✅ Review policy stamped into the run context (review_policy.md, preset default)
```

## Quality gates (same deployment)

- crap4js ratchet vs the released `crap-baseline` asset: `0 regression(s), 0 new over threshold` (exit 0)
- duplication ratchet: `duplication ratchet: OK — no new/regressed duplication` (exit 0)
- crap4dart similarity gate: `[PASS] similarity: 358 files scanned, no similar files`
- generated docs/snapshots: regenerated and committed (`node js/agentDocGenerator.js && node generate_agent_snapshots.js`)
