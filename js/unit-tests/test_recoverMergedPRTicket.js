/**
 * Unit tests for js/recoverMergedPRTicket.js.
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

function loadRecoverMergedPRTicket(options) {
    options = options || {};
    var scm = options.scm || {
        listPrs: function() { return []; }
    };
    var statusMoves = [];
    var removedLabels = [];
    var comments = [];

    var mod = (function (_m) { return loadModule('js/recoverMergedPRTicket.js', makeRequire(Object.assign({}, {
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock({
                repository: { owner: 'IstiN', repo: 'trackstate' }
            }),
            './common/scm.js': { createScm: function() { return scm; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }, { './common/trackers.js': trackersWith(_m) })), _m); })({
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        });

    return {
        mod: mod,
        statusMoves: statusMoves,
        removedLabels: removedLabels,
        comments: comments
    };
}

suite('recoverMergedPRTicket', function() {

    test('moves ticket to Merged when a matching closed PR is already merged', function() {
        var loaded = loadRecoverMergedPRTicket({
            scm: {
                listPrs: function(state) {
                    if (state === 'open') return [];
                    assert.equal(state, 'closed');
                    return [{
                        number: 1512,
                        title: 'TS-1268 accessibility fix',
                        html_url: 'https://github.com/IstiN/trackstate/pull/1512',
                        head: { ref: 'ai/TS-1268' },
                        merged_at: '2026-05-30T18:28:34Z'
                    }];
                }
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'TS-1268' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_merged');
        assert.deepEqual(loaded.statusMoves, [
            { key: 'TS-1268', statusName: 'Merged' }
        ]);
        assert.deepEqual(loaded.removedLabels, [
            { key: 'TS-1268', label: 'pr_approved' },
            { key: 'TS-1268', label: 'sm_pr_merge_triggered' },
            { key: 'TS-1268', label: 'sm_story_review_triggered' },
            { key: 'TS-1268', label: 'sm_story_rework_triggered' }
        ]);
        assert.contains(loaded.comments[0].comment, 'Merged PR Recovered');
    });

    test('does nothing when a matching open PR still exists', function() {
        var loaded = loadRecoverMergedPRTicket({
            scm: {
                listPrs: function(state) {
                    if (state === 'open') {
                        return [{
                            number: 1571,
                            title: 'TS-1293 Busy-startup retry does not restore active local workspace as Local Git',
                            head: { ref: 'ai/TS-1293' }
                        }];
                    }
                    if (state === 'closed') {
                        throw new Error('closed PRs should not be inspected while a matching open PR exists');
                    }
                    return [];
                }
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'TS-1293' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(result.action, 'none');
        assert.deepEqual(loaded.statusMoves, []);
        assert.deepEqual(loaded.removedLabels, []);
        assert.deepEqual(loaded.comments, []);
    });

    test('does not match unrelated merged PR that only mentions ticket in body', function() {
        var loaded = loadRecoverMergedPRTicket({
            scm: {
                listPrs: function(state) {
                    if (state === 'open') return [];
                    if (state === 'closed') {
                        return [{
                            number: 1623,
                            title: 'Fail AI teammate when JS action reports failure',
                            body: 'TS-1293 pr_rework posted a push failure comment.',
                            head: { ref: 'fix/fail-ai-teammate-on-js-false' },
                            merged_at: '2026-06-01T07:48:14Z'
                        }];
                    }
                    return [];
                }
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'TS-1293' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(result.action, 'none');
        assert.deepEqual(loaded.statusMoves, []);
        assert.deepEqual(loaded.removedLabels, []);
        assert.deepEqual(loaded.comments, []);
    });

    test('does nothing when matching PR is closed but not merged', function() {
        var loaded = loadRecoverMergedPRTicket({
            scm: {
                listPrs: function(state) {
                    if (state === 'open') return [];
                    return [{
                        number: 9,
                        title: 'TS-1272 attempted fix',
                        head: { ref: 'ai/TS-1272' },
                        state: 'CLOSED'
                    }];
                }
            }
        });

        var result = loaded.mod.action({ ticket: { key: 'TS-1272' }, jobParams: {} });

        assert.equal(result.success, true);
        assert.equal(result.action, 'none');
        assert.deepEqual(loaded.statusMoves, []);
        assert.deepEqual(loaded.removedLabels, []);
    });

});


suite('recoverMergedPRTicket: ado tracker provider', function() {
    test('uses ado_* tools and no jira_* tool', function() {
        var calls = [];
        var mocks = {
            ado_move_to_state: function(a) { calls.push(['move', a]); },
            ado_remove_work_item_label: function(a) { calls.push(['rm', a]); },
            ado_add_work_item_comment: function(a) { calls.push(['comment', a]); },
            jira_move_to_status: function() { throw new Error('jira_move_to_status must not be called on ado'); },
            jira_remove_label: function() { throw new Error('jira_remove_label must not be called on ado'); },
            jira_post_comment: function() { throw new Error('jira_post_comment must not be called on ado'); }
        };
        var scm = { listPrs: function(state) {
            if (state === 'open') return [];
            return [{ number: 7, title: '55 fix', html_url: 'u', head: { ref: 'ai/55' }, merged_at: '2026-01-01T00:00:00Z' }];
        } };
        var mod = loadModule('js/recoverMergedPRTicket.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock({ repository: { owner: 'o', repo: 'r' } }),
            './common/scm.js': { createScm: function() { return scm; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': trackersWith(mocks)
        }), mocks);
        var result = mod.action({ ticket: { key: '55' }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(result.action, 'moved_to_merged');
        assert.deepEqual(calls[0], ['move', { id: '55', state: 'Merged' }]);
        assert.equal(calls.filter(function(c) { return c[0] === 'rm'; }).length, 4);
        assert.equal(calls.filter(function(c) { return c[0] === 'comment'; }).length, 1);
    });
});
