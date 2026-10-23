/**
 * Unit tests for js/postTestReworkResults.js — canonical MERGE_HEAD probe.
 *
 * gh-761 review (IMPORTANT): the module carried a local isMergeInProgress()
 * duplicate of js/common/mergeState.js whose semantics drifted — it returned
 * true on ANY non-throwing cli_execute_command call (no non-empty-output
 * requirement). These tests pin the canonical probe semantics:
 *   - a loose double returning '' for unknown commands is NOT a merge;
 *   - a resolved MERGE_HEAD (non-empty sha) is a merge in progress.
 */

// Real PR helper (gh-912): the push-verify SHA extraction lives there — the
// strict ref-line parser must be exercised, not a stub.
var prHelperRealForRework = loadModule('js/common/pullRequest.js',
    makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }));

function loadPostTestReworkResults(cliMock) {
    return loadModule(
        'js/postTestReworkResults.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': {
                formatTemplate: function(template, vars) {
                    return 'test/' + vars.ticketKey + ' ' + vars.result;
                }
            },
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/feedbackLoop.js': {},
            './common/commentMarkup.js': loadModule('js/common/commentMarkup.js',
                makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') })),
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), {}),
            './common/pullRequest.js': prHelperRealForRework,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }),
        { cli_execute_command: cliMock }
    );
}

var REWORK_CONFIG = {
    git: { baseBranch: 'main' },
    formats: { commitMessage: { testRework: '{{ticketKey}} {{result}}' } }
};

var SHA40 = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec';

/**
 * Build a cli_execute_command double.
 *  - mergeHeadSha: probe returns this sha (merge in progress)
 *  - loose: probe RETURNS '' instead of throwing (loose test double — the
 *    drift detector: the old local probe misread this as "merge in progress")
 *  - lsRemote: capture for `git ls-remote --heads origin <branch>`; defaults
 *    to a realistic `<40-hex>\trefs/heads/<branch>` ref line (gh-912: probes
 *    decide on ref lines, so mocks must carry real ones).
 */
function makeCli(options) {
    options = options || {};
    var calls = [];
    var lsRemoteCapture = options.lsRemote !== undefined
        ? options.lsRemote
        : SHA40 + '\trefs/heads/' + (options.branch || 'test/PROJ-123');
    var fn = function(args) {
        var command = args.command;
        calls.push(command);
        if (command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
            if (options.mergeHeadSha) return options.mergeHeadSha;
            if (options.loose) return '';
            throw new Error('Command execution failed (exit code 1)'); // real git: no MERGE_HEAD
        }
        if (command === 'git branch --show-current') return options.branch || 'test/PROJ-123';
        if (command.indexOf('git ls-remote --heads origin') === 0) {
            return lsRemoteCapture;
        }
        if (command === 'git rev-parse HEAD') return options.headSha || SHA40;
        return '';
    };
    fn.calls = calls;
    return fn;
}

suite('postTestReworkResults — canonical MERGE_HEAD probe (gh-761)', function() {

    test('a loose cli double returning "" for the probe is NOT a merge in progress (drift guard)', function() {
        var cli = makeCli({ loose: true });
        var m = loadPostTestReworkResults(cli);

        var committed = m.commitIfNeeded('PROJ-123', true, REWORK_CONFIG);

        assert.equal(committed, false,
            'empty probe output + clean tree → no merge in progress → nothing to commit');
        assert.equal(cli.calls.filter(function(c) { return c.indexOf('git commit') === 0; }).length, 0,
            'must not finalize a phantom merge commit');
    });

    test('a resolved MERGE_HEAD (non-empty sha) is a merge in progress — the merge commit is still made', function() {
        var cli = makeCli({ mergeHeadSha: '9a7e2aecommitsha\n' });
        var m = loadPostTestReworkResults(cli);

        var committed = m.commitIfNeeded('PROJ-123', true, REWORK_CONFIG);

        assert.equal(committed, true, 'unconcluded merge with empty staged diff still needs its merge commit');
        assert.ok(cli.calls.some(function(c) { return c.indexOf('git commit') === 0; }),
            'merge finalization commit created');
    });

    test('probes MERGE_HEAD with the canonical git command', function() {
        var cli = makeCli({});
        var m = loadPostTestReworkResults(cli);

        m.commitIfNeeded('PROJ-123', true, REWORK_CONFIG);

        assert.ok(cli.calls.some(function(c) {
            return c.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1;
        }), 'the canonical MERGE_HEAD probe command must be issued');
    });

    test('a dirty PR with NO merge in progress still merges the base branch (drift skipped it before)', function() {
        var cli = makeCli({ loose: true });
        var m = loadPostTestReworkResults(cli);

        var branch = m.commitAndPush('PROJ-123', true, REWORK_CONFIG, true);

        assert.equal(branch, 'test/PROJ-123', 'push flow completes');
        var mergeCalls = cli.calls.filter(function(c) {
            return c.indexOf('git merge origin/main') === 0;
        });
        assert.ok(mergeCalls.length > 0,
            'prIsDirty + no merge in progress → base-branch merge must be started');
    });

});

// ── gh-912: push-verify extracts the SHA from the ref line ───────────────────
// The JS bridge merges stderr into every capture. The old
// `remoteCheck.split(/\s+/)[0]` read the FIRST whitespace token of the
// capture — on a central-mode runner that is `warning:` (git ≥ 2.54 prints
// `warning: redirecting to …` on every network command), so a SUCCESSFUL
// push was reported as "Push rejected". AC4: the SHA comes from the matched
// `refs/heads/<branch>` line; a warning-only capture is "branch not found".

suite('postTestReworkResults.commitAndPush — push-verify SHA extraction (gh-912 AC4)', function() {

    test('IT-1: warning-polluted capture with a real ref line verifies successfully', function() {
        var cli = makeCli({
            lsRemote: 'warning: redirecting to https://git.example.com/\n' +
                SHA40 + '\trefs/heads/test/PROJ-123'
        });
        var m = loadPostTestReworkResults(cli);

        var branch = m.commitAndPush('PROJ-123', true, REWORK_CONFIG, false);

        assert.equal(branch, 'test/PROJ-123',
            'a successful push must not be misreported as rejected because of stderr noise');
    });

    test('warning-only capture → "Branch not found on remote after push", never a phantom SHA mismatch', function() {
        var cli = makeCli({
            lsRemote: 'warning: redirecting to https://git.example.com/\n'
        });
        var m = loadPostTestReworkResults(cli);

        var err = null;
        try { m.commitAndPush('PROJ-123', true, REWORK_CONFIG, false); } catch (e) { err = e; }

        assert.ok(err, 'a push that produced no ref line must be reported');
        assert.contains(err.message, 'Branch not found on remote after push',
            'stderr noise must never be parsed as a SHA — got: ' + err.message);
    });

    test('SHA mismatch detection survives: a different remote tip still fails the verify', function() {
        var otherSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
        var cli = makeCli({
            headSha: SHA40,
            lsRemote: otherSha + '\trefs/heads/test/PROJ-123'
        });
        var m = loadPostTestReworkResults(cli);

        var err = null;
        try { m.commitAndPush('PROJ-123', true, REWORK_CONFIG, false); } catch (e) { err = e; }

        assert.ok(err, 'a genuinely mismatched remote tip must still be caught');
        assert.contains(err.message, 'Push rejected',
            'the mismatch error is preserved for real mismatches — got: ' + err.message);
    });

});

// ── gh-770: per-tracker markup for the test-rework completion comment ────────
// Step 6 historically hard-coded Jira wiki markup (h3., *bold*, {code}) and
// posted via raw jira_post_comment; on a GitHub-backed tracker the comment
// rendered as raw text garbage. The builder is extracted so the flavor choice
// (commentMarkup.forTicket) is testable per tracker, and posting goes through
// the probed tracker (trackers.js).

var testReworkCommentMarkup = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));

suite('postTestReworkResults.buildTestReworkResultComment — per-tracker markup (gh-770)', function() {

    function build(flavor, ctx) {
        return loadPostTestReworkResults(makeCli())
            .buildTestReworkResultComment(flavor, ctx);
    }

    test('jira flavor is byte-identical to the historical wiki template', function() {
        var out = build(testReworkCommentMarkup.forFlavor('jira'), {
            passed: true,
            testStatus: 'passed',
            branchName: 'test/PROJ-9',
            prUrl: 'https://github.com/acme/widgets/pull/9',
            fixSummary: 'fixed the flaky assertion'
        });
        assert.equal(out,
            'h3. 🔧 Test Rework Completed\n\n' +
            '*Re-run result*: ✅ *PASSED*\n' +
            '*Branch*: {code}test/PROJ-9{code}\n' +
            '*Pull Request*: https://github.com/acme/widgets/pull/9\n' +
            '\n' +
            'fixed the flaky assertion');
    });

    test('markdown flavor renders the same facts GitHub-safe — no wiki constructs', function() {
        var out = build(testReworkCommentMarkup.forFlavor('markdown'), {
            passed: true,
            testStatus: 'passed',
            branchName: 'test/gh-9',
            prUrl: 'https://github.com/acme/widgets/pull/9',
            fixSummary: 'fixed the flaky assertion'
        });
        assert.ok(out.indexOf('### 🔧 Test Rework Completed\n') === 0, 'markdown heading');
        assert.ok(out.indexOf('**Re-run result**: ✅ **PASSED**') !== -1);
        assert.ok(out.indexOf('**Branch**') !== -1);
        assert.ok(out.indexOf('**Pull Request**') !== -1);
        assert.equal(out.indexOf('h3.'), -1, 'no wiki heading');
        assert.equal(out.indexOf('{code'), -1, 'no wiki code tag');
    });

    test('failed re-run flips the emoji and the status emphasis', function() {
        var out = build(testReworkCommentMarkup.forFlavor('jira'), {
            passed: false,
            testStatus: 'failed',
            branchName: 'b',
            fixSummary: 'still red'
        });
        assert.ok(out.indexOf('h3. 🔧 Test Rework Completed\n') === 0);
        assert.ok(out.indexOf('*Re-run result*: ❌ *FAILED*') !== -1);
        assert.ok(out.indexOf('*Pull Request*') === -1, 'no PR line when there is no PR');
        assert.ok(out.indexOf('still red') !== -1);
    });

});

