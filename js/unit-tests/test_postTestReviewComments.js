/**
 * Unit tests for js/postTestReviewComments.js.
 */

function loadPostTestReviewComments(mocks) {
    var defaults = {
        file_read: function(opts) {
            if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
            return null;
        },
        jira_get_ticket: function() {
            return { fields: { status: { name: 'In Review - Passed' } } };
        },
        jira_post_comment: function() {},
        jira_remove_label: function() {},
        jira_add_label: function() {},
        jira_move_to_status: function() {},
        github_list_prs: function() { return []; },
        github_add_pr_comment: function() {},
        github_add_inline_comment: function() {},
        github_add_pr_label: function() {},
        github_resolve_pr_thread: function() {},
        cli_execute_command: function() { return ''; }
    };
    var allMocks = Object.assign({}, defaults, mocks || {});
    var gh = loadModule(
        'js/common/githubHelpers.js',
        makeRequire({
            '../config.js': configModule,
            './pullRequest.js': {},
            './scm.js': { createScm: function() { return {}; } }
        }),
        allMocks
    );

    return loadModule(
        'js/postTestReviewComments.js',
        makeRequire({
            './config.js': configModule,
            './common/githubHelpers.js': gh,
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function() {
                    return { success: true };
                },
                triggerSmIfIdle: function() {}
            },
            './configLoader.js': configLoaderModule
        }),
        allMocks
    );
}

suite('postTestReviewComments: failure cleanup', function() {
    test('removes SM trigger and WIP labels when review JSON is missing', function() {
        var comments = [];
        var removedLabels = [];
        var module = loadPostTestReviewComments({
            jira_post_comment: function(args) {
                comments.push(args.comment);
            },
            jira_remove_label: function(args) {
                removedLabels.push(args.label);
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-1100', fields: { summary: 'Review retry cleanup' } },
            metadata: { contextId: 'pr_test_automation_review' },
            jobParams: { customParams: { removeLabel: 'sm_test_review_triggered' } }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No review data found');
        assert.ok(removedLabels.indexOf('sm_test_review_triggered') !== -1, 'removed SM trigger label');
        assert.ok(removedLabels.indexOf('pr_test_automation_review_wip') !== -1, 'removed WIP label');
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'Removed SM trigger label so SM can retry');
    });

    test('reads review JSON from configured workingDir outputs fallback', function() {
        var reads = [];
        var module = loadPostTestReviewComments({
            file_read: function(opts) {
                reads.push(opts.path);
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path === '/tmp/repo/outputs/pr_review.json') {
                    return JSON.stringify({ recommendation: 'APPROVE', generalComment: '/tmp/repo/outputs/comment.md' });
                }
                if (opts.path === '/tmp/repo/outputs/comment.md') return 'Approved';
                return null;
            },
            github_list_prs: function() {
                return [{ number: 42, html_url: 'https://github.com/org/repo/pull/42', head: { ref: 'test/DMC-1101' } }];
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-1101', fields: { summary: 'Review working dir' } },
            jobParams: { customParams: { targetRepository: { workingDir: '/tmp/repo' } } }
        });

        assert.equal(result.success, true);
        assert.ok(reads.indexOf('/tmp/repo/outputs/pr_review.json') !== -1, 'checked workingDir fallback path');
    });
});

suite('postTestReviewComments: inline comments', function() {
    test('posts inline comments from current JSON contract body/path fields', function() {
        var inlineCalls = [];
        var prComments = [];
        var module = loadPostTestReviewComments({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'REQUEST_CHANGES',
                        generalComment: 'outputs/pr_review_general.md',
                        inlineComments: [
                            {
                                path: 'testing/tests/TS-250/test_ts_250.py',
                                line: 88,
                                body: '⚠️ Inline finding from JSON body.'
                            }
                        ]
                    });
                }
                if (opts.path === 'outputs/pr_review_general.md') return 'General comment';
                return null;
            },
            github_list_prs: function() {
                return [{ number: 255, html_url: 'https://github.com/org/repo/pull/255', head: { ref: 'test/DMC-1102' } }];
            },
            cli_execute_command: function() {
                return 'https://github.com/IstiN/trackstate';
            },
            github_add_inline_comment: function(args) {
                inlineCalls.push(args);
            },
            github_add_pr_comment: function(args) {
                prComments.push(args);
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-1102', fields: { summary: 'Inline review contract' } }
        });

        assert.equal(result.success, true);
        assert.equal(inlineCalls.length, 1, 'inline comment posted');
        assert.equal(inlineCalls[0].path, 'testing/tests/TS-250/test_ts_250.py');
        assert.equal(inlineCalls[0].line, '88');
        assert.contains(inlineCalls[0].text, 'Inline finding from JSON body');
        assert.equal(prComments.length, 1, 'general comment only, no fallback needed');
    });

    test('falls back to PR comment when inline posting fails', function() {
        var prComments = [];
        var module = loadPostTestReviewComments({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'REQUEST_CHANGES',
                        generalComment: 'outputs/pr_review_general.md',
                        inlineComments: [
                            {
                                path: 'testing/tests/TS-250/test_ts_250.py',
                                line: 99,
                                body: '⚠️ Fallback inline finding.'
                            }
                        ]
                    });
                }
                if (opts.path === 'outputs/pr_review_general.md') return 'General comment';
                return null;
            },
            github_list_prs: function() {
                return [{ number: 255, html_url: 'https://github.com/org/repo/pull/255', head: { ref: 'test/DMC-1103' } }];
            },
            cli_execute_command: function() {
                return 'https://github.com/IstiN/trackstate';
            },
            github_add_inline_comment: function() {
                throw new Error('422 line not in diff');
            },
            github_add_pr_comment: function(args) {
                prComments.push(args);
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-1103', fields: { summary: 'Inline review fallback' } }
        });

        assert.equal(result.success, true);
        assert.equal(prComments.length, 2, 'general comment plus fallback inline comment');
        assert.contains(prComments[1].text, 'testing/tests/TS-250/test_ts_250.py:99');
        assert.contains(prComments[1].text, 'Fallback inline finding');
    });
});
