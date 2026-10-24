/**
 * Unit tests for js/postPRReviewComments.js.
 */
var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var machineAuthorModule = loadModule('js/common/machineAuthor.js', makeRequire({}), {});


var githubHelpersStub = {
    findPRForTicket: function() { return null; },
    findMergedPRForTicket: function() { return null; }
};

// ── gh-1230 CRAP: post-PR-review fixture factories (characterized at EOF) ────

// file_read mock serving the pr_info.md payload (opts override or a default).
function prInfoFileRead(opts, defaultPrInfo) {
    function file_read(args) {
        var p = args && (args.path || args);
        if (p && p.indexOf('pr_info.md') !== -1) {
            return opts.prInfoContent || defaultPrInfo;
        }
        return null;
    }
    return file_read;
}

// scm stub for the !isApproved + no-PR guard suite (#311): repoInfo defaults
// to null (no remote), listPrs serves opts.openPrs.
function actionScmStub(opts, scmAddLabelCalls) {
    return {
        listPrs: function() { return opts.openPrs || []; },
        getRemoteRepoInfo: function() { return opts.repoInfo !== undefined ? opts.repoInfo : null; },
        addLabel: function(number, label) { scmAddLabelCalls.push({ number: number, label: label }); },
        fetchDiscussions: function() { return { rawThreads: { threads: [] } }; }
    };
}

// outputFiles stub for the #311 suite: pr_review.json detail + null reads.
function actionOutputFilesStub(opts) {
    function readOutputFileDetailed() {
        return { content: JSON.stringify(opts.reviewData), path: 'outputs/pr_review.json' };
    }
    function readOutputFile() { return null; }
    return { readOutputFileDetailed: readOutputFileDetailed, readOutputFile: readOutputFile };
}

// jira recorder mocks for the #311 suite.
function actionJiraMocks(jiraAddLabelCalls, jiraMoveToStatusCalls, jiraPostCommentCalls, opts) {
    return {
        file_read: prInfoFileRead(opts, null),
        jira_add_label: function(args) { jiraAddLabelCalls.push(args); },
        jira_move_to_status: function(args) { jiraMoveToStatusCalls.push(args); },
        jira_post_comment: function(args) { jiraPostCommentCalls.push(args); },
        jira_remove_label: function() {},
        jira_assign_ticket_to: function() {}
    };
}

// autoStart stub for the #311 suite: workflow trigger off, SM trigger recorded.
function actionAutoStartStub(triggerSmIfIdleCalls) {
    return {
        triggerConfiguredWorkflowForTicket: function() { return false; },
        triggerSmIfIdle: function(args) { triggerSmIfIdleCalls.push(args); }
    };
}

// configLoader stub shared by both post-PR-review loaders.
function configLoaderStub(opts) {
    return {
        loadProjectConfig: function() { return opts.config || {}; },
        resolveInstructions: function() { return { jobParamPatch: {} }; }
    };
}

// scm stub for the formal-review suite: submit/list/dismiss review recorders,
// a populated default repoInfo (overridable with an explicit null).
function formalScmStub(opts, sinks) {
    return {
        listPrs: function() { return opts.openPrs || []; },
        getRemoteRepoInfo: function() { return opts.repoInfo !== undefined ? opts.repoInfo : { owner: 'IstiN', repo: 'dmtools-agents' }; },
        addLabel: function(prId, label) { sinks.addLabelCalls.push({ prId: prId, label: label }); },
        removeLabel: function() {},
        fetchDiscussions: function() { return { rawThreads: { threads: [] } }; },
        submitReview: function(prId, event, body) {
            sinks.submitReviewCalls.push({ prId: prId, event: event, body: body });
        },
        listReviews: function() { return opts.existingReviews || []; },
        dismissReview: function(prId, reviewId, message) {
            sinks.dismissReviewCalls.push({ prId: prId, reviewId: reviewId, message: message });
        }
    };
}

// outputFiles stub for the formal-review suite: serves pr_review_general.md
// only when opts.generalMdContent is set.
function formalOutputFilesStub(opts) {
    function readOutputFileDetailed() {
        return { content: JSON.stringify(opts.reviewData), path: 'outputs/pr_review.json' };
    }
    function readOutputFile(p) {
        if (opts.generalMdContent && p && String(p).indexOf('pr_review_general.md') !== -1) {
            return opts.generalMdContent;
        }
        return null;
    }
    return { readOutputFileDetailed: readOutputFileDetailed, readOutputFile: readOutputFile };
}

// jira + github mocks for the formal-review suite (default pr_info payload,
// github_get_pr serving the machine-PR rework re-arm body probe).
function formalJiraMocks(opts) {
    return {
        file_read: prInfoFileRead(opts, '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n'),
        jira_add_label: function() {},
        jira_move_to_status: function() {},
        jira_post_comment: function() {},
        jira_remove_label: function() {},
        jira_assign_ticket_to: function() {},
        github_get_pr: function() {
            // The machine-PR rework re-arm reads the PR body for a
            // 'closes #N' linked issue (gh-728 test rides this).
            return JSON.stringify({ body: opts.githubPrBody || '' });
        }
    };
}

/**
 * Load the real js/common/trackers.js with tool mocks, pinning the provider via
 * customParams so tests stay deterministic even when the runner process has
 * DEFAULT_TRACKER set (env probing would otherwise outrank a silent config).
 * A customParams.trackerProvider in the tested params still wins, so provider
 * dispatch itself remains testable.
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

/**
 * Shared outputFiles loader for postPRReviewComments harnesses — the real
 * js/common/outputFiles.js wired against the given file_read mock.
 */
function prReviewOutputFiles(fileReadMock) {
    return loadModule('js/common/outputFiles.js', makeRequire({
        './common/commentMarkup.js': commentMarkupModule
    }), {
        file_read: fileReadMock
    });
}

/**
 * Shared require map for loading js/postPRReviewComments.js in tests — the
 * real module wiring with every common/* collaborator resolved, including
 * the gh-1053 reviewSpecClaims mapping (previously duplicated inline in
 * ~8 loaders, which pushed loadWithFileMap's CRAP over the ratchet).
 * Callers pass overrides for the collaborators a suite needs to double
 * (scm, configLoader, outputFiles, githubHelpers, trackers, autoStart, ...).
 */
function prReviewRequireMap(overrides) {
    var map = {
        './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
        './common/machineAuthor.js': machineAuthorModule,
        './config.js': configModule,
        './common/scm.js': { createScm: function() { return {}; } },
        './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
        './configLoader.js': configLoaderModule,
        './common/githubHelpers.js': githubHelpersStub,
        './common/trackers.js': makeTrackersModule({}),
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/commentMarkup.js': commentMarkupModule,
        './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
        './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {})
    };
    return Object.assign(map, overrides || {});
}

function loadPostPRReviewComments(mocks) {
    var fileRead = (mocks && mocks.file_read) || function() { return null; };
    return loadModule(
        'js/postPRReviewComments.js',
        makeRequire(prReviewRequireMap({
            './common/outputFiles.js': prReviewOutputFiles(fileRead)
        })),
        {
            file_read: fileRead
        }
    );
}

