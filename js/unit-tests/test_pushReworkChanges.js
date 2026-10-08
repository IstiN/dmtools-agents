/**
 * Unit tests for js/pushReworkChanges.js — postThreadReplies()
 *
 * Regression test: the AI agent commonly writes outputs/review_replies.json
 * using the INPUT schema field names (rootCommentId/body, mirrored from
 * input/<TICKET>/pr_discussions_raw.json) instead of the documented OUTPUT
 * schema (inReplyToId/reply). Left unhandled, this causes every reply to
 * silently fall back to a generic "✅ Addressed." top-level PR comment instead
 * of a threaded reply with the agent's actual explanation, even though the
 * thread is still correctly resolved (since "threadId" is spelled the same in
 * both schemas).
 *
 * postThreadReplies() must accept both field-name conventions.
 */

// File-scope base module (was previously misplaced INSIDE the file_read mock
// closure below — a latent defect masked in run_all.json by another test file
// leaking the same sloppy-mode global, but breaking isolated per-file runs).
var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var gitStagingModule = loadModule('js/common/gitStaging.js');

// Real githubHelpers (only its own deps stubbed) — pushReworkChanges requires
// it for the PR-anchored (pr-N) lookup path; jira keys never touch it.
var githubHelpersModule = loadModule(
    'js/common/githubHelpers.js',
    makeRequire({
        './pullRequest.js': { buildOriginFetchCommand: function() { return 'git fetch origin'; } },
        './gitOps.js': {
            checkoutPRBranch: function() {},
            getPRDiff: function() {},
            detectMergeConflicts: function() {},
            trimLargeTextForInput: function() {},
            writePRContext: function() {}
        }
    }),
    {}
);

function makeOutputFiles(fileMap) {
    return loadModule('js/common/outputFiles.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule,
        }), {
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        }
    });
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

function loadPushReworkChangesModule(fileMap, opts) {
    opts = opts || {};
    var outputFiles = makeOutputFiles(fileMap);
    var replyCalls = [];
    var resolveCalls = [];
    var addCommentCalls = [];
    var fetchDiscussionsCalls = [];

    var scm = {
        replyToThread: function(prId, thread, text) {
            replyCalls.push({ prId: prId, thread: thread, text: text });
        },
        resolveThread: function(prId, thread) {
            resolveCalls.push({ prId: prId, thread: thread });
        },
        addComment: function(prId, text) {
            addCommentCalls.push({ prId: prId, text: text });
        }
    };
    if (opts.fetchDiscussions) {
        scm.fetchDiscussions = function(prId) {
            fetchDiscussionsCalls.push(prId);
            return opts.fetchDiscussions(prId);
        };
    }

    var noop = function() {};
    var mod = loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': { loadProjectConfig: function() { return {}; } },
            './common/scm.js': { createScm: function() { return scm; } },
            './common/submodules.js': {},
            './common/pullRequest.js': {},
            './common/githubHelpers.js': githubHelpersModule,
            './common/feedbackLoop.js': {},
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: noop },
            './common/outputFiles.js': outputFiles,
            './config.js': configModule,
            './common/trackers.js': makeTrackersModule({}),
            './cacheToReleases.js': { cacheSessionLog: noop },
            './common/tokenUsageComment.js': { postTokenUsageComments: noop }
        ,
            './common/commentMarkup.js': commentMarkupModule,
        }),
        {
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                return fileMap[path] !== undefined ? fileMap[path] : null;
            }
        }
    );

    return {
        mod: mod, scm: scm, replyCalls: replyCalls, resolveCalls: resolveCalls,
        addCommentCalls: addCommentCalls, fetchDiscussionsCalls: fetchDiscussionsCalls
    };
}

suite('pushReworkChanges — postThreadReplies field-name fallback', function() {

    test('uses documented inReplyToId/reply fields when present', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    { inReplyToId: 111, threadId: 'PRRT_a', reply: 'Fixed via documented schema.' }
                ]
            })
        });

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(posted, 1);
        assert.equal(loaded.replyCalls.length, 1);
        assert.equal(loaded.replyCalls[0].thread.rootCommentId, 111);
        assert.equal(loaded.replyCalls[0].thread.threadId, 'PRRT_a');
        assert.equal(loaded.replyCalls[0].text, 'Fixed via documented schema.');
        assert.equal(loaded.resolveCalls.length, 1, 'thread should be resolved');
    });

    test('falls back to rootCommentId/body when agent mirrors input schema', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    { rootCommentId: 555000001, threadId: 'PRRT_generic1', body: 'Fixed by extracting the shared helper.' }
                ]
            })
        });

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(posted, 1);
        assert.equal(loaded.replyCalls.length, 1, 'reply should still be posted');
        assert.equal(loaded.replyCalls[0].thread.rootCommentId, 555000001, 'rootCommentId used as inReplyToId fallback');
        assert.equal(loaded.replyCalls[0].text, 'Fixed by extracting the shared helper.', 'body used as reply text fallback — NOT the generic Addressed fallback');
        assert.notEqual(loaded.replyCalls[0].text, '✅ Addressed.', 'must not silently fall back to generic text when body is present');
        assert.equal(loaded.resolveCalls.length, 1, 'thread should still be resolved');
    });

    test('prefers inReplyToId/reply over rootCommentId/body when both are present', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    {
                        inReplyToId: 222, rootCommentId: 333,
                        threadId: 'PRRT_b',
                        reply: 'Documented field wins.', body: 'Should not be used.'
                    }
                ]
            })
        });

        loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(loaded.replyCalls[0].thread.rootCommentId, 222);
        assert.equal(loaded.replyCalls[0].text, 'Documented field wins.');
    });

    test('reads reply text from a referenced .md file path', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    { inReplyToId: 444, threadId: 'PRRT_c', reply: 'outputs/review_replies/thread_1.md' }
                ]
            }),
            'outputs/review_replies/thread_1.md': 'Detailed explanation from file.'
        });

        loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(loaded.replyCalls[0].text, 'Detailed explanation from file.');
    });

    test('returns 0 and warns when review_replies.json is missing', function() {
        var loaded = loadPushReworkChangesModule({});
        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {});
        assert.equal(posted, 0);
        assert.equal(loaded.replyCalls.length, 0);
    });

    test('batches multiple untargeted replies (no comment id at all) into ONE combined top-level comment, not one per item', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    { threadId: 'PRRT_x', reply: 'Fix one.' },
                    { threadId: 'PRRT_y', reply: 'Fix two.' },
                    { threadId: 'PRRT_z', reply: 'Fix three.' }
                ]
            })
        });

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(loaded.replyCalls.length, 0, 'no threaded replies possible without a comment id');
        assert.equal(loaded.addCommentCalls.length, 1, 'exactly one combined comment posted — not one per item');
        assert.ok(loaded.addCommentCalls[0].text.indexOf('Fix one.') !== -1, 'combined comment includes item 1');
        assert.ok(loaded.addCommentCalls[0].text.indexOf('Fix two.') !== -1, 'combined comment includes item 2');
        assert.ok(loaded.addCommentCalls[0].text.indexOf('Fix three.') !== -1, 'combined comment includes item 3');
        assert.equal(posted, 1, 'combined comment counts as 1 posted item');
        assert.equal(loaded.resolveCalls.length, 3, 'each thread is still individually resolved');
    });

    test('single untargeted reply posts its own text as-is, without the numbered-list wrapper', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [
                    { threadId: 'PRRT_x', reply: 'Only fix.' }
                ]
            })
        });

        loaded.mod.postThreadReplies(loaded.scm, '123', {});

        assert.equal(loaded.addCommentCalls.length, 1);
        assert.equal(loaded.addCommentCalls[0].text, 'Only fix.');
    });
});

