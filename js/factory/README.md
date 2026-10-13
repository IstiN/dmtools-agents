# js/factory — factory glue as JS agent code

Owner directive 2026-10-13: factory glue that can be done «в стиле
dmtools-agents» lives HERE as JS agent modules, invoked through the dmtools
CLI (`dmtools run <config.json>`) — awf workflows become thin callers.
Conventions follow `js/factoryState.js`: pure functions first, IO adapters
(`exec`/`read` capturers) injected, CommonJS, ES5-style (runs on GraalJS and
the Dart QuickJS runtime), testRunner unit tests in `js/unit-tests/`.

## Modules

### token_usage.js — per-leg token-usage publisher

JS port of the awf factory-teammate.yml step «Publish leg token usage
(fa-tokens ledger → factory-data)», byte-extracted as
`scripts/publish-token-usage.sh` by IstiN/dmtools-agentic-workflows#34.
Behavior contract is identical:

1. **Ledger parse** — sum every `fa-tokens: {…}` record in the run output
   (balanced-brace scan; one line per session segment, resume-aware).
   `input`/`output`/`cacheRead` are summed; last-seen `model` wins.
   Invalid/truncated payloads are skipped.
2. **Skips** (warn + exit, never throw): run output missing/empty
   (`no-run-output`); zero input+output sums (`no-ledger`); anchor not
   `pr-*`/`gh-*` (`bad-anchor`).
3. **Leg** — `*rework*` in the runner-config basename (minus `.json`) →
   `rework` (the run guard collapses the rework slot into kind=dev), else
   `KIND`, else `dev`.
4. **Key** — `pr-<n>` passes through; `gh-<n>` → `issue-<n>`.
5. **Row** — printf field order:
   `{"leg","at","prompt","completion","total","cacheRead","model"}`,
   `at` = UTC ISO-8601 seconds, `total = prompt + completion`.
6. **Publish** — bootstrap the data branch from the default-branch head
   (422 already-exists is normal), then up to 3 attempts: GET contents
   (sha + body), append the row under the key, drop rows older than 14
   days, keep the last 40 per key, drop emptied keys, PUT the Contents API
   with the existing sha. Conflict → refetch → retry (sh backoff
   `attempt*2s`; the JS default `sleepMs` is a no-op — retries refetch
   anyway, injection point for tests). Exhausted → warn; rows are
   decorative, the next leg retries.

### Env/file contract (what the awf side passes today)

| env name      | param        | meaning                                        | default              |
|---------------|--------------|------------------------------------------------|----------------------|
| `RUN_OUTPUT`  | `runOutput`  | run-output file (fa-tokens ledger source)      | — (absent → skip)    |
| `CONFIG`      | `configPath` | runner config path (basename decides the leg)  | — (→ kind/dev)       |
| `KIND`        | `kind`       | leg kind when basename lacks `rework`          | `dev`                |
| `ANCHOR`      | `anchor`     | work anchor: `pr-<n>` \| `gh-<n>`              | — (absent → skip)    |
| `REPO`        | `repo`       | factory-data target `owner/repo`               | — (needed to publish)|
| `DATA_BRANCH` | `dataBranch` | target branch                                  | `factory-data`       |
| `DATA_PATH`   | `dataPath`   | target path                                    | `data/fa-tokens.json`|

Files touched: only the Contents API on `DATA_BRANCH`/`DATA_PATH` (no local
writes). Transport is gh-first (`gh api …` — executor whitelist), base64
stays in-shell (`printf %s … | base64`, `--jq .content | base64 -d`), same
as `factoryState.js`.

### token_usage_publish.js — JSRunner entry

`action(params, deps)` glue: resolves `jobParams.customParams` → env →
defaults (via `resolveParams`), wires `exec` → `cli_execute_command` and
`read` → `file_read`, calls `publishTokenUsage`, logs the grep-able
`leg tokens: …` line plus a `🪙 token publish: <status>` summary line, and
returns `{ status, reason, key, leg, row, attempts }`. Never throws — skip
and gave-up are statuses, not errors (the workflow step runs under
`always()`).

## Invocation sample

`dmtools run agents/js/factory/run_token_usage_publish.json` (see
`run_token_usage_publish.json`; placeholders `{config}`/`{kind}`/`{anchor}`/
`{owner}/{repo}` are filled by the machine-kit runner, or drop them and let
the env fallback read the workflow step's env block). awf stage-3 rewire:
replace

```yaml
run: bash -e "${RUNNER_TEMP}/factory-kit/scripts/publish-token-usage.sh"
```

with a `dmtools run` of this config at the same kit ref, keeping the env
block and `if: always()` on the step.

## Tests

`js/unit-tests/test_factoryTokenUsage.js` (TDD: red commit `d118b38a`
before the implementation) — run standalone with
`dmtools run js/unit-tests/run_factoryTokenUsage.json`; registered in
`js/unit-tests/run_all.json` for the Dart suite gate.
