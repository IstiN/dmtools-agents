/**
 * ciViolations.js — gate-violation extraction from raw CI job logs (gh-1119).
 *
 * Live pathology (dmtools-dart PR #433, rework run 39308030238): the gate
 * (crap4dart) failed with one violation in a file the PR itself added. The
 * violation line was present in ci_failures_full.log and inside the last
 * 500-line tail of ci_failures.md — but buried among 686 raw log lines x 5
 * checks. The rework leg's grep matched only the "[FAIL]" header, missed the
 * indented detail line, concluded "violation is in code the PR does not
 * touch", pushed without fixing, and even classified a genuinely unrelated
 * red as the same "infra" bucket.
 *
 * The fix is context assembly, not a smarter model:
 *   1. extractViolations() pulls every recognizable violation line out of the
 *      raw job logs (pure, deterministic — I2);
 *   2. tagOwnership() classifies each violation owned/foreign/unknown against
 *      the PR diff file list (owned = the file appears in the diff, old and
 *      new rename paths both count — E1);
 *   3. buildViolationsMarkdown() renders the "Violations you must fix (N
 *      owned)" table that opens ci_failures.md, followed by the "Foreign /
 *      infra reds (do not chase)" list. The raw 500-line tails stay below as
 *      evidence — extraction never drops the raw logs (I1);
 *   4. validateOwnedViolationsSummary() is the post-rework half: a fix
 *      summary that dismisses a red as "not caused by this PR"/"unrelated"
 *      while owned items are open is rejected (UT-8).
 *
 * Degradation (I3): an unknown log shape yields no violations, so
 * detectFailedChecks assembles today's ci_failures.md unchanged — never an
 * empty file, never a made-up item.
 *
 * Pure module — no dmtools globals. Keep it GraalJS-clean (var + plain
 * functions, JSON-safe data only).
 */
'use strict';

// E2: the ci_failures.md tables cap at 50 rows; the full uncapped list goes
// to ci_violations.json.
var MAX_TABLE_ROWS = 50;

// Max rendered length of one table cell (detail column) — logs can be noisy.
var MAX_CELL_LEN = 200;

// Blanket-dismissal phrases a fix summary may not use while owned violations
// are open (gh-1119 #433: "violation is in code the PR does not touch",
// "both reds classified as infra"). A per-item "disputed: <reason>" line is
// the structured alternative — see validateOwnedViolationsSummary.
var DISMISSAL_PATTERNS = [
    /not caused by (?:this|the) pr/i,
    /unrelated to (?:this|the) pr/i,
    /\bunrelated\b/i,
    /not related to (?:this|the) pr/i,
    /not introduced by (?:this|the) pr/i,
    /not touched by (?:this|the) pr/i,
    /pr does not touch/i,
    /pre-?existing (?:issue|failure|violation|red)/i,
    /\b(?:classified|marked|categorized|labelled|labeled)\s+as\s+(?:a\s+|an\s+|pure\s+)?infra\b/i,
    /\b(?:is|are)\s+(?:pure\s+)?infra\b/i
];

// Summary section headings that scope the dismissal scan (review leg
// 2026-10-20, thread PRT_kwDORYAuYs6uJ0zj): a claim inside a foreign-reds
// section describes a red the rework leg was TOLD to mention — it is not a
// dismissal of owned work. Only claims in owned/default scope (and never on
// fixed/disputed accounting lines) reject.
var FOREIGN_SECTION_HEADING = /^#{1,6}\s+.*(?:foreign|infra|do not chase|not chase)/i;
var OWNED_SECTION_HEADING = /^#{1,6}\s+.*(?:violations you must fix|\bowned\b)/i;

// ── path normalization (E3) ──────────────────────────────────────────────────

/**
 * Normalize one path for cross-source comparison: strip wrapping quotes,
 * unify Windows separators, drop "./"-style prefixes and Windows drive
 * letters. "./lib/x.dart", ".\lib\x.dart" and "C:\repo\lib\x.dart" all land
 * on comparable shapes.
 */
