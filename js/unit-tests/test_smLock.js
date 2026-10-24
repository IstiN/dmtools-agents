/**
 * Unit tests for js/common/smLock.js (gh-1250).
 */

function loadSmLock() {
    return loadModule('js/common/smLock.js', makeRequire({}), {});
}

function makeTrackerStub(overrides) {
    var stub = {
        calls: [],
        removeLabel: function(key, label) { this.calls.push({ key: key, label: label }); }
    };
    if (overrides) {
        for (var k in overrides) {
            if (overrides.hasOwnProperty(k)) stub[k] = overrides[k];
        }
    }
    return stub;
}

suite('smLock', function() {
    test('releaseLock: removes the label and logs when key and label are present', function() {
        var tracker = makeTrackerStub();
        loadSmLock().releaseLock(tracker, 'TS-1', 'sm_check_triggered');
        assert.deepEqual(tracker.calls, [{ key: 'TS-1', label: 'sm_check_triggered' }]);
    });

    test('releaseLock: no-op without a ticket key', function() {
        var tracker = makeTrackerStub();
        loadSmLock().releaseLock(tracker, null, 'sm_check_triggered');
        loadSmLock().releaseLock(tracker, undefined, 'sm_check_triggered');
        assert.deepEqual(tracker.calls, []);
    });

    test('releaseLock: no-op without a label', function() {
        var tracker = makeTrackerStub();
        loadSmLock().releaseLock(tracker, 'TS-1', null);
        loadSmLock().releaseLock(tracker, 'TS-1', '');
        assert.deepEqual(tracker.calls, []);
    });

    test('releaseLock: a removal failure is swallowed', function() {
        var logged = [];
        var origWarn = console.warn;
        console.warn = function(m) { logged.push(String(m)); };
        var tracker;
        try {
            tracker = makeTrackerStub({ removeLabel: function() { throw new Error('boom'); } });
            loadSmLock().releaseLock(tracker, 'TS-1', 'sm_check_triggered');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(tracker.calls.length, 0, 'removeLabel threw before recording');
        assert.equal(logged.length, 1, 'exactly one warning');
        assert.contains(logged[0], 'Failed to remove SM label');
    });
});
