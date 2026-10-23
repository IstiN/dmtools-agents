/**
 * Unit tests for js/preCliSnapshotSetup.js
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

var NOOP_CONFIG_JS = { GIT_CONFIG: {}, STATUSES: {}, resolveStatuses: function() { return {}; } };

// Real PR helper (gh-912): preCliSnapshotSetup delegates cleanCommandOutput to
// it, so the canonical implementation must be in the require map.
var PR_HELPER_REAL_SNAPSHOT = loadModule('js/common/pullRequest.js',
    makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }));

function loadPreCliSnapshotSetup(configLoaderStub, mocks) {
    return loadModule(
        'js/preCliSnapshotSetup.js',
        makeRequire({
            './configLoader.js': configLoaderStub || makeConfigLoaderStub(),
            './config.js': NOOP_CONFIG_JS,
            './common/pullRequest.js': PR_HELPER_REAL_SNAPSHOT
        }),
        mocks || {}
    );
}

function makeConfigLoaderStub(snapshotBranch) {
    return {
        paramsForConfigLoad: function(params) {
            return (params && params.jobParams) || params || {};
        },
        loadProjectConfig: function() {
            return {
                git: {
                    baseBranch: 'master',
                    snapshotBranch: snapshotBranch || ''
                },
                customParams: {
                    targetRepository: {
                        owner: 'acme-corp',
                        repo: 'example-repo',
                        baseBranch: 'master',
                        workingDir: './dependencies/example-repo'
                    }
                },
                workingDir: '.'
            };
        }
    };
}

function makeCliMock(calls, responses) {
    return function(opts) {
        var command = opts && opts.command;
        calls.push(command);
        if (responses && Object.prototype.hasOwnProperty.call(responses, command)) {
            return responses[command];
        }
        return '';
    };
}

function makeChainedAction(calls) {
    return {
        action: function(params) {
            calls.push('chained-action');
            return true;
        }
    };
}

var TICKET = { key: 'PROJ-1', fields: { fixVersions: [{ name: '3.9.0' }] } };

suite('preCliSnapshotSetup', function() {

    test('is no-op when snapshotBranch is not resolved', function() {
        var calls = [];
        var mod = loadPreCliSnapshotSetup(makeConfigLoaderStub(''), {
            cli_execute_command: makeCliMock(calls, {})
        });
        var result = mod.action({
            ticket: TICKET,
            customParams: {}
        });
        assert.equal(result, true);
        assert.equal(calls.length, 0, 'no git commands when snapshotBranch empty');
    });

    test('chains existing preCliJSAction before checkout', function() {
        var calls = [];
        var chainedCalls = [];
        var mod = loadModule(
            'js/preCliSnapshotSetup.js',
            makeRequire({
                './configLoader.js': makeConfigLoaderStub('develop/3.9.0'),
                './config.js': NOOP_CONFIG_JS,
                './common/pullRequest.js': PR_HELPER_REAL_SNAPSHOT,
                './fetchQuestionsToInput.js': makeChainedAction(chainedCalls)
            }),
            { cli_execute_command: makeCliMock(calls, {}) }
        );
        var result = mod.action({
            ticket: TICKET,
            customParams: {
                chainedPreCliJSAction: 'fetchQuestionsToInput.js'
            }
        });
        assert.equal(result, true);
        assert.deepEqual(chainedCalls, ['chained-action']);
        assert.ok(calls.some(function(c) { return c.indexOf('git checkout develop/3.9.0') !== -1; }), 'checkout command present');
    });

    test('chains existing preCliJSAction when customParams are nested under jobParams (real Teammate path)', function() {
        // JavaScriptExecutor.withJobContext passes { jobParams, ticket, response } —
        // customParams live inside jobParams, not at the top level.
        var calls = [];
        var chainedCalls = [];
        var mod = loadModule(
            'js/preCliSnapshotSetup.js',
            makeRequire({
                './configLoader.js': makeConfigLoaderStub('develop/3.9.0'),
                './config.js': NOOP_CONFIG_JS,
                './common/pullRequest.js': PR_HELPER_REAL_SNAPSHOT,
                './fetchQuestionsToInput.js': makeChainedAction(chainedCalls)
            }),
            { cli_execute_command: makeCliMock(calls, {}) }
        );
        var result = mod.action({
            ticket: TICKET,
            jobParams: {
                customParams: {
                    chainedPreCliJSAction: 'fetchQuestionsToInput.js'
                }
            }
        });
        assert.equal(result, true);
        assert.deepEqual(chainedCalls, ['chained-action'], 'chained action must fire with jobParams-nested customParams');
    });

    test('checks out snapshot branch and syncs codegraph', function() {
        var calls = [];
        var mod = loadPreCliSnapshotSetup(makeConfigLoaderStub('develop/3.9.0'), {
            cli_execute_command: makeCliMock(calls, {
                'git rev-parse --abbrev-ref HEAD': 'master'
            })
        });
        var result = mod.action({
            ticket: TICKET,
            customParams: {}
        });
        assert.equal(result, true);
        assert.ok(calls.some(function(c) { return c.indexOf('git fetch origin develop/3.9.0') !== -1; }));
        assert.ok(calls.some(function(c) { return c.indexOf('git checkout develop/3.9.0') !== -1; }));
        assert.ok(calls.some(function(c) { return c.indexOf('codegraph sync "."') !== -1; }));
    });

    test('skips checkout when already on snapshot branch', function() {
        var calls = [];
        var mod = loadPreCliSnapshotSetup(makeConfigLoaderStub('develop/3.9.0'), {
            cli_execute_command: makeCliMock(calls, {
                'git rev-parse --abbrev-ref HEAD': 'develop/3.9.0'
            })
        });
        var result = mod.action({
            ticket: TICKET,
            customParams: {}
        });
        assert.equal(result, true);
        assert.ok(!calls.some(function(c) { return c.indexOf('git checkout') !== -1; }), 'no checkout when already on branch');
        assert.ok(calls.some(function(c) { return c.indexOf('git pull origin develop/3.9.0 --ff-only') !== -1; }));
        assert.ok(calls.some(function(c) { return c.indexOf('codegraph sync') !== -1; }));
    });

    test('returns true even if git commands fail', function() {
        var calls = [];
        var mod = loadPreCliSnapshotSetup(makeConfigLoaderStub('develop/3.9.0'), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command.indexOf('git fetch') !== -1) {
                    throw new Error('fetch failed');
                }
                return '';
            }
        });
        var result = mod.action({
            ticket: TICKET,
            customParams: {}
        });
        assert.equal(result, true);
    });

});

// ---------------------------------------------------------------------------
// action — remaining branches (gh-1197 characterization before CRAP extraction)
// ---------------------------------------------------------------------------

suite('preCliSnapshotSetup — action branches', function() {

    function chainedModule(actionFn) {
        return { action: actionFn };
    }

    test('aborts (returns false) when the chained action returns false — no config load, no git', function() {
        var calls = [];
        var chainedCalls = [];
        var configLoads = 0;
        var loader = makeConfigLoaderStub('develop/3.9.0');
        var realLoad = loader.loadProjectConfig;
        loader.loadProjectConfig = function() { configLoads++; return realLoad(); };
        var mod = loadModule(
            'js/preCliSnapshotSetup.js',
            makeRequire({
                './configLoader.js': loader,
                './config.js': NOOP_CONFIG_JS,
                './common/pullRequest.js': PR_HELPER_REAL_SNAPSHOT,
                './fetchQuestionsToInput.js': chainedModule(function() {
                    chainedCalls.push('chained');
                    return false;
                })
            }),
            { cli_execute_command: makeCliMock(calls, {}) }
        );
        var result = mod.action({
            ticket: TICKET,
            customParams: { chainedPreCliJSAction: 'fetchQuestionsToInput.js' }
        });
        assert.equal(result, false, 'action must abort with false when the chained action returns false');
        assert.deepEqual(chainedCalls, ['chained'], 'chained action ran once');
        assert.equal(configLoads, 0, 'project config must not be loaded after an abort');
        assert.equal(calls.length, 0, 'no git commands after an abort');
    });

    test('continues when the chained module cannot be required (non-fatal)', function() {
        var calls = [];
        var mod = loadPreCliSnapshotSetup(makeConfigLoaderStub('develop/3.9.0'), {
            cli_execute_command: makeCliMock(calls, {
                'git rev-parse --abbrev-ref HEAD': 'master'
            })
        });
        var result = mod.action({
            ticket: TICKET,
            customParams: { chainedPreCliJSAction: 'definitelyMissingModule.js' }
        });
        assert.equal(result, true, 'require failure is non-fatal');
        assert.ok(calls.some(function(c) { return c.indexOf('git checkout develop/3.9.0') !== -1; }),
            'checkout still happens after the chained module fails to load');
    });

    test('continues when the chained module has no action export', function() {
        var calls = [];
        var mod = loadModule(
            'js/preCliSnapshotSetup.js',
            makeRequire({
                './configLoader.js': makeConfigLoaderStub('develop/3.9.0'),
                './config.js': NOOP_CONFIG_JS,
                './common/pullRequest.js': PR_HELPER_REAL_SNAPSHOT,
                './notAnAction.js': { notAction: function() {} }
            }),
            { cli_execute_command: makeCliMock(calls, { 'git rev-parse --abbrev-ref HEAD': 'master' }) }
        );
        var result = mod.action({
            ticket: TICKET,
            customParams: { chainedPreCliJSAction: 'notAnAction.js' }
        });
        assert.equal(result, true, 'module without action export is skipped silently');
        assert.ok(calls.some(function(c) { return c.indexOf('git checkout develop/3.9.0') !== -1; }),
            'checkout still happens');
    });

    test('continues when the chained action itself throws (non-fatal)', function() {
        var calls = [];
        var mod = loadModule(
            'js/preCliSnapshotSetup.js',
            makeRequire({
                './configLoader.js': makeConfigLoaderStub('develop/3.9.0'),
                './config.js': NOOP_CONFIG_JS,
                './common/pullRequest.js': PR_HELPER_REAL_SNAPSHOT,
                './throwingChain.js': chainedModule(function() { throw new Error('chain boom'); })
            }),
            { cli_execute_command: makeCliMock(calls, { 'git rev-parse --abbrev-ref HEAD': 'master' }) }
        );
        var result = mod.action({
            ticket: TICKET,
            customParams: { chainedPreCliJSAction: 'throwingChain.js' }
        });
        assert.equal(result, true, 'chained action failure is non-fatal');
        assert.ok(calls.some(function(c) { return c.indexOf('git checkout develop/3.9.0') !== -1; }),
            'checkout still happens after the chained action throws');
    });

    test('returns true without git commands when targetRepository.workingDir is missing', function() {
        var calls = [];
        var loader = {
            paramsForConfigLoad: function(params) { return (params && params.jobParams) || params || {}; },
            loadProjectConfig: function() {
                return {
                    git: { snapshotBranch: 'develop/3.9.0' },
                    workingDir: '.'
                };
            }
        };
        var mod = loadPreCliSnapshotSetup(loader, { cli_execute_command: makeCliMock(calls, {}) });
        var result = mod.action({ ticket: TICKET, customParams: {} });
        assert.equal(result, true, 'no workingDir — skip without failure');
        assert.equal(calls.length, 0, 'no git commands without a workingDir');
    });

    test('returns true without git commands when config has no customParams at all', function() {
        var calls = [];
        var loader = {
            paramsForConfigLoad: function(params) { return (params && params.jobParams) || params || {}; },
            loadProjectConfig: function() {
                return { git: { snapshotBranch: 'develop/3.9.0' } };
            }
        };
        var mod = loadPreCliSnapshotSetup(loader, { cli_execute_command: makeCliMock(calls, {}) });
        var result = mod.action({ ticket: TICKET, customParams: {} });
        assert.equal(result, true, 'missing customParams.targetRepository — skip without failure');
        assert.equal(calls.length, 0, 'no git commands');
    });

    test('returns true when the project config cannot be loaded (outer catch)', function() {
        var calls = [];
        var loader = {
            paramsForConfigLoad: function(params) { return (params && params.jobParams) || params || {}; },
            loadProjectConfig: function() { throw new Error('config down'); }
        };
        var mod = loadPreCliSnapshotSetup(loader, { cli_execute_command: makeCliMock(calls, {}) });
        var result = mod.action({ ticket: TICKET, customParams: {} });
        assert.equal(result, true, 'snapshot setup never blocks the agent');
        assert.equal(calls.length, 0, 'no git commands when config loading fails');
    });

    test('still checks out when the current-branch probe fails', function() {
        var calls = [];
        var mod = loadPreCliSnapshotSetup(makeConfigLoaderStub('develop/3.9.0'), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command === 'git rev-parse --abbrev-ref HEAD') {
                    throw new Error('git broken');
                }
                return '';
            }
        });
        var result = mod.action({ ticket: TICKET, customParams: {} });
        assert.equal(result, true, 'checkout proceeds after a failing rev-parse');
        assert.ok(calls.some(function(c) { return c.indexOf('git fetch origin develop/3.9.0') !== -1; }), 'fetch attempted');
        assert.ok(calls.some(function(c) { return c.indexOf('git checkout develop/3.9.0') !== -1; }), 'checkout attempted');
        assert.ok(calls.some(function(c) { return c.indexOf('codegraph sync') !== -1; }), 'codegraph synced');
    });

    test('stays on the snapshot branch when the fast-forward pull fails', function() {
        var calls = [];
        var mod = loadPreCliSnapshotSetup(makeConfigLoaderStub('develop/3.9.0'), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command.indexOf('git pull origin develop/3.9.0 --ff-only') !== -1) {
                    throw new Error('pull failed');
                }
                if (opts.command === 'git rev-parse --abbrev-ref HEAD') {
                    return 'develop/3.9.0';
                }
                return '';
            }
        });
        var result = mod.action({ ticket: TICKET, customParams: {} });
        assert.equal(result, true, 'already on the right branch — pull failure is non-fatal');
        assert.ok(!calls.some(function(c) { return c.indexOf('git checkout') !== -1; }), 'no checkout needed');
        assert.ok(calls.some(function(c) { return c.indexOf('codegraph sync') !== -1; }), 'codegraph still synced');
    });

    test('returns true when the codegraph sync fails', function() {
        var calls = [];
        var mod = loadPreCliSnapshotSetup(makeConfigLoaderStub('develop/3.9.0'), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command.indexOf('codegraph sync') !== -1) {
                    throw new Error('codegraph down');
                }
                if (opts.command === 'git rev-parse --abbrev-ref HEAD') {
                    return 'develop/3.9.0';
                }
                return '';
            }
        });
        var result = mod.action({ ticket: TICKET, customParams: {} });
        assert.equal(result, true, 'codegraph failure is non-fatal');
        assert.ok(calls.some(function(c) { return c.indexOf('git checkout develop/3.9.0') !== -1; }), 'checkout happened');
    });

});
