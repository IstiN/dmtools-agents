/**
 * Unit tests for js/common/prLookup.js — the PR↔ticket lookup family
 * deduplicated by gh-1249: prMentionsTicket (recoverMergedPRTicket.js and
 * checkBugTestsPassedHelpers.js had verbatim copies) and findOpenPrForTicket
 * (recoverStuckDevelopment.js / recoverStuckTestCase.js / retryMergePR.js
 * inlined the same listPrs('open') + title/branch match + fail-closed
 * console.error block).
 */

var assert = globalThis.assert;

var prLookup = loadModule('js/common/prLookup.js', makeRequire({}), {});

function pr(extra) {
    var base = { number: 1, title: 'gh-1 thing', head: { ref: 'ai/gh-1' } };
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) base[k] = extra[k]; } }
    return base;
}

// ── prMentionsTicket ─────────────────────────────────────────────────────────

suite('prLookup prMentionsTicket', function () {
    test('matches on title or head branch substring', function () {
        assert.equal(prLookup.prMentionsTicket(pr(), 'gh-1'), true);
        assert.equal(prLookup.prMentionsTicket(pr({ title: 'unrelated', head: { ref: 'ai/gh-1-x' } }), 'gh-1'), true);
        assert.equal(prLookup.prMentionsTicket(pr({ title: 'gh-10', head: { ref: 'main' } }), 'gh-1'), true); // substring contract
    });

    test('no match → false; null pr or key → false (never throws)', function () {
        assert.equal(prLookup.prMentionsTicket(pr({ title: 'x', head: { ref: 'y' } }), 'gh-1'), false);
        assert.equal(prLookup.prMentionsTicket(null, 'gh-1'), false);
        assert.equal(prLookup.prMentionsTicket(pr(), null), false);
        assert.equal(prLookup.prMentionsTicket({ title: null, head: null }, 'gh-1'), false);
    });

    test('result is a strict boolean', function () {
        assert.equal(prLookup.prMentionsTicket(pr({ title: 'gh-1', head: { ref: 'x' } }), 'gh-1'), true);
        assert.strictEqual ? assert.strictEqual(prLookup.prMentionsTicket(pr(), 'nope'), false) : null;
    });
});

// ── findOpenPrForTicket ──────────────────────────────────────────────────────

suite('prLookup findOpenPrForTicket', function () {
    test('returns the FIRST open PR whose title or branch mentions the key', function () {
        var scm = { listPrs: function () { return [pr({ number: 1, title: 'x', head: { ref: 'dev' } }), pr({ number: 2 })]; } };
        var hit = prLookup.findOpenPrForTicket(scm, 'gh-1');
        assert.equal(hit.number, 2);
    });

    test('no match / empty list / non-array list → null', function () {
        var scm = { listPrs: function () { return [pr({ title: 'x', head: { ref: 'y' } })]; } };
        assert.equal(prLookup.findOpenPrForTicket(scm, 'gh-1'), null);
        assert.equal(prLookup.findOpenPrForTicket({ listPrs: function () { return []; } }, 'gh-1'), null);
        assert.equal(prLookup.findOpenPrForTicket({ listPrs: function () { return null; } }, 'gh-1'), null);
    });

    test('listPrs failure logs the shared line and fails closed to null', function () {
        var logged = [];
        var origError = console.error;
        console.error = function (msg, err) { logged.push([msg, err && err.message]); };
        var scm = { listPrs: function () { throw new Error('api down'); } };
        var result;
        try {
            result = prLookup.findOpenPrForTicket(scm, 'gh-1');
        } finally {
            console.error = origError;
        }
        assert.equal(result, null);
        assert.equal(logged.length, 1);
        assert.equal(logged[0][0], 'Failed to list PRs:');
        assert.equal(logged[0][1], 'api down');
    });
});
