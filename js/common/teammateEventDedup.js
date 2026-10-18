/**
 * teammateEventDedup.js — gh-1065 event-path trigger dedup (pure side).
 *
 * Live evidence (dmtools-agents 2026-10-18, issues #1040–#1043 / #1061):
 * ONE human action (assign, or assign-while-labels-change) emits MULTIPLE
 * issues events (`assigned` + one `labeled` per label write), and
 * .github/workflows/ai-teammate.yml triggered one teammate run PER event
 * — two runs per issue at 20:11Z, three on #1061 across 20:07–20:15,
 * each duplicate hand-cancelled by the owner. The gh-1028 dedup
 * (branchLegGuard.js + smAgent.triggerWorkflow) covers the SM-internal
 * workflow_dispatch path only; the GitHub-event path bypassed that ledger.
 * The per-issue `concurrency:` group (cancel-in-progress:false) only
 * SERIALIZES the duplicates into queued no-op burns — it never drops them.
 *
 * This module is the missing gate: an issues-event run proceeds only when
 * NO OTHER ai-teammate run for the SAME issue + leg is in flight (active
 * status, gh-1028 stale-zombie parity) or freshly completed (a fulfilled
 * leg owns a short freshness window — burst duplicates of one action land
 * after the first run because the concurrency group queues them). The key
 * semantics mirror the SM side (gh-1028): same issue + same leg, where the
 * run's leg is recovered from its run title (dispatch titles carry the
 * leg; event-path titles do not) and an unknown leg on either side
 * wildcards — precision where both legs are known, conservatism for the
 * burst shapes the titles cannot distinguish.
 *
 * Tie-break (AC1, exactly one survivor): only a run that is STRICTLY OLDER
 * than the probing run suppresses it (run_number order, created_at
 * fallback). Burst runs are created milliseconds apart in run_number order,
 * so the earliest always proceeds and every later duplicate of the burst
 * drops — regardless of which probe executes first.
 *
 * FAIL-OPEN (AC3): the transport (.github/workflows/ai-teammate.yml dedup
 * job) treats a probe error as "no data" — this module maps a missing/
 * non-array run list to proceed, so a broken dedup check can never
 * silently swallow the only trigger.
 *
 * Pure functions, no tool globals — the workflow wires the transport
 * (gh api per-status fan-out, smAgent parity). GraalJS-clean: var + plain
 * functions, JSON-safe data only.
 */

'use strict';

// The leg workflow this dedup guards — the same default branchLegGuard and
// the SM dispatch side use.
var DEFAULT_WORKFLOW_FILE = 'ai-teammate.yml';

// Active-state vocabulary — branchLegGuard parity, one list.
var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending'];

// gh-1028 stale bound for NON-running active states (queued/waiting/pending
// zombies aged out own nothing). in_progress runs never age out.
var DEFAULT_STALE_NON_RUNNING_MS = 6 * 60 * 60 * 1000;

// gh-1065 freshness window for COMPLETED runs: a run that concluded
// 'success' within this window still owns the issue+leg key. Deliberately
// SHORT (10 min): the burst duplicates of one human action reach their
// dedup probe only after the concurrency group releases the first run, so
// the window only has to cover event-burst + queue lag — while a human
// re-assign hours later (a genuine new request) must never be swallowed.
// Only conclusion 'success' counts: a cancelled or failed run owns nothing
// (the retry path stays open).
var DEFAULT_FRESHLY_COMPLETED_MS = 10 * 60 * 1000;

// Arming labels → leg, the factory's derivation order (template header:
// "dispatch input leg > label agent:rework > label agent:review >
// assignee/agent:dev (dev)"). pr_approved arms the review leg.
var ARMING_LABEL_LEGS = {
    'agent:dev': 'dev',
    'agent:develop': 'dev',
    'agent:review': 'review',
    'agent:rework': 'rework',
    'pr_approved': 'review'
};

// Label-scan priority for an `assigned` event: the factory resolves the
// strongest arming label on the issue (rework > review > dev).
var ASSIGNED_LEG_PRIORITY = ['agent:rework', 'agent:review', 'agent:dev', 'agent:develop'];

var KNOWN_LEGS = ['dev', 'review', 'rework'];

function armingLegOfLabel(labelName) {
    if (!labelName || typeof labelName !== 'string') return null;
    return ARMING_LABEL_LEGS.hasOwnProperty(labelName) ? ARMING_LABEL_LEGS[labelName] : null;
}

