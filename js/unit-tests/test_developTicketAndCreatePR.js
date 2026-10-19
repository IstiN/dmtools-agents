/**
 * Unit tests for js/developTicketAndCreatePR.js failure recovery.
 */

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

// Declared once at module scope — every loader below references it in its
// makeRequire() map, so it must exist before any of them run.
var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var gitStagingModule = loadModule('js/common/gitStaging.js');
// gh-1087: real quota circuit-breaker (pure module — no requires of its own).
var quotaBreakerModule = loadModule('js/common/quotaCircuitBreaker.js');

function loadDevelopTicketAndCreatePR(mocks, feedbackLoopOverrides) {
    return (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
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
            './common/quotaCircuitBreaker.js': quotaBreakerModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } }
            ,
            './common/commentMarkup.js': commentMarkupModule,
        }, { './common/trackers.js': trackersWith(_m) })), _m); })(Object.assign({
            cli_execute_command: function () { return ''; },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        }, mocks || {}));
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
    return (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
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
            './common/quotaCircuitBreaker.js': quotaBreakerModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } }
            ,
            './common/commentMarkup.js': commentMarkupModule,
        }, { './common/trackers.js': trackersWith(_m) })), _m); })(Object.assign({
            cli_execute_command: function () { return ''; },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        }, mocks || {}));
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

    test('gh-1087 UT-2/AC2: 403 weekly-limit quota failure parks the lane — label + comment, NO Ready For Development reset, run fails with the quotaPark marker', function () {
        // Live fa gh-1697 (run 39210285663): z.ai glm-5.3-flash answered
        // 403 "weekly (7-day) usage limit", the provider chain exhausted,
        // and the gh-742 reset re-dispatched the same leg into the same
        // wall on the next tick. The quota class must PARK instead:
        // park label + reason comment, no status reset, dead-letter run.
        var movedTo = [];
        var removedLabels = [];
        var addedLabels = [];
        var comments = [];
        var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers({
            cli_execute_command: noChangesGitCommandMock('TS-6', 'ai/TS-6'),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function (args) { removedLabels.push(args.label); },
            jira_add_label: function (args) { addedLabels.push(args.label); }
        });

        var caught = null;
        try {
            mod.action({
                ticket: { key: 'TS-6', fields: { summary: 'Quota wall', description: '', labels: [] } },
                metadata: { contextId: 'story_development' },
                customParams: {},
                response: '',
                currentCliErrorMessage: 'z.ai glm-5.3-flash answered 403 "weekly (7-day) usage limit" (9 retries); Provider chain exhausted: 2 of 2'
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught, 'a parked leg must fail the run (throw), not return plain success');
        assert.ok(caught && caught.quotaPark === true,
            'thrown error carries the quotaPark marker (outer catch rethrows it)');
        assert.deepEqual(movedTo, [],
            'quota park must NOT reset the ticket to Ready For Development (AC2)');
        assert.deepEqual(addedLabels, ['provider_quota'],
            'park label added to the ticket (AC2)');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Provider Quota Exhausted');
        assert.contains(comments[0].comment, 'z.ai');
        assert.contains(comments[0].comment, 'weekly (7-day)');
        assert.contains(comments[0].comment, 'provider_quota');
        assert.ok(removedLabels.indexOf('story_development_wip') !== -1,
            'WIP label still cleaned up so a later un-park can re-dispatch');
    });

    test('gh-1087 AC4/REG-1: transient 429 interruption still takes the classic gh-742 reset (classifier must not park)', function () {
        var movedTo = [];
        var addedLabels = [];
        var comments = [];
        var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers({
            cli_execute_command: noChangesGitCommandMock('TS-7', 'ai/TS-7'),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_add_label: function (args) { addedLabels.push(args.label); }
        });

        var caught = null;
        try {
            mod.action({
                ticket: { key: 'TS-7', fields: { summary: 'Rate blip', description: '', labels: [] } },
                metadata: { contextId: 'story_development' },
                customParams: {},
                response: '',
                currentCliErrorMessage: 'HTTP 429: rate limit exceeded, retry in 30s'
            });
        } catch (e) {
            caught = e;
        }

        assert.ok(caught && caught.interruptedReset === true,
            'transient interruption keeps the gh-742 interruptedReset contract');
        assert.deepEqual(movedTo, ['Ready For Development'],
            'transient interruption is still reset for retry');
        assert.deepEqual(addedLabels, [],
            'no park label on a transient failure');
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
        var mod = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
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
            }, { './common/trackers.js': trackersWith(_m) })), _m); })({
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
            });

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
        var mod = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
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
            }, { './common/trackers.js': trackersWith(_m) })), _m); })({
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
            });

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
        var mod = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
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
            }, { './common/trackers.js': trackersWith(_m) })), _m); })({
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
            });

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
    }), {
        // file_write/file_delete: PR-body temp file is written through dmtools
        // globals — absent in the node harness unless stubbed here.
        file_write: function () { },
        file_delete: function () { }
    });
    var resumeCalls = [];
    var mod = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
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
            './common/quotaCircuitBreaker.js': quotaBreakerModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/commentMarkup.js': commentMarkupModule
        }, { './common/trackers.js': trackersWith(_m) })), _m); })(Object.assign({
            cli_execute_command: noChangesGitCommandMock('TS-20', 'ai/TS-20'),
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        }, mocks || {}));
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
    }), opts.prHelperGlobals || {
        // file_write/file_delete: PR-body temp file is written through dmtools
        // globals — absent in the node harness unless stubbed here.
        file_write: function () { },
        file_delete: function () { }
    });
    var logs = [];
    var errors = [];
    var mod = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
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
            './common/quotaCircuitBreaker.js': quotaBreakerModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/commentMarkup.js': commentMarkupModule
        }, { './common/trackers.js': trackersWith(_m) })), _m); })(Object.assign({
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
        }, mocks || {}));
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
    }), {
        // file_write/file_delete: PR-body temp file is written through dmtools
        // globals — absent in the node harness unless stubbed here.
        file_write: function () { },
        file_delete: function () { }
    });
    var mod = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': realPrHelper,
            './common/submodules.js': { pushManagedSubmodules: function () { } },
            './common/feedbackLoop.js': realFeedbackLoop,
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': realOutputFiles,
            './cacheToReleases.js': {},
            './common/gitStaging.js': gitStagingModule,
            './common/quotaCircuitBreaker.js': quotaBreakerModule,
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/commentMarkup.js': commentMarkupModule
        }, { './common/trackers.js': trackersWith(_m) })), _m); })({
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
        });
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
        assert.contains(b7, 'B6 covers a job still making progress',
            'B7 cross-references B6 so in-flight (preserve) vs no-progress (hung) cannot be read as contradictory');
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

