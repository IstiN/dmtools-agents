/**
 * Unit tests for rework post-actions merging project jobParamPatches.
 */

function loadPushReworkChanges() {
    return loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/submodules.js': {},
            './common/pullRequest.js': {},
            './common/feedbackLoop.js': {},
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/outputFiles.js': {
                readOutputFile: function(path) {
                    if (mocks.outputFiles && mocks.outputFiles[path] !== undefined) {
                        return mocks.outputFiles[path];
                    }
                    return null;
                }
            },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './cacheToReleases.js': {}
        }),
        {}
    );
}

function loadPushReworkChangesForAction(mocks) {
    mocks = mocks || {};
    return loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': {
                createScm: function() {
                    return {
                        getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; },
                        listPrs: function() { return [{ number: 1571, title: 'TS-1293 Fix', html_url: 'https://github.com/IstiN/trackstate/pull/1571', head: { ref: 'ai/TS-1293' } }]; },
                        addComment: function(prId, text) { mocks.prComments = (mocks.prComments || 0) + 1; mocks.prCommentTexts = (mocks.prCommentTexts || []).concat(text); },
                        replyToThread: function(prId, thread, text) {
                            mocks.threadReplies = (mocks.threadReplies || 0) + 1;
                            mocks.replyTexts = (mocks.replyTexts || []).concat(text);
                        },
                        resolveThread: function() { mocks.resolvedThreads = (mocks.resolvedThreads || 0) + 1; }
                    };
                }
            },
            './common/submodules.js': { pushManagedSubmodules: function() {} },
            './common/pullRequest.js': {
                readStagedDiffStat: function() { return 'lib/app.dart | 1 +'; },
                syncBranchWithBase: function() { return { success: true }; }
            },
            './common/feedbackLoop.js': {
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function(options) {
                    mocks.resumeCalls = (mocks.resumeCalls || []).concat([options.stage]);
                    if (typeof mocks.onResume === 'function') mocks.onResume(options);
                    return mocks.resumeResult || { attempted: false };
                }
            },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function() { mocks.autoStartReview = true; return true; },
                triggerSmIfIdle: function() { mocks.triggerSm = true; return true; }
            },
            './common/outputFiles.js': {
                readOutputFile: function(path) {
                    if (mocks.outputFiles && mocks.outputFiles[path] !== undefined) {
                        return mocks.outputFiles[path];
                    }
                    return null;
                }
            },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './cacheToReleases.js': { action: function() {} }
        }),
        {
            file_read: function(args) {
                if (args.path === 'input/TS-1293/pr_info.md') {
                    return '**Branch**: `ai/TS-1293` → `main`';
                }
                throw new Error('missing ' + args.path);
            },
            cli_execute_command: function(args) {
                mocks.commands = mocks.commands || [];
                mocks.commands.push(args.command);
                if (args.command === 'git branch --show-current') return 'ai/TS-1293';
                if (args.command === 'git push -u origin ai/TS-1293' && mocks.failFirstPush) {
                    mocks.failFirstPush = false;
                    throw new Error('rejected non-fast-forward');
                }
                if (args.command.indexOf('git ls-remote --heads origin ai/TS-1293') === 0) return 'abc123\trefs/heads/ai/TS-1293';
                return '';
            },
            jira_post_comment: function(args) { mocks.jiraComments = (mocks.jiraComments || []).concat([args.comment]); },
            jira_move_to_status: function(args) { mocks.moves = (mocks.moves || []).concat([args.statusName]); },
            jira_remove_label: function(args) { mocks.removedLabels = (mocks.removedLabels || []).concat([args.label]); },
            jira_assign_ticket_to: function() {}
        }
    );
}

function loadPostTestReworkResults() {
    return loadModule(
        'js/postTestReworkResults.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/feedbackLoop.js': {},
            './common/pullRequest.js': {},
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        {}
    );
}

