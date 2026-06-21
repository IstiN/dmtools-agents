/**
 * Unit tests for js/postStoryTestAutomationReview.js
 */

function loadPostStoryTestAutomationReview(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_add_label: function() {},
        jira_remove_label: function() {},
        file_read: function() { return null; },
        file_write: function() {}
    };

    var allMocks = Object.assign({}, defaults, mocks);

    var scmCalls = {
        addComment: [],
        addInlineComment: [],
        addLabel: [],
        resolveThread: [],
        listPrs: []
    };

    var scmMock = Object.assign({
        addComment: function(prId, text) { scmCalls.addComment.push({ prId: prId, text: text }); },
        addInlineComment: function(prId, filePath, line, text, startLine, side) {
            scmCalls.addInlineComment.push({ prId: prId, filePath: filePath, line: line, text: text, startLine: startLine, side: side });
        },
        addLabel: function(prId, label) { scmCalls.addLabel.push({ prId: prId, label: label }); },
        resolveThread: function(prId, thread) { scmCalls.resolveThread.push({ prId: prId, thread: thread }); },
        listPrs: function(state) {
            scmCalls.listPrs.push({ state: state });
            return (mocks && mocks.listPrsResult) || [];
        },
        getPrDiff: function(prId) { return (mocks && mocks.prDiff) || ''; },
        getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; }
    }, mocks && mocks.scmOverride || {});

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return scmMock; } }
        }),
        { file_read: function() { return null; } }
    );

    var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), allMocks);

    var prReviewComments = loadModule(
        'js/postPRReviewComments.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return scmMock; } },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function() { return false; },
                triggerSmIfIdle: function() { return { success: true }; }
            },
            './configLoader.js': freshConfigLoader,
            './common/outputFiles.js': outputFiles,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        allMocks
    );

    var module = loadModule(
        'js/postStoryTestAutomationReview.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/scm.js': { createScm: function() { return scmMock; } },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function(opts) {
                    return (mocks && mocks.triggerConfiguredWorkflowForTicket)
                        ? mocks.triggerConfiguredWorkflowForTicket(opts)
                        : false;
                },
                triggerSmIfIdle: function() { return { success: true }; }
            },
            './common/outputFiles.js': outputFiles,
            './common/githubHelpers.js': {
                getGitHubRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; },
                fetchDiscussionsAndRawData: function() { return { rawThreads: { threads: [] } }; }
            },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './postPRReviewComments.js': prReviewComments
        }),
        allMocks
    );

    module._scmCalls = scmCalls;
    module._scmMock = scmMock;
    return module;
}

