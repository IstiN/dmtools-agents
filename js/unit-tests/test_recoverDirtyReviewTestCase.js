/**
 * Unit tests for js/recoverDirtyReviewTestCase.js (gh-1077).
 *
 * The action() suites are characterization tests: they pin the observable
 * behavior (result shapes, tracker/SCM call order, cache file traffic) so the
 * pure-helper extraction cannot drift it. The helper suites cover the
 * extracted parse/build/decide helpers branch by branch.
 */

var CACHE_PATH = 'outputs/.recover_dirty_prs_cache.json';

function setupRecoverDirty(mocks) {
    mocks = mocks || {};
    var calls = [];

    function note(name, args) {
        calls.push({ name: name, args: args });
    }

    var scm = {
        listPrs: function(state) {
            note('listPrs', [state]);
            if (mocks.listPrsError) throw mocks.listPrsError;
            return mocks.openPrs || [];
        },
        getPr: function(number) {
            note('getPr', [number]);
            if (mocks.getPrError) throw mocks.getPrError;
            return mocks.prDetail !== undefined ? mocks.prDetail : { number: number };
        }
    };

    var tracker = {
        moveToStatus: function(key, status) {
            note('moveToStatus', [key, status]);
            if (mocks.moveError) throw mocks.moveError;
        },
        removeLabel: function(key, label) {
            note('removeLabel', [key, label]);
            if (mocks.removeLabelError) throw mocks.removeLabelError;
        },
        postComment: function(key, comment) {
            note('postComment', [key, comment]);
            if (mocks.commentError) throw mocks.commentError;
        }
    };

    var files = mocks.files || {};
    var globalMocks = {
        file_read: function(opts) {
            var p = opts && (opts.path || opts);
            if (mocks.fileReadError) throw mocks.fileReadError;
            if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
            return null;
        },
        file_write: function(opts) {
            note('file_write', [opts && opts.path]);
            if (mocks.fileWriteError) throw mocks.fileWriteError;
            files[opts.path] = opts.content;
        }
    };

    var module = loadModule(
        'js/recoverDirtyReviewTestCase.js',
        makeRequire({
            './common/scm.js': { createScm: function() { return scm; } },
            './configLoader.js': {
                loadProjectConfig: function() {
                    return mocks.config || { jira: { statuses: { IN_REWORK: 'In Rework' } } };
                }
            },
            './common/trackers.js': { createTracker: function(config, customParams) {
                note('createTracker', [config, customParams]);
                return tracker;
            } }
        }),
        globalMocks
    );

    return { module: module, calls: calls, files: files };
}

function paramsFor(key) {
    return { ticket: { key: key || 'TS-1' }, jobParams: {} };
}

function makePr(number, extra) {
    var pr = { number: number, title: 'TS-1: change something', head: { ref: 'test/TS-1' } };
    if (extra) {
        for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) pr[k] = extra[k];
        }
    }
    return pr;
}

function callNames(calls) {
    return calls.map(function(c) { return c.name; });
}

suite('recoverDirtyReviewTestCase.action — guard + no-PR paths', function() {

    test('missing ticket key → success:false "missing ticket key", no SCM traffic', function() {
        var setup = setupRecoverDirty({});
        var result = setup.module.action({ ticket: {}, jobParams: {} });

        assert.deepEqual(result, { success: false, error: 'missing ticket key' });
        assert.deepEqual(callNames(setup.calls), []);
    });

    test('no open PR → action:no_pr, open-PR list cached to disk', function() {
        var setup = setupRecoverDirty({});
        var result = setup.module.action(paramsFor());

        assert.deepEqual(result, { success: true, action: 'no_pr', ticketKey: 'TS-1' });
        assert.deepEqual(callNames(setup.calls), ['listPrs', 'file_write']);
        assert.equal(setup.calls[0].args[0], 'open');
        var cached = JSON.parse(setup.files[CACHE_PATH]);
        assert.deepEqual(cached, { timestamp: cached.timestamp, prList: [] });
        assert.equal(typeof cached.timestamp, 'number');
    });

    test('listPrs failure → empty PR list, no cache write, action:no_pr', function() {
        var setup = setupRecoverDirty({ listPrsError: new Error('api down') });
        var result = setup.module.action(paramsFor());

        assert.equal(result.success, true);
        assert.equal(result.action, 'no_pr');
        assert.deepEqual(callNames(setup.calls), ['listPrs']);
    });

    test('cache write failure is non-fatal — result still computed from the fetched list', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable_state: 'dirty' })],
            fileWriteError: new Error('disk full')
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'moved_to_rework');
    });

    test('title match pins the exact ticket key — TS-135 must not match TS-1359', function() {
        var setup = setupRecoverDirty({
            openPrs: [
                makePr(1, { title: 'TS-1359: unrelated', head: { ref: 'ai/TS-1359' } }),
                makePr(2, { title: 'TS-135: fix it', head: { ref: 'ai/TS-135' }, mergeable_state: 'conflicting' })
            ]
        });
        var result = setup.module.action(paramsFor('TS-135'));

        assert.equal(result.prNumber, 2);
        assert.equal(result.action, 'moved_to_rework');
    });

    test('branch ref match: feature/TS-1 matches ticket TS-1', function() {
        var setup = setupRecoverDirty({
            openPrs: [
                { number: 3, title: 'unrelated title', head: { ref: 'feature/TS-1' }, mergeable_state: 'dirty' }
            ]
        });
        var result = setup.module.action(paramsFor('TS-1'));

        assert.equal(result.prNumber, 3);
        assert.equal(result.action, 'moved_to_rework');
    });

    test('branch ref TS-19 does not match ticket TS-1', function() {
        var setup = setupRecoverDirty({
            openPrs: [
                { number: 4, title: 'unrelated title', head: { ref: 'feature/TS-19' }, mergeable_state: 'dirty' }
            ]
        });
        var result = setup.module.action(paramsFor('TS-1'));

        assert.deepEqual(result, { success: true, action: 'no_pr', ticketKey: 'TS-1' });
    });
});

