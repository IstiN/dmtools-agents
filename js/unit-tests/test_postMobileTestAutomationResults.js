/**
 * Unit tests for js/postMobileTestAutomationResults.js
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
        'js/configLoader.js',
        makeRequire({ './config.js': configModule }),
        { file_read: fileReadMock }
    );
    var prHelper = loadModule(
        'js/common/pullRequest.js',
        makeRequire({
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }),
        {}
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
    var outputFiles = loadModule(
        'js/common/outputFiles.js',
        makeRequire({}),
        allMocks
    );
    var mobileHelpers = loadModule(
        'js/postMobileTestAutomationResultsHelpers.js',
        makeRequire({}),
        {}
    );

    return loadModule(
        'js/postMobileTestAutomationResults.js',
        makeRequire({
            './configLoader.js': freshConfigLoader,
            './config.js': configModule,
            './common/pullRequest.js': prHelper,
            './postMobileTestAutomationResultsHelpers.js': mobileHelpers,
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), allMocks),
            './common/outputFiles.js': outputFiles
        }),
        allMocks
    );
}

function makeParams(ticketKey, customParams) {
    return {
        ticket: { key: ticketKey, fields: { summary: 'Test ticket summary', labels: [] } },
        jobParams: {
            customParams: Object.assign({
                featurePR: { owner: 'ExampleOrg', repo: 'example-mobile-app' },
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
        { ticket: 'PROJ-TC-1', title: 'VoiceOver modal', status: 'passed' },
        { ticket: 'PROJ-TC-2', title: 'Close button label', status: 'passed' }
    ]
});

var FAILED_RESULT = JSON.stringify({
    status: 'failed',
    summary: '2 flows, 1 failed',
    results: [
        { ticket: 'PROJ-TC-1', title: 'VoiceOver modal', status: 'passed' },
        { ticket: 'PROJ-TC-2', title: 'Close button', status: 'failed', error: 'Element not found' }
    ]
});

var COUNT_ONLY_PASSED_RESULT = JSON.stringify({
    summary: '27/27 passed',
    passed: 27,
    failed: 0,
    skipped: 0,
    results: [
        { ticket: 'PROJ-TC-1', title: 'VoiceOver modal', status: 'passed' },
        { ticket: 'PROJ-TC-2', title: 'Close button label', status: 'passed' }
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
                    { number: 963, title: 'PROJ-6618 some feature', head: { ref: 'story/PROJ-6618' } }
                ]});
            },
            github_add_pr_label: function(opts) { labelsCalled.push(opts); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

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
                return [{ number: 42, title: 'Story PROJ-6618', head: { ref: 'story/PROJ-6618' } }];
            },
            github_add_pr_label: function(opts) { labelsCalled.push(opts); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

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
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        // Should complete without throwing
        var result = m.action(makeParams('PROJ-6618'));
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
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function(opts) { removed.push(opts.label); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

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
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function(opts) { removed.push(opts.label); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

        assert.ok(added.indexOf('tests_failed') !== -1, 'should add tests_failed label');
        assert.ok(removed.indexOf('tests_passed') !== -1, 'should remove tests_passed label');
    });

    test('infers passed status from counts when top-level status is missing', function() {
        var added = [], removed = [], statusMoves = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return COUNT_ONLY_PASSED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function(opts) { removed.push(opts.label); },
            jira_move_to_status: function(opts) { statusMoves.push(opts); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

        assert.ok(added.indexOf('tests_passed') !== -1, 'should add tests_passed label');
        assert.ok(removed.indexOf('tests_failed') !== -1, 'should remove tests_failed label');
        assert.ok(statusMoves.some(function(s) { return s.statusName === 'Passed'; }), 'should move Jira to Passed');
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
                return JSON.stringify({ data: [{ number: 10, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function() {},
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618', { labels: { testsPassed: 'qa_approved', testsFailed: 'qa_rejected' } }));

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
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function() {},
            github_remove_pr_label: function() {},
            github_add_pr_comment: function(opts) { prComments.push(opts); },
            cli_execute_command: function(opts) {
                cliCommands.push(opts.command || '');
                return 'test/PROJ-6618';
            }
        });

        m.action(makeParams('PROJ-6618'));

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
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function() {},
            github_remove_pr_label: function() {},
            github_add_pr_comment: function(opts) { prComments.push(opts); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

        assert.equal(prComments.length, 1, 'should post PR comment using pr_body.md fallback');
        assert.ok(prComments[0].text.indexOf('pr_body') !== -1, 'should contain pr_body content');
    });

    test('prepends verdict when pr_feature_update only contains coverage', function() {
        var prComments = [];

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return COUNT_ONLY_PASSED_RESULT;
                if (opts.path === 'outputs/pr_feature_update.md') return '## Automated Test Coverage Added\n\n27 Maestro YAML test flows';
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function() {},
            github_remove_pr_label: function() {},
            github_add_pr_comment: function(opts) { prComments.push(opts); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

        assert.equal(prComments.length, 1, 'should post PR comment');
        assert.ok(prComments[0].text.indexOf('FIX VERIFIED') !== -1, 'should include inferred verdict');
        assert.ok(prComments[0].text.indexOf('| 27 | 0 | 0 |') !== -1, 'should include pass/fail counts');
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
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

        assert.ok(jiraComments.some(function(c) { return c.key === 'PROJ-6618'; }), 'should post Jira comment');
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
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

        assert.ok(statusMoves.some(function(s) { return s.statusName === 'Failed'; }), 'should move to Failed');
    });

});

// ── Suite: git commit always happens ─────────────────────────────────────────

suite('postMobileTestAutomationResults — git commit resilience', function() {

    test('commits and pushes even when test_automation_result.json is missing', function() {
        var gitCommands = [];
        var jiraComments = [];
        var WORKING_DIR = 'dependencies/example-mobile-app-automation';

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null; // no result JSON anywhere
            },
            cli_execute_command: function(opts) {
                gitCommands.push(opts.command || '');
                if ((opts.command || '').indexOf('branch --show-current') !== -1) return 'test/PROJ-6618';
                return '';
            },
            jira_post_comment: function(opts) { jiraComments.push(opts); }
        });

        m.action(makeParams('PROJ-6618', { targetRepository: { workingDir: WORKING_DIR } }));

        var hasAddOrCommit = gitCommands.some(function(c) {
            return c.indexOf('git add') !== -1 || c.indexOf('git commit') !== -1;
        });
        assert.ok(hasAddOrCommit, 'should attempt git add/commit even with no result JSON');
        assert.ok(jiraComments.length > 0, 'should still post error Jira comment');
        assert.ok(jiraComments[0].comment.indexOf('⚠️') !== -1, 'error comment should warn about missing output');
    });

    test('missing-output resume prompt runs suite when simulator is available', function() {
        var writes = {};
        var WORKING_DIR = 'dependencies/example-mobile-app-automation';

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null; // no result JSON and no resume marker
            },
            file_write: function(path, content) {
                writes[path] = content;
            },
            cli_execute_command: function(opts) {
                if ((opts.command || '').indexOf('branch --show-current') !== -1) return 'test/PROJ-6618';
                return '';
            },
            jira_post_comment: function() {}
        });

        m.action(makeParams('PROJ-6618', { targetRepository: { workingDir: WORKING_DIR } }));

        var prompt = writes['outputs/.resume-prompt.md'] || '';
        assert.ok(prompt.indexOf('run the generated suite once on the available simulator') !== -1,
            'resume prompt should instruct suite execution when app_info has simulator details');
        assert.ok(prompt.indexOf('Only mark flows as "written" when there is a real blocker') !== -1,
            'resume prompt should not allow written status without a real execution blocker');
    });

    test('reads result JSON from automation repo outputs dir as fallback', function() {
        var statusMoves = [];
        var WORKING_DIR = 'dependencies/example-mobile-app-automation';

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return null; // workspace root — missing
                if (opts.path === WORKING_DIR + '/outputs/test_automation_result.json') return PASSED_RESULT; // fallback
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            cli_execute_command: function(opts) {
                if ((opts.command || '').indexOf('branch --show-current') !== -1) return 'test/PROJ-6618';
                return '';
            },
            jira_move_to_status: function(opts) { statusMoves.push(opts); },
            jira_post_comment: function() {}
        });

        m.action(makeParams('PROJ-6618', { targetRepository: { workingDir: WORKING_DIR } }));

        assert.ok(statusMoves.some(function(s) { return s.statusName === 'Passed'; }),
            'should read result from automation repo fallback path and move to Passed');
    });

});

suite('postMobileTestAutomationResults: tracker layer (ADO)', function() {
    test('ado: error path uses ado_* tools and no jira_* tool', function() {
        var calls = [];
        var mocks = {
            file_read: function() { return null; },
            cli_execute_command: function() { throw new Error('boom'); }
        };
        ['jira_post_comment', 'jira_move_to_status', 'jira_add_label', 'jira_remove_label'].forEach(function(n) {
            mocks[n] = function(a) { calls.push({ tool: n, args: a }); };
        });
        ['ado_add_work_item_comment', 'ado_move_to_state', 'ado_remove_work_item_label', 'ado_add_work_item_label'].forEach(function(n) {
            mocks[n] = function(a) { calls.push({ tool: n, args: a }); };
        });
        var module = loadPostCli(mocks);
        var params = makeParams('77', { trackerProvider: 'ado', removeLabel: 'sm_trigger' });
        var res = module.action(params);
        assert.equal(res.success, false);
        var tools = calls.map(function(c) { return c.tool; });
        assert.equal(tools.filter(function(t) { return t.indexOf('jira_') === 0; }).length, 0);
        assert.ok(tools.length > 0, 'expected at least one ado_* call');
        assert.ok(calls.every(function(c) { return String(c.args.id) === '77'; }));
        assert.deepEqual(tools, ['ado_add_work_item_comment']);
    });
});

// ── Suite: blocked_by_human path (gh-979 characterization) ────────────────────

var BLOCKED_RESULT = JSON.stringify({
    status: 'blocked_by_human',
    summary: 'Simulator unavailable',
    blocked_reason: 'No iOS simulator on the runner',
    missing: [
        { name: 'APP_PATH', description: 'Path to the built .app' },
        { name: 'MAESTRO_DEVICE' }
    ],
    results: []
});

suite('postMobileTestAutomationResults — blocked_by_human', function() {

    test('posts blocked comment, moves to Blocked and returns blocked status', function() {
        var jiraComments = [], statusMoves = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return BLOCKED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            jira_post_comment: function(opts) { jiraComments.push(opts); },
            jira_move_to_status: function(opts) { statusMoves.push(opts); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        var result = m.action(makeParams('PROJ-6618'));

        assert.equal(result.success, true, 'blocked run still succeeds');
        assert.equal(result.status, 'blocked_by_human', 'should report blocked status');
        var blocked = jiraComments.filter(function(c) {
            return c.comment.indexOf('Awaiting Human Setup') !== -1;
        });
        assert.equal(blocked.length, 1, 'should post exactly one blocked comment');
        assert.ok(blocked[0].comment.indexOf('No iOS simulator on the runner') !== -1,
            'should include blocked_reason');
        assert.ok(blocked[0].comment.indexOf('*APP_PATH*: Path to the built .app') !== -1,
            'should include missing item with description');
        assert.ok(blocked[0].comment.indexOf('*MAESTRO_DEVICE*\n') !== -1,
            'should include missing item without description');
        assert.ok(statusMoves.some(function(s) { return s.statusName === 'Blocked'; }),
            'should move Jira to Blocked');
    });

    test('skips feature PR label/comment updates when blocked', function() {
        var added = [], prComments = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return BLOCKED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts); },
            github_remove_pr_label: function() {},
            github_add_pr_comment: function(opts) { prComments.push(opts); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        m.action(makeParams('PROJ-6618'));

        assert.equal(added.length, 0, 'should not add pass/fail labels when blocked');
        assert.equal(prComments.length, 0, 'should not post feature PR comment when blocked');
    });

});

// ── Suite: a11y warnings path (gh-979 characterization) ───────────────────────

var A11Y_WARNED_RESULT = JSON.stringify({
    status: 'passed',
    summary: '2 flows passed with a11y warnings',
    results: [
        { ticket: 'PROJ-TC-1', title: 'VoiceOver modal', status: 'passed', a11y_warnings: ['button has no label'] },
        { ticket: 'PROJ-TC-2', title: 'Close button label', status: 'passed' }
    ]
});

var TOP_LEVEL_A11Y_RESULT = JSON.stringify({
    status: 'passed',
    summary: '1 flow passed',
    a11y_warnings: ['contrast too low'],
    results: [
        { ticket: 'PROJ-TC-1', title: 'VoiceOver modal', status: 'passed' }
    ]
});

suite('postMobileTestAutomationResults — a11y warnings', function() {

    test('keeps passed status with per-TC a11y warnings (informational only)', function() {
        var added = [], statusMoves = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return A11Y_WARNED_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function() {},
            jira_move_to_status: function(opts) { statusMoves.push(opts); },
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        var result = m.action(makeParams('PROJ-6618'));

        assert.equal(result.status, 'passed', 'a11y warnings must not override passed status');
        assert.ok(added.indexOf('tests_passed') !== -1, 'should still add tests_passed label');
        assert.ok(statusMoves.some(function(s) { return s.statusName === 'Passed'; }),
            'should still move Jira to Passed');
    });

    test('detects top-level a11y_warnings array without results-level warnings', function() {
        var added = [];
        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return TOP_LEVEL_A11Y_RESULT;
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            github_list_prs: function() {
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function(opts) { added.push(opts.label); },
            github_remove_pr_label: function() {},
            cli_execute_command: function() { return 'test/PROJ-6618'; }
        });

        var result = m.action(makeParams('PROJ-6618'));

        assert.equal(result.status, 'passed', 'top-level a11y warnings must not override passed status');
        assert.ok(added.indexOf('tests_passed') !== -1, 'should still add tests_passed label');
    });

});

// ── Suite: outer catch (gh-979 characterization) ─────────────────────────────

suite('postMobileTestAutomationResults — error handling', function() {

    test('outer catch returns success false when ticket is missing', function() {
        var m = loadPostCli({
            file_read: function() { return null; },
            cli_execute_command: function() { return ''; }
        });

        var result = m.action({ ticket: null, jobParams: { customParams: {} } });

        assert.equal(result.success, false, 'should report failure');
        assert.ok(result.error, 'should include the error message');
    });

});

// ── Suite: automation PR link injection (gh-979 characterization) ────────────

suite('postMobileTestAutomationResults — automation PR link injection', function() {

    test('appends automation PR URL to pr_feature_update.md when feature PR found', function() {
        var writes = {};
        var jiraComments = [];
        var AUTOMATION_PR_URL = 'https://github.com/org/example-mobile-app-automation/pull/7';

        var m = loadPostCli({
            file_read: function(opts) {
                if (opts.path === 'outputs/test_automation_result.json') return PASSED_RESULT;
                if (opts.path === 'outputs/pr_feature_update.md') return '## Test Results\n\nAll passed ✅';
                if (opts.path.indexOf('.dmtools/config') !== -1) return null;
                return null;
            },
            file_write: function(path, content) {
                writes[path] = content;
            },
            github_list_prs: function(opts) {
                // First call: feature-repo PR listing; later calls: automation-repo PR lookup
                return JSON.stringify({ data: [{ number: 963, title: 'PROJ-6618', head: { ref: 'story/PROJ-6618' } }]});
            },
            github_add_pr_label: function() {},
            github_remove_pr_label: function() {},
            github_add_pr_comment: function() {},
            jira_post_comment: function(opts) { jiraComments.push(opts); },
            cli_execute_command: function(opts) {
                var cmd = opts.command || '';
                if (cmd.indexOf('branch --show-current') !== -1) return 'test/PROJ-6618';
                if (cmd.indexOf('gh pr list --head') !== -1) return AUTOMATION_PR_URL;
                return '';
            }
        });

        var result = m.action(makeParams('PROJ-6618', { targetRepository: { workingDir: 'dependencies/automation' } }));

        assert.equal(result.success, true);
        var updated = writes['outputs/pr_feature_update.md'];
        assert.ok(updated, 'should rewrite outputs/pr_feature_update.md');
        assert.ok(updated.indexOf('All passed') !== -1, 'should keep original content');
        assert.ok(updated.indexOf('> Automation PR: ' + AUTOMATION_PR_URL) !== -1,
            'should append the automation PR link');
        assert.ok(jiraComments.some(function(c) {
            return c.comment.indexOf('*Automation PR*: ' + AUTOMATION_PR_URL) !== -1;
        }), 'Jira comment should reference the automation PR');
    });

});

// ── Suite: updateFeaturePRLabel — github-globals variant (gh-1083) ───────────
// Characterization of the direct github_* label path (kept for flows without
// the SCM abstraction — no deletion): remove-then-add order, stringified PR
// id, error tolerance. The SCM variant (updateFeaturePRLabelWithScm) is
// pinned through action() in the suites above.

suite('postMobileTestAutomationResults — updateFeaturePRLabel (github globals)', function() {

    test('passed → removes tests_failed first, then adds tests_passed (string PR id, scoped workspace/repo)', function() {
        var calls = [];
        var m = loadPostCli({
            github_remove_pr_label: function(opts) { calls.push(['remove', opts]); },
            github_add_pr_label: function(opts) { calls.push(['add', opts]); }
        });

        m.updateFeaturePRLabel('ExampleOrg', 'example-mobile-app', 963, true, 'tests_passed', 'tests_failed');

        assert.equal(calls.length, 2, 'exactly one remove + one add');
        assert.equal(calls[0][0], 'remove', 'the opposite label goes first');
        assert.equal(calls[0][1].label, 'tests_failed');
        assert.equal(calls[1][0], 'add');
        assert.equal(calls[1][1].label, 'tests_passed');
        assert.equal(calls[1][1].pullRequestId, '963', 'PR number must be stringified');
        assert.equal(calls[1][1].workspace, 'ExampleOrg');
        assert.equal(calls[1][1].repository, 'example-mobile-app');
    });

    test('failed → removes tests_passed and adds tests_failed', function() {
        var added = [], removed = [], addedOpts = [];
        var m = loadPostCli({
            github_remove_pr_label: function(opts) { removed.push(opts.label); },
            github_add_pr_label: function(opts) { added.push(opts.label); addedOpts.push(opts); }
        });

        m.updateFeaturePRLabel('ExampleOrg', 'example-mobile-app', 5, false, 'tests_passed', 'tests_failed');

        assert.deepEqual(added, ['tests_failed']);
        assert.deepEqual(removed, ['tests_passed']);
        assert.equal(addedOpts[0].pullRequestId, '5', 'numeric PR id is stringified');
    });

    test('removeLabel throw is swallowed — the add still runs', function() {
        var added = [];
        var m = loadPostCli({
            github_remove_pr_label: function() { throw new Error('remove failed'); },
            github_add_pr_label: function(opts) { added.push(opts.label); }
        });

        m.updateFeaturePRLabel('ExampleOrg', 'example-mobile-app', 7, true, 'tests_passed', 'tests_failed');

        assert.deepEqual(added, ['tests_passed'], 'inner remove failure must not block the add');
    });

    test('addLabel throw is caught — no propagation to the caller', function() {
        var m = loadPostCli({
            github_add_pr_label: function() { throw new Error('add failed'); }
        });

        var threw = null;
        try {
            m.updateFeaturePRLabel('ExampleOrg', 'example-mobile-app', 8, true, 'tests_passed', 'tests_failed');
        } catch (e) {
            threw = e;
        }
        assert.notOk(threw, 'add failure must not escape updateFeaturePRLabel: ' + threw);
    });

});
