/**
 * Unit tests for the origin/<baseBranch> remote-tracking-ref fix.
 *
 * Regression coverage for a real production failure: a `pr_rework` run
 * targeting a fixVersion-derived base branch (`develop/3.9.0`, not `main`)
 * failed with `fatal: ambiguous argument 'origin/develop/3.9.0': unknown
 * revision or path not in the working tree` inside syncBranchWithBase,
 * detectMergeConflicts and getPRDiff — because `git fetch origin
 * <baseBranch>` (no destination refspec) only updates FETCH_HEAD, never
 * `refs/remotes/origin/<baseBranch>`. It "worked" for `main` only because a
 * long-lived cached checkout already had `origin/main` from an earlier full
 * clone.
 *
 * Runs with plain Node.js. Mocks `cli_execute_command` so no real git/network
 * calls are made; assertions check that the explicit-refspec fetch
 * (`+refs/heads/<b>:refs/remotes/origin/<b>`) is issued for a non-main base
 * branch before any command that reads `origin/<baseBranch>`.
 */

const assert = require('assert');
const path = require('path');

const AGENT_JS_DIR = path.resolve(__dirname, '..');

const BASE_BRANCH = 'develop/3.9.0';

// ---- fake git state ---------------------------------------------------------
// Simulates a cached checkout where origin/develop/3.9.0 does NOT exist yet
// (unlike origin/main, which "just works" from earlier runs).
let remoteRefFetched = false;
const executedCommands = [];

function resetGitState() {
    remoteRefFetched = false;
    executedCommands.length = 0;
}

const EXPLICIT_REFSPEC_FETCH =
    'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/' + BASE_BRANCH + ':refs/remotes/origin/' + BASE_BRANCH;

global.cli_execute_command = function(opts) {
    const command = (opts && opts.command) || '';
    executedCommands.push(command);

    if (command === EXPLICIT_REFSPEC_FETCH) {
        remoteRefFetched = true;
        return '';
    }

    // Any command referencing origin/<baseBranch> before the explicit-refspec
    // fetch happened simulates the real "unknown revision" failure.
    if (command.indexOf('origin/' + BASE_BRANCH) !== -1 && !remoteRefFetched) {
        throw new Error("fatal: ambiguous argument 'origin/" + BASE_BRANCH + "': unknown revision or path not in the working tree.");
    }

    if (command.indexOf('git rev-parse --is-shallow-repository') === 0) return 'false';
    if (command.indexOf('git rev-parse --abbrev-ref HEAD') === 0) return 'feature/ticket-123';
    if (command.indexOf('git status --porcelain') === 0) return '';
    if (command.indexOf('git status --short') === 0) return '';
    if (command.indexOf('git branch --list') === 0) return 'feature/ticket-123';
    if (command.indexOf('git ls-remote --heads origin') === 0) return 'abc123\trefs/heads/feature/ticket-123';
    if (command.indexOf('git checkout') === 0) return '';
    if (command.indexOf('git pull') === 0) return '';
    if (command.indexOf('git config') === 0) return '';
    if (command.indexOf('git rev-parse origin/' + BASE_BRANCH) === 0) return 'abc123deadbeef\n';
    if (command.indexOf('git merge-base') === 0) return 'abc123deadbeef\n';
    if (command.indexOf('git diff') === 0) return 'diff --git a/x b/x\n';

    return '';
};
global.file_read = function() { return ''; };
global.file_write = function() { return true; };
global.file_delete = function() { return true; };

// ---- tests -------------------------------------------------------------------
function test(name, fn) {
    resetGitState();
    try {
        fn();
        console.log('  ✅', name);
    } catch (e) {
        console.error('  ❌', name);
        throw e;
    }
}

