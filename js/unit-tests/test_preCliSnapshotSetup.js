/**
 * Unit tests for js/preCliSnapshotSetup.js
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

var NOOP_CONFIG_JS = { GIT_CONFIG: {}, STATUSES: {}, resolveStatuses: function() { return {}; } };

function loadPreCliSnapshotSetup(configLoaderStub, mocks) {
    return loadModule(
        'js/preCliSnapshotSetup.js',
        makeRequire({
            './configLoader.js': configLoaderStub || makeConfigLoaderStub(),
            './config.js': NOOP_CONFIG_JS
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
