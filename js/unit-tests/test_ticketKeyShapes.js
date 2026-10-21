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

suite('ticketKeyShapes.inputFolderNameFor — twin of the runtime input folder name', function () {
    var shapes = loadModule('js/common/ticketKeyShapes.js');

    test('a composite GitHub key becomes the router key', function () {
        assert.equal(shapes.inputFolderNameFor('acme/widgets#12'), 'gh-12');
        assert.equal(shapes.inputFolderNameFor('my.org/my-repo_2#7'), 'gh-7');
    });

    test('other keys keep letters, digits, dot, underscore and dash; anything else becomes a dash', function () {
        assert.equal(shapes.inputFolderNameFor('PROJ-123'), 'PROJ-123');
        assert.equal(shapes.inputFolderNameFor('gh-5'), 'gh-5');
        assert.equal(shapes.inputFolderNameFor('#12'), '-12');
        assert.equal(shapes.inputFolderNameFor('a b/c'), 'a-b-c');
    });

    // Expected values were produced by running the Java runtime's
    // CliExecutionHelper.toInputFolderName on each key (epam/dm.ai,
    // dmtools-core/src/main/java/com/github/istin/dmtools/teammate/CliExecutionHelper.java).
    // If that method changes, regenerate this table from it: the JS twin must stay byte-identical.
    var JAVA_PARITY = [
        ['ABC-12', 'ABC-12'],                         // Jira
        ['4567', '4567'],                             // ADO numeric id
        ['owner/repo#5', 'gh-5'],                     // GitHub composite key
        ['Owner.Repo/x-y#5', 'gh-5'],
        ['gh-9', 'gh-9'],                             // router key
        ['#12', '-12'],
        ['12', '12'],
        ['a/b#c', 'a-b-c'],                           // non-numeric issue part: not composite
        ['PROJ 123', 'PROJ-123'],                     // space
        ['Ünïcode-1', '-n-code-1'],         // Latin-1 letters
        ['日本-7', '---7'],                   // CJK
        ['PROJ-😀-1', 'PROJ---1'],          // emoji (surrogate pair) becomes one '-'
        ['é-1', 'e--1'],                        // combining mark
        ['owner/repo#5\n', 'owner-repo-5-'],          // trailing newline: not composite
        ['owner/re po#5', 'owner-re-po-5'],           // space in repo: not composite
        ['ownér/repo#5', 'own-r-repo-5'],        // non-ASCII owner: Java \w is ASCII-only
        ['standalone', 'standalone']
    ];

    JAVA_PARITY.forEach(function (row) {
        test('parity with Java toInputFolderName: ' + JSON.stringify(row[0]), function () {
            assert.equal(shapes.inputFolderNameFor(row[0]), row[1]);
        });
    });
});

suite('ticketKeyShapes.inputFolderCandidates — folder chain for post-actions', function () {
    var shapes = loadModule('js/common/ticketKeyShapes.js');

    test('explicit folder, then the Java-derived folder, then the legacy input/<ticketKey>', function () {
        assert.deepEqual(shapes.inputFolderCandidates('/w/input/gh-5', 'acme/widgets#5'),
            ['/w/input/gh-5', 'input/gh-5', 'input/acme/widgets#5']);
    });

    test('no explicit folder', function () {
        assert.deepEqual(shapes.inputFolderCandidates(null, 'acme/widgets#5'),
            ['input/gh-5', 'input/acme/widgets#5']);
    });

    test('duplicates collapse when the key needs no sanitizing', function () {
        assert.deepEqual(shapes.inputFolderCandidates(undefined, 'PROJ-1'), ['input/PROJ-1']);
        assert.deepEqual(shapes.inputFolderCandidates('input/PROJ-1', 'PROJ-1'), ['input/PROJ-1']);
    });
});
