/**
 * GitHub state source for the SM rule engine.
 *
 * On GitHub the tracker IS the state machine: issue labels carry the
 * machine-loop state (agent:dev / ai_developed / pr_approved / …) and PR
 * facts carry CI/merge observations. Two carrier modes, mirroring how the
 * loop actually spawns work:
 *
 *   query: { type: 'issue', labels, notLabels, assignee, prChecks, … }
 *     The issue is the state carrier; the linked PR (branch
 *     <branchPrefix><n> or a "#n" reference in the PR body) ENRICHES the
 *     observation (guards on prChecks / prMergeState apply only when a PR
 *     is linked — the Jira-era shape).
 *
 *   query: { type: 'pr', labels, notLabels, checks, mergeState, … }
 *     The PR itself is the state carrier — covers PRs born without an
 *     issue. Guards read PR labels + checks + merge state directly.
 *
 * All I/O goes through common/smProvider.js (bridge tools; gitlab twin
 * speaks the same contract), so this source is forge-portable as-is.
 *
 * Item shape:
 *   { key: 'gh-125' | 'pr-127', labels, pr: {number,state,checks,mergeState,
 *     mergeable} | null, issueNumber, prNumber }
 */
'use strict';

var smProviderModule = require('../../common/smProvider.js');
var machineAuthorModule = require('../../common/machineAuthor.js');
var smAsyncModule = require('../../common/smAsync.js');
var mutexRegistryModule = require('../../common/mutexRegistry.js');
var mutexRegistryModule = require('../../common/mutexRegistry.js');

// runAsync worker sources — STRING literals of CLOSURE-FREE functions.
// The Dart runtime serializes them via fn.toString() and runs each on a
// fresh, fully-wired worker engine; EVERYTHING they need travels via args
// (the per-tick ioCache snapshot rides args.preseed — worker isolates
// cannot see the main isolate's module-level cache). require() resolves
// against the main script's directory snapshot, so './common/smProvider.js'
// lands on js/common/smProvider.js. Without runAsync (Java/GraalJS parity,
// unit-test harness) smAsync falls back to sequential in-process eval of
// the same source — one code path, two execution strategies. READ fan-out
// only: rule sequencing, mutex and all actions stay on the main engine.
var PR_STATUS_WORKER_SOURCE = [
    'function(args) {',
    "    var mod = require('./common/smProvider.js');",
    "    var p = mod.createSmProvider({ scm: { provider: 'github' }, repository: args.repo, preseed: args.preseed });",
    '    return p.prStatus(args.n);',
    '}'
].join('\n');

var ISSUE_ENRICH_WORKER_SOURCE = [
    'function(args) {',
    "    var mod = require('./common/smProvider.js');",
    "    var p = mod.createSmProvider({ scm: { provider: 'github' }, repository: args.repo, preseed: args.preseed });",
    '    var prRef = p.findPr(args.n, args.prefix);',
    '    var pr = null;',
    "    if (prRef && prRef.state === 'OPEN') {",
    '        pr = p.prStatus(prRef.number);',
    '    }',
    '    return { prRef: prRef, pr: pr };',
    '}'
].join('\n');

var ISSUE_SEARCH_WORKER_SOURCE = [
    'function(args) {',
    '    function parseMcp(result) {',
    '        if (!result) return null;',
    "        if (typeof result === 'string') {",
    '            try { return JSON.parse(result); } catch (e) { return null; }',
    '        }',
    '        return result;',
    '    }',
    '    function asList(parsed) {',
    '        if (!parsed) return [];',
    '        if (Array.isArray(parsed)) return parsed;',
    '        if (Array.isArray(parsed.data)) return parsed.data;',
    '        if (Array.isArray(parsed.items)) return parsed.items;',
    '        return [];',
    '    }',
    '    var d = args.descriptor;',
    "    var query = 'repo:' + args.repo.owner + '/' + args.repo.repo +",
    "        ' is:issue is:open ' +",
    "        (d.kind === 'label' ? 'label:\"' + d.label + '\"' : 'assignee:' + args.assignee);",
    '    return { descriptor: d, items: asList(parseMcp(github_search_issues({ query: query }))) };',
    '}'
].join('\n');

function parseMcp(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

function asList(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.items)) return parsed.items; // github_search_issues shape
    return [];
}

function issueLabels(it) {
    return (it.labels || []).map(function (l) { return l.name || l; });
}

function prLabels(p) {
    return (p.labels || []).map(function (l) { return (l && l.name) || l; });
}

// ── Priority tiers (owner directive 2026-10-08) ─────────────────────────────
// A PR's priority tier breaks the FIFO tie inside the approved merge window:
//   blocker (rank 0) — jumps the queue: gets the validation slot (the
//                      ai_validating mutex) and merge priority FIRST, ahead
//                      of older medium PRs;
//   medium  (rank 1) — the default tier: a PR with NO priority label is
//                      medium (the medium label is NOT required to exist);
//   low     (rank 2) — sinks below all mediums.
// The label may sit on the PR itself OR on its LINKED ISSUE (either carrier
// counts — the issue is the machine-loop anchor, humans triage there).
// Label NAMES are configurable per project (.dmtools/config.js
// smPriorityLabels; smAgent validates + passes them through ctx) — a
// project may define only some tiers; absent entries degrade to these
// defaults, and absent labels always mean medium.
var DEFAULT_PRIORITY_LABELS = {
    blocker: 'priority_blocker',
    medium: 'priority_medium',
    low: 'priority_low'
};
var PRIORITY_RANKS = { blocker: 0, medium: 1, low: 2 };

// gh-922: the sticky-park label (shared vocabulary with smAgent's
// validation_failed park) — a parked item's blocker tier is voided so a
// park can never preempt the FIFO.
var PARKED_LABEL = 'validation_failed';

// gh-922 (fail-open dispatch): how many EXTRA tier-sorted candidates
// queryPrs returns past `limit` so the engine loop can fall through to
// the next candidate in the same tick when a trigger fails (422 no-ref).
// The engine's processedKeys cap still bounds successful dispatches at
// `limit` — the reserve is only reachable when earlier candidates yield.
//
// BOUND (review PRRT_kwDORYAuYs6tR-Jq): the fixed 3 covers at most three
// CONCURRENTLY UNPARKED dead heads — the shape that re-starved the FIFO
// pre-fix. Beyond that the bench closes the loophole: a head that parks
// validation_failed AND loses its ref (benchDeadHeadParks) leaves the
// candidate list entirely, so accumulated dead heads stop consuming
// reserve slots after their cap-driven park (≤ cap ticks of markers
// each). 4+ SIMULTANEOUS UNPARKED dead heads before any of them parks
// can still starve one tick's slice — bounded, not eliminated.
var TRIGGER_FALLTHROUGH_RESERVE = 3;

// Defensive twin of smAgent's resolvePriorityLabels: the ctx knob arrives
// pre-validated, but this source is also called directly (tests, forges) —
// anything that is not a non-empty string keeps the default name.
function resolvePriorityLabels(cfg) {
    var out = {
        blocker: DEFAULT_PRIORITY_LABELS.blocker,
        medium: DEFAULT_PRIORITY_LABELS.medium,
        low: DEFAULT_PRIORITY_LABELS.low
    };
    if (cfg && typeof cfg === 'object') {
        ['blocker', 'medium', 'low'].forEach(function (tier) {
            var v = cfg[tier];
            if (typeof v === 'string' && v) out[tier] = v;
        });
    }
    return out;
}

// Linked-issue label cache — same per-tick TTL pattern as smProvider's
// ioCache (60s): every PR-rule query in one tick re-runs queryPrs, and
// without the cache each pass would re-fetch the same issues' labels.
// Entry shape: [] labels (fetched) | null (fetch failed → PR-side labels
// only, tier degrades toward medium — never wedges the queue on I/O).
var PRIORITY_ISSUE_LABEL_TTL_MS = 60 * 1000;
var _priorityIssueLabelCache = { entries: {} };

