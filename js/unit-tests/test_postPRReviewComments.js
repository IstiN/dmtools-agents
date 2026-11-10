/**
 * Unit tests for js/postPRReviewComments.js.
 */
var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var machineAuthorModule = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
// gh-1351: the real reviewPolicy module (for the legacy-knob audit assertions).
var reviewPolicyModule = loadModule('js/common/reviewPolicy.js',
    makeRequire({
        './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js',
            makeRequire({ './machineAuthor.js': machineAuthorModule }), {})
    }), {});


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
 * Shared loader for js/common/reviewSpecClaims.js — the module now requires
 * ./findingRegistry.js (gh-1334 claim normalization in the registry's own
 * style), so every map entry resolves that collaborator the same way.
 */
function loadSpecClaimsWithRegistry() {
    return loadModule('js/common/reviewSpecClaims.js', makeRequire({
        './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
            './machineAuthor.js': machineAuthorReal(),
            './reviewVerdicts.js': reviewVerdictsReal()
        }))
    }), {});
}

/**
 * Shared loader for js/common/reviewPolicy.js (gh-1351) — a pure module
 * whose only collaborator is reviewVerdicts (the censusCount normalization).
 */
function loadReviewPolicyModule() {
    return loadModule('js/common/reviewPolicy.js',
        makeRequire({ './reviewVerdicts.js': reviewVerdictsReal() }), {});
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
        './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
        './config.js': configModule,
        './common/scm.js': { createScm: function() { return {}; } },
        './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
        './configLoader.js': configLoaderModule,
        './common/githubHelpers.js': githubHelpersStub,
        './common/trackers.js': makeTrackersModule({}),
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/commentMarkup.js': commentMarkupModule,
        './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
        './common/reviewPolicy.js': loadReviewPolicyModule(),
        './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
            './machineAuthor.js': machineAuthorReal(),
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {})
        }), {}),
        './common/reviewSpecClaims.js': loadSpecClaimsWithRegistry(),
        './common/reviewFilter.js': loadReviewFilterModule(),
        './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js'),
    };
    return Object.assign(map, overrides || {});
}

/**
 * Shared loader for js/common/reviewFilter.js (gh-1403) — the pure filter
 * leg over the real reviewPolicy + reviewVerdicts + reviewSpecClaims.
 */
