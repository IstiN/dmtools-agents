/**
 * Unit tests for js/postStoryTestAutomationReviewHelpers.js — diff/comment
 * helpers extracted from js/postStoryTestAutomationReview.js (gh-1008 CRAP split).
 */

function loadReviewHelpers() {
    return loadModule(
        'js/postStoryTestAutomationReviewHelpers.js',
        makeRequire({}),
        {}
    );
}

function loadPrReviewComments() {
    var commentMarkupModule = loadModule('js/common/commentMarkup.js',
        makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
    var machineAuthorModule = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var outputFilesModule = loadModule('js/common/outputFiles.js', makeRequire({}), {});
    return loadModule('js/postPRReviewComments.js', makeRequire({
        './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
        './config.js': configModule,
        'config': configModule,
        './common/scm.js': { createScm: function() { return {}; } },
        './common/trackers.js': { createTracker: function() { return {}; }, extractTicketKey: function() { return null; } },
        './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; }, triggerSmIfIdle: function() { return { success: true }; } },
        './configLoader.js': configLoaderModule,
        './common/machineAuthor.js': machineAuthorModule,
        './common/outputFiles.js': outputFilesModule,
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {}, customParamsOf: function() { return {}; } },
        './common/githubHelpers.js': { findPRForTicket: function() { return null; }, findMergedPRForTicket: function() { return null; } },
        './common/commentMarkup.js': commentMarkupModule,
        './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
        './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {}),
        './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js', makeRequire({}), {}),
    }), {});
}

function scmRecorder() {
    var calls = {
        addInlineComment: [],
        addComment: [],
        addLabel: [],
        resolveThread: [],
        listPrs: [],
        diffs: {}
    };
    var scm = {
        addInlineComment: function(prId, filePath, line, text, startLine, side) {
            calls.addInlineComment.push({ prId: prId, filePath: filePath, line: line, text: text, startLine: startLine, side: side });
        },
        addComment: function(prId, text) { calls.addComment.push({ prId: prId, text: text }); },
        addLabel: function(prId, label) { calls.addLabel.push({ prId: prId, label: label }); },
        resolveThread: function(prId, thread) { calls.resolveThread.push({ prId: prId, thread: thread }); },
        listPrs: function(state) { calls.listPrs.push({ state: state }); return calls.openPrs || []; },
        getPrDiff: function(prId) { return Object.prototype.hasOwnProperty.call(calls.diffs, prId) ? calls.diffs[prId] : null; }
    };
    scm.calls = calls;
    scm.diffs = calls.diffs;
    return scm;
}

var SIMPLE_DIFF = 'diff --git a/testing/tests/TS-300/test.ts b/testing/tests/TS-300/test.ts\n' +
    '--- a/testing/tests/TS-300/test.ts\n' +
    '+++ b/testing/tests/TS-300/test.ts\n' +
    '@@ -40,5 +40,5 @@\n' +
    ' line 40\n' +
    '-line 41\n' +
    '+line 41 changed\n' +
    ' line 42\n' +
    ' line 43\n' +
    ' line 44\n';

