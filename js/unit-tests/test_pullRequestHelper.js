/**
 * Unit tests for js/common/pullRequest.js
 */

function loadPullRequestHelper(mocks) {
    var mergeStateModule = loadModule('js/common/mergeState.js');
    return loadModule(
        'js/common/pullRequest.js',
        makeRequire({
            './mergeState.js': mergeStateModule,
            './common/mergeState.js': mergeStateModule
        }),
        Object.assign({
            cli_execute_command: function() { return ''; },
            file_read: function() { return null; },
            file_write: function() {},
            file_delete: function() {}
        }, mocks || {})
    );
}

suite('pullRequest helper', function() {

    test('sanitizes shell metacharacters in PR titles', function() {
        var pr = loadPullRequestHelper();
        var title = pr.sanitizeTitle('DMC-1 Fix A -> B <bad> | $x; `cmd`');

        assert.contains(title, 'A → B', 'keeps readable arrow');
        assert.notContains(title, '<', 'removes less-than');
        assert.notContains(title, '>', 'removes greater-than');
        assert.notContains(title, '|', 'removes pipe');
        assert.notContains(title, '$', 'removes dollar');
        assert.notContains(title, ';', 'removes semicolon');
        assert.notContains(title, '`', 'removes backtick');
    });

    test('truncates an overlong title to 255 chars (GitHub/GitLab hard limit)', function() {
        // Regression for GENSGENP-53793: '{ticketKey} {ticketSummary}' can push an
        // already near-limit (255-char, truncated by createRepoTasks*.js) ticket
        // summary over the GitLab MR title cap, causing
        // "title is too long (maximum is 255 characters)".
        var pr = loadPullRequestHelper();
        var longTitle = 'GENSGENP-53793 ' + 'A'.repeat(300);
        var result = pr.sanitizeTitle(longTitle);

        assert.equal(result.length, 255, 'title truncated to 255 chars');
        assert.equal(result.slice(-3), '...', 'truncated title ends with ellipsis');
    });

    test('leaves a title at or under 255 chars unchanged (aside from metachar sanitization)', function() {
        var pr = loadPullRequestHelper();
        var title = 'GENSGENP-1 ' + 'B'.repeat(200);
        var result = pr.sanitizeTitle(title);

        assert.equal(result, title, 'short title passes through unchanged');
    });

    test('sanitizes commit messages and escapes quotes', function() {
        var pr = loadPullRequestHelper();
        var msg = pr.sanitizeCommitMessage("TS-1 Use <repo> and --header \"bad\" -> ok\nline");

        assert.notContains(msg, '<', 'removes less-than');
        assert.notContains(msg, '>', 'removes greater-than');
        assert.notContains(msg, '|', 'removes pipe');
        assert.notContains(msg, '&', 'removes ampersand');
        assert.notContains(msg, ';', 'removes semicolon');
        assert.notContains(msg, '$', 'removes dollar');
        assert.notContains(msg, '`', 'removes backtick');
        assert.notContains(msg, '\n', 'removes newline');
        assert.contains(msg, '\\"bad\\"', 'escapes internal quotes');
        assert.contains(msg, '→ ok', 'keeps readable arrow');
        assert.equal(msg.indexOf('  '), -1, 'collapses whitespace');
    });

    test('creates PR from temp body file and returns URL', function() {
        var commands = [];
        var writes = [];
        var pr = loadPullRequestHelper({
            cli_execute_command: function(args) {
                commands.push({ command: args.command, workingDirectory: args.workingDirectory || null });
                if (args.command.indexOf('gh pr list --head feature/DMC-1') === 0) return '';
                if (args.command.indexOf('gh pr create') === 0) return 'https://github.com/org/repo/pull/123';
                return '';
            },
            file_write: function(path, content) {
                writes.push({ path: path, content: content });
            }
        });

        var result = pr.createPullRequest({
            title: 'DMC-1 Example',
            branchName: 'feature/DMC-1',
            baseBranch: 'main',
            workingDir: 'repo',
            bodyContent: 'body'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/org/repo/pull/123');
        assert.deepEqual(writes[0], { path: 'repo/pr_body_tmp.md', content: 'body' });
        assert.contains(commands[1].command, '--body-file "pr_body_tmp.md"');
        assert.equal(commands[1].workingDirectory, 'repo');
    });

    test('returns existing PR without creating a duplicate', function() {
        var createCalled = false;
        var pr = loadPullRequestHelper({
            cli_execute_command: function(args) {
                if (args.command.indexOf('gh pr list --head feature/DMC-2') === 0) {
                    return 'https://github.com/org/repo/pull/456';
                }
                if (args.command.indexOf('gh pr create') === 0) createCalled = true;
                return '';
            }
        });

        var result = pr.createPullRequest({
            title: 'DMC-2 Example',
            branchName: 'feature/DMC-2',
            baseBranch: 'main',
            bodyContent: 'body'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/org/repo/pull/456');
        assert.equal(result.alreadyExisted, true);
        assert.equal(createCalled, false, 'gh pr create should not run when PR exists');
    });

    test('builds PR URL from dotted repository remote when gh returns only a PR number', function() {
        var pr = loadPullRequestHelper();

        var result = pr.createPullRequest({
            title: 'DMC-3 Example',
            branchName: 'feature/DMC-3',
            baseBranch: 'main',
            bodyContent: 'body',
            runCommand: function(command) {
                if (command.indexOf('gh pr list --head feature/DMC-3') === 0) return '';
                if (command === 'git config --get remote.origin.url') return 'git@github.com:example-org/example.repo.git';
                if (command.indexOf('gh pr create') === 0) return 'Created pull request #789';
                return '';
            },
            writeFile: function() {}
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/example-org/example.repo/pull/789');
    });

    test('syncs branch with base before publishing when behind', function() {
        var commands = [];
        var pr = loadPullRequestHelper();

        var result = pr.syncBranchWithBase({
            branchName: 'feature/DMC-4',
            baseBranch: 'main',
            workingDir: 'repo',
            runCommand: function(command, workingDir) {
                commands.push({ command: command, workingDirectory: workingDir || null });
                if (command === 'git rev-parse origin/main') return 'base-sha';
                if (command === 'git merge-base origin/main HEAD') return 'old-sha';
                if (command === 'git status --porcelain --ignore-submodules=dirty') return '';
                return '';
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.updated, true);
        assert.deepEqual(commands, [
            { command: 'git rev-parse --quiet --verify MERGE_HEAD', workingDirectory: 'repo' },
            { command: 'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main', workingDirectory: 'repo' },
            { command: 'git rev-parse origin/main', workingDirectory: 'repo' },
            { command: 'git merge-base origin/main HEAD', workingDirectory: 'repo' },
            { command: 'git merge-base origin/main HEAD', workingDirectory: 'repo' },
            { command: 'git status --porcelain --ignore-submodules=dirty', workingDirectory: 'repo' },
            { command: 'git merge --no-edit origin/main', workingDirectory: 'repo' }
        ]);
    });

    test('does not merge base when branch already contains it', function() {
        var commands = [];
        var pr = loadPullRequestHelper();

        var result = pr.syncBranchWithBase({
            branchName: 'feature/DMC-5',
            baseBranch: 'release',
            runCommand: function(command) {
                commands.push(command);
                if (command === 'git rev-parse origin/release') return 'base-sha';
                if (command === 'git merge-base origin/release HEAD') return 'base-sha';
                return '';
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.updated, false);
        assert.deepEqual(commands, [
            'git rev-parse --quiet --verify MERGE_HEAD',
            'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/release:refs/remotes/origin/release',
            'git rev-parse origin/release',
            'git merge-base origin/release HEAD'
        ]);
    });

    test('ignores dirty unmanaged submodule worktrees during branch sync', function() {
        var commands = [];
        var pr = loadPullRequestHelper();

        var result = pr.syncBranchWithBase({
            branchName: 'feature/DMC-6',
            baseBranch: 'main',
            workingDir: 'repo',
            runCommand: function(command, workingDir) {
                commands.push({ command: command, workingDirectory: workingDir || null });
                if (command === 'git rev-parse origin/main') return 'base-sha';
                if (command === 'git merge-base origin/main HEAD') return 'old-sha';
                if (command === 'git status --porcelain --ignore-submodules=dirty') return '';
                return '';
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.updated, true);
        assert.deepEqual(commands, [
            { command: 'git rev-parse --quiet --verify MERGE_HEAD', workingDirectory: 'repo' },
            { command: 'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main', workingDirectory: 'repo' },
            { command: 'git rev-parse origin/main', workingDirectory: 'repo' },
            { command: 'git merge-base origin/main HEAD', workingDirectory: 'repo' },
            { command: 'git merge-base origin/main HEAD', workingDirectory: 'repo' },
            { command: 'git status --porcelain --ignore-submodules=dirty', workingDirectory: 'repo' },
            { command: 'git merge --no-edit origin/main', workingDirectory: 'repo' }
        ]);
    });

    test('refuses to merge unrelated histories during branch sync', function() {
        var commands = [];
        var pr = loadPullRequestHelper();

        var result = pr.syncBranchWithBase({
            branchName: 'feature/DMC-7',
            baseBranch: 'main',
            runCommand: function(command) {
                commands.push(command);
                if (command === 'git rev-parse origin/main') return 'base-sha';
                if (command === 'git merge-base origin/main HEAD') return '';
                return '';
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.unrecoverableByAgent, true);
        assert.contains(result.error, 'No merge base found');
        assert.equal(commands.indexOf('git merge --no-edit origin/main'), -1);
        assert.ok(commands.indexOf('git -c fetch.recurseSubmodules=no fetch --deepen=100 origin +refs/heads/main:refs/remotes/origin/main') !== -1,
            'should deepen base history before declaring histories unrelated');
        assert.ok(commands.indexOf('git -c fetch.recurseSubmodules=no fetch --deepen=100 origin +refs/heads/feature/DMC-7:refs/remotes/origin/feature/DMC-7') !== -1,
            'should deepen head branch history before declaring histories unrelated');
    });

    test('gh-761: refuses to sync while a merge is already in progress (MERGE_HEAD) — never hijacks, resolves, or aborts the agent\'s merge', function() {
        var commands = [];
        var pr = loadPullRequestHelper();

        var result = pr.syncBranchWithBase({
            branchName: 'feature/DMC-9',
            baseBranch: 'main',
            workingDir: 'repo',
            runCommand: function(command, workingDir) {
                commands.push({ command: command, workingDirectory: workingDir || null });
                if (command === 'git rev-parse --quiet --verify MERGE_HEAD') return '9a7e2aecommitsha';
                return '';
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.mergeInProgress, true, 'must flag the refusal as mergeInProgress');
        assert.contains(result.error, 'MERGE_HEAD');
        // The refusal must be the FIRST decision — nothing mutating before it.
        assert.equal(commands.length, 1, 'only the MERGE_HEAD probe may run');
        assert.contains(commands[0].command, 'git rev-parse --quiet --verify MERGE_HEAD');
        assert.equal(commands.filter(function(c) { return c.command.indexOf('git merge') === 0; }).length, 0,
            'must not start, resolve, or abort any merge');
        assert.equal(commands.filter(function(c) { return c.command.indexOf('git commit') === 0; }).length, 0,
            'must not finalize someone else\'s merge');
    });

    test('deepens shallow history before merge-base refusal', function() {
        var commands = [];
        var mergeBaseAttempts = 0;
        var pr = loadPullRequestHelper();

        var result = pr.syncBranchWithBase({
            branchName: 'feature/DMC-8',
            baseBranch: 'main',
            workingDir: 'repo',
            runCommand: function(command, workingDir) {
                commands.push({ command: command, workingDirectory: workingDir || null });
                if (command === 'git rev-parse origin/main') return 'base-sha';
                if (command === 'git merge-base origin/main HEAD') {
                    mergeBaseAttempts += 1;
                    return mergeBaseAttempts < 3 ? '' : 'old-sha';
                }
                if (command === 'git status --porcelain --ignore-submodules=dirty') return '';
                return '';
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.updated, true);
        assert.ok(commands.some(function(call) {
            return call.command === 'git -c fetch.recurseSubmodules=no fetch --deepen=100 origin +refs/heads/main:refs/remotes/origin/main';
        }), 'expected base history deepen fetch');
        assert.ok(commands.some(function(call) {
            return call.command === 'git merge --no-edit origin/main';
        }), 'expected merge after merge-base is found');
    });

    test('truncates oversized PR body to fit GitHub limit', function() {        var writes = [];
        var pr = loadPullRequestHelper({
            cli_execute_command: function(args) {
                if (args.command.indexOf('gh pr list --head feature/DMC-9') === 0) return '';
                if (args.command.indexOf('gh pr create') === 0) return 'https://github.com/org/repo/pull/999';
                return '';
            },
            file_write: function(path, content) {
                writes.push({ path: path, content: content });
            }
        });

        var hugeBody = 'x'.repeat(70000);
        var result = pr.createPullRequest({
            title: 'DMC-9 Huge body',
            branchName: 'feature/DMC-9',
            baseBranch: 'main',
            workingDir: 'repo',
            bodyContent: hugeBody
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/org/repo/pull/999');
        assert.equal(writes.length, 1);
        assert.ok(writes[0].content.length <= 60000, 'body should be truncated to <= 60000 chars');
        assert.contains(writes[0].content, 'PR body truncated by automation');
    });

});

// gh-737: the merge bot (awf factory-merge-trigger) links approved issues to
// PRs ONLY via 'Closes #N' in the PR body (or branch 'N-*'). Factory-created
// PRs built from the response.md template don't carry it, so the bot merged
// nothing (merged=0 skipped=4). The Closes line must be guaranteed by
// construction in every PR the pack creates.
suite('pullRequest helper > Closes line (gh-737)', function() {

    test('extractIssueNumber pulls the trailing number from gh-N and PROJ-N keys', function() {
        var pr = loadPullRequestHelper();
        assert.equal(pr.extractIssueNumber('gh-737'), '737', 'gh-737 → 737');
        assert.equal(pr.extractIssueNumber('PROJ-123'), '123', 'PROJ-123 → 123');
        assert.equal(pr.extractIssueNumber('gh-737 '), '737', 'tolerates surrounding whitespace');
        assert.equal(pr.extractIssueNumber('no-digits'), null, 'no digits → null');
        assert.equal(pr.extractIssueNumber(''), null, 'empty key → null');
        assert.equal(pr.extractIssueNumber(null), null, 'null key → null');
    });

    test('ensureClosesLine prepends the canonical Closes line when absent', function() {
        var pr = loadPullRequestHelper();
        var result = pr.ensureClosesLine('### What changed\n- Fixed parser.\n', 'gh-737');

        assert.contains(result, 'Closes #737', 'Closes line present');
        assert.equal(result.indexOf('Closes #737'), 0, 'canonical line goes first so the merge bot sees it');
        assert.contains(result, '### What changed', 'original body preserved');
    });

    test('ensureClosesLine is idempotent when Closes #N is already present', function() {
        var pr = loadPullRequestHelper();
        var body = 'Closes #737\n\n### What changed\n- Fixed parser.\n';
        var result = pr.ensureClosesLine(body, 'gh-737');

        assert.equal(result, body, 'body with an existing Closes line is left untouched');
        assert.equal(result.split('Closes #737').length - 1, 1, 'exactly one Closes line');
    });

    test('ensureClosesLine still emits canonical Closes when the body only carries a non-canonical keyword (Fixes)', function() {
        var pr = loadPullRequestHelper();
        var result = pr.ensureClosesLine('Fixes #737\n\nSome description.\n', 'gh-737');

        assert.contains(result, 'Closes #737',
            'Fixes/Part-of (bot-side awf#19 patterns) never substitute for the canonical Closes');
    });

    test('ensureClosesLine leaves the body unchanged for non-GitHub tracker keys', function() {
        var pr = loadPullRequestHelper();
        var body = '### What changed\n- Fixed parser.\n';
        assert.equal(pr.ensureClosesLine(body, 'PROJ-123'), body, 'tracker keys must not produce Closes #N');
    });

    test('ensureClosesLine leaves the body unchanged when the key has no digits', function() {
        var pr = loadPullRequestHelper();
        var body = '### What changed\n- Fixed parser.\n';
        assert.equal(pr.ensureClosesLine(body, 'epic-no-digits'), body);
        assert.equal(pr.ensureClosesLine(body, null), body);
    });

    test('createPullRequest injects the Closes line into the written PR body (gh-cli path)', function() {
        var writes = [];
        var pr = loadPullRequestHelper({
            cli_execute_command: function(args) {
                if (args.command.indexOf('gh pr list --head ai/gh-737') === 0) return '';
                if (args.command.indexOf('gh pr create') === 0) return 'https://github.com/org/repo/pull/737';
                return '';
            },
            file_write: function(path, content) {
                writes.push({ path: path, content: content });
            }
        });

        var result = pr.createPullRequest({
            title: 'gh-737 Example',
            branchName: 'ai/gh-737',
            baseBranch: 'main',
            workingDir: 'repo',
            ticketKey: 'gh-737',
            bodyContent: '### What changed\n- Parser fix.\n'
        });

        assert.equal(result.success, true);
        assert.equal(writes.length, 1);
        assert.contains(writes[0].content, 'Closes #737',
            'the merge bot requires Closes #N in the body — it must be there even when the agent forgot it');
        assert.contains(writes[0].content, '### What changed', 'agent body preserved');
    });

    test('createPullRequest injects the Closes line for the SCM-provider path too', function() {
        var captured = null;
        var pr = loadPullRequestHelper();
        var fakeScm = {
            createPr: function(options) {
                captured = options;
                return { success: true, prUrl: 'https://gitlab.example.com/org/repo/merge_requests/5' };
            }
        };

        var result = pr.createPullRequest({
            title: 'gh-737 Example',
            branchName: 'ai/gh-737',
            baseBranch: 'main',
            ticketKey: 'gh-737',
            scm: fakeScm,
            bodyContent: 'body without closes line'
        });

        assert.equal(result.success, true);
        assert.ok(captured, 'scm.createPr must be called');
        assert.contains(captured.body, 'Closes #737', 'SCM path body also carries the canonical line');
    });

    test('createPullRequest without ticketKey keeps the body unchanged (back-compat)', function() {
        var writes = [];
        var pr = loadPullRequestHelper({
            cli_execute_command: function(args) {
                if (args.command.indexOf('gh pr list --head feature/DMC-1') === 0) return '';
                if (args.command.indexOf('gh pr create') === 0) return 'https://github.com/org/repo/pull/1';
                return '';
            },
            file_write: function(path, content) {
                writes.push({ path: path, content: content });
            }
        });

        var result = pr.createPullRequest({
            title: 'DMC-1 Example',
            branchName: 'feature/DMC-1',
            baseBranch: 'main',
            bodyContent: 'plain body'
        });

        assert.equal(result.success, true);
        assert.equal(writes[0].content, 'plain body',
            'callers that do not pass a ticketKey are unaffected');
    });

});

// ── gh-1041: createPullRequest branch characterization (CRAP split) ──────────
// Pins every remaining branch of the PR-creation seam before the function is
// split into pure build/decide helpers: missing branchName, the SCM-provider
// path (success / failure result / no result / already-exists error / other
// error) and the gh-cli path (existing-PR lookup failure, create failure with
// and without a recoverable existing PR, temp-body cleanup on every outcome).

suite('pullRequest helper > createPullRequest branches (gh-1041)', function() {

    test('requires branchName before either creation path runs', function() {
        var cliCalls = 0;
        var pr = loadPullRequestHelper({
            cli_execute_command: function() { cliCalls++; return ''; }
        });

        var result = pr.createPullRequest({
            title: 'x',
            scm: null
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'branchName is required');
        assert.equal(cliCalls, 0, 'no creation path may run without a branch');
    });

    test('SCM-provider path returns a failure result as-is', function() {
        var pr = loadPullRequestHelper();
        var failure = { success: false, error: 'validation failed' };

        var result = pr.createPullRequest({
            title: 'x',
            branchName: 'feature/DMC-10',
            scm: { createPr: function() { return failure; } }
        });

        assert.deepEqual(result, failure);
    });

    test('SCM-provider path synthesizes an error when createPr returns nothing', function() {
        var pr = loadPullRequestHelper();

        var result = pr.createPullRequest({
            title: 'x',
            branchName: 'feature/DMC-10',
            scm: { createPr: function() { return null; } }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'SCM provider returned no result from createPr');
    });

    test('SCM-provider path reports an already-existing PR/MR as a warning, not a success', function() {
        var pr = loadPullRequestHelper();

        var result = pr.createPullRequest({
            title: 'x',
            branchName: 'feature/DMC-10',
            scm: {
                createPr: function() { throw new Error('A pull request already exists for this branch'); }
            }
        });

        assert.equal(result.success, false, 'provider-side already-exists is surfaced as a failure for the caller to retry-idempotently');
        assert.contains(result.error, 'already exists');
    });

    test('SCM-provider path surfaces any other provider error', function() {
        var pr = loadPullRequestHelper();

        var result = pr.createPullRequest({
            title: 'x',
            branchName: 'feature/DMC-10',
            scm: { createPr: function() { throw new Error('boom'); } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'boom');
    });

    test('SCM-provider path reads the body from the first readable candidate file', function() {
        var pr = loadPullRequestHelper({
            file_read: function() { return 'response body'; }
        });
        var captured = null;

        var result = pr.createPullRequest({
            title: 'x',
            branchName: 'feature/DMC-10',
            scm: {
                createPr: function(options) {
                    captured = options;
                    return { success: true, prUrl: 'https://gitlab.example.com/org/repo/merge_requests/10' };
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(captured.body, 'response body', 'body resolved from the default candidate file');
    });

    test('SCM-provider path falls back to the default body when no candidate file reads', function() {
        var pr = loadPullRequestHelper();
        var captured = null;

        pr.createPullRequest({
            title: 'x',
            branchName: 'feature/DMC-10',
            defaultBody: 'fallback body',
            scm: {
                createPr: function(options) {
                    captured = options;
                    return { success: true, prUrl: 'u' };
                }
            }
        });

        assert.equal(captured.body, 'fallback body');
    });

    test('gh path tolerates a failing existing-PR lookup and creates anyway', function() {
        var commands = [];
        var pr = loadPullRequestHelper({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command.indexOf('gh pr list --head feature/DMC-11') === 0) {
                    throw new Error('gh not authenticated');
                }
                if (args.command.indexOf('gh pr create') === 0) return 'https://github.com/org/repo/pull/11';
                return '';
            }
        });

        var result = pr.createPullRequest({
            title: 'DMC-11 Example',
            branchName: 'feature/DMC-11',
            baseBranch: 'main',
            bodyContent: 'body'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/org/repo/pull/11');
        assert.ok(commands.some(function(c) { return c.indexOf('gh pr create') === 0; }), 'create still runs after lookup failure');
    });

    test('gh path recovers the existing PR URL when create reports already-exists', function() {
        var pr = loadPullRequestHelper();
        var listCalls = 0;

        var result = pr.createPullRequest({
            title: 'DMC-12 Example',
            branchName: 'feature/DMC-12',
            baseBranch: 'main',
            bodyContent: 'body',
            runCommand: function(command) {
                if (command.indexOf('gh pr list --head feature/DMC-12') === 0) {
                    listCalls++;
                    // first call (pre-check) empty; second call (recovery) returns the URL
                    return listCalls > 1 ? 'https://github.com/org/repo/pull/12' : '';
                }
                if (command.indexOf('gh pr create') === 0) {
                    throw new Error('a pull request for branch feature/DMC-12 already exists');
                }
                return '';
            },
            writeFile: function() {},
            deleteFile: function() {}
        });

        assert.equal(result.success, true);
        assert.equal(result.alreadyExisted, true);
        assert.equal(result.prUrl, 'https://github.com/org/repo/pull/12');
    });

    test('gh path returns the create error when no existing PR can be recovered', function() {
        var deleted = [];
        var pr = loadPullRequestHelper();

        var result = pr.createPullRequest({
            title: 'DMC-13 Example',
            branchName: 'feature/DMC-13',
            baseBranch: 'main',
            workingDir: 'repo',
            bodyContent: 'body',
            runCommand: function(command) {
                if (command.indexOf('gh pr list') === 0) return '';
                if (command.indexOf('gh pr create') === 0) {
                    throw new Error('a pull request for branch feature/DMC-13 already exists');
                }
                return '';
            },
            writeFile: function() {},
            deleteFile: function(path) { deleted.push(path); }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'already exists');
        assert.deepEqual(deleted, ['repo/pr_body_tmp.md'], 'temp body file cleaned up on failure');
    });

    test('gh path returns an unrelated create error and still cleans the temp body file', function() {
        var deleted = [];
        var pr = loadPullRequestHelper();

        var result = pr.createPullRequest({
            title: 'DMC-14 Example',
            branchName: 'feature/DMC-14',
            baseBranch: 'main',
            workingDir: 'repo/',
            bodyContent: 'body',
            runCommand: function(command) {
                if (command.indexOf('gh pr list') === 0) return '';
                if (command.indexOf('gh pr create') === 0) throw new Error('HTTP 500');
                return '';
            },
            writeFile: function() {},
            deleteFile: function(path) { deleted.push(path); }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'HTTP 500');
        assert.deepEqual(deleted, ['repo/pr_body_tmp.md'], 'trailing slash on workingDir must not double the path separator');
    });

    test('gh path deletes the temp body file after a successful create', function() {
        var deleted = [];
        var pr = loadPullRequestHelper();

        var result = pr.createPullRequest({
            title: 'DMC-15 Example',
            branchName: 'feature/DMC-15',
            baseBranch: 'main',
            workingDir: 'repo',
            bodyContent: 'body',
            runCommand: function(command) {
                if (command.indexOf('gh pr list') === 0) return '';
                if (command.indexOf('gh pr create') === 0) return 'https://github.com/org/repo/pull/15';
                return '';
            },
            writeFile: function() {},
            deleteFile: function(path) { deleted.push(path); }
        });

        assert.equal(result.success, true);
        assert.deepEqual(deleted, ['repo/pr_body_tmp.md']);
    });

    test('gh path writes the body to a caller-provided temp file name', function() {
        var writes = [];
        var pr = loadPullRequestHelper();

        pr.createPullRequest({
            title: 'DMC-16 Example',
            branchName: 'feature/DMC-16',
            baseBranch: 'main',
            workingDir: 'repo',
            tempBodyFile: 'custom_body.md',
            bodyContent: 'body',
            runCommand: function(command) {
                if (command.indexOf('gh pr list') === 0) return '';
                if (command.indexOf('--body-file "custom_body.md"') !== -1) {
                    return 'https://github.com/org/repo/pull/16';
                }
                return '';
            },
            writeFile: function(path, content) { writes.push({ path: path, content: content }); },
            deleteFile: function() {}
        });

        assert.deepEqual(writes, [{ path: 'repo/custom_body.md', content: 'body' }]);
    });

});

// ── gh-912: strict ls-remote ref-line parsing ────────────────────────────────
// The JS bridge hands scripts stdout+stderr merged, so a `warning: redirecting
// to …` line (git ≥ 2.54 against a redirecting server) survives output
// cleaning. Branch-existence probes must decide on real ref lines
// (<sha>\trefs/heads/<name>), never on capture non-emptiness.

var SHA40 = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec';

suite('pullRequest helper — remoteBranchExists / remoteBranchSha (gh-912 UT-1)', function() {

    function probe(capture, branchName) {
        var pr = loadPullRequestHelper({
            cli_execute_command: function() { return capture; }
        });
        return {
            exists: pr.remoteBranchExists(function(command) {
                assert.ok(command.indexOf('git ls-remote --heads origin ') === 0,
                    'probe must use `git ls-remote --heads origin <branch>`, got: ' + command);
                return capture;
            }, null, branchName || 'ai/PROJ-1'),
            sha: pr.remoteBranchSha(function() { return capture; }, null, branchName || 'ai/PROJ-1')
        };
    }

    test('empty capture → not exists (create-branch semantics preserved)', function() {
        var r = probe('');
        assert.equal(r.exists, false);
        assert.equal(r.sha, null);
    });

    test('warning-only capture → not exists — the gh-912 defect (AC3/UT-1)', function() {
        var r = probe('warning: redirecting to https://git.example.com/\n');
        assert.equal(r.exists, false, 'stderr noise must never classify as branch existence');
        assert.equal(r.sha, null);
    });

    test('real ref line → exists, SHA extracted (E1: full 40-hex)', function() {
        var r = probe(SHA40 + '\trefs/heads/ai/PROJ-1\n');
        assert.equal(r.exists, true);
        assert.equal(r.sha, SHA40);
    });

    test('SHA-256 repositories: 64-hex ref line → exists, SHA extracted', function() {
        var sha64 = SHA40 + '0123456789abcdef01234567';
        assert.equal(sha64.length, 64);
        var r = probe(sha64 + '\trefs/heads/ai/PROJ-1\n');
        assert.equal(r.exists, true);
        assert.equal(r.sha, sha64);
    });

    test('shortened 7-hex SHA still accepted (E1: any real form)', function() {
        var r = probe('9a7e2ae\trefs/heads/ai/PROJ-1\n');
        assert.equal(r.exists, true);
        assert.equal(r.sha, '9a7e2ae');
    });

    test('warning BEFORE the ref line → exists (E3: merge order not guaranteed)', function() {
        var r = probe('warning: redirecting to https://git.example.com/\n' + SHA40 + '\trefs/heads/ai/PROJ-1\n');
        assert.equal(r.exists, true);
        assert.equal(r.sha, SHA40);
    });

    test('warning AFTER the ref line → exists (E3: both orders)', function() {
        var r = probe(SHA40 + '\trefs/heads/ai/PROJ-1\nwarning: redirecting to https://git.example.com/\n');
        assert.equal(r.exists, true);
        assert.equal(r.sha, SHA40);
    });

    test('prose/garbage (6-hex words, space separators) → not exists', function() {
        var r = probe('9a7e2a some prose refs/heads/ai/PROJ-1\n');
        assert.equal(r.exists, false);
        assert.equal(r.sha, null);
    });

    test('refs/tags/ lines never satisfy the heads probe (E5)', function() {
        var r = probe(SHA40 + '\trefs/tags/v1.0.0\n');
        assert.equal(r.exists, false);
        assert.equal(r.sha, null);
    });

    test('exact-name anchoring: ai/PROJ-1 does not match ai/PROJ-1_OLD', function() {
        var r = probe(SHA40 + '\trefs/heads/ai/PROJ-1_OLD\n', 'ai/PROJ-1');
        assert.equal(r.exists, false);
        assert.equal(r.sha, null);
    });

    test('regex-hostile branch names are escaped (E2: feature/x.y.z vs feature/xQyz)', function() {
        var rExists = probe(SHA40 + '\trefs/heads/feature/x.y.z\n', 'feature/x.y.z');
        assert.equal(rExists.exists, true, 'dotted name must match itself');
        var rNoOver = probe(SHA40 + '\trefs/heads/feature/xQyz\n', 'feature/x.y.z');
        assert.equal(rNoOver.exists, false, 'unescaped dot would over-match a different branch');
    });

    test('trailing carriage return (CRLF bridges) still matches', function() {
        var r = probe(SHA40 + '\trefs/heads/ai/PROJ-1\r\n');
        assert.equal(r.exists, true);
        assert.equal(r.sha, SHA40);
    });

});

suite('pullRequest helper — cleanCommandOutput / stripGitNoise (gh-912 UT-3, backward compat)', function() {

    test('cleanCommandOutput keeps `warning:`/`note:` lines — they are DATA for commit subjects, file lists, diffs', function() {
        var pr = loadPullRequestHelper();
        var out = pr.cleanCommandOutput('note: keep legacy flag\nwarning: deprecated api removed\nfix: real subject\n');
        assert.equal(out, 'note: keep legacy flag\nwarning: deprecated api removed\nfix: real subject');
    });

    test('stripGitNoise (opt-in) drops line-anchored git warning:/note: lines', function() {
        var pr = loadPullRequestHelper();
        var out = pr.stripGitNoise(
            'warning: redirecting to https://git.example.com/\nSHA-LINE\nnote: some git advisory\n');
        assert.equal(out, 'SHA-LINE');
    });

    test('stripGitNoise never drops mid-line occurrences (E4)', function() {
        var pr = loadPullRequestHelper();
        var out = pr.stripGitNoise(
            'diff --git a/x b/x\n+log.print("warning: weird")\n-// note: legacy\n');
        assert.contains(out, '+log.print("warning: weird")');
        assert.contains(out, '-// note: legacy');
    });

    test('script wrapper lines are still dropped', function() {
        var pr = loadPullRequestHelper();
        var out = pr.cleanCommandOutput(
            'Script started on 2026-10-16\nCOMMAND=git status\nOn branch main\nCOMMAND_EXIT_CODE=0\nScript done on 2026-10-16\n');
        assert.equal(out, 'On branch main');
    });

});

// ── gh-965: resolveMergeConflicts characterization via syncBranchWithBase ────
// The conflict auto-resolution fallback (git merge --no-edit fails → resolve →
// commit, or abort) is pinned here end-to-end: same git commands, same order,
// same result shapes. Outcomes: keep branch version, keep base version,
// submodule conflict, already-clean status, unresolved remain, commit failure,
// status read failure.
suite('pullRequest helper — syncBranchWithBase conflict auto-resolution (gh-965)', function() {

    // Consumed-once reply matching: each scripted reply satisfies exactly one
    // call, in order. An unmatched git command means the scenario drifted from
    // what the test pins — fail loudly instead of silently succeeding.
    function takeReply(replies, command) {
        for (var i = 0; i < replies.length; i++) {
            if (!replies[i].used && command.indexOf(replies[i].match) === 0) {
                replies[i].used = true;
                return replies[i];
            }
        }
        throw new Error('scriptedSync: unmatched git command: ' + command);
    }

    // Scripted runCommand: dispatches by command prefix, each reply consumed
    // once (order-strict), records every call in order.
    function scriptedSync(script) {
        var commands = [];
        var replies = script.replies.map(function(r) { return { match: r.match, output: r.output, throwError: r.throwError, used: false }; });
        var pr = loadPullRequestHelper();
        var result = pr.syncBranchWithBase({
            branchName: script.branchName || 'feature/CONF-1',
            baseBranch: script.baseBranch || 'main',
            workingDir: 'repo',
            runCommand: function(command, workingDir) {
                commands.push({ command: command, workingDirectory: workingDir || null });
                var reply = takeReply(replies, command);
                if (reply.throwError) throw new Error(reply.throwError);
                return reply.output || '';
            }
        });
        return { result: result, commands: commands };
    }

    // Reply pair for the checkout+add a resolved file always ends with.
    function resolvedWith(side, file) {
        return [
            { match: 'git checkout --' + side + ' -- "' + file + '"', output: '' },
            { match: 'git add -- "' + file + '"', output: '' }
        ];
    }

    // Standard prefix: not mid-merge, behind base, clean tree, merge explodes.
    // merge-base is consumed in order: branchContainsBase, branchHasMergeBase,
    // then the merge-base lookup inside resolveMergeConflicts.
    function conflictPrefix(statusShort, mergeError) {
        return [
            { match: 'git rev-parse --quiet --verify MERGE_HEAD', output: '' },
            { match: 'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main', output: '' },
            { match: 'git rev-parse origin/main', output: 'base-sha' },
            { match: 'git merge-base origin/main HEAD', output: 'old-sha' },
            { match: 'git merge-base origin/main HEAD', output: 'old-sha' },
            { match: 'git status --porcelain --ignore-submodules=dirty', output: '' },
            { match: 'git merge --no-edit origin/main', throwError: mergeError || 'Auto-merging src/app.js\nCONFLICT (content): Merge conflict in src/app.js\nAutomatic merge failed' },
            { match: 'git status --short', output: statusShort },
            { match: 'git merge-base origin/main HEAD', output: 'mb-sha' }
        ];
    }

    test('keeps branch version (--ours) for files the branch changed, commits sync, autoResolved=true', function() {
        var s = scriptedSync({
            replies: conflictPrefix('UU src/app.js\nAA src/other.ts\n').concat([
                { match: 'git ls-files --stage -- "src/app.js"', output: '100644 abc123 1\tsrc/app.js' },
                { match: 'git diff mb-sha HEAD -- "src/app.js"', output: 'diff --git a/src/app.js b/src/app.js\n+branch line' },
                { match: 'git ls-files --stage -- "src/other.ts"', output: '100644 def456 1\tsrc/other.ts' },
                { match: 'git diff mb-sha HEAD -- "src/other.ts"', output: 'diff --git a/src/other.ts b/src/other.ts\n+branch line' },
                { match: 'git diff --name-only --diff-filter=U', output: '' },
                { match: 'git commit', output: '[feature/CONF-1 abc] Merge origin/main into feature/CONF-1' }
            ]).concat(resolvedWith('ours', 'src/app.js')).concat(resolvedWith('ours', 'src/other.ts'))
        });

        assert.equal(s.result.success, true);
        assert.equal(s.result.updated, true);
        assert.equal(s.result.autoResolved, true);
        assert.deepEqual(s.commands.map(function(c) { return c.command; }), [
            'git rev-parse --quiet --verify MERGE_HEAD',
            'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main',
            'git rev-parse origin/main',
            'git merge-base origin/main HEAD',
            'git merge-base origin/main HEAD',
            'git status --porcelain --ignore-submodules=dirty',
            'git merge --no-edit origin/main',
            'git status --short',
            'git merge-base origin/main HEAD',
            'git ls-files --stage -- "src/app.js"',
            'git diff mb-sha HEAD -- "src/app.js"',
            'git checkout --ours -- "src/app.js"',
            'git add -- "src/app.js"',
            'git ls-files --stage -- "src/other.ts"',
            'git diff mb-sha HEAD -- "src/other.ts"',
            'git checkout --ours -- "src/other.ts"',
            'git add -- "src/other.ts"',
            'git diff --name-only --diff-filter=U',
            'git commit -m "Merge origin/main into feature/CONF-1"'
        ]);
    });

    test('keeps origin/main version (--theirs) for files the branch did not change', function() {
        var s = scriptedSync({
            replies: conflictPrefix('UU src/app.js\n').concat([
                { match: 'git ls-files --stage -- "src/app.js"', output: '100644 abc123 1\tsrc/app.js' },
                { match: 'git diff mb-sha HEAD -- "src/app.js"', output: '' },
                { match: 'git diff --name-only --diff-filter=U', output: '' },
                { match: 'git commit', output: 'ok' }
            ]).concat(resolvedWith('theirs', 'src/app.js'))
        });

        assert.equal(s.result.success, true);
        assert.equal(s.result.autoResolved, true);
        assert.deepEqual(s.commands.filter(function(c) {
            return c.command.indexOf('git checkout') === 0;
        }).map(function(c) { return c.command; }), ['git checkout --theirs -- "src/app.js"']);
    });

    test('submodule conflict adopts origin/main version (--theirs) without a diff probe', function() {
        var s = scriptedSync({
            replies: conflictPrefix('UU src/sub\n').concat([
                { match: 'git ls-files --stage -- "src/sub"', output: '160000 deadbeef 1\tsrc/sub' },
                { match: 'git diff --name-only --diff-filter=U', output: '' },
                { match: 'git commit', output: 'ok' }
            ]).concat(resolvedWith('theirs', 'src/sub'))
        });

        assert.equal(s.result.success, true);
        assert.equal(s.result.autoResolved, true);
        assert.deepEqual(s.commands.map(function(c) { return c.command; }), [
            'git rev-parse --quiet --verify MERGE_HEAD',
            'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main',
            'git rev-parse origin/main',
            'git merge-base origin/main HEAD',
            'git merge-base origin/main HEAD',
            'git status --porcelain --ignore-submodules=dirty',
            'git merge --no-edit origin/main',
            'git status --short',
            'git merge-base origin/main HEAD',
            'git ls-files --stage -- "src/sub"',
            'git checkout --theirs -- "src/sub"',
            'git add -- "src/sub"',
            'git diff --name-only --diff-filter=U',
            'git commit -m "Merge origin/main into feature/CONF-1"'
        ]);
    });

    test('already-clean status (no conflict markers) aborts and reports the original merge error', function() {
        var s = scriptedSync({
            replies: conflictPrefix(' M src/other.js\n', 'merge exploded').concat([
                { match: 'git merge --abort', output: '' }
            ])
        });

        assert.equal(s.result.success, false);
        assert.equal(s.result.conflict, false);
        assert.deepEqual(s.result.conflictFiles, []);
        assert.equal(s.result.error, 'merge exploded', 'original git error is kept when no conflict markers exist');
        assert.ok(s.commands.some(function(c) { return c.command === 'git merge --abort'; }), 'merge must be aborted');
    });

    test('unresolvable conflicts remain → conflict=true, conflictFiles listed, merge aborted', function() {
        var s = scriptedSync({
            replies: conflictPrefix('UU src/app.js\n').concat([
                { match: 'git ls-files --stage -- "src/app.js"', output: '100644 abc123 1\tsrc/app.js' },
                { match: 'git diff mb-sha HEAD -- "src/app.js"', throwError: 'diff probe failed' },
                { match: 'git diff --name-only --diff-filter=U', output: 'src/app.js' },
                { match: 'git merge --abort', output: '' }
            ]).concat(resolvedWith('theirs', 'src/app.js'))
        });

        assert.equal(s.result.success, false);
        assert.equal(s.result.conflict, true);
        assert.deepEqual(s.result.conflictFiles, ['src/app.js']);
        assert.contains(s.result.error, 'Merge conflict while syncing with origin/main: src/app.js');
        assert.ok(s.commands.some(function(c) { return c.command === 'git merge --abort'; }));
    });

    test('commit failure after clean resolution surfaces the commit error', function() {
        var s = scriptedSync({
            replies: conflictPrefix('UU src/app.js\n').concat([
                { match: 'git ls-files --stage -- "src/app.js"', output: '100644 abc123 1\tsrc/app.js' },
                { match: 'git diff mb-sha HEAD -- "src/app.js"', output: '+line' },
                { match: 'git diff --name-only --diff-filter=U', output: '' },
                { match: 'git commit', throwError: 'nothing to commit' }
            ]).concat(resolvedWith('ours', 'src/app.js'))
        });

        assert.equal(s.result.success, false);
        assert.contains(s.result.error, 'Conflict files resolved but merge commit failed');
        assert.contains(s.result.error, 'nothing to commit');
    });

    test('unresolvable merge base keeps origin/main version (--theirs) without a diff probe', function() {
        var s = scriptedSync({
            replies: [
                { match: 'git rev-parse --quiet --verify MERGE_HEAD', output: '' },
                { match: 'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main', output: '' },
                { match: 'git rev-parse origin/main', output: 'base-sha' },
                { match: 'git merge-base origin/main HEAD', output: 'old-sha' },
                { match: 'git merge-base origin/main HEAD', output: 'old-sha' },
                { match: 'git status --porcelain --ignore-submodules=dirty', output: '' },
                { match: 'git merge --no-edit origin/main', throwError: 'merge conflict' },
                { match: 'git status --short', output: 'UU src/app.js\n' },
                { match: 'git merge-base origin/main HEAD', throwError: 'fatal: no merge base' },
                { match: 'git ls-files --stage -- "src/app.js"', output: '100644 abc123 1\tsrc/app.js' },
                { match: 'git diff --name-only --diff-filter=U', output: '' },
                { match: 'git commit', output: 'ok' }
            ].concat(resolvedWith('theirs', 'src/app.js'))
        });

        assert.equal(s.result.success, true);
        assert.equal(s.result.autoResolved, true);
        assert.deepEqual(s.commands.filter(function(c) {
            return c.command.indexOf('git checkout') === 0;
        }).map(function(c) { return c.command; }), ['git checkout --theirs -- "src/app.js"']);
    });

    test('unreadable conflict status surfaces the status error and aborts', function() {
        var s = scriptedSync({
            replies: [
                { match: 'git rev-parse --quiet --verify MERGE_HEAD', output: '' },
                { match: 'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main', output: '' },
                { match: 'git rev-parse origin/main', output: 'base-sha' },
                { match: 'git merge-base origin/main HEAD', output: 'old-sha' },
                { match: 'git merge-base origin/main HEAD', output: 'old-sha' },
                { match: 'git status --porcelain --ignore-submodules=dirty', output: '' },
                { match: 'git merge --no-edit origin/main', throwError: 'merge exploded' },
                { match: 'git status --short', throwError: 'fatal: not a git repository' },
                { match: 'git merge --abort', output: '' }
            ]
        });

        assert.equal(s.result.success, false);
        assert.equal(s.result.error, 'Could not read conflict status');
        assert.ok(s.commands.some(function(c) { return c.command === 'git merge --abort'; }));
    });

});

// gh-960: the PR body (including the canonical 'Closes #N' line) must be final
// BEFORE the PR enters the merge queue. Live 2026-10-17: PR #956 merged with
// 'Closes #952' added to the body at the merge moment (finalize-step rewrite
// after validation armed) — GitHub never parsed the keyword and #952 stayed
// OPEN. Once the validate→merge pipeline owns the PR (ai_validating armed) or
// the PR is merged/closed, a body rewrite is too late and must not happen.
suite('pullRequest helper > body freeze (gh-960)', function() {

    test('isPrBodyFrozen is true once the PR is merged', function() {
        var pr = loadPullRequestHelper();
        assert.equal(pr.isPrBodyFrozen({ number: 956, merged: true }), true);
        assert.equal(pr.isPrBodyFrozen({ number: 956, merged: true, state: 'closed' }), true);
    });

    test('isPrBodyFrozen is true when the PR state is closed or merged', function() {
        var pr = loadPullRequestHelper();
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'closed' }), true);
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'merged' }), true);
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'open' }), false);
    });

    test('isPrBodyFrozen is true while validation is armed (ai_validating label)', function() {
        var pr = loadPullRequestHelper();
        // Label objects ({name}) — the GitHub REST shape.
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'open',
            labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }] }), true,
            'ai_validating among several labels still freezes the body');
        // Plain-string labels — the shape other SCM adapters normalize to.
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'open',
            labels: ['ai_validating'] }), true);
    });

    test('isPrBodyFrozen is false for an open PR outside the merge queue', function() {
        var pr = loadPullRequestHelper();
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'open' }), false);
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'open',
            labels: [{ name: 'pr_approved' }, { name: 'rework-on-red' }] }), false,
            'labels other than ai_validating do not freeze the body');
        assert.equal(pr.isPrBodyFrozen({ number: 956 }), false, 'minimal PR shape');
        assert.equal(pr.isPrBodyFrozen(null), false);
        assert.equal(pr.isPrBodyFrozen(undefined), false);
    });

    test('isPrBodyFrozen covers ADO-shaped state: completed is frozen', function() {
        var pr = loadPullRequestHelper();
        // ADO closes work items/PRs as 'completed' — the closed/merged check
        // alone would not freeze an ADO-shaped PR (review thread
        // js/common/pullRequest.js:203).
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'completed' }), true);
        assert.equal(pr.isPrBodyFrozen({ id: 956, state: 'Completed' }), true,
            'state match is case-insensitive');
        assert.equal(pr.isPrBodyFrozen({ number: 956, state: 'active' }), false,
            'an active ADO PR is not frozen');
    });

});