function loadReviewFilterModule() {
    return loadModule('js/common/reviewFilter.js', makeRequire({
        './reviewPolicy.js': loadReviewPolicyModule(),
        './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
        './reviewSpecClaims.js': loadSpecClaimsWithRegistry()
    }), {});
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
            './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
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
                    './common/reviewPolicy.js': loadReviewPolicyModule(),
                    './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({ './machineAuthor.js': machineAuthorReal(), './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}) }), {}),
                    './common/reviewSpecClaims.js': loadSpecClaimsWithRegistry(),
                    './common/reviewFilter.js': loadReviewFilterModule(),
                    './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js'),
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
            './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
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
                    './common/reviewPolicy.js': loadReviewPolicyModule(),
                    './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({ './machineAuthor.js': machineAuthorReal(), './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}) }), {}),
                    './common/reviewSpecClaims.js': loadSpecClaimsWithRegistry(),
                    './common/reviewFilter.js': loadReviewFilterModule(),
                    './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js'),
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
            './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
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
            './common/reviewPolicy.js': loadReviewPolicyModule(),
            './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({ './machineAuthor.js': machineAuthorReal(), './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}) }), {}),
            './common/reviewSpecClaims.js': loadSpecClaimsWithRegistry(),
            './common/reviewFilter.js': loadReviewFilterModule(),
            './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js'),
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
    test('gh-1350: the verdict record stamps nits/digest from the normalized census', function() {
        var mod = makeMod({});
        withGlobals(mod, function() {
            mod.postVerdictRecord(mod.__testHarness.scm,
                { owner: 'epam', repo: 'dmtools-dart' }, 1428, true, 'APPROVE',
                { blocking: 0, important: 1, suggestions: 2, nits: 3, digest: 4 });
        });
        var body = mod.__testHarness.addedComments[0].body;
        assert.contains(body, '"nits":3');
        assert.contains(body, '"digest":4');
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

    // gh-1351 machine-enforcement capture: the policy audits are LOG lines
    // (legacy-knob conflicts, density overflow) — capture what the wrapped
    // action() run emitted so tests can assert on them without scraping the
    // whole suite log.
    var capture = { lines: [], active: false };
    var harness = {
        mod: mod,
        ops: ops,
        conflicts: [],
        warnings: [],
        opNames: function() { return ops.map(function(o) { return o.op; }); },
        opsOf: function(op) { return ops.filter(function(o) { return o.op === op; }); }
    };
    harness = gh926AttachLogCapture(harness, mod, capture);
    return harness;
}

// Wraps console.warn/console.log during one action() call and files the
// captured lines into harness.conflicts ('reviewPolicy:' audit lines) and
// harness.warnings ('density audit' lines). The wrappers are installed once
// per harness; the runner's real console still receives everything.
function gh926AttachLogCapture(harness, mod, capture) {
    var realWarn = console.warn;
    var realLog = console.log;
    var captureLine = function(line) {
        if (!capture.active) return;
        capture.lines.push(String(line));
    };
    console.warn = function(msg) { captureLine(msg); return realWarn(msg); };
    console.log = function(msg) { captureLine(msg); return realLog(msg); };
    var rawAction = mod.action;
    mod.action = function(params) {
        capture.lines = [];
        capture.active = true;
        try {
            return rawAction(params);
        } finally {
            capture.active = false;
            harness.conflicts = capture.lines.filter(function(l) { return l.indexOf('reviewPolicy:') !== -1; });
            harness.warnings = capture.lines.filter(function(l) { return l.indexOf('density audit') !== -1; });
        }
    };
    return harness;
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
            './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
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
            './common/reviewPolicy.js': loadReviewPolicyModule(),
            './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({ './machineAuthor.js': machineAuthorReal(), './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}) }), {}),
            './common/reviewSpecClaims.js': loadSpecClaimsWithRegistry(),
            './common/reviewFilter.js': loadReviewFilterModule(),
            './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js'),
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

    test('suggestions-only APPROVE with no knobs: the policy approves (allowApproveWithSuggestions is policy-derived)', function() {
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
        assert.equal(result.message, 'PR approved — awaiting reviewer merge',
            'the resolved policy decides — only rework-tier (🚨/⚠️) threads gate approval');
        assert.equal(result.recommendation, 'APPROVE', 'the effective verdict is the machine verdict');
        assert.equal(result.advisoryRecommendation, 'APPROVE', 'the advisory token is carried for audit');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"APPROVE"');
        assert.deepEqual(
            h.opsOf('jira.addLabel').map(function(o) { return o.label; }),
            ['pr_approved', 'ai_pr_reviewed'],
            'no rework markers on approval'
        );
        var summary = h.opsOf('jira.postComment').map(function(o) { return o.comment; }).join('\n');
        assert.contains(summary, 'Review Policy (built-in default, preset default)',
            'the policy table is stamped into the review summary — the rework run context traces the verdict to the policy');
        assert.contains(summary, '| Severity | Round |', 'the table itself rides the summary');
    });

    test('IMPORTANT gates approval (gh-1351): allowApproveWithSuggestions cannot approve an open ⚠️', function() {
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

        assert.equal(result.message, 'Changes requested, ticket returned to In Development',
            'an open IMPORTANT thread gates approval per the policy — the legacy knob is not honored');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"REQUEST_CHANGES"',
            'the record stamps the recomputed verdict, not the advisory token');
        assert.equal(h.opsOf('jira.moveToStatus').length, 1, 'rework runs');
        assert.equal(h.opsOf('scm.addLabel').filter(function(o) { return o.label === 'pr_approved'; }).length, 0,
            'an important-gated approve must NOT arm the merge pipeline');
    });

    test('suggestions-only APPROVE with the legacy knob true stays approved (knob honored — no 🚨/⚠️ open)', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 2 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        var result = h.mod.action(gh926ActionParams({ customParams: { allowApproveWithSuggestions: true } }));

        assert.equal(result.message, 'PR approved — awaiting reviewer merge',
            'only 💡/🪶 open → APPROVE (the knob is honored when no rework-tier thread is open)');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"APPROVE"');
        assert.ok(h.opsOf('scm.addLabel').some(function(o) { return o.label === 'pr_approved'; }));
    });

    test('legacy knob conflict: allowApproveWithSuggestions=false + suggestion-only census → policy wins, conflict logged', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 3 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        var result = h.mod.action(gh926ActionParams({ customParams: { allowApproveWithSuggestions: false } }));

        assert.equal(result.message, 'PR approved — awaiting reviewer merge',
            'the resolved policy decides — only rework-tier threads gate approval');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"APPROVE"');
        assert.ok(h.conflicts.some(function(line) {
            return line.indexOf('allowApproveWithSuggestions=false') !== -1 &&
                line.indexOf('policy wins') !== -1;
        }), 'the knob conflict is logged: got ' + JSON.stringify(h.conflicts));
    });

    test('convergence: REQUEST_CHANGES token over a rework-tier-clean census recomputes to APPROVE', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'REQUEST_CHANGES',
                issueCounts: { blocking: 0, important: 0, suggestions: 1, nits: 1 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.message, 'PR approved — awaiting reviewer merge',
            'a suggestion-only cycle must converge — the machine recomputes');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"APPROVE"',
            'the record stamps the recomputed APPROVE');
        assert.ok(h.opsOf('scm.addLabel').some(function(o) { return o.label === 'pr_approved'; }));
    });

    test('BLOCK passes through: the machine never upgrades a security/data-loss call', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'BLOCK',
                issueCounts: { blocking: 0, important: 0, suggestions: 0 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.message, 'Changes requested, ticket returned to In Development');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"BLOCK"');
    });

    test('investigation policy (explicit config): blocking census does not gate approval', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 1, important: 1 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            config: { reviewPolicy: { preset: 'investigation' } }
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.message, 'PR approved — awaiting reviewer merge',
            'every tier is round none in investigation — the config IS the owner standing approval');
        assert.contains(h.opsOf('scm.addComment')[0].body, '"verdict":"APPROVE"');
    });

    test('malformed policy config fails the leg with a validation message', function() {
        var h = loadReviewActionHarness({
            reviewData: GH926_CLEAN_APPROVE,
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            config: { reviewPolicy: { severities: { TRIVIAL: { round: 'none', fix: 'never' } } } }
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.success, false, 'the leg fails loudly');
        assert.contains(result.error, 'TRIVIAL', 'the validation message names the unknown tier');
        assert.deepEqual(h.opNames(), ['jira.postComment'], 'no side effects before validation');
    });

    test('machine enforcement recomputes verdicts from census + policy; the census cross-check still fires first', function() {
        // Posted inline BLOCKING severity + census blocking 0: the gh-1350
        // cross-check overrides the token to REQUEST_CHANGES; the machine
        // verdict keeps it (gating census 0, but the posted evidence wins).
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 0 },
                inlineComments: [
                    { path: 'src/a.js', line: 1, severity: 'BLOCKING', body: 'it breaks' }
                ]
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.message, 'Changes requested, ticket returned to In Development');
        assert.contains(
            h.opsOf('scm.addComment').map(function(o) { return o.body; }).join('\n---\n'),
            '"verdict":"REQUEST_CHANGES"',
            'the record rides the same addComment stream as the fallback inline post'
        );
    });

    test('density audit: over-posted 💡 threads warn (never fail the leg)', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 10 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            githubPr: { number: 42, head: { sha: 'sha0000' }, additions: 50 }
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.success, true, 'the audit is warn-only');
        assert.ok(h.warnings.some(function(line) {
            return line.indexOf('density audit') !== -1 && line.indexOf('allows 4') !== -1;
        }), 'the density overflow warns with the allowed cap: ' + JSON.stringify(h.warnings));
    });

    test('density audit: within the cap stays silent', function() {
        var h = loadReviewActionHarness({
            reviewData: {
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 1 },
                inlineComments: []
            },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42,
            githubPr: { number: 42, head: { sha: 'sha0000' }, additions: 1000 }
        });

        var result = h.mod.action(gh926ActionParams({}));

        assert.equal(result.success, true);
        assert.equal(h.warnings.filter(function(line) { return line.indexOf('density audit') !== -1; }).length, 0);
    });

    test('dispatch-race guard (legacy valve retired): the policy owns thread budgets — approval is census-driven', function() {
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

        assert.equal(result.message, 'PR approved — awaiting reviewer merge',
            'the census is rework-tier clean → approved without any legacy valve');
        assert.ok(h.conflicts.some(function(line) {
            return line.indexOf('maxReviewThreadsBeforeForceApprove') !== -1;
        }), 'the rejected legacy knob is logged: ' + JSON.stringify(h.conflicts));
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
            ['ai_pr_reviewed', 'rework-round-1'],
            'no sm_story_rework_triggered / agent:rework when the configured workflow started'
        );
        assert.equal(h.opsOf('autoStart.triggerSmIfIdle').length, 0, 'SM not triggered when the workflow started');
    });

    test('autoStartRework trigger that does not start falls back to SM rework without burning a round', function() {
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

    test('autoStartRework stamps rework-round-1 on the first auto rework', function() {
        var h = loadReviewActionHarness({
            reviewData: { recommendation: 'REQUEST_CHANGES', issueCounts: { blocking: 1, important: 0, suggestions: 0 }, inlineComments: [] },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });
        h.mod.action(gh926ActionParams({
            customParams: { autoStartRework: true, autoStartReworkConfigFile: 'agents/pr_rework.json' }
        }));
        assert.equal(h.opsOf('autoStart.triggerConfiguredWorkflowForTicket').length, 1);
        assert.deepEqual(h.opsOf('jira.addLabel').map(function(o) { return o.label; }), ['ai_pr_reviewed', 'rework-round-1']);
    });

    test('autoStartRework is capped: at maxAutoReworkRounds the ticket gets needs-human and nothing is chained', function() {
        var h = loadReviewActionHarness({
            reviewData: { recommendation: 'REQUEST_CHANGES', issueCounts: { blocking: 1, important: 0, suggestions: 0 }, inlineComments: [] },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });
        h.mod.action(gh926ActionParams({
            ticketLabels: ['rework-round-1', 'rework-round-2'],
            customParams: { autoStartRework: true, autoStartReworkConfigFile: 'agents/pr_rework.json', maxAutoReworkRounds: 2 }
        }));
        assert.equal(h.opsOf('autoStart.triggerConfiguredWorkflowForTicket').length, 0);
        assert.equal(h.opsOf('autoStart.triggerSmIfIdle').length, 0, 'no SM fallback either');
        assert.deepEqual(h.opsOf('jira.addLabel').map(function(o) { return o.label; }), ['ai_pr_reviewed', 'needs-human']);
    });

    test('autoStartRework is skipped while the ticket has needs-human', function() {
        var h = loadReviewActionHarness({
            reviewData: { recommendation: 'REQUEST_CHANGES', issueCounts: { blocking: 1, important: 0, suggestions: 0 }, inlineComments: [] },
            repoInfo: GH926_REPO,
            prInfoContent: GH926_PR_INFO_42
        });
        h.mod.action(gh926ActionParams({
            ticketLabels: ['needs-human'],
            customParams: { autoStartRework: true, autoStartReworkConfigFile: 'agents/pr_rework.json' }
        }));
        assert.equal(h.opsOf('autoStart.triggerConfiguredWorkflowForTicket').length, 0);
        assert.deepEqual(h.opsOf('jira.addLabel').map(function(o) { return o.label; }), ['ai_pr_reviewed']);
    });

    test('reworkRoundOf picks the highest rework-round-N label', function() {
        var mod = loadReviewActionHarness({ reviewData: GH926_CLEAN_APPROVE, repoInfo: GH926_REPO, prInfoContent: GH926_PR_INFO_42 }).mod;
        assert.equal(mod.reworkRoundOf(['x', 'rework-round-2', 'rework-round-10', 'rework-round-x']), 10);
        assert.equal(mod.reworkRoundOf([]), 0);
    });

    test('maxAutoReworkRoundsOf warns and falls back to default 3 on 0 or non-numeric values', function() {
        var mod = loadReviewActionHarness({ reviewData: GH926_CLEAN_APPROVE, repoInfo: GH926_REPO, prInfoContent: GH926_PR_INFO_42 }).mod;
        assert.equal(mod.maxAutoReworkRoundsOf({}), 3);
        assert.equal(mod.maxAutoReworkRoundsOf({ maxAutoReworkRounds: 5 }), 5);
        assert.equal(mod.maxAutoReworkRoundsOf({ maxAutoReworkRounds: 0 }), 3);
        assert.equal(mod.maxAutoReworkRoundsOf({ maxAutoReworkRounds: -1 }), 3);
        assert.equal(mod.maxAutoReworkRoundsOf({ maxAutoReworkRounds: 'invalid' }), 3);
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
                issueCounts: { blocking: 1, important: 0, suggestions: 0 },
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
            './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
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
            './common/reviewPolicy.js': loadReviewPolicyModule(),
            './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
                './machineAuthor.js': machineAuthorReal(),
                './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js',
                    makeRequire({ './machineAuthor.js': machineAuthorReal() }), {})
            }), {}),
            './common/reviewSpecClaims.js': loadSpecClaimsWithRegistry(),
            './common/reviewFilter.js': loadReviewFilterModule(),
            './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js'),
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
        './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
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
        './common/reviewPolicy.js': loadReviewPolicyModule(),
        './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({ './machineAuthor.js': machineAuthorReal(), './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}) }), {}),
        './common/reviewSpecClaims.js': loadSpecClaimsWithRegistry(),
        './common/reviewFilter.js': loadReviewFilterModule(),
        './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js'),
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

        assert.deepEqual(mod.normalizeIssueCounts({}),
            { blocking: 0, important: 0, suggestions: 0, nits: 0, digest: 0 });
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

    // gh-1351: the force-approve probe is GONE — the legacy
    // `maxReviewThreadsBeforeForceApprove` knob is rejected alongside the
    // resolved policy (the audit logs the conflict, the policy wins).
    test('legacy maxReviewThreadsBeforeForceApprove is rejected alongside the policy (audit line)', function() {
        loadPostPRReviewComments();
        var audit = reviewPolicyModule.legacyKnobAudit({ maxReviewThreadsBeforeForceApprove: 2 });
        assert.equal(audit.lines.length, 1, 'exactly the rejection line');
        assert.contains(audit.lines[0], 'maxReviewThreadsBeforeForceApprove=2 is rejected alongside the policy');
        assert.contains(audit.lines[0], 'densityMax=8');
    });

    test('gh926ScmReadMocks defaults and overrides cover every branch', function() {
        var empty = gh926ScmReadMocks({});
        assert.deepEqual(empty.listPrs(), []);
        assert.equal(empty.getRemoteRepoInfo(), null);
        assert.deepEqual(empty.fetchDiscussions().rawThreads.threads, []);
        assert.deepEqual(empty.listReviews(), []);

        var full = gh926ScmReadMocks({
            openPrs: [{ number: 7 }],
            repoInfo: { owner: 'o', repo: 'r' },
            threads: [{ id: 't1' }],
            existingReviews: [{ id: 'r1' }]
        });
        assert.deepEqual(full.listPrs(), [{ number: 7 }]);
        assert.deepEqual(full.getRemoteRepoInfo(), { owner: 'o', repo: 'r' });
        assert.deepEqual(full.fetchDiscussions().rawThreads.threads, [{ id: 't1' }]);
        assert.deepEqual(full.listReviews(), [{ id: 'r1' }]);
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

    test('buildResumePrompt: names the ticket, mandatory outputs, and file-path contracts', function() {
        var mod = loadPostPRReviewComments();
        var prompt = mod.buildResumePrompt('PROJ-1');

        assert.contains(prompt, 'PROJ-1');
        assert.contains(prompt, 'outputs/pr_review.json');
        assert.contains(prompt, '"generalComment" field MUST be the file path string "outputs/pr_review_general.md"');
        assert.contains(prompt, '"outputs/pr_review_comments/<name>.md"');
        assert.contains(prompt, 'Do NOT write outputs/response.md');
    });

    test('postGeneralComment: posts inline markdown when generalComment holds prose instead of a file path', function() {
        var posted = [];
        var scm = {
            addComment: function(prId, body) { posted.push({ prId: prId, body: body }); }
        };
        var mod = loadPostPRReviewComments();

        var inlineMd = '## Review summary — MAPC-8930\n\n**Recommendation: approve.**';
        var ok = mod.postGeneralComment(scm, 1280, inlineMd, 'MAPC-8930', 'dependencies/PostNL-commercial-mobileApp');
        assert.equal(ok, true);
        assert.equal(posted.length, 1);
        assert.equal(posted[0].prId, 1280);
        assert.equal(posted[0].body, inlineMd);
    });

    test('postGeneralComment: falls back to outputs/pr_review_general.md when a file-path reference is missing', function() {
        var posted = [];
        var scm = {
            addComment: function(prId, body) { posted.push({ prId: prId, body: body }); }
        };
        var mod = loadPostPRReviewComments({
            file_read: function(args) {
                var p = args && (args.path || args);
                if (p === 'dependencies/PostNL-commercial-mobileApp/outputs/pr_review_general.md') {
                    return '## Summary from default general file';
                }
                return null;
            }
        });

        var ok = mod.postGeneralComment(scm, 1280, 'outputs/missing_summary.md', 'MAPC-8930', 'dependencies/PostNL-commercial-mobileApp');
        assert.equal(ok, true);
        assert.equal(posted.length, 1);
        assert.equal(posted[0].body, '## Summary from default general file');
    });

    test('postInlineComment: resolves relative subpath pr_review_comments/<name>.md under workingDir/outputs', function() {
        var inlinePosted = [];
        var scm = {
            getPrDiff: function() {
                return 'diff --git a/scripts/unused-files-check.sh b/scripts/unused-files-check.sh\n' +
                    '--- a/scripts/unused-files-check.sh\n' +
                    '+++ b/scripts/unused-files-check.sh\n' +
                    '@@ -30,3 +30,4 @@\n' +
                    ' line30\n' +
                    ' line31\n' +
                    '+line32\n' +
                    ' line33\n';
            },
            addInlineComment: function(prId, path, line, body, startLine, side) {
                inlinePosted.push({ prId: prId, path: path, line: line, body: body, side: side });
            }
        };
        var mod = loadPostPRReviewComments({
            file_read: function(args) {
                var p = args && (args.path || args);
                if (p === 'dependencies/PostNL-commercial-mobileApp/outputs/pr_review_comments/unused-files-check-fail-open.md') {
                    return '⚠️ **IMPORTANT: Guard exits 0 on error**\nFix the exit code.';
                }
                return null;
            }
        });

        var ok = mod.postInlineComment(
            scm,
            1280,
            {
                path: 'scripts/unused-files-check.sh',
                line: 32,
                side: 'RIGHT',
                severity: 'IMPORTANT',
                comment: 'pr_review_comments/unused-files-check-fail-open.md'
            },
            'MAPC-8930',
            'dependencies/PostNL-commercial-mobileApp'
        );
        assert.equal(ok, true);
        assert.equal(inlinePosted.length, 1);
        assert.equal(inlinePosted[0].path, 'scripts/unused-files-check.sh');
        assert.equal(inlinePosted[0].line, 32);
        assert.contains(inlinePosted[0].body, 'Guard exits 0 on error');
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
            './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
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
            './common/reviewPolicy.js': loadReviewPolicyModule(),
            './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({ './machineAuthor.js': machineAuthorReal(), './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}) }), {}),
            './common/reviewSpecClaims.js': loadSpecClaimsWithRegistry(),
            './common/reviewFilter.js': loadReviewFilterModule(),
            './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js'),
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

