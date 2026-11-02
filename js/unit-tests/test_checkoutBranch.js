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
    makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }));

// gh-1318: checkoutDevBranch seeds .git/info/exclude through branchSetup's
// file_read/file_write globals — those run against the PROCESS cwd (the real
// agents repo) unless mocked. Every load guards them; tests that need the
// recorded exclude writes pass __branchSetupFileMocks.
function loadCheckoutBranch(configLoaderStub, mocks) {
    var branchSetupFileMocks = (mocks && mocks.__branchSetupFileMocks) || {
        file_read: function() { return ''; },
        file_write: function() { return null; }
    };
    var moduleMocks = Object.assign({}, mocks || {});
    delete moduleMocks.__branchSetupFileMocks;
    return loadModule(
        'js/checkoutBranch.js',
        makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js', null, branchSetupFileMocks),
            'gitStaging.js': loadModule('js/common/gitStaging.js'),
            './config.js': { GIT_CONFIG: {} },
            './configLoader.js': configLoaderStub,
            './common/pullRequest.js': DEFAULT_PR_HELPER_STUB
        }),
        moduleMocks
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
                'bash -c "test -d input"',
                'bash -c "rm -rf .input.branch-setup-bak"',
                'bash -c "mv input .input.branch-setup-bak"',
                'git clean -fd -- input/',
                'git branch --list "ai/PROJ-1"',
                'git checkout ai/PROJ-1',
                'git ls-files -- input outputs',
                'bash -c "test -d .input.branch-setup-bak"',
                'bash -c "rm -rf input"',
                'bash -c "mv .input.branch-setup-bak input"'
            ], 'fresh input/ stashed before the clean (gh-1318), heal after checkout, restore last');
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
            'bash -c "test -d input"',
            'bash -c "rm -rf .input.branch-setup-bak"',
            'bash -c "mv input .input.branch-setup-bak"',
            'git clean -fd -- input/',
            'git branch --list "ai/PROJ-1"',
            'git ls-remote --heads origin ai/PROJ-1',
            'git checkout -b ai/PROJ-1 origin/ai/PROJ-1',
            'git ls-files -- input outputs',
            'bash -c "test -d .input.branch-setup-bak"',
            'bash -c "rm -rf input"',
            'bash -c "mv .input.branch-setup-bak input"'
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
                'bash -c "test -d input"',
                'bash -c "rm -rf .input.branch-setup-bak"',
                'bash -c "mv input .input.branch-setup-bak"',
                'git clean -fd -- input/',
                'git branch --list "ai/PROJ-1"',
                'git ls-remote --heads origin ai/PROJ-1',
                'git checkout release/rc',
                'git pull origin release/rc',
                'git checkout -b ai/PROJ-1',
                'git ls-files -- input outputs',
                'bash -c "test -d .input.branch-setup-bak"',
                'bash -c "rm -rf input"',
                'bash -c "mv .input.branch-setup-bak input"'
            ], 'new branch starts from the (feature) base; stash/restore wraps every route');
            assert.ok(logs.join('\n').indexOf('Creating new branch from release/rc: ai/PROJ-1') !== -1);
        } finally {
            console.log = originalLog;
        }
    });

});

// ── gh-1301: untracked input/ artifact cleanup before the dev-branch checkout ──
// A re-run leg (comment-resume, retry) regenerates input/<ticket>/ files the
// ask-mode leg already pushed; git would refuse the checkout. The cleanup is
// ONE CONSTANT command — `git clean -fd -- input/` — so no porcelain byte
// (porcelain C-quotes non-trivial names: `?? "input/bad name.md"`) is ever
// parsed or interpolated into a shell string (review round 1: the old
// parse + `rm -rf` loop both no-oped on quoted paths and embedded
// ticket-controlled bytes into a command).

