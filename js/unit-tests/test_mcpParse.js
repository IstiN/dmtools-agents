/* Unit tests for js/common/mcpParse.js (gh-1250) — the shared
 * MCP-bridge payload normalizers (parseMcp + payloadList) extracted from
 * the byte-identical copies in mergeTrigger.js and sm/mergeBot.js. */
/* global loadModule, assert, test, suite, makeRequire */

function loadMcpParse() {
    return loadModule('js/common/mcpParse.js', makeRequire({}), {});
}

suite('mcpParse: parseMcp', function () {
    test('null/undefined → {}', function () {
        var mod = loadMcpParse();
        assert.deepEqual(mod.parseMcp(null), {});
        assert.deepEqual(mod.parseMcp(undefined), {});
    });

    test('objects pass through by reference', function () {
        var mod = loadMcpParse();
        var obj = { a: 1, items: [1, 2] };
        assert.equal(mod.parseMcp(obj), obj, 'no copy — the caller sees the same object');
        assert.deepEqual(mod.parseMcp([1, 2]), [1, 2], 'arrays are objects too');
    });

    test('valid JSON strings parse', function () {
        var mod = loadMcpParse();
        assert.deepEqual(mod.parseMcp('{"b":2}'), { b: 2 });
        assert.deepEqual(mod.parseMcp('  [1,2] '), [1, 2]);
        assert.equal(mod.parseMcp('5'), 5, 'a bare numeric string parses to the number');
    });

    test('invalid JSON strings → {} (the swallowed bridge-error body)', function () {
        var mod = loadMcpParse();
        assert.deepEqual(mod.parseMcp('not json'), {});
        assert.deepEqual(mod.parseMcp('{"unclosed": '), {});
        assert.deepEqual(mod.parseMcp(''), {});
    });
});

suite('mcpParse: payloadList', function () {
    test('bare arrays pass through by reference', function () {
        var mod = loadMcpParse();
        var arr = [{ n: 1 }, { n: 2 }];
        assert.equal(mod.payloadList(arr), arr);
    });

    test('{ items: [...] } unwraps', function () {
        var mod = loadMcpParse();
        assert.deepEqual(mod.payloadList({ items: [3] }), [3]);
        assert.deepEqual(mod.payloadList({ items: [], pullRequests: [9] }), [],
            'an explicit empty items array wins over a pullRequests key');
    });

    test('{ pullRequests: [...] } unwraps', function () {
        var mod = loadMcpParse();
        assert.deepEqual(mod.payloadList({ pullRequests: [4] }), [4]);
        assert.deepEqual(mod.payloadList({ total_count: 0, pullRequests: [] }), []);
    });

    test('anything that is not a list shape reads as []', function () {
        var mod = loadMcpParse();
        assert.deepEqual(mod.payloadList(null), []);
        assert.deepEqual(mod.payloadList(undefined), []);
        assert.deepEqual(mod.payloadList({}), []);
        assert.deepEqual(mod.payloadList({ message: 'Not Found' }), []);
        assert.deepEqual(mod.payloadList('a string'), []);
        assert.deepEqual(mod.payloadList(5), []);
    });
});