suite('postPRReviewComments — gh-1287 cross-anchor label stripping on PR-anchored reviews', function() {

    function loadWithPrMock(prObj) {
        var fileRead = function() { return null; };
        return loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': prReviewOutputFiles(fileRead)
            })),
            {
                file_read: fileRead,
                github_get_pr: function() {
                    if (typeof prObj === 'function') return prObj();
                    return JSON.stringify(prObj);
                }
            }
        );
    }

    test('parseBranchIssueNumber and linkedIssueNumberFromPR fall back to branch when PR body has no closing keyword', function() {
        var mod = loadWithPrMock({ number: 1940, body: 'No keyword here', head: { ref: 'ai/gh-1931' } });

        assert.equal(mod.parseBranchIssueNumber('ai/gh-1931'), 1931);
        assert.equal(mod.parseBranchIssueNumber('feature/gh-0042-fix'), 42);
        assert.equal(mod.parseBranchIssueNumber('main'), null);
        assert.equal(mod.parseBranchIssueNumber(null), null);

        assert.equal(mod.linkedIssueNumberFromPR({ owner: 'IstiN', repo: 'fa' }, 1940, 'main'), 1931);

        var modNoHead = loadWithPrMock({ number: 1940, body: '' });
        assert.equal(modNoHead.linkedIssueNumberFromPR({ owner: 'IstiN', repo: 'fa' }, 1940, 'ai/gh-1935'), 1935);
    });

    test('stripLinkedIssueArmLabels and cleanLinkedIssueArmsOnApproval strip stale agent:review and agent:rework on linked issue', function() {
        var removed = [];
        var added = [];
        var scm = {
            addLabel: function(num, label) { added.push({ num: num, label: label }); },
            removeLabel: function(num, label) { removed.push({ num: num, label: label }); }
        };
        var mod = loadWithPrMock({ number: 1940, body: 'Closes #1931', head: { ref: 'ai/gh-1931' } });

        mod.stripLinkedIssueArmLabels(scm, null, true);
        assert.equal(removed.length, 0);

        var ctx = { scm: scm, machineAuthor: 'IstiN' };
        var pr = { number: 1940, author: 'IstiN', branch: 'ai/gh-1931' };
        var repoInfo = { owner: 'IstiN', repo: 'fa' };

        // Non-approved PR-anchored review: strips agent:review from PR and linked issue, adds agent:rework to linked issue
        mod.finishPRAnchoredReview(ctx, pr, repoInfo, false, 'REQUEST_CHANGES');
        assert.deepEqual(removed, [
            { num: 1940, label: 'agent:review' },
            { num: 1931, label: 'agent:review' }
        ]);
        assert.ok(added.some(function(c) { return c.num === 1931 && c.label === 'agent:rework'; }));

        // Approved PR-anchored review: strips agent:review from PR and both agent:review + agent:rework from linked issue
        removed.length = 0;
        added.length = 0;
        mod.finishPRAnchoredReview(ctx, pr, repoInfo, true, 'APPROVE');
        assert.deepEqual(removed, [
            { num: 1940, label: 'agent:review' },
            { num: 1931, label: 'agent:review' },
            { num: 1931, label: 'agent:rework' }
        ]);
        assert.ok(!added.some(function(c) { return c.label === 'agent:rework'; }));

        // Guest author: does not touch linked issue on approval
        removed.length = 0;
        mod.cleanLinkedIssueArmsOnApproval(ctx, { number: 1940, author: 'external-guest' }, repoInfo);
        assert.equal(removed.length, 0);

        // Error tolerance in cleanLinkedIssueArmsOnApproval
        var modThrows = loadWithPrMock(function() { throw new Error('github_get_pr failed'); });
        modThrows.cleanLinkedIssueArmsOnApproval(ctx, pr, repoInfo);
    });
});

suite('postPRReviewComments — gh-1332 finding-identity registry', function() {

    var REGISTRY_PREFIX = '<!-- dmtools:finding-registry ';

    function sinks() { return { comments: [], labels: [] }; }

    function registryCommentOf(findings, round, at) {
        var fr = loadModule('js/common/findingRegistry.js', makeRequire({
            './machineAuthor.js': machineAuthorReal(),
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js',
                makeRequire({ './machineAuthor.js': machineAuthorReal() }), {})
        }), {});
        var policy = fr.resolveIdentityPolicy({}, null);
        var outcome = fr.applyRound(null, { at: at, round: round, findings: findings }, policy);
        return fr.buildRegistryComment(Object.assign(outcome.registry, { at: at }));
    }

    function registryScm(opts, sinks) {
        return {
            getPrComments: function() {
                if (opts.commentsError) throw new Error(opts.commentsError);
                return opts.prComments || [];
            },
            addComment: function(prId, body) { sinks.comments.push({ prId: prId, body: body }); },
            addLabel: function(prId, label) { sinks.labels.push({ prId: prId, label: label }); }
        };
    }

    function registryCtx(opts, scm) {
        return {
            ticketKey: 'gh-1332',
            workingDir: null,
            customParams: opts.customParams || {},
            config: opts.config || {},
            machineAuthor: opts.machineAuthor === undefined ? 'ai-teammate' : opts.machineAuthor,
            scm: scm
        };
    }

    suite('findingsFromReviewData', function() {

        test('maps path/file inline bodies and comment-file references to claims', function() {
            var fileMap = {
                'outputs/pr_review_comments/c2.md': '🚨 **BLOCKING: token validation**\n\nThe token is never validated.'
            };
            var mod = loadPostPRReviewComments({ file_read: function(args) {
                var p = args && (args.path || args);
                return fileMap[p] !== undefined ? fileMap[p] : null;
            } });
            var findings = mod.findingsFromReviewData({
                inlineComments: [
                    { path: 'src/auth.ts', line: 45, severity: 'BLOCKING', body: 'nothing validates a token' },
                    { file: 'src/api.ts', line: 12, severity: 'IMPORTANT', comment: 'outputs/pr_review_comments/c2.md' },
                    { path: 'src/ui.ts', line: 3, severity: 'SUGGESTION', body: '   ' }
                ]
            }, 'gh-1332', null);
            assert.equal(findings.length, 2, 'blank claims are skipped');
            assert.equal(findings[0].file, 'src/auth.ts');
            assert.equal(findings[0].claim, 'nothing validates a token');
            assert.equal(findings[0].severity, 'BLOCKING');
            assert.equal(findings[0].line, 45);
            assert.equal(findings[1].file, 'src/api.ts');
            assert.contains(findings[1].claim, 'token validation', 'the comment file content is the claim');
        });

        test('no inlineComments → empty list', function() {
            var mod = loadPostPRReviewComments();
            assert.deepEqual(mod.findingsFromReviewData({}, 'gh-1332', null), []);
            assert.deepEqual(mod.findingsFromReviewData({ inlineComments: [] }, 'gh-1332', null), []);
        });
    });

    suite('findingReviewOf', function() {

        test('passes through validated dispositions and confirmations; absent → empty', function() {
            var mod = loadPostPRReviewComments();
            assert.deepEqual(mod.findingReviewOf({}), { dispositions: [], confirmations: [] });
            var block = mod.findingReviewOf({
                findingReview: {
                    dispositions: [{ n: 1, status: 'fixed', hunk: 'src/auth.ts:40-48' }],
                    confirmations: [{ proposedFor: 1, same: true }]
                }
            });
            assert.equal(block.dispositions.length, 1);
            assert.equal(block.confirmations.length, 1);
            assert.deepEqual(mod.findingReviewOf({ findingReview: 'garbage' }), { dispositions: [], confirmations: [] });
            assert.deepEqual(mod.findingReviewOf({ findingReview: { dispositions: 'nope' } }).dispositions, []);
        });
    });

    suite('stampFindingRegistry', function() {

        function policyOf() { return frHelper().resolveIdentityPolicy({}, null); }

        function frHelper() {
            return loadModule('js/common/findingRegistry.js', makeRequire({
                './machineAuthor.js': machineAuthorReal(),
                './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js',
                    makeRequire({ './machineAuthor.js': machineAuthorReal() }), {})
            }), {});
        }

        function roundInputOf(mod, reviewData, findingReview) {
            var block = findingReview || { dispositions: [], confirmations: [] };
            return {
                at: '2026-11-03T12:00:00Z',
                findings: mod.findingsFromReviewData(reviewData, 'gh-1332', null),
                dispositions: block.dispositions || [],
                confirmations: block.confirmations || []
            };
        }

        test('round 1: posts the registry marker and the review-round-1 label', function() {
            var mod = loadPostPRReviewComments();
            var sk = sinks();
            var scm = registryScm({}, sk);
            var outcome = mod.stampFindingRegistry(scm, 1428, [],
                roundInputOf(mod, { inlineComments: [
                    { path: 'src/auth.ts', line: 45, severity: 'BLOCKING', body: 'nothing validates a token' },
                    { path: 'src/api.ts', line: 12, severity: 'IMPORTANT', body: 'retry swallows the timeout error' }
                ] }), policyOf(), ['ai-teammate']);
            assert.ok(outcome, 'the round acted');
            assert.equal(outcome.round, 1);
            assert.equal(outcome.newIdentities.length, 2);
            assert.equal(sk.comments.length, 1, 'one registry marker comment');
            assert.contains(sk.comments[0].body, REGISTRY_PREFIX);
            assert.deepEqual(sk.labels, [{ prId: 1428, label: 'review-round-1' }]);
        });

        test('round 2 revert replay: the same claims auto-merge, F1 is re-introduced, no new identities', function() {
            var mod = loadPostPRReviewComments();
            var round1Body = registryCommentOf([
                { file: 'src/auth.ts', claim: 'nothing validates a token', severity: 'BLOCKING', line: 45 },
                { file: 'src/api.ts', claim: 'retry swallows the timeout error', severity: 'IMPORTANT', line: 12 }
            ], 1, '2026-11-03T10:00:00Z');
            var prComments = [{ body: round1Body, user: { login: 'ai-teammate' } }];
            var sk = sinks();
            var scm = registryScm({ prComments: prComments }, sk);
            var outcome = mod.stampFindingRegistry(scm, 1428, prComments,
                roundInputOf(mod, { inlineComments: [
                    { path: 'src/auth.ts', line: 77, severity: 'BLOCKING', body: 'nothing validates a token' },
                    { path: 'src/api.ts', line: 30, severity: 'IMPORTANT', body: 'retry swallows the timeout error' }
                ] }), policyOf(), ['ai-teammate']);
            assert.ok(outcome);
            assert.equal(outcome.round, 2, 'the round count comes from the previous registry');
            assert.equal(outcome.newIdentities.length, 0, 'zero duplicate threads');
            assert.equal(outcome.autoMerged.length, 2);
            assert.equal(outcome.registry.items[0].status, 're-introduced');
            assert.deepEqual(sk.labels, [{ prId: 1428, label: 'review-round-2' }]);
        });

        test('a forged previous registry is invisible — the round stays 1', function() {
            var mod = loadPostPRReviewComments();
            var round1Body = registryCommentOf([
                { file: 'src/auth.ts', claim: 'nothing validates a token', severity: 'BLOCKING', line: 45 }
            ], 1, '2026-11-03T10:00:00Z');
            var prComments = [{ body: round1Body, user: { login: 'random-user' } }];
            var sk = sinks();
            var scm = registryScm({ prComments: prComments }, sk);
            var outcome = mod.stampFindingRegistry(scm, 1428, prComments,
                roundInputOf(mod, { inlineComments: [
                    { path: 'src/auth.ts', line: 45, severity: 'BLOCKING', body: 'nothing validates a token' }
                ] }), policyOf(), ['ai-teammate']);
            assert.equal(outcome.round, 1, 'machine-author-gated markers only');
            assert.equal(outcome.newIdentities.length, 1);
        });

        test('dispositions and confirmations ride through roundInput', function() {
            var mod = loadPostPRReviewComments();
            var round1Body = registryCommentOf([
                { file: 'src/auth.ts', claim: 'nothing validates a token', severity: 'BLOCKING', line: 45 }
            ], 1, '2026-11-03T10:00:00Z');
            var prComments = [{ body: round1Body, user: { login: 'ai-teammate' } }];
            var outcome = mod.stampFindingRegistry(
                registryScm({ prComments: prComments }, sinks()), 1428, prComments,
                roundInputOf(mod, { inlineComments: [] }, {
                    dispositions: [{ n: 1, status: 'withdrawn', reason: 'claim was wrong' }]
                }), policyOf(), ['ai-teammate']);
            assert.equal(outcome.registry.items[0].status, 'withdrawn', 'the reviewer disposes');
        });

        test('no findings and no findingReview on a fresh PR → no-op (no marker spam)', function() {
            var mod = loadPostPRReviewComments();
            var sk = sinks();
            var outcome = mod.stampFindingRegistry(registryScm({}, sk), 1428, [],
                roundInputOf(mod, { inlineComments: [] }), policyOf(), ['ai-teammate']);
            assert.equal(outcome, null);
            assert.equal(sk.comments.length, 0);
        });

        test('comment read failure is non-fatal (degrades to stateless)', function() {
            var mod = loadPostPRReviewComments();
            var sk = sinks();
            var outcome = mod.stampFindingRegistry(registryScm({ commentsError: 'boom' }, sk), 1428, null,
                roundInputOf(mod, { inlineComments: [
                    { path: 'src/auth.ts', line: 45, severity: 'BLOCKING', body: 'nothing validates a token' }
                ] }), policyOf(), ['ai-teammate']);
            assert.equal(outcome, null, 'no registry update without the previous state');
            assert.equal(sk.comments.length, 0);
        });

        test('stampFindingRegistry handles a provider without getPrComments', function() {
            var mod = loadPostPRReviewComments();
            var outcome = mod.stampFindingRegistry({ addComment: function() {}, addLabel: function() {} }, 1428, null,
                roundInputOf(mod, { inlineComments: [
                    { path: 'src/auth.ts', line: 45, severity: 'BLOCKING', body: 'nothing validates a token' }
                ] }), policyOf(), []);
            assert.equal(outcome, null, 'no comment listing → no trusted registry → no stamp');
        });
    });

    suite('postFindingRegistryUpdate (wired step)', function() {

        test('end-to-end: fetch comments, resolve policy from customParams, stamp, label', function() {
            var mod = loadPostPRReviewComments();
            var sk = sinks();
            var scm = registryScm({}, sk);
            var ctx = registryCtx({
                customParams: { reviewPolicy: { identity: { candidateScope: 'diff' } } }
            }, scm);
            var outcome = mod.postFindingRegistryUpdate(ctx, { number: 1428 }, {
                inlineComments: [{ path: 'src/auth.ts', line: 45, severity: 'BLOCKING', body: 'nothing validates a token' }]
            });
            assert.ok(outcome);
            assert.equal(sk.labels[0].label, 'review-round-1');
        });

        test('no findings → silent no-op', function() {
            var mod = loadPostPRReviewComments();
            var sk = sinks();
            var outcome = mod.postFindingRegistryUpdate(registryCtx({}, registryScm({}, sk)),
                { number: 1428 }, { inlineComments: [] });
            assert.equal(outcome, null);
            assert.equal(sk.comments.length, 0);
        });

        test('scm explosion is non-fatal for the whole review action', function() {
            var mod = loadPostPRReviewComments();
            var outcome = mod.postFindingRegistryUpdate(registryCtx({}, registryScm({ commentsError: 'kaboom' }, sinks())),
                { number: 1428 }, {
                    inlineComments: [{ path: 'src/auth.ts', line: 45, severity: 'BLOCKING', body: 'x' }]
                });
            assert.equal(outcome, null);
        });
    });
});

