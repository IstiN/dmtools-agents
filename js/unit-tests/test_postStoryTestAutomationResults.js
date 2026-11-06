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
    var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}), allMocks);
    var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthor }), allMocks);
    var bugBookkeeping = loadModule('js/common/bugBookkeeping.js', makeRequire({
        './tcRunRegistry.js': loadModule('js/common/tcRunRegistry.js', makeRequire({
            './reviewVerdicts.js': reviewVerdicts
        }), allMocks),
        './tcMaintenanceLedger.js': loadModule('js/common/tcMaintenanceLedger.js', makeRequire({ './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({})),
            './reviewVerdicts.js': reviewVerdicts
        }), allMocks),
        './machineAuthor.js': machineAuthor
    }), allMocks);
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
            './common/tcTriage.js': loadModule('js/common/tcTriage.js', makeRequire({}), allMocks),
            './common/tcMaintenanceLedger.js': loadModule('js/common/tcMaintenanceLedger.js', makeRequire({ './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({})),
                './reviewVerdicts.js': reviewVerdicts
            }), allMocks),
            './common/tcRunRegistry.js': loadModule('js/common/tcRunRegistry.js', makeRequire({
                './reviewVerdicts.js': reviewVerdicts
            }), allMocks),
            './common/tcAlternation.js': loadModule('js/common/tcAlternation.js', makeRequire({
                './tcRunRegistry.js': loadModule('js/common/tcRunRegistry.js', makeRequire({
                    './reviewVerdicts.js': reviewVerdicts
                }), allMocks),
                './tcMaintenanceLedger.js': loadModule('js/common/tcMaintenanceLedger.js', makeRequire({ './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({})),
                    './reviewVerdicts.js': reviewVerdicts
                }), allMocks)
            }), allMocks),
            './common/bugBookkeeping.js': bugBookkeeping,
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

    test('Bug with unattributed fresh TC failure routes to rework — bug state unchanged', function() {
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
                            { testCaseKey: 'TS-152', status: 'failed', testPath: 'testing/tests/TS-152/test.py', failedDescriptionFile: 'outputs/failed_description_TS-152.md', failureSummary: 'regression', errorClass: 'assertion' }
                        ]
                    });
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'test/BUG-150';
                if (opts.command === 'git rev-parse HEAD') return 'sha-current';
                return '';
            },
            jira_get_ticket: function(args) {
                if (args && args.key === 'BUG-150') {
                    return JSON.stringify({ key: 'BUG-150', fields: { comment: { comments: [] } } });
                }
                return null;
            },
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
        assert.equal(result.status, 'test_maintenance');
        assert.deepEqual(result.maintenanceTestCases, ['TS-152']);
        assert.ok(!statusMoves.some(function(m) { return m.key === 'BUG-150' && m.statusName === 'Ready For Development'; }),
            'a fresh TC failure must never bounce the bug');
        assert.deepEqual(statusMoves, [
            { key: 'TS-152', statusName: 'In Review - Failed' }
        ]);
        assert.ok(comments.some(function(c) { return c.indexOf('gh-1329') !== -1 && c.indexOf('TS-152') !== -1; }));
        assert.ok(comments.some(function(c) { return c.indexOf('dmtools:tc-maintenance-ledger') !== -1; }),
            'the finding lands in the maintenance ledger');
        assert.ok(comments.some(function(c) { return c.indexOf('dmtools:tc-run-registry') !== -1; }),
            'the passed TC is recorded as validated (lastGreenSha)');
        // Failing scripts are always persisted (commit + push, no PR).
        assert.ok(comments.every(function(c) { return c.indexOf('pull/') === -1 || c.indexOf('Automated story test') === -1; }));
    });

    test('Bug bounce requires attribution: own-oracle red + AC violated bounces once with evidence', function() {
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
                            { testCaseKey: 'TS-152', status: 'failed', testPath: 'testing/tests/TS-152/test.py', failedDescriptionFile: 'outputs/failed_description_TS-152.md', failureSummary: 'regression', errorClass: 'assertion', acVerdict: 'violated' }
                        ]
                    });
                }
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'test/BUG-150';
                if (opts.command === 'git rev-parse HEAD') return 'sha-current';
                return '';
            },
            jira_get_ticket: function(args) {
                if (args && args.key === 'BUG-150') {
                    return JSON.stringify({ key: 'BUG-150', fields: { comment: { comments: [] } } });
                }
                return null;
            },
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

    test('Bug with blocked_by_human overall skips triage — environment owns it', function() {
        var statusMoves = [];
        var comments = [];

        var module = loadPostStoryTestAutomationResults({
            file_read: function(opts) {
                if (opts.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({
                        storyKey: 'BUG-160',
                        overall: 'blocked_by_human',
                        blockedReason: 'Missing credentials',
                        results: [
                            { testCaseKey: 'TS-161', status: 'failed', testPath: 'testing/tests/TS-161/test.py', acVerdict: 'violated' }
                        ]
                    });
                }
                if (opts.path === 'outputs/tracker_comment.md') return 'h3. Story Test Result';
                if (opts.path && opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if (opts.command === 'git branch --show-current') return 'test/BUG-160';
                if (opts.command === 'git status --short -- testing') return '';
                if (opts.command === 'git diff --cached --stat') return '';
                if (opts.command.indexOf('git ls-remote --heads origin test/BUG-160') === 0) return '9a7e2aec9a7e2aec9a7e2aec9a7e2aec9a7e2aec\trefs/heads/test/BUG-160';
                return '';
            },
            jira_get_ticket: function() { return JSON.stringify({ key: 'BUG-160', fields: { comment: { comments: [] } } }); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_attach_file_to_ticket: function() {},
            jira_update_field: function() {}
        });

        var result = module.action({
            ticket: { key: 'BUG-160', fields: { summary: 'Env blocked bug', issuetype: { name: 'Bug' } } },
            jobParams: { customParams: { removeLabel: 'sm_story_test_automation_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.status, 'blocked_by_human');
        assert.ok(statusMoves.some(function(m) { return m.key === 'BUG-160' && m.statusName === 'Blocked'; }));
        assert.ok(!statusMoves.some(function(m) { return m.key === 'BUG-160' && m.statusName === 'Ready For Development'; }));
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

// ── gh-1329: validated-guard triage — the mechanical decision table ─────────

// ── gh-1329 triage fixtures + harness (shared by the triage suites) ─────────

var REGISTRY_MARKER_TS152 = '<!-- dmtools:tc-run-registry {"v":1,"at":"2026-01-01T00:00:00.000Z","tcs":{"TS-152":{"role":"regression-guard","validated":true,"lastGreenSha":"sha-green","lastGreenEnvFingerprint":"env-1","lastGreenAt":"2026-01-01T00:00:00.000Z","greens":1,"redRounds":0,"lastRedAt":null,"lastVerdict":null}}} -->\n\ud83d\udcd8 registry fixture';

function bugComments(comments) {
    return function(args) {
        if (args && args.key === 'BUG-150') {
            return JSON.stringify({ key: 'BUG-150', fields: { comment: { comments: comments } } });
        }
        return null;
    };
}

function guardFailedResult(extra) {
    return {
        testCaseKey: 'TS-152',
        status: 'failed',
        testPath: 'testing/tests/TS-152/test_guard.py',
        failedDescriptionFile: 'outputs/failed_description_TS-152.md',
        failureSummary: 'guard assertion',
        errorClass: 'assertion',
        envFingerprint: 'env-1',
        role: 'regression guard'
    };
}

/** The file_read mock for triageModule: the result JSON + linked TC list. */
function triageFileReader(resultEntries, linkedTestCases, overall) {
    return function(fpath) {
        if (fpath.path === 'outputs/story_test_automation_result.json') {
            return JSON.stringify({
                storyKey: 'BUG-150',
                overall: overall || 'failed',
                summary: 'guard red',
                results: resultEntries
            });
        }
        if (fpath.path === 'input/BUG-150/linked_test_cases.json') {
            return JSON.stringify({ testCases: linkedTestCases });
        }
        if (fpath.path && fpath.path.indexOf('.dmtools/config') !== -1) return null;
        return null;
    };
}

/** The params for a BUG-150 triage run. */
function triageActionParams() {
    return {
        ticket: { key: 'BUG-150', fields: { summary: 'Guard red bug', issuetype: { name: 'Bug' } } },
        jobParams: {
            machineAuthor: 'ai-teammate',
            customParams: { removeLabel: 'sm_story_test_automation_triggered' }
        }
    };
}

/**
 * The triage-run harness: one BUG-150 bug run with configurable result
 * entries, linked TC metadata, bug comments (marker storage) and CLI.
 */
function triageModule(opts) {
    var statusMoves = [];
    var posted = [];
    var labels = [];
    var module = loadPostStoryTestAutomationResults({
        file_read: triageFileReader(
            opts.resultEntries || [opts.resultEntry || guardFailedResult()],
            opts.linkedTestCases || [],
            opts.overall),
        cli_execute_command: opts.cli || function(o) {
            if (o.command === 'git branch --show-current') return 'test/BUG-150';
            if (o.command === 'git rev-parse HEAD') return 'sha-new';
            return '';
        },
        jira_get_ticket: bugComments(opts.comments || []),
        jira_move_to_status: function(args) { statusMoves.push(args); },
        jira_post_comment: function(args) { posted.push(args.comment); },
        jira_add_label: function(args) { labels.push(args); },
        jira_attach_file_to_ticket: function() {},
        jira_update_field: function() {}
    });
    return {
        module: module,
        statusMoves: statusMoves,
        posted: posted,
        labels: labels,
        run: function() {
            return module.action(triageActionParams());
        },
        runWithoutMachineAuthor: function() {
            var p = triageActionParams();
            delete p.jobParams.machineAuthor;
            return module.action(p);
        }
    };
}

suite('postStoryTestAutomationResults: gh-1329 guard triage', function() {


    test('AC: guard red, same SHA + same env fingerprint -> no rerun, no bounce; ledger entry', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            cli: function(o) {
                if (o.command === 'git branch --show-current') return 'test/BUG-150';
                if (o.command === 'git rev-parse HEAD') return 'sha-green'; // SAME build as last green
                return '';
            },
            resultEntry: Object.assign(guardFailedResult(), { envFingerprint: 'env-1' })
        });
        var result = t.run();
        assert.equal(result.success, true);
        assert.equal(result.status, 'test_maintenance');
        assert.deepEqual(result.maintenanceTestCases, ['TS-152']);
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150'; }),
            'bug state unchanged');
        assert.deepEqual(t.statusMoves, [{ key: 'TS-152', statusName: 'In Review - Failed' }],
            'stage status only — no final Failed for a maintenance route');
        assert.ok(t.posted.some(function(c) { return c.indexOf('dmtools:tc-maintenance-ledger') !== -1; }));
    });

    test('AC: guard red, new SHA, differential green on the last-green build -> bounce with evidence', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            resultEntry: Object.assign(guardFailedResult(), { differential: 'green' })
        });
        var result = t.run();
        assert.equal(result.status, 'failed');
        assert.deepEqual(result.failedTestCases, ['TS-152']);
        assert.ok(t.statusMoves.some(function(m) { return m.key === 'BUG-150' && m.statusName === 'Ready For Development'; }));
        assert.ok(t.statusMoves.some(function(m) { return m.key === 'TS-152' && m.statusName === 'Failed'; }),
            'earned bounce finalizes the TC as Failed');
        assert.ok(t.posted.some(function(c) {
            return c.indexOf('Bug Fix Did Not Pass Automated Tests') !== -1 && c.indexOf('sha-green') !== -1;
        }), 'the bounce comment carries the differential evidence');
    });

    test('AC: repeated attributed failures hit maxReworkRounds -> escalation, no bounce', function() {
        var exhaustedRegistry = REGISTRY_MARKER_TS152.replace('"redRounds":0', '"redRounds":2');
        var t = triageModule({
            comments: [{ body: exhaustedRegistry, user: { login: 'ai-teammate' } }],
            resultEntry: Object.assign(guardFailedResult(), { differential: 'green' })
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance');
        assert.deepEqual(result.escalatedTestCases, ['TS-152']);
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150' && m.statusName === 'Ready For Development'; }),
            'the bounce loop stopped at the cap — no infinite re-fix laps');
        assert.ok(t.posted.some(function(c) { return c.indexOf('escalat') !== -1 && c.indexOf('TS-152') !== -1; }));
    });

    test('sibling TC (verifies a different bug) red never bounces this bug', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152.replace('regression-guard', 'own-oracle'), user: { login: 'ai-teammate' } }],
            resultEntry: Object.assign(guardFailedResult(), { role: '', verifies: 'BUG-999', differential: 'green' })
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance');
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150' && m.statusName === 'Ready For Development'; }),
            'sibling failures route to test maintenance and never bounce the bug');
    });

    test('markers from untrusted authors are not trusted (fail closed, legacy bounce applies)', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'not-the-machine' } }],
            resultEntry: Object.assign(guardFailedResult(), { acVerdict: 'violated' })
        });
        var result = t.run();
        assert.equal(result.status, 'failed',
            'with no trusted registry the TC is unvalidated own-oracle; AC verdict drives the bounce');
    });

    test('failing scripts are persisted on bug failure routes (commit + push, no PR)', function() {
        var commands = [];
        var t = triageModule({
            comments: [],
            cli: function(o) {
                commands.push(o.command);
                if (o.command === 'git branch --show-current') return 'test/BUG-150';
                if (o.command === 'git rev-parse HEAD') return 'sha-new';
                if (o.command === 'git status --short -- testing') return '?? testing/tests/TS-152/test_guard.py';
                if (o.command === 'git diff --cached --stat') return ' testing/tests/TS-152/test_guard.py | 1 +';
                return '';
            }
        });
        var result = t.run();
        assert.equal(result.success, true);
        assert.ok(commands.some(function(c) { return c.indexOf('git commit -m') === 0; }),
            'the failing script was committed');
        assert.ok(commands.some(function(c) { return c.indexOf('git push') === 0; }),
            'the failing script was pushed');
    });
});

