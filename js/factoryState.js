/**
 * Factory state — snapshot builder + branch publisher (owner 2026-09-23;
 * schema 2 lifecycle-timestamps owner 2026-10-01; v3 history + backlog +
 * optional tokens owner 2026-10-03; gh-825 model + $cost pricing owner
 * 2026-10-10 — all additive, schema stays 2).
 *
 * The SM tick already computes the entire machine state every pass (labels,
 * armed PR, verdicts, queue). This module renders that state as JSON and
 * publishes it to a `factory-data` BRANCH via the Contents API (pure gh, no
 * tmp files). The board reads raw.githubusercontent.com/O/R/factory-data/
 * data/<asset> — CDN, token-free, no rate limits.
 *
 * Transport is OPT-IN: jobParams.statePublish = {
 *   channel: 'release',            // 'release' | 'none' (default: off)
 *   repo:    'O/R',                // target repo (default: the tick's repo)
 *   tag:     'factory-data',       // branch name (created once)
 *   asset:   'fa-state.json'       // asset name (multi-factory: one branch,
 *                                  // one asset per factory)
 * }
 *
 * ── Schema 2 (lifecycle timestamps) ──────────────────────────────────────────
 * Schema 1 carried only the label lanes — the board could see WHERE a card
 * was, never HOW LONG it had been there or when it moved. Schema 2 stamps
 * every card with the pipeline's transition times so the whole flow (dev →
 * PR → review → approve → validate → merge) is measurable:
 *
 *   prCreated     GitHub PR.created_at (github_list_prs — free, exact)
 *   mergedAt      GitHub PR.merged_at (merged PRs, last 7d lane)
 *   reviewedAt    ai_pr_reviewed  label time
 *   approvedAt    pr_approved     label time
 *   validatingAt  ai_validating   label time (the arm)
 *   devStartedAt  issue-side: first snapshot that saw agent:dev without
 *                 ai_developed (the dev leg's running window)
 *
 * Label times are NOT free GitHub fields. Two candidate sources were
 * prototyped: (a) per-item timeline REST calls (`issues/N/events` — one
 * request per PR per tick, 10-min cadence → rate-limit and wall-clock
 * cost that grows with board size) and (b) snapshot accumulation: the tick
 * already probes the previous state file on the factory-data branch for the
 * publish sha; reusing that one fetch, every new snapshot carries forward
 * the timestamps it stamped before and stamps `now` on transitions it
 * witnesses (label present now, absent in the previous snapshot). (b) costs
 * ONE extra gh call per tick regardless of board size and is exact to the
 * tick cadence (~10 min) — chosen. Cost: the very first snapshot after the
 * upgrade has no label history (those fields stay null until each card's
 * next transition); GitHub-native fields (prCreated/mergedAt) are exact
 * from snapshot one. Snapshot history (the `<base>-history.json` index)
 * keeps the raw evidence for time travel either way.
 *
 * ── Schema 2, checks records (gh-816 citation integrity) ────────────────────
 * card.checks is one uniform record shape everywhere it appears — open card
 * cite, merged_recent cite, checks.auxiliary side-run leg, carried record:
 *
 *   verdict       status, or the conclusion once terminal (ONE vocabulary —
 *                 auxiliary and carried records never invent a third name)
 *   at / url      run created_at / html_url
 *   runId/name/sha/conclusion   audit identity (merged_recent persistence)
 *   runStartedAt/updatedAt      gh-769 CI wall-time vs queue-wait split
 *   auxiliary     the freshest SM side-run leg on the head — evidence, never
 *                 the cite (same shape, no carried flag: it is live evidence)
 *   carried       true ONLY on a carried record whose conclusion never
 *                 landed — unverified, not live (never set on terminal
 *                 records; nothing resolves a merged card in flight)
 *
 * Pure functions here (no tool globals) — smAgent wires deps; tests inject
 * mocks. CommonJS module like every other js/ module.
 */

'use strict';

// ── Lane model ───────────────────────────────────────────────────────────────
// Labels ARE the machine's state machine; lanes are a deterministic read of
// them (same predicates the reconcile rules query). Schema 2 lanes follow
// the PIPELINE order (a card moves left→right exactly once per stage):
//
//   development     issue-side: agent:dev on, ai_developed off (dev leg run)
//   pr_created      open PR, no machine labels yet (was schema 1 `fresh`)
//   pr_validation   CI validation IN FLIGHT on the PR head (a dispatched
//                   run on the head is queued/in_progress, no machine labels
//                   yet) — the real pipeline validates the fresh PR head
//                   before/while review proceeds; without this lane the
//                   board jumped pr_created → review with no visible
//                   validation state (gh-716 lane 2). Derived, not
//                   label-stamped: no LANE_ENTERED_AT entry — the board
//                   ages the card from its newest history entry.
//   review          ai_pr_reviewed, not approved
//   approved_queue  pr_approved on, not armed (FIFO by PR number — the
//                   same FIFO the mutex uses)
//   validating      ai_validating on (armed/mutex)
//   merged_recent   merged within the last 7d (terminal, observation window)
//
// changes-requested / rework lanes show via labels on cards (board-side).

function hasLabel(pr, name) {
    return (pr.labels || []).some(function (l) {
        return (l && (l.name === name || l === name));
    });
}

// Run states that mean "validation in flight on this head" — mirrors the
// active filter of buildFactoryState's headVerdict() (single source: a
// state listed here but not there, or vice versa, would mislane cards).
var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending'];

// gh-816 citation integrity — what counts as a REAL validation run on a
// head. The lane cite is the discharge evidence watchers and audits read,
// so only real validation runs may carry it:
//   (a) repo CI arriving on a non-dispatch event (push/pull_request/
//       schedule — full CI + dynamic PR-validation workflows), or
//   (b) the machine's own validation-workflow dispatch (path
//       .github/workflows/<ciWorkflow>, e.g. quality.yml).
// ANY other workflow_dispatch run on the head is an SM side-run leg
// (review/develop/rework on ai-teammate.yml) — auxiliary evidence at
// most, never the discharge cite. A dispatch without a path (payload
// shape drift) fails OPEN as real — a run that cannot be classified must
// not silently lose citability.
// RESIDUAL RISK (gh-816 rework thread 2): the runs list is repo-wide, so
// `event !== 'workflow_dispatch'` means ANY repo workflow (labeler, docs,
// lint, translation bots — not necessarily "validation"). Such a run can
// only cite when nothing better exists (see the score-tier preference in
// headVerdict: the ciWorkflow path match outranks every bare real run),
// but a path-less dynamic-validation deployment still accepts this
// breadth by design — a path allowlist cannot express arbitrary
// per-PR validation workflows.
var WORKFLOW_PATH_PREFIX = '.github/workflows/';

function isValidationWorkflowPath(p, ciWorkflow) {
    if (!p || !ciWorkflow) return false;
    if (p === WORKFLOW_PATH_PREFIX + ciWorkflow) return true;
    var suffix = '/' + ciWorkflow;
    return p.length >= suffix.length &&
        p.slice(p.length - suffix.length) === suffix;
}

function isValidationRun(r, ciWorkflow) {
    if (!r) return false;
    if (r.event !== 'workflow_dispatch') return true;   // repo CI events
    return !r.path || isValidationWorkflowPath(r.path, ciWorkflow);
}

function laneOf(pr) {
    if (hasLabel(pr, 'ai_validating')) return 'validating';
    if (hasLabel(pr, 'pr_approved')) return 'approved_queue';
    if (hasLabel(pr, 'ai_pr_reviewed')) return 'review';
    if (pr && pr.checks && ACTIVE_RUN_STATES.indexOf(pr.checks.verdict) !== -1) {
        return 'pr_validation';
    }
    return 'pr_created';
}

var LANE_ORDER = ['development', 'pr_created', 'pr_validation', 'review',
                  'approved_queue', 'validating', 'merged_recent'];

