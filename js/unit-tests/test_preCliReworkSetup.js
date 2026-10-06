/**
 * Unit tests for js/preCliReworkSetup.js
 *
 * Scope: syncBaseBranchIfConfigured() — the customParams.branchSyncFnPath extension point
 * used to keep a two-branch-mode PR base (e.g. "release/rc_*") from drifting stale relative
 * to config.git.baseBranch before merge-conflict detection runs. The rest of action()'s flow
 * (PR lookup, branch checkout, discussions/diff writing, Jira comment) is unit-tested
 * elsewhere/indirectly and isn't re-verified here.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

var NOOP_MODULE = {};

var reworkCommentMarkupModule = loadModule('js/common/commentMarkup.js');

function makeGhStub(fetchCalls) {
    return {
        buildOriginFetchCommand: function() {
            return 'git -c fetch.recurseSubmodules=no fetch origin';
        },
        // Unused by syncBaseBranchIfConfigured but required by the module's top-level require().
        _isScm: function() { return false; },
        findPRForTicket: function() {},
        getPRDetails: function() {},
        fetchDiscussionsAndRawData: function() {},
        detectFailedChecks: function() {},
        cleanCommandOutput: function(s) { return s; }
    };
}

function loadPreCliReworkSetup(configLoaderStub, mocks) {
    return loadModule(
        'js/preCliReworkSetup.js',
        makeRequire({
            './configLoader.js': configLoaderStub,
            './common/githubHelpers.js': mocks.__ghStub,
            './common/gitOps.js': NOOP_MODULE,
            './common/commentMarkup.js': reworkCommentMarkupModule,
            './fetchQuestionsToInput.js': NOOP_MODULE,
            './fetchParentContextToInput.js': NOOP_MODULE,
            './restoreFromReleases.js': NOOP_MODULE,
            // The tracker provider is only exercised inside action(); these tests
            // cover syncBaseBranchIfConfigured() which never touches it.
            './common/trackers.js': {
                createTracker: function() {
                    return {
                        provider: function() { return 'jira'; },
                        postComment: function() {},
                        addLabel: function() {},
                        removeLabel: function() {},
                        moveToStatus: function() {},
                        assignTo: function() {}
                    };
                }
            },
            // Real module (not a no-op stub): preCliReworkSetup.js reads
            // setupCommands.truncateSetupError at load time to build its own
            // truncateForComment() helper, so the stub must actually export it.
            './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
            './config.js': { resolveStatuses: function() { return { IN_DEVELOPMENT: 'In Development' }; } }
        }),
        mocks || {}
    );
}

function makeConfig(overrides) {
    var base = { git: { baseBranch: 'master' }, workingDir: 'dependencies/proj' };
    return Object.assign({}, base, overrides || {});
}

function makeConfigLoaderStub(hookFn, hookLoadCalls) {
    return {
        loadHookFn: function(path, hookName) {
            hookLoadCalls.push({ path: path, hookName: hookName });
            return hookFn || null;
        }
    };
}

suite('preCliReworkSetup.syncBaseBranchIfConfigured', function() {

    test('is a no-op when branchSyncFnPath is not configured', function() {
        var hookLoadCalls = [];
        var cliCalls = [];
        var ghStub = makeGhStub();
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, hookLoadCalls), {
            __ghStub: ghStub,
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        mod.syncBaseBranchIfConfigured('release/rc_mobile_proj-1', {}, makeConfig());

        assert.equal(hookLoadCalls.length, 0);
        assert.equal(cliCalls.length, 0);
    });

    test('is a no-op when the PR base already equals config.git.baseBranch', function() {
        var hookLoadCalls = [];
        var cliCalls = [];
        var ghStub = makeGhStub();
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, hookLoadCalls), {
            __ghStub: ghStub,
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        mod.syncBaseBranchIfConfigured('master', { branchSyncFnPath: '.dmtools/branchNaming/sf_rc_jenkins.js' }, makeConfig());

        assert.equal(hookLoadCalls.length, 0, 'should not even look up the hook when there is nothing to sync');
        assert.equal(cliCalls.length, 0);
    });

    test('is a no-op when baseBranch is falsy', function() {
        var hookLoadCalls = [];
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, hookLoadCalls), {
            __ghStub: makeGhStub(),
            cli_execute_command: function() { return ''; }
        });

        mod.syncBaseBranchIfConfigured(null, { branchSyncFnPath: 'x.js' }, makeConfig());

        assert.equal(hookLoadCalls.length, 0);
    });

    test('invokes the configured hook with the right context and fetches origin afterwards', function() {
        var hookLoadCalls = [];
        var hookCallArgs = null;
        var cliCalls = [];
        var hookFn = function(ctx) { hookCallArgs = ctx; };
        var config = makeConfig();
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(hookFn, hookLoadCalls), {
            __ghStub: makeGhStub(),
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        mod.syncBaseBranchIfConfigured('release/rc_mobile_proj-1', { branchSyncFnPath: '.dmtools/branchNaming/sf_rc_jenkins.js' }, config);

        assert.equal(hookLoadCalls.length, 1);
        assert.equal(hookLoadCalls[0].path, '.dmtools/branchNaming/sf_rc_jenkins.js');
        assert.equal(hookLoadCalls[0].hookName, 'branchSyncFnPath');

        assert.ok(hookCallArgs, 'branchSyncFn should have been invoked');
        assert.equal(hookCallArgs.branchName, 'release/rc_mobile_proj-1');
        assert.equal(hookCallArgs.targetBranch, 'master');
        assert.equal(hookCallArgs.workingDir, 'dependencies/proj');
        assert.equal(hookCallArgs.config, config);

        assert.ok(cliCalls.indexOf('git -c fetch.recurseSubmodules=no fetch origin') !== -1,
            'fetches origin after the hook runs so the local repo sees the synced branch');
    });

    test('swallows errors thrown by the hook and does not fetch afterwards', function() {
        var hookLoadCalls = [];
        var cliCalls = [];
        var hookFn = function() { throw new Error('Jenkins job failed'); };
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(hookFn, hookLoadCalls), {
            __ghStub: makeGhStub(),
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        // Should not throw.
        mod.syncBaseBranchIfConfigured('release/rc_mobile_proj-1', { branchSyncFnPath: 'x.js' }, makeConfig());

        assert.equal(cliCalls.length, 0, 'should not fetch origin when the hook itself failed');
    });

    test('is a no-op when the hook path does not export a function', function() {
        var hookLoadCalls = [];
        var cliCalls = [];
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, hookLoadCalls), {
            __ghStub: makeGhStub(),
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        mod.syncBaseBranchIfConfigured('release/rc_mobile_proj-1', { branchSyncFnPath: 'x.js' }, makeConfig());

        assert.equal(hookLoadCalls.length, 1, 'loadHookFn is still consulted');
        assert.equal(cliCalls.length, 0, 'nothing runs when loadHookFn returns null');
    });

});

suite('preCliReworkSetup.truncateForComment', function() {

    test('is wired to setupCommands.truncateSetupError so failSetup() reuses the same bound', function() {
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, []), { __ghStub: makeGhStub() });

        assert.equal(mod.truncateForComment('short'), 'short');

        var huge = 'Y'.repeat(500000);
        var truncated = mod.truncateForComment(huge);
        assert.ok(truncated.length < 10000,
            'huge setup-failure output must be bounded before being embedded in a Jira comment, got ' + truncated.length);
        assert.ok(truncated.indexOf('truncated') !== -1, 'truncated message should say so');
    });

});

// ── gh-770: per-tracker markup for the rework-started comment ────────────────
// The rework setup historically hard-coded Jira wiki markup (h3., {panel},
// {code}) in the "Automated Rework Started" comment; on a GitHub-backed
// tracker that renders as raw text garbage. The builder is extracted so the
// flavor choice (commentMarkup.forTicket) is testable per tracker.

var reworkCommentMarkup = loadModule('js/common/commentMarkup.js');

suite('preCliReworkSetup.buildReworkStartedComment — per-tracker markup (gh-770)', function() {

    var FULL_CTX = {
        prNumber: 1308,
        prUrl: 'https://github.com/acme/widgets/pull/1308',
        branchName: 'ai/gh-1308',
        conflictFiles: ['src/a.dart', 'src/b.dart'],
        failedChecks: [{ name: 'build' }, { name: 'test' }]
    };

    function loadMod() {
        return loadPreCliReworkSetup(makeConfigLoaderStub(null, []), { __ghStub: makeGhStub() });
    }

    test('jira flavor keeps wiki markup — h3., *bold*, [text|url], {code}, {panel}', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('jira'), FULL_CTX);
        assert.ok(out.indexOf('h3. 🔧 Automated Rework Started\n') === 0, 'starts with the historical h3 heading');
        assert.ok(out.indexOf('*Pull Request*: [PR #1308|https://github.com/acme/widgets/pull/1308]\n') !== -1);
        assert.ok(out.indexOf('*Branch*: {code}ai/gh-1308{code}\n') !== -1);
        assert.ok(out.indexOf('{panel:bgColor=#FFEBE6|borderColor=#DE350B}' +
            '⚠️ *Merge conflicts detected* — 2 file(s) must be resolved before rework can be applied:\n' +
            '* {code}src/a.dart{code}\n* {code}src/b.dart{code}') !== -1, 'conflict panel lists every file');
        assert.ok(out.indexOf('⚠️ *CI checks failing* — 2 check(s) must pass before merge:\n' +
            '* {code}build{code}\n* {code}test{code}\n' +
            'Error logs: {code}ci_failures.md{code} (summary) and {code}ci_failures_full.log{code} (full logs).') !== -1,
            'CI panel lists every failing check');
        assert.ok(out.indexOf('_Fix results will be posted shortly..._') !== -1);
    });

    test('markdown flavor renders GitHub-safe markup — no wiki constructs survive', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('markdown'), FULL_CTX);
        assert.ok(out.indexOf('### 🔧 Automated Rework Started\n') === 0, 'starts with a markdown heading');
        assert.ok(out.indexOf('**Pull Request**: [PR #1308](https://github.com/acme/widgets/pull/1308)\n') !== -1);
        assert.ok(out.indexOf('**Branch**') !== -1);
        assert.ok(out.indexOf('**Merge conflicts detected**') !== -1);
        assert.ok(out.indexOf('**CI checks failing**') !== -1);
        assert.ok(out.indexOf('> ') !== -1, 'panel bodies are quoted');
        assert.equal(out.indexOf('h3.'), -1, 'no wiki heading');
        assert.equal(out.indexOf('{panel'), -1, 'no wiki panel');
        assert.equal(out.indexOf('{code'), -1, 'no wiki code tag');
        assert.equal(out.indexOf('[PR #1308|'), -1, 'no wiki link');
    });

    test('clean run: no conflict/CI panels are emitted', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('jira'), {
            prNumber: 1, prUrl: 'https://x/1', branchName: 'b'
        });
        assert.equal(out.indexOf('{panel'), -1);
        assert.ok(out.indexOf('AI Teammate is fixing issues raised in the code review.') !== -1);
    });

});
