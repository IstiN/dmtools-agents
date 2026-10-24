/**
 * Unit tests for js/common/labelList.js — the label-list normalization
 * shared by smAgent.js and pushReworkChanges.js (gh-1249: two verbatim
 * copies of normalizeLabels deduplicated into this pure leaf module).
 */

var assert = globalThis.assert;

var labelList = loadModule('js/common/labelList.js', makeRequire({}), {});

suite('labelList normalizeLabels', function () {
    test('single label only, list only, both, neither', function () {
        assert.deepEqual(labelList.normalizeLabels('a', null), ['a']);
        assert.deepEqual(labelList.normalizeLabels(null, ['x', 'y']), ['x', 'y']);
        assert.deepEqual(labelList.normalizeLabels('a', ['x']), ['a', 'x']);
        assert.deepEqual(labelList.normalizeLabels(null, null), []);
        assert.deepEqual(labelList.normalizeLabels('', undefined), []);
    });

    test('de-duplicates across the single label and the list, keeps first-seen order', function () {
        assert.deepEqual(labelList.normalizeLabels('a', ['a', 'b', 'a']), ['a', 'b']);
        assert.deepEqual(labelList.normalizeLabels('b', ['a', 'b', 'c']), ['b', 'a', 'c']);
    });

    test('drops falsy entries (null / empty) from the list', function () {
        assert.deepEqual(labelList.normalizeLabels(null, ['a', '', null, 'b']), ['a', 'b']);
    });

    test('non-array list argument is ignored', function () {
        assert.deepEqual(labelList.normalizeLabels('a', 'not-a-list'), ['a']);
        assert.deepEqual(labelList.normalizeLabels(null, { x: 1 }), []);
    });

    test('2+ item list round-trip (multi-item logic, not just the happy path)', function () {
        assert.deepEqual(labelList.normalizeLabels(null, ['one', 'two', 'three']),
            ['one', 'two', 'three']);
    });
});
