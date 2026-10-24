/**
 * Unit tests: js/common/loseJson.js — lenient JSON coercion helpers
 * (gh-1248 dedup: one copy of parseJsonLose / toArrayLose for the runtime).
 */

suite('loseJson — parseJsonLose', function () {
    var loseJson = loadModule('js/common/loseJson.js', makeRequire({}), {});

    test('parses a valid JSON string', function () {
        assert.equal(loseJson.parseJsonLose('{"a":1}').a, 1);
        assert.deepEqual(loseJson.parseJsonLose('[1,2]'), [1, 2]);
    });

    test('a broken JSON string rides back unchanged (never throws)', function () {
        assert.equal(loseJson.parseJsonLose('{not json'), '{not json');
        assert.equal(loseJson.parseJsonLose(''), '');
    });

    test('non-string inputs pass through as-is', function () {
        assert.equal(loseJson.parseJsonLose(null), null);
        assert.equal(loseJson.parseJsonLose(42), 42);
        var obj = { x: 1 };
        assert.equal(loseJson.parseJsonLose(obj), obj);
    });
});

suite('loseJson — toArrayLose', function () {
    var loseJson = loadModule('js/common/loseJson.js', makeRequire({}), {});

    test('an array returns itself', function () {
        var arr = [{ a: 1 }, { a: 2 }];
        assert.equal(loseJson.toArrayLose(arr).length, 2);
    });

    test('a { value: [...] } REST envelope unwraps to the list', function () {
        var out = loseJson.toArrayLose(JSON.stringify({ value: [1, 2, 3] }));
        assert.deepEqual(out, [1, 2, 3]);
    });

    test('caller-specific extra list fields are honored in order', function () {
        var out = loseJson.toArrayLose({ jobs: ['a'], workflows: ['b', 'c'] }, ['workflows', 'jobs']);
        assert.deepEqual(out, ['b', 'c']);
        // first PRESENT field wins
        out = loseJson.toArrayLose({ jobs: ['a'], workflows: ['b'] }, ['workflows', 'jobs']);
        assert.deepEqual(out, ['b']);
    });

    test('a single object wraps into a one-element array', function () {
        var out = loseJson.toArrayLose({ id: 7 });
        assert.equal(out.length, 1);
        assert.equal(out[0].id, 7);
    });

    test('null/undefined flatten to the empty array', function () {
        assert.deepEqual(loseJson.toArrayLose(null), []);
        assert.deepEqual(loseJson.toArrayLose(undefined), []);
    });

    test('value field wins over extra fields', function () {
        var out = loseJson.toArrayLose({ value: [1], jobs: [2] }, ['jobs']);
        assert.deepEqual(out, [1]);
    });
});

suite('loseJson — firstListField', function () {
    var mod = loadModule('js/common/loseJson.js', makeRequire({}), {});

    test('returns the first present extra list field', function () {
        assert.deepEqual(mod.firstListField({ issues: [1, 2] }, ['issues']), [1, 2]);
        assert.deepEqual(mod.firstListField({ a: [1], b: [2] }, ['b', 'a']), [2]);
    });

    test('answers null when no extra field carries a list', function () {
        assert.equal(mod.firstListField({ value: [9] }, ['issues']), null);
        assert.equal(mod.firstListField(null, ['issues']), null);
        assert.equal(mod.firstListField({}, null), null);
    });

    test('toArrayLose routes through the extra fields after value', function () {
        assert.deepEqual(mod.toArrayLose('{"issues":[{"k":1}]}', ['issues']), [{ k: 1 }]);
    });
});
