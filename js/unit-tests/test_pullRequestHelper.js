/**
 * Unit tests for agents/js/common/pullRequest.js
 */

function loadPullRequestHelper(mocks) {
    return loadModule(
        'agents/js/common/pullRequest.js',
        null,
        Object.assign({
            cli_execute_command: function() { return ''; },
            file_read: function() { return null; },
            file_write: function() {}
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
                if (command === 'git config --get remote.origin.url') return 'git@github.com:epam/dm.ai.git';
                if (command.indexOf('gh pr create') === 0) return 'Created pull request #789';
                return '';
            },
            writeFile: function() {}
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/epam/dm.ai/pull/789');
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
                if (command.indexOf('git merge-base --is-ancestor') === 0) throw new Error('not ancestor');
                if (command === 'git status --porcelain --ignore-submodules=dirty') return '';
                return '';
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.updated, true);
        assert.deepEqual(commands, [
            { command: 'git -c fetch.recurseSubmodules=no fetch origin main', workingDirectory: 'repo' },
            { command: 'git merge-base --is-ancestor origin/main HEAD', workingDirectory: 'repo' },
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
                if (command.indexOf('git merge-base --is-ancestor') === 0) return 'up_to_date';
                return '';
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.updated, false);
        assert.deepEqual(commands, [
            'git -c fetch.recurseSubmodules=no fetch origin release',
            'git merge-base --is-ancestor origin/release HEAD'
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
                if (command.indexOf('git merge-base --is-ancestor') === 0) throw new Error('not ancestor');
                if (command === 'git status --porcelain --ignore-submodules=dirty') return '';
                return '';
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.updated, true);
        assert.deepEqual(commands, [
            { command: 'git -c fetch.recurseSubmodules=no fetch origin main', workingDirectory: 'repo' },
            { command: 'git merge-base --is-ancestor origin/main HEAD', workingDirectory: 'repo' },
            { command: 'git status --porcelain --ignore-submodules=dirty', workingDirectory: 'repo' },
            { command: 'git merge --no-edit origin/main', workingDirectory: 'repo' }
        ]);
    });

});
