/**
 * Unit tests: ci.js — required check-run mirroring for dispatch-only runs.
 *
 * Covered: happy path (create + update with the real conclusion),
 * skipped job never stamped, not-completed job never stamped, missing
 * job reported, duplicate job names resolve to the last attempt,
 * commit-status fallback mapping, empty runId rejected, empty
 * requiredChecks is a no-op, jobName override.
 */
/* global loadModule, assert, test, suite */

suite('ci stampRequiredChecks', function () {

    var RUN_JOBS = {
        total_count: 4,
        jobs: [
            { id: 11, name: 'gate', status: 'completed', conclusion: 'success', html_url: 'https://ci/run/1/job/11' },
            { id: 12, name: 'agents-suite', status: 'completed', conclusion: 'failure', html_url: 'https://ci/run/1/job/12' },
            { id: 13, name: 'docs', status: 'completed', conclusion: 'skipped', html_url: 'https://ci/run/1/job/13' },
            { id: 14, name: 'lint', status: 'in_progress', conclusion: null, html_url: 'https://ci/run/1/job/14' }
        ]
    };

    function loadCi(mocks) {
        return loadModule('js/common/ci.js', makeRequire({}, mocks || {}), mocks || {});
    }

    function baseOpts(overrides) {
        var opts = {
            workspace: 'epam',
            repository: 'dmtools-dart',
            headSha: 'abc123',
            runId: 36001952519,
            requiredChecks: [{ name: 'gate' }]
        };
        if (overrides) {
            for (var k in overrides) opts[k] = overrides[k];
        }
        return opts;
    }

    test('happy path stamps the real conclusion via create + update', function () {
        var calls = [];
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return JSON.stringify(RUN_JOBS); },
            github_create_check_run: function (args) {
                calls.push({ step: 'create', args: args });
                return JSON.stringify({ id: 9001 });
            },
            github_update_check_run: function (args) {
                calls.push({ step: 'update', args: args });
                return '{}';
            }
        });

        var summary = ci.stampRequiredChecks(baseOpts({
            requiredChecks: [{ name: 'gate' }, { name: 'agents-suite' }]
        }));

        assert.equal(calls.length, 4);
        assert.equal(calls[0].step, 'create');
        assert.equal(calls[0].args.name, 'gate');
        assert.equal(calls[0].args.headSha, 'abc123');
        assert.equal(calls[1].step, 'update');
        assert.equal(calls[1].args.checkRunId, 9001);
        assert.equal(calls[1].args.conclusion, 'success');
        assert.equal(calls[3].args.conclusion, 'failure');
        assert.equal(summary.stamped.length, 2);
        assert.equal(summary.stamped[0].name, 'gate');
        assert.equal(summary.stamped[0].conclusion, 'success');
        assert.equal(summary.stamped[1].conclusion, 'failure');
        assert.deepEqual(summary.skipped, []);
        assert.deepEqual(summary.missing, []);
    });

    test('update summary links back to the source run job', function () {
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return JSON.stringify(RUN_JOBS); },
            github_create_check_run: function () { return JSON.stringify({ id: 1 }); },
            github_update_check_run: function (args) {
                assert.ok(args.summary.indexOf('workflow run 36001952519') !== -1);
                assert.ok(args.summary.indexOf('job/11') !== -1);
                return '{}';
            }
        });
        ci.stampRequiredChecks(baseOpts());
    });

    test('skipped job is never stamped', function () {
        var created = 0;
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return JSON.stringify(RUN_JOBS); },
            github_create_check_run: function () { created += 1; return JSON.stringify({ id: 1 }); },
            github_update_check_run: function () { return '{}'; }
        });

        var summary = ci.stampRequiredChecks(baseOpts({ requiredChecks: [{ name: 'docs' }] }));

        assert.equal(created, 0);
        assert.deepEqual(summary.stamped, []);
        assert.equal(summary.skipped.length, 1);
        assert.equal(summary.skipped[0].name, 'docs');
        assert.equal(summary.skipped[0].reason, 'skipped');
    });

    test('not-completed job is never stamped', function () {
        var created = 0;
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return JSON.stringify(RUN_JOBS); },
            github_create_check_run: function () { created += 1; return JSON.stringify({ id: 1 }); },
            github_update_check_run: function () { return '{}'; }
        });

        var summary = ci.stampRequiredChecks(baseOpts({ requiredChecks: [{ name: 'lint' }] }));

        assert.equal(created, 0);
        assert.equal(summary.skipped[0].reason, 'not-completed');
    });

    test('missing job is reported and not stamped', function () {
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return JSON.stringify(RUN_JOBS); },
            github_create_check_run: function () { throw new Error('must not be called'); }
        });

        var summary = ci.stampRequiredChecks(baseOpts({ requiredChecks: [{ name: 'ghost' }] }));

        assert.equal(summary.missing.length, 1);
        assert.equal(summary.missing[0].name, 'ghost');
        assert.deepEqual(summary.stamped, []);
    });

    test('duplicate job names resolve to the last attempt', function () {
        var jobs = {
            jobs: [
                { id: 21, name: 'gate', status: 'completed', conclusion: 'failure', html_url: 'u1' },
                { id: 22, name: 'gate', status: 'completed', conclusion: 'success', html_url: 'u2' }
            ]
        };
        var seen = [];
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return JSON.stringify(jobs); },
            github_create_check_run: function () { return JSON.stringify({ id: 5 }); },
            github_update_check_run: function (args) {
                seen.push(args.conclusion);
                return '{}';
            }
        });

        var summary = ci.stampRequiredChecks(baseOpts());

        assert.deepEqual(seen, ['success']);
        assert.equal(summary.stamped[0].checkRunId, 5);
    });

    test('jobName override matches a differently-named job', function () {
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return JSON.stringify(RUN_JOBS); },
            github_create_check_run: function (args) {
                assert.equal(args.name, 'quality');
                return JSON.stringify({ id: 7 });
            },
            github_update_check_run: function () { return '{}'; }
        });

        var summary = ci.stampRequiredChecks(baseOpts({
            requiredChecks: [{ name: 'quality', jobName: 'gate' }]
        }));

        assert.equal(summary.stamped.length, 1);
        assert.equal(summary.stamped[0].name, 'quality');
    });

    test('commit-status fallback maps conclusions to github states', function () {
        var statuses = [];
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return JSON.stringify(RUN_JOBS); },
            github_create_check_run: function () { return JSON.stringify({ id: 1 }); },
            github_update_check_run: function () { return '{}'; },
            github_create_commit_status: function (args) { statuses.push(args); return '{}'; }
        });

        var summary = ci.stampRequiredChecks(baseOpts({
            requiredChecks: [{ name: 'gate' }, { name: 'agents-suite' }, { name: 'docs' }],
            commitStatusFallback: true
        }));

        assert.equal(statuses.length, 2);
        assert.equal(statuses[0].state, 'success');
        assert.equal(statuses[0].context, 'gate');
        assert.equal(statuses[0].sha, 'abc123');
        assert.equal(statuses[1].state, 'failure');
        assert.equal(statuses[1].targetUrl, 'https://ci/run/1/job/12');
        assert.equal(summary.stamped[0].commitStatus, 'success');
    });

    test('empty runId is rejected', function () {
        var ci = loadCi({});
        assert.throws(function () {
            ci.stampRequiredChecks(baseOpts({ runId: '' }));
        }, 'runId');
        assert.throws(function () {
            ci.stampRequiredChecks(baseOpts({ runId: null }));
        }, 'runId');
    });

    test('missing headSha is rejected', function () {
        var ci = loadCi({});
        assert.throws(function () {
            ci.stampRequiredChecks(baseOpts({ headSha: undefined }));
        }, 'headSha');
    });

    test('empty requiredChecks is a validated no-op', function () {
        var calls = 0;
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { calls += 1; return '{}'; }
        });

        var summary = ci.stampRequiredChecks(baseOpts({ requiredChecks: [] }));

        assert.equal(calls, 0);
        assert.deepEqual(summary, { stamped: [], skipped: [], missing: [] });
    });

    test('string job response (non-JSON tool return) is tolerated', function () {
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { return RUN_JOBS; },
            github_create_check_run: function () { return { id: 3 }; },
            github_update_check_run: function () { return {}; }
        });

        var summary = ci.stampRequiredChecks(baseOpts());
        assert.equal(summary.stamped.length, 1);
    });
});
