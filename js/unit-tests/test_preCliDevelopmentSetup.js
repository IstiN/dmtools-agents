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
var devCommentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
// gh-1363: the shared leg-failure report builder — pure, zero requires.
var legFailureReportModule = loadModule('js/common/legFailureReport.js');
// gh-1364: the leg-start phase signal builder — pure, zero requires.
var legStartSignalReal = loadModule('js/common/legStartSignal.js');

// The real tracker factory (provider probing is pure config/env reads) so
// action() tests exercise the actual github/jira provider gating.
var trackersModuleReal = loadModule(
    'js/common/trackers.js',
    makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }),
    {}
);

var PR_HELPER_REAL = loadModule('js/common/pullRequest.js',
    makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }));

// gh-1436: the plan-mode appendix module — wired into the setup's require map
// so the module under test can require it (its file IO stays mockable via the
// per-suite `mocks`, which shadow the globals inside THIS loader's instances).
var devDevelopmentModeReal = loadModule('js/common/developmentMode.js');
var devDevelopmentModePlanReal = loadModule('js/common/developmentModePlan.js',
    makeRequire({ './developmentMode.js': devDevelopmentModeReal }));
// gh-1437: the adaptive routing module — same wiring discipline as the plan
// module above (real instance, file IO still mockable via `mocks`).
var devDevelopmentModeAdaptiveReal = loadModule('js/common/developmentModeAdaptive.js',
    makeRequire({ './developmentMode.js': devDevelopmentModeReal, './developmentModePlan.js': devDevelopmentModePlanReal }));

function loadPreCliDevelopmentSetup(configLoaderStub, mocks) {
    return loadModule(
        'js/preCliDevelopmentSetup.js',
        makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js', null, mocks || {}),
            'gitStaging.js': loadModule('js/common/gitStaging.js'),
            './configLoader.js': configLoaderStub,
            './common/pullRequest.js': PR_HELPER_REAL,
            './config.js': NOOP_CONFIG_JS,
            './fetchQuestionsToInput.js': NOOP_MODULE,
            './fetchLinkedTestsToInput.js': NOOP_MODULE,
            './fetchParentContextToInput.js': NOOP_MODULE,
            './restoreFromReleases.js': NOOP_MODULE,
            './common/setupCommands.js': devSetupCommandsReal,
            './common/commentMarkup.js': devCommentMarkupModule,
            './common/legFailureReport.js': legFailureReportModule,
            './common/legStartSignal.js': legStartSignalReal,
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
            './common/trackers.js': trackersModuleReal,
            './common/developmentMode.js': devDevelopmentModeReal,
            './common/developmentModePlan.js': devDevelopmentModePlanReal,
            './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
            './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal
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
        responses['git ls-remote --heads origin release/rc_mobile_proj-1'] = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/release/rc_mobile_proj-1';
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
        responses['git ls-remote --heads origin ai/PROJ-7'] = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/ai/PROJ-7';
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
        responses['git ls-remote --heads origin ai/PROJ-7'] = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/ai/PROJ-7';
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

    function loadPreCliDevelopmentSetupWithExtras(bag, config, githubBehavior, extraMocks) {
        var modMocks = Object.assign({
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
            }, extraMocks || {});
        return loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js', null, modMocks),
                'gitStaging.js': loadModule('js/common/gitStaging.js'),
                './configLoader.js': makeActionConfigLoaderStub(config),
                './common/pullRequest.js': PR_HELPER_REAL,
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
                './common/developmentModePlan.js': devDevelopmentModePlanReal,
                './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
                './common/commentMarkup.js': devCommentMarkupModule,
                './common/legFailureReport.js': legFailureReportModule,
                './common/legStartSignal.js': legStartSignalReal,
                './common/trackers.js': extraMocks ? loadModule('js/common/trackers.js', makeRequire({
                    '../config.js': configModule,
                    './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
                }), extraMocks) : trackersModuleReal
            }),
            modMocks
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

    test('ado tracker: moves to In Development via ado_move_to_state, no jira_move_to_status (wave1c)', function () {
        var bag = makeBag();
        var adoMoves = [];
        var mod = loadPreCliDevelopmentSetupWithExtras(bag, makeActionConfig({ tracker: { provider: 'ado' } }), {}, {
            ado_move_to_state: function (args) { adoMoves.push(args); }
        });

        mod.action({ inputFolderPath: 'input/77', ticket: { key: '77', fields: {} }, customParams: {} });

        assert.equal(bag.moves.length, 0, 'no jira_move_to_status call on ADO');
        assert.equal(adoMoves.length, 1);
        assert.equal(adoMoves[0].id, '77');
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

function loadForComments(globals) {
    return loadPreCliDevelopmentSetup({
        loadProjectConfig: function () { return makeConfig(); },
        paramsForConfigLoad: function (p) { return p; }
    }, globals || {});
}

suite('preCliDevelopmentSetup.buildSetupErrorComment — per-tracker markup (gh-770)', function () {

    test('jira flavor is byte-identical to the historical wiki template', function () {
        var mod = loadForComments();
        var out = mod.buildSetupErrorComment(devCommentMarkupModule.forFlavor('jira'), 'Git Branch Setup', 'boom');
        assert.equal(out,
            'h3. *Development Setup Error*\n\n' +
            '*Stage:* Git Branch Setup\n' +
            '*Error:* {code}boom{code}\n\n' +
            'Development was stopped before code generation because the target git branch could not be prepared.');
    });

    test('markdown flavor renders headings, bold and fenced code — no wiki constructs', function () {
        var mod = loadForComments();
        var out = mod.buildSetupErrorComment(devCommentMarkupModule.forFlavor('markdown'), 'Environment Setup', 'npm ci failed');
        assert.ok(out.indexOf('### **Development Setup Error**') === 0, 'starts with a markdown heading');
        assert.ok(out.indexOf('**Stage:** Environment Setup') !== -1);
        assert.ok(out.indexOf('**Error:**') !== -1);
        assert.ok(out.indexOf('```') !== -1, 'error is fenced');
        assert.ok(out.indexOf('npm ci failed') !== -1);
        assert.equal(out.indexOf('h3.'), -1, 'no wiki heading');
        assert.equal(out.indexOf('{code}'), -1, 'no wiki code tag');
    });

});

suite('preCliDevelopmentSetup.postSetupErrorComment — routes through the probed tracker (gh-770)', function () {

    // The tracker factory is stubbed: which canonical tool each provider
    // dispatches to is covered by test_trackers.js — here we pin the WIRING
    // (comment built with the ticket's markup flavor, posted via the tracker).
    function loadWithTrackerStub(posted, postThrows) {
        return loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js', null, {}),
                'gitStaging.js': loadModule('js/common/gitStaging.js'),
                './configLoader.js': {
                    loadProjectConfig: function () { return makeConfig(); },
                    paramsForConfigLoad: function (p) { return p; }
                },
                './common/pullRequest.js': PR_HELPER_REAL,
                './config.js': NOOP_CONFIG_JS,
                './fetchQuestionsToInput.js': NOOP_MODULE,
                './fetchLinkedTestsToInput.js': NOOP_MODULE,
                './fetchParentContextToInput.js': NOOP_MODULE,
                './restoreFromReleases.js': NOOP_MODULE,
                './common/setupCommands.js': devSetupCommandsReal,
                './common/commentMarkup.js': devCommentMarkupModule,
                './common/legFailureReport.js': legFailureReportModule,
                './common/legStartSignal.js': legStartSignalReal,
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function () {} },
                './common/developmentModePlan.js': devDevelopmentModePlanReal,
                './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
                './common/trackers.js': {
                    createTracker: function () {
                        return {
                            provider: function () { return 'stub'; },
                            postComment: function (ticketKey, text) {
                                if (postThrows) { throw new Error('tracker down'); }
                                posted.push({ ticketKey: ticketKey, text: text });
                            }
                        };
                    }
                }
            }),
            {}
        );
    }

    test('posts the flavored comment through the probed tracker', function () {
        var posted = [];
        var mod = loadWithTrackerStub(posted, false);
        mod.postSetupErrorComment(
            { tracker: { provider: 'github' } },
            {},
            'gh-12',
            'Git Branch Setup',
            'boom'
        );
        assert.equal(posted.length, 1);
        assert.equal(posted[0].ticketKey, 'gh-12');
        assert.ok(posted[0].text.indexOf('### **Development Setup Error**') === 0,
            'github key renders markdown, got: ' + posted[0].text);
    });

    test('jira ticket receives byte-identical wiki markup', function () {
        var posted = [];
        var mod = loadWithTrackerStub(posted, false);
        mod.postSetupErrorComment({}, {}, 'PROJ-12', 'Git Branch Setup', 'boom');
        assert.equal(posted.length, 1);
        assert.equal(posted[0].ticketKey, 'PROJ-12');
        assert.ok(posted[0].text.indexOf('h3. *Development Setup Error*') === 0,
            'jira key renders wiki markup, got: ' + posted[0].text);
    });

    test('a posting failure never breaks the setup flow (warn only)', function () {
        var posted = [];
        var mod = loadWithTrackerStub(posted, true);
        mod.postSetupErrorComment({}, {}, 'PROJ-12', 'Git Branch Setup', 'boom');
        assert.equal(posted.length, 0);
    });

});

// ── gh-912: warning-only ls-remote captures must classify as "branch absent" ─
// The JS bridge merges git's stderr into every capture; on central-mode
// (insteadOf-rewritten origin) git ≥ 2.54 prints `warning: redirecting to …`
// on EVERY network command. The old `.trim()`-emptiness probes read that
// warning-only capture as "branch exists on remote" → fetch of the missing
// ref fails → `git checkout -B <b> origin/<b>` → fatal → the dev job dies
// before the CLI agent starts. These tests pin the AC1 behavior: the
// create-branch path runs and the action completes.