// ── thread-resolution closure (gh-692) ───────────────────────────────────────
// Live case (fa #1194, 2026-10-04): a rework leg addressed both open review
// threads and pushed, but the GitHub threads stayed UNRESOLVED — the raw
// discussion export (pr_discussions_raw.json) lacked threadIds for some items,
// so postThreadReplies (which only resolves item.threadId from the AI-written
// review_replies.json) silently skipped them. Consequence: the threadsResolved:true
// re-review rule can never match while the unresolved-threads rule (gh-683) keeps
// re-arming rework → infinite loop. The post-action must close the loop itself:
// enrich ids from the setup-time thread snapshot, sweep the PR's fresh open
// threads, and resolve every thread the rework addressed — threads cited in the
// rework response MUST be resolved; unciteable items fall back to a comment.
suite('pushReworkChanges — thread resolution closure (gh-692)', function() {

    test('extractCitedThreadIds: finds unique PRRT_ ids in the rework response', function() {
        var loaded = loadPushReworkChangesModule({});
        assert.deepEqual(
            loaded.mod.extractCitedThreadIds(
                'addressed PRRT_kwDOTXdlLc6opl_v and PRRT_kwDOTXdlLc6opmBc; PRRT_kwDOTXdlLc6opl_v again'),
            ['PRRT_kwDOTXdlLc6opl_v', 'PRRT_kwDOTXdlLc6opmBc']);
        assert.deepEqual(loaded.mod.extractCitedThreadIds('no ids here'), []);
        assert.deepEqual(loaded.mod.extractCitedThreadIds(null), []);
        assert.deepEqual(loaded.mod.extractCitedThreadIds(undefined), []);
    });

    test('enriches a missing threadId from the setup-time thread snapshot (matched by rootCommentId)', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [{ rootCommentId: 5550001, reply: 'Fixed the doc header.' }]
            }),
            'input/PROJ-123/pr_discussions_raw.json': JSON.stringify({
                threads: [
                    { index: 1, rootCommentId: 5550001, threadId: 'PRRT_snapshot_1', resolved: false, body: 'typo' }
                ]
            })
        });

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', { ticketKey: 'PROJ-123' });

        assert.equal(posted, 1, 'reply posted inline (rootCommentId present)');
        assert.equal(loaded.replyCalls.length, 1, 'inline threaded reply, not a combined fallback comment');
        assert.equal(loaded.addCommentCalls.length, 0);
        assert.equal(loaded.resolveCalls.length, 1, 'thread must be resolved');
        assert.equal(loaded.resolveCalls[0].thread.threadId, 'PRRT_snapshot_1',
            'threadId enriched from input/<KEY>/pr_discussions_raw.json');
    });

    test('enriches a missing inReplyToId from the snapshot (matched by threadId) so the reply becomes threaded', function() {
        var loaded = loadPushReworkChangesModule({
            'outputs/review_replies.json': JSON.stringify({
                replies: [{ threadId: 'PRRT_snapshot_2', reply: 'Fixed.' }]
            }),
            'input/PROJ-123/pr_discussions_raw.json': JSON.stringify({
                threads: [
                    { index: 1, rootCommentId: 7770002, threadId: 'PRRT_snapshot_2', resolved: false, body: 'fix' }
                ]
            })
        });

        loaded.mod.postThreadReplies(loaded.scm, '123', { ticketKey: 'PROJ-123' });

        assert.equal(loaded.replyCalls.length, 1, 'reply became a threaded reply');
        assert.equal(loaded.replyCalls[0].thread.rootCommentId, 7770002, 'inReplyToId enriched from snapshot');
        assert.equal(loaded.addCommentCalls.length, 0, 'no top-level fallback comment needed');
        assert.equal(loaded.resolveCalls.length, 1);
    });

    test('fresh-sweep resolves an open thread by rootCommentId when BOTH the agent output and the snapshot lack threadIds (the live gh-692 case)', function() {
        var loaded = loadPushReworkChangesModule(
            {
                'outputs/review_replies.json': JSON.stringify({
                    replies: [{ rootCommentId: 5550001, reply: 'Doc-only fix applied.' }]
                }),
                'input/PROJ-123/pr_discussions_raw.json': JSON.stringify({
                    threads: [{ index: 1, rootCommentId: 5550001, threadId: null, resolved: false, body: 'typo' }]
                })
            },
            {
                fetchDiscussions: function() {
                    return {
                        markdown: 'irrelevant',
                        rawThreads: {
                            threads: [
                                { index: 1, rootCommentId: 5550001, threadId: 'PRRT_fresh_1', resolved: false, body: 'typo' }
                            ]
                        }
                    };
                }
            }
        );

        loaded.mod.postThreadReplies(loaded.scm, '123', { ticketKey: 'PROJ-123' });

        assert.equal(loaded.fetchDiscussionsCalls.length, 1, 'exactly one fresh thread probe');
        assert.equal(loaded.resolveCalls.length, 1, 'the open thread must be resolved via the fresh sweep');
        assert.equal(loaded.resolveCalls[0].thread.threadId, 'PRRT_fresh_1');
    });

    test('sweep resolves multiple addressed open threads but never an unaddressed one (2+ item case)', function() {
        var loaded = loadPushReworkChangesModule(
            {
                'outputs/review_replies.json': JSON.stringify({
                    replies: [
                        { rootCommentId: 1, reply: 'Fix one.' },
                        { rootCommentId: 2, reply: 'Fix two.' }
                    ]
                })
            },
            {
                fetchDiscussions: function() {
                    return {
                        rawThreads: {
                            threads: [
                                { index: 1, rootCommentId: 1, threadId: 'PRRT_a', resolved: false },
                                { index: 2, rootCommentId: 2, threadId: 'PRRT_b', resolved: false },
                                { index: 3, rootCommentId: 3, threadId: 'PRRT_unaddressed', resolved: false }
                            ]
                        }
                    };
                }
            }
        );

        loaded.mod.postThreadReplies(loaded.scm, '123', { ticketKey: 'PROJ-123' });

        var resolvedIds = loaded.resolveCalls.map(function(c) { return c.thread.threadId; });
        assert.ok(resolvedIds.indexOf('PRRT_a') !== -1, 'PRRT_a resolved, got: ' + JSON.stringify(resolvedIds));
        assert.ok(resolvedIds.indexOf('PRRT_b') !== -1, 'PRRT_b resolved, got: ' + JSON.stringify(resolvedIds));
        assert.ok(resolvedIds.indexOf('PRRT_unaddressed') === -1,
            'a thread with NO reply item and NO citation must stay open');
    });

    test('threads cited in the rework response MUST be resolved — even with no review_replies.json at all', function() {
        var loaded = loadPushReworkChangesModule(
            {},
            {
                fetchDiscussions: function() {
                    return {
                        rawThreads: {
                            threads: [
                                { index: 1, rootCommentId: 11, threadId: 'PRRT_kwDOTXdlLc6opl_v', resolved: false },
                                { index: 2, rootCommentId: 12, threadId: 'PRRT_kwDOTXdlLc6opmBc', resolved: false }
                            ]
                        }
                    };
                }
            }
        );

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {
            ticketKey: 'PROJ-123',
            responseText: 'Addressed PRRT_kwDOTXdlLc6opl_v and PRRT_kwDOTXdlLc6opmBc (doc-only).'
        });

        assert.equal(posted, 0, 'no replies posted');
        var resolvedIds = loaded.resolveCalls.map(function(c) { return c.thread.threadId; }).sort();
        assert.deepEqual(resolvedIds, ['PRRT_kwDOTXdlLc6opl_v', 'PRRT_kwDOTXdlLc6opmBc'],
            'every cited thread resolved');
    });

    test('cited ids are resolved DIRECTLY when the fresh sweep is unavailable or finds nothing (MUST semantics)', function() {
        var loaded = loadPushReworkChangesModule({});

        loaded.mod.postThreadReplies(loaded.scm, '123', {
            ticketKey: 'PROJ-123',
            responseText: 'Fixed per PRRT_direct_1.'
        });

        assert.equal(loaded.fetchDiscussionsCalls.length, 0, 'scm has no fetchDiscussions — no probe attempted');
        assert.equal(loaded.resolveCalls.length, 1, 'cited id resolved directly');
        assert.equal(loaded.resolveCalls[0].thread.threadId, 'PRRT_direct_1');
    });

    test('sweep skips already-resolved threads', function() {
        var loaded = loadPushReworkChangesModule(
            {
                'outputs/review_replies.json': JSON.stringify({
                    replies: [{ rootCommentId: 5550001, reply: 'Fixed.' }]
                })
            },
            {
                fetchDiscussions: function() {
                    return {
                        rawThreads: {
                            threads: [
                                { index: 1, rootCommentId: 5550001, threadId: 'PRRT_already', resolved: true }
                            ]
                        }
                    };
                }
            }
        );

        loaded.mod.postThreadReplies(loaded.scm, '123', { ticketKey: 'PROJ-123' });

        assert.equal(loaded.resolveCalls.length, 0, 'resolved threads must not be re-resolved');
    });

    test('no replies, no citations → no probe, no resolutions (missing review_replies.json unchanged)', function() {
        var loaded = loadPushReworkChangesModule(
            {},
            {
                fetchDiscussions: function() {
                    return { rawThreads: { threads: [{ rootCommentId: 1, threadId: 'PRRT_open', resolved: false }] } };
                }
            }
        );

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', { ticketKey: 'PROJ-123' });

        assert.equal(posted, 0);
        assert.equal(loaded.fetchDiscussionsCalls.length, 0, 'the rework claimed nothing — resolve nothing');
        assert.equal(loaded.resolveCalls.length, 0);
    });

    test('sweep failure is non-fatal: cited ids still get direct resolve attempts', function() {
        var loaded = loadPushReworkChangesModule(
            {
                'outputs/review_replies.json': JSON.stringify({
                    replies: [{ rootCommentId: 5550001, reply: 'Fixed.' }]
                })
            },
            {
                fetchDiscussions: function() { throw new Error('GraphQL down'); }
            }
        );

        var posted = loaded.mod.postThreadReplies(loaded.scm, '123', {
            ticketKey: 'PROJ-123',
            responseText: 'Fixed PRRT_cited_1 too.'
        });

        assert.equal(posted, 1, 'the leg itself still succeeds');
        var resolvedIds = loaded.resolveCalls.map(function(c) { return c.thread.threadId; });
        assert.ok(resolvedIds.indexOf('PRRT_cited_1') !== -1,
            'cited id resolved directly after the probe failed, got: ' + JSON.stringify(resolvedIds));
    });
});

// ── commitAndPush: base-branch safety invariant ──────────────────────────────
// Never commit/push while HEAD sits on the repo's base branch instead of the
// expected PR branch (the failure mode that let WIP auto-save commits land
// on develop/main when branch setup silently failed).

function loadPushReworkChangesForCommitAndPush(mocks) {
    return loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/scm.js': {},
            './common/submodules.js': {
                pushManagedSubmodules: function() { /* no-op */ }
            },
            './common/pullRequest.js': {
                readStagedDiffStat: function() { return 'M file.txt\n'; },
                syncBranchWithBase: function() { return { success: true, updated: false }; },
                buildOriginFetchCommand: function(refSpec) {
                    return 'git -c fetch.recurseSubmodules=no fetch origin' + (refSpec ? ' ' + refSpec : '');
                }
            },
            './common/githubHelpers.js': githubHelpersModule,
            './common/feedbackLoop.js': {
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function() { return { attempted: false }; }
            },
            './common/autoStart.js': { triggerSmIfIdle: function() {} },
            './common/outputFiles.js': { readOutputFile: function() { return null; } },
            './common/trackers.js': makeTrackersModule({}),
            './cacheToReleases.js': {},
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        ,
            './common/commentMarkup.js': commentMarkupModule,
        }),
        Object.assign({
            cli_execute_command: function() { return ''; },
            file_read: function() { return null; },
            jira_post_comment: function() {},
            jira_move_to_status: function() {},
            jira_remove_label: function() {}
        }, mocks || {})
    );
}

function baseConfig(overrides) {
    return Object.assign({
        workingDir: null,
        git: { baseBranch: 'develop' },
        formats: { commitMessage: { rework: '{ticketKey} rework' } }
    }, overrides || {});
}

