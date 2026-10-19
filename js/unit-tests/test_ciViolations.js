/**
 * Unit tests for js/common/ciViolations.js (gh-1119)
 *
 * Scope: the pure CI-log violation extractor + ownership tagger + the
 * ci_failures.md violations-block builder + the owned-violation summary
 * validator. All shapes are covered with real log fixtures copied from the
 * #433 quality run (gate job 118246938987, agents-gate job 118249670863)
 * plus the documented dart analyze / dart test / crap4j / jscpd shapes.
 *
 * AC map:
 *   UT-1 (AC1)  gate log yields exactly one owned violation (file added by the PR)
 *   UT-2 (AC2)  agents-gate log yields one foreign item (file not in the diff)
 *   UT-3 (AC3)  buildViolationsMarkdown opens with the owned table, then the foreign list
 *   UT-4 (AC4)  dart analyze fixture
 *   UT-5 (AC4)  dart test fixture
 *   UT-6 (AC4)  crap4j fixture
 *   UT-7 (AC4)  jscpd fixture
 *   UT-8 (AC6)  summary validator rejects "unrelated"/"not caused by this PR" while owned items are open
 *   E1-E3      rename ownership, 50-row table cap, path normalization
 *
 * Uses: loadModule(), assert, test(), suite()
 */

var FIXTURE_DIR = 'js/unit-tests/fixtures/ci_logs/';

function readFixture(name) {
    var content = file_read({ path: FIXTURE_DIR + name });
    assert.ok(content && String(content).length > 0, 'fixture ' + name + ' must exist and be non-empty');
    return String(content);
}

// Shared fixture texts (read once at load — file_read is real in the runner).
var GATE_LOG = readFixture('gate_crap4dart.log');
var AGENTS_GATE_LOG = readFixture('agents_gate.log');
var DIFF_433 = readFixture('diff_pr_433.txt');

var cv = loadModule('js/common/ciViolations.js');

// ── extractViolations — shape parsers ────────────────────────────────────────

suite('ciViolations.extractViolations — crap4dart/crap4j shape (UT-6)', function() {

    test('UT-6: [FAIL] header + indented path:line detail lines produce one item per detail', function() {
        var items = cv.extractViolations(GATE_LOG, 'gate');
        assert.equal(items.length, 1, 'exactly one violation line under the [FAIL] header');
        assert.equal(items[0].check, 'gate');
        assert.equal(items[0].rule, 'method_size');
        assert.equal(items[0].path, 'test/js/require_base_resolution_test.dart');
        assert.equal(items[0].line, 13);
        assert.equal(items[0].detail, 'main has 100 lines > max 60');
    });

    test('the [PASS]/[WARN] boundary terminates a FAIL section — later detail lines are not swallowed', function() {
        var log = '[FAIL] method_size: 2 violations over limits\n' +
            ' a/one.dart:1: a has 10 lines > max 5\n' +
            '[PASS] method_complexity: 0 violations\n' +
            ' ignored/should_not_parse.dart:9: not a violation line\n' +
            '[FAIL] file_size: 1 violations over limits\n' +
            ' b/two.dart:2: b has 400 lines > max 300\n';
        var items = cv.extractViolations(log, 'gate');
        assert.equal(items.length, 2, 'one item per [FAIL] section');
        assert.equal(items[0].path, 'a/one.dart');
        assert.equal(items[0].rule, 'method_size');
        assert.equal(items[1].path, 'b/two.dart');
        assert.equal(items[1].rule, 'file_size');
    });
});

suite('ciViolations.extractViolations — dart analyze shape (UT-4)', function() {

    test('UT-4: error/warning/info bullet lines produce one item each with the lint code as rule', function() {
        var items = cv.extractViolations(readFixture('dart_analyze.log'), 'analyze');
        assert.equal(items.length, 3, 'all three severities are extracted');
        assert.equal(items[0].rule, 'undefined_method');
        assert.equal(items[0].path, 'lib/widgets/foo_widget.dart');
        assert.equal(items[0].line, 12);
        assert.ok(String(items[0].detail).indexOf("The method 'build' isn't defined") === 0,
            'detail carries the analyzer message');
        assert.equal(items[1].rule, 'unused_import');
        assert.equal(items[1].path, 'lib/utils/legacy.dart');
        assert.equal(items[2].rule, 'blank_line_check');
    });
});