function cachedIssueLabels(repoInfo, issueNumber) {
    var key = (repoInfo.owner || '') + '/' + (repoInfo.repo || '') +
        ':issueLabels:' + issueNumber;
    var hit = _priorityIssueLabelCache.entries[key];
    if (hit) {
        if (Date.now() - hit.at > PRIORITY_ISSUE_LABEL_TTL_MS) {
            delete _priorityIssueLabelCache.entries[key];
        } else {
            return hit.data;
        }
    }
    var labels = null;
    if (typeof github_get_issue === 'function') {
        try {
            // Exact call shape of the smAgent sites (gh-601): the sync tool
            // does NOT throw on 404 — it returns the REST error body, which
            // carries `message` and no usable labels.
            var res = github_get_issue({
                workspace: repoInfo.owner,
                repository: repoInfo.repo,
                issueNumber: issueNumber
            });
            var obj = (typeof res === 'string') ? parseMcp(res) : res;
            if (obj && typeof obj === 'object' && !obj.message) {
                labels = issueLabels(obj);
            }
        } catch (e) { labels = null; }
    }
    _priorityIssueLabelCache.entries[key] = { at: Date.now(), data: labels };
    return labels;
}

// Tier of one PR-carrier item. The PR's own blocker label short-circuits
// (nothing on the issue can outrank it, so the issue fetch is skipped);
// otherwise the linked issue's labels join the PR's. Blocker wins over any
// other combination, low only when neither carrier says blocker.
function priorityTier(item, pl, repoInfo) {
    var prLs = item.labels || [];
    if (prLs.indexOf(pl.blocker) !== -1) return 'blocker';
    var issLs = item.issueNumber ? cachedIssueLabels(repoInfo, item.issueNumber) : null;
    if (issLs && issLs.indexOf(pl.blocker) !== -1) return 'blocker';
    if (prLs.indexOf(pl.low) !== -1 || (issLs && issLs.indexOf(pl.low) !== -1)) return 'low';
    return 'medium'; // no label anywhere — the default tier (label not required)
}

// gh-922 (parked items don't preempt): the sticky validation_failed park
// voids a BLOCKER tier to medium — a parked PR waits in plain FIFO order
// instead of jumping the queue it can no longer be dispatched against
// (the park's existing rule: parked PRs leave the merge-window lanes).
// Extracted from queryPrs so the query function keeps its CRAP ratchet
// (quality gate: per-function complexity, comp tracked by baseline).
function voidParkedBlockerTier(item) {
    if (item.priorityTier === 'blocker' &&
        (item.labels || []).indexOf(PARKED_LABEL) !== -1) {
        item.priorityTier = 'medium';
    }
}

// gh-922 (dead-head park bench, review PRRT_kwDORYAuYs6tR-Jq): a parked
// PR whose head ref is GONE can never be dispatched against — every lane
// that matches it burns a trigger failure plus a fallthrough-reserve slot
// per tick, and 4+ such heads re-starve the FIFO the reserve protects.
// The provider's branchExists verdict (branchHeads snapshot + the #639
// single-branch probe for the page-1 listing cutoff) benches exactly the
// dead ones. Red-parked PRs (label present, branch LIVE) stay candidates:
// the park-reset lane must keep finding them. Fail-open — no provider
// oracle, a probe error, or an empty branch keeps the item (today's
// behavior; a blind tick never strands a candidate).
// gh-1057 (live fa pr-1591): the probe must run against the PR's HEAD
// repository — for a fork PR the branch lives on the fork (head.repo
// full name), never on the base, where the probe was a guaranteed 404
// that parked restored forks forever. A missing headRepo (same-repo PR
// whose list payload lacks head.repo, deleted-fork status, legacy
// provider) keeps the base probe.
function isDeadHeadParked(item, provider) {
    if (!item.branch || item.labels.indexOf(PARKED_LABEL) === -1) return false;
    var headFull = item.headRepo || (item.pr && item.pr.headRepo) || null;
    try {
        return provider.branchExists(item.branch, headFull) === false;
    } catch (eBench) { return false; }
}

function benchDeadHeadParks(list, provider) {
    if (!provider || typeof provider.branchExists !== 'function') return list;
    var live = list.filter(function (it) {
        if (isDeadHeadParked(it, provider)) {
            console.log('   🪦 benched dead-head park pr-' + it.prNumber +
                ' — head ref ' + it.branch + ' is gone (gh-922); ' +
                'restore/re-push the branch to re-enter the queue');
            return false;
        }
        return true;
    });
    return live.length === list.length ? list : live;
}

// gh-944 dev-on-assignment guard predicate: TRUE when the query demands no
// OPEN linked PR (`noOpenPr`) and the item still carries one — the issue is
// post-dev and the PR lifecycle rules own it. Excluding only OPEN keeps the
// recovery shapes eligible: a MERGED-PR issue a human reopened and a PR-less
// issue are fresh dev handoffs.
function hasOpenLinkedPr(q, item) {
    return !!(q.noOpenPr && item.pr && item.pr.state === 'OPEN');
}

// `owner` (repoInfo.owner) rides through for the release-bump form of the
// machine-authorship gate (#1104): chore/release-v* | chore(release): from
// the repo owner counts as machine — see common/machineAuthor.js.
// ── Guard helpers (gh-1009) ─────────────────────────────────────────────────
// matchesGuards is an orchestration shell; each guard decision group lives in
// one module-level helper below so the per-function complexity stays under
// the CRAP ratchet. Behaviour byte-identical: same guard order, same
// fail-open/fail-closed shapes, same lazy provider reads (the side-effecting
// probes — lastReview / latestVerdictRecord / reviewThreads /
// cachedIssueLabels — keep their relative order).

// Shared string-or-list normalizer (string|string[] → string[]|null).
// gh-944 CI: every guard decision routed through the helpers keeps the
// noOpenPr-era complexity neutral (baseline-locked by the CRAP ratchet).
function wantList(want) {
    return Array.isArray(want) ? want : (want ? [want] : null);
}

// The live provider reports `checkConclusion`; older stubs (and the
// issue-path placeholder) use `checks`. Accept both everywhere.
function _checkRollup(pr) {
    return pr ? (pr.checkConclusion || pr.checks) : undefined;
}

function _labelListMatch(anyOf, prLs) {
    return anyOf.some(function (l) { return prLs.indexOf(l) !== -1; });
}

function _issueCarrierGuardsFail(q, labels, item) {
    if (q.notLabels && _labelListMatch(q.notLabels, labels)) return true;
    // gh-944 dev-on-assignment: an issue whose linked PR is OPEN is
    // post-dev — the PR lifecycle rules own it (hasOpenLinkedPr carries
    // the eligibility detail: MERGED-PR / PR-less stay fresh dev handoffs).
    if (hasOpenLinkedPr(q, item)) return true;
    // 'blocked' = human hold (fa #939): the machine skips the item
    // ENTIRELY — all rules, all legs — until a human removes the label.
    if (labels.indexOf('blocked') !== -1) return true;
    return false;
}

function _prChecksGuardsFail(q, item) {
    // Array form (like mergeState): the dispatch-CI bridge reports a
    // PENDING check run on every fresh head, so "no CI yet" is either
    // 'none' or 'pending' — validate-fresh matches both.
    if (q.prChecks && wantList(q.prChecks).indexOf(_checkRollup(item.pr)) === -1) return true;
    if (q.checks && wantList(q.checks).indexOf(_checkRollup(item.pr)) === -1) return true;
    return false;
}

function _prMergeStateGuardFail(q, item) {
    if (q.prMergeState && (!item.pr || item.pr.mergeState !== q.prMergeState)) return true;
    return false;
}

function _mergeStateListGuardFail(q, item) {
    var msWant = wantList(q.mergeState);
    if (msWant && (!item.pr || msWant.indexOf(item.pr.mergeState) === -1)) return true;
    return false;
}