// ── gh-1329 rework: review-thread fixes ──────────────────────────────────────

suite('postStoryTestAutomationResults: gh-1329 rework — bounce/route surfacing', function() {

    var TWO_TC_REGISTRY = '<!-- dmtools:tc-run-registry {"v":1,"at":"2026-01-01T00:00:00.000Z","tcs":{' +
        '"TS-152":{"role":"regression-guard","validated":true,"lastGreenSha":"sha-green","lastGreenEnvFingerprint":"env-1","lastGreenAt":"2026-01-01T00:00:00.000Z","greens":1,"redRounds":0,"lastRedAt":null,"lastVerdict":null},' +
        '"TS-153":{"role":"regression-guard","validated":true,"lastGreenSha":"sha-green","lastGreenEnvFingerprint":"env-1","lastGreenAt":"2026-01-01T00:00:00.000Z","greens":1,"redRounds":0,"lastRedAt":null,"lastVerdict":null},' +
        '"TS-154":{"role":"regression-guard","validated":true,"lastGreenSha":"sha-green","lastGreenEnvFingerprint":"env-1","lastGreenAt":"2026-01-01T00:00:00.000Z","greens":1,"redRounds":2,"lastRedAt":null,"lastVerdict":null}' +
        '}} -->\n\ud83d\udcd8 registry fixture';

    function countOccurrences(text, needle) {
        var n = 0;
        var i = 0;
        while ((i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
        return n;
    }

    test('AC: the bounce comment lists each TC exactly once (no duplicated list)', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            resultEntry: Object.assign(guardFailedResult(), { differential: 'green' })
        });
        var result = t.run();
        assert.equal(result.status, 'failed');
        var bounceComments = t.posted.filter(function(c) {
            return c.indexOf('Bug Fix Did Not Pass Automated Tests') !== -1;
        });
        assert.equal(bounceComments.length, 1, 'exactly one bounce comment');
        assert.equal(countOccurrences(bounceComments[0], 'TS-152'), 1,
            'the TC key appears exactly once in the bounce comment');
        assert.contains(bounceComments[0], 'Attribution');
    });

    function mixedRunCli(commands) {
        return function(o) {
            commands.push(o.command);
            if (o.command === 'git branch --show-current') return 'test/BUG-150';
            if (o.command === 'git rev-parse HEAD') return 'sha-new';
            if (o.command === 'git status --short -- testing') return '?? testing/tests/x.py';
            if (o.command === 'git diff --cached --stat') return ' testing/tests/x.py | 1 +';
            return '';
        };
    }

    test('AC: a mixed bounce+route run still stages the routed TC and posts the triage digest', function() {
        var commands = [];
        var t = triageModule({
            comments: [{ body: TWO_TC_REGISTRY, user: { login: 'ai-teammate' } }],
            cli: mixedRunCli(commands),
            resultEntries: [
                Object.assign(guardFailedResult(), { testCaseKey: 'TS-152', differential: 'green' }),
                Object.assign(guardFailedResult(), { testCaseKey: 'TS-153', errorClass: 'timeout' })
            ]
        });
        // TS-152: differential green on a new build -> earned bounce.
        // TS-153: failed on sha-new while last green was sha-green — build
        // changed, no differential given -> routed (differential rerun).
        var result = t.run();
        assert.equal(result.status, 'failed', 'the earned bounce still returns the bug');
        assert.ok(t.statusMoves.some(function(m) { return m.key === 'TS-153' && m.statusName === 'In Review - Failed'; }),
            'the routed TC is staged even on a bounce run');
        var digest = t.posted.filter(function(c) { return c.indexOf('Linked-TC failure triage') !== -1; });
        assert.equal(digest.length, 1, 'the triage digest is posted on the bounce path too');
        assert.contains(digest[0], 'TS-153');
        var bounceComments = t.posted.filter(function(c) {
            return c.indexOf('Bug Fix Did Not Pass Automated Tests') !== -1;
        });
        assert.ok(bounceComments.every(function(c) { return c.indexOf('TS-153') === -1; }),
            'the bounce comment names only the bounced TCs');
    });

    test('AC: escalated TCs are staged and surfaced on both routes', function() {
        var commands = [];
        var t = triageModule({
            comments: [{ body: TWO_TC_REGISTRY, user: { login: 'ai-teammate' } }],
            cli: mixedRunCli(commands),
            resultEntries: [
                Object.assign(guardFailedResult(), { testCaseKey: 'TS-152', differential: 'green' }),
                Object.assign(guardFailedResult(), { testCaseKey: 'TS-154', differential: 'green' })
            ]
        });
        // TS-152: differential green -> earned bounce. TS-154: differential
        // green with an exhausted red streak (redRounds 2/2) -> escalate.
        var result = t.run();
        assert.equal(result.status, 'failed');
        assert.deepEqual(result.escalatedTestCases, ['TS-154']);
        assert.ok(t.statusMoves.some(function(m) { return m.key === 'TS-154' && m.statusName === 'In Review - Failed'; }),
            'the escalated TC is staged with its failure evidence');
        var digest = t.posted.filter(function(c) { return c.indexOf('Bounce cap reached') !== -1; });
        assert.equal(digest.length, 1, 'the escalation section is posted on the bounce path too');
        assert.contains(digest[0], 'TS-154');
    });
});

