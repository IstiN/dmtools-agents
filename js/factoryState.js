/**
 * Factory state — snapshot builder + branch publisher (owner 2026-09-23;
 * schema 2 lifecycle-timestamps owner 2026-10-01).
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

/**
 * Index the previous snapshot for timestamp carry: pr-N → card across ALL
 * lanes (a PR that merged since the last tick was an open card then — its
 * label stamps must ride the merged card), issue-N → development card.
 */
function prevIndex(prev) {
    var ix = { pr: {}, issue: {} };
    var lanes = (prev && prev.lanes) || {};
    Object.keys(lanes).forEach(function (laneId) {
        (lanes[laneId] || []).forEach(function (c) {
            if (!c) return;
            if (c.pr != null) ix.pr[c.pr] = c;
            if (c.issue != null) ix.issue[c.issue] = c;
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
 * Build the state snapshot from data the tick already has (or can fetch in
 * one pass). `prs` = open PRs (github_list_prs shape: {number,title,labels,
 * head{ref,sha},user{login},created_at}). `mergedPrs` = recently merged PRs
 * (github_list_prs state:'merged' — merged_at set; filtered to the 24h
 * window here). `devIssues` = open issues carrying the dev handoff
 * (github_search_issues items). `runs` = dispatched ci runs for the repo.
 * `checkNames` = the stamped required checks (jobParams.validationChecks).
 * `prev` = the previous published snapshot (parsed) or null — the timestamp
 * accumulation source (see the schema 2 note above).
 */
function buildFactoryState(input) {
    var prs = input.prs || [];
    var mergedPrs = input.mergedPrs || [];
    var devIssues = input.devIssues || [];
    var runs = input.runs || [];
    var checkNames = input.checkNames || [];
    var now = input.now || new Date().toISOString();
    var nowMs = Date.parse(now);
    var hasPrev = !!(input.prev && input.prev.lanes);
    var pix = prevIndex(input.prev);

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

    // issue-side development cards (dev leg running; ai_developed hands the
    // ticket to the PR side — those leave the lane)
    devIssues.forEach(function (it) {
        if (hasLabel(it, DEV_DONE_LABEL)) return;
        var prevCard = pix.issue[it.number];
        var card = {
            issue: it.number,
            title: it.title,
            author: it.user && it.user.login,
            labels: (it.labels || []).map(function (l) {
                return l && l.name || l;
            }),
            url: it.html_url,
            checks: null,
            queuePos: null,
            _now: now
        };
        // devStartedAt: carried while the leg keeps running; the first
        // snapshot that sees the handoff stamps it (tick-cadence exact).
        if (hasLabel(it, DEV_LABEL)) {
            if (prevCard && prevCard.devStartedAt) {
                card.devStartedAt = prevCard.devStartedAt;
            } else if (hasPrev) {
                card.devStartedAt = now;
            }
        }
        delete card._now;
        lanes.development.push(card);
    });
    lanes.development.sort(function (a, b) { return a.issue - b.issue; });

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
        mergeLabelTimestamps(card, pix.pr[pr.number], hasPrev);
        delete card._now;
        return card;
    }).sort(function (a, b) { return a.pr - b.pr; })
      .forEach(function (card) {
          lanes[laneOf({ labels: card.labels })].push(card);
      });

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
    LANE_ORDER: LANE_ORDER,
    LANE_ORDER_V1: LANE_ORDER_V1,
    TS_BY_LABEL: TS_BY_LABEL,
    LANE_ENTERED_AT: LANE_ENTERED_AT,
    DEV_LABEL: DEV_LABEL,
    DEV_DONE_LABEL: DEV_DONE_LABEL,
    DEFAULT_TAG: DEFAULT_TAG
};