/**
 * The leg an issues event will run. Returns { applicable, leg }:
 *  - labeled: applicable iff the label is an arming label (the workflow
 *    job gate admits exactly these — non-arming lifecycle labels proceed
 *    here and are rejected there without ever paying for a probe);
 *  - assigned: always applicable; leg = strongest arming label on the
 *    issue, '' when none (a bare assign declares no leg — it is suppressed
 *    by ANY in-flight run for the issue, see legsCompatible);
 *  - anything else: applicable, leg ''.
 */
function deriveEventLeg(action, labelName, issueLabelNames) {
    if (action === 'labeled') {
        var leg = armingLegOfLabel(labelName);
        return { applicable: leg !== null, leg: leg || '' };
    }
    if (action === 'assigned') {
        var names = Array.isArray(issueLabelNames) ? issueLabelNames : [];
        for (var i = 0; i < ASSIGNED_LEG_PRIORITY.length; i++) {
            if (names.indexOf(ASSIGNED_LEG_PRIORITY[i]) !== -1) {
                return { applicable: true, leg: ARMING_LABEL_LEGS[ASSIGNED_LEG_PRIORITY[i]] };
            }
        }
        return { applicable: true, leg: '' };
    }
    return { applicable: true, leg: '' };
}

/**
 * The issue anchor carried by a run title. Both title families carry it:
 * the stub's 'teammate: assigned #1040' / 'teammate: workflow_dispatch
 * #1040 dev' and the factory/SM '▶ dev (SM) · gh-1040' / template
 * '⚒️ dev · gh-1040' shapes. A trailing-digit guard keeps '#104' from
 * matching '#1040'. Returns a number or null.
 */
function issueOfRunName(name) {
    if (!name || typeof name !== 'string') return null;
    // First well-terminated '#<n>' token wins; a digit directly after the
    // match disqualifies that candidate (lookahead-free, GralJS-safe).
    var re = /#(\d+)/g;
    var m = re.exec(name);
    while (m) {
        var after = name.charAt(m.index + m[0].length);
        if (after === '' || after < '0' || after > '9') return parseInt(m[1], 10);
        m = re.exec(name);
    }
    var gh = /(?:^|[^0-9a-zA-Z])gh-(\d+)/g;
    m = gh.exec(name);
    while (m) {
        var afterGh = name.charAt(m.index + m[0].length);
        if (afterGh === '' || afterGh < '0' || afterGh > '9') return parseInt(m[1], 10);
        m = gh.exec(name);
    }
    return null;
}

/**
 * The leg a run title carries, '' when unknown:
 *  - '▶ <leg> (SM) · ...'           — SM dispatch (factory title)
 *  - '🔧 rework · ...' / '🔍 review · ...' / '⚒️ dev · ...'
 *                                   — template event titles
 *  - 'teammate: ... #<n> <leg>'     — stub dispatch title (trailing leg,
 *                                     stub prefix required so an issue
 *                                     title ending in a leg word never
 *                                     aliases)
 * Event-path stub titles ('teammate: assigned #1040') carry no leg → ''.
 */
function legOfRunName(name) {
    if (!name || typeof name !== 'string') return '';
    var m = /▶\s+(dev|review|rework)\s+\(SM\)/.exec(name);
    if (m) return m[1];
    m = /(?:🔧\s*rework|🔍\s*review|⚒️?\s*dev)/.exec(name);
    if (m) {
        if (m[0].indexOf('rework') !== -1) return 'rework';
        if (m[0].indexOf('review') !== -1) return 'review';
        return 'dev';
    }
    if (name.indexOf('teammate:') === 0) {
        m = /\s(dev|review|rework)$/.exec(name);
        if (m) return m[1];
    }
    return '';
}

/**
 * gh-1028 key semantics: same issue + same leg. An UNKNOWN leg on either
 * side is a wildcard — event-path run titles ('teammate: issues #1040')
 * carry no leg, and a bare `assigned` event declares none, yet both are
 * how the observed burst (#1040–#1043: assign-while-labels-change) reaches
 * the workflow; treating '' as a match-all keeps exactly one run per
 * issue per burst (AC1/AC4). Precision where it is possible: when BOTH
 * legs are known they must be EQUAL — an SM-dispatched 'dev' leg in flight
 * never swallows a genuinely new 'review' trigger (the concurrency group
 * serializes the review run behind the dev leg instead of dropping it).
 */
function legsCompatible(eventLeg, runLeg) {
    var e = eventLeg || '';
    var r = runLeg || '';
    if (e === '' || r === '') return true;
    return e === r;
}