suite('postPRReviewComments — gh-1334 ticket-grounded spec-claim verification wiring', function () {
    var TICKET_MD = [
        '# Login service requirements',
        '',
        'Invalid login attempts must return HTTP 401 with a structured error body.',
        ''
    ].join('\n');

    function trueClaimReview() {
        return {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/auth.js', line: 12, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: According to the ticket, invalid login must return 401.' }
            ]
        };
    }

    // Serves only the exact paths in the map; everything else misses like file_read.
    function mapFileRead(fileMap) {
        return function (args) {
            var p = args && (args.path || args);
            if (fileMap[p] !== undefined) return fileMap[p];
            if (p && p.indexOf('.dmtools/config') !== -1) return null;
            return null;
        };
    }

    function loadWithModuleFileRead(fileMap, writes) {
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: mapFileRead(fileMap) });
        return loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles
            })),
            {
                file_read: mapFileRead(fileMap),
                file_write: function (opts) { writes.push(opts); }
            }
        );
    }

    test('applySpecClaimDowngrades reads input/<folder>/ticket.md and keeps a verified claim BLOCKING', function () {
        var writes = [];
        var mod = loadWithModuleFileRead({ 'input/TICKET-1/ticket.md': TICKET_MD }, writes);
        var review = trueClaimReview();
        var result = mod.applySpecClaimDowngrades(review, 'TICKET-1', null, 'input/TICKET-1');
        assert.equal(result.downgrades, 0, 'no demotion — requirement verifiably in the ticket');
        assert.equal(result.citations.length, 1);
        assert.equal(result.citations[0].citation, 'ticket.md:3');
        assert.equal(review.inlineComments[0].severity, 'BLOCKING');
        assert.ok(review.inlineComments[0].body.indexOf('ticket.md:3') !== -1, 'citation auto-appended');
        assert.equal(review.issueCounts.blocking, 1, 'census untouched');
        assert.equal(review.recommendation, 'REQUEST_CHANGES');
    });

    test('falls back to request.md when the folder holds no ticket.md', function () {
        var writes = [];
        var mod = loadWithModuleFileRead({ 'input/TICKET-1/request.md': TICKET_MD }, writes);
        var result = mod.applySpecClaimDowngrades(trueClaimReview(), 'TICKET-1', null, 'input/TICKET-1');
        assert.equal(result.downgrades, 0);
        assert.equal(result.citations[0].citation, 'request.md:3');
    });

    test('no ticket text anywhere → today\'s demotion + inconclusive provenance', function () {
        var writes = [];
        var mod = loadWithModuleFileRead({}, writes);
        var review = trueClaimReview();
        var result = mod.applySpecClaimDowngrades(review, 'TICKET-1', null, 'input/TICKET-1');
        assert.equal(result.downgrades, 1, 'ticket unavailable → demote as today');
        assert.equal(result.demotions[0].claimMatchedTicket, 'inconclusive');
        assert.ok(review.inlineComments[0].body.indexOf('dmtools:demoted-from-BLOCKING') !== -1);
        assert.ok(review.inlineComments[0].demotion);
    });

    test('ticket.md is searched across the input-folder candidate chain', function () {
        var writes = [];
        // GitHub composite key: input/gh-5 is the Java-runtime folder name.
        var mod = loadWithModuleFileRead({ 'input/gh-5/ticket.md': TICKET_MD }, writes);
        var review = trueClaimReview();
        var result = mod.applySpecClaimDowngrades(review, 'acme/widgets#5', null, null);
        assert.equal(result.downgrades, 0);
        assert.equal(result.citations[0].citation, 'ticket.md:3');
    });

    test('demotion provenance rides from the sanitized entry into the registry findings', function () {
        var mod = loadWithModuleFileRead({}, []);
        var reviewData = {
            recommendation: 'APPROVE',
            inlineComments: [
                { path: 'src/env.js', line: 1, severity: 'IMPORTANT',
                  demotion: { reason: 'missing-citation', claimMatchedTicket: 'no' },
                  body: '🚨 BLOCKING: According to the ticket, audit logs must be kept for 7 years.\n' +
                        '---\n⚠️ **Severity demoted: unverified external-spec claim (gh-1053)** — please confirm.\n' +
                        '<!-- dmtools:demoted-from-BLOCKING {"reason":"missing-citation","claimMatchedTicket":"no"} -->'
                }
            ]
        };
        var findings = mod.findingsFromReviewData(reviewData, 'TICKET-1', null);
        assert.equal(findings.length, 1);
        assert.deepEqual(findings[0].demotion, { reason: 'missing-citation', claimMatchedTicket: 'no' },
            'the registry item records the provenance');
        assert.ok(findings[0].claim.indexOf('dmtools:demoted-from-BLOCKING') === -1,
            'the machine marker is not part of the registry claim');
        assert.ok(findings[0].claim.indexOf('Severity demoted') === -1,
            'the machine confirm-note is not part of the registry claim');
        assert.ok(findings[0].claim.indexOf('audit logs must be kept') !== -1,
            'the reviewer\'s own claim text is preserved');
    });

    test('a clean claim keeps its full text as the registry claim', function () {
        var mod = loadWithModuleFileRead({}, []);
        var reviewData = {
            recommendation: 'REQUEST_CHANGES',
            inlineComments: [
                { path: 'src/a.js', line: 2, severity: 'BLOCKING', body: 'null deref on empty input.' }
            ]
        };
        var findings = mod.findingsFromReviewData(reviewData, 'TICKET-1', null);
        assert.equal(findings[0].claim, 'null deref on empty input.');
        assert.equal(findings[0].demotion, null);
    });

    test('a reviewer claim with a markdown horizontal rule keeps its full text (gh-1334 rework)', function () {
        var mod = loadWithModuleFileRead({}, []);
        var body = 'null deref on empty input.\n' +
            '---\n' +
            'Same defect hits the batch path for empty arrays.';
        var reviewData = {
            recommendation: 'REQUEST_CHANGES',
            inlineComments: [
                { path: 'src/a.js', line: 2, severity: 'BLOCKING', body: body }
            ]
        };
        var findings = mod.findingsFromReviewData(reviewData, 'TICKET-1', null);
        assert.equal(findings[0].claim, body,
            'a reviewer-authored rule is prose — nothing after it is truncated');
        assert.equal(findings[0].claim.indexOf('batch path for empty arrays') !== -1, true,
            'the paragraph after the rule stays in the registry identity');
    });

    test('the machine demotion tail is cut exactly — prose before it stays intact (gh-1334 rework)', function () {
        var mod = loadWithModuleFileRead({}, []);
        var claim = 'According to the ticket, audit logs must be kept for 7 years.';
        var reviewData = {
            recommendation: 'APPROVE',
            inlineComments: [
                { path: 'src/env.js', line: 1, severity: 'IMPORTANT',
                  demotion: { reason: 'missing-citation', claimMatchedTicket: 'no' },
                  body: claim + '\n' +
                        '---\n' +
                        '\u26A0\uFE0F **Severity demoted: unverified external-spec claim (gh-1053)** \u2014 please confirm.\n' +
                        '<!-- dmtools:demoted-from-BLOCKING {"reason":"missing-citation","claimMatchedTicket":"no"} -->'
                }
            ]
        };
        var findings = mod.findingsFromReviewData(reviewData, 'TICKET-1', null);
        assert.equal(findings[0].claim, claim,
            'the registry claim is exactly the reviewer text — no separator, no note, no marker');
        assert.deepEqual(findings[0].demotion, { reason: 'missing-citation', claimMatchedTicket: 'no' });
    });
});

// ═════════════════════════════════════════════════════════════════════════
// gh-1350 (epic gh-1328 step 1/4) — review-marker integrity:
//   - machine-stamped severity prefixes on posted inline threads (built
//     from the structured JSON severity field, never the comment prose);
//   - census cross-check at verdict processing: a posted BLOCKING severity
//     with issueCounts.blocking == 0 overrides the verdict;
//   - census normalization: singular/plural suggestion spellings, nits +
//     digest plumbed into the verdict record.
// ═════════════════════════════════════════════════════════════════════════

suite('postPRReviewComments — machine-stamped severity markers (gh-1350)', function() {
    // Minimal anchored-diff scm recorder (the poster needs the line in the diff).
    function stampScm(calls) {
        return {
            getPrDiff: function() {
                return 'diff --git a/src/a.js b/src/a.js\n' +
                    'index 1111111..2222222 100644\n' +
                    '--- a/src/a.js\n' +
                    '+++ b/src/a.js\n' +
                    '@@ -1,2 +1,3 @@\n' +
                    ' context\n' +
                    '+target line\n' +
                    ' more context\n';
            },
            addInlineComment: function(prId, path, line, text, startLine, side) {
                calls.push({ path: path, line: line, text: text, side: side });
            },
            addComment: function(prId, text) {
                calls.push({ fallback: true, text: text });
            }
        };
    }

    test('AC1 corruption replay: prose 🚨 severity: none + JSON IMPORTANT posts ⚠️ severity: IMPORTANT', function() {
        var mod = loadPostPRReviewComments();
        var calls = [];
        mod.postInlineComment(stampScm(calls), 9, {
            path: 'src/a.js', line: 2, severity: 'IMPORTANT',
            body: '\uD83D\uDEA8 severity: NONE \u2014\nthe agent claims this is fine'
        }, 'PROJ-1', null);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].text,
            '\u26A0\uFE0F severity: IMPORTANT \u2014\nthe agent claims this is fine',
            'exactly ONE severity line — machine-stamped from the JSON field; ' +
            'the corrupted severity prose never reaches the PR');
    });

    test('each structured severity stamps its canonical line', function() {
        var mod = loadPostPRReviewComments();
        var calls = [];
        var scm = stampScm(calls);
        mod.postInlineComment(scm, 9, { path: 'src/a.js', line: 2, severity: 'BLOCKING', body: 'broken' }, 'PROJ-1', null);
        mod.postInlineComment(scm, 9, { path: 'src/a.js', line: 2, severity: 'SUGGESTION', body: 'rename' }, 'PROJ-1', null);
        mod.postInlineComment(scm, 9, { path: 'src/a.js', line: 2, severity: 'important', body: 'debt' }, 'PROJ-1', null);

        assert.ok(calls[0].text.indexOf('\uD83D\uDEA8 severity: BLOCKING \u2014\nbroken') === 0);
        assert.ok(calls[1].text.indexOf('\uD83D\uDCA1 severity: SUGGESTION \u2014\nrename') === 0);
        assert.ok(calls[2].text.indexOf('\u26A0\uFE0F severity: IMPORTANT \u2014\ndebt') === 0,
            'severity casing normalizes');
    });

    test('no (or unrecognized) severity → the body posts verbatim, no stamp', function() {
        var mod = loadPostPRReviewComments();
        var calls = [];
        var scm = stampScm(calls);
        mod.postInlineComment(scm, 9, { path: 'src/a.js', line: 2, body: 'plain note' }, 'PROJ-1', null);
        mod.postInlineComment(scm, 9, { path: 'src/a.js', line: 2, severity: 'TRIVIAL', body: 'unknown prose' }, 'PROJ-1', null);

        assert.equal(calls.length, 2, 'both comment bodies post (the stamp never blocks a post)');
        assert.equal(calls[0].text, 'plain note');
        assert.equal(calls[1].text, 'unknown prose',
            'unknown severities stamp nothing');
    });

    test('NIT severity stamps the 🪶 canonical line (gh-1351 4-tier enum)', function() {
        var mod = loadPostPRReviewComments();
        var calls = [];
        var scm = stampScm(calls);
        mod.postInlineComment(scm, 9, { path: 'src/a.js', line: 2, severity: 'NIT', body: 'nit prose' }, 'PROJ-1', null);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].text, '\uD83E\uDEB6 severity: NIT \u2014\nnit prose');
    });

    test('an existing leading canonical line is replaced, not duplicated (idempotent stamp)', function() {
        var mod = loadPostPRReviewComments();
        var calls = [];
        mod.postInlineComment(stampScm(calls), 9, {
            path: 'src/a.js', line: 2, severity: 'BLOCKING',
            body: '\uD83D\uDCA1 severity: SUGGESTION \u2014\nprose that lied about severity'
        }, 'PROJ-1', null);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].text,
            '\uD83D\uDEA8 severity: BLOCKING \u2014\nprose that lied about severity',
            'exactly one canonical line — the machine one, from the JSON severity');
    });

    test('the fallback PR comment carries the stamp too (line not in diff)', function() {
        var mod = loadPostPRReviewComments();
        var calls = [];
        var scm = stampScm(calls);
        scm.getPrDiff = function() { return ''; };
        mod.postInlineComment(scm, 9, {
            path: 'src/gone.js', line: 42, severity: 'BLOCKING', body: 'broken'
        }, 'PROJ-1', null);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].fallback, true);
        assert.ok(calls[0].text.indexOf('\uD83D\uDEA8 severity: BLOCKING \u2014\nbroken') !== -1);
    });

    test('the registry claim is NOT stamped (findings keep the reviewer text)', function() {
        var mod = loadPostPRReviewComments();
        var findings = mod.findingsFromReviewData({
            inlineComments: [{ path: 'src/a.js', line: 2, severity: 'IMPORTANT', body: 'debt here' }]
        }, 'PROJ-1', null);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].claim, 'debt here',
            'the severity stamp is a posting-path concern only');
    });
});

