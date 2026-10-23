/**
 * Unit tests for js/postTestReviewComments.js.
 */

function loadPostTestReviewComments(mocks, moduleMocks) {
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
        github_get_pr_diff: function() { return null; },
        github_add_pr_label: function() {},
        github_resolve_pr_thread: function() {},
        cli_execute_command: function() { return ''; }
    };
    var allMocks = Object.assign({}, defaults, mocks || {});
    var outputFiles = loadModule(
        'js/common/outputFiles.js',
        makeRequire({}),
        allMocks
    );
    var gh = loadModule(
        'js/common/githubHelpers.js',
        makeRequire({
            '../config.js': configModule,
            // Real PR helper (gh-912): githubHelpers delegates cleanCommandOutput
            // to it, so the canonical implementation must be in the map.
            './pullRequest.js': loadModule('js/common/pullRequest.js',
                makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') })),
            './scm.js': { createScm: function() { return {}; } },
            './gitOps.js': {},
            './machineNotice.js': loadModule('js/common/machineNotice.js'),
            './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js', makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') })),
            './ci.js': loadModule('js/common/ci.js'),
            './ciViolations.js': loadModule('js/common/ciViolations.js')
        }),
        allMocks
    );

    var autoStartMock = (moduleMocks && moduleMocks.autoStart) || {
        triggerConfiguredWorkflowForTicket: function() {
            return { success: true };
        },
        triggerSmIfIdle: function() {}
    };

    return loadModule(
        'js/postTestReviewComments.js',
        makeRequire({
            './config.js': configModule,
            './common/githubHelpers.js': gh,
            './common/autoStart.js': autoStartMock,
            './configLoader.js': configLoaderModule,
            './common/outputFiles.js': outputFiles,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), allMocks)
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

    test('marks ticket for SM test rework when direct auto-start is capped', function() {
        var labels = [];
        var smFallbackCalled = false;
        var module = loadPostTestReviewComments({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'REQUEST_CHANGES',
                        generalComment: 'outputs/pr_review_general.md'
                    });
                }
                if (opts.path === 'outputs/pr_review_general.md') return 'Needs rework';
                return null;
            },
            github_list_prs: function() {
                return [{ number: 1323, html_url: 'https://github.com/org/repo/pull/1323', head: { ref: 'test/TS-1323' } }];
            },
            jira_add_label: function(args) {
                labels.push(args.label);
            },
            cli_execute_command: function() {
                return 'https://github.com/IstiN/trackstate';
            }
        }, {
            autoStart: {
                triggerConfiguredWorkflowForTicket: function() { return false; },
                triggerSmIfIdle: function() { smFallbackCalled = true; }
            }
        });

        var result = module.action({
            ticket: { key: 'TS-1323', fields: { summary: 'Review capped auto-start' } },
            jobParams: {
                customParams: {
                    autoStartRework: true,
                    autoStartReworkConfigFile: 'agents/pr_test_automation_rework.json',
                    smFallback: true
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.finalStatus, 'In Rework');
        assert.ok(labels.indexOf('sm_test_rework_triggered') !== -1, 'SM test rework trigger label added');
        assert.equal(smFallbackCalled, true, 'SM fallback attempted after direct auto-start was capped');
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

    test('falls back without calling inline API when line is not in PR diff', function() {
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
                                path: 'testing/tests/TS-250/config.yaml',
                                line: 59,
                                body: 'Line is outside the diff.'
                            }
                        ]
                    });
                }
                if (opts.path === 'outputs/pr_review_general.md') return 'General comment';
                return null;
            },
            github_list_prs: function() {
                return [{ number: 255, html_url: 'https://github.com/org/repo/pull/255', head: { ref: 'test/DMC-1104' } }];
            },
            cli_execute_command: function() {
                return 'https://github.com/IstiN/trackstate';
            },
            github_get_pr_diff: function() {
                return [
                    'diff --git a/testing/tests/TS-250/config.yaml b/testing/tests/TS-250/config.yaml',
                    '--- a/testing/tests/TS-250/config.yaml',
                    '+++ b/testing/tests/TS-250/config.yaml',
                    '@@ -1,3 +1,3 @@',
                    ' name: TS-250',
                    '+enabled: true',
                    ' owner: qa'
                ].join('\n');
            },
            github_add_inline_comment: function(args) {
                inlineCalls.push(args);
            },
            github_add_pr_comment: function(args) {
                prComments.push(args);
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-1104', fields: { summary: 'Inline diff prevalidation' } }
        });

        assert.equal(result.success, true);
        assert.equal(inlineCalls.length, 0, 'inline API should not be called for a line outside the PR diff');
        assert.equal(prComments.length, 2, 'general comment plus fallback inline comment');
        assert.contains(prComments[1].text, 'testing/tests/TS-250/config.yaml:59');
        assert.contains(prComments[1].text, 'Line is outside the diff');
    });

    test('gh-802 rework: github_get_pr_diff receives pullRequestID (schema casing), never pullRequestId', function() {
        // dmtools v1.7.256 declares `pullRequestID` (capital D) for BOTH diff
        // tools — `pullRequestId` fails with "Required parameter
        // 'pullRequestID' is missing", and the null-returning catch then
        // silently skips inline-comment validation. Pin the schema casing.
        var diffCalls = [];
        var module = loadPostTestReviewComments({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({
                        recommendation: 'COMMENT',
                        generalComment: 'outputs/pr_review_general.md',
                        inlineComments: [
                            { path: 'testing/tests/TS-250/config.yaml', line: 59, body: 'Diff-backed finding.' }
                        ]
                    });
                }
                if (opts.path === 'outputs/pr_review_general.md') return 'General comment';
                return null;
            },
            github_list_prs: function() {
                return [{ number: 255, html_url: 'https://github.com/example-org/example-repo/pull/255', head: { ref: 'test/DMC-1105' } }];
            },
            cli_execute_command: function() {
                return 'https://github.com/example-org/example-repo';
            },
            github_get_pr_diff: function(args) {
                diffCalls.push(args);
                return [
                    'diff --git a/testing/tests/TS-250/config.yaml b/testing/tests/TS-250/config.yaml',
                    '--- a/testing/tests/TS-250/config.yaml',
                    '+++ b/testing/tests/TS-250/config.yaml',
                    '@@ -1,3 +1,3 @@',
                    ' name: TS-250',
                    '+enabled: true',
                    ' owner: qa'
                ].join('\n');
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-1105', fields: { summary: 'Diff arg casing pin' } }
        });

        assert.equal(result.success, true, 'action succeeded — got: ' + JSON.stringify(result));
        assert.equal(diffCalls.length, 1, 'the PR diff is fetched once for inline prevalidation');
        assert.equal(diffCalls[0].pullRequestID, '255',
            'the diff tool schema requires pullRequestID (capital D) — got: ' + JSON.stringify(diffCalls[0]));
        assert.equal(diffCalls[0].pullRequestId, undefined,
            'pullRequestId is rejected by the runtime schema — must not be sent');
    });
});

