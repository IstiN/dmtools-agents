/**
 * Unit tests for rework post-actions merging project jobParamPatches.
 */

// gh-1137: named pass-through stub for the toolchain-summary annotation. A
// per-callsite inline function(t){return t;} would sit uncovered inside the
// loader functions and lift their CRAP over the ratchet; the named helper is
// a separate coverage unit of complexity 1 (CRAP 2, far below the bar).
var stubToolchainLine = function (t) { return t; };
var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var ticketKeyShapesModule = loadModule('js/common/ticketKeyShapes.js');
var gitStagingModule = loadModule('js/common/gitStaging.js');
var forkCheckoutModule = loadModule('js/common/forkCheckout.js', makeRequire({ './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {}) }), {});
// gh-957: githubHelpers + pushReworkChanges now require the no-op loop guard.
var reworkLoopGuardModule = loadModule('js/common/reworkLoopGuard.js', makeRequire({
                './machineAuthor.js': machineAuthorReal(),
                './reviewVerdicts.js': reviewVerdictsReal()
            }));
// Real PR helper (gh-912): the modules under test delegate cleanCommandOutput
// and the remote-existence probes to it — the canonical implementation must be
// in every require map below.
var PR_HELPER_REAL = loadModule('js/common/pullRequest.js',
    makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }));
var githubHelpersModule = loadModule(
    'js/common/githubHelpers.js',
    makeRequire({
        './pullRequest.js': PR_HELPER_REAL,
        './gitOps.js': {
            checkoutPRBranch: function() {},
            getPRDiff: function() {},
            detectMergeConflicts: function() {},
            trimLargeTextForInput: function() {},
            writePRContext: function() {}
        },
        './machineNotice.js': loadModule('js/common/machineNotice.js'),
        './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js', makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') })),
        './common/reworkLoopGuard.js': reworkLoopGuardModule,
        './ci.js': loadModule('js/common/ci.js'),
        './ciViolations.js': loadModule('js/common/ciViolations.js'),
        './githubReviewFetch.js': githubReviewFetchReal(),
    }),
    {}
);


/**
 * Load the real js/common/trackers.js with tool mocks, pinning the provider via
 * customParams so tests stay deterministic even when the runner process has
 * DEFAULT_TRACKER set (env probing would otherwise outrank a silent config).
 */
function makeTrackersModule(toolMocks) {
    var realTrackers = loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        toolMocks || {}
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
}

function loadPushReworkChanges() {
    return loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './common/toolchainSummary.js': { withToolchainLine: stubToolchainLine },
            './config.js': configModule,
            './common/gitStaging.js': gitStagingModule,
            './forkCheckout.js': forkCheckoutModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/submodules.js': {},
            './common/pullRequest.js': PR_HELPER_REAL,
            './common/githubHelpers.js': githubHelpersModule,
            './common/feedbackLoop.js': {},
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/trackers.js': makeTrackersModule({}),
            './common/outputFiles.js': {
                readOutputFile: function(path) {
                    return readOutputFileFrom(mocks, path);
                }
            },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './cacheToReleases.js': {}
        ,
            './common/ticketKeyShapes.js': ticketKeyShapesModule,
            './common/commentMarkup.js': commentMarkupModule,
            './common/reworkLoopGuard.js': reworkLoopGuardModule,
            './common/ciViolations.js': loadModule('js/common/ciViolations.js')
        }),
        {}
    );
}

// ── gh-1200 CRAP refactor: named mock-builder units ─────────────────────────
// The branchy mock closures below used to fold their decisions into
// loadPushReworkChangesForAction's CRAP. Extracted as small named helpers
// with identical behavior (same captures, same call order, same canned
// responses); the characterization suite at the bottom pins every branch.

/** Push-capture: mocks[key] = (mocks[key] || []).concat([value]). */
function appendCapture(mocks, key, value) {
    mocks[key] = (mocks[key] || []).concat([value]);
}

/** Counter-capture: mocks[key] = (mocks[key] || 0) + 1. */
function countCapture(mocks, key) {
    mocks[key] = (mocks[key] || 0) + 1;
}

/** outputFiles.readOutputFile parity: fileMap hit or null. */
function readOutputFileFrom(mocks, path) {
    if (mocks.outputFiles && mocks.outputFiles[path] !== undefined) {
        return mocks.outputFiles[path];
    }
    return null;
}

/** Static pr_info.md fixture read (throws for every other path, like the live tool). */
function reworkPrInfoFileRead(args) {
    if (args.path === 'input/TS-1293/pr_info.md') {
        return '**Branch**: `ai/TS-1293` → `main`';
    }
    throw new Error('missing ' + args.path);
}