function _notMergeStateListGuardFail(q, item) {
    // Array form (owner FIFO rule 2026-09-22): exclude PRs in ANY of the
    // listed states — validate-armed skips BEHIND (refresh first) AND
    // DIRTY (conflict-rework owns the oldest).
    var nmsWant = wantList(q.notMergeState);
    if (nmsWant && (!item.pr || nmsWant.indexOf(item.pr.mergeState) !== -1)) return true;
    return false;
}

function _latchWantedLabels(q, item) {
    var latchState = item.pr.mergeState;
    var latchWant = latchState ? q.mergeStateLatch[latchState] : null;
    // Normalize string | string[] exactly like notMergeState / mergeState /
    // checks — a bare string iterated as an array would index CHARACTERS
    // and silently disable the arm.
    if (typeof latchWant === 'string') latchWant = [latchWant];
    return latchWant || null;
}

// gh-829 mergeState latch: a listed merge state matches ONLY when the PR's
// linked issue carries the latch label(s). Fails CLOSED: no linked issue,
// fetch failure, or a missing label excludes the state, never matches it.
function _mergeStateLatchGuardFail(q, item, repoInfo) {
    // Fail closed standalone: an item with NO merge-state observation must
    // not sail through a latch over a listed state — unknown is not CLEAN.
    if (!item.pr) return true;
    var latchWant = _latchWantedLabels(q, item);
    if (!latchWant) return false;
    var latchIssue = (item.issueNumber && repoInfo)
        ? cachedIssueLabels(repoInfo, item.issueNumber) : null;
    if (!latchIssue) return true;
    return latchWant.some(function (l) { return latchIssue.indexOf(l) === -1; });
}

function _lastReviewFor(provider, prNumber) {
    return (provider && provider.lastReview) ? provider.lastReview(prNumber) : null;
}

// Stale review verdict (PR #690): CHANGES_REQUESTED pinned to an older
// commit while fixes landed on a newer green head — a re-review is owed.
function _isStaleChangesRequested(lr, item) {
    return !!(lr && lr.state === 'CHANGES_REQUESTED' && item.pr &&
              item.pr.headSha && lr.commitId &&
              lr.commitId !== item.pr.headSha);
}

function _reviewStaleGuardFail(q, item, provider) {
    if (!q.reviewStale) return false;
    return !_isStaleChangesRequested(_lastReviewFor(provider, item.prNumber), item);
}

// ANY verdict (not just CHANGES_REQUESTED) rendered on an older commit —
// pairs with threadsResolved so a re-review fires once per head change.
function _verdictOnOlderHead(lv, item) {
    return !!(lv && lv.commitId && item.pr && item.pr.headSha &&
              lv.commitId !== item.pr.headSha);
}

function _staleVerdictGuardFail(q, item, provider) {
    if (!q.staleVerdict) return false;
    return !_verdictOnOlderHead(_lastReviewFor(provider, item.prNumber), item);
}

function _latestVerdictRec(provider, prNumber, headSha, machineAuthor) {
    // gh-807: pins the gh-728 machine-author allowlist (gh-828 review
    // round 2) — the marker format is public, so only machine-authored
    // markers count. Fail-open: no probe → null → guards inert.
    // Call THROUGH the provider: latestVerdictRecord's body rides
    // `this.verdictRecords` — an extracted unbound probe crashes with
    // TypeError "not a function" the moment a real candidate reaches the
    // verdict probe (live: fa SM ticks died on the gh-807 shape-1 query,
    // 2026-10-18).
    if (!provider || typeof provider.latestVerdictRecord !== 'function') return null;
    return provider.latestVerdictRecord(prNumber, headSha,
        { authorLogins: machineAuthorModule.machineAuthorLogins(machineAuthor) });
}

function _notLatestVerdictHit(q, lvVerdict) {
    return !!(q.notLatestVerdict && lvVerdict &&
              q.notLatestVerdict.indexOf(lvVerdict) !== -1);
}

function _latestVerdictMiss(q, lvVerdict) {
    return !!(q.latestVerdict &&
              (!lvVerdict || q.latestVerdict.indexOf(lvVerdict) === -1));
}

function _verdictRecordGuardsFail(q, item, provider, machineAuthor) {
    if (!q.notLatestVerdict && !q.latestVerdict) return false;
    var lvRec = _latestVerdictRec(provider, item.prNumber,
        item.pr && item.pr.headSha, machineAuthor);
    var lvVerdict = lvRec && lvRec.record ? lvRec.record.verdict : null;
    if (_notLatestVerdictHit(q, lvVerdict)) return true;
    if (_latestVerdictMiss(q, lvVerdict)) return true;
    return false;
}

function _reviewThreadsFor(provider, prNumber) {
    return (provider && provider.reviewThreads) ? provider.reviewThreads(prNumber) : null;
}

function _threadsGuardsFail(q, item, provider) {
    // All review threads resolved (at least one exists): the rework leg
    // resolved the review's findings — a fresh verdict is owed. gh-683:
    // the explicit FALSE direction — unresolved threads exist — arms
    // rework on machine-authored PRs. total 0 matches neither direction.
    if (q.threadsResolved === true) {
        var th = _reviewThreadsFor(provider, item.prNumber);
        return !(th && th.total > 0 && th.unresolved === 0);
    }
    if (q.threadsResolved === false) {
        var tho = _reviewThreadsFor(provider, item.prNumber);
        return !(tho && tho.unresolved > 0);
    }
    return false;
}

function _machineAuthorGuardFail(q, item, machineAuthor, owner) {
    // Machine-author gate (owner rule): auto legs only fire on
    // machine-authored PRs — the deployment's machine login, or a
    // release-bump PR authored by the repo owner (#1104). Fail-closed.
    if (!q.prMachineAuthor) return false;
    return !machineAuthorModule.isMachineAuthored(item, machineAuthor, owner);
}

function _mergeableGuardFail(q, item) {
    if (q.mergeable === true && (!item.pr || item.pr.mergeable !== true)) return true;
    return false;
}

function _prStateGuardFail(q, item) {
    if (q.prState && (!item.pr || item.pr.state !== q.prState)) return true;
    return false;
}

function _prSideBlockedLabel(prLs) {
    // 'blocked' on the PR side of an issue-carrier item freezes it too.
    return prLs.indexOf('blocked') !== -1;
}

function _prLabelMatchGuardsFail(q, prLs) {
    if (q.prLabels && !_labelListMatch(q.prLabels, prLs)) return true;
    if (q.notPrLabels && _labelListMatch(q.notPrLabels, prLs)) return true;
    return false;
}

function _prLabelGuardsFail(q, item) {
    // PR-side label guards (issue-anchored rules): the machine loop pins
    // ai_pr_reviewed and agent:review on the PR while the rule's type is
    // issue — match/not-match reads the linked PR's labels.
    var prLs = (item.pr && item.pr.labels) || [];
    if (_prSideBlockedLabel(prLs)) return true;
    return _prLabelMatchGuardsFail(q, prLs);
}

function matchesGuards(item, rule, provider, machineAuthor, owner, repoInfo) {
    var q = rule.query || {};
    var labels = item.labels || [];
    if (_issueCarrierGuardsFail(q, labels, item)) return false;
    if (_prChecksGuardsFail(q, item)) return false;
    if (_prMergeStateGuardFail(q, item)) return false;
    if (_mergeStateListGuardFail(q, item)) return false;
    if (_notMergeStateListGuardFail(q, item)) return false;
    if (q.mergeStateLatch && _mergeStateLatchGuardFail(q, item, repoInfo)) return false;
    if (_reviewStaleGuardFail(q, item, provider)) return false;
    if (_staleVerdictGuardFail(q, item, provider)) return false;
    if (_verdictRecordGuardsFail(q, item, provider, machineAuthor)) return false;
    if (_threadsGuardsFail(q, item, provider)) return false;
    if (_machineAuthorGuardFail(q, item, machineAuthor, owner)) return false;
    if (_mergeableGuardFail(q, item)) return false;
    if (_prStateGuardFail(q, item)) return false;
    if (_prLabelGuardsFail(q, item)) return false;
    return true;
}

