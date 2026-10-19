/**
 * Unit tests for js/common/teammateEventDedup.js — the gh-1065 event-path
 * trigger dedup: one human action (assign, or assign-while-labels-change)
 * emits multiple issues events, and each event used to start its own
 * ai-teammate.yml run (live 2026-10-18: #1040–#1043 two runs each,
 * #1061 three runs, owner hand-cancelling duplicates). The gh-1028 dedup
 * guards the SM dispatch path only; this module gates the GitHub-event
 * path with the same key semantics (same issue + same leg + in-flight or
 * freshly-completed ⇒ skip), a strict run_number tie-break (only an OLDER
 * run suppresses, so exactly one survivor per burst), and fail-open probe
 * errors (AC3).
 *
 *   AC1  assigning an issue (with or without a simultaneous label event)
 *        yields exactly ONE teammate run; the dropped duplicate carries an
 *        audit entry.
 *   AC2  the key matches the gh-1028 SM-side semantics: same issue + same
 *        leg; in-flight or freshly-completed within the window ⇒ skip.
 *   AC3  a broken probe (missing/garbled run list) must not swallow the
 *        trigger — missing data proceeds.
 *   AC4  simulated assigned+labeled double event → one dispatch, one
 *        skip-audit entry.
 *
 * Pure module — no tool globals; loadModule with no mocks.
 */

/* global loadModule, assert, test, suite, file_read */

var dedup = loadModule('js/common/teammateEventDedup.js', makeRequire({}), {});

var NOW_MS = Date.parse('2026-10-18T20:11:30.000Z');
var FIVE_MIN_AGO = '2026-10-18T20:06:30.000Z';
var TWENTY_MIN_AGO = '2026-10-18T19:51:30.000Z';
var SEVEN_HOURS_AGO = '2026-10-18T13:11:30.000Z';
var LEG_PATH = '.github/workflows/ai-teammate.yml';
var ISSUE = 1040;

// ── helpers ──────────────────────────────────────────────────────────────

function runOnIssue(runNumber, status, opts) {
    opts = opts || {};
    var r = {
        id: opts.id !== undefined ? opts.id : 900000 + runNumber,
        run_number: runNumber,
        name: opts.name || ('teammate: issues #' + ISSUE + ' '),
        status: status,
        path: opts.path || LEG_PATH,
        created_at: opts.createdAt || FIVE_MIN_AGO,
        updated_at: opts.updatedAt || FIVE_MIN_AGO,
        conclusion: opts.conclusion
    };
    return r;
}

function selfRun(runNumber, opts) {
    opts = opts || {};
    return {
        id: opts.id !== undefined ? opts.id : 800000 + runNumber,
        runNumber: runNumber,
        createdAt: opts.createdAt || NOW_MS
    };
}

function assignedEvent(opts) {
    opts = opts || {};
    return {
        eventName: 'issues',
        action: 'assigned',
        issue: ISSUE,
        issueLabelNames: opts.issueLabelNames || [],
        runs: opts.runs || [],
        selfRun: opts.selfRun || selfRun(500),
        nowMs: opts.nowMs !== undefined ? opts.nowMs : NOW_MS
    };
}

function labeledEvent(labelName, opts) {
    opts = opts || {};
    return {
        eventName: 'issues',
        action: 'labeled',
        labelName: labelName,
        issue: ISSUE,
        issueLabelNames: opts.issueLabelNames || [],
        runs: opts.runs || [],
        selfRun: opts.selfRun || selfRun(501),
        nowMs: opts.nowMs !== undefined ? opts.nowMs : NOW_MS
    };
}

// ── title parsing ─────────────────────────────────────────────────────────

