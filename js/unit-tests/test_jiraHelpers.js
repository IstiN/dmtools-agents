/**
 * Unit tests for js/common/jiraHelpers.js — extractTicketKey (gh-1226 CRAP
 * ratchet). Characterization tests: they pin the exact response-shapes the
 * helper answers to (raw tool strings, JSON strings, parsed objects, junk)
 * so the CRAP <= 12 refactor cannot drift the contract.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

function loadJiraHelpers() {
    return loadModule(
        'js/common/jiraHelpers.js',
        makeRequire({
            '../config.js': configModule,
            'config': configModule,
            // gh-1248: extractTicketKey delegates to trackers.js — load the
            // real one (pure helpers, no tracker-tool side effects).
            './trackers.js': loadModule('js/common/trackers.js',
                makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js', makeRequire({}), {})
            }), {}),
            '../configLoader.js': { loadProjectConfig: function() { return null; } }
        }),
        {}
    );
}

suite('jiraHelpers.extractTicketKey — response-shape contract (gh-1226)', function() {

    test('falsy inputs answer null', function() {
        var jh = loadJiraHelpers();
        assert.equal(jh.extractTicketKey(null), null);
        assert.equal(jh.extractTicketKey(undefined), null);
        assert.equal(jh.extractTicketKey(''), null);
        assert.equal(jh.extractTicketKey(0), null);
        assert.equal(jh.extractTicketKey(false), null);
    });

    test('a JSON string with a key returns the key', function() {
        assert.equal(loadJiraHelpers().extractTicketKey('{"key":"PROJ-456","id":"10001"}'), 'PROJ-456');
    });

    test('a JSON string without a key returns null', function() {
        assert.equal(loadJiraHelpers().extractTicketKey('{"id":"10001"}'), null);
    });

    test('an invalid JSON string returns null instead of throwing', function() {
        assert.equal(loadJiraHelpers().extractTicketKey('created ticket PROJ-9'), null);
        assert.equal(loadJiraHelpers().extractTicketKey('{not json'), null);
    });

    test('a parsed object with a string key returns the key', function() {
        assert.equal(loadJiraHelpers().extractTicketKey({ key: 'PROJ-1', id: '42' }), 'PROJ-1');
    });

    test('an object whose key is not a string returns null', function() {
        assert.equal(loadJiraHelpers().extractTicketKey({ key: 42 }), null);
        assert.equal(loadJiraHelpers().extractTicketKey({ id: '42' }), null);
    });

    test('values that are neither string nor keyed object return null', function() {
        var jh = loadJiraHelpers();
        assert.equal(jh.extractTicketKey(42), null);
        assert.equal(jh.extractTicketKey(true), null);
        assert.equal(jh.extractTicketKey(['PROJ-1']), null);
    });
});
