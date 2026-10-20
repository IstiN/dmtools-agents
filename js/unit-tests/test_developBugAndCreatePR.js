/**
 * Unit tests for js/developBugAndCreatePR.js.
 */

// gh-1137: named pass-through stub for the toolchain-summary annotation. A
// per-callsite inline function(t){return t;} would sit uncovered inside the
// loader functions and lift their CRAP over the ratchet; the named helper is
// a separate coverage unit of complexity 1 (CRAP 2, far below the bar).
var stubToolchainLine = function (t) { return t; };

function loadTrackersDev(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

// Real tracker layer loaded WITH the same tool mocks as the script under test
// (loadModule mocks only shadow globals inside the module they are passed to).
function trackersWith(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

function loadDevelopBugAndCreatePR(mocks) {
    mocks = mocks || {};
    var comments = [];
    var moves = [];
    var removed = [];
    var commands = [];

    var allMocks = Object.assign({
        file_read: function(args) {
            if (args.path === 'outputs/response.md') throw new Error('missing response');
            throw new Error('missing ' + args.path);
        },
        cli_execute_command: function(args) {
            commands.push(args.command);
            if (args.command.indexOf('gh pr list --head ') === 0) return '';
            if (args.command.indexOf('git check-ignore') === 0) {
                // gh-683 probe: not-ignored repo — check-ignore exits 1,
                // the exclusion pathspecs must stay in the staging add.
                throw new Error('Command execution failed (exit code 1)');
            }
            if (args.command === 'git status --porcelain') return 'A  outputs/rca.md\n';
            if (args.command === 'git branch --show-current') return 'main\n';
            return '';
        },
        jira_post_comment: function(args) { comments.push(args); },
        jira_move_to_status: function(args) { moves.push(args); },
        jira_remove_label: function(args) { removed.push(args); }
    }, mocks);
    var outputFiles = loadModule(
        'js/common/outputFiles.js',
        makeRequire({
            './common/commentMarkup.js': commentMarkupModule,
        }),
        allMocks
    );
var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var gitStagingModule = loadModule('js/common/gitStaging.js');
// gh-1087: real quota circuit-breaker (pure module — no requires of its own).
var quotaBreakerModule = loadModule('js/common/quotaCircuitBreaker.js');

// gh-742 rework: the bug flow's interrupted path calls
// developTicket.throwInterruptedReset, so the mock below exposes the REAL
// exported helper (single source of truth for the marker/message contract)
// instead of a byte-copy. The bug tests never invoke the delegated
// developTicketAndCreatePR action(), so its stubbed deps are never touched.
var developTicketRealModule = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
        './common/toolchainSummary.js': { withToolchainLine: stubToolchainLine },
        './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
        './common/pullRequest.js': { cleanCommandOutput: function (output) { return (output || '').trim(); } },
        './common/submodules.js': {},
        './common/feedbackLoop.js': {
            runQualityGates: function () { return { success: true }; },
            runPolicyGates: function () { return { success: true }; },
            runPostPublishGates: function () { return { success: true }; },
            resumeAgent: function () { return { attempted: false }; }
        },
        './common/autoStart.js': { triggerSmIfIdle: function () { } },
        './common/outputFiles.js': { readOutputFile: function () { return null; } },
        './cacheToReleases.js': {},
        './common/gitStaging.js': gitStagingModule,
        './common/quotaCircuitBreaker.js': quotaBreakerModule,
        './configLoader.js': configLoaderModule,
        './config.js': configModule,
        './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
        './common/commentMarkup.js': commentMarkupModule
    }, { './common/trackers.js': trackersWith(_m) })), _m); })({});

    var mod = loadModule(
        'js/developBugAndCreatePR.js',
        makeRequire({
            './common/toolchainSummary.js': { withToolchainLine: stubToolchainLine },
            './config.js': configModule,
            './common/gitStaging.js': gitStagingModule,
            './common/quotaCircuitBreaker.js': quotaBreakerModule,
            './configLoader.js': configLoaderModule,
            './common/outputFiles.js': outputFiles,
            './common/trackers.js': loadTrackersDev(allMocks),
            './developTicketAndCreatePR.js': {
                action: function() { return { success: true, path: 'delegated' }; },
                throwInterruptedReset: developTicketRealModule.throwInterruptedReset,
                // gh-1087: real shared helpers (single source of truth for
                // the classification concat + the quotaPark marker contract).
                classifyInterruptedText: developTicketRealModule.classifyInterruptedText,
                throwQuotaPark: developTicketRealModule.throwQuotaPark,
                recoverMissingResponse: function () { return null; }
            }
        ,
            './common/feedbackLoop.js': {
                runQualityGates: function () { return { success: true }; },
                runPolicyGates: function () { return { success: true }; },
                runPostPublishGates: function () { return { success: true }; },
                resumeAgent: function () { return { attempted: false }; },
                resumeOnceForMissingResponse: function () { return { attempted: false }; }
            },
            './common/commentMarkup.js': commentMarkupModule,
        }),
        allMocks
    );

    return {
        mod: mod,
        commands: commands,
        comments: comments,
        moves: moves,
        removed: removed,
        developTicketRealModule: developTicketRealModule
    };
}