suite('postPRReviewComments', function() {
    test('merges pr_review jobParamPatches into runtime customParams', function() {
        var mod = loadPostPRReviewComments();

        var customParams = mod.resolveCustomParams(
            {
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_story_review_triggered',
                        targetRepository: { owner: 'IstiN', repo: 'trackstate' }
                    }
                }
            },
            {
                jobParamPatches: {
                    pr_review: {
                        customParams: {
                            autoStartRework: true,
                            autoStartReworkConfigFile: 'agents/pr_rework.json',
                            removeLabel: 'from_patch'
                        }
                    }
                }
            }
        );

        assert.equal(customParams.autoStartRework, true);
        assert.equal(customParams.autoStartReworkConfigFile, 'agents/pr_rework.json');
        assert.equal(customParams.removeLabel, 'sm_story_review_triggered');
        assert.deepEqual(customParams.targetRepository, { owner: 'IstiN', repo: 'trackstate' });
    });

    test('detects line present in added side of PR diff', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/lib/example.dart b/lib/example.dart\n' +
            'index 1111111..2222222 100644\n' +
            '--- a/lib/example.dart\n' +
            '+++ b/lib/example.dart\n' +
            '@@ -10,2 +10,3 @@ class Example {\n' +
            ' context line\n' +
            '+new line\n' +
            ' another context\n';

        assert.equal(mod.isLinePresentInDiff(diff, 'lib/example.dart', 11), true);
        assert.equal(mod.isLinePresentInDiff(diff, 'lib/example.dart', 99), false);
    });

    test('deleted file lines are available on the LEFT side', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/.codegraph/.gitignore b/.codegraph/.gitignore\n' +
            'deleted file mode 100644\n' +
            'index 1111111..0000000\n' +
            '--- a/.codegraph/.gitignore\n' +
            '+++ /dev/null\n' +
            '@@ -1,2 +0,0 @@\n' +
            '-index\n' +
            '-cache\n';

        assert.equal(mod.isLinePresentInDiff(diff, '.codegraph/.gitignore', 1), true);
        assert.equal(mod.isLinePresentInDiff(diff, '.codegraph/.gitignore', 1, 'LEFT'), true);
        assert.equal(mod.isLinePresentInDiff(diff, '.codegraph/.gitignore', 1, 'RIGHT'), false);
    });

    test('countReviewThreads counts rawThreads from scm.fetchDiscussions', function() {
        var mod = loadPostPRReviewComments();
        var scm = {
            fetchDiscussions: function() {
                return { rawThreads: { threads: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
            }
        };
        assert.equal(mod.countReviewThreads(scm, 42), 3);
    });

    test('countReviewThreads returns 0 when fetchDiscussions throws', function() {
        var mod = loadPostPRReviewComments();
        var scm = {
            fetchDiscussions: function() {
                throw new Error('graphql failure');
            }
        };
        assert.equal(mod.countReviewThreads(scm, 42), 0);
    });

    test('countReviewThreads returns 0 when rawThreads are missing', function() {
        var mod = loadPostPRReviewComments();
        var scm = { fetchDiscussions: function() { return {}; } };
        assert.equal(mod.countReviewThreads(scm, 42), 0);
    });

    test('detects submodule pointer changes in PR diff', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/trackstate-setup b/trackstate-setup\n' +
            'index bab3e4453..20a4bc2a1 160000\n' +
            '--- a/trackstate-setup\n' +
            '+++ b/trackstate-setup\n' +
            '@@ -1 +1 @@\n' +
            '-Subproject commit bab3e445305c78295b72f1fa4fe5e85f12055546\n' +
            '+Subproject commit 20a4bc2a11e528d173e9fbe046b1ee31514e9259\n';

        assert.equal(mod.isSubmodulePathInDiff(diff, 'trackstate-setup'), true);
        assert.equal(mod.isSubmodulePathInDiff(diff, 'lib/example.dart'), false);
    });

    test('maps comments on submodule content to the submodule diff line as inline threads', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/trackstate-setup b/trackstate-setup\n' +
            'index bab3e4453..20a4bc2a1 160000\n' +
            '--- a/trackstate-setup\n' +
            '+++ b/trackstate-setup\n' +
            '@@ -1 +1 @@\n' +
            '-Subproject commit bab3e445305c78295b72f1fa4fe5e85f12055546\n' +
            '+Subproject commit 20a4bc2a11e528d173e9fbe046b1ee31514e9259\n';
        var calls = [];
        var scm = {
            getPrDiff: function() { return diff; },
            addInlineComment: function(prId, path, line, text, startLine, side) {
                calls.push({ prId: prId, path: path, line: line, text: text, startLine: startLine, side: side });
            }
        };

        mod.postInlineComment(scm, 1930, { path: 'trackstate-setup', line: 7, body: 'description issue' }, 'TS-1383', null);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, 'trackstate-setup');
        assert.equal(calls[0].line, 1);
        assert.equal(calls[0].side, 'RIGHT');
        assert.equal(calls[0].startLine, null);
        assert.ok(calls[0].text.indexOf('trackstate-setup:7') !== -1);
        assert.ok(calls[0].text.indexOf('description issue') !== -1);
    });

    test('maps comments on files inside a submodule to the submodule diff line', function() {
        var mod = loadPostPRReviewComments();
        var diff =
            'diff --git a/trackstate-setup b/trackstate-setup\n' +
            'index bab3e4453..20a4bc2a1 160000\n' +
            '--- a/trackstate-setup\n' +
            '+++ b/trackstate-setup\n' +
            '@@ -1 +1 @@\n' +
            '-Subproject commit bab3e445305c78295b72f1fa4fe5e85f12055546\n' +
            '+Subproject commit 20a4bc2a11e528d173e9fbe046b1ee31514e9259\n';
        var calls = [];
        var scm = {
            getPrDiff: function() { return diff; },
            addInlineComment: function(prId, path, line, text, startLine, side) {
                calls.push({ prId: prId, path: path, line: line, text: text, startLine: startLine, side: side });
            }
        };

        mod.postInlineComment(scm, 1930, { path: 'trackstate-setup/README.md', line: 12, body: 'readme issue' }, 'TS-1383', null);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, 'trackstate-setup');
        assert.equal(calls[0].line, 1);
        assert.ok(calls[0].text.indexOf('trackstate-setup/README.md:12') !== -1);
    });

    // ── Regression guard: body held a comment-file path instead of text ──
    // The agent is instructed to reference comment text via `comment` (a path
    // to outputs/pr_review_comments/*.md), never inline in `body`. A prompt/
    // schema mismatch once caused the model to duplicate that path into
    // `body`, and since `body` takes priority, the raw path got posted as the
    // GitHub comment (observed in production). resolveCommentFileReference +
    // postInlineComment must detect and correct this instead of publishing
    // the literal path.
    suite('resolveCommentFileReference — comment-file-path-in-body regression guard', function() {
        test('resolves a bare comment-file path into its real file content', function() {
            var mod = loadPostPRReviewComments({
                file_read: function(opts) {
                    var p = opts && (opts.path || opts);
                    if (p === 'outputs/pr_review_comments/comment1_analytics_confirm.md') {
                        return 'Analytics event should fire on confirm, not on image select.';
                    }
                    return null;
                }
            });

            var resolved = mod.resolveCommentFileReference(
                'outputs/pr_review_comments/comment1_analytics_confirm.md', 'TS-1139', null
            );

            assert.equal(resolved, 'Analytics event should fire on confirm, not on image select.');
        });

        test('does not treat ordinary inline comment text as a file reference', function() {
            var mod = loadPostPRReviewComments();

            assert.equal(mod.resolveCommentFileReference('This is a real inline comment.', 'TS-1139', null), null);
            assert.equal(mod.resolveCommentFileReference('outputs/pr_review_comments/ mentioned mid-sentence', 'TS-1139', null), null);
            assert.equal(mod.resolveCommentFileReference(null, 'TS-1139', null), null);
        });

        test('postInlineComment posts the real file content, not the raw path, when body holds a comment-file reference', function() {
            var mod = loadPostPRReviewComments({
                file_read: function(opts) {
                    var p = opts && (opts.path || opts);
                    if (p === 'outputs/pr_review_comments/comment1_analytics_confirm.md') {
                        return 'Analytics event should fire on confirm, not on image select.';
                    }
                    return null;
                }
            });
            var diff =
                'diff --git a/src/AiAutofillModal.tsx b/src/AiAutofillModal.tsx\n' +
                'index 1111111..2222222 100644\n' +
                '--- a/src/AiAutofillModal.tsx\n' +
                '+++ b/src/AiAutofillModal.tsx\n' +
                '@@ -166,3 +166,4 @@ function AiAutofillModal() {\n' +
                ' context line\n' +
                '+  onAddImage();\n' +
                ' another context\n' +
                ' more context\n';
            var calls = [];
            var scm = {
                getPrDiff: function() { return diff; },
                addInlineComment: function(prId, path, line, text, startLine, side) {
                    calls.push({ prId: prId, path: path, line: line, text: text, startLine: startLine, side: side });
                }
            };

            mod.postInlineComment(scm, 1139, {
                path: 'src/AiAutofillModal.tsx',
                line: 169,
                comment: 'outputs/pr_review_comments/comment1_analytics_confirm.md',
                body: 'outputs/pr_review_comments/comment1_analytics_confirm.md'
            }, 'TS-1139', null);

            assert.equal(calls.length, 1);
            assert.equal(calls[0].text, 'Analytics event should fire on confirm, not on image select.');
            assert.notEqual(calls[0].text, 'outputs/pr_review_comments/comment1_analytics_confirm.md');
        });
    });

    // ── action(): !isApproved + no-PR guard (issue #311) ──────────────────────
    // postPRReviewComments must not move the Jira ticket to In Rework, nor
    // auto-trigger a pr_rework cycle (markForSmStoryRework/triggerSmIfIdle), when
    // the review recommendation isn't a clean approval but no open PR could ever
    // be matched to the ticket. Only the GitHub-comment-posting step (Step 4) was
    // previously guarded with `if (prNumber && repoInfo)`; the Jira status
    // transition (Step 7) and the SM/rework auto-trigger (Step 12) were not.
    suite('action — !isApproved + no-PR guard (#311)', function() {

        function loadPostPRReviewCommentsForAction(opts) {
            opts = opts || {};
            var jiraAddLabelCalls = [];
            var jiraMoveToStatusCalls = [];
            var jiraPostCommentCalls = [];
            var triggerSmIfIdleCalls = [];
            var scmAddLabelCalls = [];

            var scm = actionScmStub(opts, scmAddLabelCalls);

            var outputFiles = actionOutputFilesStub(opts);

            var defaultMocks = actionJiraMocks(jiraAddLabelCalls, jiraMoveToStatusCalls, jiraPostCommentCalls, opts);

            var mergedMocks = Object.assign({}, defaultMocks, opts.mocks || {});

            var mod = loadModule(
                'js/postPRReviewComments.js',
                makeRequire({
            './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
            './common/machineAuthor.js': machineAuthorModule,
                    './config.js': configModule,
                    './common/scm.js': { createScm: function() { return scm; } },
                    './common/autoStart.js': actionAutoStartStub(triggerSmIfIdleCalls),
                    './configLoader.js': configLoaderStub(opts),
                    './common/outputFiles.js': outputFiles,
                    './common/githubHelpers.js': githubHelpersStub,
                    './common/trackers.js': makeTrackersModule(mergedMocks),
                    './common/tokenUsageComment.js': opts.tokenUsage || { postTokenUsageComments: function() {} },
                    './common/commentMarkup.js': commentMarkupModule,
                    './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
                    './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {})
                }),
                mergedMocks
            );

            return {
                mod: mod,
                jiraAddLabelCalls: jiraAddLabelCalls,
                jiraMoveToStatusCalls: jiraMoveToStatusCalls,
                jiraPostCommentCalls: jiraPostCommentCalls,
                triggerSmIfIdleCalls: triggerSmIfIdleCalls,
                scmAddLabelCalls: scmAddLabelCalls
            };
        }

        test('no PR found: does NOT move to In Rework, does NOT mark/trigger SM rework, posts "could not attach" comment instead', function() {
            var loaded = loadPostPRReviewCommentsForAction({
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                },
                repoInfo: null,
                openPrs: []
            });

            var result = loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1'
            });

            assert.equal(result.success, true);
            assert.equal(result.githubCommentsPosted, false);

            assert.equal(
                loaded.jiraMoveToStatusCalls.length, 0,
                'must NOT move the ticket to In Rework when no PR was found'
            );
            assert.equal(
                loaded.jiraAddLabelCalls.filter(function(c) { return c.label === 'sm_story_rework_triggered'; }).length, 0,
                'must NOT mark for SM story rework when no PR was found'
            );
            assert.equal(
                loaded.jiraAddLabelCalls.filter(function(c) { return c.label === 'agent:rework'; }).length, 0,
                'must NOT arm agent:rework when no PR was found'
            );
            assert.equal(
                loaded.triggerSmIfIdleCalls.length, 0,
                'must NOT trigger SM when no PR was found (nothing to rework)'
            );

            assert.ok(
                loaded.jiraPostCommentCalls.some(function(c) {
                    return c.comment.indexOf('PR Review Could Not Be Attached') !== -1;
                }),
                'should post the new "could not attach" comment explaining the ticket was left unchanged'
            );
        });

        test('regression: !isApproved WITH a PR found still moves to In Rework and triggers SM rework as before', function() {
            var loaded = loadPostPRReviewCommentsForAction({
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                },
                repoInfo: { owner: 'IstiN', repo: 'dmtools-agents' },
                prInfoContent: '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n'
            });

            var result = loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1'
            });

            assert.equal(result.success, true);
            assert.equal(result.githubCommentsPosted, true);

            assert.ok(
                loaded.jiraMoveToStatusCalls.some(function(c) { return c.statusName === 'In Rework'; }),
                'should still move the ticket to In Rework when a PR was found'
            );
            assert.equal(
                loaded.jiraAddLabelCalls.filter(function(c) { return c.label === 'sm_story_rework_triggered'; }).length, 1,
                'should still mark for SM story rework when a PR was found'
            );
            // Live pathology (fa gh-746 — 24 review rounds, zero reworks):
            // no SM rule reads sm_story_rework_triggered; the rework rule
            // matches agent:rework. The SM marker alone was a dead contract.
            assert.equal(
                loaded.jiraAddLabelCalls.filter(function(c) { return c.label === 'agent:rework'; }).length, 1,
                'should arm agent:rework so the SM rework rule can dispatch (gh-746)'
            );
            // And the linked PR gets ai_pr_reviewed — review-after-dev reads
            // notPrLabels on the PR, so an issue-only marker re-dispatched a
            // review every tick on the same head.
            assert.ok(
                loaded.scmAddLabelCalls.some(function(c) { return c.number === 42 && c.label === 'ai_pr_reviewed'; }),
                'should label the linked PR ai_pr_reviewed: ' + JSON.stringify(loaded.scmAddLabelCalls)
            );
            assert.equal(
                loaded.triggerSmIfIdleCalls.length, 1,
                'should still trigger SM when a PR was found'
            );
            assert.equal(
                loaded.jiraPostCommentCalls.some(function(c) {
                    return c.comment.indexOf('PR Review Could Not Be Attached') !== -1;
                }),
                false,
                'must not post the "could not attach" comment when a PR was found'
            );
        });

        test('agents#889: token usage is posted through the tracker resolved for the run, not a Jira fallback', function() {
            var usageCalls = [];
            var loaded = loadPostPRReviewCommentsForAction({
                reviewData: { recommendation: 'APPROVE', issueCounts: { blocking: 0, important: 0, suggestions: 0 }, inlineComments: [] },
                repoInfo: null,
                openPrs: [],
                tokenUsage: { postTokenUsageComments: function(key, o) { usageCalls.push({ key: key, o: o }); } }
            });
            loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1'
            });
            assert.equal(usageCalls.length, 1);
            assert.ok(usageCalls[0].o.tracker && typeof usageCalls[0].o.tracker.postComment === 'function',
                'the run tracker must be handed over');
        });

        test('agents#890: a rejected In Rework transition is marked with a label when stageFallback is label', function() {
            var labels = [];
            var loaded = loadPostPRReviewCommentsForAction({
                reviewData: { recommendation: 'REQUEST_CHANGES', issueCounts: { blocking: 1, important: 0, suggestions: 0 }, inlineComments: [] },
                repoInfo: { owner: 'IstiN', repo: 'dmtools-agents' },
                prInfoContent: '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n',
                mocks: {
                    jira_move_to_status: function() { throw new Error("The field 'State' contains the value 'In Rework' that is not in the list of supported values"); },
                    jira_add_label: function(a) { labels.push(a.label); }
                }
            });
            var result = loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1',
                customParams: { stageFallback: 'label' }
            });
            assert.equal(result.success, true);
            assert.ok(labels.some(function(l) { return /in_rework/i.test(l); }), 'stage label added: ' + JSON.stringify(labels));
        });

        test('github provider: ticket operations dispatch to github_* tools, jira_* stay untouched (#414)', function() {
            var ghCommentCalls = [];
            var ghAddLabelCalls = [];
            var ghRemoveLabelCalls = [];
            var jiraCalls = [];

            var loaded = loadPostPRReviewCommentsForAction({
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                },
                repoInfo: null,
                openPrs: [],
                mocks: {
                    github_create_comment: function(args) { ghCommentCalls.push(args); return '{}'; },
                    github_add_labels: function(args) { ghAddLabelCalls.push(args); return '{}'; },
                    github_remove_label: function(args) { ghRemoveLabelCalls.push(args); return '{}'; },
                    jira_post_comment: function(args) { jiraCalls.push(args); },
                    jira_add_label: function(args) { jiraCalls.push(args); },
                    jira_move_to_status: function(args) { jiraCalls.push(args); },
                    jira_remove_label: function(args) { jiraCalls.push(args); },
                    jira_assign_ticket_to: function(args) { jiraCalls.push(args); }
                }
            });

            var result = loaded.mod.action({
                ticket: { key: 'IstiN/fah-git-test#7', fields: { labels: [] } },
                response: 'Review content',
                inputFolderPath: 'input/IstiN/fah-git-test#7',
                customParams: { trackerProvider: 'github' }
            });

            assert.equal(result.success, true);
            assert.equal(jiraCalls.length, 0, 'no jira_* tool must be called on a github deployment: ' + JSON.stringify(jiraCalls));

            assert.ok(
                ghCommentCalls.some(function(c) {
                    return c.pullRequestId === 7 && c.text.indexOf('Automated PR Review Completed') !== -1;
                }),
                'review summary should be posted via github_create_comment: ' + JSON.stringify(ghCommentCalls)
            );
            assert.ok(
                ghCommentCalls.some(function(c) {
                    return c.pullRequestId === 7 && c.text.indexOf('PR Review Could Not Be Attached') !== -1;
                }),
                'the could-not-attach comment should be posted via github_create_comment'
            );
            assert.ok(
                ghAddLabelCalls.some(function(c) {
                    return c.number === 7 && c.labels && c.labels.indexOf('ai_pr_reviewed') !== -1;
                }),
                'ai_pr_reviewed should be added via github_add_labels: ' + JSON.stringify(ghAddLabelCalls)
            );
            assert.ok(
                ghRemoveLabelCalls.some(function(c) { return c.number === 7 && c.label === 'pr_review_wip'; }),
                'the WIP label should be removed via github_remove_label: ' + JSON.stringify(ghRemoveLabelCalls)
            );
        });
    });

    // ── action(): opt-in formal GitHub PR review (Approve/Request Changes) ────
    // customParams.formalGithubReview enables a native GitHub review decision via
    // scm.submitReview/listReviews/dismissReview, entirely additive to — and never
    // touching — the pr_approved label lifecycle (addLabel/removeLabel).
    suite('action — formal GitHub PR review (opt-in)', function() {

        function loadPostPRReviewCommentsForFormalReview(opts) {
            opts = opts || {};
            var addLabelCalls = [];
            var submitReviewCalls = [];
            var dismissReviewCalls = [];

            var sinks = { addLabelCalls: addLabelCalls, submitReviewCalls: submitReviewCalls, dismissReviewCalls: dismissReviewCalls };
            var scm = formalScmStub(opts, sinks);

            var outputFiles = formalOutputFilesStub(opts);

            var formalMocks = formalJiraMocks(opts);

            var mod = loadModule(
                'js/postPRReviewComments.js',
                makeRequire({
            './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
            './common/machineAuthor.js': machineAuthorModule,
                    './config.js': configModule,
                    './common/scm.js': { createScm: function() { return scm; } },
                    './common/autoStart.js': {
                        triggerConfiguredWorkflowForTicket: function() { return false; },
                        triggerSmIfIdle: function() {}
                    },
                    './configLoader.js': configLoaderStub(opts),
                    './common/outputFiles.js': outputFiles,
                    './common/githubHelpers.js': githubHelpersStub,
                    './common/trackers.js': makeTrackersModule(formalMocks),
                    './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
                    './common/commentMarkup.js': commentMarkupModule,
                    './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
                    './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {})
                }),
                formalMocks
            );

            return {
                mod: mod,
                addLabelCalls: addLabelCalls,
                submitReviewCalls: submitReviewCalls,
                dismissReviewCalls: dismissReviewCalls
            };
        }

        test('disabled by default: does not submit a formal review when customParams.formalGithubReview is not set', function() {
            var loaded = loadPostPRReviewCommentsForFormalReview({
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                }
            });

            loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1'
            });

            assert.equal(loaded.submitReviewCalls.length, 0, 'must not submit a formal review when the opt-in flag is off');
            assert.equal(loaded.dismissReviewCalls.length, 0, 'must not dismiss a review when the opt-in flag is off');
        });

        test('project config.js formalGithubReview=true enables it without customParams', function() {
            var loaded = loadPostPRReviewCommentsForFormalReview({
                config: { formalGithubReview: true },
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    generalComment: 'Config-driven blocking issue.',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                }
            });

            loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1'
            });

            assert.equal(loaded.submitReviewCalls.length, 1, 'project config default must enable the formal review');
            assert.equal(loaded.submitReviewCalls[0].event, 'REQUEST_CHANGES');
        });

        test('customParams.formalGithubReview=false overrides config.js true', function() {
            var loaded = loadPostPRReviewCommentsForFormalReview({
                config: { formalGithubReview: true },
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    generalComment: 'Should never be submitted.',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                }
            });

            loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1',
                customParams: { formalGithubReview: false }
            });

            assert.equal(loaded.submitReviewCalls.length, 0, 'explicit per-run false must beat the project default');
        });

        test('enabled + REQUEST_CHANGES: submits a formal Request Changes review, and still adds no pr_approved label', function() {
            var loaded = loadPostPRReviewCommentsForFormalReview({
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    generalComment: 'Blocking issue found in file X.',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                }
            });

            loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1',
                customParams: { formalGithubReview: true }
            });

            assert.equal(loaded.submitReviewCalls.length, 1, 'should submit exactly one formal review');
            assert.equal(loaded.submitReviewCalls[0].event, 'REQUEST_CHANGES');
            assert.equal(loaded.submitReviewCalls[0].body, 'Blocking issue found in file X.');
            assert.equal(loaded.dismissReviewCalls.length, 0);
            assert.equal(
                loaded.addLabelCalls.filter(function(c) { return c.label === 'pr_approved'; }).length, 0,
                'must not touch the pr_approved label logic'
            );
        });

        test('enabled + APPROVE: dismisses prior CHANGES_REQUESTED, submits a formal APPROVE review, and still adds the pr_approved label', function() {
            var loaded = loadPostPRReviewCommentsForFormalReview({
                reviewData: {
                    recommendation: 'APPROVE',
                    issueCounts: { blocking: 0, important: 0, suggestions: 0 },
                    inlineComments: []
                },
                existingReviews: [
                    { id: 111, state: 'CHANGES_REQUESTED' },
                    { id: 222, state: 'APPROVED' }
                ]
            });

            loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1',
                customParams: { formalGithubReview: true }
            });

            assert.equal(loaded.dismissReviewCalls.length, 1, 'should dismiss exactly the CHANGES_REQUESTED review');
            assert.equal(loaded.dismissReviewCalls[0].reviewId, 111);
            assert.equal(loaded.submitReviewCalls.length, 1, 'must submit a formal APPROVE review when approving');
            assert.equal(loaded.submitReviewCalls[0].event, 'APPROVE');
            assert.ok(
                loaded.submitReviewCalls[0].body && String(loaded.submitReviewCalls[0].body).length > 0,
                'APPROVE review carries a body'
            );
            assert.equal(
                loaded.addLabelCalls.filter(function(c) { return c.label === 'pr_approved'; }).length, 1,
                'pr_approved label lifecycle on approve must be unchanged'
            );
        });

        test('APPROVE body resolves a generalComment FILE PATH to its content (#720 live bug)', function() {
            // Live bug (flutter_agent_harness #720): the model followed the
            // file-path contract (generalComment = 'outputs/pr_review_general.md'),
            // postGeneralComment read the file correctly, but the formal APPROVE
            // review posted the literal PATH as its body.
            var loaded = loadPostPRReviewCommentsForFormalReview({
                reviewData: {
                    recommendation: 'APPROVE',
                    generalComment: 'outputs/pr_review_general.md',
                    issueCounts: { blocking: 0, important: 0, suggestions: 0 },
                    inlineComments: []
                },
                generalMdContent: '## Automated Code Review — APPROVE\n\nSolid work.',
                existingReviews: []
            });

            loaded.mod.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1',
                customParams: { formalGithubReview: true }
            });

            assert.equal(loaded.submitReviewCalls.length, 1, 'exactly one formal review');
            assert.equal(loaded.submitReviewCalls[0].event, 'APPROVE');
            assert.equal(
                loaded.submitReviewCalls[0].body,
                '## Automated Code Review — APPROVE\n\nSolid work.',
                'the review body must be the file CONTENT, never the outputs/ path'
            );
        });

        test('PR-anchored EXTERNAL PR + APPROVE: pr_approved arms the merge pipeline for any author (owner rule)', function() {
            // Owner rule: external PRs get auto-APPROVE (pr_approved →
            // validate → merge); only auto-REWORK stays machine-gated.
            // Previously the pr_approved arming was machineAuthor-gated and
            // external PRs were "verdict only, merge left to maintainers".
            var loaded = loadPostPRReviewCommentsForFormalReview({
                config: { machineAuthor: 'ai-teammate' },
                prInfoContent: '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: feat/external\n- **Author**: some-human\n',
                reviewData: {
                    recommendation: 'APPROVE',
                    issueCounts: { blocking: 0, important: 0, suggestions: 0 },
                    inlineComments: []
                }
            });

            loaded.mod.action({
                ticket: { key: 'pr-42', fields: { labels: [] } },
                response: 'review content',
                inputFolderPath: 'input/pr-42'
            });

            assert.ok(
                loaded.addLabelCalls.some(function(c) { return c.prId === 42 && c.label === 'pr_approved'; }),
                'external PR approved → pr_approved armed: ' + JSON.stringify(loaded.addLabelCalls)
            );
        });

        test('PR-anchored MACHINE bot PR (second list entry) + REQUEST_CHANGES: agent:rework re-armed on the linked issue (gh-728, live fa PR #1249)', function() {
            // Owner directive 2026-10-05: github-actions-authored PRs ride
            // the machine path — the machineAuthor knob is a comma-separated
            // LIST and the re-arm predicate must match ANY entry.
            var loaded = loadPostPRReviewCommentsForFormalReview({
                config: { machineAuthor: 'ai-teammate,github-actions[bot]' },
                githubPrBody: 'ci(quarantine)\n\ncloses #191',
                prInfoContent: '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: ci/quarantine\n- **Author**: github-actions[bot]\n',
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                }
            });

            loaded.mod.action({
                ticket: { key: 'pr-42', fields: { labels: [] } },
                response: 'review content',
                inputFolderPath: 'input/pr-42'
            });

            assert.ok(
                loaded.addLabelCalls.some(function(c) { return c.prId === 191 && c.label === 'agent:rework'; }),
                'bot PR counts as machine under the list config → rework re-armed on the linked issue: ' +
                    JSON.stringify(loaded.addLabelCalls)
            );
        });

        test('PR-anchored EXTERNAL PR + REQUEST_CHANGES: no agent:rework re-arm (auto rework stays machine-gated)', function() {
            var loaded = loadPostPRReviewCommentsForFormalReview({
                config: { machineAuthor: 'ai-teammate' },
                prInfoContent: '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: feat/external\n- **Author**: some-human\n',
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                }
            });

            loaded.mod.action({
                ticket: { key: 'pr-42', fields: { labels: [] } },
                response: 'review content',
                inputFolderPath: 'input/pr-42'
            });

            assert.ok(
                !loaded.addLabelCalls.some(function(c) { return c.label === 'agent:rework'; }),
                'external PR: rework is NEVER auto-armed — the human author fixes it: ' + JSON.stringify(loaded.addLabelCalls)
            );
            assert.ok(
                !loaded.addLabelCalls.some(function(c) { return c.label === 'pr_approved'; }),
                'no pr_approved on a rejected review'
            );
        });

        test('enabled + scm without submitReview support (e.g. non-GitHub provider): skips gracefully, no error thrown', function() {
            var loaded = loadPostPRReviewCommentsForFormalReview({
                reviewData: {
                    recommendation: 'REQUEST_CHANGES',
                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                    inlineComments: []
                }
            });
            delete loaded.mod; // not used further

            // Re-load with an scm lacking submitReview entirely.
            var addLabelCalls = [];
            var mod2 = loadModule(
                'js/postPRReviewComments.js',
                makeRequire({
            './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
            './common/machineAuthor.js': machineAuthorModule,
                    './config.js': configModule,
                    './common/scm.js': {
                        createScm: function() {
                            return {
                                listPrs: function() { return []; },
                                getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
                                addLabel: function(prId, label) { addLabelCalls.push({ prId: prId, label: label }); },
                                removeLabel: function() {},
                                fetchDiscussions: function() { return { rawThreads: { threads: [] } }; }
                            };
                        }
                    },
                    './common/autoStart.js': {
                        triggerConfiguredWorkflowForTicket: function() { return false; },
                        triggerSmIfIdle: function() {}
                    },
                    './configLoader.js': {
                        loadProjectConfig: function() { return {}; },
                        resolveInstructions: function() { return { jobParamPatch: {} }; }
                    },
                    './common/outputFiles.js': {
                        readOutputFileDetailed: function() {
                            return {
                                content: JSON.stringify({
                                    recommendation: 'REQUEST_CHANGES',
                                    issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                                    inlineComments: []
                                }),
                                path: 'outputs/pr_review.json'
                            };
                        },
                        readOutputFile: function() { return null; }
                    },
                    './common/githubHelpers.js': githubHelpersStub,
                    './common/trackers.js': makeTrackersModule({
                        jira_add_label: function() {},
                        jira_move_to_status: function() {},
                        jira_post_comment: function() {},
                        jira_remove_label: function() {},
                        jira_assign_ticket_to: function() {}
                    }),
                    './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
                ,
            './common/commentMarkup.js': commentMarkupModule,
            './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
            './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {})
        }),
                {
                    file_read: function(args) {
                        var p = args && (args.path || args);
                        if (p && p.indexOf('pr_info.md') !== -1) {
                            return '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n';
                        }
                        return null;
                    },
                    jira_add_label: function() {},
                    jira_move_to_status: function() {},
                    jira_post_comment: function() {},
                    jira_remove_label: function() {},
                    jira_assign_ticket_to: function() {}
                }
            );

            var result = mod2.action({
                ticket: { key: 'PROJ-1', fields: { labels: [] } },
                response: 'Jira review content',
                inputFolderPath: 'input/PROJ-1',
                customParams: { formalGithubReview: true }
            });

            assert.equal(result.success, true, 'action must still succeed when the scm provider lacks submitReview');
        });
    });

    suite('parseDiffLineInfo', function() {
        test('prefers RIGHT over LEFT for a single-line replacement at the same line number', function() {
            var mod = loadPostPRReviewComments();

            // Classic single-line replacement: old and new content share the
            // same line number (5) inside the hunk. A finding about the
            // current code must anchor on RIGHT (the new line), not LEFT
            // (the removed line), even though the '-' line is encountered
            // first while scanning the diff.
            var diffText =
                'diff --git a/foo.js b/foo.js\n' +
                'index e96d9d1..988d518 100644\n' +
                '--- a/foo.js\n' +
                '+++ b/foo.js\n' +
                '@@ -2,7 +2,7 @@ function greet() {\n' +
                ' \tconst a = 1;\n' +
                ' \tconst b = 2;\n' +
                ' \tconst label = "before";\n' +
                '-\tconst greeting = "helo";\n' +
                '+\tconst greeting = "hello";\n' +
                ' \n' +
                ' \treturn greeting;\n';

            var info = mod.parseDiffLineInfo(diffText, 'foo.js', 5);

            assert.equal(info.present, true);
            assert.equal(info.side, 'RIGHT', 'a same-numbered replacement must resolve to RIGHT, not LEFT');
        });

        test('still resolves LEFT for a pure removal (no matching + at the same line)', function() {
            var mod = loadPostPRReviewComments();

            var diffText =
                'diff --git a/foo.js b/foo.js\n' +
                'index e96d9d1..988d518 100644\n' +
                '--- a/foo.js\n' +
                '+++ b/foo.js\n' +
                '@@ -2,2 +2,1 @@ function greet() {\n' +
                ' \tconst a = 1;\n' +
                '-\tconst unused = 2;\n';

            var info = mod.parseDiffLineInfo(diffText, 'foo.js', 3);

            assert.equal(info.present, true);
            assert.equal(info.side, 'LEFT', 'a pure removal with no matching added line must still resolve to LEFT');
        });
    });
});


