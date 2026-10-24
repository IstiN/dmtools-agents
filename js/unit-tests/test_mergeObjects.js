/**
 * Unit tests for js/common/mergeObjects.js (gh-1250).
 *
 * The helper is the single shared copy of the shallow-merge loop previously
 * duplicated in js/common/contentOutput.js (skip-undefined semantics) and
 * js/fetchParentContextToInput.js (copy-undefined legacy semantics).
 */

function loadMergeObjects() {
    return loadModule(
        'js/common/mergeObjects.js',
        makeRequire({}),
        {}
    );
}

suite('mergeObjects', function() {

    test('copies base keys and lets override keys win', function() {
        var mergeObjects = loadMergeObjects().mergeObjects;
        var merged = mergeObjects({ a: 1, b: 2 }, { b: 20, c: 3 }, true);
        assert.deepEqual(merged, { a: 1, b: 20, c: 3 });
    });

    test('does not mutate either input map', function() {
        var mergeObjects = loadMergeObjects().mergeObjects;
        var base = { a: 1 };
        var override = { b: 2 };
        mergeObjects(base, override, true);
        assert.deepEqual(base, { a: 1 });
        assert.deepEqual(override, { b: 2 });
    });

    test('skipUndefined=true: an explicit undefined override keeps the base value', function() {
        var mergeObjects = loadMergeObjects().mergeObjects;
        var merged = mergeObjects({ a: 1, b: 2 }, { a: undefined, b: null }, true);
        assert.equal(merged.a, 1, 'undefined must not shadow the base value (contentOutput semantics)');
        assert.equal(merged.b, null, 'null is a real value and wins');
    });

    test('skipUndefined=false: an explicit undefined override is copied verbatim', function() {
        var mergeObjects = loadMergeObjects().mergeObjects;
        var merged = mergeObjects({ a: 1 }, { a: undefined }, false);
        assert.ok('a' in merged, 'key is present after the merge');
        assert.equal(merged.a, undefined, 'undefined copied verbatim (fetchParentContextToInput legacy semantics)');
    });

    test('null/undefined base and override degrade to empty maps', function() {
        var mergeObjects = loadMergeObjects().mergeObjects;
        assert.deepEqual(mergeObjects(null, { a: 1 }, true), { a: 1 });
        assert.deepEqual(mergeObjects({ a: 1 }, null, true), { a: 1 });
        assert.deepEqual(mergeObjects(undefined, undefined, true), {});
    });

    test('only own enumerable keys are merged', function() {
        var mergeObjects = loadMergeObjects().mergeObjects;
        var proto = { inherited: true };
        var base = Object.create(proto);
        base.own = 1;
        var merged = mergeObjects(base, null, false);
        assert.deepEqual(merged, { own: 1 }, 'prototype chain is ignored');
    });

    test('skipUndefined applies to the override only — base undefined values are always copied', function() {
        var mergeObjects = loadMergeObjects().mergeObjects;
        var base = { a: undefined };
        var override = { b: 2 };
        var merged = mergeObjects(base, override, true);
        assert.deepEqual(merged, { a: undefined, b: 2 });
        assert.ok(Object.prototype.hasOwnProperty.call(merged, 'a'), 'base key with undefined value survives');
    });
});
