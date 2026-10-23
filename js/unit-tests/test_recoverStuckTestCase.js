/**
 * Unit tests for js/recoverStuckTestCase.js.
 */

function loadTrackersRs(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

function loadRecoverStuckTestCase(options) {
    options = options || {};
    var scm = options.scm || {
        listPrs: function() { return []; }
    };
    var statusMoves = [];
    var removedLabels = [];
    var comments = [];

    var jiraMocks = {
        jira_move_to_status: function(args) { statusMoves.push(args); },
        jira_remove_label: function(args) { removedLabels.push(args); },
        jira_post_comment: function(args) { comments.push(args); }
    };
    var mod = loadModule(
        'js/recoverStuckTestCase.js',
        makeRequire({
            './common/trackers.js': loadTrackersRs(options.mocks || jiraMocks),
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock({
                repository: { owner: 'IstiN', repo: 'trackstate' }
            }),
            './common/scm.js': { createScm: function() { return scm; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        options.mocks || jiraMocks
    );

    return {
        mod: mod,
        statusMoves: statusMoves,
        removedLabels: removedLabels,
        comments: comments
    };
}

suite('recoverStuckTestCase', function() {

    test('ado provider: moves stuck TC back to Backlog via ado_* tools, no jira_* (wave1c)', function() {
        var tools = [];
        var mocks = {};
        ['jira_move_to_status', 'jira_remove_label', 'jira_post_comment', 'ado_move_to_state',
         'ado_remove_work_item_label', 'ado_add_work_item_comment'].forEach(function(n) {
            mocks[n] = function() { tools.push(n); };
        });
        var loaded = loadRecoverStuckTestCase({ mocks: mocks });
        var result = loaded.mod.action({ ticket: { key: '1290' }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(tools, ['ado_move_to_state', 'ado_remove_work_item_label', 'ado_add_work_item_comment']);
    });

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

// ── gh-916: stage-label fallback — In Review - Passed is markable; Backlog/In Rework stay direct ──

suite('recoverStuckTestCase: stage-label fallback (gh-916)', function() {
    test("'label' mode: a rejected In Review - Passed move marks stage_in_review_passed, no throw", function() {
        var added = [];
        var moves = [];
        var x = loadRecoverStuckTestCase({
            scm: {
                listPrs: function() {
                    return [{ number: 44, title: 'TS-44 tests', html_url: 'u', head: { ref: 'test/TS-44' } }];
                },
                getPr: function() { return { mergeable: true, mergeable_state: 'clean' }; }
            },
            mocks: {
                jira_move_to_status: function(args) {
                    moves.push(args);
                    throw new Error("The field 'State' contains the value 'In Review - Passed' that is not in the list of supported values");
                },
                jira_add_label: function(args) { added.push(args); },
                jira_remove_label: function() {},
                jira_post_comment: function() {}
            }
        });

        var result = x.mod.action({
            ticket: { key: 'TS-44' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.action, 'moved_to_review');
        assert.deepEqual(moves, [{ key: 'TS-44', statusName: 'In Review - Passed' }]);
        assert.deepEqual(added, [{ key: 'TS-44', label: 'stage_in_review_passed' }]);
    });

    test("'label' mode: the Backlog move stays a direct transition (no stage marker)", function() {
        var added = [];
        var moves = [];
        var x = loadRecoverStuckTestCase({
            mocks: {
                jira_move_to_status: function(args) { moves.push(args); },
                jira_add_label: function(args) { added.push(args); },
                jira_remove_label: function() {},
                jira_post_comment: function() {}
            }
        });

        var result = x.mod.action({
            ticket: { key: 'TS-45' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(moves, [{ key: 'TS-45', statusName: 'Backlog' }]);
        assert.deepEqual(added, [], 'Backlog is not a tag-only stage — no marker');
    });
});

// ── gh-1186: CRAP-reduction — extracted recovery helpers (characterization) ──

suite('recoverStuckTestCase: recovery helpers (gh-1186)', function() {

    test('isConflictingPrState: dirty/conflicting/mergeable-false conflict; clean does not', function() {
        var m = loadRecoverStuckTestCase().mod;
        assert.equal(m.isConflictingPrState(false, 'dirty'), true);
        assert.equal(m.isConflictingPrState(true, 'dirty'), true, 'dirty state conflicts regardless of the mergeable flag');
        assert.equal(m.isConflictingPrState(true, 'conflicting'), true);
        assert.equal(m.isConflictingPrState(null, 'conflicting'), true);
        assert.equal(m.isConflictingPrState(false, 'clean'), true);
        assert.equal(m.isConflictingPrState(true, 'clean'), false);
        assert.equal(m.isConflictingPrState(undefined, ''), false);
    });

    test('mergeableStateOf: snake_case first, camelCase fallback, empty-string default', function() {
        var m = loadRecoverStuckTestCase().mod;
        assert.equal(m.mergeableStateOf({ mergeable_state: 'clean' }), 'clean');
        assert.equal(m.mergeableStateOf({ mergeableState: 'dirty' }), 'dirty');
        assert.equal(m.mergeableStateOf({ mergeable_state: '', mergeableState: 'blocked' }), 'blocked');
        assert.deepEqual(m.mergeableStateOf({}), '');
        assert.equal(m.mergeableStateOf(null), null);
    });

    test('fetchPrDetailSafe: falls back to the open PR when details cannot be fetched', function() {
        var m = loadRecoverStuckTestCase().mod;
        var pr = { number: 7, title: 'x' };
        assert.deepEqual(m.fetchPrDetailSafe({ getPr: function() { return { mergeable: true }; } }, pr), { mergeable: true });
        assert.equal(m.fetchPrDetailSafe({ getPr: function() { throw new Error('boom'); } }, pr), pr);
    });

    test('action: missing ticket key → success:false with error', function() {
        var loaded = loadRecoverStuckTestCase();
        var result = loaded.mod.action({ ticket: {}, jobParams: {} });
        assert.deepEqual(result, { success: false, error: 'missing ticket key' });
    });

    test('action: unfetchable PR details fall back to the open PR (clean path)', function() {
        var loaded = loadRecoverStuckTestCase({
            scm: {
                listPrs: function() {
                    return [{ number: 9, title: 'TS-9 t', head: { ref: 'test/TS-9' } }];
                },
                getPr: function() { throw new Error('details unavailable'); }
            }
        });
        var result = loaded.mod.action({ ticket: { key: 'TS-9' }, jobParams: {} });
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_review');
        assert.equal(result.prNumber, 9);
    });

    test('action: failed Backlog transition still removes the label and comments', function() {
        var removedLabels = [];
        var comments = [];
        var loaded = loadRecoverStuckTestCase({
            mocks: {
                jira_move_to_status: function() { throw new Error('state machine says no'); },
                jira_remove_label: function(args) { removedLabels.push(args); },
                jira_post_comment: function(args) { comments.push(args.comment); }
            }
        });
        var result = loaded.mod.action({ ticket: { key: 'TS-46' }, jobParams: {} });
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(removedLabels, [{ key: 'TS-46', label: 'sm_test_automation_triggered' }]);
        assert.contains(comments[0], 'Moved back to Backlog');
    });

    test('action: failed In Rework transition still removes the stale labels and comments', function() {
        var removedLabels = [];
        var comments = [];
        var loaded = loadRecoverStuckTestCase({
            scm: {
                listPrs: function() {
                    return [{ number: 10, title: 'TS-47 t', head: { ref: 'test/TS-47' } }];
                },
                getPr: function() { return { mergeable: false, mergeable_state: 'dirty' }; }
            },
            mocks: {
                jira_move_to_status: function() { throw new Error('no transition'); },
                jira_remove_label: function(args) { removedLabels.push(args); },
                jira_post_comment: function(args) { comments.push(args.comment); }
            }
        });
        var result = loaded.mod.action({ ticket: { key: 'TS-47' }, jobParams: {} });
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_rework');
        assert.deepEqual(removedLabels, [
            { key: 'TS-47', label: 'sm_test_rework_triggered' },
            { key: 'TS-47', label: 'sm_test_automation_triggered' }
        ]);
        assert.contains(comments[0], 'Moved to In Rework');
    });

    test("action: 'conflicting' mergeable_state alone moves to rework", function() {
        var loaded = loadRecoverStuckTestCase({
            scm: {
                listPrs: function() {
                    return [{ number: 11, title: 'TS-48 t', head: { ref: 'test/TS-48' } }];
                },
                getPr: function() { return { mergeable: true, mergeable_state: 'conflicting' }; }
            }
        });
        var result = loaded.mod.action({ ticket: { key: 'TS-48' }, jobParams: {} });
        assert.equal(result.action, 'moved_to_rework');
    });
});