suite('postPRReviewComments — gh-807 verdict persistence (postVerdictRecord)', function() {

    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function makeMod(opts) {
        opts = opts || {};
        var addedComments = [];
        var getPrCalls = 0;
        var mod = loadPostPRReviewComments();
        // postVerdictRecord talks to the github_get_pr bridge global and the
        // scm provider — stub both per test.
        mod.__testHarness = {
            github_get_pr: function(args) {
                getPrCalls++;
                if (opts.prError) throw new Error(opts.prError);
                return JSON.stringify(opts.pr || { number: 7, head: { sha: HEAD } });
            },
            scm: {
                addComment: function(prNumber, body) {
                    if (opts.commentError) throw new Error(opts.commentError);
                    addedComments.push({ prNumber: prNumber, body: body });
                }
            },
            addedComments: addedComments,
            getPrCalls: function() { return getPrCalls; }
        };
        return mod;
    }

    // The production function closes over the bridge globals, so drive it
    // through a small indirection: rebind the globals it reads.
    function withGlobals(mod, fn) {
        var g = typeof github_get_pr === 'function' ? github_get_pr : null;
        github_get_pr = mod.__testHarness.github_get_pr;
        try { fn(); } finally {
            if (g) github_get_pr = g; else github_get_pr = undefined;
        }
    }

    test('APPROVE leg stamps the machine record (head sha + census) on the PR', function() {
        var mod = makeMod({});
        withGlobals(mod, function() {
            mod.postVerdictRecord(mod.__testHarness.scm,
                { owner: 'epam', repo: 'dmtools-dart' }, 1428, true, 'APPROVE',
                { blocking: 0, important: 1, suggestions: 2 });
        });
        assert.equal(mod.__testHarness.addedComments.length, 1, 'one record comment');
        var body = mod.__testHarness.addedComments[0].body;
        assert.contains(body, '"head":"' + HEAD + '"', 'the record pins the head sha');
        assert.contains(body, '"verdict":"APPROVE"');
        assert.contains(body, '"blocking":0');
        assert.contains(body, '"important":1');
        assert.contains(body, '"suggestions":2');
        assert.contains(body, '"source":"pr_review.json"');
        assert.contains(body, '"at":"', 'the record carries its timestamp');
    });

    test('an overridden APPROVE (isApproved=false) records REQUEST_CHANGES — what the leg DID', function() {
        var mod = makeMod({});
        withGlobals(mod, function() {
            mod.postVerdictRecord(mod.__testHarness.scm,
                { owner: 'epam', repo: 'dmtools-dart' }, 1428, false, 'APPROVE',
                { blocking: 0, important: 0, suggestions: 3 });
        });
        assert.contains(mod.__testHarness.addedComments[0].body, '"verdict":"REQUEST_CHANGES"',
            'the leg did not approve (open issues) — the record says REQUEST_CHANGES');
    });

    test('BLOCK records BLOCK; REQUEST_CHANGES records REQUEST_CHANGES', function() {
        var mod = makeMod({});
        withGlobals(mod, function() {
            mod.postVerdictRecord(mod.__testHarness.scm,
                { owner: 'epam', repo: 'dmtools-dart' }, 1, false, 'BLOCK', {});
            mod.postVerdictRecord(mod.__testHarness.scm,
                { owner: 'epam', repo: 'dmtools-dart' }, 1, false, 'REQUEST_CHANGES', {});
        });
        assert.equal(mod.__testHarness.addedComments.length, 2);
        assert.contains(mod.__testHarness.addedComments[0].body, '"verdict":"BLOCK"');
        assert.contains(mod.__testHarness.addedComments[1].body, '"verdict":"REQUEST_CHANGES"');
    });

    test('a head-less PR (probe failure / no sha) posts NO record — never a head-less verdict', function() {
        var mod = makeMod({ pr: { number: 7 } });
        withGlobals(mod, function() {
            mod.postVerdictRecord(mod.__testHarness.scm,
                { owner: 'epam', repo: 'dmtools-dart' }, 7, true, 'APPROVE', {});
        });
        assert.equal(mod.__testHarness.addedComments.length, 0, 'no head → no record');
        var mod2 = makeMod({ prError: 'api down' });
        withGlobals(mod2, function() {
            mod2.postVerdictRecord(mod2.__testHarness.scm,
                { owner: 'epam', repo: 'dmtools-dart' }, 7, true, 'APPROVE', {});
        });
        assert.equal(mod2.__testHarness.addedComments.length, 0, 'broken probe → no record, non-fatal');
    });

    test('a lost comment write is non-fatal (the leg completes without the record)', function() {
        var mod = makeMod({ commentError: 'comment rejected' });
        withGlobals(mod, function() {
            mod.postVerdictRecord(mod.__testHarness.scm,
                { owner: 'epam', repo: 'dmtools-dart' }, 7, true, 'APPROVE', {});
        });
        assert.equal(mod.__testHarness.addedComments.length, 0, 'nothing recorded — and nothing thrown');
    });
});

