/**
 * Factory mark-job-done — issue task-list job marker (owner directive
 * 2026-10-13: factory glue moves into dmtools-agents as JS agent code; awf
 * workflows become thin callers).
 *
 * JS port of the awf factory-teammate.yml step «Mark machine job done
 * (issue task list)» — byte-extracted into scripts/mark-job-done.sh by
 * IstiN/dmtools-agentic-workflows#34. Behavior contract is identical:
 *
 *   1. mark = JOB_RESULT mapping: success→✅ failure→❌ cancelled→🚫
 *      else→"⚠️ <JOB_RESULT>" (unset → "⚠️ ", the sh case-* fallback).
 *   2. end = UTC HH:MM.
 *   3. Body is fetched with `gh issue view N --repo R --json body -q .body`.
 *   4. Every line that CONTAINS "(<RUN_URL>)" (literal needle — awk
 *      index()) AND starts with the two-checkbox prefix "- [ ]" is
 *      processed: the flip sub `^- \[ \] ` (note the trailing space — the
 *      guard has none) turns it into "- [x] ", and if the line matches
 *      /started \d\d:\d\d/ the tail from the FIRST match of
 *      /started \d\d:\d\d .*$/ is replaced with "<st> · done <end> <mark>"
 *      where <st> comes from match() — possibly an EARLIER occurrence than
 *      the one the replace hits (awk sub/match independence, kept
 *      byte-identical; see the parity harness). A line whose checkbox has
 *      no trailing space therefore gains the done tail WITHOUT flipping —
 *      exactly like the sh under cmp -s (change detection, not intent).
 *   5. Changed body → written to the temp file and pushed with
 *      `gh issue edit N --repo R --body-file <tmp>`, logging
 *      "job marker flipped to [x] <mark>".
 *      Unchanged body → "::warning::start marker not found for <RUN_URL> —
 *      nothing to flip". (The sh compares with cmp -s; flipped>0 here is
 *      "some line changed", which is equivalent.)
 *
 * Error contract: gh failures PROPAGATE (the sh dies under `bash -e` —
 * the step runs under always() and a dead marker flip must redden).
 *
 * Env/file contract (the sh step's env block; the JSRunner entry reads
 * jobParams.customParams first, these env names as fallback):
 *   NUMBER            issue with the task list
 *   RUN_URL           the run's URL; its "(url)" needle marks the line
 *   JOB_RESULT        success | failure | cancelled | <other>
 *   GITHUB_REPOSITORY owner/repo of the issue
 *   (tempPath)        where the edited body is staged before --body-file
 *                     (sh: /tmp/issue_body_new.md)
 *
 * Pure functions carry no IO: markJobDone takes { exec, writeFile, clock,
 * log } capturers (factoryState.js convention) so tests mock the transport
 * via loadModule without touching any global.
 */

var DEFAULT_TEMP_PATH = '/tmp/issue_body_new.md';

var STARTED_RE = /started [0-9][0-9]:[0-9][0-9]/;
// [\s\S] = awk's `.`: consumes \r (CRLF records) where JS `.` would
// stop — parity-harness finding #13/#18/#20.
var STARTED_TAIL_RE = /started [0-9][0-9]:[0-9][0-9] [\s\S]*$/;
var FLIP_RE = /^- \[ \] /;

// ── pure helpers ─────────────────────────────────────────────────────────────

/** JOB_RESULT → marker emoji, exactly the sh case statement. */
function markFor(jobResult) {
    if (jobResult === 'success') return '✅';
    if (jobResult === 'failure') return '❌';
    if (jobResult === 'cancelled') return '🚫';
    return '⚠️ ' + (jobResult == null ? '' : jobResult);
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** UTC HH:MM — the sh `date -u '+%H:%M'`. */
function utcHHMM(d) {
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

/**
 * The awk port (parity core). Returns { body, flipped } where flipped
 * counts lines whose text actually changed (cmp -s equivalence).
 */
function flipTaskListItems(body, runUrl, mark, endTs) {
    var needle = '(' + runUrl + ')';
    var lines = String(body == null ? '' : body).split('\n');
    var flipped = 0;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        // awk: index($0, url) > 0 && $0 ~ /^- \[ \]/  (no trailing space)
        if (line.indexOf(needle) !== -1 && line.indexOf('- [ ]') === 0) {
            var next = line.replace(FLIP_RE, '- [x] ');
            var m = next.match(STARTED_RE);
            if (m) {
                // awk: st from match() on the flipped copy; sub() replaces
                // the first occurrence of the FULL tail pattern (which may
                // be a later "started HH:MM" than the one match() found).
                // Function replacement: the text lands verbatim.
                var st = m[0];
                next = next.replace(STARTED_TAIL_RE, function () {
                    return st + ' · done ' + endTs + ' ' + mark;
                });
            }
            if (next !== line) flipped++;
            lines[i] = next;
        }
    }
    var out = lines.join('\n');
    // awk `{ print }` terminates EVERY record with ORS — a non-empty body
    // whose last line lacks the trailing newline still comes out with one
    // (parity-harness finding #12/#19). The sh pipeline always lands there:
    // `gh --jq .body` prints a trailing newline and awk re-adds it.
    if (out !== '' && out.charAt(out.length - 1) !== '\n') out += '\n';
    return { body: out, flipped: flipped };
}

// ── orchestration (capturer-injected) ────────────────────────────────────────

/**
 * Marks the run's task-list item done. opts: { repo, number, runUrl,
 * jobResult, endTs?, tempPath? }; io: { exec, writeFile, clock, log }.
 * Returns { status: 'flipped'|'no-marker', mark, flipped, endTs }.
 */
function markJobDone(opts, io) {
    opts = opts || {};
    io = io || {};
    var repo = opts.repo;
    var number = opts.number;
    var runUrl = opts.runUrl;
    var mark = markFor(opts.jobResult);
    var endTs = opts.endTs ||
        utcHHMM(io.clock ? io.clock() : new Date());
    var log = io.log || function () {};

    var body = io.exec('gh issue view ' + number + ' --repo ' + repo +
        ' --json body -q .body');
    var r = flipTaskListItems(body, runUrl, mark, endTs);
    if (r.flipped > 0) {
        var tempPath = opts.tempPath || DEFAULT_TEMP_PATH;
        io.writeFile(tempPath, r.body);
        io.exec('gh issue edit ' + number + ' --repo ' + repo +
            ' --body-file ' + tempPath);
        log('job marker flipped to [x] ' + mark);
        return { status: 'flipped', mark: mark, flipped: r.flipped, endTs: endTs };
    }
    log('::warning::start marker not found for ' + runUrl + ' — nothing to flip');
    return { status: 'no-marker', mark: mark, flipped: 0, endTs: endTs };
}

module.exports = {
    markFor: markFor,
    utcHHMM: utcHHMM,
    flipTaskListItems: flipTaskListItems,
    markJobDone: markJobDone,
    DEFAULT_TEMP_PATH: DEFAULT_TEMP_PATH
};
