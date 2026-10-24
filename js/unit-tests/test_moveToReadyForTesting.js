/**
 * Unit tests for js/moveToReadyForTesting.js
 *
 * gh-916: READY_FOR_TESTING can be a tag-only status (restricted ADO workflows) —
 * 'label' mode marks the stage instead of failing; 'none' mode keeps the exact old move.
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

function loadMoveToReadyForTesting(mocks) {
    mocks = mocks || {};
    return (function (_m) { return loadModule('js/moveToReadyForTesting.js', makeRequire(Object.assign({}, {
        './config.js': configModule,
        './configLoader.js': makeDefaultConfigLoaderMock(),
        './common/actionTicketContext.js': loadActionTicketContext(_m)
    }, { './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), _m) })), _m); })(mocks);
}

function moveToReadyForTestingCapturingLogs(mocks) {
    var logs = [];
    var withConsole = Object.assign({
        console: {
            log: function(msg) { logs.push(String(msg)); },
            warn: function(msg) { logs.push('WARN: ' + String(msg)); },
            error: function(msg) { logs.push('WARN: ' + String(msg)); }
        }
    }, mocks || {});
    return {
        module: loadMoveToReadyForTesting(withConsole),
        logs: logs
    };
}

suite('moveToReadyForTesting', function() {

    test("'none' mode: the exact old jira_move_to_status call and success message", function() {
        var moved = [];
        var x = moveToReadyForTestingCapturingLogs({
            jira_move_to_status: function(args) { moved.push(args); }
        });

        var result = x.module.action({ ticket: { key: 'TS-400' } });

        assert.equal(result.success, true);
        assert.deepEqual(moved, [{ key: 'TS-400', statusName: 'Ready For Testing' }]);
        assert.ok(x.logs.some(function(l) { return l.indexOf('✅ TS-400 moved to Ready For Testing') !== -1; }));
    });

    test("'label' mode: a rejected transition adds stage_ready_for_testing and does not throw", function() {
        var added = [];
        var x = moveToReadyForTestingCapturingLogs({
            jira_move_to_status: function() { throw new Error("The field 'State' contains the value 'Ready For Testing' that is not in the list of supported values"); },
            jira_add_label: function(args) { added.push(args); }
        });

        var result = x.module.action({
            ticket: { key: 'TS-401' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true, 'label fallback must not fail the action');
        assert.deepEqual(added, [{ key: 'TS-401', label: 'stage_ready_for_testing' }]);
        assert.ok(x.logs.some(function(l) { return l.indexOf('✅ TS-401 moved to Ready For Testing') !== -1; }), 'success log printed for the marked stage');
    });

    test("'label' mode: when neither the move nor the marker works, the action fails loudly", function() {
        var x = moveToReadyForTestingCapturingLogs({
            jira_move_to_status: function() { throw new Error('state rejected'); },
            jira_add_label: function() { throw new Error('label api down'); }
        });

        var result = x.module.action({
            ticket: { key: 'TS-402' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, false);
    });
});
