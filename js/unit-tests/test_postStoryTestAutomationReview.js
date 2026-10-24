/**
 * Unit tests for js/postStoryTestAutomationReview.js
 */

/** gh-1192: optional moduleMocks.autoStart.triggerSmIfIdle override, else the default. */
function smIdleMockOf(moduleMocks) {
    return (moduleMocks && moduleMocks.autoStart && moduleMocks.autoStart.triggerSmIfIdle)
        || function() { return { success: true }; };
}

/** gh-1192: optional moduleMocks.configLoader override, else the loader's own. */
function configLoaderMockOf(moduleMocks, fallback) {
    return (moduleMocks && moduleMocks.configLoader) || fallback;
}

/** gh-1224: optional moduleMocks.githubHelpers override for getRepoInfo tests. */
function githubHelpersMockOf(moduleMocks) {
    return (moduleMocks && moduleMocks.githubHelpers) || {
        getGitHubRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; },
        fetchDiscussionsAndRawData: function() { return { rawThreads: { threads: [] } }; }
    };
}

function loadPostStoryTestAutomationReview(mocks, moduleMocks) {
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
        ,
            './common/commentMarkup.js': commentMarkupModule,
        }),
        { file_read: function() { return null; } }
    );

    var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule,
        }), allMocks);
    var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var machineAuthorModule = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var sharedModule = loadModule('js/postStoryTestAutomationShared.js', makeRequire({}), allMocks);
    var reviewHelpersModule = loadModule('js/postStoryTestAutomationReviewHelpers.js', makeRequire({}), {});

    var prReviewComments = loadModule(
        'js/postPRReviewComments.js',
        makeRequire({
            './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
            './config.js': configModule,
            './common/machineAuthor.js': machineAuthorModule,
            './common/scm.js': { createScm: function() { return scmMock; } },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function() { return false; },
                triggerSmIfIdle: function() { return { success: true }; }
            },
            './configLoader.js': freshConfigLoader,
            './common/outputFiles.js': outputFiles,
            './common/githubHelpers.js': {
                findPRForTicket: function() { return null; },
                findMergedPRForTicket: function() { return null; }
            },
            // Real trackers module (pinned to jira via customParams) so the
            // migrated ticket operations flow through the provider layer.
            './common/trackers.js': (function() {
                var realTrackers = loadModule(
                    'js/common/trackers.js',
                    makeRequire({
                        '../config.js': configModule,
                        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
                    }),
                    allMocks
                );
                return {
                    createTracker: function(config, customParams) {
                        return realTrackers.createTracker(
                            config,
                            Object.assign({ trackerProvider: 'jira' }, customParams || {})
                        );
                    },
                    extractTicketKey: realTrackers.extractTicketKey
                };
            })(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        ,
            './common/commentMarkup.js': commentMarkupModule,
            './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
            './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {}),
            './postStoryTestAutomationReviewHelpers.js': reviewHelpersModule,
        }),
        allMocks
    );

    var module = loadModule(
        'js/postStoryTestAutomationReview.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderMockOf(moduleMocks, freshConfigLoader),
            './common/scm.js': { createScm: function() { return scmMock; } },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function(opts) {
                    return (mocks && mocks.triggerConfiguredWorkflowForTicket)
                        ? mocks.triggerConfiguredWorkflowForTicket(opts)
                        : false;
                },
                triggerSmIfIdle: smIdleMockOf(moduleMocks)
            },
            './common/outputFiles.js': outputFiles,
            './common/githubHelpers.js': githubHelpersMockOf(moduleMocks),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './postPRReviewComments.js': prReviewComments,
            './postStoryTestAutomationShared.js': sharedModule,
            './postStoryTestAutomationReviewHelpers.js': reviewHelpersModule,
            './common/trackers.js': loadModule(
                'js/common/trackers.js',
                makeRequire({
                    '../config.js': configModule,
                    './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
                }),
                allMocks
            ),
            './common/commentMarkup.js': commentMarkupModule,
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

    test('ado provider: labels go through ado_* tools and never a jira_* tool', function() {
        var calls = [];
        var boom = function() { throw new Error('jira_* must not be called on ado'); };
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({ recommendation: 'APPROVE', summary: 'LGTM', inlineComments: [] });
                }
                if (opts.path === 'input/300/pr_info.md') {
                    return '**PR #**: 30\n**URL**: https://github.com/IstiN/trackstate/pull/30';
                }
                return null;
            },
            ado_add_work_item_label: function(a) { calls.push(['add', a]); },
            ado_remove_work_item_label: function(a) { calls.push(['rm', a]); },
            ado_add_work_item_comment: function(a) { calls.push(['comment', a]); },
            ado_move_to_state: function(a) { calls.push(['move', a]); },
            jira_add_label: boom, jira_remove_label: boom, jira_post_comment: boom, jira_move_to_status: boom
        });
        var result = module.action({
            ticket: { key: '300' },
            jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_story_test_review_triggered' } }
        });
        assert.equal(result.success, true);
        assert.ok(calls.some(function(c) { return c[0] === 'add' && c[1].id === '300' && c[1].label === 'pr_approved'; }));
        assert.ok(calls.some(function(c) { return c[0] === 'rm' && c[1].label === 'sm_story_test_review_triggered'; }));
    });

});

