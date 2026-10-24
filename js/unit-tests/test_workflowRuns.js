/**
 * Unit tests for js/common/workflowRuns.js — the shared workflow-run probe
 * family extracted by gh-1249 (duplication dedup):
 *
 *   - parseWorkflowRuns     — REST run-list envelope unwrap (array |
 *                             workflow_runs | runs | JSON string), the
 *                             smAgent.js copy moved here verbatim
 *   - eachActiveStatusRun   — the four-active-status fan-out the in-flight
 *                             guards used to inline (smAgent ×4, autoStart ×2)
 *   - workflowRunTimestamp  — run → ms (or null), moved verbatim from
 *                             smAgent.js / autoStart.js (identical copies)
 *   - workflowRunAge        — run → '42m' / '2h 5m' human age, same moves
 *   - dispatchedRuns        — the ONE `gh api .../runs?head_sha…` round the
 *                             five dispatched-CI probes used to each fire
 *   - newestRunTime / sortRunsNewestFirst — the shared newest-first ordering
 *   - indexRunsById         — the head-rollup id index the zombie/orphan
 *                             probes both built inline
 *
 * Pure module — cli_execute_command is only touched inside dispatchedRuns()
 * and is injected per-test; everything else is side-effect free apart from
 * the documented console.warn on per-status probe errors.
 */

var assert = globalThis.assert;

var workflowRuns = loadModule('js/common/workflowRuns.js', makeRequire({}), {});

function run(extra) {
    var base = { id: 1, status: 'queued', name: 'run' };
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) base[k] = extra[k]; } }
    return base;
}

// ── parseWorkflowRuns ────────────────────────────────────────────────────────

suite('workflowRuns parseWorkflowRuns', function () {
    test('null / empty / unparseable → []', function () {
        assert.deepEqual(workflowRuns.parseWorkflowRuns(null), []);
        assert.deepEqual(workflowRuns.parseWorkflowRuns(''), []);
        assert.deepEqual(workflowRuns.parseWorkflowRuns('{not json'), []);
        assert.deepEqual(workflowRuns.parseWorkflowRuns({ nope: true }), []);
    });

    test('array passes through; workflow_runs / runs envelopes unwrapped', function () {
        var list = [run()];
        assert.deepEqual(workflowRuns.parseWorkflowRuns(list), list);
        assert.deepEqual(workflowRuns.parseWorkflowRuns({ workflow_runs: list }), list);
        assert.deepEqual(workflowRuns.parseWorkflowRuns({ runs: list }), list);
    });

    test('JSON string bodies parse (both envelope shapes)', function () {
        assert.deepEqual(workflowRuns.parseWorkflowRuns('[{"id":7}]'), [{ id: 7 }]);
        assert.deepEqual(workflowRuns.parseWorkflowRuns('{"workflow_runs":[{"id":8}]}'), [{ id: 8 }]);
    });
});

// gh-1249 rework (crap-ratchet fix): the envelope unwrap is its own exported
// function so parseWorkflowRuns stays under the quality-gate CRAP threshold.
suite('workflowRuns unwrapWorkflowRunsEnvelope', function () {
    test('array passes through by reference; envelopes unwrapped; junk → []', function () {
        var list = [run()];
        assert.deepEqual(workflowRuns.unwrapWorkflowRunsEnvelope(list), list);
        assert.deepEqual(workflowRuns.unwrapWorkflowRunsEnvelope({ workflow_runs: list }), list);
        assert.deepEqual(workflowRuns.unwrapWorkflowRunsEnvelope({ runs: list }), list);
        assert.deepEqual(workflowRuns.unwrapWorkflowRunsEnvelope(null), []);
        assert.deepEqual(workflowRuns.unwrapWorkflowRunsEnvelope('{"workflow_runs":[]}'), []);
        assert.deepEqual(workflowRuns.unwrapWorkflowRunsEnvelope({ workflow_runs: 'nope' }), []);
    });
});

// ── eachActiveStatusRun ──────────────────────────────────────────────────────