suite('postStoryTestAutomationReview', function() {

    test('APPROVE posts comments via SCM and adds pr_approved label', function() {
        var mergeTriggered = false;
        var statusMoves = [];
        var jiraLabels = [];

        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'APPROVE',
                        summary: 'LGTM',
                        generalComment: 'outputs/pr_review_general.md',
                        inlineComments: [
                            { path: 'testing/tests/TS-300/test.ts', line: 42, body: 'Use stable locator' }
                        ]
                    });
                }
                if (opts.path === 'outputs/pr_review_general.md') {
                    return 'Great work!';
                }
                if (opts.path === 'input/TS-300/pr_info.md') {
                    return '**PR #**: 30\n**URL**: https://github.com/IstiN/trackstate/pull/30';
                }
                return null;
            },
            jira_add_label: function(args) { jiraLabels.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            triggerConfiguredWorkflowForTicket: function(opts) {
                if (opts.configFile === 'agents/story_test_automation_merge.json') {
                    mergeTriggered = true;
                    return true;
                }
                return false;
            },
            prDiff: 'diff --git a/testing/tests/TS-300/test.ts b/testing/tests/TS-300/test.ts\n' +
                '--- a/testing/tests/TS-300/test.ts\n' +
                '+++ b/testing/tests/TS-300/test.ts\n' +
                '@@ -40,5 +40,5 @@\n' +
                ' line 40\n' +
                '-line 41\n' +
                '+line 41 changed\n' +
                ' line 42\n' +
                ' line 43\n' +
                ' line 44\n'
        });

        var result = module.action({
            ticket: { key: 'TS-300' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_story_test_review_triggered',
                    autoStartMerge: true,
                    autoStartMergeConfigFile: 'agents/story_test_automation_merge.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'APPROVE');
        assert.equal(mergeTriggered, true);
        assert.equal(statusMoves.length, 0, 'should not move story on approve');
        assert.ok(module._scmCalls.addComment.some(function(c) { return c.text === 'Great work!'; }));
        assert.ok(module._scmCalls.addInlineComment.some(function(c) {
            return c.filePath === 'testing/tests/TS-300/test.ts' && c.line === 42;
        }));
        assert.ok(module._scmCalls.addLabel.some(function(a) { return a.label === 'pr_approved'; }));
        assert.ok(jiraLabels.some(function(a) { return a.label === 'pr_approved'; }));
    });

    test('REQUEST_CHANGES moves Story to In Rework and triggers rework', function() {
        var reworkTriggered = false;
        var statusMoves = [];

        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({ recommendation: 'REQUEST_CHANGES', summary: 'Fix locators' });
                }
                return null;
            },
            listPrsResult: [
                {
                    number: 31,
                    html_url: 'https://github.com/IstiN/trackstate/pull/31',
                    head: { ref: 'test/TS-301' }
                }
            ],
            jira_move_to_status: function(args) { statusMoves.push(args); },
            triggerConfiguredWorkflowForTicket: function(opts) {
                if (opts.configFile === 'agents/story_test_automation_rework.json') {
                    reworkTriggered = true;
                    return true;
                }
                return false;
            }
        });

        var result = module.action({
            ticket: { key: 'TS-301' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_story_test_review_triggered',
                    autoStartRework: true,
                    autoStartReworkConfigFile: 'agents/story_test_automation_rework.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'REQUEST_CHANGES');
        assert.equal(reworkTriggered, true);
        // The post action triggers the rework workflow; the status move is handled by that workflow.
        assert.deepEqual(statusMoves, []);
    });

    test('skips inline comments whose line is not in diff', function() {
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'APPROVE',
                        inlineComments: [
                            { path: 'testing/tests/TS-302/test.ts', line: 999, body: 'Not in diff' }
                        ]
                    });
                }
                if (opts.path === 'input/TS-302/pr_info.md') {
                    return '**PR #**: 32\n**URL**: https://github.com/IstiN/trackstate/pull/32';
                }
                return null;
            },
            prDiff: 'diff --git a/testing/tests/TS-302/test.ts b/testing/tests/TS-302/test.ts\n' +
                '--- a/testing/tests/TS-302/test.ts\n' +
                '+++ b/testing/tests/TS-302/test.ts\n' +
                '@@ -1,3 +1,3 @@\n' +
                ' line 1\n' +
                '-line 2\n' +
                '+line 2 changed\n' +
                ' line 3\n'
        });

        var result = module.action({
            ticket: { key: 'TS-302' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(module._scmCalls.addInlineComment.length, 0);
        assert.equal(module._scmCalls.addComment.length, 0, 'should not post fallback "lines not shown in diff" comments');
    });

    test('drops all inline comments when PR diff is unavailable', function() {
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'REQUEST_CHANGES',
                        generalComment: 'outputs/pr_review_general.md',
                        inlineComments: [
                            { path: 'testing/tests/TS-302/test.ts', line: 2, body: 'No diff' }
                        ]
                    });
                }
                if (opts.path === 'outputs/pr_review_general.md') {
                    return 'General feedback';
                }
                if (opts.path === 'input/TS-302/pr_info.md') {
                    return '**PR #**: 32\n**URL**: https://github.com/IstiN/trackstate/pull/32';
                }
                return null;
            },
            prDiff: null
        });

        var result = module.action({
            ticket: { key: 'TS-302' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(module._scmCalls.addInlineComment.length, 0);
        assert.ok(module._scmCalls.addComment.some(function(c) { return c.text === 'General feedback'; }));
    });

    test('posts LEFT-side inline comment for deleted files', function() {
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'REQUEST_CHANGES',
                        inlineComments: [
                            { path: 'testing/tests/TS-303/test.ts', line: 5, body: 'Do not delete this test' }
                        ]
                    });
                }
                if (opts.path === 'input/TS-303/pr_info.md') {
                    return '**PR #**: 33\n**URL**: https://github.com/IstiN/trackstate/pull/33';
                }
                return null;
            },
            prDiff: 'diff --git a/testing/tests/TS-303/test.ts b/testing/tests/TS-303/test.ts\n' +
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
                '-line 8\n'
        });

        var result = module.action({
            ticket: { key: 'TS-303' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(module._scmCalls.addInlineComment.length, 1);
        assert.equal(module._scmCalls.addInlineComment[0].side, 'LEFT');
        assert.equal(module._scmCalls.addInlineComment[0].line, 5);
    });

});