/** Canned git session for the TS-1293 fixture; records every command. */
function reworkCliExecute(mocks, args) {
    mocks.commands = mocks.commands || [];
    mocks.commands.push(args.command);
    if (args.command === 'git branch --show-current') return 'ai/TS-1293';
    if (args.command === 'git push -u origin ai/TS-1293' && mocks.failFirstPush) {
        mocks.failFirstPush = false;
        throw new Error('rejected non-fast-forward');
    }
    if (args.command.indexOf('git ls-remote --heads origin ai/TS-1293') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/ai/TS-1293';
    return '';
}

/** resumeAgent stub: records the stage, honors onResume/resumeResult overrides. */
function reworkResumeAgent(mocks, options) {
    appendCapture(mocks, 'resumeCalls', options.stage);
    if (typeof mocks.onResume === 'function') mocks.onResume(options);
    return mocks.resumeResult || { attempted: false };
}

/** SCM provider stub wired to the capture bag (IstiN/trackstate fixture). */
function reworkScmStub(mocks) {
    return {
        getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'trackstate' }; },
        listPrs: function() { return [{ number: 1571, title: 'TS-1293 Fix', html_url: 'https://github.com/IstiN/trackstate/pull/1571', head: { ref: 'ai/TS-1293' } }]; },
        addComment: function(prId, text) {
            countCapture(mocks, 'prComments');
            appendCapture(mocks, 'prCommentTexts', text);
        },
        replyToThread: function(prId, thread, text) {
            countCapture(mocks, 'threadReplies');
            appendCapture(mocks, 'replyTexts', text);
        },
        resolveThread: function() { countCapture(mocks, 'resolvedThreads'); }
    };
}

function loadPushReworkChangesForAction(mocks) {
    mocks = mocks || {};
    var toolMocks = {
        file_read: reworkPrInfoFileRead,
        cli_execute_command: function(args) {
            return reworkCliExecute(mocks, args);
        },
        jira_post_comment: function(args) { appendCapture(mocks, 'jiraComments', args.comment); },
        jira_move_to_status: function(args) { appendCapture(mocks, 'moves', args.statusName); },
        jira_remove_label: function(args) { appendCapture(mocks, 'removedLabels', args.label); },
        jira_assign_ticket_to: function() {}
    };
    return loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './common/toolchainSummary.js': { withToolchainLine: stubToolchainLine },
            './config.js': configModule,
            './common/gitStaging.js': gitStagingModule,
            './forkCheckout.js': forkCheckoutModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': {
                createScm: function() {
                    return reworkScmStub(mocks);
                }
            },
            './common/submodules.js': { pushManagedSubmodules: function() {} },
            './common/pullRequest.js': Object.assign({}, PR_HELPER_REAL, {
                readStagedDiffStat: function() { return 'lib/app.dart | 1 +'; },
                syncBranchWithBase: function() { return { success: true }; }
            }),
            './common/githubHelpers.js': githubHelpersModule,
            './common/feedbackLoop.js': {
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function(options) {
                    return reworkResumeAgent(mocks, options);
                }
            },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function() { mocks.autoStartReview = true; return true; },
                triggerSmIfIdle: function() { mocks.triggerSm = true; return true; }
            },
            './common/outputFiles.js': {
                readOutputFile: function(path) {
                    return readOutputFileFrom(mocks, path);
                }
            },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': makeTrackersModule(toolMocks),
            './cacheToReleases.js': { action: function() {} }
        ,
            './common/ticketKeyShapes.js': ticketKeyShapesModule,
            './common/commentMarkup.js': commentMarkupModule,
            './common/reworkLoopGuard.js': reworkLoopGuardModule,
            './common/ciViolations.js': loadModule('js/common/ciViolations.js')
        }),
        toolMocks
    );
}

function loadPostTestReworkResults() {
    return loadModule(
        'js/postTestReworkResults.js',
        makeRequire({
            './config.js': configModule,
            './common/gitStaging.js': gitStagingModule,
            './forkCheckout.js': forkCheckoutModule,
            './configLoader.js': configLoaderModule,
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/feedbackLoop.js': {},
            './common/pullRequest.js': PR_HELPER_REAL,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        ,
            './common/ticketKeyShapes.js': ticketKeyShapesModule,
            './common/commentMarkup.js': commentMarkupModule,
            './common/trackers.js': makeTrackersModule({}),
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }),
        {}
    );
}

