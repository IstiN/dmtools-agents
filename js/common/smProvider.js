/**
 * SM Provider — SCM-agnostic I/O for the machine-loop watchdog
 * (machineSmAgent.js).
 *
 * The watchdog's decision core is pure state → actions; this module is the
 * only place that talks to a forge. Provider selection mirrors scm.js:
 *
 *     var provider = createSmProvider({
 *         scm:    { provider: 'github' },           // 'github' | 'gitlab'
 *         repository: { owner: 'epam', repo: 'dmtools-dart' }
 *     });
 *
 * Everything goes through the unified snake_case tool surface (github_* /
 * gitlab_* MCP tools via the dmtools JS bridge) — the same abstraction the
 * rest of the agent ecosystem uses — so the watchdog runs unchanged on any
 * forge the bridge supports. The one exception today is GitHub's
 * update-branch (no native tool yet) which falls back to the gh CLI.
 *
 * Provider contract (all methods):
 *   listMachineIssues(machineLabels, agentHandle, limit) → [{number, title, labels, assignees}]
 *       Open issues carrying any machine label or the agent assignee.
 *   findPr(issueNumber, branchPrefix) → null | {number, state, branch}
 *       OPEN first (branch match <prefix><n> or body references #n), then
 *       MERGED on the branch (close-issue safety net).
 *   prStatus(prNumber) → {state, checkConclusion, mergeState, mergeable, author}
 *       checkConclusion: 'red' | 'green' | 'pending' | 'none'.
 *       author: creator login ('' when the API does not expose it) — the
 *       prMachineAuthor gate keys on it.
 *   activeMachineRuns() → [issueNumber, …]
 *       Issues with a queued/in_progress machine run right now.
 *   dispatchLeg(issueNumber, leg, reason)
 *       Fire the machine runner for that issue (leg: dev/review/rework).
 *   updateBranch(prNumber) / merge(prNumber) / closeIssue(n, comment)
 *   addIssueLabel(issueNumber, label)
 *
 * Known gaps (documented, non-fatal):
 *   - gitlab has no close-issue tool — closeIssue warns and no-ops.
 *   - gitlab activeMachineRuns cannot map a pipeline to an issue number
 *     (pipelines do not expose trigger variables) — any running API-sourced
 *     pipeline counts as "machine busy" (conservative: fewer parallel legs).
 *   - gitlab exposes no machine verdict records (gh-807: no MR-note reader
 *     in the tool catalog yet) — latestVerdictRecord is absent, so the
 *     latestVerdict/notLatestVerdict query guards never match/fail-open and
 *     the reconciliation stays GitHub-machine-loop behavior for now.
 */
'use strict';

// ── Per-tick I/O cache ────────────────────────────────────────────────────
// One TTL cache (60s) for the whole SM tick. Measured on a busy tick: the
// same open-PR list was re-fetched per rule AND per issue findPr (18
// github_list_prs calls returning the same payload in ONE tick). Routing
// the three list sites + prStatus through this cache collapses that to a
// single fetch per kind per repo. TTL hits change nothing observable —
// same payload, same 60s staleness budget as the old per-provider memo
// (the branchHead cache below), now shared across every provider instance
// created during the tick.
//
// runAsync workers are FRESH isolates with an empty module cache: they
// cannot see this holder. createSmProvider({ preseed }) re-hydrates it
// from an args-carried snapshot() bundle — the fan-out in
// sm/sources/githubSource.js ships the snapshot to each worker that way.
var SM_IO_CACHE_TTL_MS = 60 * 1000;
var _cache = { ttlMs: SM_IO_CACHE_TTL_MS, entries: {} };

function ioCacheKey(owner, repo, kind, id) {
    return owner + '/' + repo + ':' + kind + (id ? ':' + id : '');
}

function ioCacheGet(owner, repo, kind, id) {
    var key = ioCacheKey(owner, repo, kind, id);
    var entry = _cache.entries[key];
    if (!entry) return undefined;
    if (Date.now() - entry.at > _cache.ttlMs) {
        delete _cache.entries[key];
        return undefined;
    }
    return entry.data;
}

function ioCachePut(owner, repo, kind, id, data) {
    _cache.entries[ioCacheKey(owner, repo, kind, id)] = { at: Date.now(), data: data };
}

// Drop ONE cached entry (owner directive 2026-10-04 "red yields the slot"):
// the SM tick mutates PR labels mid-tick (fail_validation unarms
// ai_validating) and a LATER rule in the SAME tick must observe the freed
// mutex — validate-armed re-queries the open-PR list, which rides this
// cache. Without the drop the arm rule sees the stale arm and defers the
// whole approved FIFO to the next tick (live fa 2026-10-04 11:0x: #1194
// red, seven approved PRs queued 40+ min). Invalidate-after-mutation, not
// shorter TTLs: the 60s budget stays for read-only rules.
function ioCacheDrop(owner, repo, kind, id) {
    delete _cache.entries[ioCacheKey(owner, repo, kind, id)];
}

// Collect every non-expired entry of one kind for a repo into a plain
// {id: data} map — the prStatus leg of snapshot(). Keys are the id tail
// of the cache key (PR numbers as strings).
function ioCacheCollect(owner, repo, kind) {
    var out = {};
    var prefix = owner + '/' + repo + ':' + kind + ':';
    var keys = Object.keys(_cache.entries);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(prefix) !== 0) continue;
        var entry = _cache.entries[keys[i]];
        if (Date.now() - entry.at > _cache.ttlMs) {
            delete _cache.entries[keys[i]];
            continue;
        }
        out[keys[i].substring(prefix.length)] = entry.data;
    }
    return out;
}

// Ecosystem-standard MCP result parsing (see parseMcpResult in the agent
// scripts): bridge tools may return decoded objects, JSON strings, or
// {data: …} envelopes.
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
    if (Array.isArray(parsed.pullRequests)) return parsed.pullRequests;
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.issues)) return parsed.issues;
    return [];
}
// Bookkeeping check prefixes (dmtools-agents#628/#635): check runs the
// machine stamps on its own heads that are NOT validation verdicts —
// sm-kicker fires on every non-main push, the runner wake-up probe and
// the Machine Merge Bot stamp their own bookkeeping. computePrStatus
// folds them out of the rollup; smAgent.js's gh-755 arm-time red-verdict
// probe (headHasRealFailure) skips the same set via this export so the
// two verdict readers can never drift apart.
var BOOKKEEPING_CHECK_PREFIXES = ['kicker /', 'Wake-up probe', 'merge /'];

// gh-807: machine verdict records (js/common/reviewVerdicts.js) ride the
// same ioCache as the other PR facts — the notLatestVerdict /
// latestVerdict guards may evaluate per rule per tick, and each would
// otherwise re-fetch the PR comment list (one github_get_pr_comments per
// guard evaluation; the memo collapses that to one per PR per tick).
//
// gh-823: the verdicts module is required at LOAD TIME, never lazily. A
// require executed after module init (any deferred/lazy call) resolves
// against the MAIN script's directory — the pack's js/ root — EXCLUSIVELY:
// the shipped lazy `require('./reviewVerdicts.js')` looked for
// js/reviewVerdicts.js and red every tick whose conflict-shaped queries
// screened an item ("state query failed: Failed to require module:
// ./reviewVerdicts.js") while ticks without candidates stayed green.
// Load-time requires resolve file-relative (js/common/reviewVerdicts.js —
// the module ships in every pack that carries smProvider.js, and dmtools
// compile discovers it here), so hoisting removes the deferred mode — the
// require can no longer run against a base where the module is absent.
// The ci require gate fails any release that reintroduces a deferred
// require in this module, and the pack runtime LOAD self-test loads it.
var reviewVerdicts = require('./reviewVerdicts.js');