// ═══ gh-926: action() characterization + extracted-pipeline helpers ══════════
// action() is being flattened into a tested pipeline (CRAP 2010 → < 30).
// These suites pin the CURRENT behaviour per verdict branch (APPROVE /
// REQUEST_CHANGES / overridden approve, formal review, suggestions-only,
// dispatch-race guard, markers) and the exact side-effect ORDER, so the
// extraction can be verified as behaviour-preserving.

/**
 * Instrumented action() harness: every observable touchpoint (scm calls,
 * tracker tools, autoStart triggers, github/bitrise bridges, resume writes,
 * token usage) appends to one ordered op log, so tests can pin the exact
 * side-effect sequence — the gh-926 acceptance is "same effects, same order".
 */
function loadReviewActionHarness(opts) {
    opts = opts || {};
    var ops = [];
    function rec(op, detail) { ops.push(Object.assign({ op: op }, detail || {})); }

    var scm = Object.assign(
        {},
        gh926ScmReadMocks(opts),
        gh926ScmWriteMocks(rec),
        gh926ScmThreadMocks(opts, rec)
    );
    var autoStartMock = gh926AutoStartMock(opts, rec);
    var outputFilesMock = gh926OutputFilesMock(opts);

    var mocks = Object.assign({}, gh926IoMocks(opts, rec), {
        jira_add_label: gh926JiraMock(rec, 'jira.addLabel', ['key', 'label']),
        jira_remove_label: gh926JiraMock(rec, 'jira.removeLabel', ['key', 'label']),
        jira_move_to_status: gh926JiraMock(rec, 'jira.moveToStatus', ['key', 'statusName']),
        jira_post_comment: gh926JiraMock(rec, 'jira.postComment', ['key', 'comment']),
        jira_assign_ticket_to: gh926JiraMock(rec, 'jira.assign', ['key', 'accountId'])
    });

    var merged = Object.assign({}, mocks, opts.mocks || {});

    var mod = gh926LoadActionModule(opts, scm, autoStartMock, outputFilesMock, merged, rec);

    return {
        mod: mod,
        ops: ops,
        opNames: function() { return ops.map(function(o) { return o.op; }); },
        opsOf: function(op) { return ops.filter(function(o) { return o.op === op; }); }
    };
}

// Mock builders below are named function declarations (not nested closures) on
// purpose: the CRAP gate counts function expressions toward their enclosing
// function, so each builder stays small enough to keep CRAP <= 8 regardless of
// the coverage the harness run happens to collect.

function gh926ScmReadMocks(opts) {
    return {
        listPrs: function() { return opts.openPrs || []; },
        getRemoteRepoInfo: function() { return opts.repoInfo !== undefined ? opts.repoInfo : null; },
        fetchDiscussions: function() { return { rawThreads: { threads: opts.threads || [] } }; },
        listReviews: function() { return opts.existingReviews || []; }
    };
}

function gh926ScmWriteMocks(rec) {
    return {
        addLabel: function(number, label) { rec('scm.addLabel', { number: number, label: label }); },
        removeLabel: function(number, label) { rec('scm.removeLabel', { number: number, label: label }); },
        addComment: function(number, body) { rec('scm.addComment', { number: number, body: body }); },
        addInlineComment: function(number, path, line, text, startLine, side) {
            rec('scm.addInlineComment', { number: number, path: path, line: line, text: text, startLine: startLine, side: side });
        },
        submitReview: function(prId, event, body) { rec('scm.submitReview', { prId: prId, event: event, body: body }); },
        dismissReview: function(prId, reviewId, message) { rec('scm.dismissReview', { prId: prId, reviewId: reviewId, message: message }); }
    };
}

function gh926ScmThreadMocks(opts, rec) {
    return {
        resolveThread: function(number, o) { rec('scm.resolveThread', { number: number, threadId: o && o.threadId }); },
        getPrDiff: function() {
            if (opts.diffError) throw new Error(opts.diffError);
            return opts.diff !== undefined ? opts.diff : '';
        }
    };
}

function gh926AutoStartMock(opts, rec) {
    return {
        triggerConfiguredWorkflowForTicket: function(args) {
            rec('autoStart.triggerConfiguredWorkflowForTicket', gh926TriggerDetail(args));
            return gh926TriggerResult(opts);
        },
        triggerSmIfIdle: function() { rec('autoStart.triggerSmIfIdle', {}); }
    };
}

function gh926TriggerDetail(args) {
    return {
        configFile: args && args.configFile,
        label: args && args.label,
        workflowFile: args && args.workflowFile,
        stripKeys: args && args.stripKeys
    };
}

function gh926TriggerResult(opts) {
    return opts.reworkTriggerStarted !== undefined ? opts.reworkTriggerStarted : true;
}

function gh926OutputFilesMock(opts) {
    return {
        readOutputFileDetailed: function() {
            if (opts.reviewData === null || opts.reviewData === undefined) return null;
            return { content: JSON.stringify(opts.reviewData), path: 'outputs/pr_review.json' };
        },
        readOutputFile: function(p) {
            return (opts.outputFileContents && opts.outputFileContents[p]) || null;
        }
    };
}

function argPathOf(args) {
    return args && (args.path || args);
}

function isResumeMarkerPath(p) {
    return p === 'outputs/.pr-review-missing-output-resume-attempted';
}

function gh926FileReadMock(opts) {
    return function(args) {
        return gh926FileReadFor(opts, argPathOf(args));
    };
}

function gh926FileReadFor(opts, p) {
    if (typeof p === 'string' && p.indexOf('pr_info.md') !== -1) return opts.prInfoContent || null;
    if (isResumeMarkerPath(p)) return opts.resumeMarker || null;
    return null;
}

function gh926GithubPrResult(opts) {
    if (opts.githubPrError) throw new Error(opts.githubPrError);
    return JSON.stringify(opts.githubPr || { number: 42, head: { sha: 'sha0000' }, body: opts.githubPrBody || '' });
}

function gh926IoMocks(opts, rec) {
    return {
        file_read: gh926FileReadMock(opts),
        file_write: function(args) { rec('file_write', { path: argPathOf(args) }); },
        cli_execute_command: gh926CliMock(opts, rec),
        github_get_pr: function(args) {
            rec('github_get_pr', { workspace: args && args.workspace, repository: args && args.repository, pullRequestId: args && args.pullRequestId });
            return gh926GithubPrResult(opts);
        },
        bitrise_trigger_build: function(args) { rec('bitrise_trigger_build', args); return '{}'; }
    };
}

function gh926CliMock(opts, rec) {
    return function(args) {
        rec('cli_execute_command', { command: args && args.command });
        if (opts.resumeCliError) throw new Error(opts.resumeCliError);
        return opts.resumeCliOutput || 'resume ok';
    };
}

function gh926JiraMock(rec, op, fields) {
    return function(args) {
        var detail = {};
        for (var i = 0; i < fields.length; i++) {
            detail[fields[i]] = args && args[fields[i]];
        }
        rec(op, detail);
    };
}

function gh926LoadActionModule(opts, scm, autoStartMock, outputFilesMock, merged, rec) {
    return loadModule(
        'js/postPRReviewComments.js',
        makeRequire({
            './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
            './common/machineAuthor.js': machineAuthorModule,
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return scm; } },
            './common/autoStart.js': autoStartMock,
            './configLoader.js': {
                loadProjectConfig: function() { return opts.config || {}; },
                resolveInstructions: function() { return { jobParamPatch: opts.jobParamPatch || {} }; }
            },
            './common/outputFiles.js': outputFilesMock,
            './common/githubHelpers.js': githubHelpersStub,
            './common/trackers.js': makeTrackersModule(merged),
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function(key, o) { rec('tokenUsage', { key: key, initiator: o && o.initiator }); }
            },
            './common/commentMarkup.js': commentMarkupModule,
            './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
            './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {})
        }),
        merged
    );
}

var GH926_PR_INFO_42 = '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n';

var GH926_CLEAN_APPROVE = {
    recommendation: 'APPROVE',
    issueCounts: { blocking: 0, important: 0, suggestions: 0 },
    inlineComments: []
};

function gh926ActionParams(opts) {
    opts = opts || {};
    var params = {
        ticket: { key: 'PROJ-1', fields: { labels: opts.ticketLabels || [] } },
        response: 'Jira review content',
        inputFolderPath: 'input/PROJ-1'
    };
    if (opts.customParams) params.customParams = opts.customParams;
    if (opts.metadata) params.metadata = opts.metadata;
    if (opts.initiator) params.initiator = opts.initiator;
    return params;
}

var GH926_REPO = { owner: 'IstiN', repo: 'dmtools-agents' };

