/**
 * Unit tests: quality-gate config contract (gh-1251).
 *
 * Pins the three artifacts that keep the JS duplication quality gates honest:
 *
 *   1. crap4dart.yaml — the file-level `similarity` gate must scan JavaScript
 *      sources (the `**` glob over `*.js`) alongside markdown (`**` glob over
 *      `*.md`, mirroring dmtools-dart) and exclude `js/unit-tests/**`.
 *   2. .github/workflows/quality.yml — must enforce
 *      `crap4js duplicates --threshold 1 --exclude "js/unit-tests/**" js ci`
 *      (fails PRs and main when a production JS file exceeds 1% duplicated
 *      lines) and publish an overall-duplication `duplication.json` badge from
 *      the same measurement in the "Publish README badges" step.
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

    test('duplicates gate step is a hard gate (not continue-on-error)', function() {
        var gateIdx = QUALITY_YML.indexOf('duplicates --threshold 1');
        assert.ok(gateIdx !== -1, 'duplicates gate step must exist');
        var stepStart = QUALITY_YML.lastIndexOf('- name:', gateIdx);
        assert.ok(stepStart !== -1, 'gate step must be a named step');
        var nextStep = QUALITY_YML.indexOf('- name:', gateIdx);
        var stepBlock = QUALITY_YML.slice(stepStart, nextStep === -1 ? QUALITY_YML.length : nextStep);
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