suite('postStoryTestAutomationReviewHelpers: getPRNumber', function() {

    test('parses PR number, URL and branch from pr_info.md', function() {
        var helpers = loadReviewHelpers();
        var readFile = function() {
            return '**PR #**: 42\n**URL**: https://github.com/IstiN/trackstate/pull/42\n**Branch**: test/TS-300\n';
        };
        var scm = scmRecorder();
        var result = helpers.getPRNumber({}, 'TS-300', scm, readFile);
        assert.equal(result.prNumber, 42);
        assert.equal(result.prUrl, 'https://github.com/IstiN/trackstate/pull/42');
        assert.equal(result.prBranch, 'test/TS-300');
        assert.equal(scm.calls.listPrs.length, 0, 'no SCM fallback needed');
    });

    test('falls back to listing open PRs by test branch', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.calls.openPrs = [
            { number: 7, html_url: 'https://github.com/IstiN/trackstate/pull/7', head: { ref: 'test/OTHER' } },
            { number: 42, html_url: 'https://github.com/IstiN/trackstate/pull/42', head: { ref: 'test/TS-300' } }
        ];
        var result = helpers.getPRNumber({}, 'TS-300', scm, function() { return null; });
        assert.equal(result.prNumber, 42);
        assert.equal(result.prUrl, 'https://github.com/IstiN/trackstate/pull/42');
        assert.deepEqual(scm.calls.listPrs, [{ state: 'open' }]);
    });

    test('returns nulls when neither pr_info.md nor an open PR exists', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        var result = helpers.getPRNumber({}, 'TS-300', scm, function() { return null; });
        assert.equal(result.prNumber, null);
        assert.equal(result.prUrl, null);
        assert.equal(result.prBranch, null);
    });

    test('honours params.inputFolderPath for the pr_info lookup', function() {
        var helpers = loadReviewHelpers();
        var seen = [];
        helpers.getPRNumber({ inputFolderPath: 'input/custom/TS-300' }, 'TS-300', scmRecorder(), function(path) {
            seen.push(path);
            return '**PR #**: 9\n**URL**: https://github.com/IstiN/trackstate/pull/9\n';
        });
        assert.deepEqual(seen, ['input/custom/TS-300/pr_info.md']);
    });

});

suite('postStoryTestAutomationReviewHelpers: diff filtering', function() {

    test('isInlineCommentInDiff accepts a line present in the diff', function() {
        var helpers = loadReviewHelpers();
        assert.equal(
            helpers.isInlineCommentInDiff(SIMPLE_DIFF, { path: 'testing/tests/TS-300/test.ts', line: 42 }, loadPrReviewComments()),
            true
        );
    });

    test('isInlineCommentInDiff rejects a line outside the diff', function() {
        var helpers = loadReviewHelpers();
        assert.equal(
            helpers.isInlineCommentInDiff(SIMPLE_DIFF, { path: 'testing/tests/TS-300/test.ts', line: 999 }, loadPrReviewComments()),
            false
        );
    });

    test('isInlineCommentInDiff returns false for missing diff, path or line', function() {
        var helpers = loadReviewHelpers();
        var prc = loadPrReviewComments();
        assert.equal(helpers.isInlineCommentInDiff(null, { path: 'a.ts', line: 1 }, prc), false);
        assert.equal(helpers.isInlineCommentInDiff(SIMPLE_DIFF, { line: 42 }, prc), false, 'no path');
        assert.equal(helpers.isInlineCommentInDiff(SIMPLE_DIFF, { path: 'testing/tests/TS-300/test.ts' }, prc), false, 'no line');
    });

    test('isInlineCommentInDiff rejects a submodule target whose pointer line is not in the diff', function() {
        var helpers = loadReviewHelpers();
        // gitlink header without a parseable +/- pointer line
        var diff = 'diff --git a/mobile-app b/mobile-app\nindex 1111111..2222222 160000\n';
        assert.equal(
            helpers.isInlineCommentInDiff(diff, { path: 'mobile-app/lib/foo.ts', line: 5 }, loadPrReviewComments()),
            false
        );
    });

    test('isInlineCommentInDiff anchors submodule content on the pointer change', function() {
        var helpers = loadReviewHelpers();
        var diff = 'diff --git a/mobile-app b/mobile-app\n' +
            'index 1111111..2222222 160000\n' +
            '--- a/mobile-app\n' +
            '+++ b/mobile-app\n' +
            '@@ -1 +1 @@\n' +
            '-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
            '+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n';
        assert.equal(
            helpers.isInlineCommentInDiff(diff, { path: 'mobile-app/lib/foo.ts', line: 5 }, loadPrReviewComments()),
            true
        );
    });

    test('filterInlineCommentsByDiff returns [] for an empty comment list without touching the SCM', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        assert.deepEqual(helpers.filterInlineCommentsByDiff(scm, 42, [], loadPrReviewComments()), []);
        assert.equal(scm.calls.diffs[42], undefined, 'no diff fetched');
    });

    test('filterInlineCommentsByDiff drops everything when the diff is unavailable', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = null;
        var comments = [{ path: 'a.ts', line: 1, body: 'x' }];
        assert.deepEqual(helpers.filterInlineCommentsByDiff(scm, 42, comments, loadPrReviewComments()), []);
    });

    test('filterInlineCommentsByDiff keeps in-diff comments and drops the rest', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = SIMPLE_DIFF;
        var comments = [
            { path: 'testing/tests/TS-300/test.ts', line: 42, body: 'ok' },
            { path: 'testing/tests/TS-300/test.ts', line: 999, body: 'out of diff' }
        ];
        var kept = helpers.filterInlineCommentsByDiff(scm, 42, comments, loadPrReviewComments());
        assert.equal(kept.length, 1);
        assert.equal(kept[0].body, 'ok');
    });

});

