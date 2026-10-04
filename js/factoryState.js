/**
 * Factory state — snapshot builder + branch publisher (owner 2026-09-23;
 * schema 2 lifecycle-timestamps owner 2026-10-01; v3 history + backlog +
 * optional tokens owner 2026-10-03 — all additive, schema stays 2).
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
 *   mergedAt      GitHub PR.merged_at (merged PRs, last 24h lane)
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
//   review          ai_pr_reviewed, not approved
//   approved_queue  pr_approved on, not armed (FIFO by PR number — the
//                   same FIFO the mutex uses)
//   validating      ai_validating on (armed/mutex)
//   merged_recent   merged within the last 24h (terminal, observation window)
//
// changes-requested / rework lanes show via labels on cards (board-side).

function hasLabel(pr, name) {
    return (pr.labels || []).some(function (l) {
        return (l && (l.name === name || l === name));
    });
}

function laneOf(pr) {
    if (hasLabel(pr, 'ai_validating')) return 'validating';
    if (hasLabel(pr, 'pr_approved')) return 'approved_queue';
    if (hasLabel(pr, 'ai_pr_reviewed')) return 'review';
    return 'pr_created';
}

var LANE_ORDER = ['development', 'pr_created', 'review',
                  'approved_queue', 'validating', 'merged_recent'];

// Schema 1 lane order (board back-compat; old snapshots on the data branch).
var LANE_ORDER_V1 = ['validating', 'approved_queue', 'review', 'fresh'];

// Label → card timestamp key: the transition stamps schema 2 accumulates.
var TS_BY_LABEL = {
    ai_pr_reviewed: 'reviewedAt',
    pr_approved:    'approvedAt',
    ai_validating:  'validatingAt'
};

// Lane → the timestamp that ENTERED the lane (the card's "age in state").
var LANE_ENTERED_AT = {
    development:   'devStartedAt',
    pr_created:    'prCreated',
    review:        'reviewedAt',
    approved_queue:'approvedAt',
    validating:    'validatingAt',
    merged_recent: 'mergedAt'
};

var MERGED_WINDOW_MS = 24 * 60 * 60 * 1000;   // merged_recent retention
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
var HISTORY_CAP = 24;                         // bound snapshot growth
var DEFAULT_TOKENS_FILE = 'outputs/token_usage/factory_tokens.json';
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
    // login is ever consulted
    var assigned = !!machineAuthor && (
        ((issue && issue.assignees) || []).some(function (a) {
            return a && a.login === machineAuthor;
        }) || !!(issue && issue.assignee && issue.assignee.login === machineAuthor));
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
        // every tick inside the 24h merged_recent window — without this
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
        total: +r.total || (prompt + completion)
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
        var parsed = JSON.parse(String(readFn(path) || ''));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        var out = {};
        Object.keys(parsed).forEach(function (k) {
            if (Array.isArray(parsed[k])) out[k] = parsed[k];
        });
        return Object.keys(out).length ? out : null;
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
 * (jobParams.validationChecks). `prev` = the previous published snapshot
 * (parsed) or null — the timestamp AND history accumulation source (see
 * the schema 2 note above).
 */
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
    var issueHistory = {};   // issue-N → shared history (lane + backlog twin)

    // per-head dispatched run verdicts (newest-first list assumed, same as
    // syncValidationChecks)
    function headRuns(sha) {
        return runs.filter(function (r) {
            return r.event === 'workflow_dispatch' && r.head_sha === sha;
        });
    }
    function headVerdict(sha) {
        var mine = headRuns(sha);
        var terminal = mine.filter(function (r) {
            return r.status === 'completed' && r.conclusion &&
                   r.conclusion !== 'cancelled';
        });
        if (terminal.length) {
            return { state: terminal[0].conclusion, at: terminal[0].created_at,
                     url: terminal[0].html_url };
        }
        var active = mine.filter(function (r) {
            return r.status === 'queued' || r.status === 'in_progress' ||
                   r.status === 'waiting' || r.status === 'pending';
        });
        if (active.length) {
            return { state: active[0].status, at: active[0].created_at,
                     url: active[0].html_url };
        }
        return null;
    }

    var lanes = {}; LANE_ORDER.forEach(function (l) { lanes[l] = []; });
    var backlog = {}; BACKLOG_BUCKETS.forEach(function (b) { backlog[b] = []; });

    // issue-side cards (v3: one pass over ALL open issues feeds BOTH the
    // development lane and the backlog buckets — single source, one shared
    // history per issue). ai_developed hands the ticket to the PR side —
    // those leave the lane; they stay in the backlog only while blocked.
    var devStartedAtByIssue = {};
    issues.forEach(function (it) {
        if (it == null || it.number == null) return;
        var inDev = hasLabel(it, DEV_LABEL) && !hasLabel(it, DEV_DONE_LABEL);
        var bucket = backlogBucket(it, machineAuthor);
        if (hasLabel(it, DEV_DONE_LABEL) && bucket !== 'blocked') return;
        var prevCard = pix.issue[it.number];
        // devStartedAt: carried while the leg keeps running; the first
        // snapshot that sees the handoff stamps it (tick-cadence exact).
        if (inDev) {
            if (prevCard && prevCard.devStartedAt) {
                devStartedAtByIssue[it.number] = prevCard.devStartedAt;
            } else if (hasPrev) {
                devStartedAtByIssue[it.number] = now;
            }
        }
        issueHistory[it.number] = nextHistory(
            prevCard, pix.issueState[it.number], bucket, now, hasPrev);
        if (inDev) {
            lanes.development.push(issueCard(it, {
                checks: null, queuePos: null,
                devStartedAt: devStartedAtByIssue[it.number]
            }, tmap, issueHistory));
        }
        // the backlog twin carries devStartedAt too — prevIndex resolves an
        // issue to its BACKLOG card, so the next tick's carry reads it here
        var twinExtra = { bucket: bucket };
        if (devStartedAtByIssue[it.number]) {
            twinExtra.devStartedAt = devStartedAtByIssue[it.number];
        }
        (backlog[bucket] = backlog[bucket] || []).push(
            issueCard(it, twinExtra, tmap, issueHistory));
    });
    lanes.development.sort(function (a, b) { return a.issue - b.issue; });
    // BACKLOG_CAP: github_search_issues returns a single page (no perPage
    // knob), so an over-page repo truncates silently at the source. The
    // per-bucket cap bounds the published snapshot regardless of repo AND
    // keeps backlogCounts self-consistent with what the snapshot holds
    // (newest kept — issue numbers are monotonic).
    BACKLOG_BUCKETS.forEach(function (b) {
        (backlog[b] = backlog[b] || []).sort(function (x, y) {
            return x.issue - y.issue;
        });
        if (backlog[b].length > BACKLOG_CAP) {
            backlog[b] = backlog[b]
                .slice(backlog[b].length - BACKLOG_CAP);
        }
    });

    // open PR cards
    prs.map(function (pr) {
        var v = headVerdict(pr.head && pr.head.sha);
        var card = {
            pr: pr.number,
            title: pr.title,
            author: pr.user && pr.user.login,
            branch: pr.head && pr.head.ref,
            head: pr.head && pr.head.sha,
            labels: (pr.labels || []).map(function (l) {
                return l && l.name || l;
            }),
            checks: v ? { verdict: v.state, at: v.at, url: v.url } : null,
            prCreated: iso(pr.created_at),
            // FIFO position inside approved_queue is filled after the sort
            queuePos: null,
            _now: now
        };
        var lane = laneOf({ labels: card.labels });
        mergeLabelTimestamps(card, pix.pr[pr.number], hasPrev);
        card.history = nextHistory(pix.pr[pr.number], pix.prLane[pr.number],
            lane, now, hasPrev);
        if (tmap['pr-' + pr.number]) card.tokens = tmap['pr-' + pr.number];
        delete card._now;
        return { lane: lane, card: card };
    }).sort(function (a, b) { return a.card.pr - b.card.pr; })
      .forEach(function (e) { lanes[e.lane].push(e.card); });

    // recently merged PRs (terminal lane) — GitHub fields carry the ends,
    // the accumulated label stamps ride over from the card's open life
    mergedPrs.filter(function (pr) {
        var t = Date.parse(pr.merged_at || '');
        return !isNaN(t) && (nowMs - t) < MERGED_WINDOW_MS;
    }).map(function (pr) {
        var prevCard = pix.pr[pr.number];
        var card = {
            pr: pr.number,
            title: pr.title,
            author: pr.user && pr.user.login,
            branch: pr.head && pr.head.ref,
            head: pr.head && pr.head.sha,
            labels: (pr.labels || []).map(function (l) {
                return l && l.name || l;
            }),
            checks: null,
            prCreated: iso(pr.created_at),
            mergedAt: iso(pr.merged_at),
            queuePos: null,
            _now: now
        };
        carryTimestamps(card, prevCard);
        // the merge is the terminal history entry — stamped with the exact
        // GitHub merged_at, not the tick time
        card.history = nextHistory(prevCard, pix.prLane[pr.number],
            'merged_recent', now, true, card.mergedAt || now);
        if (tmap['pr-' + pr.number]) card.tokens = tmap['pr-' + pr.number];
        delete card._now;
        return card;
    }).sort(function (a, b) {
        return Date.parse(b.mergedAt) - Date.parse(a.mergedAt);
    }).forEach(function (card) { lanes.merged_recent.push(card); });

    // approved FIFO positions (1-based; the mutex takes pos 1 on arm)
    (lanes.approved_queue || []).forEach(function (card, i) {
        card.queuePos = i + 1;
    });

    return {
        schema: 2,
        factory: input.factory || (input.repoInfo && input.repoInfo.repo) || 'unknown',
        repo: input.repoInfo ? (input.repoInfo.owner + '/' + input.repoInfo.repo) : null,
        tick: {
            at: now,
            dryRun: input.dryRun === true,
            processed: input.processed || []
        },
        checks: checkNames,
        lanes: lanes,
        counts: LANE_ORDER.reduce(function (m, l) {
            m[l] = (lanes[l] || []).length; return m;
        }, {}),
        backlog: backlog,
        backlogCounts: BACKLOG_BUCKETS.reduce(function (m, b) {
            m[b] = (backlog[b] || []).length; return m;
        }, {})
    };
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
        var raw = execOut(exec, 'gh api repos/' + repo + '/contents/' + path +
            '?ref=' + tagOf(cfg) + ' --jq .content | base64 -d');
        var parsed = JSON.parse(raw);
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
            ((state.tick && state.tick.at) || '')) +
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
 * the newest `cfg.historyKeep` (default 72 = 12h at the 10-min cadence)
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
        ' -f message=' + shellQuote('factory state snapshot ' + stamp) +
        ' -f content="$(printf %s ' + shellQuote(json) + ' | base64)"';
}