suite('pushReworkChanges.commitAndPush — base-branch safety invariant', function() {

    test('refuses to commit/push when still on baseBranch after a failed forced checkout', function() {
        var commands = [];
        var mod = loadPushReworkChangesForCommitAndPush({
            file_read: function(args) {
                if (args.path.indexOf('pr_info.md') !== -1) {
                    return '**Branch**: `bug/PROJ-123` → `develop`';
                }
                return null;
            },
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git branch --show-current') return 'develop\n';
                // Forced checkout to the expected branch fails — simulates the
                // exact scenario that must never result in a push to develop.
                if (args.command === 'git checkout bug/PROJ-123') {
                    throw new Error('error: pathspec did not match any file(s)');
                }
                return '';
            }
        });

        assert.throws(function() {
            mod.commitAndPush('PROJ-123', baseConfig(), {});
        }, 'must throw instead of pushing while parked on the base branch');

        assert.equal(commands.filter(function(c) { return c.indexOf('git commit') !== -1; }).length, 0,
            'must never commit while on baseBranch');
        assert.equal(commands.filter(function(c) { return c.indexOf('git push') !== -1; }).length, 0,
            'must never push while on baseBranch');
    });

    test('commits and pushes normally once on the expected PR branch', function() {
        var commands = [];
        var mod = loadPushReworkChangesForCommitAndPush({
            file_read: function(args) {
                if (args.path.indexOf('pr_info.md') !== -1) {
                    return '**Branch**: `bug/PROJ-123` → `develop`';
                }
                return null;
            },
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git branch --show-current') return 'bug/PROJ-123\n';
                if (args.command.indexOf('git ls-remote --heads origin bug/PROJ-123') === 0) {
                    return 'abc123\trefs/heads/bug/PROJ-123\n';
                }
                return '';
            }
        });

        var result = mod.commitAndPush('PROJ-123', baseConfig(), {});

        assert.equal(result.branch, 'bug/PROJ-123');
        assert.ok(commands.filter(function(c) { return c.indexOf('git commit') !== -1; }).length >= 1,
            'should commit when there are staged changes');
        assert.ok(commands.filter(function(c) { return c.indexOf('git push -u origin bug/PROJ-123') !== -1; }).length >= 1,
            'should push to the expected PR branch');
    });

    test('rework commit never carries a CI-skip token, even when the template has one (gh-711)', function() {
        // Live fa queue 2026-10-04 (gh-711, fa #1212/#1217/#1221/#1222/#1223/#1225):
        // rework legs pushed fixes whose commit message carried [skip ci]
        // (project-configured template, "correct" for CI-noise). On a
        // validation-bound branch the push then triggered NO CI — the
        // ruleset-required check never registered on the new head and
        // mergeStateStatus stayed BLOCKED with green latches until a
        // manual ci.yml dispatch. A rework push must always re-trigger CI.
        var commands = [];
        var mod = loadPushReworkChangesForCommitAndPush({
            file_read: function(args) {
                if (args.path.indexOf('pr_info.md') !== -1) {
                    return '**Branch**: `bug/PROJ-123` → `develop`';
                }
                return null;
            },
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git branch --show-current') return 'bug/PROJ-123\n';
                if (args.command.indexOf('git ls-remote --heads origin bug/PROJ-123') === 0) {
                    return 'abc123\trefs/heads/bug/PROJ-123\n';
                }
                return '';
            }
        });

        var cfg = baseConfig({ formats: { commitMessage: {
            rework: '{ticketKey} Rework: address PR review comments [skip ci]'
        } } });
        mod.commitAndPush('PROJ-123', cfg, {});

        var commitCmd = commands.filter(function(c) { return c.indexOf('git commit') !== -1; })[0];
        assert.ok(commitCmd, 'should commit when there are staged changes');
        assert.notContains(commitCmd.toLowerCase(), 'skip ci',
            'rework commit must not carry [skip ci] — the required check would never register on the new head');
        assert.notContains(commitCmd.toLowerCase(), 'ci skip',
            'rework commit must not carry [ci skip] either (same GitHub skip directive)');
    });

    test('CI-skip strip is case-insensitive and removes the whole bracket token (gh-711)', function() {
        var commands = [];
        var mod = loadPushReworkChangesForCommitAndPush({
            file_read: function(args) {
                if (args.path.indexOf('pr_info.md') !== -1) {
                    return '**Branch**: `bug/PROJ-123` → `develop`';
                }
                return null;
            },
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git branch --show-current') return 'bug/PROJ-123\n';
                if (args.command.indexOf('git ls-remote --heads origin bug/PROJ-123') === 0) {
                    return 'abc123\trefs/heads/bug/PROJ-123\n';
                }
                return '';
            }
        });

        var cfg = baseConfig({ formats: { commitMessage: {
            rework: '{ticketKey} Rework: address PR review comments [SKIP CI]'
        } } });
        mod.commitAndPush('PROJ-123', cfg, {});

        var commitCmd = commands.filter(function(c) { return c.indexOf('git commit') !== -1; })[0];
        assert.ok(commitCmd, 'should commit when there are staged changes');
        assert.notContains(commitCmd.toLowerCase(), 'skip ci',
            'upper-case [SKIP CI] must be stripped too — GitHub skip directives are case-insensitive');
        assert.notContains(commitCmd, '[SKIP CI]',
            'the bracket token must be removed entirely, not just lower-cased');
    });

    test('refuses outright when pr_info.md is missing (no PR to push to)', function() {
        var mod = loadPushReworkChangesForCommitAndPush({
            file_read: function() { throw new Error('File does not exist'); }
        });

        assert.throws(function() {
            mod.commitAndPush('PROJ-123', baseConfig(), {});
        }, 'must refuse to commit/push without a known expected branch');
    });

    test('staging never includes machine-local .dmtools runtime logs (gh-628)', function() {
        // Live 2026-10-03 (ai/gh-628): .dmtools/credential-helper.log — the
        // credential helper's serving trace — was swept into three
        // ticket-branch commits by broad `git add` staging. Rework legs
        // commit to the SAME ai/* branches, so the rework staging pathspec
        // must exclude the runtime logs like copilot-sessions, and the rm
        // cleanup must untrack already-poisoned branches.
        var commands = [];
        var mod = loadPushReworkChangesForCommitAndPush({
            file_read: function(args) {
                if (args.path.indexOf('pr_info.md') !== -1) {
                    return '**Branch**: `bug/PROJ-123` → `develop`';
                }
                return null;
            },
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git branch --show-current') return 'bug/PROJ-123\n';
                if (args.command.indexOf('git ls-remote --heads origin bug/PROJ-123') === 0) {
                    return 'abc123\trefs/heads/bug/PROJ-123\n';
                }
                if (args.command.indexOf('git check-ignore') === 0) {
                    // gh-683 probe: not-ignored repo — check-ignore exits 1,
                    // the exclusion pathspecs must stay in the rework add.
                    throw new Error('Command execution failed (exit code 1)');
                }
                return '';
            }
        });

        mod.commitAndPush('PROJ-123', baseConfig(), {});

        var addCall = commands.filter(function(c) { return c.indexOf('git add . --') === 0; })[0];
        assert.ok(addCall, 'staging command executed — commands: ' + JSON.stringify(commands));
        assert.contains(addCall, ':!.dmtools/credential-helper.log',
            'credential-serving trace never staged');
        assert.contains(addCall, ':!.dmtools/fa-trace.log', 'fa trace log never staged');
        assert.contains(addCall, ':!.dmtools/run-output.txt', 'fa run output never staged');
        assert.contains(addCall, ':!.dmtools/stall-capture.log', 'stall capture never staged');
        assert.contains(addCall, ':!.dmtools/fa-sessions', 'session store never staged');
        assert.contains(addCall, ':!.dmtools-session-output.log',
            'timer CLI-stdout snapshot never staged');
        var rmCalls = commands.filter(function(c) { return c.indexOf('git ls-files -- ') === 0; });
        assert.equal(rmCalls.length, 1, 'exactly one untrack-cleanup command');
        assert.contains(rmCalls[0], '.dmtools/credential-helper.log',
            'already-tracked credential-helper.log is untracked (poisoned-branch self-heal)');
        assert.contains(rmCalls[0], '.dmtools/fa-sessions',
            'session store untracked too — untrack list must not drift from staging exclusions (gh-628)');
    });
});

// ── action(): rework_setup_failed.md guard (issue #310) ──────────────────────
// preCliReworkSetup.js writes input/<ticketKey>/rework_setup_failed.md (via
// failSetup()) when it could not find/checkout a PR for the ticket, e.g. "no PR
// found for ticket". pushReworkChanges must detect that marker BEFORE calling
// commitAndPush()/resumeAgent() — retrying the CLI cannot fix a missing PR, and
// in the observed incident retrying instead led the CLI agent to fabricate a
// fake pr_info.md just to slip past the "refuse to commit on base branch" guard.

function loadPushReworkChangesForAction(mocks, opts) {
    var jiraPostCommentCalls = [];
    var jiraMoveToStatusCalls = [];
    var resumeAgentCalls = [];
    var cliCommands = [];

    // Default fixture: the jira-shaped ticket's own PR is in the listPrs page
    // (title/branch contain the key) — the normal happy-path shape. Before the
    // PR-LOOKUP-FAILED hardening this defaulted to [] and the happy-path
    // regression below passed only BECAUSE of the old silent skip; the lookup
    // failure path now fails loudly by design and needs its own test.
    var scm = Object.assign({
        listPrs: function() {
            return [{
                number: 123,
                title: 'PROJ-123: rework fix',
                head: { ref: 'bug/PROJ-123' },
                html_url: 'https://github.com/IstiN/dmtools-agents/pull/123'
            }];
        },
        getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; }
    }, (opts && opts.scm) || {});

    var defaultMocks = {
        cli_execute_command: function(args) {
            cliCommands.push(args.command);
            if (args.command === 'git branch --show-current') return 'bug/PROJ-123\n';
            if (args.command.indexOf('git ls-remote --heads origin') === 0) {
                return 'abc123\trefs/heads/bug/PROJ-123\n';
            }
            return '';
        },
        file_read: function(args) {
            var p = args && (args.path || args);
            if (p && p.indexOf('rework_setup_failed.md') !== -1) {
                throw new Error('File does not exist');
            }
            if (p && p.indexOf('pr_info.md') !== -1) {
                return '**Branch**: `bug/PROJ-123` → `develop`';
            }
            return null;
        },
        jira_post_comment: function(args) { jiraPostCommentCalls.push(args); },
        jira_move_to_status: function(args) { jiraMoveToStatusCalls.push(args); },
        jira_remove_label: function() {},
        jira_assign_ticket_to: function() {}
    };

    var mergedMocks = Object.assign({}, defaultMocks, mocks || {});

    var mod = loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': {
                loadProjectConfig: function() { return baseConfig(opts && opts.config); },
                resolveInstructions: function() { return { jobParamPatch: {} }; },
                formatTemplate: function(template, vars) {
                    return template.replace(/\{(\w+)\}/g, function(m, key) {
                        return (vars && vars[key] !== undefined) ? vars[key] : m;
                    });
                }
            },
            './common/scm.js': { createScm: function() { return scm; } },
            './common/submodules.js': { pushManagedSubmodules: function() {} },
            './common/pullRequest.js': {
                readStagedDiffStat: function() { return 'M file.txt\n'; },
                syncBranchWithBase: function() { return { success: true, updated: false }; }
            },
            './common/githubHelpers.js': githubHelpersModule,
            './common/feedbackLoop.js': (function() {
                var fl = (opts && opts.feedbackLoop) || {
                    runQualityGates: function() { return { success: true }; },
                    runPolicyGates: function() { return { success: true }; },
                    runPostPublishGates: function() { return { success: true }; },
                    resumeAgent: function() { return { attempted: false }; }
                };
                var innerResume = fl.resumeAgent;
                fl.resumeAgent = function(args) {
                    resumeAgentCalls.push(args);
                    return innerResume(args);
                };
                return fl;
            })(),
            './common/autoStart.js': (opts && opts.autoStart) || {
                triggerSmIfIdle: function() {},
                triggerConfiguredWorkflowForTicket: function() { return false; }
            },
            './common/outputFiles.js': (opts && opts.outputFiles) || { readOutputFile: function() { return null; } },
            './config.js': configModule,
            './common/trackers.js': makeTrackersModule(mergedMocks),
            './cacheToReleases.js': { action: function() {} },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        ,
            './common/commentMarkup.js': commentMarkupModule,
        }),
        mergedMocks
    );

    return {
        mod: mod,
        jiraPostCommentCalls: jiraPostCommentCalls,
        jiraMoveToStatusCalls: jiraMoveToStatusCalls,
        resumeAgentCalls: resumeAgentCalls,
        cliCommands: cliCommands
    };
}