suite('postTestReviewComments: recommendation normalization and final status (gh-1011)', function() {

    function loadWithReview(reviewJson, extraMocks, moduleMocks) {
        return loadPostTestReviewComments(Object.assign({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path === 'outputs/pr_review.json') return JSON.stringify(reviewJson);
                return null;
            },
            github_list_prs: function() {
                return [{ number: 42, html_url: 'https://github.com/org/repo/pull/42', head: { ref: 'test/DMC-7' } }];
            },
            cli_execute_command: function() { return 'https://github.com/IstiN/trackstate'; }
        }, extraMocks || {}), moduleMocks);
    }

    function approveParams(extra) {
        return Object.assign({
            ticket: { key: 'DMC-7', fields: { summary: 'Normalize' } },
            jobParams: { customParams: {} }
        }, extra || {});
    }

    test('"PASSED" normalizes to APPROVE and a Passed ticket goes to Passed', function() {
        var moves = [];
        var module = loadWithReview({ recommendation: 'PASSED' }, {
            jira_move_to_status: function(args) { moves.push(args.statusName); }
        });

        var result = module.action(approveParams());

        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'APPROVE');
        assert.equal(result.mergeSucceeded, true, 'PR found → queued for merge');
        assert.equal(result.finalStatus, 'Passed', 'In Review - Passed ticket ends Passed');
        assert.deepEqual(moves, [], 'approval never moves the ticket directly');
    });

    test('"FAILED" normalizes to BLOCK and moves the ticket to In Rework', function() {
        var moves = [];
        var module = loadWithReview({ recommendation: 'FAILED' }, {
            jira_move_to_status: function(args) { moves.push(args.statusName); }
        });

        var result = module.action(approveParams());

        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'BLOCK');
        assert.equal(result.mergeSucceeded, false);
        assert.equal(result.finalStatus, 'In Rework');
        assert.deepEqual(moves, ['In Rework']);
    });

    test('"REJECT" normalizes to BLOCK', function() {
        var module = loadWithReview({ recommendation: 'reject' }, {});

        var result = module.action(approveParams());

        assert.equal(result.recommendation, 'BLOCK');
        assert.equal(result.finalStatus, 'In Rework');
    });

    test('an unrecognized recommendation is passed through untouched', function() {
        var module = loadWithReview({ recommendation: 'Request Changes' }, {});

        var result = module.action(approveParams());

        assert.equal(result.recommendation, 'Request Changes', 'mixed-case unknown value is NOT normalized');
        assert.equal(result.finalStatus, 'In Rework');
    });

    test('APPROVE without a discoverable PR reports the merge-conflict final status', function() {
        var module = loadWithReview({ recommendation: 'APPROVE' }, {
            github_list_prs: function() { return []; }
        });

        var result = module.action(approveParams());

        assert.equal(result.success, true);
        assert.equal(result.mergeSucceeded, false, 'no PR → nothing queued for merge');
        assert.equal(result.finalStatus, 'In Rework', 'approved-but-unmerged lands on In Rework');
    });

    test('APPROVE on an In Review - Failed ticket ends Failed', function() {
        var module = loadWithReview({ recommendation: 'APPROVED' }, {
            jira_get_ticket: function() {
                return { fields: { status: { name: 'In Review - Failed' } } };
            }
        });

        var result = module.action(approveParams());

        assert.equal(result.recommendation, 'APPROVE');
        assert.equal(result.finalStatus, 'Failed');
    });

    test('the review comment text is posted to the tracker', function() {
        var comments = [];
        var module = loadWithReview({ recommendation: 'BLOCK' }, {
            jira_post_comment: function(args) { comments.push(args.comment); }
        });

        module.action(approveParams({ response: 'h3. Review verdict\n\nPlease fix' }));

        assert.ok(comments.some(function(c) { return c.indexOf('Review verdict') !== -1; }),
            'the response text is posted, got: ' + JSON.stringify(comments));
    });

    test('a tracker status probe failure leaves the flow on the BLOCK fallback', function() {
        var module = loadWithReview({ recommendation: 'BLOCK' }, {
            jira_get_ticket: function() { throw new Error('jira down'); }
        });

        var result = module.action(approveParams());

        assert.equal(result.success, true);
        assert.equal(result.finalStatus, 'In Rework');
    });

    test('outer catch: a params object without a ticket returns a failure instead of throwing', function() {
        var module = loadWithReview({}, {});

        var result = module.action({});

        assert.equal(result.success, false);
        assert.contains(result.error, 'propert', 'the TypeError message is surfaced (Node and GraalJS phrase it differently)');
        assert.contains(result.error, 'key');
    });
});

