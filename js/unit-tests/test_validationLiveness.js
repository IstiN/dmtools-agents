/**
 * Unit tests for js/common/validationLiveness.js — the arm-must-mean-a-
 * live-run state machine (gh-821).
 *
 * Bug (fa PR #1443, 2026-10-09): the dispatched validation run concluded
 * CANCELLED while the ai_validating arm stayed on; the stale-arm sweeper
 * had no liveness vocabulary beyond verdict/no-verdict, so the arm kept
 * holding the serial merge-window mutex with NO live run behind it and
 * four validated PRs deferred ~2h until a manual dispatch.
 *
 * Coverage (ticket test plan L1 — the liveness state machine):
 *   running          — in-flight, or concluded inside the check-visibility
 *                      grace (fresh cancellations are NOT zombies — gh-755
 *                      and the rerun-cancelled-checks remedy own them)
 *   green / red      — verdict paths, unchanged consumption
 *   zombie-cancelled — concluded CANCELLED past every grace
 *   zombie-no-run    — no dispatched run on the head at all (lost dispatch)
 *   fail-safe        — degraded/absent probes classify 'running' (a missed
 *                      recovery retries next tick; never a wrongful churn)
 *   zombie marks     — the marker-comment carrier: per-head counts for the
 *                      crash-loop cap (3 in a row ⇒ park) and the newest
 *                      marker timestamp for the 1/head/hour rate bound
 *
 * Pure module — no tool globals; loadModule with no mocks.
 */

var assert = globalThis.assert;

var live = loadModule('js/common/validationLiveness.js', makeRequire({}), {});

var HEAD = '23dacd10deadbeefcafe0123456789abcdef0123';
var OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
var HOUR_MS = 60 * 60 * 1000;

// ── classify: the liveness state machine ─────────────────────────────────────

suite('validationLiveness classify — running', function () {
    test('an active run is running (AC3 — the healthy flow holds the mutex)', function () {
        assert.equal(live.classify({ active: true, newest: { status: 'in_progress', head_sha: HEAD } }),
            'running');
        assert.equal(live.classify({ active: true, newest: { status: 'queued', head_sha: HEAD } }),
            'running');
    });

    test('a FRESH cancellation (inside the 15-min visibility grace) is still running, never a zombie', function () {
        // hasActiveDispatchedRun counts a completed run active for 15 min
        // after its conclusion — a fresh cancel sits in the gh-755 /
        // rerun-cancelled-checks race window and must not re-dispatch.
        var t = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        assert.equal(
            live.classify({ active: true, newest: { status: 'completed', conclusion: 'cancelled',
                head_sha: HEAD, created_at: t, updated_at: t } }),
            'running');
    });

    test('degraded shapes fail safe: no probe at all → running (arm stays, retry next tick)', function () {
        assert.equal(live.classify(null), 'running');
        assert.equal(live.classify({ active: false, newest: { status: 'queued', head_sha: HEAD } }),
            'running');
        assert.equal(live.classify({ active: false, newest: { status: 'completed', conclusion: null, head_sha: HEAD } }),
            'running');
    });

    test('a truthy probe with NO facets reads as zombie-no-run (deliberate gh-821 bias)', function () {
        // The realistic degraded shape from probeDispatchedState is
        // { active: false, newest: null } — every helper fails CLOSED — and
        // that IS the lost-dispatch zombie. A wedged arm is the worse failure
        // mode; a wrongful re-dispatch is bounded (1/head/hour).
        assert.equal(live.classify({}), 'zombie-no-run');
    });
});

suite('validationLiveness classify — verdicts (unchanged paths)', function () {
    test('newest concluded success → green (the sweep latches)', function () {
        assert.equal(
            live.classify({ active: false, verdict: 'success',
                newest: { status: 'completed', conclusion: 'success', head_sha: HEAD } }),
            'green');
    });

    test('newest concluded failure → red (the standard fail path owns it)', function () {
        assert.equal(
            live.classify({ active: false, verdict: 'failure',
                newest: { status: 'completed', conclusion: 'failure', head_sha: HEAD } }),
            'red');
        assert.equal(
            live.classify({ active: false,
                newest: { status: 'completed', conclusion: 'timed_out', head_sha: HEAD } }),
            'red');
    });
});

suite('validationLiveness classify — zombies (gh-821)', function () {
    test('a STALE cancellation (past every grace) is zombie-cancelled', function () {
        // The #1443 shape: the run died cancelled 2h ago; active=false.
        var t = new Date(Date.now() - 2 * HOUR_MS).toISOString();
        assert.equal(
            live.classify({ active: false, newest: { status: 'completed', conclusion: 'cancelled',
                head_sha: HEAD, created_at: t, updated_at: t } }),
            'zombie-cancelled');
    });

    test('no dispatched run on the head at all is zombie-no-run (lost dispatch)', function () {
        assert.equal(live.classify({ active: false, newest: null }), 'zombie-no-run');
    });

    test('green/red NEVER classify as zombie regardless of age', function () {
        assert.equal(
            live.classify({ active: false,
                newest: { status: 'completed', conclusion: 'success', head_sha: HEAD } }),
            'green');
        assert.equal(
            live.classify({ active: false,
                newest: { status: 'completed', conclusion: 'failure', head_sha: HEAD } }),
            'red');
    });
});