/**
 * Queries GitHub state for the rule.
 * @param {Object} rule - SM rule with rule.query (see module doc)
 * @param {Object} ctx  - { config, repoInfo: {owner, repo}, provider? }
 * @returns {Array<Object>} state items
 */
function query(rule, ctx) {
    var q = rule.query || {};
    var repoInfo = ctx.repoInfo || {};
    var provider = ctx.provider || smProviderModule.createSmProvider({
        scm: { provider: 'github' },
        repository: repoInfo
    });
    var branchPrefix = branchPrefixOf(rule);
    var limit = rule.limit || 50;

    var machineAuthor = machineAuthorModule.resolveMachineAuthor(ctx, ctx && ctx.config);
    var owner = repoInfo.owner || '';
    // Priority-tier label names (owner directive 2026-10-08): pre-validated
    // by smAgent from .dmtools/config.js smPriorityLabels; degrade to the
    // defaults when absent.
    var priorityLabels = resolvePriorityLabels(ctx && ctx.priorityLabels);
    if (q.type === 'pr') {
        return queryPrs(rule, provider, repoInfo, limit, machineAuthor, owner, priorityLabels);
    }
    return queryIssues(rule, provider, repoInfo, branchPrefix, limit, machineAuthor, owner);
}

// gh-944: the assignee may carry the {machineAuthor} deployment knob —
// the dev-on-assignment rule re-derives dev legs for issues assigned to
// THE MACHINE without hardcoding any login in the generic rule pack.
// Resolves against the same knob every machine-keyed guard uses
// (jobParams.machineAuthor at factory setup, config.machineAuthor per
// repo); a comma-separated list searches its FIRST login (the harness
// bot — the CI-bot twin never receives assignments). Fail-closed: an
// unresolvable placeholder (no machineAuthor configured, or a knob that
// itself carries the literal placeholder) returns null — never search
// for a literal '{machineAuthor}'.
function resolveAssigneeQuery(assignee, machineAuthor) {
    if (!assignee) return null;
    var expandedAssignee = String(assignee).replace(
        /\{machineAuthor\}/g,
        (machineAuthor === null || machineAuthor === undefined) ? '' : String(machineAuthor));
    if (expandedAssignee.indexOf('{machineAuthor}') !== -1 || expandedAssignee === '') return null;
    var assigneeLogins = machineAuthorModule.machineAuthorLogins(expandedAssignee);
    return assigneeLogins.length > 0 ? assigneeLogins[0] : null;
}

function queryIssues(rule, provider, repoInfo, branchPrefix, limit, machineAuthor, owner) {
    var q = rule.query || {};
    var full = repoInfo.owner + '/' + repoInfo.repo;
    var seen = {};
    var items = [];

    // Per-label OR search (GitHub ANDs multi-label queries). Collect ALL
    // matches — the FIFO sort at the end picks the oldest, so an early
    // per-label cut at `limit` would drop old issues behind newer ones.
    // The scans fan out through smAsync: one runAsync worker round when
    // parallelWorkers is wired, the identical sequential order otherwise.
    // Merging iterates descriptor order — labels in rule order, then the
    // assignee scan — and dedupes by number, exactly like the old inline
    // sequence.
    var descriptors = (q.labels || []).map(function (ml) {
        return { kind: 'label', label: ml };
    });
    // gh-944: the assignee may carry the {machineAuthor} deployment knob —
    // the dev-on-assignment rule re-derives dev legs for issues assigned to
    // THE MACHINE (resolveAssigneeQuery; fail-closed when unresolvable).
    var assigneeQuery = resolveAssigneeQuery(q.assignee, machineAuthor);
    if (assigneeQuery) descriptors.push({ kind: 'assignee' });

    var searchOne = function (d) {
        var queryStr = 'repo:' + full + ' is:issue is:open ' +
            (d.kind === 'label' ? 'label:"' + d.label + '"' : 'assignee:' + assigneeQuery);
        var res = parseMcp(github_search_issues({ query: queryStr }));
        return { descriptor: d, items: asList(res) };
    };

    var searchResults;
    if (descriptors.length > 1) {
        searchResults = smAsyncModule.map(descriptors, ISSUE_SEARCH_WORKER_SOURCE, function (d) {
            return { repo: repoInfo, descriptor: d, assignee: assigneeQuery };
        });
    } else {
        searchResults = descriptors.map(searchOne);
    }

    searchResults.forEach(function (r) {
        r.items.forEach(function (it) {
            if (seen[it.number]) return;
            seen[it.number] = true;
            var item = {
                key: 'gh-' + it.number,
                labels: issueLabels(it),
                pr: null,
                issueNumber: it.number,
                prNumber: null
            };
            // label-scan items keep the raw payload (today's shape);
            // assignee items never carried it.
            if (r.descriptor.kind === 'label') item._raw = it;
            items.push(item);
        });
    });

    // Linked-PR enrichment: the issue carries the state, the PR carries
    // the CI/merge observation. Multi-item batches fan out through
    // smAsync with ONE cache snapshot fetched up front and shipped to
    // every worker via args.preseed; single-item lists keep today's
    // sequential path with NO snapshot fetch (avoids the extra
    // github_list_branches call for the common single-issue case).
    var enriched;
    if (items.length > 1) {
        var snapshot = (typeof runAsync === 'function' && provider &&
            typeof provider.snapshot === 'function') ? provider.snapshot() : null;
        var enrichResults = smAsyncModule.map(items, ISSUE_ENRICH_WORKER_SOURCE, function (item) {
            return { repo: repoInfo, n: item.issueNumber, prefix: branchPrefix, preseed: snapshot };
        });
        enriched = enrichResults.map(function (r, i) {
            var item = items[i];
            var prRef = r.prRef;
            if (prRef && prRef.state === 'OPEN') {
                item.pr = r.pr;
                item.prNumber = prRef.number;
                item.branch = (item.pr && item.pr.branch) || '';
                // Write-back — same cross-rule memo contract as the
                // queryPrs batch above.
                if (provider && typeof provider.memoPrStatus === 'function') {
                    provider.memoPrStatus(prRef.number, r.pr);
                }
            } else if (prRef) {
                item.pr = { number: prRef.number, state: prRef.state,
                            checks: 'none', mergeState: 'UNKNOWN', mergeable: null };
                item.prNumber = prRef.number;
            }
            return item;
        });
    } else {
        enriched = items.map(function (item) {
            var prRef = provider.findPr(item.issueNumber, branchPrefix);
            if (prRef && prRef.state === 'OPEN') {
                item.pr = provider.prStatus(prRef.number);
                item.prNumber = prRef.number;
                item.branch = (item.pr && item.pr.branch) || '';
            } else if (prRef) {
                item.pr = { number: prRef.number, state: prRef.state,
                            checks: 'none', mergeState: 'UNKNOWN', mergeable: null };
                item.prNumber = prRef.number;
            }
            return item;
        });
    }

    var matched = enriched.filter(function (item) { return matchesGuards(item, rule, provider, machineAuthor, owner, repoInfo); });

    // FIFO: oldest issue first — github_search_issues returns newest-first,
    // which starves the oldest ticket under limit:1 rules (the oldest
    // machine-loop PR rots at the bottom of the queue). Same starvation fix
    // as the PR-carrier path below; issue number order == creation order.
    matched.sort(function (a, b) { return (a.issueNumber || 0) - (b.issueNumber || 0); });
    return matched.slice(0, limit);
}

