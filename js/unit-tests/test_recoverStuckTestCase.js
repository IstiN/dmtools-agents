/**
 * Unit tests for js/recoverStuckTestCase.js.
 */

function loadRecoverStuckTestCase(options) {
    options = options || {};
    var scm = options.scm || {
        listPrs: function() { return []; }
    };
    var statusMoves = [];
    var removedLabels = [];
    var comments = [];

    var mod = loadModule(
        'js/recoverStuckTestCase.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': {
                loadProjectConfig: function() {
                    return { repository: { owner: 'IstiN', repo: 'trackstate' } };
                }
            },
            './common/scm.js': { createScm: function() { return scm; } }
        }),
        {
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        }
    );

    return {
        mod: mod,
        statusMoves: statusMoves,
        removedLabels: removedLabels,
        comments: comments
    };
}

suite('recoverStuckTestCase', function() {

    test('moves stuck TC back to Backlog when no open PR exists', function() {
        var loaded = loadRecoverStuckTestCase();

        var result = loaded.mod.action({ ticket: { key: 'TS-1290' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(loaded.statusMoves, [
            { key: 'TS-1290', statusName: 'Backlog' }
        ]);
        assert.deepEqual(loaded.removedLabels, [
            { key: 'TS-1290', label: 'sm_test_automation_triggered' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Moved back to Backlog');
    });

    test('moves stuck TC to review when matching PR is clean', function() {
        var loaded = loadRecoverStuckTestCase({
            scm: {
                listPrs: function(state) {
                    assert.equal(state, 'open');
                    return [{
                        number: 1559,
                        title: 'TS-409 test automation',
                        head: { ref: 'test/TS-409' }
                    }];
                },
                getPr: function(number) {
                    assert.equal(number, 1559);
                    return { number: 1559, mergeable: true, mergeable_state: 'clean' };
                }
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'TS-409' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_review');
        assert.deepEqual(loaded.statusMoves, [
            { key: 'TS-409', statusName: 'In Review - Passed' }
        ]);
        assert.deepEqual(loaded.removedLabels, [
            { key: 'TS-409', label: 'sm_test_automation_triggered' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Moved to In Review - Passed');
    });

    test('moves stuck TC to rework when matching PR is conflicting', function() {
        var loaded = loadRecoverStuckTestCase({
            scm: {
                listPrs: function() {
                    return [{
                        number: 1433,
                        title: 'TS-409 test automation',
                        head: { ref: 'test/TS-409' }
                    }];
                },
                getPr: function() {
                    return { number: 1433, mergeable: false, mergeable_state: 'dirty' };
                }
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'TS-409' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_rework');
        assert.deepEqual(loaded.statusMoves, [
            { key: 'TS-409', statusName: 'In Rework' }
        ]);
        assert.deepEqual(loaded.removedLabels, [
            { key: 'TS-409', label: 'sm_test_rework_triggered' },
            { key: 'TS-409', label: 'sm_test_automation_triggered' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Moved to In Rework');
    });

});