// ── zombie marks: the durable per-head bookkeeping ──────────────────────────

suite('validationLiveness zombie markers', function () {
    test('zombieMarkerLine round-trips through the marker regex and zombieMarks', function () {
        var line = live.zombieMarkerLine(2, HEAD, 3, '2026-10-09T14:00:00.000Z');
        assert.ok(line.indexOf('zombie re-dispatch') !== -1, 'the marker names the operation');
        var marks = live.zombieMarks([line]);
        assert.equal(marks[HEAD].count, 2, 'the count is parseable back');
        assert.equal(marks[HEAD].lastAtMs, Date.parse('2026-10-09T14:00:00.000Z'),
            'the timestamp is parseable back');
    });

    test('count takes the MAX N and lastAtMs the NEWEST stamp across comments (per head)', function () {
        var bodies = [
            live.zombieMarkerLine(1, HEAD, 3, '2026-10-09T14:00:00.000Z'),
            'unrelated chatter 🔄 zombie re-dispatch not-a-marker',
            live.zombieMarkerLine(2, HEAD, 3, '2026-10-09T15:00:00.000Z')
        ];
        var marks = live.zombieMarks(bodies);
        assert.equal(marks[HEAD].count, 2);
        assert.equal(marks[HEAD].lastAtMs, Date.parse('2026-10-09T15:00:00.000Z'));
    });

    test('markers for OTHER heads are ignored — a head move resets the count by construction', function () {
        var bodies = [
            live.zombieMarkerLine(3, OTHER, 3, '2026-10-09T14:00:00.000Z')
        ];
        var marks = live.zombieMarks(bodies);
        assert.equal(marks[OTHER].count, 3, 'the other head keeps its count');
        assert.equal(marks[HEAD], undefined, 'THIS head has none — fresh count');
    });

    test('empty/garbage input degrades to an empty map (no wedges)', function () {
        assert.deepEqual(live.zombieMarks([]), {});
        assert.deepEqual(live.zombieMarks(null), {});
        assert.deepEqual(live.zombieMarks(['', 'no markers here']), {});
    });

    test('an unparsable timestamp degrades to lastAtMs null but keeps the count', function () {
        var line = '🔄 zombie re-dispatch ' + HEAD + ' — zombie 1/3 at not-a-date';
        var marks = live.zombieMarks([line]);
        assert.equal(marks[HEAD].count, 1, 'the crash-loop cap reads the count');
        assert.equal(marks[HEAD].lastAtMs, null, 'the rate bound cannot fire — bounded churn, not a wedge');
    });
});

suite('validationLiveness knobs', function () {
    test('defaults: cap 3, window 1h (gh-821: 3 in a row ⇒ park, 1/head/hour)', function () {
        assert.equal(live.zombieCapOf({}), 3);
        assert.equal(live.zombieCapOf(undefined), 3);
        assert.equal(live.zombieWindowMsOf({}), HOUR_MS);
        assert.equal(live.zombieWindowMsOf(undefined), HOUR_MS);
    });

    test('deployment overrides (number or numeric string)', function () {
        assert.equal(live.zombieCapOf({ zombieRedispatchCap: 5 }), 5);
        assert.equal(live.zombieCapOf({ zombieRedispatchCap: '4' }), 4);
        assert.equal(live.zombieWindowMsOf({ zombieRedispatchMinMs: 1800000 }), 1800000);
        assert.equal(live.zombieWindowMsOf({ zombieRedispatchMinMs: '0' }), 0, '0 disables the bound');
        assert.equal(live.zombieWindowMsOf({ zombieRedispatchMinMs: -5 }), HOUR_MS, 'garbage → default');
    });
});

suite('validationLiveness ACTIVE_RUN_STATES (gh-821 round-2 review)', function () {
    // The exported constant is the SINGLE SOURCE OF TRUTH for the "a run is
    // materially in flight" vocabulary: smAgent's hasActiveDispatchedRun and
    // hasActiveHeadRun consume it (gh-821 round-2 review — an unused exported
    // parity constant invited drift exactly where parity is the point). This
    // pin freezes the contract: GitHub's four non-concluded run states.
    test('the vocabulary is exactly GitHub\'s four in-flight run states', function () {
        assert.deepEqual(live.ACTIVE_RUN_STATES, ['queued', 'in_progress', 'waiting', 'pending']);
    });

    test('no concluded state leaks into the active vocabulary', function () {
        assert.equal(live.ACTIVE_RUN_STATES.indexOf('completed'), -1,
            'completed is a conclusion carrier, never "in flight"');
        assert.equal(live.ACTIVE_RUN_STATES.indexOf('cancelled'), -1);
        assert.equal(live.ACTIVE_RUN_STATES.indexOf('success'), -1);
    });
});
