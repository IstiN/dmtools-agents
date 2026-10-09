/**
 * Unit tests for the shared test-runner mock helpers (gh-824 rework).
 *
 * The throwing './trackers.js' mock was copy-pasted across six suites that
 * load contentOutput-backed modules; trackersMock() in testRunner.js now
 * owns the "contentOutput tracker fallback must never fire here" contract
 * in exactly one place. These tests pin that contract so a change to the
 * fallback shape (different function, different message) turns red here
 * first.
 *
 * Uses: trackersMock(), suite(), test(), assert
 */

'use strict';

/* global trackersMock, suite, test, assert */

suite('unit-test mocks: trackersMock (the shared contentOutput tracker fallback)', function () {

    test('exposes createTracker as a function', function () {
        var mock = trackersMock();
        assert.ok(mock, 'trackersMock() must return a mock object');
        assert.equal(typeof mock.createTracker, 'function',
            'the mock must shape like the trackers module (createTracker)');
    });

    test('createTracker throws — the fallback must never fire in these suites', function () {
        var mock = trackersMock();
        var thrown = null;
        try {
            mock.createTracker(null, {});
        } catch (e) {
            thrown = e;
        }
        assert.ok(thrown, 'createTracker must throw when the fallback is reached');
        assert.contains(thrown.message, 'tracker fallback not expected',
            'the message must name the unexpected fallback');
    });

    test('a fresh mock per call — one suite throwing must not poison another', function () {
        var a = trackersMock();
        var b = trackersMock();
        assert.notEqual(a, b, 'each call returns a fresh object');
        assert.notEqual(a.createTracker, b.createTracker,
            'each mock carries its own throwing function');
    });
});