// Machine-login list parsing (gh-728): the machineAuthor knob is a
// comma-separated list — assignment bucketing treats ANY entry as the
// machine (same semantics as the author guards in common/machineAuthor.js).
var machineAuthorModule = require('./common/machineAuthor.js');
// gh-806: the rework in-flight latch rides the snapshot (state.reworkInFlight,
// factory-data branch) so the NEXT tick's armer consults what THIS tick armed.
var reworkLatchModule = require('./common/reworkLatch.js');

// Schema 1 lane order (board back-compat; old snapshots on the data branch).
var LANE_ORDER_V1 = ['validating', 'approved_queue', 'review', 'fresh'];

// Label → card timestamp key: the transition stamps schema 2 accumulates.
var TS_BY_LABEL = {
    ai_pr_reviewed: 'reviewedAt',
    pr_approved:    'approvedAt',
    ai_validating:  'validatingAt'
};

// Lane → the timestamp that ENTERED the lane (the card's "age in state").
// pr_validation is deliberately ABSENT: it mirrors an in-flight CI run,
// not a label, so there is no accumulated stamp — the board ages those
// cards from their newest history entry (same fallback as backlog columns).
var LANE_ENTERED_AT = {
    development:   'devStartedAt',
    pr_created:    'prCreated',
    review:        'reviewedAt',
    approved_queue:'approvedAt',
    validating:    'validatingAt',
    merged_recent: 'mergedAt'
};

var MERGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // merged_recent retention (7d)
var DEV_LABEL = 'agent:dev';                  // dev-leg handoff (machine label)
var DEV_DONE_LABEL = 'ai_developed';          // dev leg produced a green PR

// ── v3 additions (owner 2026-10-03; all additive — schema stays 2) ──────────
// 1. card.history  — accumulated per-card state timeline [{state, at}]
//    (same tick-over-tick mechanism as the schema 2 timestamps: carried
//    forward, appended when the tick witnesses a transition). Feeds the
//    board's details drawer + state timings.
// 2. backlog       — open issues as board lanes, bucketed by the machine's
//    own signals: 'blocked' label (owner hold) > assigned to the machine
//    author (in dev) > agent:dev (queued) > inbox.
// 3. card.tokens   — OPTIONAL per-leg token usage rows [{leg, at, prompt,
//    completion, total}] (fa's bench reports them; factories that don't,
//    render "—" board-side — the schema never requires the key).

var BLOCKED_LABEL = 'blocked';                // owner hold — freeze switch
var BACKLOG_BUCKETS = ['in_dev', 'queued', 'blocked', 'inbox'];
var DEFAULT_MACHINE_AUTHOR = 'ai-teammate';   // back-compat/tests only — an
                                              // unset machineAuthor means NO
                                              // assignment bucketing (null)
var HISTORY_CAP = 100;                        // bound snapshot growth
var HISTORY_KEEP = 500;                       // default snapshot index depth
var DEFAULT_TOKENS_FILE = 'outputs/token_usage/factory_tokens.json';
var FACTORY_TOKENS_ASSET = 'fa-tokens.json';   // data/<asset> on the data
                                               // branch (gh-781; the leg-side
                                               // producer's publish path).
                                               // statePublish.tokensAsset
                                               // overrides — multi-factory
                                               // deployments sharing one
                                               // branch keep their token
                                               // streams apart
var BACKLOG_CAP = 50;                         // per bucket — github_search_issues
                                              // returns ONE page (no perPage),
                                              // so the snapshot stays bounded
                                              // and backlogCounts stay honest

/**
 * Backlog bucket for an open issue — deterministic read of the machine's
 * signals, first match wins: the 'blocked' label is the freeze switch (the
 * reconciler skips blocked items entirely), assignment to the machine
 * author means the machine owns it (in dev), the agent:dev label alone is
 * a queued handoff, everything else is inbox.
 */
function backlogBucket(issue, machineAuthor) {
    if (hasLabel(issue, BLOCKED_LABEL)) return 'blocked';
    // a null/absent machineAuthor (the deployment never configured the
    // knob) opts OUT of assignment bucketing entirely — no hardcoded
    // login is ever consulted. gh-728: the knob is a comma-separated
    // LIST — assignment to ANY entry means the machine owns the issue.
    var logins = machineAuthorModule.machineAuthorLogins(machineAuthor);
    var assigned = logins.length > 0 && (
        ((issue && issue.assignees) || []).some(function (a) {
            return a && logins.indexOf(a.login) !== -1;
        }) || !!(issue && issue.assignee && issue.assignee.login !== undefined &&
                 logins.indexOf(issue.assignee.login) !== -1));
    if (assigned) return 'in_dev';
    if (hasLabel(issue, DEV_LABEL)) return 'queued';
    return 'inbox';
}

/**
 * Next per-card history: carried forward; appended when this tick
 * witnesses a transition (state key changed, or a brand-new card appeared
 * between ticks); the terminal entry (merged) takes the exact GitHub
 * merged_at instead of the tick time. Without ANY previous snapshot the
 * first entry carries no `at` — honest unknown, exactly like the schema 2
 * label timestamps.
 */
function nextHistory(prevCard, prevKey, key, now, hasPrev, terminalAt) {
    var h = ((prevCard && prevCard.history) || []).slice();
    if (terminalAt) {
        // dedupe: merged cards are re-derived from the previous snapshot
        // every tick inside the 7d merged_recent window — without this
        // guard each tick appends a second terminal entry and HISTORY_CAP
        // evicts the card's real timeline within ~4h at 10-min cadence.
        if (!h.length || h[h.length - 1].state !== key) {
            h.push({ state: key, at: terminalAt });
        }
        return capHistory(h);
    }
    if (!hasPrev) {
        if (!h.length) h.push({ state: key });
        return capHistory(h);
    }
    if (prevKey !== key) h.push({ state: key, at: now });
    return capHistory(h);
}

function capHistory(h) {
    return h.length > HISTORY_CAP ? h.slice(h.length - HISTORY_CAP) : h;
}

function normTokenRow(r) {
    var prompt = +r.prompt || 0;
    var completion = +r.completion || 0;
    return {
        leg: r.leg == null ? null : String(r.leg),
        at: r.at == null ? null : String(r.at),
        prompt: prompt,
        completion: completion,
        total: +r.total || (prompt + completion),
        // gh-825: explicit passthrough (unknown fields were tolerated but
        // dropped before) — the board's model column and the pricing engine
        // read this. Upstream emits "model":"" until fa#1460 ships the
        // ledger field; empty normalizes to null exactly like absent.
        model: (r.model == null || r.model === '') ? null : String(r.model),
        // gh-825 rework (review thread 1, BLOCKING): the cache count must
        // ride the fresh row too — rowCost's cache term priced as 0 whenever
        // normalizeTokens dropped it. Producer-drift tolerance mirrors
        // rowCost: camelCase wins, snake_case falls back. Absent → null
        // (honest unknown); a REPORTED zero stays 0 (none ≠ not reported).
        cacheRead: (r.cacheRead == null ? r.cache_read : r.cacheRead) == null
            ? null : +r.cacheRead || +r.cache_read || 0
    };
}

/**
 * Normalize the optional tokens input into a map keyed 'pr-N'/'issue-N'
 * → rows sorted by `at` ascending. Accepts either the map form (what the
 * factory-published tokens file holds) or an array of rows carrying
 * pr/issue fields. Bad shapes degrade to an empty map — tokens are
 * decorative, never fatal.
 */
function normalizeTokens(input) {
    var map = {};
    if (Array.isArray(input)) {
        input.forEach(function (r) {
            if (!r) return;
            var key = r.pr != null ? 'pr-' + r.pr
                : (r.issue != null ? 'issue-' + r.issue : null);
            if (!key) return;
            (map[key] = map[key] || []).push(normTokenRow(r));
        });
    } else if (input && typeof input === 'object') {
        Object.keys(input).forEach(function (k) {
            if (!Array.isArray(input[k])) return;
            map[k] = input[k].map(normTokenRow);
        });
    }
    Object.keys(map).forEach(function (k) {
        map[k].sort(function (a, b) {
            return String(a.at || '').localeCompare(String(b.at || ''));
        });
    });
    return map;
}

