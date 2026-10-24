/**
 * Unit tests for js/finishTestCasesGeneration.js
 */

// Real tracker layer loaded WITH the same tool mocks as the script under test
// (loadModule mocks only shadow globals inside the module they are passed to).
function trackersWith(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

function loadFinishTestCasesGeneration(mocks) {
    mocks = mocks || {};
    return (function (_m) { return loadModule('js/finishTestCasesGeneration.js', makeRequire(Object.assign({}, {
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }, { './common/trackers.js': trackersWith(_m) })), _m); })(mocks);
}

suite('finishTestCasesGeneration', function() {

    test('moves Story to Ready For Testing and removes generator label', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadFinishTestCasesGeneration({
            jira_move_to_status: function(args) { moved.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-200' }
        });

        assert.equal(result.success, true);
        assert.deepEqual(moved, [{ key: 'TS-200', statusName: 'Ready For Testing' }]);
        assert.deepEqual(removedLabels, [{ key: 'TS-200', label: 'sm_test_cases_triggered' }]);
    });

});


suite('finishTestCasesGeneration: ado tracker provider', function() {
    test('moves and unlabels through ado_* tools, no jira_* call', function() {
        var calls = [];
        var module = loadFinishTestCasesGeneration({
            ado_move_to_state: function(a) { calls.push(['move', a]); },
            ado_remove_work_item_label: function(a) { calls.push(['rm', a]); },
            jira_move_to_status: function() { throw new Error('jira_move_to_status must not be called on ado'); },
            jira_remove_label: function() { throw new Error('jira_remove_label must not be called on ado'); }
        });
        var result = module.action({
            ticket: { key: '200' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(result.success, true);
        assert.deepEqual(calls[0], ['move', { id: '200', state: 'Ready For Testing' }]);
        assert.deepEqual(calls[1], ['rm', { id: '200', label: 'sm_test_cases_triggered' }]);
    });
});

suite('finishTestCasesGeneration: stage-label fallback (gh-916)', function() {
    function finishGh916WithLogs(mocks) {
        var logs = [];
        var warns = [];
        var join = function() { return Array.prototype.slice.call(arguments).map(String).join(' '); };
        var withConsole = Object.assign({
            console: {
                log: function() { logs.push(join.apply(null, arguments)); },
                warn: function() { warns.push(join.apply(null, arguments)); }
            }
        }, mocks);
        return { module: loadFinishTestCasesGeneration(withConsole), logs: logs, warns: warns };
    }

    test("'label' mode: a rejected READY_FOR_TESTING move marks stage_ready_for_testing, no throw, success log", function() {
        var added = [];
        var x = finishGh916WithLogs({
            jira_move_to_status: function() { throw new Error("The field 'State' contains the value 'Ready For Testing' that is not in the list of supported values"); },
            jira_add_label: function(args) { added.push(args); },
            jira_remove_label: function() {}
        });

        var result = x.module.action({
            ticket: { key: 'TS-210' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true, 'label fallback must not fail the action');
        assert.deepEqual(added, [{ key: 'TS-210', label: 'stage_ready_for_testing' }]);
        assert.ok(x.logs.some(function(l) { return l.indexOf('✅ Moved TS-210 to Ready For Testing') !== -1; }), 'success log printed for the marked stage');
    });

    test("'label' mode: when neither the move nor the marker works, no ✅ success log and the reason is warned", function() {
        var x = finishGh916WithLogs({
            jira_move_to_status: function() { throw new Error('state rejected'); },
            jira_add_label: function() { throw new Error('label api down'); },
            jira_remove_label: function() {}
        });

        var result = x.module.action({
            ticket: { key: 'TS-211' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true, 'the generator finishing itself is independent of the move');
        assert.ok(!x.logs.some(function(l) { return l.indexOf('✅ Moved') !== -1; }), '✅ must not print when nothing worked');
        assert.ok(x.warns.some(function(l) { return l.indexOf('Could not move Story to Ready For Testing') !== -1; }));
    });

    // ── gh-1229 characterization: seams pinned before helper extraction ──

    test('missing ticket key: structured failure and no tracker interactions', function() {
        var x = finishGh916WithLogs({
            jira_move_to_status: function() { throw new Error('must not be called'); },
            jira_remove_label: function() { throw new Error('must not be called'); }
        });

        var result = x.module.action({});

        assert.deepEqual(result, { success: false, error: 'No ticket key found in params' });
        assert.ok(x.warns.every(function(l) { return l.indexOf('token usage') === -1; }));
    });

    test('a failing removeLabel only warns and the action still succeeds', function() {
        var moved = [];
        var x = finishGh916WithLogs({
            jira_move_to_status: function(args) { moved.push(args); },
            jira_remove_label: function() { throw new Error('label api down'); }
        });

        var result = x.module.action({ ticket: { key: 'TS-212' } });

        assert.equal(result.success, true);
        assert.deepEqual(moved, [{ key: 'TS-212', statusName: 'Ready For Testing' }]);
        assert.ok(x.warns.some(function(l) { return l.indexOf('Could not remove sm_test_cases_triggered label') !== -1; }));
    });

    test('customParamsOf keeps the jobParams-then-top-level precedence', function() {
        var m = loadFinishTestCasesGeneration({});
        assert.deepEqual(m.customParamsOf({ jobParams: { customParams: { a: 1 } } }), { a: 1 });
        assert.deepEqual(m.customParamsOf({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(m.customParamsOf({}), {});
    });
});