suite('ciViolations.extractViolations — dart test shape (UT-5)', function() {

    test('UT-5: "<path>: <test name> [E]" lines produce one item per failing test', function() {
        var items = cv.extractViolations(readFixture('dart_test.log'), 'test');
        assert.equal(items.length, 2, 'two failing tests');
        assert.equal(items[0].path, 'test/js/foo_test.dart');
        assert.equal(items[0].rule, 'test');
        assert.equal(items[0].detail, 'subtracts numbers');
        assert.equal(items[1].path, 'test/js/bar_test.dart');
        assert.equal(items[1].detail, 'wraps text');
    });
});

suite('ciViolations.extractViolations — jscpd duplication blocks (UT-7)', function() {

    test('UT-7: each "Clone found" block yields the first file as the violation, counterpart in the detail', function() {
        var items = cv.extractViolations(readFixture('jscpd.log'), 'gate');
        assert.equal(items.length, 2, 'one violation per clone block');
        assert.equal(items[0].rule, 'jscpd');
        assert.equal(items[0].path, 'lib/models/user.dart');
        assert.equal(items[0].line, 10);
        assert.ok(String(items[0].detail).indexOf('lib/models/profile.dart') !== -1,
            'detail names the duplicated counterpart');
        assert.equal(items[1].path, 'lib/services/auth_service.dart');
        assert.equal(items[1].line, 100);
    });
});

suite('ciViolations.extractViolations — generic error lines (fallback)', function() {

    test('::error file=,line= annotations extract path + line + message', function() {
        var items = cv.extractViolations(readFixture('generic_error.log'), 'build');
        assert.equal(items.length, 2, 'the annotation and the ##[error] line');
        assert.equal(items[0].path, 'scripts/deploy.sh');
        assert.equal(items[0].line, 8);
        assert.ok(String(items[0].detail).indexOf('Permission denied') === 0);
    });

    test('##[error] lines fall back to a path token inside the message when no path:line is present', function() {
        var items = cv.extractViolations(AGENTS_GATE_LOG, 'agents-gate');
        assert.equal(items.length, 1);
        assert.equal(items[0].path, 'js/unit-tests/test_recoverDirtyReviewTestCase.js');
        assert.equal(items[0].line, null, 'no line number in the message');
        assert.ok(String(items[0].detail).indexOf('planned-file partition mismatch') === 0);
    });

    test('##[error] without any path yields a pathless item (ownership unknown)', function() {
        var items = cv.extractViolations('##[error]Process completed with exit code 1.\n', 'deploy');
        assert.equal(items.length, 1);
        assert.notOk(items[0].path);
        assert.ok(String(items[0].detail).indexOf('exit code 1') !== -1);
    });
});

suite('ciViolations.extractViolations — determinism and degradation (I2, I3)', function() {

    test('I3/AC5: an unknown log shape yields no violations — never a made-up item', function() {
        assert.deepEqual(cv.extractViolations(readFixture('unknown_shape.log'), 'gate'), []);
    });

    test('I2: extraction is deterministic — same input, same items, twice', function() {
        var first = cv.extractViolations(GATE_LOG, 'gate');
        var second = cv.extractViolations(GATE_LOG, 'gate');
        assert.deepEqual(first, second);
    });

    test('null/empty logs yield no violations', function() {
        assert.deepEqual(cv.extractViolations(null, 'gate'), []);
        assert.deepEqual(cv.extractViolations('', 'gate'), []);
    });

    test('a line is never reported twice — consumed lines are skipped by later shape parsers', function() {
        var items = cv.extractViolations(GATE_LOG, 'gate');
        var seen = {};
        items.forEach(function(v) {
            var key = v.rule + '|' + v.path + '|' + v.line;
            assert.notOk(seen[key], 'duplicate violation key ' + key);
            seen[key] = true;
        });
    });
});

// ── ownership tagging ────────────────────────────────────────────────────────