suite('developTicketAndCreatePR > ado tracker provider', function () {
    test('failure reset goes through ado_* tools and never a jira_* tool', function () {
        var calls = [];
        var mod = loadDevelopTicketAndCreatePR({
            cli_execute_command: function (args) {
                if (args.command.indexOf('gh pr list --head ai/55') === 0) return '';
                if (args.command === 'git config user.name "AI Teammate"') throw new Error('git config failed');
                return '';
            },
            ado_add_work_item_comment: function (a) { calls.push(['comment', a]); },
            ado_move_to_state: function (a) { calls.push(['move', a]); },
            ado_remove_work_item_label: function (a) { calls.push(['rm', a]); },
            jira_post_comment: function() { throw new Error('jira_* must not be called on ado'); },
            jira_move_to_status: function() { throw new Error('jira_* must not be called on ado'); },
            jira_remove_label: function() { throw new Error('jira_* must not be called on ado'); },
            jira_add_label: function() { throw new Error('jira_* must not be called on ado'); },
            jira_assign_ticket_to: function() { throw new Error('jira_* must not be called on ado'); },
        });
        var result = mod.action({
            ticket: { key: '55', fields: { summary: 'x', description: '', labels: [] } },
            metadata: { contextId: 'sm_bug_development' },
            customParams: { trackerProvider: 'ado', removeLabel: 'sm_bug_development_triggered' }
        });
        assert.equal(result.path, 'development-reset-for-retry');
        assert.ok(calls.some(function (c) { return c[0] === 'comment' && c[1].id === '55'; }));
        assert.ok(calls.some(function (c) { return c[0] === 'move' && c[1].id === '55' && c[1].state === 'Ready For Development'; }));
        assert.equal(calls.filter(function (c) { return c[0] === 'rm'; }).length, 2);
    });
});

// ── gh-912: branch-name collision detection decides on ref lines ─────────────
// generateUniqueBranchName probes the remote with a glob ls-remote and used to
// branch on capture non-emptiness — a `warning: redirecting to …` line
// (central-mode insteadOf origin, git ≥ 2.54) read as "name taken" and forced
// a bogus _1 suffix onto the first run of every ticket.

suite('developTicketAndCreatePR.generateUniqueBranchName — warning-only ls-remote capture (gh-912)', function() {

    var WARNING = 'warning: redirecting to https://git.example.com/\n';

    function nameProbeMock(capture) {
        return {
            cli_execute_command: function(args) {
                var command = args && args.command;
                if (command === 'git branch --list "*feature/PROJ-1*"') return '';
                if (command === 'git ls-remote --heads origin "feature/PROJ-1*"') return capture;
                return '';
            }
        };
    }

    test('warning-only capture → base name is free, no _1 suffix', function() {
        var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers(nameProbeMock(WARNING));

        var name = mod.generateUniqueBranchName('feature', 'PROJ-1');

        assert.equal(name, 'feature/PROJ-1',
            'stderr noise must never be read as an existing branch — got suffix: ' + name);
    });

    test('a real matching ref line still forces the _1 suffix (warning + ref, both orders)', function() {
        var refLine = '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/feature/PROJ-1';
        [WARNING + refLine, refLine + '\n' + WARNING.replace('\n', '')].forEach(function(capture) {
            var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers(nameProbeMock(capture));

            var name = mod.generateUniqueBranchName('feature', 'PROJ-1');

            assert.equal(name, 'feature/PROJ-1_1',
                'a real existing branch must still trigger the collision suffix, got: ' + name);
        });
    });

});

