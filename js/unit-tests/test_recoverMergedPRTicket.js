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

// ── gh-916: stage-label fallback for the Merged recovery move ──

suite('recoverMergedPRTicket: stage-label fallback (gh-916)', function() {
    function gh916RecoverMergedLoad(mocks, scm) {
        var added = [];
        var moves = [];
        var withMoves = Object.assign({
            jira_move_to_status: function(args) {
                moves.push(args);
                throw new Error("The field 'State' contains the value 'Merged' that is not in the list of supported values");
            },
            jira_add_label: function(args) { added.push(args); },
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        }, mocks);
        var mod = loadModule('js/recoverMergedPRTicket.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock({ repository: { owner: 'IstiN', repo: 'trackstate' } }),
            './common/scm.js': { createScm: function() { return scm; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': trackersWith(withMoves)
        }), withMoves);
        return { mod: mod, added: added, moves: moves };
    }

    test("'label' mode: a rejected Merged move marks stage_merged, no throw, recovery still completes", function() {
        var x = gh916RecoverMergedLoad({}, {
            listPrs: function(state) {
                if (state === 'open') return [];
                return [{
                    number: 1600,
                    title: 'TS-700 fix',
                    html_url: 'https://github.com/IstiN/trackstate/pull/1600',
                    head: { ref: 'ai/TS-700' },
                    merged_at: '2026-06-21T14:00:00Z'
                }];
            }
        });

        var result = x.mod.action({
            ticket: { key: 'TS-700' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.action, 'moved_to_merged');
        assert.deepEqual(x.moves, [{ key: 'TS-700', statusName: 'Merged' }]);
        assert.deepEqual(x.added, [{ key: 'TS-700', label: 'stage_merged' }]);
    });
});

// ─── gh-119 CRAP: uncovered branches + extracted pure helpers ────────────────

suite('recoverMergedPRTicket — uncovered action branches (gh-119 characterization)', function() {

    test('missing ticket key: fails with missing_ticket, tracker untouched', function() {
        var loaded = loadRecoverMergedPRTicket({});
        var result = loaded.mod.action({ jobParams: {} });
        assert.equal(result.success, false);
        assert.equal(result.action, 'missing_ticket');
        assert.deepEqual(loaded.statusMoves, []);
        assert.deepEqual(loaded.comments, []);
    });

    test('no merged PR found: success none, nothing written', function() {
        var loaded = loadRecoverMergedPRTicket({ scm: { listPrs: function() { return []; } } });
        var result = loaded.mod.action({ ticket: { key: 'TS-1' }, jobParams: {} });
        assert.equal(result.success, true);
        assert.equal(result.action, 'none');
        assert.deepEqual(loaded.statusMoves, []);
        assert.deepEqual(loaded.removedLabels, []);
        assert.deepEqual(loaded.comments, []);
    });

    test('PR identified by id/url fallbacks: comment carries #<id> and the url', function() {
        var loaded = loadRecoverMergedPRTicket({
            scm: {
                listPrs: function(state) {
                    if (state === 'open') return [];
                    return [{
                        id: 9001,
                        title: 'TS-77 fix',
                        url: 'https://example.com/pr/9001',
                        head: { ref: 'ai/TS-77' },
                        merged: true
                    }];
                }
            }
        });
        var result = loaded.mod.action({ ticket: { key: 'TS-77' }, jobParams: {} });
        assert.equal(result.success, true);
        assert.equal(result.prNumber, 9001);
        assert.contains(loaded.comments[0].comment, '#9001');
        assert.contains(loaded.comments[0].comment, 'https://example.com/pr/9001');
    });

    test('tracker move hard-fails: recovery still removes labels and comments (non-fatal)', function() {
        var removed = [];
        var posted = [];
        var mod = loadModule('js/recoverMergedPRTicket.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock({ repository: { owner: 'IstiN', repo: 'trackstate' } }),
            './common/scm.js': {
                createScm: function() {
                    return { listPrs: function(state) {
                        if (state === 'open') return [];
                        return [{ number: 5, title: 'TS-5 x', html_url: 'u', head: { ref: 'ai/TS-5' }, merged: true }];
                    } };
                }
            },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': {
                createTracker: function() {
                    return {
                        moveToStatusOrMark: function() { throw new Error('tracker down'); },
                        removeLabel: function(key, label) { removed.push(label); },
                        postComment: function(key, text) { posted.push(text); }
                    };
                }
            }
        }));
        var result = mod.action({ ticket: { key: 'TS-5' }, jobParams: {} });
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_merged');
        assert.deepEqual(removed, ['pr_approved', 'sm_pr_merge_triggered', 'sm_story_review_triggered', 'sm_story_rework_triggered']);
        assert.equal(posted.length, 1);
    });

    test('token usage comments fire with initiator + customParams (non-fatal on error)', function() {
        var calls = [];
        var scm = { listPrs: function(state) {
            if (state === 'open') return [];
            return [{ number: 6, title: 'TS-6 x', head: { ref: 'ai/TS-6' }, merged_at: 'z' }];
        } };
        var mod = loadModule('js/recoverMergedPRTicket.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock({ repository: { owner: 'IstiN', repo: 'trackstate' } }),
            './common/scm.js': { createScm: function() { return scm; } },
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function(key, opts) { calls.push({ key: key, opts: opts }); },
                customParamsOf: function(params) { return params.customParams || {}; }
            },
            './common/trackers.js': trackersWith({
                jira_move_to_status: function() {},
                jira_remove_label: function() {},
                jira_post_comment: function() {}
            })
        }));
        var result = mod.action({ ticket: { key: 'TS-6' }, initiator: 'user-1', customParams: { a: 1 }, jobParams: {} });
        assert.equal(result.success, true);
        assert.deepEqual(calls, [{ key: 'TS-6', opts: { initiator: 'user-1', customParams: { a: 1 } } }]);
    });
});

