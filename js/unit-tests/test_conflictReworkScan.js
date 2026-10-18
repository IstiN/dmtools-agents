/* global loadModule, assert, test, suite, makeRequire */

// gh-1027: the shared over-scan budget (smAgent loop break + queryPrs slice
// must agree — a mismatch re-cuts the queue before the loop sees candidates
// parked behind already-reported markers).
suite('conflictReworkScan — scanLimit budget', function () {
    var mod = loadModule('js/common/conflictReworkScan.js', makeRequire({}), {});

    test('limit + OVERSCAN for positive limits', function () {
        assert.equal(mod.scanLimit(1), 16, 'limit 1 scans 16 candidates');
        assert.equal(mod.scanLimit(5), 20);
        assert.equal(mod.OVERSCAN, 15);
    });

    test('invalid limits degrade to the overscan alone', function () {
        assert.equal(mod.scanLimit(0), 15);
        assert.equal(mod.scanLimit(-3), 15);
        assert.equal(mod.scanLimit('x'), 15);
        assert.equal(mod.scanLimit(undefined), 15);
        assert.equal(mod.scanLimit(2.9), 17, 'floored');
    });
});