suite('preCliDevelopmentSetup.checkoutBranch — warning-only ls-remote captures (gh-912)', function() {

    var WARNING = 'warning: redirecting to https://git.example.com/\n';
    var SHA40 = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec';

    // Faithful git double for the first-run scenario: the ticket branch does
    // not exist on the remote, so a fetch of its ref and a checkout of
    // origin/<branch> fail exactly like real git does.
    function makeFirstRunCli(calls, responses) {
        return function(opts) {
            var command = opts && opts.command;
            calls.push(command);
            if (responses && responses[command] !== undefined) return responses[command];
            if (command === 'git fetch origin ai/PROJ-1:ai/PROJ-1' ||
                command === 'git -c fetch.recurseSubmodules=no fetch origin ai/PROJ-1:ai/PROJ-1') {
                throw new Error('fatal: couldn\'t find remote refs/heads/ai/PROJ-1');
            }
            if (command === 'git checkout -B ai/PROJ-1 origin/ai/PROJ-1') {
                throw new Error('fatal: \'origin/ai/PROJ-1\' is not a commit');
            }
            return '';
        };
    }

    test('AC1: warning-only capture on a first run takes the create-branch path and completes', function() {
        var calls = [];
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            'master',
            null,
            []
        );
        var responses = {};
        responses['git ls-remote --heads origin ai/PROJ-1'] = WARNING;
        responses['git ls-remote --heads origin release/rc_mobile_proj-1'] = WARNING;
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeFirstRunCli(calls, responses)
        });

        assert.doesNotThrow(function() {
            mod.checkoutBranch('PROJ-1', config, TICKET, {});
        }, 'warning-only capture must be read as "branch absent" — the dev leg must start, not die pre-agent');
        assert.ok(calls.indexOf('git checkout -b ai/PROJ-1') !== -1,
            'the create-branch path must run, got: ' + JSON.stringify(calls));
        assert.equal(calls.indexOf('git checkout -B ai/PROJ-1 origin/ai/PROJ-1'), -1,
            'must never checkout a tracking ref that was never fetched');
    });

    test('AC1b: warning-only capture on the FEATURE probe creates the feature branch instead of dying', function() {
        var calls = [];
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            'master',
            null,
            []
        );
        var responses = {};
        responses['git ls-remote --heads origin ai/PROJ-1'] = '';
        responses['git ls-remote --heads origin release/rc_mobile_proj-1'] = WARNING;
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeFirstRunCli(calls, responses)
        });

        assert.doesNotThrow(function() {
            mod.checkoutBranch('PROJ-1', config, TICKET, {});
        });
        assert.ok(calls.indexOf('git checkout -b release/rc_mobile_proj-1') !== -1,
            'feature branch must be created from base, got: ' + JSON.stringify(calls));
        assert.equal(calls.indexOf('git checkout -b release/rc_mobile_proj-1 origin/release/rc_mobile_proj-1'), -1,
            'must not checkout the feature branch from an origin ref that does not exist');
    });

    test('AC3: warning + real ref line still classifies "exists" (both merge orders)', function() {
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            { development: 'ai/PROJ-1', feature: 'release/rc_mobile_proj-1' },
            'master',
            null,
            []
        );
        var refLine = SHA40 + '\trefs/heads/ai/PROJ-1';
        ['warning: redirecting to https://git.example.com/\n' + refLine, refLine + '\nwarning: redirecting to https://git.example.com/']
            .forEach(function(capture) {
                var calls = [];
                var responses = {};
                responses['git ls-remote --heads origin ai/PROJ-1'] = capture;
                responses['git ls-remote --heads origin release/rc_mobile_proj-1'] = WARNING;
                // The branch EXISTS in this scenario — its fetch succeeds like real git.
                responses['git -c fetch.recurseSubmodules=no fetch origin ai/PROJ-1:ai/PROJ-1'] = '';
                var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
                    cli_execute_command: makeFirstRunCli(calls, responses)
                });
                mod.checkoutBranch('PROJ-1', config, TICKET, {});
                assert.ok(calls.indexOf('git checkout ai/PROJ-1') !== -1,
                    'an existing branch (noise-polluted capture) must still be checked out, got: ' + JSON.stringify(calls));
            });
    });

    test('existing-work report: warning-only capture means a FRESH leg, no resumed-leg warning file', function() {
        var calls = [];
        var writes = [];
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-1' }, 'main', null, []);
        var responses = {};
        responses['git ls-remote --heads origin ai/PROJ-1'] = WARNING;
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeFirstRunCli(calls, responses),
            file_write: function(args) { writes.push(args); }
        });

        var result = mod.reportExistingDevBranch('PROJ-1', makeConfig({ git: { featureBranch: { enabled: false } } }), TICKET, 'input/PROJ-1');

        assert.equal(result, false, 'a warning-only capture must report a fresh development leg');
        assert.equal(writes.length, 0, 'no existing_work.md may be written from stderr noise');
    });

});

// ── gh-1042: action()-level branch characterization ─────────────────────────
// Pins the CURRENT behaviour of the paths the CRAP refactor of action() touches
// (param resolution, status move, restore, checkout failure reporting, setup
// commands/warnings, fetch extras). The suite must stay green through the
// extraction.

suite('preCliDevelopmentSetup.action — branch-coverage characterization (gh-1042)', function() {

    function make1042Config(extra) {
        return makeConfig(Object.assign({
            git: { baseBranch: 'main', featureBranch: { enabled: false } },
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        }, extra || {}));
    }

    // Compact action loader: same wiring as the gh-716 suite, with per-test
    // stubs for restore/setupCommands/fetch extras and injected globals
    // (e.g. github_create_comment) that reach the real trackers module.
    // Defaults live in an Object.assign map — every `||` would raise the
    // loader's own CRAP (gh-1042 gate measures test files too).
    function loadActionGh1042(bag, config, globals, opts) {
        opts = Object.assign({
            resolveBranchNameThrows: false,
            restoreFromReleases: { action: function () {} },
            setupCommands: {
                runSetupCommands: function () { return null; },
                buildSetupWarningsMarkdown: function () { return null; },
                truncateSetupError: function (s) { return String(s); }
            },
            fetchLinkedTests: { action: function () {} },
            fetchParentContext: { action: function () {} }
        }, opts || {});
        globals = globals || {};
        var trackers = loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }), globals);
        return loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
                'gitStaging.js': loadModule('js/common/gitStaging.js'),
                './configLoader.js': {
                    loadProjectConfig: function () { return config; },
                    paramsForConfigLoad: function (p) { return p; },
                    resolveBranchName: function (cfg, ticket, role) {
                        if (opts.resolveBranchNameThrows) { throw new Error('branch resolve boom'); }
                        return (role === 'development' ? 'ai/' : 'feature/') + ticket.key;
                    },
                    resolvePRTargetBranch: function () { return 'main'; },
                    loadHookFn: function () { return null; }
                },
                './common/pullRequest.js': PR_HELPER_REAL,
                './config.js': NOOP_CONFIG_JS,
                './fetchQuestionsToInput.js': { action: function () {} },
                './fetchLinkedTestsToInput.js': opts.fetchLinkedTests,
                './fetchParentContextToInput.js': opts.fetchParentContext,
                './restoreFromReleases.js': opts.restoreFromReleases,
                './common/setupCommands.js': opts.setupCommands,
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function () {} },
                './common/developmentModePlan.js': devDevelopmentModePlanReal,
                './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
                './common/commentMarkup.js': devCommentMarkupModule,
                './common/legFailureReport.js': legFailureReportModule,
                './common/legStartSignal.js': legStartSignalReal,
                './common/trackers.js': trackers
            }),
            Object.assign({
                cli_execute_command: makeCliMock(bag.cliCalls, {}),
                jira_move_to_status: function (args) { bag.moves.push(args); },
                file_write: function (args) { bag.writes.push(args); },
                github_add_labels: function (args) { bag.events.push({ op: 'add', args: args }); },
                github_remove_label: function (args) { bag.events.push({ op: 'remove', args: args }); }
            }, globals)
        );
    }

    function make1042Bag() {
        return { cliCalls: [], moves: [], writes: [], events: [] };
    }

    var GH1042_TICKET = { key: 'gh-1042', fields: {} };

    function run1042Action(mod, params) {
        var threw = null;
        try {
            mod.action(params);
        } catch (e) {
            threw = e;
        }
        return threw;
    }

    test('jobParams-only params are honoured (no top-level inputFolderPath)', function() {
        var bag = make1042Bag();
        var mod = loadActionGh1042(bag, make1042Config());

        var threw = run1042Action(mod, { jobParams: { inputFolderPath: 'input/gh-1042', customParams: {} }, ticket: GH1042_TICKET });

        assert.equal(threw, null);
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/gh-1042') !== -1,
            'branch setup ran with the ticket key derived from jobParams');
    });

    test('ticket status move failure is a warning only — setup continues', function() {
        var bag = make1042Bag();
        var mod = loadActionGh1042(bag, make1042Config({ tracker: { provider: 'jira' } }), {
            jira_move_to_status: function () { throw new Error('jira down'); }
        });

        var threw = run1042Action(mod, { inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1', fields: {} }, customParams: {} });

        assert.equal(threw, null);
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/PROJ-1') !== -1,
            'branch setup still ran after the status move failed');
    });

    test('restoreFromReleases failure is non-fatal', function() {
        var bag = make1042Bag();
        var mod = loadActionGh1042(bag, make1042Config(), {}, {
            restoreFromReleases: { action: function () { throw new Error('release fetch failed'); } }
        });

        var threw = run1042Action(mod, { inputFolderPath: 'input/gh-1042', ticket: GH1042_TICKET, customParams: {} });

        assert.equal(threw, null);
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/gh-1042') !== -1,
            'branch setup still ran after the restore step failed');
    });

    test('branch checkout failure posts a Git Branch Setup error comment and stops the leg', function() {
        var bag = make1042Bag();
        var comments = [];
        var mod = loadActionGh1042(bag, make1042Config(), {
            github_create_comment: function (args) { comments.push(args); }
        }, { resolveBranchNameThrows: true });

        var threw = run1042Action(mod, { inputFolderPath: 'input/gh-1042', ticket: GH1042_TICKET, customParams: {} });

        assert.ok(threw, 'leg stops when the branch cannot be prepared');
        assert.contains(threw.toString(), 'Git branch setup failed');
        assert.equal(comments.length, 1, 'exactly one setup-error comment');
        assert.ok(comments[0].text.indexOf('### **Development Setup Error**') === 0,
            'github ticket renders markdown flavor, got: ' + comments[0].text);
        assert.contains(comments[0].text, '**Stage:** Git Branch Setup');
        assert.contains(comments[0].text, 'branch resolve boom');
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/gh-1042') === -1,
            'no checkout was possible past the branch resolution failure');
    });

    test('environment setup failure posts an Environment Setup error comment and stops the leg', function() {
        var bag = make1042Bag();
        var comments = [];
        var mod = loadActionGh1042(bag, make1042Config(), {
            github_create_comment: function (args) { comments.push(args); }
        }, {
            setupCommands: {
                runSetupCommands: function () { throw new Error('npm ci failed'); },
                buildSetupWarningsMarkdown: function () { return null; },
                truncateSetupError: function (s) { return String(s); }
            }
        });

        var threw = run1042Action(mod, { inputFolderPath: 'input/gh-1042', ticket: GH1042_TICKET, customParams: {} });

        assert.ok(threw, 'leg stops when the environment cannot be prepared');
        assert.contains(threw.toString(), 'Environment setup failed');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].text, '**Stage:** Environment Setup');
        assert.contains(comments[0].text, 'npm ci failed');
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/gh-1042') !== -1,
            'branch setup ran BEFORE the environment step failed');
    });

    test('setup warnings are written to setup_warnings.md (non-fatal)', function() {
        var bag = make1042Bag();
        var mod = loadActionGh1042(bag, make1042Config(), {}, {
            setupCommands: {
                runSetupCommands: function () { return { warnings: ['jdk missing'] }; },
                buildSetupWarningsMarkdown: function (result) { return '# Setup Warnings\n' + result.warnings.join('\n'); },
                truncateSetupError: function (s) { return String(s); }
            }
        });

        var threw = run1042Action(mod, { inputFolderPath: 'input/gh-1042', ticket: GH1042_TICKET, customParams: {} });

        assert.equal(threw, null);
        var warningWrites = bag.writes.filter(function (w) { return w.path === 'input/gh-1042/setup_warnings.md'; });
        assert.equal(warningWrites.length, 1, 'exactly one setup_warnings.md write');
        assert.equal(warningWrites[0].content, '# Setup Warnings\njdk missing');
    });

    test('setup_warnings.md write failure is a warning only — setup continues', function() {
        var bag = make1042Bag();
        var mod = loadActionGh1042(bag, make1042Config(), {
            file_write: function (args) {
                bag.writes.push(args);
                if (args.path.indexOf('setup_warnings.md') !== -1) { throw new Error('disk full'); }
            }
        }, {
            setupCommands: {
                runSetupCommands: function () { return { warnings: ['jdk missing'] }; },
                buildSetupWarningsMarkdown: function (result) { return '# Setup Warnings\n' + result.warnings.join('\n'); },
                truncateSetupError: function (s) { return String(s); }
            }
        });

        var threw = run1042Action(mod, { inputFolderPath: 'input/gh-1042', ticket: GH1042_TICKET, customParams: {} });

        assert.equal(threw, null, 'an unwritable setup_warnings.md must not fail the leg');
    });

    test('linked-tests and parent-context fetch failures are non-fatal', function() {
        var bag = make1042Bag();
        var mod = loadActionGh1042(bag, make1042Config(), {}, {
            fetchLinkedTests: { action: function () { throw new Error('jira down'); } },
            fetchParentContext: { action: function () { throw new Error('confluence down'); } }
        });

        var threw = run1042Action(mod, { inputFolderPath: 'input/gh-1042', ticket: GH1042_TICKET, customParams: {} });

        assert.equal(threw, null);
        assert.ok(bag.cliCalls.indexOf('git checkout -b ai/gh-1042') !== -1, 'setup completed through the extras');
    });

});

