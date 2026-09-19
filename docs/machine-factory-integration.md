# Machine Loop Factory — Integration Guide

How to install the AI development factory (dev → PR → CI → review → merge,
fully autonomous, human only files issues) into a GitHub repository using
dmtools + dmtools-agents. This is the exact setup running on
`epam/dmtools-dart`; the same recipe ports any repo, including non-dmtools
projects.

---

## 1. What you get

```
            ┌──────────────────────── the loop ────────────────────────┐
 issue with  │                                                          │
 agent:dev ──┤  dev leg ──► PR ──► CI (quality) ──► review leg ──┬─► APPROVE ─► merge ─► issue closed
             │   (fa)                (GitHub Actions)   (fa+kimi  │
             │                          │ red?           queue)   └─► CHANGES ─► rework leg ─┐
             │                          ▼                                              │
             │                    rework leg ◄───────────────────────────────────────────┘
             └──────────────────────────────────────────────────────────────────────────┘
 SM watchdog (cron */10, deterministic, no LLM): sees dead letters, stale
 labels, review-ready PRs, approved PRs → dispatches the right leg, merges
 (FIFO, 1 per tick), recovers stuck cycles.
```

Design invariants:

- **The tracker is the state machine.** GitHub issue labels + PR facts are
  the single source of truth. No SM-side database: every tick re-derives
  state from the API (level-triggered controller — a lost event cannot
  corrupt the loop; the next tick heals it).
- **Two state carriers**: an issue (the normal case — label lifecycle on
  the issue, the linked PR enriches observations like `prChecks`), or a PR
  alone (`type: 'pr'` rules — for PRs born without an issue).
- **SM is deterministic** (JSRunner, no LLM): the loop can always converge
  even when every AI leg is down.

---

## 2. Components

| Component | Where | Role |
|---|---|---|
| **factory/teammate.yml** | **dmtools-agents** (`.github/workflows/factory/`, reusable) | the legs: `guard → dev/review/rework` jobs, dmtools + `fa` agent |
| **factory/sm.yml** | **dmtools-agents** (reusable) | SM watchdog tick: rules → reconcile |
| thin stubs (~15 lines each) | target repo `.github/workflows/` | ONLY triggers + concurrency + `uses:` call |
| `smAgent.js` + `sm/` | dmtools-agents (`js/smAgent.js`, `js/sm/sources/`, `js/common/smProvider.js`) | engine: rules → state query → dispatch/local execution |
| `sm_github.json` | dmtools-agents (repo root) | default GitHub rule pack |
| runners (`fa-*.json`) | dmtools-agents (`configs/runners/`) | per-leg agent configs (prompts, models, timers) |
| `.dmtools/config.js` | target repo root | repo-specific overrides (rules, repository, workflow names) |
| `merge-trigger.yml` | target repo (optional fast-path) | merges on `pr_approved` + green main (`workflow_run` cannot live in a reusable) |
| `auto-update-prs.yml` | target repo (optional) | blanket branch updates — see §9 before enabling |

The factory workflows are **reusable** (`workflow_call`): they execute in
the CALLER's context — `github.repository`, `vars.*` and `secrets.*`
resolve from the target repo, and the engine is self-pinned via
`github.workflow_ref` (runners/scripts always match the invoked ref). The
dmtools CLI installs from its release asset (version-locked), so the
target repo needs no copies of anything.

---

## 3. Prerequisites

### 3.1 Repo settings
- **Branch protection on `main`, strict**: required checks = your quality
  workflow's jobs; require branches up to date. The machine only merges
  `CLEAN` PRs, so protection defines "ready".
- Actions → Allow all actions (or allowlist `dmtools`, `sub-mod`, `ephm`).

### 3.2 Secrets (repo or org)