suite('ciViolations.parseDiffPaths + tagOwnership', function() {

    test('diff paths include both old and new names (E1 — renamed files stay owned)', function() {
        var diff = 'diff --git a/js/old_name.dart b/js/new_name.dart\n' +
            'similarity index 95%\n' +
            'rename from js/old_name.dart\n' +
            'rename to js/new_name.dart\n' +
            '--- a/js/old_name.dart\n' +
            '+++ b/js/new_name.dart\n';
        var paths = cv.parseDiffPaths(diff);
        assert.ok(paths.indexOf('js/old_name.dart') !== -1, 'old name in the list');
        assert.ok(paths.indexOf('js/new_name.dart') !== -1, 'new name in the list');
    });

    test('UT-1 (AC1): the #433 gate log yields exactly one OWNED violation — the file the PR added', function() {
        var items = cv.extractAndTagViolations([{ name: 'gate', logs: GATE_LOG }], DIFF_433);
        assert.equal(items.length, 1);
        assert.equal(items[0].ownership, 'owned');
        assert.equal(items[0].path, 'test/js/require_base_resolution_test.dart');
        assert.equal(items[0].rule, 'method_size');
        assert.equal(items[0].line, 13);
    });

    test('UT-2 (AC2): the #433 agents-gate log yields one FOREIGN item — the file is not in the diff', function() {
        var items = cv.extractAndTagViolations([{ name: 'agents-gate', logs: AGENTS_GATE_LOG }], DIFF_433);
        assert.equal(items.length, 1);
        assert.equal(items[0].ownership, 'foreign');
        assert.equal(items[0].path, 'js/unit-tests/test_recoverDirtyReviewTestCase.js');
    });

    test('a pathless violation is ownership unknown', function() {
        var items = cv.extractAndTagViolations([
            { name: 'deploy', logs: '##[error]Process completed with exit code 1.\n' }
        ], DIFF_433);
        assert.equal(items.length, 1);
        assert.equal(items[0].ownership, 'unknown');
    });

    test('E1: a violation in a file the PR renamed is OWNED via the old path', function() {
        var diff = 'diff --git a/lib/old_widget.dart b/lib/new_widget.dart\n' +
            'rename from lib/old_widget.dart\n' +
            'rename to lib/new_widget.dart\n';
        var items = cv.extractAndTagViolations([
            { name: 'gate', logs: '[FAIL] method_size: 1 violations\n lib/old_widget.dart:7: run has 80 lines > max 60\n' }
        ], diff);
        assert.equal(items.length, 1);
        assert.equal(items[0].ownership, 'owned', 'old rename path counts as owned');
    });

    test('no diff text (null) → pathed violations degrade to unknown, never "foreign, do not chase"', function() {
        var items = cv.extractAndTagViolations([{ name: 'gate', logs: GATE_LOG }], null);
        assert.equal(items[0].ownership, 'unknown');
    });

    test('unknown-ownership items render as a note, never inside the "do not chase" table', function() {
        var md = cv.buildViolationsMarkdown(
            cv.extractAndTagViolations([{ name: 'gate', logs: GATE_LOG }], null));
        assert.notContains(md, 'Violations you must fix');
        assert.notContains(md, 'do not chase');
        assert.contains(md, 'no attributable file path');
    });
});

suite('ciViolations.normalizePath (E3)', function() {

    test('E3: backslashes, ./ prefixes and Windows drive letters are normalized', function() {
        assert.equal(cv.normalizePath('lib\\widgets\\foo.dart'), 'lib/widgets/foo.dart');
        assert.equal(cv.normalizePath('./lib/widgets/foo.dart'), 'lib/widgets/foo.dart');
        assert.equal(cv.normalizePath('.\\lib\\widgets\\foo.dart'), 'lib/widgets/foo.dart');
        assert.equal(cv.normalizePath('C:\\repo\\lib\\foo.dart'), 'repo/lib/foo.dart');
        assert.equal(cv.normalizePath('"lib/foo.dart"'), 'lib/foo.dart');
    });

    test('E3: a Windows-shaped violation path matches the diff path after normalization', function() {
        var items = cv.extractAndTagViolations([
            { name: 'gate', logs: '[FAIL] method_size: 1 violations\n .\\test\\js\\require_base_resolution_test.dart:13: main has 100 lines > max 60\n' }
        ], DIFF_433);
        assert.equal(items.length, 1);
        assert.equal(items[0].ownership, 'owned', 'backslash/./-prefixed path still matches the diff');
    });

    test('a CI-runner-absolute violation path (deeper prefix) still matches the diff path', function() {
        var items = cv.extractAndTagViolations([
            { name: 'gate', logs: '[FAIL] method_size: 1 violations\n /home/runner/work/repo/repo/test/js/require_base_resolution_test.dart:13: main has 100 lines > max 60\n' }
        ], DIFF_433);
        assert.equal(items.length, 1);
        assert.equal(items[0].ownership, 'owned', 'runner-rooted prefix is tolerated');
    });
});