suite('workflowRuns eachActiveStatusRun', function () {
    var SCM_STATUSES = ['queued', 'in_progress', 'waiting', 'pending'];

    function recordingScm(opts) {
        var calls = [];
        var scm = {
            calls: calls,
            listWorkflowRuns: function (status, workflowFile, maxRuns, owner, repo) {
                calls.push({ status: status, workflowFile: workflowFile, maxRuns: maxRuns, owner: owner, repo: repo });
                if (opts && opts.throwFor && opts.throwFor.indexOf(status) !== -1) {
                    throw new Error('boom ' + status);
                }
                return (opts && opts.payloads && opts.payloads.hasOwnProperty(status))
                    ? opts.payloads[status] : [];
            }
        };
        return scm;
    }

    test('visits all four active statuses in order with (status, workflowFile, 50)', function () {
        var scm = recordingScm();
        var visited = [];
        var aborted = workflowRuns.eachActiveStatusRun(scm, 'wf.yml', 'warn', [],
            function (status, raw) { visited.push(status); return false; });
        assert.equal(aborted, false);
        assert.deepEqual(visited, SCM_STATUSES);
        assert.deepEqual(scm.calls.map(function (c) { return [c.status, c.workflowFile, c.maxRuns]; }),
            SCM_STATUSES.map(function (s) { return [s, 'wf.yml', 50]; }));
    });

    test('extra args are forwarded after (status, workflowFile, 50)', function () {
        var scm = recordingScm();
        workflowRuns.eachActiveStatusRun(scm, 'wf.yml', 'warn', ['o', 'r'],
            function () { return false; });
        scm.calls.forEach(function (c) {
            assert.equal(c.owner, 'o');
            assert.equal(c.repo, 'r');
        });
    });

    test('per-status probe error logs warnPrefix + status and continues (fail-open)', function () {
        var scm = recordingScm({ throwFor: ['in_progress'] });
        var warns = [];
        var origWarn = console.warn;
        console.warn = function (msg) { warns.push(msg); };
        try {
            var visited = [];
            workflowRuns.eachActiveStatusRun(scm, 'wf.yml', 'could not list', [],
                function (status) { visited.push(status); return false; });
            // the throwing status is logged+skipped, never visited
            assert.deepEqual(visited, ['queued', 'waiting', 'pending']);
            assert.equal(warns.length, 1);
            assert.equal(warns[0], 'could not list (in_progress): boom in_progress');
        } finally {
            console.warn = origWarn;
        }
    });

    test('visitor returning truthy aborts the scan early and returns true', function () {
        var scm = recordingScm();
        var visited = [];
        var aborted = workflowRuns.eachActiveStatusRun(scm, 'wf.yml', 'warn', [],
            function (status) { visited.push(status); return status === 'queued'; });
        assert.equal(aborted, true);
        assert.deepEqual(visited, ['queued']);
        assert.equal(scm.calls.length, 1);
    });

    test('raw payload is passed to the visitor (each caller keeps its own parse flavor)', function () {
        var scm = recordingScm({ payloads: { queued: '{"workflow_runs":[{"id":3}]}' } });
        var raws = [];
        workflowRuns.eachActiveStatusRun(scm, 'wf.yml', 'warn', [],
            function (status, raw) { raws.push(raw); return false; });
        assert.equal(raws[0], '{"workflow_runs":[{"id":3}]}');
    });
});

// ── workflowRunTimestamp / workflowRunAge ────────────────────────────────────

suite('workflowRuns run time helpers', function () {
    test('workflowRunTimestamp: snake/camel fields, invalid → null', function () {
        assert.equal(workflowRuns.workflowRunTimestamp(run({ updated_at: '2026-10-01T00:00:00Z' })),
            Date.parse('2026-10-01T00:00:00Z'));
        assert.equal(workflowRuns.workflowRunTimestamp(run({ updatedAt: '2026-10-01T00:00:00Z' })),
            Date.parse('2026-10-01T00:00:00Z'));
        assert.equal(workflowRuns.workflowRunTimestamp(run({ created_at: '2026-10-01T00:00:00Z' })),
            Date.parse('2026-10-01T00:00:00Z'));
        assert.equal(workflowRuns.workflowRunTimestamp(run({ createdAt: '2026-10-01T00:00:00Z' })),
            Date.parse('2026-10-01T00:00:00Z'));
        assert.equal(workflowRuns.workflowRunTimestamp(null), null);
        assert.equal(workflowRuns.workflowRunTimestamp(run({ updated_at: 'junk' })), null);
        assert.equal(workflowRuns.workflowRunTimestamp(run({})), null);
    });

    test('workflowRunAge: minutes under an hour, hours+minutes above', function () {
        var now = Date.now();
        var age = workflowRuns.workflowRunAge(run({ updated_at: new Date(now - 42 * 60000).toISOString() }));
        assert.equal(age, '42m');
        age = workflowRuns.workflowRunAge(run({ updated_at: new Date(now - (2 * 3600 + 5 * 60) * 1000).toISOString() }));
        assert.equal(age, '2h 5m');
        age = workflowRuns.workflowRunAge(run({ updated_at: new Date(now - 3 * 3600 * 1000).toISOString() }));
        assert.equal(age, '3h');
        assert.equal(workflowRuns.workflowRunAge(run({})), '');
    });
});