// gh-1106: the workflows-permission rejection classifier — the same pure
// module the smAgent fork lane consumes, so the two silent-update paths
// (this provider lane and the git-chain fork lane) can never drift apart
// on WHAT counts as a workflow-write refusal. Hoisted like every require
// (gh-823): load-time, file-relative — validationLiveness.js ships in
// every pack that carries smProvider.js.
var validationLiveness = require('./validationLiveness.js');

// ── GitHub provider helpers (gh-1009) ─────────────────────────────────────
// The githubProvider closure below is an orchestration shell only: every
// decision branch lives in one of these module-level helpers so the provider
// method bodies stay trivial and the CRAP ratchet holds. Behaviour is
// byte-identical to the pre-split closure — same tool calls, same args,
// same order, same log lines. Named declarations (not anonymous closures)
// keep each helper out of the provider's own complexity count.

// Default-branch HEAD cache (one SM tick). REST mergeable_state
// lazily recomputes to `unknown` right after a base push, so
// behind/CLEAN is computed deterministically from base.sha vs the
// live branch head (github_list_branches is always current). The full
// name→sha map rides the shared per-tick ioCache: one
// github_list_branches call per repo per tick instead of one per
// unknown base branch.
function branchHeadsMap(owner, repo) {
    var cached = ioCacheGet(owner, repo, 'branches', null);
    if (cached) return cached;
    var map = {};
    if (typeof github_list_branches === 'function') {
        try {
            var branches = parseMcp(github_list_branches({
                workspace: owner, repository: repo
            })) || [];
            for (var i = 0; i < branches.length; i++) {
                var b = branches[i];
                if (b && b.name) {
                    map[b.name] = b.commit && b.commit.sha;
                }
            }
        } catch (e) { /* older runtime without the tool */ }
    }
    ioCachePut(owner, repo, 'branches', null, map);
    return map;
}

function branchHead(owner, repo, name) {
    var head = branchHeadsMap(owner, repo)[name];
    if (head !== undefined) return head;
    // dmtools-agents#639 (live fa pr-1174, 2026-10-03): github_list_branches
    // returns only page 1 (GitHub default 30; the tool has no perPage —
    // Java parity). On repos with more branches than that (one
    // 'ai/gh-*' per PR) 'main' falls off the page, this probe returns
    // null, the deterministic mergeState override NEVER runs, and
    // mergeState stays raw REST ('UNSTABLE') — merge-validated
    // (mergeState CLEAN) could not match ANYTHING. Single-branch probe
    // via gh api (cli_execute_command is whitelisted; the SM's own
    // probes already ride it). Fail-null keeps the old behavior.
    var cached = ioCacheGet(owner, repo, 'branchHead:' + name, null);
    if (cached !== null && cached !== undefined) return cached;
    try {
        var res = cli_execute_command({
            command: 'gh api "repos/' + owner + '/' + repo +
                     '/branches/' + encodeURIComponent(name) +
                     '" --jq .commit.sha'
        });
        var out = String((res || {}).output || (res || {}).stdout || res || '')
            .trim().replace(/^"|"$/g, '');
        if (/^[0-9a-f]{40}$/.test(out)) {
            ioCachePut(owner, repo, 'branchHead:' + name, null, out);
            return out;
        }
    } catch (eHeadProbe) { /* probe failed — null (override skips, pre-#639 behavior) */ }
    return null;
}

// Open / merged PR lists ride the same per-tick cache (kind openPrs /
// mergedPrs) — findPr is called per candidate issue and per rule, and
// each call used to re-fetch both lists (measured: 18 github_list_prs
// in one idle tick, all returning the same empty payload).
function listOpenPrs(owner, repo) {
    var cached = ioCacheGet(owner, repo, 'openPrs', null);
    if (cached) return cached;
    var list = asList(parseMcp(github_list_prs({
        workspace: owner, repository: repo, state: 'open'
    })));
    ioCachePut(owner, repo, 'openPrs', null, list);
    return list;
}

// gh-1000 — LIVE open-PR re-read for the phantom-mutex self-heal probe
// (githubSource rederiveHoldersLive): the per-tick ioCache is exactly the
// stale layer a phantom holder rides on, so the probe must bypass it. The
// fresh list also REFRESHES the cache entry — after a self-heal the rest
// of the tick reads the corrected layer instead of re-fetching.
function listOpenPrsLive(owner, repo) {
    var list = asList(parseMcp(github_list_prs({
        workspace: owner, repository: repo, state: 'open'
    })));
    ioCachePut(owner, repo, 'openPrs', null, list);
    return list;
}

function listMergedPrs(owner, repo) {
    var cached = ioCacheGet(owner, repo, 'mergedPrs', null);
    if (cached) return cached;
    var list = asList(parseMcp(github_list_prs({
        workspace: owner, repository: repo, state: 'merged'
    })));
    ioCachePut(owner, repo, 'mergedPrs', null, list);
    return list;
}

function ghIssueToState(it) {
    return {
        number: it.number,
        title: it.title,
        labels: (it.labels || []).map(function (l) { return l.name || l; }),
        assignees: (it.assignees || []).map(function (a) { return a.login || a; })
    };
}

// ── computePrStatus pieces (gh-1009 split; the named function stays the
// public orchestrator so the CRAP ratchet tracks it under its old key) ──

// Bookkeeping check prefixes ride the exported BOOKKEEPING_CHECK_PREFIXES.

function _ghIsBookeepingCheck(cname) {
    for (var bi = 0; bi < BOOKKEEPING_CHECK_PREFIXES.length; bi++) {
        if (cname.indexOf(BOOKKEEPING_CHECK_PREFIXES[bi]) === 0) return true;
    }
    return false;
}

var GH_RED_CHECK_CONCLUSIONS = ['FAILURE', 'TIMED_OUT'];
var GH_PENDING_CHECK_STATUSES = ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING'];

// Classify ONE rollup entry. CANCELLED is NOT a verdict: a cancelled
// validation run says nothing about the head (stale-run cleanup, quota
// sweeps, re-dispatches all cancel runs) — same handling as the
// bookkeeping checks below (dmtools-agents#628/#635, live dart gh-191).
// 'neutral' = a conclusive non-verdict entry (SUCCESS next to nothing
// pending, SKIPPED, …) — it neither reddens nor pendings the rollup.
function _ghCheckBookeepingOutcome(c) {
    var cname = String((c && (c.name || c.context)) || '');
    if (_ghIsBookeepingCheck(cname)) return 'bookeeping';
    if (c.conclusion === 'CANCELLED') return 'canceled';
    return null;
}

