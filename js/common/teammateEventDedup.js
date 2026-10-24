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
 * leg; the stub run-name now also resolves the strongest arming label for
 * event-path runs — see .github/workflows/ai-teammate.yml run-name).
 *
 * Leg wildcard — SCOPED (gh-1065 rework, review threads):
 *  - IN-FLIGHT owners: an unknown leg on either side wildcards. Event-path
 *    burst titles cannot be told apart; an in-flight owner of the same
 *    issue is almost certainly the same human action (AC1/AC4).
 *  - COMPLETED owners: the wildcard is GONE. A completed owner with an
 *    unknown leg suppressing a KNOWN-leg event is exactly the sequential-
 *    human-action case (assign at T, deliberate agent:review at T+6min) —
 *    it proceeds. A completed owner suppresses only when both legs are
 *    unknown (a second bare assign inside the window is burst noise) or
 *    both known and equal (the concurrency-released burst duplicate).
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
 * silently swallow the only trigger. Non-arming events never reach the
 * probe at all: the dedup JOB carries the same arming gate as the teammate
 * call, so a lifecycle-label write executes ZERO jobs and its run
 * concludes failure (the gh-676 phantom pattern) — it can never own the
 * freshness window without having run a leg.
 *
 * FOLLOW-UP — RESOLVED (gh-1073): the consumer-repo copy
 * workflows/ai-teammate.yml.template now mirrors the same gated dedup job
 * (its probe requires THIS module from the mounted agents-pack checkout at
 * dmtools-agents/js/common/, and its issues-event run-name resolves the
 * strongest arming label into the emoji title family parsed below). The
 * stub and the template stay in lockstep — a gate change here must land in
 * both files (pinned by test_teammateEventDedup.js and
 * test_aiTeammateTemplate.js).
 *
 * Pure functions, no tool globals — the workflow wires the transport
 * (gh api per-status fan-out, smAgent parity). GraalJS-clean: var + plain
 * functions, JSON-safe data only.
 */

'use strict';

var legRunVocab = require('./legRunVocab.js');

// The leg workflow this dedup guards — the same default branchLegGuard and
// the SM dispatch side use. NOTE: the consumer-repo copies of
// workflows/ai-teammate.yml.template point at the same default workflow
// file (their probe rides WORKFLOW_FILE: ai-teammate.yml); see the
// FOLLOW-UP note in the header.
var DEFAULT_WORKFLOW_FILE = 'ai-teammate.yml';

// Active-state vocabulary — branchLegGuard parity, one list (gh-1153 adds 'requested').
var ACTIVE_RUN_STATES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

// gh-1028 stale bound for NON-running active states (queued/waiting/pending
// zombies aged out own nothing). in_progress runs never age out.
var DEFAULT_STALE_NON_RUNNING_MS = 6 * 60 * 60 * 1000;

// gh-1065 freshness window for COMPLETED runs: a run that concluded
// 'success' within this window still owns the issue+leg key. Deliberately
// SHORT (10 min): the burst duplicates of one human action reach their
// dedup probe only after the concurrency group releases the first run, so
// the window only has to cover event-burst + queue lag. Sequential human
// actions inside the window are NOT swallowed thanks to the scoped
// wildcard: a completed owner with an unknown leg cannot suppress a KNOWN
// new leg (see completedLegsCompatible). Only conclusion 'success' counts:
// a cancelled or failed run owns nothing (the retry path stays open) —
// which also covers the zero-job phantom runs (gh-676 shape) that the
// dedup job gate produces for non-arming events.
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

function armingLegOfLabel(labelName) {
    if (!labelName || typeof labelName !== 'string') return null;
    return ARMING_LABEL_LEGS.hasOwnProperty(labelName) ? ARMING_LABEL_LEGS[labelName] : null;
}

/**
 * The leg of the STRONGEST arming label on the issue (assigned events).
 */
function assignedEventLeg(issueLabelNames) {
    var names = Array.isArray(issueLabelNames) ? issueLabelNames : [];
    for (var i = 0; i < ASSIGNED_LEG_PRIORITY.length; i++) {
        if (names.indexOf(ASSIGNED_LEG_PRIORITY[i]) !== -1) {
            return { applicable: true, leg: ARMING_LABEL_LEGS[ASSIGNED_LEG_PRIORITY[i]] };
        }
    }
    return { applicable: true, leg: '' };
}