suite('pushReworkChanges.action — rework_setup_failed.md guard (#310)', function() {

    test('skips commitAndPush and resumeAgent, posts a Jira comment, when rework_setup_failed.md exists', function() {
        var loaded = loadPushReworkChangesForAction({
            file_read: function(args) {
                var p = args && (args.path || args);
                if (p && p.indexOf('rework_setup_failed.md') !== -1) {
                    return '# Rework Setup Failed\n\nNo Pull Request found for ticket PROJ-123. Cannot start rework without an existing PR.\n';
                }
                return null;
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'PROJ-123', fields: { labels: [] } },
            response: 'Some fix summary that would have been pushed.'
        });

        assert.equal(result.success, true, 'should be a handled outcome, not a hard failure');
        assert.equal(result.path, 'rework-setup-already-failed');

        assert.equal(
            loaded.cliCommands.filter(function(c) { return c.indexOf('git commit') !== -1; }).length, 0,
            'must never commit when rework setup already failed'
        );
        assert.equal(
            loaded.cliCommands.filter(function(c) { return c.indexOf('git push') !== -1; }).length, 0,
            'must never push when rework setup already failed'
        );
        assert.equal(loaded.resumeAgentCalls.length, 0, 'must NOT trigger a CLI retry — a missing PR cannot be fixed by retrying');

        assert.equal(loaded.jiraPostCommentCalls.length, 1, 'exactly one Jira comment explaining the skip');
        assert.contains(loaded.jiraPostCommentCalls[0].comment, 'Rework Push Skipped');
        assert.contains(loaded.jiraPostCommentCalls[0].comment, 'No Pull Request found for ticket PROJ-123');

        assert.equal(loaded.jiraMoveToStatusCalls.length, 0, 'must not reach the normal "move to In Review" step');
    });

    test('regression: normal commit/push flow is unchanged when rework_setup_failed.md does NOT exist', function() {
        var loaded = loadPushReworkChangesForAction({});

        var result = loaded.mod.action({
            ticket: { key: 'PROJ-123', fields: { labels: [] } },
            response: 'Some fix summary that should be pushed normally.'
        });

        assert.equal(result.success, true);
        assert.notEqual(result.path, 'rework-setup-already-failed');
        assert.equal(result.branchName, 'bug/PROJ-123');

        assert.ok(
            loaded.cliCommands.filter(function(c) { return c.indexOf('git commit') !== -1; }).length >= 1,
            'should still commit staged changes'
        );
        assert.ok(
            loaded.cliCommands.filter(function(c) { return c.indexOf('git push -u origin bug/PROJ-123') !== -1; }).length >= 1,
            'should still push to the PR branch'
        );
        assert.equal(loaded.resumeAgentCalls.length, 0);

        assert.ok(
            loaded.jiraMoveToStatusCalls.some(function(c) { return c.statusName === 'In Review'; }),
            'should still move the ticket to In Review as before'
        );
    });
});

suite('pushReworkChanges.action — tracker provider dispatch (#414)', function() {

    test('github provider: ticket operations dispatch to github_* tools, jira_* stay untouched', function() {
        var ghCommentCalls = [];
        var ghRemoveLabelCalls = [];
        var jiraPostCommentCalls = [];

        var loaded = loadPushReworkChangesForAction(
            {
                file_read: function(args) {
                    var p = args && (args.path || args);
                    if (p && p.indexOf('rework_setup_failed.md') !== -1) {
                        return '# Rework Setup Failed\n\nNo Pull Request found for ticket.';
                    }
                    return null;
                },
                github_create_comment: function(args) { ghCommentCalls.push(args); return '{}'; },
                github_remove_label: function(args) { ghRemoveLabelCalls.push(args); return '{}'; },
                jira_post_comment: function(args) { jiraPostCommentCalls.push(args); }
            },
            {
                config: {
                    repository: { owner: 'IstiN', repo: 'fah-git-test' }
                }
            }
        );

        var result = loaded.mod.action({
            ticket: { key: 'IstiN/fah-git-test#42', fields: { labels: [] } },
            response: 'Fix summary',
            customParams: {
                trackerProvider: 'github',
                removeLabel: 'sm_rework_triggered'
            }
        });

        assert.equal(result.success, true, 'should be a handled outcome, not a hard failure');
        assert.equal(result.path, 'rework-setup-already-failed');

        assert.equal(jiraPostCommentCalls.length, 0, 'no jira_* tool must be called on a github deployment');
        assert.ok(
            ghCommentCalls.some(function(c) { return c.pullRequestId === 42; }),
            'expected github_create_comment with the issue number, got: ' + JSON.stringify(ghCommentCalls)
        );
        assert.ok(
            ghCommentCalls.some(function(c) {
                return typeof c.text === 'string' && c.text.indexOf('Rework Push Skipped') !== -1;
            }),
            'the setup-failed comment should be posted through the github provider'
        );
        assert.deepEqual(ghRemoveLabelCalls[0], {
            owner: 'IstiN',
            repo: 'fah-git-test',
            number: 42,
            label: 'sm_rework_triggered'
        });
    });
});

// ── action(): resumeAgent exception safety ───────────────────────────────────
// feedbackLoop.resumeAgent() shells out (mkdir/bash/run-agent.sh --continue) and
// can itself throw (e.g. blocked by a misconfigured CLI_ALLOWED_COMMANDS whitelist). Every
// call site wraps it via tryResumeAgent() so that failure is treated the same as
// { attempted: false } instead of propagating and skipping the honest error-comment fallback.

function loadPushReworkChangesForResumeSafety(mocks, feedbackLoopOverrides) {
    var mergedMocks = Object.assign({
        cli_execute_command: function() { return ''; },
        file_read: function() { return null; },
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {},
        jira_assign_ticket_to: function() {}
    }, mocks || {});

    return loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/submodules.js': { pushManagedSubmodules: function() {} },
            './common/pullRequest.js': {},
            './common/githubHelpers.js': githubHelpersModule,
            './common/feedbackLoop.js': Object.assign({
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function() { return { attempted: false }; }
            }, feedbackLoopOverrides || {}),
            './common/autoStart.js': { triggerSmIfIdle: function() {}, triggerConfiguredWorkflowForTicket: function() {} },
            './common/outputFiles.js': { readOutputFile: function() { return null; } },
            './config.js': configModule,
            './common/trackers.js': makeTrackersModule(mergedMocks),
            './cacheToReleases.js': { action: function() {} },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        ,
            './common/commentMarkup.js': commentMarkupModule,
        }),
        mergedMocks
    );
}

suite('pushReworkChanges.action — resumeAgent exception safety', function() {

    test('still posts an honest error comment when feedbackLoop.resumeAgent itself throws (e.g. blocked by CLI_ALLOWED_COMMANDS)', function() {
        var comments = [];
        var mod = loadPushReworkChangesForResumeSafety(
            {
                jira_post_comment: function(args) { comments.push(args); }
            },
            {
                // Simulates an unrelated, unexpected failure reaching the outer catch.
                runQualityGates: function() { throw new Error('simulated unexpected pre-push failure'); },
                // Simulates the real-world bug: the feedback loop's own self-invocation gets
                // blocked by a misconfigured CLI_ALLOWED_COMMANDS whitelist and throws instead
                // of returning { attempted: false }.
                resumeAgent: function() { throw new Error('Security violation: Command not whitelisted: bash'); }
            }
        );

        var result = mod.action({
            ticket: { key: 'TS-3', fields: { summary: 'Rework fix', description: '', labels: [] } },
            metadata: { contextId: 'pr_rework' },
            response: 'Some fix summary text that is long enough to be a meaningful rework summary.',
            customParams: {}
        });

        // The bug this guards against: an uncaught throw from resumeAgent used to be swallowed
        // by the outer try/catch around the reset logic itself, skipping jira_post_comment
        // entirely — the job would return { success: false } but the ticket would show no
        // comment at all, leaving it silently stuck with no explanation.
        assert.equal(result.success, false);
        assert.equal(comments.length, 1, 'an honest error comment must still be posted even though resumeAgent threw');
        assert.contains(comments[0].comment, 'Rework Workflow Error');
    });
});