suite('postPRReviewComments — gh-926 action characterization', function() {

    test('clean APPROVE: exact side-effect order, pr_approved on PR + ticket, no In Rework', function() {
        var h = loadReviewActionHarness({
            reviewData: GH926_CLEAN_APPROVE,
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.success, true);
        assert.equal(result.message, 'PR approved — awaiting reviewer merge');
        assert.equal(result.recommendation, 'APPROVE');
        assert.equal(result.githubCommentsPosted, true);

        assert.deepEqual(h.opNames(), [
            'github_get_pr',             // verdict record head probe
            'scm.addComment',            // gh-807 machine verdict record
            'scm.addLabel',              // pr_approved on the PR
            'jira.postComment',          // ticket review summary
            'jira.addLabel',             // pr_approved on the ticket
            'jira.addLabel',             // ai_pr_reviewed on the ticket
            'scm.addLabel',              // ai_pr_reviewed on the PR (#750)
            'jira.removeLabel',          // WIP label
            'autoStart.triggerSmIfIdle', // approved SM merge fallback
            'tokenUsage'
        ], 'side-effect order drifted');
        assert.equal(h.opsOf('scm.addLabel')[0].number, 42);
        assert.equal(h.opsOf('scm.addLabel')[0].label, 'pr_approved');
        assert.equal(h.opsOf('scm.addLabel')[1].number, 42);
        assert.equal(h.opsOf('scm.addLabel')[1].label, 'ai_pr_reviewed');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"APPROVE"');
        assert.equal(h.opsOf('jira.moveToStatus').length, 0, 'no In Rework move on approval');
        assert.deepEqual(
            h.opsOf('jira.addLabel').map(function(o) { return o.label; }),
            ['pr_approved', 'ai_pr_reviewed'],
            'no rework markers on approval'
        );
    });

    test('APPROVE with suggestions (no knobs) is overridden: record says REQUEST_CHANGES, In Rework + rework labels + SM', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 2 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.success, true);
        assert.equal(result.message, 'Changes requested, ticket returned to In Development');
        assert.equal(result.recommendation, 'APPROVE', 'the raw verdict is preserved in the result');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"REQUEST_CHANGES"',
            'the record stamps what the leg DID, not the raw token');
        assert.deepEqual(h.opNames(), [
            'github_get_pr',
            'scm.addComment',
            'jira.postComment',
            'jira.moveToStatus',
            'jira.addLabel',
            'scm.addLabel',
            'jira.removeLabel',
            'jira.addLabel',
            'jira.addLabel',
            'autoStart.triggerSmIfIdle',
            'tokenUsage'
        ], 'side-effect order drifted');
        assert.equal(h.opsOf('jira.moveToStatus')[0].statusName, 'In Rework');
        assert.deepEqual(
            h.opsOf('jira.addLabel').map(function(o) { return o.label; }),
            ['ai_pr_reviewed', 'sm_story_rework_triggered', 'agent:rework']
        );
        assert.equal(h.opsOf('scm.addLabel').filter(function(o) { return o.label === 'pr_approved'; }).length, 0,
            'an overridden approve must NOT arm the merge pipeline');
    });

    test('allowApproveWithSuggestions=true keeps APPROVE effective', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 1, suggestions: 2 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        var result = h.mod.action(gh926ActionParams({ customParams: { allowApproveWithSuggestions: true } }));

        assert.equal(result.message, 'PR approved — awaiting reviewer merge');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"APPROVE"');
        assert.equal(h.opsOf('jira.moveToStatus').length, 0);
        assert.ok(h.opsOf('scm.addLabel').some(function(o) { return o.label === 'pr_approved'; }));
    });

    test('dispatch-race guard: threads >= maxReviewThreadsBeforeForceApprove force-approves despite suggestions', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 3 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            threads: [{ id: 1 }, { id: 2 }]
        });

        var result = h.mod.action(gh926ActionParams({ customParams: { maxReviewThreadsBeforeForceApprove: 2 } }));

        assert.equal(result.message, 'PR approved — awaiting reviewer merge', 'forced approve at the limit');
        assert.ok(h.opsOf('scm.addLabel').some(function(o) { return o.label === 'pr_approved'; }));
        assert.equal(h.opsOf('jira.moveToStatus').length, 0);
        assert.equal(h.opsOf('github_get_pr').length, 1, 'verdict record still probed the head');
    });

    test('dispatch-race guard: threads under the limit still override to REQUEST_CHANGES', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 3 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            threads: [{ id: 1 }]
        });

        var result = h.mod.action(gh926ActionParams({ customParams: { maxReviewThreadsBeforeForceApprove: 2 } }));

        assert.equal(result.message, 'Changes requested, ticket returned to In Development');
        assert.equal(h.opsOf('jira.moveToStatus').length, 1);
    });

    test('autoStartRework opt-in triggers the configured workflow and skips the SM rework fallback', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'REQUEST_CHANGES',
                issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        h.mod.action(gh926ActionParams({
            customParams: { autoStartRework: true, autoStartReworkConfigFile: 'agents/pr_rework.json' }
        }));

        var triggers = h.opsOf('autoStart.triggerConfiguredWorkflowForTicket');
        assert.equal(triggers.length, 1);
        assert.equal(triggers[0].configFile, 'agents/pr_rework.json');
        assert.equal(triggers[0].label, 'pr_rework');
        assert.deepEqual(triggers[0].stripKeys, ['removeLabel', 'autoStartRework', 'autoStartReworkConfigFile']);
        assert.deepEqual(
            h.opsOf('jira.addLabel').map(function(o) { return o.label; }),
            ['ai_pr_reviewed'],
            'no sm_story_rework_triggered / agent:rework when the configured workflow started'
        );
        assert.equal(h.opsOf('autoStart.triggerSmIfIdle').length, 0, 'SM not triggered when the workflow started');
    });

    test('autoStartRework trigger that does not start falls back to SM rework', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'REQUEST_CHANGES',
                issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            reworkTriggerStarted: false
        });

        h.mod.action(gh926ActionParams({
            customParams: { autoStartRework: true, autoStartReworkConfigFile: 'agents/pr_rework.json' }
        }));

        assert.deepEqual(
            h.opsOf('jira.addLabel').map(function(o) { return o.label; }),
            ['ai_pr_reviewed', 'sm_story_rework_triggered', 'agent:rework']
        );
        assert.equal(h.opsOf('autoStart.triggerSmIfIdle').length, 1);
    });

    test('autoStartRework is skipped when the ticket already has pr_approved (merge in progress)', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'REQUEST_CHANGES',
                issueCounts: { blocking: 1, important: 0, suggestions: 0 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        h.mod.action(gh926ActionParams({
            ticketLabels: ['pr_approved'],
            customParams: { autoStartRework: true, autoStartReworkConfigFile: 'agents/pr_rework.json' }
        }));

        assert.equal(h.opsOf('autoStart.triggerConfiguredWorkflowForTicket').length, 0, 'workflow trigger skipped by label');
        assert.deepEqual(
            h.opsOf('jira.addLabel').map(function(o) { return o.label; }),
            ['ai_pr_reviewed', 'sm_story_rework_triggered', 'agent:rework'],
            'falls back to the SM rework path'
        );
    });

    test('WIP label removal is contextId-prefixed when metadata carries contextId', function() {
        var h = loadReviewActionHarness({
            reviewData: GH926_CLEAN_APPROVE,
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        h.mod.action(gh926ActionParams({ metadata: { contextId: 'custom_review' } }));

        assert.ok(
            h.opsOf('jira.removeLabel').some(function(o) { return o.label === 'custom_review_wip'; }),
            JSON.stringify(h.opsOf('jira.removeLabel'))
        );
    });

    test('SM idempotency label removal and initiator reassignment', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'REQUEST_CHANGES',
                issueCounts: { blocking: 0, important: 0, suggestions: 1 },
                inlineComments: []
            },
            repoInfo: null
        });

        var result = h.mod.action(gh926ActionParams({
            customParams: { removeLabel: 'sm_story_review_triggered' },
            initiator: 'alice'
        }));

        assert.equal(result.success, true);
        assert.ok(h.opsOf('jira.removeLabel').some(function(o) { return o.label === 'sm_story_review_triggered'; }));
        assert.ok(h.opsOf('jira.assign').some(function(o) { return o.accountId === 'alice'; }));
        assert.equal(h.opsOf('jira.moveToStatus').length, 0, 'no PR found → no In Rework move');
        assert.ok(
            h.opsOf('jira.postComment').some(function(o) { return o.comment.indexOf('PR Review Could Not Be Attached') !== -1; }),
            'no-PR outcome is surfaced on the ticket'
        );
    });

    test('onApproved.testCasesGenerator triggers the workflow and stamps ai_tests_generated', function() {
        var h = loadReviewActionHarness({
            reviewData: GH926_CLEAN_APPROVE,
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        h.mod.action(gh926ActionParams({
            customParams: {
                onApproved: { testCasesGenerator: { configFile: 'agents/test_cases_generator.json', workflow: 'ai-teammate.yml' } },
                aiRepository: { owner: 'acme', repo: 'agents' }
            }
        }));

        var triggers = h.opsOf('autoStart.triggerConfiguredWorkflowForTicket');
        assert.equal(triggers.length, 1);
        assert.equal(triggers[0].configFile, 'agents/test_cases_generator.json');
        assert.equal(triggers[0].workflowFile, 'ai-teammate.yml');
        assert.ok(h.opsOf('jira.addLabel').some(function(o) { return o.label === 'ai_tests_generated'; }));
        assert.equal(h.opsOf('autoStart.triggerSmIfIdle').length, 1, 'approved SM fallback still runs');
        var order = h.opNames();
        assert.ok(
            order.indexOf('autoStart.triggerConfiguredWorkflowForTicket') < order.indexOf('autoStart.triggerSmIfIdle'),
            'TestCasesGenerator trigger precedes the SM fallback'
        );
    });

    test('TestCasesGenerator is skipped when ai_tests_generated is already on the ticket', function() {
        var h = loadReviewActionHarness({
            reviewData: GH926_CLEAN_APPROVE,
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        h.mod.action(gh926ActionParams({
            ticketLabels: ['ai_tests_generated'],
            customParams: {
                onApproved: { testCasesGenerator: { configFile: 'agents/test_cases_generator.json' } },
                aiRepository: { owner: 'acme', repo: 'agents' }
            }
        }));

        assert.equal(h.opsOf('autoStart.triggerConfiguredWorkflowForTicket').length, 0);
        assert.equal(h.opsOf('jira.addLabel').filter(function(o) { return o.label === 'ai_tests_generated'; }).length, 0,
            'no second ai_tests_generated stamp');
    });

    test('TestCasesGenerator without aiRepository/repo info is skipped', function() {
        var h = loadReviewActionHarness({
            reviewData: GH926_CLEAN_APPROVE,
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            config: {}
        });

        h.mod.action(gh926ActionParams({
            customParams: { onApproved: { testCasesGenerator: { configFile: 'agents/test_cases_generator.json' } } }
        }));

        assert.equal(h.opsOf('autoStart.triggerConfiguredWorkflowForTicket').length, 0);
        assert.equal(h.opsOf('jira.addLabel').filter(function(o) { return o.label === 'ai_tests_generated'; }).length, 0);
        assert.equal(h.opsOf('autoStart.triggerSmIfIdle').length, 1, 'approved SM fallback still runs');
    });

    test('onApproved.bitriseBuild passes the PR branch and TICKET_KEY/PR_URL env vars', function() {
        var h = loadReviewActionHarness({
            reviewData: GH926_CLEAN_APPROVE,
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        h.mod.action(gh926ActionParams({
            customParams: {
                onApproved: {
                    bitriseBuild: {
                        appSlug: 'app-slug',
                        workflowId: 'wf-id',
                        branch: 'develop',
                        envVars: [{ mapped_to: 'X', value: '1', is_expand: true }]
                    }
                }
            }
        }));

        var builds = h.opsOf('bitrise_trigger_build');
        assert.equal(builds.length, 1);
        assert.equal(builds[0].appSlug, 'app-slug');
        assert.equal(builds[0].workflowId, 'wf-id');
        assert.equal(builds[0].branch, 'bug/PROJ-1', 'the PR branch from pr_info wins over the configured default');
        var envVars = JSON.parse(builds[0].envVars);
        assert.equal(envVars.length, 3, 'configured envVars + TICKET_KEY + PR_URL');
        assert.equal(envVars[0].mapped_to, 'X');
        assert.equal(envVars[1].mapped_to, 'TICKET_KEY');
        assert.equal(envVars[1].value, 'PROJ-1');
        assert.equal(envVars[2].mapped_to, 'PR_URL');
        assert.equal(envVars[2].value, 'https://github.com/IstiN/dmtools-agents/pull/42');
    });

    test('missing pr_review.json — one resume attempt, then missing-review-output handling', function() {
        var h = loadReviewActionHarness({
            reviewData: null,
            repoInfo: GH926_REPO
        });

        var result = h.mod.action(gh926ActionParams({ customParams: { removeLabel: 'sm_story_review_triggered' } }));

        assert.deepEqual(result, {
            success: true,
            action: 'missing_review_outputs',
            error: 'No review data found in pr_review.json'
        });
        var cli = h.opsOf('cli_execute_command');
        assert.equal(cli.length, 1, 'exactly one resume run');
        assert.ok(cli[0].command.indexOf('run-agent.sh --continue outputs/.pr-review-resume-prompt.md') !== -1, cli[0].command);
        assert.deepEqual(
            h.opsOf('file_write').map(function(o) { return o.path; }),
            ['outputs/.pr-review-missing-output-resume-attempted', 'outputs/.pr-review-resume-prompt.md']
        );
        assert.ok(h.opsOf('jira.postComment').some(function(o) { return o.comment.indexOf('PR Review Output Missing') !== -1; }));
        assert.ok(h.opsOf('jira.removeLabel').some(function(o) { return o.label === 'sm_story_review_triggered'; }));
        assert.equal(h.opsOf('autoStart.triggerSmIfIdle').length, 1, 'SM triggered after missing outputs');
    });

    test('the resume marker prevents a second resume attempt', function() {
        var h = loadReviewActionHarness({
            reviewData: null,
            repoInfo: null,
            resumeMarker: '2026-10-16T00:00:00.000Z\n'
        });

        h.mod.action(gh926ActionParams({}));

        assert.equal(h.opsOf('cli_execute_command').length, 0, 'marker present → no resume run');
        assert.equal(h.opsOf('file_write').length, 0, 'marker present → no marker/prompt rewrite');
        assert.equal(h.opsOf('autoStart.triggerSmIfIdle').length, 1, 'missing-output handling still triggers SM');
    });

    test('PR-anchored APPROVE ends with the pr-anchored result shape; ticket side skipped', function() {
        var h = loadReviewActionHarness({
            reviewData: GH926_CLEAN_APPROVE,
            repoInfo: GH926_REPO,
            prInfoContent: '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: feat/x\n- **Author**: some-human\n',
            config: {}
        });

        var result = h.mod.action({
            ticket: { key: 'pr-42', fields: { labels: [] } },
            response: 'review content',
            inputFolderPath: 'input/pr-42'
        });

        assert.deepEqual(result, { success: true, prNumber: 42, recommendation: 'APPROVE' });
        assert.deepEqual(
            h.opsOf('scm.addLabel').map(function(o) { return o.label; }),
            ['pr_approved', 'ai_pr_reviewed']
        );
        assert.ok(h.opsOf('scm.removeLabel').some(function(o) { return o.number === 42 && o.label === 'agent:review'; }),
            'the on-demand review trigger is consumed');
        assert.equal(h.opsOf('jira.postComment').length, 0, 'PR-anchored runs skip the ticket comment');
        assert.equal(h.opsOf('github_get_pr').length, 1, 'only the verdict-record head probe runs');
        assert.equal(h.opsOf('jira.addLabel').filter(function(o) { return o.label === 'agent:rework'; }).length, 0,
            'external author → no linked-issue rework re-arm');
    });

    test('inline comments + resolved threads are posted on the PR before the verdict record', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: GH926_CLEAN_APPROVE.issueCounts,
                generalComment: 'outputs/pr_review_general.md',
                inlineComments: [
                    { path: 'src/a.js', line: 3, body: 'inline text one' },
                    { path: 'src/b.js', line: 2, body: 'inline text two' }
                ],
                resolvedThreadIds: [777, 888]
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            outputFileContents: { 'outputs/pr_review_general.md': '## Automated Code Review — APPROVE\n\nAll good.' },
            diff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,3 @@\n x\n+changed\n y\n' +
                'diff --git a/src/b.js b/src/b.js\n--- a/src/b.js\n+++ b/src/b.js\n@@ -1,2 +1,3 @@\n x\n+added here\n y\n'
        });

        h.mod.action(gh926ActionParams({}));

        var order = h.opNames();
        assert.ok(order.indexOf('scm.addInlineComment') < order.indexOf('scm.resolveThread'), 'inline comments precede thread resolves');
        assert.ok(order.indexOf('scm.resolveThread') < order.lastIndexOf('scm.addComment'), 'thread resolves precede the verdict record');
        assert.equal(h.opsOf('scm.addInlineComment').length, 2, 'both inline comments posted');
        assert.deepEqual(
            h.opsOf('scm.resolveThread').map(function(o) { return o.threadId; }),
            [777, 888]
        );
        assert.equal(h.opsOf('scm.addComment').length, 2, 'general comment + verdict record');
        assert.contains(h.opsOf('scm.addComment')[0].body, 'Automated Code Review', 'general comment resolved from the file');
    });
});

suite('postPRReviewComments — gh-926 inline-comment fallbacks', function() {

    function inlineHarness(opts) {
        var calls = { inline: [], comments: [] };
        var scm = {
            getPrDiff: function() {
                if (opts.diffError) throw new Error(opts.diffError);
                return opts.diff !== undefined ? opts.diff : '';
            },
            addInlineComment: function(prId, path, line, text, startLine, side) {
                calls.inline.push({ prId: prId, path: path, line: line, text: text, startLine: startLine, side: side });
            },
            addComment: function(prId, body) { calls.comments.push({ prId: prId, body: body }); }
        };
        return { scm: scm, calls: calls };
    }

    test('getPrDiff failure falls back to a general PR comment and reports success', function() {
        var h = inlineHarness({ diffError: 'api down' });
        var mod = loadPostPRReviewComments();

        var ok = mod.postInlineComment(h.scm, 9, { path: 'src/a.js', line: 3, body: 'note' }, 'PROJ-1', null);

        assert.equal(ok, true, 'nothing is lost — the comment lands as a general PR comment');
        assert.equal(h.calls.inline.length, 0);
        assert.equal(h.calls.comments.length, 1);
        assert.contains(h.calls.comments[0].body, '📍 **`src/a.js:3`**');
    });

    test('line present only on the opposite side falls back to a general PR comment', function() {
        // old 1..3, new 1..1: line 2 exists only on the LEFT side of this diff.
        var diff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,3 +1,1 @@\n-a1\n-a2\n a3\n';
        var h = inlineHarness({ diff: diff });
        var mod = loadPostPRReviewComments();

        var ok = mod.postInlineComment(h.scm, 9, { path: 'src/a.js', line: 2, body: 'note', side: 'RIGHT' }, 'PROJ-1', null);

        assert.equal(ok, true);
        assert.equal(h.calls.inline.length, 0, 'line 2 only exists on the LEFT — RIGHT request falls back');
        assert.equal(h.calls.comments.length, 1);
    });

    test('comment on a deleted file anchors on the LEFT side', function() {
        var diff = 'diff --git a/old.js b/old.js\ndeleted file mode 100644\n--- a/old.js\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n';
        var h = inlineHarness({ diff: diff });
        var mod = loadPostPRReviewComments();

        var ok = mod.postInlineComment(h.scm, 9, { path: 'old.js', line: 1, body: 'note' }, 'PROJ-1', null);

        assert.equal(ok, true);
        assert.equal(h.calls.inline.length, 1);
        assert.equal(h.calls.inline[0].side, 'LEFT');
    });

    test('no comment content → false and no SCM calls', function() {
        var h = inlineHarness({ diff: '' });
        var mod = loadPostPRReviewComments();

        var ok = mod.postInlineComment(h.scm, 9, { path: 'src/a.js', line: 3 }, 'PROJ-1', null);

        assert.equal(ok, false);
        assert.equal(h.calls.inline.length, 0);
        assert.equal(h.calls.comments.length, 0);
    });

    test('no file path → false and no SCM calls', function() {
        var h = inlineHarness({ diff: '' });
        var mod = loadPostPRReviewComments();

        var ok = mod.postInlineComment(h.scm, 9, { line: 3, body: 'note' }, 'PROJ-1', null);

        assert.equal(ok, false);
        assert.equal(h.calls.inline.length, 0);
    });

    test('happy path: startLine and side are passed through to addInlineComment', function() {
        var diff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -2,3 +2,4 @@\n ctx\n+added\n ctx\n';
        var h = inlineHarness({ diff: diff });
        var mod = loadPostPRReviewComments();

        var ok = mod.postInlineComment(h.scm, 9, {
            path: 'src/a.js', line: 3, startLine: 2, body: 'note', side: 'RIGHT'
        }, 'PROJ-1', null);

        assert.equal(ok, true);
        assert.deepEqual(h.calls.inline, [{
            prId: 9, path: 'src/a.js', line: 3, text: 'note', startLine: 2, side: 'RIGHT'
        }]);
    });
});

suite('postPRReviewComments — gh-926 coverage on pre-existing helpers', function() {

    test('parseDiffLineInfo: no-newline markers, non-numeric lines, deleted files and metadata lines', function() {
        var mod = loadPostPRReviewComments();

        // Missing/blank inputs are treated as "not verifiable — present"
        assert.deepEqual(mod.parseDiffLineInfo(null, 'a.js', 3), { present: true, side: null });
        assert.deepEqual(mod.parseDiffLineInfo('', 'a.js', 3), { present: true, side: null });
        assert.deepEqual(mod.parseDiffLineInfo('x', null, 3), { present: true, side: null });
        assert.deepEqual(mod.parseDiffLineInfo('x', 'a.js', null), { present: true, side: null });
        assert.deepEqual(mod.parseDiffLineInfo('x', 'a.js', 'not-a-number'), { present: true, side: null });

        // '\ No newline at end of file' is skipped, not counted as a line
        var nnl = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n-old tail\n+new tail\n\\ No newline at end of file\n';
        assert.deepEqual(mod.parseDiffLineInfo(nnl, 'a.js', 1), { present: true, side: 'RIGHT' });
        assert.deepEqual(mod.parseDiffLineInfo(nnl, 'a.js', 2), { present: false, side: null });

        // File metadata lines between the +++ header and the first hunk are
        // skipped without crashing (oldLine/newLine still null).
        var withMeta = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\nindex aaa..bbb 100644\n@@ -1 +1 @@\n-x\n+y\n';
        assert.deepEqual(mod.parseDiffLineInfo(withMeta, 'a.js', 1), { present: true, side: 'RIGHT' });

        // Deleted file (+++ /dev/null): lines resolve on the old path, LEFT side
        var deleted = 'diff --git a/gone.js b/gone.js\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
        assert.deepEqual(mod.parseDiffLineInfo(deleted, 'gone.js', 1), { present: true, side: 'LEFT' });

        // Context lines match on either side; RIGHT wins for shared numbers
        var ctx = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n shared\n+added\n';
        assert.deepEqual(mod.parseDiffLineInfo(ctx, 'a.js', 1), { present: true, side: 'RIGHT' });

        // A line outside every hunk is absent
        assert.deepEqual(mod.parseDiffLineInfo(ctx, 'a.js', 99), { present: false, side: null });

        // Rename-style header (--- a/old +++ b/new): the new path anchors lines
        var renamed = 'diff --git a/old.js b/new.js\n--- a/old.js\n+++ b/new.js\n@@ -1 +1 @@\n-x\n+y\n';
        assert.deepEqual(mod.parseDiffLineInfo(renamed, 'new.js', 1), { present: true, side: 'RIGHT' });
        assert.deepEqual(mod.parseDiffLineInfo(renamed, 'old.js', 1), { present: false, side: null });
    });

    test('deriveProjectKey: projectKey wins; configPath basename; config.js → empty', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.deriveProjectKey(undefined), '');
        assert.equal(mod.deriveProjectKey({}), '');
        assert.equal(mod.deriveProjectKey({ projectKey: 'pk' }), 'pk');
        assert.equal(mod.deriveProjectKey({ projectKey: 'pk', configPath: '.dmtools/configs/other.js' }), 'pk');
        assert.equal(mod.deriveProjectKey({ configPath: '.dmtools/configs/myproject.js' }), 'myproject');
        assert.equal(mod.deriveProjectKey({ configPath: '.dmtools/config.js' }), '');
        assert.equal(mod.deriveProjectKey({ configPath: 'config.js' }), '');
        assert.equal(mod.deriveProjectKey({ configPath: '' }), '');
    });

    test('isFileDeletedInDiff: deleted file mode detected per file segment', function() {
        var mod = loadPostPRReviewComments();
        var diff = 'diff --git a/kept.js b/kept.js\n--- a/kept.js\n+++ b/kept.js\n@@ -1,1 +1,1 @@\n-a\n+b\n' +
            'diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n';

        assert.equal(mod.isFileDeletedInDiff(diff, 'gone.js'), true);
        assert.equal(mod.isFileDeletedInDiff(diff, 'kept.js'), false);
        assert.equal(mod.isFileDeletedInDiff(diff, 'missing.js'), false);
        assert.equal(mod.isFileDeletedInDiff(null, 'gone.js'), false);
        assert.equal(mod.isFileDeletedInDiff(diff, ''), false);
    });

    test('submoduleHasNewPointer: only a new (+) pointer counts as updated', function() {
        var mod = loadPostPRReviewComments();
        var updated = 'diff --git a/sub b/sub\n--- a/sub\n+++ b/sub\n-Subproject commit aaa\n+Subproject commit bbb\n';
        var removedOnly = 'diff --git a/sub b/sub\n--- a/sub\n+++ b/sub\n-Subproject commit aaa\n';

        assert.equal(mod.submoduleHasNewPointer(updated, 'sub'), true);
        assert.equal(mod.submoduleHasNewPointer(removedOnly, 'sub'), false);
        assert.equal(mod.submoduleHasNewPointer(updated, 'other'), false);
        assert.equal(mod.submoduleHasNewPointer(null, 'sub'), false);
    });

    test('resolveApprovedThreads: resolves in order, survives a failing thread, no-ops on empty', function() {
        var resolved = [];
        var scm = {
            resolveThread: function(prId, o) {
                if (o.threadId === 777) throw new Error('already merged');
                resolved.push(o.threadId);
            }
        };
        var mod = loadPostPRReviewComments();

        mod.resolveApprovedThreads(scm, 5, [777, 888]);
        assert.deepEqual(resolved, [888], 'the failing thread did not stop the rest');

        resolved.length = 0;
        mod.resolveApprovedThreads(scm, 5, []);
        mod.resolveApprovedThreads(scm, 5, null);
        assert.deepEqual(resolved, [], 'empty/null lists are a no-op');
    });

    test('hasPrApprovedLabel', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.hasPrApprovedLabel({ fields: { labels: ['pr_approved'] } }), true);
        assert.equal(mod.hasPrApprovedLabel({ fields: { labels: [] } }), false);
        assert.equal(mod.hasPrApprovedLabel({ fields: {} }), false);
        assert.equal(mod.hasPrApprovedLabel(null), false);
    });

    test('readReviewJson: malformed JSON → null (and the empty-output branch)', function() {
        var bad = loadModule('js/postPRReviewComments.js', makeRequire({
            './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
            './common/machineAuthor.js': machineAuthorModule,
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': {},
            './configLoader.js': {
                loadProjectConfig: function() { return {}; },
                resolveInstructions: function() { return { jobParamPatch: {} }; }
            },
            './common/outputFiles.js': {
                readOutputFileDetailed: function() { return { content: 'not json {', path: 'outputs/pr_review.json' }; },
                readOutputFile: function() { return null; }
            },
            './common/githubHelpers.js': githubHelpersStub,
            './common/trackers.js': makeTrackersModule({}),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/commentMarkup.js': commentMarkupModule,
            './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
            './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {})
        }), {});

        assert.equal(bad.readReviewJson('PROJ-1', null), null);
    });

    test('attemptResumeIfReviewOutputsMissing: no-op when review JSON or marker already present', function() {
        var present = makeResumeHarness({ reviewJson: { recommendation: 'APPROVE' } });
        assert.equal(present.mod.attemptResumeIfReviewOutputsMissing('PROJ-1'), false);
        assert.deepEqual(present.calls.writes, [], 'nothing written when outputs exist');
        assert.deepEqual(present.calls.cli, []);

        var marked = makeResumeHarness({ marker: 'earlier run\n' });
        assert.equal(marked.mod.attemptResumeIfReviewOutputsMissing('PROJ-1'), false);
        assert.deepEqual(marked.calls.writes, [], 'nothing written when the marker exists');
        assert.deepEqual(marked.calls.cli, []);
    });

    test('attemptResumeIfReviewOutputsMissing: writes marker + prompt, runs the resume CLI once', function() {
        var h = makeResumeHarness({});
        assert.equal(h.mod.attemptResumeIfReviewOutputsMissing('PROJ-1'), true);
        assert.deepEqual(h.calls.writes.map(function(w) { return w.path; }), [
            'outputs/.pr-review-missing-output-resume-attempted',
            'outputs/.pr-review-resume-prompt.md'
        ]);
        assert.contains(h.calls.writes[1].content, 'PROJ-1', 'the resume prompt names the ticket');
        assert.contains(h.calls.writes[1].content, 'outputs/pr_review.json');
        assert.equal(h.calls.cli.length, 1);
        assert.ok(h.calls.cli[0].indexOf('run-agent.sh --continue outputs/.pr-review-resume-prompt.md') !== -1);
    });

    test('attemptResumeIfReviewOutputsMissing: resume CLI failure is reported as false', function() {
        var h = makeResumeHarness({ cliError: 'cli down' });
        assert.equal(h.mod.attemptResumeIfReviewOutputsMissing('PROJ-1'), false);
        assert.equal(h.calls.cli.length, 1);
    });

    test('getGitHubRepoInfo: parses https and ssh remotes, warns on garbage', function() {
        var mod = makeResumeHarness({ remoteUrl: 'https://github.com/acme/repo.git\nScript done\n' });
        assert.deepEqual(mod.mod.getGitHubRepoInfo(), { owner: 'acme', repo: 'repo' });

        var ssh = makeResumeHarness({ remoteUrl: 'git@github.com:acme/other.git\n' });
        assert.deepEqual(ssh.mod.getGitHubRepoInfo(), { owner: 'acme', repo: 'other' });

        var junk = makeResumeHarness({ remoteUrl: 'not a remote\n' });
        assert.equal(junk.mod.getGitHubRepoInfo(), null);
    });
});

