/**
 * Unit tests for js/preCliReworkSetup.js
 *
 * Scope: syncBaseBranchIfConfigured() — the customParams.branchSyncFnPath extension point
 * used to keep a two-branch-mode PR base (e.g. "release/rc_*") from drifting stale relative
 * to config.git.baseBranch before merge-conflict detection runs. The rest of action()'s flow
 * (PR lookup, branch checkout, discussions/diff writing, Jira comment) is unit-tested
 * elsewhere/indirectly and isn't re-verified here.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

var forkCheckoutModule = loadModule('js/common/forkCheckout.js', makeRequire({ './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {}) }), {});

var NOOP_MODULE = {};

var reworkCommentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));

function makeGhStub(fetchCalls) {
    return {
        buildOriginFetchCommand: function() {
            return 'git -c fetch.recurseSubmodules=no fetch origin';
        },
        // Unused by syncBaseBranchIfConfigured but required by the module's top-level require().
        _isScm: function() { return false; },
        findPRForTicket: function() {},
        getPRDetails: function() {},
        fetchDiscussionsAndRawData: function() {},
        detectFailedChecks: function() {},
        cleanCommandOutput: function(s) { return s; }
    };
}

function loadPreCliReworkSetup(configLoaderStub, mocks) {
    return loadModule(
        'js/preCliReworkSetup.js',
        makeRequire({
            './configLoader.js': configLoaderStub,
            './common/githubHelpers.js': mocks.__ghStub,
            './forkCheckout.js': forkCheckoutModule,
            './common/gitOps.js': NOOP_MODULE,
            './common/commentMarkup.js': reworkCommentMarkupModule,
            './fetchQuestionsToInput.js': NOOP_MODULE,
            './fetchParentContextToInput.js': NOOP_MODULE,
            './restoreFromReleases.js': NOOP_MODULE,
            // The tracker provider is only exercised inside action(); these tests
            // cover syncBaseBranchIfConfigured() which never touches it.
            './common/trackers.js': {
                createTracker: function() {
                    return {
                        provider: function() { return 'jira'; },
                        postComment: function() {},
                        addLabel: function() {},
                        removeLabel: function() {},
                        moveToStatus: function() {},
                        assignTo: function() {}
                    };
                }
            },
            // Real module (not a no-op stub): preCliReworkSetup.js reads
            // setupCommands.truncateSetupError at load time to build its own
            // truncateForComment() helper, so the stub must actually export it.
            './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
            './config.js': { resolveStatuses: function() { return { IN_DEVELOPMENT: 'In Development' }; } }
        }),
        mocks || {}
    );
}

function makeConfig(overrides) {
    var base = { git: { baseBranch: 'master' }, workingDir: 'dependencies/proj' };
    return Object.assign({}, base, overrides || {});
}

function makeConfigLoaderStub(hookFn, hookLoadCalls) {
    return {
        loadHookFn: function(path, hookName) {
            hookLoadCalls.push({ path: path, hookName: hookName });
            return hookFn || null;
        }
    };
}

suite('preCliReworkSetup.syncBaseBranchIfConfigured', function() {

    test('is a no-op when branchSyncFnPath is not configured', function() {
        var hookLoadCalls = [];
        var cliCalls = [];
        var ghStub = makeGhStub();
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, hookLoadCalls), {
            __ghStub: ghStub,
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        mod.syncBaseBranchIfConfigured('release/rc_mobile_proj-1', {}, makeConfig());

        assert.equal(hookLoadCalls.length, 0);
        assert.equal(cliCalls.length, 0);
    });

    test('is a no-op when the PR base already equals config.git.baseBranch', function() {
        var hookLoadCalls = [];
        var cliCalls = [];
        var ghStub = makeGhStub();
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, hookLoadCalls), {
            __ghStub: ghStub,
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        mod.syncBaseBranchIfConfigured('master', { branchSyncFnPath: '.dmtools/branchNaming/sf_rc_jenkins.js' }, makeConfig());

        assert.equal(hookLoadCalls.length, 0, 'should not even look up the hook when there is nothing to sync');
        assert.equal(cliCalls.length, 0);
    });

    test('is a no-op when baseBranch is falsy', function() {
        var hookLoadCalls = [];
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, hookLoadCalls), {
            __ghStub: makeGhStub(),
            cli_execute_command: function() { return ''; }
        });

        mod.syncBaseBranchIfConfigured(null, { branchSyncFnPath: 'x.js' }, makeConfig());

        assert.equal(hookLoadCalls.length, 0);
    });

    test('invokes the configured hook with the right context and fetches origin afterwards', function() {
        var hookLoadCalls = [];
        var hookCallArgs = null;
        var cliCalls = [];
        var hookFn = function(ctx) { hookCallArgs = ctx; };
        var config = makeConfig();
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(hookFn, hookLoadCalls), {
            __ghStub: makeGhStub(),
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        mod.syncBaseBranchIfConfigured('release/rc_mobile_proj-1', { branchSyncFnPath: '.dmtools/branchNaming/sf_rc_jenkins.js' }, config);

        assert.equal(hookLoadCalls.length, 1);
        assert.equal(hookLoadCalls[0].path, '.dmtools/branchNaming/sf_rc_jenkins.js');
        assert.equal(hookLoadCalls[0].hookName, 'branchSyncFnPath');

        assert.ok(hookCallArgs, 'branchSyncFn should have been invoked');
        assert.equal(hookCallArgs.branchName, 'release/rc_mobile_proj-1');
        assert.equal(hookCallArgs.targetBranch, 'master');
        assert.equal(hookCallArgs.workingDir, 'dependencies/proj');
        assert.equal(hookCallArgs.config, config);

        assert.ok(cliCalls.indexOf('git -c fetch.recurseSubmodules=no fetch origin') !== -1,
            'fetches origin after the hook runs so the local repo sees the synced branch');
    });

    test('swallows errors thrown by the hook and does not fetch afterwards', function() {
        var hookLoadCalls = [];
        var cliCalls = [];
        var hookFn = function() { throw new Error('Jenkins job failed'); };
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(hookFn, hookLoadCalls), {
            __ghStub: makeGhStub(),
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        // Should not throw.
        mod.syncBaseBranchIfConfigured('release/rc_mobile_proj-1', { branchSyncFnPath: 'x.js' }, makeConfig());

        assert.equal(cliCalls.length, 0, 'should not fetch origin when the hook itself failed');
    });

    test('is a no-op when the hook path does not export a function', function() {
        var hookLoadCalls = [];
        var cliCalls = [];
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, hookLoadCalls), {
            __ghStub: makeGhStub(),
            cli_execute_command: function(opts) { cliCalls.push(opts.command); return ''; }
        });

        mod.syncBaseBranchIfConfigured('release/rc_mobile_proj-1', { branchSyncFnPath: 'x.js' }, makeConfig());

        assert.equal(hookLoadCalls.length, 1, 'loadHookFn is still consulted');
        assert.equal(cliCalls.length, 0, 'nothing runs when loadHookFn returns null');
    });

});

suite('preCliReworkSetup.truncateForComment', function() {

    test('is wired to setupCommands.truncateSetupError so failSetup() reuses the same bound', function() {
        var mod = loadPreCliReworkSetup(makeConfigLoaderStub(null, []), { __ghStub: makeGhStub() });

        assert.equal(mod.truncateForComment('short'), 'short');

        var huge = 'Y'.repeat(500000);
        var truncated = mod.truncateForComment(huge);
        assert.ok(truncated.length < 10000,
            'huge setup-failure output must be bounded before being embedded in a Jira comment, got ' + truncated.length);
        assert.ok(truncated.indexOf('truncated') !== -1, 'truncated message should say so');
    });

});

// ── gh-770: per-tracker markup for the rework-started comment ────────────────
// The rework setup historically hard-coded Jira wiki markup (h3., {panel},
// {code}) in the "Automated Rework Started" comment; on a GitHub-backed
// tracker that renders as raw text garbage. The builder is extracted so the
// flavor choice (commentMarkup.forTicket) is testable per tracker.

var reworkCommentMarkup = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));

suite('preCliReworkSetup.buildReworkStartedComment — per-tracker markup (gh-770)', function() {
    var FULL_CTX = {
        prNumber: 1308,
        prUrl: 'https://github.com/acme/widgets/pull/1308',
        branchName: 'ai/gh-1308',
        conflictFiles: ['src/a.dart', 'src/b.dart'],
        failedChecks: [{ name: 'build' }, { name: 'test' }]
    };

    function loadMod() {
        return loadPreCliReworkSetup(makeConfigLoaderStub(null, []), { __ghStub: makeGhStub() });
    }

    test('jira flavor keeps wiki markup — h3., *bold*, [text|url], {code}, {panel}', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('jira'), FULL_CTX);
        assert.ok(out.indexOf('h3. 🔧 Automated Rework Started\n') === 0, 'starts with the historical h3 heading');
        assert.ok(out.indexOf('*Pull Request*: [PR #1308|https://github.com/acme/widgets/pull/1308]\n') !== -1);
        assert.ok(out.indexOf('*Branch*: {code}ai/gh-1308{code}\n') !== -1);
        assert.ok(out.indexOf('{panel:bgColor=#FFEBE6|borderColor=#DE350B}' +
            '⚠️ *Merge conflicts detected* — 2 file(s) must be resolved before rework can be applied:\n' +
            '* {code}src/a.dart{code}\n* {code}src/b.dart{code}') !== -1, 'conflict panel lists every file');
        assert.ok(out.indexOf('⚠️ *CI checks failing* — 2 check(s) must pass before merge:\n' +
            '* {code}build{code}\n* {code}test{code}\n' +
            'Error logs: {code}ci_failures.md{code} (summary) and {code}ci_failures_full.log{code} (full logs).') !== -1,
            'CI panel lists every failing check');
        assert.ok(out.indexOf('_Fix results will be posted shortly..._') !== -1);
    });

    test('markdown flavor renders GitHub-safe markup — no wiki constructs survive', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('markdown'), FULL_CTX);
        assert.ok(out.indexOf('### 🔧 Automated Rework Started\n') === 0, 'starts with a markdown heading');
        assert.ok(out.indexOf('**Pull Request**: [PR #1308](https://github.com/acme/widgets/pull/1308)\n') !== -1);
        assert.ok(out.indexOf('**Branch**') !== -1);
        assert.ok(out.indexOf('**Merge conflicts detected**') !== -1);
        assert.ok(out.indexOf('**CI checks failing**') !== -1);
        assert.ok(out.indexOf('> ') !== -1, 'panel bodies are quoted');
        assert.equal(out.indexOf('h3.'), -1, 'no wiki heading');
        assert.equal(out.indexOf('{panel'), -1, 'no wiki panel');
        assert.equal(out.indexOf('{code'), -1, 'no wiki code tag');
        assert.equal(out.indexOf('[PR #1308|'), -1, 'no wiki link');
    });

    test('markdown flavor (ADO/GitHub): bullets and the log names are single-line code spans, never fenced blocks (agents#882)', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('markdown'), FULL_CTX);
        assert.contains(out, '> * `build`\n> * `test`');
        assert.contains(out, 'Error logs: `ci_failures.md` (summary) and `ci_failures_full.log` (full logs).');
        assert.contains(out, '> * `src/a.dart`');
        assert.equal(out.indexOf('```'), -1, 'no fenced block anywhere in this comment: ' + out);
    });

    test('markdown flavor: the quoted panel keeps one line per bullet (no orphan "> ```" lines)', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('markdown'), FULL_CTX);
        out.split('\n').forEach(function(line) {
            assert.ok(line.indexOf('> ```') === -1, 'broken quote line: ' + line);
        });
    });

    test('clean run: no conflict/CI panels are emitted', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('jira'), {
            prNumber: 1, prUrl: 'https://x/1', branchName: 'b'
        });
        assert.equal(out.indexOf('{panel'), -1);
        assert.ok(out.indexOf('AI Teammate is fixing issues raised in the code review.') !== -1);
    });

});

// ── gh-1002: shared harness for the characterization + helper suites ─────────

// default-without-a-branch helper: keeps makeActionHarness() branch-free so the
// harness itself stays under the CRAP threshold in the coverage report.
function def1002(value, fallback) {
    return value === undefined ? fallback : value;
}

// Failure-mode switch for the harness: throws when the overrides bag enables
// the named failure. A function call instead of an inline `if` so the harness
// body carries no extra branches.
function fail1002(overides, key, message) {
    if (overides[key]) {
        throw new Error(message);
    }
}

var DEFAULT_REWORK_STATUSES = { IN_DEVELOPMENT: 'In Development', IN_REWORK: 'In Rework' };

// File-level so the closure adds no branches to makeActionHarness() itself.
function resolveStatusesMock(customParams, jiraStatuses) {
    return jiraStatuses || DEFAULT_REWORK_STATUSES;
}

// gh-1002: console output of the SUT is captured by injecting a recorder as a
// `console` mock in the loadModule mocks bag (the repo-standard pattern, cf.
// test_reviewVerdicts.js) — never by touching `global`, which does not exist in
// the GraalJS host the canonical testRunner.js runs in.

/**
 * Full-action harness for the gh-1002 suites: loads js/preCliReworkSetup.js with
 * a complete set of spying mocks (tracker, gh, gitOps, scm, setupCommands) and an
 * overrides bag that flips each failure mode on.
 *
 * @returns {{module: object, calls: object, files: object, tracker: object}}
 */