suite('postStoryTestAutomationResults: gh-1329 rework — schema-gap diagnosability', function() {

    function captureWarnings(run) {
        var warnings = [];
        var orig = console.warn;
        console.warn = function() {
            warnings.push(Array.prototype.slice.call(arguments).map(String).join(' '));
        };
        try { run(); } finally { console.warn = orig; }
        return warnings;
    }

    test('AC: a failed own-oracle entry carrying NONE of the triage fields leaves a schema-gap hint', function() {
        var t = triageModule({
            comments: [],
            resultEntry: {
                testCaseKey: 'TS-152',
                status: 'failed',
                testPath: 'testing/tests/TS-152/test_guard.py',
                failedDescriptionFile: 'outputs/failed_description_TS-152.md',
                failureSummary: 'agent ignored the schema'
            }
        });
        var warnings = captureWarnings(function() { t.result = t.run(); });
        assert.equal(t.result.status, 'test_maintenance');
        var hint = t.posted.filter(function(c) { return c.indexOf('gh-1329 triage metadata') !== -1; });
        assert.equal(hint.length, 1, 'the schema-gap hint is posted');
        assert.contains(hint[0], 'TS-152');
        assert.ok(warnings.some(function(w) { return w.indexOf('TS-152') !== -1; }),
            'the schema gap also leaves a log trace');
    });

    test('an entry carrying triage fields (errorClass) produces no schema-gap hint', function() {
        var t = triageModule({
            comments: [],
            resultEntry: guardFailedResult() // errorClass present
        });
        t.run();
        assert.ok(t.posted.every(function(c) { return c.indexOf('gh-1329 triage metadata') === -1; }),
            'no hint when the agent followed the schema');
    });
});

