/**
 * Unit tests for js/moveToInTesting.js
 *
 * gh-916: IN_TESTING can be a tag-only status (ADO Test Case only has Design/Ready/Closed) —
 * 'label' mode marks the stage instead of failing; 'none' mode keeps the exact old move.
 */

function loadMoveToInTesting(mocks) {
    mocks = mocks || {};
    return (function (_m) { return loadModule('js/moveToInTesting.js', makeRequire(Object.assign({}, {
        './config.js': configModule,
        './configLoader.js': makeDefaultConfigLoaderMock(),
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
    }, { './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), _m) })), _m); })(mocks);
}

function moveToInTestingCapturingLogs(mocks) {
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
        module: loadMoveToInTesting(withConsole),
        logs: logs,
        warns: warns
    };
}

suite('moveToInTesting', function() {

    test("'none' mode: the exact old jira_move_to_status call and success message", function() {
        var moved = [];
        var x = moveToInTestingCapturingLogs({
            jira_move_to_status: function(args) { moved.push(args); },
            jira_remove_label: function() {}
        });

        var result = x.module.action({ ticket: { key: 'TS-300' } });

        assert.equal(result.success, true);
        assert.deepEqual(moved, [{ key: 'TS-300', statusName: 'In Testing' }]);
        assert.ok(x.logs.some(function(l) { return l.indexOf('✅ TS-300 moved to In Testing') !== -1; }));
    });

    test("'label' mode: a rejected transition adds stage_in_testing, does not throw, still removes the SM label", function() {
        var added = [];
        var removed = [];
        var x = moveToInTestingCapturingLogs({
            jira_move_to_status: function() { throw new Error("The field 'State' contains the value 'In Testing' that is not in the list of supported values"); },
            jira_add_label: function(args) { added.push(args); },
            jira_remove_label: function(args) { removed.push(args); }
        });

        var result = x.module.action({
            ticket: { key: 'TS-301' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true, 'label fallback must not fail the action');
        assert.deepEqual(added, [{ key: 'TS-301', label: 'stage_in_testing' }]);
        assert.deepEqual(removed, [{ key: 'TS-301', label: 'sm_test_cases_triggered' }]);
        assert.ok(x.logs.some(function(l) { return l.indexOf('✅ TS-301 moved to In Testing') !== -1; }), 'success log printed for the marked stage');
    });

    test("'label' mode: when neither the move nor the marker works, the action fails loudly", function() {
        var x = moveToInTestingCapturingLogs({
            jira_move_to_status: function() { throw new Error('state rejected'); },
            jira_add_label: function() { throw new Error('label api down'); }
        });

        var result = x.module.action({
            ticket: { key: 'TS-302' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, false);
        var all = x.logs.concat(x.warns);
        assert.ok(all.some(function(l) { return l.indexOf('❌ Error in moveToInTesting') !== -1; }));
    });

    // ── gh-1229 characterization: seams pinned before helper extraction ──

    test('missing ticket key: structured failure, no tracker creation and no status move', function() {
        var x = moveToInTestingCapturingLogs({
            jira_move_to_status: function() { throw new Error('must not be called'); }
        });

        var result = x.module.action({});

        assert.deepEqual(result, { success: false, error: 'No ticket key found in params' });
        assert.ok(x.logs.concat(x.warns).every(function(l) { return l.indexOf('In Testing') === -1; }));
    });

    test('top-level params.customParams is honored when jobParams carries none', function() {
        var added = [];
        var x = moveToInTestingCapturingLogs({
            jira_move_to_status: function() { throw new Error("The field 'State' contains the value 'In Testing' that is not in the list of supported values"); },
            jira_add_label: function(args) { added.push(args); }
        });

        var result = x.module.action({
            ticket: { key: 'TS-303' },
            customParams: { stageFallback: 'label' }
        });

        assert.equal(result.success, true);
        assert.deepEqual(added, [{ key: 'TS-303', label: 'stage_in_testing' }]);
    });

    test('helper exports keep the param-resolution contract', function() {
        var m = loadMoveToInTesting({});
        assert.equal(m.ticketKeyOf({ ticket: { key: 'TS-1' } }), 'TS-1');
        assert.equal(m.ticketKeyOf({}), null);
        assert.deepEqual(m.customParamsOf({ jobParams: { customParams: { a: 1 } } }), { a: 1 });
        assert.deepEqual(m.customParamsOf({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(m.customParamsOf({}), {});
    });
});