suite('postTestReviewComments: outer-catch error comment (gh-1011)', function() {

    test('an unwrapped mid-flow error posts the ❌ error comment and removes the SM trigger label', function() {
        var comments = [];
        var removedLabels = [];
        var module = loadPostTestReviewComments({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path === 'outputs/pr_review.json') {
                    return JSON.stringify({ recommendation: 'APPROVE' });
                }
                return null;
            },
            github_list_prs: function() {
                return [{ number: 42, html_url: 'https://github.com/org/repo/pull/42', head: { ref: 'test/DMC-8' } }];
            },
            cli_execute_command: function() { return 'https://github.com/IstiN/trackstate'; },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function(args) { removedLabels.push(args.label); }
        }, {
            autoStart: {
                triggerConfiguredWorkflowForTicket: function() { return { success: true }; },
                triggerSmIfIdle: function() { throw new Error('sm idle boom'); }
            }
        });

        var result = module.action({
            ticket: { key: 'DMC-8', fields: { summary: 'Mid-flow error' } },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'sm idle boom', 'the original error is surfaced');
        assert.ok(removedLabels.indexOf('sm_test_review_triggered') !== -1,
            'the SM trigger label is removed in the catch, got: ' + JSON.stringify(removedLabels));
        assert.ok(comments.some(function(c) {
            return c.indexOf('❌ Test Review Error') !== -1 && c.indexOf('sm idle boom') !== -1;
        }), 'the error comment is posted to the ticket, got: ' + JSON.stringify(comments));
    });
});