// ── gh-928: end-to-end characterization of action() and createPRIfMissing ────
// These pin the CURRENT postJSAction wiring of pr_test_automation_rework:
// result-json handling, status normalization, gates, commit/push, PR
// create-if-missing, thread replies, PR body/comment, status moves, tracker
// comment, label release, autoStart and the failure/resume paths. They are the
// safety net for the CRAP refactor of action() — behaviour must not move.

var REWORK_ACTION_CONFIG = {
    workingDir: '/repo',
    git: { baseBranch: 'main', authorName: 'AI Teammate', authorEmail: 'agent@example.com' },
    formats: { commitMessage: { testRework: '{ticketKey} test rework {result}' } },
    jira: { statuses: { IN_REVIEW_PASSED: 'In Review - Passed', IN_REVIEW_FAILED: 'In Review - Failed' } }
};

var REWORK_PR12 = {
    number: 12,
    html_url: 'https://github.com/acme/widgets/pull/12',
    head: { ref: 'test/PROJ-123' },
    base: { ref: 'main' }
};

var SHA40_ACTION = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec';

/** file_read double driven by an explicit path→content map (blocks real config). */
function makeReworkFileReadMock(files) {
    return function(args) {
        var p = args && args.path ? args.path : args;
        if (files[p] !== undefined) return files[p];
        if (p && p.indexOf('.dmtools/config') !== -1) return null;
        return null;
    };
}

/** cli_execute_command double with realistic git answers for the rework flow. */
function makeReworkCliMock(recorded, deps) {
    return function(args) {
        var command = args.command;
        recorded.cli.push(command);
        if (command === 'git branch --show-current') return 'test/PROJ-123';
        if (command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
            throw new Error('Command execution failed (exit code 1)'); // no MERGE_HEAD
        }
        if (command === 'git rev-parse HEAD') return SHA40_ACTION;
        if (command.indexOf('git ls-remote --heads origin') === 0) {
            return SHA40_ACTION + '\trefs/heads/' + command.replace('git ls-remote --heads origin ', '');
        }
        if (command === 'git diff --cached --stat') return deps.stagedStat || '';
        return '';
    };
}

/** scm double recording body/comment/thread side effects. */
function makeReworkScmMock(recorded, deps) {
    var scm = deps.scm || {
        updatePrBody: function(number, body) { recorded.prBodies.push({ number: number, body: body }); },
        addComment: function(number, body) { recorded.prComments.push({ number: number, body: body }); },
        replyToThread: function(number, thread, text) { recorded.threadReplies.push({ number: number, thread: thread, text: text }); },
        resolveThread: function(number, thread) { recorded.threadResolves.push({ number: number, thread: thread }); }
    };
    scm.openPrs = deps.openPrs !== undefined ? deps.openPrs : [REWORK_PR12];
    scm.listPrs = function(state) { return this.openPrs; };
    return scm;
}

/** tracker double recording comments, label removals and status moves. */
function makeReworkTrackerMock(recorded) {
    return {
        postComment: function(key, body) { recorded.trackerComments.push({ key: key, body: body }); },
        removeLabel: function(key, label) { recorded.labelRemovals.push({ key: key, label: label }); },
        moveToStatusOrMark: function(key, status, stageKey) {
            recorded.statusMoves.push({ key: key, status: status, stageKey: stageKey });
            return { moved: true, marked: false };
        },
        getIssue: function(key) {
            return { key: key, fields: { summary: 'Fix flaky login test' } };
        }
    };
}

/** feedbackLoop double with per-deps gate results and resume recording. */
function makeReworkFeedbackLoopMock(recorded, deps) {
    return {
        runQualityGates: function(opts) {
            recorded.qualityGates.push(opts);
            return deps.qualityGateResult !== undefined ? deps.qualityGateResult : { success: true };
        },
        runPolicyGates: function(opts) {
            recorded.policyGates.push(opts);
            return deps.policyGateResult !== undefined ? deps.policyGateResult : { success: true };
        },
        resumeAgent: function(opts) {
            recorded.resumeCalls.push(opts);
            return deps.resumeAttempted ? { attempted: true } : { attempted: false };
        }
    };
}

/** autoStart double recording both trigger kinds. */
function makeReworkAutoStartMock(recorded, deps) {
    return {
        triggerConfiguredWorkflowForTicket: function(opts) {
            recorded.configuredTriggers.push(opts);
            return deps.configuredTriggerResult || false;
        },
        triggerSmIfIdle: function(opts) { recorded.smTriggers.push(opts); }
    };
}

// Shared mutable state for the hoisted configLoader closures — the factories
// below must stay flat: nested closure bodies double-count into the factory's
// complexity and blow the per-function CRAP ≤ 8 gate for new functions.
var reworkHarnessState = { deps: {}, scm: null };

function reworkLoadProjectConfig() {
    var deps = reworkHarnessState.deps;
    if (deps.configError) throw new Error(deps.configError);
    return REWORK_ACTION_CONFIG;
}

function reworkCreateScm() {
    return reworkHarnessState.scm;
}

function reworkFormatTemplate(template, vars) {
    var out = template;
    for (var k in vars) {
        if (vars.hasOwnProperty(k)) {
            out = out.split('{' + k + '}').join(vars[k] === undefined ? '' : vars[k]);
        }
    }
    return out;
}

function reworkResolveInstructions() {
    return { jobParamPatch: reworkHarnessState.deps.jobParamPatch || {} };
}

/** configLoader double over the shared REWORK_ACTION_CONFIG. */
function makeReworkConfigLoaderMock(deps, scm) {
    reworkHarnessState.deps = deps;
    reworkHarnessState.scm = scm;
    return {
        loadProjectConfig: reworkLoadProjectConfig,
        createScm: reworkCreateScm,
        formatTemplate: reworkFormatTemplate,
        resolveInstructions: reworkResolveInstructions
    };
}

/** prHelper double: real helpers, recorded createPullRequest with a fixed result. */
function makeReworkPrHelperMock(recorded, deps) {
    return Object.assign({}, prHelperRealForRework, {
        createPullRequest: function(opts) {
            recorded.createPullRequests.push(opts);
            return deps.createPullRequestResult || { success: true, prUrl: 'https://github.com/acme/widgets/pull/99' };
        }
    });
}

/**
 * Full-control harness for postTestReworkResults.action().
 * Every collaborator is a recorded double; file reads come from `deps.files`.
 */
function loadReworkActionHarness(deps) {
    deps = deps || {};
    var recorded = {
        cli: [],
        trackerComments: [],
        labelRemovals: [],
        statusMoves: [],
        prComments: [],
        prBodies: [],
        threadReplies: [],
        threadResolves: [],
        qualityGates: [],
        policyGates: [],
        resumeCalls: [],
        smTriggers: [],
        configuredTriggers: [],
        tokenUsage: [],
        createPullRequests: []
    };

    var files = deps.files || {};
    var scm = makeReworkScmMock(recorded, deps);
    var tracker = makeReworkTrackerMock(recorded);
    var moduleExports = loadModule(
        'js/postTestReworkResults.js',
        makeRequire({
            './configLoader.js': makeReworkConfigLoaderMock(deps, scm),
            './config.js': configModule,
            './common/autoStart.js': makeReworkAutoStartMock(recorded, deps),
            './common/feedbackLoop.js': makeReworkFeedbackLoopMock(recorded, deps),
            './common/pullRequest.js': makeReworkPrHelperMock(recorded, deps),
            './common/mergeState.js': loadModule('js/common/mergeState.js'),
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function(key, opts) { recorded.tokenUsage.push({ key: key, opts: opts }); },
                customParamsOf: function(params) { return (params && params.customParams) || {}; }
            },
            './common/trackers.js': {
                createTracker: function(config, customParams) { return tracker; }
            },
            './common/commentMarkup.js': loadModule('js/common/commentMarkup.js',
                makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }))
        }),
        {
            cli_execute_command: deps.cliWrapper ? deps.cliWrapper(makeReworkCliMock(recorded, deps)) : makeReworkCliMock(recorded, deps),
            file_read: makeReworkFileReadMock(files)
        }
    );

    return { module: moduleExports, recorded: recorded, tracker: tracker, scm: scm, cliMock: null };
}