/**
 * Read the OPTIONAL factory-published per-leg token usage file (path from
 * statePublish.tokensFile, default outputs/token_usage/factory_tokens.json
 * in the tick's checkout). Any miss — file absent, reader throws, invalid
 * JSON, values not arrays → null; the tick publishes without tokens and
 * the board renders "—". Never fails the tick.
 */
function readTokensFile(path, readFn) {
    if (!path || typeof readFn !== 'function') return null;
    try {
        return tokensMapOf(JSON.parse(String(readFn(path) || '')));
    } catch (e) {
        return null;
    }
}

/**
 * Validate a parsed tokens payload into the keyed-map form ('pr-N'/
 * 'issue-N' → array rows): only array values survive, an empty result is
 * a miss. Shared by the local-file reader (readTokensFile) and the branch
 * fetcher (fetchTokensFromBranch) — one shape contract for both sources.
 * Rows themselves normalize later, through normalizeTokens, when the
 * snapshot builder attaches them to cards.
 */
function tokensMapOf(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    var out = {};
    Object.keys(parsed).forEach(function (k) {
        if (Array.isArray(parsed[k])) out[k] = parsed[k];
    });
    return Object.keys(out).length ? out : null;
}

/**
 * Total leg rows across a tokens map ('pr-N'/'issue-N' → array rows) —
 * the N in the tick's 🪙 provenance log line (smAgent statePublish block,
 * sibling of the 📡 published line). Null/empty/non-array values → 0:
 * tokens are decorative, the count never fails the tick.
 */
function tokensLegCount(map) {
    var n = 0;
    Object.keys(map || {}).forEach(function (k) {
        if (Array.isArray(map[k])) n += map[k].length;
    });
    return n;
}

// ── gh-825 — model pricing (hardcoded, hand-maintained) ──────────────────────
// ONE home: data/model-pricing.json at the repo root (the
// statePublish.pricingFile knob repoints it for packed/multi-repo ticks).
// Rates are USD per MILLION tokens — list prices, committed, no live APIs,
// no secrets:
//
//   { "claude-sonnet-4-5": { "input": 3, "output": 15, "cacheRead": 0.3 },
//     ..., "default": null }
//
// `default` prices models missing from the table (null = unknown models
// stay unpriced). Cost rule, per token row:
//   cost = input/1e6*prompt + output/1e6*completion + cacheRead/1e6*cacheRead
// Unknown/absent model ⇒ the row carries NO cost — tokens still render
// (AC2). ANY malformed config ⇒ the tick warns (readModelPricing's {error}
// outcome) and publishes without $ — pricing is decorative exactly like
// the tokens it prices, never fatal (AC1).

var DEFAULT_PRICING_FILE = 'data/model-pricing.json';   // the ONE home
var COST_WINDOW_DAYS = 14;                              // global Σ$ window
var COST_WINDOW_MS = COST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * One pricing entry → {input, output, cacheRead} (USD/Mtok), or null when
 * the entry can't price anything (missing/negative input|output). cacheRead
 * is optional (defaults 0); a bad cacheRead falls back to 0 instead of
 * poisoning the whole entry. Numeric strings coerce — hand-edited files.
 */
function parsePricingEntry(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    var input = +e.input;
    var output = +e.output;
    if (!isFinite(input) || !isFinite(output) || input < 0 || output < 0) {
        return null;
    }
    var cacheRead = e.cacheRead == null ? 0 : +e.cacheRead;
    if (!isFinite(cacheRead) || cacheRead < 0) cacheRead = 0;
    return { input: input, output: output, cacheRead: cacheRead };
}

/**
 * Validate a parsed pricing payload into {rates, defaultRates, models}.
 * Top-level garbage → null; INVALID ENTRIES are skipped, valid ones survive
 * (one hand-edit typo must not blank the table). A payload with NO usable
 * rate anywhere is malformed-in-disguise → null (the caller warns instead
 * of publishing a Σ$ that can never move). `rates` is prototype-less: model
 * ids come from report input, so a '__proto__' id must stay a plain bucket
 * (the flow.js legs-map lesson).
 */
function parseModelPricing(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    var rates = Object.create(null);
    var n = 0;
    Object.keys(parsed).forEach(function (k) {
        if (k === 'default') return;
        var e = parsePricingEntry(parsed[k]);
        if (e) { rates[k] = e; n += 1; }
    });
    var defaultRates = parsePricingEntry(parsed['default']);
    if (!n && !defaultRates) return null;
    return { rates: rates, defaultRates: defaultRates, models: n };
}

/**
 * Load the pricing table off disk. Outcomes:
 *   { pricing }        the file parsed into a usable table
 *   { error: reason }  the file EXISTS but is unusable (bad JSON, bad
 *                      shape) — the caller warns; the board renders
 *                      tokens-only, the tick never fails over pricing
 *   null               file absent (or no reader) — a QUIET miss: pricing
 *                      not deployed here, equally fine (AC1)
 */
function readModelPricing(path, readFn) {
    if (!path || typeof readFn !== 'function') return null;
    var raw;
    try { raw = readFn(path); } catch (e) { return null; }
    if (raw == null || String(raw).trim() === '') return null;
    try {
        var pricing = parseModelPricing(JSON.parse(String(raw)));
        return pricing ? { pricing: pricing }
                       : { error: 'no usable model rates' };
    } catch (e2) {
        return { error: (e2 && e2.message) || String(e2) };
    }
}

/**
 * Rates for one row's model: explicit table hit first, then the configured
 * default (unknown models), else null. An ABSENT model is unpriced by
 * definition — nothing was reported, there is nothing to match (AC2).
 */
function ratesFor(pricing, model) {
    if (!pricing || model == null || model === '') return null;
    var r = pricing.rates ? pricing.rates[String(model)] : null;
    return r || pricing.defaultRates || null;
}

/**
 * The cost rule: cost = input/1e6*in + output/1e6*out + cacheRead/1e6*cache.
 * The row's cache count reads `cacheRead` with a `cache_read` fallback
 * (producer-drift tolerance) and prices as 0 when absent. Rounded to 1e-6
 * USD — float noise never reaches the board. null when either side is
 * missing (never a fake 0).
 */
function rowCost(row, rates) {
    if (!row || !rates) return null;
    var cost = rates.input / 1e6 * (+row.prompt || 0) +
        rates.output / 1e6 * (+row.completion || 0) +
        (rates.cacheRead || 0) / 1e6 *
            (+row.cacheRead || +row.cache_read || 0);
    return Math.round(cost * 1e6) / 1e6;
}

/**
 * Price a whole tokens ledger in place: each row gains `cost` when its
 * model matches the table (the cost stays on the row even outside the Σ$
 * window — the per-leg $ is the row's price, always). Returns the board
 * header's rollup {usd14d, pricedLegs, windowDays} — Σ$ across ALL keys
 * (closed cards leave the board after 24h; their spend must still count,
 * so the window applies to row `at`, not to lanes), or null when pricing
 * is off/absent — or when nothing priced lands inside the window / the
 * in-window Σ$ rounds to $0.00 (gh-825 rework, review thread 2: never a
 * lying Σ$0.00 pill) → the snapshot carries no `costs` key (additive
 * schema).
 * Rows with no parsable `at` price per-row but stay out of the window —
 * an undated row must not silently inflate or vanish from the header.
 */
function priceTokens(tmap, pricing, nowMs) {
    if (!pricing) return null;
    var summary = { usd14d: 0, pricedLegs: 0, windowDays: COST_WINDOW_DAYS };
    var any = false;   // at least one row priced → pricing is live AND matching
    Object.keys(tmap || {}).forEach(function (k) {
        (tmap[k] || []).forEach(function (row) {
            if (!row || row.model == null) return;
            var rates = ratesFor(pricing, row.model);
            if (!rates) return;
            var cost = rowCost(row, rates);
            if (cost == null) return;
            row.cost = cost;
            any = true;
            var t = row.at ? Date.parse(row.at) : NaN;
            if (!isNaN(t) && nowMs - t < COST_WINDOW_MS) {
                summary.usd14d += cost;
                summary.pricedLegs += 1;
            }
        });
    });
    if (!any) return null;   // nothing priced (e.g. pre-fa#1460: models empty)
    summary.usd14d = Math.round(summary.usd14d * 100) / 100;
    // gh-825 rework (review thread 2): a rollup that rounds to $0.00 — or
    // priced nothing inside the window (undated/stale rows, sub-cent spend)
    // — would render the header pill as a lying Σ$0.00, indistinguishable
    // from "pricing off". Suppress the rollup; the per-row $ stays data.
    if (!(summary.usd14d > 0)) return null;
    return summary;
}

