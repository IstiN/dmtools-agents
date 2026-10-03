/**
 * Unit tests for js/recoverFailedTCBugStatus.js.
 */

function loadRecoverFailedTCBugStatus(mocks) {
    var calls = {
        searches: [],
        statusMoves: [],
        removedLabels: [],
        comments: []
    };

    var defaults = {
        jira_search_by_jql: function(args) {
            calls.searches.push(args);
            return [];
        },
        jira_move_to_status: function(args) { calls.statusMoves.push(args); },
        jira_remove_label: function(args) { calls.removedLabels.push(args); },
        jira_post_comment: function(args) { calls.comments.push(args); }
    };

    var mod = loadModule(
        'js/recoverFailedTCBugStatus.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        Object.assign({}, defaults, mocks || {})
    );

    return { mod: mod, calls: calls };
}

suite('recoverFailedTCBugStatus', function() {

    test('moves Failed TC with linked open Bug to Bug To Fix', function() {
        var loaded = loadRecoverFailedTCBugStatus({
            jira_search_by_jql: function(args) {
                loaded.calls.searches.push(args);
                if (args.jql.indexOf('status not in ("Done")') !== -1) {
                    return [{ key: 'TS-1289' }];
                }
                return [];
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'TS-222' } });

        assert.equal(result.action, 'moved_to_bug_to_fix');
        assert.deepEqual(loaded.calls.statusMoves, [
            { key: 'TS-222', statusName: 'Bug To Fix' }
        ]);
        assert.deepEqual(loaded.calls.removedLabels, [
            { key: 'TS-222', label: 'sm_bug_creation_triggered' },
            { key: 'TS-222', label: 'sm_bulk_bugs_creation_triggered' },
            { key: 'TS-222', label: 'sm_test_automation_triggered' }
        ]);
        assert.contains(loaded.calls.comments[0].comment, 'Moved to Bug To Fix');
    });

    test('releases Failed TC with only Done linked Bugs for bulk bug creation', function() {
        var loaded = loadRecoverFailedTCBugStatus({
            jira_search_by_jql: function(args) {
                loaded.calls.searches.push(args);
                if (args.jql.indexOf('status not in ("Done")') !== -1) {
                    return [];
                }
                return [];
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'TS-333' } });

        assert.equal(result.action, 'released_for_bulk_bug_creation');
        assert.deepEqual(loaded.calls.statusMoves, []);
        assert.deepEqual(loaded.calls.removedLabels, [
            { key: 'TS-333', label: 'sm_bug_creation_triggered' }
        ]);
    });

    test('releases Failed TC without linked Bugs for bulk bug creation', function() {
        var loaded = loadRecoverFailedTCBugStatus();

        var result = loaded.mod.action({ ticket: { key: 'TS-444' } });

        assert.equal(result.action, 'released_for_bulk_bug_creation');
        assert.deepEqual(loaded.calls.statusMoves, []);
        assert.deepEqual(loaded.calls.comments, []);
        assert.deepEqual(loaded.calls.removedLabels, [
            { key: 'TS-444', label: 'sm_bug_creation_triggered' }
        ]);
    });

});
