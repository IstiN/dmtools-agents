/**
 * Unit tests for js/common/ticketKeyShapes.js — the single owner of the
 * GitHub issue key-shape convention (gh-770).
 *
 * The convention was previously synchronized across four regex lists
 * (commentMarkup.js, validateInputJql.js's local copy, validateInputJql.js's
 * inline extraction alternation and trackers.js's githubIssueNumber). These
 * tests pin the shared owner AND the derivation contracts: consumers must
 * take their shape list from here, so adding a shape is a one-line change
 * in one file.
 *
 * Uses: loadModule(), assert, test(), suite()
 */
/* global loadModule, assert, test, suite */

function loadTicketKeyShapes() {
    return loadModule('js/common/ticketKeyShapes.js');
}

// ── isGitHubKeyShape ──────────────────────────────────────────────────────────

suite('ticketKeyShapes: isGitHubKeyShape', function () {

    test('accepts every documented GitHub key shape', function () {
        var shapes = loadTicketKeyShapes();
        assert.equal(shapes.isGitHubKeyShape('gh-1308'), true);
        assert.equal(shapes.isGitHubKeyShape('GH-1308'), true);   // case-insensitive router key
        assert.equal(shapes.isGitHubKeyShape('acme/widgets#12'), true);
        assert.equal(shapes.isGitHubKeyShape('#12'), true);
        assert.equal(shapes.isGitHubKeyShape('12'), true);
    });

    test('rejects Jira keys and junk', function () {
        var shapes = loadTicketKeyShapes();
        assert.equal(shapes.isGitHubKeyShape('PROJ-123'), false);
        assert.equal(shapes.isGitHubKeyShape('gh-abc'), false);
        assert.equal(shapes.isGitHubKeyShape('gh-'), false);
        assert.equal(shapes.isGitHubKeyShape('#'), false);
        assert.equal(shapes.isGitHubKeyShape(''), false);
        assert.equal(shapes.isGitHubKeyShape(null), false);
        assert.equal(shapes.isGitHubKeyShape(undefined), false);
        assert.equal(shapes.isGitHubKeyShape('key = gh-12'), false); // full JQL is not a key
    });

});

// ── githubIssueNumberIn ───────────────────────────────────────────────────────

suite('ticketKeyShapes: githubIssueNumberIn', function () {

    test('extracts the issue number from every GitHub key shape', function () {
        var shapes = loadTicketKeyShapes();
        assert.equal(shapes.githubIssueNumberIn('gh-1308'), 1308);
        assert.equal(shapes.githubIssueNumberIn('GH-7'), 7);
        assert.equal(shapes.githubIssueNumberIn('acme/widgets#12'), 12);
        assert.equal(shapes.githubIssueNumberIn('#12'), 12);
        assert.equal(shapes.githubIssueNumberIn('12'), 12);
    });

    test('returns null for non-GitHub keys', function () {
        var shapes = loadTicketKeyShapes();
        assert.equal(shapes.githubIssueNumberIn('PROJ-123'), null);
        assert.equal(shapes.githubIssueNumberIn(''), null);
        assert.equal(shapes.githubIssueNumberIn(null), null);
    });

});

// ── shapeSources (extraction alternation derivation) ─────────────────────────

suite('ticketKeyShapes: shapeSources', function () {

    test('yields anchored-stripped fragments in list order', function () {
        var shapes = loadTicketKeyShapes();
        var sources = shapes.shapeSources();
        assert.equal(sources.length, shapes.GITHUB_KEY_SHAPES.length);
        // gh-N before bare N — extraction must prefer the router key so the
        // original case survives (extractTicketKeyFromJql contract).
        assert.equal(sources[0], 'gh-\\d+');
        assert.equal(sources[sources.length - 1], '\\d+');
        for (var i = 0; i < sources.length; i++) {
            assert.equal(/^\^|\$$/.test(sources[i]), false, 'fragment ' + i + ' still anchored: ' + sources[i]);
        }
    });

    test('fragments reassemble into a working alternation', function () {
        var shapes = loadTicketKeyShapes();
        var re = new RegExp('(' + shapes.shapeSources().join('|') + ')', 'i');
        assert.equal(re.exec('key = gh-12')[1], 'gh-12');
        assert.equal(re.exec('key = acme/w#12')[1], 'acme/w#12');
        assert.equal(re.exec('key = #12')[1], '#12');
        assert.equal(re.exec('key = 12')[1], '12');
        assert.equal(re.exec('key = gh-abc'), null);
    });

});
