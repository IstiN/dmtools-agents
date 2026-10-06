/**
 * Unit tests for js/developBugAndCreatePR.js.
 */

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
var developTicketRealModule = loadModule(
    'js/developTicketAndCreatePR.js',
    makeRequire({
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
    }),
    {}
);

    var mod = loadModule(
        'js/developBugAndCreatePR.js',
        makeRequire({
            './config.js': configModule,
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './common/outputFiles.js': outputFiles,
            './developTicketAndCreatePR.js': {
                action: function() { return { success: true, path: 'delegated' }; },
                throwInterruptedReset: developTicketRealModule.throwInterruptedReset
            }
        ,
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
        var mod = loadModule(
            'js/developBugAndCreatePR.js',
            makeRequire({
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
                './common/commentMarkup.js': commentMarkupMod
            }),
            {
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
            }
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