// ── gh-930: outcome characterization for the whole leg ───────────────────────
// Pins the observable outcomes of every action() path (result shape, tracker
// side effects, non-fatal vs fatal) BEFORE the function is decomposed into
// helpers. These tests must pass unchanged before and after the refactor.
var realPrHelperShared = null;
function realPrHelperForOutcomes() {
    if (!realPrHelperShared) {
        // file_write/file_delete: the PR body temp file is written through
        // dmtools globals — absent in the node harness unless stubbed here.
        realPrHelperShared = loadModule('js/common/pullRequest.js', makeRequire({
            './common/commentMarkup.js': commentMarkupModule,
            './mergeState.js': loadModule('js/common/mergeState.js')
        }), {
            file_write: function () { },
            file_delete: function () { }
        });
    }
    return realPrHelperShared;
}

// Loader with overridable gates, scm, response.md and telemetry stubs.
function loadForOutcomePinning(mocks, opts) {
    opts = opts || {};
    var autoStartCalls = { review: [], smIdle: 0 };
    var telemetry = { cache: 0, tokenUsage: [] };
    var loaderConfigLoader = opts.scm
        ? Object.assign({}, configLoaderModule, { createScm: function () { return opts.scm; } })
        : configLoaderModule;
    var mod = (function (_m) { return loadModule('js/developTicketAndCreatePR.js', makeRequire(Object.assign({}, {
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': realPrHelperForOutcomes(),
            './common/submodules.js': { pushManagedSubmodules: function () { } },
            './common/feedbackLoop.js': Object.assign({
                runQualityGates: function () { return { success: true }; },
                runPolicyGates: function () { return { success: true }; },
                runPostPublishGates: function () { return { success: true }; },
                resumeAgent: function () { return { attempted: false, reason: 'attempts-exhausted' }; },
                resumeOnceForMissingResponse: function () { return { attempted: false, reason: 'disabled' }; }
            }, opts.feedbackLoop || {}),
            './common/autoStart.js': {
                triggerSmIfIdle: function () { autoStartCalls.smIdle++; },
                triggerConfiguredWorkflowForTicket: function (o) {
                    if (opts.reviewThrows) throw new Error('workflow trigger API down');
                    autoStartCalls.review.push(o); return true;
                }
            },
            './common/outputFiles.js': {
                readOutputFile: function () { return opts.responseMd === undefined ? null : opts.responseMd; }
            },
            './cacheToReleases.js': {
                action: function () { telemetry.cache++; }
            },
            './common/gitStaging.js': gitStagingModule,
            './configLoader.js': loaderConfigLoader,
            './config.js': configModule,
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function (k, o) {
                    if (opts.tokenUsageThrows) throw new Error('token usage provider down');
                    telemetry.tokenUsage.push({ ticketKey: k, options: o });
                },
                customParamsOf: function () { return {}; }
            },
            './common/commentMarkup.js': commentMarkupModule
        }, { './common/trackers.js': trackersWith(_m) })), _m); })(Object.assign({
            cli_execute_command: function () { return ''; },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { },
            jira_add_label: function () { },
            jira_assign_ticket_to: function () { },
            file_write: function () { },
            file_delete: function () { }
        }, mocks || {}));
    return { mod: mod, autoStartCalls: autoStartCalls, telemetry: telemetry };
}

