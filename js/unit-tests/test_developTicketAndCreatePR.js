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

});