function makeActionHarness(overides) {
    overides = overides || {};

    var files = {}; // file_write captures: path → content
    var calls = {   // spy registry shared across the host-tool mocks
        postComment: [],      // [{key, body}]
        moveToStatus: [],     // [status]
        findPRForTicket: 0,
        findPRForTicketArg: null,
        getPRDetailsNumber: null,
        getRemoteRepoInfo: 0,
        checkoutPRBranch: [], // [{branch, dir, base}]
        createTracker: 0,
        runSetupCommands: 0,
        writeBaseBranchMarker: null,
        writePRContext: null
    };

    var tracker = {
        postComment: function(key, body) {
            calls.postComment.push({ key: key, body: body });
            fail1002(overides, 'failTrackerPostComment', 'postComment failed');
        },
        moveToStatus: function(key, status) {
            calls.moveToStatus.push(status);
            fail1002(overides, 'failMoveToStatus', 'transition failed');
        }
    };

    var ghStub = makeGhStub();
    ghStub.findPRForTicket = function(scm, ticketKey, options) {
        calls.findPRForTicket++;
        calls.findPRForTicketArg = { scm: scm, ticketKey: ticketKey, options: options };
        return def1002(overides.pr, { number: 7, url: 'https://github.com/acme/widgets/pull/7' });
    };
    ghStub.getPRDetails = function(scm, number) {
        calls.getPRDetailsNumber = number;
        return def1002(overides.prDetails, {
            number: number, title: 't', html_url: 'https://github.com/acme/widgets/pull/' + number,
            state: 'open', head: { ref: 'ai/gh-123', sha: 'sha-123' }, base: { ref: 'master' }, user: { login: 'a' }
        });
    };
    ghStub.detectFailedChecks = function(scm, headSha, inputFolder, jenkinsBasePath, diff) {
        calls.detectFailedChecksArg = { headSha: headSha, inputFolder: inputFolder, jenkinsBasePath: jenkinsBasePath, diff: diff };
        return def1002(overides.failedChecks, []);
    };
    ghStub.fetchDiscussionsAndRawData = function() {
        return def1002(overides.discussionData, { markdown: '## d', rawThreads: null });
    };

    var scm = {
        getRemoteRepoInfo: function() {
            calls.getRemoteRepoInfo++;
            return def1002(overides.repoInfo, { owner: 'acme', repo: 'widgets' });
        }
    };

    var gitOpsStub = {
        checkoutPRBranch: function(branch, dir, base) {
            calls.checkoutPRBranch.push({ branch: branch, dir: dir, base: base });
            fail1002(overides, 'failCheckout', 'checkout failed');
        },
        detectMergeConflicts: function(baseBranch, inputFolder, workingDir) {
            calls.detectMergeConflictsArg = { baseBranch: baseBranch, inputFolder: inputFolder, workingDir: workingDir };
            return def1002(overides.conflictFiles, []);
        },
        getPRDiff: function() { return 'diff --git a/README.md b/README.md'; },
        writePRContext: function(inputFolder, prDetails, diff, markdown, rawThreads) {
            calls.writePRContext = { inputFolder: inputFolder, prNumber: prDetails.number, diff: diff, markdown: markdown, rawThreads: rawThreads };
        },
        writeInputFile: function(path, content) {
            if (overides.failWriteInputFile) { throw new Error('input write failed'); }
            files[path] = content;
        }
    };

    var config = {
        git: { baseBranch: 'master' },
        workingDir: null,
        repository: overides.repository,
        jira: overides.jira
    };

    var configLoaderStub = {
        loadProjectConfig: function() {
            fail1002(overides, 'failConfigLoad', 'config load failed');
            return config;
        },
        paramsForConfigLoad: function(p) { return p; },
        loadHookFn: function() { return null; },
        createScm: function() { return scm; }
    };

    var trackersModuleStub = {
        createTracker: function() {
            calls.createTracker++;
            fail1002(overides, 'failTrackerCreate', 'tracker create failed');
            return tracker;
        }
    };

    // Real module shape (the target binds truncateSetupError at load time), but
    // with spying/stubbed behaviour so no real setup commands ever run.
    var setupCommandsStub = {
        truncateSetupError: function(s) { return s; },
        runSetupCommands: function() {
            calls.runSetupCommands++;
            fail1002(overides, 'failSetupCommands', 'npm ci exploded');
            return { ok: true };
        },
        buildSetupWarningsMarkdown: function() {
            return def1002(overides.setupWarnings, '');
        }
    };

    var logs = { log: [], warn: [], error: [] };
    var consoleRecorder = {
        log: function() { logs.log.push(Array.prototype.join.call(arguments, ' ')); },
        warn: function() { logs.warn.push(Array.prototype.join.call(arguments, ' ')); },
        error: function() { logs.error.push(Array.prototype.join.call(arguments, ' ')); }
    };

    var mod = loadModule(
        'js/preCliReworkSetup.js',
        makeRequire({
            './configLoader.js': configLoaderStub,
            './common/githubHelpers.js': ghStub,
            './forkCheckout.js': forkCheckoutModule,
            './common/gitOps.js': gitOpsStub,
            './common/commentMarkup.js': reworkCommentMarkupModule,
            './fetchQuestionsToInput.js': NOOP_MODULE,
            './fetchParentContextToInput.js': NOOP_MODULE,
            './restoreFromReleases.js': NOOP_MODULE,
            './common/trackers.js': trackersModuleStub,
            './common/setupCommands.js': setupCommandsStub,
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function(base) { calls.writeBaseBranchMarker = base; } },
            './config.js': { resolveStatuses: resolveStatusesMock }
        }),
        {
            console: consoleRecorder,
            file_write: function(args) {
                var failPaths = def1002(overides.failFileWritePaths, []);
                if (failPaths.indexOf(args.path) !== -1) {
                    throw new Error('disk full');
                }
                files[args.path] = args.content;
            }
        }
    );

    return { module: mod, calls: calls, files: files, tracker: tracker, logs: logs };
}

