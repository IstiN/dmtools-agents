/**
 * Unit tests: ci/duplicationRatchet.js (gh-1251 rework).
 *
 * The quality.yml duplication gate is a RATCHET, not an absolute bar: the
 * production JS files already over 1% duplicated lines are pinned in
 * duplication-baseline.json (pre-existing debt owned by the gh-1244…gh-1250
 * dedup tickets). The gate fails only on
 *
 *   - a NEW file over threshold (percentage semantics — the 1% bar), or
 *   - a pinned file whose ABSOLUTE duplicated-line count GREW.
 *
 * Absolute-lines regression detection (gh-1251 rework leg 3): dedup work
 * shrinks files, so a file's duplicated-line PERCENTAGE can rise while its
 * absolute duplicated-line count is flat — the gh-1244 landing produced
 * exactly that for 7 of 12 flagged files. Percentage-only ratcheting would
 * false-red on every dedup merge; absolute counts are recovered exactly from
 * the printed percentage and the file's line count (the tool prints percent
 * to 2 decimals over an integer line count, so the integer is unique in
 * practice). A pct shift with a flat absolute count is reported as
 * informational 'shifted', not a regression.
 *
 *   - parseViolations: multi-item report parsing, summary-line/noise
 *     filtering, empty input.
 *   - recoverDupLines: exact integer recovery from pct + line count.
 *   - compareWithBaseline: clean pass, fresh file, absolute-growth
 *     regression, pct-shift-with-flat-absolute pass, absolute-decrease
 *     improvement, cleared debt, empty baseline, zero violations.
 *   - main: CLI exit codes, hermetic via a 4th repo-root argument; fail
 *     closed on crashed measurements, unreadable files, bad baselines.
 *
 * Uses: loadModule, assert, test(), suite()
 */

'use strict';

/* global loadModule, require, assert, test, suite */

var ratchet = loadModule('ci/duplicationRatchet.js', require);

// ── parseViolations ──────────────────────────────────────────────────────────

suite('duplicationRatchet — parseViolations', function() {

    test('parses a multi-file report into file/line/percent entries', function() {
        var report = [
            'ci/release_packs.mjs:164: 2.30% duplicated lines > 1%',
            'js/createRepoTasks.js:19: 16.85% duplicated lines > 1%',
            'js/mergeTrigger.js:43: 1.01% duplicated lines > 1%'
        ].join('\n');
        var v = ratchet.parseViolations(report);
        assert.deepEqual(v, [
            { file: 'ci/release_packs.mjs', line: 164, percent: 2.30 },
            { file: 'js/createRepoTasks.js', line: 19, percent: 16.85 },
            { file: 'js/mergeTrigger.js', line: 43, percent: 1.01 }
        ]);
    });

    test('ignores the summary line and unrelated noise', function() {
        var report = [
            'some header noise',
            'js/moveToDone.js:8: 12.50% duplicated lines > 1%',
            '77/192 files over 1% duplication',
            'trailing note without a violation shape'
        ].join('\n');
        var v = ratchet.parseViolations(report);
        assert.deepEqual(v, [{ file: 'js/moveToDone.js', line: 8, percent: 12.50 }]);
    });

    test('empty report parses to no violations', function() {
        assert.deepEqual(ratchet.parseViolations(''), []);
        assert.deepEqual(ratchet.parseViolations('77/192 files over 1% duplication'), []);
    });

});

// ── recoverDupLines ──────────────────────────────────────────────────────────

suite('duplicationRatchet — recoverDupLines', function() {

    test('recovers the exact integer behind a printed percentage', function() {
        assert.equal(ratchet.recoverDupLines(12.50, 200), 25);
        assert.equal(ratchet.recoverDupLines(1.50, 334), 5);
        assert.equal(ratchet.recoverDupLines(2.15, 327), 7);
        assert.equal(ratchet.recoverDupLines(1.01, 198), 2);
        assert.equal(ratchet.recoverDupLines(9.33, 150), 14);
    });

    test('zero duplicated lines recovers to zero', function() {
        assert.equal(ratchet.recoverDupLines(0.00, 100), 0);
    });

});

// ── compareWithBaseline ──────────────────────────────────────────────────────

function baselineOf(map) {
    return { version: 2, threshold: 1, pinned: map };
}