// Linked-issue resolution (pr-carrier → issue anchor): issue-anchored legs
// dispatched for a PR (manual rework via the agent:rework PR label) need the
// issue number for the {issueNumber} input. Closing keywords first (GitHub's
// own linking semantics), then a bare #N mention — the same body convention
// findPr() relies on in the issue→pr direction. null when unlinked.
//
// #544: a '#N' preceded by a REPO QUALIFIER is a cross-repo reference, never
// a local issue anchor — 'dm.ai #601', 'org/repo#N', 'org/repo #N' must NOT
// resolve against the current repo (live: dmtools-dart PR #266 body 'Dart
// port of dm.ai #601' scraped #601 → 'gh issue view 601' 404 → guard exit 1
// → the whole SM cycle red every 15 min). Qualified mentions are stripped
// before scraping; existence of what remains is verified at dispatch time
// (smAgent localIssueExists), so dangling bare refs degrade the same way.
//
// A qualifier naming THIS repository ('acme/widgets#12' in acme/widgets) is
// not cross-repo: it is the composite ticket key the dev leg writes into the
// PR (title and body heading), and dropping it left such a PR unlinked — no
// latch, no validation, no review. It stays a local ref.
// Repo-qualified '#N' mentions: a qualifier token (owner, repo, or owner/repo — word
// chars/dots/dashes, optionally slash-separated) before '#'. The boundary class keeps closing
// keywords ('Closes #123') intact.
var QUALIFIED_REF = /(^|[^A-Za-z0-9_.\-/])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)([ \t]*)(#\d+)/g;
var CLOSING_KEYWORD = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)/i;

// 'owner/repo' of the repository the rule reads, lowercased; null when unknown.
function ownRepoName(repoInfo) {
    if (!repoInfo || !repoInfo.owner || !repoInfo.repo) return null;
    return (repoInfo.owner + '/' + repoInfo.repo).toLowerCase();
}

// Only REAL qualifiers count — the token must contain a '.' or '/' ('dm.ai #601', 'org/repo#N',
// 'org/repo #603') or attach directly to the '#' ('word#N' is not autolinked by GitHub either);
// a plain English word followed by a spaced '#N' ('Related to #45') stays a LOCAL bare-mention ref.
function isRepoQualifier(qualifier, gap) {
    return gap === '' || qualifier.indexOf('.') !== -1 || qualifier.indexOf('/') !== -1;
}

// What one 'qualifier #N' match becomes: unchanged (a closing keyword, or a spaced plain word),
// a bare local '#N' (a qualifier naming THIS repository), or dropped (another repository).
function rewriteQualifiedRef(ownRepo, m0, boundary, qualifier, gap, hash) {
    if (CLOSING_KEYWORD.test(qualifier)) return m0;
    if (ownRepo && gap === '' && qualifier.toLowerCase() === ownRepo) return boundary + hash;
    if (isRepoQualifier(qualifier, gap)) return boundary + ' ';
    return m0;
}

function linkedIssueNumber(body, repoInfo) {
    var ownRepo = ownRepoName(repoInfo);
    var text = String(body || '').replace(QUALIFIED_REF, function (m0, boundary, qualifier, gap, hash) {
        return rewriteQualifiedRef(ownRepo, m0, boundary, qualifier, gap, hash);
    });
    var m = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(text);
    if (m) return parseInt(m[1], 10);
    m = /(^|[^0-9])#(\d+)([^0-9]|$)/.exec(text);
    return m ? parseInt(m[2], 10) : null;
}


// gh-1000 — phantom mutex holder reconciliation (I1/I2/E4/AC2).
// The mutex scan below reads the holder set from the provider's per-tick
// ioCache. A holder that vanished from the live label layer (arm strip
// racing the cached open-PR list) would otherwise stay a phantom turnstile
// deferring every candidate with zero labeled open PRs (live 19:08Z:
// `slots 1/1 taken` while factory lanes.validating was empty). On a
// full-slot defer decision the holders are re-derived against a LIVE
// github_list_prs re-read — divergence means the cached view was stale:
// drop the cache entry (self-heal), record the alarm + counters, and let
// the query proceed with the corrected holder set IN THE SAME TICK (a
// queued candidate may arm immediately — AC2). Probe failure keeps the
// cached decision for one more tick (fail-closed, E4).

// Numbers of the PRs in `items` that hold the mutex label, honoring the
// same guards the scan applies (mutexAmong scope; 'blocked' exempts).
function mutexHoldersOf(items, q) {
    var among = (q.mutexAmong && q.mutexAmong.length) ? q.mutexAmong : null;
    return items.filter(function (p) {
        var labels = p.labels || [];
        if (labels.indexOf('blocked') !== -1) return false;
        if (labels.indexOf(q.mutex) === -1) return false;
        return !among || among.some(function (m) { return labels.indexOf(m) !== -1; });
    // Tolerant of both payload shapes: the github_list_prs carrier uses
    // `number`, the gh-1009 query items use `prNumber` (mutexRegistry's
    // labelHoldersOf applies the same rule — a strict `p.number` read
    // would silently empty the cached leg against the split's items).
    }).map(function (p) { return p.number !== undefined ? p.number : p.prNumber; });
}

// gh-1000 — per-tick event accumulator: the phantom-heal scan below
// records self-heal events HERE; the SM (smAgent factory-state publish
// rule) drains them once per tick via takeMutexTickSnapshot(). Module
// state, not a global — githubSource and smAgent are separate modules.
var mutexTickEvents = null;

function recordMutexTickEvent(ev) {
    mutexTickEvents = mutexRegistryModule.mergeSnapshot(mutexTickEvents, ev || {});
}

// gh-1000 — the phantom-heal probe timestamps its derived snapshots; the
// module had no ISO clock helper (the WIP called a nowIso() that was never
// defined — every live re-derive would have thrown into the fail-closed
// catch, masking the phantom forever).
function nowIso() {
    return new Date().toISOString();
}

// Probe-payload normalizer: accepts the bridge's {items:[...]} envelope or
// a bare array; anything else (junk payload) reads as null — fail-closed.
function asItemsArray(liveData) {
    var liveItems = ((liveData || {}).items || liveData || []);
    return Array.isArray(liveItems) ? liveItems : null;
}

// Live open-PR re-read for the phantom-heal probe (E4 fail-closed: any
// failure — no provider hook, malformed payload, thrown probe — reads as
// null and the caller keeps the cached decision for one more tick). The
// probe deliberately bypasses the provider's per-tick ioCache through the
// facade's listOpenPrsLive() — the cache itself may be the stale layer a
// phantom holder rides on, and the guard must name a method that really
// exists on the smProvider facade (a githubApi-style indirection never did;
// the rework review thread pinned the self-heal dead on that guard).
function livePrItems(provider, repoInfo) {
    if (!provider || typeof provider.listOpenPrsLive !== 'function' || !repoInfo) return null;
    try {
        var live = asItemsArray(provider.listOpenPrsLive());
        // The live payload carries the same label shape github_list_prs
        // returns (REST: {name} objects) — the probe's label scans read
        // PLAIN strings (same contract as the query's prLabels mapping),
        // so normalize here or every defer would misread as a phantom.
        return live ? live.map(function (p) {
            return { number: p.number, labels: prLabels(p) };
        }) : null;
    } catch (e) {
        console.log('   ⚠️ gh-1000 phantom-heal live re-read failed: ' +
            String((e && e.message) || e) + ' — keeping cached mutex decision (fail-closed)');
        return null;
    }
}

// The open-PR cache is module-level in smProvider (the provider object is
// a facade) — drop via the module, guarded for minimal test stubs.
function dropOpenPrsCache(repoInfo) {
    if (!smProviderModule || typeof smProviderModule.ioCacheDrop !== 'function') return;
    try {
        smProviderModule.ioCacheDrop(repoInfo.owner, repoInfo.repo, 'openPrs', null);
    } catch (e2) { /* probe-only */ }
}

// One holder leg of the self-heal alarm: the alarm record's normalized
// pair wins (cachedHolders may still be the raw queryPrs item objects),
// the caller's argument is the fallback. Branch-light for the CRAP gate.
function alarmHoldersOf(alarm, fallbackHolders, key) {
    var h = alarm && alarm.holders;
    var v = h && h[key];
    return v ? v : (fallbackHolders || []);
}

function logPhantomHeal(alarm, cachedHolders, liveHolders) {
    console.log('   ⚠️ ' + alarm.title + ' — ' + alarm.detail +
        ' (cached holders [' + alarmHoldersOf(alarm, cachedHolders, 'cached').join(', ') +
        '] vs live [' + alarmHoldersOf(alarm, liveHolders, 'live').join(', ') +
        ']; ioCache self-healed, defer cancelled)');
}