function _ghCheckOutcome(c) {
    var early = _ghCheckBookeepingOutcome(c);
    if (early) return early;
    if (c.conclusion && GH_RED_CHECK_CONCLUSIONS.indexOf(c.conclusion) !== -1) return 'red';
    if (!c.conclusion || GH_PENDING_CHECK_STATUSES.indexOf(c.status) !== -1) return 'pending';
    return 'neutral';
}

function _ghAccumulateCheck(acc, c) {
    var outcome = _ghCheckOutcome(c);
    if (outcome === 'bookeeping') { acc.bookept++; return; }
    if (outcome === 'canceled') { acc.ignored++; return; }
    if (outcome === 'red') acc.red = true;
    else if (outcome === 'pending') acc.pending = true;
}

// Rollup tally. Cancelled still forces 'no verdict yet' even next to
// green (a cancelled validation IS the missing verdict); bookkeeping
// checks must NOT: green validation + kicker noise stays green, or
// every pushed-branch PR would re-validate forever. A head with ONLY
// bookkeeping checks has no verdict at all → pending, which is exactly
// what validate-fresh (none|pending) arms on.
function _ghTallyRollup(rollup) {
    var acc = { red: false, pending: false, ignored: 0, bookept: 0 };
    rollup.forEach(function (c) { _ghAccumulateCheck(acc, c); });
    var realCount = rollup.length - acc.ignored - acc.bookept;
    if (acc.ignored > 0 || (realCount === 0 && acc.bookept > 0)) acc.pending = true;
    return acc;
}

function _ghNormalizeCheckRun(r) {
    return {
        name: r.name || null,
        conclusion: r.conclusion ? String(r.conclusion).toUpperCase() : null,
        status: r.status ? String(r.status).toUpperCase() : null
    };
}

// The rollup source: GraphQL statusCheckRollup when present, else the
// REST check-runs tool on the head sha (the pull body has no rollup —
// that is the GraphQL spelling; the Java-parity check-runs tool is the
// REST path). Conclusions arrive lowercase — normalize before the
// red/pending comparisons.
function _ghFetchRollup(owner, repo, pr) {
    var rollup = pr.statusCheckRollup || [];
    if (!rollup.length && pr.head && pr.head.sha) {
        var cr = parseMcp(github_get_commit_check_runs({
            workspace: owner, repository: repo, commitSha: pr.head.sha
        })) || {};
        rollup = (cr.check_runs || []).map(_ghNormalizeCheckRun);
    }
    return rollup;
}

// REST mergeable_state (uppercased) with the GraphQL passthrough, then
// the coarse mergeable bool fallback when the body carries no verdict.
function _ghRestMergeState(pr) {
    var ms = pr.mergeStateStatus ||
        (pr.mergeable_state ? String(pr.mergeable_state).toUpperCase() : '') || '';
    if (!ms) ms = pr.mergeable === true ? 'CLEAN' : 'UNKNOWN';
    return ms;
}

// Deterministic override (see branchHead): DIRTY on real conflicts,
// BEHIND when the base moved, else the REST verdict — preserving
// BLOCKED for fresh heads whose required checks are pending/red.
// Masking BLOCKED as CLEAN deadlocked unarm-stale-validation on armed
// fresh PRs (live: dart #195). Falls back to the REST verdict when the
// base ref is unknown or the head probe fails.
function _ghOverrideMergeState(pr, ms, resolveBranchHead) {
    if (pr.mergeable === false) return 'DIRTY';
    if (pr.base && pr.base.ref) {
        var head = resolveBranchHead(pr.base.ref);
        if (head) {
            if (pr.base.sha !== head) return 'BEHIND';
            // Base fresh: a REST BLOCKED is real (required checks
            // pending/red on the current head) and must survive; any
            // other REST verdict on a fresh base ('behind', 'unknown')
            // is a recompute lie — deterministically CLEAN.
            return ms === 'BLOCKED' ? 'BLOCKED' : 'CLEAN';
        }
    }
    return ms;
}

function _ghPrState(pr) {
    // REST reports `state` lowercase ('open'); guards compare against
    // 'OPEN'/'MERGED' — normalize like the check-run conclusions.
    return pr.state ? String(pr.state).toUpperCase() : 'OPEN';
}

function _ghCheckConclusionLabel(rollup, tally) {
    if (!rollup.length) return 'none';
    if (tally.red) return 'red';
    return tally.pending ? 'pending' : 'green';
}

function _ghPrAuthor(pr) {
    // Creator login — the prMachineAuthor gate keys on it. REST body
    // spells it `user`; GraphQL/tests use `author` (same dual read as
    // the PR list path).
    if (pr.user && pr.user.login) return pr.user.login;
    if (pr.author && pr.author.login) return pr.author.login;
    if (pr.author && pr.author.name) return pr.author.name;
    return '';
}

function _ghPrLabelNames(pr) {
    // PR-side labels (REST body): issue-anchored SM rules read them via
    // prLabels/notPrLabels guards — the machine loop keeps
    // ai_pr_reviewed/agent:review on the PR, not the issue.
    return (pr.labels || []).map(function (l) { return (l && l.name) || l; });
}

function _ghBuildPrStatus(pr, rollup, tally, ms) {
    return {
        state: _ghPrState(pr),
        checkConclusion: _ghCheckConclusionLabel(rollup, tally),
        mergeState: ms,
        mergeable: pr.mergeable,
        // Head sha pins the review-verdict comparison: a verdict
        // rendered on an older commit is stale after pushes.
        headSha: (pr.head && pr.head.sha) || null,
        // Head ref — SM legs dispatched on the PR branch link their
        // workflow runs to the PR (checks area + timeline).
        branch: (pr.head && pr.head.ref) || '',
        // gh-1057: the head REPOSITORY full name ('owner/repo') — a fork
        // PR's branch lives there, never in the base repo. null when the
        // REST body carries no head.repo (deleted fork) or it IS the
        // base: both keep the base-reprobe behavior downstream.
        headRepo: _ghPrHeadRepoFull(pr),
        labels: _ghPrLabelNames(pr),
        author: _ghPrAuthor(pr)
    };
}

// gh-1057: resolve the PR's head repository as an 'owner/repo' full name
// for the dead-head bench oracle. REST /pulls spells it head.repo.full_name
// (null when the fork is gone). Same-repo PRs resolve to their own full
// name — the caller compares against the base and keeps the base probe.
// gh-1059: ONE resolver, exported below and shared with
// githubSource.js — the PR-list and prStatus payload dialects must never
// drift apart again.
function _ghPrHeadRepoFull(pr) {
    var r = pr && pr.head && pr.head.repo;
    if (!r) return null;
    if (typeof r === 'string') return r.indexOf('/') !== -1 ? r : null;
    return _ghRepoShapeFull(r);
}

// gh-1059: object-shaped head.repo dialects — full_name (REST),
// nameWithOwner (GraphQL), owner+name (fixtures).
function _ghRepoShapeFull(r) {
    if (r.full_name) return r.full_name;
    if (r.nameWithOwner) return r.nameWithOwner;
    var owner = _ghRepoOwnerLogin(r);
    return owner && r.name ? owner + '/' + r.name : null;
}

// gh-1057: owner login of a repo payload — REST spells it owner.login,
// GraphQL-shaped fixtures owner.name; '' when the payload carries none.
function _ghRepoOwnerLogin(repo) {
    var o = repo && repo.owner;
    if (!o) return '';
    return o.login || o.name || '';
}