suite('developBugAndCreatePR', function() {

    test('pushes interrupted partial work to development branch instead of main', function() {
        var loaded = loadDevelopBugAndCreatePR();

        // gh-742: the interrupted-reset path must fail the run (throw) so a
        // no-PR leg never reads as plain success — while still pushing the
        // partial work and resetting the ticket for retry.
        var caught = null;
        try {
            loaded.mod.action({
                ticket: {
                    key: 'TS-1296',
                    fields: { summary: 'Bug loop', description: '', labels: [] }
                },
                metadata: { contextId: 'bug_development' },
                jobParams: {
                    customParams: { removeLabel: 'sm_bug_development_triggered' }
                }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'an interrupted leg must fail the run (throw), not return plain success');
        assert.ok(caught && caught.interruptedReset === true,
            'thrown error carries the interruptedReset marker');
        // gh-742 rework: the bug flow must throw through the REAL shared
        // helper exported by developTicketAndCreatePR — not a local copy —
        // so the marker/message contract can never drift between the two
        // interrupted paths.
        assert.equal(typeof loaded.developTicketRealModule.throwInterruptedReset, 'function',
            'developTicketAndCreatePR must export throwInterruptedReset for the bug flow to reuse');
        assert.contains(caught.message, 'TS-1296 was reset for retry',
            'the thrown message is the shared contract message from developTicketAndCreatePR');
        assert.ok(
            loaded.commands.indexOf('git checkout -B ai/TS-1296') !== -1,
            'expected partial work to switch away from main'
        );
        assert.ok(
            loaded.commands.indexOf('git push -u origin ai/TS-1296 --force-with-lease') !== -1,
            'expected partial work push to target ai branch'
        );
        assert.notOk(
            loaded.commands.indexOf('git push -u origin main') !== -1,
            'must never push partial work to main'
        );
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1296', statusName: 'Ready For Development' }
        ]);
        assert.deepEqual(loaded.removed, [
            { key: 'TS-1296', label: 'bug_development_wip' },
            { key: 'TS-1296', label: 'sm_bug_development_triggered' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Development Interrupted');
    });

    test('does not clean CodeGraph runtime artifacts from JS post-action', function() {
        var loaded = loadDevelopBugAndCreatePR();

        var caught = null;
        try {
            loaded.mod.action({
                ticket: {
                    key: 'TS-1298',
                    fields: { summary: 'Interrupted by rate limit', description: '', labels: [] }
                },
                metadata: { contextId: 'bug_development' },
                jobParams: {
                    customParams: { removeLabel: 'sm_bug_development_triggered' }
                }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'an interrupted leg must fail the run (throw), not return plain success');
        assert.ok(caught && caught.interruptedReset === true,
            'thrown error carries the interruptedReset marker');
        assert.notOk(
            loaded.commands.some(function(c) {
                return c.indexOf('.agent-bin') !== -1 || c.indexOf('.codegraph') !== -1;
            }),
            'CodeGraph setup/cleanup belongs to setup scripts, not JS post-actions'
        );
    });

    test('gh-1087 UT-2/AC2: bug leg parks on a 403 quota failure — park label + comment, NO status reset, quotaPark marker', function() {
        var addedLabels = [];
        var loaded = loadDevelopBugAndCreatePR({
            jira_add_label: function (args) { addedLabels.push(args.label); }
        });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: {
                    key: 'TS-1301',
                    fields: { summary: 'Quota wall', description: '', labels: [] }
                },
                metadata: { contextId: 'bug_development' },
                response: '',
                currentCliErrorMessage: 'z.ai glm-5.3-flash answered 403 "weekly (7-day) usage limit" (9 retries); Provider chain exhausted: 2 of 2',
                jobParams: {
                    customParams: { removeLabel: 'sm_bug_development_triggered' }
                }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'a parked bug leg must fail the run (throw), not return plain success');
        assert.ok(caught && caught.quotaPark === true,
            'thrown error carries the quotaPark marker via the shared developTicket.throwQuotaPark helper');
        assert.deepEqual(loaded.moves, [],
            'quota park must NOT reset the ticket to Ready For Development (AC2)');
        assert.deepEqual(addedLabels, ['provider_quota'],
            'park label added to the ticket (AC2)');
        assert.equal(loaded.comments.length, 1);
        assert.contains(loaded.comments[0].comment, 'Provider Quota Exhausted');
        assert.contains(loaded.comments[0].comment, 'weekly (7-day)');
        assert.deepEqual(loaded.removed, [
            { key: 'TS-1301', label: 'bug_development_wip' },
            { key: 'TS-1301', label: 'sm_bug_development_triggered' }
        ], 'WIP + SM labels still cleaned up so a later un-park can re-dispatch');
    });

    test('accepts already_fixed output without CodeGraph and moves bug to Done', function() {
        var loaded = loadDevelopBugAndCreatePR({
            file_read: function(args) {
                if (args.path === 'outputs/already_fixed.json') {
                    return JSON.stringify({
                        rca: 'Current code already covers this behavior',
                        commit: 'abc123',
                        description: 'Verified without CodeGraph'
                    });
                }
                if (args.path === '.dmtools/codegraph-usage.log') {
                    throw new Error('missing codegraph usage log');
                }
                throw new Error('missing ' + args.path);
            }
        });

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1303',
                fields: { summary: 'Already fixed claim', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'already_fixed');
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1303', statusName: 'Done' }
        ]);
        assert.contains(loaded.comments[0].comment, 'No CodeGraph usage was recorded');
        assert.deepEqual(loaded.removed, [
            { key: 'TS-1303', label: 'bug_development_wip' },
            { key: 'TS-1303', label: 'sm_bug_development_triggered' }
        ]);
    });

    test('ado provider: already_fixed path uses ado_* tools and no jira_* tool (wave1c)', function() {
        var adoCalls = [];
        var jiraCalls = [];
        var loaded = loadDevelopBugAndCreatePR({
            file_read: function(args) {
                if (args.path === 'outputs/already_fixed.json') {
                    return JSON.stringify({ rca: 'covered', commit: 'abc123', description: 'ok' });
                }
                throw new Error('missing ' + args.path);
            },
            jira_post_comment: function(a) { jiraCalls.push(a); },
            jira_move_to_status: function(a) { jiraCalls.push(a); },
            jira_remove_label: function(a) { jiraCalls.push(a); },
            jira_add_label: function(a) { jiraCalls.push(a); },
            ado_move_to_state: function(a) { adoCalls.push(['move', a]); },
            ado_add_work_item_comment: function(a) { adoCalls.push(['comment', a]); },
            ado_remove_work_item_label: function(a) { adoCalls.push(['remove', a]); },
            ado_add_work_item_label: function(a) { adoCalls.push(['add', a]); }
        });
        var result = loaded.mod.action({
            ticket: { key: '1303', fields: { summary: 'x', description: '', labels: [] } },
            metadata: { contextId: 'bug_development' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(result.success, true);
        assert.equal(jiraCalls.length, 0);
        assert.ok(adoCalls.some(function(c) { return c[0] === 'move' && c[1].state === 'Done'; }));
        assert.ok(adoCalls.some(function(c) { return c[0] === 'comment'; }));
        assert.ok(adoCalls.some(function(c) { return c[0] === 'remove'; }));
    });

    test('rejects blocked output when CodeGraph was not used', function() {
        var loaded = loadDevelopBugAndCreatePR({
            file_read: function(args) {
                if (args.path === 'outputs/blocked.json') {
                    return JSON.stringify({
                        reason: 'Session tooling did not return repository file contents',
                        tried: ['Read input files'],
                        needs: 'A working session'
                    });
                }
                if (args.path === '.dmtools/codegraph-usage.log') {
                    throw new Error('missing codegraph usage log');
                }
                throw new Error('missing ' + args.path);
            }
        });

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1304',
                fields: { summary: 'Blocked claim', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'blocked_without_codegraph');
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1304', statusName: 'Ready For Development' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Blocked Claim Needs CodeGraph Verification');
    });

    test('accepts blocked output when CodeGraph usage was recorded → moves bug to Blocked (gh-1003)', function () {
        // gh-1003: the accepted-blocked branch of completeBlockedPath had no
        // characterization test (only the CodeGraph-rejection side was
        // pinned) — its coverage is what keeps the extracted helper under
        // the CRAP threshold.
        var loaded = loadDevelopBugAndCreatePR({
            file_read: function (args) {
                if (args.path === 'outputs/blocked.json') {
                    return JSON.stringify({
                        reason: 'Session tooling did not return repository file contents',
                        tried: ['Read input files', 'Reproduced locally'],
                        needs: 'A working session'
                    });
                }
                if (args.path === '.dmtools/codegraph-usage.log') {
                    return '2026-05-31T00:00:00Z\tcodegraph search symbol\n';
                }
                throw new Error('missing ' + args.path);
            }
        });

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1310',
                fields: { summary: 'Blocked claim with CodeGraph', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'blocked');
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1310', statusName: 'Blocked' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Bug Cannot Be Fixed Automatically');
        assert.contains(loaded.comments[0].comment, '- Read input files');
        assert.contains(loaded.comments[0].comment, '- Reproduced locally');
        assert.deepEqual(loaded.removed, [
            { key: 'TS-1310', label: 'bug_development_wip' },
            { key: 'TS-1310', label: 'sm_bug_development_triggered' }
        ]);
    });

    test('accepts already_fixed output when CodeGraph usage was recorded', function() {
        var loaded = loadDevelopBugAndCreatePR({
            file_read: function(args) {
                if (args.path === 'outputs/already_fixed.json') {
                    return JSON.stringify({
                        rca: 'Current code already covers this behavior',
                        commit: 'abc123',
                        description: 'Verified with CodeGraph'
                    });
                }
                if (args.path === '.dmtools/codegraph-usage.log') {
                    return '2026-05-31T00:00:00Z\tcodegraph search symbol\n';
                }
                throw new Error('missing ' + args.path);
            },
            jira_add_label: function() {}
        });

        var result = loaded.mod.action({
            ticket: {
                key: 'TS-1303',
                fields: { summary: 'Already fixed claim', description: '', labels: [] }
            },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: { removeLabel: 'sm_bug_development_triggered' }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'already_fixed');
        assert.deepEqual(loaded.moves, [
            { key: 'TS-1303', statusName: 'Done' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Bug Already Fixed');
    });

    test('git add never stages machine-local .dmtools runtime logs (gh-628)', function() {
        // Live 2026-10-03 (ai/gh-628): the machine's runtime files live
        // INSIDE the committed .dmtools/ directory, and broad `git add`
        // staging swept .dmtools/credential-helper.log (the credential
        // helper's serving trace) into three ticket-branch commits. The
        // status-check staging pathspec must exclude them like
        // copilot-sessions.
        var loaded = loadDevelopBugAndCreatePR();
        // gh-742: the interrupted path now throws after the staging check —
        // capture the throw so the staging assertions below still run.
        var caught = null;
        try {
            loaded.mod.action({
                ticket: {
                    key: 'TS-1299',
                    fields: { summary: 'staging hygiene', description: '', labels: [] }
                },
                metadata: { contextId: 'bug_development' },
                jobParams: {
                    customParams: { removeLabel: 'sm_bug_development_triggered' }
                }
            });
        } catch (e) {
            caught = e;
        }
        assert.ok(caught && caught.interruptedReset === true,
            'the interrupted path must fail the run (throw) after the staging check');
        var addCall = loaded.commands.filter(function(c) {
            return c.indexOf('git add . --') === 0;
        })[0];
        assert.ok(addCall, 'staging command executed — commands: ' + JSON.stringify(loaded.commands));
        assert.contains(addCall, ':!.dmtools/credential-helper.log',
            'credential-serving trace never staged');
        assert.contains(addCall, ':!.dmtools/fa-trace.log', 'fa trace log never staged');
        assert.contains(addCall, ':!.dmtools/run-output.txt', 'fa run output never staged');
        assert.contains(addCall, ':!.dmtools/stall-capture.log', 'stall capture never staged');
        assert.contains(addCall, ':!.dmtools/fa-sessions', 'session store never staged');
        assert.contains(addCall, ':!.dmtools-session-output.log',
            'timer CLI-stdout snapshot never staged');
        var rmCalls = loaded.commands.filter(function(c) {
            return c.indexOf('git ls-files -- ') === 0;
        });
        assert.equal(rmCalls.length, 1, 'exactly one untrack-cleanup command');
        assert.contains(rmCalls[0], '.dmtools/credential-helper.log',
            'already-tracked credential-helper.log is untracked (poisoned-branch self-heal)');
        assert.contains(rmCalls[0], '.dmtools/fa-sessions',
            'session store untracked too — untrack list must not drift from staging exclusions (gh-628)');
    });

    test('untracked machine-local runtime artifacts alone do not count as git changes (gh-628)', function() {
        // gh-628 review round 1: `git rm -r --cached` self-healing leaves the
        // runtime logs on disk as UNTRACKED files (target repos carry no
        // matching .gitignore entries). The raw `git status --porcelain`
        // filter only skipped factory-kit, so hasGitChanges became
        // permanently true — every interrupted leg ran the recovery push and
        // posted a false "Partial analysis work was saved" comment. A status
        // that reports ONLY machine-runtime artifacts must count as "no
        // changes".
        var cmds = [];
        var loaded = loadDevelopBugAndCreatePR({
            cli_execute_command: function(args) {
                cmds.push(args.command);
                if (args.command === 'git status --porcelain') {
                    return '?? .dmtools/copilot-sessions/\n' +
                        '?? .dmtools/credential-helper.log\n' +
                        '?? .dmtools/fa-trace.log\n' +
                        '?? .dmtools/run-output.txt\n' +
                        '?? .dmtools/stall-capture.log\n' +
                        '?? .dmtools/fa-sessions/\n' +
                        '?? .dmtools-session-output.log\n';
                }
                if (args.command.indexOf('gh pr list --head ') === 0) return '';
                if (args.command === 'git branch --show-current') return 'ai/TS-1305\n';
                return '';
            }
        });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: {
                    key: 'TS-1305',
                    fields: { summary: 'runtime-only status noise', description: '', labels: [] }
                },
                metadata: { contextId: 'bug_development' },
                jobParams: {
                    customParams: { removeLabel: 'sm_bug_development_triggered' }
                }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'an interrupted leg must fail the run (throw), not return plain success');
        assert.ok(caught && caught.interruptedReset === true,
            'thrown error carries the interruptedReset marker');
        assert.notOk(cmds.some(function(c) { return c.indexOf('git checkout -B') === 0; }),
            'recovery push must not run — untracked runtime logs are not work');
        assert.notOk(cmds.some(function(c) { return c.indexOf('git commit') === 0; }),
            'nothing to commit — runtime-only status must not produce a commit');
        assert.notOk(cmds.some(function(c) { return c.indexOf('git push') === 0; }),
            'nothing to push — runtime-only status must not produce a push');
        assert.ok(loaded.comments.length === 1 && loaded.comments[0].comment.indexOf('No partial work was produced.') !== -1,
            'comment must honestly report no partial work — got: ' +
            (loaded.comments[0] ? loaded.comments[0].comment : '(none)'));
    });

    test('marked failures from the delegated developTicketAndCreatePR propagate (gh-729/ gh-683 dead-letter contract)', function () {
        // developTicketAndCreatePR fails the RUN loudly on PR-creation and
        // git-operations failures by THROWING marked errors (after resetting
        // the ticket). If developBugAndCreatePR swallowed those into a
        // returned { success: false }, the run would not go RED and the
        // missing-PR leg would read as ordinary failure output.
        var marked = new Error('Pull Request creation failure (Pull Request Creation): HTTP 502');
        marked.prCreationFailure = true;
        var commentMarkupMod = loadModule('js/common/commentMarkup.js',
            makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
        var gitStagingMod = loadModule('js/common/gitStaging.js');
        var inlineMocks = {
            cli_execute_command: function (args) {
                if (args.command.indexOf('gh pr list --head ') === 0) return '';
                if (args.command.indexOf('git check-ignore') === 0) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                if (args.command === 'git status --porcelain') return '';
                if (args.command === 'git branch --show-current') return 'ai/TS-1306';
                return '';
            },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        };
        var mod = loadModule(
            'js/developBugAndCreatePR.js',
            makeRequire({
                './common/toolchainSummary.js': { withToolchainLine: stubToolchainLine },
                './common/trackers.js': loadTrackersDev(inlineMocks),
                './config.js': configModule,
                './common/gitStaging.js': gitStagingMod,
                './common/quotaCircuitBreaker.js': loadModule('js/common/quotaCircuitBreaker.js'),
                './configLoader.js': configLoaderModule,
                './common/outputFiles.js': loadModule('js/common/outputFiles.js', makeRequire({}), {
                    file_read: function (args) {
                        if (args.path === 'outputs/response.md') return '### What changed\n- fix\n';
                        throw new Error('missing ' + args.path);
                    }
                }),
                './developTicketAndCreatePR.js': { action: function () { throw marked; }, classifyInterruptedText: function (e, r) { return String(e || '') + '\n' + String(r || ''); } },
                './common/feedbackLoop.js': {
                    runQualityGates: function () { return { success: true }; },
                    runPolicyGates: function () { return { success: true }; },
                    runPostPublishGates: function () { return { success: true }; },
                    resumeAgent: function () { return { attempted: false }; },
                    resumeOnceForMissingResponse: function () { return { attempted: false }; }
                },
                './common/commentMarkup.js': commentMarkupMod
            }),
            inlineMocks
        );

        var caught = null;
        try {
            mod.action({
                ticket: { key: 'TS-1306', fields: { summary: 'PR API outage', description: '', labels: [] } },
                metadata: { contextId: 'bug_development' },
                jobParams: { customParams: {} }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'the marked prCreationFailure must propagate out of developBugAndCreatePR');
        assert.equal(caught && caught.prCreationFailure, true, 'marker survives the passthrough');
    });

});

// ── gh-775: resume-before-cold-reset (bug pre-check path) ────────────
// The bug post-action's own response.md-missing branch cold-resets BEFORE it
// ever delegates to developTicketAndCreatePR — it must route through the SHARED
// recoverMissingResponse() gate (fatal CLI/environment class first, then ONE
// bounded resume attempt, then the re-read) instead of calling
// feedbackLoop.resumeOnceForMissingResponse() directly. The developTicket mock
// below therefore exposes the REAL shared gate, backed by the REAL
// common/feedbackLoop.js + common/outputFiles.js (sharing the file map and cli
// capture), while the bug module itself gets a feedbackLoop SPY — a direct
// call from the bug leg is recorded and fails the delegation test.
function loadBugForMissingResponseResume(opts) {
    opts = opts || {};
    var files = {};
    var commands = [];
    var comments = [];
    var moves = [];
    var removed = [];
    var delegated = 0;
    var recoverCalls = [];
    var directFeedbackLoopCalls = [];

    // Self-contained base modules (the older loader in this file declares its
    // instances inside its own function scope).
    var commentMarkupModuleLocal = loadModule('js/common/commentMarkup.js',
        makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
    var gitStagingModuleLocal = loadModule('js/common/gitStaging.js');

    var sharedFileRead = function (args) {
        var path = args && (args.path || args);
        if (files[path] !== undefined) return files[path];
        throw new Error('ENOENT: ' + path);
    };
    var sharedFileWrite = function (args) {
        files[args && args.path] = args && args.content;
    };
    var baseCli = function (args) {
        var command = args.command;
        if (command.indexOf('gh pr list --head ') === 0) return '';
        if (command.indexOf('git check-ignore') === 0) {
            // gh-683 probe: not-ignored repo → keep exclusions
            throw new Error('Command execution failed (exit code 1)');
        }
        if (command === 'git status --porcelain') return 'A  outputs/rca.md\n';
        if (command === 'git branch --show-current') return 'main\n';
        return '';
    };
    var cliMock = function (args) {
        commands.push(args.command);
        if (args.command.indexOf('run-agent.sh') !== -1 && opts.wrapperImpl) {
            return opts.wrapperImpl(args.command);
        }
        return baseCli(args);
    };

    var realFeedbackLoop = loadModule('js/common/feedbackLoop.js', null, {
        file_read: sharedFileRead,
        file_write: sharedFileWrite,
        cli_execute_command: cliMock
    });
    var realOutputFiles = loadModule('js/common/outputFiles.js', null, {
        file_read: sharedFileRead
    });

    // The REAL developTicketAndCreatePR instance backing the shared gate —
    // wired to the same real feedbackLoop/outputFiles so the attempt marker,
    // prompt file and deliverable re-read are shared with the bug leg.
    var sharedGateModule = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
            './common/toolchainSummary.js': { withToolchainLine: stubToolchainLine },
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': { cleanCommandOutput: function (output) { return (output || '').trim(); } },
            './common/submodules.js': {},
            './common/feedbackLoop.js': realFeedbackLoop,
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': realOutputFiles,
            './cacheToReleases.js': {},
            './common/gitStaging.js': gitStagingModuleLocal,
            './common/quotaCircuitBreaker.js': loadModule('js/common/quotaCircuitBreaker.js'),
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/commentMarkup.js': commentMarkupModuleLocal
        }, { './common/trackers.js': trackersWith(_m) })), _m); })({
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { moves.push(args); },
            jira_remove_label: function (args) { removed.push(args); }
        });

    var spyMocks = {
        cli_execute_command: cliMock,
        file_read: sharedFileRead,
        file_write: sharedFileWrite,
        jira_post_comment: function (args) { comments.push(args); },
        jira_move_to_status: function (args) { moves.push(args); },
        jira_remove_label: function (args) { removed.push(args); }
    };
    var mod = loadModule(
        'js/developBugAndCreatePR.js',
        makeRequire({
            './common/toolchainSummary.js': { withToolchainLine: stubToolchainLine },
            './common/trackers.js': loadTrackersDev(spyMocks),
            './config.js': configModule,
            './common/gitStaging.js': gitStagingModuleLocal,
            './common/quotaCircuitBreaker.js': loadModule('js/common/quotaCircuitBreaker.js'),
            './configLoader.js': configLoaderModule,
            './common/outputFiles.js': realOutputFiles,
            // SPY: a direct resumeOnceForMissingResponse call from the bug leg
            // is forbidden — the shared gate owns the resume (gh-775 review
            // round 1, IMPORTANT thread).
            './common/feedbackLoop.js': {
                resumeOnceForMissingResponse: function (options) {
                    directFeedbackLoopCalls.push(options);
                    return { attempted: false, reason: 'direct-bug-leg-call-forbidden' };
                }
            },
            './developTicketAndCreatePR.js': {
                action: function () { delegated++; return { success: true, path: 'delegated' }; },
                classifyInterruptedText: sharedGateModule.classifyInterruptedText,
                throwQuotaPark: sharedGateModule.throwQuotaPark,
                throwInterruptedReset: sharedGateModule.throwInterruptedReset,
                recoverMissingResponse: function (ticketKey, customParams, developmentSummary, cliHasFatalError, cliErrorMessage) {
                    recoverCalls.push({
                        ticketKey: ticketKey,
                        customParams: customParams,
                        developmentSummary: developmentSummary,
                        cliHasFatalError: cliHasFatalError,
                        cliErrorMessage: cliErrorMessage
                    });
                    if (opts.recoverMissingResponseImpl) {
                        return opts.recoverMissingResponseImpl(ticketKey, customParams, developmentSummary, cliHasFatalError, cliErrorMessage);
                    }
                    return sharedGateModule.recoverMissingResponse(ticketKey, customParams, developmentSummary, cliHasFatalError, cliErrorMessage);
                }
            },
            './common/commentMarkup.js': commentMarkupModuleLocal
        }),
        spyMocks
    );

    return {
        mod: mod, files: files, commands: commands, comments: comments,
        moves: moves, removed: removed,
        recoverCalls: recoverCalls,
        directFeedbackLoopCalls: directFeedbackLoopCalls,
        delegatedCount: function () { return delegated; }
    };
}

function bugWrapperCommandCount(commands) {
    var n = 0;
    for (var i = 0; i < commands.length; i++) {
        if (commands[i].indexOf('run-agent.sh --continue') !== -1) n++;
    }
    return n;
}

suite('developBugAndCreatePR > resume-before-cold-reset (gh-775)', function () {

    test('AC2+AC3 (bug): missing response.md + resumable → ONE bounded resume lands the deliverable → normal continuation, no reset, no partial-work push', function () {
        var state = { files: null };
        var loaded = loadBugForMissingResponseResume({
            wrapperImpl: function () {
                state.files['outputs/response.md'] = '### Root Cause Analysis\nBug fixed with a regression test.\n';
                return '';
            }
        });
        state.files = loaded.files;

        var result = loaded.mod.action({
            ticket: { key: 'TS-50', fields: { summary: 'hung verification, bug fixed', description: '', labels: [] } },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_development_triggered',
                    feedbackLoop: { enabled: true }
                }
            }
        });

        assert.equal(bugWrapperCommandCount(loaded.commands), 1,
            'exactly one bounded wrapper invocation — commands: ' + JSON.stringify(loaded.commands));
        var wrapper = loaded.commands.filter(function (c) { return c.indexOf('run-agent.sh --continue') !== -1; })[0];
        assert.equal(wrapper,
            'bash -c "timeout -k 60 2400 bash agents/scripts/run-agent.sh --continue outputs/feedback/TS-50_missing_response.md"');
        assert.equal(loaded.delegatedCount(), 1,
            'the landed deliverable continues into the normal development path');
        assert.equal(result.path, 'delegated');
        assert.equal(loaded.comments.length, 0, 'no interrupted comment');
        assert.deepEqual(loaded.moves, [], 'no status move');
        var pushCommands = loaded.commands.filter(function (c) { return c.indexOf('git push') === 0; });
        assert.equal(pushCommands.length, 0,
            'no partial-work push — the resumed session finishes and the post-action commits normally');
    });

    test('AC4 (bug): resume fails → the existing interrupted sequence runs verbatim (partial-work push, comment, reset, wip removal, throw)', function () {
        var loaded = loadBugForMissingResponseResume({
            wrapperImpl: function () {
                throw new Error('Command failed (exit code 124): timeout -k 60 2400 ...');
            }
        });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-51', fields: { summary: 'resume timed out', description: '', labels: [] } },
                metadata: { contextId: 'bug_development' },
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_bug_development_triggered',
                        feedbackLoop: { enabled: true }
                    }
                }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught && caught.interruptedReset === true,
            'the verbatim cold reset still fails the run');
        assert.equal(bugWrapperCommandCount(loaded.commands), 1, 'exactly one bounded attempt');
        assert.ok(loaded.commands.indexOf('git checkout -B ai/TS-51') !== -1,
            'partial analysis work is still switched to the development branch');
        assert.ok(loaded.commands.indexOf('git push -u origin ai/TS-51 --force-with-lease') !== -1,
            'partial analysis work is still pushed before the reset');
        assert.deepEqual(loaded.moves, [{ key: 'TS-51', statusName: 'Ready For Development' }]);
        assert.deepEqual(loaded.removed, [
            { key: 'TS-51', label: 'bug_development_wip' },
            { key: 'TS-51', label: 'sm_bug_development_triggered' }
        ]);
        assert.equal(loaded.comments.length, 1);
        assert.contains(loaded.comments[0].comment, 'Development Interrupted');
    });

    test('AC5 (bug): not resumable → cold reset directly, NO wrapper invocation', function () {
        var loaded = loadBugForMissingResponseResume();

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-52', fields: { summary: 'not resumable', description: '', labels: [] } },
                metadata: { contextId: 'bug_development' },
                jobParams: { customParams: { removeLabel: 'sm_bug_development_triggered' } }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught && caught.interruptedReset === true);
        assert.equal(bugWrapperCommandCount(loaded.commands), 0,
            'no wrapper invocation without the feedback-loop opt-in');
        assert.deepEqual(loaded.moves, [{ key: 'TS-52', statusName: 'Ready For Development' }]);
    });


    test('routes through the SHARED recoverMissingResponse gate — the bug leg never calls feedbackLoop directly', function () {
        var state = { files: null };
        var loaded = loadBugForMissingResponseResume({
            wrapperImpl: function () {
                state.files['outputs/response.md'] = '### Root Cause Analysis\nBug fixed with a regression test.\n';
                return '';
            }
        });
        state.files = loaded.files;

        var result = loaded.mod.action({
            ticket: { key: 'TS-53', fields: { summary: 'hung verification, bug fixed', description: '', labels: [] } },
            metadata: { contextId: 'bug_development' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_development_triggered',
                    feedbackLoop: { enabled: true }
                }
            }
        });

        assert.equal(loaded.recoverCalls.length, 1,
            'the bug leg must delegate to developTicket.recoverMissingResponse (the shared fatal-first gate)');
        assert.equal(loaded.recoverCalls[0].ticketKey, 'TS-53');
        assert.equal(loaded.recoverCalls[0].customParams.feedbackLoop.enabled, true,
            'the leg feedback-loop opt-in rides into the shared gate');
        assert.equal(loaded.recoverCalls[0].developmentSummary, '',
            'the raw CLI response rides in as the fatal-text heuristic input');
        assert.equal(loaded.recoverCalls[0].cliHasFatalError, false);
        assert.equal(loaded.recoverCalls[0].cliErrorMessage, null);
        assert.equal(loaded.directFeedbackLoopCalls.length, 0,
            'the bug leg must NOT call feedbackLoop.resumeOnceForMissingResponse directly');
        assert.equal(bugWrapperCommandCount(loaded.commands), 1,
            'the shared gate still makes the ONE bounded attempt — commands: ' + JSON.stringify(loaded.commands));
        assert.equal(result.path, 'delegated');
    });

    test('AC6 (bug): fatal CLI signal rides into the shared gate — resume preempted, fatal error propagates', function () {
        var loaded = loadBugForMissingResponseResume();

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-54', fields: { summary: 'missing binary', description: '', labels: [] } },
                metadata: { contextId: 'bug_development' },
                currentCliHasFatalError: true,
                currentCliErrorMessage: 'cursor-agent not found in PATH',
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_bug_development_triggered',
                        feedbackLoop: { enabled: true }
                    }
                }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'the fatal CLI/environment class must fail the job explicitly');
        assert.equal(caught && caught.fatalCliEnvironment, true, 'the fatal marker survives the bug post-action');
        assert.equal(loaded.recoverCalls[0].cliHasFatalError, true,
            'the bug leg passes its own CLI outcome signal into the shared gate');
        assert.equal(bugWrapperCommandCount(loaded.commands), 0,
            'the resume never fires for the fatal class (AC6)');
        assert.ok(loaded.comments.some(function (c) { return c.comment.indexOf('AI CLI Environment Failure') !== -1; }),
            'the fatal environment comment is posted');
        assert.deepEqual(loaded.moves, [], 'no status move on a fatal environment error');
        var pushCommands = loaded.commands.filter(function (c) { return c.indexOf('git push') === 0; });
        assert.equal(pushCommands.length, 0, 'no doomed partial-work push on a fatal environment error');
    });

    test('AC6 (bug): text-heuristic fatal class (exit 127) rides the raw CLI response through the shared gate', function () {
        var loaded = loadBugForMissingResponseResume();

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-55', fields: { summary: 'missing binary', description: '', labels: [] } },
                metadata: { contextId: 'bug_development' },
                response: 'Command failed (exit code 127): cursor-agent: not found in PATH',
                jobParams: {
                    customParams: {
                        removeLabel: 'sm_bug_development_triggered',
                        feedbackLoop: { enabled: true }
                    }
                }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught && caught.fatalCliEnvironment === true,
            'the exit-127 text heuristic must preempt the resume on the bug leg too');
        assert.equal(loaded.recoverCalls[0].developmentSummary,
            'Command failed (exit code 127): cursor-agent: not found in PATH');
        assert.equal(bugWrapperCommandCount(loaded.commands), 0, 'no doomed wrapper invocation');
    });
});

