/**
 * Unit tests for js/developTicketAndCreatePR.js failure recovery.
 */

function loadDevelopTicketAndCreatePR(mocks, feedbackLoopOverrides) {
    return loadModule(
        'js/developTicketAndCreatePR.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function(key) { return key; } },
            './common/pullRequest.js': { cleanCommandOutput: function(output) { return (output || '').trim(); } },
            './common/submodules.js': {},
            './common/feedbackLoop.js': Object.assign({
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function() { return { attempted: false }; }
            }, feedbackLoopOverrides || {}),
            './common/autoStart.js': { triggerSmIfIdle: function() {} },
            './common/outputFiles.js': { readOutputFile: function() { return null; } },
            './cacheToReleases.js': {},
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        Object.assign({
            cli_execute_command: function() { return ''; },
            jira_post_comment: function() {},
            jira_move_to_status: function() {},
            jira_remove_label: function() {}
        }, mocks || {})
    );
}

// Loads developTicketAndCreatePR.js with the REAL common/pullRequest.js and
// common/submodules.js helpers (instead of the bare stubs above) so tests can
// drive performGitOperations() all the way to its "No changes were made" path,
// which the bare stubs can't reach (they lack readStagedDiffStat/buildOriginFetchCommand).
function loadDevelopTicketAndCreatePRWithRealGitHelpers(mocks) {
    var realPrHelper = loadModule('js/common/pullRequest.js', makeRequire({}), {});
    return loadModule(
        'js/developTicketAndCreatePR.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function(key) { return key; } },
            './common/pullRequest.js': realPrHelper,
            './common/submodules.js': { pushManagedSubmodules: function() {} },
            './common/feedbackLoop.js': {
                runQualityGates: function() { return { success: true }; },
                runPolicyGates: function() { return { success: true }; },
                runPostPublishGates: function() { return { success: true }; },
                resumeAgent: function() { return { attempted: false }; }
            },
            './common/autoStart.js': { triggerSmIfIdle: function() {} },
            './common/outputFiles.js': { readOutputFile: function() { return null; } },
            './cacheToReleases.js': {},
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        Object.assign({
            cli_execute_command: function() { return ''; },
            jira_post_comment: function() {},
            jira_move_to_status: function() {},
            jira_remove_label: function() {}
        }, mocks || {})
    );
}

// Common git-command mock shared by the two tests below: simulates a ticket
// branch with no staged/committed/pushed changes at all — i.e. the CLI agent
// never actually ran (which is exactly what happens when the AI CLI binary is
// missing from the runner, exit code 127).
function noChangesGitCommandMock(ticketKey, branchName) {
    return function(args) {
        var command = args.command;
        if (command.indexOf('gh pr list --head ' + branchName) === 0) return '';
        if (command === 'git branch --show-current') return branchName;
        if (command === 'git diff --cached --stat') return '';
        if (command.indexOf('git rev-list --count') === 0) return '0';
        return '';
    };
}

suite('developTicketAndCreatePR > failure recovery', function() {

    test('resets ticket and removes retry-blocking labels when git configuration fails', function() {
        var movedTo = [];
        var removedLabels = [];
        var comments = [];
        var commands = [];
        var mod = loadDevelopTicketAndCreatePR({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command.indexOf('gh pr list --head ai/TS-1') === 0) return '';
                if (args.command === 'git config user.name "AI Teammate"') throw new Error('git config failed');
                return '';
            },
            jira_post_comment: function(args) { comments.push(args); },
            jira_move_to_status: function(args) { movedTo.push(args.statusName); },
            jira_remove_label: function(args) { removedLabels.push(args.label); }
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

    test('still resets ticket and posts an honest error comment when feedbackLoop.resumeAgent itself throws (e.g. blocked by CLI_ALLOWED_COMMANDS)', function() {
        var movedTo = [];
        var comments = [];
        var mod = loadDevelopTicketAndCreatePR(
            {
                cli_execute_command: function(args) {
                    if (args.command.indexOf('gh pr list --head ai/TS-2') === 0) return '';
                    if (args.command === 'git branch --show-current') {
                        // Simulate an unrelated, unexpected failure reaching the outer catch —
                        // e.g. a transient git/filesystem error mid-workflow.
                        throw new Error('simulated unexpected git failure');
                    }
                    return '';
                },
                jira_post_comment: function(args) { comments.push(args); },
                jira_move_to_status: function(args) { movedTo.push(args.statusName); },
                jira_remove_label: function() {}
            },
            {
                // Simulate the real-world bug: the feedback loop's own self-invocation
                // (mkdir/bash/run-agent.sh --continue) gets blocked by a
                // misconfigured CLI_ALLOWED_COMMANDS whitelist and throws instead of
                // returning { attempted: false }.
                resumeAgent: function() { throw new Error('Security violation: Command not whitelisted: bash'); }
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

    test('fails the job explicitly (throws) instead of resetting for retry when the AI CLI binary is missing from the runner (exit code 127)', function() {
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
            jira_post_comment: function(args) { comments.push(args); },
            jira_move_to_status: function(args) { movedTo.push(args.statusName); },
            jira_remove_label: function(args) { removedLabels.push(args.label); }
        });

        assert.throws(function() {
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

    test('still resets ticket for retry (does not throw) on an ordinary interrupted response with no fatal environment signature', function() {
        var movedTo = [];
        var comments = [];
        var mod = loadDevelopTicketAndCreatePRWithRealGitHelpers({
            cli_execute_command: noChangesGitCommandMock('TS-4', 'ai/TS-4'),
            jira_post_comment: function(args) { comments.push(args); },
            jira_move_to_status: function(args) { movedTo.push(args.statusName); }
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

});
