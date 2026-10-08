/**
 * Unit tests for js/developTicketAndCreatePR.js failure recovery.
 */

// Declared once at module scope — every loader below references it in its
// makeRequire() map, so it must exist before any of them run.
var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var gitStagingModule = loadModule('js/common/gitStaging.js');

function loadDevelopTicketAndCreatePR(mocks, feedbackLoopOverrides) {
    return loadModule(
        'js/developTicketAndCreatePR.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': { cleanCommandOutput: function (output) { return (output || '').trim(); } },
            './common/submodules.js': {},
            './common/feedbackLoop.js': Object.assign({
                runQualityGates: function () { return { success: true }; },
                runPolicyGates: function () { return { success: true }; },
                runPostPublishGates: function () { return { success: true }; },
                resumeAgent: function () { return { attempted: false }; },
                resumeOnceForMissingResponse: function () { return { attempted: false }; }
            }, feedbackLoopOverrides || {}),
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': { readOutputFile: function () { return null; } },
            './cacheToReleases.js': {},
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } }
            ,
            './common/commentMarkup.js': commentMarkupModule,
        }),
        Object.assign({
            cli_execute_command: function () { return ''; },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        }, mocks || {})
    );
}

// Loads developTicketAndCreatePR.js with the REAL common/pullRequest.js and
// common/submodules.js helpers (instead of the bare stubs above) so tests can
// drive performGitOperations() all the way to its "No changes were made" path,
// which the bare stubs can't reach (they lack readStagedDiffStat/buildOriginFetchCommand).
function loadDevelopTicketAndCreatePRWithRealGitHelpers(mocks) {
    var realPrHelper = loadModule('js/common/pullRequest.js', makeRequire({
        './common/commentMarkup.js': commentMarkupModule,
        './mergeState.js': loadModule('js/common/mergeState.js'),
    }), {});
    return loadModule(
        'js/developTicketAndCreatePR.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': realPrHelper,
            './common/submodules.js': { pushManagedSubmodules: function () { } },
            './common/feedbackLoop.js': {
                runQualityGates: function () { return { success: true }; },
                runPolicyGates: function () { return { success: true }; },
                runPostPublishGates: function () { return { success: true }; },
                resumeAgent: function () { return { attempted: false }; },
                resumeOnceForMissingResponse: function () { return { attempted: false }; }
            },
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': { readOutputFile: function () { return null; } },
            './cacheToReleases.js': {},
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } }
            ,
            './common/commentMarkup.js': commentMarkupModule,
        }),
        Object.assign({
            cli_execute_command: function () { return ''; },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        }, mocks || {})
    );
}

// Common git-command mock shared by the two tests below: simulates a ticket
// branch with no staged/committed/pushed changes at all — i.e. the CLI agent
// never actually ran (which is exactly what happens when the AI CLI binary is
// missing from the runner, exit code 127).
function noChangesGitCommandMock(ticketKey, branchName) {
    return function (args) {
        var command = args.command;
        if (command.indexOf('gh pr list --head ' + branchName) === 0) return '';
        if (command === 'git branch --show-current') return branchName;
        if (command === 'git diff --cached --stat') return '';
        if (command.indexOf('git rev-list --count') === 0) return '0';
        return '';
    };
}

