/**
 * Unit tests for js/postStoryTestAutomationShared.js — shared helpers
 * extracted from the story test-automation post-actions (gh-1008 CRAP split).
 */

function loadShared(mocks) {
    return loadModule(
        'js/postStoryTestAutomationShared.js',
        makeRequire({}),
        mocks || {}
    );
}

// cli mock: exact-match handlers; unmatched commands throw (surfacing unexpected calls).
function cliMock(handlers, calls) {
    return function(args) {
        var command = args.command;
        calls.push(command);
        if (Object.prototype.hasOwnProperty.call(handlers, command)) {
            var h = handlers[command];
            if (typeof h === 'function') return h();
            return h;
        }
        throw new Error('unexpected command: ' + command);
    };
}

// Minimal pullRequest stand-in with the same contract the git ops rely on.
function fakePrHelper(opts) {
    opts = opts || {};
    return {
        cleanCommandOutput: function(output) {
            return String(output == null ? '' : output).replace(/\s+$/, '');
        },
        sanitizeCommitMessage: function(message) {
            return message.replace(/"/g, "'");
        },
        remoteBranchExists: function(runCommand, workingDir, branchName) {
            var out = runCommand('git ls-remote --heads origin ' + branchName, workingDir) || '';
            return out.indexOf('refs/heads/' + branchName) !== -1;
        }
    };
}

suite('postStoryTestAutomationShared: tracker holder', function() {

    test('creates the tracker lazily once and passes config + customParams through', function() {
        var created = [];
        var holder = loadShared({}).createTrackerHolder({
            createTracker: function(config, customParams) {
                created.push({ config: config, customParams: customParams });
                return { name: 'tracker-' + created.length };
            }
        });

        holder.initTracker({ jira: {} }, { trackerProvider: 'jira' });

        var t1 = holder.getTracker();
        var t2 = holder.getTracker();
        assert.equal(created.length, 1, 'tracker created exactly once');
        assert.equal(t1, t2, 'same instance returned');
        assert.deepEqual(created[0].customParams, { trackerProvider: 'jira' });
    });

    test('re-init after a config change creates a fresh tracker', function() {
        var created = [];
        var holder = loadShared({}).createTrackerHolder({
            createTracker: function() {
                created.push(true);
                return { name: 'tracker-' + created.length };
            }
        });

        holder.initTracker({ a: 1 }, {});
        var first = holder.getTracker();

        holder.initTracker({ a: 2 }, { trackerProvider: 'ado' });
        var second = holder.getTracker();

        assert.equal(created.length, 2);
        assert.notEqual(first, second);
    });

    test('initTracker tolerates missing config/customParams', function() {
        var created = [];
        var holder = loadShared({}).createTrackerHolder({
            createTracker: function(config, customParams) {
                created.push({ config: config, customParams: customParams });
                return {};
            }
        });
        holder.initTracker();
        holder.getTracker();
        assert.equal(created.length, 1);
        assert.equal(created[0].config, null);
        assert.deepEqual(created[0].customParams, {});
    });

});

suite('postStoryTestAutomationShared: resume attempt markers', function() {

    test('readAttemptMarker parses integer content', function() {
        var shared = loadShared({
            file_read: function() { return '2'; }
        });
        assert.equal(shared.readAttemptMarker('outputs/.marker'), 2);
    });

    test('readAttemptMarker returns 0 for non-numeric content', function() {
        var shared = loadShared({
            file_read: function() { return 'garbage'; }
        });
        assert.equal(shared.readAttemptMarker('outputs/.marker'), 0);
    });

    test('readAttemptMarker returns 0 when the read throws', function() {
        var shared = loadShared({
            file_read: function() { throw new Error('no such file'); }
        });
        assert.equal(shared.readAttemptMarker('outputs/.marker'), 0);
    });

    test('writeAttemptMarker writes the attempt as a string', function() {
        var written = [];
        var shared = loadShared({
            file_write: function(args) { written.push(args); }
        });
        shared.writeAttemptMarker('outputs/.marker', 3);
        assert.equal(written.length, 1);
        assert.equal(written[0].path, 'outputs/.marker');
        assert.equal(written[0].content, '3');
    });

    test('writeAttemptMarker swallows write errors', function() {
        var shared = loadShared({
            file_write: function() { throw new Error('read-only fs'); }
        });
        assert.doesNotThrow(function() {
            shared.writeAttemptMarker('outputs/.marker', 1);
        });
    });

});

suite('postStoryTestAutomationShared: markdownToJiraWiki', function() {

    var toWiki = function(md) { return loadShared({}).markdownToJiraWiki(md); };

    test('converts fenced code blocks with language to {code:lang}', function() {
        var wiki = toWiki('Before\n```bash\nnpm test\n```\nAfter');
        assert.contains(wiki, '{code:bash}\nnpm test\n{code}');
        assert.notContains(wiki, '```');
    });

    test('converts headings h1-h4', function() {
        var wiki = toWiki('# One\n## Two\n### Three\n#### Four');
        assert.contains(wiki, 'h1. One');
        assert.contains(wiki, 'h2. Two');
        assert.contains(wiki, 'h3. Three');
        assert.contains(wiki, 'h4. Four');
    });

    test('converts bullets, bold, inline code and links', function() {
        var wiki = toWiki('- item one\n- item two\n**bold** and `code` and [text](https://example.com/x)');
        assert.contains(wiki, '* item one');
        assert.contains(wiki, '* item two');
        assert.contains(wiki, '*bold*');
        assert.contains(wiki, '{{code}}');
        assert.contains(wiki, '[text|https://example.com/x]');
    });

    test('returns empty string for missing markdown', function() {
        assert.equal(toWiki(null), '');
        assert.equal(toWiki(''), '');
    });

});

suite('postStoryTestAutomationShared: removeLabelSafely', function() {

    test('returns true when the label is removed', function() {
        var removed = [];
        var shared = loadShared({});
        var ok = shared.removeLabelSafely(function() {
            return { removeLabel: function(key, label) { removed.push([key, label]); } };
        }, 'TS-1', 'wip');
        assert.equal(ok, true);
        assert.deepEqual(removed, [['TS-1', 'wip']]);
    });

    test('returns false when the tracker throws', function() {
        var shared = loadShared({});
        var ok = shared.removeLabelSafely(function() {
            return { removeLabel: function() { throw new Error('nope'); } };
        }, 'TS-1', 'wip');
        assert.equal(ok, false);
    });

});

suite('postStoryTestAutomationShared: runInRepo', function() {

    test('passes the command through and adds workingDirectory only when set', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: function(args) { calls.push(args); return 'out'; }
        });
        shared.runInRepo('git status', null);
        shared.runInRepo('git status', '/tmp/repo');
        assert.deepEqual(calls, [
            { command: 'git status' },
            { command: 'git status', workingDirectory: '/tmp/repo' }
        ]);
    });

});