suite('preCliDevelopmentSetup — extracted helpers (gh-1042)', function() {

    // Direct tests for the parse*/build*/decide* helpers extracted from
    // action() — pins their contracts so action()'s CRAP stays low with
    // full coverage on the helpers.

    function loadHelpersOnly(globals) {
        return loadPreCliDevelopmentSetup({
            loadProjectConfig: function () { return makeConfig(); },
            paramsForConfigLoad: function (p) { return p; }
        }, globals || {});
    }

    test('parseActualParams: direct params vs jobParams vs bare params', function() {
        var mod = loadHelpersOnly();
        var direct = { inputFolderPath: 'input/PROJ-1' };
        assert.equal(mod.parseActualParams(direct), direct);
        var wrapped = { jobParams: { inputFolderPath: 'input/PROJ-1' } };
        assert.equal(mod.parseActualParams(wrapped), wrapped.jobParams);
        var bare = { customParams: {} };
        assert.equal(mod.parseActualParams(bare), bare);
    });

    test('parseCustomParams: jobParams wins over actualParams', function() {
        var mod = loadHelpersOnly();
        assert.deepEqual(mod.parseCustomParams({ jobParams: { customParams: { a: 1 } } }, { customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(mod.parseCustomParams({}, { customParams: { b: 2 } }), { b: 2 });
        assert.equal(mod.parseCustomParams({}, {}), undefined,
            'no customParams anywhere stays undefined (tracker factory tolerates it)');
    });

    test('parseTicketKeyOf: folder basename', function() {
        var mod = loadHelpersOnly();
        assert.equal(mod.parseTicketKeyOf('input/PROJ-1'), 'PROJ-1');
        assert.equal(mod.parseTicketKeyOf('input/gh-1042'), 'gh-1042');
    });

    test('decideErrorMessage: Error objects and plain values', function() {
        var mod = loadHelpersOnly();
        assert.equal(mod.decideErrorMessage(new Error('boom')), 'Error: boom');
        assert.equal(mod.decideErrorMessage('plain'), 'plain');
        assert.equal(mod.decideErrorMessage(null), 'null');
    });

    test('checkoutBranchOrReport: failure posts the Git Branch Setup comment and rethrows', function() {
        var comments = [];
        var posted = [];
        var mod = loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
                'gitStaging.js': loadModule('js/common/gitStaging.js'),
                './configLoader.js': {
                    loadProjectConfig: function () { return makeConfig(); },
                    paramsForConfigLoad: function (p) { return p; }
                },
                './common/pullRequest.js': PR_HELPER_REAL,
                './config.js': NOOP_CONFIG_JS,
                './fetchQuestionsToInput.js': NOOP_MODULE,
                './fetchLinkedTestsToInput.js': NOOP_MODULE,
                './fetchParentContextToInput.js': NOOP_MODULE,
                './restoreFromReleases.js': NOOP_MODULE,
                './common/setupCommands.js': devSetupCommandsReal,
                './common/commentMarkup.js': devCommentMarkupModule,
                './common/legFailureReport.js': legFailureReportModule,
                './common/legStartSignal.js': legStartSignalReal,
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function () {} },
                './common/developmentModePlan.js': devDevelopmentModePlanReal,
                './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
                './common/trackers.js': {
                    createTracker: function () {
                        return {
                            provider: function () { return 'stub'; },
                            postComment: function (ticketKey, text) { posted.push({ key: ticketKey, text: text }); }
                        };
                    }
                }
            }),
            {
                cli_execute_command: function (opts) {
                    if (opts.command === 'git branch --list "ai/PROJ-9"') { throw new Error('git exploded'); }
                    return '';
                }
            }
        );

        // configLoader stub without resolveBranchName → checkoutBranch throws.
        var threw = null;
        try {
            mod.checkoutBranchOrReport(makeConfig(), {}, 'PROJ-9', { inputFolderPath: 'input/PROJ-9' }, {});
        } catch (e) {
            threw = e;
        }

        assert.ok(threw, 'checkout failure must rethrow');
        assert.contains(threw.toString(), 'Git branch setup failed');
        assert.equal(posted.length, 1, 'the setup error comment went through the probed tracker');
        assert.equal(posted[0].key, 'PROJ-9');
        assert.contains(posted[0].text, 'Git Branch Setup');
    });

    test('moveTicketToInDevelopment: tracker failure is a warning only', function() {
        var mod = loadHelpersOnly();
        // tracker factory (real trackers module, no provider configured) throws
        // on unknown provider — the step must swallow it.
        var threw = null;
        try {
            mod.moveTicketToInDevelopment({}, null, 'PROJ-1', { IN_DEVELOPMENT: 'In Development' });
        } catch (e) {
            threw = e;
        }
        assert.equal(threw, null, 'a failing status move must not propagate');
    });

});

// ── gh-1190: checkoutBranch seam split — helper characterization ─────────────

suite('preCliDevelopmentSetup.checkoutBranch — seam helpers (gh-1190)', function() {

    test('configureSetupAuthor issues user.name then user.email; failures are warnings', function() {
        var calls = [];
        var mod = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
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
            mod.configureSetupAuthor(makeConfig());
            assert.deepEqual(calls, ['git config user.name "AI Teammate"'], 'only user.name ran before the failure');
            assert.equal(warnings.length, 1, 'failure is a warning, not a throw');
            assert.contains(warnings[0], 'Failed to configure git author');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('fetchDevBranchRefs uses the targeted two-branch refspec and swallows failures', function() {
        var calls = [];
        var mod = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
            cli_execute_command: function(opts) { calls.push(opts.command); return ''; }
        });
        mod.fetchDevBranchRefs('ai/PROJ-1', 'master');
        assert.deepEqual(calls, [
            'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/ai/PROJ-1:refs/remotes/origin/ai/PROJ-1 +refs/heads/master:refs/remotes/origin/master'
        ], 'exactly the dev + rebase-base branches, forced refspecs, no blanket fetch');

        var failing = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
            cli_execute_command: function() { throw new Error('network down'); }
        });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            assert.doesNotThrow(function() { failing.fetchDevBranchRefs('ai/PROJ-1', 'master'); },
                'a fetch failure must not throw out of setup');
            assert.equal(warnings.length, 1);
            assert.contains(warnings[0], 'Could not fetch remote branches');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('readLocalBranchList cleans the capture, warns only when told to', function() {
        var responses = {};
        responses['git branch --list "ai/PROJ-1"'] = '  ai/PROJ-1\nScript done\n';
        var mod = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
            cli_execute_command: makeCliMock([], responses)
        });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            assert.equal(mod.readLocalBranchList('ai/PROJ-1', 'Error checking local branches:'), 'ai/PROJ-1');
            assert.deepEqual(warnings, [], 'no warning on a succeeding probe');

            var failing = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
                cli_execute_command: function() { throw new Error('git down'); }
            });
            assert.equal(failing.readLocalBranchList('ai/PROJ-1', 'Error checking local branches:'), '');
            assert.equal(warnings.length, 1);
            assert.contains(warnings[0], 'Error checking local branches:');
            assert.equal(failing.readLocalBranchList('ai/PROJ-1', null), '', 'silent probe stays silent');
            assert.equal(warnings.length, 1);
        } finally {
            console.warn = originalWarn;
        }
    });

    test('probeRemoteBranch classifies on the strict ref line; failures are warnings', function() {
        var mod = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
            cli_execute_command: function(opts) {
                if (opts.command === 'git ls-remote --heads origin ai/PROJ-1') {
                    return '0123456789abcdef0123456789abcdef01234567\trefs/heads/ai/PROJ-1\n';
                }
                return 'warning: redirecting to https://example.com/\n';
            }
        });
        assert.equal(mod.probeRemoteBranch('ai/PROJ-1', 'Error checking remote branches:'), true);
        assert.equal(mod.probeRemoteBranch('absent-branch', 'Error checking remote branches:'), false,
            'a warning-only capture classifies as absent (gh-912)');

        var failing = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
            cli_execute_command: function() { throw new Error('network down'); }
        });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            assert.equal(failing.probeRemoteBranch('ai/PROJ-1', 'Error checking remote branches:'), false);
            assert.equal(warnings.length, 1);
            assert.equal(failing.probeRemoteBranch('ai/PROJ-1', null), false);
            assert.equal(warnings.length, 1, 'silent probe stays silent');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('establishFeatureBranch: local-only → plain checkout, no creation', function() {
        var calls = [];
        var hookLoadCalls = [];
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            { development: 'ai/PROJ-1', feature: 'release/rc' },
            'master',
            null,
            hookLoadCalls
        );
        var responses = {};
        responses['git branch --list "release/rc"'] = 'release/rc';
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses)
        });

        var feature = mod.establishFeatureBranch(config, {}, TICKET);
        assert.equal(feature, 'release/rc');
        assert.deepEqual(calls, [
            'git branch --list "release/rc"',
            'git ls-remote --heads origin release/rc',
            'git checkout release/rc'
        ]);
        assert.equal(hookLoadCalls.length, 0);
    });

    test('createNewDevBranch: feature branch becomes the base; explicit refspec before checkout', function() {
        var calls = [];
        var hookLoadCalls = [];
        var config = makeConfig();
        var configLoaderStub = makeConfigLoaderStub(
            { development: 'ai/PROJ-1', feature: 'release/rc' },
            'master',
            null,
            hookLoadCalls
        );
        var responses = {};
        responses['git branch --list "release/rc"'] = 'release/rc';
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses)
        });

        mod.createNewDevBranch(config, {}, TICKET, 'ai/PROJ-1');
        assert.deepEqual(calls, [
            'git branch --list "release/rc"',
            'git ls-remote --heads origin release/rc',
            'git checkout release/rc',
            'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/release/rc:refs/remotes/origin/release/rc',
            'git checkout -B release/rc origin/release/rc',
            'git checkout -b ai/PROJ-1'
        ], 'two-branch base resolution, then the explicit-refspec ensure + hard checkout + dev-branch create');
    });

    test('checkoutExistingRemoteBranch aligns with base after fetch+checkout; falls back to hard reset', function() {
        var calls = [];
        var responses = {};
        responses['git -c fetch.recurseSubmodules=no fetch origin ai/PROJ-1:ai/PROJ-1'] = '';
        var mod = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
            cli_execute_command: function(opts) {
                var command = opts && opts.command;
                calls.push(command);
                if (command === 'git merge-base --is-ancestor HEAD origin/master') throw new Error('not ancestor');
                if (command === 'git cherry origin/master HEAD') return '-commit1\n';
                if (responses[command] !== undefined) return responses[command];
                return '';
            }
        });
        mod.checkoutExistingRemoteBranch('PROJ-1', 'ai/PROJ-1', 'master');
        assert.ok(calls.indexOf('git -c fetch.recurseSubmodules=no fetch origin ai/PROJ-1:ai/PROJ-1') !== -1,
            'explicit branch fetch first');
        assert.ok(calls.indexOf('git checkout ai/PROJ-1') !== -1);
        assert.ok(calls.indexOf('git cherry origin/master HEAD') !== -1, 'alignment ran after checkout');
        assert.ok(calls.indexOf('git reset --hard origin/master') !== -1,
            'no unique patches → branch resets onto the base (alignment decision)');
    });

    test('checkoutExistingRemoteBranch falls back to ensureRemoteBranchRef + checkout -B on fetch failure', function() {
        // Fallback: fetch+checkout throws → ensureRemoteBranchRef + checkout -B from origin.
        var fallbackCalls = [];
        var failing = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
            cli_execute_command: function(opts) {
                var command = opts && opts.command;
                fallbackCalls.push(command);
                if (command.indexOf('git -c fetch.recurseSubmodules=no fetch origin ai/PROJ-1:ai/PROJ-1') === 0) {
                    throw new Error('fetch failed');
                }
                return '';
            }
        });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            failing.checkoutExistingRemoteBranch('PROJ-1', 'ai/PROJ-1', 'master');
            assert.ok(fallbackCalls.indexOf('git checkout -B ai/PROJ-1 origin/ai/PROJ-1') !== -1,
                'hard reset from origin when fetch+checkout fails');
            assert.contains(warnings.join('\n'), 'fetch+checkout failed, resetting local branch from origin');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('checkoutLocalBranchWithAlign checks out then aligns with base', function() {
        var calls = [];
        var mod = loadPreCliDevelopmentSetup(makeConfigLoaderStub({}, 'master'), {
            cli_execute_command: function(opts) {
                var command = opts && opts.command;
                calls.push(command);
                if (command === 'git merge-base --is-ancestor HEAD origin/master') throw new Error('not ancestor');
                if (command === 'git cherry origin/master HEAD') return '+uniquepatch\n';
                if (command === 'git merge-base --is-ancestor origin/master HEAD') throw new Error('diverged');
                if (command === 'git merge-tree <base> HEAD origin/master') return '';
                return '';
            }
        });
        var warnings = [];
        var writes = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            mod.checkoutLocalBranchWithAlign('PROJ-1', 'ai/PROJ-1', 'master');
            assert.equal(calls[0], 'git checkout -- .dmtools-target-workingdir',
                'gh-1358: runtime-artifact reset runs before the checkout');
            assert.equal(calls[1], 'git rm --cached --ignore-unmatch .dmtools-target-workingdir',
                'gh-1358: runtime-artifact untrack follows the reset');
            assert.equal(calls[2], 'git checkout ai/PROJ-1', 'checkout runs first');
            assert.ok(calls.indexOf('git cherry origin/master HEAD') !== -1, 'alignment follows the checkout');
            assert.ok(calls.indexOf('git reset --hard origin/master') === -1,
                'a unique-patch diverged branch is NOT reset');
            assert.contains(warnings.join('\n'), 'Keeping divergent branch ai/PROJ-1');
        } finally {
            console.warn = originalWarn;
        }
    });

});