suite('postStoryTestAutomationReviewHelpers: postInlineComment', function() {

    test('posts the comment with the diff-inferred side', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = SIMPLE_DIFF;
        var ok = helpers.postInlineComment(scm, 42, { path: 'testing/tests/TS-300/test.ts', line: 42, body: 'Use stable locator' }, 'TS-300', function() { return null; }, loadPrReviewComments());
        assert.equal(ok, true);
        assert.equal(scm.calls.addInlineComment.length, 1);
        assert.equal(scm.calls.addInlineComment[0].side, 'RIGHT');
        assert.equal(scm.calls.addInlineComment[0].text, 'Use stable locator');
    });

    test('posts a LEFT-side comment for deleted files', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = 'diff --git a/testing/tests/TS-303/test.ts b/testing/tests/TS-303/test.ts\n' +
            'deleted file mode 100644\n' +
            '--- a/testing/tests/TS-303/test.ts\n' +
            '+++ /dev/null\n' +
            '@@ -1,8 +0,0 @@\n' +
            '-line 1\n' +
            '-line 2\n' +
            '-line 3\n' +
            '-line 4\n' +
            '-line 5\n' +
            '-line 6\n' +
            '-line 7\n' +
            '-line 8\n';
        var ok = helpers.postInlineComment(scm, 42, { path: 'testing/tests/TS-303/test.ts', line: 5, body: 'Do not delete' }, 'TS-303', function() { return null; }, loadPrReviewComments());
        assert.equal(ok, true);
        assert.equal(scm.calls.addInlineComment[0].side, 'LEFT');
        assert.equal(scm.calls.addInlineComment[0].line, 5);
    });

    test('reads the body from the referenced comment file when body is absent', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = SIMPLE_DIFF;
        helpers.postInlineComment(
            scm, 42,
            { path: 'testing/tests/TS-300/test.ts', line: 42, comment: 'outputs/pr_review_comments/1.md' },
            'TS-300',
            function(path) { return path === 'outputs/pr_review_comments/1.md' ? 'File body' : null; },
            loadPrReviewComments()
        );
        assert.equal(scm.calls.addInlineComment[0].text, 'File body');
    });

    test('returns false without posting when the line is not in the diff', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = SIMPLE_DIFF;
        var ok = helpers.postInlineComment(scm, 42, { path: 'testing/tests/TS-300/test.ts', line: 999, body: 'Nowhere' }, 'TS-300', function() { return null; }, loadPrReviewComments());
        assert.equal(ok, false);
        assert.equal(scm.calls.addInlineComment.length, 0);
    });

    test('returns false without posting when there is no comment text', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = SIMPLE_DIFF;
        var ok = helpers.postInlineComment(scm, 42, { path: 'testing/tests/TS-300/test.ts', line: 42 }, 'TS-300', function() { return null; }, loadPrReviewComments());
        assert.equal(ok, false);
        assert.equal(scm.calls.addInlineComment.length, 0);
    });

    test('returns false without posting when there is no file path', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = SIMPLE_DIFF;
        var ok = helpers.postInlineComment(scm, 42, { body: 'Orphan body' }, 'TS-300', function() { return null; }, loadPrReviewComments());
        assert.equal(ok, false);
        assert.equal(scm.calls.addInlineComment.length, 0);
    });

    test('an SCM failure is swallowed and reported as false', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.getPrDiff = function() { throw new Error('diff exploded'); };
        var ok = helpers.postInlineComment(scm, 42, { path: 'a.ts', line: 1, body: 'x' }, 'TS-1', function() { return null; }, loadPrReviewComments());
        assert.equal(ok, false);
        assert.equal(scm.calls.addInlineComment.length, 0);
    });

    test('posts a submodule-anchored comment with a location prefix', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.diffs[42] = 'diff --git a/mobile-app b/mobile-app\n' +
            'index 1111111..2222222 160000\n' +
            '--- a/mobile-app\n' +
            '+++ b/mobile-app\n' +
            '@@ -1 +1 @@\n' +
            '-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
            '+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n';
        var ok = helpers.postInlineComment(
            scm, 42,
            { path: 'mobile-app/lib/foo.ts', line: 5, body: 'Fix the widget' },
            'TS-300',
            function() { return null; },
            loadPrReviewComments()
        );
        assert.equal(ok, true);
        assert.equal(scm.calls.addInlineComment.length, 1);
        assert.equal(scm.calls.addInlineComment[0].filePath, 'mobile-app');
        assert.equal(scm.calls.addInlineComment[0].line, 1);
        assert.equal(scm.calls.addInlineComment[0].side, 'RIGHT');
        assert.contains(scm.calls.addInlineComment[0].text, '📍 **`mobile-app/lib/foo.ts:5`** (submodule content line)');
        assert.contains(scm.calls.addInlineComment[0].text, 'Fix the widget');
    });

});

