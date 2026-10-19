/**
 * Unit tests for js/unblockResolvedDependencies.js.
 */

function loadUnblockResolvedDependencies(mocks) {
    var calls = {
        statusMoves: [],
        comments: [],
        tokenUsage: []
    };

    var defaults = {
        jira_get_ticket: function() {
            return { fields: { issuelinks: [] } };
        },
        jira_move_to_status: function(args) {
            calls.statusMoves.push(args);
            if (mocks && mocks.moveThrows) throw new Error('transition down');
        },
        jira_post_comment: function(args) {
            calls.comments.push(args);
            if (mocks && mocks.commentThrows) throw new Error('comment down');
        }
    };

    var allMocks = Object.assign({}, defaults, mocks || {});
    allMocks.token_usage = {
        postTokenUsageComments: function(key, opts) {
            calls.tokenUsage.push({ key: key, opts: opts });
            if (mocks && mocks.tokenUsageThrows) throw new Error('token usage down');
        },
        customParamsOf: function(params) {
            return (params && params.jobParams && params.jobParams.customParams) || {};
        }
    };
    var mod = loadModule(
        'js/unblockResolvedDependencies.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': allMocks.token_usage,
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), allMocks)
        }),
        allMocks
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

    test('missing ticket key fails fast without touching the tracker', function() {
        var loaded = loadUnblockResolvedDependencies();

        var result = loaded.mod.action({});

        assert.deepEqual(result, { success: false, action: 'missing_ticket' });
        assert.deepEqual(loaded.calls.statusMoves, []);
        assert.deepEqual(loaded.calls.comments, []);
    });

    test('fetch failure reports fetch_failed with the error', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() { throw new Error('jira down'); }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.success, false);
        assert.equal(result.action, 'fetch_failed');
        assert.ok(result.error.indexOf('jira down') !== -1);
        assert.deepEqual(loaded.calls.statusMoves, []);
    });

    test('fetch requests only the issuelinks field', function() {
        var seen = [];
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function(args) {
                seen.push(args);
                return { fields: { issuelinks: [] } };
            }
        });

        loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.deepEqual(seen, [{ key: 'PROJ-2', fields: ['issuelinks'] }]);
    });

    test('mixed blockers: only unresolved ones are reported and nothing moves', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1', fields: { status: { name: 'Done' } } } },
                            { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-3', fields: { status: { name: 'In Progress' } } } }
                        ]
                    }
                };
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.success, true);
        assert.equal(result.action, 'still_blocked');
        assert.deepEqual(result.unresolved, [{ key: 'PROJ-3', status: 'In Progress' }]);
        assert.equal(result.ticketKey, 'PROJ-2');
        assert.deepEqual(loaded.calls.statusMoves, [], 'still blocked — no transition');
        assert.deepEqual(loaded.calls.comments, []);
    });

    test('all resolved with several blockers: moves to Backlog and lists every blocker in the comment', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1', fields: { status: { name: 'Done' } } } },
                            { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-3', fields: { status: { name: 'Passed' } } } },
                            { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-4', fields: { status: { name: 'Irrelevant' } } } }
                        ]
                    }
                };
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'moved_to_backlog');
        assert.equal(result.blockersResolved, 3);
        assert.equal(result.ticketKey, 'PROJ-2');
        assert.deepEqual(loaded.calls.statusMoves, [{ key: 'PROJ-2', statusName: 'Backlog' }]);
        assert.equal(loaded.calls.comments.length, 1);
        var body = loaded.calls.comments[0].comment;
        assert.ok(body.indexOf('PROJ-1 (Done)') !== -1, 'comment lists blocker 1');
        assert.ok(body.indexOf('PROJ-3 (Passed)') !== -1, 'comment lists blocker 2');
        assert.ok(body.indexOf('PROJ-4 (Irrelevant)') !== -1, 'comment lists blocker 3');
    });

    test('Merged and literal Closed blockers count as resolved (2+ blockers mix)', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1', fields: { status: { name: 'Merged' } } } },
                            { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-3', fields: { status: { name: 'Closed' } } } }
                        ]
                    }
                };
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(loaded.calls.statusMoves, [{ key: 'PROJ-2', statusName: 'Backlog' }]);
    });

    test('blocker without status details is treated as unresolved Unknown', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-9' } }
                        ]
                    }
                };
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'still_blocked');
        assert.deepEqual(result.unresolved, [{ key: 'PROJ-9', status: 'Unknown' }]);
    });

    test('links without inwardIssue or not of type Blocks are ignored', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { type: { name: 'Blocks' }, outwardIssue: { key: 'PROJ-8', fields: { status: { name: 'To Do' } } } },
                            { type: { name: 'Relates' }, inwardIssue: { key: 'PROJ-7', fields: { status: { name: 'To Do' } } } },
                            { inwardIssue: { key: 'PROJ-6', fields: { status: { name: 'To Do' } } } }
                        ]
                    }
                };
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'moved_to_backlog_no_blockers', 'no valid Blocks links — treated as unblocked');
        assert.deepEqual(loaded.calls.statusMoves, [{ key: 'PROJ-2', statusName: 'Backlog' }]);
    });

    test('move failure on the no-blockers path reports move_failed', function() {
        var loaded = loadUnblockResolvedDependencies({ moveThrows: true });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.success, false);
        assert.equal(result.action, 'move_failed');
        assert.ok(result.error.indexOf('transition down') !== -1);
    });

    test('move failure on the all-resolved path reports move_failed before commenting', function() {
        var loaded2 = loadUnblockResolvedDependencies({
            moveThrows: true,
            jira_get_ticket: function() { return ticketBlockedBy('Done'); }
        });

        var result = loaded2.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.success, false);
        assert.equal(result.action, 'move_failed');
        assert.deepEqual(loaded2.calls.comments, [], 'no unblock comment when the move fails');
    });

    test('comment failure after the move still reports success on the all-resolved path', function() {
        var loaded = loadUnblockResolvedDependencies({
            commentThrows: true,
            jira_get_ticket: function() { return ticketBlockedBy('Done'); }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(loaded.calls.statusMoves, [{ key: 'PROJ-2', statusName: 'Backlog' }]);
    });

    test('comment failure on the no-blockers path surfaces as move_failed (shared try block)', function() {
        var loaded = loadUnblockResolvedDependencies({ commentThrows: true });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.success, false);
        assert.equal(result.action, 'move_failed');
        assert.deepEqual(loaded.calls.statusMoves, [{ key: 'PROJ-2', statusName: 'Backlog' }],
            'the transition already happened before the comment failed');
    });

    test('token usage comments run after the move with initiator and jobParams customParams', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() { return ticketBlockedBy('Done'); }
        });

        var result = loaded.mod.action({
            ticket: { key: 'PROJ-2' },
            initiator: 'sm',
            jobParams: { customParams: { a: 1 } }
        });

        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(loaded.calls.tokenUsage, [
            { key: 'PROJ-2', opts: { initiator: 'sm', customParams: { a: 1 } } }
        ]);
    });

    test('token usage failure is swallowed', function() {
        var loaded = loadUnblockResolvedDependencies({
            tokenUsageThrows: true,
            jira_get_ticket: function() { return ticketBlockedBy('Done'); }
        });

        var result = loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.equal(result.action, 'moved_to_backlog');
    });

    test('token usage comments do not run when the ticket stays blocked', function() {
        var loaded = loadUnblockResolvedDependencies({
            jira_get_ticket: function() { return ticketBlockedBy('In Progress'); }
        });

        loaded.mod.action({ ticket: { key: 'PROJ-2' } });

        assert.deepEqual(loaded.calls.tokenUsage, []);
    });

});