/**
 * Harness for the resume-attempt / remote-info paths: mocks the file + CLI
 * globals and captures writes and commands.
 */
function makeResumeHarness(opts) {
    var calls = { writes: [], cli: [] };
    var mod = loadModule(
        'js/postPRReviewComments.js',
        gh926ResumeRequire(opts),
        gh926ResumeGlobalMocks(opts, calls)
    );
    return { mod: mod, calls: calls };
}

// Named declarations (not nested closures) so the CRAP gate does not sweep
// these lambdas into makeResumeHarness — same rule as the action harness.
function gh926ResumeRequire(opts) {
    return makeRequire({
        './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
        './common/machineAuthor.js': machineAuthorModule,
        './config.js': configModule,
        './common/scm.js': { createScm: function() { return {}; } },
        './common/autoStart.js': {},
        './configLoader.js': {
            loadProjectConfig: function() { return {}; },
            resolveInstructions: function() { return { jobParamPatch: {} }; }
        },
        './common/outputFiles.js': {
            readOutputFileDetailed: function() {
                return opts.reviewJson
                    ? { content: JSON.stringify(opts.reviewJson), path: 'outputs/pr_review.json' }
                    : null;
            },
            readOutputFile: function() { return null; }
        },
        './common/githubHelpers.js': githubHelpersStub,
        './common/trackers.js': makeTrackersModule({}),
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/commentMarkup.js': commentMarkupModule,
        './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
        './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {})
    });
}

function gh926ResumeGlobalMocks(opts, calls) {
    return {
        file_read: function(args) {
            if (isResumeMarkerPath(argPathOf(args))) return opts.marker || null;
            return null;
        },
        file_write: function(args) {
            calls.writes.push({ path: argPathOf(args), content: args && args.content });
            return null;
        },
        cli_execute_command: gh926ResumeCliMock(opts, calls)
    };
}