/**
 * Fetch the factory-published per-leg token usage off the data branch
 * (gh-781; mirrors fetchPreviousState — one gh Contents probe via the
 * shared contentsOf transport): `data/<tokensAsset>.json` @ tagOf(cfg),
 * produced by the leg-side publisher in the teammate workflow. The asset
 * is statePublish.tokensAsset when set, else the fixed fa-tokens.json —
 * the override mirrors assetName so multi-factory deployments sharing one
 * data branch keep their token streams apart (token keys are repo-global,
 * a shared fixed asset would cross-attach factories' rows). The map
 * validates through the same contract as the local file (tokensMapOf) and
 * flows into normalizeTokens when attached to cards. ANY miss — 404
 * before the first publish, invalid JSON, non-map shape, rate limit — →
 * null: tokens are decorative, never fatal, the tick publishes token-less
 * cards exactly as today.
 */
function fetchTokensFromBranch(repo, cfg, exec) {
    var asset = (cfg && cfg.tokensAsset) || FACTORY_TOKENS_ASSET;
    try {
        return tokensMapOf(JSON.parse(
            contentsOf(repo, 'data/' + asset, cfg, exec)));
    } catch (e) {
        return null;
    }
}

/**
 * Index the previous snapshot for timestamp/history carry: pr-N → card across ALL
 * lanes (a PR that merged since the last tick was an open card then — its
 * label stamps must ride the merged card), issue-N → development card OR
 * backlog card (both carry the shared history + devStartedAt since v3).
 * The parallel *Lane/*State maps record WHICH state key each card sat in —
 * the v3 history accumulator appends on key change.
 */
function prevIndex(prev) {
    var ix = { pr: {}, issue: {}, prLane: {}, issueState: {} };
    var lanes = (prev && prev.lanes) || {};
    Object.keys(lanes).forEach(function (laneId) {
        (lanes[laneId] || []).forEach(function (c) {
            if (!c) return;
            if (c.pr != null) { ix.pr[c.pr] = c; ix.prLane[c.pr] = laneId; }
            if (c.issue != null) {
                ix.issue[c.issue] = c;
                if (!ix.issueState[c.issue]) ix.issueState[c.issue] = laneId;
            }
        });
    });
    var backlog = (prev && prev.backlog) || {};
    BACKLOG_BUCKETS.forEach(function (bucket) {
        (backlog[bucket] || []).forEach(function (c) {
            if (!c || c.issue == null) return;
            ix.issue[c.issue] = c;             // backlog card wins: it owns
            ix.issueState[c.issue] = bucket;   // the issue-state history
        });
    });
    return ix;
}

/**
 * Copy known timestamp fields from the card's previous snapshot entry.
 * Used by the terminal merged lane: labels may be gone from the merged PR
 * (the merge flow drops the arm label), so the last-known stamps ARE the
 * history — no label predicates apply post-mortem.
 */
function carryTimestamps(card, prevCard) {
    if (!prevCard) return;
    ['reviewedAt', 'approvedAt', 'validatingAt'].forEach(function (key) {
        if (prevCard[key]) card[key] = prevCard[key];
    });
}

/**
 * Carry/refresh a card's label timestamps against the previous snapshot.
 * Present label + prev stamp → carry (exact history); present label, no
 * prev stamp (transition happened between ticks — or the card is new) →
 * stamp `now`; absent label → drop the stamp (a rework-cycle removal resets
 * the clock so the re-add re-stamps). Without ANY previous snapshot (first
 * publish after upgrade) label stamps stay null — honest unknowns; the
 * GitHub-native fields still carry the timeline's ends.
 */
function mergeLabelTimestamps(card, prevCard, hasPrev) {
    Object.keys(TS_BY_LABEL).forEach(function (label) {
        var key = TS_BY_LABEL[label];
        if (hasLabel(card, label)) {
            if (prevCard && prevCard[key]) card[key] = prevCard[key];
            else if (hasPrev) card[key] = card._now;
        } else {
            delete card[key];
        }
    });
}

function iso(ts) {
    return (ts == null || ts === '') ? null : ts;
}

/**
 * Issue-side card (development lane and/or backlog twin) — one shape for
 * both; `extra` merges the lane-specific fields. The history array is
 * shared by reference: lane card and backlog card always tell the same
 * story in the drawer.
 */
function issueCard(it, extra, tmap, issueHistory) {
    var card = {
        issue: it.number,
        title: it.title,
        author: it.user && it.user.login,
        assignee: firstAssignee(it),
        labels: (it.labels || []).map(function (l) {
            return l && l.name || l;
        }),
        url: it.html_url,
        history: issueHistory[it.number] || []
    };
    var tokens = tmap['issue-' + it.number];
    if (tokens) card.tokens = tokens;
    Object.keys(extra || {}).forEach(function (k) { card[k] = extra[k]; });
    return card;
}

function firstAssignee(it) {
    var a = (it.assignees || [])[0];
    return (a && a.login) || (it.assignee && it.assignee.login) || null;
}

/**
 * Build the state snapshot from data the tick already has (or can fetch in
 * one pass). `prs` = open PRs (github_list_prs shape: {number,title,labels,
 * head{ref,sha},user{login},created_at}). `mergedPrs` = recently merged PRs
 * (github_list_prs state:'merged' — merged_at set; filtered to the 24h
 * window here). `issues` = ALL open issues (github_search_issues items,
 * v3 backlog source; ONE search page — no perPage knob — so backlog
 * buckets cap at BACKLOG_CAP, newest kept, and `backlogCounts` report
 * exactly what the snapshot holds; the pre-v3 `devIssues` — the
 * agent:dev-only subset —
 * is still accepted and feeds the development lane alone). `machineAuthor`
 * = the deployment's machine login (assignee marking machine-managed
 * issues). `tokens` = OPTIONAL per-leg token usage (map keyed
 * 'pr-N'/'issue-N', or rows carrying pr/issue fields). `runs` = dispatched
 * ci runs for the repo. `checkNames` = the stamped required checks
 * (jobParams.validationChecks). `ciWorkflow` = the deployment's validation
 * workflow FILE name (default 'quality.yml') — gh-816: dispatches of THIS
 * workflow count as real validation runs; other dispatches are SM side-run
 * legs (auxiliary, never the discharge cite). `prev` = the previous
 * published snapshot (parsed) or null — the timestamp AND history
 * accumulation source (see the schema 2 note above).
 */
// gh-998 (I5): the zombie-swept leak counter — cumulative across snapshots
// so operators see the leak rate, not just the fix. Always present (0 when
// the sweeper never fired or the carry is absent) so snapshots keep a stable
// shape; a malformed carry restarts at this tick's count rather than
// NaN-poisoning the payload. The whole computation lives in its own helper so
// buildFactoryState's complexity budget (quality.yml CRAP ratchet — CRAP may
// only decrease) is not spent on bookkeeping guards.
function zombiesSweptTotal(input) {
    function saneCount(n) {
        return typeof n === 'number' && !isNaN(n) ? n : 0;
    }
    var prevSwept = input.prev && input.prev.zombiesSwept;
    return saneCount(prevSwept) + saneCount(input.zombiesSwept);
}

// gh-1000 — mutex metrics snapshot normalizer: caps the alarm tail,
// coerces counters, drops a malformed blob rather than poisoning state.
function mutexCounterNum(v) {
    return Math.max(0, Math.floor(Number(v)) || 0);
}