suite('pushReworkChanges — no-op rework token guard (2026-09-21, epam/dmtools-dart #194)', function() {

    var HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    var VERDICT_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    function prFixture() {
        return { number: 194, title: 'epam/dmtools-dart#191 parity follow-up', head: { ref: 'ai/gh-191', sha: HEAD } };
    }

    function reviewScm(reviews) {
        return { listReviews: function() { return reviews; } };
    }

    test('headMovedSinceLastReview: false when the last verdict covers the current head', function() {
        var loaded = loadPushReworkChangesModule({});
        var verdict = reviewScm([
            { state: 'CHANGES_REQUESTED', commit_id: VERDICT_SHA, submitted_at: '2026-09-21T18:45:00Z' },
            { state: 'CHANGES_REQUESTED', commit_id: HEAD, submitted_at: '2026-09-21T18:58:00Z' }
        ]);
        assert.equal(loaded.mod.headMovedSinceLastReview(verdict, prFixture()), false,
            'a rework that pushed nothing must NOT buy a fresh LLM review of the same head');
    });

    test('headMovedSinceLastReview: true when fixes landed after the verdict', function() {
        var loaded = loadPushReworkChangesModule({});
        var verdict = reviewScm([
            { state: 'CHANGES_REQUESTED', commit_id: VERDICT_SHA, submitted_at: '2026-09-21T18:58:00Z' }
        ]);
        assert.equal(loaded.mod.headMovedSinceLastReview(verdict, prFixture()), true);
    });

    test('headMovedSinceLastReview: PENDING/DISMISSED reviews are not the verdict', function() {
        var loaded = loadPushReworkChangesModule({});
        var verdict = reviewScm([
            { state: 'CHANGES_REQUESTED', commit_id: VERDICT_SHA, submitted_at: '2026-09-21T18:45:00Z' },
            { state: 'PENDING', commit_id: HEAD, submitted_at: '2026-09-21T18:50:00Z' }
        ]);
        assert.equal(loaded.mod.headMovedSinceLastReview(verdict, prFixture()), true,
            'only concluded verdicts (CHANGES_REQUESTED/APPROVED) pin the reviewed head');
    });

    test('headMovedSinceLastReview: true with no concluded reviews and when the probe throws (fail-open)', function() {
        var loaded = loadPushReworkChangesModule({});
        assert.equal(loaded.mod.headMovedSinceLastReview(reviewScm([]), prFixture()), true);
        assert.equal(loaded.mod.headMovedSinceLastReview(reviewScm(null), prFixture()), true);
        assert.equal(loaded.mod.headMovedSinceLastReview({ listReviews: function() { throw new Error('api down'); } }, prFixture()), true);
        assert.equal(loaded.mod.headMovedSinceLastReview(reviewScm([]), null), true, 'no PR at all → fail-open');
    });

    function actionFixture(opts) {
        opts = opts || {};
        var cliCommandsRef = [];
        var ghAddLabelCalls = [];
        var ghRemoveLabelCalls = [];
        var reviewTriggers = [];
        var ghCommentBodies = [];
        var loaded = loadPushReworkChangesForAction(
            {
                github_add_label: function(args) { ghAddLabelCalls.push(args); return '{}'; },
                github_add_labels: function(args) {
                    (args.labels || []).forEach(function(l) { ghAddLabelCalls.push({ label: l, number: args.number }); });
                    return '{}';
                },
                github_remove_label: function(args) { ghRemoveLabelCalls.push(args); return '{}'; },
                github_create_comment: function(args) { ghCommentBodies.push(args.body); return '{}'; },
                cli_execute_command: function(args) {
                    cliCommandsRef.push(args.command);
                    if (args.command === 'git branch --show-current') return 'ai/gh-191\n';
                    if (args.command.indexOf('git ls-remote --heads origin') === 0) {
                        return 'abc123\trefs/heads/ai/gh-191\n';
                    }
                    return '';
                },
                file_read: function(args) {
                    var p2 = args && (args.path || args);
                    if (p2 && p2.indexOf('rework_setup_failed.md') !== -1) {
                        throw new Error('File does not exist');
                    }
                    if (p2 && p2.indexOf('pr_info.md') !== -1) {
                        return '**Branch**: `ai/gh-191` → `main`';
                    }
                    return null;
                }
            },
            {
                config: { repository: { owner: 'epam', repo: 'dmtools-dart' } },
                scm: {
                    listPrs: function() {
                        var p = prFixture();
                        if (opts.prApproved) {
                            p = Object.assign({}, p, { labels: [{ name: 'pr_approved' }, { name: 'ai_pr_reviewed' }] });
                        }
                        return [p];
                    },
                    addComment: function(n, body) { ghCommentBodies.push(body); },
                    listReviews: function() { return [{
                        state: 'CHANGES_REQUESTED',
                        commit_id: opts && opts.verdictOnHead ? HEAD : VERDICT_SHA,
                        submitted_at: '2026-09-21T18:58:00Z'
                    }]; }
                },
                autoStart: {
                    triggerSmIfIdle: function() {},
                    triggerConfiguredWorkflowForTicket: function(args) { reviewTriggers.push(args); return true; }
                }
            }
        );
        return {
            loaded: loaded,
            ghAddLabelCalls: ghAddLabelCalls,
            ghRemoveLabelCalls: ghRemoveLabelCalls,
            ghCommentBodies: ghCommentBodies,
            reviewTriggers: reviewTriggers,
            run: function() {
                return loaded.mod.action({
                    ticket: { key: 'epam/dmtools-dart#191', fields: { labels: [] } },
                    response: 'Fix summary long enough to be a meaningful rework completion summary.',
                    customParams: {
                        trackerProvider: 'github',
                        autoStartReview: true,
                        autoStartReviewConfigFile: 'pr_review.json'
                    }
                });
            }
        };
    }

    test('action: no-op rework keeps ai_pr_reviewed, re-arms agent:rework, starts NO re-review', function() {
        var fx = actionFixture({ verdictOnHead: true });
        var result = fx.run();

        assert.equal(result.success, true);
        assert.ok(
            fx.ghAddLabelCalls.some(function(c) { return c.label === 'agent:rework'; }),
            'the ticket must go straight back to rework (cheap convergence, no reviewer pass)'
        );
        assert.ok(
            !fx.ghRemoveLabelCalls.some(function(c) { return c.label === 'ai_pr_reviewed'; }),
            'the ai_pr_reviewed latch must be KEPT — the standing verdict still covers this head'
        );
        assert.equal(fx.reviewTriggers.length, 0,
            'no LLM re-review may be started for an unchanged head (token guard)');
    });

    test('action: STICKY APPROVAL (owner rule 2026-09-21) — rework on an approved PR never arms a re-review', function() {
        // Live (dart #194): infra-red re-armed rework; the rework finished
        // with a moved head (ci-restart empty commit) and the completion
        // path cleared ai_pr_reviewed + armed agent:review — a third review
        // dispatched on a pr_approved PR. Sticky approval must beat every
        // fresh-review arm, even with the head moved.
        var fx = actionFixture({ verdictOnHead: false, prApproved: true });
        var result = fx.run();

        assert.equal(result.success, true);
        assert.ok(
            !fx.ghRemoveLabelCalls.some(function(c) { return c.label === 'ai_pr_reviewed'; }),
            'the ai_pr_reviewed latch must be KEPT on an approved PR'
        );
        assert.equal(fx.reviewTriggers.length, 0,
            'autoStartReview must not fire — approval is sticky, no reviewer pass ever again');
        assert.ok(
            !fx.ghAddLabelCalls.some(function(c) { return c.label === 'agent:rework'; }),
            'no agent:rework re-arm — the head just re-validates and merges'
        );
        assert.ok(
            fx.ghCommentBodies.some(function(b) { return String(b).indexOf('sticky') !== -1; }),
            'the PR is told the loop re-validates and merges without a re-review'
        );
    });

    test('action: real rework (head moved) still clears the latch and starts the fresh review', function() {
        var fx = actionFixture({ verdictOnHead: false });
        var result = fx.run();

        assert.equal(result.success, true);
        assert.ok(
            fx.ghRemoveLabelCalls.some(function(c) { return c.label === 'ai_pr_reviewed'; }),
            'a genuine rework must arm a FRESH review as before');
        assert.equal(fx.reviewTriggers.length, 1,
            'the fresh review must be auto-started exactly once');
        assert.ok(
            !fx.ghAddLabelCalls.some(function(c) { return c.label === 'agent:rework'; }),
            'no agent:rework re-arm on the productive path'
        );
    });
});

// ── fatal rework CLI failure must NOT be announced as completion ─────────────
// Live pathology 2026-09-29 (IstiN/flutter_agent_harness #1052 machine loop):
// a rework CLI command that exited non-zero (exit code 1) was announced as
// "✅ Rework Complete" because only interruption-class failures (timeout exit
// 124, missing output file) were detected. The loop then re-validated the
// never-fixed head forever. A fatal CLI failure must take the honest failure
// path: one resume attempt, then a failure comment + IN_REWORK reset — never
// a completion announcement.

suite('pushReworkChanges — fatal rework CLI failure (non-zero exit ≠ 124)', function() {

    test('isFailedCliReworkResponse: exit code 1 is fatal', function() {
        var loaded = loadPushReworkChangesForAction({});
        assert.equal(
            loaded.mod.isFailedCliReworkResponse(
                'CLI Command: ./run-agent.sh "/tmp/p.txt"\n'
                + 'Error: Command failed (exit code 1): ./run-agent.sh "/tmp/p.txt"\n'
                + 'Output:\n=== AGENT PROMPT START ===\n'),
            true, 'exit code 1 must classify as a fatal CLI failure');
    });

    test('isFailedCliReworkResponse: exit code 124 stays interruption-class', function() {
        var loaded = loadPushReworkChangesForAction({});
        assert.equal(
            loaded.mod.isFailedCliReworkResponse(
                'Error: Command failed (exit code 124): ./run-agent.sh'),
            false, '124 is the interrupted/timeout class — isInterruptedReworkResponse owns it');
    });

    test('isFailedCliReworkResponse: a normal summary is not fatal', function() {
        var loaded = loadPushReworkChangesForAction({});
        assert.equal(
            loaded.mod.isFailedCliReworkResponse('## Fix summary\n\nAll findings addressed.'),
            false, 'a completion summary must never classify as fatal');
        assert.equal(loaded.mod.isFailedCliReworkResponse(''), false);
        assert.equal(loaded.mod.isFailedCliReworkResponse(null), false);
    });

    test('action: fatal CLI failure posts ❌, resets to IN_REWORK, never announces completion', function() {
        var loaded = loadPushReworkChangesForAction({});
        var fatalResponse = 'CLI Command: ./factory-agents/scripts/run-agent.sh "/tmp/dmtools_cli_prompt.txt"\n'
            + 'Error: Command failed (exit code 1): ./factory-agents/scripts/run-agent.sh "/tmp/dmtools_cli_prompt.txt"\n'
            + 'Output:\n=== AGENT PROMPT START ===';

        var result = loaded.mod.action({
            ticket: { key: 'PROJ-123', fields: { labels: [] } },
            response: fatalResponse
        });

        assert.equal(result.success, false, 'a fatal CLI run must not report success');
        assert.equal(result.path, 'rework-cli-failed');

        var jiraBodies = loaded.jiraPostCommentCalls.map(function(c) { return String(c.body || c.comment || ''); });
        assert.ok(
            jiraBodies.some(function(b) { return b.indexOf('Rework CLI Failed') !== -1; }),
            'the failure must be posted to the ticket');
        assert.ok(
            !jiraBodies.some(function(b) { return b.indexOf('Rework Completed') !== -1; }),
            'must never post the success comment');
        assert.ok(
            !loaded.jiraMoveToStatusCalls.some(function(c) { return c.statusName === 'In Review'; }),
            'must never move the ticket to In Review');
        assert.ok(
            loaded.jiraMoveToStatusCalls.some(function(c) { return c.statusName === 'In Rework'; }),
            'the ticket goes back to In Rework for retry');
        assert.equal(loaded.resumeAgentCalls.length, 1, 'exactly one resume attempt');
        assert.equal(loaded.resumeAgentCalls[0].stage, 'rework_cli_failed');
    });

    test('action: resume attempt recurses once, then takes the failure path', function() {
        var attempts = 0;
        var loaded = loadPushReworkChangesForAction({}, {
            feedbackLoop: {
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function() {
                    attempts += 1;
                    return { attempted: attempts === 1 };
                }
            }
        });
        var fatalResponse = 'Error: Command failed (exit code 2): ./run-agent.sh';

        var result = loaded.mod.action({
            ticket: { key: 'PROJ-123', fields: { labels: [] } },
            response: fatalResponse
        });

        assert.equal(loaded.resumeAgentCalls.length, 2, 'resume tried once, then the recursion sees attempted=false');
        assert.equal(result.success, false);
        assert.equal(result.path, 'rework-cli-failed');
    });

    test('action: interruption class (124) keeps its existing resume semantics', function() {
        var loaded = loadPushReworkChangesForAction({});
        var result = loaded.mod.action({
            ticket: { key: 'PROJ-123', fields: { labels: [] } },
            response: 'Error: Command failed (exit code 124): ./run-agent.sh — timed out'
        });

        assert.equal(result.path, 'rework-interrupted', '124 must still take the interrupted path');
        assert.equal(result.success, true);
    });
});

