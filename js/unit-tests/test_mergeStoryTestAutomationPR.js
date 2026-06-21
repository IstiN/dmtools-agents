/**
 * Unit tests for js/mergeStoryTestAutomationPR.js
 */

function loadMergeStoryTestAutomationPR(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {},
        jira_search_by_jql: function() { return []; },
        jira_link_issues: function() {},
        jira_add_label: function() {},
        github_list_prs: function() { return []; },
        github_get_pr: function() { return {}; },
        github_merge_pr: function() {},
        github_remove_pr_label: function() {},
        cli_execute_command: function() { return ''; },
        file_read: function() { return null; }
    };

    var allMocks = Object.assign({}, defaults, mocks);

    var scmModule = loadModule(
        'js/common/scm.js',
        makeRequire({}),
        allMocks
    );

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': scmModule
        }),
        { file_read: function() { return null; } }
    );

    return loadModule(
        'js/mergeStoryTestAutomationPR.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/scm.js': scmModule,
            './common/autoStart.js': {
                triggerSmIfIdle: function() { return { success: true }; }
            },
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function() {}
            }
        }),
        allMocks
    );
}

suite('mergeStoryTestAutomationPR', function() {

    test('merges PR and moves linked Test Cases to Passed/Failed', function() {
        var merged = [];
        var statusMoves = [];
        var labelsRemoved = [];

        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') {
                    return 'https://github.com/IstiN/trackstate.git';
                }
                return '';
            },
            github_list_prs: function() {
                return [{ number: 55, head: { ref: 'test/TS-50' }, html_url: 'https://github.com/IstiN/trackstate/pull/55' }];
            },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_merge_pr: function(args) { merged.push(args); },
            github_remove_pr_label: function(num, label) { labelsRemoved.push({ num: num, label: label }); },
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-50")');
                assert.deepEqual(args.fields, ['key', 'status']);
                return [
                    { key: 'TS-51', fields: { status: { name: 'In Review - Passed' } } },
                    { key: 'TS-52', fields: { status: { name: 'In Review - Failed' } } }
                ];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { labelsRemoved.push(args); },
            jira_post_comment: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-50' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(result, true);
        assert.deepEqual(merged, [{ workspace: 'IstiN', repository: 'trackstate', pullRequestId: '55', mergeMethod: 'squash' }]);
        assert.deepEqual(statusMoves, [
            { key: 'TS-51', statusName: 'Passed' },
            { key: 'TS-52', statusName: 'Failed' }
        ]);
    });

    test('merges Bug PR and moves Bug to Done after linked Test Cases', function() {
        var merged = [];
        var statusMoves = [];

        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function() {
                return [{ number: 77, head: { ref: 'test/TS-80' }, html_url: 'https://github.com/IstiN/trackstate/pull/77' }];
            },
            github_get_pr: function() { return { mergeable: true, mergeable_state: 'clean' }; },
            github_merge_pr: function(args) { merged.push(args); },
            github_remove_pr_label: function() {},
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-80")');
                return [
                    { key: 'TS-81', fields: { status: { name: 'In Review - Passed' } } }
                ];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-80', fields: { issuetype: { name: 'Bug' } } },
            jobParams: { customParams: { removeLabel: 'sm_bug_test_merge_triggered' } }
        });

        assert.equal(result, true);
        assert.deepEqual(statusMoves, [
            { key: 'TS-81', statusName: 'Passed' },
            { key: 'TS-80', statusName: 'Done' }
        ]);
    });

    test('returns false when no open PR found', function() {
        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function() { return []; }
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(result, false);
    });

    test('moves ticket to In Rework on merge conflict', function() {
        var statusMoves = [];
        var comments = [];

        var module = loadMergeStoryTestAutomationPR({
            cli_execute_command: function(opts) {
                if (opts.command === 'git config --get remote.origin.url') return 'https://github.com/IstiN/trackstate.git';
                return '';
            },
            github_list_prs: function() {
                return [{ number: 66, head: { ref: 'test/TS-70' }, html_url: 'https://github.com/IstiN/trackstate/pull/66' }];
            },
            github_get_pr: function() { return { mergeable: false, mergeable_state: 'dirty' }; },
            github_remove_pr_label: function() {},
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-70' },
            jobParams: { customParams: { removeLabel: 'sm_story_test_merge_triggered' } }
        });

        assert.equal(result, true);
        assert.deepEqual(statusMoves, [{ key: 'TS-70', statusName: 'In Rework' }]);
        assert.ok(comments[0].indexOf('MERGE CONFLICT') !== -1);
    });

});