function mutexSnapObject(input) {
    return (input && typeof input === 'object') ? input : {};
}

function mutexAlarmsTail(snap) {
    return Array.isArray(snap.alarms) ? snap.alarms.slice(-5) : [];
}

function normalizeMutexSnapshot(input) {
    var snap = mutexSnapObject(input);
    return {
        mutexSelfHeals: mutexCounterNum(snap.mutexSelfHeals),
        phantomHolderTicks: mutexCounterNum(snap.phantomHolderTicks),
        consecutivePhantomTicks: mutexCounterNum(snap.consecutivePhantomTicks),
        alarms: mutexAlarmsTail(snap)
    };
}

// gh-1000 — phantom-holder bookkeeping (second tier). Present only when
// the SM published a mutex snapshot this tick; malformed blobs drop.
function applyMutexSnapshot(state, input) {
    if (input.mutex) state.mutex = normalizeMutexSnapshot(input.mutex);
}

// gh-113 AC3 — the guest dead-zone block rides the snapshot verbatim (the
// smAgent side already merged the per-PR first-seen carry over
// input.prev.deadZone); absent on both sides ⇒ the key stays absent, the
// schema never changes.
function applyDeadZoneSnapshot(state, input) {
    if (input.deadZone) state.deadZone = input.deadZone;
}

// gh-816 — per-head run verdicts (citation integrity). The runs list is
// repo-wide and newest-first; classification is explicit (same idiom as
// syncValidationChecks/failedRunLinksLine) because the list is shared with
// side-run legs whose clocks interleave with CI. Pure helpers, extracted
// top-level (gh-1036) so buildFactoryState stays under its CRAP budget;
// behaviour is exactly the former closure cluster.

function headRuns(runs, sha) {
    return runs.filter(function (r) {
        return r && r.head_sha === sha;
    });
}

function runClock(r) {
    return {
        runStartedAt: (r && r.run_started_at) || null,
        updatedAt: (r && r.updated_at) || null
    };
}

// Sort key: the run's run_started_at/updated_at (gh-769) carry the CI
// wall-time vs queue-wait split; nulls sort as ''.
function runSortKey(r) {
    return String((r && (r.updated_at || r.created_at)) || '');
}

function freshestRun(list) {
    return (list || []).slice().sort(function (a, b) {
        return runSortKey(b).localeCompare(runSortKey(a));
    })[0] || null;
}

// The audit record for one run: verdict + the identity fields the
// merged_recent persistence needs (run id + name + sha + conclusion,
// gh-816) alongside the gh-769 clock split.
function runVerdictOf(r) {
    var done = r.status === 'completed';
    return done ? (r.conclusion || r.status) : r.status;
}

function runConclusionOf(r) {
    var done = r.status === 'completed';
    return done ? (r.conclusion || null) : null;
}

function runCite(r) {
    var t = runClock(r);
    return {
        verdict: runVerdictOf(r),
        at: r.created_at,
        url: r.html_url,
        runId: r.id == null ? null : r.id,
        name: r.name || null,
        sha: r.head_sha || null,
        conclusion: runConclusionOf(r),
        runStartedAt: t.runStartedAt,
        updatedAt: t.updatedAt
    };
}

// Cite resolution (gh-816 + rework threads 2/4): the runs list is repo-wide,
// so REAL runs come in tiers — score 2: the machine's own validation
// workflow (ciWorkflow path match); score 1: every other real run (repo CI,
// dynamic PR-validation, unrelated push/pull_request workflows under the
// documented fail-open). The best AVAILABLE tier cites — the validation
// workflow outranks any bare real run however fresh, and an unrelated
// workflow only cites when nothing better exists. Within the winning tier
// the newest TERMINAL non-cancelled run decides (cancelled is never a
// verdict — gh-191), else the newest active run, else NO cite — a head
// carrying only SM side-run legs has no validation evidence to discharge.
function citeTier(r, ciWorkflow) {
    return isValidationWorkflowPath(r.path, ciWorkflow) ? 2 : 1;
}

function isTerminalVerdict(r) {
    return r.status === 'completed' && r.conclusion &&
        r.conclusion !== 'cancelled';
}

function isActiveRun(r) {
    return ACTIVE_RUN_STATES.indexOf(r.status) !== -1;
}

// Within one tier pool: newest terminal non-cancelled run wins, else the
// newest active run, else no cite.
function citeFromPool(pool) {
    return freshestRun(pool.filter(isTerminalVerdict)) ||
        freshestRun(pool.filter(isActiveRun));
}

function citeForTier(real, ciWorkflow, tier) {
    return citeFromPool(real.filter(function (r) {
        return citeTier(r, ciWorkflow) === tier;
    }));
}

// The freshest side-run leg, when any, rides along as checks.auxiliary
// (runCite-shaped — same vocabulary as the cite: verdict/conclusion/
// runId/name/sha) — evidence, never the cite.
function headVerdict(runs, ciWorkflow, sha) {
    var mine = headRuns(runs, sha);
    var real = mine.filter(function (r) { return isValidationRun(r, ciWorkflow); });
    var legs = mine.filter(function (r) { return !isValidationRun(r, ciWorkflow); });
    var cite = null;
    [2, 1].forEach(function (tier) {
        if (cite) return;
        cite = citeForTier(real, ciWorkflow, tier);
    });
    if (!cite) return null;
    var out = runCite(cite);
    var leg = freshestRun(legs);
    if (leg) out.auxiliary = runCite(leg);
    return out;
}

function buildFactoryState(input) {
    var prs = input.prs || [];
    var mergedPrs = input.mergedPrs || [];
    var issues = input.issues || input.devIssues || [];
    var runs = input.runs || [];
    var checkNames = input.checkNames || [];
    var now = input.now || new Date().toISOString();
    var nowMs = Date.parse(now);
    var hasPrev = !!(input.prev && input.prev.lanes);
    var pix = prevIndex(input.prev);
    // null when the deployment has no machineAuthor knob — a deliberate
    // "unconfigured" state: no assignment bucketing (backlogBucket opts out),
    // never a hardcoded login (DEFAULT_MACHINE_AUTHOR is back-compat only)
    var machineAuthor = input.machineAuthor || null;
    var tmap = normalizeTokens(input.tokens);
    // gh-825: price the ledger in place BEFORE the cards attach — rows are
    // shared by reference, so every card.tokens row leaves the builder
    // carrying `model` (always) and `cost` (when priced). `costs` is the
    // board header's global Σ$ rollup; absent when pricing is off/bad.
    var costs = priceTokens(tmap, input.pricing, nowMs);
    var issueHistory = {};   // issue-N → shared history (lane + backlog twin)
    var ciWorkflow = input.ciWorkflow || 'quality.yml';
    function verdictFor(sha) {
        return headVerdict(runs, ciWorkflow, sha);
    }

    var lanes = {}; LANE_ORDER.forEach(function (l) { lanes[l] = []; });
    var backlog = {}; BACKLOG_BUCKETS.forEach(function (b) { backlog[b] = []; });

    // issue-side cards (v3: one pass over ALL open issues feeds BOTH the
    // development lane and the backlog buckets — single source, one shared
    // history per issue). ai_developed hands the ticket to the PR side —
    // those leave the lane; they stay in the backlog only while blocked.
    var issueCtx = {
        pix: pix, tmap: tmap, machineAuthor: machineAuthor,
        hasPrev: hasPrev, now: now, lanes: lanes, backlog: backlog,
        issueHistory: issueHistory
    };
    issues.forEach(function (it) { issueEntry(it, issueCtx); });
    lanes.development.sort(function (a, b) { return a.issue - b.issue; });
    sortAndCapBacklog(backlog);

    // open PR cards
    openPrEntries(prs, verdictFor, now, tmap, pix, hasPrev)
        .forEach(function (e) { lanes[e.lane].push(e.card); });

    // recently merged PRs (terminal lane) — GitHub fields carry the ends,
    // the accumulated label stamps ride over from the card's open life
    mergedCards(mergedPrs, nowMs, verdictFor, now, tmap, pix)
        .forEach(function (card) { lanes.merged_recent.push(card); });

    stampQueuePositions(lanes);

    // gh-806: the rework in-flight latch persists next to tick.processed —
    // the previous snapshot's map is the carry source, this tick's live map
    // (arms + clears that already happened mid-tick) merges over it, then
    // stale (AC3: >45 min, no matching active run) and terminated (AC2: the
    // leg's ai-teammate run concluded at/after the arm) entries are pruned so
    // the snapshot never wedges the armer on a dead leg. A leg run still
    // ACTIVE survives even past the stale window — a queued run on a jammed
    // runner must not invite a duplicate. Additive; schema stays 2.
    var reworkInFlight = reworkLatchModule.pruneStale(
        reworkLatchModule.normalizeMap(mergeLatchCarry(
            input.prev && input.prev.reworkInFlight, input.reworkInFlight)), {
            now: nowMs,
            runs: runs,
            workflowFile: input.legWorkflow
        }).map;

    // gh-998 (I5): cumulative zombie-swept leak counter — see zombiesSweptTotal.
    var sweptTotal = zombiesSweptTotal(input);

    var state = buildState(input, now, {
        checks: checkNames,
        reworkInFlight: reworkInFlight,
        zombiesSwept: sweptTotal,
        lanes: lanes,
        counts: laneCounts(lanes),
        backlog: backlog,
        backlogCounts: bucketCounts(backlog)
    });
    // gh-825 — the board header's global Σ$ (all cards, 14d window). Absent
    // key when pricing is off/absent/malformed: the board renders tokens-only.
    if (costs) state.costs = costs;
    applyMutexSnapshot(state, input);
    applyDeadZoneSnapshot(state, input);
    return state;
}

