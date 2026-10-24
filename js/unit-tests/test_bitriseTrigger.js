/**
 * Unit tests for js/common/bitriseTrigger.js (gh-1250).
 *
 * Shared helpers extracted from triggerBitriseIosBuild.js and
 * triggerBitriseTestAutomation.js: JQL ticket-key parsing, issue-list
 * payload normalization and feature-PR matching.
 */

function loadBitriseTrigger() {
    return loadModule('js/common/bitriseTrigger.js', makeRequire({}), {});
}

suite('bitriseTrigger — jql parsing', function() {

    test('parseJqlTicketKey extracts and uppercases the ticket key', function() {
        var mod = loadBitriseTrigger();
        assert.equal(mod.parseJqlTicketKey('key = ios-7'), 'IOS-7');
        assert.equal(mod.parseJqlTicketKey('key=PROJ-6815 AND status = Open'), 'PROJ-6815');
        assert.equal(mod.parseJqlTicketKey('key = ts-42 AND x'), 'TS-42');
    });

    test('parseJqlTicketKey returns empty string when no key present', function() {
        var mod = loadBitriseTrigger();
        assert.equal(mod.parseJqlTicketKey('labels = nokey'), '');
        assert.equal(mod.parseJqlTicketKey(''), '');
        assert.equal(mod.parseJqlTicketKey(null), '');
    });

    test('parseIssueList normalizes string/object-with-issues/bare-array payloads', function() {
        var mod = loadBitriseTrigger();
        assert.deepEqual(mod.parseIssueList('{"issues":[1]}'), [1]);
        assert.deepEqual(mod.parseIssueList({ issues: [2] }), [2]);
        assert.deepEqual(mod.parseIssueList([3]), [3]);
    });

    test('parseIssueList falls back to empty array for junk payloads', function() {
        var mod = loadBitriseTrigger();
        assert.deepEqual(mod.parseIssueList(undefined), []);
        assert.deepEqual(mod.parseIssueList(null), []);
        assert.throws(function() { mod.parseIssueList('{bad'); });
    });
});

suite('bitriseTrigger — PR matching', function() {

    test('prHeadRef falls back to empty string', function() {
        var mod = loadBitriseTrigger();
        assert.equal(mod.prHeadRef({ head: { ref: 'r' } }), 'r');
        assert.equal(mod.prHeadRef({}), '');
        assert.equal(mod.prHeadRef(null), '');
    });

    test('prViewUrl prefers html_url over url, falls back to empty string', function() {
        var mod = loadBitriseTrigger();
        assert.equal(mod.prViewUrl({ html_url: 'h', url: 'u' }), 'h');
        assert.equal(mod.prViewUrl({ url: 'u' }), 'u');
        assert.equal(mod.prViewUrl({}), '');
    });

    test('prMatchesTicket matches on title or head branch ref', function() {
        var mod = loadBitriseTrigger();
        assert.equal(mod.prMatchesTicket({ title: 'fix TS-1' }, 'TS-1'), true);
        assert.equal(mod.prMatchesTicket({ head: { ref: 'ai/TS-1' } }, 'TS-1'), true);
        assert.equal(mod.prMatchesTicket({ title: 'x', head: { ref: 'y' } }, 'TS-1'), false);
        assert.equal(mod.prMatchesTicket({}, 'TS-1'), false);
    });

    test('findMatchingPr returns the first PR matching the ticket key', function() {
        var mod = loadBitriseTrigger();
        var prs = [
            { number: 1, title: 'nope', head: { ref: 'x' } },
            { number: 2, title: 'TS-9 yes', head: { ref: 'y' }, html_url: 'h2' },
            { number: 3, title: 'TS-9 duplicate', head: { ref: 'z' } }
        ];
        var match = mod.findMatchingPr(prs, 'TS-9');
        assert.equal(match.number, 2, 'first matching PR wins');
        assert.equal(mod.findMatchingPr(prs, 'TS-99'), null, 'no match → null');
    });

    test('findMatchingPr tolerates null/empty PR lists', function() {
        var mod = loadBitriseTrigger();
        assert.equal(mod.findMatchingPr(null, 'TS-1'), null);
        assert.equal(mod.findMatchingPr([], 'TS-1'), null);
    });
});
