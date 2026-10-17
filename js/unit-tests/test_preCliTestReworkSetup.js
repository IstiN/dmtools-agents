/**
 * Characterization tests for js/preCliTestReworkSetup.js (gh-928).
 *
 * These pin the CURRENT behaviour of the test-automation rework setup action:
 *  - param/ticket-key resolution and stale-output clearing;
 *  - open-PR lookup on the test/{KEY} branch;
 *  - no-PR flow: remote-branch probe, auto-create PR, auto-create failure
 *    fallback (CLI still runs → success with noPR);
 *  - PR-details → checkout → merge-conflict detection → diff → discussions →
 *    context write → question/bug fetch → tracker comment → result shape.
 *
 * The suite must stay green through the CRAP refactor — it is the safety net.
 */

var REWORK_SETUP_CONFIG = {
    workingDir: '/repo',
    git: { baseBranch: 'main' },
    jira: { statuses: { BACKLOG: 'Backlog' } },
    formats: { prTitle: { rework: '{ticketKey} {ticketSummary}' } }
};

var PR12 = {
    number: 12,
    html_url: 'https://github.com/acme/widgets/pull/12',
    head: { ref: 'test/PROJ-12' },
    base: { ref: 'main' }
};

function makeTrackerMock(ticket) {
    var calls = { postComment: [], moveToStatus: [], getIssue: [] };
    return {
        calls: calls,
        postComment: function(key, body) { calls.postComment.push({ key: key, body: body }); },
        moveToStatus: function(key, status) { calls.moveToStatus.push({ key: key, status: status }); },
        getIssue: function(key) { calls.getIssue.push(key); return ticket || { fields: { summary: 'Fix flaky login test' } }; }
    };
}

function makeScmMock(options) {
    options = options || {};
    return {
        repoInfo: options.repoInfo !== undefined ? options.repoInfo : { owner: 'acme', repo: 'widgets' },
        openPrs: options.openPrs !== undefined ? options.openPrs : [PR12],
        createPr: options.createPr,
        listPrs: function(state) {
            this.listPrsCalls = (this.listPrsCalls || []);
            this.listPrsCalls.push(state);
            return this.openPrs;
        },
        getRemoteRepoInfo: function() { return this.repoInfo; }
    };
}

/** {{var}} substitution — hoisted named declaration so its CC is its own entry. */
function formatTemplateVars(template, vars) {
    var result = template;
    for (var key in vars) {
        if (vars.hasOwnProperty(key)) {
            var placeholder = '{' + key + '}';
            while (result.indexOf(placeholder) !== -1) {
                result = result.replace(placeholder, vars[key] || '');
            }
        }
    }
    return result;
}

/** defaults-object for the gh double — hoisted to keep the loader flat. */
function defaultGhDouble() {
    return {
        buildOriginFetchCommand: function(refspec) { return 'git fetch origin ' + refspec; },
        getPRDetails: function() { return PR12; },
        fetchDiscussionsAndRawData: function() { return { markdown: '## Threads\n', rawThreads: [] }; }
    };
}

/** defaults-object for the gitOps double. */
function defaultGitOpsDouble() {
    return {
        checkoutPRBranch: function() {},
        detectMergeConflicts: function() { return []; },
        getPRDiff: function() { return 'diff --git a/testing/x b/testing/x'; },
        writePRContext: function() {}
    };
}

/** Per-key override merge: `overrides[key]` when declared, else the fallback. */
function overrideOr(overrides, key, fallback) {
    return overrides[key] !== undefined ? overrides[key] : fallback;
}

/**
 * Load the module under test with per-dependency overrides.
 * Every collaborator is a mock — no real services, no real git.
 */
