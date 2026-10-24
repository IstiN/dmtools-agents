// Duplication ratchet for the quality.yml gate (gh-1251 rework).
//
// The `crap4js duplicates --threshold 1` measurement fails with exit 2 while
// ANY production JS file exceeds 1% duplicated lines. 85 files do today —
// pre-existing debt owned by the gh-1244…gh-1250 dedup tickets — so an
// absolute 1% bar can never go green until all seven land. This script turns
// the hard gate into a ratchet: duplication-baseline.json pins every
// currently-over-threshold file with its measured percentage, and the gate
// fails only when the report shows
//
//   - a file over threshold that is NOT pinned (new duplication), or
//   - a pinned file whose percentage GREW (regression).
//
// Shrinking or cleared debt passes (and is reported) — the baseline is
// pruned by the dedup tickets as they land, hardening the gate towards the
// absolute 1% bar it replaces. A measurement that did not run cleanly (tool
// exit other than 0 = no violations, 2 = violations found) never passes.
//
// Usage (see the "Duplication gate" step in .github/workflows/quality.yml):
//   node ci/duplicationRatchet.js <report-file> <baseline-json> <tool-exit-code>
//
// Pure parsing/comparison functions are exported for the unit suite; the
// file-system access lives in main() only, so loadModule() needs no mocks.

'use strict';

var VIOLATION_RE = /^(.+):(\d+): (\d+(?:\.\d+)?)% duplicated lines > /;
var EPSILON = 1e-9;

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

/**
 * Compare a parsed violation list against the pinned baseline.
 * Returns { clean, fresh, regressions, improved, cleared, pinnedCount }.
 */
function compareWithBaseline(violations, baseline) {
    var pinned = (baseline && baseline.pinned) || {};
    var fresh = [];
    var regressions = [];
    var improved = [];
    var seen = {};
    var pinnedCount = 0;

    violations.forEach(function(v) {
        seen[v.file] = true;
        if (!Object.prototype.hasOwnProperty.call(pinned, v.file)) {
            fresh.push({ file: v.file, percent: v.percent });
        } else if (v.percent > pinned[v.file] + EPSILON) {
            regressions.push({ file: v.file, from: pinned[v.file], to: v.percent });
        } else {
            pinnedCount++;
            if (v.percent < pinned[v.file] - EPSILON) {
                improved.push({ file: v.file, from: pinned[v.file], to: v.percent });
            }
        }
    });

    var cleared = Object.keys(pinned).filter(function(f) { return !seen[f]; });

    return {
        clean: fresh.length === 0 && regressions.length === 0,
        fresh: fresh,
        regressions: regressions,
        improved: improved,
        cleared: cleared,
        pinnedCount: pinnedCount
    };
}

function formatFilePercent(entry) {
    return entry.file + ' ' + entry.percent.toFixed(2) + '%';
}

/**
 * CLI body. Arguments: <report-file> <baseline-json> <tool-exit-code>.
 * Returns the process exit code (0 = ratchet clean, 2 = gate failed).
 */
function main(argv) {
    var fs = require('fs');
    var reportPath = argv[0];
    var baselinePath = argv[1];
    var toolExit = String(argv[2] || '0');

    if (toolExit !== '0' && toolExit !== '2') {
        console.error('duplication ratchet: measurement crashed (tool exit ' + toolExit +
            ') — refusing to pass; report at ' + reportPath);
        return 2;
    }

    var baseline;
    try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (e) {
        console.error('duplication ratchet: cannot read baseline ' + baselinePath + ': ' + e.message);
        return 2;
    }
    if (!baseline || typeof baseline.pinned !== 'object' || baseline.pinned === null) {
        console.error('duplication ratchet: baseline ' + baselinePath + ' has no "pinned" map');
        return 2;
    }

    var reportText = '';
    try {
        reportText = fs.readFileSync(reportPath, 'utf8');
    } catch (e) {
        console.error('duplication ratchet: cannot read report ' + reportPath + ': ' + e.message);
        return 2;
    }

    var violations = parseViolations(reportText);
    var result = compareWithBaseline(violations, baseline);

    result.improved.forEach(function(i) {
        console.log('improved ' + i.file + ': ' + i.from.toFixed(2) + '% -> ' + i.to.toFixed(2) + '%');
    });
    result.cleared.forEach(function(f) {
        console.log('cleared ' + f + ' — no longer over threshold (baseline entry stale, prune with the dedup PR)');
    });

    if (!result.clean) {
        result.fresh.forEach(function(f) {
            console.error('fresh duplication: ' + formatFilePercent(f) + ' (not pinned in ' + baselinePath + ')');
        });
        result.regressions.forEach(function(r) {
            console.error('duplication regression: ' + r.file + ' ' + r.from.toFixed(2) + '% -> ' + r.to.toFixed(2) + '%');
        });
        console.error('duplication ratchet: FAIL — ' + result.fresh.length + ' fresh, ' +
            result.regressions.length + ' regressed (' + result.pinnedCount + ' pinned debt files unchanged)');
        return 2;
    }

    console.log('duplication ratchet: OK — no new/regressed duplication (' +
        result.pinnedCount + ' pinned debt files, ' + result.cleared.length + ' cleared)');
    return 0;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseViolations: parseViolations,
        compareWithBaseline: compareWithBaseline,
        main: main
    };
}

// CLI entry: only when executed directly, not when eval-loaded by the harness.
if (typeof require !== 'undefined' && require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