suite('teammateEventDedup — title parsing', function () {

    test('issueOfRunName reads the stub event title (#<n>)', function () {
        assert.equal(dedup.issueOfRunName('teammate: issues #1040 '), 1040);
        assert.equal(dedup.issueOfRunName('teammate: assigned #1040'), 1040);
    });

    test('issueOfRunName reads the SM and template titles (gh-<n>)', function () {
        assert.equal(dedup.issueOfRunName('▶ dev (SM) · gh-1040'), 1040);
        assert.equal(dedup.issueOfRunName('⚒️ dev · gh-1040: Fix the dedup'), 1040);
    });

    test('issueOfRunName never cross-matches a longer number', function () {
        assert.equal(dedup.issueOfRunName('teammate: issues #10401 '), 10401);
        assert.notEqual(dedup.issueOfRunName('teammate: issues #10401 '), 1040);
        assert.equal(dedup.issueOfRunName('▶ dev (SM) · gh-10401'), 10401);
    });

    test('issueOfRunName returns null for PR-anchored or anchor-less titles', function () {
        assert.equal(dedup.issueOfRunName('▶ rework (SM) · pr-266'), null);
        assert.equal(dedup.issueOfRunName('teammate: workflow_dispatch #  '), null);
        assert.equal(dedup.issueOfRunName(''), null);
        assert.equal(dedup.issueOfRunName(null), null);
    });

    test('legOfRunName reads the SM dispatch leg', function () {
        assert.equal(dedup.legOfRunName('▶ rework (SM) · gh-1040'), 'rework');
        assert.equal(dedup.legOfRunName('▶ review (SM) · gh-1040'), 'review');
    });

    test('legOfRunName reads the template emoji titles', function () {
        assert.equal(dedup.legOfRunName('🔧 rework · gh-1040'), 'rework');
        assert.equal(dedup.legOfRunName('🔍 review · gh-1040'), 'review');
        assert.equal(dedup.legOfRunName('⚒️ dev · gh-1040'), 'dev');
    });

    test('legOfRunName reads the stub dispatch trailing leg only with the stub prefix', function () {
        assert.equal(dedup.legOfRunName('teammate: workflow_dispatch #1040 dev'), 'dev');
        assert.equal(dedup.legOfRunName('teammate: workflow_dispatch #1040 review'), 'review');
        assert.equal(dedup.legOfRunName('teammate: issues #1040 '), '');
        // an issue TITLE ending in a leg word must not alias (no stub prefix)
        assert.equal(dedup.legOfRunName('some title ending in review'), '');
    });

    test('legOfRunName reads the leg the stub run-name now carries for event-path runs', function () {
        // gh-1065 rework: run-name resolves the strongest arming label, so a
        // completed event-path owner stays title-precise (the strict
        // completed-owner leg rule needs it).
        assert.equal(dedup.legOfRunName('teammate: issues #1040 dev'), 'dev');
        assert.equal(dedup.legOfRunName('teammate: issues #1040 review'), 'review');
        assert.equal(dedup.legOfRunName('teammate: issues #1040 rework'), 'rework');
        assert.equal(dedup.issueOfRunName('teammate: issues #1040 dev'), 1040);
    });
});

// ── event leg derivation ─────────────────────────────────────────────────

suite('teammateEventDedup — deriveEventLeg', function () {

    test('labeled arming labels map to legs; lifecycle labels are not applicable', function () {
        assert.deepEqual(dedup.deriveEventLeg('labeled', 'agent:dev', []), { applicable: true, leg: 'dev' });
        assert.deepEqual(dedup.deriveEventLeg('labeled', 'agent:develop', []), { applicable: true, leg: 'dev' });
        assert.deepEqual(dedup.deriveEventLeg('labeled', 'agent:review', []), { applicable: true, leg: 'review' });
        assert.deepEqual(dedup.deriveEventLeg('labeled', 'agent:rework', []), { applicable: true, leg: 'rework' });
        assert.deepEqual(dedup.deriveEventLeg('labeled', 'pr_approved', []), { applicable: true, leg: 'review' });
        assert.deepEqual(dedup.deriveEventLeg('labeled', 'status:in_progress', []), { applicable: false, leg: '' });
        assert.deepEqual(dedup.deriveEventLeg('labeled', null, []), { applicable: false, leg: '' });
    });

    test('assigned picks the strongest arming label (rework > review > dev)', function () {
        assert.deepEqual(dedup.deriveEventLeg('assigned', null, ['agent:dev', 'agent:rework']),
            { applicable: true, leg: 'rework' });
        assert.deepEqual(dedup.deriveEventLeg('assigned', null, ['agent:review']),
            { applicable: true, leg: 'review' });
        assert.deepEqual(dedup.deriveEventLeg('assigned', null, ['agent:dev', 'bug']),
            { applicable: true, leg: 'dev' });
    });

    test('assigned with no arming labels declares no leg (wildcard)', function () {
        assert.deepEqual(dedup.deriveEventLeg('assigned', null, ['bug', 'status:x']),
            { applicable: true, leg: '' });
        assert.deepEqual(dedup.deriveEventLeg('assigned', null, null), { applicable: true, leg: '' });
    });
});