// ── ci_failures.md violations block (AC3) ────────────────────────────────────

suite('ciViolations.buildViolationsMarkdown (UT-3, AC3)', function() {

    function tagBoth() {
        return cv.extractAndTagViolations([
            { name: 'gate', logs: GATE_LOG },
            { name: 'agents-gate', logs: AGENTS_GATE_LOG }
        ], DIFF_433);
    }

    test('UT-3 (AC3): the owned table opens the block, the foreign list follows', function() {
        var md = cv.buildViolationsMarkdown(tagBoth());
        var ownedIdx = md.indexOf('Violations you must fix');
        var foreignIdx = md.indexOf('Foreign / infra reds');
        assert.ok(ownedIdx !== -1, 'owned section present');
        assert.ok(foreignIdx !== -1, 'foreign section present');
        assert.ok(ownedIdx < foreignIdx, 'owned table comes BEFORE the foreign list');
        assert.notContains(md, 'Error log (last 500 lines)', 'the raw log tails are NOT part of the block');
        assert.contains(md, 'Violations you must fix (1 owned)');
        assert.contains(md, 'test/js/require_base_resolution_test.dart:13');
        assert.contains(md, 'main has 100 lines > max 60');
        assert.contains(md, 'js/unit-tests/test_recoverDirtyReviewTestCase.js');
    });

    test('the owned section carries the no-dismissal rule the prompt references', function() {
        var md = cv.buildViolationsMarkdown(tagBoth());
        assert.contains(md, 'may not be dismissed');
        assert.contains(md, 'disputed:');
    });

    test('owned-only logs produce no foreign section and vice versa', function() {
        var ownedOnly = cv.buildViolationsMarkdown(
            cv.extractAndTagViolations([{ name: 'gate', logs: GATE_LOG }], DIFF_433));
        assert.ok(ownedOnly.indexOf('Violations you must fix') !== -1);
        assert.notContains(ownedOnly, 'Foreign / infra reds');

        var foreignOnly = cv.buildViolationsMarkdown(
            cv.extractAndTagViolations([{ name: 'agents-gate', logs: AGENTS_GATE_LOG }], DIFF_433));
        assert.notContains(foreignOnly, 'Violations you must fix');
        assert.ok(foreignOnly.indexOf('Foreign / infra reds') !== -1);
    });

    test('AC5/REG-1: no extracted violations → empty string, no table (the tail stays as today)', function() {
        assert.equal(cv.buildViolationsMarkdown([]), '');
        assert.equal(cv.buildViolationsMarkdown(
            cv.extractAndTagViolations([{ name: 'gate', logs: readFixture('unknown_shape.log') }], DIFF_433)), '');
    });

    test('E2: more than 50 violations cap the table rows at 50 with an overflow count', function() {
        var lines = [];
        for (var i = 1; i <= 60; i++) {
            lines.push(' gen/big_' + (i < 10 ? '0' : '') + i + '.dart:' + i + ': method m' + i + ' has ' + (60 + i) + ' lines > max 60');
        }
        var log = '[FAIL] method_size: 60 violations over limits\n' + lines.join('\n') + '\n';
        // A non-empty diff (none of the 60 files in it) classifies the items
        // foreign so the capped table is exercised.
        var items = cv.extractAndTagViolations([{ name: 'gate', logs: log }],
            'diff --git a/other/unrelated.txt b/other/unrelated.txt\n');
        assert.equal(items.length, 60, 'all 60 extracted');
        var md = cv.buildViolationsMarkdown(items);
        var rowCount = 0;
        md.split('\n').forEach(function(l) { if (l.indexOf('gen/big_') === 0 || l.indexOf('| gate |') !== -1) rowCount++; });
        assert.ok(rowCount <= 50, 'table rows capped at 50 (saw ' + rowCount + ')');
        assert.contains(md, 'of 60', 'overflow count is shown');
    });
});

