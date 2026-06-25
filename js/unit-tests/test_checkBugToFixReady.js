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

    test('keeps Story in Bug To Fix when a linked Test Case has a pending Bug', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                var jql = args.jql;
                // Direct linked bugs of the Story: one Done bug.
                if (jql.indexOf('linkedIssues("TS-90")') !== -1 && jql.indexOf('issuetype = Bug') !== -1) {
                    if (jql.indexOf('status != "Done"') !== -1) {
                        return [];
                    }
                    return [{ key: 'TS-92', fields: { status: { name: 'Done' } } }];
                }
                // Linked Test Cases of the Story.
                if (jql.indexOf('linkedIssues("TS-90")') !== -1 && jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [{ key: 'TS-TC-1', fields: { status: { name: 'Bug To Fix' } } }];
                }
                // Bugs linked to the Test Case: one not-Done bug.
                if (jql.indexOf('linkedIssues("TS-TC-1")') !== -1 && jql.indexOf('issuetype = Bug') !== -1) {
                    if (jql.indexOf('status != "Done"') !== -1) {
                        return [{ key: 'TS-95', fields: { status: { name: 'Ready For Testing' } } }];
                    }
                    return [
                        { key: 'TS-95', fields: { status: { name: 'Ready For Testing' } } }
                    ];
                }
                return [];
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
        assert.equal(result.action, 'waiting_for_tc_bugs');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_to_fix_check_triggered' }]);
    });

    test('keeps Story in Bug To Fix when search results are host objects (GraalJS)', function() {
        var moved = [];
        var removedLabels = [];

        // Simulates DMTools host objects where direct .key access returns undefined
        // but JSON.stringify() serialises the underlying data.
        function hostIssue(key, statusName) {
            return {
                toJSON: function() {
                    return { key: key, fields: { status: { name: statusName } } };
                }
            };
        }

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                var jql = args.jql;
                if (jql.indexOf('linkedIssues("TS-90")') !== -1 && jql.indexOf('issuetype = Bug') !== -1) {
                    if (jql.indexOf('status != "Done"') !== -1) {
                        return [];
                    }
                    return [hostIssue('TS-92', 'Done')];
                }
                if (jql.indexOf('linkedIssues("TS-90")') !== -1 && jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [hostIssue('TS-TC-1', 'Bug To Fix')];
                }
                if (jql.indexOf('linkedIssues("TS-TC-1")') !== -1 && jql.indexOf('issuetype = Bug') !== -1) {
                    if (jql.indexOf('status != "Done"') !== -1) {
                        return [hostIssue('TS-95', 'Ready For Testing')];
                    }
                    return [hostIssue('TS-95', 'Ready For Testing')];
                }
                return [];
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
        assert.equal(result.action, 'waiting_for_tc_bugs');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_to_fix_check_triggered' }]);
    });

});