// js/fakeA.js: 200 lines, 25 duplicated (12.50%). js/fakeB.js: 198 lines,
// 2 duplicated (1.01%).
var DEBT = baselineOf({
    'js/fakeA.js': { pct: 12.50, lines: 25 },
    'js/fakeB.js': { pct: 1.01, lines: 2 }
});

var COUNTS = { 'js/fakeA.js': 200, 'js/fakeB.js': 198 };

suite('duplicationRatchet — compareWithBaseline', function() {

    test('identical debt is clean — pinned files do not fail the gate', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/fakeA.js', line: 8, percent: 12.50 },
            { file: 'js/fakeB.js', line: 43, percent: 1.01 }
        ], DEBT, COUNTS);
        assert.equal(result.clean, true);
        assert.deepEqual(result.fresh, []);
        assert.deepEqual(result.regressions, []);
        assert.equal(result.pinnedCount, 2);
    });

    test('a NEW file over threshold is a fresh regression', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/fakeA.js', line: 8, percent: 12.50 },
            { file: 'js/brandNewDup.js', line: 3, percent: 4.20 }
        ], DEBT, { 'js/fakeA.js': 200, 'js/brandNewDup.js': 100 });
        assert.equal(result.clean, false);
        assert.deepEqual(result.fresh, [{ file: 'js/brandNewDup.js', percent: 4.20 }]);
        assert.equal(result.regressions.length, 0);
    });

    test('an INCREASED absolute count on a pinned file is a regression', function() {
        // fakeB: 4 duplicated lines of 198 → 2.02%.
        var result = ratchet.compareWithBaseline([
            { file: 'js/fakeB.js', line: 43, percent: 2.02 },
            { file: 'js/fakeA.js', line: 8, percent: 12.50 }
        ], DEBT, COUNTS);
        assert.equal(result.clean, false);
        assert.deepEqual(result.regressions, [
            { file: 'js/fakeB.js', fromLines: 2, toLines: 4 }
        ]);
    });

    test('a pct shift with a FLAT absolute count is clean (file shrinkage)', function() {
        // fakeB shrank 198→132 lines; still 2 duplicated → 1.52%.
        var result = ratchet.compareWithBaseline([
            { file: 'js/fakeB.js', line: 43, percent: 1.52 },
            { file: 'js/fakeA.js', line: 8, percent: 12.50 }
        ], DEBT, { 'js/fakeA.js': 200, 'js/fakeB.js': 132 });
        assert.equal(result.clean, true);
        assert.deepEqual(result.regressions, []);
        assert.deepEqual(result.shifted, [
            { file: 'js/fakeB.js', fromPct: 1.01, toPct: 1.52, lines: 2 }
        ]);
    });

    test('a DECREASED absolute count is clean and reported as improved', function() {
        // fakeB: 1 duplicated line of 198 → 0.51%.
        var result = ratchet.compareWithBaseline([
            { file: 'js/fakeB.js', line: 43, percent: 0.51 },
            { file: 'js/fakeA.js', line: 8, percent: 12.50 }
        ], DEBT, COUNTS);
        assert.equal(result.clean, true);
        assert.deepEqual(result.improved, [
            { file: 'js/fakeB.js', fromLines: 2, toLines: 1 }
        ]);
    });

    test('debt cleared below threshold is clean and reported as cleared', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/fakeA.js', line: 8, percent: 12.50 }
        ], DEBT, COUNTS);
        assert.equal(result.clean, true);
        assert.deepEqual(result.cleared, ['js/fakeB.js']);
    });

    test('empty baseline makes every violation fresh', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/fakeA.js', line: 8, percent: 12.50 }
        ], baselineOf({}), COUNTS);
        assert.equal(result.clean, false);
        assert.deepEqual(result.fresh, [{ file: 'js/fakeA.js', percent: 12.50 }]);
    });

    test('zero violations is clean even with a non-empty baseline', function() {
        var result = ratchet.compareWithBaseline([], DEBT, COUNTS);
        assert.equal(result.clean, true);
        assert.deepEqual(result.cleared, ['js/fakeA.js', 'js/fakeB.js']);
    });

});

// ── main (CLI) ───────────────────────────────────────────────────────────────