// ── gh-1036: pure build/decide helpers extracted from buildFactoryState ─────
// Each helper owns ONE concern of the former monolith; every one is covered
// by the characterization suites in js/unit-tests/test_factoryState.js.

/** True when the issue is a running dev leg: agent:dev on, ai_developed off. */
function isInDevLeg(it) {
    return hasLabel(it, DEV_LABEL) && !hasLabel(it, DEV_DONE_LABEL);
}

/** ai_developed hands the ticket to the PR side — it leaves the board unless the owner froze it (blocked). */
function isDevDoneVisible(it, bucket) {
    return hasLabel(it, DEV_DONE_LABEL) && bucket !== 'blocked';
}

// devStartedAt: carried while the leg keeps running; the first snapshot
// that sees the handoff stamps it (tick-cadence exact).
function devStartedAtCarry(prevCard, hasPrev, now) {
    if (prevCard && prevCard.devStartedAt) return prevCard.devStartedAt;
    return hasPrev ? now : undefined;
}

/**
 * One open issue → development-lane card + backlog twin (v3: one pass
 * feeds both; the history array is shared by reference so the two cards
 * always tell the same story). Mutates ctx (lanes/backlog/issueHistory);
 * issues that don't board (null, numberless, handed-off) are skipped.
 */
function issueEntry(it, ctx) {
    if (it == null || it.number == null) return;
    var inDev = isInDevLeg(it);
    var bucket = backlogBucket(it, ctx.machineAuthor);
    if (isDevDoneVisible(it, bucket)) return;
    var prevCard = ctx.pix.issue[it.number];
    ctx.issueHistory[it.number] = nextHistory(
        prevCard, ctx.pix.issueState[it.number], bucket, ctx.now, ctx.hasPrev);
    var devStartedAt;
    if (inDev) {
        devStartedAt = devStartedAtCarry(prevCard, ctx.hasPrev, ctx.now);
        ctx.lanes.development.push(issueCard(it, {
            checks: null, queuePos: null,
            devStartedAt: devStartedAt
        }, ctx.tmap, ctx.issueHistory));
    }
    // the backlog twin carries devStartedAt too — prevIndex resolves an
    // issue to its BACKLOG card, so the next tick's carry reads it here
    var twinExtra = { bucket: bucket };
    if (devStartedAt) {
        twinExtra.devStartedAt = devStartedAt;
    }
    (ctx.backlog[bucket] = ctx.backlog[bucket] || []).push(
        issueCard(it, twinExtra, ctx.tmap, ctx.issueHistory));
}

// BACKLOG_CAP: github_search_issues returns a single page (no perPage
// knob), so an over-page repo truncates silently at the source. The
// per-bucket cap bounds the published snapshot regardless of repo AND
// keeps backlogCounts self-consistent with what the snapshot holds
// (newest kept — issue numbers are monotonic).
function sortAndCapBacklog(backlog) {
    BACKLOG_BUCKETS.forEach(function (b) {
        (backlog[b] = backlog[b] || []).sort(function (x, y) {
            return x.issue - y.issue;
        });
        if (backlog[b].length > BACKLOG_CAP) {
            backlog[b] = backlog[b]
                .slice(backlog[b].length - BACKLOG_CAP);
        }
    });
}

/** GitHub PR identity fields shared by the open card and the terminal card. */
function prIdentity(pr) {
    return {
        pr: pr.number,
        title: pr.title,
        author: pr.user && pr.user.login,
        branch: pr.head && pr.head.ref,
        head: pr.head && pr.head.sha,
        labels: (pr.labels || []).map(function (l) {
            return l && l.name || l;
        })
    };
}

/** One open PR → { lane, card }: label lanes + carried/ stamped timestamps. */
function openPrCard(pr, checks, now, tmap, pix, hasPrev) {
    var card = prIdentity(pr);
    // headVerdict already returns the card-shaped record (or null)
    card.checks = checks || null;
    card.prCreated = iso(pr.created_at);
    // FIFO position inside approved_queue is filled after the sort
    card.queuePos = null;
    card._now = now;
    var lane = laneOf({ labels: card.labels, checks: card.checks });
    mergeLabelTimestamps(card, pix.pr[pr.number], hasPrev);
    card.history = nextHistory(pix.pr[pr.number], pix.prLane[pr.number],
        lane, now, hasPrev);
    if (tmap['pr-' + pr.number]) card.tokens = tmap['pr-' + pr.number];
    delete card._now;
    return { lane: lane, card: card };
}

/** All open PR cards, sorted by PR number (the same FIFO the mutex uses). */
function openPrEntries(prs, verdictFor, now, tmap, pix, hasPrev) {
    return prs.map(function (pr) {
        return openPrCard(pr, verdictFor(pr.head && pr.head.sha),
            now, tmap, pix, hasPrev);
    }).sort(function (a, b) { return a.card.pr - b.card.pr; });
}

/** merged_recent retention: merged within the last 7d (parseable merged_at). */
function mergedInWindow(pr, nowMs) {
    var t = Date.parse(pr.merged_at || '');
    return !isNaN(t) && (nowMs - t) < MERGED_WINDOW_MS;
}

// gh-816 rework thread 3: a carried record whose conclusion never landed
// (the runs rotated out of the window while validation was still in
// flight) is carried MARKED — without the marker the merged card would
// read "validation in flight" for the whole 24h window, since nothing
// ever resolves it.
function carriedMergeChecks(prevCard) {
    var mergedChecks = Object.assign({}, prevCard.checks);
    if (mergedChecks.conclusion == null) mergedChecks.carried = true;
    return mergedChecks;
}

/**
 * gh-816: PERSIST the checks record at merge time — resolve the head's
 * real validation cite from the current runs list (the list is repo-wide,
 * the merged head still matches), else carry the record the card
 * accumulated during its open life. The terminal lane is the audit trail:
 * dropping the record forced retrospectives to re-derive run history to
 * tell legit merges from false-green. Terminal records carry as-is (a
 * resolved verdict), and the audit fields stay uniform across
 * cite/auxiliary/carried records (all runCite-shaped, thread 4).
 */
function mergedChecksFor(pr, prevCard, verdictFor) {
    var mergedChecks = (pr.head && pr.head.sha &&
        verdictFor(pr.head.sha)) || null;
    if (!mergedChecks && prevCard && prevCard.checks) {
        mergedChecks = carriedMergeChecks(prevCard);
    }
    return mergedChecks;
}

