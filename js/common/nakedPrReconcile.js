// gh-1097 — reconciliation sweep for naked PRs.
//
// Every SM lane is label-driven on the PR side; the escalation/reset paths
// (gh-957 rework-loop escalation, BEHIND strips, gh-807 verdict strip) can
// leave an OPEN PR with ZERO lifecycle labels while its linked issue is
// still mid-flow (agent:review / agent:rework / status:In Review / In
// Rework). No query matches such a PR again (live: dart #426, fa #1693).
//
// This module heals the aftermath: a post-lane sweep (runs AFTER every
// dispatch lane of the tick) re-derives the PR-side arm label from the
// issue state and posts ONE audit comment per re-arm. It never dispatches
// — the next tick's normal lanes pick the PR up (AC3).
//
// Excluded by design (AC2): blocked / needs-human / validation_failed on
// the PR or the issue, and human-authored PRs (not machine-authored and
// not on a machine `ai/` branch).
'use strict';

var LIFECYCLE_LABELS = [
    'agent:review', 'agent:rework', 'agent:dev', 'ai_developed',
    'ai_validating', 'ai_validated', 'pr_approved', 'validation_failed',
    'blocked', 'needs-human', 'rework-loop-escalated'
];

var EXCLUDED_LABELS = ['blocked', 'needs-human', 'validation_failed'];

// Issue label → PR-side arm label (first match wins).
var REARM_TABLE = [
    { from: 'agent:review', to: 'agent:review' },
    { from: 'status:In Review', to: 'agent:review' },
    { from: 'agent:rework', to: 'agent:rework' },
    { from: 'status:In Rework', to: 'agent:rework' }
];

var MARKER_PREFIX = '<!-- dmtools:naked-pr-rearm ';

function hasAny(labels, wanted) {
    var list = labels || [];
    return wanted.some(function (w) { return list.indexOf(w) !== -1; });
}

function isNakedPr(prLabels, lifecycleLabels) {
    return !hasAny(prLabels, lifecycleLabels || LIFECYCLE_LABELS);
}

// pr.machine: precomputed machine-authorship (author allowlist OR an ai/
// branch marker) — the caller owns the identity knob resolution.
function excluded(prLabels, issueLabels, pr) {
    if (hasAny(prLabels, EXCLUDED_LABELS)) return true;
    if (hasAny(issueLabels, EXCLUDED_LABELS)) return true;
    return !(pr && pr.machine);
}

function rearmLabelFor(issueLabels) {
    var list = issueLabels || [];
    for (var i = 0; i < REARM_TABLE.length; i++) {
        if (list.indexOf(REARM_TABLE[i].from) !== -1) return REARM_TABLE[i].to;
    }
    return null;
}

function buildAuditComment(prNumber, issueNumber, label) {
    var meta = { pr: prNumber, issue: issueNumber, label: label };
    return MARKER_PREFIX + JSON.stringify(meta) + ' -->\n' +
        '🩹 **Naked-PR reconciliation (gh-1097)**: this PR carried no lifecycle labels while ' +
        'linked issue #' + issueNumber + ' is still in flow — re-armed `' + label + '`. ' +
        'No dispatch from this sweep; the next SM tick picks it up.';
}

function labelNames(raw) {
    return (raw || []).map(function (l) { return (l && l.name) || l; });
}

var BRANCH_RE = /^ai\/gh-(\d+)$/;

// Linked issue: branch ai/gh-N first, then the body scraper (closing
// keywords — githubSource.linkedIssueNumber) the caller injects.
function linkedIssueOf(pr, bodyLinker) {
    var m = BRANCH_RE.exec(String((pr.head && pr.head.ref) || ''));
    if (m) return parseInt(m[1], 10);
    return bodyLinker(pr.body) || null;
}

// Decision for one PR: null (untouched) or { pr, issue, label }.
function planFor(pr, deps) {
    var prLabels = labelNames(pr.labels);
    if (!isNakedPr(prLabels)) return null;
    var issue = linkedIssueOf(pr, deps.bodyLinker);
    if (!issue) return null;
    var issueLabels = deps.issueLabels(issue) || [];
    if (excluded(prLabels, issueLabels, { machine: deps.isMachine(pr) })) return null;
    var label = rearmLabelFor(issueLabels);
    return label ? { pr: pr.number, issue: issue, label: label } : null;
}

function applyPlan(plan, deps) {
    deps.log('  🩹 naked-PR sweep: pr#' + plan.pr + ' (issue #' + plan.issue + ') → ' + plan.label +
        (deps.dry ? ' [DRY]' : ''));
    if (deps.dry) return;
    deps.addLabel(plan.pr, plan.label);
    deps.comment(plan.pr, buildAuditComment(plan.pr, plan.issue, plan.label));
}

// deps: { bodyLinker, issueLabels(n), isMachine(pr), addLabel(n,l),
//         comment(n,body), log, dry }. Returns the applied plans.
function sweep(prs, deps) {
    var plans = (prs || []).map(function (pr) { return planFor(pr, deps); })
        .filter(function (p) { return p; });
    plans.forEach(function (p) { applyPlan(p, deps); });
    return plans;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        LIFECYCLE_LABELS: LIFECYCLE_LABELS, isNakedPr: isNakedPr, excluded: excluded,
        rearmLabelFor: rearmLabelFor, buildAuditComment: buildAuditComment,
        linkedIssueOf: linkedIssueOf, planFor: planFor, sweep: sweep
    };
}