// ── gh-1229 characterization: reportExistingDevBranch degradation branches
//    pinned before helper extraction (direct calls, scripted git). ──
suite('preCliDevelopmentSetup.reportExistingDevBranch — degradation branches (gh-1229)', function () {

    var REPORT_CONFIG = makeConfig({ git: { featureBranch: { enabled: false } } });

    function branchExists(calls, responses) {
        responses['git ls-remote --heads origin ai/PROJ-7'] = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/ai/PROJ-7';
    }

    function loadReporter(calls, responses, writes, fileWriteImpl) {
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-7' }, 'main', null, []);
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: makeCliMock(calls, responses),
            file_write: fileWriteImpl || function (args) { writes.push(args); }
        });
        return mod;
    }

    test('a failing rev-list count degrades to "?" without aborting the report', function () {
        var calls = [];
        var writes = [];
        var responses = {};
        branchExists(calls, responses);
        // rev-list missing from responses? No — makeCliMock returns '' for
        // unknown commands; force the failure by throwing instead.
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-7' }, 'main', null, []);
        var mod = loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: function (opts) {
                var command = opts && opts.command;
                calls.push(command);
                if (command.indexOf('git rev-list --count') === 0) throw new Error('rev-list exploded');
                if (responses[command] !== undefined) return responses[command];
                return '';
            },
            file_write: function (args) { writes.push(args); }
        });

        var result = mod.reportExistingDevBranch('PROJ-7', REPORT_CONFIG, TICKET, 'input/PROJ-7');

        assert.equal(result, true, 'the report is still written');
        assert.contains(writes[0].content, 'Commits ahead of base: ?',
            'the "?" placeholder marks the failed count');
        assert.contains(writes[0].content, '(no diff)', 'empty diff renders as (no diff)');
    });

    test('a failed existing_work.md write is non-fatal and the step still reports true', function () {
        var calls = [];
        var responses = {};
        branchExists(calls, responses);
        var mod = loadReporter(calls, responses, [], function () { throw new Error('disk full'); });

        var result = mod.reportExistingDevBranch('PROJ-7', REPORT_CONFIG, TICKET, 'input/PROJ-7');

        assert.equal(result, true, 'the branch genuinely exists — the step must still report it');
    });

    test('an empty log omits the commits section from the report', function () {
        var calls = [];
        var writes = [];
        var responses = {};
        branchExists(calls, responses);
        responses['git rev-list --count --right-only origin/main...origin/ai/PROJ-7'] = '0';
        responses['git log --oneline -20 origin/main..origin/ai/PROJ-7'] = '';
        responses['git diff --shortstat origin/main...origin/ai/PROJ-7'] = ' 2 files changed';
        var mod = loadReporter(calls, responses, writes);

        var result = mod.reportExistingDevBranch('PROJ-7', REPORT_CONFIG, TICKET, 'input/PROJ-7');

        assert.equal(result, true);
        assert.notContains(writes[0].content, '## Commits ahead of base',
            'no commit list section when the log is empty');
        assert.contains(writes[0].content, 'Diff vs base: 2 files changed');
    });

    test('helper exports keep the report-building contract', function () {
        var mod = loadReporter([], {}, []);
        var content = mod.buildExistingWorkReport('ai/PROJ-7', 'origin/main', 'origin/ai/PROJ-7', {
            commitsAhead: '2', logLines: 'a1 one', diffStat: ' 1 file changed'
        });
        assert.contains(content, '# Existing Work on Remote Branch');
        assert.contains(content, 'Commits ahead of base: 2');
        assert.contains(content, '## Commits ahead of base');
        assert.contains(content, 'Diff vs base:  1 file changed',
            'the diff stat passes through verbatim (trimming is the metric collector\'s job)');

        var minimal = mod.buildExistingWorkReport('ai/PROJ-7', 'origin/main', 'origin/ai/PROJ-7', {
            commitsAhead: '0', logLines: '', diffStat: ''
        });
        assert.contains(minimal, 'Diff vs base: (no diff)');
        assert.notContains(minimal, '## Commits ahead of base');
    });
});

suite('preCliDevelopmentSetup.writeDevBaseHead (gh-1308)', function () {

    function loadWithMocks(cliFn, writeFn) {
        var configLoaderStub = makeConfigLoaderStub({ development: 'ai/PROJ-1' }, 'main', null, []);
        return loadPreCliDevelopmentSetup(configLoaderStub, {
            cli_execute_command: cliFn,
            file_write: writeFn || function () { }
        });
    }

    test('writes dev_base_head.txt when git rev-parse HEAD returns a valid SHA', function () {
        var writes = [];
        var mod = loadWithMocks(function (opts) {
            if (opts.command === 'git rev-parse HEAD') return 'abc1234567890\n';
            return '';
        }, function (args) { writes.push(args); });

        mod.writeDevBaseHead('input/PROJ-1');

        assert.equal(writes.length, 1);
        assert.equal(writes[0].path, 'input/PROJ-1/dev_base_head.txt');
        assert.equal(writes[0].content, 'abc1234567890');
    });

    test('skips write when folder is missing or SHA is invalid', function () {
        var writes = [];
        var mod = loadWithMocks(function () { return 'not-a-sha'; }, function (args) { writes.push(args); });

        mod.writeDevBaseHead(null);
        mod.writeDevBaseHead('input/PROJ-1');

        assert.equal(writes.length, 0);
    });

    test('swallows git or file_write errors with a warning', function () {
        var mod = loadWithMocks(function () { throw new Error('git boom'); });
        assert.doesNotThrow(function () { mod.writeDevBaseHead('input/PROJ-1'); });
    });
});

// ── gh-1318: regenerated input/ wins over the branch-tracked stale copy ──────
// Single-repo deployments have no cleaner in this setup path: the freshly
// regenerated input/ collided with the ask-mode WIP snapshot's branch-tracked
// input/ and `git checkout` REFUSED ("untracked working tree files would be
// overwritten") — after moveTicketToInDevelopment had already stranded the
// ticket. Real-git tests over a mktemp repo: the fresh copy is stashed aside
// before branch setup and overlaid back afterwards; the status move happens
// only after branch setup succeeds.

