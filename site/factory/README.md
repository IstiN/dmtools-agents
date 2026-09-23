# Factory Board (site/factory)

Real-time-ish board for the SM machine: PRs flowing through the label state
machine, per-head validation verdicts, tick heartbeat. Zero build, zero
tokens, zero rate limits — the data is a JSON snapshot the SM tick itself
publishes as a **public prerelease asset** (draft releases are private, so
the asset lives on a published prerelease tag).

## Data flow

```
SM tick (sm_github.json)
  └─ end of pass: buildFactoryState() + publishFactoryState()
       └─ gh release upload <tag> <asset> --clobber     (silent token)
            └─ https://github.com/O/R/releases/latest/download/<asset>
                 └─ board fetch() every refreshMs
```

## Deploy (any static host)

1. Copy this folder.
2. Edit `config.js` — factories[] (stateUrl, accent), title, refreshMs.
3. Style: only `:root` variables in `styles.css` (+ `data-theme="light"`
   overrides). Embeddable via `?theme=light|dark`.
4. Host it: GitHub Pages, Cloudflare Pages, or drop the folder behind
   fa1.dev/factory.

## Enable publishing for a factory (OPT-IN)

The machine workflows pass `state-publish` (JSON string) to factory-sm.yml:

```yaml
      state-publish: '{"channel":"release","tag":"factory-state","asset":"fa-state.json"}'
```

- `channel: 'release'` — the only channel today; anything else = off.
- `repo` — target repo (default: the tick's repo).
- `tag` — release tag, created once as prerelease (default `factory-state`).
- `asset` — one asset per factory so several factories can share one release
  (e.g. `fa-state.json`, `dart-state.json`).

## State schema (v1)

```json
{
  "schema": 1,
  "factory": "flutter_agent_harness",
  "repo": "IstiN/flutter_agent_harness",
  "tick": { "at": "...", "dryRun": false, "processed": ["pr-817"] },
  "checks": ["Quality gate", "JS engine integration (quickjs-ng)", "Binaries smoke gate"],
  "lanes": {
    "validating":     [ { "pr": 817, "title": "...", "labels": [...],
                          "checks": { "verdict": "in_progress", "at": "...", "url": "..." },
                          "queuePos": null } ],
    "approved_queue": [ { "pr": 828, "queuePos": 1, ... } ],
    "review": [], "fresh": []
  },
  "counts": { "validating": 1, "approved_queue": 1, "review": 0, "fresh": 0 }
}
```

Lanes are a deterministic read of the machine labels (the same predicates the
reconcile rules query): `ai_validating` → validating; `pr_approved` →
approved_queue (FIFO by PR number, `queuePos` 1-based); `ai_pr_reviewed` →
review; else fresh. Per-head `checks` verdicts come from the newest
dispatched run (cancelled never decides — gh-191).