function normalizePath(p) {
    var s = String(p === null || p === undefined ? '' : p).trim();
    if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
        s = s.substring(1, s.length - 1).trim();
    }
    s = s.replace(/\\/g, '/');
    while (s.substring(0, 2) === './') {
        s = s.substring(2);
    }
    s = s.replace(/^[A-Za-z]:\//, '');
    return s;
}

/** True when a violation path refers to the same file as a diff path. */
function sameFile(violationPath, diffPath) {
    var v = normalizePath(violationPath);
    var d = normalizePath(diffPath);
    if (!v || !d) return false;
    if (v === d) return true;
    return v.length > d.length + 1 && v.substring(v.length - d.length - 1) === '/' + d;
}

/** Add one diff-header path (old+new of the `diff --git` line) to the set. */
function addDiffHeaderPaths(add, line) {
    var m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
        add(m[1]);
        add(m[2]);
    }
}

/** Add `--- a/<old>` / `+++ b/<new>` paths; /dev/null sides are skipped. */
function addDiffTargetPath(add, line) {
    var m = line.match(/^--- (?:(?:a\/)?(.+))$/);
    if (m && m[1] !== '/dev/null') {
        add(m[1]);
        return;
    }
    m = line.match(/^\+\+\+ (?:(?:b\/)?(.+))$/);
    if (m && m[1] !== '/dev/null') {
        add(m[1]);
    }
}

/**
 * Repo-root-relative file paths touched by a PR diff — old AND new names
 * (E1: a violation in a renamed file is still owned via the old path).
 * Handles `diff --git a/.. b/..` headers, `---`/`+++` lines, rename from/to
 * markers; /dev/null entries are skipped.
 */
function parseDiffPaths(diffText) {
    if (!diffText) return [];
    var seen = {};
    var out = [];
    var add = function(p) {
        var n = normalizePath(p);
        if (!n || seen[n]) return;
        seen[n] = true;
        out.push(n);
    };
    // Only file-header lines (before the first hunk `@@` of the current
    // file) may contribute paths — a CONTENT line whose text starts with
    // "++ "/"-- " renders as "+++ "/"--- " and must not join the set
    // (thread PRT_kwDORYAuYs6uJ04O: phantom owned files over-match).
    var headerZone = true;
    String(diffText).split('\n').forEach(function(line) {
        if (line.substring(0, 11) === 'diff --git ') headerZone = true;
        if (line.substring(0, 2) === '@@') {
            headerZone = false;
            return;
        }
        if (!headerZone) return;
        addDiffHeaderPaths(add, line);
        if ((line.match(/^rename (from|to) (.+)$/))) {
            add(line.replace(/^rename (?:from|to) /, ''));
            return;
        }
        addDiffTargetPath(add, line);
    });
    return out;
}

// ── shape parsers ────────────────────────────────────────────────────────────

/** crap4dart/crap4j: "[FAIL] <rule>:" header + indented "path:line: detail" lines. */
function crap4jViolations(lines, checkName, taken, out) {
    var currentRule = null;
    lines.forEach(function(line, idx) {
        if (taken[idx]) return;
        var marker = line.match(/^\[(FAIL|PASS|WARN)\]\s+([A-Za-z0-9_-]+):\s*(.*)$/);
        if (marker) {
            currentRule = marker[1] === 'FAIL' ? marker[2] : null;
            taken[idx] = true;
            return;
        }
        if (!currentRule) return;
        var detail = line.match(/^\s*(.+?):(\d+):\s*(.+?)\s*$/);
        if (!detail) return;
        taken[idx] = true;
        out.push({
            check: checkName,
            rule: currentRule,
            path: detail[1],
            line: parseInt(detail[2], 10),
            detail: detail[3]
        });
    });
}

/**
 * The shared regex-scanner skeleton of the per-line dart extractors
 * (gh-1248): visit every not-yet-taken line, match, mark it taken and hand
 * the match to the caller's push closure. The re/onMatch pair keeps each
 * check's violation shape local.
 */