suite('postStoryTestAutomationResults: gh-1329 rework — linked-TC metadata is the role truth', function() {

    test('AC: the linked TC ticket metadata wins over the agent-copied role — a linked sibling never bounces', function() {
        var warnings = [];
        var orig = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).map(String).join(' ')); };
        var t;
        try {
            t = triageModule({
                comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
                linkedTestCases: [{ key: 'TS-152', fields: { verifies: 'BUG-999' } }],
                resultEntry: Object.assign(guardFailedResult(), { differential: 'green' })
            });
            t.result = t.run();
        } finally {
            console.warn = orig;
        }
        assert.equal(t.result.status, 'test_maintenance',
            'the linked TC names another bug in Verifies: — sibling — the bounce gate must not trust the agent copy');
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150'; }),
            'bug state unchanged');
        assert.ok(warnings.some(function(w) { return w.indexOf('BUG-999') !== -1; }),
            'the disagreement leaves a warning trace');
    });

    test('linked own-oracle metadata (no fields wrapper) keeps the bounce gate', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            linkedTestCases: [{ key: 'TS-152', verifies: 'BUG-150', role: 'regression guard' }],
            resultEntry: Object.assign(guardFailedResult(), { role: '', differential: 'green' })
        });
        var result = t.run();
        assert.equal(result.status, 'failed',
            'the linked TC verifies THIS bug — the earned bounce stands');
    });

    test('without linked TC metadata the agent-copied role still applies', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            resultEntry: Object.assign(guardFailedResult(), { differential: 'green' })
        });
        assert.equal(t.run().status, 'failed');
    });

    test('linked TC fields can carry the role alone (fields.role wins over the agent copy)', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            linkedTestCases: [{ key: 'TS-152', fields: { role: 'regression guard' } }],
            resultEntry: Object.assign(guardFailedResult(), { role: '', differential: 'green' })
        });
        assert.equal(t.run().status, 'failed',
            'the linked TC names itself a guard of this bug — the earned bounce stands');
    });

    test('a linked entry with no role metadata at all falls through to the agent copy', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            linkedTestCases: [{ key: 'TS-152', fields: { summary: 'no role stamps here' } }],
            resultEntry: Object.assign(guardFailedResult(), { differential: 'green' })
        });
        assert.equal(t.run().status, 'failed');
    });
});

suite('postStoryTestAutomationResults: gh-1329 rework — build SHA resolved once per run', function() {

    test('AC: a multi-TC bug run shells out to git rev-parse at most once', function() {
        var commands = [];
        var t = triageModule({
            comments: [],
            cli: function(o) {
                commands.push(o.command);
                if (o.command === 'git branch --show-current') return 'test/BUG-150';
                if (o.command === 'git rev-parse HEAD') return 'sha-new';
                if (o.command === 'git status --short -- testing') return '?? testing/tests/x.py';
                if (o.command === 'git diff --cached --stat') return ' testing/tests/x.py | 1 +';
                return '';
            },
            resultEntries: [
                {
                    testCaseKey: 'TS-151', status: 'failed', testPath: 'testing/tests/TS-151/t.py',
                    failedDescriptionFile: 'outputs/failed_description_TS-151.md', failureSummary: 'one'
                },
                {
                    testCaseKey: 'TS-152', status: 'failed', testPath: 'testing/tests/TS-152/t.py',
                    failedDescriptionFile: 'outputs/failed_description_TS-152.md', failureSummary: 'two'
                }
            ]
        });
        var result = t.run();
        assert.equal(result.success, true);
        var revParseCount = commands.filter(function(c) { return c === 'git rev-parse HEAD'; }).length;
        assert.equal(revParseCount, 1, 'git rev-parse HEAD runs once per triage run, not once per entry');
    });
});

// ── gh-1345: the dispatcher hand-off (park label + deployment guard) ─────────

