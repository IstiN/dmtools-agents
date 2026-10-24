/**
 * Unit tests for js/common/reworkLoopGuard.js (gh-957).
 *
 * The rework no-op loop guard: the rework post-action stamps one lap marker
 * per leg close ({head, pushed, resolved}); the SM arm actions count
 * consecutive no-op laps (pushed 0 AND resolved 0) on ONE head and withhold
 * + escalate at the cap. Live pathology: dart #424 — 7 no-op legs / 2h, the
 * arm re-matched every tick and starved the whole machine queue.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadGuard() {
    return loadModule('js/common/reworkLoopGuard.js',
        makeRequire({ './machineAuthor.js': machineAuthorReal(), './reviewVerdicts.js': reviewVerdictsReal() }));
}

function machineComment(body) {
    return { body: body, user: { login: 'ai-teammate' } };
}

function forgeComment(body) {
    return { body: body, user: { login: 'some-random-user' } };
}

suite('reworkLoopGuard.buildLapMarker / parseLapMarkers', function() {

    test('marker round-trips with head, pushed, resolved, run URL and timestamp', function() {
        var g = loadGuard();
        var body = g.buildLapMarker('abc123def456', 0, 3, 'https://github.com/o/r/actions/runs/123', '2026-10-17T10:00:00Z');
        assert.ok(body, 'marker built');
        var parsed = g.parseLapMarkers([machineComment(body)]);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].head, 'abc123def456');
        assert.equal(parsed[0].pushed, 0);
        assert.equal(parsed[0].resolved, 3);
        assert.equal(parsed[0].run, 'https://github.com/o/r/actions/runs/123');
        assert.equal(parsed[0].atMs, Date.parse('2026-10-17T10:00:00Z'));
    });

    test('unbuildable records return null (no head)', function() {
        var g = loadGuard();
        assert.equal(g.buildLapMarker(null, 0, 0, null, '2026-10-17T10:00:00Z'), null);
    });

    test('machine-author allowlist gates the markers (format is public)', function() {
        var g = loadGuard();
        var body = g.buildLapMarker('abc123def456', 0, 0, null, '2026-10-17T10:00:00Z');
        var allow = { authorLogins: ['ai-teammate'] };
        assert.equal(g.parseLapMarkers([machineComment(body)], allow).length, 1);
        assert.equal(g.parseLapMarkers([forgeComment(body)], allow).length, 0, 'forged marker from a non-machine identity is invisible');
    });

    test('markers sort by timestamp with payload order as tiebreak', function() {
        var g = loadGuard();
        var b1 = g.buildLapMarker('h1', 0, 0, null, '2026-10-17T10:00:00Z');
        var b2 = g.buildLapMarker('h1', 0, 0, null, '2026-10-17T11:00:00Z');
        var parsed = g.parseLapMarkers([machineComment(b2), machineComment(b1)]);
        assert.equal(parsed[0].at, '2026-10-17T10:00:00Z', 'oldest first');
        assert.equal(parsed[1].at, '2026-10-17T11:00:00Z');
    });
});

suite('reworkLoopGuard.consecutiveNoopLaps', function() {

    function laps(g, defs) {
        return defs.map(function(d) {
            return { head: d[0], pushed: d[1], resolved: d[2], atMs: 0 };
        });
    }

    test('counts the newest-first run of no-op laps on one head', function() {
        var g = loadGuard();
        assert.equal(g.consecutiveNoopLaps(laps(g, [['h1', 0, 0], ['h1', 0, 0]]), 'h1'), 2);
    });

    test('a progress lap (pushed) ends the run', function() {
        var g = loadGuard();
        assert.equal(g.consecutiveNoopLaps(laps(g, [['h1', 0, 0], ['h1', 1, 0], ['h1', 0, 0]]), 'h1'), 1);
    });

    test('a progress lap (resolved threads) ends the run', function() {
        var g = loadGuard();
        assert.equal(g.consecutiveNoopLaps(laps(g, [['h1', 0, 0], ['h1', 0, 5]]), 'h1'), 0,
            'the newest lap resolved threads — no consecutive no-ops');
    });

    test('laps on other heads do not count and do not mask this head\'s run', function() {
        var g = loadGuard();
        assert.equal(g.consecutiveNoopLaps(laps(g, [['h1', 0, 0], ['h2', 0, 0], ['h1', 0, 0]]), 'h1'), 2);
        assert.equal(g.consecutiveNoopLaps(laps(g, [['h1', 0, 0], ['h2', 0, 0]]), 'h2'), 1);
    });

    test('null head fails closed to zero', function() {
        var g = loadGuard();
        assert.equal(g.consecutiveNoopLaps(laps(g, [['h1', 0, 0]]), null), 0);
    });
});

suite('reworkLoopGuard.shouldWithholdArm', function() {

    function marker(g, head, pushed, resolved, at) {
        return g.parseLapMarkers([machineComment(g.buildLapMarker(head, pushed, resolved, null, at))])[0];
    }

    test('below the cap the arm proceeds', function() {
        var g = loadGuard();
        var d = g.shouldWithholdArm({
            markers: [marker(g, 'h1', 0, 0, '2026-10-17T10:00:00Z')],
            headSha: 'h1',
            maxNoopLaps: 2
        });
        assert.equal(d.withhold, false);
        assert.equal(d.laps, 1);
        assert.equal(d.escalate, false);
    });

    test('at the cap the arm is withheld and the escalation fires once', function() {
        var g = loadGuard();
        var d = g.shouldWithholdArm({
            markers: [
                marker(g, 'h1', 0, 0, '2026-10-17T10:00:00Z'),
                marker(g, 'h1', 0, 0, '2026-10-17T11:00:00Z')
            ],
            headSha: 'h1',
            maxNoopLaps: 2
        });
        assert.equal(d.withhold, true);
        assert.equal(d.laps, 2);
        assert.equal(d.escalate, true, 'no escalation on record — post it now');
    });

    test('an existing escalation marker for the head suppresses re-posting', function() {
        var g = loadGuard();
        var esc = g.parseEscalationMarkers([machineComment(
            g.buildEscalationComment('h1', 2, 2, '2026-10-17T11:30:00Z'))]);
        assert.equal(g.hasEscalationForHead(esc, 'h1'), true);
        assert.equal(g.hasEscalationForHead(esc, 'h2'), false);
        var d = g.shouldWithholdArm({
            markers: [
                marker(g, 'h1', 0, 0, '2026-10-17T10:00:00Z'),
                marker(g, 'h1', 0, 0, '2026-10-17T11:00:00Z')
            ],
            escalationMarkers: esc,
            headSha: 'h1',
            maxNoopLaps: 2
        });
        assert.equal(d.withhold, true, 'still withheld');
        assert.equal(d.escalate, false, 'but the owner was already escalated for this head');
    });

    test('a new head starts with a fresh budget even on a hot PR', function() {
        var g = loadGuard();
        var d = g.shouldWithholdArm({
            markers: [
                marker(g, 'h1', 0, 0, '2026-10-17T10:00:00Z'),
                marker(g, 'h1', 0, 0, '2026-10-17T11:00:00Z')
            ],
            headSha: 'h2',
            maxNoopLaps: 2
        });
        assert.equal(d.withhold, false, 'a human push (new head) re-arms the budget');
    });

    test('default cap is DEFAULT_NOOP_LAP_MAX', function() {
        var g = loadGuard();
        var markers = [];
        for (var i = 0; i < g.DEFAULT_NOOP_LAP_MAX; i++) {
            markers.push(marker(g, 'h1', 0, 0, '2026-10-17T1' + i + ':00:00Z'));
        }
        var d = g.shouldWithholdArm({ markers: markers, headSha: 'h1' });
        assert.equal(d.withhold, true);
        assert.equal(d.maxLaps, g.DEFAULT_NOOP_LAP_MAX);
    });
});

suite('reworkLoopGuard.escalationIsFalsePositive (gh-990)', function() {

    // gh-990 (2nd live instance, dart #424 ~16:37Z / #419 ~17:2xZ,
    // 2026-10-17): the no-op loop guard fired rework-loop-escalated on legs
    // that no-op'd CORRECTLY — the operator had already pushed the fix and
    // the GraphQL census read 0 unresolved threads — and the escalated label
    // then jammed the whole queue's validate-armed pointer. The refinement:
    // when the census is EMPTY and the head carries NO red validation, the
    // escalation is a false positive — validation re-flow owns the PR, not a
    // human park. Suppression requires POSITIVE evidence of both sides.

    test('0 unresolved threads + no red validation → suppression (the false-positive shape)', function() {
        var g = loadGuard();
        assert.equal(g.escalationIsFalsePositive({ unresolvedThreads: 0, headRed: false }), true);
    });

    test('open threads (1 or many) keep the legacy escalation', function() {
        var g = loadGuard();
        assert.equal(g.escalationIsFalsePositive({ unresolvedThreads: 1, headRed: false }), false);
        assert.equal(g.escalationIsFalsePositive({ unresolvedThreads: 22, headRed: false }), false,
            'multi-thread census — the #419 live shape (18/22 threads open)');
    });

    test('a red head keeps the legacy escalation', function() {
        var g = loadGuard();
        assert.equal(g.escalationIsFalsePositive({ unresolvedThreads: 0, headRed: true }), false);
    });

    test('unknown census (-1) keeps the legacy escalation — no positive empty evidence', function() {
        var g = loadGuard();
        assert.equal(g.escalationIsFalsePositive({ unresolvedThreads: -1, headRed: false }), false);
    });

    test('unknown red probe (null) keeps the legacy escalation — no positive no-red evidence', function() {
        var g = loadGuard();
        assert.equal(g.escalationIsFalsePositive({ unresolvedThreads: 0, headRed: null }), false);
    });

    test('missing state fails closed to the legacy escalation', function() {
        var g = loadGuard();
        assert.equal(g.escalationIsFalsePositive(null), false);
        assert.equal(g.escalationIsFalsePositive({}), false);
    });
});

suite('reworkLoopGuard.buildEscalationComment', function() {

    test('carries the hidden marker, the label and the lap budget', function() {
        var g = loadGuard();
        var body = g.buildEscalationComment('abc123def456', 2, 2, '2026-10-17T12:00:00Z');
        assert.contains(body, g.ESCALATION_MARKER_PREFIX, 'the dedup marker rides the comment');
        assert.contains(body, g.ESCALATION_LABEL, 'the escalation label is named');
        assert.contains(body, '2/2');
        assert.contains(body, 'abc123def456');
        assert.contains(body, 'ZERO pushed commits');
        var parsed = g.parseEscalationMarkers([machineComment(body)]);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].head, 'abc123def456');
        assert.equal(parsed[0].laps, 2);
    });
});


suite('reworkLoopGuard: [bot]-suffixed machine authors are trusted (gh-1025)', function () {
    function botComment(body, login) {
        return { body: body, user: { login: login }, created_at: '2026-10-18T07:00:00Z' };
    }

    test('lap markers authored by dmtools-factory-bot[bot] parse under the bare knob entry', function () {
        var g = loadGuard();
        var lap = g.buildLapMarker('abc123def456', 1, 2, null, '2026-10-18T07:00:00Z');
        var allow = { authorLogins: ['dmtools-factory-bot'] };
        assert.equal(g.parseLapMarkers([botComment(lap, 'dmtools-factory-bot[bot]')], allow).length, 1,
            'App-authored lap markers feed the gh-957 budget');
        assert.equal(g.parseLapMarkers([botComment(lap, 'dependabot[bot]')], allow).length, 0,
            'a different bot stays invisible');
    });
});