// gh-1070: the maintainer-edits probe for the fork-aware silent update.
// REST /pulls spells the field maintainer_can_modify, GraphQL
// maintainerCanModify — fixtures use either. Returns the BOOLEAN when the
// payload carries the field, null when it does not (the caller re-probes
// fresh or fails closed to the guest park — an unprobed fork push is never
// attempted). ONE exported resolver, shared with githubSource exactly like
// ghPrHeadRepoFull (gh-1059) — the PR-list and prStatus payload dialects
// must never drift apart.
function _ghPrMaintainerCanModify(pr) {
    if (!pr) return null;
    if (pr.maintainerCanModify === true || pr.maintainerCanModify === false) {
        return pr.maintainerCanModify;
    }
    if (pr.maintainer_can_modify === true || pr.maintainer_can_modify === false) {
        return pr.maintainer_can_modify;
    }
    return null;
}

// (was the computePrStatus closure — hoisted to module scope by gh-1009;
// resolveBranchHead injects the per-provider branchHead so the merge-state
// override keeps its deterministic base check; every step is one of the
// pure helpers above, tested directly through prStatus.)
function computePrStatus(owner, repo, prNumber, resolveBranchHead) {
    var pr = parseMcp(github_get_pr({
        workspace: owner, repository: repo, pullRequestId: prNumber
    })) || {};
    var rollup = _ghFetchRollup(owner, repo, pr);
    var tally = _ghTallyRollup(rollup);
    var ms = _ghOverrideMergeState(pr, _ghRestMergeState(pr), resolveBranchHead);
    return _ghBuildPrStatus(pr, rollup, tally, ms);
}

// ── remaining github method bodies (gh-1009) ──────────────────────────────

// gh-922 dead-head park bench oracle: does this head ref exist on the
// repo right now? The branchHeads snapshot answers the common case;
// the #639 single-branch probe rescues a page-1 listing miss. Empty
// ref fails closed; probe failure reads as absent.
function _ghBranchExists(owner, repo, name) {
    if (!name) return false;
    if (branchHeadsMap(owner, repo)[name] !== undefined) return true;
    return branchHead(owner, repo, name) !== null;
}

// gh-1057 (live fa pr-1591): a FORK PR's head branch lives on the fork,
// never on the base repo — probing the base is a guaranteed 404 that
// parks a restored fork forever. headFull ('owner/repo', from
// pr.head.repo) redirects the SAME snapshot + #639 probe machinery at
// the head repo. An absent spec, a spec naming the base, or a malformed
// spec keeps the base probe (fail-safe — today's behavior for same-repo
// PRs and blind probes alike). Fail-open note: a fork the token cannot
// read (private fork) fails the probe exactly like a deleted branch —
// branchHead reads a probe error as absent — so an unreadable fork reads
// as a dead head and the parked PR is benched; that matches pre-gh-1057
// fork behavior (the githubSource catch only rescues a THROWING oracle).
function _ghBranchExistsRef(owner, repo, name, headFull) {
    var ho = owner;
    var hr = repo;
    if (typeof headFull === 'string' && headFull.indexOf('/') !== -1) {
        var parts = headFull.split('/');
        if (parts.length === 2 && parts[0] && parts[1] &&
            !(parts[0] === owner && parts[1] === repo)) {
            ho = parts[0];
            hr = parts[1];
        }
    }
    return _ghBranchExists(ho, hr, name);
}

// snapshot(kinds?) — kinds limits which cache legs to materialize:
// the queryPrs batch only needs openPrs + branchHeads, and the
// merged-PR list was measured at ~1.8s on a busy repo for ZERO uses in
// that path. Omitted kinds stay out of the preseed.
function _ghSnapshot(owner, repo, kinds) {
    var want = {};
    (kinds || ['openPrs', 'mergedPrs', 'branchHeads', 'prStatus'])
        .forEach(function (k) { want[k] = true; });
    var out = {};
    if (want.openPrs) out.openPrs = listOpenPrs(owner, repo);
    if (want.mergedPrs) out.mergedPrs = listMergedPrs(owner, repo);
    if (want.branchHeads) out.branchHeads = branchHeadsMap(owner, repo);
    if (want.prStatus) out.prStatus = ioCacheCollect(owner, repo, 'prStatus');
    return out;
}

function _ghMergeIssueItem(seen, out, it) {
    if (seen[it.number]) return;
    seen[it.number] = true;
    out.push(ghIssueToState(it));
}

function _ghListMachineIssues(owner, repo, full, machineLabels, agentHandle, limit) {
    // GitHub search ANDs multiple label: qualifiers — run one
    // search per label (OR semantics), merge unique by number.
    var seen = {};
    var out = [];
    machineLabels.forEach(function (ml) {
        var res = parseMcp(github_search_issues({
            query: 'repo:' + full + ' is:issue is:open label:"' + ml + '"'
        }));
        asList(res).forEach(function (it) { _ghMergeIssueItem(seen, out, it); });
        if (out.length >= (limit || 50)) return; // forEach: enough
    });
    var extra = parseMcp(github_search_issues({
        query: 'repo:' + full + ' is:issue is:open assignee:' + agentHandle
    }));
    asList(extra).forEach(function (it) { _ghMergeIssueItem(seen, out, it); });
    return out.slice(0, limit || 50);
}

function _prHeadLabel(p) {
    return (p.head && p.head.label);
}

function _prBodyRefsIssue(p, bodyRe) {
    return bodyRe.test(String(p.body || ''));
}

function _ghFindOpenPr(owner, repo, issueNumber, headFilter, branch) {
    var list = listOpenPrs(owner, repo);
    var open = list.filter(function (p) {
        return _prHeadLabel(p) === headFilter;
    });
    var bodyRe = new RegExp('(^|[^0-9])#' + issueNumber + '([^0-9]|$)');
    if (!open.length) {
        open = list.filter(function (p) { return _prBodyRefsIssue(p, bodyRe); });
    }
    if (!open.length) return null;
    return { number: open[0].number, state: 'OPEN',
             branch: (open[0].head && open[0].head.ref) || branch };
}

function _ghFindMergedPr(owner, repo, headFilter, branch) {
    var merged = listMergedPrs(owner, repo).filter(function (p) {
        return _prHeadLabel(p) === headFilter;
    });
    if (merged.length) {
        return { number: merged[0].number, state: 'MERGED', branch: branch };
    }
    return null;
}

function _ghFindPr(owner, repo, issueNumber, branchPrefix) {
    // OPEN first (branch match <prefix><n> or body references #n), then
    // MERGED on the branch (close-issue safety net).
    var branch = branchPrefix + issueNumber;
    var headFilter = owner + ':' + branch;
    var open = _ghFindOpenPr(owner, repo, issueNumber, headFilter, branch);
    if (open) return open;
    return _ghFindMergedPr(owner, repo, headFilter, branch);
}

// Per-tick memo (kind prStatus, key = PR number): measured on a busy
// tick — three rules re-fetched prStatus 23× for the same 7 PRs.
// Results are read-only for callers (githubSource assigns item.pr;
// matchesGuards only reads), so sharing the cached reference is safe.
function _ghPrStatusMemo(owner, repo, prNumber, resolveBranchHead) {
    var memo = ioCacheGet(owner, repo, 'prStatus', prNumber);
    if (memo) return memo;
    var out = computePrStatus(owner, repo, prNumber, resolveBranchHead);
    ioCachePut(owner, repo, 'prStatus', prNumber, out);
    return out;
}

