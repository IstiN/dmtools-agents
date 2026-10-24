/**
 * Unit tests: quality-gate config contract (gh-1251).
 *
 * Pins the three artifacts that keep the JS duplication quality gates honest:
 *
 *   1. crap4dart.yaml — the file-level `similarity` gate must scan JavaScript
 *      sources (the `**` glob over `*.js`) alongside markdown (`**` glob over
 *      `*.md`, mirroring dmtools-dart) and exclude `js/unit-tests/**`.
 *   2. .github/workflows/quality.yml — must run
 *      `crap4js duplicates --threshold 1 --exclude "js/unit-tests/**" js ci`
 *      and evaluate it as a RATCHET via ci/duplicationRatchet.js against
 *      duplication-baseline.json (fails PRs and main on a NEW over-threshold
 *      file or a pinned file that gained ABSOLUTE duplicated lines; the
 *      pinned pre-existing debt owned by gh-1244…gh-1250 — see the baseline
 *      for the current set — does not fail it), and publish an
 *      overall-duplication `duplication.json` badge from the same measurement
 *      in the "Publish README badges" step.
 *   3. README.md — must render the duplication endpoint badge.
 *
 * These are string-level contract tests (no YAML parser in the GraalJS
 * runtime); they guard against silent gate regressions — e.g. a yaml edit
 * that drops the JS glob from the similarity include or renames the badge file.
 *
 * Uses: file_read, assert, test(), suite()
 */

'use strict';

/* global file_read, assert, test, suite */

function readRepoFile(path) {
    var content = file_read({ path: path });
    assert.ok(content !== null && content !== undefined && content.length > 0,
        path + ' must exist and be non-empty');
    return String(content);
}

var CRAP4DART_YAML = readRepoFile('crap4dart.yaml');
var QUALITY_YML = readRepoFile('.github/workflows/quality.yml');
var README_MD = readRepoFile('README.md');

// ── 1. crap4dart.yaml — similarity gate covers JS sources ────────────────────

suite('crap4dart.yaml similarity gate — gh-1251 JS sources contract', function() {

    test('include scans both markdown and JavaScript sources', function() {
        assert.ok(/include:\s*\[[^\]]*'\*\*\/\*\.md'[^\]]*'\*\*\/\*\.js'[^\]]*\]/.test(CRAP4DART_YAML) ||
                  /include:\s*\[[^\]]*'\*\*\/\*\.js'[^\]]*'\*\*\/\*\.md'[^\]]*\]/.test(CRAP4DART_YAML),
            'gates.similarity include must carry **/*.md and **/*.js');
    });

    test('exclude drops the unit-test tree from similarity', function() {
        assert.ok(CRAP4DART_YAML.indexOf("'js/unit-tests/**'") !== -1 ||
                  CRAP4DART_YAML.indexOf('"js/unit-tests/**"') !== -1,
            'gates.similarity exclude must carry js/unit-tests/**');
    });

});

// ── 2. quality.yml — duplicates gate + duplication badge ─────────────────────