suite('postStoryTestAutomationShared: git ops', function() {

    test('revParse trims cleaned output and returns "" on failure', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: cliMock({ 'git rev-parse HEAD': 'abc123\n' }, calls)
        });
        var ops = shared.createGitOps(fakePrHelper());
        assert.equal(ops.revParse('HEAD', null), 'abc123');
        assert.deepEqual(calls, ['git rev-parse HEAD']);

        var failing = loadShared({
            cli_execute_command: function() { throw new Error('boom'); }
        });
        assert.equal(failing.createGitOps(fakePrHelper()).revParse('HEAD', null), '');
    });

    test('findMergeBase returns the trimmed merge base', function() {
        var shared = loadShared({
            cli_execute_command: cliMock({ 'git merge-base HEAD origin/test/TS-1': 'def456\n' }, [])
        });
        assert.equal(
            shared.createGitOps(fakePrHelper()).findMergeBase('HEAD', 'origin/test/TS-1', null),
            'def456'
        );
    });

    test('fetchRemoteBranch reports success and failure', function() {
        var ok = loadShared({
            cli_execute_command: cliMock({ 'git fetch origin test/TS-1': '' }, [])
        });
        assert.equal(ok.createGitOps(fakePrHelper()).fetchRemoteBranch('test/TS-1', null), true);

        var bad = loadShared({ cli_execute_command: function() { throw new Error('offline'); } });
        assert.equal(bad.createGitOps(fakePrHelper()).fetchRemoteBranch('test/TS-1', null), false);
    });

    test('publishExistingBranch: same sha on both sides skips the push', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: cliMock({
                'git rev-parse HEAD': 'aaa\n',
                'git rev-parse origin/test/TS-2': 'aaa\n'
            }, calls)
        });
        var result = shared.createGitOps(fakePrHelper()).publishExistingBranch('test/TS-2', null);
        assert.equal(result.success, true);
        assert.equal(result.noNewCommit, true);
        assert.ok(calls.every(function(c) { return c.indexOf('git push') !== 0; }), 'no push issued');
    });

    test('publishExistingBranch: local strictly ahead fast-forward pushes', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: cliMock({
                'git rev-parse HEAD': 'bbb\n',
                'git rev-parse origin/test/TS-2': 'aaa\n',
                'git merge-base HEAD origin/test/TS-2': 'aaa\n',
                'git push -u origin test/TS-2': ''
            }, calls)
        });
        var result = shared.createGitOps(fakePrHelper()).publishExistingBranch('test/TS-2', null);
        assert.equal(result.success, true);
        assert.ok(calls.indexOf('git push -u origin test/TS-2') !== -1);
    });

    test('publishExistingBranch: a failed fast-forward push falls back to the lease push', function() {
        var calls = [];
        var pushAttempts = 0;
        var shared = loadShared({
            cli_execute_command: function(args) {
                calls.push(args.command);
                if (args.command === 'git rev-parse HEAD') return 'bbb\n';
                if (args.command === 'git rev-parse origin/test/TS-2') return 'aaa\n';
                if (args.command === 'git merge-base HEAD origin/test/TS-2') return 'aaa\n';
                if (args.command === 'git push -u origin test/TS-2') {
                    pushAttempts++;
                    if (pushAttempts === 1) throw new Error('rejected');
                    return '';
                }
                if (args.command === 'git push -u origin test/TS-2 --force-with-lease') return '';
                throw new Error('unexpected command: ' + args.command);
            }
        });
        var result = shared.createGitOps(fakePrHelper()).publishExistingBranch('test/TS-2', null);
        assert.equal(result.success, true);
        assert.equal(pushAttempts, 2);
        assert.ok(calls.indexOf('git push -u origin test/TS-2 --force-with-lease') !== -1);
    });

    test('syncDecision classifies identical/ahead/behind/diverged shas', function() {
        var ops = loadShared({}).createGitOps(fakePrHelper());
        assert.equal(ops.syncDecision('aaa', 'aaa', 'aaa'), 'identical');
        assert.equal(ops.syncDecision('bbb', 'aaa', 'aaa'), 'ahead');
        assert.equal(ops.syncDecision('aaa', 'bbb', 'aaa'), 'behind');
        assert.equal(ops.syncDecision('bbb', 'ccc', 'aaa'), 'diverged');
        assert.equal(ops.syncDecision('bbb', '', ''), 'diverged', 'unknown remote sha is treated as diverged');
    });

    test('publishExistingBranch: remote ahead resets to the remote state', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: cliMock({
                'git rev-parse HEAD': 'aaa\n',
                'git rev-parse origin/test/TS-2': 'ccc\n',
                'git merge-base HEAD origin/test/TS-2': 'aaa\n',
                'git reset --hard origin/test/TS-2': ''
            }, calls)
        });
        var result = shared.createGitOps(fakePrHelper()).publishExistingBranch('test/TS-2', null);
        assert.equal(result.success, true);
        assert.ok(calls.indexOf('git reset --hard origin/test/TS-2') !== -1);
        assert.ok(calls.every(function(c) { return c.indexOf('git push') !== 0; }), 'no push issued');
    });

    test('publishExistingBranch: diverged branches push, then retry with --force-with-lease', function() {
        var calls = [];
        var pushAttempts = 0;
        var shared = loadShared({
            cli_execute_command: function(args) {
                calls.push(args.command);
                if (args.command === 'git rev-parse HEAD') return 'bbb\n';
                if (args.command === 'git rev-parse origin/test/TS-2') return 'ccc\n';
                if (args.command === 'git merge-base HEAD origin/test/TS-2') return 'aaa\n';
                if (args.command === 'git push -u origin test/TS-2') {
                    pushAttempts++;
                    if (pushAttempts === 1) throw new Error('non-fast-forward');
                    return '';
                }
                if (args.command === 'git push -u origin test/TS-2 --force-with-lease') return '';
                throw new Error('unexpected command: ' + args.command);
            }
        });
        var result = shared.createGitOps(fakePrHelper()).publishExistingBranch('test/TS-2', null);
        assert.equal(result.success, true);
        assert.equal(pushAttempts, 1);
        assert.ok(calls.indexOf('git push -u origin test/TS-2 --force-with-lease') !== -1);
    });

    test('publishExistingBranch: both pushes failing reports an error', function() {
        var shared = loadShared({
            cli_execute_command: function(args) {
                if (args.command === 'git rev-parse HEAD') return 'bbb\n';
                if (args.command === 'git rev-parse origin/test/TS-2') return 'ccc\n';
                if (args.command === 'git merge-base HEAD origin/test/TS-2') return 'aaa\n';
                throw new Error('push refused');
            }
        });
        var result = shared.createGitOps(fakePrHelper()).publishExistingBranch('test/TS-2', null);
        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('could not be pushed') !== -1);
    });

    test('performGitOperations: staged changes commit and push', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: cliMock({
                'git status --short -- testing': '?? testing/tests/TS-1/test.py\n',
                'git add testing/': '',
                'git diff --cached --stat': ' testing/tests/TS-1/test.py | 1 +\n',
                'git commit -m "TS-1 test: automate"': '',
                'git push -u origin test/TS-1': '',
                'git ls-remote --heads origin test/TS-1': 'aaa\trefs/heads/test/TS-1\n'
            }, calls)
        });
        var ops = shared.createGitOps(fakePrHelper());
        var result = ops.performGitOperations('test/TS-1', 'TS-1 test: automate', null, 'testing/');
        assert.equal(result.success, true);
        assert.equal(result.branchName, 'test/TS-1');
        assert.ok(calls.indexOf('git commit -m "TS-1 test: automate"') !== -1);
        assert.ok(calls.indexOf('git push -u origin test/TS-1') !== -1);
    });

    test('performGitOperations: nothing staged and no remote branch pushes the current state', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: cliMock({
                'git status --short -- testing': '',
                'git add testing/': '',
                'git diff --cached --stat': '',
                'git ls-remote --heads origin test/TS-1': '',
                'git push -u origin test/TS-1': ''
            }, calls)
        });
        var result = shared.createGitOps(fakePrHelper())
            .performGitOperations('test/TS-1', 'msg', null, 'testing/');
        assert.equal(result.success, true);
        assert.equal(result.noNewCommit, true);
        assert.ok(calls.indexOf('git push -u origin test/TS-1') !== -1);
    });

    test('performGitOperations: nothing staged adopts the existing remote branch', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: cliMock({
                'git status --short -- testing': '',
                'git add testing/': '',
                'git diff --cached --stat': '',
                'git rev-parse HEAD': 'aaa\n',
                'git rev-parse origin/test/TS-1': 'aaa\n',
                'git ls-remote --heads origin test/TS-1': 'aaa\trefs/heads/test/TS-1\n'
            }, calls)
        });
        var result = shared.createGitOps(fakePrHelper())
            .performGitOperations('test/TS-1', 'msg', null, 'testing/');
        assert.equal(result.success, true);
        assert.equal(result.noNewCommit, true);
        assert.ok(calls.every(function(c) { return c.indexOf('git push') !== 0; }), 'no push issued');
    });

    test('performGitOperations: push without a remote ref afterwards reports failure', function() {
        var shared = loadShared({
            cli_execute_command: cliMock({
                'git status --short -- testing': '?? testing/tests/TS-1/test.py\n',
                'git add testing/': '',
                'git diff --cached --stat': ' testing/tests/TS-1/test.py | 1 +\n',
                'git commit -m "msg"': '',
                'git push -u origin test/TS-1': '',
                'git ls-remote --heads origin test/TS-1': ''
            }, [])
        });
        var result = shared.createGitOps(fakePrHelper())
            .performGitOperations('test/TS-1', 'msg', null, 'testing/');
        assert.equal(result.success, false);
    });

    test('performGitOperations: a failing commit reports failure', function() {        var shared = loadShared({
            cli_execute_command: cliMock({
                'git status --short -- testing': '?? testing/tests/TS-1/test.py\n',
                'git add testing/': '',
                'git diff --cached --stat': ' testing/tests/TS-1/test.py | 1 +\n',
                'git commit -m "msg"': function() { throw new Error('nothing to commit'); }
            }, [])
        });
        var result = shared.createGitOps(fakePrHelper())
            .performGitOperations('test/TS-1', 'msg', null, 'testing/');
        assert.equal(result.success, false);
    });

    test('performGitOperations: normal push failure escalates to force-with-lease then force', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: function(args) {
                calls.push(args.command);
                if (args.command === 'git status --short -- testing') return '?? testing/tests/TS-1/test.py\n';
                if (args.command === 'git add testing/') return '';
                if (args.command === 'git diff --cached --stat') return ' f | 1 +\n';
                if (args.command === 'git commit -m "msg"') return '';
                if (args.command === 'git fetch origin test/TS-1') return '';
                if (args.command === 'git push -u origin test/TS-1') throw new Error('rejected');
                if (args.command === 'git push -u origin test/TS-1 --force-with-lease') throw new Error('rejected');
                if (args.command === 'git push -u origin test/TS-1 --force') return '';
                if (args.command.indexOf('git ls-remote --heads origin test/TS-1') === 0) return 'aaa\trefs/heads/test/TS-1\n';
                throw new Error('unexpected command: ' + args.command);
            }
        });
        var result = shared.createGitOps(fakePrHelper())
            .performGitOperations('test/TS-1', 'msg', null, 'testing/');
        assert.equal(result.success, true);
        assert.ok(calls.indexOf('git push -u origin test/TS-1 --force') !== -1);
    });

    test('performGitOperations: nothing staged and a missing remote branch that cannot be pushed reports failure', function() {
        var shared = loadShared({
            cli_execute_command: function(args) {
                if (args.command === 'git status --short -- testing') return '';
                if (args.command === 'git add testing/') return '';
                if (args.command === 'git diff --cached --stat') return '';
                if (args.command.indexOf('git ls-remote --heads origin test/TS-1') === 0) return '';
                if (args.command === 'git push -u origin test/TS-1') throw new Error('push refused');
                throw new Error('unexpected command: ' + args.command);
            }
        });
        var result = shared.createGitOps(fakePrHelper())
            .performGitOperations('test/TS-1', 'msg', null, 'testing/');
        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('could not push branch') !== -1);
    });

    test('performGitOperations: a failing git status log does not stop staging', function() {
        var calls = [];
        var shared = loadShared({
            cli_execute_command: function(args) {
                calls.push(args.command);
                if (args.command === 'git status --short -- testing') throw new Error('status exploded');
                if (args.command === 'git add testing/') return '';
                if (args.command === 'git diff --cached --stat') return ' f | 1 +\n';
                if (args.command === 'git commit -m "msg"') return '';
                if (args.command === 'git fetch origin test/TS-1') throw new Error('offline');
                if (args.command === 'git push -u origin test/TS-1') return '';
                if (args.command.indexOf('git ls-remote --heads origin test/TS-1') === 0) return 'aaa\trefs/heads/test/TS-1\n';
                throw new Error('unexpected command: ' + args.command);
            }
        });
        var result = shared.createGitOps(fakePrHelper())
            .performGitOperations('test/TS-1', 'msg', null, 'testing/');
        assert.equal(result.success, true);
        assert.ok(calls.indexOf('git add testing/') !== -1, 'staging still ran after the status log failure');
        assert.ok(calls.indexOf('git push -u origin test/TS-1') !== -1, 'fetch failure is tolerated before the push');
    });

});