function isActiveStatus(status) {
    return ACTIVE_RUN_STATES.indexOf(status) !== -1;
}

function runTimestampMs(run) {
    var value = run && (run.updated_at || run.created_at);
    if (!value) return null;
    var ms = Date.parse(String(value));
    return isNaN(ms) ? null : ms;
}

/** gh-1028 zombie parity: non-in_progress active state past the stale bound. */
function isStaleNonRunning(run, nowMs, staleMs) {
    if (run && run.status === 'in_progress') return false;
    var ts = runTimestampMs(run);
    if (ts === null || nowMs === null) return false;
    return (nowMs - ts) > staleMs;
}

/**
 * A run that concluded 'success' within the freshness window still owns
 * the issue+leg key. Any other conclusion (failure, cancelled, skipped)
 * owns nothing — the retry path stays open.
 */
function isFreshlyCompleted(run, nowMs, freshMs) {
    if (!run || run.status !== 'completed') return false;
    if (String(run.conclusion || '').toLowerCase() !== 'success') return false;
    var ts = runTimestampMs(run);
    if (ts === null || nowMs === null) return false;
    return (nowMs - ts) <= freshMs;
}

/**
 * THE GATE: is this run a suppressor candidate at all — in flight
 * (active, non-stale zombie) or freshly completed?
 */
function isOwningRun(run, nowMs, staleMs, freshMs) {
    if (!run || !run.status) return false;
    if (isActiveStatus(run.status)) {
        if (run.status !== 'in_progress' && nowMs !== null &&
            isStaleNonRunning(run, nowMs, staleMs)) return false;
        return true;
    }
    return isFreshlyCompleted(run, nowMs, freshMs);
}

/**
 * Tie-break: the suppressor must be STRICTLY OLDER than the probing run,
 * so of a same-second burst (run_numbers N, N+1, N+2) only the earliest
 * proceeds — regardless of probe execution order. run_number order first
 * (REST always carries it), created_at fallback; a run with neither order
 * signal is ignored.
 */
function isOlderRun(run, selfRun) {
    if (!run || !selfRun) return false;
    var a = run.run_number, b = selfRun.runNumber;
    if (typeof a === 'number' && typeof b === 'number' && !isNaN(a) && !isNaN(b)) {
        return a < b;
    }
    var ta = run.created_at ? Date.parse(String(run.created_at)) : NaN;
    var tb = selfRun.createdAt ? Date.parse(String(selfRun.createdAt)) : NaN;
    if (!isNaN(ta) && !isNaN(tb)) return ta < tb;
    return false;
}

/** branchLegGuard.isLegRun parity — only runs of the leg workflow count. */
function isLegWorkflowRun(run, workflowFile) {
    if (!run) return false;
    if (run.path === undefined || run.path === null || run.path === '') return true;
    var suffix = '/' + String(workflowFile || DEFAULT_WORKFLOW_FILE);
    var path = String(run.path);
    return path.length >= suffix.length &&
        path.slice(path.length - suffix.length) === suffix;
}

function staleMsOf(opts) {
    return (opts && typeof opts.staleNonRunningMs === 'number' && opts.staleNonRunningMs > 0)
        ? opts.staleNonRunningMs : DEFAULT_STALE_NON_RUNNING_MS;
}

function freshMsOf(opts) {
    return (opts && typeof opts.freshlyCompletedMs === 'number' && opts.freshlyCompletedMs > 0)
        ? opts.freshlyCompletedMs : DEFAULT_FRESHLY_COMPLETED_MS;
}

function nowMsOf(opts) {
    return (opts && typeof opts.nowMs === 'number' && !isNaN(opts.nowMs))
        ? opts.nowMs : null;
}

/**
 * THE DECISION (gh-1065). input:
 *   eventName        'issues' | anything else (dispatch paths pass through)
 *   action           github.event.action ('assigned' | 'labeled')
 *   labelName        github.event.label.name (labeled events)
 *   issueLabelNames  github.event.issue.labels.*.name (assigned events)
 *   issue            the issue number (number)
 *   workflowFile     default ai-teammate.yml
 *   runs             workflow_run list for the leg workflow (any status mix)
 *   selfRun          { id, runNumber, createdAt } — the probing run
 *   nowMs            clock (default null — without a clock no zombie can be
 *                    proven stale and nothing is freshly completed: the
 *                    gate degrades to in-flight-only, still never blocks
 *                    the earliest run of a burst)
 *   staleNonRunningMs / freshlyCompletedMs — window overrides
 *
 * Returns { proceed, reason, audit }. reason: 'dispatch-path' |
 * 'non-arming-label' | 'no-issue-anchor' | 'no-runs' | 'duplicate' |
 * 'first-trigger'. 'duplicate' is the ONLY proceed=false outcome and its
 * audit line is the AC1 drop-audit entry.
 */