function reworkActionParams(overrides) {
    overrides = overrides || {};
    return {
        ticket: { key: 'PROJ-123' },
        response: overrides.omitResponse ? undefined :
            (overrides.response !== undefined ? overrides.response : 'Fixed the flaky assertion'),
        initiator: 'sm',
        jobParams: overrides.jobParams,
        customParams: overrides.customParams,
        metadata: overrides.metadata
    };
}

var PASSED_RESULT_JSON = JSON.stringify({ status: 'passed', summary: 'all green' });

suite('postTestReworkResults.action — end-to-end characterization (gh-928)', function() {

    function passedFlowDeps(overrides) {
        overrides = overrides || {};
        var d = {
            files: {
                'outputs/test_automation_result.json': overrides.resultJson !== undefined ? overrides.resultJson : PASSED_RESULT_JSON
            }
        };
        if (overrides.prBody !== undefined) d.files['outputs/pr_body.md'] = overrides.prBody;
        if (overrides.replies !== undefined) d.files['outputs/review_replies.json'] = overrides.replies;
        return d;
    }

    test('passed flow: gates → commit/push → PR body+comment → move to In Review - Passed → tracker comment → unlock → SM trigger', function() {
        var h = loadReworkActionHarness(passedFlowDeps({ prBody: '## What the agent did' }));

        var result = h.module.action(reworkActionParams());

        assert.deepEqual(result, {
            success: true,
            testStatus: 'passed',
            jiraStatus: 'In Review - Passed',
            ticketKey: 'PROJ-123'
        }, 'success shape consumed by the rework workflow');

        assert.deepEqual(h.recorded.qualityGates, [{ ticketKey: 'PROJ-123', customParams: {}, section: 'qualityGates' }]);
        assert.deepEqual(h.recorded.policyGates, [{ ticketKey: 'PROJ-123', customParams: {}, section: 'policyGates' }]);

        assert.ok(h.recorded.cli.indexOf('git add testing/') !== -1, 'testing/ staged');
        assert.ok(h.recorded.cli.some(function(c) { return c.indexOf('git push -u origin test/PROJ-123') === 0; }), 'pushed to test branch');
        assert.equal(h.recorded.cli.filter(function(c) { return c.indexOf('git commit') === 0; }).length, 0,
            'no commit when the tree is clean and no merge pending');

        assert.deepEqual(h.recorded.prBodies, [{
            number: 12,
            body: '## PROJ-123 Result: PASSED\n\n**Latest rework result:** `PASSED`\n\n---\n\n## What the agent did'
        }], 'PR body refreshed with the latest rework result');
        assert.equal(h.recorded.prComments.length, 1, 'one PR summary comment');
        assert.contains(h.recorded.prComments[0].body, '## 🔧 Test Rework Complete — PROJ-123');
        assert.contains(h.recorded.prComments[0].body, '**Re-run result**: ✅ PASSED');
        assert.contains(h.recorded.prComments[0].body, '## What the agent did');

        assert.deepEqual(h.recorded.statusMoves, [{
            key: 'PROJ-123', status: 'In Review - Passed', stageKey: 'IN_REVIEW_PASSED'
        }]);

        assert.equal(h.recorded.trackerComments.length, 1, 'exactly one tracker comment');
        assert.contains(h.recorded.trackerComments[0].body, 'h3. 🔧 Test Rework Completed');
        assert.contains(h.recorded.trackerComments[0].body, '*Re-run result*: ✅ *PASSED*');
        assert.contains(h.recorded.trackerComments[0].body, 'Fixed the flaky assertion');

        assert.deepEqual(h.recorded.labelRemovals, [{ key: 'PROJ-123', label: 'pr_test_automation_rework_wip' }],
            'WIP label released');

        assert.equal(h.recorded.configuredTriggers.length, 0, 'no autoStartReview by default');
        assert.equal(h.recorded.smTriggers.length, 1, 'SM triggered when idle');
        assert.deepEqual(h.recorded.smTriggers[0].config, REWORK_ACTION_CONFIG);
        assert.deepEqual(h.recorded.tokenUsage, [{ key: 'PROJ-123', opts: { initiator: 'sm', customParams: {} } }]);
    });

    test('failed flow: ❌ emoji, In Review - Failed, commit message result "update"', function() {
        var h = loadReworkActionHarness(passedFlowDeps({
            resultJson: JSON.stringify({ status: 'FAILED', reason: 'login still flaky' })
        }));

        var result = h.module.action(reworkActionParams());

        assert.deepEqual(result, {
            success: true,
            testStatus: 'failed',
            jiraStatus: 'In Review - Failed',
            ticketKey: 'PROJ-123'
        });
        assert.deepEqual(h.recorded.statusMoves, [{
            key: 'PROJ-123', status: 'In Review - Failed', stageKey: 'IN_REVIEW_FAILED'
        }]);
        assert.contains(h.recorded.prComments[0].body, '**Re-run result**: ❌ FAILED');
        assert.contains(h.recorded.trackerComments[0].body, '*Re-run result*: ❌ *FAILED*');
    });

    test('status synonyms "pass" and "fail" normalize to passed/failed', function() {
        var h = loadReworkActionHarness(passedFlowDeps({ resultJson: JSON.stringify({ status: 'pass' }) }));
        var result = h.module.action(reworkActionParams());
        assert.equal(result.testStatus, 'passed');

        var h2 = loadReworkActionHarness(passedFlowDeps({ resultJson: JSON.stringify({ status: 'fail' }) }));
        var result2 = h2.module.action(reworkActionParams());
        assert.equal(result2.testStatus, 'failed');
    });

    test('missing result file → ⚠️ Rework Error comment, unlock, failure — gates never run', function() {
        var h = loadReworkActionHarness({ files: {} });

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, false);
        assert.contains(result.error, 'Could not read outputs/test_automation_result.json — file missing or empty.');
        assert.equal(h.recorded.qualityGates.length, 0, 'gates must not run without a result');
        assert.equal(h.recorded.trackerComments.length, 1);
        assert.contains(h.recorded.trackerComments[0].body, 'h3. ⚠️ Rework Error');
        assert.contains(h.recorded.trackerComments[0].body, 'file missing or empty');
        assert.deepEqual(h.recorded.labelRemovals, [{ key: 'PROJ-123', label: 'pr_test_automation_rework_wip' }],
            'lock released on the early-exit path too');
    });

    test('result without status field → error names the field and shows the payload', function() {
        var h = loadReworkActionHarness({ files: { 'outputs/test_automation_result.json': '{"foo":1}' } });

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, false);
        assert.contains(result.error, 'missing required "status" field');
        assert.contains(result.error, '{"foo":1}');
        assert.equal(h.recorded.qualityGates.length, 0);
    });

    test('quality gate failure → outer catch: resume not attempted → ❌ Test Rework Error + unlock', function() {
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            qualityGateResult: { success: false, failedGate: 'crap', error: 'too crappy' }
        });

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, false);
        assert.contains(result.error, 'Quality gate failed before test rework publish: crap');
        assert.equal(h.recorded.resumeCalls.length, 1, 'resumeAgent consulted');
        assert.deepEqual(h.recorded.resumeCalls[0], {
            ticketKey: 'PROJ-123', customParams: {}, section: 'postAction',
            stage: 'test_rework_post_action', error: result.error
        });
        assert.equal(h.recorded.trackerComments.length, 1);
        assert.contains(h.recorded.trackerComments[0].body, 'h3. ❌ Test Rework Error');
        assert.contains(h.recorded.trackerComments[0].body, '{code}Error: Quality gate failed before test rework publish: crap');
        assert.deepEqual(h.recorded.labelRemovals, [{ key: 'PROJ-123', label: 'pr_test_automation_rework_wip' }]);
    });

    test('push failure with resume attempted → action retries itself and the retry succeeds', function() {
        var pushes = 0;
        var h = loadReworkActionHarness({
            files: passedFlowDeps({}).files,
            resumeAttempted: true,
            // The FIRST push verify sees stderr noise with no ref line → commitAndPush throws;
            // the recursive retry (attempt 2) sees a clean capture and succeeds.
            cliWrapper: function(base) {
                return function(args) {
                    if (args.command.indexOf('git ls-remote --heads origin') === 0 && pushes === 1) {
                        return 'warning: redirecting to https://git.example.com/\n';
                    }
                    if (args.command.indexOf('git push -u origin') === 0) pushes++;
                    return base(args);
                };
            }
        });

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, true, 'the retried action completes');
        assert.equal(pushes, 2, 'exactly two push attempts');
        assert.equal(h.recorded.resumeCalls.length, 1, 'one resume consult');
        assert.equal(h.recorded.resumeCalls[0].stage, 'test_rework_git_operations');
        assert.equal(h.recorded.trackerComments.length, 1, 'only the completion comment');
        assert.contains(h.recorded.trackerComments[0].body, 'h3. 🔧 Test Rework Completed',
            'the surviving comment is the success one, not a failure one');
    });

    test('push failure with resume NOT attempted → ❌ Rework Push Failed comment + unlock + failure', function() {
        var h = loadReworkActionHarness({
            files: passedFlowDeps({}).files,
            // Warning-only ls-remote capture → "Branch not found on remote after push".
            cliWrapper: function(base) {
                return function(args) {
                    if (args.command.indexOf('git ls-remote --heads origin') === 0) {
                        return 'warning: redirecting to https://git.example.com/\n';
                    }
                    return base(args);
                };
            }
        });

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, false);
        assert.contains(result.error, 'Branch not found on remote after push');
        assert.equal(h.recorded.resumeCalls.length, 1);
        assert.equal(h.recorded.resumeCalls[0].stage, 'test_rework_git_operations');
        assert.equal(h.recorded.trackerComments.length, 1);
        assert.contains(h.recorded.trackerComments[0].body, 'h3. ❌ Rework Push Failed');
        assert.contains(h.recorded.trackerComments[0].body, 'Branch not found on remote after push');
        assert.deepEqual(h.recorded.labelRemovals, [{ key: 'PROJ-123', label: 'pr_test_automation_rework_wip' }]);
    });

    test('no open PR → createPRIfMissing creates one after the push', function() {
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            openPrs: []
        });

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, true);
        assert.equal(h.recorded.createPullRequests.length, 1, 'PR created post-push');
        assert.equal(h.recorded.createPullRequests[0].branchName, 'test/PROJ-123');
        assert.equal(h.recorded.createPullRequests[0].baseBranch, 'main');
        assert.contains(h.recorded.createPullRequests[0].bodyContent, 'Auto-created PR after test rework');
        assert.equal(h.recorded.createPullRequests[0].ticketKey, 'PROJ-123');
        // listPrs still returns [] → the refreshed lookup misses → fallback shape from the URL.
        assert.equal(h.recorded.prComments[0].number, 99, 'comment lands on the fallback PR shape (number from URL)');
        assert.equal(h.recorded.prBodies[0].number, 99);
    });

    test('autoStartReview configured → configured workflow triggered, SM idle trigger skipped', function() {
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            jobParamPatch: { customParams: { autoStartReview: true, autoStartReviewConfigFile: 'agents/pr_test_automation_review.json', removeLabel: 'sm_rework' } },
            configuredTriggerResult: true
        });

        var params = reworkActionParams({});
        var result = h.module.action(params);

        assert.equal(result.success, true);
        assert.equal(h.recorded.configuredTriggers.length, 1);
        assert.equal(h.recorded.configuredTriggers[0].configFile, 'agents/pr_test_automation_review.json');
        assert.equal(h.recorded.configuredTriggers[0].label, 'pr_test_automation_review');
        assert.deepEqual(h.recorded.configuredTriggers[0].stripKeys, ['removeLabel', 'autoStartReview', 'autoStartReviewConfigFile']);
        assert.equal(h.recorded.smTriggers.length, 0, 'configured trigger suppresses the SM idle trigger');
        assert.deepEqual(h.recorded.labelRemovals, [
            { key: 'PROJ-123', label: 'pr_test_automation_rework_wip' },
            { key: 'PROJ-123', label: 'sm_rework' }
        ], 'WIP label AND the custom SM idempotency label removed');
    });

    test('thread replies: explicit replies post inside threads; resolves happen; generic-comment flood avoided', function() {
        var h = loadReworkActionHarness(passedFlowDeps({
            replies: JSON.stringify({ replies: [
                { inReplyToId: 'root-1', threadId: 'th-1', reply: 'Addressed — tightened the wait.' },
                { threadId: 'th-2' },
                { reply: 'orphan reply without rootCommentId' }
            ] })
        }));

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, true);
        assert.deepEqual(h.recorded.threadReplies, [{
            number: 12,
            thread: { rootCommentId: 'root-1', threadId: 'th-1' },
            text: 'Addressed — tightened the wait.'
        }], 'only explicit replies with rootCommentId are posted');
        assert.deepEqual(h.recorded.threadResolves, [
            { number: 12, thread: { threadId: 'th-1' } },
            { number: 12, thread: { threadId: 'th-2' } }
        ], 'threads with threadId resolved');
    });

    test('no fix summary → placeholder used, result JSON summary ignored', function() {
        var h = loadReworkActionHarness({ files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON } });

        var result = h.module.action(reworkActionParams({ omitResponse: true }));

        assert.equal(result.success, true);
        assert.contains(h.recorded.trackerComments[0].body, '_(No fix summary)_');
    });

    test('wip label follows the metadata.contextId when present', function() {
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON }
        });

        var params = reworkActionParams({ metadata: { contextId: 'pr_test_automation_rework_mobile' } });
        h.module.action(params);

        assert.deepEqual(h.recorded.labelRemovals, [{ key: 'PROJ-123', label: 'pr_test_automation_rework_mobile_wip' }]);
    });
});