/**
 * The leg an issues event will run. Returns { applicable, leg }:
 *  - labeled: applicable iff the label is an arming label (the workflow
 *    job gate admits exactly these — non-arming lifecycle labels skip the
 *    jobs entirely, gh-1029 zero-burn parity);
 *  - assigned: always applicable; leg = strongest arming label on the
 *    issue, '' when none (a bare assign declares no leg — an in-flight
 *    run for the issue still suppresses it, see legsCompatible);
 *  - anything else: applicable, leg ''.
 */
function deriveEventLeg(action, labelName, issueLabelNames) {
    if (action === 'labeled') {
        var leg = armingLegOfLabel(labelName);
        return { applicable: leg !== null, leg: leg || '' };
    }
    if (action === 'assigned') return assignedEventLeg(issueLabelNames);
    return { applicable: true, leg: '' };
}

/**
 * One anchored-token scanner shared by the two issue-anchor regex
 * families (stub '#<n>' and factory/template 'gh-<n>'): iterate the
 * pattern's matches and accept the FIRST match that is not immediately
 * followed by a digit — a trailing-digit guard keeps '#104' from matching
 * '#1040'. Returns a number or null.
 */
function anchoredNumberOf(name, re) {
    var m = re.exec(name);
    while (m) {
        var after = name.charAt(m.index + m[0].length);
        if (after === '' || after < '0' || after > '9') return parseInt(m[1], 10);
        m = re.exec(name);
    }
    return null;
}

/**
 * The issue anchor carried by a run title. Both title families carry it:
 * the stub's 'teammate: assigned #1040' / 'teammate: workflow_dispatch
 * #1040 dev' and the factory/SM '▶ dev (SM) · gh-1040' / template
 * '⚒️ dev · gh-1040' shapes. Returns a number or null.
 */
