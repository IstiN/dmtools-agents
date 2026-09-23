/**
 * Factory state — snapshot builder + release-asset publisher (owner 2026-09-23).
 *
 * The SM tick already computes the entire machine state every pass (labels,
 * armed PR, verdicts, queue). This module renders that state as JSON and
 * publishes it as a release ASSET (not a draft — drafts are private and a
 * public board cannot read them; a published prerelease is public and its
 * `releases/latest/download/<asset>` link is a CDN redirect, not the REST
 * API — no token in the browser, no 60 req/h wall).
 *
 * Transport is OPT-IN: jobParams.statePublish = {
 *   channel: 'release',            // 'release' | 'none' (default: off)
 *   repo:    'O/R',                // target repo (default: the tick's repo)
 *   tag:     'factory-state',      // release tag (created once, prerelease)
 *   asset:   'fa-state.json'       // asset name (multi-factory: one release,
 *                                  // one asset per factory)
 * }
 *
 * Pure functions here (no tool globals) — smAgent wires deps; tests inject
 * mocks. CommonJS module like every other js/ module.
 */

'use strict';

// ── Lane model ───────────────────────────────────────────────────────────────
// Labels ARE the machine's state machine; lanes are a deterministic read of
// them (same predicates the reconcile rules query):
//   validating       ai_validating on                              (armed/mutex)
//   approved_queue   pr_approved on, not armed                     (FIFO order
//                    by PR number — the same FIFO the mutex uses)
//   review           ai_pr_reviewed, not approved
//   fresh            open, no machine labels yet
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
    return 'fresh';
}

var LANE_ORDER = ['validating', 'approved_queue', 'review', 'fresh'];

/**
 * Build the state snapshot from data the tick already has (or can fetch in
 * one pass). `prs` = open PRs (github_list_prs shape: {number,title,labels,
 * head{ref,sha},user{login}}). `runs` = dispatched ci runs for the repo
 * (github_list_workflow_runs shape). `checkNames` = the stamped required
 * checks (jobParams.validationChecks, parsed).
 */
function buildFactoryState(input) {
    var prs = input.prs || [];
    var runs = input.runs || [];
    var checkNames = input.checkNames || [];
    var now = input.now || new Date().toISOString();

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
    prs.map(function (pr) {
        var v = headVerdict(pr.head && pr.head.sha);
        return {
            pr: pr.number,
            title: pr.title,
            author: pr.user && pr.user.login,
            branch: pr.head && pr.head.ref,
            head: pr.head && pr.head.sha,
            labels: (pr.labels || []).map(function (l) {
                return l && l.name || l;
            }),
            checks: v ? { verdict: v.state, at: v.at, url: v.url } : null,
            // FIFO position inside approved_queue is filled after the sort
            queuePos: null
        };
    }).sort(function (a, b) { return a.pr - b.pr; })
      .forEach(function (card) { lanes[laneOf({ labels: card.labels })].push(card); });

    // approved FIFO positions (1-based; the mutex takes pos 1 on arm)
    (lanes.approved_queue || []).forEach(function (card, i) {
        card.queuePos = i + 1;
    });

    return {
        schema: 1,
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

// Single-quote an argv token, splicing shell substitutions around a marker:
// quotedWithSub('a__OID__b', '__OID__', 'gh api ...') =>
//   'a'"$(gh api ...)"'b'    ($() expands OUTSIDE the single quotes)
function quotedWithSub(s, marker, cmd) {
    return s.split(marker).map(shellQuote).join('"$(' + cmd + ')"');
}

/**
 * Pure: the gh commands that publish `state` (board URL derivable without
 * running them). First command bootstraps the data branch (fails harmlessly
 * when it exists); second commits data/<asset> via createCommitOnBranch —
 * expectedHeadOid is resolved IN-SHELL, so concurrent ticks fail open and
 * the next tick retries.
 */
function publishCommands(state, cfg) {
    var repo = (cfg && cfg.repo) || state.repo;
    var branch = tagOf(cfg);
    var asset = assetName(state, cfg);
    var path = 'data/' + asset;
    var json = JSON.stringify(state);
    var input = JSON.stringify({
        branch: { repositoryNameWithOwner: repo, branchName: branch },
        message: { headline: 'factory state — ' + (state.tick && state.tick.at || '') },
        fileChanges: { additions: [{ path: path, contents: json }] },
        expectedHeadOid: '__OID__'
    });
    var inputArg = quotedWithSub(input, '__OID__',
        'gh api repos/' + repo + '/git/ref/heads/' + branch + ' --jq .object.sha');
    return [
        'gh api -X POST repos/' + repo + '/git/refs -f ref=refs/heads/' + branch +
            ' -f sha="$(gh api repos/' + repo +
            '/git/ref/heads/$(gh api repos/' + repo +
            ' --jq .default_branch) --jq .object.sha)"',
        'gh api graphql -f query=\'mutation($input: CreateCommitOnBranchInput!)' +
            '{ createCommitOnBranch(input: $input) { commit { oid } } }\'' +
            ' -F input=' + inputArg
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
    publishCommands(state, cfg).forEach(function (c) { exec({ command: c }); });
    return 'https://raw.githubusercontent.com/' + repo + '/' + branch +
        '/data/' + asset;
}

function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

module.exports = {
    buildFactoryState: buildFactoryState,
    publishCommands: publishCommands,
    quotedWithSub: quotedWithSub,
    publishFactoryState: publishFactoryState,
    assetName: assetName,
    tagOf: tagOf,
    laneOf: laneOf,
    hasLabel: hasLabel,
    DEFAULT_TAG: DEFAULT_TAG
};
