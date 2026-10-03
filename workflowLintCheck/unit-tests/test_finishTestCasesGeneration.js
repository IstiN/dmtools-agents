/**
 * Unit tests for js/finishTestCasesGeneration.js
 */

function loadFinishTestCasesGeneration(mocks) {
    mocks = mocks || {};
    return loadModule(
        'js/finishTestCasesGeneration.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        mocks
    );
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