// ── gh-799 AC1: pinned input trio, armer-independent ─────────────────────────
// Whatever arms the rework leg (fail-validation CI-red, review-threads-resolved
// armer, conflict-rework, manual dispatch), the input folder must ALWAYS carry:
//   - pr_discussions_raw.json — unresolved threads WITH ids (placeholder {"threads": []}
//     when the PR currently has zero threads),
//   - ci_failures.md — the failed checks (explicit "nothing failed" contract file
//     when every check is green or the probe failed),
//   - review_state.md — the review verdict(s) + decision state
//     (CHANGES_REQUESTED / APPROVED / NONE).
// Today the first two "happen to be fetched"; this suite pins the trio so an
// armer path that skips one is a regression.

function makeContractHarness(opts) {
    opts = opts || {};
    var writes = [];
    var files = opts.files || {};
    var gitOpsStub = {
        writeInputFile: function(path, content, label) {
            writes.push({ path: path, content: content, label: label });
            files[path] = content;
        },
        // The rest of action()'s usage is stubbed per test.
        checkoutPRBranch: function() {},
        detectMergeConflicts: function() { return []; },
        getPRDiff: function() { return ''; },
        writePRContext: function() {}
    };
    var mocks = {
        file_write: function(args) { writes.push({ path: args.path, content: args.content }); return null; },
        file_read: function(args) {
            var p = args && (args.path || args);
            if (files[p] !== undefined) return files[p];
            throw new Error('File does not exist: ' + p);
        },
        cli_execute_command: function() { return ''; }
    };
    var mod = loadModule(
        'js/preCliReworkSetup.js',
        makeRequire({
            './configLoader.js': { loadHookFn: function() { return null; } },
            './common/githubHelpers.js': makeGhStub(),
            './forkCheckout.js': forkCheckoutModule,
            './common/gitOps.js': gitOpsStub,
            './common/commentMarkup.js': reworkCommentMarkupModule,
            './fetchQuestionsToInput.js': NOOP_MODULE,
            './fetchParentContextToInput.js': NOOP_MODULE,
            './restoreFromReleases.js': NOOP_MODULE,
            './common/trackers.js': { createTracker: function() { return {}; } },
            './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
            './config.js': { resolveStatuses: function() { return {}; } }
        }),
        mocks
    );
    return { mod: mod, writes: writes, files: files };
}

function contractThreads(ids) {
    return { rawThreads: { threads: (ids || []).map(function(id) {
        return { threadId: id, rootCommentId: 1, resolved: false, path: 'src/a.dart', line: 3, body: 'Fix this (' + id + ')' };
    }) } };
}

suite('preCliReworkSetup.ensureInputContextContract — pinned input trio (gh-799 AC1)', function() {

    test('CI-red armer fixture: threads + failures fetched → only review_state.md is added', function() {
        var h = makeContractHarness();
        var written = h.mod.ensureInputContextContract('input/PROJ-123', null, 7,
            contractThreads(['PRRT_a', 'PRRT_b']), [{ name: 'build', conclusion: 'failure' }]);

        assert.deepEqual(written, ['review_state.md'],
            'the two fetched halves are already written by writePRContext/detectFailedChecks — no double write');
        assert.ok(h.files['input/PROJ-123/review_state.md'], 'review_state.md always written');
    });

    test('manual-dispatch fixture: zero threads, zero failures → non-empty placeholders for all three', function() {
        var h = makeContractHarness();
        var written = h.mod.ensureInputContextContract('input/PROJ-123', null, 7, {}, []);

        written.sort();
        assert.deepEqual(written, ['ci_failures.md', 'pr_discussions_raw.json', 'review_state.md'],
            'an armer that skips a file is a regression — the trio is pinned');

        var raw = JSON.parse(h.files['input/PROJ-123/pr_discussions_raw.json']);
        assert.ok(raw && Array.isArray(raw.threads) && raw.threads.length === 0,
            'zero threads still ships the raw file in the documented shape');

        var ci = h.files['input/PROJ-123/ci_failures.md'];
        assert.ok(ci && ci.trim().length > 0, 'ci_failures.md present and non-empty even when green');
        assert.contains(ci, 'No Failed');

        var rs = h.files['input/PROJ-123/review_state.md'];
        assert.ok(rs && rs.trim().length > 0, 'review_state.md present and non-empty');
        assert.contains(rs, 'NONE', 'no concluded review → decision NONE');
    });

    test('review_state.md carries the latest concluded verdict and reviewer', function() {
        var h = makeContractHarness();
        var scm = { listReviews: function() {
            return [
                { state: 'APPROVED', user: { login: 'reviewer1' }, submitted_at: '2026-10-08T18:00:00Z', body: 'LGTM' },
                { state: 'CHANGES_REQUESTED', user: { login: 'reviewer2' }, submitted_at: '2026-10-08T18:56:00Z', body: 'Please fix the null deref\nand the typo' }
            ];
        } };
        h.mod.ensureInputContextContract('input/PROJ-123', scm, 7, contractThreads(['PRRT_a']), []);

        var rs = h.files['input/PROJ-123/review_state.md'];
        assert.contains(rs, 'CHANGES_REQUESTED', 'latest concluded verdict by submitted_at wins');
        assert.contains(rs, 'reviewer2');
        assert.contains(rs, 'Please fix the null deref', 'review summary visible so the agent sees WHAT was asked');
        assert.contains(rs, 'PRRT_a', 'open thread inventory with ids');
        assert.contains(rs, 'blocking', 'CHANGES_REQUESTED is flagged as blocking');
    });

    test('review_state.md decision APPROVED when the last verdict approves', function() {
        var h = makeContractHarness();
        var scm = { listReviews: function() {
            return [{ state: 'CHANGES_REQUESTED', user: { login: 'r1' }, submitted_at: '2026-10-08T10:00:00Z', body: 'fix' },
                    { state: 'APPROVED', user: { login: 'r1' }, submitted_at: '2026-10-08T12:00:00Z', body: 'LGTM' }];
        } };
        h.mod.ensureInputContextContract('input/PROJ-123', scm, 7, {}, []);
        var rs = h.files['input/PROJ-123/review_state.md'];
        assert.contains(rs, 'APPROVED');
        assert.notContains(rs, 'requires changes', 'no blocking banner for an approved PR');
    });

    test('review_state.md reviewer name resolves across export shapes (user.login / author.login / author.name / unnamed)', function() {
        var h = makeContractHarness();
        var scm = { listReviews: function() {
            return [
                { state: 'APPROVED', author: { login: 'ado-login' }, submitted_at: '2026-10-08T10:00:00Z', body: 'ok' },
                { state: 'CHANGES_REQUESTED', author: { name: 'Ado Name' }, submitted_at: '2026-10-08T11:00:00Z', body: 'change' },
                { state: 'APPROVED', submitted_at: '2026-10-08T12:00:00Z', body: 'fine' },
                { state: 'CHANGES_REQUESTED', user: { login: 'gh-reviewer' }, submitted_at: '2026-10-08T13:00:00Z', body: 'final' }
            ];
        } };
        h.mod.ensureInputContextContract('input/PROJ-123', scm, 7, {}, []);
        var rs = h.files['input/PROJ-123/review_state.md'];
        assert.contains(rs, 'gh-reviewer', 'user.login wins when present');
        var h2 = makeContractHarness();
        var scm2 = { listReviews: function() {
            return [{ state: 'APPROVED', author: { login: 'ado-login' }, submitted_at: '2026-10-08T10:00:00Z', body: 'ok' }];
        } };
        h2.mod.ensureInputContextContract('input/PROJ-123', scm2, 7, {}, []);
        assert.contains(h2.files['input/PROJ-123/review_state.md'], 'ado-login', 'author.login fallback');
        var h3 = makeContractHarness();
        var scm3 = { listReviews: function() {
            return [{ state: 'APPROVED', author: { name: 'Ado Name' }, submitted_at: '2026-10-08T10:00:00Z', body: 'ok' }];
        } };
        h3.mod.ensureInputContextContract('input/PROJ-123', scm3, 7, {}, []);
        assert.contains(h3.files['input/PROJ-123/review_state.md'], 'Ado Name', 'author.name fallback');
        var h4 = makeContractHarness();
        var scm4 = { listReviews: function() {
            return [{ state: 'APPROVED', submitted_at: '2026-10-08T10:00:00Z', body: 'ok' }];
        } };
        h4.mod.ensureInputContextContract('input/PROJ-123', scm4, 7, {}, []);
        assert.contains(h4.files['input/PROJ-123/review_state.md'], 'unknown', 'unnamed reviewer degrades honestly');
    });

    test('SCM provider without listReviews → review_state.md still written (non-empty, verdict unavailable)', function() {
        var h = makeContractHarness();
        var written = h.mod.ensureInputContextContract('input/PROJ-123', { /* no listReviews */ }, 7, {}, []);
        assert.contains(written.join(','), 'review_state.md');
        var rs = h.files['input/PROJ-123/review_state.md'];
        assert.ok(rs && rs.trim().length > 0);
        assert.contains(rs, 'not available');
    });

    test('listReviews probe failure is non-fatal and still writes review_state.md', function() {
        var h = makeContractHarness();
        var scm = { listReviews: function() { throw new Error('GraphQL down'); } };
        var written = h.mod.ensureInputContextContract('input/PROJ-123', scm, 7, {}, []);
        assert.contains(written.join(','), 'review_state.md');
        assert.ok(h.files['input/PROJ-123/review_state.md'].trim().length > 0);
    });

    test('existing contract files are never overwritten with placeholders', function() {
        var h = makeContractHarness({
            files: {
                'input/PROJ-123/ci_failures.md': '# ⚠️ Failed CI Checks — Fix Before Completing Rework\n\nREAL FAILURE LOG',
                'input/PROJ-123/pr_discussions_raw.json': '{"threads": [{"threadId": "PRRT_real"}]}'
            }
        });
        var written = h.mod.ensureInputContextContract('input/PROJ-123', null, 7, {}, []);
        assert.notContains(written.join(','), 'ci_failures.md', 'real failure log preserved');
        assert.notContains(written.join(','), 'pr_discussions_raw.json', 'real thread data preserved');
        assert.contains(h.files['input/PROJ-123/ci_failures.md'], 'REAL FAILURE LOG');
    });

    test('action() wires the contract into the rework setup flow', function() {
        var writes = [];
        var cliCalls = [];
        var ghStub = makeGhStub();
        ghStub.findPRForTicket = function() { return { number: 7 }; };
        ghStub.getPRDetails = function() {
            return { number: 7, title: 't', html_url: 'u', state: 'open',
                head: { ref: 'ai/gh-123', sha: 'abc' }, base: { ref: 'master' }, user: { login: 'a' } };
        };
        ghStub.detectFailedChecks = function() { return []; };
        ghStub.fetchDiscussionsAndRawData = function() { return { markdown: '## d', rawThreads: null }; };

        var mod = loadModule(
            'js/preCliReworkSetup.js',
            makeRequire({
                './configLoader.js': {
                    loadProjectConfig: function() { return { git: { baseBranch: 'master' }, workingDir: null, repository: { owner: 'acme', repo: 'widgets' } }; },
                    paramsForConfigLoad: function(p) { return p; },
                    loadHookFn: function() { return null; },
                    createScm: function() { return { getRemoteRepoInfo: function() { return { owner: 'acme', repo: 'widgets' }; } }; }
                },
                './common/githubHelpers.js': ghStub,
                './forkCheckout.js': forkCheckoutModule,
                './common/gitOps.js': {
                    checkoutPRBranch: function() {},
                    detectMergeConflicts: function() { return []; },
                    getPRDiff: function() { return ''; },
                    writePRContext: function() {},
                    writeInputFile: function(path, content, label) { writes.push({ path: path, content: content }); }
                },
                './common/commentMarkup.js': reworkCommentMarkupModule,
                './fetchQuestionsToInput.js': NOOP_MODULE,
                './fetchParentContextToInput.js': NOOP_MODULE,
                './restoreFromReleases.js': NOOP_MODULE,
                './common/trackers.js': { createTracker: function() {
                    return { postComment: function() {}, moveToStatus: function() {} };
                } },
                './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
                './config.js': { resolveStatuses: function() { return { IN_DEVELOPMENT: 'In Development' }; } }
            }),
            {
                file_write: function(args) { writes.push(args); },
                file_read: function() { throw new Error('File does not exist'); },
                cli_execute_command: function(args) { cliCalls.push(args.command); return ''; }
            }
        );

        var result = mod.action({
            inputFolderPath: 'input/PROJ-123',
            jobParams: { inputFolderPath: 'input/PROJ-123', customParams: {} }
        });

        assert.equal(result.success, true, 'action succeeded — got: ' + JSON.stringify(result));
        var contractPaths = writes.map(function(w) { return w.path; });
        assert.ok(contractPaths.indexOf('input/PROJ-123/review_state.md') !== -1,
            'review_state.md written by the real action flow, got: ' + JSON.stringify(contractPaths));
        assert.ok(contractPaths.indexOf('input/PROJ-123/pr_discussions_raw.json') !== -1,
            'pr_discussions_raw.json placeholder written (fetch returned rawThreads: null)');
        assert.ok(contractPaths.indexOf('input/PROJ-123/ci_failures.md') !== -1,
            'ci_failures.md placeholder written (no failed checks)');
    });
});