function issueOfRunName(name) {
    if (!name || typeof name !== 'string') return null;
    // First well-terminated '#<n>' token wins.
    var issue = anchoredNumberOf(name, /#(\d+)/g);
    if (issue !== null) return issue;
    return anchoredNumberOf(name, /(?:^|[^0-9a-zA-Z])gh-(\d+)/g);
}

/**
 * The PR anchor carried by a run title ('teammate: workflow_dispatch # · pr-1151 review'
 * or '▶ review (SM) · pr-1151'). Uses the same non-digit boundary guard as
 * issueOfRunName so 'pr-115' never matches 'pr-1151'. Returns a number or null.
 */
function prOfRunName(name) {
    if (!name || typeof name !== 'string') return null;
    return anchoredNumberOf(name, /(?:^|[^0-9a-zA-Z])pr-(\d+)/g);
}

// Emoji-marker → leg for the template title family ('🔧 rework · ...',
// '🔍 review · ...', '⚒️ dev · ...').
var EMOJI_LEG_MARKERS = [['🔧', 'rework'], ['🔍', 'review'], ['⚒️', 'dev']];

function emojiLegOf(name) {
    for (var i = 0; i < EMOJI_LEG_MARKERS.length; i++) {
        var marker = EMOJI_LEG_MARKERS[i][0];
        var at = name.indexOf(marker);
        if (at !== -1 && name.indexOf(EMOJI_LEG_MARKERS[i][1], at) !== -1) {
            return EMOJI_LEG_MARKERS[i][1];
        }
    }
    return '';
}

/** Trailing leg token of a stub title ('teammate: ... #<n> <leg>'). */
function stubTailLegOf(name) {
    var m = /\s(dev|review|rework)$/.exec(name);
    return m ? m[1] : '';
}

/**
 * The leg a run title carries, '' when unknown:
 *  - '▶ <leg> (SM) · ...'           — SM dispatch (factory title)
 *  - '🔧 rework · ...' / '🔍 review · ...' / '⚒️ dev · ...'
 *                                   — template event titles
 *  - 'teammate: ... #<n> <leg>'     — stub titles (dispatch leg input AND
 *                                     the event-path label-derived leg the
 *                                     stub run-name carries since the
 *                                     gh-1065 rework; the stub prefix is
 *                                     required so an issue title ending
 *                                     in a leg word never aliases)
 * Event-path stub titles from before the run-name change ('teammate:
 * assigned #1040') carry no leg → ''.
 */
function legOfRunName(name) {
    if (!name || typeof name !== 'string') return '';
    var m = /▶\s+(dev|review|rework)\s+\(SM\)/.exec(name);
    if (m) return m[1];
    var emoji = emojiLegOf(name);
    if (emoji) return emoji;
    if (name.indexOf('teammate:') === 0) return stubTailLegOf(name);
    return '';
}

/**
 * gh-1028 key semantics for IN-FLIGHT owners: same issue + same leg. An
 * UNKNOWN leg on either side is a wildcard — event-path run titles from
 * a live burst cannot be told apart ('teammate: issues #1040'), and a
 * bare `assigned` event declares none, yet both are how the observed
 * burst (#1040–#1043: assign-while-labels-change) reaches the workflow;
 * treating '' as a match-all keeps exactly one run per issue per burst
 * (AC1/AC4). Precision where it is possible: when BOTH legs are known
 * they must be EQUAL — an SM-dispatched 'dev' leg in flight never
 * swallows a genuinely new 'review' trigger (the concurrency group
 * serializes the review run behind the dev leg instead of dropping it).
 */
function legsCompatible(eventLeg, runLeg) {
    var e = eventLeg || '';
    var r = runLeg || '';
    if (e === '' || r === '') return true;
    return e === r;
}

/**
 * gh-1065 rework — key semantics for COMPLETED owners (the freshness
 * window): STRICT. A completed owner that suppressed a KNOWN new leg
 * would swallow genuinely sequential human actions (assign at T, the run
 * concludes success at T+4min, the same human deliberately adds
 * agent:review at T+6min — a new request, not burst noise). So a
 * completed owner with an unknown leg suppresses ONLY another unknown-leg
 * event (a second bare assign inside the window stays burst noise); in
 * all other cases both legs must be known and equal. The wildcard stays
 * where it belongs — on in-flight owners (legsCompatible).
 */
function completedLegsCompatible(eventLeg, runLeg) {
    var e = eventLeg || '';
    var r = runLeg || '';
    if (e === '' && r === '') return true;
    return e !== '' && r !== '' && e === r;
}

/**
 * Leg compatibility for a candidate owner: the wildcard is scoped to
 * in-flight owners; completed owners are strict.
 */
function ownerLegCompatible(run, eventLeg) {
    if (isActiveStatus(run.status)) return legsCompatible(eventLeg, legOfRunName(run.name));
    return completedLegsCompatible(eventLeg, legOfRunName(run.name));
}

// The freshness probes bound to this module's active-state vocabulary
// ('requested' included) — one factory call instead of the former delegate
// copies (gh-1248 dedup).
var runProbes = legRunVocab.makeRunProbes(ACTIVE_RUN_STATES);
var isActiveStatus = runProbes.isActiveStatus;
var runTimestampMs = runProbes.runTimestampMs;
/** gh-1028 zombie parity: non-in_progress active state past the stale bound. */
var isStaleNonRunning = runProbes.isStaleNonRunning;

/**
 * A run that concluded 'success' within the freshness window still owns
 * the issue+leg key. Any other conclusion (failure, cancelled, skipped)
 * owns nothing — the retry path stays open. Note the transport guarantee
 * that makes 'success' trustworthy: the dedup JOB is gated by the same
 * arming gate as the teammate call, so a run that never ran a leg (a
 * dropped duplicate is a real leg run's sibling; a non-arming label
 * write executes ZERO jobs and concludes failure) cannot conclude
 * 'success' on its own.
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
 * Tie-break helpers: the suppressor must be STRICTLY OLDER than the
 * probing run, so of a same-second burst (run_numbers N, N+1, N+2) only
 * the earliest proceeds — regardless of probe execution order. run_number
 * order first (REST always carries it), created_at fallback; a run with
 * neither order signal is ignored. Timestamps accept ISO strings or
 * epoch ms.
 */
function timeMsOf(value) {
    if (typeof value === 'number') return isNaN(value) ? NaN : value;
    if (!value) return NaN;
    var ms = Date.parse(String(value));
    return isNaN(ms) ? NaN : ms;
}

function olderByCreatedAt(run, selfRun) {
    var ta = timeMsOf(run.created_at);
    var tb = timeMsOf(selfRun.createdAt);
    return !isNaN(ta) && !isNaN(tb) && ta < tb;
}

/**
 * Older = STRICTLY older. run_number order DECIDES when both sides carry
 * it (REST always does — no created_at fallback there); only when a side
 * lacks a run_number does the created_at fallback run. A run with neither
 * order signal is ignored.
 */
function isOlderRun(run, selfRun) {
    if (!run || !selfRun) return false;
    var a = run.run_number, b = selfRun.runNumber;
    if (typeof a === 'number' && typeof b === 'number') {
        return !isNaN(a) && !isNaN(b) && a < b;
    }
    return olderByCreatedAt(run, selfRun);
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

function selfIdOf(selfRun) {
    if (selfRun && selfRun.id !== undefined) return selfRun.id;
    return null;
}

/** The per-candidate gate — the six-condition suppressor predicate. */
function isSuppressorRun(run, ctx) {
    if (ctx.selfId !== null && run.id === ctx.selfId) return false;
    if (!isLegWorkflowRun(run, ctx.workflowFile)) return false;
    if (issueOfRunName(run.name) !== ctx.issue) return false;
    if (!ownerLegCompatible(run, ctx.leg)) return false;
    if (!isOwningRun(run, ctx.nowMs, ctx.staleMs, ctx.freshMs)) return false;
    return isOlderRun(run, ctx.selfRun);
}

/** The first run of the candidate list that suppresses this event. */
function findSuppressor(runs, ctx) {
    for (var i = 0; i < runs.length; i++) {
        var run = runs[i] || {};
        if (isSuppressorRun(run, ctx)) return run;
    }
    return null;
}

/** The scan context shared by the per-candidate predicates. */
function scanContextOf(input, issue, leg) {
    var selfRun = input.selfRun || {};
    return {
        issue: issue,
        leg: leg,
        workflowFile: input.workflowFile || DEFAULT_WORKFLOW_FILE,
        nowMs: nowMsOf(input),
        staleMs: staleMsOf(input),
        freshMs: freshMsOf(input),
        selfRun: selfRun,
        selfId: selfIdOf(selfRun)
    };
}

/** A proceed verdict — the ONLY proceed=false outcome is 'duplicate'. */
function proceedVerdict(reason, audit) {
    return { proceed: true, reason: reason, audit: audit };
}

function issueNumberOf(input) {
    return typeof input.issue === 'number' ? input.issue : parseInt(input.issue, 10);
}

function prNumberOf(input) {
    return typeof input.pr === 'number' ? input.pr : parseInt(input.pr, 10);
}

function hasRuns(runs) {
    return Array.isArray(runs) && runs.length > 0;
}

function isInFlightRun(run, nowMs, staleMs) {
    return legRunVocab.isFreshActiveRun(run, ACTIVE_RUN_STATES, nowMs, staleMs);
}

function runMatchesDispatchAnchor(run, ctx) {
    if (!isNaN(ctx.issue) && issueOfRunName(run.name) === ctx.issue) return true;
    return !isNaN(ctx.pr) && prOfRunName(run.name) === ctx.pr;
}

function isDispatchSuppressorRun(run, ctx) {
    if (ctx.selfId !== null && run.id === ctx.selfId) return false;
    if (!isLegWorkflowRun(run, ctx.workflowFile)) return false;
    if (!runMatchesDispatchAnchor(run, ctx)) return false;
    if (!legsCompatible(ctx.leg, legOfRunName(run.name))) return false;
    if (!isInFlightRun(run, ctx.nowMs, ctx.staleMs)) return false;
    return isOlderRun(run, ctx.selfRun);
}

function findDispatchSuppressor(runs, ctx) {
    for (var i = 0; i < runs.length; i++) {
        var run = runs[i] || {};
        if (isDispatchSuppressorRun(run, ctx)) return run;
    }
    return null;
}

function dispatchAnchorLabel(issue, pr) {
    return !isNaN(pr) ? ('pr-' + pr) : ('#' + issue);
}

function duplicateDispatchVerdict(run, anchorLabel, leg) {
    var owner = run.run_number !== undefined ? ('run ' + run.run_number) : ('run id ' + run.id);
    return {
        proceed: false,
        reason: 'duplicate',
        audit: '⏭️ teammate dedup (gh-1153): dropped workflow_dispatch on ' + anchorLabel +
            ' (leg \'' + (leg || 'any') + '\') — ' + owner +
            ' for the same anchor+leg is in flight (' + run.status + '); this dispatch is a duplicate'
    };
}

function decideDispatchDedup(input) {
    var issue = issueNumberOf(input);
    var pr = prNumberOf(input);
    if ((isNaN(issue) && isNaN(pr)) || !hasRuns(input.runs)) {
        return proceedVerdict('dispatch-path',
            'teammate dedup (gh-1065): workflow_dispatch path — governed by the SM-side gh-1028 dedup; proceeding');
    }
    var leg = String(input.leg || '');
    var ctx = scanContextOf(input, issue, leg);
    ctx.pr = pr;
    var anchorLabel = dispatchAnchorLabel(issue, pr);
    var owner = findDispatchSuppressor(input.runs, ctx);
    if (owner) return duplicateDispatchVerdict(owner, anchorLabel, leg);
    return proceedVerdict('first-trigger',
        'teammate dedup (gh-1153): no in-flight run for ' + anchorLabel +
        ' (leg \'' + (leg || 'any') + '\') — proceeding');
}

function duplicateVerdict(run, input, issue, leg) {
    var owner = run.run_number !== undefined ? ('run ' + run.run_number) : ('run id ' + run.id);
    var state = run.status === 'completed'
        ? ('freshly completed (' + run.conclusion + ')')
        : ('in flight (' + run.status + ')');
    return {
        proceed: false,
        reason: 'duplicate',
        audit: '⏭️ teammate dedup (gh-1065): dropped ' + String(input.action || 'issues') +
            ' event on #' + issue + ' (leg \'' + (leg || 'any') + '\') — ' +
            owner + ' for the same issue+leg is ' + state +
            ' within the dedup window; this trigger is a duplicate'
    };
}

function firstTriggerVerdict(issue, leg) {
    return proceedVerdict('first-trigger',
        'teammate dedup (gh-1065): no in-flight or freshly-completed run for #' +
        issue + ' (leg \'' + (leg || 'any') + '\') — proceeding');
}

/** The scan-phase verdicts: after preflight, the event arms the workflow. */
function scanVerdict(input, derived) {
    var issue = issueNumberOf(input);
    if (isNaN(issue)) {
        return proceedVerdict('no-issue-anchor',
            'teammate dedup (gh-1065): issues event without an issue anchor — proceeding');
    }
    if (!hasRuns(input.runs)) {
        return proceedVerdict('no-runs',
            'teammate dedup (gh-1065): no runs on file for the leg workflow — proceeding');
    }
    var owner = findSuppressor(input.runs, scanContextOf(input, issue, derived.leg));
    if (owner) return duplicateVerdict(owner, input, issue, derived.leg);
    return firstTriggerVerdict(issue, derived.leg);
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
    if (input.eventName === 'workflow_dispatch') {
        return decideDispatchDedup(input);
    }
    if (input.eventName !== 'issues') {
        return proceedVerdict('dispatch-path',
            'teammate dedup (gh-1065): ' + (input.eventName || 'dispatch') +
            ' path — governed by the SM-side gh-1028 dedup; proceeding');
    }
    var derived = deriveEventLeg(input.action, input.labelName, input.issueLabelNames);
    if (!derived.applicable) {
        return proceedVerdict('non-arming-label',
            'teammate dedup (gh-1065): labeled event for non-arming label' +
            ' — the job gate rejects it; no probe spent');
    }
    return scanVerdict(input, derived);
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
    prOfRunName: prOfRunName,
    legOfRunName: legOfRunName,
    legsCompatible: legsCompatible,
    completedLegsCompatible: completedLegsCompatible,
    isActiveStatus: isActiveStatus,
    isStaleNonRunning: isStaleNonRunning,
    isFreshlyCompleted: isFreshlyCompleted,
    isOwningRun: isOwningRun,
    isOlderRun: isOlderRun,
    isLegWorkflowRun: isLegWorkflowRun,
    decideEventDedup: decideEventDedup
};