suite('duplicationRatchet — main CLI', function() {

    var fs = require('fs');
    var os = require('os');
    var path = require('path');

    var tmpDir;
    var reportPath;
    var baselinePath;

    function writeTmp(name, content) {
        var p = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        return p;
    }

    // A repo root with two fake files of controlled line counts:
    // js/fakeA.js — 200 lines (25 duplicated = 12.50%),
    // js/fakeB.js — 198 lines (2 duplicated = 1.01%).
    function setup() {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-ratchet-'));
        writeTmp('js/fakeA.js', new Array(201).join('x\n'));
        writeTmp('js/fakeB.js', new Array(199).join('x\n'));
        baselinePath = writeTmp('baseline.json', JSON.stringify(DEBT));
        reportPath = writeTmp('report.txt', [
            'js/fakeA.js:8: 12.50% duplicated lines > 1%',
            'js/fakeB.js:43: 1.01% duplicated lines > 1%',
            '2/192 files over 1% duplication'
        ].join('\n'));
    }

    function mainArgs() {
        return [reportPath, baselinePath, '2', tmpDir];
    }

    test('exits 0 when the report matches the pinned baseline', function() {
        setup();
        assert.equal(ratchet.main(mainArgs()), 0);
    });

    test('exits 2 when a fresh file appears over threshold', function() {
        setup();
        writeTmp('js/brandNewDup.js', new Array(101).join('x\n'));
        reportPath = writeTmp('report-fresh.txt', [
            'js/fakeA.js:8: 12.50% duplicated lines > 1%',
            'js/fakeB.js:43: 1.01% duplicated lines > 1%',
            'js/brandNewDup.js:3: 4.20% duplicated lines > 1%',
            '3/192 files over 1% duplication'
        ].join('\n'));
        assert.equal(ratchet.main(mainArgs()), 2);
    });

    test('exits 2 when a pinned file gained absolute duplicated lines', function() {
        setup();
        reportPath = writeTmp('report-regressed.txt', [
            'js/fakeA.js:8: 12.50% duplicated lines > 1%',
            'js/fakeB.js:43: 2.02% duplicated lines > 1%',
            '2/192 files over 1% duplication'
        ].join('\n'));
        assert.equal(ratchet.main(mainArgs()), 2);
    });

    test('exits 0 when only the percentage moved (file shrank, absolute flat)', function() {
        setup();
        writeTmp('js/fakeB.js', new Array(133).join('x\n')); // 198 -> 132 lines
        reportPath = writeTmp('report-shifted.txt', [
            'js/fakeA.js:8: 12.50% duplicated lines > 1%',
            'js/fakeB.js:43: 1.52% duplicated lines > 1%',
            '2/192 files over 1% duplication'
        ].join('\n'));
        assert.equal(ratchet.main(mainArgs()), 0);
    });

    test('exits 0 on a clean measurement with zero tool violations', function() {
        setup();
        reportPath = writeTmp('report-clean.txt', '192 files, 0.80% duplicated lines');
        assert.equal(ratchet.main(mainArgs()), 0);
    });

    test('a crashed measurement (tool exit other than 0/2) never passes', function() {
        setup();
        assert.equal(ratchet.main([reportPath, baselinePath, '1', tmpDir]), 2);
    });

    test('exits 2 when the baseline file is missing', function() {
        setup();
        assert.equal(ratchet.main([reportPath, path.join(tmpDir, 'nope.json'), '2', tmpDir]), 2);
    });

    test('exits 2 when the baseline is not valid JSON', function() {
        setup();
        var bad = writeTmp('bad.json', '{not json');
        assert.equal(ratchet.main([reportPath, bad, '2', tmpDir]), 2);
    });

    test('exits 2 when the baseline has no pinned map', function() {
        setup();
        var noMap = writeTmp('nomap.json', JSON.stringify({ version: 2 }));
        assert.equal(ratchet.main([reportPath, noMap, '2', tmpDir]), 2);
    });

    test('exits 2 when the report file is missing', function() {
        setup();
        assert.equal(ratchet.main([path.join(tmpDir, 'nope.txt'), baselinePath, '2', tmpDir]), 2);
    });

    test('exits 2 when a violated file cannot be read for line counting', function() {
        setup();
        reportPath = writeTmp('report-ghost.txt', [
            'js/ghostFile.js:3: 4.20% duplicated lines > 1%',
            '1/192 files over 1% duplication'
        ].join('\n'));
        assert.equal(ratchet.main(mainArgs()), 2);
    });

});