/**
/**
 * createPRIfMissing is internal (not exported) — its coverage is driven
 * through action() with no open PR. Every branch: refresh hit, URL fallback,
 * creation failure, listPrs throwing, unreadable ticket.
 */
suite('postTestReworkResults — createPRIfMissing via action (gh-928)', function() {

    test('refresh after creation finds the PR → downstream pr is refreshed.pr (undefined today — pinned quirk)', function() {
        // CHARACTERIZED QUIRK: findTestPRForTicket returns the PR object itself, but the
        // refresh branch reads `refreshed.pr` — always undefined. A successful re-fetch
        // therefore yields NO downstream PR (no comment/body) today. Pinned as-is; the
        // CRAP refactor must not silently change it.
        var created = {
            number: 41,
            html_url: 'https://github.com/acme/widgets/pull/41',
            head: { ref: 'test/PROJ-123' },
            base: { ref: 'main' }
        };
        var calls = 0;
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            openPrs: []
        });
        h.scm.listPrs = function() {
            calls++;
            return calls >= 3 ? [created] : [];  // 1: dirty lookup, 2: create-check, 3: refresh
        };

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, true);
        assert.equal(h.recorded.createPullRequests.length, 1);
        assert.deepEqual(h.recorded.prComments, [], 'refreshed.pr is undefined → no PR comment today');
        assert.deepEqual(h.recorded.prBodies, [], 'refreshed.pr is undefined → no PR body today');
    });

    test('creation failure → rework still succeeds, no PR comment/body, status still moves', function() {
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            openPrs: [],
            createPullRequestResult: { success: false, error: 'validation failed' }
        });

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, true, 'missing PR does not fail the rework publish');
        assert.equal(h.recorded.createPullRequests.length, 1, 'creation attempted exactly once');
        assert.deepEqual(h.recorded.prComments, [], 'no PR comment without a PR');
        assert.deepEqual(h.recorded.prBodies, [], 'no PR body without a PR');
        assert.deepEqual(h.recorded.statusMoves, [{
            key: 'PROJ-123', status: 'In Review - Passed', stageKey: 'IN_REVIEW_PASSED'
        }], 'status still moves');
        assert.contains(h.recorded.trackerComments[0].body, '*Branch*: {code}test/PROJ-123{code}');
    });

    test('listPrs throwing → createPRIfMissing catch → null → no PR comment, success preserved', function() {
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            openPrs: []
        });
        h.scm.listPrs = function() { throw new Error('api down'); };

        var result = h.module.action(reworkActionParams());

        assert.equal(result.success, true);
        assert.deepEqual(h.recorded.prComments, []);
        assert.deepEqual(h.recorded.prBodies, []);
    });

    test('tracker getIssue failing → creation title falls back to the bare ticket key', function() {
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            openPrs: [],
            createPullRequestResult: { success: true, prUrl: 'https://github.com/acme/widgets/pull/7' }
        });
        h.tracker.getIssue = function() { throw new Error('jira down'); };

        h.module.action(reworkActionParams());

        assert.equal(h.recorded.createPullRequests[0].title, 'PROJ-123 PROJ-123',
            'unreadable issue → summary falls back to the key → title "KEY KEY"');
    });
});

// ── gh-928: direct tests for the extracted planners/parsers/executors ────────

