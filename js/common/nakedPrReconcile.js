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
//
// Re-arm loop guard: the marker carries the PR head sha; a PR already
// re-armed on the same head (marker present) is skipped — a lane that
// consumes the label must not get a fresh arm + comment every tick. A new
// head re-opens the sweep. Limit: the caller lists open PRs with a single
// github_list_prs call (the bridge exposes no page/perPage), so only the
// first page of open PRs is swept.
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

// gh-1387 comment-reduction (L2): when the label strip that left the PR
// naked is itself explained by a gh-840 consumption audit marker on the
// SAME head, the re-arm comment must not repeat the full consumption
// story — the consume comment posted seconds earlier already tells it.
// The marker payload is byte-identical in both variants (the same-head
// dedup anchor and any future parser read the marker, never the tail).
var CONSUME_MARKER_RE = /<!-- dmtools:rework-consume (\{[^\n]*?\}) -->/;
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

function buildAuditComment(prNumber, issueNumber, label, head, explained) {
    var meta = { pr: prNumber, issue: issueNumber, label: label, head: head || null };
    var tail = explained
        ? '🩹 re-armed `' + label + '` — naked because agent:rework was consumed on this head' +
          ' (gh-840 audit for this head); the next SM tick dispatches normally.'
        : '🩹 **Naked-PR reconciliation (gh-1097)**: this PR carried no lifecycle labels while ' +
          'linked issue #' + issueNumber + ' is still in flow — re-armed `' + label + '`. ' +
          'No dispatch from this sweep; the next SM tick picks it up.';
    return MARKER_PREFIX + JSON.stringify(meta) + ' -->\n' + tail;
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
    return label ? { pr: pr.number, issue: issue, label: label, head: headSha(pr) } : null;
}

function headSha(pr) {
    return (pr.head && pr.head.sha) || null;
}

var MARKER_RE = /<!-- dmtools:naked-pr-rearm (\{[^\n]*?\}) -->/;

// Shared marker-payload reader (gh-1387: one body for both marker families —
// the duplication gate flags look-alike parse blocks). Returns the JSON
// payload of the first <re> marker in the body, or null (absent/malformed).
function markerPayload(comment, re) {
    var m = re.exec(String((comment && comment.body) || ''));
    if (!m) return null;
    try { return JSON.parse(m[1]) || null; } catch (e) { return null; }
}

// Head sha recorded in one comment's re-arm marker, or null.
function markerHead(comment) {
    var p = markerPayload(comment, MARKER_RE);
    return p ? (p.head || null) : null;
}

// Head sha recorded in one consume-audit marker (gh-840), or null.
// gh-1392 review: unlike reworkConsumption.parseConsumeMarkers, this reader
// deliberately has NO machineAuthor allowlist — the only thing it gates is
// the re-arm comment's VISIBLE tail (cosmetic), and the marker payload is
// byte-identical in both variants. A hand-written marker can reword the
// human-facing audit line at worst; nothing machine-readable consults this
// decision (the label still lands, the dedup anchor is the marker payload,
// and the durable gh-840 sweep re-parses consume markers behind its own
// allowlist).
function consumeMarkerHead(comment) {
    var p = markerPayload(comment, CONSUME_MARKER_RE);
    return p ? (p.head || null) : null;
}

// True when a marker of the given family on the PR records THIS head.
function anyMarkerHeadEquals(comments, head, headOf) {
    if (!head) return false;
    return (comments || []).some(function (c) { return headOf(c) === head; });
}

function alreadyRearmed(comments, head) {
    return anyMarkerHeadEquals(comments, head, markerHead);
}

// True when a gh-840 consumption audit marker for THIS head is on the PR —
// the nakedness has a same-head consumption story already on the page.
// Deliberately cosmetic + author-agnostic: see consumeMarkerHead above.
function isConsumeExplained(comments, head) {
    return anyMarkerHeadEquals(comments, head, consumeMarkerHead);
}

function notYetRearmed(plan, deps) {
    // gh-1392 review thread 4: ONE prComments fetch per plan — the same-head
    // dedup read and applyPlan's consume-explained read share this list.
    plan.comments = typeof deps.prComments === 'function' ? deps.prComments(plan.pr) : [];
    if (!alreadyRearmed(plan.comments, plan.head)) return true;
    deps.log('  🩹 naked-PR sweep: pr#' + plan.pr + ' already re-armed on head ' + plan.head + ' — skip');
    return false;
}

function applyPlan(plan, deps) {
    deps.log('  🩹 naked-PR sweep: pr#' + plan.pr + ' (issue #' + plan.issue + ') → ' + plan.label +
        (deps.dry ? ' [DRY]' : ''));
    if (deps.dry) return;
    deps.addLabel(plan.pr, plan.label);
    var comments = plan.comments;
    if (comments === undefined && typeof deps.prComments === 'function') {
        // Direct applyPlan caller (not driven through sweep) — fetch here.
        comments = deps.prComments(plan.pr);
    }
    var explained = isConsumeExplained(comments, plan.head);
    deps.comment(plan.pr, buildAuditComment(plan.pr, plan.issue, plan.label, plan.head, explained));
}

// deps: { bodyLinker, prComments(n), issueLabels(n), isMachine(pr), addLabel(n,l),
//         comment(n,body), log, dry }. Returns the applied plans.
function sweep(prs, deps) {
    var plans = (prs || []).map(function (pr) { return planFor(pr, deps); })
        .filter(function (p) { return p && notYetRearmed(p, deps); });
    plans.forEach(function (p) { applyPlan(p, deps); });
    return plans;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        LIFECYCLE_LABELS: LIFECYCLE_LABELS, isNakedPr: isNakedPr, excluded: excluded,
        rearmLabelFor: rearmLabelFor, buildAuditComment: buildAuditComment,
        linkedIssueOf: linkedIssueOf, markerHead: markerHead, alreadyRearmed: alreadyRearmed,
        consumeMarkerHead: consumeMarkerHead, isConsumeExplained: isConsumeExplained,
        planFor: planFor, applyPlan: applyPlan, sweep: sweep
    };
}
