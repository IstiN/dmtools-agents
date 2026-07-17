/**
 * Unit tests for js/unblockResolvedDependencies.js.
 */

function loadUnblockResolvedDependencies(mocks) {
    var calls = {
        statusMoves: [],
        comments: []
    };

    var defaults = {
        jira_get_ticket: function() {
            return { fields: { issuelinks: [] } };
        },
        jira_move_to_status: function(args) { calls.statusMoves.push(args); },
        jira_post_comment: function(args) { calls.comments.push(args); }
    };

    var mod = loadModule(
        'js/unblockResolvedDependencies.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        Object.assign({}, defaults, mocks || {})
    );

    return { mod: mod, calls: calls };
}

function ticketBlockedBy(statusName) {
    return {
        fields: {
            issuelinks: [
                {
                    type: { name: 'Blocks' },
                    inwardIssue: { key: 'PROJ-1', fields: { status: { name: statusName } } }
                }
            ]
        }
    };
}

suite('unblockResolvedDependencies', function() {

    test('blocker in literal "Closed" status counts as resolved', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() { return ticketBlockedBy('Closed'); }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(loaded.calls.statusMoves, [
            { key: 'PROJ-2', statusName: 'Backlog' }
        ]);
    });

    test('blocker in a non-terminal status keeps ticket Blocked', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() { return ticketBlockedBy('In Progress'); }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'still_blocked');
        assert.deepEqual(loaded.calls.statusMoves, []);
    });

    test('ticket without blockers is moved to Backlog', function() {
        var loaded = loadUnblockResolvedDependencies();

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'moved_to_backlog_no_blockers');
        assert.deepEqual(loaded.calls.statusMoves, [
            { key: 'PROJ-2', statusName: 'Backlog' }
        ]);
    });

});
