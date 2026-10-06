/**
 * Unit tests for js/postTestReworkResults.js — canonical MERGE_HEAD probe.
 *
 * gh-761 review (IMPORTANT): the module carried a local isMergeInProgress()
 * duplicate of js/common/mergeState.js whose semantics drifted — it returned
 * true on ANY non-throwing cli_execute_command call (no non-empty-output
 * requirement). These tests pin the canonical probe semantics:
 *   - a loose double returning '' for unknown commands is NOT a merge;
 *   - a resolved MERGE_HEAD (non-empty sha) is a merge in progress.
 */

function loadPostTestReworkResults(cliMock) {
    return loadModule(
        'js/postTestReworkResults.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': {
                formatTemplate: function(template, vars) {
                    return 'test/' + vars.ticketKey + ' ' + vars.result;
                }
            },
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/feedbackLoop.js': {},
            './common/commentMarkup.js': loadModule('js/common/commentMarkup.js'),
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule }), {}),
            './common/pullRequest.js': {
                // Mirrors the real readStagedDiffStat(runCommand, workingDir).
                readStagedDiffStat: function(runCommand) {
                    return String(runCommand('git diff --cached --stat') || '').trim();
                }
            },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }),
        { cli_execute_command: cliMock }
    );
}

var REWORK_CONFIG = {
    git: { baseBranch: 'main' },
    formats: { commitMessage: { testRework: '{{ticketKey}} {{result}}' } }
};

/**
 * Build a cli_execute_command double.
 *  - mergeHeadSha: probe returns this sha (merge in progress)
 *  - loose: probe RETURNS '' instead of throwing (loose test double — the
 *    drift detector: the old local probe misread this as "merge in progress")
 */
function makeCli(options) {
    options = options || {};
    var calls = [];
    var fn = function(args) {
        var command = args.command;
        calls.push(command);
        if (command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
            if (options.mergeHeadSha) return options.mergeHeadSha;
            if (options.loose) return '';
            throw new Error('Command execution failed (exit code 1)'); // real git: no MERGE_HEAD
        }
        if (command === 'git branch --show-current') return options.branch || 'test/PROJ-123';
        if (command.indexOf('git ls-remote --heads origin') === 0) {
            return '9a7e2aecommitsha refs/heads/' + (options.branch || 'test/PROJ-123');
        }
        if (command === 'git rev-parse HEAD') return '9a7e2aecommitsha';
        return '';
    };
    fn.calls = calls;
    return fn;
}

suite('postTestReworkResults — canonical MERGE_HEAD probe (gh-761)', function() {

    test('a loose cli double returning "" for the probe is NOT a merge in progress (drift guard)', function() {
        var cli = makeCli({ loose: true });
        var m = loadPostTestReworkResults(cli);

        var committed = m.commitIfNeeded('PROJ-123', true, REWORK_CONFIG);

        assert.equal(committed, false,
            'empty probe output + clean tree → no merge in progress → nothing to commit');
        assert.equal(cli.calls.filter(function(c) { return c.indexOf('git commit') === 0; }).length, 0,
            'must not finalize a phantom merge commit');
    });

    test('a resolved MERGE_HEAD (non-empty sha) is a merge in progress — the merge commit is still made', function() {
        var cli = makeCli({ mergeHeadSha: '9a7e2aecommitsha\n' });
        var m = loadPostTestReworkResults(cli);

        var committed = m.commitIfNeeded('PROJ-123', true, REWORK_CONFIG);

        assert.equal(committed, true, 'unconcluded merge with empty staged diff still needs its merge commit');
        assert.ok(cli.calls.some(function(c) { return c.indexOf('git commit') === 0; }),
            'merge finalization commit created');
    });

    test('probes MERGE_HEAD with the canonical git command', function() {
        var cli = makeCli({});
        var m = loadPostTestReworkResults(cli);

        m.commitIfNeeded('PROJ-123', true, REWORK_CONFIG);

        assert.ok(cli.calls.some(function(c) {
            return c.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1;
        }), 'the canonical MERGE_HEAD probe command must be issued');
    });

    test('a dirty PR with NO merge in progress still merges the base branch (drift skipped it before)', function() {
        var cli = makeCli({ loose: true });
        var m = loadPostTestReworkResults(cli);

        var branch = m.commitAndPush('PROJ-123', true, REWORK_CONFIG, true);

        assert.equal(branch, 'test/PROJ-123', 'push flow completes');
        var mergeCalls = cli.calls.filter(function(c) {
            return c.indexOf('git merge origin/main') === 0;
        });
        assert.ok(mergeCalls.length > 0,
            'prIsDirty + no merge in progress → base-branch merge must be started');
    });

});