// gh-1000 I1/I2 — re-derive the full-slot holder set against the LIVE
// label layer; a divergent cached holder is self-healed (cache drop +
// alarm + tick counters) so a queued candidate arms in the SAME tick
// (AC2). Returns the corrected holders; fail-closed keeps `holders`.
function rederiveHoldersLive(holders, items, provider, repoInfo, q) {
    var liveItems = livePrItems(provider, repoInfo);
    if (!liveItems) return holders;
    var repoName = repoInfo.owner + '/' + repoInfo.repo;
    // The cached leg in NUMBER shape (matches the live leg) — `holders`
    // here is the query's item-object array, not numbers.
    var cachedHolders = mutexHoldersOf(items, q);
    // The reconciliation is generic over the RULE's mutex label (q.mutex) —
    // both label-layer legs derive against q.mutex, never a hardcoded
    // 'ai_validating' (a second mutex label would otherwise mis-derive
    // every full-slot defer for its rule).
    var liveHolderSet = mutexRegistryModule.derive(
        mutexHoldersOf(liveItems, q), liveItems,
        mutexRegistryModule.noCompletedRuns, repoName, nowIso(), q.mutex);
    var cachedSet = mutexRegistryModule.derive(
        cachedHolders, items, mutexRegistryModule.noCompletedRuns, repoName, nowIso(), q.mutex);
    var divergent = mutexRegistryModule.reconcile(cachedSet, liveHolderSet);
    if (divergent.selfHealed) {
        dropOpenPrsCache(repoInfo);
        logPhantomHeal(divergent.alarm, cachedHolders, liveHolderSet.holders);
        recordMutexTickEvent({
            mutexSelfHeals: 1,
            phantomHolderTicks: 1,
            // gh-1000 (rework thread): the streak key MUST ride the event —
            // without it num() coerces to 0 and the published
            // consecutivePhantomTicks stays 0 forever (only the test-only
            // recordPhantomHeal used to increment it).
            consecutivePhantomTicks: 1,
            alarm: divergent.alarm
        });
    }
    return liveHolderSet.holders;
}

// Re-derive only on a full-slot decision — keeps the mutex gate's
// zero-slot fast path allocation-free (and the query's branch count
// identical to the pre-gh-1000 shape).
function phantomHealIfFull(holders, items, provider, repoInfo, q, mutexMax) {
    if (holders.length < mutexMax) return holders;
    return rederiveHoldersLive(holders, items, provider, repoInfo, q);
}

function logMutexDefer(q, holderCount, mutexMax) {
    console.log('   🔒 mutex "' + q.mutex + '" slots ' + holderCount + '/' + mutexMax +
        ' taken — rule defers (' + (mutexMax > 1 ? 'parallel window' : 'serial FIFO') + ')');
}

function takeMutexTickSnapshot() {
    var s = mutexTickEvents;
    mutexTickEvents = null;
    return s;
}

// ── queryPrs helpers (gh-1009) ──────────────────────────────────────────────
// Same split as the guards: queryPrs keeps the orchestration (list → block
// filter → mutex → lazy status → guard filter → bench → tier sort → slice);
// every decision group is a module-level helper below, behaviour-identical.

function _openPrList(provider, repoInfo) {
    // The open-PR list rides the provider's per-tick ioCache — this site
    // fired github_list_prs once PER RULE (measured: 18 calls, one idle
    // tick, all the same payload). Providers without the cache contract
    // (gitlab stub returns null) keep the direct fetch.
    return (provider && typeof provider.listOpenPrs === 'function'
        ? provider.listOpenPrs() : null) ||
        asList(parseMcp(github_list_prs({
            workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open'
        })));
}

function _prListBranch(p) {
    return (p.head && p.head.ref) || p.headRefName || '';
}

// The issue a machine branch was cut for: '<branchPrefix><n>' exactly
// ('ai/gh-12'). The issue-carrier side already links a PR to its issue by
// this branch (provider.findPr); the PR-carrier side used only the body
// scrape, so a PR whose body names no issue stayed unlinked.
// The machine branch prefix of a rule (default 'ai/gh-') — one default for both carriers.
function branchPrefixOf(rule) {
    return rule.branchPrefix || 'ai/gh-';
}

function issueNumberFromBranch(branch, branchPrefix) {
    var b = String(branch || '');
    var prefix = String(branchPrefix || '');
    if (!prefix || b.indexOf(prefix) !== 0) return null;
    var rest = b.substring(prefix.length);
    return /^\d+$/.test(rest) ? parseInt(rest, 10) : null;
}

// An explicit reference in the body wins; the machine branch name is the fallback.
function _prIssueNumber(p, repoInfo, branchPrefix) {
    var bodyIssue = linkedIssueNumber(p.body, repoInfo);
    return bodyIssue !== null ? bodyIssue : issueNumberFromBranch(_prListBranch(p), branchPrefix);
}

// gh-1057: the head REPOSITORY of the PR as an 'owner/repo' full name
// (REST head.repo.full_name; null when the fork is deleted) — the
// dead-head bench oracle must probe THERE for fork PRs, not the base.
// gh-1059: resolved by the ONE shared smProvider resolver
// (ghPrHeadRepoFull) — never a second implementation here.
function _prListAuthor(p) {
    // REST /pulls carries the creator under `user` (no `author` key at
    // all — live-verified); GraphQL and the unit fixtures use `author`.
    if (p.user && p.user.login) return p.user.login;
    if (p.author && p.author.login) return p.author.login;
    if (p.author && p.author.name) return p.author.name;
    return '';
}

function _prItemFromPr(p, repoInfo, branchPrefix) {
    return {
        key: 'pr-' + p.number,
        labels: prLabels(p),
        pr: null,
        issueNumber: _prIssueNumber(p, repoInfo, branchPrefix),
        prNumber: p.number,
        draft: !!p.draft,
        branch: _prListBranch(p),
        headRepo: smProviderModule.ghPrHeadRepoFull(p),
        // gh-1070: the maintainer-edits probe ("Allow edits from maintainers")
        // for the fork-aware silent update — resolved by the ONE shared
        // smProvider resolver (gh-1059) so the PR-list and prStatus payload
        // dialects never drift apart. null when the payload carries no
        // field: the lane re-probes fresh, fail closed to the guest park.
        maintainerCanModify: smProviderModule.ghPrMaintainerCanModify(p),
        title: p.title || '',
        author: _prListAuthor(p)
    };
}

function _buildPrItems(prs, repoInfo, branchPrefix) {
    var items = [];
    for (var i = 0; i < prs.length; i++) items.push(_prItemFromPr(prs[i], repoInfo, branchPrefix));
    return items;
}

function _mutexMaxOf(q) {
    // gh-837 (merge cadence): q.mutexMax (default 1) — how many arms the
    // mutex admits CONCURRENTLY when the validationConcurrency knob is up.
    return (typeof q.mutexMax === 'number' && isFinite(q.mutexMax))
        ? Math.max(1, Math.floor(q.mutexMax)) : 1;
}

function _holdsMutex(it, mutexLabel, among) {
    if (it.labels.indexOf(mutexLabel) === -1) return false;
    if (!among) return true;
    // q.mutexAmong = [labels]: only holders that ALSO carry one of these
    // count — the dev lane is non-blocking by design (owner priority rule
    // 2026-09-22, live fa #801).
    return among.some(function (l) { return it.labels.indexOf(l) !== -1; });
}

function _mutexHolders(items, q) {
    return items.filter(function (it) { return _holdsMutex(it, q.mutex, q.mutexAmong); });
}

function _otherHolderCount(holders, candidate) {
    var n = 0;
    for (var hi = 0; hi < holders.length; hi++) {
        if (holders[hi] !== candidate && holders[hi].prNumber !== candidate.prNumber) n++;
    }
    return n;
}