suite('postStoryTestAutomationReview — review-data and verdict branches (gh-1192)', function() {

    test('missing pr_review.json posts the error comment and fails after label cleanup', function() {
        var comments = [];
        var removedLabels = [];
        var module = loadPostStoryTestAutomationReview({
            file_read: function() { return null; },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function(args) { removedLabels.push(args.label); }
        });
        var result = module.action({
            ticket: { key: 'TS-400' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });
        assert.equal(result.success, false);
        assert.equal(result.error, 'No review data found');
        assert.ok(comments.some(function(c) { return c.indexOf('Could not read pr_review.json') !== -1; }));
        assert.ok(removedLabels.indexOf('sm_story_test_review_triggered') !== -1, 'SM trigger label removed');
        assert.ok(removedLabels.indexOf('pr_story_test_automation_review_wip') !== -1, 'default WIP label removed');
    });

    test('unparseable pr_review.json fails like a missing file', function() {
        var comments = [];
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                return opts.path === 'outputs/pr_review.json' ? '{ not json' : null;
            },
            jira_post_comment: function(args) { comments.push(args.comment); }
        });
        var result = module.action({
            ticket: { key: 'TS-401' },
            jobParams: { customParams: {} }
        });
        assert.equal(result.success, false);
        assert.ok(comments.some(function(c) { return c.indexOf('Could not read pr_review.json') !== -1; }));
    });

    test('an unconfigured merge trigger falls back to the SM idle trigger', function() {
        var smIdleCalls = 0;
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') return JSON.stringify({ recommendation: 'APPROVE' });
                return null;
            }
        }, {
            autoStart: {
                triggerSmIfIdle: function() { smIdleCalls++; return { success: true }; }
            }
        });
        var result = module.action({
            ticket: { key: 'TS-402' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });
        assert.equal(result.success, true);
        assert.equal(smIdleCalls, 1, 'SM idle trigger fired as the fallback');
    });

    test('the changes-requested path also falls back to the SM idle trigger', function() {
        var smIdleCalls = 0;
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') return JSON.stringify({ recommendation: 'REQUEST_CHANGES' });
                return null;
            }
        }, {
            autoStart: {
                triggerSmIfIdle: function() { smIdleCalls++; return { success: true }; }
            }
        });
        var result = module.action({
            ticket: { key: 'TS-406' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });
        assert.equal(result.success, true);
        assert.equal(smIdleCalls, 1, 'SM idle trigger fired as the fallback');
    });

    test('params.response is posted to the tracker as the review comment', function() {
        var comments = [];
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') return JSON.stringify({ recommendation: 'APPROVE' });
                return null;
            },
            jira_post_comment: function(args) { comments.push(args.comment); }
        });
        var result = module.action({
            ticket: { key: 'TS-403' },
            response: 'AI review summary line',
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });
        assert.equal(result.success, true);
        assert.ok(comments.indexOf('AI review summary line') !== -1, 'response posted verbatim');
    });

    test('a failing rework-feedback post is a warn; the flow continues to the trigger', function() {
        var smIdleCalls = 0;
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'REQUEST_CHANGES',
                        inlineComments: [{ path: 'testing/tests/TS-404/test.ts', line: 2, body: 'Fix this' }]
                    });
                }
                return null;
            },
            prDiff: 'diff --git a/testing/tests/TS-404/test.ts b/testing/tests/TS-404/test.ts\n' +
                '--- a/testing/tests/TS-404/test.ts\n' +
                '+++ b/testing/tests/TS-404/test.ts\n' +
                '@@ -1,3 +1,3 @@\n' +
                ' line 1\n' +
                '-line 2\n' +
                '+line 2 changed\n' +
                ' line 3\n',
            jira_post_comment: function(args) {
                if (args.comment.indexOf('Rework Feedback') !== -1) throw new Error('feedback boom');
            }
        }, {
            autoStart: { triggerSmIfIdle: function() { smIdleCalls++; return { success: true }; } }
        });
        var result = module.action({
            ticket: { key: 'TS-404' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });
        assert.equal(result.success, true);
        assert.equal(smIdleCalls, 1);
    });

    test('a top-level error is reported to the tracker and fails the action', function() {
        var comments = [];
        var removedLabels = [];
        var module = loadPostStoryTestAutomationReview({
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function(args) { removedLabels.push(args.label); }
        }, {
            configLoader: {
                loadProjectConfig: function() { throw new Error('config boom'); }
            }
        });
        var result = module.action({
            ticket: { key: 'TS-405' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_review_triggered' } }
        });
        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('config boom') !== -1);
        assert.ok(removedLabels.indexOf('sm_story_test_review_triggered') !== -1);
        assert.ok(comments.some(function(c) {
            return c.indexOf('❌ Story Test Review Error') !== -1 && c.indexOf('config boom') !== -1;
        }));
    });
});