// ── gh-1200 characterization: the extracted rework mock builders ────────────

suite('rework custom params — extracted mock builders (characterization, gh-1200)', function() {

    test('reworkPrInfoFileRead: serves the TS-1293 pr_info fixture, throws otherwise', function() {
        assert.equal(reworkPrInfoFileRead({ path: 'input/TS-1293/pr_info.md' }),
            '**Branch**: `ai/TS-1293` → `main`');
        var caught = null;
        try { reworkPrInfoFileRead({ path: 'input/TS-1293/other.md' }); } catch (e) { caught = e; }
        assert.ok(caught, 'non-pr_info paths throw');
        assert.contains(String(caught && caught.message), 'missing input/TS-1293/other.md');
    });

    test('reworkCliExecute: canned branch/push/ls-remote responses, failFirstPush flips once', function() {
        var mocks = {};
        assert.equal(reworkCliExecute(mocks, { command: 'git branch --show-current' }), 'ai/TS-1293');
        assert.equal(reworkCliExecute(mocks, { command: 'git ls-remote --heads origin ai/TS-1293' }),
            '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/ai/TS-1293');
        assert.equal(reworkCliExecute(mocks, { command: 'git status' }), '', 'unknown command → empty');

        var failing = { failFirstPush: true };
        var thrown = null;
        try { reworkCliExecute(failing, { command: 'git push -u origin ai/TS-1293' }); } catch (e) { thrown = e; }
        assert.ok(thrown, 'the first push is rejected when failFirstPush is set');
        assert.contains(String(thrown && thrown.message), 'rejected non-fast-forward');
        assert.equal(failing.failFirstPush, false, 'the flag resets after one rejection');
        assert.equal(reworkCliExecute(failing, { command: 'git push -u origin ai/TS-1293' }), '',
            'the retried push succeeds');
        assert.deepEqual(mocks.commands, ['git branch --show-current',
            'git ls-remote --heads origin ai/TS-1293', 'git status'], 'every command recorded');
        assert.deepEqual(failing.commands, ['git push -u origin ai/TS-1293', 'git push -u origin ai/TS-1293']);
    });

    test('appendCapture/countCapture: lazily create the capture bag', function() {
        var m = {};
        appendCapture(m, 'moves', 'In Review');
        appendCapture(m, 'moves', 'Done');
        assert.deepEqual(m.moves, ['In Review', 'Done']);
        countCapture(m, 'prComments');
        countCapture(m, 'prComments');
        countCapture(m, 'prComments');
        assert.equal(m.prComments, 3);
    });

    test('readOutputFileFrom: fileMap hit or null, without requiring an outputFiles bag', function() {
        assert.equal(readOutputFileFrom({ outputFiles: { 'review_replies.json': '{}' } }, 'review_replies.json'), '{}');
        assert.equal(readOutputFileFrom({ outputFiles: {} }, 'review_replies.json'), null, 'empty bag → null');
        assert.equal(readOutputFileFrom({}, 'anything'), null, 'no bag at all → null');
    });

    test('reworkResumeAgent: records the stage, honors onResume and resumeResult', function() {
        var seen = null;
        var m = { onResume: function(o) { seen = o; }, resumeResult: { attempted: true } };
        assert.deepEqual(reworkResumeAgent(m, { stage: 'rework_missing_outputs' }), { attempted: true });
        assert.deepEqual(m.resumeCalls, ['rework_missing_outputs']);
        assert.deepEqual(seen, { stage: 'rework_missing_outputs' });

        var plain = {};
        assert.deepEqual(reworkResumeAgent(plain, { stage: 'x' }), { attempted: false },
            'default resume result without overrides');
        assert.deepEqual(plain.resumeCalls, ['x']);
    });

    test('reworkScmStub: counters and text captures per provider call', function() {
        var m = {};
        var scm = reworkScmStub(m);
        assert.deepEqual(scm.getRemoteRepoInfo(), { owner: 'IstiN', repo: 'trackstate' });
        assert.equal(scm.listPrs().length, 1);
        assert.equal(scm.listPrs()[0].number, 1571);
        scm.addComment(1571, 'first');
        scm.addComment(1571, 'second');
        scm.replyToThread(1571, 'PRRT_1', 'reply text');
        scm.resolveThread(1571, 'PRRT_1');
        assert.equal(m.prComments, 2);
        assert.deepEqual(m.prCommentTexts, ['first', 'second']);
        assert.equal(m.threadReplies, 1);
        assert.deepEqual(m.replyTexts, ['reply text']);
        assert.equal(m.resolvedThreads, 1);
    });
});

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