function runTests() {
    console.log('Running git_remote_tracking_ref tests...');

    const prHelper = require(path.join(AGENT_JS_DIR, 'common', 'pullRequest.js'));
    const gitOps = require(path.join(AGENT_JS_DIR, 'common', 'gitOps.js'));

    test('ensureRemoteBranchRef issues explicit-refspec fetch for a non-main branch', () => {
        const runCommand = function(cmd, wd) {
            return global.cli_execute_command({ command: cmd, workingDirectory: wd });
        };
        const ok = prHelper.ensureRemoteBranchRef(runCommand, null, BASE_BRANCH);
        assert.strictEqual(ok, true, 'should report success');
        assert.ok(remoteRefFetched, 'explicit refspec fetch should have run');
    });

    test('syncBranchWithBase resolves origin/<baseBranch> after ensureRemoteBranchRef (no "unknown revision" failure)', () => {
        const result = prHelper.syncBranchWithBase({
            branchName: 'feature/ticket-123',
            baseBranch: BASE_BRANCH,
            runCommand: function(cmd, wd) {
                return global.cli_execute_command({ command: cmd, workingDirectory: wd });
            }
        });
        assert.ok(remoteRefFetched, 'should have fetched the explicit ref before rev-parsing origin/<baseBranch>');
        assert.strictEqual(result.success, true, 'sync should succeed: ' + (result.error || ''));
    });

    test('syncBranchWithBase surfaces the original git error instead of a misleading "No conflicted files detected" message', () => {
        // Simulate a genuine unresolved failure unrelated to a missing ref
        // (e.g. merge throws for some other reason) with zero conflict markers
        // in git status --short — resolveMergeConflicts finds nothing to fix,
        // and previously this replaced the real error with a generic message.
        // Force branchContainsBase to report "not up to date" (different SHAs)
        // so syncBranchWithBase proceeds all the way to the merge attempt.
        const runCommand = function(cmd) {
            if (cmd.indexOf('git -c fetch.recurseSubmodules=no fetch origin +refs/heads/') === 0) {
                remoteRefFetched = true;
                return '';
            }
            if (cmd.indexOf('git rev-parse origin/' + BASE_BRANCH) === 0) return 'base-sha\n';
            if (cmd.indexOf('git merge-base origin/' + BASE_BRANCH + ' HEAD') === 0) return 'different-sha\n';
            if (cmd.indexOf('git status --porcelain') === 0) return '';
            if (cmd.indexOf('git merge --no-edit origin/') === 0) {
                throw new Error('fatal: something unexpected happened during merge');
            }
            if (cmd.indexOf('git status --short') === 0) return '';
            if (cmd.indexOf('git merge --abort') === 0) return '';
            return '';
        };
        const result = prHelper.syncBranchWithBase({
            branchName: 'feature/ticket-123',
            baseBranch: BASE_BRANCH,
            runCommand: runCommand
        });
        assert.strictEqual(result.success, false);
        assert.ok(
            result.error.indexOf('something unexpected happened during merge') !== -1,
            'should preserve the original error, got: ' + result.error
        );
    });

    test('getPRDiff ensures origin/<baseBranch> ref before diffing a non-main base branch', () => {
        const diff = gitOps.getPRDiff(BASE_BRANCH, 'feature/ticket-123', null);
        assert.ok(remoteRefFetched, 'should have fetched the explicit ref before diffing');
        assert.ok(diff && diff.length > 0, 'should return a non-empty diff');
    });

    test('detectMergeConflicts ensures origin/<baseBranch> ref before merging a non-main base branch', () => {
        const conflicts = gitOps.detectMergeConflicts(BASE_BRANCH, 'input/TICKET-123', null);
        assert.ok(remoteRefFetched, 'should have fetched the explicit ref before merging');
        assert.deepStrictEqual(conflicts, [], 'should report no conflicts on a clean merge');
    });

    test('checkoutPRBranch ensures origin/<baseBranch> ref exists as soon as the branch is known', () => {
        gitOps.checkoutPRBranch('feature/ticket-123', null, BASE_BRANCH);
        assert.ok(remoteRefFetched, 'should have fetched the explicit ref during checkout');
    });

    console.log('✅ All git_remote_tracking_ref tests passed');
}

runTests();