suite('developTicketAndCreatePR > leg outcome characterization (gh-930)', function () {

    test('an already-open PR for the branch is reused — comment + In Review, no git work', function () {
        var comments = [];
        var movedTo = [];
        var commands = [];
        var fakeScm = {
            listPrs: function (state) {
                commands.push('scm.listPrs:' + state);
                return [{
                    number: 41,
                    html_url: 'https://github.com/acme/widgets/pull/41',
                    head: { ref: 'ai/TS-50' }
                }];
            }
        };
        var loaded = loadForOutcomePinning({
            cli_execute_command: function (args) { commands.push(args.command); return ''; },
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); }
        }, { scm: fakeScm });

        var result = loaded.mod.action({
            ticket: { key: 'TS-50', fields: { summary: 'reuse open PR', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {}
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'pr_already_open');
        assert.equal(result.ticketKey, 'TS-50');
        assert.deepEqual(movedTo, ['In Review']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'PR Already Open');
        assert.contains(comments[0].comment, 'https://github.com/acme/widgets/pull/41');
        assert.ok(!commands.some(function (c) { return c.indexOf('git ') === 0; }),
            'no git work may run when a PR already exists — commands: ' + JSON.stringify(commands));
    });

    test('a stale pr_approved label is removed from the ticket before the leg proceeds', function () {
        var removedLabels = [];
        var comments = [];
        var movedTo = [];
        var caught = null;
        var loaded = loadForOutcomePinning({
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function (args) { removedLabels.push(args.label); }
        }, {});

        try {
            loaded.mod.action({
                ticket: { key: 'TS-51', fields: { summary: 'rework cycle', description: '', labels: ['pr_approved'] } },
                metadata: { contextId: 'story_development' },
                customParams: {}
            });
        } catch (e) { caught = e; }

        assert.deepEqual(removedLabels, ['pr_approved', 'story_development_wip'],
            'pr_approved goes first (stale-review cleanup), the wip label only on the reset path');
        assert.ok(caught && caught.interruptedReset === true,
            'with no work and no response.md the leg throws the interrupted-reset marker (gh-742 contract)');
        assert.deepEqual(movedTo, ['Ready For Development']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Development Interrupted');
    });

    test('a failed quality gate resets the ticket for retry (comment, no throw)', function () {
        var comments = [];
        var movedTo = [];
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-52', ''),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); }
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n',
            feedbackLoop: {
                runQualityGates: function () { return { success: false, failedGate: 'unit-tests', error: '3 failing' }; }
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-52', fields: { summary: 'gate fail', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'development-reset-for-retry');
        assert.contains(result.error, 'Quality gate failed before development publish');
        assert.contains(result.error, 'unit-tests');
        assert.deepEqual(movedTo, ['Ready For Development']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Quality Gate');
    });

    test('a failed policy gate resets the ticket for retry (comment, no throw)', function () {
        var comments = [];
        var movedTo = [];
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-53', ''),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); }
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n',
            feedbackLoop: {
                runPolicyGates: function () { return { success: false, failedGate: 'secrets', error: 'key found' }; }
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-53', fields: { summary: 'policy fail', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'ok'
        });

        assert.equal(result.path, 'development-reset-for-retry');
        assert.contains(result.error, 'Policy gate failed before development publish');
        assert.contains(result.error, 'secrets');
        assert.deepEqual(movedTo, ['Ready For Development']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Policy Gate');
    });

    test('a failed post-publish gate without a resume attempt resets the ticket for retry', function () {
        var comments = [];
        var movedTo = [];
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-54', ''),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); }
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n',
            feedbackLoop: {
                runPostPublishGates: function () {
                    return { success: false, failedGate: 'crap', error: 'regression', resumeAttempted: false };
                }
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-54', fields: { summary: 'post-publish fail', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'ok'
        });

        assert.equal(result.path, 'development-reset-for-retry');
        assert.contains(result.error, 'Post-publish quality gate failed');
        assert.contains(result.error, 'crap');
        assert.deepEqual(movedTo, ['Ready For Development']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Post-Publish Quality Gate');
    });

    test('a post-publish gate failure that already resumed re-runs the leg instead of resetting', function () {
        var postPublishCalls = 0;
        var prUrl = 'https://github.com/acme/widgets/pull/54';
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-55', prUrl)
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n',
            feedbackLoop: {
                runPostPublishGates: function () {
                    postPublishCalls++;
                    return postPublishCalls === 1
                        ? { success: false, failedGate: 'quality', error: 'first pass fails', resumeAttempted: true }
                        : { success: true };
                }
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-55', fields: { summary: 'post-publish resume', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'ok'
        });

        assert.equal(postPublishCalls, 2, 'the leg re-ran once after the resume attempt');
        assert.equal(result.success, true);
        assert.equal(result.prUrl, prUrl);
    });

    test('autoStartReview configured → review workflow triggered, SM not kicked', function () {
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-56', 'https://github.com/acme/widgets/pull/56')
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n'
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-56', fields: { summary: 'auto review', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: { autoStartReview: true, autoStartReviewConfigFile: 'agents/pr_review.json' },
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(loaded.autoStartCalls.review.length, 1, 'the review workflow is triggered');
        assert.equal(loaded.autoStartCalls.review[0].ticketKey, 'TS-56');
        assert.equal(loaded.autoStartCalls.review[0].label, 'pr_review');
        assert.equal(loaded.autoStartCalls.review[0].configFile, 'agents/pr_review.json');
        assert.equal(loaded.autoStartCalls.smIdle, 0, 'the SM kicker is skipped while review was started');
    });

    test('a failing autoStartReview trigger is non-fatal — the leg stays green and the SM kicker runs', function () {
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-61', 'https://github.com/acme/widgets/pull/61')
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n',
            reviewThrows: true
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-61', fields: { summary: 'trigger fails', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: { autoStartReview: true, autoStartReviewConfigFile: 'agents/pr_review.json' },
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/acme/widgets/pull/61');
        assert.equal(loaded.autoStartCalls.review.length, 0);
        assert.equal(loaded.autoStartCalls.smIdle, 1);
    });

    test('no autoStartReview config → the SM kicker runs instead', function () {
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-58', 'https://github.com/acme/widgets/pull/58')
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n'
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-58', fields: { summary: 'no auto review', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(loaded.autoStartCalls.review.length, 0);
        assert.equal(loaded.autoStartCalls.smIdle, 1);
    });

    test('autoStartReview without a config file is not started — SM kicker runs instead', function () {
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-62', 'https://github.com/acme/widgets/pull/62')
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n'
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-62', fields: { summary: 'no review config', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: { autoStartReview: true },
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/acme/widgets/pull/62');
        assert.equal(loaded.autoStartCalls.review.length, 0,
            'no config file — the review workflow must not be triggered');
        assert.equal(loaded.autoStartCalls.smIdle, 1);
    });

    test('autoStartReview with a failing stale-pr_approved cleanup is skipped — SM kicker runs', function () {
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-59', 'https://github.com/acme/widgets/pull/59'),
            jira_remove_label: function () { throw new Error('tracker down'); }
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n'
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-59', fields: { summary: 'cleanup failed', description: '', labels: ['pr_approved'] } },
            metadata: { contextId: 'story_development' },
            customParams: { autoStartReview: true, autoStartReviewConfigFile: 'agents/pr_review.json' },
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, 'https://github.com/acme/widgets/pull/59', 'the leg runs to PR creation');
        assert.equal(loaded.autoStartCalls.review.length, 0,
            'review must not be auto-started while pr_approved survived the cleanup');
        assert.equal(loaded.autoStartCalls.smIdle, 1);
    });

    test('success tail assigns the initiator, labels, strips wip and posts telemetry (telemetry failures non-fatal)', function () {
        var assigned = [];
        var addedLabels = [];
        var removedLabels = [];
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-57', 'https://github.com/acme/widgets/pull/57'),
            jira_assign_ticket_to: function (a) { assigned.push(a); },
            jira_add_label: function (a) { addedLabels.push(a.label); },
            jira_remove_label: function (a) { removedLabels.push(a.label); }
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n',
            tokenUsageThrows: true
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-57', fields: { summary: 'success tail', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            initiator: 'initiator-1',
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(result.branchName, 'ai/TS-57');
        assert.equal(result.prUrl, 'https://github.com/acme/widgets/pull/57');
        assert.contains(result.message, 'developed, committed, and PR created');
        assert.deepEqual(assigned, [{ key: 'TS-57', accountId: 'initiator-1' }]);
        assert.ok(addedLabels.indexOf('ai_developed') !== -1, 'ai_developed label added');
        assert.ok(removedLabels.indexOf('story_development_wip') !== -1, 'wip label removed');
        assert.equal(loaded.telemetry.cache, 1, 'cacheToReleases ran exactly once');
        assert.equal(loaded.telemetry.tokenUsage.length, 0, 'a throwing token-usage provider is non-fatal');
    });

    test('token usage provider records the comment with the initiator context', function () {
        var loaded = loadForOutcomePinning({
            cli_execute_command: committedWorkGitMock('ai/TS-60', 'https://github.com/acme/widgets/pull/60'),
            jira_assign_ticket_to: function () { }
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n'
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-60', fields: { summary: 'token usage', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            initiator: 'initiator-2',
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(loaded.telemetry.tokenUsage.length, 1);
        assert.equal(loaded.telemetry.tokenUsage[0].ticketKey, 'TS-60');
        assert.equal(loaded.telemetry.tokenUsage[0].options.initiator, 'initiator-2');
    });

    // Push-rejection mock: initial push rejected; the first N force pushes
    // (performGitOperations retries internally once) rejected too, later ones succeed.
    function pushRejectedGitMock(branchName, prUrl, opts) {
        opts = opts || {};
        var forceRejections = opts.forceRejections === undefined ? 1 : opts.forceRejections;
        var forceCount = 0;
        var inner = committedWorkGitMock(branchName, prUrl, opts);
        return function (args) {
            var command = args.command;
            if (command === 'git push -u origin ' + branchName) {
                return 'error: failed to push some refs — rejected (non-fast-forward)';
            }
            if (command === 'git push -u origin ' + branchName + ' --force') {
                forceCount++;
                if (forceCount <= forceRejections) {
                    return 'remote rejected: GH013: push declined';
                }
                return '';
            }
            return inner(args);
        };
    }

    test('a rejected push is retried with force after the agent fix — the leg continues to PR', function () {
        var prUrl = 'https://github.com/acme/widgets/pull/71';
        var commands = [];
        var written = [];
        var git = pushRejectedGitMock('ai/TS-70', prUrl);
        var loaded = loadForOutcomePinning({
            cli_execute_command: function (args) {
                commands.push(args.command);
                return git(args);
            },
            file_write: function (args) { written.push(args.path); }
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n'
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-70', fields: { summary: 'push rejected then fixed', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(result.prUrl, prUrl,
            'the leg must reach PR creation after the force-push fix — result: ' + JSON.stringify(result) +
            '; forces: ' + JSON.stringify(commands.filter(function (c) { return c.indexOf('git push') === 0; })));
        assert.ok(commands.some(function (c) { return c.indexOf('git push -u origin ai/TS-70 --force') === 0; }),
            'the force-push retry must run — commands: ' + JSON.stringify(commands));
        assert.ok(written.indexOf('input/TS-70/push_error.md') !== -1,
            'the agent-facing push_error.md must be written before the retry — written: ' + JSON.stringify(written));
    });

    test('a push that stays rejected after the retry resets the ticket for retry', function () {
        var comments = [];
        var movedTo = [];
        var loaded = loadForOutcomePinning({
            cli_execute_command: pushRejectedGitMock('ai/TS-72', '', { forceRejections: 99 }),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); }
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n'
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-72', fields: { summary: 'push stays rejected', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'ok'
        });

        assert.equal(result.success, true);
        assert.equal(result.path, 'development-reset-for-retry');
        assert.contains(result.error, 'Git push failed even after retry:');
        assert.contains(result.error, 'Push still rejected after agent fix');
        assert.deepEqual(movedTo, ['Ready For Development']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Git Push (after retry)');
    });

    test('a resumable push failure re-runs the leg once before falling back to the reset', function () {
        var resumeCalls = 0;
        var loaded = loadForOutcomePinning({
            cli_execute_command: pushRejectedGitMock('ai/TS-73', '', { forceRejections: 99 })
        }, {
            responseMd: '### What changed\n- Parser fix (`js/parser.js`).\n',
            feedbackLoop: {
                resumeAgent: function () {
                    resumeCalls++;
                    return { attempted: resumeCalls === 1, reason: resumeCalls === 1 ? 'resumed' : 'attempts-exhausted' };
                }
            }
        });

        var result = loaded.mod.action({
            ticket: { key: 'TS-73', fields: { summary: 'push failure resume', description: '', labels: [] } },
            metadata: { contextId: 'story_development' },
            customParams: {},
            response: 'ok'
        });

        assert.equal(resumeCalls, 2, 'the wrapper is re-invoked once, then the attempts are exhausted');
        assert.equal(result.path, 'development-reset-for-retry');
    });

});

// ── gh-1003: performGitOperations extraction ─────────────────────────
// The CRAP refactor (gh-1003) splits pure parse/detect helpers out of
// performGitOperations (CC 29, CRAP 144.6). These tests pin the helpers'
// behaviour directly and characterize the previously-uncovered commit/push/
// verify tail through the full action() flow.
suite('developTicketAndCreatePR > performGitOperations helpers (gh-1003)', function () {

    test('sanitizeCommitMessage keeps plain messages and escapes shell metacharacters', function () {
        var mod = loadDevelopTicketAndCreatePR({});
        assert.equal(typeof mod.sanitizeCommitMessage, 'function',
            'gh-1003 extracts the commit-message sanitizer for direct characterization');
        assert.equal(mod.sanitizeCommitMessage('gh-1003 Work on TS-1'), 'gh-1003 Work on TS-1');
        assert.equal(mod.sanitizeCommitMessage('say "hi"'), 'say \\"hi\\"');
        assert.equal(mod.sanitizeCommitMessage('a>b|c;d`e$f\ng'), 'a b c d e f g',
            'shell metacharacters become spaces, whitespace collapses');
        assert.equal(mod.sanitizeCommitMessage('  x\ny\tz  '), 'x y z',
            'newlines/tabs collapse into single spaces and the result is trimmed');
    });

    test('parseAheadCount parses rev-list counts and defaults junk to zero', function () {
        var mod = loadDevelopTicketAndCreatePR({});
        assert.equal(typeof mod.parseAheadCount, 'function',
            'gh-1003 extracts the ahead-count parser for direct characterization');
        assert.equal(mod.parseAheadCount('2'), 2);
        assert.equal(mod.parseAheadCount(' 3\n'), 3);
        assert.equal(mod.parseAheadCount('0'), 0);
        assert.equal(mod.parseAheadCount(''), 0);
        assert.equal(mod.parseAheadCount('abc'), 0);
        assert.equal(mod.parseAheadCount(undefined), 0);
        assert.equal(mod.parseAheadCount(null), 0);
    });

    test('hasStagedChanges treats blank or missing diff-stat as nothing staged', function () {
        var mod = loadDevelopTicketAndCreatePR({});
        assert.equal(typeof mod.hasStagedChanges, 'function',
            'gh-1003 extracts the staged-changes predicate for direct characterization');
        assert.equal(mod.hasStagedChanges(' js/foo.js | 2 +-\n 1 file changed'), true);
        assert.equal(mod.hasStagedChanges(' '), false);
        assert.equal(mod.hasStagedChanges(''), false);
        assert.equal(mod.hasStagedChanges(null), false);
        assert.equal(mod.hasStagedChanges(undefined), false);
    });

    test('detectPushFailure: a thrown push fails, soft-rejection markers fail, clean output passes', function () {
        var mod = loadDevelopTicketAndCreatePR({});
        assert.equal(typeof mod.detectPushFailure, 'function',
            'gh-1003 extracts the push-failure detector for direct characterization');
        var markers = ['remote rejected', 'GH013', 'error: failed to push', 'push declined', 'non-fast-forward', 'rejected'];
        for (var i = 0; i < markers.length; i++) {
            assert.equal(mod.detectPushFailure('remote: ' + markers[i] + ' (more text)', false), true,
                'marker must be detected: ' + markers[i]);
        }
        assert.equal(mod.detectPushFailure('GH013 + non-fast-forward in one output', false), true,
            'multi-marker output still fails (loop case)');
        assert.equal(mod.detectPushFailure('Everything up-to-date', false), false);
        assert.equal(mod.detectPushFailure('Everything up-to-date', true), true,
            'thrown push short-circuits true before the marker scan');
        assert.equal(mod.detectPushFailure(undefined, true), true,
            'thrown push stays true even without output (original || chain short-circuit)');
        assert.throws(function () { mod.detectPushFailure(undefined, false); },
            'undefined output without a thrown exception throws, exactly like the original indexOf chain');
    });

    test('branchMissingOnRemote detects a missing refs/heads entry', function () {
        var mod = loadDevelopTicketAndCreatePR({});
        assert.equal(typeof mod.branchMissingOnRemote, 'function',
            'gh-1003 extracts the remote-branch presence probe for direct characterization');
        assert.equal(mod.branchMissingOnRemote('abc123\trefs/heads/ai/TS-9', 'ai/TS-9'), false);
        assert.equal(mod.branchMissingOnRemote('', 'ai/TS-9'), true);
        assert.equal(mod.branchMissingOnRemote(undefined, 'ai/TS-9'), true);
        assert.equal(mod.branchMissingOnRemote('abc123\trefs/heads/main', 'ai/TS-9'), true);
    });

    // Full-flow git mock for the commit/push/verify tail: staged changes are
    // present (diff --cached --stat non-empty), so performGitOperations takes
    // the commit path instead of the nothing-staged path the other mocks drive.
    // Respond closure factory: throws the precomputed failure when set,
    // otherwise returns the canned value — keeps every respond closure
    // operator-free (gh-1003 CRAP ratchet measures test helpers too).
    function throwOrReturn(err, value) {
        return function () {
            if (err) {
                throw err;
            }
            return value;
        };
    }

    function gh1003CommitPathMock(branchName, prUrl, opts) {
        opts = opts || {};
        // Precompute every variant payload so the respond closures stay
        // operator-free — the CRAP ratchet measures test helpers too and
        // nested-closure complexity aggregates into the factory (gh-1003).
        var statOutput = ' js/foo.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n';
        var notIgnoredProbe = new Error('Command execution failed (exit code 1)');
        var commitFailure = null;
        var pushFailure = null;
        var pushOutput = '';
        var branchRefLine = 'abc123\trefs/heads/' + branchName;
        if (opts.commitThrows) {
            commitFailure = new Error('cannot run git commit');
        }
        if (opts.pushThrows) {
            // Note: retryAfterPushFailure recognizes only 'remote rejected' /
            // 'GH013' / 'error: failed to push' / 'push declined' — a thrown
            // message containing one of those keeps the retry honest; a bare
            // 'non-fast-forward' would make the force-retry read as success
            // (pre-existing behaviour).
            pushFailure = new Error('remote rejected (non-fast-forward), index packed failed');
        }
        if (opts.pushError) {
            pushOutput = opts.pushError;
        }
        var mergeBaseFailure = null;
        if (opts.mergeBaseThrows) {
            mergeBaseFailure = new Error('no merge base');
        }
        if (opts.branchOnRemote === false) {
            branchRefLine = '';
        }
        var table = [
            { match: 'gh pr list --head ' + branchName, respond: function () { return ''; } },
            { match: 'git branch --show-current', respond: function () { return branchName; } },
            { match: 'git ls-files -- ', respond: function () { return ''; } },
            { match: 'git check-ignore', respond: function () { throw notIgnoredProbe; } },
            { match: 'git add . --', respond: function () { return ''; } },
            { match: 'git diff --cached --stat', respond: function () { return statOutput; } },
            { match: 'git commit', respond: throwOrReturn(commitFailure, '') },
            { match: 'git rev-list --count', respond: function () { return '0'; } },
            { match: 'git fetch', respond: function () { return ''; } },
            { match: 'git rev-parse origin/', respond: function () { return 'basesha123'; } },
            { match: 'git merge-base', respond: throwOrReturn(mergeBaseFailure, 'basesha123') },
            { match: 'git push', respond: throwOrReturn(pushFailure, pushOutput) },
            { match: 'git ls-remote --heads origin main', respond: function () { return 'sha9\trefs/heads/main'; } },
            { match: 'git ls-remote --heads origin ' + branchName, respond: function () { return branchRefLine; } },
            { match: 'gh pr create', respond: function () { return prUrl; } }
        ];
        return dispatchGitMock(table);
    }

    // Shared first-prefix-match dispatcher for table-driven git mocks —
    // hoisted so its loop does not aggregate into the factory's CRAP (gh-1003).
    function dispatchGitMock(table) {
        return function (args) {
            var command = args.command;
            for (var i = 0; i < table.length; i++) {
                if (command.indexOf(table[i].match) === 0) {
                    return table[i].respond();
                }
            }
            return '';
        };
    }

    function runCommitPathAction(opts, prUrl) {
        var movedTo = [];
        var comments = [];
        var loaded = loadForPrTail({
            cli_execute_command: gh1003CommitPathMock('ai/TS-40', prUrl || '', opts),
            jira_post_comment: function (args) { comments.push(args); },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function () { }
        }, { responseMd: '### What changed\n- Fixed the parser.\n' });
        var caught = null;
        var result = null;
        try {
            result = loaded.mod.action({
                ticket: { key: 'TS-40', fields: { summary: 'commit path', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: {},
                response: '### What changed\n- Fixed the parser.\n'
            });
        } catch (e) {
            caught = e;
        }
        return { result: result, caught: caught, movedTo: movedTo, comments: comments };
    }

    test('commit path + soft-rejected push (GH013 text, exit 0) → push-failure reset for retry, no PR, no silent green', function () {
        var run = runCommitPathAction({ pushError: 'remote rejected (GH013: push declined, non-fast-forward)' });
        assert.equal(run.caught, null, 'a retryable push failure must not fail the run RED');
        assert.equal(run.result.path, 'development-reset-for-retry',
            'soft-rejected push lands in the retryable reset path');
        assert.deepEqual(run.movedTo, ['Ready For Development']);
        assert.equal(run.comments.length, 1, 'the push-failure stage comment is posted');
        assert.contains(run.comments[0].comment, 'Push');
    });

    test('commit path + thrown push (non-fast-forward exception) → same push-failure reset for retry', function () {
        var run = runCommitPathAction({ pushThrows: true });
        assert.equal(run.caught, null);
        assert.equal(run.result.path, 'development-reset-for-retry');
        assert.deepEqual(run.movedTo, ['Ready For Development']);
    });

    test('commit path + push ok + branch missing on remote → push-failure reset (branch was not found after push)', function () {
        var run = runCommitPathAction({ branchOnRemote: false });
        assert.equal(run.caught, null);
        assert.equal(run.result.path, 'development-reset-for-retry');
        assert.deepEqual(run.movedTo, ['Ready For Development']);
    });

    test('commit path + merge sync failure (no merge base) → leg fails RED with gitOperationsFailure marker', function () {
        // syncBranchWithBase (real prHelper) returns its unrecoverable failure
        // when HEAD has no merge base with origin/main: merge-base keeps
        // failing (even after the deepen fetches) → isMergeSyncFailure.
        var movedTo = [];
        var loaded = loadForPrTail({
            cli_execute_command: gh1003CommitPathMock('ai/TS-41', '', { mergeBaseThrows: true }),
            jira_post_comment: function () { },
            jira_move_to_status: function (args) { movedTo.push(args.statusName); },
            jira_remove_label: function () { }
        }, { responseMd: '### What changed\n- Fixed.\n' });
        var caught = null;
        try {
            loaded.mod.action({
                ticket: { key: 'TS-41', fields: { summary: 'sync failure', description: '', labels: [] } },
                metadata: { contextId: 'sm_story_development' },
                customParams: {},
                response: '### What changed\n- Fixed.\n'
            });
        } catch (e) {
            caught = e;
        }
        assert.ok(caught, 'an unrecoverable merge-sync failure must fail the run RED');
        assert.equal(caught && caught.gitOperationsFailure, true,
            'thrown error carries the gitOperationsFailure marker');
        assert.deepEqual(movedTo, ['Ready For Development'],
            'ticket is still reset for retry before the leg fails');
    });

    test('commit path + git commit throws → generic git-operations failure fails the run RED (marked)', function () {
        var run = runCommitPathAction({ commitThrows: true });
        assert.ok(run.caught, 'an unexpected git failure must fail the run RED');
        assert.equal(run.caught && run.caught.gitOperationsFailure, true,
            'thrown error carries the gitOperationsFailure marker');
        assert.deepEqual(run.movedTo, ['Ready For Development'],
            'ticket is still reset for retry before the leg fails');
    });
});