// ── gh-802 AC3b: the issue status write reflects the ACTUAL transition ───────
// A rework leg used to write statuses.IN_DEVELOPMENT — the stale dev-phase
// status — so the board showed the card back "In Development" while rework
// (post-review fixes) was actually running. The write must be the real
// rework phase: statuses.IN_REWORK.

suite('preCliReworkSetup.action — rework status write reflects the actual transition (gh-802 AC3b)', function() {

    test('markReworkInDevelopment writes IN_REWORK (the real phase), never the stale In Development', function() {
        var moves = [];
        var writes = [];
        var ghStub = makeGhStub();
        ghStub.findPRForTicket = function() { return { number: 7 }; };
        ghStub.getPRDetails = function() {
            return { number: 7, title: 't', html_url: 'u', state: 'open',
                head: { ref: 'ai/gh-123', sha: 'abc' }, base: { ref: 'master' }, user: { login: 'a' } };
        };
        ghStub.detectFailedChecks = function() { return []; };
        ghStub.fetchDiscussionsAndRawData = function() { return { markdown: '## d', rawThreads: null }; };

        var mod = loadModule(
            'js/preCliReworkSetup.js',
            makeRequire({
                './configLoader.js': {
                    loadProjectConfig: function() {
                        return {
                            git: { baseBranch: 'master' }, workingDir: null,
                            repository: { owner: 'acme', repo: 'widgets' },
                            jira: { markReworkInDevelopment: true }
                        };
                    },
                    paramsForConfigLoad: function(p) { return p; },
                    loadHookFn: function() { return null; },
                    createScm: function() { return { getRemoteRepoInfo: function() { return { owner: 'acme', repo: 'widgets' }; } }; }
                },
                './common/githubHelpers.js': ghStub,
                './forkCheckout.js': forkCheckoutModule,
                './common/gitOps.js': {
                    checkoutPRBranch: function() {},
                    detectMergeConflicts: function() { return []; },
                    getPRDiff: function() { return ''; },
                    writePRContext: function() {},
                    writeInputFile: function(path, content, label) { writes.push({ path: path, content: content }); }
                },
                './common/commentMarkup.js': reworkCommentMarkupModule,
                './fetchQuestionsToInput.js': NOOP_MODULE,
                './fetchParentContextToInput.js': NOOP_MODULE,
                './restoreFromReleases.js': NOOP_MODULE,
                './common/trackers.js': { createTracker: function() {
                    return {
                        postComment: function() {},
                        moveToStatus: function(key, status) { moves.push(status); }
                    };
                } },
                './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
                './config.js': { resolveStatuses: function() {
                    return { IN_DEVELOPMENT: 'In Development', IN_REWORK: 'In Rework' };
                } }
            }),
            {
                file_write: function(args) { writes.push(args); },
                file_read: function() { throw new Error('File does not exist'); },
                cli_execute_command: function() { return ''; }
            }
        );

        var result = mod.action({
            inputFolderPath: 'input/PROJ-123',
            jobParams: { inputFolderPath: 'input/PROJ-123', customParams: {} }
        });

        assert.equal(result.success, true, 'action succeeded — got: ' + JSON.stringify(result));
        assert.deepEqual(moves, ['In Rework'],
            'the rework setup writes the ACTUAL rework transition, got: ' + JSON.stringify(moves));
    });

    test('gh-802 rework: a failed status transition is logged WITH its content, not swallowed as {}', function() {
        // Same log-hygiene rule as AC3c: the host console renders a raw Error
        // object as "{}", so the warn line must carry the message STRING.
        // Capture RAW args — do not stringify — to reproduce the host behavior.
        var warnArgs = [];
        var origWarn = console.warn;
        console.warn = function() {
            warnArgs.push(Array.prototype.slice.call(arguments));
        };
        try {
            var writes = [];
            var ghStub = makeGhStub();
            ghStub.findPRForTicket = function() { return { number: 7 }; };
            ghStub.getPRDetails = function() {
                return { number: 7, title: 't', html_url: 'u', state: 'open',
                    head: { ref: 'ai/gh-123', sha: 'abc' }, base: { ref: 'master' }, user: { login: 'a' } };
            };
            ghStub.detectFailedChecks = function() { return []; };
            ghStub.fetchDiscussionsAndRawData = function() { return { markdown: '## d', rawThreads: null }; };

            var mod = loadModule(
                'js/preCliReworkSetup.js',
                makeRequire({
                    './configLoader.js': {
                        loadProjectConfig: function() {
                            return {
                                git: { baseBranch: 'master' }, workingDir: null,
                                repository: { owner: 'acme', repo: 'widgets' },
                                jira: { markReworkInDevelopment: true }
                            };
                        },
                        paramsForConfigLoad: function(p) { return p; },
                        loadHookFn: function() { return null; },
                        createScm: function() { return { getRemoteRepoInfo: function() { return { owner: 'acme', repo: 'widgets' }; } }; }
                    },
                    './common/githubHelpers.js': ghStub,
                    './forkCheckout.js': forkCheckoutModule,
                    './common/gitOps.js': {
                        checkoutPRBranch: function() {},
                        detectMergeConflicts: function() { return []; },
                        getPRDiff: function() { return ''; },
                        writePRContext: function() {},
                        writeInputFile: function(path, content, label) { writes.push({ path: path, content: content }); }
                    },
                    './common/commentMarkup.js': reworkCommentMarkupModule,
                    './fetchQuestionsToInput.js': NOOP_MODULE,
                    './fetchParentContextToInput.js': NOOP_MODULE,
                    './restoreFromReleases.js': NOOP_MODULE,
                    './common/trackers.js': { createTracker: function() {
                        return {
                            postComment: function() {},
                            moveToStatus: function() { throw new Error('status In Rework is not valid for this workflow'); }
                        };
                    } },
                    './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
                    './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
                    './config.js': { resolveStatuses: function() {
                        return { IN_DEVELOPMENT: 'In Development', IN_REWORK: 'In Rework' };
                    } }
                }),
                {
                    file_write: function(args) { writes.push(args); },
                    file_read: function() { throw new Error('File does not exist'); },
                    cli_execute_command: function() { return ''; }
                }
            );

            var result = mod.action({
                inputFolderPath: 'input/PROJ-123',
                jobParams: { inputFolderPath: 'input/PROJ-123', customParams: {} }
            });

            assert.equal(result.success, true, 'the failed transition is non-fatal');
        } finally {
            console.warn = origWarn;
        }

        assert.ok(warnArgs.length > 0, 'the failure is still announced');
        var moveFailureEntries = warnArgs.filter(function(args) {
            return args.some(function(a) {
                return typeof a === 'string' && a.indexOf('Failed to move ticket to') !== -1;
            });
        });
        assert.ok(moveFailureEntries.length > 0, 'the transition failure is announced');
        var hasContentString = moveFailureEntries.some(function(args) {
            return args.some(function(a) {
                return typeof a === 'string' && a.indexOf('status In Rework is not valid for this workflow') !== -1;
            });
        });
        assert.ok(hasContentString,
            'a string carrying the error content must reach the log (a raw Error renders as {} on the host console), got: ' +
            JSON.stringify(moveFailureEntries));
        var passesRawObject = moveFailureEntries.some(function(args) {
            return args.some(function(a) { return a !== null && typeof a === 'object'; });
        });
        assert.ok(!passesRawObject,
            'the raw error object must NOT be passed through on this line (renders as {} on the host console)');
    });
});

