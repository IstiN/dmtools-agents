/**
 * Unit tests for js/common/trackerHolder.js (gh-1247)
 *
 * The module is require-free by design (the trackers module is injected by
 * the caller, same convention as branchSetup.js), so it loads bare.
 *
 * Uses: loadModule(), assert, test(), suite()
 */

/** trackersModule stub recording createTracker calls. */
function makeTrackersModule(calls) {
    return {
        createTracker: function (config, customParams) {
            calls.push({ config: config, customParams: customParams });
            return { id: calls.length, config: config, customParams: customParams };
        }
    };
}

suite('trackerHolder', function() {

    test('getTracker lazily creates ONE tracker and caches it', function() {
        var calls = [];
        var holder = loadModule('js/common/trackerHolder.js').create(makeTrackersModule(calls));

        var cfg = { jira: {} };
        var params = { customParams: { a: 1 } };
        holder.initTracker(cfg, params);

        var t1 = holder.getTracker();
        var t2 = holder.getTracker();

        assert.equal(calls.length, 1, 'createTracker called exactly once');
        assert.equal(calls[0].config, cfg, 'config passed through');
        assert.equal(calls[0].customParams, params, 'customParams passed through');
        assert.equal(t1, t2, 'same cached instance returned');
        assert.equal(t1.id, 1, 'returns the created tracker');
    });

    test('initTracker resets the cached instance — next getTracker re-creates', function() {
        var calls = [];
        var holder = loadModule('js/common/trackerHolder.js').create(makeTrackersModule(calls));

        holder.initTracker({ v: 1 }, {});
        var first = holder.getTracker();

        var cfg2 = { v: 2 };
        holder.initTracker(cfg2, undefined);
        var second = holder.getTracker();
        var again = holder.getTracker();

        assert.equal(calls.length, 2, 're-created after re-init');
        assert.notEqual(first, second, 'fresh instance after re-init');
        assert.equal(second, again, 'new instance cached too');
        assert.equal(calls[1].config, cfg2, 'new config used');
        assert.deepEqual(calls[1].customParams, {}, 'undefined customParams normalized to {}');
    });

    test('initTracker defaults config and customParams to null', function() {
        var calls = [];
        var holder = loadModule('js/common/trackerHolder.js').create(makeTrackersModule(calls));

        holder.initTracker();
        holder.getTracker();

        assert.equal(calls[0].config, null, 'config defaults to null');
        assert.deepEqual(calls[0].customParams, {}, 'customParams defaults to {}');
    });

    test('two holders are independent — no shared state', function() {
        var callsA = [];
        var callsB = [];
        var load = loadModule('js/common/trackerHolder.js');
        var holderA = load.create(makeTrackersModule(callsA));
        var holderB = load.create(makeTrackersModule(callsB));

        holderA.initTracker({ name: 'a' }, {});
        holderB.initTracker({ name: 'b' }, {});

        assert.equal(holderA.getTracker().config.name, 'a');
        assert.equal(holderB.getTracker().config.name, 'b');
        assert.equal(callsA.length, 1, 'holderA created once');
        assert.equal(callsB.length, 1, 'holderB created once');
    });
});