// ── PR-anchored lookup + loud lookup failure (githubSource pr-N, fa #1212) ───
// Live fa #1212 (2026-10-04, run 37200002499, job 111429622376): the post-action
// looked up the PR for pseudo-ticket 'pr-1212' by scanning a single listPrs
// page for a title/head containing the literal key — the PR is titled/branched
// after the ORIGINAL work item ('ai/gh-1204') and was not even on the fetched
// page → "Could not find PR to post comment — skipping GitHub PR comment" →
// thread replies/resolutions SKIPPED, ticket still moved to In Review, WIP and
// agent:rework labels removed, cycle declared closed with success:true. The
// threads stayed unresolved, SM re-armed rework → infinite empty-lap loop.
//
// Two hard requirements proven here:
//   1. pr-N keys resolve the PR directly by number (REST pulls/{n}) — never
//      by list-scanning.
//   2. A PR-lookup failure after the rework push FAILS LOUDLY: no PR comment,
//      no status move, no label removal, no "cycle closed" — the leg returns
//      success:false with a greppable PR-LOOKUP-FAILED marker.
suite('pushReworkChanges — PR-anchored lookup & loud lookup failure (fa #1212)', function() {

    var PR_1212 = {
        number: 1212,
        title: 'ai/gh-1204: fix telemetry',
        head: { ref: 'ai/gh-1204' },
        state: 'open',
        html_url: 'https://github.com/IstiN/fa/pull/1212'
    };

    function loadAnchoredAction(scmOverrides, extraMocks) {
        var getPrCalls = [];
        var listCalls = [];
        var addCommentCalls = [];
        var moveCalls = [];
        var removedLabels = [];
        var ticketComments = [];

        var scm = Object.assign({
            getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'fa' }; },
            // Single page of unrelated open PRs — #1212 is NOT in it (fa #1212
            // lived past page 1 among 10+ open PRs).
            listPrs: function(state) {
                listCalls.push(state);
                return [{ number: 1200, title: 'ai/gh-800: unrelated', head: { ref: 'ai/gh-800' }, changed_files: 2 }];
            },
            getPr: function(id) { getPrCalls.push(id); return PR_1212; },
            addComment: function(prId, text) { addCommentCalls.push({ prId: prId, text: text }); },
            listReviews: function() { return []; }
        }, scmOverrides || {});

        var mocks = Object.assign({
            cli_execute_command: function(args) {
                if (args.command === 'git branch --show-current') return 'ai/gh-1204\n';
                if (args.command.indexOf('git ls-remote --heads origin') === 0) {
                    return 'abc123\trefs/heads/ai/gh-1204\n';
                }
                return '';
            },
            file_read: function(args) {
                var p = args && (args.path || args);
                if (p && p.indexOf('rework_setup_failed.md') !== -1) {
                    throw new Error('File does not exist');
                }
                if (p && p.indexOf('pr_info.md') !== -1) {
                    return '**Branch**: `ai/gh-1204` → `main`';
                }
                return null;
            },
            jira_post_comment: function(args) { ticketComments.push(args.comment || args.body || ''); },
            jira_move_to_status: function(args) { moveCalls.push(args.statusName); },
            jira_remove_label: function(args) { removedLabels.push(args.label); },
            jira_assign_ticket_to: function() {}
        }, extraMocks || {});

        var loaded = loadPushReworkChangesForAction(mocks, { scm: scm });

        return {
            loaded: loaded,
            getPrCalls: getPrCalls,
            listCalls: listCalls,
            addCommentCalls: addCommentCalls,
            moveCalls: moveCalls,
            removedLabels: removedLabels,
            ticketComments: ticketComments,
            run: function() {
                return loaded.mod.action({
                    ticket: { key: 'pr-1212', fields: { labels: [] } },
                    metadata: { contextId: 'pr_rework' },
                    response: 'Fix summary long enough to be a meaningful rework completion summary.',
                    customParams: { removeLabels: ['agent:rework'] }
                });
            }
        };
    }

    test('repro (fa #1212): pr-1212 post-action finds PR #1212 directly by number and posts to it', function() {
        var fx = loadAnchoredAction();
        var result = fx.run();

        assert.equal(result.success, true, 'the rework leg completes');
        assert.equal(result.prUrl, 'https://github.com/IstiN/fa/pull/1212');
        assert.equal(fx.getPrCalls.length, 1, 'exactly one direct get-by-number fetch');
        assert.equal(String(fx.getPrCalls[0]), '1212', 'pulls/1212 is the lookup path');
        assert.equal(fx.listCalls.length, 0, 'anchored keys must not list-scan at all');
        assert.ok(
            fx.addCommentCalls.some(function(c) { return c.prId === 1212; }),
            'the fix summary must be posted to PR #1212 (was silently skipped pre-fix)'
        );
    });

    test('loud failure: PR lookup fails → leg fails, cycle-close steps never run', function() {
        var fx = loadAnchoredAction({
            getPr: function() { throw new Error('pulls/1212 not found'); },
            listPrs: function() { return []; }
        });
        var result = fx.run();

        assert.equal(result.success, false, 'a skipped-lookup leg must NOT report success');
        assert.contains(String(result.error), 'PR-LOOKUP-FAILED', 'greppable marker in the job result');
        assert.contains(String(result.error), 'pr-1212');
        assert.equal(fx.addCommentCalls.length, 0, 'nothing was posted to any PR');
        assert.equal(
            fx.moveCalls.filter(function(s) { return s === 'In Review'; }).length, 0,
            'the ticket must NOT be moved to In Review — replies/resolutions were skipped for infrastructure reasons'
        );
        assert.equal(fx.removedLabels.length, 0,
            'no label removal (agent:rework / WIP) — the rework cycle was NOT closed');
        assert.ok(
            fx.ticketComments.some(function(c) { return String(c).indexOf('PR-LOOKUP-FAILED') !== -1; }),
            'a job-summary line reaches the tracker error comment'
        );
        assert.equal(fx.loaded.resumeAgentCalls.length, 1, 'one resume attempt, then the honest failure');
    });

    test('loud failure: closed/merged anchored PR also fails loudly instead of silently skipping', function() {
        var fx = loadAnchoredAction({
            getPr: function(id) { fx.getPrCalls.push(id); return Object.assign({}, PR_1212, { state: 'closed' }); }
        });
        fx.getPrCalls = [];
        var result = fx.run();

        assert.equal(result.success, false);
        assert.contains(String(result.error), 'PR-LOOKUP-FAILED');
        assert.equal(fx.removedLabels.length, 0, 'cycle not closed');
    });

    test('jira regression: jira-shaped ticket keeps the exact pre-change lookup and completion path', function() {
        var listCalls = [];
        var getPrCalls = [];
        var addCommentCalls = [];
        var moveCalls = [];
        var ticketComments = [];

        var loaded = loadPushReworkChangesForAction({
            jira_post_comment: function(args) { ticketComments.push(args.comment || args.body || ''); },
            jira_move_to_status: function(args) { moveCalls.push(args.statusName); }
        }, {
            scm: {
                getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
                listPrs: function(state) {
                    listCalls.push(state);
                    return [{
                        number: 123,
                        title: 'PROJ-123: rework fix',
                        head: { ref: 'bug/PROJ-123' },
                        html_url: 'https://github.com/IstiN/dmtools-agents/pull/123'
                    }];
                },
                getPr: function(id) { getPrCalls.push(id); return { number: 123 }; },
                addComment: function(prId, text) { addCommentCalls.push({ prId: prId, text: text }); },
                listReviews: function() { return []; }
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'PROJ-123', fields: { labels: [] } },
            response: 'Some fix summary that should be pushed normally.'
        });

        // Byte-identical jiraSource path: list-scan lookup, PR comment posted,
        // ticket moved to In Review, completion comment, success.
        assert.equal(result.success, true);
        assert.deepEqual(listCalls, ['open'], 'unchanged single open-state list call');
        assert.equal(getPrCalls.length, 0, 'jira keys never switch to get-by-number');
        assert.ok(addCommentCalls.some(function(c) { return c.prId === 123; }), 'fix summary posted to the scanned PR');
        assert.ok(moveCalls.some(function(s) { return s === 'In Review'; }), 'In Review move preserved');
        assert.ok(
            ticketComments.some(function(c) { return String(c).indexOf('Rework Completed') !== -1; }),
            'completion comment to the Jira ticket preserved'
        );
        assert.equal(result.branchName, 'bug/PROJ-123');
    });
});

