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

var DEFAULT_PR_HELPER_STUB = {
    buildOriginFetchCommand: function(refSpec) {
        return 'git -c fetch.recurseSubmodules=no fetch origin' + (refSpec ? ' ' + refSpec : '');
    }
};

function loadCheckoutBranch(configLoaderStub, mocks) {
    return loadModule(
        'js/checkoutBranch.js',
        makeRequire({
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
