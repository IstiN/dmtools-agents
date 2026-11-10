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
// gh-1417: the TWO-STAGE merge gate (stage 1: the gh-1353/gh-1370 backstop;
// stage 2: the classification-independent open-threads hold) — the same
// ONE shared helper the other two merge funnels call, so all three gate
// identically.
var mergeGate = require('./common/mergeGate.js');
// gh-1420: the merge-decision observability layer — the greppable
// MERGE-DECISION structured line at every exit of squashAndFinalize (the
// shared say/logger seam), the ::warning:: annotation on holds, and the
// dmtools:merge-note residue marker posted after the squash-merge
// (pure-clean merges stay silent).
var mergeNote = require('./common/mergeNote.js');

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
 * race the funnel). Returns the gate OUTCOME (gh-1420: the verdict rides
 * the MERGE-DECISION line) — `held` is the caller's defer signal. The gate
 * never throws (it fails open internally — no records, stale-head-only
 * records, unreadable markers, and broken reads all proceed as today); a
 * wiring-level fault is absorbed fail-open here too. Never emits the
 * decision itself — squashAndFinalize renders ONE line per exit.
 */
function verdictGateOutcomeForPr(jobParams, owner, repo, prNumber, prDetail) {
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
        }
        return verdictGate;
    } catch (eGate) {
        console.warn('Verdict gate fault — fail-open (gh-1416):', eGate.message || eGate);
        return { held: false, verdict: null, head: null, prNumber: prNumber, fault: true };
    }
}

// The boolean defer signal (the pre-gh-1420 shape, kept for callers/tests).
function verdictGateHoldsMerge(jobParams, owner, repo, prNumber, prDetail) {
    return verdictGateOutcomeForPr(jobParams, owner, repo, prNumber, prDetail).held === true;
}

/**
 * gh-1417: the TWO-STAGE merge gate at the squash-merge instant — stage 1
 * is the gh-1353/gh-1370 backstop (machine-owned threads to terminal
 * disposition), stage 2 the classification-independent hold (after stage
 * 1, ANY unresolved review thread — any author, machine notices excluded —
 * holds the merge behind a deduped per-head dmtools:merge-hold marker,
 * needs-human escalation past mergeGate.humanHoldHours). The same ONE
 * shared helper mergeTrigger's runStateMachine and the mergeBot probe
 * call — the three funnels gate identically (gh-1417 AC3). Returns the
 * gate OUTCOME (gh-1420: the backstop residue rides `backstop` for the
 * merge-note + the MERGE-DECISION line) — `held` is the caller's defer
 * signal: a held stage-2 outcome, or a THROWN stage-1/2 fault (shape
 * `{ held: true, thrown: true }` — the merge gate is fail-CLOSED: a broken
 * census or a failed resolution defers the merge, never merges blind,
 * gh-1370 semantics; unlike the verdict gate above it, faults are NOT
 * absorbed fail-open).
 */
function mergeGateOutcomeForPr(jobParams, owner, repo, prNumber, prDetail) {
    try {
        var gate = mergeGate.runForPr(
            mergeGate.githubBridgeIo(),
            owner, repo, jobParams, prNumber,
            mcpParse.parseMcp(prDetail),
            function (line) { console.log(line); });
        if (gate.held) {
            console.warn('PR #' + prNumber + ' merge deferred — ' + gate.total +
                ' unresolved review thread(s) (human ' + gate.human + ', machine ' +
                gate.machine + ') remain open (gh-1417); the threads resolving' +
                ' (or a human taking it past mergeGate.humanHoldHours) owns the merge');
        }
        return gate;
    } catch (eGate) {
        console.warn('Merge gate failed — merge deferred (gh-1370/gh-1417):',
            eGate.message || eGate);
        return { held: true, thrown: true, prNumber: prNumber }; // fail-closed
    }
}

/**
 * gh-1417: the boolean defer signal (the pre-gh-1420 shape, kept for
 * callers/tests).
 */