suite('recoverMergedPRTicket — pure helpers (gh-119)', function() {
    var guard = loadRecoverMergedPRTicket({}).mod;

    test('prIdentity: number/id and html_url/url fallback chains', function() {
        assert.deepEqual(guard.prIdentity({ number: 7, html_url: 'a' }), { number: 7, url: 'a' });
        assert.deepEqual(guard.prIdentity({ id: 8, url: 'b' }), { number: 8, url: 'b' });
        assert.deepEqual(guard.prIdentity({}), { number: '?', url: '' });
        assert.deepEqual(guard.prIdentity({ number: 0, id: 9 }), { number: 9, url: '' });
    });

    test('recoveryCustomParams: jobParams bag wins, params bag next, {} last', function() {
        assert.deepEqual(guard.recoveryCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(guard.recoveryCustomParams({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(guard.recoveryCustomParams({}), {});
        assert.deepEqual(guard.recoveryCustomParams({ jobParams: {} }), {});
    });
});

// ── gh-1229 characterization: findMergedPRForTicket contract pinned before
//    helper extraction (direct calls, no tracker needed). ──
suite('recoverMergedPRTicket — findMergedPRForTicket contract (gh-1229)', function() {
    var guard = loadRecoverMergedPRTicket({}).mod;

    test('returns the first closed+merged PR matching title or branch', function() {
        var prA = { number: 1, title: 'TS-1 one', head: { ref: 'ai/x' }, merged_at: 't1' };
        var prB = { number: 2, title: 'unrelated', head: { ref: 'ai/TS-1-b' }, merged_at: 't2' };
        assert.deepEqual(guard.findMergedPRForTicket({
            listPrs: function(state) { return state === 'open' ? [] : [prA, prB]; }
        }, 'TS-1'), prA);
    });

    test('a matching open PR wins the guard: null and no closed scan', function() {
        var closedScanned = false;
        var result = guard.findMergedPRForTicket({
            listPrs: function(state) {
                if (state === 'open') return [{ number: 9, title: 'TS-9 open', head: { ref: 'ai/TS-9' } }];
                closedScanned = true;
                return [];
            }
        }, 'TS-9');
        assert.equal(result, null);
        assert.equal(closedScanned, false, 'closed list must not be scanned when an open PR matches');
    });

    test('an open-PR listing failure aborts the recovery lookup with null', function() {
        var result = guard.findMergedPRForTicket({
            listPrs: function(state) {
                if (state === 'open') throw new Error('open api down');
                throw new Error('closed must not be reached');
            }
        }, 'TS-1');
        assert.equal(result, null);
    });

    test('a closed-PR listing failure returns null instead of a partial match', function() {
        var result = guard.findMergedPRForTicket({
            listPrs: function(state) {
                if (state === 'open') return [];
                throw new Error('closed api down');
            }
        }, 'TS-1');
        assert.equal(result, null);
    });

    test('closed PRs that match but are not merged are skipped', function() {
        var merged = guard.findMergedPRForTicket({
            listPrs: function(state) {
                if (state === 'open') return [];
                return [
                    { number: 3, title: 'TS-1 stale', head: { ref: 'ai/TS-1' }, merged_at: null },
                    { number: 4, title: 'TS-1 merged', head: { ref: 'ai/TS-1' }, state: 'MERGED' }
                ];
            }
        }, 'TS-1');
        assert.equal(merged.number, 4);
        assert.equal(guard.findMergedPRForTicket({
            listPrs: function(state) {
                if (state === 'open') return [];
                return [{ number: 3, title: 'TS-1 stale', head: { ref: 'ai/TS-1' }, merged_at: null }];
            }
        }, 'TS-1'), null);
    });
});