function decideEventDedup(input) {
    input = input || {};
    var eventName = input.eventName || '';
    var issue = typeof input.issue === 'number' ? input.issue : parseInt(input.issue, 10);

    if (eventName !== 'issues') {
        return {
            proceed: true,
            reason: 'dispatch-path',
            audit: 'teammate dedup (gh-1065): ' + (eventName || 'dispatch') +
                ' path — governed by the SM-side gh-1028 dedup; proceeding'
        };
    }

    var derived = deriveEventLeg(input.action, input.labelName, input.issueLabelNames);
    if (!derived.applicable) {
        return {
            proceed: true,
            reason: 'non-arming-label',
            audit: 'teammate dedup (gh-1065): labeled event for non-arming label' +
                ' — the job gate rejects it; no probe spent'
        };
    }

    if (isNaN(issue)) {
        return {
            proceed: true,
            reason: 'no-issue-anchor',
            audit: 'teammate dedup (gh-1065): issues event without an issue anchor — proceeding'
        };
    }

    var runs = input.runs;
    if (!Array.isArray(runs) || runs.length === 0) {
        return {
            proceed: true,
            reason: 'no-runs',
            audit: 'teammate dedup (gh-1065): no runs on file for the leg workflow — proceeding'
        };
    }

    var workflowFile = input.workflowFile || DEFAULT_WORKFLOW_FILE;
    var staleMs = staleMsOf(input);
    var freshMs = freshMsOf(input);
    var nowMs = nowMsOf(input);
    var selfRun = input.selfRun || {};
    var selfId = selfRun.id !== undefined ? selfRun.id : null;

    for (var i = 0; i < runs.length; i++) {
        var run = runs[i] || {};
        if (selfId !== null && run.id === selfId) continue;
        if (!isLegWorkflowRun(run, workflowFile)) continue;
        if (issueOfRunName(run.name) !== issue) continue;
        if (!legsCompatible(derived.leg, legOfRunName(run.name))) continue;
        if (!isOwningRun(run, nowMs, staleMs, freshMs)) continue;
        if (!isOlderRun(run, selfRun)) continue;

        var owner = run.run_number !== undefined ? ('run ' + run.run_number) : ('run id ' + run.id);
        var state = run.status === 'completed'
            ? ('freshly completed (' + run.conclusion + ')')
            : ('in flight (' + run.status + ')');
        return {
            proceed: false,
            reason: 'duplicate',
            audit: '⏭️ teammate dedup (gh-1065): dropped ' + String(input.action || 'issues') +
                ' event on #' + issue + ' (leg \'' + (derived.leg || 'any') + '\') — ' +
                owner + ' for the same issue+leg is ' + state +
                ' within the dedup window; this trigger is a duplicate'
        };
    }

    return {
        proceed: true,
        reason: 'first-trigger',
        audit: 'teammate dedup (gh-1065): no in-flight or freshly-completed run for #' +
            issue + ' (leg \'' + (derived.leg || 'any') + '\') — proceeding'
    };
}

module.exports = {
    DEFAULT_WORKFLOW_FILE: DEFAULT_WORKFLOW_FILE,
    ACTIVE_RUN_STATES: ACTIVE_RUN_STATES,
    DEFAULT_STALE_NON_RUNNING_MS: DEFAULT_STALE_NON_RUNNING_MS,
    DEFAULT_FRESHLY_COMPLETED_MS: DEFAULT_FRESHLY_COMPLETED_MS,
    ARMING_LABEL_LEGS: ARMING_LABEL_LEGS,
    armingLegOfLabel: armingLegOfLabel,
    deriveEventLeg: deriveEventLeg,
    issueOfRunName: issueOfRunName,
    legOfRunName: legOfRunName,
    legsCompatible: legsCompatible,
    isActiveStatus: isActiveStatus,
    isStaleNonRunning: isStaleNonRunning,
    isFreshlyCompleted: isFreshlyCompleted,
    isOwningRun: isOwningRun,
    isOlderRun: isOlderRun,
    isLegWorkflowRun: isLegWorkflowRun,
    decideEventDedup: decideEventDedup
};
