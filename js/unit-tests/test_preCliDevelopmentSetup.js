/**
 * Unit tests for js/preCliDevelopmentSetup.js
 *
 * Scope: checkoutBranch()'s two-branch mode feature branch creation step and its
 * customParams.branchCreateFnPath extension point (mirrors js/checkoutBranch.js — see
 * test_checkoutBranch.js — this file's flow is a separately-maintained duplicate used by
 * story_development.json/bug_development.json's preCliJSAction). The rest of
 * checkoutBranch()'s plain-branch checkout/rebase logic and action()'s broader flow (status
 * transition, questions/tests/parent-context fetch, error-to-Jira reporting) are not
 * re-verified here.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

var NOOP_MODULE = {};
var NOOP_CONFIG_JS = { GIT_CONFIG: {}, STATUSES: {}, resolveStatuses: function() { return {}; } };

var DEFAULT_PR_HELPER_STUB = {
    buildOriginFetchCommand: function(refSpec) {
        return 'git -c fetch.recurseSubmodules=no fetch origin' + (refSpec ? ' ' + refSpec : '');
    }
};

function loadPreCliDevelopmentSetup(configLoaderStub, mocks) {
    return loadModule(
        'js/preCliDevelopmentSetup.js',
        makeRequire({
            './configLoader.js': configLoaderStub,
            './common/pullRequest.js': DEFAULT_PR_HELPER_STUB,
            './config.js': NOOP_CONFIG_JS,
            './fetchQuestionsToInput.js': NOOP_MODULE,
            './fetchLinkedTestsToInput.js': NOOP_MODULE,
            './fetchParentContextToInput.js': NOOP_MODULE,
            './restoreFromReleases.js': NOOP_MODULE,
            './common/setupCommands.js': NOOP_MODULE
        }),
        mocks || {}
    );
}

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

function makeConfigLoaderStub(branchNameByRole, prTargetBranch, hookFn, hookLoadCalls) {
    return {
        resolveBranchName: function(cfg, ticket, role) { return branchNameByRole[role]; },
        resolvePRTargetBranch: function() { return prTargetBranch || 'master'; },
        loadHookFn: function(path, hookName) {
            hookLoadCalls.push({ path: path, hookName: hookName });
            return hookFn || null;
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

var TICKET = { key: 'PROJ-1', fields: {} };

suite('preCliDevelopmentSetup.checkoutBranch — two-branch mode feature branch creation', function() {

    test('falls back to git checkout+push when branchCreateFnPath is not configured', function() {
        var calls = [];
        var hookLoadCalls = [];
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            'master',
            null,
            hookLoadCalls
        );
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, {})
        });

        mod.checkoutBranch('PROJ-1', config, TICKET, {});

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
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            'master',
            hookFn,
            hookLoadCalls
        );
        // Neither the dev branch nor the feature branch exist yet, so checkoutBranch() falls
        // through to the "brand new dev branch" path, which is where the two-branch-mode
        // feature-branch-creation block (and thus branchCreateFnPath) actually runs.
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, {})
        });

        mod.checkoutBranch('PROJ-1', config, TICKET, { branchCreateFnPath: '.dmtools/branchNaming/sf_rc_branch_create.js' });

        assert.equal(hookLoadCalls.length, 1);
        assert.equal(hookLoadCalls[0].path, '.dmtools/branchNaming/sf_rc_branch_create.js');
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
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            'master',
            null,
            hookLoadCalls
        );
        var responses = {};
        // Dev branch (ai/PROJ-1) does not exist yet, so we do reach the two-branch block, but
        // the feature branch itself already exists remotely — the hook must not be consulted.
        responses['git ls-remote --heads origin release/rc_mobile_proj-1'] = 'abc123\trefs/heads/release/rc_mobile_proj-1';
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses)
        });

        mod.checkoutBranch('PROJ-1', config, TICKET, { branchCreateFnPath: '.dmtools/branchNaming/sf_rc_branch_create.js' });

        assert.equal(hookLoadCalls.length, 0, 'branchCreateFnPath is only consulted when the feature branch does not exist yet');
        assert.equal(calls.indexOf('git push -u origin release/rc_mobile_proj-1'), -1);
    });

    test('two-branch mode is skipped entirely when config.git.featureBranch.enabled is false', function() {
        var calls = [];
        var hookLoadCalls = [];
        var config = makeConfig({ git: { featureBranch: { enabled: false } } });
        var configLoaderStub = makeConfigLoaderStub(
            { development: 'ai/PROJ-1' },
            'master',
            null,
            hookLoadCalls
        );
        // Neither branch exists yet, so we reach the "brand new dev branch" path where the
        // featureBranch.enabled check happens — with it false, no two-branch commands should run.
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, {})
        });

        mod.checkoutBranch('PROJ-1', config, TICKET, {});

        assert.equal(hookLoadCalls.length, 0);
        for (var i = 0; i < calls.length; i++) {
            assert.ok(calls[i].indexOf('release/rc_') === -1, 'no feature-branch commands should run: ' + calls[i]);
        }
    });

});
