/**
 * Unit tests for js/developTicketAndCreatePR.js failure recovery.
 */

function loadDevelopTicketAndCreatePR(mocks) {
    return loadModule(
        'js/developTicketAndCreatePR.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function(key) { return key; } },
            './common/pullRequest.js': { cleanCommandOutput: function(output) { return (output || '').trim(); } },
            './common/submodules.js': {},
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

});