suite('postTestReworkResults — extracted helpers (gh-928)', function() {

    function helperModule() {
        return loadReworkActionHarness({ files: {} }).module;
    }

    test('normalizeTestStatus maps the pass/fail synonym family, passes anything else through', function() {
        var m = helperModule();
        assert.equal(m.normalizeTestStatus('pass'), 'passed');
        assert.equal(m.normalizeTestStatus('passed'), 'passed');
        assert.equal(m.normalizeTestStatus('fail'), 'failed');
        assert.equal(m.normalizeTestStatus('failed'), 'failed');
        assert.equal(m.normalizeTestStatus('SKIPPED'), 'SKIPPED', 'unknown statuses pass through verbatim');
        assert.equal(m.normalizeTestStatus(''), '');
    });

    test('buildResultErrorMessage distinguishes missing file from missing status field', function() {
        var m = helperModule();
        assert.equal(
            m.buildResultErrorMessage(null),
            'Could not read outputs/test_automation_result.json — file missing or empty.'
        );
        var msg = m.buildResultErrorMessage({ foo: 'bar' });
        assert.contains(msg, 'missing required "status" field');
        assert.contains(msg, '{"foo":"bar"}');
        assert.contains(msg, 'The agent must write { "status": "passed" | "failed", ... }.');
    });

    test('resolveWipLabel follows contextId, defaulting to the rework wip label', function() {
        var m = helperModule();
        assert.equal(m.resolveWipLabel({ metadata: { contextId: 'pr_test_automation_rework_mobile' } }),
            'pr_test_automation_rework_mobile_wip');
        assert.equal(m.resolveWipLabel({}), 'pr_test_automation_rework_wip');
        assert.equal(m.resolveWipLabel({ metadata: {} }), 'pr_test_automation_rework_wip');
    });

    test('prMatchesBranch requires head.ref equality', function() {
        var m = helperModule();
        assert.equal(m.prMatchesBranch({ head: { ref: 'test/PROJ-1' } }, 'test/PROJ-1'), true);
        assert.equal(m.prMatchesBranch({ head: { ref: 'other' } }, 'test/PROJ-1'), false);
        // The original inline filter callback returned the bare && expression —
        // a missing head yields null (falsy for filter), not false. Pinned as-is.
        assert.ok(!m.prMatchesBranch({ head: null }, 'test/PROJ-1'), 'missing head → falsy');
        assert.ok(!m.prMatchesBranch({}, 'test/PROJ-1'), 'missing head object → falsy');
    });

    test('buildAutoPRTitle degrades: full summary, empty summary, missing ticket', function() {
        var m = helperModule();
        assert.equal(m.buildAutoPRTitle({ fields: { summary: 'Fix login' } }, 'PROJ-1'), 'PROJ-1 Fix login');
        assert.equal(m.buildAutoPRTitle({ fields: { summary: '' } }, 'PROJ-1'), 'PROJ-1 PROJ-1');
        assert.equal(m.buildAutoPRTitle(null, 'PROJ-1'), 'PROJ-1 PROJ-1');
        assert.equal(m.buildAutoPRTitle({}, 'PROJ-1'), 'PROJ-1 PROJ-1');
    });

    test('prNumberFromUrl parses trailing /pull/<n>, null otherwise', function() {
        var m = helperModule();
        assert.equal(m.prNumberFromUrl('https://github.com/acme/w/pull/41'), 41);
        assert.equal(m.prNumberFromUrl('https://github.com/acme/w/pull/0'), 0);
        assert.equal(m.prNumberFromUrl('https://gitlab.com/acme/w/-/merge_requests/7'), null, 'non-GitHub URL shape');
        assert.equal(m.prNumberFromUrl('https://github.com/acme/w/pull/41/commits'), null, 'not a PR landing URL');
        assert.equal(m.prNumberFromUrl(''), null);
        assert.equal(m.prNumberFromUrl(null), null);
    });

    test('buildFallbackPR keeps the URL even when the number is unparseable', function() {
        var m = helperModule();
        assert.deepEqual(
            m.buildFallbackPR({ prUrl: 'https://github.com/acme/w/pull/9' }, 'test/PROJ-1'),
            { number: 9, html_url: 'https://github.com/acme/w/pull/9', head: { ref: 'test/PROJ-1' } }
        );
        assert.deepEqual(
            m.buildFallbackPR({ prUrl: 'https://gitlab.com/acme/w/-/merge_requests/7' }, 'test/PROJ-1'),
            { number: null, html_url: 'https://gitlab.com/acme/w/-/merge_requests/7', head: { ref: 'test/PROJ-1' } }
        );
    });

    test('buildPRReworkComment flips emoji with the outcome and keeps the markdown contract', function() {
        var m = helperModule();
        assert.equal(
            m.buildPRReworkComment('PROJ-2', 'passed', true, 'BODY'),
            '## 🔧 Test Rework Complete — PROJ-2\n\n**Re-run result**: ✅ PASSED\n\n---\n\nBODY'
        );
        assert.equal(
            m.buildPRReworkComment('PROJ-2', 'failed', false, 'BODY'),
            '## 🔧 Test Rework Complete — PROJ-2\n\n**Re-run result**: ❌ FAILED\n\n---\n\nBODY'
        );
    });

    test('runPublishGates: quality gate throws first, policy gate throws second, success passes silently', function() {
        var calls = [];
        var h = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            qualityGateResult: { success: false, failedGate: 'crap', error: 'boom' }
        });
        var err = null;
        try { h.module.action(reworkActionParams()); } catch (e) { /* action catches internally */ }
        void calls;

        // Direct: quality failure surfaces the quality message.
        var h1 = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            qualityGateResult: { success: false, failedGate: 'crap', error: 'boom' }
        });
        var r1 = h1.module.action(reworkActionParams());
        assert.contains(r1.error, 'Quality gate failed before test rework publish: crap\nboom');

        // Direct: policy failure surfaces the policy message.
        var h2 = loadReworkActionHarness({
            files: { 'outputs/test_automation_result.json': PASSED_RESULT_JSON },
            policyGateResult: { success: false, failedGate: 'method_size', error: 'too big' }
        });
        var r2 = h2.module.action(reworkActionParams());
        assert.contains(r2.error, 'Policy gate failed before test rework publish: method_size\ntoo big');
        assert.ok(h2.recorded.qualityGates.length >= 1, 'quality gate ran before the policy gate');
    });

    test('handleReplyItem: reply error is a warn (tally unchanged), resolve error likewise', function() {
        var m = helperModule();
        var scm = {
            replyToThread: function() { throw new Error('reply api down'); },
            resolveThread: function() { throw new Error('resolve api down'); }
        };
        var tally = { posted: 0, resolved: 0 };
        m.handleReplyItem(scm, 12, { inReplyToId: 'r1', threadId: 't1', reply: 'Done' }, tally);
        assert.deepEqual(tally, { posted: 0, resolved: 0 }, 'failed reply/resolve do not count');
    });

    test('replyThreadIdOf prefers threadId, falls back to discussionId, else undefined', function() {
        var m = helperModule();
        assert.equal(m.replyThreadIdOf({ threadId: 't1', discussionId: 'd1' }), 't1');
        assert.equal(m.replyThreadIdOf({ discussionId: 'd1' }), 'd1');
        assert.equal(m.replyThreadIdOf({}), undefined);
    });

    test('reworkFormatTemplate substitutes every var and empties missing ones', function() {
        assert.equal(reworkFormatTemplate('KEY {ticketKey} RESULT {result}', { ticketKey: 'PROJ-9', result: 'fix' }),
            'KEY PROJ-9 RESULT fix');
        // Keys absent from the map stay unreplaced; present-but-undefined values → ''.
        assert.equal(reworkFormatTemplate('KEY {ticketKey} RESULT {result}', { ticketKey: 'PROJ-9' }),
            'KEY PROJ-9 RESULT {result}', 'absent key stays unreplaced');
        assert.equal(reworkFormatTemplate('KEY {ticketKey}', { ticketKey: undefined }),
            'KEY ', 'undefined value → empty string');
        assert.equal(reworkFormatTemplate('no vars', { ignored: 1 }), 'no vars');
    });

    test('handleReplyItem uses discussionId when threadId is absent (resolve skipped)', function() {
        var seen = [];
        var m = helperModule();
        var scm = {
            replyToThread: function(id, thread, text) { seen.push({ id: id, thread: thread, text: text }); },
            resolveThread: function() { seen.push('resolved-should-not-happen'); }
        };
        var tally = { posted: 0, resolved: 0 };
        m.handleReplyItem(scm, 12, { inReplyToId: 'r9', discussionId: 'd9', reply: ' Noted. ' }, tally);
        assert.deepEqual(seen, [{ id: 12, thread: { rootCommentId: 'r9', threadId: 'd9' }, text: 'Noted.' }],
            'reply text trimmed, discussionId used as the thread id, nothing resolved');
        assert.deepEqual(tally, { posted: 1, resolved: 0 });
    });

    test('releaseReworkLock removes the wip label always and the SM label only when configured', function() {
        var removals = [];
        var h = loadReworkActionHarness({ files: {} });
        h.tracker.removeLabel = function(key, label) { removals.push(label); };

        h.module.releaseReworkLock('PROJ-1', 'wip_label', undefined);
        assert.deepEqual(removals, ['wip_label'], 'no SM label when removeLabel is absent');

        h.module.releaseReworkLock('PROJ-1', 'wip_label', 'sm_rework');
        assert.deepEqual(removals, ['wip_label', 'wip_label', 'sm_rework'], 'both labels removed when configured');
    });

    test('triggerAutoStart: configured trigger success suppresses the SM idle trigger', function() {
        var h = loadReworkActionHarness({
            files: {},
            jobParamPatch: { customParams: { autoStartReview: true, autoStartReviewConfigFile: 'cfg.json' } },
            configuredTriggerResult: true
        });
        var started = h.module.triggerAutoStart('PROJ-1', { autoStartReview: true, autoStartReviewConfigFile: 'cfg.json' }, REWORK_ACTION_CONFIG);
        assert.equal(started, true);
        assert.equal(h.recorded.configuredTriggers[0].ticketKey, 'PROJ-1');
        assert.equal(h.recorded.smTriggers.length, 0);

        var h2 = loadReworkActionHarness({ files: {} });
        var started2 = h2.module.triggerAutoStart('PROJ-1', {}, REWORK_ACTION_CONFIG);
        assert.equal(started2, false, 'no autoStart config → SM idle trigger fallback');
        assert.equal(h2.recorded.smTriggers.length, 1);

        var h3 = loadReworkActionHarness({ files: {}, configuredTriggerResult: false });
        var started3 = h3.module.triggerAutoStart('PROJ-1', { autoStartReview: true, autoStartReviewConfigFile: 'cfg.json' }, REWORK_ACTION_CONFIG);
        assert.equal(started3, false, 'configured trigger returning false still falls back to SM');
        assert.equal(h3.recorded.smTriggers.length, 1);
    });

    test('postReworkBodyAndComment: body update and comment share prBodyContent; failure of one warns only', function() {
        var h = loadReworkActionHarness({ files: {} });
        var scmCalls = [];
        var scm = {
            updatePrBody: function(n, b) { scmCalls.push(['body', n, b]); },
            addComment: function(n, c) { scmCalls.push(['comment', n, c]); }
        };
        h.module.postReworkBodyAndComment(scm, { number: 5 }, 'PROJ-1', 'passed', true, 'CONTENT');
        assert.deepEqual(scmCalls, [
            ['body', 5, '## PROJ-1 Result: PASSED\n\n**Latest rework result:** `PASSED`\n\n---\n\nCONTENT'],
            ['comment', 5, '## 🔧 Test Rework Complete — PROJ-1\n\n**Re-run result**: ✅ PASSED\n\n---\n\nCONTENT']
        ], 'both side effects fire with the same content and PR number');

        // updatePullRequestBody catches internally — a body failure does NOT stop
        // the summary comment. Pinned: the comment still posts.
        var scmBroken = {
            updatePrBody: function() { throw new Error('api down'); },
            addComment: function(n, c) { scmCalls.push(['comment-after-failure', n, c]); }
        };
        h.module.postReworkBodyAndComment(scmBroken, { number: 5 }, 'PROJ-1', 'passed', true, 'C');
        assert.deepEqual(scmCalls[2], ['comment-after-failure', 5, '## 🔧 Test Rework Complete — PROJ-1\n\n**Re-run result**: ✅ PASSED\n\n---\n\nC'],
            'summary comment survives a PR-body failure');
    });
});

