# Factory Board v3 (site/factory)

Real-time-ish board for the SM machine: three factories side by side (tabs),
cards flowing through the full label pipeline — development → PR → review →
approved queue → validating → merged — with lifecycle timestamps, a mini
SVG timeline per card, readable per-lane progress, a details drawer
(state history + timings + token spend), and the issue backlog lanes.
Zero build, zero tokens, zero rate limits: the data is a JSON snapshot
each factory's SM tick publishes to its repo's `factory-data` branch
(raw.githubusercontent CDN link).

## Data flow

```
SM tick (sm_github.json, per factory repo)
  └─ end of pass: buildFactoryState() + publishFactoryState()
       └─ gh api PUT repos/O/R/contents/data/<asset>   (factory-data branch)
            └─ https://raw.githubusercontent.com/O/R/factory-data/data/<asset>
                 └─ board fetch() every refreshMs (schema 1 + 2 both render)
```

Factories on the board today:

| tab | repo | asset | state-publish |
| --- | --- | --- | --- |
| flutter_agent_harness | IstiN/flutter_agent_harness | `fa-state.json` | on |
| dmtools-dart | epam/dmtools-dart | `dart-state.json` | on |
| dmtools-agents | IstiN/dmtools-agents | `agents-state.json` | on |

## Deploy (any static host)

1. Copy this folder.
2. Edit `config.js` — factories[] (stateUrl, accent), lanes,
   backlogColumns, badgeLabels.
3. Style: only `:root` variables in `styles.css` (+ `data-theme="light"`
   overrides). Design tokens mirror `site/index.html` (slate palette,
   JetBrains Mono — embedded, no CDN). Embeddable via `?theme=light|dark`.

## Enable publishing for a factory (OPT-IN)

The machine workflow passes `state-publish` (JSON string) to factory-sm.yml:

```yaml
      state-publish: '{"channel":"release","tag":"factory-data","asset":"fa-state.json"}'
```

