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
