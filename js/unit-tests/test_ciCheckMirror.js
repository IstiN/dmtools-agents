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

// ── gh-1183: validation + extracted pure helpers ──

suite('ci stampRequiredChecks — validation (gh-1183)', function () {

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

    function assertThrowsWith(fn, expectedSubstring, msg) {
        var threw = null;
        try { fn(); } catch (e) { threw = e; }
        if (!threw) {
            throw new Error((msg || 'assertThrowsWith') + ': expected function to throw');
        }
        var actual = threw.message || String(threw);
        if (actual.indexOf(expectedSubstring) === -1) {
            throw new Error((msg || 'assertThrowsWith') + ': expected error containing ' +
                JSON.stringify(expectedSubstring) + ' but got ' + JSON.stringify(actual));
        }
    }

    test('missing workspace is rejected with a specific message', function () {
        var ci = loadCi({});
        assertThrowsWith(function () {
            ci.stampRequiredChecks(baseOpts({ workspace: undefined }));
        }, 'stampRequiredChecks: workspace is required');
    });

    test('missing repository is rejected with a specific message', function () {
        var ci = loadCi({});
        assertThrowsWith(function () {
            ci.stampRequiredChecks(baseOpts({ repository: undefined }));
        }, 'stampRequiredChecks: repository is required');
    });

    test('whitespace-only runId is rejected', function () {
        var ci = loadCi({});
        assertThrowsWith(function () {
            ci.stampRequiredChecks(baseOpts({ runId: '   ' }));
        }, 'stampRequiredChecks: runId is required');
    });

    test('no options at all is rejected as missing workspace', function () {
        var ci = loadCi({});
        assertThrowsWith(function () {
            ci.stampRequiredChecks();
        }, 'workspace is required');
    });

    test('valid options pass validation and flow into the jobs fetch', function () {
        var fetched = null;
        var ci = loadCi({
            github_get_workflow_run_jobs: function (args) {
                fetched = args;
                return JSON.stringify({ jobs: [] });
            }
        });

        var summary = ci.stampRequiredChecks(baseOpts({ requiredChecks: [{ name: 'ghost' }] }));

        assert.deepEqual(fetched, { workspace: 'epam', repository: 'dmtools-dart', runId: 36001952519 });
        assert.deepEqual(summary, { stamped: [], skipped: [], missing: [{ name: 'ghost', jobName: 'ghost' }] });
    });

    test('absent requiredChecks is a validated no-op (no jobs fetch)', function () {
        var calls = 0;
        var ci = loadCi({
            github_get_workflow_run_jobs: function () { calls += 1; return '{}'; }
        });

        var summary = ci.stampRequiredChecks(baseOpts({ requiredChecks: undefined }));

        assert.equal(calls, 0, 'an empty required list must not fetch run jobs');
        assert.deepEqual(summary, { stamped: [], skipped: [], missing: [] });
    });

    test('null required-check entries are recorded as no-name skips', function () {
        var ci = loadCi({
            github_get_workflow_run_jobs: function () {
                return JSON.stringify({ jobs: [{ id: 1, name: 'gate', status: 'completed', conclusion: 'success' }] });
            },
            github_create_check_run: function () { throw new Error('must not create check-runs'); }
        });

        var summary = ci.stampRequiredChecks(baseOpts({ requiredChecks: [null, {}] }));

        assert.equal(summary.skipped.length, 2);
        assert.deepEqual(summary.skipped[0], { name: null, reason: 'no-name' });
        assert.deepEqual(summary.skipped[1], { name: null, reason: 'no-name' });
        assert.deepEqual(summary.stamped, []);
        assert.deepEqual(summary.missing, []);
    });
});