/** One recently merged PR → terminal card (the merge is the terminal history entry — exact GitHub merged_at). */
function mergedPrCard(pr, mergedChecks, now, tmap, pix) {
    var card = prIdentity(pr);
    card.checks = mergedChecks;
    card.prCreated = iso(pr.created_at);
    card.mergedAt = iso(pr.merged_at);
    card.queuePos = null;
    card._now = now;
    carryTimestamps(card, pix.pr[pr.number]);
    card.history = nextHistory(pix.pr[pr.number], pix.prLane[pr.number],
        'merged_recent', now, true, card.mergedAt || now);
    if (tmap['pr-' + pr.number]) card.tokens = tmap['pr-' + pr.number];
    delete card._now;
    return card;
}

/** All merged_recent cards, newest merge first. */
function mergedCards(mergedPrs, nowMs, verdictFor, now, tmap, pix) {
    return mergedPrs.filter(function (pr) {
        return mergedInWindow(pr, nowMs);
    }).map(function (pr) {
        return mergedPrCard(pr, mergedChecksFor(pr, pix.pr[pr.number], verdictFor),
            now, tmap, pix);
    }).sort(function (a, b) {
        return Date.parse(b.mergedAt) - Date.parse(a.mergedAt);
    });
}

// Approved FIFO positions (1-based; the mutex takes pos 1 on arm).
function stampQueuePositions(lanes) {
    (lanes.approved_queue || []).forEach(function (card, i) {
        card.queuePos = i + 1;
    });
}

function copyLatchInto(carry, latch) {
    if (latch && typeof latch === 'object') {
        Object.keys(latch).forEach(function (k) { carry[k] = latch[k]; });
    }
}

// gh-806: the previous snapshot's latch map is the carry source, this
// tick's live map (arms + clears that already happened mid-tick) merges
// over it.
function mergeLatchCarry(prevLatch, liveLatch) {
    var carry = {};
    copyLatchInto(carry, prevLatch);
    copyLatchInto(carry, liveLatch);
    return carry;
}

/**
 * The snapshot shell: header first — schema, factory, repo, tick — in the
 * pinned schema 2 key order (gh-1036 characterization test), then the
 * per-tick body. `factory` falls back to the repo name, then 'unknown';
 * `repo` is 'O/R' or null without repoInfo.
 */
function buildState(input, now, body) {
    var state = {
        schema: 2,
        factory: input.factory ||
            (input.repoInfo && input.repoInfo.repo) || 'unknown',
        repo: input.repoInfo
            ? (input.repoInfo.owner + '/' + input.repoInfo.repo) : null,
        tick: {
            at: now,
            dryRun: input.dryRun === true,
            processed: input.processed || []
        }
    };
    Object.keys(body).forEach(function (k) { state[k] = body[k]; });
    return state;
}

function laneCounts(lanes) {
    return LANE_ORDER.reduce(function (m, l) {
        m[l] = (lanes[l] || []).length; return m;
    }, {});
}

function bucketCounts(backlog) {
    return BACKLOG_BUCKETS.reduce(function (m, b) {
        m[b] = (backlog[b] || []).length; return m;
    }, {});
}

// ── Publisher ────────────────────────────────────────────────────────────────
// Transport: a `factory-data` branch committed via the Git data API (pure gh,
// no tmp files). The CLI whitelist admits only gh/git/dmtools/... as the
// first token (printf/rm rejected — live 18:56 tick; the runner's dmtools
// file_write schema drifted — live 19:12 tick), so EVERY command starts with
// `gh`, and the JSON rides inside `-f` fields. The board reads
// raw.githubusercontent.com/O/R/factory-data/data/<asset> — CDN, token-free.

var DEFAULT_TAG = 'factory-data';
var DATA_BRANCH = 'factory-data';

function assetName(state, cfg) {
    return (cfg && cfg.asset) ||
        ((state.factory || 'factory') + '-state.json');
}

function tagOf(cfg) {
    return (cfg && cfg.tag) || DEFAULT_TAG;
}

/**
 * Fetch + parse the previously published snapshot (the timestamp
 * accumulation source for schema 2). One gh call; any miss (first publish,
 * branch absent, parse error) → null — accumulation then starts fresh.
 * `repo` is 'O/R' (cfg.repo or the tick's repo — the caller knows it
 * before the state exists).
 */
function fetchPreviousState(repo, cfg, exec) {
    var path = 'data/' + (cfg && cfg.asset ? cfg.asset :
        (repo.split('/')[1] || 'factory') + '-state.json');
    try {
        var parsed = JSON.parse(contentsOf(repo, path, cfg, exec));
        return (parsed && parsed.lanes) ? parsed : null;
    } catch (e) {
        return null;
    }
}

/**
 * Pure: the gh commands that publish `state` (board URL derivable without
 * running them). First command bootstraps the data branch (fails harmlessly
 * when it exists); second commits data/<asset> via createCommitOnBranch —
 * expectedHeadOid is resolved IN-SHELL, so concurrent ticks fail open and
 * the next tick retries.
 */
function publishCommands(state, cfg, existingSha) {
    var repo = (cfg && cfg.repo) || state.repo;
    var branch = tagOf(cfg);
    var asset = assetName(state, cfg);
    var path = 'data/' + asset;
    var json = JSON.stringify(state);
    // gh's GraphQL transports are unusable from here (see #516/#518);
    // the Contents API PUT is plain REST with a base64 payload. The
    // existing-file sha comes from the caller (publishFactoryState
    // probes it via exec) — omit it and a first publish CREATES the
    // file. Every command MUST start with `gh`: the executor whitelists
    // the first token, so no leading `S=$( ... )` tricks.
    var put = 'gh api -X PUT repos/' + repo + '/contents/' + path +
        ' -f branch=' + branch +
        ' -f message=' + shellQuote('factory state — ' +
            ((state.tick && state.tick.at) || '') + ' [skip ci]') +
        ' -f content="$(printf %s ' + shellQuote(json) + ' | base64)"';
    if (existingSha) {
        put += " -f sha=" + shellQuote(existingSha);
    }
    return [
        // '|| true': the normal case is "branch already exists" (422) — the
        // executor throws on non-zero exit, which would abort the commit.
        'gh api -X POST repos/' + repo + '/git/refs -f ref=refs/heads/' + branch +
            ' -f sha="$(gh api repos/' + repo +
            '/git/ref/heads/$(gh api repos/' + repo +
            ' --jq .default_branch) --jq .object.sha)" || true',
        put
    ];
}

/**
 * Publish via `exec` (cli_execute_command in the bridge; a capturer in
 * tests). Returns the public board URL.
 */
function publishFactoryState(state, cfg, exec) {
    var repo = (cfg && cfg.repo) || state.repo;
    var asset = assetName(state, cfg);
    var branch = tagOf(cfg);
    var path = 'data/' + asset;
    var sha = '';
    try {
        var res = exec({ command: 'gh api repos/' + repo + '/contents/' +
            path + '?ref=' + branch + ' --jq .sha' });
        sha = String((res && (res.output || res.stdout)) || res || '')
            .trim();
        if (sha.indexOf('Not Found') !== -1) sha = '';
    } catch (e) { sha = ''; } // first publish — the file is absent
    publishCommands(state, cfg, sha).forEach(function (c) {
        exec({ command: c });
    });
    return 'https://raw.githubusercontent.com/' + repo + '/' + branch +
        '/data/' + asset;
}

function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Time-travel history (owner 2026-09-24): every tick also lands a
 * timestamped snapshot `<base>-<stamp>.json` (unique name → always a
 * create, no sha) and rewrites the rolling index `<base>-history.json`
 * the factory board probes for its scrub/play controls. The index keeps
 * the newest `cfg.historyKeep` (default 500 = ~41h at 5-min / ~83h at 10-min)
 * snapshots; snapshot URLs are absolute raw links the board fetches
 * directly. Every command starts with `gh` (executor whitelist); the
 * index body is decoded in-shell (`| base64 -d`), so the JS side never
 * needs a base64 codec.
 */