function _ghMemoPrStatus(owner, repo, prNumber, data) {
    // Main-engine write-back for the runAsync fan-out: worker engines
    // compute prStatus in their own isolates and hand the result back
    // through smAsync's ordered results — absorbing it here makes the
    // NEXT batch's snapshot preseed hit instead of re-fetching.
    if (data) ioCachePut(owner, repo, 'prStatus', prNumber, data);
}

function _isSubstantiveReview(r) {
    if (!r) return false;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') return true;
    return String(r.body || '').trim() !== '';
}

function _pickLatestVerdictReview(list) {
    for (var i = list.length - 1; i >= 0; i--) {
        if (_isSubstantiveReview(list[i])) return list[i];
    }
    return list[list.length - 1];
}

function _ghLastReview(owner, repo, prNumber) {
    // REST: reviews arrive chronological. Scan newest-to-oldest for the
    // latest substantive review (APPROVED / CHANGES_REQUESTED or non-empty
    // body) so bare inline thread replies (state: 'COMMENTED', body: '')
    // on a newer commit never mask an earlier review verdict (gh-1153).
    var list = asList(parseMcp(github_list_pr_reviews({
        workspace: owner, repository: repo, pullRequestId: String(prNumber)
    })));
    if (!list.length) return null;
    var r = _pickLatestVerdictReview(list);
    return {
        state: r.state || null,
        commitId: r.commit_id || r.commitId || null,
        author: (r.user && r.user.login) || null
    };
}

function _ghParseCommentList(raw) {
    var obj = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
    return Array.isArray(obj) ? obj : (obj.comments || obj.items || []);
}

function _ghFetchPrComments(owner, repo, prNumber) {
    // The COMMENT FETCH is memoized per tick (kind prVerdicts) — the
    // verdict guards may evaluate per rule and must not re-fetch.
    var memoId = String(prNumber);
    var memo = ioCacheGet(owner, repo, 'prVerdicts', memoId);
    if (memo) return memo;
    var list = [];
    try {
        var raw = parseMcp(github_get_pr_comments({
            workspace: owner, repository: repo, pullRequestId: String(prNumber)
        }));
        list = _ghParseCommentList(raw);
    } catch (e) {
        console.warn('  ⚠️ verdict-record read failed (fail-open): ' + (e.message || e));
        list = [];
    }
    ioCachePut(owner, repo, 'prVerdicts', memoId, list);
    return list;
}

function _ghVerdictRecords(owner, repo, prNumber, opts) {
    // The parse runs per call: opts.authorLogins (gh-828) is the
    // gh-728 machine-identity allowlist, and each caller may pin a
    // different one. Probe failure fails OPEN (empty list → guards
    // inert → legacy behavior).
    var allow = (opts && Array.isArray(opts.authorLogins)) ? opts.authorLogins : null;
    return reviewVerdicts.parseVerdictRecords(_ghFetchPrComments(owner, repo, prNumber),
        allow ? { authorLogins: allow } : undefined);
}

function _ghLatestVerdictRecord(provider, prNumber, headSha, opts) {
    // Newest verdict record for one head, or null when the head has
    // none — the null is what makes the query guards fail-open for
    // pre-gh-807 PRs.
    if (!headSha) return null;
    return reviewVerdicts.latestVerdictForHead(
        provider.verdictRecords(prNumber, opts), headSha);
}

// GraphQL-only surface (REST has no threads endpoint): navigate the
// {data:{repository:{pullRequest:{reviewThreads:{nodes:[…]}}}}} envelope
// by hand — parseMcp only unwraps the JSON string.
function _ghThreadNodes(res) {
    return (res && res.data && res.data.repository &&
            res.data.repository.pullRequest &&
            res.data.repository.pullRequest.reviewThreads &&
            res.data.repository.pullRequest.reviewThreads.nodes) || [];
}

function _ghReviewThreads(owner, repo, prNumber) {
    var res = parseMcp(github_get_pr_review_threads({
        workspace: owner, repository: repo, pullRequestId: String(prNumber)
    }));
    var nodes = _ghThreadNodes(res);
    var resolved = 0;
    nodes.forEach(function (t) { if (t && t.isResolved) resolved++; });
    return { total: nodes.length, resolved: resolved,
             unresolved: nodes.length - resolved };
}

function _ghThreadFirstComment(t) {
    return (t.comments && t.comments.nodes &&
            t.comments.nodes[0]) || {};
}

// reviewThreadList: the DETAILED thread list (vs the counts above) —
// each node mapped to its GraphQL resolve id, the root REST comment id
// (the reply anchor), the root author and body (the machine-auth and
// severity classification inputs) and the resolved flag. Fail OPEN to
// []: a broken threads read means "nothing eligible", never a throw.
function _ghThreadAuthor(first) {
    return (first.author && (first.author.login || first.author.name)) || '';
}

function _ghThreadLine(t) {
    return (t.line === 0 || t.line) ? t.line : null;
}

function _ghReviewThreadRow(t) {
    var first = _ghThreadFirstComment(t);
    return {
        threadId: t.id || null,
        rootCommentId: first.databaseId || null,
        resolved: t.isResolved === true,
        author: _ghThreadAuthor(first),
        body: first.body || '',
        path: t.path || null,
        line: _ghThreadLine(t)
    };
}

function _ghReviewThreadList(owner, repo, prNumber) {
    try {
        var res = parseMcp(github_get_pr_review_threads({
            workspace: owner, repository: repo, pullRequestId: String(prNumber)
        }));
        var nodes = _ghThreadNodes(res);
        var out = [];
        nodes.forEach(function (t) { if (t) out.push(_ghReviewThreadRow(t)); });
        return out;
    } catch (e) {
        console.warn('  ⚠️ review-thread list failed (fail-open): ' + (e.message || e));
        return [];
    }
}

function _ghReplyToThread(owner, repo, prNumber, thread, text) {
    // The ack reply rides the REST reply endpoint anchored on the root
    // comment id; a thread-shaped item without one degrades to a PR-level
    // comment so the ack is never lost silently.
    if (thread && thread.rootCommentId) {
        return github_reply_to_pr_thread({
            workspace: owner, repository: repo,
            pullRequestId: String(prNumber),
            inReplyToId: String(thread.rootCommentId), text: String(text || '')
        });
    }
    return github_add_pr_comment({
        workspace: owner, repository: repo,
        pullRequestId: String(prNumber), text: String(text || '')
    });
}

function _ghResolveThread(owner, repo, prNumber, thread) {
    if (thread && thread.threadId) {
        return github_resolve_pr_thread({
            workspace: owner, repository: repo,
            pullRequestId: String(prNumber), threadId: String(thread.threadId)
        });
    }
    console.warn('smProvider(github): no threadId to resolve on PR #' + prNumber);
}

function _ghRunIssueNumber(r) {
    var m = /gh-(\d+)/.exec(String(r.display_title || r.displayTitle || r.name || ''));
    return m ? parseInt(m[1], 10) : null;
}