// ── gh-1224: getRepoInfo — config repository vs the git-remote fallback ──────

suite('postStoryTestAutomationReview.getRepoInfo (gh-1224)', function() {

    /** Minimal configLoader double: loadProjectConfig + the resolveInstructions contract. */
    function configDouble(config) {
        return {
            loadProjectConfig: function() { return config; },
            resolveInstructions: function() { return { jobParamPatch: undefined }; }
        };
    }

    /** Loads the module with a recorded fetchDiscussionsAndRawData + one stale thread. */
    function loadWithRepoMocks(opts) {
        var fetchCalls = [];
        var module = loadPostStoryTestAutomationReview({
            file_read: function(opts) {
                var path = opts && opts.path;
                if (path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'APPROVE',
                        generalComment: 'outputs/pr_review_general.md'
                    });
                }
                if (path === 'outputs/pr_review_general.md') return 'LGTM';
                if (path === 'input/TS-700/pr_info.md') {
                    return '**PR #**: 70\n**URL**: https://github.com/IstiN/trackstate/pull/70';
                }
                return null;
            },
            prDiff: 'diff --git a/t.ts b/t.ts\n--- a/t.ts\n+++ b/t.ts\n@@ -1,1 +1,1 @@\n-old\n+new'
        }, {
            configLoader: opts.configLoader,
            githubHelpers: {
                getGitHubRepoInfo: opts.getGitHubRepoInfo,
                fetchDiscussionsAndRawData: function(owner, repo, prNumber) {
                    fetchCalls.push({ owner: owner, repo: repo, prNumber: prNumber });
                    return { rawThreads: { threads: [{ threadId: 555, resolved: false }] } };
                }
            }
        });
        module._fetchCalls = fetchCalls;
        return module;
    }

    test('a fully configured config.repository wins and the git fallback is never called', function() {
        var ghFallbackCalls = 0;
        var module = loadWithRepoMocks({
            configLoader: configDouble({ repository: { owner: 'cfgorg', repo: 'cfgrepo' } }),
            getGitHubRepoInfo: function() { ghFallbackCalls += 1; return { owner: 'gh', repo: 'fallback' }; }
        });

        var result = module.action({ ticket: { key: 'TS-700' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(ghFallbackCalls, 0, 'the git-remote fallback is skipped when config.repository is complete');
        assert.equal(module._fetchCalls.length, 1, 'the stale-thread resolution fetched discussions');
        assert.deepEqual(module._fetchCalls[0], { owner: 'cfgorg', repo: 'cfgrepo', prNumber: 70 });
        assert.ok(module._scmCalls.resolveThread.some(function(c) { return c.thread.threadId === 555; }),
            'the stale thread was resolved with the config-provided repo context');
    });

    test('without config.repository the git-remote fallback supplies owner/repo', function() {
        var module = loadWithRepoMocks({
            configLoader: configDouble({ workingDir: null }),
            getGitHubRepoInfo: function() { return { owner: 'ghorg', repo: 'ghrepo' }; }
        });

        var result = module.action({ ticket: { key: 'TS-700' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(module._fetchCalls.length, 1);
        assert.deepEqual(module._fetchCalls[0], { owner: 'ghorg', repo: 'ghrepo', prNumber: 70 });
    });

    test('a config.repository with owner but no repo falls back to the git remote', function() {
        var module = loadWithRepoMocks({
            configLoader: configDouble({ repository: { owner: 'cfgorg' } }),
            getGitHubRepoInfo: function() { return { owner: 'ghorg', repo: 'ghrepo' }; }
        });

        var result = module.action({ ticket: { key: 'TS-700' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.deepEqual(module._fetchCalls[0], { owner: 'ghorg', repo: 'ghrepo', prNumber: 70 },
            'an incomplete config.repository is not usable — the fallback supplies both fields');
    });

    test('a failing git-remote probe leaves repoInfo null and the action still succeeds', function() {
        var module = loadWithRepoMocks({
            configLoader: configDouble({}),
            getGitHubRepoInfo: function() { throw new Error('not a git repo'); }
        });

        var result = module.action({ ticket: { key: 'TS-700' }, jobParams: {} });

        assert.equal(result.success, true, 'the missing repo info degrades gracefully');
        assert.equal(module._fetchCalls.length, 0, 'no repo context — no discussion fetch');
        assert.ok(module._scmCalls.addComment.some(function(c) { return c.text === 'LGTM'; }),
            'the general comment is still posted to the PR');
    });

    test('a git-remote probe throwing a message-less value hits the same null path', function() {
        var module = loadWithRepoMocks({
            configLoader: configDouble({}),
            getGitHubRepoInfo: function() { throw 'plain string failure'; }
        });

        var result = module.action({ ticket: { key: 'TS-700' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(module._fetchCalls.length, 0);
    });
});
