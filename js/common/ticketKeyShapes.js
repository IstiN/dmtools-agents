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
 *   - pushReworkChanges input folder → inputFolderNameFor(key)
 *   - post-action input folder chain → inputFolderCandidates(explicit, key)
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

/**
 * Name of the input/ subfolder dmtools creates for a ticket's run — the JS twin
 * of the runtime's CliExecutionHelper.toInputFolderName. A composite GitHub key
 * (acme/widgets#12) becomes the router key gh-12; any other key keeps its
 * letters, digits, '.', '_' and '-' and has every other character replaced by
 * '-'. Pre-CLI actions receive the real folder as params.inputFolderPath, but
 * post-actions do not, so a post-action that reads input/<ticketKey>/ looks in
 * a folder that does not exist for a GitHub ticket.
 *
 * Must stay byte-identical to the Java runtime:
 *   https://github.com/epam/dm.ai/blob/main/dmtools-core/src/main/java/com/github/istin/dmtools/teammate/CliExecutionHelper.java
 *   (CliExecutionHelper.toInputFolderName, pinned by CliExecutionHelperTest)
 * The parity table in js/unit-tests/test_ticketKeyShapes.js carries values
 * produced by that Java method; change both sides together. The 'u' flag makes
 * a character outside the BMP (an emoji) one '-' like Java's code-point regex,
 * not two for its surrogate halves.
 *
 * The Dart runtime does not sanitize: teammate_job.dart pins
 * metadata.contextId to the raw ticket key and CliAgent creates
 * input/<contextId>/ —
 *   https://github.com/epam/dmtools-dart/blob/main/lib/src/agents/teammate_job.dart
 *   https://github.com/epam/dmtools-dart/blob/main/lib/src/agents/cli_agent.dart
 * so a reader also tries the legacy input/<ticketKey>/ (inputFolderCandidates).
 * @param {string} ticketKey
 * @returns {string}
 */
function inputFolderNameFor(ticketKey) {
    var k = String(ticketKey == null ? '' : ticketKey);
    var composite = /^[\w.-]+\/[\w.-]+#(\d+)$/.exec(k);
    if (composite) return 'gh-' + composite[1];
    return k.replace(/[^A-Za-z0-9._-]/gu, '-');
}

/**
 * Candidate input/ folders for a ticket's run, most specific first and without
 * duplicates: the folder the runtime passed (explicitFolder), the Java
 * runtime's input/<inputFolderNameFor(key)>, then the legacy input/<ticketKey>
 * that the Dart runtime and older runtimes create. A reader takes the first
 * candidate that holds the file it needs.
 * @param {string|null} explicitFolder
 * @param {string} ticketKey
 * @returns {string[]}
 */
function inputFolderCandidates(explicitFolder, ticketKey) {
    var out = [];
    var all = [explicitFolder, 'input/' + inputFolderNameFor(ticketKey), 'input/' + ticketKey];
    for (var i = 0; i < all.length; i++) {
        if (all[i] && out.indexOf(all[i]) === -1) out.push(all[i]);
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GITHUB_KEY_SHAPES: GITHUB_KEY_SHAPES,
        isGitHubKeyShape: isGitHubKeyShape,
        githubIssueNumberIn: githubIssueNumberIn,
        shapeSources: shapeSources,
        inputFolderNameFor: inputFolderNameFor,
        inputFolderCandidates: inputFolderCandidates
    };
}