// ── gh-1003: pure helpers extracted from action ──────────────────────
// The CRAP refactor (gh-1003) splits pure parse/build/decide helpers out of
// action (CC 78, CRAP 212.7). These tests pin the helpers' behaviour directly
// and characterize the paths the extraction re-plumbs.
suite('developBugAndCreatePR > pure helpers (gh-1003)', function () {

    test('resolveActualParams: ticket-bearing params win, else jobParams, else params', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        assert.equal(typeof mod.resolveActualParams, 'function',
            'gh-1003 extracts the actual-params resolution for direct characterization');
        var withTicket = { ticket: { key: 'TS-1' } };
        assert.equal(mod.resolveActualParams(withTicket), withTicket);
        var wrapped = { jobParams: { ticket: { key: 'TS-2' } } };
        assert.equal(mod.resolveActualParams(wrapped), wrapped.jobParams);
        var bare = { ticketKey: 'TS-3' };
        assert.equal(mod.resolveActualParams(bare), bare);
    });

    test('findOpenPrForBranch matches head.ref across multiple PRs and tolerates nulls', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        assert.equal(typeof mod.findOpenPrForBranch, 'function',
            'gh-1003 extracts the open-PR finder for direct characterization');
        var prs = [
            { number: 1, head: { ref: 'ai/TS-1' } },
            { number: 2, head: { ref: 'ai/TS-2' }, html_url: 'https://github.com/acme/widgets/pull/2' },
            null,
            { number: 3 }
        ];
        var found = mod.findOpenPrForBranch(prs, 'ai/TS-2');
        assert.equal(found.number, 2);
        assert.equal(mod.findOpenPrForBranch(prs, 'ai/TS-9'), undefined);
        assert.equal(mod.findOpenPrForBranch([], 'ai/TS-2'), undefined);
        assert.equal(mod.findOpenPrForBranch(null, 'ai/TS-2'), undefined);
    });

    test('buildPrAlreadyOpenComment renders heading, PR url and In Review bold', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        var comment = mod.buildPrAlreadyOpenComment('TS-77', 'https://github.com/acme/widgets/pull/77');
        assert.contains(comment, 'PR Already Open');
        assert.contains(comment, 'https://github.com/acme/widgets/pull/77');
        assert.contains(comment, '*In Review*');
    });

    test('buildBlockedComment renders reason, one bullet per tried entry, and needs', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        var comment = mod.buildBlockedComment('TS-1', {
            reason: 'Tooling unreachable',
            tried: ['Read input files', 'Reproduced locally'],
            needs: 'A working session'
        });
        assert.contains(comment, 'Bug Cannot Be Fixed Automatically');
        assert.contains(comment, 'Tooling unreachable');
        assert.contains(comment, '- Read input files');
        assert.contains(comment, '- Reproduced locally');
        assert.contains(comment, 'A working session');
    });

    test('buildBlockedComment defaults a missing reason and skips empty tried/needs', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        var comment = mod.buildBlockedComment('TS-1', { tried: [], needs: '' });
        assert.contains(comment, '(see details below)');
        assert.notContains(comment, 'Attempted');
        assert.notContains(comment, 'Needs from human');
    });

    test('buildAlreadyFixedComment: codegraph wording variants and optional fields', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        var full = mod.buildAlreadyFixedComment('TS-1', {
            rca: 'Off-by-one in the pager',
            commit: 'abc123',
            description: 'Verified on main'
        }, true);
        assert.contains(full, 'Bug Already Fixed');
        assert.contains(full, 'Off-by-one in the pager');
        assert.contains(full, '{code}abc123{code}');
        assert.contains(full, 'Verified on main');
        assert.contains(full, 'Moved to *Done*.');

        var noGraph = mod.buildAlreadyFixedComment('TS-1', { commit: 'abc123' }, false);
        assert.contains(noGraph, 'No CodeGraph usage was recorded');
        assert.notContains(noGraph, 'Root Cause');

        var minimal = mod.buildAlreadyFixedComment('TS-1', {}, true);
        assert.contains(minimal, 'Bug Already Fixed');
        assert.notContains(minimal, 'Root Cause');
        assert.notContains(minimal, 'Fixed in commit');
    });

    test('buildInterruptedComment: partial-work vs no-work wording', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        var withWork = mod.buildInterruptedComment('TS-1', true);
        assert.contains(withWork, 'Development Interrupted');
        assert.contains(withWork, 'Partial analysis work was saved to the branch.');
        var withoutWork = mod.buildInterruptedComment('TS-1', false);
        assert.contains(withoutWork, 'No partial work was produced.');
    });

    test('gh-1121: buildInterruptedComment names the provider outage instead of guessing a rate limit', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        var outage = {
            kind: 'provider_transient',
            models: ['zai/glm-5.3-flash', 'kimi-for-coding'],
            codes: ['500', '429']
        };
        var comment = mod.buildInterruptedComment('TS-2', true, outage);
        assert.contains(comment, 'Provider outage (zai/glm-5.3-flash, kimi-for-coding, 500, 429) — reset for retry');
        assert.contains(comment, 'Partial analysis work was saved to the branch.');
        assert.notContains(comment.toLowerCase(), 'rate limit',
            'the comment must not blame a rate limit when the cause was a 500');
    });

    test('isMeaningfulStatusLine keeps real work and drops factory-kit, runtime and script noise', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        assert.equal(typeof mod.isMeaningfulStatusLine, 'function',
            'gh-1003 extracts the porcelain-line filter for direct characterization');
        assert.equal(mod.isMeaningfulStatusLine(''), false);
        assert.equal(mod.isMeaningfulStatusLine('   '), false);
        assert.equal(mod.isMeaningfulStatusLine('A  outputs/rca.md'), true);
        assert.equal(mod.isMeaningfulStatusLine(' M js/foo.js'), true);
        assert.equal(mod.isMeaningfulStatusLine('?? factory-kit/'), false);
        assert.equal(mod.isMeaningfulStatusLine('A  factory-kit/pom.xml'), false);
        assert.equal(mod.isMeaningfulStatusLine('?? .dmtools/credential-helper.log'), false);
        assert.equal(mod.isMeaningfulStatusLine('?? .dmtools/fa-sessions/'), false);
        assert.equal(mod.isMeaningfulStatusLine('?? .dmtools-session-output.log'), false);
        assert.equal(mod.isMeaningfulStatusLine('Script started on 2026-10-17'), false);
        assert.equal(mod.isMeaningfulStatusLine('Script done on 2026-10-17'), false);
    });

    test('detectGitChanges: meaningful status → true; runtime-only status → false; cli failure → false', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        assert.equal(typeof mod.detectGitChanges, 'function',
            'gh-1003 extracts the staging/status probe for direct characterization');
        var calls = [];
        var cli = function (args) {
            calls.push(args.command);
            if (args.command === 'git status --porcelain') return 'A  outputs/rca.md\n';
            if (args.command.indexOf('git check-ignore') === 0) throw new Error('Command execution failed (exit code 1)');
            return '';
        };
        assert.equal(mod.detectGitChanges(cli), true);
        assert.ok(calls.some(function (c) { return c.indexOf('git ls-files -- ') === 0; }),
            'runtime-artifact untrack probe runs first');
        assert.ok(calls.some(function (c) { return c.indexOf('git add . --') === 0; }),
            'staging add with pathspec exclusions runs');
        assert.ok(calls.some(function (c) { return c === 'git status --porcelain'; }),
            'porcelain status runs');

        var runtimeOnly = function (args) {
            if (args.command === 'git status --porcelain') {
                return '?? .dmtools/credential-helper.log\n?? .dmtools-session-output.log\n';
            }
            if (args.command.indexOf('git check-ignore') === 0) throw new Error('Command execution failed (exit code 1)');
            return '';
        };
        assert.equal(mod.detectGitChanges(runtimeOnly), false,
            'runtime-artifact-only status means no agent work');

        var failing = function (args) {
            if (args.command.indexOf('git add') === 0) throw new Error('boom');
            return '';
        };
        assert.equal(mod.detectGitChanges(failing), false,
            'a staging failure degrades to no-git-changes, never a throw');
    });

    test('decidePartialPush: branch, checkout and force-with-lease decisions (multi-case)', function () {
        var mod = loadDevelopBugAndCreatePR({}).mod;
        assert.equal(typeof mod.decidePartialPush, 'function',
            'gh-1003 extracts the partial-push planner for direct characterization');
        assert.deepEqual(mod.decidePartialPush('main', 'ai/TS-1', 'main'),
            { branch: 'ai/TS-1', needsCheckout: true, force: true },
            'partial work on main must switch branches and force-push');
        assert.deepEqual(mod.decidePartialPush('ai/TS-1', 'ai/TS-1', 'main'),
            { branch: 'ai/TS-1', needsCheckout: false, force: false },
            'already on the development branch: plain push');
        assert.deepEqual(mod.decidePartialPush('', 'ai/TS-1', 'main'),
            { branch: 'ai/TS-1', needsCheckout: true, force: false });
        assert.deepEqual(mod.decidePartialPush('master', null, 'main'),
            { branch: 'master', needsCheckout: false, force: true });
        assert.deepEqual(mod.decidePartialPush('feature-x', null, 'main'),
            { branch: 'feature-x', needsCheckout: false, force: false });
        assert.deepEqual(mod.decidePartialPush('develop', 'develop', 'develop'),
            { branch: 'develop', needsCheckout: false, force: true });
        assert.equal(mod.decidePartialPush('', null, 'main'), null,
            'no current and no expected branch → nothing to push');
    });
});