suite('developTicketAndCreatePR > failure recovery', function () {

    test('resets ticket and removes retry-blocking labels when git configuration fails', function () {
        var movedTo = [];
        var removedLabels = [];
        var comments = [];
        var commands = [];
        var mod = loadDevelopTicketAndCreatePR({
            cli_execute_command: function (args) {
                commands.push(args.command);
                if (args.command.indexOf('gh pr list --head ai/TS-1') === 0) return '';
                if (args.command === 'git config user.name "AI Teammate"') throw new Error('git config failed');
                return '';
            },
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function (args) { removedLabels.push(args.label); }
        });

        var result = mod.action({
            ticket: {
                key: 'TS-1',
                fields: { summary: 'Recover dev failure', description: '', labels: [] }
            },
            metadata: { contextId: 'sm_bug_development' },
            customParams: {
                removeLabel: 'sm_bug_development_triggered',
                removeLabels: ['extra_retry_lock']
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'development-reset-for-retry');
        assert.deepEqual(movedTo, ['Ready For Development']);
        assert.deepEqual(
            removedLabels,
            ['sm_bug_development_triggered', 'extra_retry_lock', 'sm_bug_development_wip']
        );
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Git Configuration');
        assert.ok(commands.length > 0, 'expected git/gh commands to run');
    });

    test('still resets ticket and posts an honest error comment when feedbackLoop.resumeAgent itself throws (e.g. blocked by CLI_ALLOWED_COMMANDS)', function () {
        var movedTo = [];
        var comments = [];
        var mod = loadDevelopTicketAndCreatePR(
            {
                cli_execute_command: function (args) {
                    if (args.command.indexOf('gh pr list --head ai/TS-2') === 0) return '';
                    if (args.command === 'git branch --show-current') {
                        // Simulate an unrelated, unexpected failure reaching the outer catch —
                        // e.g. a transient git/filesystem error mid-workflow.
                        throw new Error('simulated unexpected git failure');
                    }
                    return '';
                },
                jira_post_comment: function (args) { comments.push(args); },
                jira_move_to_status: function (args) { movedTo.push(args.statusName); },
                jira_remove_label: function () { }
            },
            {
                // Simulate the real-world bug: the feedback loop's own self-invocation
                // (mkdir/bash/run-agent.sh --continue) gets blocked by a
                // misconfigured CLI_ALLOWED_COMMANDS whitelist and throws instead of
                // returning { attempted: false }.
                resumeAgent: function () { throw new Error('Security violation: Command not whitelisted: bash'); }
            }
        );

        var result = mod.action({
            ticket: {
                key: 'TS-2',
                fields: { summary: 'Recover from broken feedback-loop retry', description: '', labels: [] }
            },
            metadata: { contextId: 'story_development' },
            customParams: {}
        });

        // The bug this guards against: an uncaught throw from resumeAgent used to skip
        // resetDevelopmentForRetry() entirely, leaving the ticket silently stuck in
        // "In Development" with no comment at all, while the outer job still reported success.
        assert.equal(result.success, true);
        assert.equal(result.path, 'development-reset-for-retry');
        assert.deepEqual(movedTo, ['Ready For Development']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Development Workflow Error');
    });

    test('fails the job explicitly (throws) instead of resetting for retry when the AI CLI binary is missing from the runner (exit code 127)', function () {
        var movedTo = [];
        var removedLabels = [];
        var comments = [];
        // Mirrors the real dmtools "response" text observed when run-agent.sh can't
        // find the configured provider's CLI binary (e.g. cursor-agent not installed).
        var fatalResponse = 'CLI command executed but did not produce output file:\n' +
            'CLI Command: ./agents/scripts/run-agent.sh "prompt"\n' +
            "Error: Failed to execute CLI command './agents/scripts/run-agent.sh \"prompt\"': " +
            'Command failed (exit code 127): ./agents/scripts/run-agent.sh "prompt"\n' +
            'Output:\nAI Agent Provider: cursor\nError: cursor-agent not found in PATH\n';

        var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers({
            cli_execute_command: noChangesGitCommandMock('TS-3', 'ai/TS-3'),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function (args) { removedLabels.push(args.label); }
        });

        assert.throws(function () {
            mod.action({
                ticket: { key: 'TS-3', fields: { summary: 'Broken CLI', description: '', labels: [] } },
                metadata: { contextId: 'story_development' },
                customParams: {},
                response: fatalResponse
            });
        }, 'expected action() to throw so the CI job fails explicitly instead of silently continuing');

        assert.equal(movedTo.length, 0, 'ticket must not be silently reset to Ready For Development');
        assert.equal(removedLabels.length, 0, 'retry-blocking labels must not be removed on a fatal environment error');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'AI CLI Environment Failure');
    });

    test('gh-742: ordinary interrupted response (no fatal environment signature) still resets the ticket but now FAILS the leg (thrown, marked)', function () {
        // Live dmtools-dart gh-350 (run 37316571468, 2026-10-05): the
        // interrupted-reset path returned { success: true } — a green no-PR
        // leg the wrapper read as "dev done", so agent:review was armed on
        // an issue with no PR and no retry ever fired. The reset must stay
        // (comment + Ready For Development), but the run must go RED.
        var movedTo = [];
        var comments = [];
        var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers({
            cli_execute_command: noChangesGitCommandMock('TS-4', 'ai/TS-4'),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); }
        });

        var caught = null;
        try {
            mod.action({
                ticket: { key: 'TS-4', fields: { summary: 'Rate limited', description: '', labels: [] } },
                metadata: { contextId: 'story_development' },
                customParams: {},
                response: 'Agent hit a rate limit and stopped mid-analysis.'
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'an interrupted leg must fail the run (throw), not return plain success');
        assert.ok(caught && caught.interruptedReset === true,
            'thrown error carries the interruptedReset marker (outer catch rethrows it)');
        assert.deepEqual(movedTo, ['Ready For Development'],
            'ticket is still reset for retry before the leg fails');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Development Interrupted');
    });

    test('fails the job explicitly (throws) when currentCliHasFatalError is set, even though the response text matches no known fatal-error signature (e.g. a provider HTTP 5xx)', function () {
        var movedTo = [];
        var removedLabels = [];
        var comments = [];

        var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers({
            cli_execute_command: noChangesGitCommandMock('TS-5', 'ai/TS-5'),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function (args) { removedLabels.push(args.label); }
        });

        assert.throws(function () {
            mod.action({
                ticket: { key: 'TS-5', fields: { summary: 'Provider outage', description: '', labels: [] } },
                metadata: { contextId: 'story_development' },
                customParams: {},
                // Same ordinary-looking text as the "interrupted" test above — matches NONE of
                // the exit-code-127/PATH/unknown-provider regexes — but Teammate's own
                // authoritative signal says the CLI call actually failed fatally (e.g. a DIAL/
                // provider HTTP 502). Proves the flag alone drives the fatal path, not text-sniffing.
                response: 'Agent hit a rate limit and stopped mid-analysis.',
                currentCliHasFatalError: true,
                currentCliErrorMessage: '502: Failed to connect to upstream server'
            });
        }, 'expected action() to throw so the CI job fails explicitly instead of silently resetting for retry');

        assert.equal(movedTo.length, 0, 'ticket must not be silently reset to Ready For Development');
        assert.equal(removedLabels.length, 0, 'retry-blocking labels must not be removed on a fatal CLI/provider error');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'AI CLI Environment Failure');
        assert.contains(comments[0].comment, '502: Failed to connect to upstream server');
    });

});

suite('developTicketAndCreatePR > staging hygiene (factory kit)', function () {
    var realLoadProjectConfig = configLoaderModule.loadProjectConfig;

    test('git add excludes the factory-kit nested repo — a gitlink without a commit must not kill staging (gh-1000)', function () {
        // Live 2026-10-03 (fa gh-1000): the factory workflow materializes a
        // NESTED git repo at $GITHUB_WORKSPACE/factory-kit; the PR
        // post-action's `git add .` tried to stage that gitlink and died
        // with exit 128 ("'factory-kit/' does not have a commit checked
        // out") AFTER a fully green dev leg — no PR, ticket rolled back.
        // The staging pathspec must exclude factory-kit like it excludes
        // copilot-sessions.
        var staging = null;
        var commands = [];
        var base = noChangesGitCommandMock('TS-9', 'ai/TS-9');
        // This repo's test .dmtools/config.js carries no git section; the
        // production one always does. Wrap the real loader to guarantee the
        // git defaults the staging path reads (resolvePRTargetBranch).
        var loaderWithGitDefaults = Object.assign({}, configLoaderModule, {
            loadProjectConfig: function (p) {
                var c = realLoadProjectConfig(p) || {};
                if (!c.git) c.git = { baseBranch: 'main' };
                return c;
            }
        });
        var mod = loadModule(
            'js/developTicketAndCreatePR.js',
            makeRequire({
                './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
                './common/pullRequest.js': { cleanCommandOutput: function (output) { return (output || '').trim(); } },
                './common/submodules.js': { pushManagedSubmodules: function () {} },
                './common/feedbackLoop.js': {
                    runQualityGates: function () { return { success: true }; },
                    runPolicyGates: function () { return { success: true }; },
                    runPostPublishGates: function () { return { success: true }; },
                    resumeAgent: function () { return { attempted: false }; },
                    resumeOnceForMissingResponse: function () { return { attempted: false }; }
                },
                './common/autoStart.js': { triggerSmIfIdle: function () { } },
                './common/outputFiles.js': { readOutputFile: function () { return null; } },
                './cacheToReleases.js': {},
                './common/gitStaging.js': gitStagingModule,
                './configLoader.js': loaderWithGitDefaults,
                './config.js': configModule,
                './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
                './common/commentMarkup.js': commentMarkupModule
            }),
            {
                cli_execute_command: function (args) {
                    commands.push(args.command);
                    if (args.command.indexOf('git check-ignore') === 0) {
                        // gh-683 probe: not-ignored repo → keep exclusions
                        throw new Error('Command execution failed (exit code 1)');
                    }
                    if (args.command.indexOf('git add . --') === 0) {
                        staging = args.command;
                        throw new Error('staging probe reached');
                    }
                    return base(args);
                },
                jira_post_comment: function () {},
                jira_move_to_status: function () {},
                jira_remove_label: function () {}
            }
        );

        // gh-683: the staging failure now fails the whole leg (thrown
        // gitOperationsFailure) instead of returning success-with-comment.
        assert.throws(function () {
            mod.action({
                ticket: { key: 'TS-9', fields: { summary: 'staging hygiene', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: {}
            });
        }, 'a Git-Operations failure must fail the leg, not return success');

        assert.ok(staging, 'staging command executed — commands seen: ' + JSON.stringify(commands));
        assert.ok(staging.indexOf(':!factory-kit') !== -1,
            'staging excludes factory-kit gitlink — found: ' + staging);
        assert.ok(staging.indexOf(':!.dmtools/copilot-sessions') !== -1,
            'copilot-sessions exclusion preserved');
    });

    test('gh-683: a repo that IGNORES the runtime paths stages without naming them — git add guard cannot fire', function () {
        // Live fa run 37153405587 (fa gh-1206, 2026-10-03): the dev leg's
        // `git add . -- ":!.dmtools/credential-helper.log" ...` died with
        // exit 1 — "The following paths are ignored by one of your
        // .gitignore files ... hint: Use -f if you really want to add
        // them" — AFTER a fully green development run: no PR, ticket
        // rolled back, leg marked SUCCESS. git add runs its
        // ignored-pathspec guard on `:!` EXCLUSION pathspecs too. In a
        // repo whose .gitignore covers the artifacts, the check-ignore
        // probe drops every runtime exclusion (gitignore alone keeps
        // `git add .` away); only factory-kit (never ignored) remains.
        var staging = null;
        var base = noChangesGitCommandMock('TS-11', 'ai/TS-11');
        var realLoadProjectConfig = configLoaderModule.loadProjectConfig;
        var loaderWithGitDefaults = Object.assign({}, configLoaderModule, {
            loadProjectConfig: function (p) {
                var c = realLoadProjectConfig(p) || {};
                if (!c.git) c.git = { baseBranch: 'main' };
                return c;
            }
        });
        var mod = loadModule(
            'js/developTicketAndCreatePR.js',
            makeRequire({
                './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
                './common/pullRequest.js': { cleanCommandOutput: function (output) { return (output || '').trim(); } },
                './common/submodules.js': { pushManagedSubmodules: function () {} },
                './common/feedbackLoop.js': {
                    runQualityGates: function () { return { success: true }; },
                    runPolicyGates: function () { return { success: true }; },
                    runPostPublishGates: function () { return { success: true }; },
                    resumeAgent: function () { return { attempted: false }; },
                    resumeOnceForMissingResponse: function () { return { attempted: false }; }
                },
                './common/autoStart.js': { triggerSmIfIdle: function () { } },
                './common/outputFiles.js': { readOutputFile: function () { return null; } },
                './cacheToReleases.js': {},
                './common/gitStaging.js': gitStagingModule,
                './configLoader.js': loaderWithGitDefaults,
                './config.js': configModule,
                './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
                './common/commentMarkup.js': commentMarkupModule
            }),
            {
                cli_execute_command: function (args) {
                    if (args.command.indexOf('git add . --') === 0) {
                        staging = args.command;
                        throw new Error('staging probe reached');
                    }
                    if (args.command.indexOf('git check-ignore') === 0 &&
                        args.command.indexOf('factory-kit') !== -1) {
                        // the nested machine-infra repo is NOT gitignored
                        throw new Error('Command execution failed (exit code 1)');
                    }
                    return base(args); // check-ignore returns '' → ignored → exclusion dropped
                },
                jira_post_comment: function () {},
                jira_move_to_status: function () {},
                jira_remove_label: function () {}
            }
        );

        assert.throws(function () {
            mod.action({
                ticket: { key: 'TS-11', fields: { summary: 'staging hygiene', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: {}
            });
        }, 'staging probe short-circuits into the Git-Operations failure leg-throw');

        assert.ok(staging, 'staging command executed');
        assert.ok(staging.indexOf(':!factory-kit') !== -1,
            'factory-kit exclusion stays (a nested repo is never gitignored)');
        assert.ok(staging.indexOf(':!.dmtools/') === -1,
            'no runtime path named in the pathspec — found: ' + staging);
        assert.ok(staging.indexOf(':!.dmtools-session-output.log') === -1,
            'no runtime path named in the pathspec — found: ' + staging);
    });

    test('git add never stages machine-local .dmtools runtime logs (gh-628)', function () {
        // Live 2026-10-03 (ai/gh-628): .dmtools/credential-helper.log — the
        // credential helper's serving trace — was swept into three commits
        // on the ticket branch by broad `git add` staging. The runtime logs
        // live next to COMMITTED files (config.js, runners/), so the
        // post-action's staging pathspec must exclude them explicitly, the
        // same way it excludes copilot-sessions; the rm cleanup untracks
        // already-poisoned branches.
        var staging = null;
        var cleanup = null;
        var base = noChangesGitCommandMock('TS-9', 'ai/TS-9');
        var realLoadProjectConfig = configLoaderModule.loadProjectConfig;
        // Same loader wrapper as the factory-kit test: guarantee the git
        // defaults the staging path (resolvePRTargetBranch) reads.
        var loaderWithGitDefaults = Object.assign({}, configLoaderModule, {
            loadProjectConfig: function (p) {
                var c = realLoadProjectConfig(p) || {};
                if (!c.git) c.git = { baseBranch: 'main' };
                return c;
            }
        });
        var mod = loadModule(
            'js/developTicketAndCreatePR.js',
            makeRequire({
                './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
                './common/pullRequest.js': { cleanCommandOutput: function (output) { return (output || '').trim(); } },
                './common/submodules.js': { pushManagedSubmodules: function () {} },
                './common/feedbackLoop.js': {
                    runQualityGates: function () { return { success: true }; },
                    runPolicyGates: function () { return { success: true }; },
                    runPostPublishGates: function () { return { success: true }; },
                    resumeAgent: function () { return { attempted: false }; },
                    resumeOnceForMissingResponse: function () { return { attempted: false }; }
                },
                './common/autoStart.js': { triggerSmIfIdle: function () { } },
                './common/outputFiles.js': { readOutputFile: function () { return null; } },
                './cacheToReleases.js': {},
                './common/gitStaging.js': gitStagingModule,
                './configLoader.js': loaderWithGitDefaults,
                './config.js': configModule,
                './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
                './common/commentMarkup.js': commentMarkupModule
            }),
            {
                cli_execute_command: function (args) {
                    if (args.command.indexOf('git ls-files -- ') === 0) {
                        cleanup = args.command;
                        return '';
                    }
                    if (args.command.indexOf('git check-ignore') === 0) {
                        // gh-683 probe: not-ignored repo → keep exclusions
                        throw new Error('Command execution failed (exit code 1)');
                    }
                    if (args.command.indexOf('git add . --') === 0) {
                        staging = args.command;
                        throw new Error('staging probe reached');
                    }
                    return base(args);
                },
                jira_post_comment: function () {},
                jira_move_to_status: function () {},
                jira_remove_label: function () {}
            }
        );

        // gh-683: the staging failure now fails the whole leg (thrown
        // gitOperationsFailure) instead of returning success-with-comment.
        assert.throws(function () {
            mod.action({
                ticket: { key: 'TS-9', fields: { summary: 'staging hygiene', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: {}
            });
        }, 'a Git-Operations failure must fail the leg, not return success');

        assert.ok(staging, 'staging command executed');
        assert.contains(staging, ':!.dmtools/credential-helper.log',
            'credential-serving trace never staged');
        assert.contains(staging, ':!.dmtools/fa-sessions', 'session store never staged');
        assert.contains(staging, ':!.dmtools-session-output.log',
            'timer CLI-stdout snapshot never staged');
        assert.ok(cleanup, 'untrack-cleanup command executed');
        assert.contains(cleanup, '.dmtools/credential-helper.log',
            'already-tracked credential-helper.log is untracked');
        assert.contains(cleanup, '.dmtools/fa-sessions',
            'session store untracked too — untrack list must not drift from staging exclusions (gh-628)');
    });

    test('Git-Operations failure fails the leg (thrown, marked) after resetting the ticket — gh-683 dead dev letter', function () {
        // Live fa run 37153405587 (fa gh-1206..1210, 2026-10-03): the dev
        // leg did all the work, the staging add died on git's
        // ignored-pathspec guard, and the leg posted the error comment,
        // moved the ticket back to Ready For Development and returned
        // { success: true } — the SM cannot distinguish a dead dev letter
        // from a green one, so the ticket silently looped with no PR. The
        // leg must now THROW a marked error after the reset (same
        // propagation mechanism as the fatal CLI environment failure), so
        // the workflow run is RED and retryable.
        var movedTo = [];
        var comments = [];
        var caught = null;
        var mod = loadDevelopTicketAndCreatePR({
            cli_execute_command: function (args) {
                if (args.command.indexOf('gh pr list --head ai/TS-12') === 0) return '';
                if (args.command === 'git branch --show-current') return 'ai/TS-12';
                if (args.command.indexOf('git check-ignore') === 0) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                if (args.command.indexOf('git add . --') === 0) {
                    // The exact live failure shape: git add's ignored-pathspec guard
                    throw new Error('Tool execution failed: Command execution failed (exit code 1): ' +
                        'The following paths are ignored by one of your .gitignore files:\n' +
                        '.dmtools/credential-helper.log\n.dmtools/fa-sessions\n' +
                        'hint: Use -f if you really want to add them.');
                }
                return '';
            },
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function () { }
        });

        try {
            mod.action({
                ticket: {
                    key: 'TS-12',
                    fields: { summary: 'dead dev letter visibility', description: '', labels: [] }
                },
                metadata: { contextId: 'sm_story_development' },
                customParams: {}
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'the Git-Operations failure must throw (fail the run), not return success');
        assert.ok(caught.gitOperationsFailure === true,
            'thrown error carries the gitOperationsFailure marker (outer catch rethrows it)');
        assert.contains(String(caught.message), 'Git Operations',
            'the stage name rides the thrown error');
        assert.deepEqual(movedTo, ['Ready For Development'],
            'ticket is still reset for retry before the leg fails');
        assert.equal(comments.length, 1, 'the stage error comment is still posted');
        assert.contains(comments[0].comment, 'Git Operations');
    });

});

// Loader for the landing-guard suite: real git helpers (so the flow reaches
// the "No changes were made" path), overridable outputFiles (response.md
// content) and feedbackLoop.resumeAgent (capture + scripted attempts).
function loadForLandingGuard(mocks, opts) {
    opts = opts || {};
    var realPrHelper = loadModule('js/common/pullRequest.js', makeRequire({
        './common/commentMarkup.js': commentMarkupModule,
        './mergeState.js': loadModule('js/common/mergeState.js'),
    }), {});
    var resumeCalls = [];
    var mod = loadModule(
        'js/developTicketAndCreatePR.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': realPrHelper,
            './common/submodules.js': { pushManagedSubmodules: function () { } },
            './common/feedbackLoop.js': {
                runQualityGates: function () { return { success: true }; },
                runPolicyGates: function () { return { success: true }; },
                runPostPublishGates: function () { return { success: true }; },
                resumeOnceForMissingResponse: function () { return { attempted: false }; },
                resumeAgent: function (options) {
                    resumeCalls.push(options);
                    return opts.resumeImpl ? opts.resumeImpl(options, resumeCalls.length)
                        : { attempted: false, reason: 'attempts-exhausted' };
                }
            },
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': {
                readOutputFile: function () { return opts.responseMd === undefined ? null : opts.responseMd; }
            },
            './cacheToReleases.js': {},
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/commentMarkup.js': commentMarkupModule
        }),
        Object.assign({
            cli_execute_command: noChangesGitCommandMock('TS-20', 'ai/TS-20'),
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        }, mocks || {})
    );
    return { mod: mod, resumeCalls: resumeCalls };
}

var CLAIMS_CHANGES_RESPONSE = '### What changed\n' +
    '- Part A — `js-apps` skill promoted: source of truth moved to `prompts/skills/js-apps/SKILL.md`.\n' +
    '- Part B — render errors flow back to the authoring agent via `JsAppErrorChannel`.\n\n' +
    '### How to verify\n```bash\ndart test test/skills\n```\n';

suite('developTicketAndCreatePR > post-session landing guard (gh-1164)', function () {

    test('empty tree + response claiming changes → resumeAgent called with the landing-guard promptOverride', function () {
        // Live fa gh-1164 (run 37220167230): the previous leg's work never
        // landed (timer autosave died on the staging guard every tick), and
        // the resumed leg read session memory, mistook main's release tip
        // for its own work commit, declared done and hit "No changes to
        // commit" — review armed with no PR. response.md claimed changes;
        // the branch carried none. The guard must resume the agent with an
        // override explaining its changes never landed BEFORE the
        // "No Code Changes Needed" comment path.
        var comments = [];
        var loaded = loadForLandingGuard({
            jira_post_comment: function (args) { comments.push(args); }
        }, {
            responseMd: CLAIMS_CHANGES_RESPONSE,
            resumeImpl: function (options, callCount) {
                // First resume attempt "succeeds" — action() re-runs; on the
                // second pass the attempts are exhausted → comment fallback.
                return callCount === 1 ? { attempted: true, attempts: 1 }
                    : { attempted: false, reason: 'attempts-exhausted' };
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-20', fields: { summary: 'lost work', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: CLAIMS_CHANGES_RESPONSE
        });

        assert.ok(loaded.resumeCalls.length >= 1, 'resumeAgent must be consulted');
        var resume = loaded.resumeCalls[0];
        assert.equal(resume.stage, 'development_landing_guard');
        assert.ok(resume.promptOverride, 'a promptOverride must be passed (not the default failure prompt)');
        assert.contains(resume.promptOverride, 'did not land in the git tree',
            'the override names the root cause');
        assert.contains(resume.promptOverride, 'Do not push',
            'the override keeps the no-push contract');
        assert.equal(result.path, 'no-changes-needed',
            'after the resume cycle exhausts, the honest comment path still runs');
        assert.ok(comments.some(function (c) { return c.comment.indexOf('No Code Changes Needed') !== -1; }),
            'the no-changes comment is the documented fallback');
    });

    test('resume exhausted → falls back to the no-changes comment path', function () {
        var comments = [];
        var movedTo = [];
        var loaded = loadForLandingGuard({
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); }
        }, {
            responseMd: CLAIMS_CHANGES_RESPONSE
            // resumeImpl omitted → { attempted: false, reason: 'attempts-exhausted' }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-20', fields: { summary: 'lost work', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: CLAIMS_CHANGES_RESPONSE
        });

        assert.equal(loaded.resumeCalls.length, 1, 'exactly one resume consult');
        assert.equal(result.success, true);
        assert.equal(result.path, 'no-changes-needed');
        assert.ok(comments.some(function (c) { return c.comment.indexOf('No Code Changes Needed') !== -1; }),
            'exhausted resume keeps the existing comment path');
        assert.deepEqual(movedTo, ['In Review']);
    });

    test('empty tree + honest no-changes response → NO resume, comment path directly', function () {
        var comments = [];
        var loaded = loadForLandingGuard({
            jira_post_comment: function (args) { comments.push(args); }
        }, {
            responseMd: 'The fix is already present in the target branch — no code changes are required.'
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-20', fields: { summary: 'already fixed', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'The fix is already present in the target branch.'
        });

        assert.equal(loaded.resumeCalls.length, 0,
            'an honest "no changes needed" analysis must never trigger the landing guard');
        assert.equal(result.path, 'no-changes-needed');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'No Code Changes Needed');
    });

    test('branch carrying work (dirty tree) + claims-changes response → NO resume', function () {
        var loaded = loadForLandingGuard({
            cli_execute_command: function (args) {
                var command = args.command;
                if (command.indexOf('gh pr list --head ai/TS-20') === 0) return '';
                if (command === 'git branch --show-current') return 'ai/TS-20';
                if (command === 'git diff --cached --stat') return '';
                if (command.indexOf('git rev-list --count') === 0) return '0';
                if (command === 'git status --porcelain') return ' M src/real_work.js\n';
                return '';
            }
        }, {
            responseMd: CLAIMS_CHANGES_RESPONSE
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-20', fields: { summary: 'work present', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: CLAIMS_CHANGES_RESPONSE
        });

        assert.equal(loaded.resumeCalls.length, 0,
            'a branch that actually carries work must not trigger the guard');
        assert.equal(result.path, 'no-changes-needed');
    });

    test('runtime-artifact / outputs status noise alone does not count as carried work', function () {
        var loaded = loadForLandingGuard({
            cli_execute_command: function (args) {
                var command = args.command;
                if (command.indexOf('gh pr list --head ai/TS-20') === 0) return '';
                if (command === 'git branch --show-current') return 'ai/TS-20';
                if (command === 'git diff --cached --stat') return '';
                if (command.indexOf('git rev-list --count') === 0) return '0';
                if (command === 'git status --porcelain') {
                    return '?? .dmtools/fa-sessions/\n?? factory-kit/\n?? outputs/response.md\n';
                }
                return '';
            }
        }, {
            responseMd: CLAIMS_CHANGES_RESPONSE
        });

        loaded.mod.action({
            ticket: { key: 'TS-20', fields: { summary: 'noise only', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: CLAIMS_CHANGES_RESPONSE
        });

        assert.equal(loaded.resumeCalls.length, 1,
            'machine-local noise + the response.md claim itself must not satisfy the guard');
        assert.equal(loaded.resumeCalls[0].stage, 'development_landing_guard');
    });

});

// ── gh-729: PR-creation tail visibility ─────────────────────────────────────
// Live fa gh-1197 (run 37234028759, 2026-10-04): the dev leg's log showed the
// staging check-ignore probes and then NOTHING for 23s — no git add, no
// commit, no push, no gh pr create, no error — and the leg still reported
// success and armed review with no PR. The tail must log every step and a
// missing PR must never read as plain success.
function loadForPrTail(mocks, opts) {
    opts = opts || {};
    var realPrHelper = loadModule('js/common/pullRequest.js', makeRequire({
        './common/commentMarkup.js': commentMarkupModule,
        './mergeState.js': loadModule('js/common/mergeState.js'),
    }), opts.prHelperGlobals || {});
    var logs = [];
    var errors = [];
    var mod = loadModule(
        'js/developTicketAndCreatePR.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': realPrHelper,
            './common/submodules.js': { pushManagedSubmodules: function () { } },
            './common/feedbackLoop.js': {
                runQualityGates: function () { return { success: true }; },
                runPolicyGates: function () { return { success: true }; },
                runPostPublishGates: function () { return { success: true }; },
                resumeAgent: function () { return { attempted: false, reason: 'attempts-exhausted' }; },
                resumeOnceForMissingResponse: function () { return { attempted: false, reason: 'attempts-exhausted' }; }
            },
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': {
                readOutputFile: function () { return opts.responseMd === undefined ? null : opts.responseMd; }
            },
            './cacheToReleases.js': {},
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/commentMarkup.js': commentMarkupModule
        }),
        Object.assign({
            cli_execute_command: opts.gitMock || function () { return ''; },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { },
            file_write: function () { },
            file_delete: function () { },
            console: {
                log: function (msg) { logs.push(String(msg)); },
                warn: function (msg) { logs.push('WARN: ' + String(msg)); },
                error: function (msg) { errors.push(String(msg)); }
            }
        }, mocks || {})
    );
    return { mod: mod, logs: logs, errors: errors };
}

// Simulates the live gh-1197 branch state at post-action: the CLI agent
// already committed its work (branch 2 commits ahead of origin/main) and the
// working tree is clean — post-action must push and create the PR.
function committedWorkGitMock(branchName, prUrl, opts) {
    opts = opts || {};
    return function (args) {
        var command = args.command;
        if (command.indexOf('gh pr list --head ' + branchName) === 0) return '';
        if (command === 'git branch --show-current') return branchName;
        if (command.indexOf('git ls-files -- ') === 0) return '';
        if (command.indexOf('git check-ignore') === 0) {
            throw new Error('Command execution failed (exit code 1)'); // not ignored → keep exclusions
        }
        if (command.indexOf('git add . --') === 0) return '';
        if (command === 'git diff --cached --stat') return '';
        if (command.indexOf('git rev-list --count') === 0) return '2';
        if (command.indexOf('git fetch') === 0) return '';
        if (command.indexOf('git rev-parse origin/') === 0) return 'basesha123';
        if (command.indexOf('git merge-base') === 0) return 'basesha123';
        if (command.indexOf('git push') === 0) return '';
        if (command === 'git ls-remote --heads origin main') return 'sha9\trefs/heads/main';
        if (command === 'git ls-remote --heads origin ' + branchName) return 'abc123\trefs/heads/' + branchName;
        if (command.indexOf('gh pr create') === 0) {
            if (opts.prCreateFails) throw new Error('HTTP 502: GraphQL: Bad Gateway');
            return prUrl;
        }
        return '';
    };
}

suite('developTicketAndCreatePR > PR-creation tail (gh-729)', function () {

    test('branch with committed work + clean tree at post-action → push + PR created', function () {
        var prUrl = 'https://github.com/acme/widgets/pull/1263';
        var commands = [];
        var gitMock = committedWorkGitMock('ai/TS-30', prUrl);
        var loaded = loadForPrTail({
            cli_execute_command: function (args) { commands.push(args.command); return gitMock(args); },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        }, { responseMd: '### What changed\n- Fixed the parser (`js/parser.js`).\n' });

        var result = loaded.mod.action({
            ticket: { key: 'TS-30', fields: { summary: 'committed work, clean tree', description: '', labels: [] } },
            metadata: { contextId: 'sm_bug_development' },
            customParams: {},
            response: '### What changed\n- Fixed the parser (`js/parser.js`).\n'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, prUrl,
            'a branch carrying work must end with a PR, not a bare success');
        assert.ok(commands.some(function (c) { return c.indexOf('git push') === 0; }),
            'the agent-committed work must be pushed — commands seen: ' + JSON.stringify(commands));
        assert.ok(commands.some(function (c) { return c.indexOf('gh pr create') === 0; }),
            'a PR must actually be created');
        // gh-729 tail visibility: every step between staging and PR-create logs.
        var allOutput = loaded.logs.join('\n');
        assert.contains(allOutput, 'Staging working tree',
            'tail step log: staging');
        assert.contains(allOutput, 'agent already committed',
            'tail step log: clean tree + commits ahead → push-only path named');
        assert.contains(allOutput, 'completed successfully',
            'tail step log: final outcome logged');
    });

    test('gh pr create failure → reset for retry AND the leg fails loudly (thrown, marked) — no silent green no-PR leg', function () {
        var movedTo = [];
        var comments = [];
        var gitMock = committedWorkGitMock('ai/TS-31', '', { prCreateFails: true });
        var loaded = loadForPrTail({
            cli_execute_command: gitMock,
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function () { }
        }, { responseMd: '### What changed\n- Fixed the parser (`js/parser.js`).\n' });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-31', fields: { summary: 'PR API outage', description: '', labels: [] } },
                metadata: { contextId: 'sm_bug_development' },
                customParams: {},
                response: '### What changed\n- Fixed the parser (`js/parser.js`).\n'
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'a missing-PR outcome must NOT return plain success — it must throw');
        assert.ok(caught && caught.prCreationFailure === true,
            'thrown error carries the prCreationFailure marker (outer catch rethrows it)');
        assert.contains(String(caught && caught.message), 'Pull Request Creation',
            'the stage name rides the thrown error');
        assert.deepEqual(movedTo, ['Ready For Development'],
            'ticket is still reset for retry before the leg fails');
        assert.equal(comments.length, 1, 'the stage error comment is still posted');
        assert.contains(comments[0].comment, 'Pull Request Creation');
        assert.contains(comments[0].comment, '502',
            'the underlying gh error reaches the Jira comment');
        assert.ok(loaded.errors.some(function (e) { return e.indexOf('Pull Request creation failed') !== -1; }),
            'the failure reason is error-logged, not swallowed — the live gh-1197 log had no error line at all');
    });

    test('gh-742: work committed and pushed but response.md missing → interrupted-reset comment, ticket reset AND the leg fails loudly (thrown, marked)', function () {
        // Live dmtools-dart gh-350 (run 37316571468, 2026-10-05) — the exact
        // log tail: "agent verdict: parity already implemented" → commit →
        // "outputs/response.md missing after commit — CLI agent was
        // interrupted mid-way. Resetting for retry." → {"success":true}.
        // The leg went green with no PR and the wrapper armed agent:review
        // on the issue; no retry ever fired. The interrupted comment +
        // Ready For Development reset must stay, but the run must go RED so
        // a no-PR leg can never read as "dev done".
        var movedTo = [];
        var removedLabels = [];
        var comments = [];
        var loaded = loadForPrTail({
            cli_execute_command: committedWorkGitMock('ai/TS-32', ''),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function (args) { removedLabels.push(args.label); }
        }, { responseMd: null });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-32', fields: { summary: 'interrupted mid-way', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: {},
                response: 'Agent hit a rate limit while writing the summary.'
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'an interrupted no-PR leg must NOT return plain success — it must throw');
        assert.ok(caught && caught.interruptedReset === true,
            'thrown error carries the interruptedReset marker (outer catch rethrows it)');
        assert.deepEqual(movedTo, ['Ready For Development'],
            'ticket is still reset for retry before the leg fails');
        assert.equal(comments.length, 1, 'the interrupted comment is still posted');
        assert.contains(comments[0].comment, 'Development Interrupted');
        assert.contains(comments[0].comment, 'ai/TS-32',
            'the comment names the branch carrying the partial work');
        assert.deepEqual(removedLabels, ['sm_story_development_wip'],
            'the WIP label is still cleared so the retry is not label-locked');
    });

    test('gh-737: dev leg PR body contains the canonical Closes #N line by construction', function () {
        // Live fa 2026-10-05: the merge bot (awf factory-merge-trigger) links
        // approved issues to PRs ONLY via 'Closes #N' in the PR body (or branch
        // 'N-*'). Factory PRs built from the response.md template carried no
        // Closes line → the bot merged nothing (merged=0 skipped=4). The dev
        // leg must emit 'Closes #737' for a gh-737 ticket even when the agent
        // response forgot it.
        var writes = [];
        var prUrl = 'https://github.com/acme/widgets/pull/737';
        var loaded = loadForPrTail({
            cli_execute_command: committedWorkGitMock('ai/gh-737', prUrl),
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        }, {
            responseMd: '### What changed\n- Parser fix.\n',
            prHelperGlobals: {
                file_write: function (path, content) { writes.push({ path: path, content: content }); },
                file_delete: function () { }
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'gh-737', fields: { summary: 'emit Closes line', description: '', labels: [] } },
            metadata: { contextId: 'sm_story_development' },
            customParams: {},
            response: '### What changed\n- Parser fix.\n'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, prUrl);
        var bodyWrite = writes.filter(function (w) { return w.path.indexOf('pr_body_tmp') !== -1; })[0];
        assert.ok(bodyWrite, 'PR body must be written to the temp body file — writes seen: ' + JSON.stringify(writes.map(function (w) { return w.path; })));
        assert.contains(bodyWrite.content, 'Closes #737',
            'the merge bot requires Closes #N in the PR body — the dev leg must emit it by construction');
    });

});


// ── gh-775: resume-before-cold-reset ─────────────
// Live fa gh-1341 (run 37521704313, 2026-10-06): a dev leg finished all its
// edits, the background verification job hung, and the post-action cold-reset
// a STILL-RESUMABLE session (interrupted comment + Ready For Development +
// wip removal + red run) — the deliverable was one "write outputs/response.md"
// step away. The post-action must make exactly ONE bounded resume attempt
// (wrapper re-invoked via `bash -c "timeout -k 60 <N> bash agents/scripts/
// run-agent.sh --continue <prompt>"`) BEFORE any tracker side effect, and only
// fall back to the EXISTING cold-reset sequence when the attempt fails, times
// out, or is not applicable. These tests use the REAL common/feedbackLoop.js
// so the attempt marker, the prompt file and the wrapper command are observed
// end-to-end through the mocked dmtools globals.
function loadForMissingResponseResume(opts) {
    opts = opts || {};
    var files = {};        // shared file map (attempt marker, prompt, response.md)
    var commands = [];     // captured cli_execute_command commands, in order
    var events = [];       // ordering log across commands + tracker side effects
    var comments = [];
    var movedTo = [];
    var removedLabels = [];

    var sharedFileRead = function (args) {
        var path = args && (args.path || args);
        if (files[path] !== undefined) return files[path];
        throw new Error('ENOENT: ' + path);
    };
    var sharedFileWrite = function (args) {
        files[args && args.path] = args && args.content;
    };
    var gitMock = opts.gitMock || function () { return ''; };
    var cliMock = function (args) {
        commands.push(args.command);
        events.push('command:' + args.command);
        if (args.command.indexOf('run-agent.sh') !== -1 && opts.wrapperImpl) {
            return opts.wrapperImpl(args.command);
        }
        return gitMock(args);
    };

    var realFeedbackLoop = loadModule('js/common/feedbackLoop.js', null, {
        file_read: sharedFileRead,
        file_write: sharedFileWrite,
        cli_execute_command: cliMock
    });
    var realOutputFiles = loadModule('js/common/outputFiles.js', null, {
        file_read: sharedFileRead
    });
    var realPrHelper = loadModule('js/common/pullRequest.js', makeRequire({
        './common/commentMarkup.js': commentMarkupModule,
        './mergeState.js': loadModule('js/common/mergeState.js')
    }), {});
    var mod = loadModule(
        'js/developTicketAndCreatePR.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': realPrHelper,
            './common/submodules.js': { pushManagedSubmodules: function () { } },
            './common/feedbackLoop.js': realFeedbackLoop,
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': realOutputFiles,
            './cacheToReleases.js': {},
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/commentMarkup.js': commentMarkupModule
        }),
        {
            cli_execute_command: cliMock,
            file_read: sharedFileRead,
            file_write: sharedFileWrite,
            file_delete: function () { },
            jira_post_comment: function (args) {
                comments.push(args);
                events.push('comment:' + String(args.comment || '').substring(0, 40));
            },
            jira_move_to_status: function (args) {
                movedTo.push(args.statusName);
                events.push('move:' + args.statusName);
            },
            jira_remove_label: function (args) {
                removedLabels.push(args.label);
                events.push('label:' + args.label);
            }
        }
    );
    return {
        mod: mod, files: files, commands: commands, events: events,
        comments: comments, movedTo: movedTo, removedLabels: removedLabels
    };
}

function wrapperCommandCount(commands) {
    var n = 0;
    for (var i = 0; i < commands.length; i++) {
        if (commands[i].indexOf('run-agent.sh --continue') !== -1) n++;
    }
    return n;
}

function firstIndexOfEvent(events, pattern) {
    for (var i = 0; i < events.length; i++) {
        if (pattern.test(events[i])) return i;
    }
    return -1;
}

var MISSING_RESPONSE_FEEDBACK = { feedbackLoop: { enabled: true } };

suite('developTicketAndCreatePR > resume-before-cold-reset (gh-775)', function () {

    test('AC2+AC3: committed work + missing response.md + resumable → exactly ONE bounded wrapper invocation, then normal continuation (no cold reset)', function () {
        var prUrl = 'https://github.com/acme/widgets/pull/775';
        var state = { files: null };
        var loaded = loadForMissingResponseResume({
            gitMock: committedWorkGitMock('ai/TS-40', prUrl),
            wrapperImpl: function () {
                // the resumed fa session finishes and writes the deliverable
                state.files['outputs/response.md'] = '### What changed\n- Fixed the parser (`js/parser.js`).\n';
                return '';
            }
        });
        state.files = loaded.files;

        var result = loaded.mod.action({
            ticket: { key: 'TS-40', fields: { summary: 'hung verification, work done', description: '', labels: [] } },
            metadata: { contextId: 'sm_story_development' },
            customParams: MISSING_RESPONSE_FEEDBACK,
            response: 'Agent hit a rate limit while writing the summary.'
        });

        // AC2: exactly ONE wrapper invocation, bounded, through the whitelisted token.
        assert.equal(wrapperCommandCount(loaded.commands), 1,
            'the wrapper must be re-invoked exactly once — commands: ' + JSON.stringify(loaded.commands));
        var wrapper = loaded.commands.filter(function (c) { return c.indexOf('run-agent.sh --continue') !== -1; })[0];
        assert.equal(wrapper,
            'bash -c "timeout -k 60 2400 bash agents/scripts/run-agent.sh --continue outputs/feedback/TS-40_missing_response.md"',
            'the resume is hard-capped (default 2400s) and enters cli_execute_command through `bash`');
        assert.contains(loaded.files['outputs/feedback/TS-40_missing_response.md'], 'bash_job stop',
            'the follow-up prompt tells the agent to dispose of the hung job');
        assert.contains(loaded.files['outputs/feedback/TS-40_missing_response.md'], 'outputs/response.md',
            'the follow-up prompt names the missing deliverable');
        assert.equal(loaded.files['outputs/feedback/TS-40_missing_response.attempt'], '1',
            'the one attempt is tracked in its own marker file');
        // AC2 ordering invariant: zero tracker side effects before the outcome resolves.
        var wrapperIdx = firstIndexOfEvent(loaded.events, /command:.*run-agent\.sh/);
        var trackerIdx = firstIndexOfEvent(loaded.events, /^(comment|move|label):/);
        assert.ok(wrapperIdx !== -1 && trackerIdx !== -1 && wrapperIdx < trackerIdx,
            'no tracker side effect may fire before the resume outcome resolves — events: ' + JSON.stringify(loaded.events));
        // AC3: normal continuation — PR created, no cold reset anywhere.
        assert.equal(result.success, true);
        assert.equal(result.prUrl, prUrl, 'the landed deliverable must continue into PR creation');
        assert.deepEqual(loaded.movedTo, ['In Review'],
            'the ticket moves to In Review — never to Ready For Development');
        for (var c = 0; c < loaded.comments.length; c++) {
            assert.notContains(loaded.comments[c].comment, 'Development Interrupted');
        }
    });

    test('AC4: resume fails/times out (exit 124) → the existing cold-reset sequence runs verbatim', function () {
        var loaded = loadForMissingResponseResume({
            gitMock: committedWorkGitMock('ai/TS-41', ''),
            wrapperImpl: function () {
                throw new Error('Command failed (exit code 124): timeout -k 60 2400 bash agents/scripts/run-agent.sh --continue ...');
            }
        });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-41', fields: { summary: 'resume timed out', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: MISSING_RESPONSE_FEEDBACK,
                response: 'Agent hit a rate limit while writing the summary.'
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'an un-recovered missing deliverable must still fail the run (gh-742 contract intact)');
        assert.ok(caught && caught.interruptedReset === true, 'thrown error carries the interruptedReset marker');
        assert.equal(wrapperCommandCount(loaded.commands), 1, 'exactly one bounded attempt was made');
        assert.deepEqual(loaded.movedTo, ['Ready For Development'],
            'the existing reset still moves the ticket to Ready For Development');
        assert.deepEqual(loaded.removedLabels, ['sm_story_development_wip'],
            'the existing reset still clears the WIP label');
        assert.equal(loaded.comments.length, 1);
        assert.contains(loaded.comments[0].comment, 'Development Interrupted');
        assert.contains(loaded.comments[0].comment, 'ai/TS-41',
            'the comment names the branch carrying the partial work — reset text unchanged');
        assert.contains(loaded.comments[0].comment, 'resume from the existing branch');
    });

    test('AC5: feedback loop not enabled → cold reset directly, NO wrapper invocation', function () {
        var loaded = loadForMissingResponseResume({
            gitMock: committedWorkGitMock('ai/TS-42', '')
        });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-42', fields: { summary: 'not resumable', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: {},
                response: 'Agent hit a rate limit while writing the summary.'
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught && caught.interruptedReset === true);
        assert.equal(wrapperCommandCount(loaded.commands), 0,
            'no wrapper invocation without the feedback-loop opt-in');
        assert.deepEqual(loaded.movedTo, ['Ready For Development']);
    });

    test('AC6: fatal CLI/environment error → throwFatalCliEnvironmentError, resume never preempts it', function () {
        var loaded = loadForMissingResponseResume({
            gitMock: committedWorkGitMock('ai/TS-43', '')
        });

        assert.throws(function () {
            loaded.mod.action({
                ticket: { key: 'TS-43', fields: { summary: 'missing binary', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: MISSING_RESPONSE_FEEDBACK,
                currentCliHasFatalError: true,
                currentCliErrorMessage: 'cursor-agent not found in PATH'
            });
        }, 'the fatal CLI/environment class must fail the job explicitly');

        assert.equal(wrapperCommandCount(loaded.commands), 0,
            'the resume never fires for the fatal class');
        assert.deepEqual(loaded.movedTo, [], 'no status move on a fatal environment error');
        assert.equal(loaded.comments.length, 1);
        assert.contains(loaded.comments[0].comment, 'AI CLI Environment Failure');
    });

    test('AC2/AC3 (no-changes site): resume lands an honest response → No Code Changes Needed path, no reset', function () {
        var state = { files: null };
        var loaded = loadForMissingResponseResume({
            gitMock: noChangesGitCommandMock('TS-44', 'ai/TS-44'),
            wrapperImpl: function () {
                state.files['outputs/response.md'] = 'The fix is already present in the target branch — no code changes are required.';
                return '';
            }
        });
        state.files = loaded.files;

        var result = loaded.mod.action({
            ticket: { key: 'TS-44', fields: { summary: 'hung analysis, no changes', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: MISSING_RESPONSE_FEEDBACK,
            response: ''
        });

        assert.equal(wrapperCommandCount(loaded.commands), 1);
        assert.equal(result.success, true);
        assert.equal(result.path, 'no-changes-needed');
        assert.deepEqual(loaded.movedTo, ['In Review']);
        assert.ok(loaded.comments.some(function (c) { return c.comment.indexOf('No Code Changes Needed') !== -1; }));
        for (var c = 0; c < loaded.comments.length; c++) {
            assert.notContains(loaded.comments[c].comment, 'Development Interrupted');
        }
    });

    test('AC4 (no-changes site): resume fails → verbatim interrupted reset', function () {
        var loaded = loadForMissingResponseResume({
            gitMock: noChangesGitCommandMock('TS-45', 'ai/TS-45'),
            wrapperImpl: function () {
                throw new Error('Command failed (exit code 124): timed out');
            }
        });

        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-45', fields: { summary: 'hung analysis', description: '', labels: [] } },
                metadata: { contextId: 'story_development' },
                customParams: MISSING_RESPONSE_FEEDBACK,
                response: ''
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught && caught.interruptedReset === true);
        assert.equal(wrapperCommandCount(loaded.commands), 1);
        assert.deepEqual(loaded.movedTo, ['Ready For Development']);
        assert.equal(loaded.comments.length, 1);
        assert.contains(loaded.comments[0].comment, 'Development Interrupted');
    });

    test('missingResponse.timeoutSeconds override tightens the hard cap', function () {
        var loaded = loadForMissingResponseResume({
            gitMock: committedWorkGitMock('ai/TS-46', '')
        });

        try {
            loaded.mod.action({
                ticket: { key: 'TS-46', fields: { summary: 'short budget', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: { feedbackLoop: { enabled: true, missingResponse: { timeoutSeconds: 600 } } },
                response: 'Agent hit a rate limit while writing the summary.'
            });
        } catch (e) { /* the cold-reset throw is the expected fallback here */ }

        var wrapper = loaded.commands.filter(function (c) { return c.indexOf('run-agent.sh --continue') !== -1; })[0];
        assert.ok(wrapper, 'wrapper was invoked');
        assert.contains(wrapper, 'timeout -k 60 600', 'the configured cap rides the wrapper command');
    });

});

suite('prompts/bash_tools.md > B7 hung-job disposal rule (gh-775 AC1)', function () {
    var bashTools = file_read({ path: 'prompts/bash_tools.md' });

    test('BGJOBS chain ends with the B7 hung-job disposal node', function () {
        assert.ok(bashTools, 'prompts/bash_tools.md is readable');
        assert.contains(bashTools, 'B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7',
            'the disposal node extends the BGJOBS chain');
        assert.contains(bashTools, 'B7[');
    });

    test('B7 carries the disposal semantics: stop the hung job, note it, finish the deliverable', function () {
        var b7 = bashTools.substring(bashTools.indexOf('B7['));
        b7 = b7.substring(0, b7.indexOf('"]') + 2);
        assert.contains(b7, 'bash_job stop', 'names the disposal command');
        assert.contains(b7, 'outputs/response.md', 'the deliverable must still be written');
        assert.contains(b7, 'MOVE ON', 'the agent must not hold the deliverable hostage');
        assert.contains(b7, 'validation CI', 'PR CI is the stated safety net');
    });

    test('mermaid graph stays syntactically valid (balanced fences, flowchart header)', function () {
        var fences = bashTools.match(/```/g) || [];
        assert.equal(fences.length, 2, 'exactly one fenced mermaid block');
        assert.contains(bashTools, '```mermaid\nflowchart TD');
    });

});
