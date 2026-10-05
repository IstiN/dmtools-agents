/**
 * Unit tests for js/developTicketAndCreatePR.js failure recovery.
 */

// Declared once at module scope — every loader below references it in its
// makeRequire() map, so it must exist before any of them run.
var commentMarkupModule = loadModule('js/common/commentMarkup.js');
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
                resumeAgent: function () { return { attempted: false }; }
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
                resumeAgent: function () { return { attempted: false }; }
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

    test('still resets ticket for retry (does not throw) on an ordinary interrupted response with no fatal environment signature', function () {
        var movedTo = [];
        var comments = [];
        var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers({
            cli_execute_command: noChangesGitCommandMock('TS-4', 'ai/TS-4'),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); }
        });

        var result = mod.action({
            ticket: { key: 'TS-4', fields: { summary: 'Rate limited', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'Agent hit a rate limit and stopped mid-analysis.'
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'interrupted');
        assert.deepEqual(movedTo, ['Ready For Development']);
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
                    resumeAgent: function () { return { attempted: false }; }
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
                    resumeAgent: function () { return { attempted: false }; }
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
                    resumeAgent: function () { return { attempted: false }; }
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
                resumeAgent: function () { return { attempted: false, reason: 'attempts-exhausted' }; }
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