// ── key + window predicates ───────────────────────────────────────────────

suite('teammateEventDedup — key/window predicates', function () {

    test('legsCompatible: unknown leg wildcards on either side, known legs must be equal', function () {
        assert.ok(dedup.legsCompatible('', 'dev'));
        assert.ok(dedup.legsCompatible('review', ''));
        assert.ok(dedup.legsCompatible('', ''));
        assert.ok(dedup.legsCompatible('dev', 'dev'));
        assert.notOk(dedup.legsCompatible('dev', 'review'));
    });

    test('completedLegsCompatible: the wildcard is scoped to IN-FLIGHT owners only — a completed owner never swallows a KNOWN new leg', function () {
        // Review-thread regression (sequential human actions): assign at T
        // (the run title carries no leg), deliberate agent:review at T+6min
        // is a genuinely new request — the completed leg-less owner must not
        // suppress it. Both-unknown stays burst-noise; both-known stays
        // precision.
        assert.notOk(dedup.completedLegsCompatible('review', ''), 'known review after a leg-less completion proceeds');
        assert.notOk(dedup.completedLegsCompatible('', 'dev'), 'a bare re-assign after a known-leg completion proceeds');
        assert.ok(dedup.completedLegsCompatible('', ''), 'two unknown legs inside the window stay burst-noise');
        assert.ok(dedup.completedLegsCompatible('dev', 'dev'), 'same known leg is a duplicate');
        assert.notOk(dedup.completedLegsCompatible('dev', 'review'), 'different known legs never match');
    });

    test('isFreshlyCompleted: only success inside the window counts', function () {
        var ok = runOnIssue(499, 'completed', { conclusion: 'success', updatedAt: FIVE_MIN_AGO });
        assert.ok(dedup.isFreshlyCompleted(ok, NOW_MS, 10 * 60 * 1000), '5-min-old success is fresh');
        var old = runOnIssue(499, 'completed', { conclusion: 'success', updatedAt: TWENTY_MIN_AGO });
        assert.notOk(dedup.isFreshlyCompleted(old, NOW_MS, 10 * 60 * 1000), '20-min-old success aged out');
        var cancelled = runOnIssue(499, 'completed', { conclusion: 'cancelled', updatedAt: FIVE_MIN_AGO });
        assert.notOk(dedup.isFreshlyCompleted(cancelled, NOW_MS, 10 * 60 * 1000), 'cancelled owns nothing');
        var failed = runOnIssue(499, 'completed', { conclusion: 'failure', updatedAt: FIVE_MIN_AGO });
        assert.notOk(dedup.isFreshlyCompleted(failed, NOW_MS, 10 * 60 * 1000), 'failure owns nothing (retry stays open)');
    });

    test('isOwningRun: in_progress never ages out; stale non-running zombies own nothing (gh-1028 parity)', function () {
        var live = runOnIssue(499, 'in_progress', { updatedAt: SEVEN_HOURS_AGO });
        assert.ok(dedup.isOwningRun(live, NOW_MS, 6 * 3600 * 1000, 600 * 1000));
        var zombie = runOnIssue(499, 'queued', { updatedAt: SEVEN_HOURS_AGO });
        assert.notOk(dedup.isOwningRun(zombie, NOW_MS, 6 * 3600 * 1000, 600 * 1000));
        var queued = runOnIssue(499, 'queued', { updatedAt: FIVE_MIN_AGO });
        assert.ok(dedup.isOwningRun(queued, NOW_MS, 6 * 3600 * 1000, 600 * 1000));
    });

    test('isOlderRun: strict run_number ordering, created_at fallback, no signal → ignored', function () {
        assert.ok(dedup.isOlderRun({ run_number: 499 }, { runNumber: 500 }));
        assert.notOk(dedup.isOlderRun({ run_number: 501 }, { runNumber: 500 }), 'a NEWER run never suppresses');
        assert.notOk(dedup.isOlderRun({ run_number: 500 }, { runNumber: 500 }), 'self-age run is not a suppressor');
        assert.ok(dedup.isOlderRun({ created_at: FIVE_MIN_AGO }, { createdAt: NOW_MS }));
        assert.notOk(dedup.isOlderRun({}, { runNumber: 500 }), 'a run with no order signal is ignored');
    });

    test('isLegWorkflowRun: only runs of the leg workflow count (path guard parity)', function () {
        assert.notOk(dedup.isLegWorkflowRun(null), 'no run at all');
        assert.ok(dedup.isLegWorkflowRun({}), 'a missing path counts (legacy run shapes)');
        assert.ok(dedup.isLegWorkflowRun({ path: null }), 'a null path counts');
        assert.ok(dedup.isLegWorkflowRun({ path: '' }), 'an empty path counts');
        assert.ok(dedup.isLegWorkflowRun({ path: LEG_PATH }), 'the leg workflow path matches');
        assert.ok(dedup.isLegWorkflowRun({ path: 'workflows/ai-teammate.yml' }), 'a workflow-file suffix match counts');
        assert.notOk(dedup.isLegWorkflowRun({ path: '.github/workflows/quality.yml' }), 'another workflow never matches');
        assert.notOk(dedup.isLegWorkflowRun({ path: 'ai-teammate.yml' }), 'a path shorter than the /-prefixed suffix never matches');
        assert.ok(dedup.isLegWorkflowRun({ path: 'x/ai-teammate.yml' }, 'ai-teammate.yml'), 'an explicit workflowFile override matches its suffix');
    });
});

