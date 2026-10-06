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

// Real setupCommands: buildSetupErrorComment binds setupCommands.truncateSetupError
// at load time (the shared truncation bound), so the stub must actually export it.
var devSetupCommandsReal = loadModule('js/common/setupCommands.js');
var devCommentMarkupModule = loadModule('js/common/commentMarkup.js');

// The real tracker factory (provider probing is pure config/env reads) so
// action() tests exercise the actual github/jira provider gating.
var trackersModuleReal = loadModule(
    'js/common/trackers.js',
    makeRequire({ '../config.js': configModule }),
    {}
);

var DEFAULT_PR_HELPER_STUB = {
    buildTargetedOriginFetchCommand: function(branches) {
        var list = (branches || []).filter(function(b) { return b; });
        if (!list.length) return null;
        return 'git -c fetch.recurseSubmodules=no fetch origin ' + list.map(function(b) {
            return '+refs/heads/' + b + ':refs/remotes/origin/' + b;
        }).join(' ');
    },
    buildOriginFetchCommand: function(refSpec) {
        return 'git -c fetch.recurseSubmodules=no fetch origin' + (refSpec ? ' ' + refSpec : '');
    },
    ensureRemoteBranchRef: function(runCommand, workingDir, branchName) {
        if (!branchName) return false;
        try {
            runCommand(
                'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/' + branchName + ':refs/remotes/origin/' + branchName,
                workingDir
            );
            return true;
        } catch (e) {
            return false;
        }
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
            './common/setupCommands.js': devSetupCommandsReal,
            './common/commentMarkup.js': devCommentMarkupModule,
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
            './common/trackers.js': trackersModuleReal
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

suite('preCliDevelopmentSetup.checkoutBranch — generated .codegraph index guard', function() {

    var STASH_RM_CMD = 'git rm -r --cached --ignore-unmatch .codegraph';
    var STASH_TEST_CMD = 'bash -c "test -d .codegraph"';
    var STASH_MV_CMD = 'bash -c "mv .codegraph .codegraph.branch-setup-bak"';
    var RESTORE_TEST_CMD = 'bash -c "test -d .codegraph.branch-setup-bak"';
    var RESTORE_MV_CMD = 'bash -c "mv .codegraph.branch-setup-bak .codegraph"';

    function loadForGuard(calls, responses) {
        var config = makeConfig({ git: { featureBranch: { enabled: false } } });
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-1' }, 'master', null, []);
        return {
            mod: loadPreCliDevelopmentSetup(configLoaderStub, {
                cli_execute_command: makeCliMock(calls, responses)
            }),
            config: config
        };
    }

    test('stashes .codegraph before any checkout and restores it afterwards', function() {
        var calls = [];
        var ctx = loadForGuard(calls, {});

        ctx.mod.checkoutBranch('PROJ-1', ctx.config, TICKET, {});

        var stashRmIdx = calls.indexOf(STASH_RM_CMD);
        var stashTestIdx = calls.indexOf(STASH_TEST_CMD);
        var stashMvIdx = calls.indexOf(STASH_MV_CMD);
        var checkoutIdx = calls.indexOf('git checkout -B master origin/master');
        var restoreTestIdx = calls.lastIndexOf(RESTORE_TEST_CMD);
        var restoreMvIdx = calls.lastIndexOf(RESTORE_MV_CMD);

        assert.ok(stashRmIdx !== -1, 'unstages .codegraph before branch setup');
        assert.ok(stashTestIdx !== -1, 'checks whether .codegraph exists before moving it aside');
        assert.ok(stashMvIdx !== -1, 'moves .codegraph aside before branch setup');
        assert.ok(restoreTestIdx !== -1, 'checks whether the backup exists before restoring it');
        assert.ok(restoreMvIdx !== -1, 'restores .codegraph after branch setup');
        assert.ok(stashMvIdx < checkoutIdx, 'stash happens before checkout');
        assert.ok(restoreMvIdx > calls.lastIndexOf('git checkout -b ai/PROJ-1'), 'restore happens after checkout');
        for (var i = 0; i < calls.length; i++) {
            assert.equal(/[;`]|&&|\|\||[<>]/.test(calls[i]), false, 'command must not contain disallowed shell metacharacters: ' + calls[i]);
        }
    });

    test('restores .codegraph even when checkout fails', function() {
        var calls = [];
        var responses = {};
        var ctx = loadForGuard(calls, responses);
        // Existing local branch → plain checkout, which we make fail (dirty .codegraph scenario).
        responses['git branch --list "ai/PROJ-1"'] = 'ai/PROJ-1';
        var failingCalls = [];
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-1' }, 'master', null, []);
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: function(opts) {
                var command = opts && opts.command;
                failingCalls.push(command);
                if (command === 'git checkout ai/PROJ-1') {
                    throw new Error('error: Your local changes to .codegraph/codegraph.db would be overwritten');
                }
                if (responses && Object.prototype.hasOwnProperty.call(responses, command)) {
                    return responses[command];
                }
                return '';
            }
        });

        var threw = false;
        try {
            mod.checkoutBranch('PROJ-1', makeConfig({ git: { featureBranch: { enabled: false } } }), TICKET, {});
        } catch (e) {
            threw = true;
        }

        assert.ok(threw, 'checkout failure propagates');
        assert.ok(failingCalls.indexOf(RESTORE_MV_CMD) !== -1, 'restore runs even on checkout failure');
        // stash rm + restore rm = at least two untrack calls
        var rmCount = failingCalls.filter(function(c) { return c === STASH_RM_CMD; }).length;
        assert.ok(rmCount >= 2, 'restore untracks .codegraph on the (attempted) branch');
    });

    test('guard commands run inside config.workingDir when set', function() {
        var calls = [];
        var dirs = [];
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-1' }, 'master', null, []);
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: function(opts) {
                calls.push(opts && opts.command);
                dirs.push(opts && opts.workingDirectory);
                return '';
            },
            file_write: function() {}
        });
        var config = makeConfig({ git: { featureBranch: { enabled: false } }, workingDir: 'dependencies/target-repo' });

        mod.checkoutBranch('PROJ-1', config, TICKET, {});

        var stashMvIdx = calls.indexOf(STASH_MV_CMD);
        assert.ok(stashMvIdx !== -1, 'stash command ran');
        assert.equal(dirs[stashMvIdx], 'dependencies/target-repo', 'stash runs in the dependency working dir');
    });

});

suite('preCliDevelopmentSetup.checkoutBranch — base branch fetch before checkout', function() {

    test('fetches baseBranch from origin before git checkout when creating a new branch', function() {
        var calls = [];
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-1' }, 'master', null, []);
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, {})
        });
        var config = makeConfig({ git: { featureBranch: { enabled: false } } });

        mod.checkoutBranch('PROJ-1', config, TICKET, {});

        var fetchIdx = -1;
        var checkoutIdx = -1;
        for (var i = 0; i < calls.length; i++) {
            if (calls[i] && calls[i].indexOf('fetch origin') !== -1 && calls[i].indexOf('master') !== -1) {
                fetchIdx = i;
            }
            if (calls[i] === 'git checkout -B master origin/master') {
                checkoutIdx = i;
            }
        }
        assert.ok(fetchIdx !== -1, 'git fetch origin master must run before checkout');
        assert.ok(checkoutIdx !== -1, 'git checkout -B master origin/master must run');
        assert.ok(fetchIdx < checkoutIdx, 'fetch must come before checkout (fetchIdx=' + fetchIdx + ', checkoutIdx=' + checkoutIdx + ')');
    });

    test('fetches two-branch feature base before git checkout when creating a new branch', function() {
        var calls = [];
        var hookLoadCalls = [];
        var configLoaderStub = makeConfigLoaderStub(
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            'master',
            null,
            hookLoadCalls
        );
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, {})
        });
        var config = makeConfig(); // featureBranch.enabled = true by default

        mod.checkoutBranch('PROJ-1', config, TICKET, {});

        // In two-branch mode the dev branch is created from the feature branch,
        // so the fetch must target the feature branch name, not the raw baseBranch.
        var fetchIdx = -1;
        var checkoutIdx = -1;
        for (var i = 0; i < calls.length; i++) {
            if (calls[i] && calls[i].indexOf('fetch origin') !== -1 && calls[i].indexOf('release/rc_mobile_proj-1') !== -1) {
                fetchIdx = i;
            }
            if (calls[i] === 'git checkout -B release/rc_mobile_proj-1 origin/release/rc_mobile_proj-1') {
                checkoutIdx = i;
            }
        }
        assert.ok(fetchIdx !== -1, 'git fetch origin release/rc_mobile_proj-1 must run before checkout');
        assert.ok(checkoutIdx !== -1, 'git checkout -B release/rc_mobile_proj-1 origin/release/rc_mobile_proj-1 must run');
        assert.ok(fetchIdx < checkoutIdx, 'fetch must come before checkout');
    });

});

suite('preCliDevelopmentSetup.reportExistingDevBranch — existing remote work surfaced (gh-1164)', function () {

    // Live fa gh-1164 (run 37220167230): a resumed dev leg on a fresh branch
    // read session memory and mistook main's release tip for its own work
    // commit — nothing in the input folder said what origin/ai/<ticket>
    // already carried. Mirrors preCliReworkSetup.js surfacing existing state.

    function loadForReport(calls, responses, writes) {
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-7' }, 'main', null, []);
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses),
            file_write: function (args) { writes.push(args); }
        });
        return mod;
    }

    var CONFIG = makeConfig({ git: { featureBranch: { enabled: false } } });

    test('no remote branch → cheap no-op: one ls-remote, no file written', function () {
        var calls = [];
        var writes = [];
        var mod = loadForReport(calls, {}, writes);

        var result = mod.reportExistingDevBranch('PROJ-7', CONFIG, TICKET, 'input/PROJ-7');

        assert.equal(result, false);
        assert.deepEqual(calls, ['git ls-remote --heads origin ai/PROJ-7'],
            'exactly one ls-remote when the branch does not exist');
        assert.equal(writes.length, 0);
    });

    test('existing remote branch → input/<ticket>/existing_work.md carries commit count, file stat and oneline log', function () {
        var calls = [];
        var writes = [];
        var responses = {};
        responses['git ls-remote --heads origin ai/PROJ-7'] = 'abc123\trefs/heads/ai/PROJ-7';
        responses['git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/ai/PROJ-7:refs/remotes/origin/ai/PROJ-7'] = '';
        responses['git rev-list --count --right-only origin/main...origin/ai/PROJ-7'] = '3';
        responses['git log --oneline -20 origin/main..origin/ai/PROJ-7'] = 'abc123 PROJ-7 WIP auto-save\ndef456 PROJ-7 part A\n789abc PROJ-7 scaffold';
        responses['git diff --shortstat origin/main...origin/ai/PROJ-7'] = ' 5 files changed, 120 insertions(+), 4 deletions(-)';
        var mod = loadForReport(calls, responses, writes);

        var result = mod.reportExistingDevBranch('PROJ-7', CONFIG, TICKET, 'input/PROJ-7');

        assert.equal(result, true);
        assert.equal(writes.length, 1, 'exactly one report file');
        assert.equal(writes[0].path, 'input/PROJ-7/existing_work.md');
        var content = writes[0].content;
        assert.contains(content, 'RESUMED development leg',
            'the resumed-leg warning is the headline');
        assert.contains(content, 'Commits ahead of base: 3');
        assert.contains(content, '5 files changed, 120 insertions(+), 4 deletions(-)',
            'brief file stat');
        assert.contains(content, 'def456 PROJ-7 part A', 'oneline commit list');
        assert.contains(content, 'origin/ai/PROJ-7');
        assert.contains(content, 'origin/main',
            'names the base so the agent cannot mistake main\'s tip for its own work');
        // cheap: ls-remote + targeted fetch + rev-list + log + diff, nothing else
        assert.equal(calls.length, 5, 'one ls-remote + one fetch + one log batch when the branch exists');
        var fetchIdx = calls.indexOf('git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/ai/PROJ-7:refs/remotes/origin/ai/PROJ-7');
        var countIdx = calls.indexOf('git rev-list --count --right-only origin/main...origin/ai/PROJ-7');
        assert.ok(fetchIdx !== -1, 'targeted fetch of base+branch refs must run');
        assert.ok(countIdx !== -1, 'three-dot right-only ahead-count must run');
        assert.ok(fetchIdx < countIdx, 'gh-729: fresh refs BEFORE the count — a stale origin/main must not inflate it');
    });

    test('gh-729: ahead-count uses the three-dot right-only range (matches the diff, immune to stale base refs)', function () {
        // Live fa gh-1197 (run 37234028759): the report claimed 'Commits ahead
        // of base: 2343' while the very next line said 'Diff vs base: (no
        // diff)' — the two-dot count read a stale local origin/main ref while
        // the diff used the merge base. The count must use the same
        // three-dot semantics as the diff, against freshly fetched refs.
        var calls = [];
        var writes = [];
        var responses = {};
        responses['git ls-remote --heads origin ai/PROJ-7'] = 'abc123\trefs/heads/ai/PROJ-7';
        responses['git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main +refs/heads/ai/PROJ-7:refs/remotes/origin/ai/PROJ-7'] = '';
        responses['git rev-list --count --right-only origin/main...origin/ai/PROJ-7'] = '0';
        responses['git log --oneline -20 origin/main..origin/ai/PROJ-7'] = '';
        responses['git diff --shortstat origin/main...origin/ai/PROJ-7'] = '';
        var mod = loadForReport(calls, responses, writes);

        var result = mod.reportExistingDevBranch('PROJ-7', CONFIG, TICKET, 'input/PROJ-7');

        assert.equal(result, true);
        assert.equal(writes.length, 1);
        assert.contains(writes[0].content, 'Commits ahead of base: 0',
            'a fully-merged branch counts 0 ahead — consistent with the (no diff) line');
        var twoDotIdx = -1;
        for (var i = 0; i < calls.length; i++) {
            if (calls[i].indexOf('git rev-list --count') === 0 && calls[i].indexOf('--right-only') === -1) {
                twoDotIdx = i;
            }
        }
        assert.equal(twoDotIdx, -1, 'no two-dot ahead-count may run anymore — it is the stale-ref bug');
    });

    test('ls-remote failure is non-fatal and writes nothing', function () {
        var writes = [];
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-7' }, 'main', null, []);
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: function () { throw new Error('network down'); },
            file_write: function (args) { writes.push(args); }
        });

        var result = mod.reportExistingDevBranch('PROJ-7', CONFIG, TICKET, 'input/PROJ-7');

        assert.equal(result, false);
        assert.equal(writes.length, 0);
    });

});

suite('preCliDevelopmentSetup.action — dev-leg transition label assertion (gh-716)', function () {

    // Live fa gh-1164: a MANUALLY dispatched dev leg (gh workflow run
    // ai-teammate.yml -f issue=N -f leg=dev) bypassed the SM's agent:dev
    // labeling, so the card vanished from the factory board's Development
    // lane while the leg ran 40+ minutes. The setup now asserts the
    // transition itself: agent:dev ON, stale agent:review / ai_developed
    // cleared — on ANY dispatch path. GitHub-tracker deployments only;
    // never fatal (a labeling failure costs board visibility, not the run).

    function makeActionConfig(extra) {
        return makeConfig(Object.assign({
            git: { baseBranch: 'main', featureBranch: { enabled: false } },
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        }, extra || {}));
    }

    function makeActionConfigLoaderStub(config) {
        return {
            loadProjectConfig: function () { return config; },
            paramsForConfigLoad: function (params) { return params; },
            resolveBranchName: function (cfg, ticket, role) {
                return (role === 'development' ? 'ai/' : 'feature/') + ticket.key;
            },
            resolvePRTargetBranch: function () { return 'main'; },
            loadHookFn: function () { return null; }
        };
    }

    // Full-stub loader: action() touches restore/fetch/setup helpers that
    // checkoutBranch-only tests never exercised.
    function loadForAction(bag, config, githubBehavior) {
        return loadPreCliDevelopmentSetupWithExtras(bag, config, githubBehavior);
    }

    function loadPreCliDevelopmentSetupWithExtras(bag, config, githubBehavior) {
        return loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({
                './configLoader.js': makeActionConfigLoaderStub(config),
                './common/pullRequest.js': DEFAULT_PR_HELPER_STUB,
                './config.js': NOOP_CONFIG_JS,
                './fetchQuestionsToInput.js': { action: function () {} },
                './fetchLinkedTestsToInput.js': { action: function () {} },
                './fetchParentContextToInput.js': { action: function () {} },
                './restoreFromReleases.js': { action: function () {} },
                './common/setupCommands.js': {
                    runSetupCommands: function () { return null; },
                    buildSetupWarningsMarkdown: function () { return null; },
                    truncateSetupError: function (s) { return String(s); }
                },
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function () {} },
                './common/trackers.js': trackersModuleReal
            }),
            {
                cli_execute_command: makeCliMock(bag.cliCalls, {}),
                jira_move_to_status: function (args) { bag.moves.push(args); },
                file_write: function (args) { bag.writes.push(args); },
                github_add_labels: function (args) {
                    bag.events.push({ op: 'add', args: args });
                    if (githubBehavior && githubBehavior.addThrows) {
                        throw new Error('label add failed');
                    }
                },
                github_remove_label: function (args) {
                    bag.events.push({ op: 'remove', args: args });
                    if (githubBehavior && githubBehavior.removeThrowsFor === args.label) {
                        throw new Error('label absent');
                    }
                }
            }
        );
    }

    function makeBag() {
        return { cliCalls: [], moves: [], writes: [], events: [] };
    }

    var GH_TICKET = { key: 'gh-716', fields: {} };

    test('github tracker: clears stale agent:review + ai_developed, THEN asserts agent:dev with repo-scoped calls', function () {
        var bag = makeBag();
        var mod = loadForAction(bag, makeActionConfig(), { removeThrowsFor: 'agent:review' });

        mod.action({ inputFolderPath: 'input/gh-716', ticket: GH_TICKET, customParams: {} });

        var ghEvents = bag.events;
        assert.equal(ghEvents.length, 3, 'two removals + one add');
        // stale labels cleared FIRST (absent label = thrown, swallowed)
        assert.equal(ghEvents[0].op, 'remove');
        assert.equal(ghEvents[0].args.label, 'agent:review');
        assert.equal(ghEvents[1].op, 'remove');
        assert.equal(ghEvents[1].args.label, 'ai_developed');
        assert.equal(ghEvents[2].op, 'add');
        assert.deepEqual(ghEvents[2].args.labels, ['agent:dev']);
        ghEvents.forEach(function (e) {
            assert.equal(e.args.number, 716, 'issue number parsed from the gh-716 key');
            assert.equal(e.args.workspace, 'acme');
            assert.equal(e.args.repository, 'widgets');
        });
        // setup kept going: branch checkout happened after the assertion
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/gh-716') !== -1,
            'branch setup still ran');
    });

    test('non-github tracker (jira default): never touches GitHub labels', function () {
        var bag = makeBag();
        var mod = loadForAction(bag, makeActionConfig({ tracker: { provider: 'jira' } }), {});

        mod.action({ inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1', fields: {} }, customParams: {} });

        assert.equal(bag.events.length, 0, 'no github_add_labels / github_remove_label calls');
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/PROJ-1') !== -1,
            'branch setup still ran');
    });

    test('label assertion failure is non-fatal: github_add_labels throws, the setup still completes', function () {
        var bag = makeBag();
        var mod = loadForAction(bag, makeActionConfig(), { addThrows: true });

        mod.action({ inputFolderPath: 'input/gh-716', ticket: GH_TICKET, customParams: {} });

        assert.equal(bag.events.length, 3, 'removals were attempted, add was attempted');
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/gh-716') !== -1,
            'development was NOT stopped by the labeling failure');
    });

    test('assertDevLegTransition: key without a trailing issue number is skipped without calls', function () {
        var bag = makeBag();
        var mod = loadForAction(bag, makeActionConfig(), {});

        mod.assertDevLegTransition('no-digits-here', makeActionConfig(), {});

        assert.equal(bag.events.length, 0);
    });

});

// ── gh-770: per-tracker markup for the dev-leg setup error comment ───────────
// postSetupErrorToJira historically hard-coded Jira wiki markup and posted via
// raw jira_post_comment; on a GitHub-backed tracker the comment rendered as
// raw text garbage. The builder is extracted and posting goes through the
// probed tracker (trackers.js) so the flavor follows the ticket's tracker.

suite('preCliDevelopmentSetup.buildSetupErrorComment — per-tracker markup (gh-770)', function () {

    function loadForComments(globals) {
        return loadPreCliDevelopmentSetup({
            loadProjectConfig: function () { return makeConfig(); },
            paramsForConfigLoad: function (p) { return p; }
        }, globals || {});
    }

    test('jira flavor is byte-identical to the historical wiki template', function () {
        var mod = loadForComments();
        var out = mod.buildSetupErrorComment(devCommentMarkupModule.forFlavor('jira'), 'Git Branch Setup', 'boom');
        assert.equal(out,
            'h3. *Development Setup Error*\n' +
            '*Stage:* Git Branch Setup\n' +
            '*Error:* {code}boom{code}\n' +
            'Development was stopped before code generation because the target git branch could not be prepared.');
    });

    test('markdown flavor renders headings, bold and fenced code — no wiki constructs', function () {
        var mod = loadForComments();
        var out = mod.buildSetupErrorComment(devCommentMarkupModule.forFlavor('markdown'), 'Environment Setup', 'npm ci failed');
        assert.ok(out.indexOf('### **Development Setup Error**') === 0, 'starts with a markdown heading');
        assert.ok(out.indexOf('**Stage**: Environment Setup') !== -1);
        assert.ok(out.indexOf('**Error**') !== -1);
        assert.ok(out.indexOf('```') !== -1, 'error is fenced');
        assert.ok(out.indexOf('npm ci failed') !== -1);
        assert.equal(out.indexOf('h3.'), -1, 'no wiki heading');
        assert.equal(out.indexOf('{code}'), -1, 'no wiki code tag');
    });

});

suite('preCliDevelopmentSetup.postSetupErrorComment — routes through the probed tracker (gh-770)', function () {

    test('github ticket: posts markdown via the canonical github comment tool', function () {
        var posted = [];
        var mod = loadForComments({
            github_create_comment: function (args) { posted.push(args); return '{}'; }
        });
        mod.postSetupErrorComment(
            { tracker: { provider: 'github' }, repository: { owner: 'acme', repo: 'widgets' } },
            {},
            'gh-12',
            'Git Branch Setup',
            'boom'
        );
        assert.equal(posted.length, 1);
        assert.equal(posted[0].workspace, 'acme');
        assert.equal(posted[0].repository, 'widgets');
        assert.equal(posted[0].pullRequestId, 12);
        assert.ok(posted[0].text.indexOf('### **Development Setup Error**') === 0);
    });

    test('jira ticket: posts byte-identical wiki markup via the canonical jira tool', function () {
        var posted = [];
        var mod = loadForComments({
            jira_post_comment: function (args) { posted.push(args); return '{}'; }
        });
        mod.postSetupErrorComment({}, {}, 'PROJ-12', 'Git Branch Setup', 'boom');
        assert.equal(posted.length, 1);
        assert.equal(posted[0].key, 'PROJ-12');
        assert.ok(posted[0].comment.indexOf('h3. *Development Setup Error*') === 0);
    });

    test('a posting failure never breaks the setup flow (warn only)', function () {
        var mod = loadForComments({
            jira_post_comment: function () { throw new Error('jira down'); }
        });
        mod.postSetupErrorComment({}, {}, 'PROJ-12', 'Git Branch Setup', 'boom');
    });

});
