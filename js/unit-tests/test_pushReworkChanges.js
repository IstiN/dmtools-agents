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

function makeOutputFiles(fileMap) {
    return loadModule('js/common/outputFiles.js', makeRequire({}), {
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        }
    });
}

function loadPushReworkChangesModule(fileMap) {
    var outputFiles = makeOutputFiles(fileMap);
    var replyCalls = [];
    var resolveCalls = [];
    var addCommentCalls = [];

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

    var noop = function() {};
    var mod = loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return {}; } },
            './common/scm.js': { createScm: function() { return scm; } },
            './common/submodules.js': {},
            './common/pullRequest.js': {},
            './common/feedbackLoop.js': {},
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: noop },
            './common/outputFiles.js': outputFiles,
            './config.js': configModule,
            './cacheToReleases.js': { cacheSessionLog: noop },
            './common/tokenUsageComment.js': { postTokenUsageComments: noop }
        }),
        {
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                return fileMap[path] !== undefined ? fileMap[path] : null;
            }
        }
    );

    return { mod: mod, scm: scm, replyCalls: replyCalls, resolveCalls: resolveCalls, addCommentCalls: addCommentCalls };
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

// ── commitAndPush: base-branch safety invariant ──────────────────────────────
// Never commit/push while HEAD sits on the repo's base branch instead of the
// expected PR branch (the failure mode that let WIP auto-save commits land
// on develop/main when branch setup silently failed).

function loadPushReworkChangesForCommitAndPush(mocks) {
    return loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
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
            './common/feedbackLoop.js': {
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function() { return { attempted: false }; }
            },
            './common/autoStart.js': { triggerSmIfIdle: function() {} },
            './common/outputFiles.js': { readOutputFile: function() { return null; } },
            './cacheToReleases.js': {},
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
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

    test('refuses outright when pr_info.md is missing (no PR to push to)', function() {
        var mod = loadPushReworkChangesForCommitAndPush({
            file_read: function() { throw new Error('File does not exist'); }
        });

        assert.throws(function() {
            mod.commitAndPush('PROJ-123', baseConfig(), {});
        }, 'must refuse to commit/push without a known expected branch');
    });
});

// ── action(): rework_setup_failed.md guard (issue #310) ──────────────────────
// preCliReworkSetup.js writes input/<ticketKey>/rework_setup_failed.md (via
// failSetup()) when it could not find/checkout a PR for the ticket, e.g. "no PR
// found for ticket". pushReworkChanges must detect that marker BEFORE calling
// commitAndPush()/resumeAgent() — retrying the CLI cannot fix a missing PR, and
// in the observed incident retrying instead led the CLI agent to fabricate a
// fake pr_info.md just to slip past the "refuse to commit on base branch" guard.

function loadPushReworkChangesForAction(mocks) {
    var jiraPostCommentCalls = [];
    var jiraMoveToStatusCalls = [];
    var resumeAgentCalls = [];
    var cliCommands = [];

    var scm = {
        listPrs: function() { return []; },
        getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; }
    };

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

    var mod = loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './configLoader.js': {
                loadProjectConfig: function() { return baseConfig(); },
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
            './common/feedbackLoop.js': {
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function(args) { resumeAgentCalls.push(args); return { attempted: false }; }
            },
            './common/autoStart.js': {
                triggerSmIfIdle: function() {},
                triggerConfiguredWorkflowForTicket: function() { return false; }
            },
            './common/outputFiles.js': { readOutputFile: function() { return null; } },
            './config.js': configModule,
            './cacheToReleases.js': { action: function() {} },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        Object.assign({}, defaultMocks, mocks || {})
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

// ── action(): resumeAgent exception safety ───────────────────────────────────
// feedbackLoop.resumeAgent() shells out (mkdir/bash/run-agent.sh --continue) and
// can itself throw (e.g. blocked by a misconfigured CLI_ALLOWED_COMMANDS whitelist). Every
// call site wraps it via tryResumeAgent() so that failure is treated the same as
// { attempted: false } instead of propagating and skipping the honest error-comment fallback.

function loadPushReworkChangesForResumeSafety(mocks, feedbackLoopOverrides) {
    return loadModule(
        'js/pushReworkChanges.js',
        makeRequire({
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/submodules.js': { pushManagedSubmodules: function() {} },
            './common/pullRequest.js': {},
            './common/feedbackLoop.js': Object.assign({
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function() { return { attempted: false }; }
            }, feedbackLoopOverrides || {}),
            './common/autoStart.js': { triggerSmIfIdle: function() {}, triggerConfiguredWorkflowForTicket: function() {} },
            './common/outputFiles.js': { readOutputFile: function() { return null; } },
            './config.js': configModule,
            './cacheToReleases.js': { action: function() {} },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        Object.assign({
            cli_execute_command: function() { return ''; },
            file_read: function() { return null; },
            jira_post_comment: function() {},
            jira_move_to_status: function() {},
            jira_remove_label: function() {},
            jira_assign_ticket_to: function() {}
        }, mocks || {})
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