- `channel: 'release'` — the only channel today; anything else = off.
- `repo` — target repo (default: the tick's repo).
- `tag` — the data branch name (default `factory-data`; all three factories
  use it — the board URLs share the shape).
- `asset` — one asset per factory (`fa-state.json`, `dart-state.json`,
  `agents-state.json`).

## State schema (v2)

```json
{
  "schema": 2,
  "factory": "flutter_agent_harness",
  "repo": "IstiN/flutter_agent_harness",
  "tick": { "at": "...", "dryRun": false, "processed": ["pr-817"] },
  "checks": ["Quality gate", "JS engine integration (quickjs-ng)", "Binaries smoke gate"],
  "lanes": {
    "development":   [ { "issue": 315, "title": "...", "labels": ["agent:dev"],
                         "url": "https://github.com/O/R/issues/315",
                         "devStartedAt": "..." } ],
    "pr_created":    [ { "pr": 870, "title": "...", "labels": [],
                         "prCreated": "...", "checks": null } ],
    "review":        [ { "pr": 860, "labels": ["ai_pr_reviewed"],
                         "prCreated": "...", "reviewedAt": "..." } ],
    "approved_queue":[ { "pr": 828, "queuePos": 1, "approvedAt": "..." } ],
    "validating":    [ { "pr": 817, "checks": { "verdict": "in_progress",
                         "at": "...", "url": "..." }, "validatingAt": "..." } ],
    "merged_recent": [ { "pr": 801, "mergedAt": "...", "approvedAt": "...",
                         "validatingAt": "..." } ]
  },
  "counts": { "development": 1, "pr_created": 1, "review": 1,
              "approved_queue": 1, "validating": 1, "merged_recent": 1 }
}
```

Lanes are a deterministic read of the machine labels (the same predicates
the reconcile rules query), in PIPELINE order: `agent:dev` (no
`ai_developed`) → development; open, no machine labels → pr_created;
`ai_pr_reviewed` → review; `pr_approved` → approved_queue (FIFO by PR
number, `queuePos` 1-based); `ai_validating` → validating (mutex); merged
within 24h → merged_recent.

Timestamps on every card (the v2 feature — the pipeline becomes measurable):

- `prCreated` / `mergedAt` — GitHub fields (`created_at` / `merged_at`),
  exact from the first snapshot.
- `reviewedAt` / `approvedAt` / `validatingAt` / `devStartedAt` — label
  transition times, accumulated tick-over-tick: the tick fetches the
  previous snapshot off the `factory-data` branch (one `gh api` call),
  carries forward what it stamped before, and stamps `now` on transitions
  it witnesses (label present now, absent in the previous snapshot). Exact
  to the tick cadence (~10 min). First snapshot after the upgrade: these
  stay `null` until each card's next transition — honest unknowns, and the
  per-tick `<base>-history.json` snapshots keep the raw evidence.

The board renders schema 1 snapshots too (`fresh` maps onto `pr_created`,
timestamp chips simply don't render) — old history files never break it.

## v3 additions (owner 2026-10-03 — additive, schema stays 2)

Old snapshots render untouched; every new key is optional.

### `card.history` — state timeline (details drawer + timings)

Every card may carry `history: [{state, at}]` (oldest first), accumulated
tick-over-tick by the same mechanism as the v2 timestamps: carried
forward, appended when the tick witnesses a transition, capped at 24
entries. PR states are lane ids; issue states are backlog bucket ids.
The first entry after the upgrade carries no `at` (honest unknown). The
board falls back to deriving a timeline from the v2 timestamp fields when
`history` is absent, so pre-v3 snapshots still get a usable drawer.

### `backlog` — issues as board lanes

```json
"backlog": {
  "in_dev":  [ { "issue": 402, "title": "...", "assignee": "ai-teammate",
                 "labels": ["agent:dev"], "url": "...", "bucket": "in_dev",
                 "history": [...], "devStartedAt": "..." } ],
  "queued":  [], "blocked": [], "inbox": []
},
"backlogCounts": { "in_dev": 1, "queued": 0, "blocked": 0, "inbox": 0 }
```

Fed by ONE search call per tick (`repo:X is:issue is:open`). Bucketing is
a deterministic read of the machine's own signals, first match wins:

| bucket | signal |
| --- | --- |
| `blocked` | the `blocked` label — owner hold, its own visually distinct column |
| `in_dev` | assigned to the machine author (the `machineAuthor` deployment knob — a comma-separated login list, gh-728; unconfigured → no assignment bucketing at all) |
| `queued` | `agent:dev` label, not assigned |
| `inbox` | everything else (no label/assignee) |

**Page limit**: the search tool returns a single page (no `perPage` knob),
so a repo with more open issues than one page truncates at the source. Each
bucket is additionally capped at `BACKLOG_CAP` (50, newest kept) in
`js/factoryState.js` — the published snapshot stays bounded, and
`backlogCounts` always equal what the snapshot actually holds (a truncated
lane never masquerades as an empty one). A deployment with more issues than
that should narrow the query instead.

Issues carrying `ai_developed` have handed off to the PR side — they leave
the backlog (unless blocked). Backlog issues share one history array with
their development-lane twin, so the drawer tells the same story from both.

### `card.tokens` — OPTIONAL per-leg token spend

```json
"tokens": [ { "leg": "story_development", "at": "...", "prompt": 48210,
              "completion": 12980, "total": 61190 } ]
```

Keyed `pr-N` / `issue-N` in the builder's `tokens` input. Factories whose
legs report usage (fa's bench) drop a keyed JSON file into the tick's
checkout — `statePublish.tokensFile`, default
`outputs/token_usage/factory_tokens.json`; `readTokensFile()` picks it up
(or returns null on ANY miss — the tick never fails over tokens).
Factories that don't report tokens yet publish token-less cards and the
drawer renders `tokens — not reported by this factory`. The schema never
requires the key.

### Board surfaces

- **Lane summaries** — `N total · M done · K in-flight · Q queued` (+
  blocked) per lane, with a thin segmented progress bar (done / in-flight /
  queued / blocked). Done = merged; in-flight = dev leg running or mutex
  validating; queued = waiting on the next machine step; blocked = owner
  hold. Cards and timeline dots stay as decoration.
- **Details drawer** — click any PR/issue card: header (number, title,
  head sha, current state, labels, `open on github ↗` in a new tab), the
  state history newest-first with per-state timings (`2h13m` style) and
  proportional duration bars, then the token table (leg · when · prompt ·
  completion · total) with a per-card total. `esc`, the backdrop or ✕
  closes it; `?drawer=pr-817@validating` deep-links it.
- **Backlog section** — the four buckets render as columns under the PR
  pipeline; blocked is red-bordered. Same card interactions as the lanes.

## Visual-check fixtures

`visual-check/` holds the deterministic PNG fixtures + the bundled sample
snapshot they were captured from:

```
bash site/factory/visual-check/capture.sh   # needs a headless chromium
```

The board pins "now" to the fixture's tick in `?fixture=` mode, so frames
are reproducible; `fixture.json` exercises every surface (all six lanes,
all four backlog buckets, a token-reporting PR and a non-reporting one).
The drawer frame is captured open via the `?drawer=` deep link.
