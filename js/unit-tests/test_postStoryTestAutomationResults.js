/**
 * Unit tests for js/postStoryTestAutomationResults.js
 */

function loadPostStoryTestAutomationResults(mocks) {
    var fileReadMock = mocks.file_read || function(opts) {
        if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
        try { return file_read(opts); } catch (e) { return null; }
    };

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } }
        }),
        { file_read: fileReadMock }
    );

    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_add_label: function() {},
        jira_remove_label: function() {},
        jira_update_field: function() {},
        jira_attach_file_to_ticket: function() {},
        cli_execute_command: function() { return ''; },
        file_read: fileReadMock,
        file_write: function() {}
    };

    var allMocks = Object.assign({}, defaults, mocks);

    var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), allMocks);
    var prHelper = loadModule('js/common/pullRequest.js', null, allMocks);

    return loadModule(
        'js/postStoryTestAutomationResults.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './config.js': configModule,
            './common/pullRequest.js': prHelper,
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function(opts) {
                    return (mocks && mocks.triggerConfiguredWorkflowForTicket)
                        ? mocks.triggerConfiguredWorkflowForTicket(opts)
                        : false;
                },
                triggerSmIfIdle: function() { return { success: true }; }
            },
            './common/outputFiles.js': outputFiles,
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function() {}
            }
        }),
        allMocks
    );
}

suite('postStoryTestAutomationResults: bulk result processing', function() {

    test('creates PR, moves TCs to In Review statuses, attaches failed description', function() {
        var commands = [];
        var statusMoves = [];
        var attachments = [];
        var fieldUpdates = [];
        var prCreated = false;

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'TS-80',
                        overall: 'failed',
                        summary: 'Mixed results',
                        results: [
                            { testCaseKey: 'TS-81', status: 'passed', testPath: 'testing/tests/TS-81/test.py' },
                            { testCaseKey: 'TS-82', status: 'failed', testPath: 'testing/tests/TS-82/test.py', failedDescriptionFile: 'outputs/failed_description_TS-82.md', failureSummary: 'assertion failed' }
                        ]
                    });
                }
                if (opts.path === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git branch --show-current') return 'test/TS-80';
                if (opts.command === 'git status --short -- testing') return '?? testing/tests/TS-81/test.py';
                if (opts.command === 'git diff --cached --stat') return ' testing/tests/TS-81/test.py | 1 +';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-80') === 0) return 'abc\trefs/heads/test/TS-80';
                if (opts.command.indexOf('gh pr list --head test/TS-80') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) {
                    prCreated = true;
                    return 'https://github.com/IstiN/trackstate/pull/80';
                }
                return '';
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_attach_file_to_ticket: function(args) { attachments.push(args); },
            jira_update_field: function(args) { fieldUpdates.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-80', fields: { summary: 'Story bulk test' } },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_story_test_automation_triggered',
                    autoStartReview: true,
                    autoStartReviewConfigFile: 'agents/pr_story_test_automation_review.json'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.status, 'failed');
        assert.equal(prCreated, true);
        assert.deepEqual(statusMoves, [
            { key: 'TS-81', statusName: 'In Review - Passed' },
            { key: 'TS-82', statusName: 'In Review - Failed' },
            { key: 'TS-80', statusName: 'In Testing' }
        ]);
        assert.equal(attachments.length, 1);
        assert.equal(attachments[0].ticketKey, 'TS-82');
        assert.equal(attachments[0].filePath, 'outputs/failed_description_TS-82.md');
        assert.equal(fieldUpdates.length, 1);
        assert.equal(fieldUpdates[0].key, 'TS-82');
    });

    test('blocked_by_human moves Story to Blocked and skips PR', function() {
        var statusMoves = [];
        var comments = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'TS-90',
                        overall: 'blocked_by_human',
                        summary: 'Missing credentials',
                        blockedReason: 'No test DB credentials',
                        results: []
                    });
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); }
        });

        var result = module.action({
            ticket: { key: 'TS-90', fields: { summary: 'Blocked story' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.status, 'blocked_by_human');
        assert.deepEqual(statusMoves, [{ key: 'TS-90', statusName: 'Blocked' }]);
        assert.ok(comments[0].indexOf('Blocked — Awaiting Human Setup') !== -1);
    });

    test('returns error when result JSON is missing', function() {
        var comments = [];
        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(args) { comments.push(args.comment); }
        });

        var result = module.action({
            ticket: { key: 'TS-99', fields: { summary: 'Missing result' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No story test result JSON found');
    });

    test('finalizes TC statuses to Passed/Failed when there are no code changes', function() {
        var statusMoves = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'TS-100',
                        overall: 'mixed',
                        summary: 'Re-test after bug fixes',
                        results: [
                            { testCaseKey: 'TS-101', status: 'passed', testPath: 'testing/tests/TS-101/test.py' },
                            { testCaseKey: 'TS-102', status: 'failed', testPath: 'testing/tests/TS-102/test.py', failedDescriptionFile: 'outputs/failed_description_TS-102.md', failureSummary: 'still failing' }
                        ]
                    });
                }
                if (opts.path === 'outputs/tracker_comment.md') return 'h3. Re-test Result';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'test/TS-100';
                if (opts.command === 'git status --short -- testing') return '';
                if (opts.command === 'git diff --cached --stat') return '';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-100') === 0) return 'abc\trefs/heads/test/TS-100';
                return '';
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-100', fields: { summary: 'Re-test story' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.deepEqual(statusMoves, [
            { key: 'TS-101', statusName: 'In Review - Passed' },
            { key: 'TS-101', statusName: 'Passed' },
            { key: 'TS-102', statusName: 'In Review - Failed' },
            { key: 'TS-102', statusName: 'Failed' },
            { key: 'TS-100', statusName: 'In Testing' }
        ]);
    });

});