function _ghActiveMachineRuns(workflowFile) {
    var runs = parseMcp(github_list_workflow_runs({
        workflowId: workflowFile, status: 'in_progress', perPage: 30
    })) || {};
    var queued = parseMcp(github_list_workflow_runs({
        workflowId: workflowFile, status: 'queued', perPage: 30
    })) || {};
    var all = (runs.workflow_runs || runs.workflowRuns || [])
        .concat(queued.workflow_runs || queued.workflowRuns || []);
    var issues = [];
    all.forEach(function (r) {
        var n = _ghRunIssueNumber(r);
        if (n !== null) issues.push(n);
    });
    return issues;
}

function _ghCloseIssue(owner, repo, issueNumber, comment) {
    if (comment) {
        try { github_create_comment({ workspace: owner, repository: repo, number: issueNumber, body: comment }); }
        catch (e) { console.warn('  ⚠️ close-issue comment failed: ' + (e.message || e)); }
    }
    return github_close_issue({ workspace: owner, repository: repo, number: issueNumber });
}

function _ghRemovePrLabel(owner, repo, prNumber, label) {
    // Absent label → 404; treat as an idempotent no-op.
    try {
        return github_remove_label({ workspace: owner, repository: repo, number: prNumber, label: label });
    } catch (e) {
        console.warn('  ⚠️ remove "' + label + '" from PR #' + prNumber + ': ' + (e.message || e));
        return null;
    }
}

// ── gh-1106 CRAP-ratchet split (gh-107 convention: the decision branches
// live in small module-level helpers so every function stays under the
// CRAP_THRESHOLD=8 gate) — the behavior stays byte-identical to the
// single-function version the UT-4/REG-1 suite pins: same calls, same
// order, same error texts, same finally-restores.

// The DISTINCT capability error both refusal shapes surface (E1/AC3):
// the caller parks on "needs a workflow-write token", never on the
// maintainer-edit-revoked trail.
function _ghWorkflowWriteTokenError(detail) {
    return new Error('silent update needs a workflow-write token (gh-1106): ' + detail);
}

// ONE escalated attempt with GH_TOKEN swapped to escalationToken — the
// same token-in-env pattern as the silent swap. The swap is undone in
// finally even on exception (AC7); a second workflows-class refusal
// surfaces the DISTINCT capability error (AC3), anything else propagates
// untouched.
function _ghEscalatedUpdate(update, silentToken, escalationToken) {
    set_env_variable('GH_TOKEN', escalationToken);
    try {
        return update();
    } catch (eEsc) {
        if (validationLiveness.isWorkflowsPermissionRejection(eEsc && eEsc.message)) {
            // AC3: the escalation token ALSO lacks workflow write.
            throw _ghWorkflowWriteTokenError('the escalation token was refused too — grant the App ' +
                '"Workflows: write" or use a PAT with the `workflow` scope (E1: no token available to ' +
                'this tick can finish the update)');
        }
        throw eEsc;
    } finally {
        // AC7: undo the escalation swap before the outer restore —
        // even on exception (finally runs first).
        set_env_variable('GH_TOKEN', silentToken);
    }
}

function _ghSilentUpdateBranch(full, prNumber, silentToken, restoreToken, escalationToken) {
    // Silent refresh of an armed PR: pushes made with the workflow's
    // own github.token trigger NO workflows, so the branch updates
    // without re-running the CI matrix (issue #687 — test once per
    // state, update for free).
    //
    // gh-1106 (AC6): a workflows-permission rejection means the update
    // touches `.github/workflows/*` — the silent token can NEVER create
    // or update workflow files (no `permissions:` key grants `workflows`
    // to a GITHUB_TOKEN), so the same-token retry is deterministic-
    // forever-failed. With an escalation token wired (App installation
    // token with "Workflows: write", or a PAT with the `workflow` scope)
    // the update retries ONCE with GH_TOKEN swapped to it. A second
    // workflows-class refusal surfaces a DISTINCT error naming the
    // missing capability so the caller parks on "needs a workflow-write
    // token", never on a maintainer-edit-revoked trail. Non-workflows
    // failures keep the pre-gh-1106 surface byte-identical (REG-1 — the
    // catch rethrows before any escalation machinery).
    var update = function () {
        return cli_execute_command({
            command: 'gh pr update-branch ' + prNumber + ' --repo ' + full
        });
    };
    if (!silentToken) return update();
    try {
        set_env_variable('GH_TOKEN', silentToken);
        try {
            return update();
        } catch (e) {
            if (!validationLiveness.isWorkflowsPermissionRejection(e && e.message)) throw e;
            if (!escalationToken) {
                // E1: no workflow-capable token is available — the
                // capability gap is the finding; name it and stop.
                throw _ghWorkflowWriteTokenError('the update touches .github/workflows/* which the ' +
                    'silent token can never create or update — wire an App installation token with ' +
                    '"Workflows: write" or a PAT with the `workflow` scope');
            }
            return _ghEscalatedUpdate(update, silentToken, escalationToken);
        }
    } finally {
        set_env_variable('GH_TOKEN', restoreToken || silentToken);
    }
}


