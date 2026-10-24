/**
 * Unit tests for js/moveToDone.js
 *
 * gh-1250: the shared ticket-key/config/tracker opening block moved into
 * js/common/actionTicketContext.js — these tests pin the action's observable
 * behavior (jira tool calls, logs, structured results) around that seam.
 */

function loadActionTicketContext(mocks) {
    mocks = mocks || {};
    return loadModule('js/common/actionTicketContext.js', makeRequire({
        '../configLoader.js': makeDefaultConfigLoaderMock(),
        './trackers.js': loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }), mocks)
    }), mocks);
}

function loadMoveToDone(mocks) {
    mocks = mocks || {};
    return (function (_m) { return loadModule('js/moveToDone.js', makeRequire(Object.assign({}, {
        './config.js': configModule,
        './configLoader.js': makeDefaultConfigLoaderMock(),
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/actionTicketContext.js': loadActionTicketContext(_m)
    }, { './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), _m) })), _m); })(mocks);
}

function moveToDoneCapturingLogs(mocks) {
    var logs = [];
    var withConsole = Object.assign({
        console: {
            log: function(msg) { logs.push(String(msg)); },
            warn: function(msg) { logs.push('WARN: ' + String(msg)); },
            error: function(msg) { logs.push('ERROR: ' + String(msg)); }
        }
    }, mocks || {});
    return {
        module: loadMoveToDone(withConsole),
        logs: logs
    };
}

suite('moveToDone', function() {

    test('happy path: moves to Done, removes trigger label, posts the Done comment', function() {
        var moved = [];
        var removed = [];
        var commented = [];
        var x = moveToDoneCapturingLogs({
            jira_move_to_status: function(args) { moved.push(args); },
            jira_remove_label: function(args) { removed.push(args); },
            jira_post_comment: function(args) { commented.push(args); }
        });

        var result = x.module.action({ ticket: { key: 'TS-500' } });

        assert.equal(result.success, true);
        assert.equal(result.message, 'TS-500 moved to Done');
        assert.deepEqual(moved, [{ key: 'TS-500', statusName: 'Done' }]);
        assert.deepEqual(removed, [{ key: 'TS-500', label: 'sm_bug_test_cases_triggered' }]);
        assert.equal(commented.length, 1);
        assert.equal(commented[0].key, 'TS-500');
        assert.ok(commented[0].comment.indexOf('Test cases generated. Bug marked as Done.') === 0);
        assert.ok(x.logs.some(function(l) { return l.indexOf('✅ TS-500 moved to Done') !== -1; }));
    });

    test('a missing trigger label is best-effort: action still succeeds with a note in the log', function() {
        var moved = [];
        var x = moveToDoneCapturingLogs({
            jira_move_to_status: function(args) { moved.push(args); },
            jira_remove_label: function() { throw new Error('label not found'); },
            jira_post_comment: function() {}
        });

        var result = x.module.action({ ticket: { key: 'TS-501' } });

        assert.equal(result.success, true);
        assert.deepEqual(moved, [{ key: 'TS-501', statusName: 'Done' }]);
        assert.ok(x.logs.some(function(l) {
            return l.indexOf('Label sm_bug_test_cases_triggered not found or already removed') !== -1;
        }));
    });

    test('missing ticket key: structured failure, no status move', function() {
        var x = moveToDoneCapturingLogs({
            jira_move_to_status: function() { throw new Error('must not be called'); }
        });

        var result = x.module.action({});

        assert.deepEqual(result, { success: false, error: 'No ticket key found in params' });
        assert.ok(x.logs.every(function(l) { return l.indexOf('moved to Done') === -1; }));
    });

    test('a rejected transition fails the action loudly', function() {
        var x = moveToDoneCapturingLogs({
            jira_move_to_status: function() { throw new Error('state rejected'); }
        });

        var result = x.module.action({ ticket: { key: 'TS-502' } });

        assert.equal(result.success, false);
        assert.ok(String(result.error).indexOf('state rejected') !== -1);
        assert.ok(x.logs.some(function(l) { return l.indexOf('❌ Error in moveToDone') !== -1; }));
    });

    test('top-level params.customParams reaches the tracker (stageFallback honored)', function() {
        var added = [];
        var x = moveToDoneCapturingLogs({
            jira_move_to_status: function() { throw new Error("The field 'State' contains the value 'Done' that is not in the list of supported values"); },
            jira_remove_label: function() {},
            jira_post_comment: function() {},
            jira_add_label: function(args) { added.push(args); }
        });

        var result = x.module.action({
            ticket: { key: 'TS-503' },
            customParams: { stageFallback: 'label' }
        });

        assert.equal(result.success, true, 'label fallback must not fail the action');
        assert.deepEqual(added, [{ key: 'TS-503', label: 'stage_done' }]);
    });

    test('jobParams.customParams wins over top-level customParams', function() {
        var added = [];
        var x = moveToDoneCapturingLogs({
            jira_move_to_status: function() { throw new Error("The field 'State' contains the value 'Done' that is not in the list of supported values"); },
            jira_remove_label: function() {},
            jira_post_comment: function() {},
            jira_add_label: function(args) { added.push(args); }
        });

        var result = x.module.action({
            ticket: { key: 'TS-504' },
            customParams: { stageFallback: 'none' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true, 'label fallback must not fail the action');
        assert.deepEqual(added, [{ key: 'TS-504', label: 'stage_done' }], 'jobParams stageFallback=label wins over top-level none');
    });
});
