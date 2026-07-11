/**
 * Unit tests for js/common/gitOps.js — SCM-agnostic git operations shared by
 * GitHub- and GitLab-backed repos (checkoutPRBranch, getPRDiff,
 * detectMergeConflicts, writePRContext). None of these call a github_ or
 * gitlab_ tool — everything goes through cli_execute_command — so a single
 * test suite covers both providers.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

function loadGitOps(mocks) {
    return loadModule(
        'js/common/gitOps.js',
        makeRequire({
            '../config.js': configModule,
            'config': configModule,
            './pullRequest.js': {
                buildOriginFetchCommand: function(refSpec) {
                    return 'git -c fetch.recurseSubmodules=no fetch origin' + (refSpec ? ' ' + refSpec : '');
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
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x');

        var stashIdx = commands.indexOf('git add -A');
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
});