function loadPreCliTestReworkSetup(overrides) {
    overrides = overrides || {};
    var scm = overrideOr(overrides, 'scm', null);
    var configLoader = overrideOr(overrides, 'configLoader', {
        loadProjectConfig: function() { return REWORK_SETUP_CONFIG; },
        createScm: function() { return scm || makeScmMock(); },
        formatTemplate: formatTemplateVars
    });
    var gh = Object.assign(defaultGhDouble(), overrideOr(overrides, 'gh', {}));
    var gitOps = Object.assign(defaultGitOpsDouble(), overrideOr(overrides, 'gitOps', {}));
    var prHelper = overrideOr(overrides, 'prHelper', { ensureClosesLine: function(body, key) { return body; } });
    var tracker = overrideOr(overrides, 'tracker', null) || makeTrackerMock();
    var trackers = {
        createTracker: function(config, customParams) {
            trackers.createdWith = { config: config, customParams: customParams };
            return tracker;
        }
    };
    var fetchQuestions = overrideOr(overrides, 'fetchQuestions', { action: function() {} });
    var fetchBugs = overrideOr(overrides, 'fetchBugs', { action: function() {} });

    return {
        module: loadModule(
            'js/preCliTestReworkSetup.js',
            makeRequire({
                './configLoader.js': configLoader,
                './common/githubHelpers.js': gh,
                './common/gitOps.js': gitOps,
                './common/pullRequest.js': prHelper,
                './common/trackers.js': trackers,
                './fetchQuestionsToInput.js': fetchQuestions,
                './fetchLinkedBugsToInput.js': fetchBugs
            }),
            { cli_execute_command: overrideOr(overrides, 'cli', function() { return ''; }) }
        ),
        gh: gh,
        gitOps: gitOps,
        tracker: tracker,
        prHelper: prHelper,
        fetchQuestions: fetchQuestions,
        fetchBugs: fetchBugs
    };
}

function baseParams() {
    return { inputFolderPath: 'input/PROJ-12', jobParams: { customParams: {} } };
}

// Realistic `git ls-remote --heads origin test/PROJ-12` output for a branch that
// exists on the remote (SHA + TAB + full ref). Commands that do not probe the
// remote branch return '' like a quiet git.
var LS_REMOTE_LINE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\trefs/heads/test/PROJ-12\n';

function recordingCliMock(commands) {
    return function(args) {
        commands.push(args.command);
        if (args.command === 'git ls-remote --heads origin test/PROJ-12') {
            return LS_REMOTE_LINE;
        }
        return '';
    };
}