suite('preCliDevelopmentSetup — fresh leg input survives branch setup (gh-1318, real git)', function() {

    // Runtime gate (see test_checkoutBranch.js): the node coverage harness
    // runs cli_execute_command against the pack root and ignores
    // workingDirectory — real git there would mutate the agents repo, so the
    // suite self-skips; the dmtools runner executes the repro for real.
    var REAL_GIT_SUPPORTED = (function () {
        try {
            var tmp = String(cli_execute_command({ command: 'bash -c "mktemp -d"' })).trim();
            var pwd = String(cli_execute_command({ command: 'bash -c "pwd"', workingDirectory: tmp })).trim();
            cli_execute_command({ command: 'bash -c "rm -rf ' + tmp + '"' });
            return pwd === tmp;
        } catch (e) {
            return false;
        }
    })();

    function requireRealGitRuntime() {
        if (REAL_GIT_SUPPORTED) return true;
        assert.ok(true, 'skipped — this runtime ignores workingDirectory (node coverage harness); the real-git repro runs under the dmtools runner');
        return false;
    }

    var FRESH = 'FRESH - reporter answered: credentials are testuser/testpass';
    var STALE = 'STALE - pre-answer ticket comments';
    var MOVE_MARKER = 'TRACKER: move to In Development';

    function git(cmd, dir) {
        return cli_execute_command({ command: cmd, workingDirectory: dir });
    }

    function makeCollisionRepo() {
        var tmp = String(cli_execute_command({ command: 'bash -c "mktemp -d"' })).trim();
        git('git init', tmp);
        var base = String(git('git symbolic-ref --short HEAD', tmp)).trim();
        git('git config user.name "Test Agent"', tmp);
        git('git config user.email "agent@example.com"', tmp);
        file_write({ path: tmp + '/README.md', content: 'seed\n' });
        git('git add README.md', tmp);
        git('git commit -m seed', tmp);
        git('git checkout -b ai/BUG-1', tmp);
        file_write({ path: tmp + '/input/TICKET/comments.md', content: STALE });
        git('git add -A', tmp);
        git('git commit -m "ask-mode WIP snapshot"', tmp);
        git('git checkout ' + base, tmp);
        file_write({ path: tmp + '/input/TICKET/comments.md', content: FRESH });
        return { tmp: tmp, base: base };
    }

    function make1314ConfigLoaderStub(repo) {
        return {
            loadProjectConfig: function() {
                return makeConfig({
                    git: { baseBranch: repo.base, featureBranch: { enabled: false } },
                    workingDir: repo.tmp,
                    tracker: { provider: 'jira' }
                });
            },
            paramsForConfigLoad: function(p) { return p; },
            resolveBranchName: function(cfg, ticket, role) { return 'ai/BUG-1'; },
            resolvePRTargetBranch: function() { return repo.base; },
            loadHookFn: function() { return null; }
        };
    }

    // CRAP ratchet (quality.yml): these real-git repro suites self-skip in the
    // node coverage harness, so every helper below measures ~0% coverage there
    // — CRAP = cc²·(1−cov)³ + cc then grows past the threshold 8 at cc = 3
    // (gh-1318 rework: loadForRealGit scored 10.5). Keep EACH helper at
    // cyclomatic complexity ≤ 2: the command spy owns the `opts && opts.command`
    // guard, the mocks builder owns the `extraGlobals || {}` default, and the
    // require map stays branch-free.
    function makeRealGitCliSpy(calls) {
        return function(opts) {
            calls.push(opts && opts.command);
            return cli_execute_command(opts);
        };
    }

    function makeRealGitMocks(calls, fileWrites, extraGlobals) {
        return Object.assign({
            cli_execute_command: makeRealGitCliSpy(calls),
            jira_move_to_status: function(args) {
                calls.push(MOVE_MARKER);
                fileWrites.push({ path: '@move', content: JSON.stringify(args) });
            },
            file_write: function(args) { fileWrites.push(args); return null; },
            file_read: function() { return ''; }
        }, extraGlobals || {});
    }

    function makeRealGitRequireMap(repo, trackers, mocks) {
        return makeRequire({
            'branchSetup.js': loadModule('js/common/branchSetup.js', null, mocks),
            'gitStaging.js': loadModule('js/common/gitStaging.js'),
            './configLoader.js': make1314ConfigLoaderStub(repo),
            './common/pullRequest.js': PR_HELPER_REAL,
            './config.js': NOOP_CONFIG_JS,
            './fetchQuestionsToInput.js': { action: function() {} },
            './fetchLinkedTestsToInput.js': { action: function() {} },
            './fetchParentContextToInput.js': { action: function() {} },
            './restoreFromReleases.js': { action: function() {} },
            './common/setupCommands.js': {
                runSetupCommands: function() { return null; },
                buildSetupWarningsMarkdown: function() { return null; },
                truncateSetupError: function(s) { return String(s); }
            },
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
            './common/commentMarkup.js': devCommentMarkupModule,
            './common/legFailureReport.js': legFailureReportModule,
            './common/legStartSignal.js': legStartSignalReal,
            './common/developmentModePlan.js': devDevelopmentModePlanReal,
            './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
            './common/trackers.js': trackers
        });
    }

    function loadForRealGit(repo, extraGlobals) {
        var calls = [];
        var fileWrites = [];
        var mocks = makeRealGitMocks(calls, fileWrites, extraGlobals);
        var trackers = loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }), mocks);
        var mod = loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRealGitRequireMap(repo, trackers, mocks),
            mocks
        );
        return { mod: mod, calls: calls, fileWrites: fileWrites };
    }

    test('branch-tracked input/ collision no longer aborts — fresh copy wins, checkout completes', function() {
        if (!requireRealGitRuntime()) return;
        var repo = makeCollisionRepo();
        var ctx = loadForRealGit(repo, {});

        ctx.mod.action({ inputFolderPath: 'input/BUG-1', ticket: { key: 'BUG-1', fields: {} }, customParams: {} });

        assert.ok(ctx.calls.indexOf('git checkout ai/BUG-1') !== -1, 'the collision checkout ran instead of refusing');
        assert.equal(String(git('git symbolic-ref --short HEAD', repo.tmp)).trim(), 'ai/BUG-1',
            'the dev branch is checked out');
        assert.contains(file_read({ path: repo.tmp + '/input/TICKET/comments.md' }), 'FRESH - reporter answered',
            'the fresh reporter answer wins over the branch-tracked stale snapshot');
        assert.equal(String(git('git ls-files -- input outputs', repo.tmp)), '',
            'the branch no longer tracks leg context (heal ran in the working dir)');
    });

    test('the ticket moves to In Development only AFTER branch setup succeeded', function() {
        if (!requireRealGitRuntime()) return;
        var repo = makeCollisionRepo();
        var ctx = loadForRealGit(repo, {});

        ctx.mod.action({ inputFolderPath: 'input/BUG-1', ticket: { key: 'BUG-1', fields: {} }, customParams: {} });

        var checkoutIdx = ctx.calls.indexOf('git checkout ai/BUG-1');
        var moveIdx = ctx.calls.indexOf(MOVE_MARKER);
        assert.ok(checkoutIdx !== -1, 'branch setup ran');
        assert.ok(moveIdx !== -1, 'the status move ran on the success path');
        assert.ok(checkoutIdx < moveIdx, 'status move comes after the checkout (gh-1318 ordering)');
    });

    test('branch setup failure leaves the ticket OUT of In Development (no stranded status)', function() {
        if (!requireRealGitRuntime()) return;
        var repo = makeCollisionRepo();
        var calls = [];
        var moves = [];
        var stub = make1314ConfigLoaderStub(repo);
        stub.resolveBranchName = function() { throw new Error('branch resolve boom'); };
        var mocks = {
            cli_execute_command: function(opts) {
                calls.push(opts && opts.command);
                return cli_execute_command(opts);
            },
            jira_move_to_status: function(args) { moves.push(args); },
            file_write: function() { return null; },
            file_read: function() { return ''; }
        };
        var mod = loadPreCliDevelopmentSetup(stub, mocks);

        var threw = null;
        try {
            mod.action({ inputFolderPath: 'input/BUG-1', ticket: { key: 'BUG-1', fields: {} }, customParams: {} });
        } catch (e) {
            threw = e;
        }

        assert.ok(threw, 'the setup failure still stops the leg');
        assert.contains(threw.toString(), 'Git branch setup failed');
        assert.equal(moves.length, 0, 'no In Development move — the ticket stays in the reporter\'s lane');
    });

});

suite('preCliDevelopmentSetup.action — dryRun guard (gh-1356)', function() {

    test('dryRun:true skips cli_execute_command and tracker/SCM writes while allowing context fetch', function() {
        var cliCalls = [];
        var trackerMoves = [];
        var labelCalls = [];
        var questionsFetched = 0;
        var linkedTestsFetched = 0;
        var parentContextFetched = 0;

        var mod = loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({
                'branchSetup.js': loadModule('js/common/branchSetup.js'),
                'gitStaging.js': loadModule('js/common/gitStaging.js'),
                './configLoader.js': {
                    loadProjectConfig: function() { return makeConfig({ repository: { owner: 'o', repo: 'r' } }); },
                    paramsForConfigLoad: function(p) { return p; },
                    resolveBranchName: function() { return 'ai/PROJ-1'; },
                    resolvePRTargetBranch: function() { return 'master'; }
                },
                './common/pullRequest.js': PR_HELPER_REAL,
                './config.js': NOOP_CONFIG_JS,
                './fetchQuestionsToInput.js': { action: function() { questionsFetched++; } },
                './fetchLinkedTestsToInput.js': { action: function() { linkedTestsFetched++; } },
                './fetchParentContextToInput.js': { action: function() { parentContextFetched++; } },
                './restoreFromReleases.js': { action: function() { throw new Error('restoreFromReleases must not run in dryRun'); } },
                './common/setupCommands.js': devSetupCommandsReal,
                './common/commentMarkup.js': devCommentMarkupModule,
                './common/legFailureReport.js': legFailureReportModule,
                './common/legStartSignal.js': legStartSignalReal,
                './common/developmentModePlan.js': devDevelopmentModePlanReal,
                './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function() { throw new Error('baseBranchMarker must not run in dryRun'); } },
                './common/trackers.js': {
                    createTracker: function() {
                        return {
                            provider: function() { return 'github'; },
                            moveToStatus: function(k, s) { trackerMoves.push({ key: k, status: s }); }
                        };
                    }
                }
            }),
            {
                cli_execute_command: function(opts) { cliCalls.push(opts && opts.command); return ''; },
                github_add_labels: function(a) { labelCalls.push(a); },
                github_remove_label: function(a) { labelCalls.push(a); }
            }
        );

        var res = mod.action({
            inputFolderPath: 'input/gh-1356',
            dryRun: true,
            ticket: { key: 'gh-1356', fields: {} },
            customParams: {}
        });

        assert.deepEqual(res, { success: true, dryRun: true });
        assert.equal(cliCalls.length, 0, 'dryRun must make zero cli_execute_command calls');
        assert.equal(trackerMoves.length, 0, 'dryRun must perform no tracker status moves');
        assert.equal(labelCalls.length, 0, 'dryRun must perform no SCM label writes');
        assert.equal(questionsFetched, 1, 'read-only context fetch (questions) still runs');
        assert.equal(linkedTestsFetched, 1, 'read-only context fetch (linked tests) still runs');
        assert.equal(parentContextFetched, 1, 'read-only context fetch (parent context) still runs');
    });

    test('nested customParams.dryRun and jobParams.customParams.dryRun are honoured by branchSetup.isDryRunParams, preCliDevelopmentSetupDynamicRepo, and preCliSyncBaseBranch (gh-1413)', function() {
        var bs = loadModule('js/common/branchSetup.js');
        assert.equal(bs.isDryRunParams({ dryRun: true }), true);
        assert.equal(bs.isDryRunParams({ jobParams: { dryRun: 'true' } }), true);
        assert.equal(bs.isDryRunParams({ customParams: { dryRun: true } }), true);
        assert.equal(bs.isDryRunParams({ jobParams: { customParams: { dryRun: 'true' } } }), true);
        assert.equal(bs.isDryRunParams({ jobParams: { customParams: { dryRun: false } } }), false);

        var writes = [];
        var dynMod = loadModule('js/preCliDevelopmentSetupDynamicRepo.js', makeRequire({
            './resolveRepoFromTicket.js': { action: function(p) {
                p.customParams = Object.assign({}, p.customParams || {}, { targetRepository: { workingDir: '/tmp/wt' } });
                return true;
            } },
            './preCliDevelopmentSetup.js': { action: function(p) { return { success: true, dryRun: bs.isDryRunParams(p) }; } },
            './common/branchSetup.js': bs
        }), {
            file_write: function(args) { writes.push(args); }
        });
        var dynRes = dynMod.action({ jobParams: { customParams: { dryRun: true } } });
        assert.deepEqual(dynRes, { success: true, dryRun: true });
        assert.equal(writes.length, 0, 'preCliDevelopmentSetupDynamicRepo must not write .dmtools-target-workingdir in dryRun');

        var syncCli = [];
        var syncMod = loadModule('js/preCliSyncBaseBranch.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return { git: { baseBranch: 'main' } }; } },
            './common/pullRequest.js': PR_HELPER_REAL,
            './common/branchSetup.js': bs
        }), {
            cli_execute_command: function(args) { syncCli.push(args); return ''; }
        });
        assert.equal(syncMod.action({ customParams: { dryRun: true } }), true);
        assert.equal(syncMod.action({ jobParams: { customParams: { dryRun: 'true' } } }), true);
        assert.equal(syncCli.length, 0, 'preCliSyncBaseBranch must not execute git checkout/pull in dryRun');

        assert.equal(syncMod.action({ jobParams: { customParams: {} } }), true);
        assert.equal(syncCli.length, 2, 'non-dryRun executes git checkout and git pull');
        assert.equal(syncCli[0].command, 'git checkout main');
        assert.equal(syncCli[1].command, 'git pull --ff-only origin main');

        var errSyncMod = loadModule('js/preCliSyncBaseBranch.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return { workingDir: '/tmp/w', git: {} }; } },
            './common/pullRequest.js': PR_HELPER_REAL,
            './common/branchSetup.js': bs
        }), {
            cli_execute_command: function() { throw new Error('git failed'); }
        });
        assert.equal(errSyncMod.action({}), false, 'returns false when git command throws');
    });

});

// ── gh-1363: leg-failure reports that carry context ──────────────────────────
// The setup failure path shares the js/common/legFailureReport.js builder:
// a failing leg reports phase (setup), the failing step (the setup stage),
// a bounded excerpt, run id + link when the CI env provides them, the
// leg-start pre-flight line, and the repeat count against prior
// failure-signature lines on the same ticket (existing surface — no new
// persistence).

var legFailureReportReal = loadModule('js/common/legFailureReport.js');

function loadForGh1363(globals, trackerStub, configLoaderStub) {
    return loadModule(
        'js/preCliDevelopmentSetup.js',
        makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js', null, globals || {}),
            'gitStaging.js': loadModule('js/common/gitStaging.js'),
            './configLoader.js': configLoaderStub || {
                loadProjectConfig: function () { return makeConfig(); },
                paramsForConfigLoad: function (p) { return p; }
            },
            './common/pullRequest.js': PR_HELPER_REAL,
            './config.js': NOOP_CONFIG_JS,
            './fetchQuestionsToInput.js': NOOP_MODULE,
            './fetchLinkedTestsToInput.js': NOOP_MODULE,
            './fetchParentContextToInput.js': NOOP_MODULE,
            './restoreFromReleases.js': NOOP_MODULE,
            './common/setupCommands.js': devSetupCommandsReal,
            './common/commentMarkup.js': devCommentMarkupModule,
            './common/legFailureReport.js': legFailureReportReal,
            './common/legStartSignal.js': legStartSignalReal,
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function () {} },
                './common/developmentModePlan.js': devDevelopmentModePlanReal,
                './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
            './common/trackers.js': {
                createTracker: function () { return trackerStub; }
            }
        }),
        globals || {}
    );
}