suite('postStoryTestAutomationReviewHelpers: resolveExistingAgentReviewThreads', function() {

    test('resolves only the stale (unresolved) threads', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        var fetch = function(owner, repo, prNumber) {
            return {
                rawThreads: {
                    threads: [
                        { threadId: 't1', resolved: false },
                        { threadId: 't2', resolved: true },
                        { resolved: false }
                    ]
                }
            };
        };
        helpers.resolveExistingAgentReviewThreads(scm, 42, { owner: 'IstiN', repo: 'trackstate' }, fetch);
        assert.deepEqual(scm.calls.resolveThread, [{ prId: 42, thread: { threadId: 't1' } }]);
    });

    test('a failing resolve on one thread does not stop the others', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.resolveThread = function(prId, thread) {
            if (thread.threadId === 't1') throw new Error('gone');
            scm.calls.resolveThread.push({ prId: prId, thread: thread });
        };
        var fetch = function() {
            return { rawThreads: { threads: [{ threadId: 't1', resolved: false }, { threadId: 't2', resolved: false }] } };
        };
        helpers.resolveExistingAgentReviewThreads(scm, 42, { owner: 'IstiN', repo: 'trackstate' }, fetch);
        assert.deepEqual(scm.calls.resolveThread, [{ prId: 42, thread: { threadId: 't2' } }]);
    });

    test('missing repo info or PR number is a no-op', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        var fetchCalled = false;
        var fetch = function() { fetchCalled = true; return null; };
        helpers.resolveExistingAgentReviewThreads(scm, 42, null, fetch);
        helpers.resolveExistingAgentReviewThreads(scm, null, { owner: 'o', repo: 'r' }, fetch);
        assert.equal(fetchCalled, false);
        assert.equal(scm.calls.resolveThread.length, 0);
    });

    test('a failing discussions fetch is swallowed', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        var fetch = function() { throw new Error('api down'); };
        helpers.resolveExistingAgentReviewThreads(scm, 42, { owner: 'IstiN', repo: 'trackstate' }, fetch);
        assert.equal(scm.calls.resolveThread.length, 0);
    });

});

suite('postStoryTestAutomationReviewHelpers: postGeneralComment', function() {

    test('posts the trimmed file content', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        var outputFiles = {
            readOutputFileDetailed: function(path) {
                return path === 'outputs/pr_review_general.md' ? { content: '  General feedback\n' } : null;
            }
        };
        helpers.postGeneralComment(scm, 42, 'outputs/pr_review_general.md', 'TS-300', null, outputFiles);
        assert.equal(scm.calls.addComment.length, 1);
        assert.equal(scm.calls.addComment[0].text, 'General feedback');
    });

    test('skips posting when the file is empty', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        var outputFiles = { readOutputFileDetailed: function() { return { content: '   ' } } };
        helpers.postGeneralComment(scm, 42, 'outputs/pr_review_general.md', 'TS-300', null, outputFiles);
        assert.equal(scm.calls.addComment.length, 0);
    });

});