// ── gh-799: complete rework picture + honest live-rechecked completion ───────
// Live incident (fa PR #1420, run 37806292238, 2026-10-08): the post-action
// posted "Rework Analysis Completed — ... no code changes are required" from
// the STALE input snapshot while the PR's review state required changes, and
// outputs/review_replies.json carried "threadId": null (untargeted reply →
// combined PR comment). Three contract hardenings live here:
//   1. reply coverage — N open threads in, fewer than N targeted replies out
//      is a LOUD warning (log + completion comment), never a silent fold into
//      a "nothing required" story;
//   2. completion honesty — the completion comment is generated from a LIVE
//      unresolved-threads re-fetch (same call as input prep), so threads that
//      appeared mid-run are reported (the exact live incident shape);
//   3. wording gate — "no code changes are required" is allowed ONLY when the
//      live unresolved-thread count is 0 AND the verdict is not
//      CHANGES_REQUESTED AND every input thread got a targeted reply.

function ghThread(id, rootId, extra) {
    var t = {
        threadId: id,
        rootCommentId: rootId,
        resolved: false,
        path: 'src/a.dart',
        line: 12,
        body: 'Fix the null deref here'
    };
    return Object.assign(t, extra || {});
}

suite('pushReworkChanges — reply coverage (gh-799 AC2)', function() {

    test('counts only unresolved non-bot input threads as open', function() {
        var loaded = loadPushReworkChangesModule({});
        var coverage = loaded.mod.buildReplyCoverage([
            ghThread('PRRT_r', 1, { resolved: true }),
            ghThread('PRRT_o1', 2),
            ghThread('PRRT_bot', 3, { bot: true }),
            ghThread('PRRT_o2', 4)
        ], []);
        assert.equal(coverage.openCount, 2, 'resolved and bot threads are not the agent\'s obligation');
        assert.equal(coverage.unaddressed.length, 2);
    });

    test('every open thread targeted by threadId → no gap (2+ item case)', function() {
        var loaded = loadPushReworkChangesModule({});
        var coverage = loaded.mod.buildReplyCoverage(
            [ghThread('PRRT_a', 1), ghThread('PRRT_b', 2), ghThread('PRRT_c', 3)],
            [{ threadId: 'PRRT_a', reply: 'one' }, { threadId: 'PRRT_b', reply: 'two' }, { threadId: 'PRRT_c', reply: 'three' }]
        );
        assert.equal(coverage.openCount, 3);
        assert.equal(coverage.unaddressed.length, 0, 'fully targeted input — no warning state');
    });

    test('fewer targeted replies than open threads → unaddressed lists the uncovered threads', function() {
        var loaded = loadPushReworkChangesModule({});
        var coverage = loaded.mod.buildReplyCoverage(
            [ghThread('PRRT_a', 1), ghThread('PRRT_b', 2), ghThread('PRRT_c', 3)],
            [{ threadId: 'PRRT_a', reply: 'one' }]
        );
        assert.equal(coverage.openCount, 3);
        assert.equal(coverage.targetedCount, 1);
        assert.deepEqual(
            coverage.unaddressed.map(function(t) { return t.threadId; }),
            ['PRRT_b', 'PRRT_c'],
            'the coverage gap names exactly the threads without a targeted reply');
    });

    test('a null-threadId reply targets nothing (the live incident shape)', function() {
        var loaded = loadPushReworkChangesModule({});
        var coverage = loaded.mod.buildReplyCoverage(
            [ghThread('PRRT_a', 1)],
            [{ threadId: null, reply: 'combined-comment fallback text' }]
        );
        assert.equal(coverage.unaddressed.length, 1, 'the untargeted reply must not mask the gap');
        assert.equal(coverage.unaddressed[0].threadId, 'PRRT_a');
    });

    test('a reply matching by rootCommentId counts as targeted (post-enrichment parity with gh-692)', function() {
        var loaded = loadPushReworkChangesModule({});
        var coverage = loaded.mod.buildReplyCoverage(
            [ghThread('PRRT_a', 5550001)],
            [{ threadId: null, rootCommentId: 5550001, reply: 'fixed' }]
        );
        assert.equal(coverage.unaddressed.length, 0,
            'the reply IS thread-targeted (rootCommentId) — postThreadReplies enriches the threadId from it');
    });

    test('missing or empty inputs → zero counts, no crash', function() {
        var loaded = loadPushReworkChangesModule({});
        assert.equal(loaded.mod.buildReplyCoverage(null, null).openCount, 0);
        assert.equal(loaded.mod.buildReplyCoverage([], []).unaddressed.length, 0);
        assert.equal(loaded.mod.buildReplyCoverage([ghThread('PRRT_a', 1)], null).unaddressed.length, 1);
    });
});

suite('pushReworkChanges — loud coverage-gap warning (gh-799 AC2)', function() {

    test('one LOUD line per unaddressed thread with id and title, plus a summary line', function() {
        var loaded = loadPushReworkChangesModule({});
        var coverage = loaded.mod.buildReplyCoverage(
            [ghThread('PRRT_a', 1), ghThread('PRRT_b', 2, { path: 'src/b.dart', line: 40, body: 'Unused variable\nmore context' })],
            [{ threadId: 'PRRT_a', reply: 'one' }]
        );
        var lines = loaded.mod.logReplyCoverageGap(coverage);

        assert.equal(lines.length, 2, 'summary + one line per unaddressed thread');
        assert.ok(lines[0].indexOf('REPLY-COVERAGE-GAP:') === 0, 'greppable loud marker, got: ' + lines[0]);
        assert.contains(lines[0], '1/2');
        assert.contains(lines[1], 'PRRT_b');
        assert.contains(lines[1], 'src/b.dart');
        assert.contains(lines[1], 'Unused variable', 'the thread title/first body line is in the log');
    });

    test('fully covered input produces no warning lines', function() {
        var loaded = loadPushReworkChangesModule({});
        var coverage = loaded.mod.buildReplyCoverage(
            [ghThread('PRRT_a', 1)],
            [{ threadId: 'PRRT_a', reply: 'one' }]
        );
        assert.deepEqual(loaded.mod.logReplyCoverageGap(coverage), []);
    });
});

suite('pushReworkChanges — live unresolved-thread re-check (gh-799 AC3/AC5)', function() {

    test('uses the LIVE fetch, filtered to unresolved non-bot threads', function() {
        var loaded = loadPushReworkChangesModule({}, {
            fetchDiscussions: function() {
                return { rawThreads: { threads: [
                    ghThread('PRRT_open1', 1),
                    ghThread('PRRT_done', 2, { resolved: true }),
                    ghThread('PRRT_open2', 3),
                    ghThread('PRRT_bot', 4, { bot: true })
                ] } };
            }
        });
        var live = loaded.mod.fetchLiveOpenThreads(loaded.scm, { number: 1420 }, []);
        assert.deepEqual(
            live.map(function(t) { return t.threadId; }),
            ['PRRT_open1', 'PRRT_open2'],
            'the completion decision is made from the PR state at completion time, not the stale snapshot');
    });

    test('probe failure falls back to the input snapshot (never silently to zero)', function() {
        var loaded = loadPushReworkChangesModule({}, {
            fetchDiscussions: function() { throw new Error('GraphQL down'); }
        });
        var inputThreads = [ghThread('PRRT_a', 1), ghThread('PRRT_done', 2, { resolved: true })];
        var live = loaded.mod.fetchLiveOpenThreads(loaded.scm, { number: 1420 }, inputThreads);
        assert.deepEqual(live.map(function(t) { return t.threadId; }), ['PRRT_a'],
            'a broken probe degrades to the last known honest state, not to "no open threads"');
    });

    test('no probe or no PR → input snapshot fallback (honesty over silence)', function() {
        var loaded = loadPushReworkChangesModule({});
        var inputThreads = [ghThread('PRRT_a', 1)];
        assert.deepEqual(
            loaded.mod.fetchLiveOpenThreads(loaded.scm, { number: 1420 }, inputThreads).map(function(t) { return t.threadId; }),
            ['PRRT_a'], 'scm without fetchDiscussions');
        assert.deepEqual(
            loaded.mod.fetchLiveOpenThreads(null, { number: 1420 }, inputThreads).map(function(t) { return t.threadId; }),
            ['PRRT_a'], 'no scm at all');
        assert.deepEqual(
            loaded.mod.fetchLiveOpenThreads(loaded.scm, null, inputThreads).map(function(t) { return t.threadId; }),
            ['PRRT_a'], 'no PR → last known state, never a silent zero');
    });

    test('live zero threads → empty list (the honest zero)', function() {
        var loaded = loadPushReworkChangesModule({}, {
            fetchDiscussions: function() { return { rawThreads: null }; }
        });
        assert.deepEqual(loaded.mod.fetchLiveOpenThreads(loaded.scm, { number: 1420 }, [ghThread('PRRT_a', 1)]), [],
            'the input snapshot must NOT be used when the live PR genuinely has zero open threads');
    });
});

suite('pushReworkChanges — latestConcludedVerdict (gh-799)', function() {

    test('latest concluded review by submitted_at wins', function() {
        var loaded = loadPushReworkChangesModule({});
        var scm = { listReviews: function() { return [
            { state: 'APPROVED', submitted_at: '2026-10-08T18:00:00Z' },
            { state: 'CHANGES_REQUESTED', submitted_at: '2026-10-08T18:56:00Z' }
        ]; } };
        assert.equal(loaded.mod.latestConcludedVerdict(scm, { number: 1 }), 'CHANGES_REQUESTED');
    });

    test('PENDING/COMMENTED reviews are not the verdict', function() {
        var loaded = loadPushReworkChangesModule({});
        var scm = { listReviews: function() { return [
            { state: 'COMMENTED', submitted_at: '2026-10-08T19:00:00Z' },
            { state: 'APPROVED', submitted_at: '2026-10-08T18:00:00Z' }
        ]; } };
        assert.equal(loaded.mod.latestConcludedVerdict(scm, { number: 1 }), 'APPROVED');
    });

    test('fail-open: no reviews, no listReviews, probe throws, no PR → null', function() {
        var loaded = loadPushReworkChangesModule({});
        assert.equal(loaded.mod.latestConcludedVerdict({ listReviews: function() { return []; } }, { number: 1 }), null);
        assert.equal(loaded.mod.latestConcludedVerdict({}, { number: 1 }), null);
        assert.equal(loaded.mod.latestConcludedVerdict({ listReviews: function() { throw new Error('api down'); } }, { number: 1 }), null);
        assert.equal(loaded.mod.latestConcludedVerdict({ listReviews: function() { return [{ state: 'APPROVED' }]; } }, null), null);
    });
});

