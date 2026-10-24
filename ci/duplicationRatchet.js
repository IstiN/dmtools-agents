// Duplication ratchet for the quality.yml gate (gh-1251 rework).
//
// The `crap4js duplicates --threshold 1` measurement fails with exit 2 while
// ANY production JS file exceeds 1% duplicated lines. Dozens of files do
// today — pre-existing debt owned by the gh-1244…gh-1250 dedup tickets — so
// an absolute 1% bar can never go green until all seven land. This script
// turns the hard gate into a ratchet against duplication-baseline.json. The
// gate fails only when the report shows
//
//   - a file over threshold that is NOT pinned (new duplication), or
//   - a pinned file whose ABSOLUTE duplicated-line count GREW.
//
// Absolute-count regression detection (leg 3): dedup work shrinks files, so
// a file's duplicated-line PERCENTAGE can rise while its absolute count is
// flat — the gh-1244 merge produced exactly that for 7 of 12 flagged files.
// The tool prints percentages to 2 decimals over an integer line count, so
// the absolute count is recovered exactly by recoverDupLines() and compared
// against the baseline's pinned line counts. A percentage shift with a flat
// absolute count is reported as informational 'shifted', never a failure.
// Shrinking or cleared debt passes — the baseline is pruned by the dedup
// tickets as they land, hardening the gate towards the absolute 1% bar it
// replaces. A measurement that did not run cleanly (tool exit other than
// 0 = no violations, 2 = violations found) never passes.
//
// Usage (see the "Duplication gate" step in .github/workflows/quality.yml):
//   node ci/duplicationRatchet.js <report-file> <baseline-json> <tool-exit-code> [repo-root]
//
// Pure parsing/comparison functions are exported for the unit suite; the
// file-system access lives in main() only, so loadModule() needs no mocks.

'use strict';

var VIOLATION_RE = /^(.+):(\d+): (\d+(?:\.\d+)?)% duplicated lines > /;

/**
 * Parse the percentage-mode `crap4js duplicates` report into violation
 * entries. The summary line (`N/M files over T% duplication`) and any other
 * noise are ignored — only `<file>:<line>: NN.NN% duplicated lines > T%`
 * lines match.
 */
function parseViolations(reportText) {
    var violations = [];
    String(reportText || '').split('\n').forEach(function(line) {
        var m = line.match(VIOLATION_RE);
        if (m) {
            violations.push({ file: m[1], line: parseInt(m[2], 10), percent: parseFloat(m[3]) });
        }
    });
    return violations;
}

