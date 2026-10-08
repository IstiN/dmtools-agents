/**
 * Unit tests for js/developBugAndCreatePR.js.
 */

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

// gh-742 rework: the bug flow's interrupted path calls
// developTicket.throwInterruptedReset, so the mock below exposes the REAL
// exported helper (single source of truth for the marker/message contract)
// instead of a byte-copy. The bug tests never invoke the delegated
// developTicketAndCreatePR action(), so its stubbed deps are never touched.
var developTicketRealModule = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
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
        './configLoader.js': configLoaderModule,
        './config.js': configModule,
        './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
        './common/commentMarkup.js': commentMarkupModule
    }, { './common/trackers.js': trackersWith(_m) })), _m); })({});

    var mod = loadModule(
        'js/developBugAndCreatePR.js',
        makeRequire({
            './config.js': configModule,
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './common/outputFiles.js': outputFiles,
            './common/trackers.js': loadTrackersDev(allMocks),
            './developTicketAndCreatePR.js': {
                action: function() { return { success: true, path: 'delegated' }; },
                throwInterruptedReset: developTicketRealModule.throwInterruptedReset,
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
                './common/trackers.js': loadTrackersDev(inlineMocks),
                './config.js': configModule,
                './common/gitStaging.js': gitStagingMod,
                './configLoader.js': configLoaderModule,
                './common/outputFiles.js': loadModule('js/common/outputFiles.js', makeRequire({}), {
                    file_read: function (args) {
                        if (args.path === 'outputs/response.md') return '### What changed\n- fix\n';
                        throw new Error('missing ' + args.path);
                    }
                }),
                './developTicketAndCreatePR.js': { action: function () { throw marked; } },
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
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': { cleanCommandOutput: function (output) { return (output || '').trim(); } },
            './common/submodules.js': {},
            './common/feedbackLoop.js': realFeedbackLoop,
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': realOutputFiles,
            './cacheToReleases.js': {},
            './common/gitStaging.js': gitStagingModuleLocal,
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
            './common/trackers.js': loadTrackersDev(spyMocks),
            './config.js': configModule,
            './common/gitStaging.js': gitStagingModuleLocal,
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
