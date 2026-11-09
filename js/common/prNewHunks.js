/**
 * prNewHunks.js — the diff-of-diff input for re-review rounds (gh-1404).
 *
 * Pathology (gh-1404): every review round re-exposed ALL old code ("read the
 * full content of every changed file") under a maximum-recall instruction,
 * so findings landed on already-reviewed lines and each rework lap minted new
 * findings on its own fix. The frozen-code rule: a re-review round reviews
 * the hunks added since the last reviewed head (the diff-of-diff) plus their
 * interaction neighborhood; unchanged lines are frozen — a finding there
 * requires the new hunks to make it worse, otherwise it is advisory digest
 * only.
 *
 * The last reviewed head is the head of the newest machine verdict record on
 * the PR (reviewVerdicts, gh-807): a review leg concluded at that head.
 * Pure module — no dmtools globals; preparePRForReview feeds it comment
 * payloads and the current head sha. Keep it GraalJS-clean (var + plain
 * functions, JSON-safe data only).
 */
'use strict';

var machineAuthor = require('./machineAuthor.js');
var reviewVerdicts = require('./reviewVerdicts.js');

/**
 * The head sha the newest trusted verdict record was rendered on — the last
 * reviewed head — or null when no trusted record exists (first review round;
 * free-form review text is never consulted). opts carries the machineAuthor
 * allowlist ({ authorLogins: [...] }); records from any other identity are
 * invisible.
 */
function lastReviewedHead(comments, opts) {
    var records = reviewVerdicts.parseVerdictRecords(comments, opts);
    if (!records.length) return null;
    return records[records.length - 1].head;
}

/**
 * Prefix-aware head equality (same rule as latestVerdictForHead): exact
 * match, or one sha being a >=7-char prefix of the other.
 */
function sameHead(a, b) {
    if (!a || !b) return false;
    var x = String(a);
    var y = String(b);
    if (x === y) return true;
    if (x.length >= 7 && y.indexOf(x) === 0) return true;
    if (y.length >= 7 && x.indexOf(y) === 0) return true;
    return false;
}

/**
 * The re-review precondition: true only when BOTH heads exist and differ.
 * A missing side is never a diff — a first round (no verdict record) or an
 * unknown current head reviews the full PR diff as before.
 */
function headsDiffer(lastHead, currentHead) {
    return !!lastHead && !!currentHead && !sameHead(lastHead, currentHead);
}

function shortSha(sha) {
    var s = String(sha || '');
    return s.length > 10 ? s.substring(0, 10) : s;
}

/**
 * Renders pr_new_hunks.txt: a short header carrying the frozen-lines
 * contract (so the decision rule is cheap to follow at review time) followed
 * by the raw delta between the two heads.
 */
function buildNewHunksFile(lastHead, currentHead, diff) {
    var lines = [
        '# PR new hunks — what changed since the last review concluded',
        '',
        'Last reviewed head: ' + shortSha(lastHead),
        'Current head: ' + shortSha(currentHead),
        '',
        'These hunks are the re-review scope, together with their interaction',
        'neighborhood (direct callers/callees of changed symbols). Every line',
        'NOT shown here is frozen: a finding on an unchanged line must show that',
        'these hunks make the problem worse (the interaction test) — otherwise',
        'it is advisory digest only, never a review thread.',
        '',
        '--- diff ---',
        '',
        String(diff || '')
    ];
    return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        lastReviewedHead: lastReviewedHead,
        sameHead: sameHead,
        headsDiffer: headsDiffer,
        buildNewHunksFile: buildNewHunksFile
    };
}
