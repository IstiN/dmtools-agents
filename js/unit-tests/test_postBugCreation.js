/**
 * Unit tests for js/postBugCreation.js
 */

function loadPostBugCreation(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {},
        jira_link_issues: function() {},
        jira_create_ticket_basic: function() { return ''; },
        file_read: function() { return null; }
    };

    return loadModule(
        'js/postBugCreation.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        Object.assign({}, defaults, mocks)
    );
}

suite('postBugCreation', function() {

    test('removes SM trigger label when bug_decision.json is missing', function() {
        var removedLabels = [];
        var comments = [];

        var module = loadPostBugCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bug_decision.json') return null;
                return null;
            },
            jira_post_comment: function(args) {
                comments.push(args);
            },
            jira_remove_label: function(args) {
                removedLabels.push(args);
            }
        });

        var result = module.action({
            ticket: { key: 'TS-732' },
            metadata: { contextId: 'bug_creation' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered'
                }
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No bug_decision.json');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Could not read bug_decision.json');
        // sm_bug_creation_triggered is intentionally kept to prevent SM re-triggering an infinite loop
        assert.deepEqual(removedLabels, [
            { key: 'TS-732', label: 'bug_creation_wip' }
        ]);
    });

    test('moves test-code issue decision to In Rework and clears trigger labels', function() {
        var statusMoves = [];
        var removedLabels = [];
        var comments = [];

        var module = loadPostBugCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bug_decision.json') {
                    return JSON.stringify({
                        action: 'none',
                        reason: 'Failure is caused by stale test automation.'
                    });
                }
                return null;
            },
            jira_post_comment: function(args) { comments.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-222' },
            metadata: { contextId: 'bug_creation' },
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'none');
        assert.deepEqual(statusMoves, [
            { key: 'TS-222', statusName: 'In Rework' }
        ]);
        assert.deepEqual(removedLabels, [
            { key: 'TS-222', label: 'sm_test_automation_triggered' },
            { key: 'TS-222', label: 'bug_creation_wip' },
            { key: 'TS-222', label: 'sm_bug_creation_triggered' }
        ]);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'In Rework');
    });

});