function gh926ResumeCliMock(opts, calls) {
    return function(args) {
        calls.cli.push(args && args.command);
        if (opts.cliError) throw new Error(opts.cliError);
        return opts.remoteUrl !== undefined ? opts.remoteUrl : 'resume output';
    };
}

suite('postPRReviewComments — gh-926 extracted pipeline helpers', function() {

    test('parsePRAnchor: folder anchor wins, jobParams fallback, null when absent', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.parsePRAnchor({ inputFolderPath: 'input/pr-42' }, {}), 42);
        assert.equal(mod.parsePRAnchor({ inputFolderPath: 'input/PROJ-1' }, { prNumber: 7 }), 7);
        assert.equal(mod.parsePRAnchor({ inputFolderPath: 'input/PROJ-1' }, { pr: '9' }), 9);
        assert.equal(mod.parsePRAnchor({ inputFolderPath: 'input/pr-42' }, { prNumber: 7 }), 42, 'folder anchor wins');
        assert.equal(mod.parsePRAnchor({ inputFolderPath: 'input/PROJ-1' }, {}), null);
        assert.equal(mod.parsePRAnchor({ inputFolderPath: 'input/pr-abc' }, {}), null);
    });

    test('resolveReviewTicketKey: pr-<n> for anchored runs, ticket key otherwise', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.resolveReviewTicketKey({ ticket: { key: 'PROJ-1' } }, 42), 'pr-42');
        assert.equal(mod.resolveReviewTicketKey({ ticket: { key: 'PROJ-1' } }, null), 'PROJ-1');
    });

    test('parsePRInfoMarkdown: number/url/branch parsed; Author only when PR-anchored; misses carry current', function() {
        var mod = loadPostPRReviewComments();
        var prInfo = '- **PR #**: 42\n- **URL**: https://github.com/acme/repo/pull/42\n- **Branch**: feat/x\n- **Author**: some-human\n';

        var anchored = mod.parsePRInfoMarkdown(prInfo, 42, { prNumber: 42, prUrl: null, prBranch: null, prAuthor: null });
        assert.equal(anchored.prNumber, 42);
        assert.equal(anchored.prUrl, 'https://github.com/acme/repo/pull/42');
        assert.equal(anchored.prBranch, 'feat/x');
        assert.equal(anchored.prAuthor, 'some-human', 'Author parsed only for PR-anchored runs');

        var issueAnchored = mod.parsePRInfoMarkdown(prInfo, null, { prNumber: null, prUrl: null, prBranch: null, prAuthor: null });
        assert.equal(issueAnchored.prAuthor, null, 'issue-anchored runs never read the author');

        var partial = mod.parsePRInfoMarkdown('- **Branch**: feat/y\n', null, { prNumber: 33, prUrl: 'u', prBranch: null, prAuthor: null });
        assert.equal(partial.prNumber, 33, 'no PR # match → prior value kept');
        assert.equal(partial.prUrl, 'u');
        assert.equal(partial.prBranch, 'feat/y');

        var absent = mod.parsePRInfoMarkdown(null, null, { prNumber: 33, prUrl: null, prBranch: null, prAuthor: null });
        assert.equal(absent.prNumber, 33, 'missing pr_info.md → current values carried');
    });

    test('normalizeRecommendation: APPROVED → APPROVE, verdict fallback, default REQUEST_CHANGES', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.normalizeRecommendation({ recommendation: 'APPROVED' }), 'APPROVE');
        assert.equal(mod.normalizeRecommendation({ recommendation: 'APPROVE' }), 'APPROVE');
        assert.equal(mod.normalizeRecommendation({ verdict: 'BLOCK' }), 'BLOCK');
        assert.equal(mod.normalizeRecommendation({}), 'REQUEST_CHANGES');
        assert.equal(mod.normalizeRecommendation({ recommendation: 'REQUEST_CHANGES' }), 'REQUEST_CHANGES');
    });

    test('normalizeIssueCounts + hasAnyOpenIssue: any non-zero count opens issues', function() {
        var mod = loadPostPRReviewComments();

        assert.deepEqual(mod.normalizeIssueCounts({}), { blocking: 0, important: 0, suggestions: 0 });
        assert.equal(mod.hasAnyOpenIssue({ blocking: 0, important: 0, suggestions: 0 }), false);
        assert.equal(mod.hasAnyOpenIssue({ blocking: 1 }), true);
        assert.equal(mod.hasAnyOpenIssue({ important: 2 }), true);
        assert.equal(mod.hasAnyOpenIssue({ suggestions: 3 }), true);
        assert.equal(mod.hasAnyOpenIssue({}), false);
    });

    test('decideApproval: APPROVE stands unless open issues are not excused', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.decideApproval('APPROVE', false, false, false), true);
        assert.equal(mod.decideApproval('APPROVE', true, false, false), false);
        assert.equal(mod.decideApproval('APPROVE', true, true, false), true, 'allowApproveWithSuggestions');
        assert.equal(mod.decideApproval('APPROVE', true, false, true), true, 'thread-limit force approve');
        assert.equal(mod.decideApproval('REQUEST_CHANGES', false, false, false), false);
        assert.equal(mod.decideApproval('BLOCK', true, false, false), false);
    });

    test('isApprovalOverridden + warning text', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.isApprovalOverridden('APPROVE', true, false, false), true);
        assert.equal(mod.isApprovalOverridden('APPROVE', true, false, true), false, 'force-approved is not an override');
        assert.equal(mod.isApprovalOverridden('APPROVE', true, true, false), false);
        assert.equal(mod.isApprovalOverridden('REQUEST_CHANGES', true, false, false), false);

        var warning = mod.buildApprovalOverrideWarning({ blocking: 1, important: 2, suggestions: 3 });
        assert.contains(warning, 'blocking=1');
        assert.contains(warning, 'important=2');
        assert.contains(warning, 'suggestions=3');
        assert.contains(warning, 'allowApproveWithSuggestions=true');
    });

    test('shouldProbeThreadLimit + maxThreadLimitOf: probe only under full preconditions', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.shouldProbeThreadLimit('APPROVE', true, false, 42, GH926_REPO, 2), true);
        assert.equal(mod.shouldProbeThreadLimit('REQUEST_CHANGES', true, false, 42, GH926_REPO, 2), false);
        assert.equal(mod.shouldProbeThreadLimit('APPROVE', false, false, 42, GH926_REPO, 2), false);
        assert.equal(mod.shouldProbeThreadLimit('APPROVE', true, true, 42, GH926_REPO, 2), false);
        assert.equal(mod.shouldProbeThreadLimit('APPROVE', true, false, null, GH926_REPO, 2), false);
        assert.equal(mod.shouldProbeThreadLimit('APPROVE', true, false, 42, null, 2), false);
        assert.equal(mod.shouldProbeThreadLimit('APPROVE', true, false, 42, GH926_REPO, 0), false);
        assert.equal(mod.shouldProbeThreadLimit('APPROVE', true, false, 42, GH926_REPO, undefined), false);

        assert.equal(mod.maxThreadLimitOf({ maxReviewThreadsBeforeForceApprove: 5 }), 5);
        assert.equal(mod.maxThreadLimitOf({}), 0);
        assert.equal(mod.maxThreadLimitOf(undefined), 0);
    });

    test('resolveFormalReviewEnabled: per-run flag beats project default beats off', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.resolveFormalReviewEnabled({ formalGithubReview: true }, {}), true);
        assert.equal(mod.resolveFormalReviewEnabled({ formalGithubReview: false }, { formalGithubReview: true }), false);
        assert.equal(mod.resolveFormalReviewEnabled({}, { formalGithubReview: true }), true);
        assert.equal(mod.resolveFormalReviewEnabled(undefined, { formalGithubReview: true }), true);
        assert.equal(mod.resolveFormalReviewEnabled(undefined, {}), false);
    });

    test('parseLinkedIssueNumber: closes/fixes/resolves, case-insensitive, null otherwise', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.parseLinkedIssueNumber('ci: fix\ncloses #12'), 12);
        assert.equal(mod.parseLinkedIssueNumber('Fixes #7'), 7);
        assert.equal(mod.parseLinkedIssueNumber('resolves #99 later'), 99);
        assert.equal(mod.parseLinkedIssueNumber('no refs here'), null);
        assert.equal(mod.parseLinkedIssueNumber(''), null);
        assert.equal(mod.parseLinkedIssueNumber(null), null);
    });

    test('resolveWipLabel: contextId-prefixed when present, default otherwise', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.resolveWipLabel({ metadata: { contextId: 'pr_review' } }), 'pr_review_wip');
        assert.equal(mod.resolveWipLabel({ metadata: { contextId: 'custom_review' } }), 'custom_review_wip');
        assert.equal(mod.resolveWipLabel({ metadata: {} }), 'pr_review_wip');
        assert.equal(mod.resolveWipLabel({}), 'pr_review_wip');
    });

    test('buildBitriseEnvVars: copies configured envVars, appends TICKET_KEY, PR_URL only with a URL', function() {
        var mod = loadPostPRReviewComments();
        var bb = { envVars: [{ mapped_to: 'X', value: '1', is_expand: true }] };

        var withUrl = mod.buildBitriseEnvVars(bb, 'PROJ-1', 'https://example.com/pull/1');
        assert.equal(withUrl.length, 3);
        assert.deepEqual(withUrl[0], { mapped_to: 'X', value: '1', is_expand: true });
        assert.deepEqual(withUrl[1], { mapped_to: 'TICKET_KEY', value: 'PROJ-1', is_expand: false });
        assert.deepEqual(withUrl[2], { mapped_to: 'PR_URL', value: 'https://example.com/pull/1', is_expand: false });
        assert.equal(bb.envVars.length, 1, 'the configured list is copied, not mutated');

        var noUrl = mod.buildBitriseEnvVars(bb, 'PROJ-1', null);
        assert.equal(noUrl.length, 2);

        var noConfigured = mod.buildBitriseEnvVars({}, 'PROJ-1', null);
        assert.equal(noConfigured.length, 1);
    });

    test('resolveBitriseBranch: PR branch → configured branch → develop', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.resolveBitriseBranch({ branch: 'main' }, 'feat/x'), 'feat/x');
        assert.equal(mod.resolveBitriseBranch({ branch: 'main' }, null), 'main');
        assert.equal(mod.resolveBitriseBranch({}, null), 'develop');
        assert.equal(mod.resolveBitriseBranch({}, 'feat/x'), 'feat/x');
    });

    test('resolveTestCasesGeneratorRepo: aiRepository beats config.repository', function() {
        var mod = loadPostPRReviewComments();

        assert.deepEqual(
            mod.resolveTestCasesGeneratorRepo({ aiRepository: { owner: 'a', repo: 'b' } }, { repository: { owner: 'c', repo: 'd' } }),
            { owner: 'a', repo: 'b' }
        );
        assert.deepEqual(
            mod.resolveTestCasesGeneratorRepo({}, { repository: { owner: 'c', repo: 'd' } }),
            { owner: 'c', repo: 'd' }
        );
        assert.deepEqual(
            mod.resolveTestCasesGeneratorRepo({}, {}),
            { owner: undefined, repo: undefined }
        );
        assert.deepEqual(
            mod.resolveTestCasesGeneratorRepo(undefined, {}),
            { owner: undefined, repo: undefined }
        );
    });

    test('hasLabel + ticketLabels', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.hasLabel(['a', 'b'], 'b'), true);
        assert.equal(mod.hasLabel(['a'], 'b'), false);
        assert.equal(mod.hasLabel(undefined, 'b'), false);

        assert.deepEqual(mod.ticketLabels({ fields: { labels: ['x'] } }), ['x']);
        assert.deepEqual(mod.ticketLabels({ fields: {} }), []);
        assert.deepEqual(mod.ticketLabels({}), []);
        assert.deepEqual(mod.ticketLabels(null), []);
    });

    test('parseGitHubRemoteUrl: https and ssh forms, garbage → null', function() {
        var mod = loadPostPRReviewComments();

        assert.deepEqual(mod.parseGitHubRemoteUrl('https://github.com/acme/repo.git\nScript done\n'), { owner: 'acme', repo: 'repo' });
        assert.deepEqual(mod.parseGitHubRemoteUrl('git@github.com:acme/other.git\n'), { owner: 'acme', repo: 'other' });
        assert.equal(mod.parseGitHubRemoteUrl('not a remote\n'), null);
        assert.equal(mod.parseGitHubRemoteUrl(''), null);
    });

    test('buildResumePrompt: names the ticket and the mandatory outputs', function() {
        var mod = loadPostPRReviewComments();
        var prompt = mod.buildResumePrompt('PROJ-1');

        assert.contains(prompt, 'PROJ-1');
        assert.contains(prompt, 'outputs/pr_review.json');
        assert.contains(prompt, 'outputs/pr_review_general.md');
        assert.contains(prompt, 'Do NOT write outputs/response.md');
    });
});

suite('postPRReviewComments — gh-926 searchMissingPRNumber / ticketKeyOfParams', function() {

    test('ticketKeyOfParams: null params, missing ticket, key passthrough', function() {
        var mod = loadPostPRReviewComments();

        assert.equal(mod.ticketKeyOfParams(null), null);
        assert.equal(mod.ticketKeyOfParams({}), null);
        assert.equal(mod.ticketKeyOfParams({ ticket: null }), null);
        assert.equal(mod.ticketKeyOfParams({ ticket: { key: 'PROJ-1' } }), 'PROJ-1');
    });

    test('searchMissingPRNumber: existing PR number wins, no GitHub search', function() {
        var h = loadForPrSearch({ number: 99, html_url: 'https://example.com/pull/99', head: { ref: 'other' } });
        var pr = { number: 7, url: null, branch: null };

        h.mod.searchMissingPRNumber({}, {}, 'PROJ-1', pr, { owner: 'a', repo: 'b' });

        assert.equal(pr.number, 7);
        assert.equal(h.searchCalls.length, 0, 'no search when the PR number is already known');
    });

    test('searchMissingPRNumber: without repo info it leaves the PR empty and does not search', function() {
        var h = loadForPrSearch({ number: 99, html_url: 'https://example.com/pull/99', head: { ref: 'other' } });
        var pr = { number: null, url: null, branch: null };

        h.mod.searchMissingPRNumber({}, {}, 'PROJ-1', pr, null);

        assert.equal(pr.number, null);
        assert.equal(pr.url, null);
        assert.equal(h.searchCalls.length, 0, 'no search without repo info');
    });

    test('searchMissingPRNumber: applies the PR found via GitHub search', function() {
        var found = { number: 42, html_url: 'https://example.com/pull/42', head: { ref: 'bug/PROJ-1' } };
        var h = loadForPrSearch(found);
        var pr = { number: null, url: null, branch: null };

        h.mod.searchMissingPRNumber({}, {}, 'PROJ-1', pr, { owner: 'a', repo: 'b' });

        assert.equal(pr.number, 42);
        assert.equal(pr.url, 'https://example.com/pull/42');
        assert.equal(pr.branch, 'bug/PROJ-1');
        assert.equal(h.searchCalls.length, 1);
        assert.equal(h.searchCalls[0].ticketKey, 'PROJ-1');
    });

    test('searchMissingPRNumber: leaves the PR empty when the search finds nothing', function() {
        var h = loadForPrSearch(null);
        var pr = { number: null, url: null, branch: null };

        h.mod.searchMissingPRNumber({}, {}, 'PROJ-1', pr, { owner: 'a', repo: 'b' });

        assert.equal(pr.number, null);
        assert.equal(h.searchCalls.length, 1);
    });
});