suite('recoverDirtyReviewTestCase.action — dirty/clean decision and rework flow', function() {

    test('list row already dirty (mergeable_state) → rework without an extra getPr', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable_state: 'dirty' })]
        });
        var result = setup.module.action(paramsFor());

        assert.deepEqual(result, { success: true, action: 'moved_to_rework', ticketKey: 'TS-1', prNumber: 7 });
        assert.deepEqual(callNames(setup.calls), [
            'createTracker', 'listPrs', 'file_write', 'moveToStatus',
            'removeLabel', 'removeLabel', 'removeLabel', 'postComment'
        ]);
        assert.deepEqual(setup.calls[3].args, ['TS-1', 'In Rework']);
        assert.deepEqual(
            setup.calls.slice(4, 7).map(function(c) { return c.args[1]; }),
            ['sm_test_rework_triggered', 'sm_test_automation_triggered', 'sm_test_review_triggered']
        );
        assert.contains(setup.calls[7].args[1], 'Test Case PR #7 became dirty');
        assert.contains(setup.calls[7].args[1], 'In Rework');
    });

    test('conflicting merge state → rework', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable_state: 'conflicting' })]
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'moved_to_rework');
    });

    test('mergeable:false without a state → rework', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable: false })]
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'moved_to_rework');
    });

    test('camelCase mergeableState on the list row is honored', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeableState: 'dirty' })]
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'moved_to_rework');
    });

    test('clean PR → action:clean, tracker untouched', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable: true, mergeable_state: 'clean' })]
        });
        var result = setup.module.action(paramsFor());

        assert.deepEqual(result, { success: true, action: 'clean', ticketKey: 'TS-1', prNumber: 7 });
        assert.deepEqual(callNames(setup.calls), ['createTracker', 'listPrs', 'file_write']);
    });

    test('list row without merge info → exactly one getPr fetch; dirty detail moves the ticket', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7)],
            prDetail: { number: 7, mergeable: false }
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'moved_to_rework');
        assert.deepEqual(
            setup.calls.filter(function(c) { return c.name === 'getPr'; }).map(function(c) { return c.args[0]; }),
            [7]
        );
    });

    test('getPr failure falls back to the list row (clean fallback → no recovery)', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable: true })],
            getPrError: new Error('secondary rate limit')
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'clean');
    });

    test('getPr failure with dirty list row still moves to rework', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable_state: 'conflicting' })],
            getPrError: new Error('boom')
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'moved_to_rework');
    });

    test('moveToStatus failure → success:false with the error, no labels stripped, no comment', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable_state: 'dirty' })],
            moveError: new Error('status blocked')
        });
        var result = setup.module.action(paramsFor());

        assert.deepEqual(result, { success: false, error: 'Error: status blocked', ticketKey: 'TS-1', prNumber: 7 });
        assert.deepEqual(callNames(setup.calls), ['createTracker', 'listPrs', 'file_write', 'moveToStatus']);
    });

    test('recovery comment failure is non-fatal — success stays true', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable_state: 'dirty' })],
            commentError: new Error('comment quota')
        });
        var result = setup.module.action(paramsFor());

        assert.deepEqual(result, { success: true, action: 'moved_to_rework', ticketKey: 'TS-1', prNumber: 7 });
        assert.deepEqual(callNames(setup.calls), [
            'createTracker', 'listPrs', 'file_write', 'moveToStatus',
            'removeLabel', 'removeLabel', 'removeLabel', 'postComment'
        ]);
    });

    test('removeLabel failure on one stale label does not abort the recovery', function() {
        var setup = setupRecoverDirty({
            openPrs: [makePr(7, { mergeable_state: 'dirty' })],
            removeLabelError: new Error('label api')
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'moved_to_rework');
    });
});