function forEachUntakenMatch(lines, taken, re, onMatch) {
    lines.forEach(function(line, idx) {
        if (taken[idx]) return;
        var m = line.match(re);
        if (!m) return;
        taken[idx] = true;
        onMatch(m);
    });
}

/** dart analyze: "error • message • path:line:col • code" bullet lines. */
function dartAnalyzeViolations(lines, checkName, taken, out) {
    var re = /^\s*(error|warning|info)\s+•\s+(.+?)\s+•\s+(.+?):(\d+):(\d+)\s+•\s+(\S+)\s*$/;
    forEachUntakenMatch(lines, taken, re, function(m) {
        out.push({
            check: checkName,
            rule: m[6],
            path: m[3],
            line: parseInt(m[4], 10),
            detail: (m[1] === 'error' ? '' : '[' + m[1] + '] ') + m[2]
        });
    });
}

/** dart test: "[optional progress prefix]path: <test name> [E]" failure lines. */
function dartTestViolations(lines, checkName, taken, out) {
    // The elapsed prefix is \d{1,}:\d{2} — capping the minutes at two digits
    // dropped [E] lines of suites running >=100 minutes (thread
    // PRT_kwDORYAuYs6uJ07q).
    var re = /^(?:\s*\d{1,}:\d{2}\s+\+\d+(?:\s+-\d+)*:\s*)?\s*(\S+\.dart):\s+(.+?)\s+\[E\]\s*$/;
    forEachUntakenMatch(lines, taken, re, function(m) {
        out.push({
            check: checkName,
            rule: 'test',
            path: m[1],
            line: null,
            detail: m[2]
        });
    });
}

/**
 * dart format --set-exit-if-changed (gh-1134): each unformatted file is
 * announced by a bare "Formatted <path>.dart" line BEFORE the run summary
 * ("Formatted 495 files (3 changed) in 1.08 seconds."). The strict end
 * anchor keeps the summary line out (UT-2); the trailing \s* makes the
 * match CRLF-safe (logs split on '\n' keep a trailing '\r' on Windows) and
 * \S+ covers backslash path separators. Whole-file red: line 1.
 */
function dartFormatViolations(lines, checkName, taken, out) {
    var re = /^Formatted\s+(\S+\.dart)\s*$/;
    forEachUntakenMatch(lines, taken, re, function(m) {
        out.push({
            check: checkName,
            rule: 'dart_format',
            path: m[1],
            line: 1,
            detail: 'not dart-formatted'
        });
    });
}

/**
 * jscpd: each "Clone found" block lists the duplicated file pair; the first
 * entry is the violation location, the counterpart goes into the detail.
 */
function jscpdEntryOf(line) {
    var m = line.match(/^\s*(?:[-*]\s*)?(.+?):\s*(\d+)-(\d+)\s*$/);
    return m ? { path: m[1], start: m[2], end: m[3] } : null;
}

/** Emit the block's violation — first file as location, counterpart in detail. */
function flushJscpdBlock(checkName, blockEntries, out) {
    if (blockEntries.length === 0) return;
    var first = blockEntries[0];
    var second = blockEntries[1] || null;
    var detail = second
        ? 'lines ' + first.start + '-' + first.end + ' duplicate of ' +
          second.path + ':' + second.start + '-' + second.end
        : 'duplicated lines ' + first.start + '-' + first.end;
    out.push({
        check: checkName,
        rule: 'jscpd',
        path: first.path,
        line: parseInt(first.start, 10),
        detail: detail
    });
}

function jscpdViolations(lines, checkName, taken, out) {
    var inBlock = false;
    var blockEntries = [];
    lines.forEach(function(line, idx) {
        if (taken[idx]) {
            inBlock = false;
            blockEntries = [];
            return;
        }
        if (/\bClone found\b/.test(line)) {
            flushJscpdBlock(checkName, blockEntries, out);
            blockEntries = [];
            inBlock = true;
            taken[idx] = true;
            return;
        }
        if (!inBlock) return;
        var entry = jscpdEntryOf(line);
        if (entry) {
            blockEntries.push(entry);
            taken[idx] = true;
            return;
        }
        if (String(line).trim() !== '') {
            flushJscpdBlock(checkName, blockEntries, out);
            blockEntries = [];
            inBlock = false;
        }
    });
    flushJscpdBlock(checkName, blockEntries, out);
}