suite('ci stampRequiredChecks — extracted pure helpers (gh-1183)', function () {

    function loadCiHelpers() {
        return loadModule('js/common/ci.js', makeRequire({}, {}), {});
    }

    test('validateStampOptions accepts a valid options object', function () {
        assert.equal(loadCiHelpers().validateStampOptions({
            workspace: 'w', repository: 'r', headSha: 'h', runId: 1
        }), undefined, 'valid options pass silently');
    });

    test('validateStampOptions rejects each missing field with its message', function () {
        var helpers = loadCiHelpers();
        var cases = [
            [{}, 'workspace is required'],
            [{ workspace: 'w' }, 'repository is required'],
            [{ workspace: 'w', repository: 'r' }, 'headSha is required'],
            [{ workspace: 'w', repository: 'r', headSha: 'h' }, 'runId is required'],
            [{ workspace: 'w', repository: 'r', headSha: 'h', runId: null }, 'runId is required']
        ];
        for (var i = 0; i < cases.length; i++) {
            var threw = null;
            try { helpers.validateStampOptions(cases[i][0]); } catch (e) { threw = e; }
            assert.ok(threw, 'case ' + i + ' must throw');
            assert.ok((threw.message || '').indexOf(cases[i][1]) !== -1,
                'case ' + i + ' must mention ' + cases[i][1] + ', got: ' + threw.message);
        }
    });

    test('classifyJobOutcome maps job states to stamp decisions', function () {
        var classify = loadCiHelpers().classifyJobOutcome;
        assert.equal(classify(null), 'missing');
        assert.equal(classify(undefined), 'missing');
        assert.equal(classify({ status: 'in_progress', conclusion: null }), 'not-completed');
        assert.equal(classify({ status: 'queued', conclusion: null }), 'not-completed');
        assert.equal(classify({ status: 'completed', conclusion: null }), 'not-completed');
        assert.equal(classify({ status: 'completed', conclusion: 'skipped' }), 'skipped');
        assert.equal(classify({ status: 'completed', conclusion: 'success' }), 'stamp');
        assert.equal(classify({ status: 'completed', conclusion: 'failure' }), 'stamp');
    });

    test('findLastJobNamed returns the last matching job and tolerates null entries', function () {
        var find = loadCiHelpers().findLastJobNamed;
        var jobs = [null, { id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'a' }];
        assert.equal(find(jobs, 'a').id, 3, 'the last duplicate wins (most recent attempt)');
        assert.equal(find(jobs, 'b').id, 2);
        assert.equal(find(jobs, 'ghost'), null);
        assert.equal(find([], 'a'), null);
    });

    test('resolveCheckRunId prefers id, falls back to checkRunId, tolerates missing create result', function () {
        var resolve = loadCiHelpers().resolveCheckRunId;
        assert.equal(resolve({ id: 5 }), 5);
        assert.equal(resolve({ id: 0 }), 0, 'id 0 is a defined id and must be honored');
        assert.equal(resolve({ checkRunId: 9 }), 9, 'missing id falls back to checkRunId');
        assert.equal(resolve({ id: null, checkRunId: 9 }), 9, 'null id falls back to checkRunId');
        assert.equal(resolve(null), null, 'a failed create yields a falsy id');
        assert.equal(resolve(undefined), undefined);
    });

    test('buildCheckRunUpdatePayload carries conclusion, title and summary link', function () {
        var payload = loadCiHelpers().buildCheckRunUpdatePayload('gate', 'gate', {
            conclusion: 'failure',
            html_url: 'https://ci/run/1/job/12'
        }, 36001952519);

        assert.deepEqual(payload, {
            status: 'completed',
            conclusion: 'failure',
            title: 'gate — failure (mirrored from run 36001952519)',
            summary: 'Mirrored from [workflow run 36001952519](https://ci/run/1/job/12): ' +
                'job `gate` concluded `failure`.'
        });
    });

    test('buildCheckRunUpdatePayload tolerates a job without html_url', function () {
        var payload = loadCiHelpers().buildCheckRunUpdatePayload('gate', 'gate-job', {
            conclusion: 'success'
        }, 7);
        assert.equal(payload.title, 'gate — success (mirrored from run 7)');
        assert.equal(payload.summary, 'Mirrored from [workflow run 7](): job `gate-job` concluded `success`.');
    });
});