suite('pushReworkChanges — completion wording selection (gh-799 AC2–AC5)', function() {

    test('live open threads win over everything else (AC3/AC5)', function() {
        var loaded = loadPushReworkChangesModule({});
        assert.equal(loaded.mod.selectReworkCompletionWording(2, 0, null), 'open-threads');
        assert.equal(loaded.mod.selectReworkCompletionWording(2, 0, 'CHANGES_REQUESTED'), 'open-threads');
        assert.equal(loaded.mod.selectReworkCompletionWording(1, 1, 'APPROVED'), 'open-threads');
    });

    test('zero live threads but unaddressed input threads → coverage-gap wording (AC2)', function() {
        var loaded = loadPushReworkChangesModule({});
        assert.equal(loaded.mod.selectReworkCompletionWording(0, 1, null), 'unaddressed-replies');
    });

    test('zero live threads, all covered, CHANGES_REQUESTED verdict → honest verdict wording', function() {
        var loaded = loadPushReworkChangesModule({});
        assert.equal(loaded.mod.selectReworkCompletionWording(0, 0, 'CHANGES_REQUESTED'), 'changes-requested-verdict');
    });

    test('zero live threads, all covered, no blocking verdict → clean (AC4)', function() {
        var loaded = loadPushReworkChangesModule({});
        assert.equal(loaded.mod.selectReworkCompletionWording(0, 0, 'APPROVED'), 'clean');
        assert.equal(loaded.mod.selectReworkCompletionWording(0, 0, null), 'clean');
    });
});

suite('pushReworkChanges — completion comment wording (gh-799 AC2–AC5)', function() {

    var md = commentMarkupModule.forFlavor('markdown');

    function ctx(overrides) {
        return Object.assign({
            ticketKey: 'PROJ-123',
            prUrl: 'https://github.com/acme/widgets/pull/1420',
            branchName: 'ai/gh-1420',
            prCommentPosted: false,
            codeChangesCommitted: true,
            liveOpenThreads: [],
            inputThreads: [],
            unaddressed: [],
            verdict: null
        }, overrides || {});
    }

    test('2 live open threads NEVER produce the "no code changes are required" wording (AC3)', function() {
        var loaded = loadPushReworkChangesModule({});
        var out = loaded.mod.buildReworkCompletionComment(md, ctx({
            codeChangesCommitted: true,
            liveOpenThreads: [ghThread('PRRT_1', 1), ghThread('PRRT_2', 2)],
            inputThreads: [ghThread('PRRT_1', 1), ghThread('PRRT_2', 2)]
        }));
        assert.notContains(out, 'no code changes are required',
            'the live incident: "no code changes required" posted while threads were open');
        assert.contains(out, '2 review thread(s) remain open');
        assert.contains(out, 're-arm a threads-rework');
        assert.contains(out, 'PRRT_1');
        assert.contains(out, 'PRRT_2');
    });

    test('threads that appeared mid-run are labeled as drift and listed (AC5)', function() {
        var loaded = loadPushReworkChangesModule({});
        var out = loaded.mod.buildReworkCompletionComment(md, ctx({
            liveOpenThreads: [ghThread('PRRT_new', 9, { path: 'src/new.dart', line: 7, body: 'Late review finding' })],
            inputThreads: [],
            unaddressed: []
        }));
        assert.contains(out, 'PRRT_new');
        assert.contains(out, 'src/new.dart');
        assert.contains(out, 'Late review finding');
        assert.contains(out, 'appeared mid-run',
            'exactly the live incident shape: threads arrived after the input snapshot was written');
    });

    test('unaddressed input threads are labeled as such (AC2)', function() {
        var loaded = loadPushReworkChangesModule({});
        var out = loaded.mod.buildReworkCompletionComment(md, ctx({
            liveOpenThreads: [ghThread('PRRT_1', 1), ghThread('PRRT_2', 2)],
            inputThreads: [ghThread('PRRT_1', 1), ghThread('PRRT_2', 2)],
            unaddressed: [ghThread('PRRT_2', 2)]
        }));
        var lines = out.split('\n');
        var line1 = lines.filter(function(l) { return l.indexOf('PRRT_1') !== -1; })[0];
        var line2 = lines.filter(function(l) { return l.indexOf('PRRT_2') !== -1; })[0];
        assert.ok(line1, 'PRRT_1 listed');
        assert.ok(line2, 'PRRT_2 listed');
        assert.contains(line1, 'reply posted, thread still open');
        assert.contains(line2, 'not addressed by any reply in `outputs/review_replies.json`');
    });

    test('a thread with a posted reply that is still open live is labeled as such', function() {
        var loaded = loadPushReworkChangesModule({});
        var out = loaded.mod.buildReworkCompletionComment(md, ctx({
            liveOpenThreads: [ghThread('PRRT_1', 1)],
            inputThreads: [ghThread('PRRT_1', 1)],
            unaddressed: []
        }));
        assert.contains(out, 'reply posted, thread still open');
    });

    test('clean path: no code changes committed → exact historical wording preserved (AC4)', function() {
        var loaded = loadPushReworkChangesModule({});
        var out = loaded.mod.buildReworkCompletionComment(md, ctx({
            codeChangesCommitted: false,
            prCommentPosted: true
        }));
        assert.contains(out, '### ✅ Rework Analysis Completed');
        assert.contains(out, 'AI Teammate analyzed all PR review comments and determined no code changes are required.');
        assert.contains(out, 'A fix summary has been posted as a comment on the Pull Request.');
    });

    test('clean path: code changes committed → exact historical wording preserved (AC4)', function() {
        var loaded = loadPushReworkChangesModule({});
        var out = loaded.mod.buildReworkCompletionComment(md, ctx({ codeChangesCommitted: true }));
        assert.contains(out, '### ✅ Rework Completed');
        assert.contains(out, 'AI Teammate has addressed all PR review comments and pushed the fixes.');
    });

    test('CHANGES_REQUESTED verdict with zero open threads → honest verdict wording, never "no code changes"', function() {
        var loaded = loadPushReworkChangesModule({});
        var out = loaded.mod.buildReworkCompletionComment(md, ctx({
            codeChangesCommitted: false,
            verdict: 'CHANGES_REQUESTED'
        }));
        assert.notContains(out, 'no code changes are required');
        assert.contains(out, 'CHANGES_REQUESTED');
    });

    test('unaddressed replies with zero live threads → coverage listing, never "no code changes" (AC2)', function() {
        var loaded = loadPushReworkChangesModule({});
        var out = loaded.mod.buildReworkCompletionComment(md, ctx({
            codeChangesCommitted: true,
            inputThreads: [ghThread('PRRT_1', 1)],
            unaddressed: [ghThread('PRRT_1', 1)]
        }));
        assert.notContains(out, 'no code changes are required');
        assert.contains(out, 'PRRT_1');
        assert.contains(out, 'review_replies.json');
    });

    test('jira flavor renders wiki markup for the open-threads wording', function() {
        var loaded = loadPushReworkChangesModule({});
        var jm = commentMarkupModule.forFlavor('jira');
        var out = loaded.mod.buildReworkCompletionComment(jm, ctx({
            liveOpenThreads: [ghThread('PRRT_1', 1)],
            inputThreads: [ghThread('PRRT_1', 1)]
        }));
        assert.ok(out.indexOf('h3. ⚠️ Rework Completed') === 0, 'jira wiki heading, got: ' + out.substring(0, 40));
        assert.contains(out, '*Branch*: {code}ai/gh-1420{code}');
        assert.contains(out, '{code}PRRT_1{code}');
    });
});

suite('pushReworkChanges.action — completion live re-check wiring (gh-799 AC5 drift)', function() {

    test('threads appearing mid-run reach the completion comment; wording is never "no code changes"', function() {
        var liveFetchCalls = [];
        var fileMap = {
            'input/PROJ-123/pr_info.md': '**Branch**: `ai/gh-1420` → `main`',
            'input/PROJ-123/pr_discussions_raw.json': JSON.stringify({ threads: [ghThread('PRRT_in_1', 100)] }),
            'outputs/review_replies.json': JSON.stringify({
                replies: [{ inReplyToId: 100, threadId: 'PRRT_in_1', reply: 'Fixed the reported issue.' }]
            })
        };
        var loaded = loadPushReworkChangesForAction({
            file_read: function(args) {
                var p = args && (args.path || args);
                if (p && p.indexOf('rework_setup_failed.md') !== -1) throw new Error('File does not exist');
                return fileMap[p] !== undefined ? fileMap[p] : null;
            },
            github_remove_label: function() { return '{}'; }
        }, {
            outputFiles: loadModule('js/common/outputFiles.js', makeRequire({}), {
                file_read: function(args) {
                    var p = args && (args.path || args);
                    return fileMap[p] !== undefined ? fileMap[p] : null;
                }
            }),
            scm: {
                getRemoteRepoInfo: function() { return { owner: 'acme', repo: 'widgets' }; },
                listPrs: function() {
                    return [{ number: 1420, title: 'PROJ-123: rework fix', head: { ref: 'ai/gh-1420' },
                        html_url: 'https://github.com/acme/widgets/pull/1420' }];
                },
                replyToThread: function() {},
                resolveThread: function() {},
                addComment: function() {},
                listReviews: function() {
                    return [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-10-08T18:56:00Z' }];
                },
                fetchDiscussions: function(prId) {
                    liveFetchCalls.push(prId);
                    return { rawThreads: { threads: [
                        ghThread('PRRT_in_1', 100, { resolved: true }),
                        ghThread('PRRT_late_1', 200, { path: 'src/late.dart', line: 3, body: 'Late finding one' }),
                        ghThread('PRRT_late_2', 300, { path: 'src/late2.dart', line: 9, body: 'Late finding two' })
                    ] } };
                }
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'PROJ-123', fields: { labels: [] } },
            response: 'Fix summary long enough to be a meaningful rework completion summary.'
        });

        assert.equal(result.success, true);
        assert.ok(liveFetchCalls.length >= 1, 'the completion comment is generated from a LIVE re-fetch' +
            ' (2 calls = gh-692 closure sweep + the completion re-check — both legitimate)');
        var completion = loaded.jiraPostCommentCalls.filter(function(c) {
            return String(c.comment || c.body || '').indexOf('remain open') !== -1;
        })[0];
        assert.ok(completion, 'an honest open-threads completion comment was posted');
        var text = String(completion.comment || completion.body);
        assert.notContains(text, 'no code changes are required');
        assert.contains(text, '2 review thread(s) remain open');
        assert.contains(text, 'PRRT_late_1');
        assert.contains(text, 'PRRT_late_2');
        assert.contains(text, 'appeared mid-run');
    });
});