// The tool's own line counter (duplicates.js lineCount): the file's line
// count, with a trailing newline not adding an empty line.
function lineCount(source) {
    var newlines = source.split('\n').length - 1;
    return source.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * Recover the exact integer number of distinct duplicated lines behind a
 * printed percentage: the tool prints (dupLines/totalLines*100).toFixed(2),
 * so scan the integers and keep the one whose printed form matches. Unique
 * whenever adjacent integers differ by more than 0.01% on the given line
 * count (always true for the repo's file sizes).
 */
function recoverDupLines(percent, totalLines) {
    var best = 0;
    var bestDiff = Infinity;
    for (var d = 0; d <= totalLines; d++) {
        var diff = Math.abs(parseFloat((d / totalLines * 100).toFixed(2)) - percent);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = d;
        }
    }
    return best;
}

/**
 * Classify one violated file against its baseline entry and current line
 * count. Returns { kind, ... } where kind is 'fresh' (no baseline entry),
 * 'error' (line count unavailable), 'regressions' (absolute count grew),
 * 'improved' (absolute count fell), 'shifted' (pct moved, absolute flat),
 * or 'pinned' (unchanged).
 */
function classifyViolation(v, entry, total) {
    if (!entry || typeof entry.lines !== 'number') {
        return { kind: 'fresh', file: v.file, percent: v.percent };
    }
    if (typeof total !== 'number') {
        return { kind: 'error', message: 'cannot determine line count of ' + v.file };
    }
    var absNow = recoverDupLines(v.percent, total);
    if (absNow > entry.lines) {
        return { kind: 'regressions', file: v.file, fromLines: entry.lines, toLines: absNow };
    }
    if (absNow < entry.lines) {
        return { kind: 'improved', file: v.file, fromLines: entry.lines, toLines: absNow };
    }
    if (v.percent !== entry.pct) {
        return { kind: 'shifted', file: v.file, fromPct: entry.pct, toPct: v.percent, lines: absNow };
    }
    return { kind: 'pinned', file: v.file };
}

/**
 * Compare a parsed violation list against the pinned baseline.
 * `lineCounts` maps each violated file to its current line count (main()
 * builds it by reading the files). Baseline entries are
 * { pct, lines } — pct is informational, lines drives regressions.
 * Returns { clean, fresh, regressions, improved, shifted, cleared,
 * pinnedCount, error? }.
 */
function compareWithBaseline(violations, baseline, lineCounts) {
    var pinned = (baseline && baseline.pinned) || {};
    var buckets = { fresh: [], regressions: [], improved: [], shifted: [] };
    var seen = {};
    var pinnedCount = 0;

    for (var i = 0; i < violations.length; i++) {
        var v = violations[i];
        seen[v.file] = true;
        var c = classifyViolation(v, pinned[v.file], lineCounts[v.file]);
        if (c.kind === 'error') return { error: c.message };
        if (c.kind === 'pinned') { pinnedCount++; continue; }
        buckets[c.kind].push(c);
    }

    var cleared = Object.keys(pinned).filter(function(f) { return !seen[f]; });

    return {
        clean: buckets.fresh.length === 0 && buckets.regressions.length === 0,
        fresh: buckets.fresh,
        regressions: buckets.regressions,
        improved: buckets.improved,
        shifted: buckets.shifted,
        cleared: cleared,
        pinnedCount: pinnedCount
    };
}

function formatFilePercent(entry) {
    return entry.file + ' ' + entry.percent.toFixed(2) + '%';
}

// ── CLI helpers (kept tiny: the CRAP ratchet fails any NEW function > 8) ─────

function toolExitIsValid(toolExit) {
    return toolExit === '0' || toolExit === '2';
}

function readBaseline(fs, baselinePath) {
    var baseline;
    try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (e) {
        return { error: 'cannot read baseline ' + baselinePath + ': ' + e.message };
    }
    if (!baseline || typeof baseline.pinned !== 'object' || baseline.pinned === null) {
        return { error: 'baseline ' + baselinePath + ' has no "pinned" map' };
    }
    return { baseline: baseline };
}

function readReport(fs, reportPath) {
    try {
        return { text: fs.readFileSync(reportPath, 'utf8') };
    } catch (e) {
        return { error: 'cannot read report ' + reportPath + ': ' + e.message };
    }
}

// Line counts of every violated file, for absolute-count recovery. A file
// that cannot be read is a hard error — the gate must not guess.
function countLines(fs, repoRoot, violations) {
    var counts = {};
    for (var i = 0; i < violations.length; i++) {
        var f = violations[i].file;
        if (counts[f] !== undefined) continue;
        try {
            counts[f] = lineCount(fs.readFileSync(repoRoot + '/' + f, 'utf8'));
        } catch (e) {
            return { error: 'cannot read ' + f + ' under ' + repoRoot + ': ' + e.message };
        }
    }
    return { counts: counts };
}

// Print the comparison verdict; the return value is the gate's exit code.
function reportVerdict(result) {
    if (result.error) {
        console.error('duplication ratchet: ' + result.error);
        return 2;
    }
    result.shifted.forEach(function(s) {
        console.log('shifted ' + s.file + ': ' + s.fromPct.toFixed(2) + '% -> ' +
            s.toPct.toFixed(2) + '% (' + s.lines + ' duplicated lines, flat — file shrank)');
    });
    result.improved.forEach(function(i) {
        console.log('improved ' + i.file + ': ' + i.fromLines + ' -> ' + i.toLines + ' duplicated lines');
    });
    result.cleared.forEach(function(f) {
        console.log('cleared ' + f + ' — no longer over threshold (baseline entry stale, prune with the dedup PR)');
    });
    if (!result.clean) {
        result.fresh.forEach(function(f) {
            console.error('fresh duplication: ' + formatFilePercent(f) + ' (not pinned in duplication-baseline.json)');
        });
        result.regressions.forEach(function(r) {
            console.error('duplication regression: ' + r.file + ' ' + r.fromLines + ' -> ' + r.toLines + ' duplicated lines');
        });
        console.error('duplication ratchet: FAIL — ' + result.fresh.length + ' fresh, ' +
            result.regressions.length + ' regressed (' + result.pinnedCount + ' pinned debt files unchanged)');
        return 2;
    }
    console.log('duplication ratchet: OK — no new/regressed duplication (' +
        result.pinnedCount + ' pinned debt files, ' + result.shifted.length + ' shifted, ' +
        result.cleared.length + ' cleared)');
    return 0;
}

/**
 * CLI body. Arguments: <report-file> <baseline-json> <tool-exit-code> [repo-root].
 * Returns the process exit code (0 = ratchet clean, 2 = gate failed).
 */
function main(argv) {
    var fs = require('fs');
    var reportPath = argv[0];
    var baselinePath = argv[1];
    var toolExit = String(argv[2] || '0');
    var repoRoot = argv[3] || '.';

    if (!toolExitIsValid(toolExit)) {
        console.error('duplication ratchet: measurement crashed (tool exit ' + toolExit +
            ') — refusing to pass; report at ' + reportPath);
        return 2;
    }
    var base = readBaseline(fs, baselinePath);
    if (base.error) {
        console.error('duplication ratchet: ' + base.error);
        return 2;
    }
    var rep = readReport(fs, reportPath);
    if (rep.error) {
        console.error('duplication ratchet: ' + rep.error);
        return 2;
    }
    var violations = parseViolations(rep.text);
    var counts = countLines(fs, repoRoot, violations);
    if (counts.error) {
        console.error('duplication ratchet: ' + counts.error);
        return 2;
    }
    return reportVerdict(compareWithBaseline(violations, base.baseline, counts.counts));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseViolations: parseViolations,
        recoverDupLines: recoverDupLines,
        classifyViolation: classifyViolation,
        compareWithBaseline: compareWithBaseline,
        main: main
    };
}

// CLI entry: only when executed directly, not when eval-loaded by the harness.
if (typeof require !== 'undefined' && require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
