/**
 * Check-run stamp transport (gh-1107).
 *
 * stampValidationChecksForModule used to build
 * `gh api -X POST .../check-runs -f summary="<jobs table>"` as a shell
 * string with run-derived values inside double quotes. A dispatched run
 * with a job named `Lockfile smoke (${{ matrix.os }} release)` made
 * /bin/sh (dash) see `${{ ... }}` → `Bad substitution`, exit 2, and NO
 * stamp was written — the required checks stayed "expected" and the PR
 * stayed BLOCKED (live 2026-10-19 17:15, factory #510 bridge-free mode).
 * Any `$`, backtick, `"` or `\` in a job name, title, summary or details
 * URL was shell-interpreted, and job names come from repo workflow files
 * a PR can edit — an injection surface, not just a quoting bug.
 *
 * Contract (ticket gh-1107):
 *   - the request body (`{name, head_sha, status, conclusion?, details_url?,
 *     output:{title, summary}}`) is JSON, written to a temp file and posted
 *     with `gh api -X POST repos/{o}/{r}/check-runs --input <file>`; the
 *     file is deleted in `finally` (the scm.js gh-960 PR-body precedent);
 *   - invariant: ZERO untrusted bytes inside the shell command string —
 *     only the fixed repo path and the temp-file path ever reach the shell;
 *   - E1: a summary past GitHub's 65,535-char output limit is truncated
 *     with a marker, not rejected;
 *   - E2: an unwritable temp dir throws through to the caller's per-stamp
 *     warn-and-skip — today's failure mode, unchanged;
 *   - the single shellQuote helper (AC5 audit) is re-exported from
 *     factory/token_usage.js so every converted call site shares ONE
 *     escaping implementation.
 *
 * Pure module: the transport takes { write, exec, del } capturers
 * (factoryState.js convention) so tests mock the IO without any global.
 * Every require is load-time (gh-823 pack contract).
 */

var shellQuote = require('../factory/token_usage.js').shellQuote;

// GitHub Checks API output.summary hard limit — past it the API rejects
// the whole stamp. Truncate instead (E1), the marker tells the reader why.
var SUMMARY_CHAR_LIMIT = 65535;
var SUMMARY_TRUNCATION_MARKER = '\n…[truncated — GitHub 65,535-char output.summary limit (gh-1107)]';

/** E1: cap output.summary at the API limit, marker last, never reject. */
function truncateCheckRunSummary(summary) {
    var s = (summary === null || summary === undefined) ? '' : String(summary);
    if (s.length <= SUMMARY_CHAR_LIMIT) return s;
    var room = SUMMARY_CHAR_LIMIT - SUMMARY_TRUNCATION_MARKER.length;
    if (room < 0) room = 0;
    return s.slice(0, room) + SUMMARY_TRUNCATION_MARKER;
}

/**
 * The create-check-run request body. `conclusion` / `details_url` ride
 * along only when present (an in_progress stamp carries neither).
 */
function buildCheckRunBody(o) {
    var body = {
        name: String(o.name),
        head_sha: String(o.headSha),
        status: String(o.status),
        output: {
            title: String(o.title),
            summary: truncateCheckRunSummary(o.summary)
        }
    };
    if (o.conclusion) body.conclusion = String(o.conclusion);
    if (o.detailsUrl) body.details_url = String(o.detailsUrl);
    return body;
}

/** Temp-file path: /tmp prefix + numeric suffixes ONLY — the one thing
 * besides the fixed repo path allowed inside the shell command string. */
function tempBodyPath(now, seq) {
    return '/tmp/sm-check-run-' + Number(now) + '-' + Number(seq) + '.json';
}

/** The whole shell surface of a stamp: repo path + temp path, nothing else. */
function stampCommand(repoInfo, tempPath) {
    return 'gh api -X POST repos/' + repoInfo.owner + '/' + repoInfo.repo +
           '/check-runs --input ' + tempPath;
}

/**
 * Write the body to the temp file, post it, delete the file in `finally`
 * (AC3 — on success AND failure). Throws through to the caller so E2
 * (unwritable temp dir) degrades exactly like a failed gh call: warn and
 * skip. A throwing cleanup never masks the outcome.
 */
function postCheckRunStamp(repoInfo, body, tempPath, io) {
    var posted = false;
    try {
        io.write({ path: tempPath, content: JSON.stringify(body) });
        io.exec({ command: stampCommand(repoInfo, tempPath) });
        posted = true;
    } finally {
        try { io.del({ path: tempPath }); } catch (eDel) { /* best-effort cleanup */ }
    }
    return posted;
}

module.exports = {
    shellQuote: shellQuote,
    SUMMARY_CHAR_LIMIT: SUMMARY_CHAR_LIMIT,
    SUMMARY_TRUNCATION_MARKER: SUMMARY_TRUNCATION_MARKER,
    truncateCheckRunSummary: truncateCheckRunSummary,
    buildCheckRunBody: buildCheckRunBody,
    tempBodyPath: tempBodyPath,
    stampCommand: stampCommand,
    postCheckRunStamp: postCheckRunStamp
};