suite('postStoryTestAutomationResults: gh-1345 differential dispatcher hand-off', function() {

    test('AC: a parked differential request labels the bug for the scripted dispatcher', function() {
        // validated guard, build changed, no differential outcome recorded —
        // the triage parks a rerun request (fail-safe: no unattributed bounce)
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            resultEntry: Object.assign(guardFailedResult(), { differential: null })
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance');
        assert.deepEqual(result.maintenanceTestCases, ['TS-152']);
        assert.deepEqual(t.labels, [{ key: 'BUG-150', label: 'tc_differential_pending' }],
            'the SM dispatcher rule matches this label next tick');
    });

    test('a fully-routed run (no differential requests) never parks the label', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            cli: function(o) {
                if (o.command === 'git branch --show-current') return 'test/BUG-150';
                if (o.command === 'git rev-parse HEAD') return 'sha-green'; // same build
                return '';
            },
            resultEntry: Object.assign(guardFailedResult(), { envFingerprint: 'env-1' })
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance');
        assert.deepEqual(t.labels, [], 'a flaky-same-build route is sweep work — no dispatcher label');
    });

    test('an earned bounce run never parks the label', function() {
        var t = triageModule({
            comments: [{ body: REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            resultEntry: Object.assign(guardFailedResult(), { differential: 'green' })
        });
        var result = t.run();
        assert.equal(result.status, 'failed');
        assert.deepEqual(t.labels, [], 'the bounce consumed the attribution — nothing parked');
    });
});

suite('postStoryTestAutomationResults: gh-1354 own-oracle triage — the automation-leg contract', function() {

    // The F1 route's user-visible contract lives HERE (routeVerdict →
    // routePathResult): a validated own-oracle red must end in test
    // maintenance / a parked dispatcher request with the OWN role intact.
    // Every earlier triage case in this file uses guard roles — these two
    // cases pin that a role-normalization regression (e.g. resolveTcRole
    // demoting OWN) cannot silently re-enter the AC-gated path through the
    // automation leg.

    var OWN_REGISTRY_MARKER_TS152 = REGISTRY_MARKER_TS152.replace('regression-guard', 'own-oracle');
    var ownTcLedger = loadModule('js/common/tcMaintenanceLedger.js', makeRequire({
        './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({})),
        './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({
            './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}))
        }))
    }));

    /** The newest posted ledger digest, parsed (machine-author allowlist). */
    function postedLedgerOf(t) {
        var markers = t.posted.filter(function(c) {
            return c.indexOf('<!-- dmtools:tc-maintenance-ledger ') !== -1;
        });
        if (!markers.length) return null;
        return ownTcLedger.latestLedger([{ body: markers[markers.length - 1], user: { login: 'ai-teammate' } }],
            { authorLogins: ['ai-teammate'] }).ledger;
    }

    test('AC (F1): validated own-oracle red, same build + changed envFingerprint -> test_maintenance, no bug move', function() {
        var t = triageModule({
            comments: [{ body: OWN_REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            cli: function(o) {
                if (o.command === 'git branch --show-current') return 'test/BUG-150';
                if (o.command === 'git rev-parse HEAD') return 'sha-green'; // SAME build as last green
                return '';
            },
            resultEntry: Object.assign(guardFailedResult(), { role: 'own-oracle', envFingerprint: 'env-2' })
        });
        var result = t.run();

        assert.equal(result.success, true);
        assert.equal(result.status, 'test_maintenance',
            'an environment shift is maintenance even on the bug\'s own oracle — no rework, no bounce');
        assert.deepEqual(result.maintenanceTestCases, ['TS-152']);
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150'; }),
            'no bug move — the world moved, not the product');
        var ledger = postedLedgerOf(t);
        assert.ok(ledger, 'the ledger digest was posted');
        assert.equal(ledger.findings[0].reason, 'environment-shift', 'the F1 finding names its route');
        assert.equal(ledger.findings[0].role, 'own-oracle');
    });

    test('AC (F1/F2 loop): validated own-oracle, build changed, no differential outcome -> park label + request carries role own-oracle', function() {
        var t = triageModule({
            comments: [{ body: OWN_REGISTRY_MARKER_TS152, user: { login: 'ai-teammate' } }],
            resultEntry: Object.assign(guardFailedResult(), { role: 'own-oracle', differential: null })
        });
        var result = t.run();

        assert.equal(result.status, 'test_maintenance');
        assert.deepEqual(t.labels, [{ key: 'BUG-150', label: 'tc_differential_pending' }],
            'the scripted dispatcher picks the request up next tick');
        var ledger = postedLedgerOf(t);
        assert.ok(ledger, 'the ledger digest was posted');
        var parked = ledger.findings[0];
        assert.equal(parked.verdict, 'differential-rerun');
        assert.equal(parked.role, 'own-oracle',
            'the role the dispatcher\'s dispatcherRoleOf round-trips — a green outcome must hand to the AC re-check, never an un-gated bounce');
    });
});

suite('postStoryTestAutomationResults: gh-1345 machineAuthor deployment guard', function() {

    function captureWarnings(run) {
        var warnings = [];
        var orig = console.warn;
        console.warn = function() {
            warnings.push(Array.prototype.slice.call(arguments).map(String).join(' '));
        };
        try { run(); } finally { console.warn = orig; }
        return warnings;
    }

    test('AC4: triage active + empty allowlist warns ONCE with the deployment fix', function() {
        var t = triageModule({ comments: [] });
        var warnings = captureWarnings(function() { t.result = t.runWithoutMachineAuthor(); });
        assert.equal(t.result.success, true);
        var guardWarnings = warnings.filter(function(w) { return w.indexOf('machineAuthor') !== -1; });
        assert.equal(guardWarnings.length, 1, 'exactly one startup warning per run');
        assert.contains(guardWarnings[0], 'params.jobParams.machineAuthor');
        assert.contains(guardWarnings[0], 'config.machineAuthor');
    });

    test('AC4: a configured deployment sees nothing', function() {
        var t = triageModule({ comments: [] });
        var warnings = captureWarnings(function() { t.result = t.run(); });
        assert.equal(t.result.success, true);
        assert.deepEqual(warnings.filter(function(w) { return w.indexOf('machineAuthor') !== -1; }), []);
    });
});

// ── gh-1331: cross-lap alternation detection + bounce suppression ─────────────

var gh1331MachineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}));
var gh1331ReviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({
    './machineAuthor.js': gh1331MachineAuthor
}));
var gh1331Registry = loadModule('js/common/tcRunRegistry.js', makeRequire({
    './reviewVerdicts.js': gh1331ReviewVerdicts
}));
var gh1331Ledger = loadModule('js/common/tcMaintenanceLedger.js', makeRequire({ './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({})),
    './reviewVerdicts.js': gh1331ReviewVerdicts
}));
var gh1331Alternation = loadModule('js/common/tcAlternation.js', makeRequire({
    './tcRunRegistry.js': gh1331Registry,
    './tcMaintenanceLedger.js': gh1331Ledger
}));

function gh1331At(n) {
    return '2026-01-0' + n + 'T00:00:00.000Z';
}

/** A validated-guard registry base: both guards green on sha-green, env-1. */
function gh1331GreenBoth(r, at) {
    r = gh1331Registry.recordGreen(r, 'TS-152', { sha: 'sha-green', envFingerprint: 'env-1', role: 'regression-guard', at: at });
    r = gh1331Registry.recordGreen(r, 'TS-153', { sha: 'sha-green', envFingerprint: 'env-1', role: 'regression-guard', at: at });
    return r;
}

/**
 * One simulated lap for the two-guard fixture: the red TC earned its bounce,
 * the other guard went green on the same build.
 */
function gh1331Lap(r, n, redKey, greenKey, buildSha) {
    r = gh1331Registry.recordGreen(r, greenKey, { sha: buildSha, envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(n) });
    r = gh1331Registry.recordFailure(r, redKey, { sha: buildSha, at: gh1331At(n), verdict: 'bounce', role: 'regression-guard' });
    r = gh1331Registry.recordBounce(r, redKey, { at: gh1331At(n), lastGreenSha: 'sha-green', kind: 'earned' });
    return r;
}

/** The lap-1 ledger fixture: the open bounce finding the real lap would have posted. */
function gh1331BounceFindingLedgerMarker(tcKey) {
    var l = gh1331Ledger.emptyLedger();
    l = gh1331Ledger.appendFinding(l, gh1331Ledger.findingFromVerdict({
        tcKey: tcKey,
        role: 'regression-guard',
        action: 'bounce',
        reason: 'regression-from-change-range',
        evidence: {
            sha: 'sha-old', envFingerprint: 'env-1', lastGreenSha: 'sha-green', lastGreenEnvFingerprint: 'env-1',
            errorClass: 'assertion', testPath: 'testing/tests/' + tcKey + '/test_guard.py'
        },
        ledgerEntry: {
            tcKey: tcKey, role: 'regression-guard', verdict: 'bounce', reason: 'regression-from-change-range',
            evidence: { sha: 'sha-old', lastGreenSha: 'sha-green', errorClass: 'assertion', testPath: 'testing/tests/' + tcKey + '/test_guard.py' }
        }
    }, { at: gh1331At(2) }));
    return gh1331Ledger.buildLedgerMarker(l);
}