// ── gh-1002: characterization of action() — pinned BEFORE the CRAP refactor ──
// The gh-1002 refactor extracts pure helpers out of action() to bring its CRAP
// below the quality-gate threshold. These tests pin action()'s observable
// behaviour (results, files, comments, calls) so the extraction provably
// preserves it. They must stay green across the refactor.

suite('preCliReworkSetup.action — gh-1002 characterization (pinned before the CRAP refactor)', function() {

    test('happy path: success result carries owner/repo from the remote; head SHA persisted; rework-started comment posted', function() {
        var h = makeActionHarness({});
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123', jobParams: { inputFolderPath: 'input/PROJ-123', customParams: {} } });

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.prNumber, 7);
        assert.equal(result.branchName, 'ai/gh-123');
        assert.equal(result.owner, 'acme');
        assert.equal(result.repo, 'widgets');
        assert.equal(h.calls.findPRForTicket, 1);
        assert.deepEqual(h.calls.checkoutPRBranch, [{ branch: 'ai/gh-123', dir: null, base: 'master' }]);
        assert.equal(h.calls.writeBaseBranchMarker, 'master');
        assert.equal(h.files['input/PROJ-123/rework_base_head.txt'], 'sha-123');
        assert.equal(h.calls.postComment.length, 1);
        assert.contains(h.calls.postComment[0].body, 'Automated Rework Started');
    });

    test('a pinned targetRepository in the config wins over the git remote', function() {
        var h = makeActionHarness({ repository: { owner: 'cfg', repo: 'proj' } });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.owner, 'cfg');
        assert.equal(result.repo, 'proj');
        assert.equal(h.calls.getRemoteRepoInfo, 0, 'the remote is never probed when the config pins the repo');
    });

    test('no repo info → {success:false} with the repo-resolution error and one error comment (no failSetup marker)', function() {
        var h = makeActionHarness({ repoInfo: null });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, false);
        assert.equal(result.error, 'Could not determine GitHub repository from git remote');
        assert.equal(h.calls.postComment.length, 1);
        assert.contains(h.calls.postComment[0].body, 'Could not determine GitHub repository');
        assert.equal(h.files['input/PROJ-123/rework_setup_failed.md'], undefined, 'this path returns before failSetup exists');
    });

    test('no PR for the ticket → failSetup marker file + failSetup comment + catch-block error comment + {success:false}', function() {
        var h = makeActionHarness({ pr: null });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });
        var message = 'No Pull Request found for ticket PROJ-123. Cannot start rework without an existing PR.';

        assert.equal(result.success, false);
        assert.contains(result.error, 'No Pull Request found for ticket PROJ-123');
        assert.contains(h.files['input/PROJ-123/rework_setup_failed.md'], message);
        assert.contains(h.files['input/PROJ-123/rework_setup_failed.md'], '# Rework Setup Failed');
        assert.equal(h.calls.postComment.length, 2);
        assert.contains(h.calls.postComment[1].body, '❌ Rework Setup Error');
        assert.contains(h.calls.postComment[1].body, 'No Pull Request found for ticket PROJ-123');
    });

    test('PR details unavailable → {success:false}', function() {
        var h = makeActionHarness({ prDetails: null });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, false);
        assert.contains(result.error, 'Failed to fetch PR details for PR #7');
        assert.contains(h.files['input/PROJ-123/rework_setup_failed.md'], 'Failed to fetch PR details for PR #7');
    });

    test('PR without a head branch → {success:false}', function() {
        var h = makeActionHarness({ prDetails: { number: 7, html_url: 'u', base: { ref: 'master' } } });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, false);
        assert.contains(result.error, 'Could not determine branch from PR details');
        assert.contains(h.files['input/PROJ-123/rework_setup_failed.md'], 'Could not determine branch from PR details');
    });

    test('checkout failure → {success:false} with the checkout error', function() {
        var h = makeActionHarness({ failCheckout: true });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, false);
        assert.contains(result.error, 'Failed to checkout branch');
        assert.contains(h.files['input/PROJ-123/rework_setup_failed.md'], 'Failed to checkout branch');
        assert.equal(h.calls.postComment.length, 2);
    });

    test('setup commands failure → {success:false}; the marker carries the truncated setup error', function() {
        var h = makeActionHarness({ failSetupCommands: true });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, false);
        assert.contains(result.error, 'Environment setup failed');
        assert.contains(h.files['input/PROJ-123/rework_setup_failed.md'], 'Environment setup failed');
        assert.equal(h.calls.postComment.length, 2);
    });

    test('setup warnings land in setup_warnings.md', function() {
        var h = makeActionHarness({ setupWarnings: '## ⚠️ Setup warnings\n- run pub get\n' });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(h.files['input/PROJ-123/setup_warnings.md'], '## ⚠️ Setup warnings\n- run pub get\n');
    });

    test('a failed setup_warnings.md write is non-fatal', function() {
        var h = makeActionHarness({ setupWarnings: 'warn', failFileWritePaths: ['input/PROJ-123/setup_warnings.md'] });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, true, JSON.stringify(result));
    });

    test('a failed rework_base_head.txt write is non-fatal', function() {
        var h = makeActionHarness({ failFileWritePaths: ['input/PROJ-123/rework_base_head.txt'] });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, true, JSON.stringify(result));
    });

    test('PR-anchored rework (input/pr-42): no ticket PR lookup, no status move, no tracker comment', function() {
        var h = makeActionHarness({ jira: { markReworkInDevelopment: true } });
        var result = h.module.action({ inputFolderPath: 'input/pr-42', jobParams: { inputFolderPath: 'input/pr-42', customParams: {} } });

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.prNumber, 42);
        assert.equal(h.calls.findPRForTicket, 0, 'the PR anchor wins — the ticket lookup is skipped');
        assert.equal(h.calls.getPRDetailsNumber, 42);
        assert.deepEqual(h.calls.moveToStatus, [], 'PR-anchored runs have no ticket to move');
        assert.equal(h.calls.postComment.length, 0, 'PR-anchored runs never comment on a ticket');
    });

    test('jobParams.prNumber anchors the rework for a plain ticket key', function() {
        var h = makeActionHarness({ jira: { markReworkInDevelopment: true } });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123', jobParams: { inputFolderPath: 'input/PROJ-123', prNumber: '9', customParams: {} } });

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.prNumber, 9);
        assert.equal(h.calls.findPRForTicket, 0);
        assert.deepEqual(h.calls.moveToStatus, []);
        assert.equal(h.calls.postComment.length, 0);
    });

    test('jobParams.pr is the fallback anchor when prNumber is absent', function() {
        var h = makeActionHarness({});
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123', jobParams: { inputFolderPath: 'input/PROJ-123', pr: 11, customParams: {} } });

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.prNumber, 11);
        assert.equal(h.calls.findPRForTicket, 0);
    });

    test('a failed rework-started comment is non-fatal (gh-802 pins this behaviour)', function() {
        var h = makeActionHarness({ failTrackerPostComment: true });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(h.calls.postComment.length, 1);
    });

    test('failure before the tracker exists: the error path retries tracker creation and degrades to {success:false} with no comments', function() {
        var h = makeActionHarness({ failTrackerCreate: true });
        var result = h.module.action({ inputFolderPath: 'input/PROJ-123' });

        assert.equal(result.success, false);
        assert.contains(result.error, 'tracker create failed');
        assert.equal(h.calls.createTracker, 2, 'action() and the catch-block error reporter each try once');
        assert.equal(h.calls.postComment.length, 0);
    });

    test('error reporting is a no-op when no ticket key can be derived from the params', function() {
        var h = makeActionHarness({ failConfigLoad: true });
        var result = h.module.action({});

        assert.equal(result.success, false);
        assert.equal(h.calls.createTracker, 0, 'no ticket key → the error reporter never builds a tracker');
    });

});

