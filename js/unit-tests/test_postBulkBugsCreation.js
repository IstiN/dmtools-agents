/**
 * Unit tests for js/postBulkBugsCreation.js
 */

function loadPostBulkBugsCreation(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {},
        jira_add_label: function() {},
        jira_link_issues: function() {},
        jira_create_ticket_basic: function() { return ''; },
        file_read: function() { return null; }
    };

    return loadModule(
        'js/postBulkBugsCreation.js',
        makeRequire({
            './config.js': configModule,
            './common/feedbackLoop.js': {
                resumeAgent: function() {
                    return { attempted: false, reason: 'unit test' };
                }
            }
        }),
        Object.assign({}, defaults, mocks)
    );
}

suite('postBulkBugsCreation', function() {

    test('moves skipped test-code issues to In Rework and clears trigger labels', function() {
        var statusMoves = [];
        var removedLabels = [];
        var comments = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-396'],
                        newBugs: [],
                        links: [],
                        fixedByBug: [],
                        skipped: [
                            { tcKey: 'TS-396', reason: 'Failure is caused by outdated test code.' }
                        ]
                    });
                }
                return null;
            },
            jira_post_comment: function(args) { comments.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.results.skipped.length, 1);
        assert.deepEqual(statusMoves, [
            { key: 'TS-396', statusName: 'In Rework' }
        ]);
        assert.deepEqual(removedLabels, [
            { key: 'TS-396', label: 'sm_test_automation_triggered' },
            { key: 'TS-396', label: 'sm_bug_creation_triggered' },
            { key: 'TS-396', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'In Rework');
    });

    test('rejects fixedByBug decisions and does not move TC to Backlog', function() {
        var statusMoves = [];
        var removedLabels = [];
        var links = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-706'],
                        newBugs: [],
                        links: [],
                        fixedByBug: [
                            { tcKey: 'TS-706', bugKey: 'TS-1', reason: 'Done bug matched' }
                        ],
                        skipped: []
                    });
                }
                return null;
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_link_issues: function(args) { links.push(args); }
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered'
                }
            }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'fixedByBug is not supported');
        assert.deepEqual(statusMoves, []);
        assert.deepEqual(links, []);
        assert.deepEqual(removedLabels, [
            { key: 'TS-706', label: 'sm_bug_creation_triggered' },
            { key: 'TS-706', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
    });

});