suite('checkoutBranch — input/ artifact cleanup (gh-1301)', function() {

    var GIT_CLEAN_INPUT = 'git clean -fd -- input/';

    function loadWithStatus(statusLines) {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                return statusLines;
            }
        });
        return { mod: mod, calls: calls };
    }

    test('dropUntrackedInputArtifacts: untracked input/ file → the single constant git clean', function() {
        var loaded = loadWithStatus('?? input/PROJ-1/old.md\n');
        loaded.mod.dropUntrackedInputArtifacts();
        assert.deepEqual(loaded.calls, [GIT_CLEAN_INPUT],
            'one fixed command does the cleanup — nothing is parsed or interpolated');
    });

    test('dropUntrackedInputArtifacts: quoted porcelain names never reach a command (no rm -rf, no interpolation)', function() {
        var loaded = loadWithStatus('?? "input/bad name.md"\n?? "input/$(touch pwned).md"\n');
        loaded.mod.dropUntrackedInputArtifacts();
        assert.deepEqual(loaded.calls, [GIT_CLEAN_INPUT],
            'attachment-style names are the collision case — the command must not depend on them');
        assert.ok(loaded.calls.every(function(c) { return c.indexOf('rm -rf') === -1; }),
            'no rm -rf may be built from porcelain output');
        assert.ok(loaded.calls.every(function(c) { return c.indexOf("\x24") === -1 && c.indexOf("\"") === -1; }),
            'no quoted/untrusted byte rides into the executed command');
    });

    test('dropUntrackedInputArtifacts: the command flags pin the semantics (untracked only, tracked and ignored untouched)', function() {
        var loaded = loadWithStatus(' M input/PROJ-1/tracked.md\n');
        loaded.mod.dropUntrackedInputArtifacts();
        assert.deepEqual(loaded.calls, [GIT_CLEAN_INPUT],
            '-fd removes untracked files/directories; no -x keeps ignored files; tracked files are never touched');
    });

    test('dropUntrackedInputArtifacts: clean failure warns instead of throwing', function() {
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                throw new Error('git clean failed');
            }
        });
        try {
            mod.dropUntrackedInputArtifacts();
            assert.equal(warnings.length, 1, 'the cleanup failure is a warning');
            assert.contains(warnings[0], 'Input-artifact cleanup before checkout failed');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('checkoutDevBranch: the clean runs after the input stash and before the decision tree', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command === 'git branch --list "ai/PROJ-1"') return 'ai/PROJ-1';
                return '';
            }
        });
        mod.checkoutDevBranch('ai/PROJ-1', 'master');
        var cleanIdx = calls.indexOf(GIT_CLEAN_INPUT);
        var stashIdx = calls.indexOf('bash -c "mv input .input.branch-setup-bak"');
        var branchProbeIdx = calls.indexOf('git branch --list "ai/PROJ-1"');
        assert.ok(cleanIdx !== -1, 'the constant clean still runs');
        assert.ok(stashIdx !== -1 && stashIdx < cleanIdx,
            'the fresh regenerated input/ is stashed away BEFORE the clean can touch it (gh-1318)');
        assert.ok(branchProbeIdx !== -1 && cleanIdx < branchProbeIdx,
            'the cleanup still precedes the checkout decision tree');
    });

});

// ── gh-1318: fresh leg input wins over the branch-tracked stale copy ─────────
// A dev leg that ended in ask-mode pushed ai/<ticket> WITH its own pre-answer
// input/ snapshot (the timer's git add -A). The tracker regenerates input/
// (with the reporter's answer) before the re-run leg — but the old
// dropUntrackedInputArtifacts deleted that fresh copy and the checkout
// restored the stale branch-tracked one: the answer never reached a leg.
// Unit-level behavior: stash before clean, restore-over-checked-out-copy
// after, and a leg-context heal (untrack + .git/info/exclude seed) so the
// collision class disappears from the branch entirely.

suite('checkoutBranch — fresh leg input survives the checkout (gh-1318)', function() {

    var STASH_MV = 'bash -c "mv input .input.branch-setup-bak"';
    var RESTORE_MV = 'bash -c "mv .input.branch-setup-bak input"';

    test('stash failure degrades to the pre-gh-1318 behavior — clean still runs, nothing throws', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command === STASH_MV) throw new Error('read-only workspace');
                if (opts.command === 'git branch --list "ai/PROJ-1"') return 'ai/PROJ-1';
                return '';
            }
        });
        mod.checkoutDevBranch('ai/PROJ-1', 'master');
        assert.ok(calls.indexOf('git clean -fd -- input/') !== -1, 'the constant clean still ran');
        assert.ok(calls.indexOf(RESTORE_MV) === -1, 'nothing was stashed → no restore');
        assert.ok(calls.indexOf('git checkout ai/PROJ-1') !== -1, 'checkout completed');
    });

    test('checkout refusal still restores the fresh input (finally, not the happy path)', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command === 'git branch --list "ai/PROJ-1"') return 'ai/PROJ-1';
                if (opts.command === 'git checkout ai/PROJ-1') throw new Error('untracked working tree files would be overwritten');
                return '';
            }
        });
        var threw = null;
        try {
            mod.checkoutDevBranch('ai/PROJ-1', 'master');
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, 'the refusal propagates (action() logs it non-fatally)');
        assert.ok(calls.indexOf(RESTORE_MV) !== -1, 'the fresh input comes back even when the checkout failed');
        assert.ok(calls.indexOf('git ls-files -- input outputs') === -1,
            'no heal runs when the checkout never succeeded (nothing was checked out to heal)');
    });

    test('heal: a branch still tracking leg context gets it untracked (quoted, --cached)', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command === 'git branch --list "ai/PROJ-1"') return 'ai/PROJ-1';
                if (opts.command === 'git ls-files -- input outputs') {
                    return 'input/PROJ-1/comments.md\noutputs/pr_base_branch.txt\n';
                }
                return '';
            }
        });
        mod.checkoutDevBranch('ai/PROJ-1', 'master');
        var rm = calls.filter(function(c) { return c.indexOf('git rm -r --cached --ignore-unmatch') === 0; })[0];
        assert.ok(rm, 'poisoned branch is untracked in the same setup pass');
        assert.contains(rm, '"input/PROJ-1/comments.md"');
        assert.contains(rm, '"outputs/pr_base_branch.txt"');
        var rmIdx = calls.indexOf(rm);
        var restoreIdx = calls.indexOf(RESTORE_MV);
        assert.ok(rmIdx !== -1 && restoreIdx !== -1 && rmIdx < restoreIdx,
            'untrack (index-only) precedes the working-tree restore — the fresh copy is the last state');
    });

    test('heal: untrack failure is a warning and never blocks the checkout', function() {
        var calls = [];
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
                cli_execute_command: function(opts) {
                    calls.push(opts.command);
                    if (opts.command === 'git ls-files -- input outputs') throw new Error('git down');
                    if (opts.command === 'git branch --list "ai/PROJ-1"') return 'ai/PROJ-1';
                    return '';
                }
            });
            mod.checkoutDevBranch('ai/PROJ-1', 'master');
            assert.ok(calls.indexOf('git checkout ai/PROJ-1') !== -1, 'checkout completed');
            assert.ok(calls.indexOf(RESTORE_MV) !== -1, 'restore still ran');
            assert.ok(warnings.some(function(w) { return w.indexOf('leg context') !== -1; }),
                'the failure names the leg-context heal: ' + warnings.join(' | '));
        } finally {
            console.warn = originalWarn;
        }
    });

    test('heal: clean branch (nothing tracked under input//outputs/) → listing only, no rm', function() {
        var calls = [];
        var mod = loadCheckoutBranch(makeConfigLoaderStub(makeConfig(), {}), {
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                if (opts.command === 'git branch --list "ai/PROJ-1"') return 'ai/PROJ-1';
                return '';
            }
        });
        mod.checkoutDevBranch('ai/PROJ-1', 'master');
        assert.equal(calls.filter(function(c) { return c.indexOf('git rm') === 0; }).length, 0,
            'nothing tracked → nothing to untrack');
    });

});

