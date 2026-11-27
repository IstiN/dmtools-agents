/**
 * Unit tests for js/sm/ciDispatchPriority.js — approved-first CI dispatch,
 * one run per head, in-flight dedupe, dead-branch cancel (fa #2435).
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */
var assert = globalThis.assert;
var cp = loadModule('js/sm/ciDispatchPriority.js', makeRequire({
    '../common/triggerFailures.js': loadModule('js/common/triggerFailures.js', makeRequire({}), {})
}), {});
var REPO = { owner: 'o', repo: 'r' };

function run(id, branch, sha, status, extra) {
    var r = { id: id, event: 'workflow_dispatch', head_branch: branch, head_sha: sha, status: status,
              created_at: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString() };
    Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
    return r;
}
function pr(n, branch, labels) {
    return { number: n, head: { ref: branch }, labels: (labels || []).map(function (l) { return { name: l }; }) };
}
function harness(o) {
    cp.resetTick();
    var h = { cancels: [], logs: [], strips: [], lists: 0 };
    h.deps = {
        dry: !!o.dry, jobParams: { ciWorkflow: 'ci.yml' },
        log: function (m) { h.logs.push(m); }, warn: function (m) { h.logs.push(m); },
        listOpenPrs: function () { return JSON.stringify(o.prs || []); },
        githubTracker: function () { return { removeLabel: function (n, l) { h.strips.push(n + ':' + l); } }; },
        exec: function (c) { h.cancels.push(Number(/runs\/(\d+)\/cancel/.exec(c.command)[1])); return ''; },
        listWorkflowRuns: function () {
            h.lists++;
            if (o.listThrows) throw new Error('boom');
            return JSON.stringify({ workflow_runs: o.runs || [] });
        }
    };
    return h;
}
var FRESH = { localAction: 'validate_pr', source: 'github', deferWhileApprovedPending: true, oneRunPerHead: true };
var ARMED = { localAction: 'validate_pr', source: 'github' };

suite('ciDispatchPriority: pure helpers', function () {
    test('dedupeSameHead keeps only the newest per branch+sha', function () {
        var d = cp.dedupeSameHead([run(1, 'a', 's', 'queued'), run(3, 'a', 's', 'queued'), run(2, 'a', 's', 'in_progress'), run(4, 'b', 's', 'queued')]);
        assert.deepEqual(d.map(function (r) { return r.id; }).sort(), [1, 2]);
    });
    test('fail-open on unreadable listings / object payloads parse', function () {
        var h = harness({}); h.deps.listWorkflowRuns = function () { return { output: 'not json' }; };
        assert.equal(cp.gateRule(h.deps, FRESH, REPO), false);
        h = harness({}); h.deps.listWorkflowRuns = function () { return { workflow_runs: [] }; };
        h.deps.listOpenPrs = function () { return { data: [] }; };
        assert.equal(cp.gateRule(h.deps, FRESH, REPO), false);
        h = harness({}); h.deps.listWorkflowRuns = function () { return null; };
        assert.equal(cp.gateRule(h.deps, FRESH, REPO), false);
    });
    test('shouldDeferFresh honors the rule knob only', function () {
        assert.equal(cp.shouldDeferFresh(FRESH, { approvedPending: true }), true);
        assert.equal(cp.shouldDeferFresh(FRESH, { approvedPending: false }), false);
        assert.equal(cp.shouldDeferFresh(ARMED, { approvedPending: true }), false);
    });
});

suite('ciDispatchPriority: runs memo', function () {
    test('inFlightCiRuns lists once per tick; dropRunsMemo forces a re-list (stale-cancel invalidation)', function () {
        var h = harness({ runs: [run(1, 'b', 's1', 'queued')] });
        cp.inFlightCiRuns(h.deps, REPO, 'ci.yml');
        cp.inFlightCiRuns(h.deps, REPO, 'ci.yml');
        assert.equal(h.lists, 1, 'memoized within the tick');
        cp.dropRunsMemo(REPO);
        cp.inFlightCiRuns(h.deps, REPO, 'ci.yml');
        assert.equal(h.lists, 2, 'dropped memo re-lists');
    });
});

suite('ciDispatchPriority: preDispatchSkip', function () {
    test('in-flight run on same branch+sha skips dispatch and marks handled', function () {
        var h = harness({ runs: [run(1, 'feat', 'abcdef123', 'queued')] });
        var keys = [];
        assert.equal(cp.preDispatchSkip(h.deps, ARMED, REPO, { branch: 'feat' }, 'pr-1', null, 'abcdef123', keys), true);
        assert.deepEqual(keys, ['pr-1']);
        assert.ok(h.logs.some(function (l) { return l.indexOf('in-flight CI already covers abcdef1') !== -1; }));
    });
    test('different sha does not skip', function () {
        var h = harness({ runs: [run(1, 'feat', 'old', 'queued')] });
        assert.equal(cp.preDispatchSkip(h.deps, ARMED, REPO, { branch: 'feat' }, 'pr-1', null, 'new', []), false);
    });
    test('oneRunPerHead: concluded verdict skips; cancelled-only (verdict null) re-dispatches', function () {
        var h = harness({});
        assert.equal(cp.preDispatchSkip(h.deps, FRESH, REPO, { branch: 'f' }, 'k', { verdict: 'failure' }, 's', []), true);
        assert.equal(cp.preDispatchSkip(h.deps, FRESH, REPO, { branch: 'f' }, 'k', { verdict: null }, 's', []), false);
    });
    test('probe failure fails open', function () {
        var h = harness({ listThrows: true });
        assert.equal(cp.preDispatchSkip(h.deps, ARMED, REPO, { branch: 'f' }, 'k', null, 's', []), false);
        assert.ok(h.logs.some(function (l) { return l.indexOf('⚠️') !== -1; }));
    });
});

