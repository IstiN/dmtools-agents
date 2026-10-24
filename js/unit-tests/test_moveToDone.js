/**
 * Unit tests for js/moveToDone.js (postJSAction for bug_test_cases_generator)
 * gh-1242: every action() branch — missing ticket key, label-removal failure,
 * token-usage failure and the outer catch, alongside the happy path.
 */

function loadMoveToDone(mocks, tokenUsage) {
    return (function (_m) {
        return loadModule('js/moveToDone.js', makeRequire({
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': tokenUsage || { postTokenUsageComments: function() {} },
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), _m)
        }), _m);
    })(mocks);
}

function moveToDoneCtx(mocks, tokenUsage) {
    var logs = [];
    var warns = [];
    var withConsole = Object.assign({
        console: {
            log: function(msg) { logs.push(String(msg)); },
            warn: function(msg) { warns.push(String(msg)); },
            error: function(msg) { warns.push(String(msg)); }
        }
    }, mocks || {});
    return {
        module: loadMoveToDone(withConsole, tokenUsage),
        logs: logs,
        warns: warns
    };
}

suite('moveToDone', function() {

    test('missing ticket key → success:false with the no-key error', function() {
        var x = moveToDoneCtx({
            jira_move_to_status: function() { throw new Error('must not be called'); }
        });
        var noTicket = x.module.action({});
        assert.equal(noTicket.success, false);
        assert.equal(noTicket.error, 'No ticket key found in params');

        var emptyKey = x.module.action({ ticket: { key: '' } });
        assert.equal(emptyKey.success, false);
        assert.equal(emptyKey.error, 'No ticket key found in params');
    });

    test('happy path: moves to Done, strips the SM label, posts the comment, reports token usage', function() {
        var moved = [];
        var removed = [];
        var comments = [];
        var usageCalls = [];
        var x = moveToDoneCtx({
            jira_move_to_status: function(args) { moved.push(args); },
            jira_remove_label: function(args) { removed.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        }, {
            postTokenUsageComments: function(key, opts) { usageCalls.push({ key: key, opts: opts }); }
        });

        var result = x.module.action({ ticket: { key: 'TS-100' }, initiator: 'sm' });

        assert.equal(result.success, true);
        assert.equal(result.message, 'TS-100 moved to Done');
        assert.deepEqual(moved, [{ key: 'TS-100', statusName: 'Done' }]);
        assert.deepEqual(removed, [{ key: 'TS-100', label: 'sm_bug_test_cases_triggered' }]);
        assert.equal(comments.length, 1);
        assert.equal(comments[0].key, 'TS-100');
        assert.ok(comments[0].comment.indexOf('Test cases generated') !== -1, 'the closure comment is posted');
        assert.equal(usageCalls.length, 1, 'token usage reported once');
        assert.equal(usageCalls[0].key, 'TS-100');
        assert.equal(usageCalls[0].opts.initiator, 'sm');
        assert.ok(usageCalls[0].opts.tracker, 'the tracker instance is handed to the usage reporter');
        assert.ok(x.logs.some(function(l) { return l.indexOf('✅ TS-100 moved to Done') !== -1; }));
    });

    test('customParams nested under jobParams (real Teammate path) resolve the same way', function() {
        var moved = [];
        var x = moveToDoneCtx({
            jira_move_to_status: function(args) { moved.push(args); },
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        });
        var result = x.module.action({
            ticket: { key: 'TS-101' },
            jobParams: { customParams: { tracker: 'jira' } }
        });
        assert.equal(result.success, true);
        assert.deepEqual(moved, [{ key: 'TS-101', statusName: 'Done' }]);
    });

    test('a missing SM label is non-fatal — the action still succeeds', function() {
        var comments = [];
        var x = moveToDoneCtx({
            jira_move_to_status: function() {},
            jira_remove_label: function() { throw new Error('label not found'); },
            jira_post_comment: function(args) { comments.push(args); }
        });
        var result = x.module.action({ ticket: { key: 'TS-102' } });
        assert.equal(result.success, true, 'label absence must not fail the move');
        assert.equal(comments.length, 1, 'the closure comment is still posted');
        assert.ok(x.logs.some(function(l) { return l.indexOf('sm_bug_test_cases_triggered not found or already removed') !== -1; }));
    });

    test('a failing token-usage report is non-fatal — the action still succeeds', function() {
        var x = moveToDoneCtx({
            jira_move_to_status: function() {},
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        }, {
            postTokenUsageComments: function() { throw new Error('usage reporter down'); }
        });
        var result = x.module.action({ ticket: { key: 'TS-103' } });
        assert.equal(result.success, true);
        assert.ok(x.warns.some(function(w) { return w.indexOf('Failed to post token usage comments') !== -1; }));
    });

    test('a failing move lands in the outer catch → success:false', function() {
        var x = moveToDoneCtx({
            jira_move_to_status: function() { throw new Error('jira down'); },
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        });
        var result = x.module.action({ ticket: { key: 'TS-104' } });
        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('jira down') !== -1, 'the caught error is reported');
        assert.ok(x.warns.some(function(w) { return w.indexOf('Error in moveToDone') !== -1; }));
    });

});