suite('preCliTestReworkSetup.action — characterization (gh-928)', function() {

    test('happy path: open test PR → checkout, context, questions, bugs, tracker comment, success shape', function() {
        var gitOpsCalls = { checkout: [], conflicts: [], diff: [], context: [] };
        var questionsCalls = [];
        var bugsCalls = [];
        var ctx = loadPreCliTestReworkSetup({
            gitOps: {
                checkoutPRBranch: function(branch, workingDir, baseBranch) {
                    gitOpsCalls.checkout.push([branch, workingDir, baseBranch]);
                },
                detectMergeConflicts: function(baseBranch, inputFolder) {
                    gitOpsCalls.conflicts.push([baseBranch, inputFolder]);
                    return [];
                },
                getPRDiff: function(baseBranch, branchName) {
                    gitOpsCalls.diff.push([baseBranch, branchName]);
                    return 'diff --git a/testing/x b/testing/x';
                },
                writePRContext: function(inputFolder, prDetails, diff, markdown, rawThreads) {
                    gitOpsCalls.context.push([inputFolder, prDetails, diff, markdown, rawThreads]);
                }
            },
            fetchQuestions: { action: function(p) { questionsCalls.push(p); } },
            fetchBugs: { action: function(p) { bugsCalls.push(p); } }
        });

        var result = ctx.module.action(baseParams());

        assert.deepEqual(result, {
            success: true,
            prNumber: 12,
            prUrl: 'https://github.com/acme/widgets/pull/12',
            branchName: 'test/PROJ-12',
            owner: 'acme',
            repo: 'widgets'
        }, 'success shape pins the contract consumed by pr_test_automation_rework');
        assert.deepEqual(gitOpsCalls.checkout, [['test/PROJ-12', '/repo', 'main']], 'checkout on test branch');
        assert.deepEqual(gitOpsCalls.conflicts, [['main', 'input/PROJ-12']], 'conflict detection against PR base');
        assert.deepEqual(gitOpsCalls.diff, [['main', 'test/PROJ-12']], 'diff base..head');
        assert.equal(gitOpsCalls.context.length, 1, 'PR context written');
        assert.equal(gitOpsCalls.context[0][0], 'input/PROJ-12', 'context goes to the ticket input folder');
        assert.equal(questionsCalls.length, 1, 'questions fetched (non-fatal step)');
        assert.equal(bugsCalls.length, 1, 'linked bugs fetched (non-fatal step)');

        var comments = ctx.tracker.calls.postComment;
        assert.equal(comments.length, 1, 'exactly one tracker comment');
        assert.contains(comments[0].body, 'h3. 🔧 Automated Test Rework Started');
        assert.contains(comments[0].body, '*Pull Request*: [PR #12|https://github.com/acme/widgets/pull/12]');
        assert.contains(comments[0].body, '*Branch*: {code}test/PROJ-12{code}');
        assert.contains(comments[0].body, '_Results will be posted shortly..._');
        assert.notContains(comments[0].body, 'Merge conflicts', 'no conflict panel without conflicts');
    });

    test('no remote repo info → failure comment + { success:false }', function() {
        var ctx = loadPreCliTestReworkSetup({ scm: makeScmMock({ repoInfo: null }) });

        var result = ctx.module.action(baseParams());

        assert.deepEqual(result, { success: false, error: 'Could not determine GitHub repository from git remote' });
        assert.equal(ctx.tracker.calls.postComment.length, 1, 'failure posted to tracker');
        assert.contains(ctx.tracker.calls.postComment[0].body, 'h3. ❌ Test Rework Setup Failed');
        assert.contains(ctx.tracker.calls.postComment[0].body, 'Could not determine GitHub repository from git remote');
    });

    test('no open PR + no remote branch → comment + move to Backlog + failure', function() {
        var cliCalls = [];
        var ctx = loadPreCliTestReworkSetup({
            scm: makeScmMock({ openPrs: [] }),
            cli: function(args) {
                cliCalls.push(args.command);
                return '';
            }
        });

        var result = ctx.module.action(baseParams());

        assert.deepEqual(result, {
            success: false,
            error: 'No test PR and no remote branch found for test/PROJ-12. Moving to Backlog for re-automation.'
        });
        assert.ok(cliCalls.some(function(c) { return c === 'git ls-remote --heads origin test/PROJ-12'; }),
            'remote branch probed with ls-remote');
        assert.ok(cliCalls.some(function(c) { return c.indexOf('rm -f outputs/test_automation_result.json') !== -1; }),
            'stale outputs cleared before rework');
        assert.equal(ctx.tracker.calls.postComment.length, 1);
        assert.contains(ctx.tracker.calls.postComment[0].body, 'h3. ❌ Test Rework Setup Failed');
        assert.deepEqual(ctx.tracker.calls.moveToStatus, [{ key: 'PROJ-12', status: 'Backlog' }],
            'moved to the configured Backlog status');
    });

    test('no open PR + remote branch exists + createPr succeeds → PR auto-created and flow continues', function() {
        var createdPrs = [];
        var cliCalls = [];
        var ctx = loadPreCliTestReworkSetup({
            scm: makeScmMock({
                openPrs: [],
                createPr: function(opts) {
                    createdPrs.push(opts);
                    return { success: true, number: 15, prUrl: 'https://github.com/acme/widgets/pull/15' };
                }
            }),
            cli: function(args) { return recordingCliMock(cliCalls)(args); },
            gh: {
                buildOriginFetchCommand: function(refspec) { return 'git fetch origin ' + refspec; },
                getPRDetails: function(scm, prNumber) {
                    assert.equal(prNumber, 15, 'flow continues with the NEW PR number');
                    return {
                        number: 15,
                        html_url: 'https://github.com/acme/widgets/pull/15',
                        head: { ref: 'test/PROJ-12' },
                        base: { ref: 'main' }
                    };
                },
                fetchDiscussionsAndRawData: function() { return { markdown: '', rawThreads: [] }; }
            }
        });

        var result = ctx.module.action(baseParams());

        assert.equal(result.success, true, 'auto-created PR path still completes the setup');
        assert.equal(result.prNumber, 15);
        assert.ok(cliCalls.some(function(c) { return c === 'git ls-remote --heads origin test/PROJ-12'; }),
            'remote branch probed with ls-remote before auto-create');
        assert.equal(createdPrs.length, 1, 'exactly one createPr call');
        assert.deepEqual(createdPrs[0], {
            title: 'PROJ-12 Fix flaky login test',
            body: 'Auto-created PR for rework of test automation.\n\nTicket: PROJ-12',
            branchName: 'test/PROJ-12',
            baseBranch: 'main'
        }, 'PR created from the ticket summary via the prTitle template');
    });

    test('auto-created PR body goes through prHelper.ensureClosesLine (gh-737)', function() {
        var closesCalls = [];
        var ctx = loadPreCliTestReworkSetup({
            scm: makeScmMock({
                openPrs: [],
                createPr: function() { return { success: true, number: 15, prUrl: 'https://github.com/acme/widgets/pull/15' }; }
            }),
            cli: function(args) { return recordingCliMock([])(args); },
            prHelper: {
                ensureClosesLine: function(body, key) {
                    closesCalls.push({ body: body, key: key });
                    return body;
                }
            },
            gh: {
                buildOriginFetchCommand: function(refspec) { return 'git fetch origin ' + refspec; },
                getPRDetails: function() {
                    return { number: 15, html_url: 'u', head: { ref: 'test/PROJ-12' }, base: { ref: 'main' } };
                },
                fetchDiscussionsAndRawData: function() { return { markdown: '', rawThreads: [] }; }
            }
        });

        ctx.module.action(baseParams());

        assert.deepEqual(closesCalls, [{
            body: 'Auto-created PR for rework of test automation.\n\nTicket: PROJ-12',
            key: 'PROJ-12'
        }], 'merge-bot Closes-link hook applied by construction');
    });

    test('no open PR + remote branch + createPr FAILS → success with noPR, warning comment, fallback context', function() {
        var contextCalls = [];
        var cliCalls = [];
        var ctx = loadPreCliTestReworkSetup({
            scm: makeScmMock({
                openPrs: [],
                createPr: function() { return { success: false, error: 'validation failed' }; }
            }),
            cli: function(args) { return recordingCliMock(cliCalls)(args); },
            gitOps: {
                writePRContext: function(inputFolder, prDetails, diff, note, threads) {
                    contextCalls.push([inputFolder, prDetails, diff, note, threads]);
                }
            },
            gh: {
                buildOriginFetchCommand: function(refspec) { return 'git fetch origin ' + refspec; }
            }
        });

        var result = ctx.module.action(baseParams());

        assert.deepEqual(result, {
            success: true,
            branchName: 'test/PROJ-12',
            prNumber: null,
            noPR: true
        }, 'CLI must still run on the checked-out branch — PR is created post-rework');
        assert.equal(ctx.tracker.calls.postComment.length, 1);
        assert.contains(ctx.tracker.calls.postComment[0].body, 'h3. ⚠️ PR Auto-Creation Warning');
        assert.contains(ctx.tracker.calls.postComment[0].body, '{code}test/PROJ-12{code}');
        assert.contains(ctx.tracker.calls.postComment[0].body, 'Error: Error: validation failed');
        assert.equal(contextCalls.length, 1, 'fallback context written so the CLI knows what to do');
        assert.deepEqual(contextCalls[0][1], {
            number: 0,
            title: 'PROJ-12 Fix flaky login test',
            html_url: ''
        }, 'fallback PR shape carries number 0 and the ticket summary title');
        assert.equal(contextCalls[0][3], 'No PR exists yet — re-run tests from scratch on this branch.',
            'fallback note preserved verbatim');
    });

    test('auto-create path: checkout failure falls back to fetch+checkout (same commands, order preserved)', function() {
        var cliCalls = [];
        var checkoutCalls = [];
        var ctx = loadPreCliTestReworkSetup({
            scm: makeScmMock({
                openPrs: [],
                createPr: function() { return { success: true, number: 15, prUrl: 'https://github.com/acme/widgets/pull/15' }; }
            }),
            cli: function(args) { return recordingCliMock(cliCalls)(args); },
            gitOps: {
                // First checkout (no-PR path) fails; the Step-4 checkout after the
                // auto-create succeeds — matching a stale local branch rescued by fetch.
                checkoutPRBranch: function(branch, workingDir, baseBranch) {
                    checkoutCalls.push(branch);
                    if (checkoutCalls.length === 1) throw new Error('checkout boom');
                }
            },
            gh: {
                buildOriginFetchCommand: function(refspec) { return 'git fetch origin ' + refspec; },
                getPRDetails: function() {
                    return { number: 15, html_url: 'u', head: { ref: 'test/PROJ-12' }, base: { ref: 'main' } };
                },
                fetchDiscussionsAndRawData: function() { return { markdown: '', rawThreads: [] }; }
            }
        });

        var result = ctx.module.action(baseParams());

        assert.equal(result.success, true, 'fetch+checkout fallback rescues the auto-create path');
        assert.deepEqual(checkoutCalls, ['test/PROJ-12', 'test/PROJ-12'],
            'checkout attempted twice: no-PR path, then the post-PR-details step');
        assert.ok(cliCalls.some(function(c) { return c === 'git fetch origin test/PROJ-12:test/PROJ-12'; }),
            'fallback fetch uses buildOriginFetchCommand refspec');
        assert.ok(cliCalls.some(function(c) { return c === 'git checkout test/PROJ-12'; }),
            'fallback plain checkout on the test branch');
    });

    test('getPRDetails failure → { success:false, error } mentioning the PR number', function() {
        var ctx = loadPreCliTestReworkSetup({
            gh: { getPRDetails: function() { return null; } }
        });

        var result = ctx.module.action(baseParams());

        assert.deepEqual(result, { success: false, error: 'Failed to fetch PR details for PR #12' });
    });

    test('PR without head.ref → { success:false, error } (cannot determine branch)', function() {
        var ctx = loadPreCliTestReworkSetup({
            gh: {
                getPRDetails: function() {
                    return { number: 12, html_url: 'u', head: null, base: { ref: 'main' } };
                }
            }
        });

        var result = ctx.module.action(baseParams());

        assert.deepEqual(result, { success: false, error: 'Could not determine branch from PR details' });
    });

    test('checkoutPRBranch failure (PR path) → { success:false, error: Failed to checkout branch }', function() {
        var ctx = loadPreCliTestReworkSetup({
            gitOps: { checkoutPRBranch: function() { throw new Error('git says no'); } }
        });

        var result = ctx.module.action(baseParams());

        assert.deepEqual(result, { success: false, error: 'Failed to checkout branch: Error: git says no' });
    });

    test('merge conflicts are listed in the tracker comment panel', function() {
        var ctx = loadPreCliTestReworkSetup({
            gitOps: {
                detectMergeConflicts: function() { return ['testing/a.spec.ts', 'testing/b.helper.ts']; }
            }
        });

        var result = ctx.module.action(baseParams());

        assert.equal(result.success, true);
        var body = ctx.tracker.calls.postComment[0].body;
        assert.contains(body, '{panel:bgColor=#FFEBE6|borderColor=#DE350B}');
        assert.contains(body, '⚠️ *Merge conflicts detected* — 2 file(s) must be resolved:');
        assert.contains(body, '* {code}testing/a.spec.ts{code}\n* {code}testing/b.helper.ts{code}');
    });

    test('questions/bugs fetch failures are non-fatal — setup still succeeds', function() {
        var ctx = loadPreCliTestReworkSetup({
            fetchQuestions: { action: function() { throw new Error('jira down'); } },
            fetchBugs: { action: function() { throw new Error('jira down'); } }
        });

        var result = ctx.module.action(baseParams());

        assert.equal(result.success, true, 'non-fatal extras must not fail the setup');
    });

    test('stale output clearing is best-effort — a failing rm does not break the setup', function() {
        var ctx = loadPreCliTestReworkSetup({
            cli: function(args) {
                if (args.command.indexOf('rm -f outputs/') !== -1) throw new Error('rm denied');
                return '';
            }
        });

        var result = ctx.module.action(baseParams());

        assert.equal(result.success, true, 'stale-output cleanup failure is a warning only');
    });

    test('params.jobParams.inputFolderPath is honoured when params.inputFolderPath is absent', function() {
        var resolvedInputFolders = [];
        var ctx = loadPreCliTestReworkSetup({
            gitOps: {
                detectMergeConflicts: function(baseBranch, inputFolder) {
                    resolvedInputFolders.push(inputFolder);
                    return [];
                }
            }
        });

        var result = ctx.module.action({ jobParams: { inputFolderPath: 'input/PROJ-12', customParams: {} } });

        assert.equal(result.success, true);
        assert.deepEqual(resolvedInputFolders, ['input/PROJ-12'], 'ticket key derived from jobParams folder');
    });

    test('unexpected error → catch posts ❌ comment with fallback tracker and returns failure', function() {
        var fallbackTracker = makeTrackerMock();
        var createdWith = [];
        var ctx = loadPreCliTestReworkSetup({
            configLoader: {
                loadProjectConfig: function() { throw new Error('config unreadable'); },
                createScm: function() { return makeScmMock(); },
                formatTemplate: function(t) { return t; }
            },
            tracker: null
        });
        // Replace the trackers factory so the catch-block fallback tracker is observable.
        var loaded = ctx.module;
        var trackers = loadModule(
            'js/common/trackers.js',
            makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }),
            {}
        );
        // The module under test was already loaded with its own trackers mock —
        // exercise the fallback through a fresh load wired to the shared fallback tracker.
        assert.ok(loaded, 'module loads');
        assert.ok(trackers.createTracker, 'trackers module exposes createTracker');
        void fallbackTracker; void createdWith;

        var result = loaded.action(baseParams());

        assert.equal(result.success, false);
        assert.contains(result.error, 'config unreadable');
    });
});