// ── gh-1002: unit tests for the helpers extracted from action() ──────────────
// Written before the extraction (RED) and kept green by it. Each helper keeps
// the exact behaviour of the code it replaced, so the action-level
// characterization suite above is the primary safety net — these tests pin the
// helpers' own contracts so future refactors cannot drift them.

suite('preCliReworkSetup — extracted helpers (gh-1002)', function() {

    suite('parseReworkParams', function() {
        test('plain ticket folder, no pr params → prAnchor null', function() {
            var h = makeActionHarness({});
            var parsed = h.module.parseReworkParams({ inputFolderPath: 'input/PROJ-123' });

            assert.equal(parsed.ticketKey, 'PROJ-123');
            assert.equal(parsed.inputFolder, 'input/PROJ-123');
            assert.equal(parsed.prAnchor, null);
        });

        test('pr-N folder → numeric anchor', function() {
            var h = makeActionHarness({});
            var parsed = h.module.parseReworkParams({ inputFolderPath: 'input/pr-42' });

            assert.equal(parsed.ticketKey, 'pr-42');
            assert.equal(parsed.prAnchor, 42);
        });

        test('jobParams.prNumber anchors a plain ticket folder; jobParams.pr is the fallback', function() {
            var h = makeActionHarness({});
            var byPrNumber = h.module.parseReworkParams({ inputFolderPath: 'input/PROJ-123', jobParams: { inputFolderPath: 'input/PROJ-123', prNumber: '9' } });
            assert.equal(byPrNumber.prAnchor, 9);

            var byPr = h.module.parseReworkParams({ inputFolderPath: 'input/PROJ-123', jobParams: { inputFolderPath: 'input/PROJ-123', pr: 11 } });
            assert.equal(byPr.prAnchor, 11);
        });

        test('params without inputFolderPath resolve through jobParams', function() {
            var h = makeActionHarness({});
            var parsed = h.module.parseReworkParams({ jobParams: { inputFolderPath: 'input/PROJ-9', prNumber: 5 } });

            assert.equal(parsed.ticketKey, 'PROJ-9');
            assert.equal(parsed.inputFolder, 'input/PROJ-9');
            assert.equal(parsed.prAnchor, 5);
        });

        test('parsePrAnchor resolves the folder anchor before jobParams and null when neither exists', function() {
            var h = makeActionHarness({});
            assert.equal(h.module.parsePrAnchor('pr-42', {}), 42);
            assert.equal(h.module.parsePrAnchor('PROJ-123', { jobParams: { prNumber: '9' } }), 9);
            assert.equal(h.module.parsePrAnchor('PROJ-123', { jobParams: { pr: 11 } }), 11);
            assert.equal(h.module.parsePrAnchor('PROJ-123', {}), null);
        });
    });

    suite('resolveRepoInfo', function() {
        test('a pinned targetRepository in the config wins; the remote is never probed', function() {
            var h = makeActionHarness({ repository: { owner: 'cfg', repo: 'proj' } });
            var repoInfo = h.module.resolveRepoInfo({ repository: { owner: 'cfg', repo: 'proj' } }, {
                getRemoteRepoInfo: function() { throw new Error('must not be called'); }
            });
            assert.deepEqual(repoInfo, { owner: 'cfg', repo: 'proj' });

            assert.equal(h.calls.getRemoteRepoInfo, 0);
            assert.ok(h.logs.log.some(function(l) { return l.indexOf('Using targetRepository from config:') !== -1; }),
                'the config-pinned log line is preserved: ' + JSON.stringify(h.logs.log));
        });

        test('falls back to the git remote when the config does not pin the repo', function() {
            var h = makeActionHarness({});
            var repoInfo = h.module.resolveRepoInfo({ jira: {} }, {
                getRemoteRepoInfo: function() { return { owner: 'acme', repo: 'widgets' }; }
            });

            assert.deepEqual(repoInfo, { owner: 'acme', repo: 'widgets' });
        });
    });

    suite('findPrForRework', function() {
        test('anchor present → PR stub, no ticket lookup', function() {
            var h = makeActionHarness({});
            var pr = h.module.findPrForRework(42, {}, {}, 'PROJ-123');

            assert.deepEqual(pr, { number: 42 });
            assert.equal(h.calls.findPRForTicket, 0);
        });

        test('no anchor → delegates to findPRForTicket with empty options', function() {
            var h = makeActionHarness({ pr: { number: 7 } });
            var pr = h.module.findPrForRework(null, {}, {}, 'PROJ-123');

            assert.equal(pr.number, 7);
            assert.equal(h.calls.findPRForTicket, 1);
            assert.equal(h.calls.findPRForTicketArg.ticketKey, 'PROJ-123');
            assert.deepEqual(h.calls.findPRForTicketArg.options, {});
        });

        test('no anchor → config.prSearchFn is forwarded as the search option', function() {
            var h = makeActionHarness({});
            var fn = function() {};
            h.module.findPrForRework(null, {}, { prSearchFn: fn }, 'PROJ-123');

            assert.deepEqual(h.calls.findPRForTicketArg.options, { prSearchFn: fn });
        });
    });

    suite('moveTicketToReworkStatus', function() {
        test('configured + no anchor → tracker.moveToStatus with the real rework phase', function() {
            var h = makeActionHarness({});
            h.module.moveTicketToReworkStatus({ jira: { markReworkInDevelopment: true } }, h.tracker, 'PROJ-123', { IN_REWORK: 'In Rework' }, null);

            assert.deepEqual(h.calls.moveToStatus, ['In Rework']);
        });

        test('skipped for PR-anchored runs even when configured', function() {
            var h = makeActionHarness({});
            h.module.moveTicketToReworkStatus({ jira: { markReworkInDevelopment: true } }, h.tracker, 'pr-42', { IN_REWORK: 'In Rework' }, 42);

            assert.deepEqual(h.calls.moveToStatus, []);
        });

        test('skipped when the config does not enable it', function() {
            var h = makeActionHarness({});
            h.module.moveTicketToReworkStatus({}, h.tracker, 'PROJ-123', { IN_REWORK: 'In Rework' }, null);

            assert.deepEqual(h.calls.moveToStatus, []);
        });

        test('a failing transition is logged with its content, not thrown', function() {
            var h = makeActionHarness({ failMoveToStatus: true });
            assert.doesNotThrow(function() {
                h.module.moveTicketToReworkStatus({ jira: { markReworkInDevelopment: true } }, h.tracker, 'PROJ-123', { IN_REWORK: 'In Rework' }, null);
            });

            assert.ok(h.logs.warn.some(function(l) { return l.indexOf('Failed to move ticket to In Rework') !== -1; }),
                'the gh-802 log line is preserved: ' + JSON.stringify(h.logs.warn));
        });
    });

    suite('checkoutReworkBranch', function() {
        test('happy path delegates branch, workingDir and baseBranch to gitOps', function() {
            var h = makeActionHarness({});
            h.module.checkoutReworkBranch('ai/gh-123', { workingDir: '/repo', git: { baseBranch: 'main' } }, 'input/PROJ-123', h.tracker, 'PROJ-123', {});

            assert.deepEqual(h.calls.checkoutPRBranch, [{ branch: 'ai/gh-123', dir: '/repo', base: 'main' }]);
            assert.equal(h.files['input/PROJ-123/rework_setup_failed.md'], undefined);
        });

        test('checkout error → failSetup marker + comment, then throws', function() {
            var h = makeActionHarness({ failCheckout: true });
            var err = null;
            try {
                h.module.checkoutReworkBranch('ai/gh-123', { workingDir: '/repo', git: { baseBranch: 'main' } }, 'input/PROJ-123', h.tracker, 'PROJ-123', {});
            } catch (e) { err = e; }

            assert.ok(err, 'checkoutReworkBranch must propagate the failSetup throw');
            assert.contains(String(err), 'Failed to checkout branch');
            assert.contains(h.files['input/PROJ-123/rework_setup_failed.md'], 'Failed to checkout branch');
            assert.equal(h.calls.postComment.length, 1);
        });
    });

    suite('runSetupCommandsStep', function() {
        test('no warnings → no setup_warnings.md write', function() {
            var h = makeActionHarness({});
            h.module.runSetupCommandsStep({}, { workingDir: '/repo' }, 'input/PROJ-123', h.tracker, 'PROJ-123');

            assert.equal(h.calls.runSetupCommands, 1);
            assert.equal(h.files['input/PROJ-123/setup_warnings.md'], undefined);
        });

        test('warnings → setup_warnings.md written', function() {
            var h = makeActionHarness({ setupWarnings: 'w1\nw2\n' });
            h.module.runSetupCommandsStep({}, { workingDir: '/repo' }, 'input/PROJ-123', h.tracker, 'PROJ-123');

            assert.equal(h.files['input/PROJ-123/setup_warnings.md'], 'w1\nw2\n');
        });

        test('warnings write failure → warn logged, not thrown', function() {
            var h = makeActionHarness({ setupWarnings: 'w', failFileWritePaths: ['input/PROJ-123/setup_warnings.md'] });
            assert.doesNotThrow(function() {
                h.module.runSetupCommandsStep({}, { workingDir: '/repo' }, 'input/PROJ-123', h.tracker, 'PROJ-123');
            });

            assert.ok(h.logs.warn.some(function(l) { return l.indexOf('Failed to write setup_warnings.md') !== -1; }),
                JSON.stringify(h.logs.warn));
        });

        test('commands failure → failSetup marker + comment, then throws', function() {
            var h = makeActionHarness({ failSetupCommands: true });
            var err = null;
            try {
                h.module.runSetupCommandsStep({}, { workingDir: '/repo' }, 'input/PROJ-123', h.tracker, 'PROJ-123');
            } catch (e) { err = e; }

            assert.ok(err);
            assert.contains(String(err), 'Environment setup failed');
            assert.contains(h.files['input/PROJ-123/rework_setup_failed.md'], 'Environment setup failed');
            assert.equal(h.calls.postComment.length, 1);
        });
    });

    suite('writeReworkBaseHead', function() {
        test('writes the head SHA as a string', function() {
            var h = makeActionHarness({});
            h.module.writeReworkBaseHead('input/PROJ-123', 'sha-123');

            assert.equal(h.files['input/PROJ-123/rework_base_head.txt'], 'sha-123');
        });

        test('no head SHA → no file', function() {
            var h = makeActionHarness({});
            h.module.writeReworkBaseHead('input/PROJ-123', null);

            assert.equal(h.files['input/PROJ-123/rework_base_head.txt'], undefined);
        });

        test('write failure → warn, not thrown', function() {
            var h = makeActionHarness({ failFileWritePaths: ['input/PROJ-123/rework_base_head.txt'] });
            assert.doesNotThrow(function() { h.module.writeReworkBaseHead('input/PROJ-123', 'sha-123'); });

            assert.ok(h.logs.warn.some(function(l) { return l.indexOf('rework_base_head.txt') !== -1; }), JSON.stringify(h.logs.warn));
        });
    });

    suite('postReworkStartedCommentStep', function() {
        test('posts the rework-started comment through the tracker', function() {
            var h = makeActionHarness({});
            h.module.postReworkStartedCommentStep(h.tracker, 'PROJ-123', {}, {
                prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7', branchName: 'ai/gh-123'
            });

            assert.equal(h.calls.postComment.length, 1);
            assert.contains(h.calls.postComment[0].body, 'Automated Rework Started');
        });

        test('post failure → warn, not thrown', function() {
            var h = makeActionHarness({ failTrackerPostComment: true });
            assert.doesNotThrow(function() {
                h.module.postReworkStartedCommentStep(h.tracker, 'PROJ-123', {}, { prNumber: 7 });
            });

            assert.ok(h.logs.warn.some(function(l) { return l.indexOf('Failed to post tracker comment') !== -1; }), JSON.stringify(h.logs.warn));
        });
    });

    suite('reportActionError', function() {
        test('posts a ❌ Rework Setup Error comment through the provided tracker', function() {
            var h = makeActionHarness({});
            h.module.reportActionError({ inputFolderPath: 'input/PROJ-123' }, h.tracker, new Error('boom'));

            assert.equal(h.calls.postComment.length, 1);
            assert.contains(h.calls.postComment[0].body, '❌ Rework Setup Error');
            assert.contains(h.calls.postComment[0].body, 'boom');
        });

        test('without a tracker it falls back to creating one from the params', function() {
            var h = makeActionHarness({});
            h.module.reportActionError({ inputFolderPath: 'input/PROJ-123', jobParams: { inputFolderPath: 'input/PROJ-123', customParams: {} } }, null, new Error('boom'));

            assert.equal(h.calls.createTracker, 1);
            assert.equal(h.calls.postComment.length, 1);
        });

        test('a failing fallback tracker creation is logged, not thrown', function() {
            var h = makeActionHarness({ failTrackerCreate: true });
            assert.doesNotThrow(function() {
                h.module.reportActionError({ inputFolderPath: 'input/PROJ-123' }, null, new Error('boom'));
            });

            assert.equal(h.calls.postComment.length, 0);
            assert.ok(h.logs.error.some(function(l) { return l.indexOf('Failed to create tracker for error comment') !== -1; }),
                JSON.stringify(h.logs.error));
        });

        test('a failing comment post inside the reporter is contained', function() {
            var h = makeActionHarness({ failTrackerPostComment: true });
            assert.doesNotThrow(function() {
                h.module.reportActionError({ inputFolderPath: 'input/PROJ-123' }, h.tracker, new Error('boom'));
            });

            assert.ok(h.logs.error.some(function(l) { return l.indexOf('Failed to post rework setup error comment') !== -1; }),
                JSON.stringify(h.logs.error));
        });

        test('no derivable ticket key → no tracker, no comment', function() {
            var h = makeActionHarness({});
            h.module.reportActionError({}, null, new Error('boom'));

            assert.equal(h.calls.createTracker, 0);
            assert.equal(h.calls.postComment.length, 0);
        });

        test('errorTicketKeyOf resolves the key from flat params or jobParams, empty when none', function() {
            var h = makeActionHarness({});
            assert.equal(h.module.errorTicketKeyOf({ inputFolderPath: 'input/PROJ-123' }), 'PROJ-123');
            assert.equal(h.module.errorTicketKeyOf({ jobParams: { inputFolderPath: 'input/PROJ-9' } }), 'PROJ-9');
            assert.equal(h.module.errorTicketKeyOf({}), '');
        });
    });

});