suite('ciDispatchPriority: tick sweep / gateRule', function () {
    var prs = [pr(1, 'approved', ['pr_approved', 'ai_validating']), pr(2, 'fresh', ['ai_validating']), pr(3, 'started', ['ai_validating'])];
    var runs = [run(10, 'approved', 'a1', 'queued'), run(11, 'fresh', 'f1', 'queued'), run(12, 'started', 's1', 'in_progress'),
                run(13, 'v1.2.3', 't1', 'queued', { event: 'push' }), run(14, 'gone', 'g1', 'in_progress'),
                run(15, 'fresh', 'f1', 'queued'), run(16, 'main', 'm1', 'queued')];
    test('approved pending: queued unapproved cancelled + unarmed; started, tag push, main untouched; dead branch + dup cancelled; fresh defers', function () {
        var h = harness({ prs: prs, runs: runs });
        assert.equal(cp.gateRule(h.deps, FRESH, REPO), true);
        assert.deepEqual(h.cancels.sort(), [11, 14, 15]);
        assert.ok(h.strips.indexOf('2:ai_validating') !== -1 && h.strips.indexOf('1:ai_validating') === -1);
        assert.equal(cp.gateRule(h.deps, ARMED, REPO), false, 'armed lane never defers');
        assert.equal(h.lists, 1, 'one listing per repo per tick');
    });
    test('superseded head: a queued/started run on an old sha of an open PR is cancelled; the head run is kept', function () {
        var p = pr(7, 'moved', ['pr_approved', 'ai_validating']);
        p.head.sha = 'new1';
        var h = harness({ prs: [p], runs: [run(30, 'moved', 'old1', 'queued'), run(31, 'moved', 'new1', 'pending')] });
        cp.gateRule(h.deps, ARMED, REPO);
        assert.deepEqual(h.cancels, [30]);
        assert.deepEqual(cp.supersededHeadRuns([run(32, 'x', 'a', 'queued')], {}), [], 'no PR / no head sha → untouched');
    });
    test('no approved pending: fresh dispatches, unapproved queued runs kept', function () {
        var h = harness({ prs: prs, runs: [run(11, 'fresh', 'f1', 'queued')] });
        assert.equal(cp.gateRule(h.deps, FRESH, REPO), false);
        assert.deepEqual(h.cancels, []);
    });
    test('approved armed this tick defers fresh', function () {
        var h = harness({ prs: prs, runs: [] });
        cp.noteDispatched(REPO, { labels: ['pr_approved'] });
        assert.equal(cp.gateRule(h.deps, FRESH, REPO), true);
    });
    test('dry mode logs cancels, never calls cancel', function () {
        var h = harness({ prs: prs, runs: runs, dry: true });
        cp.gateRule(h.deps, FRESH, REPO);
        assert.deepEqual(h.cancels, []);
        assert.deepEqual(h.strips, []);
        assert.ok(h.logs.some(function (l) { return l.indexOf('[dry] would cancel') !== -1; }));
    });
    test('probe failure fails open (no defer)', function () {
        var h = harness({ listThrows: true });
        assert.equal(cp.gateRule(h.deps, FRESH, REPO), false);
    });
    test('afterMergeOutcome cancels other approved validations and unarms them', function () {
        var h = harness({ prs: [pr(1, 'a', ['pr_approved']), pr(2, 'b', ['pr_approved', 'ai_validating']), pr(3, 'c', [])],
                          runs: [run(20, 'b', 'x', 'in_progress'), run(21, 'c', 'y', 'queued')] });
        assert.equal(cp.afterMergeOutcome(h.deps, REPO, { branch: 'a' }, 'merged'), 'merged');
        assert.deepEqual(h.cancels, [20]);
        assert.deepEqual(h.strips, ['2:ai_validating']);
        h.cancels.length = 0;
        cp.afterMergeOutcome(h.deps, REPO, { branch: 'a' }, 'latched');
        assert.deepEqual(h.cancels, []);
    });
});

suite('ciDispatchPriority: finalizeValidatePrDispatch', function () {
    function fdeps(o) {
        var h = { logs: [], stamps: 0, labels: [], fails: 0 };
        h.deps = { dry: !!o.dry, log: function (m) { h.logs.push(m); }, warn: function (m) { h.logs.push(m); },
            dispatchCiWorkflow: function () { if (o.throws) throw new Error('x'); },
            recordDispatchFailure: function () { h.fails++; },
            stampValidationChecks: function () { h.stamps++; },
            githubTracker: function () { return { addLabel: function (n, l) { h.labels.push(l); } }; } };
        return h;
    }
    test('success arms + stamps + marks processed', function () {
        cp.resetTick();
        var h = fdeps({}); var keys = [];
        cp.finalizeValidatePrDispatch(h.deps, REPO, { branch: 'b', prNumber: 1, labels: [] }, 'k', 'sha', keys);
        assert.deepEqual(keys, ['k']); assert.equal(h.stamps, 1); assert.deepEqual(h.labels, ['ai_validating']);
    });
    test('failure records and does not arm; dry never labels; no head no stamp', function () {
        var h = fdeps({ throws: true }); var keys = [];
        cp.finalizeValidatePrDispatch(h.deps, REPO, { branch: 'b', prNumber: 1 }, 'k', 'sha', keys);
        assert.equal(h.fails, 1); assert.deepEqual(keys, []);
        var d = fdeps({ dry: true });
        cp.finalizeValidatePrDispatch(d.deps, REPO, { branch: 'b', prNumber: 1 }, 'k', null, []);
        assert.equal(d.stamps, 0); assert.deepEqual(d.labels, []);
    });
});
