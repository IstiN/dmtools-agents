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

    test('clean run: no conflict/CI panels are emitted', function() {
        var out = loadMod().buildReworkStartedComment(reworkCommentMarkup.forFlavor('jira'), {
            prNumber: 1, prUrl: 'https://x/1', branchName: 'b'
        });
        assert.equal(out.indexOf('{panel'), -1);
        assert.ok(out.indexOf('AI Teammate is fixing issues raised in the code review.') !== -1);
    });

});

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
        var hasContentString = warnArgs.some(function(args) {
            return args.some(function(a) {
                return typeof a === 'string' && a.indexOf('status In Rework is not valid for this workflow') !== -1;
            });
        });
        assert.ok(hasContentString,
            'a string carrying the error content must reach the log (a raw Error renders as {} on the host console), got: ' +
            JSON.stringify(warnArgs));
        var passesRawObject = warnArgs.some(function(args) {
            return args.some(function(a) { return a !== null && typeof a === 'object'; });
        });
        assert.ok(!passesRawObject,
            'the raw error object must NOT be passed through (renders as {} on the host console)');
    });
});
