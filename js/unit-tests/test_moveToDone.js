/**
 * Unit tests for js/moveToDone.js (postJSAction for bug_test_cases_generator)
 *
 * gh-1242: every action() branch — missing ticket key, label-removal failure,
 * token-usage failure and the outer catch, alongside the happy path.
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

function loadMoveToDone(mocks, tokenUsage) {
    mocks = mocks || {};
    return (function (_m) { return loadModule('js/moveToDone.js', makeRequire(Object.assign({}, {
        './config.js': configModule,
        './configLoader.js': makeDefaultConfigLoaderMock(),
        './common/tokenUsageComment.js': tokenUsage || { postTokenUsageComments: function() {} },
        './common/actionTicketContext.js': loadActionTicketContext(_m)
    }, { './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), _m) })), _m); })(mocks);
}

function moveToDoneCapturingLogs(mocks, tokenUsage) {
    var logs = [];
    var withConsole = Object.assign({
        console: {
            log: function(msg) { logs.push(String(msg)); },
            warn: function(msg) { logs.push('WARN: ' + String(msg)); },
            error: function(msg) { logs.push('ERROR: ' + String(msg)); }
        }
    }, mocks || {});
    return {
        module: loadMoveToDone(withConsole, tokenUsage),
        logs: logs
    };
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

    test('happy path: token usage is reported with the initiator and the tracker (gh-1242)', function() {
        var usageCalls = [];
        var x = moveToDoneCtx({
            jira_move_to_status: function() {},
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        }, {
            postTokenUsageComments: function(key, opts) { usageCalls.push({ key: key, opts: opts }); }
        });

        var result = x.module.action({ ticket: { key: 'TS-100' }, initiator: 'sm' });

        assert.equal(result.success, true);
        assert.equal(usageCalls.length, 1, 'token usage reported once');
        assert.equal(usageCalls[0].key, 'TS-100');
        assert.equal(usageCalls[0].opts.initiator, 'sm');
        assert.ok(usageCalls[0].opts.tracker, 'the tracker instance is handed to the usage reporter');
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

    test('empty ticket key fails the same way as a missing one (gh-1242)', function() {
        var x = moveToDoneCapturingLogs({
            jira_move_to_status: function() { throw new Error('must not be called'); }
        });

        var result = x.module.action({ ticket: { key: '' } });

        assert.equal(result.success, false);
        assert.equal(result.error, 'No ticket key found in params');
    });

    test('a failing token-usage report is non-fatal — the action still succeeds (gh-1242)', function() {
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

    test('a rejected transition fails the action loudly', function() {
        var x = moveToDoneCapturingLogs({
            jira_move_to_status: function() { throw new Error('state rejected'); }
        });

        var result = x.module.action({ ticket: { key: 'TS-502' } });

        assert.equal(result.success, false);
        assert.ok(String(result.error).indexOf('state rejected') !== -1);
        assert.ok(x.logs.some(function(l) { return l.indexOf('❌ Error in moveToDone') !== -1; }));
    });

    test('a failing move lands in the outer catch → success:false (gh-1242)', function() {
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

    test('customParams nested under jobParams (real Teammate path) resolve the same way (gh-1242)', function() {
        var moved = [];
        var x = moveToDoneCapturingLogs({
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