// ── THE DECISION ─────────────────────────────────────────────────────────

suite('teammateEventDedup — decideEventDedup', function () {

    test('AC4: assigned+labeled burst → exactly one dispatch, one skip-audit entry', function () {
        // The burst: run 500 (assigned) and run 501 (labeled agent:dev) for
        // #1040, created a second apart. Each run probes the run list.
        var burstRuns = [
            runOnIssue(500, 'in_progress', { id: 800500, name: 'teammate: issues #1040 ', createdAt: '2026-10-18T20:11:00.000Z' }),
            runOnIssue(501, 'queued', { id: 800501, name: 'teammate: issues #1040 ', createdAt: '2026-10-18T20:11:01.000Z' })
        ];
        var first = dedup.decideEventDedup(assignedEvent({
            issueLabelNames: ['agent:dev'],
            runs: burstRuns,
            selfRun: { id: 800500, runNumber: 500, createdAt: '2026-10-18T20:11:00.000Z' }
        }));
        var second = dedup.decideEventDedup(labeledEvent('agent:dev', {
            runs: burstRuns,
            selfRun: { id: 800501, runNumber: 501, createdAt: '2026-10-18T20:11:01.000Z' }
        }));
        var dispatches = [first, second].filter(function (d) { return d.proceed; });
        var skips = [first, second].filter(function (d) { return !d.proceed; });
        assert.equal(dispatches.length, 1, 'exactly ONE run of the burst proceeds');
        assert.equal(skips.length, 1, 'exactly ONE run of the burst is dropped');
        assert.equal(first.proceed, true, 'the EARLIEST run (500) proceeds regardless of probe order');
        assert.equal(second.reason, 'duplicate');
        assert.ok(second.audit.indexOf('gh-1065') !== -1 && second.audit.indexOf('#1040') !== -1,
            'the dropped trigger carries the audit line (issue + gate tag)');
    });

    test('AC4 (three-event burst, gh-1061 shape): two drops, one survivor', function () {
        var burst = [
            runOnIssue(500, 'in_progress', { id: 1, createdAt: '2026-10-18T20:07:00.000Z' }),
            runOnIssue(501, 'queued', { id: 2, createdAt: '2026-10-18T20:07:02.000Z' }),
            runOnIssue(502, 'queued', { id: 3, createdAt: '2026-10-18T20:07:03.000Z' })
        ];
        var verdicts = [1, 2, 3].map(function (i) {
            return dedup.decideEventDedup({
                eventName: 'issues', action: 'labeled', labelName: 'agent:dev', issue: ISSUE,
                runs: burst, selfRun: { id: i, runNumber: 499 + i, createdAt: NOW_MS }, nowMs: NOW_MS
            });
        });
        assert.equal(verdicts.filter(function (v) { return v.proceed; }).length, 1);
        assert.equal(verdicts.filter(function (v) { return !v.proceed; }).length, 2);
    });

    test('AC2: the concurrency group releases burst duplicates AFTER the first run — a fresh success suppresses them', function () {
        // Run 500 already completed successfully 3 minutes ago (the group
        // held 501 back); 501 must now drop.
        var finished = runOnIssue(500, 'completed', {
            conclusion: 'success', createdAt: '2026-10-18T20:08:00.000Z', updatedAt: '2026-10-18T20:08:30.000Z'
        });
        var v = dedup.decideEventDedup(assignedEvent({ runs: [finished], selfRun: selfRun(501) }));
        assert.equal(v.proceed, false, 'freshly-completed success owns the dedup window');
        assert.equal(v.reason, 'duplicate');
    });

    test('AC2: a completed run outside the freshness window owns nothing — a new assign proceeds', function () {
        var oldDone = runOnIssue(500, 'completed', {
            conclusion: 'success', createdAt: '2026-10-18T19:00:00.000Z', updatedAt: '2026-10-18T19:30:00.000Z'
        });
        var v = dedup.decideEventDedup(assignedEvent({ runs: [oldDone], selfRun: selfRun(501) }));
        assert.equal(v.proceed, true, 'an hour-old completion is a new request, not a duplicate');
        assert.equal(v.reason, 'first-trigger');
    });

    test('a cancelled duplicate owns nothing — the retry path stays open', function () {
        var cancelled = runOnIssue(500, 'completed', { conclusion: 'cancelled' });
        var v = dedup.decideEventDedup(labeledEvent('agent:dev', { runs: [cancelled] }));
        assert.equal(v.proceed, true);
    });

    test('AC2 precision: a KNOWN different leg in flight does not swallow a new trigger', function () {
        // SM dispatched the dev leg (title carries 'dev'); a review label
        // event is a genuinely new leg — it must proceed.
        var devDispatch = {
            id: 700001, run_number: 498, name: 'teammate: workflow_dispatch #1040 dev',
            status: 'in_progress', path: LEG_PATH, created_at: FIVE_MIN_AGO, updated_at: FIVE_MIN_AGO
        };
        var v = dedup.decideEventDedup(labeledEvent('agent:review', { runs: [devDispatch] }));
        assert.equal(v.proceed, true, 'dev in flight never swallows review');
        var dev = dedup.decideEventDedup(labeledEvent('agent:dev', { runs: [devDispatch] }));
        assert.equal(dev.proceed, false, 'same known leg is dropped');
    });

    test('runs for OTHER issues never suppress', function () {
        var other = runOnIssue(499, 'in_progress');
        other.name = 'teammate: issues #1041 ';
        var v = dedup.decideEventDedup(assignedEvent({ runs: [other] }));
        assert.equal(v.proceed, true);
    });

    test('runs of OTHER workflows never suppress (path guard parity)', function () {
        var foreign = runOnIssue(499, 'in_progress', { path: '.github/workflows/quality.yml' });
        var v = dedup.decideEventDedup(assignedEvent({ runs: [foreign] }));
        assert.equal(v.proceed, true);
    });

    test('the probing run itself (self id) never suppresses itself', function () {
        var self = runOnIssue(500, 'in_progress', { id: 800500 });
        var v = dedup.decideEventDedup(assignedEvent({ runs: [self], selfRun: selfRun(500, { id: 800500 }) }));
        assert.equal(v.proceed, true);
    });

    test('AC3 fail-open: a missing or broken run list proceeds (broken probe swallows nothing)', function () {
        [undefined, null, 'garbage', {}, []].forEach(function (runs) {
            var v = dedup.decideEventDedup(assignedEvent({ runs: runs }));
            assert.equal(v.proceed, true, 'proceeds on runs=' + JSON.stringify(runs));
        });
    });

    test('non-arming lifecycle label events skip the probe and proceed (the job gate rejects them)', function () {
        var v = dedup.decideEventDedup(labeledEvent('status:in_progress', { runs: null }));
        assert.equal(v.proceed, true);
        assert.equal(v.reason, 'non-arming-label');
    });

    test('workflow_dispatch passes through — the SM-side gh-1028 dedup governs it', function () {
        var v = dedup.decideEventDedup({
            eventName: 'workflow_dispatch', action: null, issue: ISSUE, runs: null, selfRun: selfRun(500)
        });
        assert.equal(v.proceed, true);
        assert.equal(v.reason, 'dispatch-path');
    });

    test('a stale queued zombie (gh-1028 6h bound) does not suppress', function () {
        var zombie = runOnIssue(499, 'queued', { updatedAt: SEVEN_HOURS_AGO });
        var v = dedup.decideEventDedup(assignedEvent({ runs: [zombie] }));
        assert.equal(v.proceed, true);
    });

    test('review-thread regression: a COMPLETED owner with unknown leg never swallows a KNOWN-leg event (sequential human actions)', function () {
        // The gh-1065 rework scopes the wildcard to in-flight owners: a run
        // titled 'teammate: issues #1040 ' that concluded success WITHOUT
        // running the leg (the dropped-duplicate shape) cannot own a
        // genuinely new, different-leg request within the window.
        var leglessDone = runOnIssue(500, 'completed', { conclusion: 'success' });
        var review = dedup.decideEventDedup(labeledEvent('agent:review', { runs: [leglessDone], selfRun: selfRun(501) }));
        assert.equal(review.proceed, true, 'deliberate agent:review minutes after a leg-less completion proceeds');
        assert.equal(review.reason, 'first-trigger');
        var dev = dedup.decideEventDedup(labeledEvent('agent:dev', { runs: [leglessDone], selfRun: selfRun(501) }));
        assert.equal(dev.proceed, true, 'a different known leg is never swallowed by a leg-less owner');
    });

    test('AC2 with carried legs: the burst duplicate of a KNOWN leg still drops after the first run completed', function () {
        // The stub run-name now carries the label-derived leg, so the burst
        // owner stays title-precise even when completed: the
        // assign-while-labels-change run 500 completes 'success', the queued
        // labeled agent:dev run 501 drops.
        var done = runOnIssue(500, 'completed', {
            conclusion: 'success',
            name: 'teammate: issues #1040 dev',
            createdAt: '2026-10-18T20:08:00.000Z', updatedAt: '2026-10-18T20:08:30.000Z'
        });
        var v = dedup.decideEventDedup(labeledEvent('agent:dev', { runs: [done], selfRun: selfRun(501) }));
        assert.equal(v.proceed, false, 'same known leg after completion is a duplicate');
        assert.equal(v.reason, 'duplicate');
    });

    test('in-flight owner still wildcards an unknown leg (the wildcard is scoped, not removed)', function () {
        // Event-path in-flight titles carry no leg; during a same-second
        // burst the in-flight owner of the same issue IS the same human
        // action — the wildcard survives for active states.
        var inflight = runOnIssue(500, 'in_progress');
        var v = dedup.decideEventDedup(labeledEvent('agent:dev', { runs: [inflight], selfRun: selfRun(501) }));
        assert.equal(v.proceed, false, 'an in-flight leg-less owner still suppresses (same burst)');
        assert.equal(v.reason, 'duplicate');
    });
});

