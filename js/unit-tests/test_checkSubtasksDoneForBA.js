/**
 * Unit tests for js/checkSubtasksDoneForBA.js
 */

function baTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

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
        'js/checkSubtasksDoneForBA.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': baTrackers(mocks)
        }),
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

    test('ado provider: uses ado_* tools only, no jira_* (wave2d3)', function() {
        var calls = [];
        var mocks = {
            ado_search_by_wiql: function(a) { calls.push({ t: 'search', a: a }); return { value: [] }; },
            ado_move_to_state: function(a) { calls.push({ t: 'move', a: a }); },
            ado_add_work_item_comment: function(a) { calls.push({ t: 'comment', a: a }); },
            jira_search_by_jql: function() { throw new Error('jira_search_by_jql must not be called'); },
            jira_move_to_status: function() { throw new Error('jira_move_to_status must not be called'); },
            jira_post_comment: function() { throw new Error('jira_post_comment must not be called'); }
        };
        var baCheck = loadBaCheck(mocks);
        var result = baCheck.action({
            ticket: { key: '42' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ba_analysis_no_subtasks');
        var move = calls.filter(function(c) { return c.t === 'move'; })[0];
        assert.equal(String(move.a.id), '42');
        assert.equal(calls.filter(function(c) { return c.t === 'comment'; }).length, 1);
        assert.equal(calls[0].t, 'search');
    });
});
