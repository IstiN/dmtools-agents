/**
 * Unit tests: sm Jira state source (js/sm/sources/jiraSource.js) — the
 * classic JQL-backed source behind source:'jira' (default) sm rules.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('sm jira source', function () {

    function load(jqlResults) {
        return loadModule('js/sm/sources/jiraSource.js', makeRequire({}), {
            jira_search_by_jql: function () { return jqlResults; }
        });
    }

    test('FIFO: newest-first API order comes back oldest-first (owner rule 2026-10-04)', function () {
        // jira_search_by_jql returns REST default (newest first); limit:1
        // rules must still see the OLDEST ticket first or it starves at the
        // bottom of the queue forever.
        var src = load([
            { key: 'PROJ-9', labels: ['a'] },
            { key: 'PROJ-2', labels: ['b'] },
            { key: 'PROJ-30', labels: ['c'] },
            { key: 'PROJ-1', labels: ['d'] }
        ]);
        var items = src.query({ jql: 'project = PROJ' }, { jql: 'project = PROJ' });
        assert.deepEqual(items.map(function (i) { return i.key; }),
            ['PROJ-1', 'PROJ-2', 'PROJ-9', 'PROJ-30'],
            'numeric suffix order, not lexicographic (PROJ-30 < PROJ-9 would starve it)');
    });

    test('FIFO: multi-project JQL keeps per-project order (prefix, then number)', function () {
        var src = load([
            { key: 'BB-1', labels: [] },
            { key: 'AA-20', labels: [] },
            { key: 'AA-3', labels: [] },
            { key: 'BB-2', labels: [] }
        ]);
        var items = src.query({}, {});
        assert.deepEqual(items.map(function (i) { return i.key; }),
            ['AA-3', 'AA-20', 'BB-1', 'BB-2']);
    });

    test('item shape and non-array API results degrade to empty', function () {
        var src = load([{ key: 'X-7', labels: ['keep'] }]);
        var items = src.query({}, {});
        assert.deepEqual(Object.keys(items[0]).sort(),
            ['issueNumber', 'key', 'labels', 'pr', 'prNumber']);
        assert.deepEqual(items[0].labels, ['keep']);
        assert.equal(items[0].pr, null);
        var empty = load(null).query({}, {});
        assert.deepEqual(empty, [], 'null API payload → no tickets, no crash');
    });
});