suite('postTestReviewComments.isLinePresentInDiff — pure diff scanner (gh-1192)', function() {

    function loadScanner() {
        return loadPostTestReviewComments({});
    }

    function joined(lines) {
        return lines.join('\n');
    }

    var SIMPLE = joined([
        'diff --git a/foo.ts b/foo.ts',
        '--- a/foo.ts',
        '+++ b/foo.ts',
        '@@ -10,5 +10,5 @@',
        ' line 10',
        '-line 11',
        '+line 11 new',
        ' line 12',
        ' line 13',
        ' line 14'
    ]);

    test('empty diff, file or target line are permissive (cannot validate)', function() {
        var m = loadScanner();
        assert.equal(m.isLinePresentInDiff('', 'foo.ts', 10), true);
        assert.equal(m.isLinePresentInDiff(SIMPLE, '', 10), true);
        assert.equal(m.isLinePresentInDiff(SIMPLE, 'foo.ts', ''), true);
        assert.equal(m.isLinePresentInDiff(null, null, null), true);
    });

    test('non-numeric or zero target lines are permissive', function() {
        var m = loadScanner();
        assert.equal(m.isLinePresentInDiff(SIMPLE, 'foo.ts', 'abc'), true);
        assert.equal(m.isLinePresentInDiff(SIMPLE, 'foo.ts', 0), true);
    });

    test('context lines match on the new-side numbering', function() {
        var m = loadScanner();
        assert.equal(m.isLinePresentInDiff(SIMPLE, 'foo.ts', 10), true);
        assert.equal(m.isLinePresentInDiff(SIMPLE, 'foo.ts', 12), true);
        assert.equal(m.isLinePresentInDiff(SIMPLE, 'foo.ts', 14), true);
    });

    test('added lines match; removed lines never match the new side', function() {
        var m = loadScanner();
        assert.equal(m.isLinePresentInDiff(SIMPLE, 'foo.ts', 11), true, 'the added replacement is present');
        var shifted = joined([
            'diff --git a/bar.ts b/bar.ts',
            '--- a/bar.ts',
            '+++ b/bar.ts',
            '@@ -30,3 +31,2 @@',
            ' line 31',
            '-line 30',
            '-line 31'
        ]);
        assert.equal(m.isLinePresentInDiff(shifted, 'bar.ts', 30), false, 'removed old-side number is not on the new side');
        assert.equal(m.isLinePresentInDiff(shifted, 'bar.ts', 31), true);
        assert.equal(m.isLinePresentInDiff(shifted, 'bar.ts', 32), false);
    });

    test('other files in the same diff are ignored', function() {
        var m = loadScanner();
        assert.equal(m.isLinePresentInDiff(SIMPLE, 'other.ts', 10), false);
    });

    test('a second file is found after the first is skipped', function() {
        var m = loadScanner();
        var multi = joined([
            'diff --git a/first.ts b/first.ts',
            '--- a/first.ts',
            '+++ b/first.ts',
            '@@ -1,2 +1,2 @@',
            ' one',
            ' two',
            'diff --git a/second.ts b/second.ts',
            '--- a/second.ts',
            '+++ b/second.ts',
            '@@ -5,2 +5,2 @@',
            ' alpha',
            ' beta'
        ]);
        assert.equal(m.isLinePresentInDiff(multi, 'second.ts', 5), true);
        assert.equal(m.isLinePresentInDiff(multi, 'second.ts', 6), true);
        assert.equal(m.isLinePresentInDiff(multi, 'second.ts', 7), false);
        assert.equal(m.isLinePresentInDiff(multi, 'first.ts', 1), true);
    });

    test("the '\\ No newline at end of file' marker neither matches nor advances", function() {
        var m = loadScanner();
        var noNl = joined([
            'diff --git a/n.ts b/n.ts',
            '--- a/n.ts',
            '+++ b/n.ts',
            '@@ -1,2 +1,2 @@',
            ' one',
            ' two',
            '\\ No newline at end of file',
            ' three'
        ]);
        assert.equal(m.isLinePresentInDiff(noNl, 'n.ts', 2), true);
        assert.equal(m.isLinePresentInDiff(noNl, 'n.ts', 3), true, 'the marker did not consume a line number');
    });

    test('CRLF line endings are split correctly', function() {
        var m = loadScanner();
        var crlf = SIMPLE.replace(/\n/g, '\r\n');
        assert.equal(m.isLinePresentInDiff(crlf, 'foo.ts', 12), true);
        assert.equal(m.isLinePresentInDiff(crlf, 'foo.ts', 99), false);
    });

    test('a target line inside a later hunk of the same file is found', function() {
        var m = loadScanner();
        var twoHunks = joined([
            'diff --git a/h.ts b/h.ts',
            '--- a/h.ts',
            '+++ b/h.ts',
            '@@ -1,2 +1,2 @@',
            ' a',
            ' b',
            '@@ -50,2 +50,2 @@',
            ' x',
            '+y'
        ]);
        assert.equal(m.isLinePresentInDiff(twoHunks, 'h.ts', 50), true);
        assert.equal(m.isLinePresentInDiff(twoHunks, 'h.ts', 51), true);
        assert.equal(m.isLinePresentInDiff(twoHunks, 'h.ts', 52), false);
    });

    test('prefix-less junk lines inside a segment advance the counter', function() {
        var m = loadScanner();
        var junk = joined([
            'diff --git a/j.ts b/j.ts',
            '--- a/j.ts',
            '+++ b/j.ts',
            '@@ -1,1 +1,3 @@',
            'keep',
            ' junk line',
            ' tail'
        ]);
        // 'keep' has no diff prefix → falls into the catch-all branch and
        // advances newLine (1→2); ' junk line' then matches new-side line 2.
        assert.equal(m.isLinePresentInDiff(junk, 'j.ts', 2), true);
        assert.equal(m.isLinePresentInDiff(junk, 'j.ts', 3), true);
    });

    test('the extracted scan helpers keep the state-machine contract', function() {
        var m = loadScanner();
        var st = m.newInlineScanState();
        assert.deepEqual(st, { currentFile: null, newLine: null });
        assert.equal(m.trackInlineHeaderLine(st, 'diff --git a/x b/y'), true, 'consumed');
        assert.deepEqual(st, { currentFile: null, newLine: null });
        assert.equal(m.trackInlineHeaderLine(st, '+++ b/foo.ts'), true, 'consumed');
        assert.equal(st.currentFile, 'foo.ts');
        assert.equal(m.trackInlineHeaderLine(st, ' content'), false, 'not consumed');
        assert.equal(m.inlineHunkStartOf('@@ -5,7 +12,3 @@ ctx'), 12);
        assert.equal(m.inlineHunkStartOf('+++ b/foo.ts'), null);
        st.newLine = 12;
        assert.equal(m.inlineContentLineMatches(st, '+added', 12), true);
        assert.equal(st.newLine, 12, 'a matching line returns immediately, without advancing');
        assert.equal(m.inlineContentLineMatches(st, '+other', 13), false);
        assert.equal(st.newLine, 13, 'a non-matching added line advanced');
        assert.equal(m.inlineContentLineMatches(st, '-removed', 13), false);
        assert.equal(st.newLine, 13, 'removed line did not advance');
        assert.equal(m.inlineContentLineMatches(st, '\\ No newline at end of file', 13), false);
        assert.equal(st.newLine, 13, 'marker did not advance');
        assert.equal(m.inlineContentLineMatches(st, 'junk', 13), false);
        assert.equal(st.newLine, 14, 'prefix-less junk advanced');
    });
});