suite('rework custom params', function() {
    test('merges pr_rework jobParamPatches into runtime customParams', function() {
        var mod = loadPushReworkChanges();

        var customParams = mod.resolveCustomParams(
            {
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_story_rework_triggered',
                        targetRepository: { owner: 'IstiN', repo: 'trackstate' }
                    }
                }
            },
            { customParams: { ignored: true } },
            {
                jobParamPatches: {
                    pr_rework: {
                        customParams: {
                            autoStartReview: true,
                            autoStartReviewConfigFile: 'agents/pr_review.json',
                            removeLabel: 'from_patch'
                        }
                    }
                }
            }
        );

        assert.equal(customParams.autoStartReview, true);
        assert.equal(customParams.autoStartReviewConfigFile, 'agents/pr_review.json');
        assert.equal(customParams.removeLabel, 'sm_story_rework_triggered');
        assert.deepEqual(customParams.targetRepository, { owner: 'IstiN', repo: 'trackstate' });
    });

    test('detects interrupted pr_rework responses', function() {
        var mod = loadPushReworkChanges();

        assert.equal(mod.isInterruptedReworkResponse('CLI command executed but did not produce output file'), true);
        assert.equal(mod.isInterruptedReworkResponse('Command failed (exit code 124): ./agents/scripts/run-agent.sh'), true);
        assert.equal(mod.isInterruptedReworkResponse('Implemented fix and wrote outputs/response.md'), false);
    });

    test('interrupted pr_rework keeps PR conversations open and resets ticket for retry', function() {
        var mocks = {};
        var mod = loadPushReworkChangesForAction(mocks);

        var result = mod.action({
            jobParams: {
                ticket: { key: 'TS-1293', fields: { labels: [] } },
                response: 'CLI command executed but did not produce output file:\nCommand failed (exit code 124): ./agents/scripts/run-agent.sh',
                customParams: {
                    removeLabels: ['sm_story_rework_triggered'],
                    autoStartReview: true,
                    autoStartReviewConfigFile: 'agents/pr_review.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'rework-interrupted');
        assert.deepEqual(mocks.moves, ['In Rework']);
        assert.deepEqual(mocks.removedLabels, ['sm_story_rework_triggered']);
        assert.equal(mocks.prComments || 0, 0, 'must not post Rework Complete PR comment');
        assert.equal(mocks.threadReplies || 0, 0, 'must not reply to conversations without review_replies.json');
        assert.equal(mocks.resolvedThreads || 0, 0, 'must not resolve conversations without review_replies.json');
        assert.equal(!!mocks.autoStartReview, false, 'must not start review after interrupted rework');
    });

    test('interrupted pr_rework attempts resume before falling back to SM retry', function() {
        var params;
        var mocks = {
            resumeResult: { attempted: true },
            onResume: function() {
                params.jobParams.response = 'Implemented fix and wrote outputs/response.md after resume.';
            }
        };
        var mod = loadPushReworkChangesForAction(mocks);

        params = {
            jobParams: {
                ticket: { key: 'TS-1293', fields: { labels: [] } },
                response: 'CLI command executed but did not produce output file:\nCommand failed (exit code 124): ./agents/scripts/run-agent.sh',
                customParams: {
                    feedbackLoop: { postAction: { enabled: true, maxAttempts: 2 } },
                    removeLabels: ['sm_story_rework_triggered']
                }
            }
        };
        var result = mod.action(params);

        assert.deepEqual(mocks.resumeCalls, ['rework_missing_outputs']);
        assert.equal(result.success, true);
        assert.equal(result.message, 'TS-1293 rework pushed, PR commented, moved to In Review');
        assert.deepEqual(mocks.moves, ['In Review']);
    });

    test('pr_rework syncs remote branch before retrying a rejected push', function() {
        var mocks = { failFirstPush: true };
        var mod = loadPushReworkChangesForAction(mocks);

        var result = mod.action({
            jobParams: {
                ticket: { key: 'TS-1293', fields: { labels: [] } },
                response: 'Implemented fix and wrote outputs/response.md',
                customParams: {
                    removeLabels: ['sm_story_rework_triggered']
                }
            }
        });

        assert.equal(result.success, true);
        assert.ok(
            mocks.commands.indexOf('git -c fetch.recurseSubmodules=no fetch origin ai/TS-1293:refs/remotes/origin/ai/TS-1293') !== -1,
            'expected fetch of remote PR branch after rejected push'
        );
        assert.ok(
            mocks.commands.indexOf('git merge --no-edit origin/ai/TS-1293') !== -1,
            'expected merge of remote PR branch before retry push'
        );
        assert.equal(
            mocks.commands.indexOf('git push -u origin ai/TS-1293 --force-with-lease'),
            -1,
            'must not force-push over remote PR updates'
        );
    });

    test('pr_rework posts thread replies from files referenced in review_replies.json and resolves threads', function() {
        var mocks = {
            outputFiles: {
                'review_replies.json': JSON.stringify({
                    replies: [
                        {
                            inReplyToId: 111,
                            threadId: 'PRRT_abc',
                            reply: 'outputs/review_replies/thread_111.md'
                        },
                        {
                            inReplyToId: 222,
                            threadId: 'PRRT_def',
                            reply: 'outputs/review_replies/thread_222.md'
                        }
                    ]
                }),
                'outputs/review_replies/thread_111.md': '✅ Fixed in `ai/TS-1293`.',
                'outputs/review_replies/thread_222.md': '✅ Renamed variable per review.'
            }
        };
        var mod = loadPushReworkChangesForAction(mocks);

        var result = mod.action({
            jobParams: {
                ticket: { key: 'TS-1293', fields: { labels: [] } },
                response: 'Implemented fix and wrote outputs/response.md',
                customParams: {
                    removeLabels: ['sm_story_rework_triggered']
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(mocks.threadReplies, 2);
        assert.equal(mocks.resolvedThreads, 2);
        assert.deepEqual(mocks.replyTexts, ['✅ Fixed in `ai/TS-1293`.', '✅ Renamed variable per review.']);
        assert.equal(mocks.prComments || 0, 0, 'must not post a top-level PR comment when thread replies exist');
    });

    test('merges pr_test_automation_rework jobParamPatches into runtime customParams', function() {
        var mod = loadPostTestReworkResults();

        var customParams = mod.resolveCustomParams(
            {
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_tc_rework_triggered'
                    }
                }
            },
            {},
            {
                jobParamPatches: {
                    pr_test_automation_rework: {
                        customParams: {
                            autoStartReview: true,
                            autoStartReviewConfigFile: 'agents/pr_test_automation_review.json',
                            removeLabel: 'from_patch'
                        }
                    }
                }
            }
        );

        assert.equal(customParams.autoStartReview, true);
        assert.equal(customParams.autoStartReviewConfigFile, 'agents/pr_test_automation_review.json');
        assert.equal(customParams.removeLabel, 'sm_tc_rework_triggered');
    });
});