// ── workflow wiring guard ─────────────────────────────────────────────────

suite('ai-teammate.yml — the dedup gate is wired into the stub', function () {

    var yml = file_read({ path: '.github/workflows/ai-teammate.yml' });

    // Every folded job-level `if: >-` scalar in the workflow (the stub
    // carries two since the gh-1065 rework: the dedup probe gate and the
    // teammate call gate).
    function foldedJobIfs(content) {
        var lines = content.split('\n');
        var ifs = [];
        for (var i = 0; i < lines.length; i++) {
            if (/^ {4}if: >-\s*$/.test(lines[i])) {
                var parts = [];
                for (var j = i + 1; j < lines.length; j++) {
                    if (/^\s*$/.test(lines[j])) continue;
                    if (/^ {5,}/.test(lines[j])) parts.push(lines[j].replace(/^\s+/, ''));
                    else break;
                }
                ifs.push(parts.join(' '));
            }
        }
        return ifs;
    }

    test('the dedup probe job exists and exposes the proceed gate', function () {
        assert.ok(yml.indexOf('dedup:') !== -1, 'a dedup job is declared');
        assert.ok(yml.indexOf('proceed: ${{ steps.probe.outputs.proceed }}') !== -1,
            'the job exposes the proceed output');
        assert.ok(yml.indexOf('js/common/teammateEventDedup.js') !== -1,
            'the probe consults the unit-tested decision module');
    });

    test('the teammate call gates on needs.dedup (event path AND dispatch path)', function () {
        assert.ok(yml.indexOf('needs: dedup') !== -1, 'the teammate job needs the probe');
        assert.ok(yml.indexOf("needs.dedup.outputs.proceed == 'true'") !== -1,
            'the call fires only when the probe proceeded');
    });

    test('the probe fails open on probe errors (AC3)', function () {
        assert.ok(yml.indexOf('probe degraded — fail-open') !== -1,
            'a probe crash still proceeds (catch-all fail-open, never wedges needs:)');
        assert.ok(yml.indexOf('status skipped, fail-open') !== -1,
            'a per-status API error is skipped fail-open');
    });

    test('the dedup job is gated (gh-1029 zero-burn parity, gh-1076 assigned-only): non-teammate events execute ZERO jobs', function () {
        // Review-thread fix: an unguarded dedup job burned a runner on EVERY
        // label write repo-wide. With the gate mirroring the teammate gate,
        // a non-arming lifecycle label write executes zero jobs — the run
        // concludes failure (the gh-676 phantom pattern) and owns no dedup
        // key, closing the freshness-window hole for runs that never ran a
        // leg. gh-1076 then removed the `labeled` trigger itself (live
        // #1074: the workflow re-fired on its own consequence labels), so
        // the mirror's labeled branch went with it — the byte-level
        // guarantee is now that NO labeled branch exists to fire.
        var ifs = foldedJobIfs(yml);
        assert.ok(ifs.length >= 2, 'both the dedup and the teammate job carry a folded if gate');
        var candidates = ifs.filter(function (b) { return b.indexOf('needs.dedup') === -1; });
        assert.equal(candidates.length, 1,
            'exactly one non-call folded gate (the dedup probe gate) — a third folded ' +
            'gate would silently shift this test onto the wrong one');
        var dedupIf = candidates[0];
        assert.ok(dedupIf.indexOf("github.event.action == 'labeled'") === -1 &&
            dedupIf.indexOf('github.event.label.name') === -1,
            'gh-1076: the dedup gate must not key the labeled action — the labeled ' +
            'trigger is gone, no labeled branch may survive. Gate: ' + dedupIf);
        assert.ok(dedupIf.indexOf("github.event.action == 'assigned'") !== -1,
            'the dedup gate keys the assignee check to the assigned action');
        assert.ok(dedupIf.indexOf("contains(github.event.issue.assignees.*.login, 'ai-teammate')") !== -1,
            'the dedup gate requires the ai-teammate assignee');
        assert.ok(dedupIf.indexOf("github.event_name == 'workflow_dispatch'") !== -1,
            'the dedup gate preserves the dispatch path (probe outputs proceed=true there)');
    });

    test('the run-name carries the label-derived leg (completed owners stay title-precise)', function () {
        assert.ok(yml.indexOf("contains(github.event.issue.labels.*.name, 'agent:rework')") !== -1,
            'run-name resolves the strongest arming label into the title');
    });

    test('label and assignee lists ride as JSON — names with spaces never fracture', function () {
        assert.ok(yml.indexOf('${{ toJson(github.event.issue.labels.*.name) }}') !== -1,
            'ISSUE_LABELS is JSON-encoded');
        assert.ok(yml.indexOf('${{ toJson(github.event.issue.assignees.*.login) }}') !== -1,
            'ASSIGNEES is JSON-encoded');
        assert.ok(yml.indexOf('parseEventList') !== -1, 'the probe parses the JSON lists');
    });

    test('the transport supplies the clock — without nowMs the freshness window is inert', function () {
        // Transport regression (mocked-gh smoke): the probe must pass
        // nowMs, otherwise the module degrades to in-flight-only and a
        // completed burst owner never suppresses the concurrency-released
        // duplicates (AC2 dead in production).
        assert.ok(yml.indexOf('nowMs: Date.now()') !== -1,
            'the probe passes the wall clock into the decision');
    });
});
