/**
 * Unit tests for js/checkoutBranch.js
 *
 * Focuses on the two-branch mode "feature" branch creation step and its
 * customParams.branchCreateFnPath extension point — the rest of the file's
 * plain-branch checkout logic is exercised indirectly through these tests.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function makeConfig(overrides) {
    var base = {
        git: {
            baseBranch: 'master',
            authorName: 'AI Teammate',
            authorEmail: 'ai@example.com',
            featureBranch: { enabled: true }
        },
        workingDir: null
    };
    if (overrides && overrides.git) {
        base.git = Object.assign({}, base.git, overrides.git);
        overrides = Object.assign({}, overrides);
        delete overrides.git;
    }
    return Object.assign({}, base, overrides || {});
}

/**
 * Builds a configLoader stub with full control over loadProjectConfig/resolveBranchName/
 * loadHookFn, so tests don't depend on the real configLoader.js or real file_read.
 */
function makeConfigLoaderStub(config, branchNameByRole, hookFn, hookLoadCalls) {
    return {
        loadProjectConfig: function() { return config; },
        resolveBranchName: function(cfg, ticket, role) { return branchNameByRole[role]; },
        loadHookFn: function(path, hookName) {
            hookLoadCalls.push({ path: path, hookName: hookName });
            return hookFn || null;
        }
    };
}

// Real PR helper (gh-912): the remote-existence probes live there — the
// strict ref-line parser must be exercised, not a stub.
var DEFAULT_PR_HELPER_STUB = loadModule('js/common/pullRequest.js',
    makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'), './mergeState.js': loadModule('js/common/mergeState.js') }));

function loadCheckoutBranch(configLoaderStub, mocks) {
    return loadModule(
        'js/checkoutBranch.js',
        makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
            './config.js': { GIT_CONFIG: {} },
            './configLoader.js': configLoaderStub,
            './common/pullRequest.js': DEFAULT_PR_HELPER_STUB
        }),
        mocks || {}
    );
}

/** Builds a cli_execute_command mock that records every call and returns '' unless a
 *  response is registered for that exact command in `responses`. */
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

var TICKET = { key: 'PROJ-1' };

suite('checkoutBranch — two-branch mode feature branch creation', function() {

    test('falls back to git checkout+push when branchCreateFnPath is not configured', function() {
        var calls = [];
        var hookLoadCalls = [];
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            config,
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            null,
            hookLoadCalls
        );
        var mod = loadCheckoutBranch(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, {})
        });

        mod.action({ ticket: TICKET, jobParams: { customParams: {} } });

        assert.equal(hookLoadCalls.length, 0, 'loadHookFn should not be called when branchCreateFnPath is unset');
        assert.ok(calls.indexOf('git checkout -b release/rc_mobile_proj-1') !== -1, 'creates the feature branch locally');
        assert.ok(calls.indexOf('git push -u origin release/rc_mobile_proj-1') !== -1, 'pushes the new feature branch directly');
    });

    test('delegates feature branch creation to branchCreateFnPath and checks out via origin tracking', function() {
        var calls = [];
        var hookLoadCalls = [];
        var hookCallArgs = null;
        var hookFn = function(ctx) { hookCallArgs = ctx; };
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            config,
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            hookFn,
            hookLoadCalls
        );
        // Dev branch already exists locally so the rest of the flow is a no-op simple checkout.
        var responses = {};
        responses['git branch --list "ai/PROJ-1"'] = 'ai/PROJ-1';
        var mod = loadCheckoutBranch(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses)
        });

        mod.action({ ticket: TICKET, jobParams: { customParams: { branchCreateFnPath: '.dmtools/branchNaming/sf_rc_jenkins.js' } } });

        assert.equal(hookLoadCalls.length, 1);
        assert.equal(hookLoadCalls[0].path, '.dmtools/branchNaming/sf_rc_jenkins.js');
        assert.equal(hookLoadCalls[0].hookName, 'branchCreateFnPath');

        assert.ok(hookCallArgs, 'branchCreateFn should have been invoked');
        assert.equal(hookCallArgs.branchName, 'release/rc_mobile_proj-1');
        assert.equal(hookCallArgs.baseBranch, 'master');
        assert.equal(hookCallArgs.ticket, TICKET);
        assert.equal(hookCallArgs.config, config);

        assert.ok(calls.indexOf('git -c fetch.recurseSubmodules=no fetch origin') !== -1, 'fetches origin after the hook runs');
        assert.ok(calls.indexOf('git checkout -b release/rc_mobile_proj-1 origin/release/rc_mobile_proj-1') !== -1,
            'checks out the branch created by the hook via origin tracking');
        assert.equal(calls.indexOf('git push -u origin release/rc_mobile_proj-1'), -1,
            'must not attempt a direct push when delegating to branchCreateFnPath');
        assert.equal(calls.indexOf('git checkout -b release/rc_mobile_proj-1'), -1,
            'must not create a bare local branch when delegating to branchCreateFnPath');
    });

    test('does not touch the feature branch step when the feature branch already exists', function() {
        var calls = [];
        var hookLoadCalls = [];
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            config,
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            null,
            hookLoadCalls
        );
        var responses = {};
        responses['git branch --list "release/rc_mobile_proj-1"'] = 'release/rc_mobile_proj-1';
        responses['git branch --list "ai/PROJ-1"'] = 'ai/PROJ-1';
        var mod = loadCheckoutBranch(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses)
        });

        mod.action({ ticket: TICKET, jobParams: { customParams: { branchCreateFnPath: '.dmtools/branchNaming/sf_rc_jenkins.js' } } });

        assert.equal(hookLoadCalls.length, 0, 'branchCreateFnPath is only consulted when the feature branch does not exist yet');
        assert.equal(calls.indexOf('git push -u origin release/rc_mobile_proj-1'), -1);
    });

    test('two-branch mode is skipped entirely when config.git.featureBranch.enabled is false', function() {
        var calls = [];
        var hookLoadCalls = [];
        var config = makeConfig({ git: { featureBranch: { enabled: false } } });
        var configLoaderStub = makeConfigLoaderStub(
            config,
            { development: 'ai/PROJ-1' },
            null,
            hookLoadCalls
        );
        var responses = {};
        responses['git branch --list "ai/PROJ-1"'] = 'ai/PROJ-1';
        var mod = loadCheckoutBranch(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses)
        });

        mod.action({ ticket: TICKET, jobParams: { customParams: {} } });

        assert.equal(hookLoadCalls.length, 0);
        for (var i = 0; i < calls.length; i++) {
            assert.ok(calls[i].indexOf('release/rc_') === -1, 'no feature-branch commands should run: ' + calls[i]);
        }
    });

});

