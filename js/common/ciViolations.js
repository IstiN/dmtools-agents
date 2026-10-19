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
    String(diffText).split('\n').forEach(function(line) {
        var m;
        if ((m = line.match(/^diff --git a\/(.*) b\/(.*)$/))) { add(m[1]); add(m[2]); return; }
        if ((m = line.match(/^rename from (.+)$/))) { add(m[1]); return; }
        if ((m = line.match(/^rename to (.+)$/))) { add(m[1]); return; }
        if ((m = line.match(/^--- (?:(?:a\/)?(.+))$/)) && m[1] !== '/dev/null') { add(m[1]); return; }
        if ((m = line.match(/^\+\+\+ (?:(?:b\/)?(.+))$/)) && m[1] !== '/dev/null') { add(m[1]); }
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

/** dart analyze: "error • message • path:line:col • code" bullet lines. */
function dartAnalyzeViolations(lines, checkName, taken, out) {
    var re = /^\s*(error|warning|info)\s+•\s+(.+?)\s+•\s+(.+?):(\d+):(\d+)\s+•\s+(\S+)\s*$/;
    lines.forEach(function(line, idx) {
        if (taken[idx]) return;
        var m = line.match(re);
        if (!m) return;
        taken[idx] = true;
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
    var re = /^(?:\s*\d{1,2}:\d{2}\s+\+\d+(?:\s+-\d+)*:\s*)?\s*(\S+\.dart):\s+(.+?)\s+\[E\]\s*$/;
    lines.forEach(function(line, idx) {
        if (taken[idx]) return;
        var m = line.match(re);
        if (!m) return;
        taken[idx] = true;
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
 * jscpd: each "Clone found" block lists the duplicated file pair; the first
 * entry is the violation location, the counterpart goes into the detail.
 */
function jscpdViolations(lines, checkName, taken, out) {
    var entryRe = /^\s*(?:[-*]\s*)?(.+?):\s*(\d+)-(\d+)\s*$/;
    var inBlock = false;
    var blockEntries = [];
    var flush = function() {
        if (blockEntries.length > 0) {
            var first = blockEntries[0];
            var detail = blockEntries.length > 1
                ? 'lines ' + first.start + '-' + first.end + ' duplicate of ' +
                  first.other.path + ':' + first.other.start + '-' + first.other.end
                : 'duplicated lines ' + first.start + '-' + first.end;
            out.push({
                check: checkName,
                rule: 'jscpd',
                path: first.path,
                line: parseInt(first.start, 10),
                detail: detail
            });
        }
        blockEntries = [];
    };
    lines.forEach(function(line, idx) {
        if (taken[idx]) { flush(); inBlock = false; return; }
        if (/\bClone found\b/.test(line)) {
            flush();
            inBlock = true;
            taken[idx] = true;
            return;
        }
        if (!inBlock) return;
        var m = line.match(entryRe);
        if (m) {
            blockEntries.push({
                path: m[1],
                start: m[2],
                end: m[3],
                other: null
            });
            if (blockEntries.length === 2) {
                blockEntries[0].other = { path: m[1], start: m[2], end: m[3] };
                inBlock = false;
            }
            taken[idx] = true;
            return;
        }
        if (String(line).trim() !== '') {
            flush();
            inBlock = false;
        }
    });
    flush();
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

/** Generic fallback: "::error file=..,line=..::msg" annotations and "##[error]" lines. */
function genericErrorViolations(lines, checkName, taken, out) {
    lines.forEach(function(line, idx) {
        if (taken[idx]) return;
        var props = line.match(/::error\s+([^:]*)::(.*?)\s*$/);
        if (props) {
            taken[idx] = true;
            var file = (props[1].match(/file=([^,\s]+)/) || [])[1] || null;
            var ln = (props[1].match(/line=(\d+)/) || [])[1];
            out.push({
                check: checkName,
                rule: 'error',
                path: file,
                line: ln ? parseInt(ln, 10) : null,
                detail: props[2]
            });
            return;
        }
        var ghErr = line.match(/^.*##\[error\]\s?(.*?)\s*$/);
        if (ghErr) {
            taken[idx] = true;
            var token = findPathToken(ghErr[1]);
            out.push({
                check: checkName,
                rule: 'error',
                path: token,
                line: null,
                detail: ghErr[1]
            });
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
    crap4jViolations(lines, checkName, taken, out);
    dartAnalyzeViolations(lines, checkName, taken, out);
    dartTestViolations(lines, checkName, taken, out);
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
    var owned = items.filter(function(v) { return v.ownership === 'owned'; });
    var foreign = items.filter(function(v) { return v.ownership === 'foreign'; });
    var unknown = items.filter(function(v) { return v.ownership !== 'owned' && v.ownership !== 'foreign'; });
    if (owned.length === 0 && foreign.length === 0 && unknown.length === 0) return '';
    var md = '';
    if (owned.length > 0) {
        md += '## 🚨 Violations you must fix (' + owned.length + ' owned)\n\n' +
            violationsTable(owned) + '\n' + OWNED_RULE_NOTE + '\n';
    }
    if (foreign.length > 0) {
        md += '## 🌐 Foreign / infra reds (do not chase)\n\n' + violationsTable(foreign) + '\n' + FOREIGN_NOTE + '\n';
    }
    if (unknown.length > 0) {
        md += '_ℹ️ ' + unknown.length + ' additional error line(s) had no attributable file path — ' +
            'judge them from the raw log sections below._\n';
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

/** The blanket-dismissal phrase a summary uses, or null. */
function findDismissalClaim(summary) {
    var text = String(summary || '');
    for (var i = 0; i < DISMISSAL_PATTERNS.length; i++) {
        var m = text.match(DISMISSAL_PATTERNS[i]);
        if (m) return m[0];
    }
    return null;
}

/** True when a line names the violation (path, basename or rule) AND carries fixed/disputed. */
function lineAccountsFor(line, v) {
    var normalized = String(line).toLowerCase();
    var path = normalizePath(v.path).toLowerCase();
    var basename = path.split('/').pop();
    var named = (path && normalized.indexOf(path) !== -1) ||
        (basename.length > 3 && normalized.indexOf(basename) !== -1) ||
        (v.rule && normalized.indexOf(String(v.rule).toLowerCase()) !== -1);
    if (!named) return false;
    return /\bfixed\b/i.test(line) || /disputed\s*:/i.test(line);
}

/** True when the summary accounts for one owned violation (fixed / disputed per item). */
function violationAccounted(summary, v, ownedCount) {
    var lines = String(summary || '').split('\n');
    var i;
    for (i = 0; i < lines.length; i++) {
        if (lineAccountsFor(lines[i], v)) return true;
    }
    if (ownedCount === 1) {
        // A single owned violation: one fixed/disputed line IS the per-item
        // accounting — no ambiguity about which item it settles.
        for (i = 0; i < lines.length; i++) {
            if (/\bfixed\b/i.test(lines[i]) || /disputed\s*:/i.test(lines[i])) return true;
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
        return !violationAccounted(summary, v, owned.length);
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