function _applyExcludeSelfMutex(q, items, holders, mutexMax) {
    // q.mutexExcludeSelf = true (recovery-rule form): a candidate defers
    // only while ANOTHER PR holds the arm AND the candidate itself does
    // not (#577: a self-holding candidate occupies its own serialization
    // slot, so a leaked stack drains oldest-first instead of deadlocking).
    return items.filter(function (candidate) {
        var selfHolds = _holdsMutex(candidate, q.mutex, q.mutexAmong);
        var otherHolders = _otherHolderCount(holders, candidate);
        var blocked = !selfHolds && otherHolders >= mutexMax;
        if (blocked) {
            console.log('   🔒 mutex "' + q.mutex + '" slots ' + otherHolders + '/' + mutexMax +
                ' taken — candidate pr-' + candidate.prNumber +
                ' defers (' + (mutexMax > 1 ? 'parallel window' : 'serial FIFO') + ', exclude-self)');
        }
        return !blocked;
    });
}

// Returns the filtered item list, or NULL when the rule defers entirely
// (the global mutex form at cap) — the caller turns that into [].
// gh-1000: provider/repoInfo feed the phantom-heal live re-derive on a
// full-slot defer decision (phantomHealIfFull); the exclude-self form is
// untouched (it never returns the global defer).
function _applyMutexFilter(q, items, provider, repoInfo) {
    if (!q.mutex) return items;
    // Mutex (q.mutex = label): if ANY open PR holds the label, this rule
    // defers entirely. Serializes one-dispatch stages — validate-armed /
    // validate-fresh both arm ai_validating + dispatch CI; without the
    // mutex N merges = N×N validation runs (owner rule 2026-09-22).
    var mutexMax = _mutexMaxOf(q);
    var holders = _mutexHolders(items, q);
    if (q.mutexExcludeSelf) {
        return _applyExcludeSelfMutex(q, items, holders, mutexMax);
    }
    // gh-1000 I1/I2 — phantom-holder reconciliation before deferring: the
    // full-slot decision is re-derived against the LIVE label layer; a
    // divergent cached holder is self-healed (cache drop + alarm + tick
    // counters) so a queued candidate arms in the SAME tick (AC2).
    // Fail-closed (E4): probe failure keeps the cached decision.
    holders = phantomHealIfFull(holders, items, provider, repoInfo, q, mutexMax);
    // Only the global (non-exclude-self) form arms; it defers once the
    // slot count reaches mutexMax holders within mutexAmong.
    if (holders.length >= mutexMax) {
        logMutexDefer(q, holders.length, mutexMax);
        return null;
    }
    return items;
}

function _prStatusFetchNeeded(q) {
    // gh-807: the verdict guards read item.pr.headSha — they need the
    // status fetch too, or item.pr stays null and the guard never resolves.
    return q.checks || q.mergeState || q.notMergeState ||
        q.mergeable !== undefined || q.prChecks ||
        q.latestVerdict || q.notLatestVerdict;
}

function _fetchPrStatusSnapshot(provider) {
    return (typeof runAsync === 'function' && provider &&
        typeof provider.snapshot === 'function')
        ? provider.snapshot(['openPrs', 'branchHeads', 'prStatus']) : null;
}

function _absorbPrStatuses(items, provider, prStatuses) {
    items.forEach(function (item, i) {
        item.pr = prStatuses[i];
        // Workers cannot write back to the main isolate's cache —
        // absorb each computed status so the NEXT batch's snapshot
        // preseed hits instead of re-fetching the same PR per rule.
        if (provider && typeof provider.memoPrStatus === 'function') {
            provider.memoPrStatus(item.prNumber, prStatuses[i]);
        }
    });
    return items;
}

function _enrichPrItemsWithStatus(items, provider, repoInfo) {
    // Multi-PR batches fan out through smAsync with ONE cache snapshot
    // shipped to every worker via args.preseed; single-PR lists keep the
    // sequential path with NO snapshot fetch (avoids the extra
    // github_list_branches call for the common single-PR rule).
    if (items.length <= 1) {
        return items.map(function (item) {
            item.pr = provider.prStatus(item.prNumber);
            return item;
        });
    }
    // PR-rule batch: only the open-PR list + branch heads are needed by
    // the prStatus worker — skip the merged-PR leg (was ~1.8s on a busy
    // repo, zero uses in this path).
    var prSnapshot = _fetchPrStatusSnapshot(provider);
    var prStatuses = smAsyncModule.map(items, PR_STATUS_WORKER_SOURCE, function (item) {
        return { repo: repoInfo, n: item.prNumber, preseed: prSnapshot };
    });
    return _absorbPrStatuses(items, provider, prStatuses);
}

function _prListAuthorGuardsFail(item, q2, machineAuthor, owner) {
    // Author guards: `notAuthors` excludes listed logins (the external
    // one-time review rule) or vice versa.
    if (q2.notAuthors && q2.notAuthors.indexOf(item.author) !== -1) return true;
    // `notMachine` excludes machine-authored PRs without naming the
    // login — the deployment knob (machineAuthor) or a release-bump PR
    // authored by the repo owner (#1104). No machineAuthor configured
    // and no owner → inert (every green PR is reviewable).
    if (q2.notMachine &&
        machineAuthorModule.isMachineAuthored(item, machineAuthor, owner)) return true;
    if (q2.authors && q2.authors.indexOf(item.author) === -1) return true;
    return false;
}

function _assignPriorityRanks(matched, pl, repoInfo) {
    matched.forEach(function (item) {
        item.priorityTier = priorityTier(item, pl, repoInfo);
        voidParkedBlockerTier(item); // gh-922: a parked blocker waits in plain FIFO order
        item.priorityRank = PRIORITY_RANKS[item.priorityTier];
    });
}

function _priorityRankCompare(a, b) {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    return (a.prNumber || 0) - (b.prNumber || 0);
}

function _logPriorityPremption(matched, limit) {
    // Preemption marker (grep-able in tick logs): a blocker took a slot
    // a non-blocker would have held under plain FIFO. Fires only when the
    // limit actually CUT a non-blocker while keeping the blocker.
    var keptCount = Math.min(limit, matched.length);
    if (keptCount >= matched.length) return;
    var cutTiers = matched.slice(keptCount).map(function (it) { return it.priorityTier; });
    matched.slice(0, keptCount).forEach(function (it) {
        if (it.priorityTier === 'blocker' &&
            cutTiers.some(function (t) { return t !== 'blocker'; })) {
            console.log('   🥇 priority blocker pr-' + it.prNumber +
                ' preempts the FIFO queue — ' + (matched.length - keptCount) +
                ' non-blocker PR(s) yield the slot (owner rule 2026-10-08)');
        }
    });
}

function _sortAndSlicePrCandidates(matched, limit, priorityLabels, repoInfo) {
    if (matched.length > 1) {
        // PRIORITY TIERS (owner directive 2026-10-08) amend the FIFO rule
        // 2026-09-22: FIFO WITHIN a tier — primary key = tier rank
        // (blocker 0, medium 1, low 2), secondary = the age/FIFO key.
        var pl = resolvePriorityLabels(priorityLabels);
        _assignPriorityRanks(matched, pl, repoInfo);
        matched.sort(_priorityRankCompare);
        _logPriorityPremption(matched, limit);
    } else {
        // Single-candidate lists stay FIFO by PR number (the anonymous
        // comparator form matches the pre-split code — a named helper here
        // would be a never-invoked function under the CRAP ratchet).
        matched.sort(function (a, b) { return (a.prNumber || 0) - (b.prNumber || 0); });
    }
    // gh-922 (fail-open dispatch): return the limit slots PLUS a small
    // fallthrough reserve. The engine loop gives failed candidates no
    // slot credit (processedKeys only grows on success), so a failed
    // trigger (422 no-ref) lets the NEXT candidate take the slot in the
    // SAME tick; otherwise processedKeys still bounds dispatches at limit.
    return matched.slice(0, limit + TRIGGER_FALLTHROUGH_RESERVE);
}

