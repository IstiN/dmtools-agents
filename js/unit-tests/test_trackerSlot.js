/**
 * Unit tests for js/common/trackerSlot.js (gh-1250).
 */

function loadTrackerSlot(trackersMock) {
    return loadModule(
        'js/common/trackerSlot.js',
        makeRequire({ './trackers.js': trackersMock }),
        {}
    );
}

function makeTrackersStub() {
    return {
        calls: [],
        created: [],
        tracker: { provider: function() { return 'stub'; } },
        createTracker: function(config, customParams) {
            this.calls.push({ config: config, customParams: customParams });
            var t = { provider: function() { return 'stub'; } };
            this.created.push(t);
            return t;
        }
    };
}

suite('trackerSlot', function() {
    test('the slot is the trackers.js createTrackerHolder instance (gh-1250 unification)', function() {
        var holder = {
            initTracker: function() { throw new Error('initTracker must be re-exported, not wrapped'); },
            getTracker: function() { return 'the-tracker'; }
        };
        var holderCalls = 0;
        var trackers = {
            createTracker: function() { throw new Error('must go through the holder'); },
            createTrackerHolder: function() { holderCalls += 1; return holder; }
        };
        var slot = loadTrackerSlot(trackers);
        assert.equal(holderCalls, 1, 'one holder per slot module instance');
        assert.equal(slot.getTracker, holder.getTracker, 'getTracker is the holder method');
        assert.equal(slot.getTracker(), 'the-tracker');
    });

    test('getTracker lazily creates one tracker from the init context', function() {
        var trackers = makeTrackersStub();
        var slot = loadTrackerSlot(trackers);
        slot.initTracker({ name: 'cfg' }, { trackerProvider: 'github' });
        var t1 = slot.getTracker();
        var t2 = slot.getTracker();
        assert.equal(t1, trackers.created[0], 'returns the created tracker');
        assert.equal(t2, trackers.created[0], 'second call returns the same instance');
        assert.equal(trackers.calls.length, 1, 'createTracker called exactly once');
        assert.deepEqual(trackers.calls[0].config, { name: 'cfg' }, 'config forwarded');
        assert.deepEqual(trackers.calls[0].customParams, { trackerProvider: 'github' }, 'customParams forwarded');
    });

    test('initTracker resets the slot: next getTracker builds a fresh tracker', function() {
        var trackers = makeTrackersStub();
        var slot = loadTrackerSlot(trackers);
        slot.initTracker({ v: 1 }, {});
        var first = slot.getTracker();
        slot.initTracker({ v: 2 }, {});
        var second = slot.getTracker();
        assert.notEqual(first, second, 'fresh instance after re-init');
        assert.equal(trackers.calls.length, 2, 'one createTracker per init+get cycle');
        assert.deepEqual(trackers.calls[1].config, { v: 2 }, 'new config used');
    });

    test('initTracker defaults missing config/customParams to null/{}', function() {
        var trackers = makeTrackersStub();
        var slot = loadTrackerSlot(trackers);
        slot.initTracker();
        slot.getTracker();
        assert.equal(trackers.calls[0].config, null, 'config defaults to null');
        assert.deepEqual(trackers.calls[0].customParams, {}, 'customParams defaults to {}');
    });

    test('two slots loaded independently do not share state', function() {
        var trackersA = makeTrackersStub();
        var trackersB = makeTrackersStub();
        var slotA = loadTrackerSlot(trackersA);
        var slotB = loadTrackerSlot(trackersB);
        slotA.initTracker({ who: 'a' }, {});
        slotB.initTracker({ who: 'b' }, {});
        assert.deepEqual(slotA.getTracker(), trackersA.created[0], 'slot A uses its own trackers module');
        assert.deepEqual(slotB.getTracker(), trackersB.created[0], 'slot B uses its own trackers module');
    });
});