function gh1331Comment(marker) {
    return { body: marker, user: { login: 'ai-teammate' } };
}

function gh1331GuardPair() {
    return [
        { key: 'TS-152', fields: { role: 'regression guard', verifies: 'BUG-150' } },
        { key: 'TS-153', fields: { role: 'regression guard', verifies: 'BUG-150' } }
    ];
}

function gh1331FailedEntry(tcKey) {
    return {
        testCaseKey: tcKey,
        status: 'failed',
        testPath: 'testing/tests/' + tcKey + '/test_guard.py',
        failedDescriptionFile: 'outputs/failed_description_' + tcKey + '.md',
        failureSummary: 'guard ' + tcKey + ' assertion',
        errorClass: 'assertion',
        envFingerprint: 'env-1',
        differential: 'green',
        role: 'regression guard'
    };
}

function gh1331PassedEntry(tcKey) {
    return {
        testCaseKey: tcKey,
        status: 'passed',
        testPath: 'testing/tests/' + tcKey + '/test_guard.py',
        envFingerprint: 'env-1',
        role: 'regression guard'
    };
}

/** The default cli answers of the two-guard triage harness (a table, not a branch chain). */
function gh1331CliTable(opts) {
    return {
        'git branch --show-current': 'test/BUG-150',
        'git rev-parse HEAD': opts.buildSha || 'sha-new',
        'git status --short -- testing': '?? testing/tests/x.py',
        'git diff --cached --stat': ' testing/tests/x.py | 1 +'
    };
}

/** The two-guard triage harness: configurable comments, build SHA, entries. */
function gh1331Triage(opts) {
    var cliTable = gh1331CliTable(opts);
    return triageModule({
        comments: opts.comments || [],
        linkedTestCases: opts.linkedTestCases || gh1331GuardPair(),
        overall: opts.overall,
        resultEntries: opts.resultEntries,
        cli: opts.cli || function(o) {
            var answer = cliTable[o.command];
            return answer === undefined ? '' : answer;
        }
    });
}

/** The latest posted registry marker, parsed back. */
function gh1331PostedRegistry(t) {
    var bodies = t.posted.filter(function(c) { return c.indexOf('<!-- dmtools:tc-run-registry ') !== -1; });
    if (!bodies.length) return null;
    var parsed = gh1331Registry.latestRegistry(
        [{ body: bodies[bodies.length - 1], user: { login: 'ai-teammate' } }],
        { authorLogins: ['ai-teammate'] });
    return parsed ? parsed.registry : null;
}

function gh1331PostedLedger(t) {
    var bodies = t.posted.filter(function(c) { return c.indexOf('<!-- dmtools:tc-maintenance-ledger ') !== -1; });
    if (!bodies.length) return null;
    var parsed = gh1331Ledger.latestLedger(
        [{ body: bodies[bodies.length - 1], user: { login: 'ai-teammate' } }],
        { authorLogins: ['ai-teammate'] });
    return parsed ? parsed.ledger : null;
}

function gh1331EscalationsOf(t) {
    return t.posted.filter(function(c) {
        return c.indexOf('gh-1331') !== -1 && c.indexOf('contradictory-or-flaky') !== -1;
    });
}

suite('postStoryTestAutomationResults: gh-1331 lap 1 — the first trade earns its bounce', function() {

    test('AC: the first earned bounce fires and stamps the cross-lap history beside lastGreenSha', function() {
        var fresh = gh1331Registry.emptyRegistry();
        fresh = gh1331GreenBoth(fresh, gh1331At(1));
        var t = gh1331Triage({
            comments: [gh1331Comment(gh1331Registry.buildRegistryMarker(fresh))],
            buildSha: 'sha-new',
            resultEntries: [gh1331PassedEntry('TS-153'), gh1331FailedEntry('TS-152')]
        });
        var result = t.run();
        assert.equal(result.status, 'failed', 'the FIRST earned bounce fires');
        assert.deepEqual(result.failedTestCases, ['TS-152']);
        assert.ok(t.statusMoves.some(function(m) { return m.key === 'BUG-150' && m.statusName === 'Ready For Development'; }));
        var posted = gh1331PostedRegistry(t);
        assert.ok(posted, 'the registry marker is posted');
        assert.equal(posted.tcs['TS-152'].lastBounceRange, 'sha-green', 'the bounce anchor is stamped');
        assert.ok(posted.tcs['TS-152'].runs.length >= 2, 'the run history is stamped (gh-1331 bookkeeping)');
        assert.equal(posted.tcs['TS-152'].runs[1].s, 'red');
        assert.equal(posted.tcs['TS-152'].runs[1].sha, 'sha-new');
    });
});

