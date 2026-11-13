/**
 * Unit tests for js/sm/redVerdict.js — the fail_validation red-verdict path
 * extracted from smAgent.js processRule (dmtools-agents#1459) + the fa #2148
 * flake rerun (green→red on the same head sha → one `gh run rerun --failed`).
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

var assert = globalThis.assert;

var rv = loadModule('js/sm/redVerdict.js', makeRequire({
    '../common/redConvergence.js': loadModule('js/common/redConvergence.js', makeRequire({}), {}),
    '../common/prTerminalState.js': loadModule('js/common/prTerminalState.js', makeRequire({}), {})
}), {});

var HEAD = '22b1977d22b1977d22b1977d22b1977d22b1977d';

function run(id, conclusion, at, extra) {
    var r = { id: id, event: 'workflow_dispatch', head_sha: HEAD, status: 'completed',
              conclusion: conclusion, html_url: 'https://x/runs/' + id,
              created_at: at, updated_at: at };
    if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
    return r;
}

var GREEN = run(43396332450, 'success', '2026-11-01T09:09:00Z');
var RED = run(43399381538, 'failure', '2026-11-01T09:32:00Z');

function harness(o) {
    o = o || {};
    var h = { comments: [], adds: [], removes: [], reruns: [], stamps: [], logs: [], latchArms: 0 };
    h.deps = {
        dry: !!o.dry, jobParams: o.jobParams || {},
        log: function (m) { h.logs.push(m); },
        warn: function (m) { h.logs.push(m); },
        realRed: function () { return o.realFailure !== false; },
        isMachinePr: function () { return o.machine !== false; },
        dispatchedRuns: function () { return o.runs === undefined ? [RED, GREEN] : o.runs; },
        commentBodies: function () { return o.bodies || []; },
        rerunFailed: function (id) {
            if (o.rerunThrows) throw new Error('HTTP 403');
            h.reruns.push(id);
        },
        stampInProgress: function (head) { h.stamps.push(head); },
        postComment: function (n, b) {
            if (o.postThrows && b.indexOf('needs a human') !== -1) throw new Error('boom');
            h.comments.push({ n: n, body: b });
        },
        addLabel: function (n, l) {
            if (o.addThrows) throw new Error('label 500');
            h.adds.push(n + ':' + l);
        },
        removeLabel: function (n, l) {
            if (o.removeThrows) throw new Error('absent');
            h.removes.push(n + ':' + l);
        },
        getPr: function () {
            if (o.getPrThrows) throw new Error('pr 502');
            return o.pr || { body: 'Fixes #503', state: 'open' };
        },
        readFailMarks: function () { return o.marks || { redHeads: {}, emptyLaps: {} }; },
        reworkLatched: function () { return !!o.latched; },
        latchRework: function () { h.latchArms++; },
        failingJobs: function () { return o.failing || []; },
        redLine: function (prior, head) {
            return head ? '\uD83D\uDD34 red head ' + head + ' \u2014 red ' + (prior + 1) + '/3' : null;
        }
    };
    return h;
}

var CTX = { key: 'pr-2148', owner: 'IstiN', prNumber: 2148, head: HEAD, branch: 'ai/gh-2140' };

function ctx(extra) {
    var c = {};
    Object.keys(CTX).forEach(function (k) { c[k] = CTX[k]; });
    if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
    return c;
}

suite('redVerdict: flakeCandidate', function () {
    test('green then red on the same sha → candidate (fa #2148 replay)', function () {
        var c = rv.flakeCandidate([GREEN, RED], HEAD);
        assert.equal(c.red.id, RED.id);
        assert.equal(c.green.id, GREEN.id);
    });
    test('no prior green → null', function () {
        assert.equal(rv.flakeCandidate([RED], HEAD), null);
    });
    test('newest verdict green → null; cancelled ignored', function () {
        var later = run(9, 'success', '2026-11-01T10:00:00Z');
        var canc = run(10, 'cancelled', '2026-11-01T11:00:00Z');
        assert.equal(rv.flakeCandidate([RED, GREEN, later, canc], HEAD), null);
    });
    test('red already re-run (run_attempt > 1) → null', function () {
        var red2 = run(RED.id, 'failure', RED.updated_at, { run_attempt: 2 });
        assert.equal(rv.flakeCandidate([red2, GREEN], HEAD), null);
    });
    test('other-sha green never counts; bad inputs → null', function () {
        var otherGreen = run(5, 'success', '2026-11-01T08:00:00Z', { head_sha: 'abc1234' });
        assert.equal(rv.flakeCandidate([RED, otherGreen], HEAD), null);
        assert.equal(rv.flakeCandidate(null, HEAD), null);
        assert.equal(rv.flakeCandidate([RED], null), null);
        assert.equal(rv.flakeCandidate([null, { event: 'push' }], HEAD), null);
    });
    test('timed_out counts as red', function () {
        var to = run(11, 'timed_out', '2026-11-01T09:40:00Z');
        assert.equal(rv.flakeCandidate([GREEN, to], HEAD).red.id, 11);
    });
});

suite('redVerdict: flake marker', function () {
    test('marker line round-trips through flakeMarkedHeads', function () {
        var line = rv.flakeMarkerLine(HEAD, 1, 2);
        assert.ok(rv.flakeMarkedHeads(['x', line, null])[HEAD]);
        assert.deepEqual(rv.flakeMarkedHeads(null), {});
    });
});

suite('redVerdict: handle', function () {
    test('green→red same sha on a machine PR → one rerun --failed, marker, NO rework / unarm / red count', function () {
        var h = harness();
        assert.equal(rv.handle(ctx(), h.deps), 'rerun');
        assert.deepEqual(h.reruns, [RED.id]);
        assert.deepEqual(h.stamps, [HEAD], 'validation checks re-stamped in_progress');
        assert.equal(h.comments.length, 1);
        assert.ok(h.comments[0].body.indexOf('\uD83C\uDFB2 flake rerun head ' + HEAD) === 0);
        assert.ok(h.comments[0].body.indexOf('red head') === -1, 'no red-count marker');
        assert.deepEqual(h.adds, [], 'no agent:rework');
        assert.deepEqual(h.removes, [], 'ai_validating stays armed for the rerun verdict');
    });

    test('cap 1 per sha: marker already on the PR → second red takes the rework path', function () {
        var h = harness({ bodies: [rv.flakeMarkerLine(HEAD, 1, 2)] });
        assert.equal(rv.handle(ctx(), h.deps), 'failed');
        assert.deepEqual(h.reruns, []);
        assert.deepEqual(h.removes, ['2148:ai_validating']);
        assert.deepEqual(h.adds, ['503:agent:rework']);
        assert.equal(h.latchArms, 1);
        assert.ok(h.comments[0].body.indexOf('\uD83D\uDD34 red head ' + HEAD + ' \u2014 red 1/3') !== -1);
    });

    test('no prior green → rework as before', function () {
        var h = harness({ runs: [RED] });
        assert.equal(rv.handle(ctx(), h.deps), 'failed');
        assert.deepEqual(h.reruns, []);
        assert.deepEqual(h.adds, ['503:agent:rework']);
    });

    test('rerun API failure → falls back to rework', function () {
        var h = harness({ rerunThrows: true });
        assert.equal(rv.handle(ctx(), h.deps), 'failed');
        assert.deepEqual(h.adds, ['503:agent:rework']);
        assert.ok(h.logs.some(function (l) { return l.indexOf('falling back to the rework path') !== -1; }));
    });

    test('dry run → rerun only logged', function () {
        var h = harness({ dry: true });
        assert.equal(rv.handle(ctx(), h.deps), 'rerun');
        assert.deepEqual(h.reruns, []);
        assert.equal(h.comments.length, 0);
    });

    test('guest PR: green→red never reruns — park only (gh-757 unchanged)', function () {
        var h = harness({ machine: false });
        assert.equal(rv.handle(ctx(), h.deps), 'failed');
        assert.deepEqual(h.reruns, []);
        assert.deepEqual(h.adds, ['2148:validation_failed']);
        assert.ok(h.comments[0].body.indexOf('Guest PR') !== -1);
        assert.ok(h.comments[0].body.indexOf('parked-head: ' + HEAD) !== -1);
    });

    test('guest park label failure is tolerated', function () {
        var h = harness({ machine: false, addThrows: true, removeThrows: true });
        assert.equal(rv.handle(ctx(), h.deps), 'failed');
        assert.ok(h.logs.some(function (l) { return l.indexOf('guest park label failed') !== -1; }));
    });

    test('cancelled-only red → skip', function () {
        var h = harness({ realFailure: false });
        assert.equal(rv.handle(ctx(), h.deps), 'skip');
        assert.equal(h.comments.length + h.adds.length + h.removes.length, 0);
    });

    test('unlinked machine PR → PR-anchored arm; branch fallback links', function () {
        var h = harness({ runs: [RED], pr: { body: 'no keyword' } });
        rv.handle(ctx({ branch: 'feature/x' }), h.deps);
        assert.deepEqual(h.adds, ['2148:agent:rework']);
        var h2 = harness({ runs: [RED], pr: { body: 'no keyword' } });
        rv.handle(ctx(), h2.deps);
        assert.deepEqual(h2.adds, ['2140:agent:rework']);
    });

    test('unlinked arm failure is tolerated (no latch arm)', function () {
        var h = harness({ runs: [RED], getPrThrows: true, addThrows: true });
        assert.equal(rv.handle(ctx({ branch: null }), h.deps), 'failed');
        assert.equal(h.latchArms, 0);
    });

    test('latched → arm suppressed (both carriers)', function () {
        var h = harness({ runs: [RED], latched: true });
        rv.handle(ctx(), h.deps);
        assert.deepEqual(h.adds, []);
        var h2 = harness({ runs: [RED], latched: true, pr: { body: '' } });
        rv.handle(ctx({ branch: null }), h2.deps);
        assert.deepEqual(h2.adds, []);
    });

    test('terminal PR → no arm, truthful report', function () {
        var h = harness({ runs: [RED], pr: { body: 'Fixes #503', state: 'closed', merged: true } });
        rv.handle(ctx(), h.deps);
        assert.deepEqual(h.adds, []);
        assert.ok(h.comments[0].body.indexOf('MERGED/CLOSED') !== -1);
    });

    test('empty-lap cap → withheld + escalation (post failure tolerated)', function () {
        var marks = { redHeads: {}, emptyLaps: {} };
        marks.redHeads[HEAD] = 2; marks.emptyLaps[HEAD] = 1;
        var h = harness({ runs: [RED], marks: marks });
        rv.handle(ctx(), h.deps);
        assert.deepEqual(h.adds, []);
        assert.ok(h.comments[0].body.indexOf('WITHHELD') !== -1);
        assert.ok(h.comments[1].body.indexOf('needs a human') !== -1);
        var h2 = harness({ runs: [RED], marks: marks, postThrows: true });
        rv.handle(ctx(), h2.deps);
        assert.ok(h2.logs.some(function (l) { return l.indexOf('escalation post failed') !== -1; }));
    });

    test('empty lap below cap → lap line with LAST CHANCE', function () {
        var marks = { redHeads: {}, emptyLaps: {} };
        marks.redHeads[HEAD] = 1;
        var h = harness({ runs: [RED], marks: marks });
        rv.handle(ctx(), h.deps);
        assert.ok(h.comments[0].body.indexOf('empty rework lap 1/1') !== -1);
        assert.ok(h.comments[0].body.indexOf('LAST CHANCE') !== -1);
        var h2 = harness({ runs: [RED], marks: marks });
        h2.deps.jobParams = { emptyLapMax: '3' };
        rv.handle(ctx(), h2.deps);
        assert.ok(h2.comments[0].body.indexOf('LAST CHANCE') === -1);
    });

    test('convergence park: 2 consecutive reds → validation_failed + failing jobs', function () {
        var red2 = run(7, 'failure', '2026-11-01T10:00:00Z');
        var h = harness({ runs: [red2, RED], failing: ['golden'] });
        rv.handle(ctx(), h.deps);
        assert.ok(h.adds.indexOf('2148:validation_failed') !== -1);
        assert.ok(h.comments[0].body.indexOf('CONVERGENCE PARK') !== -1);
        assert.ok(h.comments[0].body.indexOf('Failing job(s): golden') !== -1);
        var h2 = harness({ runs: [red2, RED], addThrows: true, pr: { body: '' } });
        rv.handle(ctx({ branch: null }), h2.deps);
        assert.ok(h2.logs.some(function (l) { return l.indexOf('rollup unavailable') !== -1; }));
    });

    test('no head sha → no rerun, report without head lines', function () {
        var h = harness();
        rv.handle(ctx({ head: null }), h.deps);
        assert.deepEqual(h.reruns, []);
        assert.ok(h.comments[0].body.indexOf('parked-head') === -1);
    });
});

suite('redVerdict: moved helpers', function () {
    test('emptyLapMaxOf: default 1, numeric/string override, junk → 1', function () {
        assert.equal(rv.emptyLapMaxOf(null), 1);
        assert.equal(rv.emptyLapMaxOf({ emptyLapMax: 2 }), 2);
        assert.equal(rv.emptyLapMaxOf({ emptyLapMax: '4' }), 4);
        assert.equal(rv.emptyLapMaxOf({ emptyLapMax: 0 }), 1);
        assert.equal(rv.emptyLapMaxOf({ emptyLapMax: 'x' }), 1);
    });
    test('failedRunLinksFromList: red runs of the head only, newest first, max 3', function () {
        var runs = [GREEN, RED, run(1, 'timed_out', '2026-11-01T10:00:00Z'),
            run(2, 'failure', '2026-11-01T11:00:00Z'), run(3, 'failure', '2026-11-01T12:00:00Z'),
            run(4, 'failure', '2026-11-01T13:00:00Z', { head_sha: 'other' }),
            run(5, 'failure', '2026-11-01T14:00:00Z', { html_url: '' }), null];
        assert.equal(rv.failedRunLinksFromList(runs, HEAD),
            'Failed runs: https://x/runs/3, https://x/runs/2', 'url-less newest run occupies a slot (legacy slice-then-filter)');
        assert.equal(rv.failedRunLinksFromList([RED], HEAD), 'Failed run: https://x/runs/' + RED.id);
        assert.equal(rv.failedRunLinksFromList([GREEN], HEAD), '');
        assert.equal(rv.failedRunLinksFromList(null, HEAD), '');
        assert.equal(rv.failedRunLinksFromList([RED], null), '');
    });
});