/** First path-like token (contains a separator and an extension) in a text. */
function findPathToken(text) {
    var stripped = String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/`/g, '');
    // The separator must be INSIDE the class: tokens like
    // js/unit-tests/foo.js have several levels, and a class without '/' only
    // matches the last directory level (leftmost-match semantics).
    var m = stripped.match(/[A-Za-z0-9_.\-\/\\]+\.[A-Za-z0-9]+/);
    if (!m) return null;
    var token = m[0];
    return (token.indexOf('/') !== -1 || token.indexOf('\\') !== -1) ? token : null;
}

/** One "::error file=..,line=..::message" annotation → violation, or null. */
function errorAnnotationViolation(line, checkName) {
    var props = line.match(/::error\s+([^:]*)::(.*?)\s*$/);
    if (!props) return null;
    var file = (props[1].match(/file=([^,\s]+)/) || [])[1] || null;
    var ln = (props[1].match(/line=(\d+)/) || [])[1];
    return {
        check: checkName,
        rule: 'error',
        path: file,
        line: ln ? parseInt(ln, 10) : null,
        detail: props[2]
    };
}

/**
 * Every "##[error]message" segment of one line → violations (path via token
 * fallback). A line can carry several workflow annotations; a greedy
 * ".*##\[error\]" anchor kept only the LAST one (thread
 * PRT_kwDORYAuYs6uJ05y) — split on the marker instead and emit each segment.
 */
function ghErrorViolations(line, checkName) {
    var segments = String(line).split(/##\[error\]\s?/);
    var out = [];
    for (var i = 1; i < segments.length; i++) {
        var msg = segments[i].trim();
        if (!msg) continue;
        out.push({
            check: checkName,
            rule: 'error',
            path: findPathToken(msg),
            line: null,
            detail: msg
        });
    }
    return out;
}

/** Generic fallback: "::error file=..,line=..::msg" annotations and "##[error]" lines. */
function genericErrorViolations(lines, checkName, taken, out) {
    lines.forEach(function(line, idx) {
        if (taken[idx]) return;
        var violation = errorAnnotationViolation(line, checkName);
        if (violation) {
            taken[idx] = true;
            out.push(violation);
            return;
        }
        var ghErrors = ghErrorViolations(line, checkName);
        if (ghErrors.length > 0) {
            taken[idx] = true;
            ghErrors.forEach(function(v) { out.push(v); });
        }
    });
}

// ── public extraction API ────────────────────────────────────────────────────

/**
 * Extract every recognizable violation from one raw job log. Deterministic
 * (I2): fixed parser order, line order preserved, identical items deduped.
 * Unknown shapes yield [] (I3). Items: {check, rule, path, line, detail}.
 */
function extractViolations(logs, checkName) {
    if (!logs) return [];
    var lines = String(logs).split('\n');
    var taken = {};
    var out = [];
    // Most specific shapes first (thread PRT_kwDORYAuYs6uJ0xk, BLOCKING):
    // the crap4j section scanner stays in-rule from a "[FAIL]" header until
    // the next marker and would swallow dart-analyze bullets (or any
    // "path:line:"-shaped line) appearing later in the SAME concatenated job
    // log — an owned red mangled into a foreign-looking item. dart-analyze
    // bullets and dart-test "[E]" lines never match the other parsers, so
    // claiming them first is safe for every pinned fixture. The dart-format
    // "Formatted <file>" line (gh-1134) is the strictest anchor of all
    // (bare line, ends in .dart) and no other parser can match it — run it
    // first so a concatenated log's format reds can never be swallowed.
    dartFormatViolations(lines, checkName, taken, out);
    dartAnalyzeViolations(lines, checkName, taken, out);
    dartTestViolations(lines, checkName, taken, out);
    crap4jViolations(lines, checkName, taken, out);
    jscpdViolations(lines, checkName, taken, out);
    genericErrorViolations(lines, checkName, taken, out);
    var seen = {};
    var unique = [];
    out.forEach(function(v) {
        var key = v.rule + '|' + v.path + '|' + v.line + '|' + v.detail;
        if (seen[key]) return;
        seen[key] = true;
        unique.push(v);
    });
    return unique;
}

/** Every violation whose path IS in the diff (old and new rename paths count). */
function ownedViolations(violations) {
    return (violations || []).filter(function(v) { return !!v && v.ownership === 'owned'; });
}

/**
 * Tag each violation owned / foreign / unknown against the PR diff text:
 * owned = the path (or a runner-rooted suffix of it) appears in the diff,
 * unknown = no path OR no diff evidence (legacy callers pass no diff — a
 * missing diff must never silently rebrand a possibly-owned red as "foreign,
 * do not chase"), foreign = pathed and absent from the diff.
 */
function tagOwnership(violations, diffText) {
    var diffPaths = diffText ? parseDiffPaths(diffText) : null;
    return (violations || []).map(function(v) {
        var ownership = 'unknown';
        if (v.path && diffPaths) {
            ownership = 'foreign';
            for (var i = 0; i < diffPaths.length; i++) {
                if (sameFile(v.path, diffPaths[i])) {
                    ownership = 'owned';
                    break;
                }
            }
        }
        var tagged = {};
        Object.keys(v).forEach(function(k) { tagged[k] = v[k]; });
        tagged.ownership = ownership;
        return tagged;
    });
}

/**
 * Extract + tag in one step: checkLogs = [{name, logs}], diffText = the raw
 * PR diff (pr_diff.txt). Returns violations with an ownership field.
 */
function extractAndTagViolations(checkLogs, diffText) {
    var items = [];
    (checkLogs || []).forEach(function(entry) {
        items = items.concat(extractViolations(entry && entry.logs, (entry && entry.name) || ''));
    });
    return tagOwnership(items, diffText);
}

// ── ci_failures.md rendering (AC3) ───────────────────────────────────────────

var OWNED_RULE_NOTE = '⚠️ These violations sit in files changed by this PR\'s diff. An owned violation ' +
    '**may not be dismissed** as "not caused by this PR" — fix it, or dispute it per item in the rework ' +
    'summary with `fixed` / `disputed: <reason>`.';

var FOREIGN_NOTE = 'Violations in files this PR does not touch — likely infra or base-branch flake. ' +
    'Do not chase them in this PR; mention them in the summary instead.';

function formatLocation(v) {
    return '`' + normalizePath(v.path) + (v.line ? ':' + v.line : '') + '`';
}

function sanitizeCell(text) {
    var s = String(text === null || text === undefined ? '' : text)
        .replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
    return s.length > MAX_CELL_LEN ? s.substring(0, MAX_CELL_LEN - 3) + '...' : s;
}

function violationsTable(items) {
    var md = '| Check | Rule | Location | Detail |\n|---|---|---|---|\n';
    var shown = items.slice(0, MAX_TABLE_ROWS);
    shown.forEach(function(v) {
        md += '| ' + sanitizeCell(v.check) + ' | ' + sanitizeCell(v.rule) + ' | ' +
            (v.path ? formatLocation(v) : '_(no path)_') + ' | ' + sanitizeCell(v.detail) + ' |\n';
    });
    if (items.length > MAX_TABLE_ROWS) {
        md += '\n_Showing ' + MAX_TABLE_ROWS + ' of ' + items.length +
            ' — full uncapped list in `ci_violations.json`._\n';
    }
    return md;
}

function ownershipBuckets(items) {
    return {
        owned: items.filter(function(v) { return v.ownership === 'owned'; }),
        foreign: items.filter(function(v) { return v.ownership === 'foreign'; }),
        unknown: items.filter(function(v) {
            return v.ownership !== 'owned' && v.ownership !== 'foreign';
        })
    };
}

function appendViolationsSection(md, heading, note, items) {
    if (items.length === 0) return md;
    return md + heading + '\n\n' + violationsTable(items) + '\n' + note + '\n';
}

function unknownViolationsNote(count) {
    return '_ℹ️ ' + count + ' additional error line(s) had no attributable file path — ' +
        'judge them from the raw log sections below._\n';
}

/**
 * The violations block that opens ci_failures.md: the owned table first,
 * the foreign list second (AC3). Unknown-ownership items (no path, or no
 * diff evidence) get a note only — they are never rendered as "do not
 * chase". Empty string when nothing was extracted — the caller then
 * assembles today's file unchanged (AC5 / I3).
 */
function buildViolationsMarkdown(violations) {
    var items = violations || [];
    if (items.length === 0) return '';
    var buckets = ownershipBuckets(items);
    var md = appendViolationsSection('',
        '## 🚨 Violations you must fix (' + buckets.owned.length + ' owned)', OWNED_RULE_NOTE, buckets.owned);
    md = appendViolationsSection(md, '## 🌐 Foreign / infra reds (do not chase)', FOREIGN_NOTE, buckets.foreign);
    if (buckets.unknown.length > 0) {
        md += unknownViolationsNote(buckets.unknown.length);
    }
    return md;
}

/** The ci_violations.json summary: ownership counts + the FULL uncapped list (E2). */
function violationsSummaryJson(violations) {
    var items = violations || [];
    var count = function(o) {
        return items.filter(function(v) { return v.ownership === o; }).length;
    };
    var generatedAt = null;
    try { generatedAt = new Date().toISOString(); } catch (e) { /* non-essential */ }
    return {
        generatedAt: generatedAt,
        owned: count('owned'),
        foreign: count('foreign'),
        unknown: count('unknown'),
        violations: items
    };
}

// ── owned-violation summary validation (AC6, UT-8) ───────────────────────────

/** The first blanket-dismissal phrase on one line, or null. */
function lineDismissalClaim(line) {
    for (var i = 0; i < DISMISSAL_PATTERNS.length; i++) {
        var m = line.match(DISMISSAL_PATTERNS[i]);
        if (m) return m[0];
    }
    return null;
}

/**
 * The blanket-dismissal phrase a summary uses in owned/default scope, or
 * null. Two scopes never reject (review leg 2026-10-20, thread
 * PRT_kwDORYAuYs6uJ0zj):
 *  - a `fixed` / `disputed:` accounting line — the structured per-item
 *    alternative the gate asks for;
 *  - a line inside a foreign-reds section — the foreign note tells the leg
 *    to mention foreign reds, and "unrelated" is that vocabulary.
 * A bare claim in owned/default scope still rejects while owned items are
 * open (UT-8: blanket dismissal ≠ per-item dispute).
 */
function findDismissalClaim(summary) {
    var lines = String(summary || '').split('\n');
    var foreignScope = false;
    for (var i = 0; i < lines.length; i++) {
        if (FOREIGN_SECTION_HEADING.test(lines[i])) {
            foreignScope = true;
            continue;
        }
        if (OWNED_SECTION_HEADING.test(lines[i])) {
            foreignScope = false;
            continue;
        }
        if (foreignScope || carriesAccountingMarker(lines[i])) continue;
        var claim = lineDismissalClaim(lines[i]);
        if (claim) return claim;
    }
    return null;
}

/** True when the line names the violation's file (path or basename). */
function lineNamesPath(normalizedLine, v) {
    var path = normalizePath(v.path).toLowerCase();
    var basename = path.split('/').pop();
    return (path.length > 0 && normalizedLine.indexOf(path) !== -1) ||
        (basename.length > 3 && normalizedLine.indexOf(basename) !== -1);
}

/** True when a summary line names the violation (path, basename or rule). */
function mentionsViolation(normalizedLine, v) {
    if (lineNamesPath(normalizedLine, v)) return true;
    if (!v.rule) return false;
    // Word-boundary rule match: the dart-test shape hardcodes rule "test",
    // and a bare substring match would let "…added a test" settle an
    // unrelated file — a substring inside a longer token (test_recover…)
    // is not the rule name (thread PRT_kwDORYAuYs6uJ01M).
    var rule = String(v.rule).toLowerCase();
    var ruleRe = new RegExp('\\b' + rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    return ruleRe.test(normalizedLine);
}

/** True when the line carries the `fixed` / `disputed:` accounting marker. */
function carriesAccountingMarker(line) {
    return /\bfixed\b/i.test(line) || /disputed\s*:/i.test(line);
}

/** True when a line names the violation (path, basename or rule) AND carries fixed/disputed. */
function lineAccountsFor(line, v, requirePath) {
    if (!carriesAccountingMarker(line)) return false;
    var normalized = String(line).toLowerCase();
    if (requirePath) return lineNamesPath(normalized, v);
    return mentionsViolation(normalized, v);
}

/** True when the line names the file of a DIFFERENT violation (owned or not). */
function namesOtherViolationPath(normalizedLine, v, violations) {
    var list = violations || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] === v) continue;
        if (lineNamesPath(normalizedLine, list[i])) return true;
    }
    return false;
}

/** True when the summary accounts for one owned violation (fixed / disputed per item). */
function violationAccounted(summary, v, ownedCount, violations) {
    var lines = String(summary || '').split('\n');
    var i;
    // Several owned items: citing the rule (or the dart-test word "test")
    // is not naming the item — require the path/basename so one line cannot
    // settle a differently-named file (thread PRT_kwDORYAuYs6uJ01M).
    var requirePath = ownedCount > 1;
    for (i = 0; i < lines.length; i++) {
        if (lineAccountsFor(lines[i], v, requirePath)) return true;
    }
    if (ownedCount === 1) {
        // A single owned violation: one fixed/disputed line IS the per-item
        // accounting — unless the line names a DIFFERENT violation's file
        // (it settles that one, not this item).
        for (i = 0; i < lines.length; i++) {
            if (!carriesAccountingMarker(lines[i])) continue;
            if (namesOtherViolationPath(String(lines[i]).toLowerCase(), v, violations)) continue;
            return true;
        }
    }
    return false;
}

/**
 * The post-rework gate (UT-8): with owned violations open, a fix summary may
 * neither dismiss them wholesale ("not caused by this PR", "unrelated",
 * "infra") nor leave them unaccounted — each owned violation needs a line
 * with `fixed` or `disputed: <reason>`. Returns { ok: true } or
 * { ok: false, errors: [...], unaccounted: [...] }.
 */
function validateOwnedViolationsSummary(summary, violations) {
    var owned = ownedViolations(violations);
    if (owned.length === 0) return { ok: true };
    var errors = [];
    var claim = findDismissalClaim(summary);
    if (claim) {
        errors.push('dismissal claim "' + claim + '" while ' + owned.length +
            ' owned CI violation(s) are open — fix them or dispute each with "disputed: <reason>"');
    }
    var unaccounted = owned.filter(function(v) {
        return !violationAccounted(summary, v, owned.length, violations);
    });
    if (unaccounted.length > 0) {
        errors.push('unaccounted owned violation(s): ' +
            unaccounted.map(function(v) {
                return normalizePath(v.path) + (v.line ? ':' + v.line : '');
            }).join(', ') + ' — list each with "fixed" or "disputed: <reason>"');
    }
    return errors.length > 0 ? { ok: false, errors: errors, unaccounted: unaccounted } : { ok: true };
}

module.exports = {
    MAX_TABLE_ROWS: MAX_TABLE_ROWS,
    normalizePath: normalizePath,
    parseDiffPaths: parseDiffPaths,
    extractViolations: extractViolations,
    tagOwnership: tagOwnership,
    extractAndTagViolations: extractAndTagViolations,
    ownedViolations: ownedViolations,
    buildViolationsMarkdown: buildViolationsMarkdown,
    violationsSummaryJson: violationsSummaryJson,
    findDismissalClaim: findDismissalClaim,
    validateOwnedViolationsSummary: validateOwnedViolationsSummary
};
