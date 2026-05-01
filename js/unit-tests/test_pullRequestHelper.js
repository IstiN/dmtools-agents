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

});
