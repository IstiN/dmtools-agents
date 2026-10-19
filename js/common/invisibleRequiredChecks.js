/**
 * gh-1101 (live dart #435): "invisible required checks".
 *
 * Every required context (and our github_create_check_run mirrors) lived in
 * the workflow_dispatch Quality check suite. GitHub never associates a
 * workflow_dispatch suite with the PR, so the PR rollup / isRequired shows
 * none of them and mergeStateStatus stays BLOCKED forever while the commit
 * is green. Re-dispatch/mirroring on the same sha cannot fix it — only a
 * fresh head whose push suite exists BEFORE the CI dispatch.
 *
 * Deterministic (owner 2026-10: no grace): no active dispatched run on the
 * head + required contexts green on the commit + absent from the PR rollup
 * ⇒ reset now. Pure helpers only; smAgent owns the I/O.
 */

var MARKER_PREFIX = '<!-- dmtools:invisible-required-reset';
var MARKER_RE = /<!-- dmtools:invisible-required-reset sha=(\S+) at=(\S+) -->/g;
var DEFAULT_PUSH_SUITE_WAIT_MS = 10 * 60 * 1000;

function runTime(c) {
    return Date.parse(c.started_at || c.completed_at || '') || 0;
}

function keepNewer(out, c) {
    var t = runTime(c);
    var prev = out[c.name];
    if (!prev || t >= prev.t) out[c.name] = { t: t, run: c };
}

function latestByName(checkRuns) {
    var out = {};
    checkRuns.forEach(function (c) {
        if (c && c.name) keepNewer(out, c);
    });
    return out;
}

function allRequiredGreen(required, checkRuns) {
    var latest = latestByName(checkRuns);
    return required.every(function (name) {
        var hit = latest[name];
        return !!hit && hit.run.status === 'completed' && hit.run.conclusion === 'success';
    });
}

/**
 * required: string[] (branch protection contexts); checkRuns: commit
 * check-runs; prRollupNames: context names the PR itself sees.
 */
function isInvisible(required, checkRuns, prRollupNames) {
    if (!required || !required.length || !checkRuns || !prRollupNames) return false;
    if (!allRequiredGreen(required, checkRuns)) return false;
    return !required.some(function (name) { return prRollupNames.indexOf(name) !== -1; });
}

/** Shape gate: approved, mergeable, BLOCKED (BEHIND keeps the normal path). */
function blockedApprovedShape(ticket) {
    var pr = (ticket && ticket.pr) || {};
    var labels = (ticket && ticket.labels) || [];
    return labels.indexOf('pr_approved') !== -1 && pr.mergeable !== false &&
        pr.mergeState === 'BLOCKED';
}

function markerLine(oldSha, atIso) {
    return MARKER_PREFIX + ' sha=' + oldSha + ' at=' + atIso + ' -->';
}

/** Newest reset marker timestamp (ms) or null. */
function lastResetAtMs(bodies) {
    var last = null;
    (bodies || []).forEach(function (b) {
        var s = String(b == null ? '' : b);
        MARKER_RE.lastIndex = 0;
        var m;
        while ((m = MARKER_RE.exec(s)) !== null) {
            var at = Date.parse(m[2]);
            if (!isNaN(at) && (last === null || at > last)) last = at;
        }
    });
    return last;
}

/**
 * Dispatch-ordering guard: right after a reset, the CI dispatch on the new
 * head must wait until the head carries its push-event suite (else the
 * dispatch suite wins the race again). Bounded by waitMs so a repo with no
 * push workflows is never wedged.
 */
function waitMsOf(waitMs) {
    return typeof waitMs === 'number' ? waitMs : DEFAULT_PUSH_SUITE_WAIT_MS;
}

function hasPushSuite(headRuns) {
    if (headRuns === null) return false; // probe failed: hold (fail closed, bounded)
    return headRuns.some(function (r) { return !!r && r.event === 'push'; });
}

function shouldHoldDispatch(lastResetMs, headRuns, nowMs, waitMs) {
    if (lastResetMs === null || lastResetMs === undefined) return false;
    if (nowMs - lastResetMs >= waitMsOf(waitMs)) return false;
    return !hasPushSuite(headRuns);
}

module.exports = {
    MARKER_PREFIX: MARKER_PREFIX,
    DEFAULT_PUSH_SUITE_WAIT_MS: DEFAULT_PUSH_SUITE_WAIT_MS,
    isInvisible: isInvisible,
    blockedApprovedShape: blockedApprovedShape,
    markerLine: markerLine,
    lastResetAtMs: lastResetAtMs,
    shouldHoldDispatch: shouldHoldDispatch
};