suite('postStoryTestAutomationReviewHelpers: applyVerdictLabels', function() {

    test('approval labels both the PR and the ticket', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        var trackerLabels = [];
        var getTracker = function() {
            return { addLabel: function(key, label) { trackerLabels.push([key, label]); } };
        };
        helpers.applyVerdictLabels(scm, 42, 'TS-300', true, getTracker, configModule.LABELS);
        assert.deepEqual(scm.calls.addLabel, [{ prId: 42, label: 'pr_approved' }]);
        assert.deepEqual(trackerLabels, [['TS-300', 'pr_approved']]);
    });

    test('rejection labels both sides with test_pr_rework_needed', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        var trackerLabels = [];
        var getTracker = function() {
            return { addLabel: function(key, label) { trackerLabels.push([key, label]); } };
        };
        helpers.applyVerdictLabels(scm, 42, 'TS-300', false, getTracker, configModule.LABELS);
        assert.deepEqual(scm.calls.addLabel, [{ prId: 42, label: 'test_pr_rework_needed' }]);
        assert.deepEqual(trackerLabels, [['TS-300', 'test_pr_rework_needed']]);
    });

    test('a failing SCM label does not block the tracker label', function() {
        var helpers = loadReviewHelpers();
        var scm = scmRecorder();
        scm.addLabel = function() { throw new Error('label exploded'); };
        var trackerLabels = [];
        var getTracker = function() {
            return { addLabel: function(key, label) { trackerLabels.push([key, label]); } };
        };
        helpers.applyVerdictLabels(scm, 42, 'TS-300', true, getTracker, configModule.LABELS);
        assert.deepEqual(trackerLabels, [['TS-300', 'pr_approved']]);
    });

});

suite('postStoryTestAutomationReviewHelpers: buildReworkFeedback', function() {

    test('builds numbered feedback with code blocks and the general comment', function() {
        var helpers = loadReviewHelpers();
        var reviewData = {
            generalComment: 'outputs/pr_review_general.md',
            inlineComments: [
                { path: 'testing/tests/TS-300/test.ts', line: 42, body: 'Use stable locator' },
                { file: 'testing/tests/TS-301/test.ts', body: 'File-keyed comment without line' }
            ]
        };
        var feedback = helpers.buildReworkFeedback(reviewData, function(path) {
            return path === 'outputs/pr_review_general.md' ? 'General notes' : null;
        });
        assert.contains(feedback, 'h3. 📝 Test Automation Rework Feedback');
        assert.contains(feedback, '#1. *testing/tests/TS-300/test.ts:42*');
        assert.contains(feedback, '{code}Use stable locator{code}');
        assert.contains(feedback, '#2. *testing/tests/TS-301/test.ts*');
        assert.contains(feedback, 'h4. General comment');
        assert.contains(feedback, '{code}General notes{code}');
    });

    test('skips inline comments without a body but keeps their numbering positions', function() {
        var helpers = loadReviewHelpers();
        var reviewData = {
            inlineComments: [
                { path: 'a.ts', line: 1 },
                { path: 'b.ts', line: 2, body: 'Real issue' }
            ]
        };
        var feedback = helpers.buildReworkFeedback(reviewData, function() { return null; });
        assert.notContains(feedback, '#1.');
        assert.contains(feedback, '#2. *b.ts:2*');
    });

    test('omits the general comment section when the file is empty', function() {
        var helpers = loadReviewHelpers();
        var feedback = helpers.buildReworkFeedback(
            { generalComment: 'outputs/g.md', inlineComments: [{ path: 'a.ts', line: 1, body: 'x' }] },
            function() { return null; }
        );
        assert.notContains(feedback, 'h4. General comment');
    });

});
