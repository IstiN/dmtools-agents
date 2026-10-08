/**
 * Unit tests for js/common/gitOps.js — SCM-agnostic git operations shared by
 * GitHub- and GitLab-backed repos (checkoutPRBranch, getPRDiff,
 * detectMergeConflicts, writePRContext). None of these call a github_ or
 * gitlab_ tool — everything goes through cli_execute_command — so a single
 * test suite covers both providers.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

var gitStagingModuleForGitOps = loadModule('js/common/gitStaging.js');

function loadGitOps(mocks) {
    return loadModule(
        'js/common/gitOps.js',
        makeRequire({
            '../config.js': configModule,
            'config': configModule,
            './gitStaging.js': gitStagingModuleForGitOps,
            './pullRequest.js': {
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
            }
        }),
        mocks || {}
    );
}

suite('gitOps.checkoutPRBranch', function() {
    test('falls back to existing local branch when fetch creates it before failing', function() {
        var commands = [];
        var branchExists = false;
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git branch --list "ai/TS-1268"') {
                    return branchExists ? '  ai/TS-1268\nCOMMAND_EXIT_CODE=0' : '\nCOMMAND_EXIT_CODE=0';
                }
                if (args.command === 'git ls-remote --heads origin ai/TS-1268') {
                    return 'abc123\trefs/heads/ai/TS-1268\nCOMMAND_EXIT_CODE=0';
                }
                if (args.command === 'git -c fetch.recurseSubmodules=no fetch origin ai/TS-1268:ai/TS-1268') {
                    branchExists = true;
                    throw new Error('fatal: refusing to fetch into branch checked out');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        gitOps.checkoutPRBranch('ai/TS-1268');

        assert.ok(commands.indexOf('git checkout ai/TS-1268') !== -1, 'existing local branch should be checked out');
        assert.equal(commands.indexOf('git checkout -b ai/TS-1268 origin/ai/TS-1268'), -1, 'must not recreate an existing branch');
    });

    test('does not stash when the working tree is already clean', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x');

        assert.equal(commands.filter(function(c) { return c.indexOf('git stash') !== -1; }).length, 0,
            'must not stash a clean tree');
        assert.equal(result.hadConflict, false);
    });

    test('stashes a dirty tree before switching and reapplies it cleanly afterwards', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return ' M .codegraph/codegraph.db\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                if (args.command.indexOf('git check-ignore') === 0) {
                    // gh-1164 probe: factory-kit NOT gitignored (nested repo) →
                    // the exclusion is kept and the add command keeps its classic shape.
                    throw new Error('Command execution failed (exit code 1)');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x');

        var stashIdx = commands.indexOf('git add -A -- ":!factory-kit" ":!factory-kit/**"');
        var pushIdx = commands.indexOf('git stash push -u -m "preflight-checkout-feature/x"');
        var checkoutIdx = commands.indexOf('git checkout feature/x');
        var popIdx = commands.indexOf('git stash pop');

        assert.ok(stashIdx !== -1 && pushIdx !== -1, 'dirty tree should be staged and stashed');
        assert.ok(pushIdx < checkoutIdx, 'stash must happen before checkout');
        assert.ok(checkoutIdx < popIdx, 'stash pop must happen after checkout');
        assert.equal(result.hadConflict, false);
    });

    test('does not throw and reports hadConflict when reapplying the snapshot conflicts', function() {
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                if (args.command === 'git status --porcelain') return ' M src/foo.ts\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git stash pop') {
                    throw new Error('CONFLICT (content): Merge conflict in src/foo.ts');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x');

        assert.equal(result.hadConflict, true, 'conflict during stash pop must be reported, not thrown');
        assert.equal(result.branch, 'feature/x');
    });

    test('self-heals by recreating the ticket branch when still on baseBranch after checkout', function() {
        var commands = [];
        var currentBranch = 'develop';
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                // Local branch already exists — checkout/pull "succeed" per exit code,
                // but (simulating an edge case) HEAD never actually moves off develop.
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git rev-parse --abbrev-ref HEAD') return currentBranch + '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git checkout -B feature/x origin/develop') { currentBranch = 'feature/x'; }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x', null, 'develop');

        assert.ok(commands.indexOf('git checkout -B feature/x origin/develop') !== -1,
            'must self-heal by recreating the branch from origin/baseBranch instead of ever returning while on develop');
        assert.equal(result.branch, 'feature/x');
    });

    test('is a no-op invariant check when baseBranch is not provided', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        gitOps.checkoutPRBranch('feature/x'); // no baseBranch arg

        assert.equal(commands.indexOf('git rev-parse --abbrev-ref HEAD'), -1,
            'invariant check must be skipped entirely when baseBranch is not supplied');
    });

    test('resets local branch to origin after force-push (divergent branches)', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "ai/TS-1268"') return '  ai/TS-1268\nCOMMAND_EXIT_CODE=0';
                // git pull would fail here with divergent branches — reset --hard is used instead
                if (args.command === 'git pull origin ai/TS-1268') {
                    throw new Error('fatal: Need to specify how to reconcile divergent branches.');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        gitOps.checkoutPRBranch('ai/TS-1268');

        assert.ok(commands.indexOf('git checkout ai/TS-1268') !== -1, 'local branch is checked out');
        assert.equal(commands.indexOf('git pull origin ai/TS-1268'), -1, 'git pull must NOT be used (fails on divergent branches)');
        assert.ok(commands.indexOf('git reset --hard origin/ai/TS-1268') !== -1, 'git reset --hard origin/<branch> is used to sync with remote');
        // Fetch must use explicit remote-tracking refspec — a plain '<branch>:<branch>' refspec
        // fails when HEAD is on that branch ("Refusing to fetch into current branch").
        var hasCorrectFetch = commands.some(function(c) {
            return c && c.indexOf('fetch origin') !== -1 && c.indexOf('+refs/heads/ai/TS-1268:refs/remotes/origin/ai/TS-1268') !== -1;
        });
        assert.ok(hasCorrectFetch, 'fetch must use +refs/heads/<b>:refs/remotes/origin/<b> refspec');
    });
});


// ── gh-802 AC3a: log hygiene in detectMergeConflicts ─────────────────────────
// The old code logged "No merge conflicts — base branch changes staged" after
// EVERY clean merge — including an already-up-to-date branch where the merge
// staged nothing. The log must reflect what actually happened.

suite('gitOps.detectMergeConflicts — clean-merge log wording (gh-802 AC3a)', function() {

    function runDetect(quietDiffExit) {
        var logs = [];
        var warns = [];
        var origLog = console.log;
        var origWarn = console.warn;
        console.log = function() {
            logs.push(Array.prototype.slice.call(arguments).join(' '));
        };
        console.warn = function() {
            warns.push(Array.prototype.slice.call(arguments).join(' '));
        };
        try {
            var gitOps = loadGitOps({
                cli_execute_command: function(args) {
                    var c = args.command || '';
                    if (c === 'git rev-parse --is-shallow-repository') return 'false\nCOMMAND_EXIT_CODE=0';
                    if (c === 'git merge origin/main --no-commit --no-ff') return 'Merge cleanup\nCOMMAND_EXIT_CODE=0';
                    if (c === 'git diff --cached --quiet HEAD') {
                        if (quietDiffExit === 0) return 'COMMAND_EXIT_CODE=0';
                        if (quietDiffExit === 'corrupt') throw new Error('fatal: unable to read the index — COMMAND_EXIT_CODE=128');
                        throw new Error('exit 1 — the merge staged changes');
                    }
                    return 'COMMAND_EXIT_CODE=0';
                }
            });
            var conflicts = gitOps.detectMergeConflicts('main', 'input/PROJ-123', null);
            return { conflicts: conflicts, logs: logs, warns: warns };
        } finally {
            console.log = origLog;
            console.warn = origWarn;
        }
    }

    test('an up-to-date merge (nothing staged) must NOT claim "base branch changes staged"', function() {
        var fx = runDetect(0);

        assert.deepEqual(fx.conflicts, [], 'clean merge — no conflicts');
        var joined = fx.logs.join('\n');
        assert.ok(joined.indexOf('base branch changes staged') === -1,
            'no false "base branch changes staged" line on an up-to-date merge, got: ' + JSON.stringify(fx.logs));
        assert.ok(joined.indexOf('already up to date') !== -1,
            'the up-to-date case is named explicitly, got: ' + JSON.stringify(fx.logs));
        assert.equal(fx.warns.length, 0, 'the normal exit-0 quiet-diff path is silent — got: ' + JSON.stringify(fx.warns));
    });

    test('a merge that stages base changes keeps the "base branch changes staged" wording', function() {
        var fx = runDetect(1);

        assert.deepEqual(fx.conflicts, [], 'clean merge — no conflicts');
        var joined = fx.logs.join('\n');
        assert.ok(joined.indexOf('No merge conflicts — base branch changes staged') !== -1,
            'staged-changes case keeps the informative wording, got: ' + JSON.stringify(fx.logs));
        // gh-802 rework (thread 4): exit 1 IS the expected "staged" signal —
        // it must not produce an anomaly warning.
        assert.equal(fx.warns.length, 0,
            'exit 1 is the expected staged-changes signal, no warn expected — got: ' + JSON.stringify(fx.warns));
    });

    test('a quiet-diff failure that is NOT exit 1 is flagged as a git error, not silently claimed as "staged"', function() {
        var fx = runDetect('corrupt');

        assert.deepEqual(fx.conflicts, [], 'the detection still completes with the staged assumption');
        var joined = fx.logs.join('\n');
        assert.ok(joined.indexOf('base branch changes staged') !== -1,
            'the conservative "staged" fallback wording is kept, got: ' + JSON.stringify(fx.logs));
        var joinedWarns = fx.warns.join('\n');
        assert.ok(fx.warns.length > 0, 'a non-exit-1 quiet-diff failure is announced');
        assert.ok(joinedWarns.indexOf('unable to read the index') !== -1,
            'the warn carries the failure content, got: ' + JSON.stringify(fx.warns));
    });
});
