/**
 * Unit tests for js/checkStoryTestsPassed.js
 */

function loadCheckStoryTestsPassed(mocks) {
    mocks = mocks || {};
    var configLoaderMock = makeDefaultConfigLoaderMock({
        jira: {
            issueTypes: {
                TEST_CASE: 'Test Case',
                BUG: 'Bug'
            }
        }
    });

    return loadModule(
        'js/checkStoryTestsPassed.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderMock,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        mocks
    );
}

function makeTc(key, status) {
    return { key: key, fields: { status: { name: status } } };
}

suite('checkStoryTestsPassed', function() {

    test('moves Story to Done when all linked TCs are Passed', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-11', 'Passed'), makeTc('TS-12', 'Passed')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-10', statusName: 'Done' }]);
        assert.contains(comments[0].comment, 'All Test Cases Passed');
        assert.equal(removedLabels.length, 0, 'lock should not be released after Done');
    });

    test('moves Story to Done when TCs are Passed, Skipped, or Irrelevant', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-21', 'Passed'), makeTc('TS-22', 'Skipped'), makeTc('TS-23', 'Irrelevant')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-20' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-20', statusName: 'Done' }]);
        assert.contains(comments[0].comment, 'All Test Cases Passed');
        assert.equal(removedLabels.length, 0, 'lock should not be released after Done');
    });

    test('waits when a TC is still in In Review - Passed', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-21', 'In Review - Passed')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-20' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_in_flight');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-20', label: 'sm_story_done_check_triggered' }]);
    });

    test('waits when a Failed TC has no linked bug yet', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-31', 'Failed')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-30' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_for_bugs');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-30', label: 'sm_story_done_check_triggered' }]);
    });

    test('waits when a Failed TC coexists with Skipped or Irrelevant TCs', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-33', 'Failed'), makeTc('TS-34', 'Skipped'), makeTc('TS-35', 'Irrelevant')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-35' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_for_bugs');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-35', label: 'sm_story_done_check_triggered' }]);
    });

    test('moves Story to Bug To Fix when a TC has a non-Done linked bug', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-41', 'Bug To Fix')];
                }
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-50', fields: { status: { name: 'In Progress' } } }];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-40' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_bug_to_fix');
        assert.deepEqual(moved, [{ key: 'TS-40', statusName: 'Bug To Fix' }]);
        assert.contains(comments[0].comment, 'Story Moved to Bug To Fix');
        assert.contains(comments[0].comment, 'TS-50');
        assert.deepEqual(removedLabels, [{ key: 'TS-40', label: 'sm_story_done_check_triggered' }]);
    });

    test('moves Story back to Ready For Testing when all linked bugs are Done', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-61', 'Bug To Fix'), makeTc('TS-62', 'Passed')];
                }
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-70', fields: { status: { name: 'Done' } } }];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.deepEqual(moved, [{ key: 'TS-60', statusName: 'Ready For Testing' }]);
        assert.contains(comments[0].comment, 'Ready for Re-test');
        assert.deepEqual(removedLabels, [{ key: 'TS-60', label: 'sm_story_done_check_triggered' }]);
    });

    test('honors customParams.customStatuses override over config statuses', function() {
        var moved = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-81', 'Bug To Fix')];
                }
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-90', fields: { status: { name: 'Done' } } }];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-80' },
            jobParams: { customParams: { customStatuses: { READY_FOR_TESTING: 'Retest Needed' } } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.deepEqual(moved, [{ key: 'TS-80', statusName: 'Retest Needed' }]);
    });

});