suite('preCliDevelopmentSetup.buildSetupErrorComment — enriched leg-failure context (gh-1363)', function () {

    test('no context (legacy 3-arg call) → byte-identical historical comment', function () {
        var mod = loadForGh1363();
        var legacy = loadForComments();
        var withCtxSupport = mod.buildSetupErrorComment(devCommentMarkupModule.forFlavor('markdown'), 'Git Branch Setup', 'boom');
        var expected = legacy.buildSetupErrorComment(devCommentMarkupModule.forFlavor('markdown'), 'Git Branch Setup', 'boom');
        assert.equal(withCtxSupport, expected);
    });

    test('context renders phase, step, pre-flight line, repeat and signature in the ticket flavor', function () {
        var mod = loadForGh1363();
        var out = mod.buildSetupErrorComment(
            devCommentMarkupModule.forFlavor('markdown'), 'Git Branch Setup', 'checkout boom',
            {
                preflightLine: 'git pre-flight: branch=ai/gh-1 head=f3183be dirty=1 staged=0 paths=[x.js]',
                runId: '17500000001',
                runUrl: 'https://github.com/acme/widgets/actions/runs/17500000001',
                repeatCount: 2,
                signature: 'preCliDevelopmentSetup | Git Branch Setup | checkout boom'
            });
        assert.ok(out.indexOf('### **Development Setup Error**') === 0, 'legacy heading stays first');
        assert.ok(out.indexOf('**Phase:** setup') !== -1, 'phase is always setup here: ' + out);
        assert.ok(out.indexOf('**Failing step:** Git Branch Setup') !== -1);
        assert.ok(out.indexOf('17500000001') !== -1);
        assert.ok(out.indexOf('identical failure #2 in a row') !== -1);
        assert.ok(out.indexOf('failure-signature: preCliDevelopmentSetup | Git Branch Setup |') !== -1);
        assert.ok(out.indexOf('git pre-flight: branch=ai/gh-1') !== -1);
    });

    test('the excerpt section is hard-capped — a 100-line error renders ≤30 excerpt lines', function () {
        var mod = loadForGh1363();
        var longError = new Array(101).join('error line\n');
        var out = mod.buildSetupErrorComment(
            devCommentMarkupModule.forFlavor('markdown'), 'Environment Setup', longError,
            { phase: 'setup', excerpt: longError + 'tail the caller kept separately\n' });
        var fenced = out.match(/```[a-z]*\n([\s\S]*?)\n```/g) || [];
        var excerptBlock = fenced.length ? fenced[fenced.length - 1] : '';
        var lineCount = excerptBlock.split('\n').length - 2; // minus the two fence lines
        assert.ok(lineCount <= 30, 'excerpt capped, got ' + lineCount);
    });

});

suite('preCliDevelopmentSetup.postSetupErrorComment — repeat count from prior signatures (gh-1363)', function () {

    var SIG_OF = function (stage, message) {
        return legFailureReportReal.failureSignature({
            workflow: 'preCliDevelopmentSetup', step: stage, message: message
        });
    };

    test('one prior identical failure → second report says identical failure #2 in a row', function () {
        var posted = [];
        var tracker = {
            provider: function () { return 'stub'; },
            getComments: function () {
                return [{ author: 'm', body: 'note\nfailure-signature: ' + SIG_OF('Git Branch Setup', 'boom') }];
            },
            postComment: function (key, text) { posted.push({ key: key, text: text }); }
        };
        var mod = loadForGh1363({}, tracker);
        mod.postSetupErrorComment({}, {}, 'gh-12', 'Git Branch Setup', 'boom');
        assert.equal(posted.length, 1);
        assert.ok(posted[0].text.indexOf('identical failure #2 in a row') !== -1, 'got: ' + posted[0].text);
    });

    test('a prior DIFFERENT failure → first failure with this signature', function () {
        var posted = [];
        var tracker = {
            provider: function () { return 'stub'; },
            getComments: function () {
                return [{ author: 'm', body: 'failure-signature: ' + SIG_OF('Environment Setup', 'npm ci exit 1') }];
            },
            postComment: function (key, text) { posted.push({ key: key, text: text }); }
        };
        var mod = loadForGh1363({}, tracker);
        mod.postSetupErrorComment({}, {}, 'gh-12', 'Git Branch Setup', 'boom');
        assert.ok(posted[0].text.indexOf('first failure with this signature') !== -1, 'got: ' + posted[0].text);
    });

    test('a tracker without getComments (legacy stub shape) still posts the legacy comment', function () {
        var posted = [];
        var tracker = {
            provider: function () { return 'stub'; },
            postComment: function (key, text) { posted.push({ key: key, text: text }); }
        };
        var mod = loadForGh1363({}, tracker);
        mod.postSetupErrorComment({}, {}, 'PROJ-12', 'Git Branch Setup', 'boom');
        assert.equal(posted.length, 1);
        assert.equal(posted[0].text.indexOf('h3. *Development Setup Error*'), 0, 'byte-identical legacy body');
        assert.equal(posted[0].text.indexOf('failure-signature:'), -1, 'no enrichment without any context');
    });

});

suite('preCliDevelopmentSetup.collectPreflightStateStep — leg-start state line (gh-1363)', function () {

    var CLI_RESPONSES = {
        'git rev-parse --abbrev-ref HEAD': 'ai/gh-1363\n',
        'git rev-parse HEAD': 'f3183be0925cf2b3fe399b50323fbc533ccf223a\n',
        'git status --porcelain': ' M js/a.js\nM  js/b.js\n'
    };

    test('collects the canonical line and remembers it for the failure report', function () {
        var calls = [];
        var mod = loadForGh1363({ cli_execute_command: makeCliMock(calls, CLI_RESPONSES) });
        var line = mod.collectPreflightStateStep();
        assert.equal(line,
            'git pre-flight: branch=ai/gh-1363 head=f3183be0925cf2b3fe399b50323fbc533ccf223a dirty=2 staged=1 paths=[js/a.js, js/b.js]');
        assert.equal(mod.currentPreflightLine(), line, 'kept for the next setup-error report');
    });

    test('a git failure is non-fatal — null, and the leg keeps going', function () {
        var mod = loadForGh1363({ cli_execute_command: function () { throw new Error('git missing'); } });
        assert.equal(mod.collectPreflightStateStep(), null);
        assert.equal(mod.currentPreflightLine(), null);
    });

    test('a failing checkout report carries the pre-flight line (wiring through the error path)', function () {
        var posted = [];
        var calls = [];
        var tracker = {
            provider: function () { return 'stub'; },
            postComment: function (key, text) { posted.push({ key: key, text: text }); }
        };
        var mod = loadForGh1363({
            cli_execute_command: function (opts) {
                var command = opts && opts.command;
                calls.push(command);
                if (Object.prototype.hasOwnProperty.call(CLI_RESPONSES, command)) return CLI_RESPONSES[command];
                throw new Error('cli_execute_command failed: ' + command);
            }
        }, tracker, makeConfigLoaderStub({ development: 'ai/gh-12' }, 'master', null, []));
        mod.collectPreflightStateStep();
        // every git command beyond the known probe set fails → checkout fails →
        // the setup-error report posts enriched, then the error rethrows (leg stops)
        var threw = false;
        try {
            mod.checkoutBranchOrReport(makeConfig(), {}, 'gh-12', {}, { ticket: { key: 'gh-12', fields: {} } });
        } catch (e) {
            threw = true;
        }
        assert.ok(threw, 'checkout failure must stop the leg');
        assert.equal(posted.length, 1, 'setup error comment posted');
        assert.ok(posted[0].text.indexOf('git pre-flight: branch=ai/gh-1363') !== -1,
            'pre-flight line rides the report: ' + posted[0].text);
        assert.ok(posted[0].text.indexOf('**Phase:** setup') !== -1, 'phase carried');
    });

});

// ── gh-1363 rework: review-thread fixes ──────────────────────────────────────

suite('preCliDevelopmentSetup.action — pre-flight capture targets the configured workspace (gh-1363 rework)', function () {

    var TARGET_DIR = '/tmp/gh-1363-target-repo';
    var PREFLIGHT_RESPONSES = {
        'git rev-parse --abbrev-ref HEAD': 'ai/gh-1363\n',
        'git rev-parse HEAD': 'f3183be0925cf2b3fe399b50323fbc533ccf223a\n',
        'git status --porcelain': ''
    };

    function workingDirConfigLoaderStub(workingDir) {
        return {
            loadProjectConfig: function () { return makeConfig({ workingDir: workingDir }); },
            paramsForConfigLoad: function (p) { return p; },
            resolveBranchName: function (cfg, ticket, role) { return role === 'development' ? 'ai/gh-12' : 'master'; },
            resolvePRTargetBranch: function () { return 'master'; },
            loadHookFn: function () { return null; }
        };
    }

    function runActionCapturingPreflight(workingDir) {
        var recorded = [];
        var posted = [];
        var tracker = {
            provider: function () { return 'stub'; },
            postComment: function (key, text) { posted.push({ key: key, text: text }); }
        };
        var mod = loadForGh1363({
            cli_execute_command: function (opts) {
                recorded.push(opts);
                var command = opts && opts.command;
                if (PREFLIGHT_RESPONSES.hasOwnProperty(command)) return PREFLIGHT_RESPONSES[command];
                throw new Error('cli_execute_command failed: ' + command);
            },
            file_write: function () { }
        }, tracker, workingDirConfigLoaderStub(workingDir));
        var threw = false;
        try {
            mod.action({ inputFolderPath: 'input/gh-12', ticket: { key: 'gh-12', fields: { } } });
        } catch (e) {
            threw = true; // checkout fails beyond the probe set — the leg stops
        }
        return { recorded: recorded, posted: posted, threw: threw, mod: mod };
    }

    function preflightCallsOf(run) {
        return run.recorded.filter(function (opts) {
            return PREFLIGHT_RESPONSES.hasOwnProperty(opts && opts.command);
        });
    }

    test('config.workingDir is resolved BEFORE the capture — the git probes run in the target workspace', function () {
        var run = runActionCapturingPreflight(TARGET_DIR);
        var preflightCalls = preflightCallsOf(run);
        assert.ok(preflightCalls.length >= 3, 'all three pre-flight probes ran, got ' + preflightCalls.length);
        preflightCalls.forEach(function (opts) {
            assert.equal(opts.workingDirectory, TARGET_DIR,
                'pre-flight probe "' + opts.command + '" must carry workingDirectory=' + TARGET_DIR);
        });
        assert.ok(run.threw, 'the leg still stops on the checkout failure');
        assert.equal(run.posted.length, 1, 'the setup-error report is still posted');
        assert.ok(run.posted[0].text.indexOf('git pre-flight: branch=ai/gh-1363') !== -1,
            'the pre-flight line rides the report: ' + run.posted[0].text);
    });

    test('no workingDir — the probes carry no workingDirectory (no-workingDir behavior unchanged)', function () {
        var run = runActionCapturingPreflight(null);
        preflightCallsOf(run).forEach(function (opts) {
            assert.equal(opts.workingDirectory, undefined,
                'no-workingDir setups must not grow a workingDirectory');
        });
        assert.ok(run.threw, 'the leg still stops on the checkout failure');
    });

});