| Secret | Used by | Notes |
|---|---|---|
| `SOURCE_GITHUB_TOKEN` | ai-teammate legs, auto-update | **PAT of the machine account** (not the default `GITHUB_TOKEN`): labels added with `GITHUB_TOKEN` do not fire `issues:` events (#116 lesson), and bot pushes must not be `github-actions[bot]` (non-collaborator → runs land in `action_required`). |
| `PAT_TOKEN` | auto-update (first choice) | owner PAT; pushes with it definitely trigger downstream CI |
| `ZAI_CODE_KEY` | dev/rework legs | z.ai API key (glm) |
| `KIMI_REVIEW_KEY` | review leg | kimi API key |

### 3.3 Variables (repo or org)

| Var | Example | Notes |
|---|---|---|
| `FA_VERSION_MACHINE` | `v0.1.392` | pins the `fa` CLI for the machine; falls back `FA_VERSION` (org) → `latest` |
| `DMTOOLS_VERSION` | `v0.1.14` | pins the dmtools CLI release bundle the workflows install |
| `FLUTTER_VERSION` | `stable` | Flutter SDK for agent work, cached per version (flutter-action). Empty string opts out — pure-Dart targets get `dart` from the runner image |
| `SM_AGENTS_REF` | `<sha>` | pin of dmtools-agents the SM uses (a branch **hash**, not a mutable ref) |
| `MERGE_TRIGGER_ENABLED` | `true` | fuse for merge-trigger.yml |

### 3.4 dmtools.env (repo root, git-ignored) — for local runs
```
SOURCE_GITHUB_TOKEN=<pat>
SOURCE_GITHUB_WORKSPACE=<owner>
SOURCE_GITHUB_REPOSITORY=<repo>
DMTOOLS_TRACKER_REPO=<owner>/<repo>
DEFAULT_TRACKER=github
```
CI gets the same values from secrets/vars; the file is only for local
dry runs of the engine.

---

## 4. Step-by-step integration

### Step 1 — workflows (two thin stubs)
Drop these into the target repo `.github/workflows/` — nothing else:

```yaml
# factory-teammate.yml
name: 'AI Teammate'
on:
  issues: { types: [assigned, labeled] }
  workflow_dispatch:
    inputs:
      issue: { description: Issue number, required: true, type: number }
      leg: { description: 'dev | review | rework (empty = derive)', required: false, type: string }
concurrency:
  group: ai-teammate-issue-${{ github.event.issue.number || inputs.issue }}
  cancel-in-progress: false
jobs:
  factory:
    uses: IstiN/dmtools-agents/.github/workflows/factory-teammate.yml@main
    with:
      issue: ${{ github.event.issue.number || inputs.issue }}
      leg: ${{ inputs.leg || '' }}
    secrets: inherit
```

```yaml
# factory-sm.yml
name: 'Machine SM'
on:
  schedule: [{ cron: '*/10 * * * *' }]
  workflow_dispatch:
    inputs:
      dryRun: { description: Log only, required: false, type: boolean, default: true }
concurrency:
  group: machine-sm
  cancel-in-progress: false
jobs:
  sm:
    uses: IstiN/dmtools-agents/.github/workflows/factory-sm.yml@main
    with:
      dryRun: ${{ inputs.dryRun || false }}
    secrets: inherit
```

Pin `@main` to a tag/sha of dmtools-agents for production (the factory
version then moves in lockstep with the engine).

### Step 2 — rules
Start from `configs/sm_github.json`. The default pack encodes the loop:

```jsonc
[
  // red CI + agent:rework label, no run in flight → rework leg
  { "description": "red CI → rework",
    "source": "github",
    "query": { "type": "issue", "labels": ["agent:rework"], "prChecks": "red" },
    "configFile": "configs/runners/fa-rework-zai.json" },

  // dev finished (ai_developed), PR green, not yet reviewed → review leg
  { "description": "green after dev → review",
    "query": { "type": "issue", "labels": ["ai_developed"],
               "notLabels": ["ai_pr_reviewed"], "prChecks": "green" },
    "configFile": "configs/runners/fa-review-kimi.json" },

  // approved + green + mergeable → merge, oldest first, one per tick
  { "description": "approved → merge (FIFO, 1/tick)",
    "query": { "type": "pr", "labels": ["pr_approved"],
               "checks": "green", "mergeable": true },
    "configFile": "configs/retry_merge_github.json",
    "localExecution": true, "limit": 1 }
]
```

Repo-specific tuning goes to `.dmtools/config.js` in the target repo:

```js
module.exports = {
  machineSm: {
    repository: { owner: 'epam', repo: 'dmtools-dart' },
    workflowFile: 'ai-teammate.yml',
    workflowBudget: { maxWorkflows: 1 },
    rules: [ /* full rules or per-description overrides */ ]
  }
};
```

### Step 3 — labels
The pack relies on this taxonomy (all configurable via rules):

| Label | Set by | Meaning |
|---|---|---|
| `agent:dev` / `agent:review` / `agent:rework` | human / SM | leg request (dead-letter safe: SM re-fires) |
| `ai_developed` | dev leg | PR exists, hands to review |
| `ai_pr_reviewed` | review leg | review verdict produced |
| `pr_approved` / `agent:rework` | review leg | verdict |
| `needs-human` | SM / review leg | round cap exceeded or unrecoverable |
| `rework-round-<n>` | rework leg | round counter (cap 2) |

### Step 4 — verification (dry tick)
```bash
gh workflow run machine-sm.yml -f dryRun=true
```
Expect a log like:
```
SM Agent — <owner>/<repo> (3 rules)
══ red CI → rework ══
Query[github]: {...} → no items
...
{"success":true,"processed":0,"skipped":0}
```
File a real issue with `agent:dev`, watch the dev leg fire, then let the
tick schedule take over. The loop is self-driving from here.

---

## 5. Rule language reference

**Query** (issue carrier):
- `type: 'issue'`, `labels: [...]` (ANY-of), `notLabels: [...]` (NONE-of),
  `branchPrefix`, `prChecks: 'green'|'red'|'pending'|'none'` — evaluated
  against the **linked PR** (matched by `Closes #N` body link first, then
  `ai/<key>`-style branch), `linkedOnly: true` to require a PR.

**Query** (PR carrier): `type: 'pr'`, `labels`/`notLabels` on the **PR**,
`checks`, `mergeable`, `mergeState`, `draft`, `author`, `branchPrefix`.

**Effects**: `configFile` + `workflowFile` (dispatch a leg with the
ticket key), `localExecution: true` (run the config's action in-process —
merges, label moves; no runner spent), `limit: N` (per tick), `addLabels`
/ `removeLabel` (idempotency marks), `inputs` (extra workflow_dispatch
inputs).

**Semantics worth knowing**:
- **FIFO**: PR candidates are sorted oldest-first (`github_list_prs`
  returns newest-first; the source re-sorts). With `limit: 1` the merge
  rule drains the oldest MERGEABLE PR — blocked candidates (conflict /
  red / pending) are guard-filtered and never starve the queue.
- **In-flight dedup**: before dispatching, the engine lists workflow runs
  matching `<configFile> : <ticketKey>`; a running leg is never double-fired.
- **Stale local locks**: `localExecution` failures recover automatically
  on the next tick (the trigger-label guard is reset).
- **Budget**: `workflowBudget.maxWorkflows` caps concurrent dispatched
  legs repo-wide.

---

## 5a. Runners and instructions — who owns what

- **The factory ships NO repo-specific runners.** Runner configs (agent
  providers, models, queue, tracker wiring) live in the TARGET repo at
  `.dmtools/runners/*.json` and are wired via `.dmtools/config.js`:

```js
module.exports = {
  sm: {
    runners: {
      bug:    '.dmtools/runners/fa-bug-dev.json',
      story:  '.dmtools/runners/fa-story-dev.json',   // or a single 'dev' for both
      review: '.dmtools/runners/fa-review-kimi.json',
      rework: '.dmtools/runners/fa-rework-zai.json'
    }
  }
};
```

  The factory guard fails fast with a pointer to this section when the
  config or a slot is missing. Parent pipelines (bug_development /
  story_development / pr_review / pr_rework) resolve by SLOT inside the
  agents checkout, so a custom runner inherits session and verdict
  semantics automatically.

- **Instruction files are part of dmtools-agents** (extensions of the
  default agents): `instructions/common/github_comment_format.md`,
  `instructions/pr_review/review_verdict_rules.md`. Runner configs
  reference them through the agents checkout mount:
  `./factory-agents/instructions/…`.

### Patching rules — `smRuleOverrides`

Rules carry stable ids (`rework-on-red-ci`, `review-after-dev`,
`silent-update-behind`). Patch any field or disable a rule entirely:

```js
module.exports = {
  smRuleOverrides: {
    'validate-armed':       { limit: 2 },     // validate two PRs per tick
    'rework-on-red-ci':     { enabled: false } // manual rework only
  }
};
```

Jira-style rules still match by `configFile` key.

### PR lifecycle rules (#687) — test once per state

The merge loop is PR-carried (issue labels stay the dev→review contract):
`silent-update-behind` (ANY behind open non-draft PR → silent `github.token`
refresh, no CI — free freshness, the retired auto-update-prs workflow's
replacement; validating PRs excluded so their head never moves mid-run),
`validate-armed` (merge window: PAT update fires validation CI on the
final head + `ai_validating` marker), `fail-validation` (red → unarm,
report, re-arm `agent:rework` on the linked issue), `merge-validated`
(green + CLEAN → squash-merge, markers cleared). Note `labels` in SM
queries are **OR**-matched — the validating rules key on `ai_validating`
alone because it only ever lands on armed (`pr_approved`) PRs. Reviews of
PRs born without an issue: `review-external-once` (any non-machine author,
green checks, once — `ai_pr_reviewed` blocks re-review on later pushes)
and `review-on-label` (`agent:review` on the PR, any author; the review
runner consumes the label). PR-anchored factory dispatches pass `pr`
instead of `issue`; the anchor rides the `pr-N` contextId into the agent
scripts (`preparePRForReview` / `postPRReviewComments`).

**Machine author is a deployment knob, never a rule field:** the agents
repo carries no bot login. Every machine-keyed guard (the `notMachine`
filter in `review-external-once`, the `pr_approved` arming gate, the
rework re-arm in PR-anchored reviews) resolves through one helper —
`js/common/machineAuthor.js` → `resolveMachineAuthor(jobParams, config)`:

1. `jobParams.machineAuthor` — **the JSON parameter at factory setup**.
   The factory-sm reusable workflow takes a `machine-author` input; it
   lands in the `dmtools run` override as
   `{"params":{"jobParams":{...,"machineAuthor":"<login>"}}}`. This is the
   global level: set once by the harness (machine-sm.yml
   `machine-author:`), valid for every repo the factory runs against.
2. `config.machineAuthor` — **the per-repo `.dmtools/config.js` knob**,
   for fleets where different repos run different bots:
   `module.exports = { machineAuthor: 'my-bot' };`
3. `null` — unconfigured. All guards keyed on it are inert: every green
   PR is reviewable, and a PR-anchored APPROVE never arms `pr_approved`
   nor re-arms `agent:rework` (external semantics — the verdict comment
   is the whole report).

## 6. The legs (runners)

| Runner | Model | What it does |
|---|---|---|
| `fa-bug-dev.json` / `fa-story-dev.json` | z.ai glm | reads the issue body as spec, TDD, PR + summary |
| `fa-review-kimi.json` | kimi (queue head) | reviews the linked PR; posts verdict comment + labels; formal `APPROVE` when tokens allow (own-PR → falls back to labels) |
| `fa-rework-zai.json` | z.ai glm | reads review threads + CI logs, fixes, re-pushes |
| `retry_merge_github.json` | — (deterministic) | squash-merge + issue close + comment |

Review queue (provider failover) is configured in the review runner's
`envVariables`: `FA_PROVIDERS_QUEUE='[{"provider":"kimi",...},{"provider":"zai","model":"glm-5.3"}]'`
— first healthy provider wins.

All runners share the `timerAutoCommitAndSave` WIP timer (5 min commits,
`[skip ci]`-able — see §9) and tracker-aware comment formatting
(`commentMarkup.js`: jira wiki vs markdown by ticket-key shape).

---

## 7. What each tick does (deterministic SM)

1. Load rules (pack → `.dmtools/config.js` deep-merge).
2. For each rule: query the carrier (issues / PRs), filter by guards,
   sort FIFO, apply `limit`.
3. For each item: skip if a leg is already in flight for it; dispatch the
   leg (workflow_dispatch with the ticket key + leg) or execute locally
   (merge/labels).
4. Emit `{"success":true,"processed":N,...}` and exit. Ticks are cheap
   (seconds, no LLM).

---

## 8. Troubleshooting (field-tested)

| Symptom | Cause | Fix |
|---|---|---|
| Legs never fire from labels | labels added with `GITHUB_TOKEN` don't emit events | use `SOURCE_GITHUB_TOKEN` PAT in legs; SM re-fires dead letters anyway |
| SM tick dies instantly, `Bad substitution` | script run via `sh` (dash) | call installers with `bash` |
| `github_*` tools "not found" in tick | `SOURCE_GITHUB_TOKEN` not in the job env → tools not exposed | add env to the reconcile job |
| Tool works locally, missing on CI | version drift: pinned `DMTOOLS_VERSION` older than the tool | bump the var / cut a release |
| Merge declined: `2 of 2 required status checks` | branch BEHIND after a parallel merge | update-branch, let checks re-run (or SM's FIFO + limit:1 to serialize) |
| PR branch update doesn't trigger CI | update pushed with `github.token` | PAT chain in auto-update (§2 comments) |
| Review leg completes, no verdict | runner died mid-run (old fa bug) | fa ≥ 0.1.387 (headless compaction fix); queue failover also helps |
| Stale `agent:rework` with no run | dead letter | SM recovers on the next tick by design |

---

## 9. CI cost policy (choose deliberately)

After every merge to main, three things can re-run CI:

1. quality on main (unavoidable, ×1);
2. branch updates of open PRs (each = a full matrix);
3. the next merge in the cascade (its main run).

Options for (2):

- **A. dm.ai heritage**: `auto-update-prs.yml` updates **every** open
  non-draft PR after every main push. Fastest merges, cost O(N) matrices
  per merge (the fa#523 problem at small scale).
- **B. Approved-only updates**: same workflow + a label filter
  (`pr_approved`). Halves the burn, keeps approved PRs always mergeable.
- **C. SM-driven (recommended)**: retire the blanket bot; the SM rule
  `approved + BEHIND → update` with `limit: 1` refreshes only the head of
  the merge queue, oldest first. Cost ~2 runs per merge; merge latency
  bounded by the tick cadence (10 min). This is the policy to port to
  repositories with many open PRs.

---

## 10. Porting beyond GitHub

`smProvider.js` already speaks GitLab (`gitlab_*` tools: issues, MRs,
pipelines, rebase/merge/approve). Set `scm.provider: 'gitlab'` in the
config; dispatch effects become pipeline triggers with variables
(`issue`, `leg`). Known conservative gaps (documented in the provider):
issue-close and pipeline→issue mapping need runner-side handling.
Jira-backed state is the original smAgent path (`source: 'jira'`, JQL
rules) — the same engine drives both, so a mixed fleet is fine.