function githubProvider(cfg) {
    var owner = cfg.repository.owner;
    var repo = cfg.repository.repo;
    var full = owner + '/' + repo;
    // gh-1009: the closure is an orchestration shell; every method body
    // delegates to a module-level helper above (same calls, same order,
    // same log lines). The merge-state override's branchHead resolver is
    // the one closure the helpers cannot own.
    var resolveBranchHead = function (name) { return branchHead(owner, repo, name); };

    return {
        provider: 'github',

        listOpenPrs: function () { return listOpenPrs(owner, repo); },
        listOpenPrsLive: function () { return listOpenPrsLive(owner, repo); },
        listMergedPrs: function () { return listMergedPrs(owner, repo); },

        // branchExists(name, headFull?) — gh-922 dead-head park bench
        // oracle; gh-1057: headFull redirects the probe at a fork's head
        // repo (absent/same-repo/malformed keeps the base probe).
        branchExists: function (name, headFull) {
            return _ghBranchExistsRef(owner, repo, name, headFull);
        },

        // snapshot(kinds?) — args-carried cache snapshot for the
        // runAsync worker engines (see the helper for the contract).
        snapshot: function (kinds) { return _ghSnapshot(owner, repo, kinds); },

        listMachineIssues: function (machineLabels, agentHandle, limit) {
            return _ghListMachineIssues(owner, repo, full, machineLabels, agentHandle, limit);
        },

        findPr: function (issueNumber, branchPrefix) {
            return _ghFindPr(owner, repo, issueNumber, branchPrefix);
        },

        prStatus: function (prNumber) {
            return _ghPrStatusMemo(owner, repo, prNumber, resolveBranchHead);
        },

        memoPrStatus: function (prNumber, data) {
            return _ghMemoPrStatus(owner, repo, prNumber, data);
        },

        lastReview: function (prNumber) {
            return _ghLastReview(owner, repo, prNumber);
        },

        // ── gh-807 machine verdict records (js/common/reviewVerdicts.js) ──
        verdictRecords: function (prNumber, opts) {
            return _ghVerdictRecords(owner, repo, prNumber, opts);
        },

        latestVerdictRecord: function (prNumber, headSha, opts) {
            return _ghLatestVerdictRecord(this, prNumber, headSha, opts);
        },

        reviewThreads: function (prNumber) {
            return _ghReviewThreads(owner, repo, prNumber);
        },

        // ── gh-828 post-APPROVE thread resolution primitives ──
        reviewThreadList: function (prNumber) {
            return _ghReviewThreadList(owner, repo, prNumber);
        },

        replyToThread: function (prNumber, thread, text) {
            return _ghReplyToThread(owner, repo, prNumber, thread, text);
        },

        resolveThread: function (prNumber, thread) {
            return _ghResolveThread(owner, repo, prNumber, thread);
        },

        activeMachineRuns: function (workflowFile) {
            return _ghActiveMachineRuns(workflowFile);
        },

        dispatchLeg: function (issueNumber, leg, reason, workflowFile) {
            // The bridge tool takes inputs as a JSON string (Java parity).
            return github_trigger_workflow({
                workflowId: workflowFile,
                ref: 'main',
                inputs: JSON.stringify({
                    issue: String(issueNumber), leg: leg, reason: reason || ''
                })
            });
        },

        updateBranch: function (prNumber) {
            // No native tool for the update-branch API yet — gh CLI fallback
            // (whitelisted: gh).
            return cli_execute_command({
                command: 'gh pr update-branch ' + prNumber + ' --repo ' + full
            });
        },

        merge: function (prNumber) {
            return github_merge_pr({
                workspace: owner, repository: repo, pullRequestId: prNumber, mergeMethod: 'squash'
            });
        },

        closeIssue: function (issueNumber, comment) {
            return _ghCloseIssue(owner, repo, issueNumber, comment);
        },

        addIssueLabel: function (issueNumber, label) {
            return github_add_labels({ workspace: owner, repository: repo, number: issueNumber, labels: [label] });
        },

        // ── PR lifecycle primitives (issue #687: SM owns the PR loop) ──
        // Labels ride the issues API — a PR is an issue for labeling.

        addPrLabel: function (prNumber, label) {
            return github_add_labels({ workspace: owner, repository: repo, number: prNumber, labels: [label] });
        },

        removePrLabel: function (prNumber, label) {
            return _ghRemovePrLabel(owner, repo, prNumber, label);
        },

        dispatchPrLeg: function (prNumber, leg, reason, workflowFile) {
            // PR-anchored dispatch: the factory takes the PR number as the
            // anchor instead of an issue (review of PRs born without one).
            return github_trigger_workflow({
                workflowId: workflowFile,
                ref: 'main',
                inputs: JSON.stringify({
                    issue: '', leg: leg, reason: reason || '', pr: String(prNumber)
                })
            });
        },

        silentUpdateBranch: function (prNumber, silentToken, restoreToken, escalationToken) {
            return _ghSilentUpdateBranch(full, prNumber, silentToken, restoreToken, escalationToken);
        }
    };
}

// ── GitLab provider helpers (gh-1009) ─────────────────────────────────────
// Same split as the github side: gitlabProvider is an orchestration shell
// over these module-level helpers; same gitlab_* tool calls, same order.

function _glIssueToState(it) {
    return {
        number: it.iid,
        title: it.title,
        labels: it.labels || [],
        assignees: (it.assignees || []).map(function (a) { return a.username || a; })
    };
}

function _glAssigneeLogins(it) {
    return (it.assignees || []).map(function (a) { return a.username || a; });
}

function _glIssueMatches(it, machineLabels, agentHandle) {
    // Machine labels are OR semantics: the assignee match wins, else any
    // single machine label on the issue qualifies it.
    if (_glAssigneeLogins(it).indexOf(agentHandle) !== -1) return true;
    var labels = it.labels || [];
    return machineLabels.some(function (ml) { return labels.indexOf(ml) !== -1; });
}

// gitlab_list_issues accepts comma-separated labels (AND on GitLab);
// machine labels are OR semantics, so list open issues once and filter
// client-side.
function _glListMachineIssues(owner, repo, machineLabels, agentHandle, limit) {
    var res = gitlab_list_issues({ workspace: owner, repository: repo, state: 'opened', perPage: limit || 50 }) || [];
    return (res.issues || res || []).filter(function (it) {
        return _glIssueMatches(it, machineLabels, agentHandle);
    }).map(_glIssueToState);
}

function _glMrMatches(mr, branch, bodyRe) {
    return mr.source_branch === branch || bodyRe.test(String(mr.description || ''));
}

function _glFindOpenMr(owner, repo, issueNumber, branch) {
    var bodyRe = new RegExp('(^|[^0-9])#' + issueNumber + '([^0-9]|$)');
    var open = (gitlab_list_mrs({ workspace: owner, repository: repo, state: 'opened' }) || [])
        .filter(function (mr) { return _glMrMatches(mr, branch, bodyRe); });
    if (!open.length) return null;
    return { number: open[0].iid, state: 'OPEN', branch: open[0].source_branch || branch };
}

function _glFindPr(owner, repo, issueNumber, branchPrefix) {
    var branch = branchPrefix + issueNumber;
    var open = _glFindOpenMr(owner, repo, issueNumber, branch);
    if (open) return open;
    var merged = (gitlab_list_mrs({ workspace: owner, repository: repo, state: 'merged' }) || [])
        .filter(function (mr) { return mr.source_branch === branch; });
    if (merged.length) {
        return { number: merged[0].iid, state: 'MERGED', branch: branch };
    }
    return null;
}

var GL_PENDING_PIPELINE_STATUSES = ['running', 'pending', 'created', 'waiting_for_resource'];

// gh-755 (owner directive 2026-10-05): CANCELLED is not a verdict — a
// cancelled pipeline says nothing about the head (superseded concurrency,
// quota sweeps). Fold to 'no verdict yet' exactly like the GitHub rollup.
function _glPipelineOutcome(p) {
    var st = p.status || p.detailed_status;
    if (st === 'canceled') return 'canceled';
    if (st === 'failed') return 'red';
    if (GL_PENDING_PIPELINE_STATUSES.indexOf(st) !== -1) return 'pending';
    return 'green';
}

function _glTallyPipelines(list) {
    var acc = { red: false, pending: false, any: false, cancelled: 0 };
    list.forEach(function (p) {
        acc.any = true;
        var outcome = _glPipelineOutcome(p);
        if (outcome === 'canceled') { acc.cancelled++; return; }
        if (outcome === 'red') acc.red = true;
        else if (outcome === 'pending') acc.pending = true;
    });
    if (acc.cancelled > 0) acc.pending = true;
    return acc;
}

function _glMrMergeState(mr) {
    if (mr.merge_status === 'can_be_merged' && !mr.has_conflicts) return 'CLEAN';
    if (mr.has_conflicts) return 'BEHIND'; // conflicts ⇒ needs rebase
    return 'UNKNOWN'; // incl. merge_status 'checking' (still computing)
}

function _glCheckConclusionLabel(tally) {
    if (!tally.any) return 'none';
    if (tally.red) return 'red';
    return tally.pending ? 'pending' : 'green';
}

function _glMrAuthor(mr) {
    // MR author login — the prMachineAuthor gate (GitHub twin reads
    // `user.login`; GitLab spells it `author.username`).
    return (mr.author && mr.author.username) || '';
}