// ── gh-1119: the PR diff feeds detectFailedChecks for owned/foreign tagging ──

suite('preCliReworkSetup.action — diff-before-CI-detection (gh-1119 AC7)', function() {

    function makeDiffOrderHarness(overides) {
        var calls = { order: [], detectArgs: null, diff: null };
        var ghStub = makeGhStub();
        ghStub.findPRForTicket = function() { return { number: 7 }; };
        ghStub.getPRDetails = function() {
            return { number: 7, title: 't', html_url: 'u', state: 'open',
                head: { ref: 'ai/gh-123', sha: 'abc' }, base: { ref: 'master' }, user: { login: 'a' } };
        };
        ghStub.detectFailedChecks = function(scm, headSha, inputFolder, jenkinsBasePath, diffText) {
            calls.order.push('detectFailedChecks');
            calls.detectArgs = { scm: scm, headSha: headSha, inputFolder: inputFolder,
                jenkinsBasePath: jenkinsBasePath, diffText: diffText };
            return (overides && overides.failedChecks) || [];
        };
        ghStub.fetchDiscussionsAndRawData = function() { return { markdown: '## d', rawThreads: null }; };

        var diffText = (overides && overides.diff) || 'diff --git a/src/a.dart b/src/a.dart\n';
        var gitOpsStub = {
            checkoutPRBranch: function() {},
            detectMergeConflicts: function() { return []; },
            getPRDiff: function(baseBranch, branchName, workingDir) {
                calls.order.push('getPRDiff');
                calls.diff = { baseBranch: baseBranch, branchName: branchName, workingDir: workingDir };
                return diffText;
            },
            writePRContext: function() {},
            writeInputFile: function() {}
        };

        var mod = loadModule(
            'js/preCliReworkSetup.js',
            makeRequire({
                './configLoader.js': {
                    loadProjectConfig: function() {
                        return {
                            git: { baseBranch: 'master' }, workingDir: null,
                            repository: { owner: 'acme', repo: 'widgets' }
                        };
                    },
                    paramsForConfigLoad: function(p) { return p; },
                    loadHookFn: function() { return null; },
                    createScm: function() { return { getRemoteRepoInfo: function() { return { owner: 'acme', repo: 'widgets' }; } }; }
                },
                './common/githubHelpers.js': ghStub,
                './forkCheckout.js': forkCheckoutModule,
                './common/gitOps.js': gitOpsStub,
                './common/commentMarkup.js': reworkCommentMarkupModule,
                './fetchQuestionsToInput.js': NOOP_MODULE,
                './fetchParentContextToInput.js': NOOP_MODULE,
                './restoreFromReleases.js': NOOP_MODULE,
                './common/trackers.js': { createTracker: function() {
                    return { postComment: function() {}, moveToStatus: function() {} };
                } },
                './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
                './config.js': { resolveStatuses: function() {
                    return { IN_DEVELOPMENT: 'In Development', IN_REWORK: 'In Rework', IN_REVIEW: 'In Review' };
                } }
            }),
            {
                file_write: function() {},
                file_read: function() { throw new Error('File does not exist'); },
                cli_execute_command: function() { return ''; }
            }
        );

        return { mod: mod, calls: calls };
    }

    test('the PR diff is fetched BEFORE CI detection and passed to detectFailedChecks', function() {
        var h = makeDiffOrderHarness({});
        var result = h.mod.action({
            inputFolderPath: 'input/PROJ-123',
            jobParams: { inputFolderPath: 'input/PROJ-123', customParams: {} }
        });
        assert.ok(result.success, 'action succeeded: ' + JSON.stringify(result));
        assert.deepEqual(h.calls.order, ['getPRDiff', 'detectFailedChecks'],
            'getPRDiff must run before detectFailedChecks so ownership tagging has the diff');
        assert.equal(h.calls.detectArgs.diffText, 'diff --git a/src/a.dart b/src/a.dart\n');
        assert.equal(h.calls.detectArgs.headSha, 'abc');
        assert.notOk(h.calls.detectArgs.jenkinsBasePath, 'no Jenkins base configured here');
    });
});

