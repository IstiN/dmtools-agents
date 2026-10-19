function d2Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

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
        jira_search_by_jql: function() { return []; },
        cli_execute_command: function() { return ''; },
        file_read: fileReadMock,
        file_write: function() {}
    };

    var allMocks = Object.assign({}, defaults, mocks);

    var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), allMocks);
    var prHelper = loadModule('js/common/pullRequest.js', makeRequire({
        './mergeState.js': loadModule('js/common/mergeState.js'),
        './common/mergeState.js': loadModule('js/common/mergeState.js')
    }), allMocks);
    var sharedModule = loadModule('js/postStoryTestAutomationShared.js', makeRequire({}), allMocks);

    return loadModule(
        'js/postStoryTestAutomationResults.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './config.js': configModule,
            './common/pullRequest.js': prHelper,
            './postStoryTestAutomationShared.js': sharedModule,
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
            },
            './common/trackers.js': d2Trackers(allMocks)
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
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-80') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-80';
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
                        overall: 'passed',
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
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-100') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-100';
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

    test('moves skipped TCs directly to Skipped status without PR review', function() {
        var statusMoves = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'TS-105',
                        overall: 'passed',
                        summary: 'Some tests skipped',
                        results: [
                            { testCaseKey: 'TS-106', status: 'passed', testPath: 'testing/tests/TS-106/test.py' },
                            { testCaseKey: 'TS-107', status: 'skipped', testPath: 'testing/tests/TS-107/test.py' }
                        ]
                    });
                }
                if (opts.path === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'test/TS-105';
                if (opts.command === 'git status --short -- testing') return '?? testing/tests/TS-106/test.py';
                if (opts.command === 'git diff --cached --stat') return ' testing/tests/TS-106/test.py | 1 +';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-105') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-105';
                if (opts.command.indexOf('gh pr list --head test/TS-105') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) return 'https://github.com/IstiN/trackstate/pull/105';
                return '';
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-105', fields: { summary: 'Skipped test story' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.deepEqual(statusMoves, [
            { key: 'TS-106', statusName: 'In Review - Passed' },
            { key: 'TS-107', statusName: 'Skipped' },
            { key: 'TS-105', statusName: 'In Testing' }
        ]);
    });

    test('moves irrelevant TCs to Irrelevant and deletes their test code', function() {
        var statusMoves = [];
        var gitCommands = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'TS-108',
                        overall: 'passed',
                        summary: 'One test irrelevant',
                        results: [
                            { testCaseKey: 'TS-109', status: 'passed', testPath: 'testing/tests/TS-109/test.py' },
                            { testCaseKey: 'TS-110', status: 'irrelevant' }
                        ]
                    });
                }
                if (opts.path === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                gitCommands.push(opts.command);
                if (opts.command === 'git branch --show-current') return 'test/TS-108';
                if (opts.command === 'git status --short -- testing') return 'D  testing/tests/TS-110/test.py\n?? testing/tests/TS-109/test.py';
                if (opts.command === 'git diff --cached --stat') return ' testing/tests/TS-110/test.py | 1 -';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-108') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-108';
                if (opts.command.indexOf('gh pr list --head test/TS-108') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) return 'https://github.com/IstiN/trackstate/pull/108';
                if (opts.command.indexOf('git rm') === 0) return '';
                return '';
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-108', fields: { summary: 'Irrelevant test story' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.contains(gitCommands.join('\n'), 'git rm -r --ignore-unmatch -- testing/tests/TS-110');
        assert.deepEqual(statusMoves, [
            { key: 'TS-109', statusName: 'In Review - Passed' },
            { key: 'TS-110', statusName: 'Irrelevant' },
            { key: 'TS-108', statusName: 'In Testing' }
        ]);
    });

    test('Bug with product failure returns to Ready For Development and finalizes failed TCs', function() {
        var statusMoves = [];
        var comments = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'BUG-150',
                        overall: 'failed',
                        summary: 'Fix did not work',
                        results: [
                            { testCaseKey: 'TS-151', status: 'passed', testPath: 'testing/tests/TS-151/test.py' },
                            { testCaseKey: 'TS-152', status: 'failed', testPath: 'testing/tests/TS-152/test.py', failedDescriptionFile: 'outputs/failed_description_TS-152.md', failureSummary: 'regression' }
                        ]
                    });
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function() { return ''; },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'BUG-150', fields: { summary: 'Broken fix', issuetype: { name: 'Bug' } } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.status, 'failed');
        assert.deepEqual(result.failedTestCases, ['TS-152']);
        assert.deepEqual(statusMoves, [
            { key: 'TS-152', statusName: 'In Review - Failed' },
            { key: 'TS-152', statusName: 'Failed' },
            { key: 'BUG-150', statusName: 'Ready For Development' }
        ]);
        assert.ok(comments.some(function(c) { return c.indexOf('Bug Fix Did Not Pass Automated Tests') !== -1; }));
        assert.ok(comments.some(function(c) { return c.indexOf('TS-152') !== -1 && c.indexOf('regression') !== -1; }));
    });

    test('ignores result entries with an unknown status', function() {
        var statusMoves = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'TS-160',
                        overall: 'passed',
                        summary: 'One unknown entry',
                        results: [
                            { testCaseKey: 'TS-161', status: 'passed', testPath: 'testing/tests/TS-161/test.py' },
                            { testCaseKey: 'TS-162', status: 'in_progress' }
                        ]
                    });
                }
                if (opts.path === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'test/TS-160';
                if (opts.command === 'git status --short -- testing') return '?? testing/tests/TS-161/test.py';
                if (opts.command === 'git diff --cached --stat') return ' testing/tests/TS-161/test.py | 1 +';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-160') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-160';
                if (opts.command.indexOf('gh pr list --head test/TS-160') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) return 'https://github.com/IstiN/trackstate/pull/160';
                return '';
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-160', fields: { summary: 'Unknown status story' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.deepEqual(statusMoves, [
            { key: 'TS-161', statusName: 'In Review - Passed' },
            { key: 'TS-160', statusName: 'In Testing' }
        ]);
    });

    test('resumes agent when linked Test Cases are missing from result', function() {
        var resumeCommands = [];
        var filesWritten = {};
        var resultReads = 0;

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                var p = opts.path;
                if (p === 'input/TS-110/linked_test_cases.json') {
                    return JSON.stringify({ storyKey: 'TS-110', testCases: [{ key: 'TS-111' }, { key: 'TS-112' }] });
                }
                if (p === 'outputs/story_test_automation_result.json') {
                    resultReads++;
                    if (resultReads === 1) {
                        return JSON.stringify({
                            storyKey: 'TS-110',
                            overall: 'passed',
                            results: [{ testCaseKey: 'TS-111', status: 'passed', testPath: 'testing/tests/TS-111/test.py' }]
                        });
                    }
                    return JSON.stringify({
                        storyKey: 'TS-110',
                        overall: 'passed',
                        results: [
                            { testCaseKey: 'TS-111', status: 'passed', testPath: 'testing/tests/TS-111/test.py' },
                            { testCaseKey: 'TS-112', status: 'passed', testPath: 'testing/tests/TS-112/test.py' }
                        ]
                    });
                }
                if (p === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
                if (p && p.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            file_write: function(opts) { filesWritten[opts.path] = opts.content; },
            cli_execute_command: function(opts) {
                if (opts.command.indexOf('bash agents/scripts/run-agent.sh') === 0) {
                    resumeCommands.push(opts.command);
                    return '';
                }
                if (opts.command === 'git branch --show-current') return 'test/TS-110';
                if (opts.command === 'git status --short -- testing') return '';
                if (opts.command === 'git diff --cached --stat') return '';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-110') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-110';
                return '';
            },
            jira_move_to_status: function() {},
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-110', fields: { summary: 'Resume story' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(resumeCommands.length, 1);
        assert.ok(resumeCommands[0].indexOf('outputs/.story-test-resume-prompt.md') !== -1);
        assert.ok(filesWritten['outputs/.story-test-resume-attempted'] === '1');
        assert.ok(filesWritten['outputs/.story-test-resume-prompt.md'] && filesWritten['outputs/.story-test-resume-prompt.md'].indexOf('TS-112') !== -1);
    });

    test('returns error when linked Test Cases remain missing after max resume attempts', function() {
        var resumeCommands = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                var p = opts.path;
                if (p === 'input/TS-120/linked_test_cases.json') {
                    return JSON.stringify({ storyKey: 'TS-120', testCases: [{ key: 'TS-121' }] });
                }
                if (p === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({ storyKey: 'TS-120', overall: 'passed', results: [] });
                }
                if (p === 'outputs/.story-test-resume-attempted') return '2';
                if (p && p.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command.indexOf('bash agents/scripts/run-agent.sh') === 0) {
                    resumeCommands.push(opts.command);
                }
                return '';
            },
            jira_post_comment: function() {},
            jira_move_to_status: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-120', fields: { summary: 'Exhausted resume story' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('Missing Test Case results') !== -1);
        assert.ok(result.error.indexOf('TS-121') !== -1);
        assert.equal(resumeCommands.length, 0);
    });

    test('sanitizes shell metacharacters in commit message from ticket summary', function() {
        var commands = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'TS-140',
                        overall: 'passed',
                        summary: 'Mixed',
                        results: [
                            { testCaseKey: 'TS-141', status: 'passed', testPath: 'testing/tests/TS-141/test.py' }
                        ]
                    });
                }
                if (opts.path === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git branch --show-current') return 'test/TS-140';
                if (opts.command === 'git status --short -- testing') return '?? testing/tests/TS-141/test.py';
                if (opts.command === 'git diff --cached --stat') return ' testing/tests/TS-141/test.py | 1 +';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-140') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-140';
                if (opts.command.indexOf('gh pr list --head test/TS-140') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) return 'https://github.com/IstiN/trackstate/pull/140';
                return '';
            },
            jira_move_to_status: function() {},
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-140', fields: { summary: "README uses '<repository>' and --header instead of '<fork>' and -H" } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        var commitCmd = commands.filter(function(c) { return c.indexOf('git commit -m') === 0; })[0];
        assert.ok(commitCmd, 'commit command was issued');
        assert.notContains(commitCmd, '<');
        assert.notContains(commitCmd, '>');
        assert.notContains(commitCmd, ';');
        assert.notContains(commitCmd, '|');
        assert.notContains(commitCmd, '&');
        assert.contains(commitCmd, 'TS-140 test: automate README uses');
    });

});