// ── gh-1318 repro over a REAL git repo (the ticket's synthetic in-process run) ─
// Drives checkoutBranch.action() in-process over a real temp repository —
// every cli_execute_command git command executes for real, scoped to the
// temp dir via workingDirectory. Scenario (ticket repro verbatim):
//   1. main seeded; branch ai/BUG-1 committed input/TICKET/comments.md with
//      the STALE pre-answer text (the ask-mode WIP snapshot)
//   2. back on main, a FRESH untracked input/TICKET/comments.md carries the
//      reporter's answer (what preCli regeneration produces)
//   3. checkoutBranch.action() runs for BUG-1
// Pre-fix: git clean removed the fresh copy, the checkout restored STALE.
// Post-fix: the fresh answer wins, the clean still ran, and the branch
// stopped tracking input/ (heal).
//
// Runtime gate: the node coverage harness (quality.yml) executes
// cli_execute_command with the PACK ROOT as cwd and ignores
// workingDirectory — real git there would run against the agents repo
// itself. The probe below detects that runtime and the suite self-skips;
// the dmtools runner (the canonical green gate) runs the repro for real.

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

suite('checkoutBranch — gh-1318 repro over a real git repo', function() {

    var FRESH = 'FRESH - reporter answered: credentials are testuser/testpass';
    var STALE = 'STALE - pre-answer ticket comments';

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

    test('branch-tracked stale copy loses, tracker-regenerated fresh copy wins', function() {
        if (!requireRealGitRuntime()) return;
        var repo = makeCollisionRepo();
        var calls = [];
        var excludeWrites = [];
        var configLoaderStub = {
            loadProjectConfig: function() {
                return makeConfig({ git: { baseBranch: repo.base, featureBranch: { enabled: false } } });
            },
            resolveBranchName: function(cfg, ticket, role) { return 'ai/BUG-1'; }
        };
        var mod = loadCheckoutBranch(configLoaderStub, {
            __branchSetupFileMocks: {
                file_read: function() { return ''; },
                file_write: function(args) { excludeWrites.push(args); return null; }
            },
            cli_execute_command: function(opts) {
                calls.push(opts.command);
                return cli_execute_command({ command: opts.command, workingDirectory: repo.tmp });
            }
        });

        mod.action({ ticket: { key: 'BUG-1' }, jobParams: { customParams: {} } });

        assert.contains(calls.join('\n'), 'git clean -fd -- input/', 'the constant clean still ran');
        assert.equal(String(git('git symbolic-ref --short HEAD', repo.tmp)).trim(), 'ai/BUG-1',
            'the dev branch is checked out');
        assert.contains(file_read({ path: repo.tmp + '/input/TICKET/comments.md' }), 'FRESH - reporter answered',
            'the fresh reporter answer survived — the stale branch-tracked copy must not win');
        assert.equal(String(git('git ls-files -- input outputs', repo.tmp)), '',
            'the branch no longer tracks leg context (root-cause heal)');
        var excludeContent = excludeWrites.filter(function(w) { return w.path === '.git/info/exclude'; })
            .map(function(w) { return w.content; }).join('');
        assert.contains(excludeContent, 'input/', 'input/ seeded into .git/info/exclude');
        assert.contains(excludeContent, 'outputs/', 'outputs/ seeded into .git/info/exclude');
        cli_execute_command({ command: 'bash -c "rm -rf ' + repo.tmp + '"' });
    });

});
