/**
 * Unit tests for agents/js/postMobileTestAutomationResults.js
 *
 * Tests: findFeaturePR (parseMcpResult), updateFeaturePRBody (github_add_pr_comment),
 *        updateFeaturePRLabel (tests_passed/tests_failed), full action flow.
 *
 * Uses: configModule, configLoaderModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function loadPostCli(mocks) {
    var fileReadMock = mocks.file_read || function(opts) {
        var p = opts.path;
        if (p.indexOf('.dmtools/config') !== -1) return null;
        try { return file_read(opts); } catch (e) { return null; }
    };

    var freshConfigLoader = loadModule(
        'agents/js/configLoader.js',
        makeRequire({ './config.js': configModule }),
        { file_read: fileReadMock }
    );

    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_add_label: function() {},
        jira_remove_label: function() {},
        github_list_prs: function() { return JSON.stringify({ data: [] }); },
        github_add_pr_label: function() {},
        github_remove_pr_label: function() {},
        github_add_pr_comment: function() {},
        cli_execute_command: function() { return ''; },
        file_read: fileReadMock,
        file_write: function() {}
    };

    var allMocks = Object.assign({}, defaults, mocks);

    return loadModule(
        'agents/js/postMobileTestAutomationResults.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './config.js': configModule
        }),
        allMocks
    );
}

function makeParams(ticketKey, customParams) {
    return {
        ticket: { key: ticketKey, fields: { summary: 'Test ticket summary', labels: [] } },
        jobParams: {
            customParams: Object.assign({
                featurePR: { owner: 'PostNL-BitDigital', repo: 'PostNL-commercial-mobileApp' },
                labels: { testsPassed: 'tests_passed', testsFailed: 'tests_failed' },
                testFilesGlob: 'src/flows/'
            }, customParams || {})
        }
    };
}

var PASSED_RESULT = JSON.stringify({
    status: 'passed',
    summary: '3 flows written, all passed',
    results: [
        { ticket: 'MAPC-TC-1', title: 'VoiceOver modal', status: 'passed' },
        { ticket: 'MAPC-TC-2', title: 'Close button label', status: 'passed' }
    ]
});

var FAILED_RESULT = JSON.stringify({
    status: 'failed',
    summary: '2 flows, 1 failed',
    results: [
        { ticket: 'MAPC-TC-1', title: 'VoiceOver modal', status: 'passed' },
        { ticket: 'MAPC-TC-2', title: 'Close button', status: 'failed', error: 'Element not found' }
    ]
});

// ── Suite: findFeaturePR with parseMcpResult ──────────────────────────────────

suite('postMobileTestAutomationResults — findFeaturePR', function() {

    test('finds PR when github_list_prs returns JSON string with branch matching ticketKey', function() {
        var labelsCalled = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [
                    { number: 963, title: 'MAPC-6618 some feature', head: { ref: 'story/MAPC-6618' } }
                ]});
            },
            github_add_pr_label: function(opts) { labelsCalled.push(opts); },
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        m.action(makeParams('MAPC-6618'));

        assert.ok(labelsCalled.length > 0, 'should add label to found PR');
        assert.equal(labelsCalled[0].pullRequestId, '963', 'should use correct PR number (as string)');
    });

    test('finds PR when github_list_prs returns plain array (not wrapped)', function() {
        var labelsCalled = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return [{ number: 42, title: 'Story MAPC-6618', head: { ref: 'story/MAPC-6618' } }];
            },
            github_add_pr_label: function(opts) { labelsCalled.push(opts); },
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        m.action(makeParams('MAPC-6618'));

        assert.ok(labelsCalled.length > 0, 'should add label even when PRs returned as array');
        assert.equal(labelsCalled[0].pullRequestId, '42');
    });

    test('does not throw when no matching PR found', function() {
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() { return JSON.stringify({ data: [] }); },
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        // Should complete without throwing
        var result = m.action(makeParams('MAPC-6618'));
        assert.equal(result.success, true, 'action should succeed even without a feature PR');
    });

});

// ── Suite: feature PR label ───────────────────────────────────────────────────

suite('postMobileTestAutomationResults — feature PR label', function() {

    test('adds tests_passed label and removes tests_failed when all pass', function() {
        var added = [], removed = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'MAPC-6618', head: { ref: 'story/MAPC-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function(opts) { removed.push(opts.label); },
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        m.action(makeParams('MAPC-6618'));

        assert.ok(added.indexOf('tests_passed') !== -1, 'should add tests_passed label');
        assert.ok(removed.indexOf('tests_failed') !== -1, 'should remove tests_failed label');
    });

    test('adds tests_failed label and removes tests_passed when tests fail', function() {
        var added = [], removed = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return FAILED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'MAPC-6618', head: { ref: 'story/MAPC-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function(opts) { removed.push(opts.label); },
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        m.action(makeParams('MAPC-6618'));

        assert.ok(added.indexOf('tests_failed') !== -1, 'should add tests_failed label');
        assert.ok(removed.indexOf('tests_passed') !== -1, 'should remove tests_passed label');
    });

    test('uses custom label names from customParams.labels', function() {
        var added = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 10, title: 'MAPC-6618', head: { ref: 'story/MAPC-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function() {},
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        m.action(makeParams('MAPC-6618', { labels: { testsPassed: 'qa_approved', testsFailed: 'qa_rejected' } }));

        assert.ok(added.indexOf('qa_approved') !== -1, 'should use custom passed label');
    });

});

// ── Suite: feature PR comment ─────────────────────────────────────────────────

suite('postMobileTestAutomationResults — feature PR comment', function() {

    test('posts pr_feature_update.md as github_add_pr_comment (not gh pr edit)', function() {
        var prComments = [];
        var cliCommands = [];

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path === 'outputs/pr_feature_update.md') return '## Test Results\n\nAll passed ✅';
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'MAPC-6618', head: { ref: 'story/MAPC-6618' } }]});
            },
            github_add_pr_label: function() {},
            github_remove_pr_label: function() {},
            github_add_pr_comment: function(opts) { prComments.push(opts); },
            cli_execute_command: function(opts) {
                cliCommands.push(opts.command || '');
                return 'test/MAPC-6618';
            }
        });

        m.action(makeParams('MAPC-6618'));

        assert.ok(prComments.length > 0, 'should call github_add_pr_comment');
        assert.equal(prComments[0].pullRequestId, '963', 'should target correct PR');
        assert.ok(prComments[0].text.indexOf('All passed') !== -1, 'should contain pr_feature_update content');

        var ghPrEdit = cliCommands.find(function(c) { return c.indexOf('gh pr edit') !== -1; });
        assert.ok(!ghPrEdit, 'should NOT use gh pr edit (would overwrite PR body)');
    });

    test('falls back to pr_body.md when pr_feature_update.md missing', function() {
        var prComments = [];

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                if (opts.path.indexOf('pr_feature_update.md') !== -1) return null;
                if (opts.path.indexOf('pr_body.md') !== -1) return '## Test Results (from pr_body)\n\nAll passed ✅';
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'MAPC-6618', head: { ref: 'story/MAPC-6618' } }]});
            },
            github_add_pr_label: function() {},
            github_remove_pr_label: function() {},
            github_add_pr_comment: function(opts) { prComments.push(opts); },
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        m.action(makeParams('MAPC-6618'));

        assert.equal(prComments.length, 1, 'should post PR comment using pr_body.md fallback');
        assert.ok(prComments[0].text.indexOf('pr_body') !== -1, 'should contain pr_body content');
    });

});

// ── Suite: Jira comment + status move ────────────────────────────────────────

suite('postMobileTestAutomationResults — Jira updates', function() {

    test('posts Jira comment and moves to Passed when all tests pass', function() {
        var jiraComments = [], statusMoves = [];

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(opts) { jiraComments.push(opts); },
            jira_move_to_status: function(opts) { statusMoves.push(opts); },
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        m.action(makeParams('MAPC-6618'));

        assert.ok(jiraComments.some(function(c) { return c.key === 'MAPC-6618'; }), 'should post Jira comment');
        assert.ok(statusMoves.some(function(s) { return s.statusName === 'Passed'; }), 'should move to Passed');
    });

    test('moves to Failed when tests fail', function() {
        var statusMoves = [];

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return FAILED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function() {},
            jira_move_to_status: function(opts) { statusMoves.push(opts); },
            cli_execute_command: function() { return 'test/MAPC-6618'; }
        });

        m.action(makeParams('MAPC-6618'));

        assert.ok(statusMoves.some(function(s) { return s.statusName === 'Failed'; }), 'should move to Failed');
    });

});

// ── Suite: git commit always happens ─────────────────────────────────────────

suite('postMobileTestAutomationResults — git commit resilience', function() {

    test('commits and pushes even when test_automation_result.json is missing', function() {
        var gitCommands = [];
        var jiraComments = [];
        var WORKING_DIR = 'dependencies/PostNL-commercial-mobileApp-automation';

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null; // no result JSON anywhere
            },
            cli_execute_command: function(opts) {
                gitCommands.push(opts.command || '');
                if ((opts.command || '').indexOf('branch --show-current') !== -1) return 'test/MAPC-6618';
                return '';
            },
            jira_post_comment: function(opts) { jiraComments.push(opts); }
        });

        m.action(makeParams('MAPC-6618', { targetRepository: { workingDir: WORKING_DIR } }));

        var hasAddOrCommit = gitCommands.some(function(c) {
            return c.indexOf('git add') !== -1 || c.indexOf('git commit') !== -1;
        });
        assert.ok(hasAddOrCommit, 'should attempt git add/commit even with no result JSON');
        assert.ok(jiraComments.length > 0, 'should still post error Jira comment');
        assert.ok(jiraComments[0].comment.indexOf('⚠️') !== -1, 'error comment should warn about missing output');
    });

    test('reads result JSON from automation repo outputs dir as fallback', function() {
        var statusMoves = [];
        var WORKING_DIR = 'dependencies/PostNL-commercial-mobileApp-automation';

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return null; // workspace root — missing
                if (opts.path === WORKING_DIR + '/outputs/test_automation_result.json') return PASSED_RESULT; // fallback
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if ((opts.command || '').indexOf('branch --show-current') !== -1) return 'test/MAPC-6618';
                return '';
            },
            jira_move_to_status: function(opts) { statusMoves.push(opts); },
            jira_post_comment: function() {}
        });

        m.action(makeParams('MAPC-6618', { targetRepository: { workingDir: WORKING_DIR } }));

        assert.ok(statusMoves.some(function(s) { return s.statusName === 'Passed'; }),
            'should read result from automation repo fallback path and move to Passed');
    });

    test('a11y warnings override status=failed to passed when all Maestro tests passed', function() {
        var labelAdded = [];
        var A11Y_WARNING_RESULT = JSON.stringify({
            status: 'failed',
            summary: '11 passed, 0 failed',
            results: [
                { ticket: 'MAPC-TC-1', title: 'Form labels', status: 'passed', a11y_warnings: [{ element: 'Subject', warning: 'no value' }] },
                { ticket: 'MAPC-TC-2', title: 'Chat input', status: 'passed' }
            ],
            a11y_warnings: [{ element: 'Subject dropdown', warning: 'accessibilityText only', impact: 'VoiceOver issue' }]
        });

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return A11Y_WARNING_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if ((opts.command || '').indexOf('branch --show-current') !== -1) return 'test/MAPC-7014';
                return '';
            },
            github_list_prs: function() { return [{ number: 1001, title: 'MAPC-7014 fix', head: { ref: 'bug/MAPC-7014' } }]; },
            github_add_pr_label: function(opts) { labelAdded.push(opts.label); },
            github_remove_pr_label: function() {},
            jira_move_to_status: function() {},
            jira_post_comment: function() {},
            github_add_pr_comment: function() {}
        });

        m.action(makeParams('MAPC-7014'));

        assert.ok(labelAdded.indexOf('tests_passed') !== -1, 'should add tests_passed label when a11y warnings present but all tests pass');
        assert.ok(labelAdded.indexOf('tests_failed') === -1, 'should NOT add tests_failed label');
    });

});