function mergeGateHoldsMerge(jobParams, owner, repo, prNumber, prDetail) {
    return mergeGateOutcomeForPr(jobParams, owner, repo, prNumber, prDetail).held === true;
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

// The gh-1420 logger seam of this lane (console parity with the gates).
function laneSay(line) { console.log(line); }

// The verdict-hold exit (gh-1416): the structured deferred line + the hold
// ::warning::, the lock released, pr_approved stays (the deferral is not a
// rework flip — the rework lap / a human resolution lands the fresh verdict).
function verdictHoldExit(ctx, pr, prPayload, verdictGate) {
    mergeNote.emitDecision(laneSay, {
        prNumber: pr.number, pr: prPayload, job: ctx.jobParams, action: 'defered',
        verdict: verdictGate.verdict, warn: true,
        reason: 'newest verdict on head ' + (verdictGate.head || '?') +
            ' is ' + verdictGate.verdict + ' — a stale approval cannot race the merge (gh-1416)'
    });
    releaseLock(ctx);
    return false;
}

// The gate-hold exit (gh-1417): held or faulted, the merge defers the same
// way. A THROWN gate fault reads the census UNKNOWN — the held line renders
// ? counts (never a misleading machineThreads=0 humanThreads=0, the
// allowlist=0 grep audit could misread).
function gateHoldExit(ctx, pr, prPayload, gate, verdictGate) {
    mergeNote.emitDecision(laneSay, {
        prNumber: pr.number, pr: prPayload, job: ctx.jobParams, action: 'held',
        machineThreads: gate.thrown ? '?' : gate.machine,
        humanThreads: gate.thrown ? '?' : gate.human,
        verdict: verdictGate.verdict,
        reason: gate.thrown
            ? 'merge gate faulted (gh-1370/gh-1417) — fail-closed defer'
            : gate.total + ' unresolved review thread(s) (human ' +
                gate.human + ', machine ' + gate.machine + ') hold the merge (gh-1417)'
    });
    releaseLock(ctx);
    return false;
}

// The failed-merge exit: the structured deferred line + the legacy warning.
function mergeFailedExit(ctx, pr, prPayload, gate, verdictGate, e) {
    mergeNote.emitDecision(laneSay, {
        prNumber: pr.number, pr: prPayload, job: ctx.jobParams, action: 'defered',
        backstop: gate.backstop, verdict: verdictGate.verdict,
        reason: 'merge failed: ' + (e.message || e)
    });
    console.warn('Merge failed:', e.message || e);
    releaseLock(ctx);
    return false;
}

// The merged exit: the residue marker (silent on a pure-clean merge,
// deduped per head), the structured merged line, the post-merge bookkeeping.
function mergedExit(ctx, pr, prPayload, gate, verdictGate) {
    // gh-1420 AC1: the residue marker — silent on a pure-clean merge,
    // deduped per head; then the structured merged line.
    mergeNote.runMergeNoteForPr(mergeVerdictGate.githubBridgeIo(),
        ctx.owner, ctx.repo, ctx.jobParams, pr.number, prPayload, gate.backstop, laneSay);
    mergeNote.emitDecision(laneSay, {
        prNumber: pr.number, pr: prPayload, job: ctx.jobParams, action: 'merged',
        backstop: gate.backstop, verdict: verdictGate.verdict
    });
    removeIssueLabel(ctx.issueNumber, ctx.approvedLabel);
    releaseLock(ctx);
    closeIssueSafetyNet(ctx.issueNumber);
    return true;
}

function squashAndFinalize(ctx, pr) {
    // gh-1416: the held path releases the lock and returns false — the SM
    // retries next cycle, the rework lap / a human resolution lands the
    // fresh verdict; pr_approved stays (the deferral is not a rework flip).
    var prPayload = mcpParse.parseMcp(pr.detail);
    var verdictGate = verdictGateOutcomeForPr(ctx.jobParams, ctx.owner, ctx.repo,
        pr.number, pr.detail);
    if (verdictGate.held) return verdictHoldExit(ctx, pr, prPayload, verdictGate);
    // gh-1417: the two-stage merge gate — held or faulted, the merge
    // defers the same way (the lock releases, pr_approved stays, the SM
    // retries next cycle).
    var gate = mergeGateOutcomeForPr(ctx.jobParams, ctx.owner, ctx.repo, pr.number, pr.detail);
    if (gate.held) return gateHoldExit(ctx, pr, prPayload, gate, verdictGate);
    // Merge (squash — merge-trigger parity).
    try {
        ctx.scm.mergePr(pr.number, ctx.owner, ctx.repo, 'squash');
        console.log('✅ Merged PR #' + pr.number + ' (squash)');
    } catch (e) {
        return mergeFailedExit(ctx, pr, prPayload, gate, verdictGate, e);
    }
    return mergedExit(ctx, pr, prPayload, gate, verdictGate);
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
        verdictGateHoldsMerge: verdictGateHoldsMerge,
        verdictGateOutcomeForPr: verdictGateOutcomeForPr,
        mergeGateHoldsMerge: mergeGateHoldsMerge,
        mergeGateOutcomeForPr: mergeGateOutcomeForPr };
}