suite('postStoryTestAutomationResults: gh-1331 residue 2 — open items dedup, no re-bounce', function() {

    test('AC: a prior earned bounce on the same SHA range refreshes the ledger instead of re-bouncing', function() {
        var lap1 = gh1331Registry.emptyRegistry();
        lap1 = gh1331GreenBoth(lap1, gh1331At(1));
        lap1 = gh1331Lap(lap1, 2, 'TS-152', 'TS-153', 'sha-new');
        var t = gh1331Triage({
            comments: [
                gh1331Comment(gh1331Registry.buildRegistryMarker(lap1)),
                gh1331Comment(gh1331BounceFindingLedgerMarker('TS-152'))
            ],
            buildSha: 'sha-new2',
            resultEntries: [gh1331PassedEntry('TS-153'), gh1331FailedEntry('TS-152')]
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance',
            'residue 2: the prior bounce on the same SHA range dedups the re-bounce');
        assert.deepEqual(result.maintenanceTestCases, ['TS-152']);
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150'; }),
            'the bug is NOT re-bounced for the same unresolved range');
        var ledger = gh1331PostedLedger(t);
        var finding = gh1331Ledger.openFindings(ledger).filter(function(f) { return f.tcKey === 'TS-152'; })[0];
        assert.ok(finding, 'the ledger entry is refreshed');
        assert.equal(finding.occurrences, 2, 'the same finding identity advanced');
        assert.equal(finding.reason, 'suppressed-prior-bounce-same-range');
    });

    test('AC: an open ledger bounce finding on the same SHA range suppresses without any prior bounce record', function() {
        var r = gh1331Registry.emptyRegistry();
        r = gh1331Registry.recordGreen(r, 'TS-152', { sha: 'sha-green', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(1) });
        var t = gh1331Triage({
            comments: [
                gh1331Comment(gh1331Registry.buildRegistryMarker(r)),
                gh1331Comment(gh1331BounceFindingLedgerMarker('TS-152'))
            ],
            buildSha: 'sha-new2',
            resultEntries: [gh1331PassedEntry('TS-153'), gh1331FailedEntry('TS-152')]
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance');
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150'; }), 'bug NOT re-bounced');
        var finding = gh1331Ledger.openFindings(gh1331PostedLedger(t)).filter(function(f) { return f.tcKey === 'TS-152'; })[0];
        assert.equal(finding.occurrences, 2, 'the ledger entry is refreshed, not duplicated');
        assert.equal(finding.reason, 'suppressed-open-ledger-item');
    });

    test('AC: a dev-filed test_suspected claim on the same build suppresses the bounce', function() {
        var r = gh1331Registry.emptyRegistry();
        r = gh1331Registry.recordGreen(r, 'TS-152', { sha: 'sha-green', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(1) });
        var claim = gh1331Ledger.appendFinding(gh1331Ledger.emptyLedger(), gh1331Ledger.findingFromDevClaim({
            tcKey: 'TS-152', claimedVerdict: 'stale-guard', reason: 'guard pins the pre-change behavior',
            testPath: 'testing/tests/TS-152/test_guard.py', sha: 'sha-new2'
        }, { at: gh1331At(2) }));
        var t = gh1331Triage({
            comments: [
                gh1331Comment(gh1331Registry.buildRegistryMarker(r)),
                gh1331Comment(gh1331Ledger.buildLedgerMarker(claim))
            ],
            buildSha: 'sha-new2',
            resultEntries: [gh1331PassedEntry('TS-153'), gh1331FailedEntry('TS-152')]
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance', 'the dev claim anchors the same failing build');
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150'; }), 'bug NOT re-bounced');
    });

    test('a bounce from an OLDER range does not anchor — a fresh regression still bounces', function() {
        var r = gh1331Registry.emptyRegistry();
        r = gh1331Registry.recordBounce(r, 'TS-152', { at: gh1331At(1), lastGreenSha: 'sha-old', kind: 'earned' });
        r = gh1331Registry.recordGreen(r, 'TS-152', { sha: 'sha-green', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(2) });
        var t = gh1331Triage({
            comments: [gh1331Comment(gh1331Registry.buildRegistryMarker(r))],
            buildSha: 'sha-new2',
            resultEntries: [gh1331PassedEntry('TS-153'), gh1331FailedEntry('TS-152')]
        });
        var result = t.run();
        assert.equal(result.status, 'failed', 'the prior bounce was on another range — this regression earns its bounce');
    });
});

suite('postStoryTestAutomationResults: gh-1331 alternation — the flip suppresses and escalates once', function() {

    /** Lap-1 state: TS-152 bounced on sha-new, TS-153 stayed green. */
    function lap1Comments() {
        var lap1 = gh1331Registry.emptyRegistry();
        lap1 = gh1331GreenBoth(lap1, gh1331At(1));
        lap1 = gh1331Lap(lap1, 2, 'TS-152', 'TS-153', 'sha-new');
        return [
            gh1331Comment(gh1331Registry.buildRegistryMarker(lap1)),
            gh1331Comment(gh1331BounceFindingLedgerMarker('TS-152'))
        ];
    }

    test('AC: lap 2 flips the trade — the bounce is suppressed, the pair marked, ONE escalation', function() {
        var t = gh1331Triage({
            comments: lap1Comments(),
            buildSha: 'sha-new2',
            resultEntries: [gh1331PassedEntry('TS-152'), gh1331FailedEntry('TS-153')]
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance', 'the flip suppresses the bounce');
        assert.deepEqual(result.maintenanceTestCases, ['TS-153']);
        assert.ok(!t.statusMoves.some(function(m) { return m.key === 'BUG-150'; }),
            'no unbounded ping-pong: the bug stays put');
        var escalations = gh1331EscalationsOf(t);
        assert.equal(escalations.length, 1, 'exactly ONE async escalation for the pair');
        assert.contains(escalations[0], 'TS-152');
        assert.contains(escalations[0], 'TS-153');
        assert.contains(escalations[0], 'BUG-150', 'the AC references reach the owner');
        var posted = gh1331PostedRegistry(t);
        assert.equal(posted.pairs['TS-152|TS-153'].state, 'contradictory-or-flaky',
            'the pair record persists for the next laps');
        var ledger = gh1331PostedLedger(t);
        assert.ok(gh1331Ledger.openFindings(ledger).some(function(f) {
            return f.tcKey === 'TS-153' && f.reason === 'suppressed-contradictory-pair';
        }), 'the suppressed bounce lands in the ledger');
    });

    test('AC: lap 3 trades back — suppression holds and NO second escalation is posted', function() {
        var lap2 = gh1331Registry.emptyRegistry();
        lap2 = gh1331GreenBoth(lap2, gh1331At(1));
        lap2 = gh1331Lap(lap2, 2, 'TS-152', 'TS-153', 'sha-new');
        lap2 = gh1331Registry.recordGreen(lap2, 'TS-152', { sha: 'sha-new2', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(3) });
        lap2 = gh1331Registry.recordFailure(lap2, 'TS-153', { sha: 'sha-new2', at: gh1331At(3), verdict: 'maintenance', role: 'regression-guard' });
        lap2 = gh1331Registry.recordBounce(lap2, 'TS-153', { at: gh1331At(3), lastGreenSha: 'sha-green', kind: 'supressed' });
        lap2.pairs = { 'TS-152|TS-153': { state: 'contradictory-or-flaky', detectedAt: gh1331At(3), holderNow: 'TS-153', holderPrev: 'TS-152', members: {} } };
        var t = gh1331Triage({
            comments: [gh1331Comment(gh1331Registry.buildRegistryMarker(lap2))],
            buildSha: 'sha-new3',
            resultEntries: [gh1331PassedEntry('TS-153'), gh1331FailedEntry('TS-152')]
        });
        var result = t.run();
        assert.equal(result.status, 'test_maintenance', 'the third lap stays suppressed');
        assert.deepEqual(gh1331EscalationsOf(t), [], 'one escalation per pair — the record stands');
        var posted = gh1331PostedRegistry(t);
        assert.equal(posted.pairs['TS-152|TS-153'].detectedAt, gh1331At(3),
            'the original pair record is kept (no re-mark)');
    });

    test('after a stable green the pair no longer suppresses — a fresh regression earns its bounce', function() {
        var resolved = gh1331Registry.emptyRegistry();
        resolved = gh1331GreenBoth(resolved, gh1331At(1));
        resolved = gh1331Lap(resolved, 2, 'TS-152', 'TS-153', 'sha-new');
        resolved = gh1331Registry.recordGreen(resolved, 'TS-152', { sha: 'sha-new2', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(3) });
        resolved = gh1331Registry.recordGreen(resolved, 'TS-153', { sha: 'sha-new2', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(3) });
        resolved = gh1331Registry.recordGreen(resolved, 'TS-152', { sha: 'sha-new4', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(4) });
        resolved = gh1331Registry.recordGreen(resolved, 'TS-153', { sha: 'sha-new4', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(4) });
        // the pair record was reconciled away by the stable green — the lap carries none
        var t = gh1331Triage({
            comments: [gh1331Comment(gh1331Registry.buildRegistryMarker(resolved))],
            buildSha: 'sha-new5',
            resultEntries: [gh1331PassedEntry('TS-153'), gh1331FailedEntry('TS-152')]
        });
        var result = t.run();
        assert.equal(result.status, 'failed', 'normal triage re-enabled — a fresh regression earns its bounce');
        assert.deepEqual(result.failedTestCases, ['TS-152']);
        assert.ok(t.statusMoves.some(function(m) { return m.key === 'BUG-150' && m.statusName === 'Ready For Development'; }));
        assert.deepEqual(gh1331PostedRegistry(t).pairs, {}, 'no pair record survives the stable green');
    });
});

// ── gh-1331 rework: the all-green resolution lap still books its greens ──────

/** A quiet cli for the green laps: the build sha is the only answer needed
 *  (no branch → publishBranchAndPr falls through without PR work). */
function gh1331GreenCli(opts) {
    return function(o) {
        if (o.command === 'git rev-parse HEAD') return opts.buildSha;
        return '';
    };
}

/**
 * A trading history WITH the pair marked: lap1 green/green on sha-green,
 * lap2 TS-152 red (earned bounce, anchor sha-green) + TS-153 green, then the
 * pair record. The canonical resolution lap that follows is ALL-GREEN.
 */
function gh1331MarkedTradingPair() {
    var r = gh1331Registry.emptyRegistry();
    r = gh1331GreenBoth(r, gh1331At(1));
    r = gh1331Lap(r, 2, 'TS-152', 'TS-153', 'sha-new');
    var marked = gh1331Alternation.recordConflicts(
        r, gh1331Alternation.scanAlternations(r), gh1331At(3), function() { return null; });
    return marked.registry;
}

suite('postStoryTestAutomationResults: gh-1331 rework — the all-green resolution lap books its greens', function() {

    test('AC: an all-green bug lap reconciles a marked pair and posts the registry marker', function() {
        var t = gh1331Triage({
            comments: [gh1331Comment(gh1331Registry.buildRegistryMarker(gh1331MarkedTradingPair()))],
            buildSha: 'sha-fix',
            overall: 'passed',
            cli: gh1331GreenCli({ buildSha: 'sha-fix' }),
            resultEntries: [gh1331PassedEntry('TS-152'), gh1331PassedEntry('TS-153')]
        });
        var result = t.run();
        assert.equal(result.success, true);
        var posted = gh1331PostedRegistry(t);
        assert.ok(posted, 'the all-green lap posts the registry marker — the resolution must be persisted');
        assert.equal(posted.pairs['TS-152|TS-153'], undefined, 'the pair record is reconciled — normal triage re-enables');
        assert.equal(posted.tcs['TS-152'].lastGreenSha, 'sha-fix', 'the resolution greens are recorded');
        assert.ok(posted.tcs['TS-152'].runs.some(function(run) { return run.sha === 'sha-fix' && run.s === 'green'; }),
            'the run window carries the resolution lap');
    });

    test('AC: after the all-green resolution the next red earns its bounce (no stale suppression)', function() {        var resolution = gh1331Triage({
            comments: [gh1331Comment(gh1331Registry.buildRegistryMarker(gh1331MarkedTradingPair()))],
            buildSha: 'sha-fix',
            overall: 'passed',
            cli: gh1331GreenCli({ buildSha: 'sha-fix' }),
            resultEntries: [gh1331PassedEntry('TS-152'), gh1331PassedEntry('TS-153')]
        });
        resolution.run();
        var posted = gh1331PostedRegistry(resolution);
        assert.ok(posted, 'the resolution lap posts the registry marker');
        // the NEXT lap reads the resolution state back from the marker
        var t = gh1331Triage({
            comments: [gh1331Comment(gh1331Registry.buildRegistryMarker(posted))],
            buildSha: 'sha-next',
            resultEntries: [gh1331PassedEntry('TS-153'), gh1331FailedEntry('TS-152')]
        });
        var result = t.run();
        assert.equal(result.status, 'failed', 'a fresh regression after the resolution earns its bounce');
        assert.deepEqual(result.failedTestCases, ['TS-152']);
        assert.ok(t.statusMoves.some(function(m) { return m.key === 'BUG-150' && m.statusName === 'Ready For Development'; }),
            'no stale contradictory-pair suppression — the bug returns to development');
    });
});

suite('postStoryTestAutomationResults: gh-1331 rework — the green lap escalates a fresh flip', function() {

    test('AC: a fresh trade flip surfaces even on a sha-less all-green lap (the bookkeeping escalation)', function() {
        // a trading history WITHOUT a stable green: TS-153 red@S2, then TS-152 red@S3.
        var r = gh1331Registry.emptyRegistry();
        r = gh1331Registry.recordGreen(r, 'TS-152', { sha: 'S2', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(1) });
        r = gh1331Registry.recordFailure(r, 'TS-153', { sha: 'S2', at: gh1331At(1), verdict: 'bounce', role: 'regression-guard' });
        r = gh1331Registry.recordGreen(r, 'TS-153', { sha: 'S3', envFingerprint: 'env-1', role: 'regression-guard', at: gh1331At(2) });
        r = gh1331Registry.recordFailure(r, 'TS-152', { sha: 'S3', at: gh1331At(2), verdict: 'bounce', role: 'regression-guard' });
        // the lap is all-green but carries NO build sha — the greens never
        // classify, so the full-lap scan still sees the trade flip behind them
        var t = gh1331Triage({
            comments: [gh1331Comment(gh1331Registry.buildRegistryMarker(r))],
            buildSha: '',
            overall: 'passed',
            cli: gh1331GreenCli({ buildSha: '' }),
            resultEntries: [gh1331PassedEntry('TS-152'), gh1331PassedEntry('TS-153')]
        });
        var result = t.run();
        assert.equal(result.success, true);
        var escalations = gh1331EscalationsOf(t);
        assert.equal(escalations.length, 1, 'the fresh flip escalates even though the lap was all-green');
        assert.contains(escalations[0], 'TS-152');
        assert.contains(escalations[0], 'TS-153');
        var posted = gh1331PostedRegistry(t);
        assert.ok(posted.pairs['TS-152|TS-153'], 'the pair is marked in the posted registry');
    });
});
