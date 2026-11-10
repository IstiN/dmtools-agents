/**
 * retryMergeGithubPR.js — GitHub-issues machine loop: merge leg.
 *
 * The sm counterpart of retryMergePR.js for repos where GitHub issues (not
 * Jira) carry the machine state. Called by SM (localExecution) for issues
 * whose linked PR is approved (label pr_approved) and CI-green. Locks ride
 * sm-trigger labels on the issue exactly like the Jira flow.
 *
 * Outcomes (mirrors retryMergePR semantics):
 *  - CI running / mergeability unknown → do nothing, release lock (SM retries)
 *  - Branch behind                    → update branch, retry next cycle
 *  - Merged                           → remove pr_approved (+ lock), close issue
 *  - Conflict / CI failing            → remove pr_approved, re-label agent:rework
 *
 * Structure (gh-1416 rework): `action` is the orchestrator — every phase
 * (option resolution, repo resolution, linked-PR resolution, merge-state
 * decision, per-decision handler, squash+finalize) is its own module-level
 * function, so no lane function's CRAP exceeds the quality ratchet's
 * per-function threshold. Behavior is unchanged (the lane tests pin it).
 */
'use strict';

var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
// gh-1416: the verdict-freshness probe rides the squash-merge — the same
// merge-instant gate the merge-trigger sweep (js/mergeTrigger.js) and the
// event-driven merge bot (js/sm/mergeBot.js) run. Requires hoisted (gh-823).
var mcpParse = require('./common/mcpParse.js');
var mergeVerdictGate = require('./common/mergeVerdictGate.js');

function issueNumberFromKey(ticketKey) {
    var m = /(\d+)$/.exec(String(ticketKey || ''));
    return m ? parseInt(m[1], 10) : null;
}

function removeIssueLabel(number, label, what) {
    try {
        github_remove_label({ owner: REPO.owner, repo: REPO.repo, number: number, label: label });
        console.log('Removed "' + label + '" from ' + (what || 'issue'));
    } catch (e) {
        console.warn('Could not remove "' + label + '" from ' + (what || 'issue') + ':', e.message || e);
    }
}

function addIssueLabel(number, label, what) {
    try {
        github_add_labels({ owner: REPO.owner, repo: REPO.repo, number: number, labels: [label] });
        console.log('Added "' + label + '" to ' + (what || 'issue'));
    } catch (e) {
        console.warn('Could not add "' + label + '":', e.message || e);
    }
}

var REPO = { owner: null, repo: null };

// ── phase: option resolution ─────────────────────────────────────────────────

function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) ||
        params.customParams || {};
}

function prNumberOf(params, customParams) {
    return (params.ticket && params.ticket.prNumber) || customParams.prNumber || null;
}

function laneOptionsOf(params) {
    var customParams = customParamsOf(params);
    return {
        jobParams: params.jobParams || params,
        customParams: customParams,
        branchPrefix: customParams.branchPrefix || 'ai/gh-',
        reworkLabel: customParams.reworkLabel || 'agent:rework',
        approvedLabel: customParams.approvedLabel || 'pr_approved',
        lockLabel: customParams.removeLabel || null,
        prNumberDirect: prNumberOf(params, customParams)
    };
}

// ── phase: repo resolution ───────────────────────────────────────────────────

function explicitRepoOf(config) {
    return (config && config.repository && config.repository.owner &&
            config.repository.repo)
        ? { owner: config.repository.owner, repo: config.repository.repo }
        : null;
}

/**
 * Target repo precedence: explicit config.repository (the SM passes the
 * RULE's repo — the machine loop lives in the target repo, not in this
 * agents checkout) > git remote of CWD. getRemoteRepoInfo() alone is
 * WRONG when running from the dmtools-agents checkout: it would resolve
 * to dmtools-agents and operate on its PRs. Returns { scm, owner, repo }
 * or null when neither source resolves.
 */
function repoInfoOf(params) {
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var explicitRepo = explicitRepoOf(config);
    if (explicitRepo) {
        config = Object.assign({}, config, { repository: explicitRepo });
    }
    var scm = scmModule.createScm(config);
    var repoInfo = explicitRepo || scm.getRemoteRepoInfo();
    if (!repoInfo) return null;
    return { scm: scm, owner: repoInfo.owner, repo: repoInfo.repo };
}

// ── phase: linked-PR resolution ──────────────────────────────────────────────

function releaseLock(ctx) {
    if (ctx.lockLabel) removeIssueLabel(ctx.issueNumber, ctx.lockLabel, 'lock');
}