suite('preCliDevelopmentSetup.buildSetupErrorComment — excerpt not duplicated (gh-1363 rework)', function () {

    var CONTEXT = {
        preflightLine: 'git pre-flight: branch=ai/gh-1 head=f3183be dirty=0 staged=0 paths=[]',
        repeatCount: 2,
        signature: 'preCliDevelopmentSetup | Git Branch Setup | checkout boom'
    };

    test('a default excerpt equal to the error is omitted — the Error: line already carries it', function () {
        var mod = loadForGh1363();
        var out = mod.buildSetupErrorComment(
            devCommentMarkupModule.forFlavor('markdown'), 'Git Branch Setup', 'checkout boom', CONTEXT);
        assert.ok(out.indexOf('**Error:**') !== -1, 'the legacy Error line stays');
        assert.equal(out.indexOf('Log excerpt'), -1, 'no duplicated excerpt section, got: ' + out);
    });

    test('a long default excerpt (truncated Error: line) is omitted too — same text, same source', function () {
        var mod = loadForGh1363();
        var longError = new Array(101).join('maven failure line\n');
        var out = mod.buildSetupErrorComment(
            devCommentMarkupModule.forFlavor('markdown'), 'Environment Setup', longError, { phase: 'setup' });
        assert.equal(out.indexOf('Log excerpt'), -1, 'no duplicated excerpt section for a default excerpt');
    });

    test('an explicit caller-provided excerpt DISTINCT from the error still renders', function () {
        var mod = loadForGh1363();
        var out = mod.buildSetupErrorComment(
            devCommentMarkupModule.forFlavor('markdown'), 'Environment Setup', 'npm ci failed',
            Object.assign({}, CONTEXT, { excerpt: 'npm ERR! missing peer dep\nnpm ERR! exit 1' }));
        assert.ok(out.indexOf('Log excerpt') !== -1, 'explicit distinct excerpt renders');
        assert.ok(out.indexOf('npm ERR! missing peer dep') !== -1);
    });

});

suite('preCliDevelopmentSetup — gh-1363 rework: extracted enrichment helpers (crap split)', function () {

    var SIG = 'preCliDevelopmentSetup | Git Branch Setup | boom';

    function envJava(values) {
        return { lang: { System: { getenv: function (name) {
            return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
        } } } };
    }

    test('commentBodies: body/text shapes, null entries and a null list', function () {
        var mod = loadForGh1363();
        assert.deepEqual(
            mod.commentBodies([{ body: 'a' }, { text: 'b' }, null, { author: 'x' }]),
            ['a', 'b', '', '']);
        assert.deepEqual(mod.commentBodies(null), []);
        assert.deepEqual(mod.commentBodies([]), []);
    });

    test('readJavaEnv: value, absent and a throwing bridge — all non-fatal', function () {
        var mod = loadForGh1363({ java: envJava({ GH_TOKEN: 'tok' }) });
        assert.equal(mod.readJavaEnv('GH_TOKEN'), 'tok');
        assert.equal(mod.readJavaEnv('MISSING'), null);
        var throwing = loadForGh1363({
            java: { lang: { System: { getenv: function () { throw new Error('no bridge'); } } } }
        });
        assert.equal(throwing.readJavaEnv('ANY'), null);
    });

    test('readProcessEnv: present, absent, no-process-global and a throwing env access — all non-fatal', function () {
        var mod = loadForGh1363({ process: { env: { FOO: 'bar' } } });
        assert.equal(mod.readProcessEnv('FOO'), 'bar');
        assert.equal(mod.readProcessEnv('NOPE'), null);
        var noProcess = loadForGh1363({ process: undefined });
        assert.equal(noProcess.readProcessEnv('FOO'), null);
        var throwingHost = {};
        Object.defineProperty(throwingHost, 'env', { get: function () { throw new Error('env boom'); } });
        assert.equal(loadForGh1363({ process: throwingHost }).readProcessEnv('FOO'), null);
    });

    test('readEnvVar: the java bridge wins over the node process env', function () {
        var both = loadForGh1363({
            java: envJava({ BOTH: 'from-java' }),
            process: { env: { BOTH: 'from-process' } }
        });
        assert.equal(both.readEnvVar('BOTH'), 'from-java');
        var onlyProcess = loadForGh1363({
            java: envJava({}),
            process: { env: { BOTH: 'from-process' } }
        });
        assert.equal(onlyProcess.readEnvVar('BOTH'), 'from-process');
        assert.equal(loadForGh1363({ java: envJava({}) }).readEnvVar('MISSING'), null);
    });

    test('deriveEnrichmentContext: fills signature+repeat, the leg-start line and the run identity', function () {
        var tracker = {
            getComments: function () {
                return [{ author: 'm', body: 'note\nfailure-signature: ' + SIG }];
            }
        };
        var mod = loadForGh1363({
            java: envJava({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/widgets', GITHUB_RUN_ID: '4242' }),
            cli_execute_command: makeCliMock([], {
                'git rev-parse --abbrev-ref HEAD': 'ai/gh-1363\n',
                'git rev-parse HEAD': 'f3183be0925cf2b3fe399b50323fbc533ccf223a\n',
                'git status --porcelain': ''
            })
        });
        mod.collectPreflightStateStep();
        var ctx = mod.deriveEnrichmentContext(tracker, 'gh-12', 'Git Branch Setup', 'boom', {});
        assert.equal(ctx.signature, SIG);
        assert.equal(ctx.repeatCount, 2, 'one prior identical failure → #2');
        assert.ok(ctx.preflightLine.indexOf('git pre-flight: branch=ai/gh-1363') === 0,
            'the collected leg-start line fills the context: ' + ctx.preflightLine);
        assert.equal(ctx.runId, '4242');
        assert.ok(ctx.runUrl.indexOf('/actions/runs/4242') !== -1);
    });

    test('deriveEnrichmentContext: caller-provided values win; a tracker without getComments yields no signature', function () {
        var mod = loadForGh1363({ java: envJava({}) });
        var provided = { preflightLine: 'given', runUrl: 'https://given', signature: 'given-sig', repeatCount: 5 };
        var ctx = mod.deriveEnrichmentContext({ getComments: function () { return []; } }, 'gh-12', 'S', 'boom', provided);
        assert.equal(ctx.preflightLine, 'given');
        assert.equal(ctx.runUrl, 'https://given');
        assert.equal(ctx.signature, 'given-sig');
        assert.equal(ctx.repeatCount, 5);
        var noComments = mod.deriveEnrichmentContext({}, 'gh-12', 'S', 'boom', {});
        assert.equal(noComments.signature, undefined, 'no getComments → no derived signature');
    });

    test('isEnrichedContext: any collected item enriches; an empty context does not', function () {
        var mod = loadForGh1363();
        assert.equal(mod.isEnrichedContext({}), false);
        assert.equal(mod.isEnrichedContext({ preflightLine: 'x' }), true);
        assert.equal(mod.isEnrichedContext({ runUrl: 'x' }), true);
        assert.equal(mod.isEnrichedContext({ runId: 'x' }), true);
        assert.equal(mod.isEnrichedContext({ signature: 'x' }), true);
    });

});

// ── gh-1364: the leg-start phase signal ──────────────────────────────────────
// Every dev leg answers, machine-readably, "can agent legs currently start
// work on this main SHA?": ONE summary line at the setup boundary
// (`leg-start: ok (branch <name>)` / `leg-start: failed (<class>: <first
// line>)`) plus a BEST-EFFORT commit status on the head SHA the leg ran
// against (leg-start/ok | leg-start/failed). Formats and the closed reason
// set live in js/common/legStartSignal.js; the wiring lives here.

var GH1364_SHA = 'f3183be0925cf2b3fe399b50323fbc533ccf223a';
var GH1364_PROBES = {
    'git rev-parse --abbrev-ref HEAD': 'ai/gh-1364\n',
    'git rev-parse HEAD': GH1364_SHA + '\n',
    'git status --porcelain': ''
};

function gh1364Config(overrides) {
    return makeConfig(Object.assign({
        git: { baseBranch: 'main', featureBranch: { enabled: false } },
        tracker: { provider: 'github' },
        repository: { owner: 'acme', repo: 'widgets' }
    }, overrides || {}));
}

function gh1364SetupCommandsOk() {
    return {
        runSetupCommands: function () { return null; },
        buildSetupWarningsMarkdown: function () { return null; },
        truncateSetupError: function (s) { return String(s); }
    };
}

// Full action() gauntlet with a recorded github_create_commit_status. Every
// default lives in the Object.assign maps (no `||` in the builders' hot paths —
// the CRAP gate measures test files too, so each builder below stays small and
// fully covered: gh1364Globals (mock globals), gh1364RequireMap (module map),
// loadForGh1364 (the thin composition; gh-1364 rework split for the ratchet).
function gh1364Globals(bag, opts) {
    var globals = Object.assign({
        cli_execute_command: function (commandOpts) {
            var command = commandOpts && commandOpts.command;
            bag.cliCalls.push(command);
            if (Object.prototype.hasOwnProperty.call(opts.cliThrowFor, command)) {
                throw new Error(opts.cliThrowFor[command]);
            }
            if (Object.prototype.hasOwnProperty.call(GH1364_PROBES, command)) return GH1364_PROBES[command];
            if (Object.prototype.hasOwnProperty.call(opts.cliResponses, command)) return opts.cliResponses[command];
            return '';
        },
        jira_move_to_status: function (args) { bag.moves.push(args); },
        file_write: function (args) { bag.writes.push(args); return null; },
        file_read: function () { return ''; },
        github_create_commit_status: function (args) {
            bag.statuses.push(args);
            bag.events.push('status');
            if (opts.statusThrows) throw new Error(opts.statusThrows);
            return '{}';
        },
        github_add_labels: function () {},
        github_remove_label: function () {}
    }, opts.extraGlobals);
    if (opts.env) globals.java = opts.env;
    return globals;
}

function gh1364RequireMap(trackers, opts) {
    return makeRequire({
        'branchSetup.js': loadModule('js/common/branchSetup.js'),
        'gitStaging.js': loadModule('js/common/gitStaging.js'),
        './configLoader.js': {
            loadProjectConfig: function () {
                if (opts.configLoadThrows) throw new Error(opts.configLoadThrows);
                return opts.config || gh1364Config();
            },
            paramsForConfigLoad: function (p) { return p; },
            resolveBranchName: function (cfg, ticket, role) { return 'ai/' + ticket.key; },
            resolvePRTargetBranch: function () { return 'main'; },
            loadHookFn: function () { return null; }
        },
        './common/pullRequest.js': PR_HELPER_REAL,
        './config.js': NOOP_CONFIG_JS,
        './fetchQuestionsToInput.js': { action: function () {} },
        './fetchLinkedTestsToInput.js': { action: function () {} },
        './fetchParentContextToInput.js': { action: function () {} },
        './restoreFromReleases.js': { action: function () {} },
        './common/setupCommands.js': opts.setupCommands || gh1364SetupCommandsOk(),
        './common/baseBranchMarker.js': { writeBaseBranchMarker: function () {} },
                './common/developmentModePlan.js': devDevelopmentModePlanReal,
                './common/developmentModeAdaptive.js': devDevelopmentModeAdaptiveReal,
        './common/commentMarkup.js': devCommentMarkupModule,
        './common/legFailureReport.js': legFailureReportModule,
        './common/legStartSignal.js': legStartSignalReal,
        './common/trackers.js': trackers
    });
}

function loadForGh1364(bag, opts) {
    opts = Object.assign({
        config: null,
        cliThrowFor: {},
        cliResponses: {},
        statusThrows: null,
        env: null,
        configLoadThrows: null,
        setupCommands: null,
        extraGlobals: {}
    }, opts || {});
    var globals = gh1364Globals(bag, opts);
    var trackers = loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), globals);
    return loadModule(
        'js/preCliDevelopmentSetup.js',
        gh1364RequireMap(trackers, opts),
        globals
    );
}

function makeGh1364Bag() {
    return { cliCalls: [], moves: [], writes: [], statuses: [], events: [] };
}