// ── gh-1003: pr-already-open path + interrupted-leg push planning ────
suite('developBugAndCreatePR > pr-already-open and partial-push paths (gh-1003)', function () {

    // gh-1003: the PR-scan shape needs an scm stub — with the real scm the
    // node harness's github_list_prs network guard always throws inside
    // listPrs, so existing suites never reach Path 0.
    function loadBugWithScmStub(scmStub, cliImpl, extraMocks) {
        var comments = [];
        var moves = [];
        var removed = [];
        var delegated = 0;
        var commentMarkupModuleLocal = loadModule('js/common/commentMarkup.js',
            makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
        var gitStagingModuleLocal = loadModule('js/common/gitStaging.js');
        var allMocks = Object.assign({
            file_read: function (args) { throw new Error('missing ' + args.path); },
            cli_execute_command: cliImpl || function () { return ''; },
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { moves.push(args); },
            jira_remove_label: function (args) { removed.push(args); }
        }, extraMocks || {});
        var loaderWithScmStub = Object.assign({}, configLoaderModule, {
            createScm: function () { return scmStub; }
        });
        var mod = loadModule(
            'js/developBugAndCreatePR.js',
            makeRequire({
                './common/toolchainSummary.js': { withToolchainLine: stubToolchainLine },
                './config.js': configModule,
                './common/gitStaging.js': gitStagingModuleLocal,
                './common/quotaCircuitBreaker.js': loadModule('js/common/quotaCircuitBreaker.js'),
                './configLoader.js': loaderWithScmStub,
                './common/outputFiles.js': loadModule('js/common/outputFiles.js', makeRequire({}), allMocks),
                './common/trackers.js': loadTrackersDev(allMocks),
                './developTicketAndCreatePR.js': {
                    action: function () { delegated++; return { success: true, path: 'delegated' }; },
                    classifyInterruptedText: function (e, r) { return String(e || '') + '\n' + String(r || ''); },
                    // Never invoked on the pr-already-open / delegated paths
                    // under test; the REAL shared helper is pinned by the
                    // gh-742 suite through loadDevelopBugAndCreatePR.
                    throwInterruptedReset: function (ticketKey) {
                        var err = new Error(ticketKey + ' was reset for retry');
                        err.interruptedReset = true;
                        throw err;
                    },
                    recoverMissingResponse: function () { return null; }
                },
                './common/commentMarkup.js': commentMarkupModuleLocal
            }),
            allMocks
        );
        return { mod: mod, comments: comments, moves: moves, removed: removed, delegatedCount: function () { return delegated; } };
    }

    test('existing open PR for the expected branch → move to In Review, remove labels, skip development', function () {
        var loaded = loadBugWithScmStub({
            listPrs: function (state) {
                return [
                    { number: 1, head: { ref: 'ai/TS-76' }, html_url: 'https://github.com/acme/widgets/pull/76' },
                    { number: 2, head: { ref: 'ai/TS-77' }, html_url: 'https://github.com/acme/widgets/pull/77' }
                ];
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-77', fields: { summary: 'PR already open', description: '', labels: [] } },
            metadata: { contextId: 'bug_development' },
            jobParams: { customParams: { removeLabel: 'sm_bug_development_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'pr_already_open');
        assert.equal(loaded.delegatedCount(), 0, 'development must be skipped entirely');
        assert.deepEqual(loaded.moves, [{ key: 'TS-77', statusName: 'In Review' }]);
        assert.equal(loaded.comments.length, 1);
        assert.contains(loaded.comments[0].comment, 'https://github.com/acme/widgets/pull/77');
        assert.deepEqual(loaded.removed, [
            { key: 'TS-77', label: 'bug_development_wip' },
            { key: 'TS-77', label: 'sm_bug_development_triggered' }
        ]);
    });

    test('no matching open PR → development proceeds (delegated)', function () {
        var loaded = loadBugWithScmStub({
            listPrs: function () { return [{ number: 1, head: { ref: 'ai/TS-76' }, html_url: 'x' }]; }
        }, function (args) {
            if (args.command === 'git status --porcelain') return 'A  js/foo.js\n';
            if (args.command.indexOf('git check-ignore') === 0) throw new Error('Command execution failed (exit code 1)');
            return '';
        }, {
            file_read: function (args) {
                if (args.path === 'outputs/response.md') return '### What changed\n- fix\n';
                throw new Error('missing ' + args.path);
            }
        });
        var result = loaded.mod.action({
            ticket: { key: 'TS-77', fields: { summary: 'normal', description: '', labels: [] } },
            metadata: { contextId: 'bug_development' },
            jobParams: { customParams: { removeLabel: 'sm_bug_development_triggered' } }
        });
        assert.equal(result.path, 'delegated');
        assert.equal(loaded.delegatedCount(), 1);
        assert.deepEqual(loaded.moves, [], 'no status move on the normal path — the delegate owns it');
    });

    test('interrupted leg already on its development branch pushes without checkout or force', function () {
        var commands = [];
        var loaded = loadDevelopBugAndCreatePR({
            cli_execute_command: function (args) {
                commands.push(args.command);
                if (args.command.indexOf('gh pr list --head ') === 0) return '';
                if (args.command.indexOf('git check-ignore') === 0) throw new Error('Command execution failed (exit code 1)');
                if (args.command === 'git status --porcelain') return 'A  outputs/rca.md\n';
                if (args.command === 'git branch --show-current') return 'ai/TS-1401\n';
                return '';
            }
        });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-1401', fields: { summary: 'interrupted on branch', description: '', labels: [] } },
                metadata: { contextId: 'bug_development' },
                jobParams: { customParams: { removeLabel: 'sm_bug_development_triggered' } }
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught && caught.interruptedReset === true);
        assert.ok(commands.indexOf('git push -u origin ai/TS-1401') !== -1,
            'plain push to the current development branch — commands: ' + JSON.stringify(commands));
        assert.notOk(commands.some(function (c) { return c.indexOf('git checkout -B') === 0; }),
            'no branch switch when already on the development branch');
        assert.notOk(commands.some(function (c) { return c.indexOf('--force-with-lease') !== -1; }),
            'no force push when the current branch is not base/main/master');
        assert.deepEqual(loaded.moves, [{ key: 'TS-1401', statusName: 'Ready For Development' }]);
    });
});
