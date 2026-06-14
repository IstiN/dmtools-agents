/**
 * Unit tests for js/checkBugToFixReady.js
 */

function loadCheckBugToFixReady(mocks) {
    mocks = mocks || {};
    return loadModule(
        'js/checkBugToFixReady.js',
        makeRequire({
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        mocks
    );
}

function makeTicket(key, issueType) {
    return {
        key: key,
        fields: {
            issuetype: { name: issueType }
        }
    };
}

suite('checkBugToFixReady', function() {

    test('moves Test Case to Backlog when all linked bugs are Done', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('status != "Done"') !== -1) {
                    return [];
                }
                return [{ key: 'TS-91', fields: { status: { name: 'Done' } } }];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-90', 'Test Case'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(moved, [{ key: 'TS-90', statusName: 'Backlog' }]);
        assert.contains(comments[0].comment, 'Test Case Ready for Re-automation');
        assert.ok(removedLabels.some(function(l) { return l.label === 'sm_test_automation_triggered'; }));
    });

    test('moves Story to Ready For Testing when all linked bugs are Done', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('status != "Done"') !== -1) {
                    return [];
                }
                return [
                    { key: 'TS-92', fields: { status: { name: 'Done' } } },
                    { key: 'TS-93', fields: { status: { name: 'Done' } } }
                ];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-90', 'Story'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.deepEqual(moved, [{ key: 'TS-90', statusName: 'Ready For Testing' }]);
        assert.contains(comments[0].comment, 'Story Ready for Re-test');
        assert.ok(removedLabels.some(function(l) { return l.label === 'sm_story_done_check_triggered'; }));
    });

    test('releases lock when a linked bug is not Done', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('status != "Done"') !== -1) {
                    return [{ key: 'TS-94', fields: { status: { name: 'In Progress' } } }];
                }
                return [{ key: 'TS-94', fields: { status: { name: 'In Progress' } } }];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-90', 'Story'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_to_fix_check_triggered' }]);
    });

});