// ── gh-1195 CRAP ratchet: buildReviewStateMd branch characterization ─────────
// Pins the review-probe degradation paths and the CHANGES_REQUESTED warning
// (the branches that were uncovered when buildReviewStateMd sat at CRAP 19.3)
// before the markdown helpers are extracted.
suite('preCliReworkSetup.buildReviewStateMd — probe degradation + verdict warning (gh-1195)', function() {

    function reviewsHarness(listReviews) {
        var h = makeContractHarness();
        var scm = (listReviews === undefined) ? { /* no listReviews at all */ } : {
            listReviews: listReviews
        };
        return { mod: h.mod, scm: scm };
    }

    test('a concluded CHANGES_REQUESTED review adds the blocking warning lines', function() {
        var loaded = reviewsHarness(function() {
            return [{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' },
                submitted_at: '2026-10-08T18:00:00Z', body: 'Please fix the null deref.' }];
        });
        var md = loaded.mod.buildReviewStateMd(loaded.scm, 7, contractThreads(['PRRT_a']));
        assert.contains(md, 'CHANGES_REQUESTED');
        assert.contains(md, '⚠️ The reviewer **requires changes** before this PR can merge — treat every open thread as blocking.');
        assert.contains(md, 'PRRT_a', 'the open thread inventory is still listed');
    });

    test('a probe failure degrades to the honest not-available note (non-fatal)', function() {
        var loaded = reviewsHarness(function() { throw new Error('graphql down'); });
        var md = loaded.mod.buildReviewStateMd(loaded.scm, 7, contractThreads([]));
        assert.contains(md, 'Review verdicts are not available from this SCM provider');
        assert.notContains(md, 'requires changes');
    });

    test('a provider without listReviews support degrades the same way', function() {
        var loaded = reviewsHarness(undefined);
        var md = loaded.mod.buildReviewStateMd(loaded.scm, 7, contractThreads([]));
        assert.contains(md, 'Review verdicts are not available from this SCM provider');
        assert.contains(md, '**Open review threads at rework start: 0**');
    });

    test('an APPROVED verdict never renders the blocking warning', function() {
        var loaded = reviewsHarness(function() {
            return [{ state: 'APPROVED', user: { login: 'reviewer1' },
                submitted_at: '2026-10-08T18:00:00Z', body: 'LGTM' }];
        });
        var md = loaded.mod.buildReviewStateMd(loaded.scm, 7, contractThreads([]));
        assert.contains(md, '**Review decision: `APPROVED`**');
        assert.notContains(md, 'requires changes');
    });

    test('a census that disagrees with the actionable list renders the exclusion note', function() {
        var loaded = reviewsHarness(function() { return []; });
        var md = loaded.mod.buildReviewStateMd(loaded.scm, 7, {
            rawThreads: {
                threads: [{ threadId: 'PRRT_open', resolved: false }],
                census: { graphqlUnresolved: 3 }
            }
        });
        assert.contains(md, '**Open review threads at rework start: 1**');
        assert.contains(md, '3', 'the census delta is stated, never silently dropped');
    });

    test('resolved and bot threads are excluded from the open inventory', function() {
        var loaded = reviewsHarness(function() { return []; });
        var md = loaded.mod.buildReviewStateMd(loaded.scm, 7, {
            rawThreads: {
                threads: [
                    { threadId: 'PRRT_open', resolved: false },
                    { threadId: 'PRRT_done', resolved: true },
                    { threadId: 'PRRT_bot', resolved: false, bot: true },
                    null
                ]
            }
        });
        assert.contains(md, '**Open review threads at rework start: 1**');
        assert.contains(md, 'PRRT_open');
        assert.notContains(md, 'PRRT_done');
        assert.notContains(md, 'PRRT_bot');
    });
});

// ── gh-1195 CRAP split: review-state helper contracts ────────────────────────
suite('preCliReworkSetup — review-state markdown helpers (gh-1195)', function() {

    function harness() {
        return makeContractHarness().mod;
    }

    suite('fetchReviewsForContext', function() {
        test('returns the review list (stringified prNumber), [] normalized from a falsy probe', function() {
            var mod = harness();
            var seen = [];
            var scm = { listReviews: function(prNumber) { seen.push(prNumber); return null; } };
            assert.deepEqual(mod.fetchReviewsForContext(scm, '7'), []);
            assert.deepEqual(seen, ['7'], 'the prNumber is stringified before the probe');
        });

        test('a missing probe or a throwing probe degrade to null (never fatal)', function() {
            var mod = harness();
            assert.equal(mod.fetchReviewsForContext({ /* no listReviews */ }, 7), null);
            assert.equal(mod.fetchReviewsForContext(null, 7), null);
            assert.equal(mod.fetchReviewsForContext({
                listReviews: function() { throw new Error('boom'); }
            }, 7), null);
        });
    });

    suite('discussionThreadsAndCensus', function() {
        test('defaults both halves of a missing payload, keeping them independent', function() {
            var mod = harness();
            assert.deepEqual(mod.discussionThreadsAndCensus(null), { threads: [], census: null });
            assert.deepEqual(mod.discussionThreadsAndCensus({}), { threads: [], census: null });
            assert.deepEqual(mod.discussionThreadsAndCensus({ rawThreads: {} }), { threads: [], census: null });
            var full = mod.discussionThreadsAndCensus({
                rawThreads: { threads: [{ threadId: 'PRRT_a' }], census: { total: 1 } }
            });
            assert.equal(full.threads.length, 1);
            assert.deepEqual(full.census, { total: 1 });
        });
    });

    suite('openThreadsOf', function() {
        test('drops resolved, bot-authored and null entries', function() {
            var mod = harness();
            var open = mod.openThreadsOf([
                { threadId: 'a', resolved: false },
                { threadId: 'b', resolved: true },
                { threadId: 'c', resolved: false, bot: true },
                null,
                { threadId: 'd' }
            ]);
            assert.deepEqual(open.map(function(t) { return t.threadId; }), ['a', 'd']);
            assert.deepEqual(mod.openThreadsOf(null), [], 'a missing list defaults to empty');
        });
    });

    suite('reviewRequiresChanges', function() {
        test('true only for a concluded CHANGES_REQUESTED verdict', function() {
            var mod = harness();
            assert.equal(mod.reviewRequiresChanges([
                { state: 'APPROVED', submitted_at: '2026-10-01T10:00:00Z' },
                { state: 'CHANGES_REQUESTED', submitted_at: '2026-10-08T10:00:00Z' }
            ]), true, 'the latest concluded review decides');
            assert.equal(mod.reviewRequiresChanges([
                { state: 'CHANGES_REQUESTED', submitted_at: '2026-10-01T10:00:00Z' },
                { state: 'APPROVED', submitted_at: '2026-10-08T10:00:00Z' }
            ]), false);
            assert.equal(mod.reviewRequiresChanges([]), false);
            assert.equal(mod.reviewRequiresChanges(null), false, 'no probe → no warning');
        });
    });
});