function queryPrs(rule, provider, repoInfo, limit, machineAuthor, owner, priorityLabels) {
    var q = rule.query || {};
    var items = _buildPrItems(_openPrList(provider, repoInfo), repoInfo, branchPrefixOf(rule));

    // 'blocked' = human hold (fa #939 — documented in matchesGuards): the
    // item is invisible to EVERY rule, so it must not even act as a mutex
    // holder — a frozen PR's stale ai_validating arm would otherwise
    // serialize the whole queue forever. Filtered before the mutex scan;
    // the matchesGuards check remains the engine-level guard.
    items = items.filter(function (it) { return it.labels.indexOf('blocked') === -1; });

    // Mutex: gh-1009 split — _applyMutexFilter owns the defer decision;
    // gh-1000's phantom-holder reconciliation (phantomHealIfFull, inside
    // the global-mutex branch) re-derives a full-slot defer against the
    // LIVE label layer before returning null. Fail-closed (E4).
    items = _applyMutexFilter(q, items, provider, repoInfo);
    if (items === null) return [];
    // validate-fresh both arm ai_validating + dispatch CI; without the
    // mutex multiple approved PRs validate in parallel and every merge
    // (base move) re-invalidates the others: N merges = N×N validation
    // runs. One at a time, oldest-first (FIFO sort below) = each head
    // validates exactly once. Owner rule 2026-09-22 (live: fa #778/#779
    // both ai_validating while older #762 waited).
    //
    // q.mutexAmong = [labels]: scope the mutex to holders that ALSO carry
    // one of these labels. Owner priority rule 2026-09-22 (live: fa #801
    // pr_approved+ai_validated starved behind dev-lane ai_validating arms
    // on #831/#832/#834 — validate-armed deferred every tick while the
    // parallel dev wave re-occupied the label): the dev lane is
    // non-blocking by design, so its arms must NOT block the approved
    // merge window. Only approved-PR arms serialize the merge window
    // (the N×N re-validation invariant is a merge-window property).
    // q.mutexExcludeSelf = true (recovery-rule form): the rule's own target
    // carries the mutex label by definition (it re-dispatches CI on an
    // ALREADY armed PR), so the global scan would self-block it 100% of the
    // time — which is exactly why the recovery rules shipped with NO mutex
    // and leaked (live multi-arm, fa 2026-09-26: 7 approved PRs held
    // ai_validating at once, +1 arm per tick, while their descriptions
    // claimed validate-armed's mutex made the arm a singleton — false once
    // heads move: silent-update / BEHIND unarm races / guest pushes keep
    // feeding checks=none states). With exclude-self the mutex is evaluated
    // PER CANDIDATE (#577): a candidate defers only while ANOTHER PR holds
    // the arm AND the candidate itself does not (mutexAmong still scopes
    // the holders). One armed approved PR = the candidate itself = fires;
    // with several arms the self-holding candidates drain the stack
    // oldest-first (a stack can also freeze the drain rules themselves —
    // live: fa #1068+#1088 2026-09-30, both heads green-with-missing-CI +
    // BLOCKED, so merge-validated/fail-validation/unarm-stale matched
    // nothing and the old all-defer form deadlocked the queue ~40 min).
    // Arming stays serialized: only the global (non-exclude-self) form
    // adds the label, and it defers on ANY holder within mutexAmong.
    // gh-837 (merge cadence): q.mutexMax (default 1) — how many arms the
    // mutex admits CONCURRENTLY. The SM engine patches this onto the
    // ai_validating/pr_approved merge-window rules when the
    // validationConcurrency knob (repo var, default 1 = today's behavior)
    // is raised AND the approved queue depth is at/above the watermark —
    // N=2-3 parallel validations drain the approved FIFO at ~1 merge per
    // validation cycle instead of one. The candidate/holder accounting is
    // unchanged: mutexAmong still scopes WHO counts as a holder, 'blocked'
    // holders are invisible, and mutexExcludeSelf still lets a self-holding
    // recovery candidate drain a leaked stack — only the defer threshold
    // moves from '>=1 other holder' to '>= mutexMax other holders'.
    if (q.mutex) {
        var among = q.mutexAmong;
        var holdsMutex = function (it) {
            if (it.labels.indexOf(q.mutex) === -1) return false;
            if (!among) return true;
            return among.some(function (l) { return it.labels.indexOf(l) !== -1; });
        };
        var mutexMax = (typeof q.mutexMax === 'number' && isFinite(q.mutexMax))
            ? Math.max(1, Math.floor(q.mutexMax)) : 1;
        var holders = items.filter(holdsMutex);
        if (q.mutexExcludeSelf) {
            items = items.filter(function (candidate) {
                // #577 (fa 2026-09-30, live #1068+#1088): a candidate that
                // itself holds the mutex occupies its own serialization slot.
                // The old 'another holder exists' test made two armed PRs
                // block each other forever whenever every drain rule was
                // inapplicable (both heads green-with-missing-CI + BLOCKED +
                // not BEHIND: revalidate-armed and dead-zone each deferred on
                // the other, while merge-validated / fail-validation /
                // unarm-stale could not complete the stack — the whole queue
                // froze ~40 min until a manual unarm). Defer only when the
                // candidate does NOT hold the mutex itself; recovery-rule
                // candidates always self-hold (their query carries the arm
                // label), so a leaked stack drains oldest-first instead of
                // deadlocking. New arms still cannot leak: only the global
                // (non-exclude-self) form arms, and it still defers once the
                // slot count reaches mutexMax holders within mutexAmong.
                var selfHolds = holdsMutex(candidate);
                var otherHolders = 0;
                for (var hi = 0; hi < holders.length; hi++) {
                    if (holders[hi] !== candidate && holders[hi].prNumber !== candidate.prNumber) {
                        otherHolders++;
                    }
                }
                var blocked = !selfHolds && otherHolders >= mutexMax;
                if (blocked) {
                    console.log('   🔒 mutex "' + q.mutex + '" slots ' + otherHolders + '/' + mutexMax +
                        ' taken — candidate pr-' + candidate.prNumber +
                        ' defers (' + (mutexMax > 1 ? 'parallel window' : 'serial FIFO') + ', exclude-self)');
                }
                return !blocked;
            });
        }
    }

    // PR guards that need per-PR facts (checks/merge state) resolve lazily:
    // only when the rule actually filters on them.
    if (_prStatusFetchNeeded(q)) {
        items = _enrichPrItemsWithStatus(items, provider, repoInfo);
    }

    var matched = items.filter(function (item) {
        var labels = item.labels;
        var q2 = rule.query || {};
        if (labels.indexOf('blocked') !== -1) return false; // #939: human hold — filtered pre-mutex too; see matchesGuards
        if (q2.labels && !q2.labels.some(function (l) { return labels.indexOf(l) !== -1; })) return false;
        if (q2.notLabels && q2.notLabels.some(function (l) { return labels.indexOf(l) !== -1; })) return false;
        if (q2.draft === false && item.draft) return false;
        if (q2.branchPrefix && String(item.branch || '').indexOf(q2.branchPrefix) !== 0) return false;
        if (_prListAuthorGuardsFail(item, q2, machineAuthor, owner)) return false;
        return matchesGuards(item, rule, provider, machineAuthor, owner, repoInfo);
    });

    // gh-922 (dead-head park bench): parked candidates whose head ref the
    // provider cannot see never reach the dispatch loop. Runs before the
    // tier sort so the FIFO math below sees the benched list.
    matched = benchDeadHeadParks(matched, provider);

    // FIFO: oldest PR first (github_list_prs returns newest-first, which
    // would starve older approved PRs under limit:1 merge rules).
    return _sortAndSlicePrCandidates(matched, limit, priorityLabels, repoInfo);
}


if (typeof module !== 'undefined' && module.exports) {
    module.exports = { query: query, matchesGuards: matchesGuards,
        takeMutexTickSnapshot: takeMutexTickSnapshot,
        mutexHoldersOf: mutexHoldersOf, rederiveHoldersLive: rederiveHoldersLive,
        logPhantomHeal: logPhantomHeal };
}