// ── gh-981: stageUnmergedPaths characterization + pure path-classification helpers ──
// stageUnmergedPaths was CRAP 174.6 (git staging in the rework leg). These tests
// pin the CURRENT command sequence and side-effect order so the function can be
// split into pure path classification (parse*/decide*) + thin git executors
// without behaviour drift: same commands, same order, same log lines.

suite('postTestReworkResults.stageUnmergedPaths — characterization (gh-981)', function () {

    var STAGE_CONFIG = { git: { baseBranch: 'main' } };

    /** Scripted cli double: commands must arrive in the exact scripted order. */
    function makeScriptedCli(script) {
        var idx = 0;
        var calls = [];
        var fn = function (args) {
            var command = args.command;
            calls.push(command);
            if (idx >= script.length) throw new Error('unexpected command: ' + command);
            var step = script[idx++];
            if (step.cmd !== command) {
                throw new Error('command mismatch at step ' + (idx - 1) + ': got "' + command + '", expected "' + step.cmd + '"');
            }
            if (step.fail) throw new Error(step.fail);
            return step.out !== undefined ? step.out : '';
        };
        fn.calls = calls;
        fn.exhausted = function () { return idx === script.length; };
        return fn;
    }

    function loadStageModule(cli) {
        return loadReworkActionHarness({ files: {}, cliWrapper: function () { return cli; } }).module;
    }

    test('no unmerged paths → a single probe and nothing else', function () {
        var cli = makeScriptedCli([
            { cmd: 'git diff --name-only --diff-filter=U', out: '' }
        ]);
        loadStageModule(cli).stageUnmergedPaths(STAGE_CONFIG);
        assert.ok(cli.exhausted(), 'exactly one command expected, got: ' + JSON.stringify(cli.calls));
    });

    test('two unmerged paths are staged; clean tree afterwards stops there', function () {
        var cli = makeScriptedCli([
            { cmd: 'git diff --name-only --diff-filter=U', out: 'src/a.js\ntesting/b.js' },
            { cmd: 'git add -- "src/a.js"' },
            { cmd: 'git add -- "testing/b.js"' },
            { cmd: 'git diff --cached --check', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' }
        ]);
        loadStageModule(cli).stageUnmergedPaths(STAGE_CONFIG);
        assert.ok(cli.exhausted(), 'script must be consumed exactly: ' + JSON.stringify(cli.calls));
    });

    test('conflict markers: testing/ keeps --ours, everything else keeps --theirs', function () {
        var cli = makeScriptedCli([
            { cmd: 'git diff --name-only --diff-filter=U', out: 'testing/x.js\nsrc/y.js' },
            { cmd: 'git add -- "testing/x.js"' },
            { cmd: 'git add -- "src/y.js"' },
            { cmd: 'git diff --cached --check',
              out: 'testing/x.js:2: conflict marker\nsrc/y.js:5: conflict marker' },
            { cmd: 'git checkout --ours -- "testing/x.js"' },
            { cmd: 'git add -- "testing/x.js"' },
            { cmd: 'git checkout --theirs -- "src/y.js"' },
            { cmd: 'git add -- "src/y.js"' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' }
        ]);
        loadStageModule(cli).stageUnmergedPaths(STAGE_CONFIG);
        assert.ok(cli.exhausted(), 'script must be consumed exactly: ' + JSON.stringify(cli.calls));
    });

    test('duplicate marker lines for the same file resolve it exactly once', function () {
        var cli = makeScriptedCli([
            { cmd: 'git diff --name-only --diff-filter=U', out: 'src/y.js' },
            { cmd: 'git add -- "src/y.js"' },
            { cmd: 'git diff --cached --check',
              out: 'src/y.js:5: conflict marker\nsrc/y.js:9: conflict marker' },
            { cmd: 'git checkout --theirs -- "src/y.js"' },
            { cmd: 'git add -- "src/y.js"' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' }
        ]);
        loadStageModule(cli).stageUnmergedPaths(STAGE_CONFIG);
        assert.ok(cli.exhausted(), 'script must be consumed exactly: ' + JSON.stringify(cli.calls));
    });

    test('submodule conflicts adopt the origin/main (--theirs) state', function () {
        var cli = makeScriptedCli([
            { cmd: 'git diff --name-only --diff-filter=U', out: 'vendor/lib' },
            { cmd: 'git add -- "vendor/lib"' },
            { cmd: 'git diff --cached --check', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: 'vendor/lib' },
            { cmd: 'git ls-files --stage -- "vendor/lib"', out: '160000 a4f9c1d 0\tvendor/lib' },
            { cmd: 'git checkout --theirs -- "vendor/lib"' },
            { cmd: 'git add -- "vendor/lib"' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' }
        ]);
        loadStageModule(cli).stageUnmergedPaths(STAGE_CONFIG);
        assert.ok(cli.exhausted(), 'script must be consumed exactly: ' + JSON.stringify(cli.calls));
    });

    test('a still-unmerged NON-submodule path is left alone (no forced checkout)', function () {
        var cli = makeScriptedCli([
            { cmd: 'git diff --name-only --diff-filter=U', out: 'src/z.js' },
            { cmd: 'git add -- "src/z.js"' },
            { cmd: 'git diff --cached --check', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: 'src/z.js' },
            { cmd: 'git ls-files --stage -- "src/z.js"', out: '100644 a4f9c1d 0\tsrc/z.js' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' }
        ]);
        loadStageModule(cli).stageUnmergedPaths(STAGE_CONFIG);
        assert.ok(cli.exhausted(), 'script must be consumed exactly: ' + JSON.stringify(cli.calls));
    });

    test('isSubmodulePath tolerates a failing ls-files probe (treated as non-submodule)', function () {
        var cli = makeScriptedCli([
            { cmd: 'git diff --name-only --diff-filter=U', out: 'src/w.js' },
            { cmd: 'git add -- "src/w.js"' },
            { cmd: 'git diff --cached --check', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: 'src/w.js' },
            { cmd: 'git ls-files --stage -- "src/w.js"', fail: 'not a git repo' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' }
        ]);
        loadStageModule(cli).stageUnmergedPaths(STAGE_CONFIG);
        assert.ok(cli.exhausted(), 'script must be consumed exactly: ' + JSON.stringify(cli.calls));
    });

    test('still-unmerged paths after every resolver throw the pinned error', function () {
        var cli = makeScriptedCli([
            { cmd: 'git diff --name-only --diff-filter=U', out: 'left.js' },
            { cmd: 'git add -- "left.js"' },
            { cmd: 'git diff --cached --check', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: '' },
            { cmd: 'git diff --name-only --diff-filter=U', out: 'left.js' }
        ]);
        var err = null;
        try {
            loadStageModule(cli).stageUnmergedPaths(STAGE_CONFIG);
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'must throw when conflicts remain');
        assert.equal(err.message, 'Unable to resolve merge conflicts: left.js');
        assert.ok(cli.exhausted(), 'script must be consumed exactly: ' + JSON.stringify(cli.calls));
    });
});

suite('postTestReworkResults — path classification helpers (gh-981)', function () {

    function helperModule() {
        return loadReworkActionHarness({ files: {} }).module;
    }

    test('parsePathList splits, trims and drops empty lines', function () {
        var m = helperModule();
        assert.deepEqual(m.parsePathList(' a.js \n\t\nb.js\n'), ['a.js', 'b.js']);
        assert.deepEqual(m.parsePathList(''), []);
        assert.deepEqual(m.parsePathList(null), []);
        assert.deepEqual(m.parsePathList(undefined), []);
        assert.deepEqual(m.parsePathList('only.js'), ['only.js']);
    });

    test('parseConflictMarkerPaths extracts unique marker files in order', function () {
        var m = helperModule();
        assert.deepEqual(
            m.parseConflictMarkerPaths(
                'src/a.js:3: conflict marker\n' +
                'src/b.js:7: conflict marker\n' +
                'src/a.js:9: conflict marker\n' +
                'unrelated output line\n'
            ),
            ['src/a.js', 'src/b.js']
        );
        assert.deepEqual(m.parseConflictMarkerPaths(''), []);
        assert.deepEqual(m.parseConflictMarkerPaths(null), []);
    });

    test('decideConflictSide keeps testing/ on ours and everything else on theirs', function () {
        var m = helperModule();
        assert.equal(m.decideConflictSide('testing/x.js'), 'ours');
        assert.equal(m.decideConflictSide('src/testing/x.js'), 'theirs', 'testing/ must be a PREFIX match');
        assert.equal(m.decideConflictSide('testing'), 'theirs', 'bare "testing" is not under testing/');
        assert.equal(m.decideConflictSide('src/y.js'), 'theirs');
    });
});

// gh-960 rework (review thread js/postTestReworkResults.js:279): `updatePrBody`
// is a live seam (_githubUpdatePrBody returns null when the PATCH fails) — the
// caller must not print a green check or return success in that case.
suite('updatePullRequestBody > PATCH failure reporting (gh-960)', function() {

    function captureConsole(fn) {
        var logs = [], warns = [];
        var origLog = console.log, origWarn = console.warn;
        console.log = function(m) { logs.push(String(m)); };
        console.warn = function(m) { warns.push(String(m)); };
        try {
            return { result: fn(), logs: logs, warns: warns };
        } finally {
            console.log = origLog;
            console.warn = origWarn;
        }
    }

    test('null from updatePrBody (failed PATCH) warns and reports failure — no green check', function() {
        var h = loadReworkActionHarness({ files: {} });
        var scm = { updatePrBody: function() { return null; } };
        var out = captureConsole(function() {
            return h.module.updatePullRequestBody(scm, 5, 'gh-1', 'passed', 'CONTENT');
        });
        assert.equal(out.result, false, 'a failed PATCH must not report success');
        assert.equal(out.logs.filter(function(m) { return m.indexOf('✅ Updated PR/MR body') !== -1; }).length, 0,
            'no green check in logs when the PATCH failed');
        assert.equal(out.warns.filter(function(m) { return m.indexOf('PR body update failed') !== -1; }).length, 1,
            'failure is surfaced as a warning instead');
    });

    test('truthy output from updatePrBody logs the green check and returns true', function() {
        var h = loadReworkActionHarness({ files: {} });
        var scm = { updatePrBody: function() { return '{"id":5}'; } };
        var out = captureConsole(function() {
            return h.module.updatePullRequestBody(scm, 5, 'gh-1', 'passed', 'CONTENT');
        });
        assert.equal(out.result, true, 'successful PATCH reports success');
        assert.equal(out.logs.filter(function(m) { return m.indexOf('✅ Updated PR/MR body') !== -1; }).length, 1,
            'green check only on a real success');
    });

    test('unsupported provider still warns and reports failure', function() {
        var h = loadReworkActionHarness({ files: {} });
        var out = captureConsole(function() {
            return h.module.updatePullRequestBody({}, 5, 'gh-1', 'passed', 'CONTENT');
        });
        assert.equal(out.result, false, 'missing seam reports failure');
        assert.equal(out.logs.filter(function(m) { return m.indexOf('✅ Updated PR/MR body') !== -1; }).length, 0,
            'no green check when nothing was updated');
    });
});

// gh-960: the PR body (including the canonical 'Closes #N' line) must be final
// BEFORE the PR enters the merge queue. The rework-publish body refresh must:
//   - be skipped entirely once validation armed (ai_validating) or the PR
//     merged — a post-merge body edit never auto-closes the issue (live
//     2026-10-17: #956 merged with 'Closes #952' landing at the merge moment,
//     #952 stayed OPEN);
//   - preserve the canonical 'Closes #N' line when it does run, so a refresh
//     can never drop the keyword the merge bot links by (gh-737).
suite('postTestReworkResults > PR body finality (gh-960)', function() {

    function makeRecordingScm(calls) {
        return {
            updatePrBody: function(n, b) { calls.push(['body', n, b]); },
            addComment: function(n, c) { calls.push(['comment', n, c]); }
        };
    }

    test('body rewrite is skipped when the PR is merged, but the summary comment still posts', function() {
        var h = loadReworkActionHarness({ files: {} });
        var calls = [];
        h.module.postReworkBodyAndComment(makeRecordingScm(calls), { number: 956, merged: true, state: 'closed' },
            'gh-952', 'passed', true, 'CONTENT');
        assert.deepEqual(calls.map(function(c) { return c[0]; }), ['comment'],
            'no body rewrite after merge — only the comment');
        assert.contains(calls[0][2], 'CONTENT', 'comment still carries the rework summary');
    });

    test('body rewrite is skipped while validation is armed (ai_validating), but the summary comment still posts', function() {
        var h = loadReworkActionHarness({ files: {} });
        var calls = [];
        h.module.postReworkBodyAndComment(makeRecordingScm(calls),
            { number: 956, state: 'open', labels: [{ name: 'pr_approved' }, { name: 'ai_validating' }] },
            'gh-952', 'passed', true, 'CONTENT');
        assert.deepEqual(calls.map(function(c) { return c[0]; }), ['comment'],
            'validation-armed PR body is final — no rewrite, comment still posts');
    });

    test('body rewrite still runs for an open PR outside the merge queue', function() {
        var h = loadReworkActionHarness({ files: {} });
        var calls = [];
        h.module.postReworkBodyAndComment(makeRecordingScm(calls),
            { number: 956, state: 'open', labels: [{ name: 'pr_approved' }] },
            'gh-952', 'passed', true, 'CONTENT');
        assert.deepEqual(calls.map(function(c) { return c[0]; }), ['body', 'comment'],
            'pre-queue refresh keeps both side effects');
    });

    test('body rewrite preserves the canonical Closes line for GitHub router keys', function() {
        var h = loadReworkActionHarness({ files: {} });
        var calls = [];
        // The refreshed content (outputs/pr_body.md) carries no Closes line of
        // its own — the rewrite must not drop the one GitHub already parsed.
        h.module.postReworkBodyAndComment(makeRecordingScm(calls), { number: 956 },
            'gh-952', 'passed', true, '### Rework summary\n- Fixed the parser.\n');
        assert.equal(calls[0][0], 'body');
        assert.contains(calls[0][2], 'Closes #952',
            'canonical line survives the refresh so the merge bot link never breaks');
        assert.equal(calls[0][2].indexOf('Closes #952'), 0,
            'canonical line stays first, as on creation');
        assert.contains(calls[0][2], '### Rework summary', 'refreshed content preserved');
    });

    test('body rewrite is idempotent when the refreshed content already closes the issue', function() {
        var h = loadReworkActionHarness({ files: {} });
        var calls = [];
        h.module.postReworkBodyAndComment(makeRecordingScm(calls), { number: 956 },
            'gh-952', 'passed', true, 'Closes #952\n\n### Rework summary\n');
        assert.equal(calls[0][2].split('Closes #952').length - 1, 1, 'exactly one Closes line after refresh');
    });

    test('body rewrite leaves non-GitHub tracker keys untouched', function() {
        var h = loadReworkActionHarness({ files: {} });
        var calls = [];
        h.module.postReworkBodyAndComment(makeRecordingScm(calls), { number: 5 },
            'PROJ-1', 'passed', true, 'CONTENT');
        assert.equal(calls[0][2], '## PROJ-1 Result: PASSED\n\n**Latest rework result:** `PASSED`\n\n---\n\nCONTENT',
            'tracker keys must not gain a bogus Closes #N line (gh-737 behavior kept)');
    });

});

// ── gh-1083: action() split — pure planners pinned before extraction ─────────

suite('postTestReworkResults — action-split helpers (gh-1083)', function() {

    function helperModule() {
        return loadReworkActionHarness({ files: {} }).module;
    }

    suite('resolveActionContext', function() {

        test('ticket-shaped params resolve to themselves', function() {
            var m = helperModule();
            var params = { ticket: { key: 'PROJ-77' }, response: 'done' };
            var ctx = m.resolveActionContext(params);
            assert.equal(ctx.actualParams, params, 'actualParams is the params object itself');
            assert.equal(ctx.ticketKey, 'PROJ-77');
        });

        test('jobParams-wrapped params unwrap to the jobParams body', function() {
            var m = helperModule();
            var inner = { ticket: { key: 'PROJ-78' } };
            var ctx = m.resolveActionContext({ jobParams: inner });
            assert.equal(ctx.actualParams, inner, 'actualParams is the jobParams body');
            assert.equal(ctx.ticketKey, 'PROJ-78');
        });

    });

    suite('fixSummaryOf', function() {

        test('returns the response when present', function() {
            var m = helperModule();
            assert.equal(m.fixSummaryOf({ response: 'Fixed the flaky assertion' }), 'Fixed the flaky assertion');
        });

        test('empty string response degrades to the placeholder', function() {
            var m = helperModule();
            assert.equal(m.fixSummaryOf({ response: '' }), '_(No fix summary)_');
        });

        test('missing response degrades to the placeholder', function() {
            var m = helperModule();
            assert.equal(m.fixSummaryOf({}), '_(No fix summary)_');
            assert.equal(m.fixSummaryOf(null), '_(No fix summary)_');
        });

    });

    suite('isMissingResult', function() {

        test('null/unreadable result is missing', function() {
            var m = helperModule();
            assert.equal(m.isMissingResult(null), true);
            assert.equal(m.isMissingResult(undefined), true);
        });

        test('result without a status field is missing', function() {
            var m = helperModule();
            assert.equal(m.isMissingResult({}), true);
            assert.equal(m.isMissingResult({ foo: 1 }), true);
            assert.equal(m.isMissingResult({ status: '' }), true);
        });

        test('result with a status (any value) is present', function() {
            var m = helperModule();
            assert.equal(m.isMissingResult({ status: 'passed' }), false);
            assert.equal(m.isMissingResult({ status: 'failed' }), false);
            assert.equal(m.isMissingResult({ status: 'flaky' }), false, 'unknown statuses are NOT missing — normalizeTestStatus handles them');
        });

    });

    suite('decidePrIsDirty', function() {

        test('no PR is never dirty', function() {
            var m = helperModule();
            assert.equal(m.decidePrIsDirty(null), false);
            assert.equal(m.decidePrIsDirty(undefined), false);
        });

        test('mergeable_state "dirty" marks the PR dirty', function() {
            var m = helperModule();
            assert.equal(m.decidePrIsDirty({ number: 1, mergeable_state: 'dirty' }), true);
        });

        test('mergeStateStatus "DIRTY" marks the PR dirty', function() {
            var m = helperModule();
            assert.equal(m.decidePrIsDirty({ number: 1, mergeStateStatus: 'DIRTY' }), true);
        });

        test('mergeable === false marks the PR dirty', function() {
            var m = helperModule();
            assert.equal(m.decidePrIsDirty({ number: 1, mergeable: false }), true);
        });

        test('clean PR (all indicators good) is not dirty', function() {
            var m = helperModule();
            assert.equal(m.decidePrIsDirty({
                number: 1, mergeable_state: 'clean', mergeStateStatus: 'CLEAN', mergeable: true
            }), false);
        });

        test('empty PR shape is not dirty', function() {
            var m = helperModule();
            assert.equal(m.decidePrIsDirty({ number: 1 }), false);
            assert.equal(m.decidePrIsDirty({ mergeable: undefined }), false, 'strict === false — undefined is not dirty');
        });

    });

    suite('decideReworkTargetStatus', function() {

        var STATUSES = {
            IN_REVIEW_PASSED: 'In Review - Passed',
            IN_REVIEW_FAILED: 'In Review - Failed'
        };

        test('passed moves to In Review - Passed', function() {
            var m = helperModule();
            assert.deepEqual(m.decideReworkTargetStatus(true, STATUSES),
                { stageKey: 'IN_REVIEW_PASSED', targetStatus: 'In Review - Passed' });
        });

        test('failed moves to In Review - Failed', function() {
            var m = helperModule();
            assert.deepEqual(m.decideReworkTargetStatus(false, STATUSES),
                { stageKey: 'IN_REVIEW_FAILED', targetStatus: 'In Review - Failed' });
        });

        test('status values flow through from the config verbatim', function() {
            var m = helperModule();
            var custom = { IN_REVIEW_PASSED: 'Review OK', IN_REVIEW_FAILED: 'Review NG' };
            assert.equal(m.decideReworkTargetStatus(true, custom).targetStatus, 'Review OK');
            assert.equal(m.decideReworkTargetStatus(false, custom).targetStatus, 'Review NG');
        });

    });

});

suite('postTestReworkResults — action-input resolution (gh-1083)', function() {

    test('loadReworkProjectConfig reads the jobParams body when wrapped', function() {
        var h = loadReworkActionHarness({ files: {} });
        var inner = { marker: 'jobParams-body' };
        // The harness configLoader double ignores its argument; pin the
        // delegation by observing the resolved config identity instead.
        var config = h.module.loadReworkProjectConfig({ jobParams: inner });
        assert.equal(config, REWORK_ACTION_CONFIG, 'delegates to configLoader.loadProjectConfig');
    });

    test('loadReworkProjectConfig delegates for bare dispatch params too', function() {
        var h = loadReworkActionHarness({ files: {} });
        assert.equal(h.module.loadReworkProjectConfig({ ticket: { key: 'PROJ-1' } }), REWORK_ACTION_CONFIG);
    });

    test('smRemoveLabelOf reads the configured label and degrades to null', function() {
        var h = loadReworkActionHarness({ files: {} });
        assert.equal(h.module.smRemoveLabelOf({ removeLabel: 'sm_rework_triggered' }), 'sm_rework_triggered');
        assert.equal(h.module.smRemoveLabelOf({}), null);
        assert.equal(h.module.smRemoveLabelOf(null), null);
    });

});

suite('postTestReworkResults.commitAndPush — guards and fallbacks (gh-1192)', function() {

    test('an undeterminable branch fails before any staging', function() {
        var calls = [];
        var cli = function(args) {
            calls.push(args.command);
            return '';
        };
        cli.calls = calls;
        var module = loadPostTestReworkResults(cli);
        var err = null;
        try { module.commitAndPush('PROJ-123', true, REWORK_CONFIG, false); } catch (e) { err = e; }
        assert.ok(err, 'expected a throw');
        assert.contains(err.message, 'Could not determine current git branch');
        assert.ok(cli.calls.indexOf('git add testing/') === -1, 'no git mutation happened');
    });

    test('pushing directly to main or master is refused', function() {
        var cli = makeCli({ branch: 'main' });
        var module = loadPostTestReworkResults(cli);
        var err = null;
        try { module.commitAndPush('PROJ-123', true, REWORK_CONFIG, false); } catch (e) { err = e; }
        assert.ok(err, 'expected a throw');
        assert.contains(err.message, 'Refusing to commit rework directly to "main"');

        cli = makeCli({ branch: 'master' });
        module = loadPostTestReworkResults(cli);
        err = null;
        try { module.commitAndPush('PROJ-123', true, REWORK_CONFIG, false); } catch (e) { err = e; }
        assert.ok(err, 'expected a throw');
        assert.contains(err.message, 'Refusing to commit rework directly to "master"');
    });

    test('a failing origin fetch warns and the flow continues', function() {
        var calls = [];
        var cli = function(args) {
            calls.push(args.command);
            if (args.command === 'git fetch origin main') throw new Error('fetch boom');
            if (args.command === 'git branch --show-current') return 'test/PROJ-123';
            if (args.command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) throw new Error('Command execution failed (exit code 1)');
            if (args.command.indexOf('git ls-remote --heads origin') === 0) return SHA40 + '\trefs/heads/test/PROJ-123';
            if (args.command === 'git rev-parse HEAD') return SHA40;
            return '';
        };
        cli.calls = calls;
        var module = loadPostTestReworkResults(cli);
        var branchName = module.commitAndPush('PROJ-123', true, REWORK_CONFIG, false);
        assert.equal(branchName, 'test/PROJ-123');
        assert.ok(cli.calls.some(function(c) { return c === 'git fetch origin main'; }));
    });

    test('a rejected push escalates to a forced update of the rework branch', function() {
        var cli = makeCli({ branch: 'test/PROJ-123' });
        var rejected = 'git push -u origin test/PROJ-123';
        var forced = rejected + ' --force';
        var cli2 = function(args) {
            if (args.command === rejected) throw new Error('push rejected');
            return cli(args);
        };
        cli2.calls = cli.calls;
        var module = loadPostTestReworkResults(cli2);
        var branchName = module.commitAndPush('PROJ-123', true, REWORK_CONFIG, false);
        assert.equal(branchName, 'test/PROJ-123');
        assert.ok(cli.calls.some(function(c) { return c === forced; }), 'forced push executed after rejection');
    });

    test('the extracted helpers keep the pinned messages and command shapes', function() {
        var cli = makeCli({ branch: 'test/PROJ-123' });
        var module = loadPostTestReworkResults(cli);
        assert.equal(module.currentBranchName(), 'test/PROJ-123');

        var err = null;
        try { module.guardReworkBranch('', 'PROJ-123'); } catch (e) { err = e; }
        assert.ok(err, 'empty branch throws');
        assert.contains(err.message, 'Could not determine current git branch');

        err = null;
        try { module.guardReworkBranch('main', 'PROJ-123'); } catch (e) { err = e; }
        assert.ok(err, 'main throws');
        assert.contains(err.message, 'Refusing to commit rework directly to "main"');

        module.pushReworkBranchToRemote('test/PROJ-123');
        assert.ok(cli.calls.indexOf('git push -u origin test/PROJ-123') !== -1);

        err = null;
        try { module.verifyPushedBranch(SHA40, 'test/PROJ-123'); } catch (e) { err = e; }
        assert.equal(err, null, 'matching local/remote shas verify cleanly');
    });

    test('mergeBaseWhenDirty commits pending fixes and merges the base without committing', function() {
        var cli = makeCli({ branch: 'test/PROJ-123' });
        var module = loadPostTestReworkResults(cli);
        module.mergeBaseWhenDirty('PROJ-123', true, REWORK_CONFIG, 'main');
        assert.ok(cli.calls.indexOf('git add testing/') !== -1, 'pending fixes staged first');
        assert.ok(cli.calls.indexOf('git merge origin/main --no-commit --no-ff') !== -1, 'base merged without commit');
    });
});
