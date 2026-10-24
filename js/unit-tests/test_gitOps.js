/**
 * Unit tests for js/common/gitOps.js — SCM-agnostic git operations shared by
 * GitHub- and GitLab-backed repos (checkoutPRBranch, getPRDiff,
 * detectMergeConflicts, writePRContext). None of these call a github_ or
 * gitlab_ tool — everything goes through cli_execute_command — so a single
 * test suite covers both providers.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

var gitStagingModuleForGitOps = loadModule('js/common/gitStaging.js');
var forkCheckoutModule = loadModule('js/common/forkCheckout.js', makeRequire({ './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {}) }), {});
// Real PR helper (gh-912): the remote-existence probes live there — the
// strict ref-line parser must be exercised, not a stub.
var prHelperRealForGitOps = loadModule('js/common/pullRequest.js',
    makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }));

function loadGitOps(mocks) {
    return loadModule(
        'js/common/gitOps.js',
        makeRequire({
            '../config.js': configModule,
            'config': configModule,
            './gitStaging.js': gitStagingModuleForGitOps,
            './forkCheckout.js': forkCheckoutModule,
            './pullRequest.js': prHelperRealForGitOps
        }),
        mocks || {}
    );
}

suite('gitOps.checkoutPRBranch', function() {
    test('falls back to existing local branch when fetch creates it before failing', function() {
        var commands = [];
        var branchExists = false;
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git branch --list "ai/TS-1268"') {
                    return branchExists ? '  ai/TS-1268\nCOMMAND_EXIT_CODE=0' : '\nCOMMAND_EXIT_CODE=0';
                }
                if (args.command === 'git ls-remote --heads origin ai/TS-1268') {
                    return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/ai/TS-1268\nCOMMAND_EXIT_CODE=0';
                }
                if (args.command === 'git -c fetch.recurseSubmodules=no fetch origin ai/TS-1268:ai/TS-1268') {
                    branchExists = true;
                    throw new Error('fatal: refusing to fetch into branch checked out');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        gitOps.checkoutPRBranch('ai/TS-1268');

        assert.ok(commands.indexOf('git checkout ai/TS-1268') !== -1, 'existing local branch should be checked out');
        assert.equal(commands.indexOf('git checkout -b ai/TS-1268 origin/ai/TS-1268'), -1, 'must not recreate an existing branch');
    });

    test('does not stash when the working tree is already clean', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x');

        assert.equal(commands.filter(function(c) { return c.indexOf('git stash') !== -1; }).length, 0,
            'must not stash a clean tree');
        assert.equal(result.hadConflict, false);
    });

    test('stashes a dirty tree before switching and reapplies it cleanly afterwards', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return ' M .codegraph/codegraph.db\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                if (args.command.indexOf('git check-ignore') === 0) {
                    // gh-1164 probe: factory-kit NOT gitignored (nested repo) →
                    // the exclusion is kept and the add command keeps its classic shape.
                    throw new Error('Command execution failed (exit code 1)');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x');

        var stashIdx = commands.indexOf('git add -A -- ":!factory-kit" ":!factory-kit/**"');
        var pushIdx = commands.indexOf('git stash push -u -m "preflight-checkout-feature/x"');
        var checkoutIdx = commands.indexOf('git checkout feature/x');
        var popIdx = commands.indexOf('git stash pop');

        assert.ok(stashIdx !== -1 && pushIdx !== -1, 'dirty tree should be staged and stashed');
        assert.ok(pushIdx < checkoutIdx, 'stash must happen before checkout');
        assert.ok(checkoutIdx < popIdx, 'stash pop must happen after checkout');
        assert.equal(result.hadConflict, false);
    });

    test('does not throw and reports hadConflict when reapplying the snapshot conflicts', function() {
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                if (args.command === 'git status --porcelain') return ' M src/foo.ts\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git stash pop') {
                    throw new Error('CONFLICT (content): Merge conflict in src/foo.ts');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x');

        assert.equal(result.hadConflict, true, 'conflict during stash pop must be reported, not thrown');
        assert.equal(result.branch, 'feature/x');
    });

    test('self-heals by recreating the ticket branch when still on baseBranch after checkout', function() {
        var commands = [];
        var currentBranch = 'develop';
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                // Local branch already exists — checkout/pull "succeed" per exit code,
                // but (simulating an edge case) HEAD never actually moves off develop.
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git rev-parse --abbrev-ref HEAD') return currentBranch + '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git checkout -B feature/x origin/develop') { currentBranch = 'feature/x'; }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var result = gitOps.checkoutPRBranch('feature/x', null, 'develop');

        assert.ok(commands.indexOf('git checkout -B feature/x origin/develop') !== -1,
            'must self-heal by recreating the branch from origin/baseBranch instead of ever returning while on develop');
        assert.equal(result.branch, 'feature/x');
    });

    test('is a no-op invariant check when baseBranch is not provided', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "feature/x"') return '  feature/x\nCOMMAND_EXIT_CODE=0';
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        gitOps.checkoutPRBranch('feature/x'); // no baseBranch arg

        assert.equal(commands.indexOf('git rev-parse --abbrev-ref HEAD'), -1,
            'invariant check must be skipped entirely when baseBranch is not supplied');
    });

    test('resets local branch to origin after force-push (divergent branches)', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "ai/TS-1268"') return '  ai/TS-1268\nCOMMAND_EXIT_CODE=0';
                // git pull would fail here with divergent branches — reset --hard is used instead
                if (args.command === 'git pull origin ai/TS-1268') {
                    throw new Error('fatal: Need to specify how to reconcile divergent branches.');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        gitOps.checkoutPRBranch('ai/TS-1268');

        assert.ok(commands.indexOf('git checkout ai/TS-1268') !== -1, 'local branch is checked out');
        assert.equal(commands.indexOf('git pull origin ai/TS-1268'), -1, 'git pull must NOT be used (fails on divergent branches)');
        assert.ok(commands.indexOf('git reset --hard origin/ai/TS-1268') !== -1, 'git reset --hard origin/<branch> is used to sync with remote');
        // Fetch must use explicit remote-tracking refspec — a plain '<branch>:<branch>' refspec
        // fails when HEAD is on that branch ("Refusing to fetch into current branch").
        var hasCorrectFetch = commands.some(function(c) {
            return c && c.indexOf('fetch origin') !== -1 && c.indexOf('+refs/heads/ai/TS-1268:refs/remotes/origin/ai/TS-1268') !== -1;
        });
        assert.ok(hasCorrectFetch, 'fetch must use +refs/heads/<b>:refs/remotes/origin/<b> refspec');
    });
});


// ── gh-802 AC3a: log hygiene in detectMergeConflicts ─────────────────────────
// The old code logged "No merge conflicts — base branch changes staged" after
// EVERY clean merge — including an already-up-to-date branch where the merge
// staged nothing. The log must reflect what actually happened.

suite('gitOps.detectMergeConflicts — clean-merge log wording (gh-802 AC3a)', function() {

    function runDetect(quietDiffExit) {
        var logs = [];
        var warns = [];
        var origLog = console.log;
        var origWarn = console.warn;
        console.log = function() {
            logs.push(Array.prototype.slice.call(arguments).join(' '));
        };
        console.warn = function() {
            warns.push(Array.prototype.slice.call(arguments).join(' '));
        };
        try {
            var gitOps = loadGitOps({
                cli_execute_command: function(args) {
                    var c = args.command || '';
                    if (c === 'git rev-parse --is-shallow-repository') return 'false\nCOMMAND_EXIT_CODE=0';
                    if (c === 'git merge origin/main --no-commit --no-ff') return 'Merge cleanup\nCOMMAND_EXIT_CODE=0';
                    if (c === 'git diff --cached --quiet HEAD') {
                        if (quietDiffExit === 0) return 'COMMAND_EXIT_CODE=0';
                        if (quietDiffExit === 'corrupt') throw new Error('fatal: unable to read the index — COMMAND_EXIT_CODE=128');
                        // exit 1 — the expected "staged" signal; the runtime
                        // surfaces exit codes as COMMAND_EXIT_CODE=N in the
                        // thrown message.
                        throw new Error('exit 1 — the merge staged changes\nCOMMAND_EXIT_CODE=1');
                    }
                    return 'COMMAND_EXIT_CODE=0';
                }
            });
            var conflicts = gitOps.detectMergeConflicts('main', 'input/PROJ-123', null);
            return { conflicts: conflicts, logs: logs, warns: warns };
        } finally {
            console.log = origLog;
            console.warn = origWarn;
        }
    }

    test('an up-to-date merge (nothing staged) must NOT claim "base branch changes staged"', function() {
        var fx = runDetect(0);

        assert.deepEqual(fx.conflicts, [], 'clean merge — no conflicts');
        var joined = fx.logs.join('\n');
        assert.ok(joined.indexOf('base branch changes staged') === -1,
            'no false "base branch changes staged" line on an up-to-date merge, got: ' + JSON.stringify(fx.logs));
        assert.ok(joined.indexOf('already up to date') !== -1,
            'the up-to-date case is named explicitly, got: ' + JSON.stringify(fx.logs));
        assert.equal(fx.warns.length, 0, 'the normal exit-0 quiet-diff path is silent — got: ' + JSON.stringify(fx.warns));
    });

    test('a merge that stages base changes keeps the "base branch changes staged" wording', function() {
        var fx = runDetect(1);

        assert.deepEqual(fx.conflicts, [], 'clean merge — no conflicts');
        var joined = fx.logs.join('\n');
        assert.ok(joined.indexOf('No merge conflicts — base branch changes staged') !== -1,
            'staged-changes case keeps the informative wording, got: ' + JSON.stringify(fx.logs));
        // gh-802 rework (thread 4): exit 1 IS the expected "staged" signal —
        // it must not produce an anomaly warning.
        assert.equal(fx.warns.length, 0,
            'exit 1 is the expected staged-changes signal, no warn expected — got: ' + JSON.stringify(fx.warns));
    });

    test('a quiet-diff failure that is NOT exit 1 is flagged as a git error, not silently claimed as "staged"', function() {
        var fx = runDetect('corrupt');

        assert.deepEqual(fx.conflicts, [], 'the detection still completes with the staged assumption');
        var joined = fx.logs.join('\n');
        assert.ok(joined.indexOf('base branch changes staged') !== -1,
            'the conservative "staged" fallback wording is kept, got: ' + JSON.stringify(fx.logs));
        var joinedWarns = fx.warns.join('\n');
        assert.ok(fx.warns.length > 0, 'a non-exit-1 quiet-diff failure is announced');
        assert.ok(joinedWarns.indexOf('unable to read the index') !== -1,
            'the warn carries the failure content, got: ' + JSON.stringify(fx.warns));
    });
});

// ---------------------------------------------------------------------------
// writePRContext — gh-806 AC4: pr_discussions_raw.json entries already
// RESOLVED are filtered before the agent sees them. A rework/review leg that
// reads a stale file must not spend a duplicate reply pass on closed threads.
// ---------------------------------------------------------------------------

suite('gitOps.writePRContext — resolved threads filtered from pr_discussions_raw.json (gh-806 AC4)', function() {

    function prDetailsFixture() {
        return {
            number: 806, html_url: 'https://github.com/o/r/pull/806', title: 't',
            user: { login: 'u' }, head: { ref: 'pr-806' }, base: { ref: 'base' },
            state: 'open'
        };
    }

    function threadsFixture() {
        return { threads: [
            { index: 1, rootCommentId: 1, threadId: 'PRRT_open', resolved: false, body: 'fix this' },
            { index: 2, rootCommentId: 2, threadId: 'PRRT_closed', resolved: true, body: 'already done' },
            { index: 3, rootCommentId: 3, threadId: 'PRRT_open2', resolved: false, body: 'and this' }
        ] };
    }

    test('resolved threads are dropped from the written file; open threads keep order and ids', function() {
        var writes = {};
        var gitOps = loadGitOps({ file_write: function(call) { writes[call.path] = call.content; } });

        gitOps.writePRContext('input/PROJ-10', prDetailsFixture(), 'diff', null, threadsFixture());

        var raw = JSON.parse(writes['input/PROJ-10/pr_discussions_raw.json']);
        assert.equal(raw.threads.length, 2, 'only open threads survive');
        assert.equal(raw.threads[0].threadId, 'PRRT_open');
        assert.equal(raw.threads[1].threadId, 'PRRT_open2');
        assert.ok(JSON.stringify(raw).indexOf('PRRT_closed') === -1, 'resolved entry must be gone');
    });

    test('a file of only resolved threads is written as an empty list (agent sees nothing actionable)', function() {
        var writes = {};
        var gitOps = loadGitOps({ file_write: function(call) { writes[call.path] = call.content; } });

        gitOps.writePRContext('input/PROJ-10', prDetailsFixture(), 'diff', null,
            { threads: [{ index: 1, rootCommentId: 9, threadId: 'PRRT_only', resolved: true, body: 'done' }] });

        var raw = JSON.parse(writes['input/PROJ-10/pr_discussions_raw.json']);
        assert.equal(raw.threads.length, 0, 'all-resolved file collapses to an empty thread list');
    });

    test('open-only input is written unchanged', function() {
        var writes = {};
        var gitOps = loadGitOps({ file_write: function(call) { writes[call.path] = call.content; } });

        gitOps.writePRContext('input/PROJ-10', prDetailsFixture(), 'diff', null,
            { threads: [{ index: 1, rootCommentId: 1, threadId: 'A', resolved: false, body: 'x' }] });

        var raw = JSON.parse(writes['input/PROJ-10/pr_discussions_raw.json']);
        assert.equal(raw.threads.length, 1);
        assert.equal(raw.threads[0].threadId, 'A');
    });

    test('gh-957 AC3: the GraphQL threads census rides into pr_discussions_raw.json', function() {
        var writes = {};
        var gitOps = loadGitOps({ file_write: function(call) { writes[call.path] = call.content; } });
        var census = {
            source: 'graphql',
            graphqlTotal: 3,
            graphqlUnresolved: 2
        };

        gitOps.writePRContext('input/PROJ-10', prDetailsFixture(), 'diff', null,
            { threads: [{ index: 1, rootCommentId: 1, threadId: 'A', resolved: false, body: 'x' }],
              census: census });

        var raw = JSON.parse(writes['input/PROJ-10/pr_discussions_raw.json']);
        assert.deepEqual(raw.census, census,
            'the rework leg input and the SM arm consult the same census object');
    });

    test('gh-957 AC3: legacy input without a census writes census null (no crash)', function() {
        var writes = {};
        var gitOps = loadGitOps({ file_write: function(call) { writes[call.path] = call.content; } });

        gitOps.writePRContext('input/PROJ-10', prDetailsFixture(), 'diff', null,
            { threads: [{ index: 1, rootCommentId: 1, threadId: 'A', resolved: false, body: 'x' }] });

        var raw = JSON.parse(writes['input/PROJ-10/pr_discussions_raw.json']);
        assert.equal(raw.census, null, 'absent census stays absent, never undefined-keyed');
    });
});

// ── gh-1226 characterization: the pr_info.md / pr_diff.txt / pr_discussions.md
// writes of writePRContext — exact block format, fallbacks and file set. ─────

suite('gitOps.writePRContext — written file set and pr_info.md format (gh-1226)', function() {

    function fullPrDetails() {
        return {
            number: 806, html_url: 'https://github.com/o/r/pull/806', title: 't',
            user: { login: 'u' }, head: { ref: 'pr-806' }, base: { ref: 'main' },
            state: 'open', changed_files: 3, additions: 10, deletions: 2,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
            body: 'Please review the PR body.'
        };
    }

    function loadAndCapture() {
        var writes = {};
        var gitOps = loadGitOps({ file_write: function(call) { writes[call.path] = call.content; } });
        return { gitOps: gitOps, writes: writes };
    }

    test('pr_info.md carries the full metadata block and the PR description', function() {
        var ctx = loadAndCapture();

        ctx.gitOps.writePRContext('input/PROJ-10', fullPrDetails(), 'the diff', null, null);

        var md = ctx.writes['input/PROJ-10/pr_info.md'];
        assert.ok(md, 'pr_info.md is written');
        assert.ok(md.indexOf('# Pull Request Information\n') === 0, 'header line first');
        assert.contains(md, '- **PR #**: 806\n');
        assert.contains(md, '- **URL**: https://github.com/o/r/pull/806\n');
        assert.contains(md, '- **Title**: t\n');
        assert.contains(md, '- **Author**: u\n');
        assert.contains(md, '- **Branch**: `pr-806` → `main`\n');
        assert.contains(md, '- **State**: open\n');
        assert.contains(md, '- **Files Changed**: 3\n');
        assert.contains(md, '- **Additions**: +10\n');
        assert.contains(md, '- **Deletions**: -2\n');
        assert.contains(md, '- **Created**: 2026-01-01T00:00:00Z\n');
        assert.contains(md, '- **Updated**: 2026-01-02T00:00:00Z\n');
        assert.contains(md, '\n## PR Description\n\nPlease review the PR body.\n');
        assert.contains(ctx.writes['input/PROJ-10/pr_diff.txt'], 'the diff');
        assert.equal(ctx.writes['input/PROJ-10/pr_discussions.md'], undefined,
            'no discussions markdown → no pr_discussions.md write');
        assert.equal(ctx.writes['input/PROJ-10/pr_discussions_raw.json'], undefined,
            'no raw threads → no pr_discussions_raw.json write');
    });

    test('missing author/branch/diff fall back to unknown placeholders, absent body is omitted', function() {
        var ctx = loadAndCapture();
        var bare = { number: 1, html_url: 'https://github.com/o/r/pull/1', title: 'bare', state: 'open' };

        ctx.gitOps.writePRContext('input/PROJ-10', bare, '', null, null);

        var md = ctx.writes['input/PROJ-10/pr_info.md'];
        assert.contains(md, '- **Author**: unknown\n');
        assert.contains(md, '- **Branch**: `unknown` → `unknown`\n');
        assert.ok(md.indexOf('## PR Description') === -1, 'no body → no description section');
        assert.contains(ctx.writes['input/PROJ-10/pr_diff.txt'], 'No diff available',
            'an empty diff is replaced by the placeholder');
    });

    test('a discussions markdown string is written to pr_discussions.md as-is', function() {
        var ctx = loadAndCapture();

        ctx.gitOps.writePRContext('input/PROJ-10', fullPrDetails(), 'diff',
            '## Review threads\n\n- thread 1', null);

        assert.equal(ctx.writes['input/PROJ-10/pr_discussions.md'], '## Review threads\n\n- thread 1');
    });
});

// ── gh-912: _switchToBranch decides on ref lines, never on stderr noise ──────
// preCliReworkSetup.js:426-428 wraps checkoutPRBranch in failSetup — a
// warning-only `git ls-remote` capture (central-mode insteadOf origin, git ≥
// 2.54) used to be read as "branch exists on remote" and died mid-fetch /
// mid-checkout with a fatal. AC2: with the branch genuinely absent, the
// decision must be the explicit "Branch not found locally or remotely";
// with warning + real ref line (AC3), the checkout proceeds.

suite('gitOps._switchToBranch — warning-only ls-remote captures (gh-912)', function() {

    var WARNING = 'warning: redirecting to https://git.example.com/\n';

    test('AC2: warning-only capture + absent branch → explicit not-found decision, no fatal mid-checkout', function() {
        var commands = [];
        var gitOps = loadGitOps({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git branch --list "ai/TS-1268"') return '\nCOMMAND_EXIT_CODE=0';
                if (args.command === 'git ls-remote --heads origin ai/TS-1268') return WARNING;
                if (args.command === 'git checkout -b ai/TS-1268 origin/ai/TS-1268') {
                    throw new Error('fatal: \'origin/ai/TS-1268\' is not a commit');
                }
                return 'COMMAND_EXIT_CODE=0';
            }
        });

        var err = null;
        try { gitOps.checkoutPRBranch('ai/TS-1268'); } catch (e) { err = e; }

        assert.ok(err, 'a genuinely absent branch must still be reported');
        assert.contains(err.message, 'Branch not found locally or remotely',
            'the decision must come from strict ref-line parsing, not from a fatal checkout — got: ' + err.message);
    });

    test('AC3: warning + real ref line → branch is checked out (noise tolerated, both merge orders)', function() {
        var refLine = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/ai/TS-1268';
        [WARNING + refLine, refLine + '\n' + WARNING.replace('\n', '')].forEach(function(capture) {
            var commands = [];
            var gitOps = loadGitOps({
                cli_execute_command: function(args) {
                    commands.push(args.command);
                    if (args.command === 'git status --porcelain') return '\nCOMMAND_EXIT_CODE=0';
                    if (args.command === 'git branch --list "ai/TS-1268"') return '\nCOMMAND_EXIT_CODE=0';
                    if (args.command === 'git ls-remote --heads origin ai/TS-1268') return capture;
                    return 'COMMAND_EXIT_CODE=0';
                }
            });

            gitOps.checkoutPRBranch('ai/TS-1268');

            assert.ok(commands.indexOf('git checkout -b ai/TS-1268 origin/ai/TS-1268') !== -1,
                'an existing remote branch (noise-polluted capture) must still be checked out, got: ' + JSON.stringify(commands));
        });
    });

});

// ── gh-962: getPRDiff characterization ───────────────────────────────────────
// CRAP-506 monolith split into small helpers. These tests pin the CURRENT
// behaviour before/with the refactor: the exact git command sequence, the
// fallback order (three-dot → origin/ prefix → merge-base), the per-strategy
// log lines and the '' return on total failure. Pure refactor — every
// expectation here passes identically before and after the split.

suite('gitOps.getPRDiff — characterization (gh-962)', function() {

    var EXPLICIT_FETCH_MAIN = 'git -c fetch.recurseSubmodules=no fetch origin +refs/heads/main:refs/remotes/origin/main';

    // responses: exact command string -> capture string, or function(args).
    // Unlisted commands get a bare exit-0 capture.
    function makeHarness(responses) {
        var h = { commands: [], logs: [], warns: [], errors: [] };
        var origLog = console.log, origWarn = console.warn, origError = console.error;
        console.log = function() { h.logs.push(Array.prototype.slice.call(arguments).join(' ')); };
        console.warn = function() { h.warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        console.error = function() { h.errors.push(Array.prototype.slice.call(arguments).join(' ')); };
        h.gitOps = loadGitOps({
            cli_execute_command: function(args) {
                h.commands.push(args);
                var r = responses[args.command];
                if (typeof r === 'function') return r(args);
                if (r !== undefined) return r;
                return 'COMMAND_EXIT_CODE=0';
            }
        });
        h.commandStrings = function() {
            return h.commands.map(function(a) { return a.command; });
        };
        h.restore = function() {
            console.log = origLog; console.warn = origWarn; console.error = origError;
        };
        return h;
    }

    function run(h, base, head, wd) {
        try {
            return h.gitOps.getPRDiff(base, head, wd);
        } finally {
            h.restore();
        }
    }

    test('happy path: three-dot diff succeeds — command order and return shape pinned', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': '+added line\nCOMMAND_EXIT_CODE=0'
        });

        var diff = run(h, 'main', 'feature/x', '/work/dir');

        assert.equal(diff, '+added line');
        assert.deepEqual(h.commandStrings(), [
            EXPLICIT_FETCH_MAIN,
            'git rev-parse --is-shallow-repository',
            'git diff main...feature/x'
        ], 'ensure-ref fetch → shallow probe → three-dot diff, in this exact order');
        h.commands.forEach(function(a) {
            assert.equal(a.workingDirectory, '/work/dir', 'workingDir must reach cli_execute_command');
        });
        var joined = h.logs.join('\n');
        assert.contains(joined, 'Generating diff between main and feature/x (in /work/dir)');
        assert.contains(joined, 'Repository is already complete (not shallow), skipping unshallow');
        assert.contains(joined, 'Diff size: 31 chars');
        assert.equal(h.warns.length, 0, 'happy path is silent on warn — got: ' + JSON.stringify(h.warns));
        assert.equal(h.errors.length, 0);
    });

    test('no workingDir: cli_execute_command args carry no workingDirectory key', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': 'ok'
        });

        run(h, 'main', 'feature/x');

        h.commands.forEach(function(a) {
            assert.equal(a.workingDirectory, undefined, 'no workingDirectory key expected, got: ' + JSON.stringify(a));
        });
        assert.contains(h.logs.join('\n'), 'Generating diff between main and feature/x ');
        assert.ok(h.logs.join('\n').indexOf('(in') === -1, 'no "(in <dir>)" suffix without workingDir');
    });

    test('shallow repository: git fetch --unshallow is issued before the diff', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'true\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': 'ok'
        });

        run(h, 'main', 'feature/x');

        var cmds = h.commandStrings();
        assert.ok(cmds.indexOf('git fetch --unshallow') !== -1, 'unshallow must run, got: ' + JSON.stringify(cmds));
        assert.ok(cmds.indexOf('git fetch --unshallow') < cmds.indexOf('git diff main...feature/x'),
            'unshallow must precede the diff');
        assert.contains(h.logs.join('\n'), 'Unshallowed repository for full merge base detection');
    });

    test('shallow probe failure is swallowed and the diff still runs', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': function() { throw new Error('rev-parse exploded'); },
            'git diff main...feature/x': 'ok'
        });

        var diff = run(h, 'main', 'feature/x');

        assert.equal(diff, 'ok', 'a failing shallow probe must not abort the diff');
        assert.ok(h.commandStrings().indexOf('git fetch --unshallow') === -1);
    });

    test('three-dot failure falls back to the origin/ prefix — exact commands and warns', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': function() { throw new Error('no merge base'); },
            'git diff origin/main...feature/x': 'fallback diff\nCOMMAND_EXIT_CODE=0'
        });

        var diff = run(h, 'main', 'feature/x');

        assert.equal(diff, 'fallback diff');
        assert.deepEqual(h.commandStrings(), [
            EXPLICIT_FETCH_MAIN,
            'git rev-parse --is-shallow-repository',
            'git diff main...feature/x',
            'git diff origin/main...feature/x'
        ]);
        assert.contains(h.warns.join('\n'),
            'Three-dot diff failed (likely no merge base), trying with origin/ prefix: no merge base');
        assert.contains(h.logs.join('\n'), 'Diff size (origin fallback): 33 chars');
    });

    test('base branch already origin/-prefixed: no double prefix anywhere', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff origin/main...feature/x': 'ok'
        });

        var diff = run(h, 'origin/main', 'feature/x');

        assert.equal(diff, 'ok');
        assert.contains(h.commandStrings()[0],
            'fetch origin +refs/heads/main:refs/remotes/origin/main',
            'ensure-ref fetch uses the STRIPPED branch name');
        assert.ok(h.commandStrings().indexOf('git diff origin/origin/main...feature/x') === -1,
            'origin/ prefix must never be doubled');
        assert.ok(h.commandStrings().indexOf('git diff origin/main...feature/x') !== -1);
    });

    test('origin fallback failure falls back to merge-base — exact commands', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': function() { throw new Error('fail 1'); },
            'git diff origin/main...feature/x': function() { throw new Error('fail 2'); },
            'git merge-base origin/main feature/x': 'abc123def\nCOMMAND_EXIT_CODE=0',
            'git diff abc123def...feature/x': 'mb diff\nCOMMAND_EXIT_CODE=0'
        });

        var diff = run(h, 'main', 'feature/x');

        assert.equal(diff, 'mb diff');
        assert.deepEqual(h.commandStrings(), [
            EXPLICIT_FETCH_MAIN,
            'git rev-parse --is-shallow-repository',
            'git diff main...feature/x',
            'git diff origin/main...feature/x',
            'git merge-base origin/main feature/x',
            'git diff abc123def...feature/x'
        ], 'full fallback chain, in this exact order');
        assert.contains(h.warns.join('\n'), 'Origin-prefix diff also failed, trying merge-base approach: fail 2');
        assert.contains(h.logs.join('\n'), 'Diff size (merge-base fallback): 27 chars');
    });

    test('empty merge-base: silent fall-through to the all-failed log, returns empty string', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': function() { throw new Error('fail 1'); },
            'git diff origin/main...feature/x': function() { throw new Error('fail 2'); },
            'git merge-base origin/main feature/x': '\nCOMMAND_EXIT_CODE=0'
        });

        var diff = run(h, 'main', 'feature/x');

        assert.equal(diff, '');
        assert.ok(h.warns.join('\n').indexOf('Merge-base diff also failed') === -1,
            'an EMPTY merge-base must not warn (only command failures do) — got: ' + JSON.stringify(h.warns));
        assert.contains(h.errors.join('\n'), 'All diff strategies failed for main ... feature/x');
    });

    test('merge-base probe failure warns and returns empty string', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': function() { throw new Error('fail 1'); },
            'git diff origin/main...feature/x': function() { throw new Error('fail 2'); },
            'git merge-base origin/main feature/x': function() { throw new Error('mb gone'); }
        });

        var diff = run(h, 'main', 'feature/x');

        assert.equal(diff, '');
        assert.contains(h.warns.join('\n'), 'Merge-base diff also failed: mb gone');
        assert.contains(h.errors.join('\n'), 'All diff strategies failed for main ... feature/x');
    });

    test('merge-base found but the diff from it fails: warns, returns empty string, no diff command reuses a stale base', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': function() { throw new Error('fail 1'); },
            'git diff origin/main...feature/x': function() { throw new Error('fail 2'); },
            'git merge-base origin/main feature/x': 'abc123def\nCOMMAND_EXIT_CODE=0',
            'git diff abc123def...feature/x': function() { throw new Error('inner fail'); }
        });

        var diff = run(h, 'main', 'feature/x');

        assert.equal(diff, '');
        assert.contains(h.warns.join('\n'), 'Merge-base diff also failed: inner fail');
        assert.contains(h.errors.join('\n'), 'All diff strategies failed for main ... feature/x');
        assert.ok(h.commandStrings().indexOf('git diff \n...feature/x') === -1,
            'an empty merge base must never reach the diff command');
    });

    test('outer catch: a non-string base branch returns empty string instead of throwing', function() {
        var h = makeHarness({});

        var diff = run(h, null, 'feature/x');

        assert.equal(diff, '');
        assert.equal(h.commands.length, 0, 'no git command may run when the base branch is unusable');
        assert.contains(h.errors.join('\n'), 'Failed to get PR diff:');
    });

    test('a falsy (null) command throw surfaces in the outer catch — fallbacks are NOT attempted', function() {
        var h = makeHarness({
            'git rev-parse --is-shallow-repository': 'false\nCOMMAND_EXIT_CODE=0',
            'git diff main...feature/x': function() { throw null; }
        });

        var diff = run(h, 'main', 'feature/x');

        assert.equal(diff, '');
        assert.contains(h.errors.join('\n'), 'Failed to get PR diff:');
        assert.ok(h.commandStrings().indexOf('git diff origin/main...feature/x') === -1,
            'null-ish throws must not be silently converted into a fallback attempt');
    });

});


// ── gh-1011: detectMergeConflicts conflict branches ─────────────────────────
// Pins the exact return shapes, log/warn lines and file writes of the
// merge-failure paths (conflict markers, non-conflict failure, status probe
// failure, shallow clone, quiet-diff anomalies) so the CRAP-reducing
// extraction of the pure parse/build helpers stays byte-identical.

// Response table for the conflict-detect mock: maps exact commands to their
// captures and routes failures through a `throw` marker (kept separate from
// the mock closure so both stay under the CRAP gate).
function conflictResponses(spec) {
    var outs = {
        'git rev-parse --is-shallow-repository': (spec.shallow || 'false') + '\nCOMMAND_EXIT_CODE=0',
        'git diff --cached --quiet HEAD': 'COMMAND_EXIT_CODE=0',
        'git status --short': (spec.statusRaw || '') + '\nCOMMAND_EXIT_CODE=0'
    };
    var throws = {};
    if (spec.shallow === 'THROW') {
        delete outs['git rev-parse --is-shallow-repository'];
        throws['git rev-parse --is-shallow-repository'] = 'shallow probe failed';
    }
    if (spec.quietThrow) {
        delete outs['git diff --cached --quiet HEAD'];
        throws['git diff --cached --quiet HEAD'] = spec.quietThrow;
    }
    if (spec.statusThrow) {
        delete outs['git status --short'];
        throws['git status --short'] = spec.statusThrow;
    }
    return { outs: outs, throws: throws };
}

function makeConflictCmdMock(spec) {
    var table = conflictResponses(spec);
    return function(args) {
        var c = args.command || '';
        if (c.indexOf('git merge origin/') === 0) {
            if (spec.mergeThrow) throw new Error(spec.mergeThrow);
            if (spec.record) spec.record(c, args);
            return 'Merge cleanup\nCOMMAND_EXIT_CODE=0';
        }
        var response = table.throws[c];
        if (response) {
            throw new Error(response);
        }
        if (spec.record) spec.record(c, args);
        return table.outs[c] || 'COMMAND_EXIT_CODE=0';
    };
}

function runConflictDetect(spec) {
    var logs = [];
    var warns = [];
    var writes = [];
    var commands = [];
    var origLog = console.log;
    var origWarn = console.warn;
    console.log = function() { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
    console.warn = function() { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
    try {
        spec.record = function(c, args) { commands.push({ command: c, workingDirectory: args.workingDirectory || null }); };
        var gitOps = loadGitOps({
            cli_execute_command: makeConflictCmdMock(spec),
            file_write: function(args) { writes.push(args); }
        });
        var conflicts = gitOps.detectMergeConflicts(spec.baseBranch || 'main', spec.inputFolder || 'input/PROJ-123', spec.workingDir || null);
        return { conflicts: conflicts, logs: logs, warns: warns, writes: writes, commands: commands };
    } finally {
        console.log = origLog;
        console.warn = origWarn;
    }
}

suite('gitOps.detectMergeConflicts — conflict handling (gh-1011)', function() {

    test('merge conflict exit code returns the conflict file list and writes merge_conflicts.md', function() {
        var fx = runConflictDetect({
            mergeThrow: 'Automatic merge failed; fix conflicts and then commit the result. COMMAND_EXIT_CODE=1',
            statusRaw: 'UU src/a.js\nAA  src/b.js\nM src/clean.js'
        });

        assert.deepEqual(fx.conflicts, ['src/a.js', 'src/b.js'], 'only conflict-marker lines become files, in order');

        var joinedWarns = fx.warns.join('\n');
        assert.contains(joinedWarns, '⚠️ Merge conflicts in 2 file(s):', 'the warn carries the count');
        assert.contains(joinedWarns, 'src/a.js, src/b.js', 'the warn lists the files');

        assert.equal(fx.writes.length, 1, 'exactly one merge_conflicts.md write');
        assert.equal(fx.writes[0].path, 'input/PROJ-123/merge_conflicts.md');
        var md = fx.writes[0].content;
        assert.contains(md, '# ⚠️ Merge Conflicts — Resolve Before Rework');
        assert.contains(md, 'conflicts with `main`');
        assert.contains(md, '- `src/a.js`');
        assert.contains(md, '- `src/b.js`');
        assert.contains(md, '2 file(s) contain conflict markers');
        assert.contains(md, 'git add <file>');
        assert.contains(md, 'Do NOT run `git commit` or `git merge --abort`');

        var logged = fx.logs.join('\n');
        assert.contains(logged, '✅ Wrote merge_conflicts.md');
        assert.ok(logged.indexOf('No merge conflicts') === -1, 'a real conflict must not log "No merge conflicts"');
        var mergeAborts = fx.commands.filter(function(c) { return c.command === 'git merge --abort'; });
        assert.equal(mergeAborts.length, 0, 'the conflicted merge state is left in place for the agent');
    });

    test('merge failure without conflict markers aborts, warns with the reason and returns no files', function() {
        var fx = runConflictDetect({
            mergeThrow: 'fatal: refusing to merge unrelated histories COMMAND_EXIT_CODE=128',
            statusRaw: 'M src/something.js'
        });

        assert.deepEqual(fx.conflicts, []);
        assert.contains(fx.warns.join('\n'), 'Merge failed (non-conflict reason):',
            'the non-conflict path is announced, got: ' + JSON.stringify(fx.warns));
        assert.equal(fx.writes.length, 0, 'no merge_conflicts.md on a non-conflict failure');
        assert.equal(fx.commands.filter(function(c) { return c.command === 'git merge --abort'; }).length, 1,
            'a non-conflict failure aborts the merge');
    });

    test('when the status probe itself fails, the merge is aborted and no files are reported', function() {
        var fx = runConflictDetect({
            mergeThrow: 'error: merge failed COMMAND_EXIT_CODE=1',
            statusThrow: 'fatal: unable to read the index COMMAND_EXIT_CODE=128'
        });

        assert.deepEqual(fx.conflicts, [], 'no files are reported when the status probe fails');
        assert.contains(fx.warns.join('\n'), 'Could not determine merge state after conflict:',
            'the status-probe failure is announced, got: ' + JSON.stringify(fx.warns));
        assert.equal(fx.commands.filter(function(c) { return c.command === 'git merge --abort'; }).length, 1);
        assert.equal(fx.writes.length, 0, 'no merge_conflicts.md when the state cannot be determined');
    });

    test('a shallow repository is unshallowed before the merge attempt', function() {
        var fx = runConflictDetect({ shallow: 'true' });

        assert.deepEqual(fx.conflicts, []);
        assert.ok(fx.commands.some(function(c) { return c.command === 'git fetch --unshallow'; }),
            'git fetch --unshallow must run for a shallow clone');
        assert.contains(fx.logs.join('\n'), 'Unshallowed repository for full merge base detection');
    });

    test('a failing shallow probe is swallowed silently and the merge proceeds', function() {
        var fx = runConflictDetect({
            shallow: 'THROW',
            mergeThrow: 'Automatic merge failed COMMAND_EXIT_CODE=1',
            statusRaw: 'UU src/x.js'
        });

        assert.deepEqual(fx.conflicts, ['src/x.js'], 'the conflict outcome is unaffected by the probe failure');
        assert.equal(fx.warns.filter(function(w) { return w.indexOf('shallow') !== -1; }).length, 0,
            'the swallowed probe failure stays silent');
    });

    test('a quiet-diff failure that is NOT exit 1 warns with the message and keeps the staged assumption', function() {
        var fx = runConflictDetect({
            quietThrow: 'fatal: unable to read the index COMMAND_EXIT_CODE=128'
        });

        assert.deepEqual(fx.conflicts, []);
        var joinedWarns = fx.warns.join('\n');
        assert.contains(joinedWarns, 'git diff --cached --quiet failed (assuming staged):');
        assert.contains(joinedWarns, 'unable to read the index', 'the warn carries the failure content');
        assert.contains(fx.logs.join('\n'), 'No merge conflicts — base branch changes staged',
            'the conservative staged wording is kept');
    });

    test('a successful merge with staged changes keeps the staged wording (exit-1 quiet diff)', function() {
        var fx = runConflictDetect({
            quietThrow: 'exit 1 — the merge staged changes COMMAND_EXIT_CODE=1'
        });

        assert.deepEqual(fx.conflicts, []);
        assert.contains(fx.logs.join('\n'), 'No merge conflicts — base branch changes staged');
        assert.equal(fx.warns.length, 0, 'exit 1 is the expected staged signal — no warn');
    });

    test('a non-conflict merge failure with a clean index aborts and reports no conflicts', function() {
        var fx = runConflictDetect({
            mergeThrow: 'error: Your local changes COMMAND_EXIT_CODE=128',
            statusRaw: ''
        });

        assert.deepEqual(fx.conflicts, []);
        assert.contains(fx.warns.join('\n'), 'Merge failed (non-conflict reason):');
        assert.equal(fx.commands.filter(function(c) { return c.command === 'git merge --abort'; }).length, 1);
    });

    test('the working directory is threaded into every command and the opening log line', function() {
        var fx = runConflictDetect({ workingDir: '/tmp/work' });

        assert.deepEqual(fx.conflicts, []);
        assert.contains(fx.logs.join('\n'), 'Checking for merge conflicts with origin/main in /tmp/work...');
        assert.ok(fx.commands.length > 0, 'sanity: commands were recorded');
        fx.commands.forEach(function(c) {
            assert.equal(c.workingDirectory, '/tmp/work', 'every git call carries the working directory: ' + c.command);
        });
    });

    test('an up-to-date merge logs the explicit up-to-date wording (gh-802 AC3a)', function() {
        var fx = runConflictDetect({});

        assert.deepEqual(fx.conflicts, []);
        assert.contains(fx.logs.join('\n'), 'No merge conflicts — branch already up to date with origin/main');
    });

    test('conflict file names are trimmed of leading/trailing whitespace', function() {
        var fx = runConflictDetect({
            mergeThrow: 'CONFLICT COMMAND_EXIT_CODE=1',
            statusRaw: 'UU   src/spaced.js  '
        });

        assert.deepEqual(fx.conflicts, ['src/spaced.js']);
    });
});
