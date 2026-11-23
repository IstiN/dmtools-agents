```mermaid
flowchart TD
    START([Maintainer leg starts]) --> READ["⚠️ Read ALL prepared input FIRST — instructions/common/input_context_reading.md"]
    READ --> PHASE{Phase?}
    PHASE -->|"plan (default)"| ANALYZE["Analyze structure and recent history:<br/>git log over the change window, gate signals<br/>(duplication clusters, size pressure, complexity hotspots), test state"]
    ANALYZE --> FINDINGS["Write outputs/maintainer-findings.md —<br/>every finding carries evidence: file, symbol, line, quote"]
    FINDINGS --> PLAN["Write outputs/maintainer-plan.md —<br/>target structure, what is deleted, what moves,<br/>what becomes unrepresentable, risks"]
    PLAN --> POST["Post findings + plan to the ticket — GFM"]
    POST --> STOP["⚠️ STOP — zero source changes in the plan phase.<br/>Fixes run only in the execute leg after owner approval"]
    STOP --> END_PLAN([End — awaiting approval])
    PHASE -->|"execute (isMaintainerExecute)"| APPROVED["Read the APPROVED plan from input/&lt;KEY&gt;/ —<br/>the owner's edited version wins"]
    APPROVED --> SCOPE{"Plan coherent and<br/>references still valid?"}
    SCOPE -->|No| ASK["Post ONE comment naming the contradiction,<br/>write outputs/blocked.json, STOP"]
    SCOPE -->|Yes| IMPLEMENT["Implement the approved structural changes —<br/>make each problem class unrepresentable:<br/>visibility, extraction, single sanctioned path, state shape"]
    IMPLEMENT --> GUARDS["Remove interim guards and absorbed tests<br/>in the same branch"]
    GUARDS --> TESTS["Update/delete tests that pin the old structure<br/>per test_guidelines"]
    TESTS --> GATE{"At a landable milestone or leg end:<br/>run the FULL suite<br/>(per step: only dart analyze)"}
    GATE -->|No| FIX["Adjust structure or tests per test_guidelines —<br/>never weaken a test to make it pass"]
    FIX --> GATE
    GATE -->|Yes| ACCEPT{"For every fixed finding: can you NAME the<br/>mechanism that makes it unrepresentable?"}
    ACCEPT -->|No| RETHINK["Redesign — a guard is not a fix"]
    RETHINK --> IMPLEMENT
    ACCEPT -->|Yes| PR["Write PR description to outputs/response.md:<br/>plan reference, per-finding unrepresentability mechanism,<br/>guards removed, tests changed, related fixes taken/filed"]
    PR --> END_EXECUTE([End — post-processing handles branch, commit and PR])
```

## The maintainer mandate

The role prompt carries the ownership sentence: you are the owner and
long-term maintainer of this codebase, and its design is up to you. This
leg is a structural quality pass — it exists because many changes landed,
quality degraded, and the debt now has a known shape.

The core rule of every maintainer decision: **a guard is not a fix**. A
finding is fixed only when its problem CLASS becomes unrepresentable —
there is no remaining way to do the wrong thing:

- visibility (private / library-private / package boundary),
- extraction or merge (the wrong shape becomes impossible to express),
- a single sanctioned path (the bypass is visible and lintable),
- state shape (an object whose surface cannot express the illegal state).

A check, a flag, or a comment is at most a temporary measure; if you ship
one, the PR body must name it as debt with the structural target.

## Phase contract

- **Plan phase (default)** — analysis and planning only. Zero source
  changes: the only writes are `outputs/maintainer-findings.md`,
  `outputs/maintainer-plan.md`, and the ticket comment. The fixes run in
  the execute leg after the owner approves (and edits) the plan.
- **Execute phase** (`maintainerPhase: "execute"`, execute appendix in the
  prompt chain) — implement exactly the approved plan. The owner's edited
  version of the plan wins over the original. Do not improve beyond the
  plan; related fixes discovered mid-flight follow the scope rule below.

## Scope rule

Execute the approved plan, nothing else. A related fix discovered mid-flight
is either tiny and adjacent (take it, list it under "related fixes taken" in
the PR body) or bigger (file an issue, name it in the PR body) — never a
silent change.

## Precedence over common guidelines

This file and `instructions/maintainer/coding_guidelines.md` OVERRIDE
`instructions/common/coding_guidelines.md` on maintainer legs: the
"never invent new patterns" freeze does not bind structural changes —
improving the structure is this role's mandate. What still binds: the
target repository's `AGENTS.md`, its formatting and conventions, and stable
public behavior (the plan may change behavior only where it says so).

## Tests

See `instructions/maintainer/test_guidelines.md`. Summary: all tests are
equal — update or delete tests that pin the old structure freely; the suite
must be green before finishing; never weaken a failing test to make it pass.

## Completion

The common completion rules apply on execute legs:
`instructions/common/git_completion_guard.md` and
`instructions/common/completion_post_check.md`. Prove the work landed on
the branch before writing any summary.