suite('recoverDirtyReviewTestCase.action — PR cache', function() {

    test('fresh cache hit short-circuits listPrs and still drives the recovery', function() {
        var setup = setupRecoverDirty({
            files: (function() {
                var f = {};
                f[CACHE_PATH] = JSON.stringify({
                    timestamp: new Date().getTime() - 1000,
                    prList: [{ number: 9, title: 'TS-1: cached', head: { ref: 'test/TS-1' }, mergeable_state: 'dirty' }]
                });
                return f;
            })()
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'moved_to_rework');
        assert.deepEqual(
            setup.calls.map(function(c) { return c.name; }),
            ['createTracker', 'moveToStatus', 'removeLabel', 'removeLabel', 'removeLabel', 'postComment']
        );
    });

    test('expired cache (> 5 min) is ignored — listPrs runs', function() {
        var setup = setupRecoverDirty({
            files: (function() {
                var f = {};
                f[CACHE_PATH] = JSON.stringify({
                    timestamp: new Date().getTime() - 6 * 60 * 1000,
                    prList: [{ number: 9, title: 'TS-1: stale', head: { ref: 'test/TS-1' } }]
                });
                return f;
            })(),
            openPrs: [makePr(7, { mergeable: true, mergeable_state: 'clean' })]
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'clean');
        assert.equal(setup.calls[1].name, 'listPrs');
    });

    test('cache entry without a timestamp is ignored', function() {
        var setup = setupRecoverDirty({
            files: (function() {
                var f = {};
                f[CACHE_PATH] = JSON.stringify({ prList: [] });
                return f;
            })(),
            openPrs: [makePr(7, { mergeable: true, mergeable_state: 'clean' })]
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'clean');
        assert.equal(setup.calls[1].name, 'listPrs');
    });

    test('unparsable cache payload is ignored (no throw)', function() {
        var setup = setupRecoverDirty({
            files: (function() {
                var f = {};
                f[CACHE_PATH] = 'definitely not json';
                return f;
            })(),
            openPrs: [makePr(7, { mergeable: true, mergeable_state: 'clean' })]
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'clean');
    });

    test('cache read error is ignored', function() {
        var setup = setupRecoverDirty({
            fileReadError: new Error('fs offline'),
            openPrs: [makePr(7, { mergeable: true, mergeable_state: 'clean' })]
        });
        var result = setup.module.action(paramsFor());

        assert.equal(result.action, 'clean');
    });

    test('written cache slimming: head.ref fallback and mergeable_state/state normalization', function() {
        var setup = setupRecoverDirty({
            openPrs: [
                { number: 1, title: 'a', head: { ref: 'x' }, mergeable: true, mergeable_state: 'clean' },
                { number: 2, title: 'b', mergeable: false, mergeableState: 'dirty' },
                { number: 3, title: 'c', head: {}, mergeable_state: 'dirty', mergeableState: 'dirty' }
            ]
        });
        setup.module.action(paramsFor());

        var cached = JSON.parse(setup.files[CACHE_PATH]);
        assert.deepEqual(cached.prList, [
            { number: 1, title: 'a', head: { ref: 'x' }, mergeable: true, mergeable_state: 'clean', mergeableState: 'clean' },
            { number: 2, title: 'b', head: { ref: '' }, mergeable: false, mergeable_state: 'dirty', mergeableState: 'dirty' },
            { number: 3, title: 'c', head: { ref: '' }, mergeable: undefined, mergeable_state: 'dirty', mergeableState: 'dirty' }
        ]);
    });
});

suite('recoverDirtyReviewTestCase — extracted pure helpers (gh-1077)', function() {

    test('resolveTicketKey', function() {
        var setup = setupRecoverDirty({});
        assert.equal(setup.module.resolveTicketKey({ ticket: { key: 'TS-9' } }), 'TS-9');
        assert.equal(setup.module.resolveTicketKey({ ticket: {} }), undefined);
        assert.equal(setup.module.resolveTicketKey({}), undefined);
        assert.equal(setup.module.resolveTicketKey({ ticket: null }), null);
    });

    test('resolveCustomParams — jobParams win over params, defaults to {}', function() {
        var setup = setupRecoverDirty({});
        assert.deepEqual(setup.module.resolveCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(setup.module.resolveCustomParams({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(setup.module.resolveCustomParams({ jobParams: {} }), {});
        assert.deepEqual(setup.module.resolveCustomParams({}), {});
    });

    test('prHasMergeInfo — mergeable defined, or either state spelling', function() {
        var setup = setupRecoverDirty({});
        assert.equal(setup.module.prHasMergeInfo({ mergeable: false }), true);
        assert.equal(setup.module.prHasMergeInfo({ mergeable: true }), true);
        assert.equal(setup.module.prHasMergeInfo({ mergeableState: 'clean' }), true);
        assert.equal(setup.module.prHasMergeInfo({ mergeable_state: 'dirty' }), true);
        assert.equal(setup.module.prHasMergeInfo({}), false);
    });

    test('mergeStateOf — snake_case first, camelCase fallback, empty default, null-safe', function() {
        var setup = setupRecoverDirty({});
        assert.equal(setup.module.mergeStateOf({ mergeable_state: 'dirty', mergeableState: 'clean' }), 'dirty');
        assert.equal(setup.module.mergeStateOf({ mergeableState: 'clean' }), 'clean');
        assert.equal(setup.module.mergeStateOf({}), '');
        assert.equal(setup.module.mergeStateOf(null), null);
    });

    test('mergeableFlagOf — null-safe passthrough', function() {
        var setup = setupRecoverDirty({});
        assert.equal(setup.module.mergeableFlagOf({ mergeable: false }), false);
        assert.equal(setup.module.mergeableFlagOf({ mergeable: true }), true);
        assert.equal(setup.module.mergeableFlagOf({}), undefined);
        assert.equal(setup.module.mergeableFlagOf(null), null);
    });

    test('isDirtyMergeState — dirty/conflicting states and explicit mergeable:false only', function() {
        var setup = setupRecoverDirty({});
        assert.equal(setup.module.isDirtyMergeState('dirty', true), true);
        assert.equal(setup.module.isDirtyMergeState('conflicting', undefined), true);
        assert.equal(setup.module.isDirtyMergeState('clean', false), true);
        assert.equal(setup.module.isDirtyMergeState('clean', true), false);
        assert.equal(setup.module.isDirtyMergeState('unstable', true), false);
        assert.equal(setup.module.isDirtyMergeState('', undefined), false);
    });

    test('_parseJson — strings parse, broken strings stay raw, non-strings pass through', function() {
        var setup = setupRecoverDirty({});
        var obj = { a: 1 };
        assert.deepEqual(setup.module._parseJson('{"a":1}'), obj);
        assert.equal(setup.module._parseJson('not json'), 'not json');
        assert.equal(setup.module._parseJson(obj), obj);
        assert.equal(setup.module._parseJson(null), null);
    });

    test('_toArray — array, {value}, {items}, single object, and null shapes', function() {
        var setup = setupRecoverDirty({});
        assert.deepEqual(setup.module._toArray('[1,2]'), [1, 2]);
        assert.deepEqual(setup.module._toArray(['x']), ['x']);
        assert.deepEqual(setup.module._toArray({ value: ['v'] }), ['v']);
        assert.deepEqual(setup.module._toArray({ items: ['i'] }), ['i']);
        assert.deepEqual(setup.module._toArray({ number: 5 }), [{ number: 5 }]);
        assert.deepEqual(setup.module._toArray(null), []);
        assert.deepEqual(setup.module._toArray(undefined), []);
    });

    test('_readCache — miss, fresh hit, stale, timestamp-less, and error all behave', function() {
        var fresh = setupRecoverDirty({
            files: (function() {
                var f = {};
                f[CACHE_PATH] = JSON.stringify({ timestamp: new Date().getTime(), prList: ['p'] });
                return f;
            })()
        });
        assert.deepEqual(fresh.module._readCache(), ['p']);

        var stale = setupRecoverDirty({
            files: (function() {
                var f = {};
                f[CACHE_PATH] = JSON.stringify({ timestamp: 1, prList: ['p'] });
                return f;
            })()
        });
        assert.equal(stale.module._readCache(), null);

        var noTs = setupRecoverDirty({
            files: (function() {
                var f = {};
                f[CACHE_PATH] = JSON.stringify({ prList: ['p'] });
                return f;
            })()
        });
        assert.equal(noTs.module._readCache(), null);

        var broken = setupRecoverDirty({
            files: (function() {
                var f = {};
                f[CACHE_PATH] = '{{';
                return f;
            })()
        });
        assert.equal(broken.module._readCache(), null);

        var empty = setupRecoverDirty({});
        assert.equal(empty.module._readCache(), null);
    });
});
