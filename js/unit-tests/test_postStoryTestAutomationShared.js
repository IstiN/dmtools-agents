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

    // gh-1244: the holder factory lives in js/common/trackers.js
    // (createTrackerHolder); the shared-module copy is a delegate that keeps
    // the trackersModule argument for injection.
    test('delegates to trackersModule.createTrackerHolder and returns its result', function() {
        var sentinel = { initTracker: function() {}, getTracker: function() {} };
        var called = 0;
        var holder = loadShared({}).createTrackerHolder({
            createTrackerHolder: function() {
                called++;
                return sentinel;
            }
        });

        assert.equal(called, 1, 'createTrackerHolder called exactly once');
        assert.equal(holder, sentinel, 'the holder is returned verbatim');
    });

    // Behavioural pin of the canonical factory (js/common/trackers.js) through
    // the delegate: lazy create, cached instance, re-init resets.
    test('holder from the real trackers module keeps the lazy-init behaviour', function() {
        var trackers = loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }), {});
        var holder = loadShared({}).createTrackerHolder(trackers);

        holder.initTracker({ jira: {} }, { trackerProvider: 'jira' });
        var first = holder.getTracker();
        assert.equal(first, holder.getTracker(), 'same instance returned');
        assert.equal(first.provider(), 'jira');
        assert.equal(holder.getTracker().provider(), 'jira');

        holder.initTracker({ jira: {} }, { trackerProvider: 'ado' });
        var second = holder.getTracker();
        assert.notEqual(first, second, 're-init creates a fresh tracker');
        assert.equal(second.provider(), 'ado');
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
                    throw new Error('rejected');
                }
                if (args.command === 'git push -u origin test/TS-2 --force-with-lease') {
                    assert.equal(pushAttempts, 2, 'fast-forward push retried, then the lease push ran');
                    return '';
                }
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
            cli_execute_command: cliMock({
                'git status --short -- testing': '?? testing/tests/TS-1/test.py\n',
                'git add testing/': '',
                'git diff --cached --stat': ' f | 1 +\n',
                'git commit -m "msg"': '',
                'git fetch origin test/TS-1': '',
                'git push -u origin test/TS-1': function() { throw new Error('rejected'); },
                'git push -u origin test/TS-1 --force-with-lease': function() { throw new Error('rejected'); },
                'git push -u origin test/TS-1 --force': '',
                'git ls-remote --heads origin test/TS-1': 'aaa\trefs/heads/test/TS-1\n'
            }, calls)
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
            cli_execute_command: cliMock({
                'git status --short -- testing': function() { throw new Error('status exploded'); },
                'git add testing/': '',
                'git diff --cached --stat': ' f | 1 +\n',
                'git commit -m "msg"': '',
                'git fetch origin test/TS-1': function() { throw new Error('offline'); },
                'git push -u origin test/TS-1': '',
                'git ls-remote --heads origin test/TS-1': 'aaa\trefs/heads/test/TS-1\n'
            }, calls)
        });
        var result = shared.createGitOps(fakePrHelper())
            .performGitOperations('test/TS-1', 'msg', null, 'testing/');
        assert.equal(result.success, true);
        assert.ok(calls.indexOf('git add testing/') !== -1, 'staging still ran after the status log failure');
        assert.ok(calls.indexOf('git push -u origin test/TS-1') !== -1, 'fetch failure is tolerated before the push');
    });

});

suite('postStoryTestAutomationShared: autoStart trigger parameter order (gh-1246 review)', function() {

    // gh-1246 review: triggerAutoStartReworkWorkflow must take
    // (autoStart, ticketKey, customParams, config) — customParams BEFORE
    // config — matching the review-flavor sibling triggerAutoStartReviewWorkflow.
    // A caller copying the review-flavor call shape must not silently swap
    // config and customParams.
    function recordingAutoStart(recorded) {
        return {
            triggerConfiguredWorkflowForTicket: function(options) {
                recorded.push(options);
                return { success: true };
            }
        };
    }

    test('triggerAutoStartReworkWorkflow takes customParams before config', function() {
        var recorded = [];
        var customParams = { autoStartRework: true, autoStartReworkConfigFile: 'agents/pr_test_automation_rework.json' };
        var config = { git: {} };

        var result = loadShared({}).triggerAutoStartReworkWorkflow(
            recordingAutoStart(recorded), 'TS-1', customParams, config);

        assert.equal(recorded.length, 1, 'the configured workflow was triggered');
        assert.equal(recorded[0].customParams, customParams, 'customParams landed in the customParams slot');
        assert.equal(recorded[0].config, config, 'config landed in the config slot');
        assert.equal(recorded[0].configFile, 'agents/pr_test_automation_rework.json');
        assert.equal(recorded[0].label, 'pr_test_automation_rework');
        assert.equal(recorded[0].stripKeys.length, 3);
        assert.deepEqual(recorded[0].stripKeys, ['removeLabel', 'autoStartRework', 'autoStartReworkConfigFile']);
        assert.deepEqual(result, { success: true });
    });

    test('triggerAutoStartReworkWorkflow without the flags does not trigger', function() {
        var recorded = [];
        var result = loadShared({}).triggerAutoStartReworkWorkflow(
            recordingAutoStart(recorded), 'TS-1', {}, { git: {} });
        assert.equal(recorded.length, 0);
        assert.equal(result, false);
    });

    test('triggerAutoStartReworkWorkflow swallows trigger failures', function() {
        var throwing = {
            triggerConfiguredWorkflowForTicket: function() { throw new Error('boom'); }
        };
        var customParams = { autoStartRework: true, autoStartReworkConfigFile: 'agents/pr_test_automation_rework.json' };
        var result = loadShared({}).triggerAutoStartReworkWorkflow(throwing, 'TS-1', customParams, {});
        assert.equal(result, false);
    });
});
