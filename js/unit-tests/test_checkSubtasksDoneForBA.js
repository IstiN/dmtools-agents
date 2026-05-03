/**
 * Unit tests for agents/js/checkSubtasksDoneForBA.js
 */

function loadBaCheck(mocks) {
    mocks = mocks || {};
    var configLoaderMock = {
        loadProjectConfig: function() {
            return {
                jira: {
                    questions: {
                        fetchJql: 'parent = {ticketKey} AND issuetype = Subtask ORDER BY created ASC'
                    },
                    statuses: {
                        BA_ANALYSIS: 'BA Analysis'
                    },
                    issueTypes: {
                        SUBTASK: 'Subtask'
                    }
                }
            };
        }
    };

    return loadModule(
        'agents/js/checkSubtasksDoneForBA.js',
        makeRequire({ './configLoader.js': configLoaderMock }),
        mocks
    );
}

suite('checkSubtasksDoneForBA', function() {

    test('moves story to BA Analysis when no clarification subtasks exist', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];
        var baCheck = loadBaCheck({
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = baCheck.action({
            ticket: { key: 'DMC-975' },
            jobParams: { customParams: { removeLabel: 'sm_story_ba_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ba_analysis_no_subtasks');
        assert.deepEqual(moved[0], { key: 'DMC-975', statusName: 'BA Analysis' });
        assert.contains(comments[0].comment, 'No clarification subtasks were created');
        assert.equal(removedLabels.length, 0, 'lock should not be released after successful transition');
    });

    test('releases lock when at least one clarification subtask is not Done', function() {
        var removedLabels = [];
        var moved = [];
        var searchCalls = 0;
        var baCheck = loadBaCheck({
            jira_search_by_jql: function() {
                searchCalls++;
                return searchCalls === 1
                    ? [{ key: 'DMC-976' }]
                    : [{ key: 'DMC-976' }];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = baCheck.action({
            ticket: { key: 'DMC-975' },
            jobParams: { customParams: { removeLabel: 'sm_story_ba_check_triggered' } }
        });

        assert.equal(result.action, 'waiting');
        assert.equal(moved.length, 0);
        assert.deepEqual(removedLabels[0], {
            key: 'DMC-975',
            label: 'sm_story_ba_check_triggered'
        });
    });
});