function branchReFor(issueNumber, opts) {
    return new RegExp('^' + opts.branchPrefix + issueNumber + '$');
}

function bodyReFor(issueNumber) {
    return new RegExp('(^|[^0-9])#' + issueNumber + '([^0-9]|$)');
}

function findInPrList(list, pred) {
    return (Array.isArray(list) ? list : []).find(pred) || null;
}

function findOpenPr(scm, issueNumber, opts) {
    var branchRe = branchReFor(issueNumber, opts);
    var bodyRe = bodyReFor(issueNumber);
    var prList = scm.listPrs('open');
    return findInPrList(prList, function (p) {
        return branchRe.test((p.head && p.head.ref) || '');
    }) || findInPrList(prList, function (p) {
        return bodyRe.test(String(p.body || ''));
    });
}

function findMergedPr(scm, issueNumber, opts) {
    var branchRe = branchReFor(issueNumber, opts);
    // Branch match wins — a body mention of "#125" is too loose (release
    // notes and cross-references also match).
    return findInPrList(scm.listPrs('merged'), function (p) {
        return branchRe.test((p.head && p.head.ref) || '');
    });
}

function cleanupMergedPr(ctx, pr) {
    console.log('PR #' + pr.number + ' already merged for ' + ctx.ticketKey + ' — cleanup');
    try { github_remove_label({ owner: ctx.owner, repo: ctx.repo, number: ctx.issueNumber, label: ctx.approvedLabel }); } catch (e) {}
    try {
        github_create_comment({ workspace: ctx.owner, repository: ctx.repo,
                                number: ctx.issueNumber, body: '✅ Merged via #' + pr.number + ' — closing.' });
    } catch (e) {}
    try {
        github_close_issue({ workspace: ctx.owner, repository: ctx.repo, number: ctx.issueNumber });
    } catch (e) {}
    releaseLock(ctx);
}

/**
 * The linked PR for the issue: explicit number > open-list branch match >
 * open-list body match > already-merged cleanup (handled inline, reported
 * as mergedHandled). Returns { pr } | { mergedHandled: true } | null.
 */
function resolveLinkedPr(ctx) {
    if (ctx.prNumberDirect) return { pr: { number: ctx.prNumberDirect } };
    var pr = findOpenPr(ctx.scm, ctx.issueNumber, ctx);
    if (pr) return { pr: pr };
    var merged = findMergedPr(ctx.scm, ctx.issueNumber, ctx);
    if (!merged) return null;
    cleanupMergedPr(ctx, merged);
    return { mergedHandled: true };
}

// ── phase: merge-state decision (the provider-surface observation) ──────────

function mergeStateOf(detail) {
    return detail.mergeable_state || detail.mergeStateStatus;
}

function isWaitState(mergeState) {
    return ['unknown', 'blocked', 'unstable', 'checking',
        'unchecked', 'preparing', 'ci_must_pass', 'ci_still_running',
        'pending'].indexOf(mergeState) !== -1;
}

function mergeStateDecision(detail) {
    var ms = mergeStateOf(detail);
    if (detail.mergeable === null || isWaitState(ms)) return 'wait';
    if (ms === 'behind' || ms === 'BEHIND') return 'behind';
    if (ms === 'dirty' || ms === 'DIRTY') return 'dirty';
    if (detail.mergeable === false) return 'dirty';
    return 'merge';
}

// ── phase: per-decision handlers ─────────────────────────────────────────────

function deferForWait(ctx, pr) {
    console.log('PR not ready to merge (' + mergeStateOf(pr.detail) + ') — will retry next cycle');
    releaseLock(ctx);
    return false;
}

function retryBehind(ctx, pr) {
    console.log('PR branch is behind base — requesting branch update');
    try {
        ctx.scm.updateBranch(pr.number, ctx.owner, ctx.repo);
    } catch (e) {
        console.warn('Branch update failed (may already be in flight):', e.message || e);
    }
    releaseLock(ctx);
    return false;
}

function returnToRework(ctx) {
    console.warn('Conflicts detected — returning to rework');
    removeIssueLabel(ctx.issueNumber, ctx.approvedLabel);
    addIssueLabel(ctx.issueNumber, ctx.reworkLabel);
    releaseLock(ctx);
    return false;
}

var WAIT_HANDLERS = {
    wait: deferForWait,
    behind: retryBehind,
    dirty: returnToRework
};

// ── phase: the merge instant + post-merge bookkeeping ────────────────────────