// ── gh-770: per-tracker markup for the test-rework completion comment ────────
// Step 6 historically hard-coded Jira wiki markup (h3., *bold*, {code}) and
// posted via raw jira_post_comment; on a GitHub-backed tracker the comment
// rendered as raw text garbage. The builder is extracted so the flavor choice
// (commentMarkup.forTicket) is testable per tracker, and posting goes through
// the probed tracker (trackers.js).

var testReworkCommentMarkup = loadModule('js/common/commentMarkup.js');

suite('postTestReworkResults.buildTestReworkResultComment — per-tracker markup (gh-770)', function() {

    function build(flavor, ctx) {
        return loadPostTestReworkResults(makeCli())
            .buildTestReworkResultComment(flavor, ctx);
    }

    test('jira flavor is byte-identical to the historical wiki template', function() {
        var out = build(testReworkCommentMarkup.forFlavor('jira'), {
            passed: true,
            testStatus: 'passed',
            branchName: 'test/PROJ-9',
            prUrl: 'https://github.com/acme/widgets/pull/9',
            fixSummary: 'fixed the flaky assertion'
        });
        assert.equal(out,
            'h3. 🔧 Test Rework Completed\n' +
            '*Re-run result*: ✅ *PASSED*\n' +
            '*Branch*: {code}test/PROJ-9{code}\n' +
            '*Pull Request*: https://github.com/acme/widgets/pull/9\n' +
            'fixed the flaky assertion');
    });

    test('markdown flavor renders the same facts GitHub-safe — no wiki constructs', function() {
        var out = build(testReworkCommentMarkup.forFlavor('markdown'), {
            passed: true,
            testStatus: 'passed',
            branchName: 'test/gh-9',
            prUrl: 'https://github.com/acme/widgets/pull/9',
            fixSummary: 'fixed the flaky assertion'
        });
        assert.ok(out.indexOf('### 🔧 Test Rework Completed\n') === 0, 'markdown heading');
        assert.ok(out.indexOf('**Re-run result**: ✅ **PASSED**') !== -1);
        assert.ok(out.indexOf('**Branch**') !== -1);
        assert.ok(out.indexOf('**Pull Request**') !== -1);
        assert.equal(out.indexOf('h3.'), -1, 'no wiki heading');
        assert.equal(out.indexOf('{code'), -1, 'no wiki code tag');
        assert.equal(out.indexOf('*Re-run result*'), -1, 'no wiki bold');
    });

    test('failed re-run flips the emoji and the status emphasis', function() {
        var out = build(testReworkCommentMarkup.forFlavor('jira'), {
            passed: false,
            testStatus: 'failed',
            branchName: 'b',
            fixSummary: 'still red'
        });
        assert.ok(out.indexOf('h3. 🔧 Test Rework Completed\n') === 0);
        assert.ok(out.indexOf('*Re-run result*: ❌ *FAILED*') !== -1);
        assert.ok(out.indexOf('*Pull Request*') === -1, 'no PR line when there is no PR');
        assert.ok(out.indexOf('still red') !== -1);
    });

});