// ── gh-916: stage-label fallback for per-TC final/intermediate status moves ──

suite('postStoryTestAutomationResults: stage-label fallback (gh-916)', function() {
    function gh916StoryResult(resultJson, mocks) {
        return loadPostStoryTestAutomationResults(Object.assign({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') return JSON.stringify(resultJson);
                if (opts.path === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'test/TS-299';
                if (opts.command === 'git status --short -- testing') return '';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-299') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/TS-299';
                if (opts.command.indexOf('gh pr list --head test/TS-299') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) return 'https://github.com/IstiN/trackstate/pull/299';
                return '';
            },
            jira_post_comment: function() {},
            jira_remove_label: function() {},
            jira_update_field: function() {},
            jira_attach_file_to_ticket: function() {}
        }, mocks));
    }

    test("'label' mode: a rejected In Review - Failed move marks stage_in_review_failed, no throw", function() {
        var added = [];
        var moves = [];
        var module = gh916StoryResult(
            { overall: 'failed', results: [{ testCaseKey: 'TS-300', status: 'failed', testPath: 'testing/tests/TS-300/test.py' }] },
            {
                jira_move_to_status: function(args) {
                    moves.push(args);
                    throw new Error("The field 'State' contains the value 'In Review - Failed' that is not in the list of supported values");
                },
                jira_add_label: function(args) { added.push(args); }
            }
        );

        var result = module.action({
            ticket: { key: 'TS-299', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true);
        assert.ok(moves.some(function(m) { return m.statusName === 'In Review - Failed'; }));
        assert.ok(added.some(function(a) { return a.key === 'TS-300' && a.label === 'stage_in_review_failed'; }));
    });

    test("'label' mode: skipped and irrelevant TCs get their stage markers when the move is rejected", function() {
        var added = [];
        var module = gh916StoryResult(
            {
                overall: 'passed',
                results: [
                    { testCaseKey: 'TS-301', status: 'skipped', testPath: 'testing/tests/TS-301/test.py' },
                    { testCaseKey: 'TS-302', status: 'irrelevant' }
                ]
            },
            {
                jira_move_to_status: function() { throw new Error('state rejected'); },
                jira_add_label: function(args) { added.push(args); }
            }
        );

        var result = module.action({
            ticket: { key: 'TS-299', fields: { issuetype: { name: 'Story' } } },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true);
        assert.ok(added.some(function(a) { return a.key === 'TS-301' && a.label === 'stage_skipped'; }));
        assert.ok(added.some(function(a) { return a.key === 'TS-302' && a.label === 'stage_irrelevant'; }));
    });
});

// ── gh-1080: characterization tests pinning current action() behaviour before
// the CRAP split. Failure/exception branches of the git/PR phase and the
// per-step guards are exercised here. ──

suite('postStoryTestAutomationResults: characterization (gh-1080 CRAP split)', function() {

    function resultJsonOf(storyKey) {
        return JSON.stringify({
            storyKey: storyKey,
            overall: 'passed',
            summary: 'Characterization',
            results: [{ testCaseKey: storyKey + '-1', status: 'passed', testPath: 'testing/tests/' + storyKey + '-1/test.py' }]
        });
    }

    function standardResultFileRead(storyKey) {
        return function(opts) {
            if (opts.path === 'outputs/story_test_automation_result.json') return resultJsonOf(storyKey);
            if (opts.path === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
            if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
            return null;
        };
    }

    test('a failing git author configuration only warns — the run continues', function() {
        var commands = [];
        var module = loadPostStoryTestAutomationResults({
            file_read: standardResultFileRead('TS-400'),
            cli_execute_command: function(opts) {
                commands.push(opts.command);
                if (opts.command === 'git config user.name "AI Teammate"') throw new Error('git config boom');
                if (opts.command === 'git branch --show-current') return 'test/TS-400';
                if (opts.command === 'git status --short -- testing') return '?? testing/tests/TS-400-1/test.py';
                if (opts.command === 'git diff --cached --stat') return ' testing/tests/TS-400-1/test.py | 1 +';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-400') === 0) return '9a7e2aec\trefs/heads/test/TS-400';
                if (opts.command.indexOf('gh pr list --head test/TS-400') === 0) return '';
                if (opts.command.indexOf('gh pr create') === 0) return 'https://github.com/example/repo/pull/400';
                return '';
            },
            jira_move_to_status: function() {},
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-400', fields: { summary: 'Author config failure' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true, 'the author config failure must not fail the run');
        assert.ok(commands.indexOf('git config user.name "AI Teammate"') !== -1);
    });

    test('failing git operations post the failure comment and return an error result', function() {
        var comments = [];
        var removedLabels = [];
        var statusMoves = [];
        var module = loadPostStoryTestAutomationResults({
            file_read: standardResultFileRead('TS-401'),
            cli_execute_command: function(opts) {
                if (opts.command === 'git add testing/') throw new Error('index.lock exists');
                if (opts.command === 'git branch --show-current') return 'test/TS-401';
                return '';
            },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-401', fields: { summary: 'Git failure' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'Git operations failed: Error: index.lock exists');
        assert.ok(comments.some(function(c) { return c.indexOf('Git Operations Failed') !== -1 && c.indexOf('index.lock') !== -1; }));
        assert.ok(removedLabels.length > 0, 'labels are cleaned up on the failure path');
        assert.deepEqual(statusMoves, [], 'no status moves after the git failure');
    });

    test('a failed PR creation posts the failure comment and returns an error result', function() {
        var comments = [];
        var removedLabels = [];
        var statusMoves = [];
        var module = loadPostStoryTestAutomationResults({
            file_read: standardResultFileRead('TS-402'),
            cli_execute_command: function(opts) {
                if (opts.command.indexOf('gh pr create') === 0) throw new Error('gh: Permission denied');
                if (opts.command === 'git branch --show-current') return 'test/TS-402';
                if (opts.command === 'git status --short -- testing') return '?? testing/tests/TS-402-1/test.py';
                if (opts.command === 'git diff --cached --stat') return ' testing/tests/TS-402-1/test.py | 1 +';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-402') === 0) return '9a7e2aec\trefs/heads/test/TS-402';
                if (opts.command.indexOf('gh pr list --head test/TS-402') === 0) return '';
                return '';
            },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-402', fields: { summary: 'PR failure' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'PR creation failed');
        assert.ok(comments.some(function(c) { return c.indexOf('PR Creation Failed') !== -1 && c.indexOf('test/TS-402') !== -1; }));
        assert.ok(removedLabels.length > 0, 'labels are cleaned up on the failure path');
        assert.deepEqual(statusMoves, [], 'no status moves after the PR failure');
    });

    test('a throwing git branch query fails through the outer error path', function() {
        var comments = [];
        var module = loadPostStoryTestAutomationResults({
            file_read: standardResultFileRead('TS-403'),
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') throw new Error('not a git repo');
                return '';
            },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-403', fields: { summary: 'Branch failure' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'not a git repo');
        assert.ok(comments.some(function(c) { return c.indexOf('Story Test Automation Error') !== -1 && c.indexOf('not a git repo') !== -1; }));
    });

    test("'none' mode: a rejected In Testing story move is caught — the run still succeeds", function() {
        var statusMoves = [];
        var module = loadPostStoryTestAutomationResults({
            file_read: standardResultFileRead('TS-404'),
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'test/TS-404';
                if (opts.command === 'git status --short -- testing') return '';
                if (opts.command === 'git diff --cached --stat') return '';
                if (opts.command.indexOf('git ls-remote --heads origin test/TS-404') === 0) return '9a7e2aec\trefs/heads/test/TS-404';
                return '';
            },
            jira_move_to_status: function(args) {
                if (args.statusName === 'In Testing') throw new Error('state rejected');
                statusMoves.push(args);
            },
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-404', fields: { summary: 'In Testing rejection' } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.status, 'passed');
        assert.ok(statusMoves.some(function(m) { return m.statusName === 'Passed'; }), 'TC finalization still ran');
        assert.ok(!statusMoves.some(function(m) { return m.statusName === 'In Testing'; }), 'the story move was rejected');
    });
});