function _glBuildMrStatus(mr, tally, mergeState) {
    return {
        state: mr.state ? String(mr.state).toUpperCase() : 'OPEN',
        checkConclusion: _glCheckConclusionLabel(tally),
        mergeState: mergeState,
        mergeable: mr.merge_status === 'can_be_merged' && !mr.has_conflicts,
        author: _glMrAuthor(mr)
    };
}

function _glPrStatus(owner, repo, mrNumber) {
    var mr = gitlab_get_mr({ workspace: owner, repository: repo, pullRequestId: String(mrNumber) }) || {};
    // Pipelines for the MR head — the CI verdict.
    var pipes = (gitlab_get_mr_pipelines({ workspace: owner, repository: repo, pullRequestId: String(mrNumber) }) || {});
    var list = pipes.pipelines || pipes || [];
    return _glBuildMrStatus(mr, _glTallyPipelines(list), _glMrMergeState(mr));
}

function _glActiveMachineRuns(owner, repo) {
    // Pipelines do not expose trigger variables, so an API-sourced
    // running pipeline is conservatively "the machine is busy".
    var res = gitlab_list_pipeline_runs({ workspace: owner, repository: repo, status: 'running' }) || [];
    var runs = res.pipelines || res || [];
    var api = runs.filter(function (p) { return p.source === 'api' || p.source === 'trigger'; });
    return api.length ? ['unknown'] : [];
}

function _glCloseIssue(owner, repo, issueNumber, comment) {
    // No native close-issue tool in the GitLab catalog yet — document
    // the gap, stay non-fatal.
    console.warn('  ⚠️ gitlab close-issue tool not available — issue !' +
        issueNumber + ' left open (comment-only).');
    if (comment) {
        // Issue notes ride the generic note path when present.
        try { gitlab_create_mr_note({ workspace: owner, repository: repo, pullRequestId: String(issueNumber), text: comment }); }
        catch (e) { console.warn('  ⚠️ close-issue comment failed: ' + (e.message || e)); }
    }
    return null;
}

function gitlabProvider(cfg) {
    var owner = cfg.repository.owner;   // group or user namespace
    var repo = cfg.repository.repo;

    function projectPath() { return owner + '/' + repo; }

    return {
        provider: 'gitlab',

        listOpenPrs: function () {
            // Documented gap (gitlab twin of the github contract): the
            // runAsync fan-out is github-only for now; returning null lets
            // callers skip the snapshot fetch the same way.
            return null;
        },

        snapshot: function () {
            // Documented gap — see listOpenPrs above.
            return null;
        },

        listMachineIssues: function (machineLabels, agentHandle, limit) {
            return _glListMachineIssues(owner, repo, machineLabels, agentHandle, limit);
        },

        findPr: function (issueNumber, branchPrefix) {
            return _glFindPr(owner, repo, issueNumber, branchPrefix);
        },

        prStatus: function (mrNumber) {
            return _glPrStatus(owner, repo, mrNumber);
        },

        activeMachineRuns: function () {
            return _glActiveMachineRuns(owner, repo);
        },

        dispatchLeg: function (issueNumber, leg, reason, workflowFile) {
            // The GitLab machine runner pipeline receives the leg the same
            // way ai-teammate.yml does on GitHub: variables.
            return gitlab_trigger_pipeline({
                workspace: owner,
                repository: repo,
                ref: 'main',
                variablesJson: JSON.stringify({
                    issue: String(issueNumber),
                    leg: leg,
                    reason: reason || ''
                })
            });
        },

        updateBranch: function (mrNumber) {
            return gitlab_rebase_mr({ workspace: owner, repository: repo, pullRequestId: String(mrNumber) });
        },

        merge: function (mrNumber) {
            return gitlab_merge_mr({ workspace: owner, repository: repo, pullRequestId: String(mrNumber) });
        },

        closeIssue: function (issueNumber, comment) {
            return _glCloseIssue(owner, repo, issueNumber, comment);
        },

        addIssueLabel: function (issueNumber, label) {
            // Issue-level labels ride the MR label tool shape; where the
            // project uses MR labels for machine state this is exact.
            return gitlab_add_mr_label({ workspace: owner, repository: repo, pullRequestId: String(issueNumber), label: label });
        }
    };
}

/**
 * The repository binding every forge needs: owner + repo. Anything less is
 * a loud config error (never a silent half-wired provider). Returns the
 * repository so the caller reads owner/repo off a validated shape.
 */
function requiredRepository(cfg) {
    if (!cfg.repository || !cfg.repository.owner || !cfg.repository.repo) {
        throw new Error('smProvider: repository.owner and repository.repo are required');
    }
    return cfg.repository;
}

// prStatus leg of the preseed: {number-as-string: status} — see the
// github provider's memoPrStatus for the write-back side.
function preseedPrStatuses(owner, repo, prStatus) {
    var memoIds = Object.keys(prStatus);
    for (var mi = 0; mi < memoIds.length; mi++) {
        ioCachePut(owner, repo, 'prStatus', memoIds[mi], prStatus[memoIds[mi]]);
    }
}

// Re-hydrate the per-tick ioCache from an args-carried snapshot() bundle —
// runAsync worker engines call this so their first cache read hits instead
// of re-fetching the lists the main engine already paid for.
function preseedIoCache(owner, repo, preseed) {
    if (preseed.openPrs) {
        ioCachePut(owner, repo, 'openPrs', null, preseed.openPrs);
    }
    if (preseed.mergedPrs) {
        ioCachePut(owner, repo, 'mergedPrs', null, preseed.mergedPrs);
    }
    if (preseed.branchHeads) {
        ioCachePut(owner, repo, 'branches', null, preseed.branchHeads);
    }
    if (preseed.prStatus) {
        preseedPrStatuses(owner, repo, preseed.prStatus);
    }
}

// The forge backend from the effective config (github default).
function smProviderFor(provider, cfg) {
    if (provider === 'gitlab') return gitlabProvider(cfg);
    if (provider === 'github') return githubProvider(cfg);
    throw new Error('smProvider: unknown provider "' + provider + '" (github | gitlab)');
}

/**
 * Creates the SM provider for the configured forge.
 * @param {Object} config - { scm: { provider }, repository: { owner, repo } }
 * @returns {Object} provider implementing the contract above
 */
function createSmProvider(config) {
    var cfg = config || {};
    var provider = (cfg.scm && cfg.scm.provider) || 'github';
    var repository = requiredRepository(cfg);
    if (cfg.preseed) {
        preseedIoCache(repository.owner, repository.repo, cfg.preseed);
    }
    return smProviderFor(provider, cfg);
}

if (typeof module !== 'undefined' && module.exports) {
    // _cache is exported for the unit tests (clearing/aging the holder);
    // production callers never touch it directly.
    module.exports = {
        createSmProvider: createSmProvider,
        ioCacheDrop: ioCacheDrop,
        BOOKKEEPING_CHECK_PREFIXES: BOOKKEEPING_CHECK_PREFIXES,
        // gh-1059: ONE head-repo resolver shared with githubSource.js (the
        // PR-list and prStatus payload dialects must never drift apart).
        ghPrHeadRepoFull: _ghPrHeadRepoFull,
        ghPrMaintainerCanModify: _ghPrMaintainerCanModify,
        _cache: _cache
    };
}
