/**
 * Single owner of the GitHub issue key-shape convention (gh-770).
 *
 * The machine loop keys GitHub-backed tickets with these shapes:
 *   gh-N           — the router key convention (gh-1308)
 *   owner/repo#N   — composite form (acme/widgets#12)
 *   #N             — bare-hash form (dispatch payloads)
 *   N              — bare issue number
 *
 * This list was previously synchronized by hand across four regex lists
 * (commentMarkup flavor detection, validateInputJql's gate and its inline
 * extraction alternation, trackers.js's issue-number parser). Drift surfaced
 * only as a live leg silently losing its tracker updates — exactly the bug
 * class gh-770 fixes — so every consumer now derives from THIS module:
 *
 *   - commentMarkup.flavorForTicket  → isGitHubKeyShape(key)
 *   - validateInputJql gate          → isGitHubKeyShape(key)
 *   - validateInputJql extraction    → shapeSources() alternation
 *   - trackers.js githubIssueNumber  → githubIssueNumberIn(key)
 *
 * Adding a shape is a one-line change here; the derivation is pinned by
 * js/unit-tests/test_ticketKeyShapes.js plus per-consumer derivation tests.
 *
 * GraalJS-compatible: var declarations, plain functions, no arrow functions.
 */
'use strict';

// Ordered is-shape list — also the extraction order: gh-N before bare N so a
// router key keeps its original case (uppercasing would mint 'GH-12', a key
// different from the 'gh-12' the machine loop created), and composite forms
// before bare numbers.
var GITHUB_KEY_SHAPES = [
    /^gh-\d+$/i,               // gh-1308 — GitHub router key convention
    /^[\w.-]+\/[\w.-]+#\d+$/,  // acme/widgets#12
    /^#\d+$/,                  // #12
    /^\d+$/                    // 12
];

// The same shapes with the numeric issue part captured, in the SAME order —
// trackers.js parses issue numbers from this list so a key that passes the
// is-shape check can never die with "cannot parse GitHub issue key".
var GITHUB_KEY_CAPTURE_SHAPES = [
    /^gh-(\d+)$/i,
    /^[\w.-]+\/[\w.-]+#(\d+)$/,
    /^#(\d+)$/,
    /^(\d+)$/
];

/**
 * True when the key matches one of the GitHub issue key shapes.
 * Null/undefined/empty are not shapes.
 * @param {string} key
 * @returns {boolean}
 */
function isGitHubKeyShape(key) {
    var k = String(key == null ? '' : key).trim();
    for (var i = 0; i < GITHUB_KEY_SHAPES.length; i++) {
        if (GITHUB_KEY_SHAPES[i].test(k)) return true;
    }
    return false;
}

/**
 * Parse the numeric GitHub issue number out of any GitHub-shaped key.
 * @param {string} key
 * @returns {number|null} the issue number, or null when the key is not a
 *                        GitHub key shape
 */
function githubIssueNumberIn(key) {
    var k = String(key == null ? '' : key).trim();
    for (var i = 0; i < GITHUB_KEY_CAPTURE_SHAPES.length; i++) {
        var m = GITHUB_KEY_CAPTURE_SHAPES[i].exec(k);
        if (m) return parseInt(m[1], 10);
    }
    return null;
}

/**
 * Anchor-stripped source fragments of the shape list, in order, for building
 * inline alternations — e.g. validateInputJql extracts the ticket key from a
 * JQL string with `new RegExp('key\\s*(?:=|in\\s*\\()\\s*(' +
 * shapeSources().join('|') + ')', 'i')`, keeping the alternation derived
 * instead of copy-pasted.
 * @returns {string[]}
 */
function shapeSources() {
    var out = [];
    for (var i = 0; i < GITHUB_KEY_SHAPES.length; i++) {
        out.push(GITHUB_KEY_SHAPES[i].source.replace(/^\^/, '').replace(/\$$/, ''));
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GITHUB_KEY_SHAPES: GITHUB_KEY_SHAPES,
        isGitHubKeyShape: isGitHubKeyShape,
        githubIssueNumberIn: githubIssueNumberIn,
        shapeSources: shapeSources
    };
}
