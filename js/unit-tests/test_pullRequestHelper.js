/**
 * Unit tests for js/common/pullRequest.js
 */

function loadPullRequestHelper(mocks) {
    return loadModule(
        'js/common/pullRequest.js',
        null,
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