// ── dispatchedRuns ───────────────────────────────────────────────────────────

suite('workflowRuns dispatchedRuns', function () {
    var REPO = { owner: 'IstiN', repo: 'dmtools-agents' };

    function loadWithCli(cliMock) {
        return loadModule('js/common/workflowRuns.js', makeRequire({}),
            { cli_execute_command: cliMock });
    }

    test('fires the head_sha workflow_dispatch probe and unwraps workflow_runs', function () {
        var commands = [];
        var mod = loadWithCli(function (args) {
            commands.push(args.command);
            return { output: JSON.stringify({ workflow_runs: [{ id: 9, status: 'completed' }] }) };
        });
        var list = mod.dispatchedRuns(REPO, 'ci.yml', 'abc123');
        assert.equal(list.length, 1);
        assert.equal(list[0].id, 9);
        assert.equal(commands.length, 1);
        assert.equal(commands[0],
            'gh api "repos/IstiN/dmtools-agents/actions/workflows/ci.yml/runs?head_sha=abc123' +
            '&event=workflow_dispatch&per_page=5"');
    });

    test('cli failure propagates — every caller owns its fail-open/fail-closed catch', function () {
        var mod = loadWithCli(function () { throw new Error('gh exploded'); });
        var threw = false;
        try { mod.dispatchedRuns(REPO, 'ci.yml', 'abc123'); } catch (e) { threw = true; }
        assert.equal(threw, true);
    });

    test('stdout envelope and bare-object bodies parse; unparseable → []', function () {
        var mod = loadWithCli(function () { return { stdout: '{"workflow_runs":[{"id":1}]}' }; });
        assert.equal(mod.dispatchedRuns(REPO, 'ci.yml', 's').length, 1);
        mod = loadWithCli(function () { return { workflow_runs: [{ id: 2 }] }; });
        assert.equal(mod.dispatchedRuns(REPO, 'ci.yml', 's')[0].id, 2);
        mod = loadWithCli(function () { return 'not json'; });
        assert.deepEqual(mod.dispatchedRuns(REPO, 'ci.yml', 's'), []);
        mod = loadWithCli(function () { return null; });
        assert.deepEqual(mod.dispatchedRuns(REPO, 'ci.yml', 's'), []);
    });
});

// ── newest-first ordering ────────────────────────────────────────────────────

suite('workflowRuns newest-first ordering', function () {
    test('newestRunTime orders by updated_at falling back to created_at', function () {
        var older = run({ id: 1, updated_at: '2026-10-01T10:00:00Z' });
        var newer = run({ id: 2, updated_at: '2026-10-01T12:00:00Z' });
        assert.equal(workflowRuns.newestRunTime(older, newer) > 0, true);
        assert.equal(workflowRuns.newestRunTime(newer, older) < 0, true);
        var byCreated = run({ id: 3, created_at: '2026-10-01T13:00:00Z' });
        assert.equal(workflowRuns.newestRunTime(newer, byCreated) > 0, true);
    });

    test('sortRunsNewestFirst sorts in place newest-first', function () {
        var a = run({ id: 1, updated_at: '2026-10-01T10:00:00Z' });
        var b = run({ id: 2, updated_at: '2026-10-01T12:00:00Z' });
        var c = run({ id: 3, updated_at: '2026-10-01T11:00:00Z' });
        var sorted = workflowRuns.sortRunsNewestFirst([a, b, c]);
        assert.deepEqual(sorted.map(function (r) { return r.id; }), [2, 3, 1]);
    });
});

// ── indexRunsById ────────────────────────────────────────────────────────────

suite('workflowRuns indexRunsById', function () {
    test('indexes by stringified id; id-less runs skipped; null-safe', function () {
        var a = run({ id: 7 });
        var b = run({ id: '8' });
        var byId = workflowRuns.indexRunsById([a, null, b, {}]);
        assert.equal(byId['7'], a);
        assert.equal(byId['8'], b);
        assert.equal(Object.keys(byId).length, 2);
        assert.deepEqual(workflowRuns.indexRunsById(null), {});
    });
});