function historyPutCommand(state, cfg, index, existingSha) {
    var repo = (cfg && cfg.repo) || state.repo;
    var base = assetName(state, cfg).replace(/\.json$/, '');
    var path = 'data/' + base + '-history.json';
    var put = 'gh api -X PUT repos/' + repo + '/contents/' + path +
        ' -f branch=' + tagOf(cfg) +
        ' -f message=' + shellQuote('factory state history — ' +
            ((state.tick && state.tick.at) || '')) +
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

function updateHistory(state, cfg, exec) {
    var repo = (cfg && cfg.repo) || state.repo;
    var branch = tagOf(cfg);
    var base = assetName(state, cfg).replace(/\.json$/, '');
    var keep = (cfg && cfg.historyKeep) || 72;
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
            var cur = JSON.parse(execOut(exec, 'gh api repos/' + repo +
                '/contents/' + indexPath + '?ref=' + branch +
                ' --jq .content | base64 -d') || '{}');
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
    prevIndex: prevIndex,
    mergeLabelTimestamps: mergeLabelTimestamps,
    carryTimestamps: carryTimestamps,
    backlogBucket: backlogBucket,
    nextHistory: nextHistory,
    normalizeTokens: normalizeTokens,
    readTokensFile: readTokensFile,
    LANE_ORDER: LANE_ORDER,
    LANE_ORDER_V1: LANE_ORDER_V1,
    TS_BY_LABEL: TS_BY_LABEL,
    LANE_ENTERED_AT: LANE_ENTERED_AT,
    BACKLOG_BUCKETS: BACKLOG_BUCKETS,
    DEV_LABEL: DEV_LABEL,
    DEV_DONE_LABEL: DEV_DONE_LABEL,
    BLOCKED_LABEL: BLOCKED_LABEL,
    DEFAULT_MACHINE_AUTHOR: DEFAULT_MACHINE_AUTHOR,
    HISTORY_CAP: HISTORY_CAP,
    DEFAULT_TOKENS_FILE: DEFAULT_TOKENS_FILE,
    BACKLOG_CAP: BACKLOG_CAP,
    DEFAULT_TAG: DEFAULT_TAG
};
