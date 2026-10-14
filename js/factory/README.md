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

### mark_job_done.js — issue task-list job marker

JS port of the awf factory-teammate.yml step «Mark machine job done (issue
task list)», byte-extracted as `scripts/mark-job-done.sh` by
IstiN/dmtools-agentic-workflows#34. Behavior contract is identical:

1. **Mark** — `success`→✅ `failure`→❌ `cancelled`→🚫 else `⚠️ <JOB_RESULT>`.
2. **Flip** — every body line containing the literal `(<RUN_URL>)` needle
   (awk `index()`) AND starting with the two-checkbox prefix `- [ ]` is
   processed: `- [ ] ` → `- [x] ` (note: the guard has no trailing space, the
   flip sub does), and if the line matches `/started \d\d:\d\d/` the tail from
   the first `/started \d\d:\d\d .*$/` match is replaced with
   `<st> · done <HH:MM> <mark>` (st from match() may be an earlier occurrence
   than the one replaced — awk sub/match independence, kept byte-identical;
   see the parity harness). Non-empty output always ends with `\n` (awk
   `{ print }` ORS); CRLF records lose the CR only inside a replaced tail.
3. **Publish** — changed body → staged to the temp file and pushed with
   `gh issue edit N --repo R --body-file <tmp>`, logging
   `job marker flipped to [x] <mark>`; unchanged body →
   `::warning::start marker not found for <RUN_URL> — nothing to flip`.
4. **Errors propagate** — the sh dies under `bash -e`; gh failures redden
   the step (it runs under `always()`, so a dead flip must be loud).

### Env/file contract (what the awf side passes today)

| env name            | param       | meaning                                   | default                |
|---------------------|-------------|-------------------------------------------|------------------------|
| `NUMBER`            | `number`    | issue holding the task list               | — (nothing to flip)    |
| `RUN_URL`           | `runUrl`    | run URL; `(url)` marks the line           | — (nothing to flip)    |
| `JOB_RESULT`        | `jobResult` | success / failure / cancelled / other     | `⚠️ ` (sh fallback)    |
| `GITHUB_REPOSITORY` | `repo`      | `owner/repo` of the issue                 | — (gh call fails loud) |
| (tempPath)          | `tempPath`  | staging path for the edited body          | `/tmp/issue_body_new.md`|

Files touched: the temp body file only (`gh issue edit --body-file`), same
as `pullRequest.js` conventions. Transport is gh-first (`gh issue view/edit`).

### mark_job_done_publish.js — JSRunner entry

`action(params, deps)` glue: resolves `jobParams.customParams` → env →
defaults (via `resolveParams`), wires `exec` → `cli_execute_command` and
`writeFile` → `file_write`, calls `markJobDone`, logs the sh's line plus a
`✅ job marker: <status>` summary, and returns
`{ status, mark, flipped, endTs }`. gh failures propagate (see above).

## Parity + regression harnesses

- `node js/unit-tests/parity_factoryMarkJobDone.js [N]` — flips N randomized
  task-list bodies through BOTH the JS port and the spec's literal awk
  program (embedded, byte-for-byte from scripts/mark-job-done.sh) and
  byte-compares. Node-only (needs `awk`), not part of the testRunner suite.
  Found and pinned three awk semantics on the way: `.` consumes `\r`,
  `{ print }` ORS, first-match/replace-position independence.
- the same harness also runs the **full sh pipeline** end-to-end: the
  embedded scripts/mark-job-done.sh executes under `bash` with PATH-stubbed
  `gh`/`date`, and the POSTED BODY FILE and stdout marker line are
  byte-compared against the JS module driven with the same gh view output —
  3 scenarios: canonical flip (trailing newline flows through both paths),
  newline-stripped transport (the JS ORS rule lands the same posted bytes
  the sh's always-newline file has), and the no-marker warning path (no
  post on either side).
- `js/unit-tests/test_factoryTokenUsageIssue889.js` — the issue #889
  scenario («copilot usage is not posted to ADO») as a regression guard:
  copilot `fa-tokens:` ledger rows reach the factory-data board with the
  copilot model preserved through a gh-only transport, and
  `outputs/copilot_usage.json` posts through the vendor-agnostic ADO tracker
  in ADO markdown — never through the Jira-only `jira_post_comment`.

## Tests (this module)

`js/unit-tests/test_factoryMarkJobDone.js` (TDD: red commit `109ec3fa`
before the implementation; 37 tests) — run standalone with
`dmtools run js/unit-tests/run_factoryMarkJobDone.json`; registered in
`js/unit-tests/run_all.json` for the Dart suite gate.