// ── ci_violations.json summary (E2) ─────────────────────────────────────────

suite('ciViolations.violationsSummaryJson', function() {

    test('counts by ownership and carries the FULL list (E2: uncapped)', function() {
        var items = cv.extractAndTagViolations([
            { name: 'gate', logs: GATE_LOG },
            { name: 'agents-gate', logs: AGENTS_GATE_LOG }
        ], DIFF_433);
        var summary = cv.violationsSummaryJson(items);
        assert.equal(summary.owned, 1);
        assert.equal(summary.foreign, 1);
        assert.equal(summary.unknown, 0);
        assert.equal(summary.violations.length, 2, 'full list, uncapped');
        assert.equal(summary.violations[0].ownership, 'owned');
        assert.ok(summary.generatedAt === null || typeof summary.generatedAt === 'string');
    });
});

// ── owned-violation summary validator (AC6, UT-8) ────────────────────────────

suite('ciViolations.validateOwnedViolationsSummary (UT-8, AC6)', function() {

    var OWNED = [{ check: 'gate', rule: 'method_size', path: 'test/js/require_base_resolution_test.dart',
        line: 13, detail: 'main has 100 lines > max 60', ownership: 'owned' }];

    test('UT-8: "not caused by this PR" with an owned violation open → rejected', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            '## Approach\nThe gate failure is not caused by this PR, none of my files exceed the limit.',
            OWNED);
        assert.notOk(verdict.ok);
        assert.ok(String(verdict.errors.join(' ')).indexOf('not caused by this PR') !== -1);
    });

    test('UT-8: "unrelated" with an owned violation open → rejected', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            'The method_size violation is unrelated — violation is in code the PR does not touch.',
            OWNED);
        assert.notOk(verdict.ok);
    });

    test('"classified as infra" with an owned violation open → rejected', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            'Both reds were classified as infra (base-branch issues).',
            OWNED);
        assert.notOk(verdict.ok);
    });

    test('a dismissal claim rejects even when a disputed line exists (blanket dismissal ≠ per-item dispute)', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            'Not caused by this PR.\n- disputed: the limit is wrong for generated tests\n',
            OWNED);
        assert.notOk(verdict.ok);
    });

    test('per-item accounting passes: fixed with the violation path cited', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            '## Owned CI violations\n- fixed: test/js/require_base_resolution_test.dart main() split into helpers\n',
            OWNED);
        assert.ok(verdict.ok, 'errors: ' + JSON.stringify(verdict.errors || []));
    });

    test('per-item accounting passes: disputed with a concrete reason', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            '## Owned CI violations\n- disputed: the method_size limit is misconfigured for test scaffolding (limit 60, file is generated)\n',
            OWNED);
        assert.ok(verdict.ok, 'errors: ' + JSON.stringify(verdict.errors || []));
    });

    test('an owned violation mentioned without fixed/disputed accounting is unaccounted → rejected', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            '## Files Modified\n- test/js/require_base_resolution_test.dart (touched)\n',
            OWNED);
        assert.notOk(verdict.ok);
        assert.ok(String(verdict.errors.join(' ')).indexOf('unaccounted') !== -1);
    });

    test('no owned violations → always ok, even with a dismissal claim (nothing owned to dismiss)', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            'The failure is unrelated to this PR.',
            [{ check: 'gate', rule: 'test', path: 'other/x.dart', line: 1, detail: 'd', ownership: 'foreign' }]);
        assert.ok(verdict.ok);
    });

    test('no violations at all → ok', function() {
        assert.ok(cv.validateOwnedViolationsSummary('anything at all', []).ok);
        assert.ok(cv.validateOwnedViolationsSummary(null, null).ok);
    });

    test('mixed owned + foreign: only the owned item must be accounted', function() {
        var violations = OWNED.concat([
            { check: 'agents-gate', rule: 'test', path: 'js/unit-tests/test_recoverDirtyReviewTestCase.js',
                line: null, detail: 'partition mismatch', ownership: 'foreign' }
        ]);
        var verdict = cv.validateOwnedViolationsSummary(
            '- fixed: test/js/require_base_resolution_test.dart split\n- agents-gate red is on the base branch, left alone\n',
            violations);
        assert.ok(verdict.ok, 'errors: ' + JSON.stringify(verdict.errors || []));
    });
});