suite('postPRReviewComments — census cross-check (gh-1350)', function() {
    function reviewData(severity, counts) {
        return {
            recommendation: 'APPROVE',
            inlineComments: severity ? [{ path: 'src/a.js', line: 2, severity: severity, body: 'x' }] : [],
            issueCounts: counts || { blocking: 0, important: 0, suggestions: 0 }
        };
    }

    test('AC2: posted inline BLOCKING + issueCounts.blocking == 0 overrides to REQUEST_CHANGES', function() {
        var mod = loadPostPRReviewComments();
        var out = mod.censusCrossCheckOverride(reviewData('BLOCKING'), 'APPROVE',
            mod.normalizeIssueCounts(reviewData('BLOCKING')));
        assert.equal(out.overridden, true);
        assert.equal(out.recommendation, 'REQUEST_CHANGES');
    });

    test('blocking census already counts the thread → no override', function() {
        var mod = loadPostPRReviewComments();
        var out = mod.censusCrossCheckOverride(reviewData('BLOCKING'), 'APPROVE',
            mod.normalizeIssueCounts({ issueCounts: { blocking: 1 } }));
        assert.equal(out.overridden, false);
        assert.equal(out.recommendation, 'APPROVE');
    });

    test('lowercase severities count; non-blocking severities never override', function() {
        var mod = loadPostPRReviewComments();
        assert.equal(mod.censusCrossCheckOverride(reviewData('blocking'), 'APPROVE',
            mod.normalizeIssueCounts(reviewData('blocking'))).overridden, true);
        assert.equal(mod.censusCrossCheckOverride(reviewData('IMPORTANT'), 'APPROVE',
            mod.normalizeIssueCounts(reviewData('IMPORTANT'))).overridden, false);
        assert.equal(mod.censusCrossCheckOverride(reviewData('SUGGESTION'), 'APPROVE',
            mod.normalizeIssueCounts(reviewData('SUGGESTION'))).overridden, false);
    });

    test('several inline comments: one BLOCKING among many overrides (multi-item case)', function() {
        var mod = loadPostPRReviewComments();
        var data = {
            recommendation: 'APPROVE',
            inlineComments: [
                { path: 'src/a.js', line: 1, severity: 'SUGGESTION', body: 'a' },
                { path: 'src/b.js', line: 2, severity: 'IMPORTANT', body: 'b' },
                { path: 'src/c.js', line: 3, severity: 'BLOCKING', body: 'c' }
            ],
            issueCounts: { blocking: 0, important: 0, suggestions: 0 }
        };
        var out = mod.censusCrossCheckOverride(data, 'APPROVE', mod.normalizeIssueCounts(data));
        assert.equal(out.overridden, true);
        assert.equal(out.recommendation, 'REQUEST_CHANGES');
    });

    test('no inline comments / empty severities / malformed data → no override', function() {
        var mod = loadPostPRReviewComments();
        assert.equal(mod.censusCrossCheckOverride(reviewData(null), 'APPROVE',
            mod.normalizeIssueCounts(reviewData(null))).overridden, false);
        assert.equal(mod.censusCrossCheckOverride(
            { recommendation: 'APPROVE', inlineComments: [{ path: 'a', line: 1 }] }, 'APPROVE',
            { blocking: 0, important: 0, suggestions: 0 }).overridden, false);
        assert.equal(mod.censusCrossCheckOverride(null, 'APPROVE',
            mod.normalizeIssueCounts({})).overridden, false);
    });

    test('a non-approving verdict is left alone (nothing to override)', function() {
        var mod = loadPostPRReviewComments();
        var out = mod.censusCrossCheckOverride(reviewData('BLOCKING'), 'REQUEST_CHANGES',
            mod.normalizeIssueCounts(reviewData('BLOCKING')));
        assert.equal(out.overridden, false);
        assert.equal(out.recommendation, 'REQUEST_CHANGES');
    });

    test('the override warning is loud and names both sides of the mismatch', function() {
        var mod = loadPostPRReviewComments();
        var warning = mod.buildCensusCrossCheckWarning(
            mod.normalizeIssueCounts(reviewData('BLOCKING')));
        assert.contains(warning, 'BLOCKING');
        assert.contains(warning, 'blocking=0');
        assert.contains(warning, 'REQUEST_CHANGES');
    });
});

suite('postPRReviewComments — census normalization + nit plumbing (gh-1350)', function() {
    test('AC4: {"suggestion": 2} and {"suggestions": 2} normalize to the identical census', function() {
        var mod = loadPostPRReviewComments();
        var singular = mod.normalizeIssueCounts({ issueCounts: { suggestion: 2 } });
        var plural = mod.normalizeIssueCounts({ issueCounts: { suggestions: 2 } });
        assert.deepEqual(singular, plural);
        assert.deepEqual(singular, { blocking: 0, important: 0, suggestions: 2, nits: 0, digest: 0 });
    });

    test('the plural spelling wins when both spellings are present', function() {
        var mod = loadPostPRReviewComments();
        assert.deepEqual(mod.normalizeIssueCounts({ issueCounts: { suggestion: 2, suggestions: 5 } }),
            { blocking: 0, important: 0, suggestions: 5, nits: 0, digest: 0 });
    });

    test('nits and digest ride the census; missing counts default to zero', function() {
        var mod = loadPostPRReviewComments();
        assert.deepEqual(mod.normalizeIssueCounts({ issueCounts: { nits: 3, digest: 7 } }),
            { blocking: 0, important: 0, suggestions: 0, nits: 3, digest: 7 });
        assert.deepEqual(mod.normalizeIssueCounts({}),
            { blocking: 0, important: 0, suggestions: 0, nits: 0, digest: 0 });
        assert.deepEqual(mod.normalizeIssueCounts(null),
            { blocking: 0, important: 0, suggestions: 0, nits: 0, digest: 0 });
        assert.deepEqual(mod.normalizeIssueCounts({ issueCounts: null }),
            { blocking: 0, important: 0, suggestions: 0, nits: 0, digest: 0 });
    });

    test('string counts normalize through Number()', function() {
        var mod = loadPostPRReviewComments();
        assert.deepEqual(mod.normalizeIssueCounts({ issueCounts: { blocking: '2', suggestion: '1' } }),
            { blocking: 2, important: 0, suggestions: 1, nits: 0, digest: 0 });
    });

    test('hasAnyOpenIssue: the singular spelling counts, nits/digest do NOT open issues (no flip)', function() {
        var mod = loadPostPRReviewComments();
        assert.equal(mod.hasAnyOpenIssue({ blocking: 0, important: 0, suggestions: 0 }), false);
        assert.equal(mod.hasAnyOpenIssue({ blocking: 0, important: 0, suggestion: 1 }), true,
            'the singular spelling is the same census');
        assert.equal(mod.hasAnyOpenIssue({ nits: 5 }), false,
            'nits open issues from part 2 (the NIT enum), not here');
        assert.equal(mod.hasAnyOpenIssue({ digest: 5 }), false);
        assert.equal(mod.hasAnyOpenIssue({}), false);
        assert.equal(mod.hasAnyOpenIssue(null), false);
    });
});

suite('postPRReviewComments — gh-1369 terminal-PR guard on the rework arms', function() {

    // Harness: github_get_pr serves prPayload (the FRESH probe at re-arm
    // time — the PR search at leg start may have listed the PR open, the
    // #1368 race). triggerSmIfIdle is captured so both rework-arm paths
    // (the label stamp AND the SM kick) are observable.
    function runReworkLegHarness(prPayload) {
        var labels = [];
        var smIdleCalls = 0;
        var fileRead = function() { return null; };
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': prReviewOutputFiles(fileRead),
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() { smIdleCalls += 1; }
                }
            })),
            {
                file_read: fileRead,
                github_get_pr: function() {
                    if (typeof prPayload === 'function') return prPayload();
                    return JSON.stringify(prPayload);
                }
            }
        );
        var tracker = { addLabel: function(k, l) { labels.push(l); } };
        var ctx = { tracker: tracker, ticketKey: 'PROJ-1', scm: {}, config: {} };
        var pr = { number: 10, url: 'https://example.com/pr/10', branch: 'ai/gh-1',
                   author: 'ai-teammate' };
        return {
            mod: mod, labels: labels, tracker: tracker, ctx: ctx, pr: pr,
            repoInfo: { owner: 'acme', repo: 'widget' },
            smIdleCalls: function() { return smIdleCalls; }
        };
    }

    test('runReworkLeg — a MERGED PR is never marked for rework (no labels, no SM kick)', function() {
        var h = runReworkLegHarness({ number: 10, state: 'closed', merged: true, body: '' });
        h.mod.runReworkLeg(h.ctx, {}, h.pr, h.repoInfo, false);

        assert.deepEqual(h.labels, [],
            'no sm_story_rework_triggered / agent:rework on a merged PR');
        assert.equal(h.smIdleCalls(), 0, 'no SM trigger');
    });

    test('runReworkLeg — a CLOSED (not merged) PR is terminal too', function() {
        var h = runReworkLegHarness({ number: 10, state: 'closed', merged: false, body: '' });
        h.mod.runReworkLeg(h.ctx, {}, h.pr, h.repoInfo, false);

        assert.deepEqual(h.labels, [], 'no rework labels on a closed PR');
        assert.equal(h.smIdleCalls(), 0, 'no SM trigger');
    });

    test('runReworkLeg — an OPEN PR keeps the legacy arm (labels + SM kick, regression)', function() {
        var h = runReworkLegHarness({ number: 10, state: 'open', merged: false, body: '' });
        h.mod.runReworkLeg(h.ctx, {}, h.pr, h.repoInfo, false);

        assert.deepEqual(h.labels, ['sm_story_rework_triggered', 'agent:rework'],
            'both labels land on an open PR');
        assert.equal(h.smIdleCalls(), 1, 'SM kicked');
    });

    test('runReworkLeg — a probe failure fails OPEN (legacy arm semantics)', function() {
        var h = runReworkLegHarness(function() { throw new Error('github_get_pr failed'); });
        h.mod.runReworkLeg(h.ctx, {}, h.pr, h.repoInfo, false);

        assert.deepEqual(h.labels, ['sm_story_rework_triggered', 'agent:rework'],
            'fail-open: unknown terminality keeps the legacy arm');
    });

    // finishPRAnchoredReview: the REQUEST_CHANGES verdict re-arms
    // agent:rework on the linked issue — a flying review leg concluding
    // after the merge must not stamp a terminal PR.
    function anchoredHarness(prPayload) {
        var added = [];
        var removed = [];
        var fileRead = function() { return null; };
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': prReviewOutputFiles(fileRead)
            })),
            {
                file_read: fileRead,
                github_get_pr: function() {
                    if (typeof prPayload === 'function') return prPayload();
                    return JSON.stringify(prPayload);
                }
            }
        );
        var scm = {
            addLabel: function(num, label) { added.push({ num: num, label: label }); },
            removeLabel: function(num, label) { removed.push({ num: num, label: label }); }
        };
        var ctx = { scm: scm, machineAuthor: 'ai-teammate' };
        var pr = { number: 1940, author: 'ai-teammate', branch: 'ai/gh-1931' };
        return { mod: mod, added: added, removed: removed, ctx: ctx, pr: pr,
                 repoInfo: { owner: 'acme', repo: 'widget' } };
    }

    test('finishPRAnchoredReview — REQUEST_CHANGES on a MERGED PR never re-arms the linked issue', function() {
        var h = anchoredHarness({ number: 1940, state: 'closed', merged: true,
                                  body: 'Closes #1931', head: { ref: 'ai/gh-1931' } });
        h.mod.finishPRAnchoredReview(h.ctx, h.pr, h.repoInfo, false, 'REQUEST_CHANGES');

        assert.ok(!h.added.some(function(c) { return c.label === 'agent:rework'; }),
            'no agent:rework re-arm on a merged PR');
    });

    test('finishPRAnchoredReview — REQUEST_CHANGES on an OPEN PR still re-arms (regression)', function() {
        var h = anchoredHarness({ number: 1940, state: 'open', merged: false,
                                  body: 'Closes #1931', head: { ref: 'ai/gh-1931' } });
        h.mod.finishPRAnchoredReview(h.ctx, h.pr, h.repoInfo, false, 'REQUEST_CHANGES');

        assert.ok(h.added.some(function(c) {
            return c.num === 1931 && c.label === 'agent:rework';
        }), 'the linked-issue re-arm lands on an open PR');
    });

    test('finishPRAnchoredReview — a probe failure keeps the legacy outcome (quiet no-write, no crash)', function() {
        // Legacy: the linked-issue lookup rides the same github_get_pr read;
        // when it throws, rearmReworkOnLinkedIssue catches and NO re-arm
        // write happens. The guard's fail-open keeps exactly that outcome.
        var h = anchoredHarness(function() { throw new Error('github_get_pr failed'); });
        h.mod.finishPRAnchoredReview(h.ctx, h.pr, h.repoInfo, false, 'REQUEST_CHANGES');

        assert.ok(!h.added.some(function(c) { return c.label === 'agent:rework'; }),
            'legacy: the lookup failure already suppressed the write quietly');
    });
});

