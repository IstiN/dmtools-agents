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

// gh-1027 rework (CRAP ratchet regression): the slice-cap branch was
// extracted from queryPrs into sliceCap — queryPrs' CC (and so its CRAP
// floor) must not carry the conflict_rework decision.
suite('conflictReworkScan — sliceCap query slice', function () {
    var mod = loadModule('js/common/conflictReworkScan.js', makeRequire({}), {});

    test('conflict_rework rules widen to the over-scan budget', function () {
        assert.equal(mod.sliceCap({ localAction: 'conflict_rework' }, 1, 3), 16,
            'limit 1 -> scanLimit(1) = 16');
        assert.equal(mod.sliceCap({ localAction: 'conflict_rework' }, 5, 3), 20);
        assert.equal(mod.sliceCap({ localAction: 'conflict_rework', limit: 5 }, 2.9, 3), 17,
            'invalid/fractional limit degrades to OVERSCAN alone');
    });

    test('other rules keep limit + fallthrough reserve', function () {
        assert.equal(mod.sliceCap({ localAction: 'validate_fresh' }, 1, 3), 4);
        assert.equal(mod.sliceCap({ localAction: 'validate_fresh' }, 5, 3), 8);
        assert.equal(mod.sliceCap({}, 1, 3), 4, 'rule without localAction keeps the reserve');
        assert.equal(mod.sliceCap(null, 2, 3), 5, 'null rule keeps the reserve');
        assert.equal(mod.sliceCap(undefined, 2, 3), 5, 'undefined rule keeps the reserve');
    });
});