// ── gh-1190: checkoutBranch seam split — helper characterization ─────────────

suite('checkoutBranch — seam helpers (gh-1190)', function() {

    test('resolveActionCustomParams prefers jobParams.customParams, falls back through params', function() {
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {});
        assert.deepEqual(mod.resolveActionCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 },
            'jobParams.customParams wins');
        assert.deepEqual(mod.resolveActionCustomParams({ customParams: { b: 2 } }), { b: 2 },
            'standalone customParams next');
        assert.deepEqual(mod.resolveActionCustomParams({}), {},
            'defaults to an empty object');
    });

    test('configureGitAuthor issues user.name then user.email and warns on failure', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (calls.length === 1) throw new Error('git boom');
                return '';
            }
        });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            assert.equal(mod.configureGitAuthor(makeConfig()), undefined);
            assert.deepEqual(calls, ['git config user.name "AI Teammate"'], 'only user.name ran before the failure');
            assert.equal(warnings.length, 1, 'failure is a warning, not a throw');
            assert.contains(warnings[0], 'Failed to configure git author');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('configureGitAuthor logs success and fetchTargetBranch uses the targeted refspec', function() {
        var calls = [];
        var logs = [];
        var originalLog = console.log;
        console.log = function() { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) { calls.push(opts.command); return ''; }
        });
        try {
            mod.configureGitAuthor(makeConfig());
            assert.ok(logs.indexOf('Configured git author') !== -1);
            assert.deepEqual(calls, [
                'git config user.name "AI Teammate"',
                'git config user.email "ai@example.com"'
            ]);

            mod.fetchTargetBranch(makeConfig());
            assert.deepEqual(calls.slice(2), [
                'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/master:refs/remotes/origin/master'
            ], 'only the base branch is fetched (no blanket fetch)');
            assert.ok(logs.join('\n').indexOf('Fetched target branch: master') !== -1);
        } finally {
            console.log = originalLog;
        }
    });

    test('readLocalBranchList returns a cleaned capture and warns only when told to', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: makeCliMock(calls, { 'git branch --list "ai/PROJ-1"': '  ai/PROJ-1\nScript done\n' })
        });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            assert.equal(mod.readLocalBranchList('ai/PROJ-1', 'Error checking local branches:'), 'ai/PROJ-1',
                'wrapper artifacts stripped');
            assert.deepEqual(warnings, []);

            assert.equal(mod.readLocalBranchList('missing-branch', null), '', 'empty capture → empty string');
            var throwingLoader = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
                cli_execute_command: function() { throw new Error('git down'); }
            });
            assert.equal(throwingLoader.readLocalBranchList('ai/PROJ-1', 'Error checking local branches:'), '',
                'probe failure → empty string, not a throw');
            assert.equal(warnings.length, 1);
            assert.contains(warnings[0], 'Error checking local branches:');

            assert.equal(throwingLoader.readLocalBranchList('ai/PROJ-1', null), '', 'silent probe stays silent');
            assert.equal(warnings.length, 1, 'no extra warning when warnMessage is null');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('probeRemoteBranch delegates to the strict ls-remote parser and swallows failures', function() {
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                if (opts.command === 'git ls-remote --heads origin ai/PROJ-1') {
                    return '0123456789abcdef0123456789abcdef01234567\trefs/heads/ai/PROJ-1\n';
                }
                return 'warning: redirecting to https://example.com/\n';
            }
        });
        assert.equal(mod.probeRemoteBranch('ai/PROJ-1', 'Error checking remote branches:'), true,
            'a real ref line proves existence');
        assert.equal(mod.probeRemoteBranch('absent-branch', 'Error checking remote branches:'), false,
            'a warning-only capture classifies as absent (gh-912)');

        var throwingLoader = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function() { throw new Error('network down'); }
        });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            assert.equal(throwingLoader.probeRemoteBranch('ai/PROJ-1', 'Error checking remote branches:'), false);
            assert.equal(warnings.length, 1);
            assert.equal(throwingLoader.probeRemoteBranch('ai/PROJ-1', null), false);
            assert.equal(warnings.length, 1, 'silent probe stays silent');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('establishFeatureBranch routes: local-only → plain checkout, both → plain checkout', function() {
        var calls = [];
        var hookLoadCalls = [];
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            config,
            { development: 'ai/PROJ-1', feature: 'release/rc' },
            null,
            hookLoadCalls
        );
        var responses = {};
        responses['git branch --list "release/rc"'] = 'release/rc';
        var mod = loadCheckoutBranch(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses)
        });

        var feature = mod.establishFeatureBranch(config, {}, TICKET);
        assert.equal(feature, 'release/rc');
        assert.deepEqual(calls, [
            'git branch --list "release/rc"',
            'git ls-remote --heads origin release/rc',
            'git checkout release/rc'
        ], 'local-only feature branch → both probes, then exactly one plain checkout');
    });

    test('establishFeatureBranch routes: remote-only → tracking checkout', function() {
        var calls = [];
        var configLoaderStub = makeConfigLoaderStub(
            makeConfig(),
            { development: 'ai/PROJ-1', feature: 'release/rc' },
            null,
            []
        );
        var mod = loadCheckoutBranch(configLoaderStub, {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command === 'git ls-remote --heads origin release/rc') {
                    return '0123456789abcdef0123456789abcdef01234567\trefs/heads/release/rc\n';
                }
                return '';
            }
        });

        var logs = [];
        var originalLog = console.log;
        console.log = function() { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var feature = mod.establishFeatureBranch(makeConfig(), {}, TICKET);
            assert.equal(feature, 'release/rc');
            assert.deepEqual(calls, [
                'git branch --list "release/rc"',
                'git ls-remote --heads origin release/rc',
                'git checkout -b release/rc origin/release/rc'
            ]);
            assert.ok(logs.join('\n').indexOf('Two-branch mode: dev branch will be created from feature branch: release/rc') !== -1);
        } finally {
            console.log = originalLog;
        }
    });

    test('checkoutDevBranch: local hit → plain checkout without remote probes', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: makeCliMock(calls, { 'git branch --list "ai/PROJ-1"': 'ai/PROJ-1' })
        });
        var logs = [];
        var originalLog = console.log;
        console.log = function() { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            mod.checkoutDevBranch('ai/PROJ-1', 'master');
            assert.deepEqual(calls, [
                'git branch --list "ai/PROJ-1"',
                'git checkout ai/PROJ-1'
            ], 'local hit short-circuits before any ls-remote');
            assert.ok(logs.join('\n').indexOf('Branch exists locally, checking out: ai/PROJ-1') !== -1);
        } finally {
            console.log = originalLog;
        }
    });

    test('checkoutDevBranch: remote hit → tracking checkout', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command === 'git ls-remote --heads origin ai/PROJ-1') {
                    return '0123456789abcdef0123456789abcdef01234567\trefs/heads/ai/PROJ-1\n';
                }
                return '';
            }
        });
        mod.checkoutDevBranch('ai/PROJ-1', 'master');
        assert.deepEqual(calls, [
            'git branch --list "ai/PROJ-1"',
            'git ls-remote --heads origin ai/PROJ-1',
            'git checkout -b ai/PROJ-1 origin/ai/PROJ-1'
        ]);
    });

    test('checkoutDevBranch: absent everywhere → create from branchBase', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: makeCliMock(calls, {})
        });
        var logs = [];
        var originalLog = console.log;
        console.log = function() { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            mod.checkoutDevBranch('ai/PROJ-1', 'release/rc');
            assert.deepEqual(calls, [
                'git branch --list "ai/PROJ-1"',
                'git ls-remote --heads origin ai/PROJ-1',
                'git checkout release/rc',
                'git pull origin release/rc',
                'git checkout -b ai/PROJ-1'
            ], 'new branch starts from the (feature) base');
            assert.ok(logs.join('\n').indexOf('Creating new branch from release/rc: ai/PROJ-1') !== -1);
        } finally {
            console.log = originalLog;
        }
    });

});