function runGh1364Action(mod) {
    var threw = null;
    try {
        mod.action({ inputFolderPath: 'input/gh-1364', ticket: { key: 'gh-1364', fields: {} }, customParams: {} });
    } catch (e) {
        threw = e;
    }
    return threw;
}

suite('preCliDevelopmentSetup.action — leg-start ok signal (gh-1364)', function () {

    test('AC1/AC3: setup crossed → exactly one leg-start/ok status on the pre-flight head SHA', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { extraGlobals: { process: undefined, java: undefined } });

        var threw = runGh1364Action(mod);

        assert.equal(threw, null, 'the leg completes');
        assert.equal(bag.statuses.length, 1, 'exactly one commit status (AC1 exactly-once)');
        var args = bag.statuses[0];
        assert.equal(args.context, 'leg-start/ok');
        assert.equal(args.state, 'success');
        assert.equal(args.description, 'ai/gh-1364', 'description is the branch name');
        assert.equal(args.workspace, 'acme');
        assert.equal(args.repository, 'widgets');
        assert.equal(args.sha, GH1364_SHA, 'the head SHA the leg ran against (pre-flight head)');
        assert.equal(args.targetUrl, undefined, 'no CI env → no target_url');
        assert.equal(mod.currentLegStartLine(), 'leg-start: ok (branch ai/gh-1364)');
    });

    test('ok status fires only after the environment-setup step ran (setup boundary ordering)', function () {
        var bag = makeGh1364Bag();
        var setupCommands = gh1364SetupCommandsOk();
        var originalRun = setupCommands.runSetupCommands;
        setupCommands.runSetupCommands = function (customParams, workingDir) {
            bag.events.push('setup');
            return originalRun(customParams, workingDir);
        };
        var mod = loadForGh1364(bag, { setupCommands: setupCommands });

        runGh1364Action(mod);

        assert.deepEqual(bag.events.filter(function (e) { return e !== 'status' ? false : true; }).length, 1, 'one status');
        var setupIdx = bag.events.indexOf('setup');
        var statusIdx = bag.events.indexOf('status');
        assert.ok(setupIdx !== -1 && statusIdx > setupIdx,
            'the ok signal fires after setup commands, got ' + JSON.stringify(bag.events));
    });

    test('AC4: the status API failing does not fail the leg — warning logged, run continues', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { statusThrows: 'rate limit exceeded' });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function () { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var threw = runGh1364Action(mod);
            assert.equal(threw, null, 'a status posting failure never fails the leg');
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(bag.statuses.length, 1, 'the status call was attempted');
        assert.equal(mod.currentLegStartLine(), 'leg-start: ok (branch ai/gh-1364)', 'the ok line still logged');
        assert.ok(warnings.join('\n').indexOf('non-fatal') !== -1,
            'a warning is logged: ' + JSON.stringify(warnings));
    });

    test('non-github tracker provider: no commit status at all (GitHub plumbing is opt-in)', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { config: gh1364Config({ tracker: { provider: 'jira' } }) });

        var threw = runGh1364Action(mod);

        assert.equal(threw, null);
        assert.equal(bag.statuses.length, 0, 'no github_create_commit_status on a jira-tracker leg');
        assert.equal(mod.currentLegStartLine(), 'leg-start: ok (branch ai/gh-1364)', 'the log line still emitted');
    });

    test('no repository scope in config: status skipped with a warning, line still emitted', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { config: gh1364Config({ repository: undefined }) });

        var threw = runGh1364Action(mod);

        assert.equal(threw, null);
        assert.equal(bag.statuses.length, 0);
        assert.equal(mod.currentLegStartLine(), 'leg-start: ok (branch ai/gh-1364)');
    });

    test('head SHA not resolvable: status skipped, log line still emitted (AC3 caveat)', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { cliThrowFor: { 'git rev-parse HEAD': 'fatal: not a git repository' } });

        var threw = runGh1364Action(mod);

        assert.equal(threw, null);
        assert.equal(bag.statuses.length, 0, 'no sha → no status');
        assert.equal(mod.currentLegStartLine(), 'leg-start: ok (branch ai/gh-1364)');
    });

    test('mixed path: pre-flight state collection fails → the fresh rev-parse fallback still feeds the status', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { cliThrowFor: { 'git status --porcelain': 'fatal: not a git repository' } });
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function () { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var threw = runGh1364Action(mod);
        } finally {
            console.warn = originalWarn;
        }

        assert.equal(threw, null, 'a failed pre-flight collection never fails the leg');
        assert.ok(warnings.join('\n').indexOf('pre-flight state collection failed') !== -1,
            'the pre-flight capture failed best-effort: ' + JSON.stringify(warnings));
        assert.equal(bag.statuses.length, 1, 'no remembered SHA → the fresh probe still resolves one');
        assert.equal(bag.statuses[0].sha, GH1364_SHA, 'the fallback SHA is the same head the leg ran on');
    });

    test('remembered head is not a SHA (garbage rev-parse) → the fresh probe still feeds the status', function () {
        var bag = makeGh1364Bag();
        var revParseCalls = 0;
        var mod = loadForGh1364(bag, { extraGlobals: {
            cli_execute_command: function (commandOpts) {
                var command = commandOpts && commandOpts.command;
                bag.cliCalls.push(command);
                if (command === 'git rev-parse HEAD') {
                    revParseCalls++;
                    // the pre-flight capture answers garbage; the later probe
                    // (post-checkout head) answers the real SHA — the
                    // remembered-invalid → fresh-succeeds mixed path.
                    return revParseCalls === 1 ? 'detached-garbage\n' : GH1364_SHA + '\n';
                }
                if (Object.prototype.hasOwnProperty.call(GH1364_PROBES, command)) return GH1364_PROBES[command];
                return '';
            }
        } });

        var threw = runGh1364Action(mod);

        assert.equal(threw, null);
        assert.ok(revParseCalls >= 2, 'both the pre-flight capture and the fallback probe ran, got ' + revParseCalls);
        assert.equal(bag.statuses.length, 1, 'an invalid remembered SHA falls through to the fresh probe');
        assert.equal(bag.statuses[0].sha, GH1364_SHA, 'the fresh SHA the leg actually runs on');
    });

    test('both the remembered and the fresh head are garbage → no status, log line still emitted', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { extraGlobals: {
            cli_execute_command: function (commandOpts) {
                var command = commandOpts && commandOpts.command;
                bag.cliCalls.push(command);
                if (command === 'git rev-parse HEAD') return 'detached-garbage\n';
                if (Object.prototype.hasOwnProperty.call(GH1364_PROBES, command)) return GH1364_PROBES[command];
                return '';
            }
        } });

        var threw = runGh1364Action(mod);

        assert.equal(threw, null);
        assert.equal(bag.statuses.length, 0, 'a non-SHA head never feeds the commit status');
        assert.equal(mod.currentLegStartLine(), 'leg-start: ok (branch ai/gh-1364)');
    });

    test('direct call with no config: skipped with a warning, never a throw (posting guard chain)', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag);
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function () { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        var posted = null;
        try {
            posted = mod.postLegStartStatusBestEffort(null, {}, { ok: true, branchName: 'ai/gh-1364' });
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(posted, null, 'no config → null');
        assert.equal(bag.statuses.length, 0, 'no status call attempted');
        assert.ok(warnings.join('\n').indexOf('no config') !== -1,
            'the log-only warning is carried: ' + JSON.stringify(warnings));
    });

    test('CI env provides the run URL → it rides the status as target_url', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, {
            env: { lang: { System: { getenv: function (name) {
                return name === 'GITHUB_SERVER_URL' ? 'https://github.com'
                    : name === 'GITHUB_REPOSITORY' ? 'acme/widgets'
                    : name === 'GITHUB_RUN_ID' ? '4242' : null;
            } } } }
        });

        runGh1364Action(mod);

        assert.equal(bag.statuses.length, 1);
        assert.equal(bag.statuses[0].targetUrl, 'https://github.com/acme/widgets/actions/runs/4242');
    });

    test('dryRun legs emit no signal at all (no setup boundary crossed)', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag);

        var res = mod.action({ inputFolderPath: 'input/gh-1364', ticket: { key: 'gh-1364', fields: {} }, dryRun: true });

        assert.deepEqual(res, { success: true, dryRun: true });
        assert.equal(bag.statuses.length, 0, 'no commit status from a dryRun leg');
        assert.equal(mod.currentLegStartLine(), null, 'no leg-start line from a dryRun leg');
    });

});

suite('preCliDevelopmentSetup.action — leg-start failed signal (gh-1364)', function () {

    var GIT_STATE_ERROR = 'error: Your local changes to the following files would be overwritten by checkout:\n' +
        '\tfile.js\nPlease commit your changes or stash them before you switch branches.\nAborting';

    test('AC2/AC5: checkout dies on a dirty workspace → leg-start/failed, reason class git-state', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { cliThrowFor: { 'git checkout -B main origin/main': GIT_STATE_ERROR } });

        var threw = runGh1364Action(mod);

        assert.ok(threw, 'the leg still stops');
        assert.contains(threw.toString(), 'Git branch setup failed', 'the historical rethrow is unchanged');
        assert.equal(bag.moves.length, 0, 'no In Development move — leg stopped in setup');
        assert.equal(bag.statuses.length, 1, 'exactly one failed status despite the action-level catch');
        var args = bag.statuses[0];
        assert.equal(args.context, 'leg-start/failed');
        assert.equal(args.state, 'failure');
        assert.equal(args.description, 'git-state', 'reason class from the closed set');
        assert.equal(args.sha, GH1364_SHA);
        assert.ok(String(mod.currentLegStartLine()).indexOf('leg-start: failed (git-state: ') === 0,
            'log line format: ' + mod.currentLegStartLine());
    });

    test('AC5: pathspec failure classifies checkout', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, {
            cliThrowFor: { 'git checkout -B main origin/main': "fatal: pathspec 'main' did not match any file(s) known to git" }
        });

        runGh1364Action(mod);

        assert.equal(bag.statuses.length, 1);
        assert.equal(bag.statuses[0].description, 'checkout');
    });

    test('environment-setup failure after a green checkout → failed signal, reason class other', function () {
        var bag = makeGh1364Bag();
        var setupCommands = gh1364SetupCommandsOk();
        setupCommands.runSetupCommands = function () { throw new Error('Required setup command failed: npm ci — exit 1'); };
        var mod = loadForGh1364(bag, { setupCommands: setupCommands });

        var threw = runGh1364Action(mod);

        assert.ok(threw, 'the leg still stops');
        assert.contains(threw.toString(), 'Environment setup failed');
        assert.equal(bag.statuses.length, 1);
        assert.equal(bag.statuses[0].description, 'other');
        assert.equal(bag.statuses[0].context, 'leg-start/failed');
        assert.ok(String(mod.currentLegStartLine()).indexOf('leg-start: failed (other: Error: Required setup command failed') === 0,
            'log line: ' + mod.currentLegStartLine());
    });

    test('config-load failure before any git probe → log-only failed signal (no sha, no status)', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, { configLoadThrows: 'Failed to load config: unexpected token in JSON' });

        var threw = runGh1364Action(mod);

        assert.ok(threw, 'the leg still stops');
        assert.equal(bag.statuses.length, 0, 'no workspace head was ever resolvable → no status');
        assert.ok(String(mod.currentLegStartLine()).indexOf('leg-start: failed (config: ') === 0,
            'the log line still marks the failed leg: ' + mod.currentLegStartLine());
    });

    test('AC4 on the failed path: a status posting failure does not mask the setup error', function () {
        var bag = makeGh1364Bag();
        var mod = loadForGh1364(bag, {
            cliThrowFor: { 'git checkout -B main origin/main': GIT_STATE_ERROR },
            statusThrows: 'status api exploded'
        });

        var threw = runGh1364Action(mod);

        assert.ok(threw, 'the setup error still propagates');
        assert.contains(threw.toString(), 'Git branch setup failed');
        assert.equal(bag.statuses.length, 1, 'the status call was attempted');
    });

});