suite('postPReviewComments — gh-1403 review filter leg (verification: filter)', function() {

    var GENERAL_MD = '## General review\n\nThe PR looks solid overall.';

    function mapFileRead(fileMap) {
        return function (args) {
            var p = args && (args.path || args);
            if (fileMap[p] !== undefined) return fileMap[p];
            if (p && p.indexOf('.dmtools/config') !== -1) return null;
            return null;
        };
    }

    // Loader for the filter-runner helpers: real outputFiles wired to a
    // file map, a file_write recorder and a controllable cli_execute_command.
    function loadFilterRunner(fileMap, writes, cli) {
        var cliCalls = [];
        var cliMock = function (args) {
            cliCalls.push(args);
            if (typeof cli === 'function') return cli(args);
            return 'cli output';
        };
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: mapFileRead(fileMap) });
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles,
                './common/reviewFilter.js': loadModule('js/common/reviewFilter.js', makeRequire({
                    './reviewPolicy.js': loadReviewPolicyModule(),
                    './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
                    './reviewSpecClaims.js': loadSpecClaimsWithRegistry()
                }), {})
            })),
            {
                file_read: mapFileRead(fileMap),
                file_write: function (a, b) {
                    writes.push(typeof a === 'string' ? { path: a, content: b } : a);
                },
                cli_execute_command: cliMock
            }
        );
        return { mod: mod, cliCalls: cliCalls };
    }

    function filterPolicy() {
        return loadReviewPolicyModule().validateReviewPolicy({ verification: 'filter' }, 'test');
    }

    function filterCtx(policy, ticketKey) {
        return {
            reviewPolicy: policy,
            ticketKey: ticketKey || 'PROJ-1',
            workingDir: null,
            customParams: {}
        };
    }

    function filteredReviewData() {
        return {
            recommendation: 'APPROVE',
            issueCounts: { blocking: 0, important: 2, suggestions: 1, nits: 1, digest: 1 },
            inlineComments: [
                { path: 'a.js', line: 10, severity: 'IMPORTANT', body: 'wrong claim one' },
                { path: 'b.js', line: 20, severity: 'IMPORTANT', body: 'overstated claim two' },
                { path: 'c.js', line: 30, severity: 'SUGGESTION', body: 'solid claim three' },
                { path: 'd.js', line: 40, severity: 'NIT', body: 'nit four never filtered' }
            ],
            generalComment: 'outputs/pr_review_general.md'
        };
    }

    function dropDemoteKeepVerdicts() {
        return JSON.stringify({ verdicts: [
            { id: 0, decision: 'drop', reason: 'guard exists upstream' },
            { id: 1, decision: 'demote', tier: 'SUGGESTION', reason: 'real but cosmetic' },
            { id: 2, decision: 'keep' }
        ] });
    }

    test('applyReviewFilter is a full no-op when verification is none (legacy byte-identical path)', function() {
        var writes = [];
        var loaded = loadFilterRunner({}, writes, null);
        var data = filteredReviewData();
        var before = JSON.stringify(data.inlineComments);
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(loadReviewPolicyModule().defaultPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.equal(outcome, null, 'no filter outcome');
        assert.equal(JSON.stringify(data.inlineComments), before, 'review data untouched');
        assert.equal(loaded.cliCalls.length, 0, 'no CLI run');
        assert.equal(writes.length, 0, 'no files written');
    });

    test('filterDiffPathOf — inputFolderPath wins when it holds the diff (inputFolderCandidates chain)', function() {
        var loaded = loadFilterRunner({
            'input/TS-42/pr_diff.txt': 'diff --git a/y b/y'
        }, [], null);
        assert.equal(loaded.mod.filterDiffPathOf({ inputFolderPath: 'input/TS-42' }, 'TS-42'),
            'input/TS-42/pr_diff.txt', 'dispatched input folder used as-is');
        assert.equal(loaded.mod.filterDiffPathOf({}, 'TS-42'),
            'input/TS-42/pr_diff.txt', 'ticketKey fallback matches the review prompt layout');
        assert.equal(loaded.mod.filterDiffPathOf({ inputFolderPath: 'input/pr-1940' }, null),
            'input/pr-1940/pr_diff.txt', 'PR-anchored folder key works without a ticketKey');
    });

    test('filterDiffPathOf — a composite key resolves through inputFolderNameFor, not the raw key (gh-1403 thread 1)', function() {
        var loaded = loadFilterRunner({ 'input/gh-1407/pr_diff.txt': 'diff --git a/x b/x' }, [], null);
        assert.equal(loaded.mod.filterDiffPathOf({}, 'acme/widgets#1407'),
            'input/gh-1407/pr_diff.txt',
            'the derived input/<gh-N> layout is probed — the raw composite key path would 404');
        var bothFolders = loadFilterRunner({
            'input/gh-1407/pr_diff.txt': 'derived',
            'input/explicit-1407/pr_diff.txt': 'explicit'
        }, [], null);
        assert.equal(bothFolders.mod.filterDiffPathOf({ inputFolderPath: 'input/explicit-1407' }, 'acme/widgets#1407'),
            'input/explicit-1407/pr_diff.txt', 'the explicit dispatch folder is still most specific');
    });

    test('filterDiffPathOf — a sanitized key resolves its derived folder', function() {
        var loaded = loadFilterRunner({ 'input/PROJ-123-A-B/pr_diff.txt': 'diff' }, [], null);
        assert.equal(loaded.mod.filterDiffPathOf({}, 'PROJ-123/A B'),
            'input/PROJ-123-A-B/pr_diff.txt', 'non-[\\w.-] key chars are derived away by inputFolderNameFor');
    });

    test('filterDiffPathOf — the jobParams-wrapped params shape is unwrapped', function() {
        var loaded = loadFilterRunner({ 'input/WRAPPED/pr_diff.txt': 'diff' }, [], null);
        assert.equal(loaded.mod.filterDiffPathOf({ jobParams: { inputFolderPath: 'input/WRAPPED' } }, 'K'),
            'input/WRAPPED/pr_diff.txt', 'JSRunner jobParams wrapper unwrapped like linkedIssuesReport');
    });

    test('filterDiffPathOf — no candidate holds the diff: the first candidate is named anyway (fail-open)', function() {
        var loaded = loadFilterRunner({}, [], null);
        assert.equal(loaded.mod.filterDiffPathOf({}, 'acme/widgets#1407'),
            'input/gh-1407/pr_diff.txt',
            'degrades to the derived layout — the same fail-open class as any filter degradation');
    });

    test('applyReviewFilter with zero candidates skips the CLI (no cost round)', function() {
        var writes = [];
        var loaded = loadFilterRunner({}, writes, null);
        var data = {
            recommendation: 'APPROVE',
            issueCounts: { blocking: 0, important: 0, suggestions: 0, nits: 2, digest: 0 },
            inlineComments: [
                { path: 'd.js', line: 40, severity: 'NIT', body: 'nit one' },
                { path: 'e.js', line: 50, severity: 'NIT', body: 'nit two' }
            ]
        };
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.equal(outcome, null, 'nothing to verify');
        assert.equal(loaded.cliCalls.length, 0, 'zero candidates must not cost a CLI run');
        assert.equal(data.inlineComments.length, 2);
    });

    test('applyReviewFilter runs the fresh-context CLI, applies verdicts and recomputes the census', function() {
        var writes = [];
        var loaded = loadFilterRunner({
            'outputs/pr_review_filter.json': dropDemoteKeepVerdicts(),
            'outputs/pr_review_general.md': GENERAL_MD
        }, writes, null);
        var data = filteredReviewData();
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');

        assert.ok(outcome, 'filter outcome returned');
        assert.deepEqual(outcome.stats, { candidates: 3, kept: 1, demoted: 1, dropped: 1, dropRate: 0.333 });

        // CLI contract: run-agent.sh on the hidden filter prompt, from the
        // runtime cwd (no workingDirectory override — same as the main leg).
        assert.equal(loaded.cliCalls.length, 1);
        assert.equal(loaded.cliCalls[0].command, 'bash agents/scripts/run-agent.sh outputs/.pr-review-filter-prompt.md');
        assert.equal(loaded.cliCalls[0].workingDirectory, undefined);

        // The written prompt is a fresh-context contract.
        var promptWrite = writes.filter(function(w) { return w.path === 'outputs/.pr-review-filter-prompt.md'; })[0];
        assert.ok(promptWrite, 'filter prompt written');
        assert.ok(promptWrite.content.indexOf('outputs/pr_review_filter_input.json') !== -1);
        assert.ok(promptWrite.content.indexOf('input/PROJ-1/pr_diff.txt') !== -1, 'diff path injected');
        assert.ok(promptWrite.content.indexOf('outputs/pr_review_filter.json') !== -1);

        // The written input carries claims, never severities.
        var inputWrite = writes.filter(function(w) { return w.path === 'outputs/pr_review_filter_input.json'; })[0];
        assert.ok(inputWrite, 'filter input written');
        assert.ok(inputWrite.content.indexOf('wrong claim one') !== -1, 'claims ride the input');
        assert.ok(inputWrite.content.indexOf('IMPORTANT') === -1, 'severity never rides the input');

        // Machine semantics: drop removes, demote downgrades, keep stays, NIT untouched.
        assert.equal(data.inlineComments.length, 3, 'the dropped thread is gone');
        var byPath = {};
        data.inlineComments.forEach(function(c) { byPath[c.path] = c; });
        assert.ok(!byPath['a.js'], 'dropped finding posts nowhere');
        assert.equal(byPath['b.js'].severity, 'SUGGESTION', 'demote downgrades the tier');
        assert.equal(byPath['c.js'].severity, 'SUGGESTION', 'keep is unchanged');
        assert.equal(byPath['d.js'].severity, 'NIT', 'NIT never went through the filter');

        // Census recomputed AFTER filtering: threads by tier + digest + dropped.
        assert.deepEqual(data.issueCounts, { blocking: 0, important: 0, suggestions: 2, nits: 1, digest: 2 });

        // The general comment gains the dropped section (one line per drop).
        var gcWrite = writes.filter(function(w) { return w.path === 'outputs/pr_review_general.md'; })[0];
        assert.ok(gcWrite, 'general comment rewritten');
        assert.ok(gcWrite.content.indexOf('Review filter') !== -1);
        assert.ok(gcWrite.content.indexOf('`a.js:10`') !== -1, 'dropped candidate listed');
        assert.ok(gcWrite.content.indexOf('guard exists upstream') !== -1, 'drop reason listed');
        assert.ok(gcWrite.content.indexOf(GENERAL_MD) !== -1, 'original comment preserved');

        // The demoted thread carries the machine demotion note.
        assert.ok(byPath['b.js'].body.indexOf('Severity demoted') !== -1, 'demotion note appended');
        assert.ok(byPath['b.js'].body.indexOf('real but cosmetic') !== -1);
    });

    test('applyReviewFilter — a CLI failure degrades to unfiltered (fail-open)', function() {
        var writes = [];
        var loaded = loadFilterRunner({}, writes, function() { throw new Error('provider down'); });
        var data = filteredReviewData();
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.equal(outcome, null, 'no outcome on CLI failure');
        assert.equal(data.inlineComments.length, 4, 'review data untouched');
        assert.equal(data.issueCounts.important, 2, 'census untouched');
    });

    test('applyReviewFilter — missing or malformed verdict file degrades to unfiltered', function() {
        var writes = [];
        var loaded = loadFilterRunner({}, writes, null);
        var data = filteredReviewData();
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.equal(outcome, null, 'no verdicts file → unfiltered');
        assert.equal(data.inlineComments.length, 4);

        var loaded2 = loadFilterRunner({ 'outputs/pr_review_filter.json': '{{{bad json' }, writes, null);
        var data2 = filteredReviewData();
        var outcome2 = loaded2.mod.applyReviewFilter(data2, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.equal(outcome2, null, 'malformed verdicts → unfiltered');
        assert.equal(data2.inlineComments.length, 4);
    });

    test('applyReviewFilter — a demote on a file-referenced comment rewrites the comment file', function() {
        var writes = [];
        var commentFile = 'outputs/pr_review_comments/c1.md';
        var fileMap = {
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 0, decision: 'demote', tier: 'SUGGESTION', reason: 'overstated' }
            ] }),
            'outputs/pr_review_general.md': GENERAL_MD,
            'outputs/pr_review_comments/c1.md': '⚠️ The helper duplicates logic.'
        };
        var data = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 },
            inlineComments: [
                { path: 'b.js', line: 20, severity: 'IMPORTANT', comment: commentFile }
            ]
        };
        var loaded = loadFilterRunner(fileMap, writes, null);
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.ok(outcome);
        assert.equal(data.inlineComments[0].severity, 'SUGGESTION');
        var fileWrite = writes.filter(function(w) { return w.path === commentFile; })[0];
        assert.ok(fileWrite, 'comment file rewritten');
        assert.ok(fileWrite.content.indexOf('The helper duplicates logic.') !== -1, 'original prose kept');
        assert.ok(fileWrite.content.indexOf('Severity demoted') !== -1, 'demotion note appended to the file');
        assert.ok(fileWrite.content.indexOf('overstated') !== -1, 'filter reason in the note');
        assert.ok(!data.inlineComments[0].__filterId, 'filter tags cleaned from the posted payload');
    });

    test('stampOneDemotion — a non-comment-file path is never written (gh-1350 class guard, gh-1403 thread 2)', function() {
        var writes = [];
        var foreign = 'docs/agents/pr_review.md';
        var fileMap = {
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 0, decision: 'demote', tier: 'SUGGESTION', reason: 'overstated' }
            ] }),
            'outputs/pr_review_general.md': GENERAL_MD,
            'docs/agents/pr_review.md': '# pr review\nReadable repo doc the model must never mutate.'
        };
        var data = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 },
            inlineComments: [
                { path: 'b.js', line: 20, severity: 'IMPORTANT', comment: foreign }
            ]
        };
        var loaded = loadFilterRunner(fileMap, writes, null);
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.ok(outcome, 'the demote itself still applies');
        assert.equal(data.inlineComments[0].severity, 'SUGGESTION', 'tier downgraded');
        assert.equal(writes.filter(function(w) { return w.path === foreign; }).length, 0,
            'a repo file outside the comment-file layout is NEVER written');
    });

    test('stampOneDemotion — hostile model-written shapes are refused (nested dir, workflow yaml)', function() {
        var writes = [];
        var fileMap = {
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 0, decision: 'demote', tier: 'SUGGESTION', reason: 'overstated' }
            ] }),
            'outputs/pr_review_general.md': GENERAL_MD,
            'sub/dir/note.md': 'nested doc',
            '.github/workflows/ci.yml': 'name: ci'
        };
        var data = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 },
            inlineComments: [
                { path: 'a.js', line: 10, severity: 'IMPORTANT', comment: 'sub/dir/note.md' },
                { path: 'b.js', line: 20, severity: 'IMPORTANT', comment: '.github/workflows/ci.yml' }
            ]
        };
        var loaded = loadFilterRunner(fileMap, writes, null);
        loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.equal(writes.filter(function(w) { return w.path === 'sub/dir/note.md'; }).length, 0);
        assert.equal(writes.filter(function(w) { return w.path === '.github/workflows/ci.yml'; }).length, 0);
    });

    test('action() recomputes the verdict from the FILTERED census — a dropped thread no longer gates approval', function() {
        var writes = [];
        var scmCommentCalls = [];
        var scmInlineCalls = [];
        var scmAddLabelCalls = [];
        var cliCalls = [];
        var fileMap = {
            'input/PROJ-1/pr_info.md': '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n',
            'outputs/pr_review.json': JSON.stringify({
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 },
                inlineComments: [
                    { path: 'a.js', line: 10, severity: 'IMPORTANT', body: 'overstated claim' }
                ],
                generalComment: 'outputs/pr_review_general.md'
            }),
            'outputs/pr_review_general.md': GENERAL_MD,
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 0, decision: 'drop', reason: 'verified wrong against the caller guard' }
            ] })
        };
        var fileRead = mapFileRead(fileMap);
        var scm = {
            listPrs: function() { return []; },
            getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
            addLabel: function(prId, label) { scmAddLabelCalls.push(label); },
            removeLabel: function() {},
            fetchDiscussions: function() { return { rawThreads: { threads: [] } }; },
            addComment: function(prId, body) { scmCommentCalls.push(body); },
            addInlineComment: function() { scmInlineCalls.push(1); }
        };
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: fileRead });
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles,
                './common/scm.js': { createScm: function() { return scm; } },
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() {}
                },
                './common/reviewFilter.js': loadModule('js/common/reviewFilter.js', makeRequire({
                    './reviewPolicy.js': loadReviewPolicyModule(),
                    './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
                    './reviewSpecClaims.js': loadSpecClaimsWithRegistry()
                }), {})
            })),
            {
                file_read: fileRead,
                file_write: function(a, b) {
                    // writes are visible to later reads (the poster re-reads
                    // the general comment file after the filter appends to it)
                    var w = typeof a === 'string' ? { path: a, content: b } : a;
                    writes.push(w);
                    fileMap[w.path] = w.content;
                },
                cli_execute_command: function(args) { cliCalls.push(args); return 'filter cli ok'; },
                jira_add_label: function() {},
                jira_move_to_status: function() {},
                jira_post_comment: function(args) {},
                jira_remove_label: function() {},
                jira_assign_ticket_to: function() {}
            }
        );

        var result = mod.action({
            ticket: { key: 'PROJ-1', fields: { labels: [] } },
            response: 'Jira review content',
            inputFolderPath: 'input/PROJ-1',
            jobParams: {
                reviewPolicy: JSON.stringify({ verification: 'filter' })
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'APPROVE',
            'the only gating thread was filter-dropped → the census recomputes to APPROVE');
        assert.ok(result.filter && result.filter.candidates === 1 && result.filter.dropped === 1,
            'filter stats ride the result');
        assert.equal(scmInlineCalls.length, 0, 'the dropped finding never posts as a thread');
        assert.ok(scmAddLabelCalls.indexOf('pr_approved') !== -1, 'approval flows through');
        var postedGeneral = scmCommentCalls.filter(function(b) {
            return b.indexOf('Review filter') !== -1;
        });
        assert.equal(postedGeneral.length, 1, 'the general comment carries the dropped section');
        assert.ok(postedGeneral[0].indexOf('verified wrong against the caller guard') !== -1);
        assert.equal(cliCalls.length, 1, 'exactly one filter CLI run');
    });

    test('action() reconciles a surviving BLOCK token against a clean post-filter census (gh-1403 thread 3)', function() {
        var writes = [];
        var scmCommentCalls = [];
        var scmAddLabelCalls = [];
        var cliCalls = [];
        var fileMap = {
            'input/PROJ-1/pr_info.md': '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n',
            'outputs/pr_review.json': JSON.stringify({
                recommendation: 'BLOCK',
                issueCounts: { blocking: 1, important: 0, suggestions: 0, nits: 0, digest: 0 },
                inlineComments: [
                    { path: 'a.js', line: 10, severity: 'BLOCKING', body: 'claimed data loss on the empty path' }
                ],
                generalComment: 'outputs/pr_review_general.md'
            }),
            'outputs/pr_review_general.md': GENERAL_MD,
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 0, decision: 'drop', reason: 'the caller validates the input — claim wrong' }
            ] })
        };
        var fileRead = mapFileRead(fileMap);
        var scm = {
            listPrs: function() { return []; },
            getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
            addLabel: function(prId, label) { scmAddLabelCalls.push(label); },
            removeLabel: function() {},
            fetchDiscussions: function() { return { rawThreads: { threads: [] } }; },
            addComment: function(prId, body) { scmCommentCalls.push(body); },
            addInlineComment: function() {}
        };
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: fileRead });
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles,
                './common/scm.js': { createScm: function() { return scm; } },
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() {}
                },
                './common/reviewFilter.js': loadModule('js/common/reviewFilter.js', makeRequire({
                    './reviewPolicy.js': loadReviewPolicyModule(),
                    './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
                    './reviewSpecClaims.js': loadSpecClaimsWithRegistry()
                }), {})
            })),
            {
                file_read: fileRead,
                file_write: function(a, b) {
                    var w = typeof a === 'string' ? { path: a, content: b } : a;
                    writes.push(w);
                    fileMap[w.path] = w.content;
                },
                cli_execute_command: function(args) { cliCalls.push(args); return 'filter cli ok'; },
                jira_add_label: function() {},
                jira_move_to_status: function() {},
                jira_post_comment: function(args) {},
                jira_remove_label: function() {},
                jira_assign_ticket_to: function() {}
            }
        );

        var result = mod.action({
            ticket: { key: 'PROJ-1', fields: { labels: [] } },
            response: 'Jira review content',
            inputFolderPath: 'input/PROJ-1',
            jobParams: {
                reviewPolicy: JSON.stringify({ verification: 'filter' })
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'APPROVE',
            'the filter dropped every gating thread — the pre-filter BLOCK token is advisory, the census wins');
        assert.ok(scmAddLabelCalls.indexOf('pr_approved') !== -1, 'the reconciled approval flows through');
        assert.ok(result.filter && result.filter.dropped === 1, 'filter stats ride the result');
    });

    test('action() — a BLOCK token stands when no filter ran (verification none keeps the invariant)', function() {
        var scmAddLabelCalls = [];
        var fileMap = {
            'input/PROJ-1/pr_info.md': '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n',
            'outputs/pr_review.json': JSON.stringify({
                recommendation: 'BLOCK',
                issueCounts: { blocking: 1, important: 0, suggestions: 0, nits: 0, digest: 0 },
                inlineComments: [
                    { path: 'a.js', line: 10, severity: 'BLOCKING', body: 'real data loss' }
                ],
                generalComment: 'outputs/pr_review_general.md'
            }),
            'outputs/pr_review_general.md': GENERAL_MD
        };
        var fileRead = mapFileRead(fileMap);
        var scm = {
            listPrs: function() { return []; },
            getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
            addLabel: function(prId, label) { scmAddLabelCalls.push(label); },
            removeLabel: function() {},
            fetchDiscussions: function() { return { rawThreads: { threads: [] } }; },
            addComment: function() {},
            addInlineComment: function() {}
        };
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: fileRead });
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles,
                './common/scm.js': { createScm: function() { return scm; } },
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() {}
                }
            })),
            {
                file_read: fileRead,
                file_write: function() {},
                cli_execute_command: function() { throw new Error('no filter CLI without verification filter'); },
                jira_add_label: function() {},
                jira_move_to_status: function() {},
                jira_post_comment: function() {},
                jira_remove_label: function() {},
                jira_assign_ticket_to: function() {}
            }
        );

        var result = mod.action({
            ticket: { key: 'PROJ-1', fields: { labels: [] } },
            response: 'Jira review content',
            inputFolderPath: 'input/PROJ-1'
        });
        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'BLOCK',
            'model BLOCK (security/data-loss) stands untouched without an applied filter');
        assert.ok(scmAddLabelCalls.indexOf('pr_approved') === -1, 'no approval label');
    });

    test('action() — a BLOCK token stands when the post-filter census still gates (kept BLOCKING thread)', function() {
        var fileMap = {
            'input/PROJ-1/pr_info.md': '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n',
            'outputs/pr_review.json': JSON.stringify({
                recommendation: 'BLOCK',
                issueCounts: { blocking: 2, important: 0, suggestions: 0, nits: 0, digest: 0 },
                inlineComments: [
                    { path: 'a.js', line: 10, severity: 'BLOCKING', body: 'verified data loss — kept' },
                    { path: 'b.js', line: 20, severity: 'BLOCKING', body: 'overstated claim — dropped' }
                ],
                generalComment: 'outputs/pr_review_general.md'
            }),
            'outputs/pr_review_general.md': GENERAL_MD,
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 1, decision: 'drop', reason: 'guard exists upstream' }
            ] })
        };
        var fileRead = mapFileRead(fileMap);
        var scm = {
            listPrs: function() { return []; },
            getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
            addLabel: function() {},
            removeLabel: function() {},
            fetchDiscussions: function() { return { rawThreads: { threads: [] } }; },
            addComment: function() {},
            addInlineComment: function() {}
        };
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: fileRead });
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles,
                './common/scm.js': { createScm: function() { return scm; } },
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() {}
                },
                './common/reviewFilter.js': loadModule('js/common/reviewFilter.js', makeRequire({
                    './reviewPolicy.js': loadReviewPolicyModule(),
                    './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
                    './reviewSpecClaims.js': loadSpecClaimsWithRegistry()
                }), {})
            })),
            {
                file_read: fileRead,
                file_write: function() {},
                cli_execute_command: function() { return 'filter cli ok'; },
                jira_add_label: function() {},
                jira_move_to_status: function() {},
                jira_post_comment: function() {},
                jira_remove_label: function() {},
                jira_assign_ticket_to: function() {}
            }
        );

        var result = mod.action({
            ticket: { key: 'PROJ-1', fields: { labels: [] } },
            response: 'Jira review content',
            inputFolderPath: 'input/PROJ-1',
            jobParams: {
                reviewPolicy: JSON.stringify({ verification: 'filter' })
            }
        });
        assert.equal(result.success, true);
        assert.equal(result.recommendation, 'BLOCK',
            'blocking evidence remains posted — the BLOCK token is not reconciled away');
    });

    test('action() with verification none never invokes the filter CLI (default stays legacy)', function() {
        var writes = [];
        var cliCalls = [];
        var fileMap = {
            'input/PROJ-1/pr_info.md': '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n',
            'outputs/pr_review.json': JSON.stringify({
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 0, nits: 0, digest: 0 },
                inlineComments: [],
                generalComment: 'outputs/pr_review_general.md'
            })
        };
        var fileRead = mapFileRead(fileMap);
        var scm = {
            listPrs: function() { return []; },
            getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
            addLabel: function() {},
            removeLabel: function() {},
            fetchDiscussions: function() { return { rawThreads: { threads: [] } }; },
            addComment: function() {},
            addInlineComment: function() {}
        };
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: fileRead });
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles,
                './common/scm.js': { createScm: function() { return scm; } },
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() {}
                },
                './common/reviewFilter.js': loadModule('js/common/reviewFilter.js', makeRequire({
                    './reviewPolicy.js': loadReviewPolicyModule(),
                    './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
                    './reviewSpecClaims.js': loadSpecClaimsWithRegistry()
                }), {})
            })),
            {
                file_read: fileRead,
                file_write: function() {},
                cli_execute_command: function(args) { cliCalls.push(args); return 'cli'; },
                jira_add_label: function() {},
                jira_move_to_status: function() {},
                jira_post_comment: function() {},
                jira_remove_label: function() {},
                jira_assign_ticket_to: function() {}
            }
        );

        var result = mod.action({
            ticket: { key: 'PROJ-1', fields: { labels: [] } },
            response: 'Jira review content',
            inputFolderPath: 'input/PROJ-1'
        });
        assert.equal(result.success, true);
        assert.equal(result.filter, undefined, 'no filter outcome on the default policy');
        assert.equal(cliCalls.length, 0, 'verification none costs nothing');
    });

    test('action() with verification none runs no input-folder diff probes (lazy diff path, round 2 NIT)', function() {
        var diffReads = 0;
        var fileMap = {
            'input/PROJ-1/pr_info.md': '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n',
            'outputs/pr_review.json': JSON.stringify({
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 0, suggestions: 0, nits: 0, digest: 0 },
                inlineComments: [],
                generalComment: 'outputs/pr_review_general.md'
            })
        };
        var baseRead = mapFileRead(fileMap);
        var fileRead = function(args) {
            var p = args && (args.path || args);
            if (p && String(p).indexOf('pr_diff.txt') !== -1) diffReads++;
            return baseRead(args);
        };
        var scm = {
            listPrs: function() { return []; },
            getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
            addLabel: function() {},
            removeLabel: function() {},
            fetchDiscussions: function() { return { rawThreads: { threads: [] } }; },
            addComment: function() {},
            addInlineComment: function() {}
        };
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: fileRead });
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles,
                // gh-1408: isolation — this 'verification none' scenario must not
                // ride the REAL .dmtools/config.js (the shared prReviewRequireMap
                // wires the real configLoader, whose file_read reads the repo's
                // live reviewPolicy.verification). Stub it per the AGENTS.md mock
                // convention: a config-dependent test gets an explicit stub.
                './configLoader.js': configLoaderStub({}),
                './common/scm.js': { createScm: function() { return scm; } },
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() {}
                }
            })),
            {
                file_read: fileRead,
                file_write: function() {},
                cli_execute_command: function() { throw new Error('no filter CLI without verification filter'); },
                jira_add_label: function() {},
                jira_move_to_status: function() {},
                jira_post_comment: function() {},
                jira_remove_label: function() {},
                jira_assign_ticket_to: function() {}
            }
        );

        var result = mod.action({
            ticket: { key: 'PROJ-1', fields: { labels: [] } },
            response: 'Jira review content',
            inputFolderPath: 'input/PROJ-1'
        });
        assert.equal(result.success, true);
        assert.equal(diffReads, 0,
            'a disabled filter must not probe the input folders for pr_diff.txt');
    });

    test('applyReviewFilter — a throwing verdict-file read degrades to unfiltered (fail-open)', function() {
        var writes = [];
        var loaded = loadFilterRunner({}, writes, function(args) {
            var p = args && (args.path || args);
            if (p === 'outputs/pr_review_filter.json') throw new Error('disk boom');
            return 'cli output';
        });
        var data = filteredReviewData();
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.equal(outcome, null, 'unreadable verdicts → unfiltered');
        assert.equal(data.inlineComments.length, 4, 'review data untouched');
        assert.equal(data.issueCounts.important, 2, 'census untouched');
    });

    test('applyReviewFilter — a non-file generalComment skips the drop listing, stats still ride', function() {
        var writes = [];
        var loaded = loadFilterRunner({ 'outputs/pr_review_filter.json': dropDemoteKeepVerdicts() }, writes, null);
        var data = filteredReviewData();
        data.generalComment = '## General review\n\ninline text, not a file reference';
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.ok(outcome, 'filter outcome still returned');
        assert.equal(outcome.stats.candidates, 3);
        assert.equal(outcome.dropped.length, 1);
        var gcWrites = writes.filter(function(w) { return w.path === 'outputs/pr_review_general.md'; });
        assert.equal(gcWrites.length, 0, 'no general-comment file write without a file path');
    });

    test('applyReviewFilter — an unreadable general-comment file skips the injection (non-fatal)', function() {
        var writes = [];
        var loaded = loadFilterRunner({ 'outputs/pr_review_filter.json': dropDemoteKeepVerdicts() }, writes, null);
        var data = filteredReviewData();
        data.generalComment = 'outputs/pr_review_comments/missing.md';
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.ok(outcome, 'filter outcome still returned');
        assert.equal(writes.filter(function(w) { return w.path === 'outputs/pr_review_comments/missing.md'; }).length, 0,
            'nothing written when the general comment file does not exist');
    });

    test('applyReviewFilter — a body-as-path hybrid gets its note in the FILE, body stays resolvable (round 2, shape A)', function() {
        var writes = [];
        var commentFile = 'outputs/pr_review_comments/c1.md';
        var fileMap = {
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 0, decision: 'demote', tier: 'SUGGESTION', reason: 'overstated' }
            ] }),
            'outputs/pr_review_general.md': GENERAL_MD,
            'outputs/pr_review_comments/c1.md': '⚠️ The helper duplicates logic.'
        };
        var data = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 },
            inlineComments: [
                // agent-output hybrid: the body HOLDS the comment-file path —
                // the shape resolveInlineComment resolves at post time
                { path: 'b.js', line: 20, severity: 'IMPORTANT', body: commentFile }
            ]
        };
        var loaded = loadFilterRunner(fileMap, writes, null);
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.ok(outcome);
        assert.equal(data.inlineComments[0].severity, 'SUGGESTION');
        assert.equal(data.inlineComments[0].body, commentFile,
            'the body keeps its path shape — appending the note would publish the literal path');
        assert.ok(loaded.mod.isCommentFilePath(data.inlineComments[0].body),
            'the poster still resolves this body to the claim content, not a literal path');
        var fileWrite = writes.filter(function(w) { return w.path === commentFile; })[0];
        assert.ok(fileWrite, 'the demotion note lands in the referenced comment file instead');
        assert.ok(fileWrite.content.indexOf('Severity demoted') !== -1);
        assert.ok(fileWrite.content.indexOf('The helper duplicates logic.') !== -1, 'claim prose kept');
    });

    test('applyReviewFilter — old-spec {file, comment} gets the note in its comment file (round 2, shape B)', function() {
        var writes = [];
        var commentFile = 'outputs/pr_review_comments/old.md';
        var fileMap = {
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 0, decision: 'demote', tier: 'SUGGESTION', reason: 'overstated' }
            ] }),
            'outputs/pr_review_general.md': GENERAL_MD,
            'outputs/pr_review_comments/old.md': 'Old-spec claim prose.'
        };
        var data = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 },
            inlineComments: [
                // old spec: `file` names the code location, `comment` references the file
                { file: 'b.js', line: 20, severity: 'IMPORTANT', comment: commentFile }
            ]
        };
        var loaded = loadFilterRunner(fileMap, writes, null);
        var outcome = loaded.mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.ok(outcome);
        assert.equal(data.inlineComments[0].severity, 'SUGGESTION', 'structured tier still downgrades');
        var fileWrite = writes.filter(function(w) { return w.path === commentFile; })[0];
        assert.ok(fileWrite, 'the demotion note lands in the old-spec comment file (isStampTarget matches entry.file)');
        assert.ok(fileWrite.content.indexOf('Severity demoted') !== -1);
    });
    test('stampDemotionNotesOnFiles — a stamp whose severity no longer matches is skipped (consume-once)', function() {
        var writes = [];
        var fileMap = { 'outputs/pr_review_comments/c1.md': 'original claim prose' };
        var loaded = loadFilterRunner(fileMap, writes, null);
        var data = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 },
            inlineComments: [
                { path: 'b.js', line: 20, severity: 'IMPORTANT', comment: 'outputs/pr_review_comments/c1.md' }
            ]
        };
        loaded.mod.stampDemotionNotesOnFiles(data, [
            { decision: 'demote', path: 'b.js', line: 20, to: 'SUGGESTION', note: 'demotion note' }
        ], filterCtx(filterPolicy()));
        var fileWrite = writes.filter(function(w) { return w.path === 'outputs/pr_review_comments/c1.md'; })[0];
        assert.equal(fileWrite, undefined, 'severity mismatch → the comment file is NOT rewritten');
        assert.equal(data.inlineComments[0].severity, 'IMPORTANT', 'the entry severity is untouched');
        assert.ok(!data.inlineComments[0].__filterNoted, 'no stamp tag left behind');
    });

    test('applyReviewFilter — an unexpected internal error degrades to unfiltered (catch-all fail-open)', function() {
        var writes = [];
        var realFilter = loadModule('js/common/reviewFilter.js', makeRequire({
            './reviewPolicy.js': loadReviewPolicyModule(),
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
            './reviewSpecClaims.js': loadSpecClaimsWithRegistry()
        }), {});
        var brokenFilter = {};
        for (var k in realFilter) { brokenFilter[k] = realFilter[k]; }
        brokenFilter.buildFilterInputJson = function() { throw new Error('input boom'); };
        var cliCalls = [];
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule
        }), { file_read: mapFileRead({}) });
        var mod = loadModule(
            'js/postPRReviewComments.js',
            makeRequire(prReviewRequireMap({
                './common/outputFiles.js': outputFiles,
                './common/reviewFilter.js': brokenFilter
            })),
            {
                file_read: mapFileRead({ 'outputs/pr_review_filter.json': dropDemoteKeepVerdicts() }),
                file_write: function(a, b) { writes.push(typeof a === 'string' ? { path: a, content: b } : a); },
                cli_execute_command: function(args) { cliCalls.push(args); return 'cli'; }
            }
        );
        var data = filteredReviewData();
        var outcome = mod.applyReviewFilter(data, filterCtx(filterPolicy()), 'input/PROJ-1/pr_diff.txt');
        assert.equal(outcome, null, 'internal filter error → unfiltered, never fatal');
        assert.equal(data.inlineComments.length, 4, 'review data untouched');
        assert.equal(data.issueCounts.important, 2, 'census untouched');
    });
});
