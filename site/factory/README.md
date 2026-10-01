# Factory Board v2 (site/factory)

Real-time-ish board for the SM machine: three factories side by side (tabs),
cards flowing through the full label pipeline — development → PR → review →
approved queue → validating → merged — with lifecycle timestamps and a mini
SVG timeline per card. Zero build, zero tokens, zero rate limits: the data is
a JSON snapshot each factory's SM tick publishes to its repo's `factory-data`
branch (raw.githubusercontent CDN link).

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
2. Edit `config.js` — factories[] (stateUrl, accent), lanes, badgeLabels.
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