/**
 * Loads js/postPRReviewComments.js with a controllable
 * githubHelpers.findPRForTicket so searchMissingPRNumber can be exercised
 * directly (the shared githubHelpersStub always returns null).
 */
function loadForPrSearch(foundPr) {
    var searchCalls = [];
    var ghMock = {
        findPRForTicket: function(scm, ticketKey, options) {
            searchCalls.push({ ticketKey: ticketKey, options: options });
            return foundPr;
        },
        findMergedPRForTicket: function() { return null; }
    };
    var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
        './common/commentMarkup.js': commentMarkupModule
    }), {
        file_read: function() { return null; }
    });
    var mod = loadModule(
        'js/postPRReviewComments.js',
        makeRequire({
            './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
            './common/machineAuthor.js': machineAuthorModule,
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './configLoader.js': configLoaderModule,
            './common/outputFiles.js': outputFiles,
            './common/githubHelpers.js': ghMock,
            './common/trackers.js': makeTrackersModule({}),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/commentMarkup.js': commentMarkupModule,
            './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
            './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {})
        }),
        {
            file_read: function() { return null; }
        }
    );
    return { mod: mod, searchCalls: searchCalls };
}

suite('postPRReviewComments — gh-1053 spec-claim guard wiring', function () {
    function mapReadingFileRead(fileMap) {
        return function (opts) {
            var p = opts && (opts.path || opts);
            if (fileMap[p] !== undefined) return fileMap[p];
            if (p && p.indexOf('.dmtools/config') !== -1) return null;
            return null;
        };
    }

    function loadWithFileMap(fileMap, writes) {
        return loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': prReviewOutputFiles(mapReadingFileRead(fileMap))
            })),
            {
                // Comment-file reads in this suite flow through the outputFiles
                // instance's own file_read (see prReviewOutputFiles above); the
                // module-level file_read is never exercised here, so keep it
                // trivially simple (a branchy mock trips the CRAP ratchet on
                // near-zero coverage).
                file_read: function () { return null; },
                file_write: function (opts) {
                    writes.push(opts);
                }
            }
        );
    }

    test('applySpecClaimDowngrades rewrites a file-referenced uncited spec claim before posting', function () {
        var fileMap = {
            'outputs/pr_review_comments/f1.md':
                '🚨 BLOCKING: the spec says only *_MAX_TOKENS is exempt — this PR exempts more.'
        };
        var writes = [];
        var mod = loadWithFileMap(fileMap, writes);
        var reviewData = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/env.js', line: 10, comment: 'outputs/pr_review_comments/f1.md' }
            ]
        };
        var result = mod.applySpecClaimDowngrades(reviewData, 'TICKET-1', null);
        assert.equal(result.downgrades, 1, 'one downgrade applied');
        assert.equal(writes.length, 1, 'comment file rewritten');
        assert.ok(writes[0].content.indexOf('\uD83D\uDEA8') === -1, 'no 🚨 in rewritten file');
        assert.ok(writes[0].content.indexOf('\u26A0') !== -1, '⚠ in rewritten file');
        assert.equal(reviewData.issueCounts.blocking, 0, 'census drained');
        assert.equal(reviewData.recommendation, 'APPROVE', 'verdict collapsed to APPROVE');
    });

    test('applySpecClaimDowngrades leaves cited blocking findings untouched', function () {
        var writes = [];
        var mod = loadWithFileMap({}, writes);
        var reviewData = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/env.js', line: 40, severity: 'BLOCKING', body: '🚨 BLOCKING: deviation from the spec (Policy.java:61-66).' }
            ]
        };
        var result = mod.applySpecClaimDowngrades(reviewData, 'TICKET-1', null);
        assert.equal(result.downgrades, 0);
        assert.equal(writes.length, 0, 'nothing rewritten');
        assert.equal(reviewData.recommendation, 'REQUEST_CHANGES');
        assert.equal(reviewData.issueCounts.blocking, 1);
    });
});

suite('postPRReviewComments.readPRInfoMarkdown — input folder chain', function () {

    // Serves pr_info.md from one folder only; every other path misses the way file_read does.
    function prInfoOnlyIn(folder, reads) {
        return function (args) {
            var p = args && (args.path || args);
            reads.push(p);
            if (p === folder + '/pr_info.md') return '**Branch**: `ai/gh-5` → `main`';
            throw new Error('File does not exist: ' + p);
        };
    }

    test('an explicit inputFolderPath wins', function () {
        var reads = [];
        var mod = loadPostPRReviewComments({ file_read: prInfoOnlyIn('/work/input/gh-5', reads) });

        assert.ok(mod.readPRInfoMarkdown('/work/input/gh-5', 'acme/widgets#5'));
        assert.equal(reads.length, 1, 'no further candidate is read');
    });

    test('derives input/gh-N for a GitHub key when no inputFolderPath is passed (Java runtime)', function () {
        var reads = [];
        var mod = loadPostPRReviewComments({ file_read: prInfoOnlyIn('input/gh-5', reads) });

        assert.ok(mod.readPRInfoMarkdown(undefined, 'acme/widgets#5'));
        assert.equal(reads[0], 'input/gh-5/pr_info.md');
    });

    test('falls back to the legacy input/<ticketKey> (Dart runtime, older runtimes)', function () {
        var reads = [];
        var mod = loadPostPRReviewComments({ file_read: prInfoOnlyIn('input/acme/widgets#5', reads) });

        assert.ok(mod.readPRInfoMarkdown(undefined, 'acme/widgets#5'));
        assert.deepEqual(reads, ['input/gh-5/pr_info.md', 'input/acme/widgets#5/pr_info.md']);
    });

    test('an explicit folder without pr_info.md still falls through the chain', function () {
        var reads = [];
        var mod = loadPostPRReviewComments({ file_read: prInfoOnlyIn('input/PROJ-1', reads) });

        assert.ok(mod.readPRInfoMarkdown('/work/input/elsewhere', 'PROJ-1'));
        assert.deepEqual(reads, ['/work/input/elsewhere/pr_info.md', 'input/PROJ-1/pr_info.md']);
    });

    test('null when no candidate holds pr_info.md', function () {
        var mod = loadPostPRReviewComments({ file_read: prInfoOnlyIn('input/nowhere', []) });

        assert.equal(mod.readPRInfoMarkdown(undefined, 'acme/widgets#5'), null);
    });
});

// ── gh-1230 CRAP characterization: post-PR-review fixture factories ──────────

suite('postPRReviewComments — fixture factories (gh-1230 characterization)', function() {

    test('prInfoFileRead: pr_info.md path serves opts content or the default, others null', function() {
        var fr = prInfoFileRead({ prInfoContent: '- **PR #**: 7\n' }, 'default-info');
        assert.equal(fr({ path: 'input/PROJ-1/pr_info.md' }), '- **PR #**: 7\n');
        assert.equal(fr('input/PROJ-1/pr_info.md'), '- **PR #**: 7\n', 'string-arg shape');
        assert.equal(fr({ path: 'outputs/other.md' }), null);
        var frDefault = prInfoFileRead({}, 'default-info');
        assert.equal(frDefault({ path: 'input/PROJ-1/pr_info.md' }), 'default-info');
        assert.equal(frDefault({ path: 'outputs/other.md' }), null, 'non-pr_info paths give null');
    });

    test('actionScmStub: openPrs default and override, repoInfo default null and override, addLabel records', function() {
        var labels = [];
        var scm = actionScmStub({}, labels);
        assert.deepEqual(scm.listPrs(), []);
        assert.equal(scm.getRemoteRepoInfo(), null);
        scm.addLabel(42, 'sm_pr_rework_triggered');
        assert.deepEqual(labels, [{ number: 42, label: 'sm_pr_rework_triggered' }]);
        assert.deepEqual(scm.fetchDiscussions(), { rawThreads: { threads: [] } });

        var labels2 = [];
        var scm2 = actionScmStub({ openPrs: [{ number: 9 }], repoInfo: { owner: 'o', repo: 'r' } }, labels2);
        assert.deepEqual(scm2.listPrs(), [{ number: 9 }]);
        assert.deepEqual(scm2.getRemoteRepoInfo(), { owner: 'o', repo: 'r' });
    });

    test('actionOutputFilesStub: readOutputFileDetailed serves reviewData, readOutputFile null', function() {
        var m = actionOutputFilesStub({ reviewData: { recommendation: 'APPROVE' } });
        assert.deepEqual(m.readOutputFileDetailed(), { content: '{"recommendation":"APPROVE"}', path: 'outputs/pr_review.json' });
        assert.equal(m.readOutputFile(), null);
    });

    test('actionJiraMocks: label/status/comment recorders capture args', function() {
        var labels = [], moves = [], comments = [];
        var mocks = actionJiraMocks(labels, moves, comments, {});
        mocks.jira_add_label({ label: 'a' });
        mocks.jira_move_to_status({ status: 's' });
        mocks.jira_post_comment({ body: 'c' });
        mocks.jira_remove_label({});
        mocks.jira_assign_ticket_to();
        assert.deepEqual(labels, [{ label: 'a' }]);
        assert.deepEqual(moves, [{ status: 's' }]);
        assert.deepEqual(comments, [{ body: 'c' }]);
        assert.equal(typeof mocks.file_read, 'function');
    });

    test('actionAutoStartStub: workflow trigger off, SM trigger recorded', function() {
        var triggers = [];
        var auto = actionAutoStartStub(triggers);
        assert.equal(auto.triggerConfiguredWorkflowForTicket(), false);
        auto.triggerSmIfIdle({ key: 'PROJ-1' });
        assert.deepEqual(triggers, [{ key: 'PROJ-1' }]);
    });

    test('configLoaderStub: project config default empty and override', function() {
        assert.deepEqual(configLoaderStub({}).loadProjectConfig(), {});
        assert.deepEqual(configLoaderStub({ config: { formalGithubReview: true } }).loadProjectConfig(), { formalGithubReview: true });
        assert.deepEqual(configLoaderStub({}).resolveInstructions(), { jobParamPatch: {} });
    });

    test('formalScmStub: default repoInfo, review submission and dismissal recorders, listReviews', function() {
        var sinks = { addLabelCalls: [], submitReviewCalls: [], dismissReviewCalls: [] };
        var scm = formalScmStub({}, sinks);
        assert.deepEqual(scm.getRemoteRepoInfo(), { owner: 'IstiN', repo: 'dmtools-agents' });
        assert.deepEqual(scm.listPrs(), []);
        assert.deepEqual(scm.listReviews(), []);
        scm.addLabel(42, 'pr_approved');
        scm.submitReview(42, 'APPROVE', 'nice');
        scm.dismissReview(42, 3, 'stale');
        assert.deepEqual(sinks.addLabelCalls, [{ prId: 42, label: 'pr_approved' }]);
        assert.deepEqual(sinks.submitReviewCalls, [{ prId: 42, event: 'APPROVE', body: 'nice' }]);
        assert.deepEqual(sinks.dismissReviewCalls, [{ prId: 42, reviewId: 3, message: 'stale' }]);
        scm.removeLabel();
        assert.deepEqual(scm.fetchDiscussions(), { rawThreads: { threads: [] } });

        var sinks2 = { addLabelCalls: [], submitReviewCalls: [], dismissReviewCalls: [] };
        var scm2 = formalScmStub({ openPrs: [{ number: 5 }], repoInfo: null, existingReviews: [{ id: 1 }] }, sinks2);
        assert.equal(scm2.getRemoteRepoInfo(), null, 'explicit null repoInfo override honoured');
        assert.deepEqual(scm2.listPrs(), [{ number: 5 }]);
        assert.deepEqual(scm2.listReviews(), [{ id: 1 }]);
    });

    test('formalOutputFilesStub: general markdown served only for the pr_review_general.md path', function() {
        var m = formalOutputFilesStub({ reviewData: { recommendation: 'APPROVE' }, generalMdContent: '# general' });
        assert.deepEqual(m.readOutputFileDetailed(), { content: '{"recommendation":"APPROVE"}', path: 'outputs/pr_review.json' });
        assert.equal(m.readOutputFile('pr_review_general.md'), '# general');
        assert.equal(m.readOutputFile('pr_review_response.md'), null);
        var mNoGeneral = formalOutputFilesStub({ reviewData: {} });
        assert.equal(mNoGeneral.readOutputFile('pr_review_general.md'), null);
        var mNoPath = formalOutputFilesStub({ reviewData: {}, generalMdContent: '# general' });
        assert.equal(mNoPath.readOutputFile(), null, 'undefined path gives null');
    });

    test('formalJiraMocks: pr_info default, github_get_pr body default and override', function() {
        var mocks = formalJiraMocks({});
        assert.contains(mocks.file_read({ path: 'x/pr_info.md' }), '- **PR #**: 42');
        assert.equal(mocks.file_read({ path: 'x/other.md' }), null);
        assert.deepEqual(JSON.parse(mocks.github_get_pr()), { body: '' });
        var mocks2 = formalJiraMocks({ prInfoContent: 'custom info', githubPrBody: 'closes #7' });
        assert.equal(mocks2.file_read({ path: 'x/pr_info.md' }), 'custom info');
        assert.deepEqual(JSON.parse(mocks2.github_get_pr()), { body: 'closes #7' });
        mocks2.jira_add_label({});
        mocks2.jira_move_to_status({});
        mocks2.jira_post_comment({});
        mocks2.jira_remove_label({});
        mocks2.jira_assign_ticket_to();
    });
});