function stampOf(state) {
    var at = String((state && state.tick && state.tick.at) || '');
    // '2026-09-23T22:35:55.658Z' → '20260923-2235' (pure string surgery)
    return at.slice(0, 10).replace(/-/g, '') + '-' + at.slice(11, 16).replace(':', '');
}

function snapshotPutCommand(state, cfg, stamp) {
    var repo = (cfg && cfg.repo) || state.repo;
    var base = assetName(state, cfg).replace(/\.json$/, '');
    var json = JSON.stringify(state);
    return 'gh api -X PUT repos/' + repo + '/contents/data/' + base + '-' +
        stamp + '.json' +
        ' -f branch=' + tagOf(cfg) +
        ' -f message=' + shellQuote('factory state snapshot ' + stamp +
            ' [skip ci]') +
        ' -f content="$(printf %s ' + shellQuote(json) + ' | base64)"';
}

function historyPutCommand(state, cfg, index, existingSha) {
    var repo = (cfg && cfg.repo) || state.repo;
    var base = assetName(state, cfg).replace(/\.json$/, '');
    var path = 'data/' + base + '-history.json';
    var put = 'gh api -X PUT repos/' + repo + '/contents/' + path +
        ' -f branch=' + tagOf(cfg) +
        ' -f message=' + shellQuote('factory state history — ' +
            ((state.tick && state.tick.at) || '') + ' [skip ci]') +
        ' -f content="$(printf %s ' + shellQuote(JSON.stringify(index)) +
        ' | base64)"';
    if (existingSha) {
        put += " -f sha=" + shellQuote(existingSha);
    }
    return put;
}

function execOut(exec, command) {
    var res = exec({ command: command });
    return String((res && (res.output || res.stdout)) || res || '').trim();
}

/**
 * One home for the gh Contents CONTENT probe (rework gh-783): gh-first
 * (executor whitelist), `--jq .content` + in-shell `| base64 -d` decode,
 * ref rides tagOf(cfg). Transport miss (404, rate limit, exec throw) →
 * null; an EMPTY exec response comes back as '' — callers JSON.parse-
 * guard the result, so both degrade exactly as before. The `.sha` probes
 * (publishFactoryState, updateHistory) keep their own shape: they read a
 * different jq field and treat a 'Not Found' string as data (first
 * publish), not as a miss.
 */
function contentsOf(repo, path, cfg, exec) {
    try {
        return execOut(exec, 'gh api repos/' + repo + '/contents/' + path +
            '?ref=' + tagOf(cfg) + ' --jq .content | base64 -d');
    } catch (e) { return null; }
}

function updateHistory(state, cfg, exec) {
    var repo = (cfg && cfg.repo) || state.repo;
    var branch = tagOf(cfg);
    var base = assetName(state, cfg).replace(/\.json$/, '');
    var keep = (cfg && cfg.historyKeep) || HISTORY_KEEP;
    var stamp = stampOf(state);
    exec({ command: snapshotPutCommand(state, cfg, stamp) });
    var indexPath = 'data/' + base + '-history.json';
    var snaps = [];
    var sha = '';
    try {
        sha = execOut(exec, 'gh api repos/' + repo + '/contents/' +
            indexPath + '?ref=' + branch + ' --jq .sha');
        if (sha.indexOf('Not Found') !== -1) sha = '';
    } catch (e) { sha = ''; }
    if (sha) {
        try {
            var cur = JSON.parse(
                contentsOf(repo, indexPath, cfg, exec) || '{}');
            snaps = (cur && cur.snapshots) || [];
        } catch (e2) { snaps = []; }
    }
    snaps = snaps.filter(function (s) { return s && s.url; });
    snaps.unshift({
        ts: new Date().toISOString(),
        tick: (state && state.tick && state.tick.at) || '',
        stamp: stamp,
        url: 'https://raw.githubusercontent.com/' + repo + '/' + branch +
             '/data/' + base + '-' + stamp + '.json'
    });
    snaps = snaps.slice(0, keep);
    exec({ command: historyPutCommand(state, cfg,
        { schema: 1, repo: repo, asset: assetName(state, cfg), snapshots: snaps },
        sha) });
    return 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' +
        indexPath;
}

module.exports = {
    buildFactoryState: buildFactoryState,
    headRuns: headRuns,
    runClock: runClock,
    runSortKey: runSortKey,
    freshestRun: freshestRun,
    runCite: runCite,
    citeTier: citeTier,
    citeFromPool: citeFromPool,
    headVerdict: headVerdict,
    isTerminalVerdict: isTerminalVerdict,
    isActiveRun: isActiveRun,
    issueEntry: issueEntry,
    isInDevLeg: isInDevLeg,
    isDevDoneVisible: isDevDoneVisible,
    devStartedAtCarry: devStartedAtCarry,
    sortAndCapBacklog: sortAndCapBacklog,
    prIdentity: prIdentity,
    openPrCard: openPrCard,
    mergedInWindow: mergedInWindow,
    carriedMergeChecks: carriedMergeChecks,
    mergedChecksFor: mergedChecksFor,
    mergedPrCard: mergedPrCard,
    mergedCards: mergedCards,
    stampQueuePositions: stampQueuePositions,
    mergeLatchCarry: mergeLatchCarry,
    buildState: buildState,
    laneCounts: laneCounts,
    bucketCounts: bucketCounts,
    publishCommands: publishCommands,
    publishFactoryState: publishFactoryState,
    fetchPreviousState: fetchPreviousState,
    stampOf: stampOf,
    snapshotPutCommand: snapshotPutCommand,
    historyPutCommand: historyPutCommand,
    updateHistory: updateHistory,
    assetName: assetName,
    tagOf: tagOf,
    laneOf: laneOf,
    hasLabel: hasLabel,
    ACTIVE_RUN_STATES: ACTIVE_RUN_STATES,
    isValidationRun: isValidationRun,
    isValidationWorkflowPath: isValidationWorkflowPath,
    WORKFLOW_PATH_PREFIX: WORKFLOW_PATH_PREFIX,
    prevIndex: prevIndex,
    mergeLabelTimestamps: mergeLabelTimestamps,
    carryTimestamps: carryTimestamps,
    backlogBucket: backlogBucket,
    nextHistory: nextHistory,
    normalizeTokens: normalizeTokens,
    normalizeMutexSnapshot: normalizeMutexSnapshot,
    readTokensFile: readTokensFile,
    fetchTokensFromBranch: fetchTokensFromBranch,
    tokensMapOf: tokensMapOf,
    tokensLegCount: tokensLegCount,
    parseModelPricing: parseModelPricing,
    readModelPricing: readModelPricing,
    ratesFor: ratesFor,
    rowCost: rowCost,
    priceTokens: priceTokens,
    contentsOf: contentsOf,
    LANE_ORDER: LANE_ORDER,
    LANE_ORDER_V1: LANE_ORDER_V1,
    TS_BY_LABEL: TS_BY_LABEL,
    LANE_ENTERED_AT: LANE_ENTERED_AT,
    BACKLOG_BUCKETS: BACKLOG_BUCKETS,
    DEV_LABEL: DEV_LABEL,
    DEV_DONE_LABEL: DEV_DONE_LABEL,
    BLOCKED_LABEL: BLOCKED_LABEL,
    DEFAULT_MACHINE_AUTHOR: DEFAULT_MACHINE_AUTHOR,
    MERGED_WINDOW_MS: MERGED_WINDOW_MS,
    HISTORY_CAP: HISTORY_CAP,
    HISTORY_KEEP: HISTORY_KEEP,
    DEFAULT_TOKENS_FILE: DEFAULT_TOKENS_FILE,
    DEFAULT_PRICING_FILE: DEFAULT_PRICING_FILE,
    COST_WINDOW_DAYS: COST_WINDOW_DAYS,
    COST_WINDOW_MS: COST_WINDOW_MS,
    BACKLOG_CAP: BACKLOG_CAP,
    DEFAULT_TAG: DEFAULT_TAG
};