suite('quality.yml — gh-1251 duplication gate and badge contract', function() {

    test('enforces crap4js duplicates <= 1% on production JS (js + ci)', function() {
        assert.ok(QUALITY_YML.indexOf('duplicates --threshold 1 --exclude "js/unit-tests/**" js ci') !== -1,
            'quality.yml must run crap4js duplicates --threshold 1 --exclude "js/unit-tests/**" js ci');
        assert.ok(QUALITY_YML.indexOf('node_modules/.bin/crap4js" duplicates') !== -1,
            'the duplicates gate must run the pinned tool from the isolated prefix');
    });

    // The gate step, sliced out of the workflow by its step name (the command
    // string also appears in the workflow header comment — anchor on the step).
    function gateStepBlock() {
        var nameIdx = QUALITY_YML.indexOf('- name: Duplication gate');
        assert.ok(nameIdx !== -1, 'duplicates gate step must exist');
        var nextStep = QUALITY_YML.indexOf('\n      - name:', nameIdx + 1);
        return QUALITY_YML.slice(nameIdx, nextStep === -1 ? QUALITY_YML.length : nextStep);
    }

    test('duplicates gate is a ratchet against the pinned baseline', function() {
        assert.ok(QUALITY_YML.indexOf('ci/duplicationRatchet.js') !== -1,
            'the duplicates gate must evaluate the report through ci/duplicationRatchet.js');
        assert.ok(QUALITY_YML.indexOf('duplication-baseline.json') !== -1,
            'the duplicates gate must compare against duplication-baseline.json');
        // The tool exits 2 while pinned debt remains — the step must capture
        // the code instead of letting -e kill the step before the ratchet runs.
        var stepBlock = gateStepBlock();
        assert.ok(stepBlock.indexOf('set +e') !== -1,
            'the gate step must capture the tool exit code with set +e (exit 2 is expected while debt is pinned)');
    });

    test('duplication baseline pins the over-threshold files without a magic count', function() {
        var raw = file_read({ path: 'duplication-baseline.json' });
        var baseline = JSON.parse(String(raw));
        assert.ok(baseline && typeof baseline === 'object', 'duplication-baseline.json must parse as an object');
        assert.equal(baseline.threshold, 1, 'baseline threshold must be 1 (mirrors the gate)');
        assert.ok(baseline.pinned && typeof baseline.pinned === 'object',
            'baseline must carry a pinned file map');
        var files = Object.keys(baseline.pinned);
        // Non-drifting invariants only: the count moves with every dedup
        // landing (gh-1244..gh-1250), so never pin a point-in-time number.
        assert.ok(files.length > 0, 'baseline must pin the current debt files');
        assert.ok(files.length <= 85, 'baseline must never exceed the gh-1251 historical maximum of 85 files');
        files.forEach(function(f) {
            assert.ok(/\.(js|mjs|cjs)$/.test(f), 'pinned entry must be a production JS file: ' + f);
            assert.ok(file_read({ path: f }) !== null, 'pinned file must exist in the repo: ' + f);
            var entry = baseline.pinned[f];
            assert.ok(entry && typeof entry === 'object',
                'pinned entry must be a { pct, lines } object (absolute-lines ratchet): ' + f);
            assert.ok(typeof entry.pct === 'number' && entry.pct > 1,
                'pinned pct must be a number above the 1% threshold: ' + f);
            assert.ok(typeof entry.lines === 'number' && entry.lines >= 1 && entry.lines % 1 === 0,
                'pinned lines must be a positive integer duplicated-line count: ' + f);
        });
    });

    test('duplicates gate step is a hard gate (not continue-on-error)', function() {
        var stepBlock = gateStepBlock();
        assert.ok(stepBlock.indexOf('continue-on-error') === -1,
            'the duplicates gate must fail the workflow — no continue-on-error');
    });

    test('badges step computes overall duplication % and writes duplication.json', function() {
        var badgesIdx = QUALITY_YML.indexOf('Publish README badges');
        assert.ok(badgesIdx !== -1, 'Publish README badges step must exist');
        assert.ok(QUALITY_YML.indexOf('duplication.json') !== -1,
            'badges step must publish a duplication.json endpoint file');
        assert.ok(/duplication/i.test(QUALITY_YML.slice(badgesIdx)),
            'badges step must compute the overall duplication percentage');
    });

});

// ── 3. README.md — duplication badge ─────────────────────────────────────────

suite('README.md — gh-1251 duplication badge contract', function() {

    test('renders the shields.io endpoint badge for duplication.json', function() {
        assert.ok(README_MD.indexOf('badges%2Fduplication.json') !== -1 ||
                  README_MD.indexOf('badges/duplication.json') !== -1,
            'README.md must carry a shields.io endpoint badge pointing at duplication.json');
    });

});
