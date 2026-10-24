/**
 * Unit tests: ci/duplicationRatchet.js (gh-1251 rework).
 *
 * The quality.yml duplication gate is a RATCHET, not an absolute bar: the
 * 85 production JS files already over 1% duplicated lines are pinned in
 * duplication-baseline.json (pre-existing debt owned by the gh-1244…gh-1250
 * dedup tickets) and only a NEW over-threshold file or an INCREASED
 * percentage fails the gate. These tests pin that behavior end to end:
 *
 *   - parseViolations: multi-item report parsing, summary-line/noise
 *     filtering, empty input.
 *   - compareWithBaseline: clean pass on identical debt, fresh-file
 *     regression, percentage-increase regression, percentage-decrease
 *     improvement, cleared debt, empty baseline, zero violations.
 *   - main: CLI exit codes for ratchet-clean, fresh regression, and a
 *     crashed measurement (tool exit other than 0/2 must never pass).
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
            '85/191 files over 1% duplication',
            'trailing note without a violation shape'
        ].join('\n');
        var v = ratchet.parseViolations(report);
        assert.deepEqual(v, [{ file: 'js/moveToDone.js', line: 8, percent: 12.50 }]);
    });

    test('empty report parses to no violations', function() {
        assert.deepEqual(ratchet.parseViolations(''), []);
        assert.deepEqual(ratchet.parseViolations('85/191 files over 1% duplication'), []);
    });

});

// ── compareWithBaseline ──────────────────────────────────────────────────────

function baselineOf(map) {
    return { version: 1, threshold: 1, pinned: map };
}

var DEBT = baselineOf({
    'js/moveToDone.js': 12.50,
    'js/mergeTrigger.js': 1.01
});

suite('duplicationRatchet — compareWithBaseline', function() {

    test('identical debt is clean — pinned files do not fail the gate', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/moveToDone.js', line: 8, percent: 12.50 },
            { file: 'js/mergeTrigger.js', line: 43, percent: 1.01 }
        ], DEBT);
        assert.equal(result.clean, true);
        assert.deepEqual(result.fresh, []);
        assert.deepEqual(result.regressions, []);
        assert.equal(result.pinnedCount, 2);
    });

    test('a NEW file over threshold is a fresh regression', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/moveToDone.js', line: 8, percent: 12.50 },
            { file: 'js/brandNewDup.js', line: 3, percent: 4.20 }
        ], DEBT);
        assert.equal(result.clean, false);
        assert.deepEqual(result.fresh, [{ file: 'js/brandNewDup.js', percent: 4.20 }]);
        assert.equal(result.regressions.length, 0);
    });

    test('an INCREASED percentage on a pinned file is a regression', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/mergeTrigger.js', line: 43, percent: 1.50 },
            { file: 'js/moveToDone.js', line: 8, percent: 12.50 }
        ], DEBT);
        assert.equal(result.clean, false);
        assert.deepEqual(result.regressions, [
            { file: 'js/mergeTrigger.js', from: 1.01, to: 1.50 }
        ]);
    });

    test('a DECREASED percentage is clean and reported as improved', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/mergeTrigger.js', line: 43, percent: 0.99 },
            { file: 'js/moveToDone.js', line: 8, percent: 12.50 }
        ], DEBT);
        assert.equal(result.clean, true);
        assert.deepEqual(result.improved, [
            { file: 'js/mergeTrigger.js', from: 1.01, to: 0.99 }
        ]);
    });

    test('debt cleared below threshold is clean and reported as cleared', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/moveToDone.js', line: 8, percent: 12.50 }
        ], DEBT);
        assert.equal(result.clean, true);
        assert.deepEqual(result.cleared, ['js/mergeTrigger.js']);
    });

    test('empty baseline makes every violation fresh', function() {
        var result = ratchet.compareWithBaseline([
            { file: 'js/moveToDone.js', line: 8, percent: 12.50 }
        ], baselineOf({}));
        assert.equal(result.clean, false);
        assert.deepEqual(result.fresh, [{ file: 'js/moveToDone.js', percent: 12.50 }]);
    });

    test('zero violations is clean even with a non-empty baseline', function() {
        var result = ratchet.compareWithBaseline([], DEBT);
        assert.equal(result.clean, true);
        assert.deepEqual(result.cleared, ['js/moveToDone.js', 'js/mergeTrigger.js']);
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
        fs.writeFileSync(p, content);
        return p;
    }

    // suite()/test() have no beforeEach in this harness — set up per test.
    function setup() {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-ratchet-'));
        baselinePath = writeTmp('baseline.json', JSON.stringify(DEBT));
        reportPath = writeTmp('report.txt', [
            'js/moveToDone.js:8: 12.50% duplicated lines > 1%',
            'js/mergeTrigger.js:43: 1.01% duplicated lines > 1%',
            '2/191 files over 1% duplication'
        ].join('\n'));
    }

    test('exits 0 when the report matches the pinned baseline', function() {
        setup();
        assert.equal(ratchet.main([reportPath, baselinePath, '2']), 0);
    });

    test('exits 2 when a fresh file appears over threshold', function() {
        setup();
        reportPath = writeTmp('report-fresh.txt', [
            'js/moveToDone.js:8: 12.50% duplicated lines > 1%',
            'js/mergeTrigger.js:43: 1.01% duplicated lines > 1%',
            'js/brandNewDup.js:3: 4.20% duplicated lines > 1%',
            '3/191 files over 1% duplication'
        ].join('\n'));
        assert.equal(ratchet.main([reportPath, baselinePath, '2']), 2);
    });

    test('exits 2 when a pinned percentage regressed', function() {
        setup();
        reportPath = writeTmp('report-regressed.txt', [
            'js/moveToDone.js:8: 12.50% duplicated lines > 1%',
            'js/mergeTrigger.js:43: 2.00% duplicated lines > 1%',
            '2/191 files over 1% duplication'
        ].join('\n'));
        assert.equal(ratchet.main([reportPath, baselinePath, '2']), 2);
    });

    test('exits 0 on a clean measurement with zero tool violations', function() {
        setup();
        reportPath = writeTmp('report-clean.txt', '191 files, 0.80% duplicated lines');
        assert.equal(ratchet.main([reportPath, baselinePath, '0']), 0);
    });

    test('a crashed measurement (tool exit other than 0/2) never passes', function() {
        setup();
        assert.equal(ratchet.main([reportPath, baselinePath, '1']), 2);
    });

});