/**
 * gh-1416: refuse the merge while the current head's newest verdict is
 * REQUEST_CHANGES/BLOCK — the newest dmtools:review-verdict record for the
 * CURRENT head holds the merge instant (a stale pr_approved can no longer
 * race the funnel). Returns true when the caller must defer (the same
 * shape as mergeTrigger's verdictGateBeforeMerge — the extracted wiring is
 * directly unit-testable without driving the whole lane). The gate never
 * throws (it fails open internally — no records, stale-head-only records,
 * unreadable markers, and broken reads all proceed as today); a
 * wiring-level fault is absorbed fail-open here too.
 */
function verdictGateHoldsMerge(jobParams, owner, repo, prNumber, prDetail) {
    try {
        var verdictGate = mergeVerdictGate.runGateForPr(
            mergeVerdictGate.githubBridgeIo(),
            owner, repo, jobParams, prNumber,
            mcpParse.parseMcp(prDetail),
            function (line) { console.log(line); });
        if (verdictGate.held) {
            console.warn('PR #' + prNumber + ' merge deferred — newest verdict on the' +
                ' current head is ' + verdictGate.verdict + ' (gh-1416); the rework lap /' +
                ' a human resolution owns the fresh verdict');
            return true;
        }
    } catch (eGate) {
        console.warn('Verdict gate fault — fail-open (gh-1416):', eGate.message || eGate);
    }
    return false;
}

// Fixes-#N usually closes the issue on merge; this is the safety net.
function closeIssueSafetyNet(issueNumber) {
    try {
        var issue = github_get_issue({ number: issueNumber }) || {};
        var parsed = typeof issue === 'string' ? JSON.parse(issue) : issue;
        if (parsed && parsed.state === 'open') {
            github_close_issue({ number: issueNumber });
            console.log('Closed issue #' + issueNumber + ' (safety net)');
        }
    } catch (e) {
        console.warn('Issue close safety net failed (non-fatal):', e.message || e);
    }
}

function squashAndFinalize(ctx, pr) {
    // gh-1416: the held path releases the lock and returns false — the SM
    // retries next cycle, the rework lap / a human resolution lands the
    // fresh verdict; pr_approved stays (the deferral is not a rework flip).
    if (verdictGateHoldsMerge(ctx.jobParams, ctx.owner, ctx.repo, pr.number, pr.detail)) {
        releaseLock(ctx);
        return false;
    }
    // Merge (squash — merge-trigger parity).
    try {
        ctx.scm.mergePr(pr.number, ctx.owner, ctx.repo, 'squash');
        console.log('✅ Merged PR #' + pr.number + ' (squash)');
    } catch (e) {
        console.warn('Merge failed:', e.message || e);
        releaseLock(ctx);
        return false;
    }
    removeIssueLabel(ctx.issueNumber, ctx.approvedLabel);
    releaseLock(ctx);
    closeIssueSafetyNet(ctx.issueNumber);
    return true;
}

// ── the orchestrator ─────────────────────────────────────────────────────────

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var issueNumber = issueNumberFromKey(ticketKey);
    if (!issueNumber) {
        console.error('retryMergeGithubPR: no issue number in ticket key "' + ticketKey + '"');
        return false;
    }
    var repo = repoInfoOf(params);
    if (!repo) {
        console.error('retryMergeGithubPR: could not determine owner/repo');
        return false;
    }
    REPO.owner = repo.owner;
    REPO.repo = repo.repo;
    var ctx = laneOptionsOf(params);
    ctx.ticketKey = ticketKey;
    ctx.issueNumber = issueNumber;
    ctx.owner = repo.owner;
    ctx.repo = repo.repo;
    ctx.scm = repo.scm;

    var found = resolveLinkedPr(ctx);
    if (!found) {
        console.warn('No open PR found for ' + ticketKey + ' — releasing lock');
        releaseLock(ctx);
        return false;
    }
    if (found.mergedHandled) return true;
    var pr = found.pr;
    console.log('Found PR #' + pr.number + ' for ' + ticketKey);
    // Mergeability + CI observation via the provider surface.
    pr.detail = ctx.scm.getPr(pr.number) || {};
    var handler = WAIT_HANDLERS[mergeStateDecision(pr.detail)];
    if (handler) return handler(ctx, pr);
    return squashAndFinalize(ctx, pr);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, issueNumberFromKey: issueNumberFromKey,
        verdictGateHoldsMerge: verdictGateHoldsMerge };
}
