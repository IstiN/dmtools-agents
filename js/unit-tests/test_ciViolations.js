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

/** Instruction-pack files (gh-1134 UT-5) — tests run with cwd = repo root. */
function readPackFile(path) {
    var content = file_read({ path: path });
    assert.ok(content !== null && content !== undefined && String(content).length > 0,
        'pack file ' + path + ' must exist and be non-empty');
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

    test('a clone block with a single entry degrades to a pathless-counterpart detail', function() {
        var items = cv.extractViolations(
            'Clone found (dart):\n lib/solo.dart: 40-70\n', 'gate');
        assert.equal(items.length, 1);
        assert.equal(items[0].path, 'lib/solo.dart');
        assert.equal(items[0].line, 40);
        assert.equal(items[0].detail, 'duplicated lines 40-70');
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

    test('deleted files (--- a/.., +++ /dev/null) still count as diff paths', function() {
        var diff = 'diff --git a/lib/gone.dart b/lib/gone.dart\n' +
            '--- a/lib/gone.dart\n' +
            '+++ /dev/null\n';
        var paths = cv.parseDiffPaths(diff);
        assert.deepEqual(paths, ['lib/gone.dart']);
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

// ── review-thread fixes (2026-10-20 rework leg) ──────────────────────────────

// Thread PRT_kwDORYAuYs6uJ0xk (BLOCKING): parser order — the greedy crap4j
// section scanner ran first and swallowed dart-analyze bullets appearing
// after a [FAIL] header in the same (concatenated) job log, mangling their
// path/rule and rendering a genuine owned red under "do not chase".
suite('ciViolations.extractViolations — combined gate + dart-analyze log (parser order)', function() {

    test('a dart-analyze bullet AFTER a [FAIL] section keeps its clean path/rule and tags OWNED', function() {
        var log = readFixture('gate_plus_analyze.log');
        var diff = 'diff --git a/test/js/require_base_resolution_test.dart b/test/js/require_base_resolution_test.dart\n' +
            '--- /dev/null\n+++ b/test/js/require_base_resolution_test.dart\n@@ -0,0 +1,3 @@\n+void main() {}\n' +
            'diff --git a/lib/widgets/foo_widget.dart b/lib/widgets/foo_widget.dart\n' +
            '--- /dev/null\n+++ b/lib/widgets/foo_widget.dart\n@@ -0,0 +1 @@\n+class FooWidget {}\n';

        var tagged = cv.extractAndTagViolations([{ name: 'gate', logs: log }], diff);

        var crap = tagged.filter(function(v) { return v.rule === 'method_size'; });
        assert.equal(crap.length, 1, 'the crap4j detail line still parses exactly once');
        assert.equal(crap[0].path, 'test/js/require_base_resolution_test.dart');
        assert.equal(crap[0].line, 13);
        assert.equal(crap[0].ownership, 'owned');

        var analyze = tagged.filter(function(v) { return v.path === 'lib/widgets/foo_widget.dart'; });
        assert.equal(analyze.length, 1,
            'the analyze bullet must survive with its CLEAN path (not swallowed into a mangled crap4j item): '
            + JSON.stringify(tagged));
        assert.equal(analyze[0].rule, 'undefined_method', 'the lint code is the rule');
        assert.equal(analyze[0].line, 12);
        assert.equal(analyze[0].ownership, 'owned',
            'an in-diff analyze error is OWNED — never "foreign, do not chase"');
    });

    test('pure dart-analyze logs are unaffected by the parser order change (UT-4 stays pinned)', function() {
        var items = cv.extractViolations(readFixture('dart_analyze.log'), 'analyze');
        assert.ok(items.length > 0, 'dart analyze fixture still extracts');
        assert.ok(items.every(function(v) { return v.rule && v.path; }));
    });
});

// Thread PRT_kwDORYAuYs6uJ0zj (IMPORTANT): the blanket-dismissal scan must
// not reject fully-accounted summaries that merely describe a FOREIGN red —
// the foreign note tells the leg to mention them, and "unrelated" is that
// vocabulary. Claims inside foreign-red sections (or on fixed/disputed
// accounting lines) are not blanket dismissals of owned work.
suite('ciViolations.validateOwnedViolationsSummary — dismissal scan scoping', function() {

    var OWNED = [{ check: 'gate', rule: 'method_size', path: 'test/js/require_base_resolution_test.dart',
        line: 13, detail: 'main has 100 lines > max 60', ownership: 'owned' }];

    test('a fully-accounted summary that describes a FOREIGN red as "unrelated" passes', function() {
        var summary = [
            '## Owned CI violations',
            '- fixed: test/js/require_base_resolution_test.dart main() split into helpers',
            '## Foreign reds',
            '- the agents-gate red is unrelated to this PR (partition race on the base branch)'
        ].join('\n');
        var verdict = cv.validateOwnedViolationsSummary(summary, OWNED);
        assert.ok(verdict.ok, 'errors: ' + JSON.stringify(verdict.errors || []));
    });

    test('a dismissal claim OUTSIDE foreign sections still rejects even when a fixed line exists', function() {
        var summary = '## Owned CI violations\n- fixed: test/js/require_base_resolution_test.dart split\n' +
            'The method_size red is not caused by this PR anyway.\n';
        var verdict = cv.validateOwnedViolationsSummary(summary, OWNED);
        assert.notOk(verdict.ok, 'a blanket claim in owned scope is still a dismissal');
    });

    test('findDismissalClaim ignores accounting lines and foreign-red sections, still sees bare claims', function() {
        assert.equal(cv.findDismissalClaim('- fixed: a.dart (the old code was unrelated to the pr)'), null,
            'an accounting line is the structured alternative, not a dismissal');
        assert.equal(cv.findDismissalClaim('## Foreign reds\n- z.dart red is unrelated to this PR'), null,
            'foreign-section mention is the vocabulary the foreign note asks for');
        assert.equal(cv.findDismissalClaim('not caused by this PR'), 'not caused by this PR');
        assert.equal(cv.findDismissalClaim('## Owned CI violations\n- x is unrelated'), 'unrelated',
            'a claim in owned scope still rejects');
    });
});

// Thread PRT_kwDORYAuYs6uJ01M (SUGGESTION): accounting precision — the word
// "test" (dart-test rule name) or a bare "fixed" must not settle a
// differently-named owned violation.
suite('ciViolations.validateOwnedViolationsSummary — accounting precision (multi-owned)', function() {

    var OWNED_TWO = [
        { check: 'gate', rule: 'test', path: 'lib/a.dart', line: 1, detail: 'd1', ownership: 'owned' },
        { check: 'gate', rule: 'test', path: 'lib/c_test.dart', line: 2, detail: 'd2', ownership: 'owned' }
    ];

    test('a "fixed" line containing the word "test" does not settle a differently-named owned file', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            '- fixed: lib/a.dart and added a test\n', OWNED_TWO);
        assert.notOk(verdict.ok, 'with several owned items the path must be cited');
        assert.ok(String(verdict.errors.join(' ')).indexOf('c_test.dart') !== -1,
            'c_test.dart stays unaccounted: ' + JSON.stringify(verdict.errors || []));
    });

    test('multi-owned: per-item accounting with both paths passes', function() {
        var verdict = cv.validateOwnedViolationsSummary(
            '- fixed: lib/a.dart split\n- disputed: lib/c_test.dart is generated scaffolding\n', OWNED_TWO);
        assert.ok(verdict.ok, JSON.stringify(verdict.errors || []));
    });

    test('single-owned fallback does not account when the line names a DIFFERENT violation file', function() {
        var OWNED_ONE = [{ check: 'gate', rule: 'test', path: 'lib/a.dart', line: 1, detail: 'd', ownership: 'owned' }];
        var FOREIGN = [{ check: 'agents-gate', rule: 'test', path: 'js/unit-tests/test_recoverDirtyReviewTestCase.js',
            line: null, detail: 'partition mismatch', ownership: 'foreign' }];
        var verdict = cv.validateOwnedViolationsSummary(
            '- fixed: js/unit-tests/test_recoverDirtyReviewTestCase.js on the base branch\n',
            OWNED_ONE.concat(FOREIGN));
        assert.notOk(verdict.ok, 'the fixed line names the foreign file, not the owned one');
    });

    test('single-owned: a disputed line naming the rule still accounts (heuristic leniency kept)', function() {
        var OWNED_ONE = [{ check: 'gate', rule: 'method_size', path: 'lib/a.dart', line: 1, detail: 'd', ownership: 'owned' }];
        var verdict = cv.validateOwnedViolationsSummary(
            '- disputed: the method_size limit is misconfigured for generated scaffolding\n', OWNED_ONE);
        assert.ok(verdict.ok, JSON.stringify(verdict.errors || []));
    });
});

// Thread PRT_kwDORYAuYs6uJ04O (SUGGESTION): parseDiffPaths must not ingest
// phantom paths from diff CONTENT lines (added lines rendering as "+++ text"
// or deleted lines as "--- text" after a hunk header).
suite('ciViolations.parseDiffPaths — hunk content never joins the diff path set', function() {

    test('added/deleted content lines starting with ++/-- after a hunk header are not diff paths', function() {
        var diff = 'diff --git a/docs/guide.md b/docs/guide.md\n' +
            '--- a/docs/guide.md\n+++ b/docs/guide.md\n' +
            '@@ -1,3 +1,4 @@\n' +
            ' context line\n' +
            '+++ example of embedded diff text\n' +
            '--- not a path\n' +
            'diff --git a/real.dart b/real.dart\n' +
            '--- /dev/null\n+++ b/real.dart\n@@ -0,0 +1 @@\n+void main() {}\n';
        var paths = cv.parseDiffPaths(diff);
        assert.ok(paths.indexOf('docs/guide.md') !== -1, 'real target path parsed');
        assert.ok(paths.indexOf('real.dart') !== -1, 'second file target path parsed');
        assert.equal(paths.indexOf('example of embedded diff text'), -1, '+++ content line is not a path');
        assert.equal(paths.indexOf('not a path'), -1, '--- content line is not a path');
        assert.equal(paths.length, 2, 'no phantom paths: ' + JSON.stringify(paths));
    });

    test('a ---/+++ pair with no diff --git header and no hunks still parses (bare-pair diff)', function() {
        var paths = cv.parseDiffPaths('--- a/only.dart\n+++ b/only.dart\n');
        assert.deepEqual(paths, ['only.dart']);
    });

    test('the #433 fixture diff still yields its real paths (no regression from hunk gating)', function() {
        var paths = cv.parseDiffPaths(DIFF_433);
        assert.ok(paths.indexOf('js/common/githubHelpers.js') !== -1, JSON.stringify(paths));
        assert.ok(paths.indexOf('test/js/require_base_resolution_test.dart') !== -1, JSON.stringify(paths));
    });
});

// Thread PRT_kwDORYAuYs6uJ05y (SUGGESTION): the greedy "^.*##\[error\]" anchor
// kept only the LAST marker of a line — extract each marker's segment.
suite('ciViolations.extractViolations — multiple ##[error] markers on one line', function() {

    test('each ##[error] marker yields its own message segment', function() {
        var log = '##[error]lint failed in src/a.dart:12 ##[error]and src/b.dart:9 has issues\n';
        var items = cv.extractViolations(log, 'ci');
        assert.equal(items.length, 2, 'one item per marker, not just the last: ' + JSON.stringify(items));
        assert.equal(items[0].detail, 'lint failed in src/a.dart:12');
        assert.equal(items[0].path, 'src/a.dart');
        assert.equal(items[1].detail, 'and src/b.dart:9 has issues');
        assert.equal(items[1].path, 'src/b.dart');
    });

    test('single-marker lines are unchanged (pinned fallback shape)', function() {
        var items = cv.extractViolations('##[error]Process completed with exit code 1.\n', 'ci');
        assert.equal(items.length, 1);
        assert.equal(items[0].detail, 'Process completed with exit code 1.');
        assert.equal(items[0].path, null);
    });
});

// Thread PRT_kwDORYAuYs6uJ07q (SUGGESTION): the dart-test progress prefix
// capped at \d{1,2}:\d{2} — suites running >=100 minutes lost their [E] lines.
suite('ciViolations.extractViolations — dart-test long-run progress prefix', function() {

    test('a failure line with a >=100 minute elapsed prefix still extracts', function() {
        var log = '00:02 +51: loading test/dart_test_shape.dart\n' +
            '102:33 +583 -12: test/long_suite.dart: the whole suite times out [E]\n' +
            '102:33 +583 -13: Some tests failed.\n';
        var items = cv.extractViolations(log, 'test-runner');
        var paths = items.map(function(v) { return v.path; });
        assert.ok(paths.indexOf('test/long_suite.dart') !== -1,
            '>=100:00 prefix line extracted: ' + JSON.stringify(items));
        assert.equal(items[0].rule, 'test');
    });
});

// gh-1134 (#433 rework-loop-escalated): the `static` job failed on
// `dart format --set-exit-if-changed` — "Formatted <file>" lines with the
// summary "Formatted 495 files (3 changed) in 1.08 seconds." The extractor
// had no shape for them, the rework leg reported "0 owned" and finished
// green over a one-command fix.
suite('ciViolations.extractViolations — dart format shape (gh-1134, UT-1/UT-2)', function() {

    var STATIC_LOG = readFixture('static_dart_format.log');
    var STATIC_DIFF = readFixture('diff_pr_433_static.txt');

    test('UT-1 (AC1): the #433 static log yields exactly three dart_format items, all OWNED', function() {
        var items = cv.extractAndTagViolations([{ name: 'static', logs: STATIC_LOG }], STATIC_DIFF);
        var fmt = items.filter(function(v) { return v.rule === 'dart_format'; });
        assert.equal(fmt.length, 3, 'exactly three dart_format items: ' + JSON.stringify(items));
        assert.deepEqual(fmt.map(function(v) { return v.path; }), [
            'test/js/require_base_resolution_test.dart',
            'lib/src/js/async_job_pool.dart',
            'lib/src/cli/run_command_processor.dart'
        ]);
        fmt.forEach(function(v) {
            assert.equal(v.check, 'static', 'check is the job name');
            assert.equal(v.line, 1, 'whole-file violation: line 1');
            assert.equal(v.detail, 'not dart-formatted');
            assert.equal(v.ownership, 'owned', v.path + ' is in the PR diff');
        });
    });

    test('UT-2 (AC2): the "Formatted N files (M changed)" summary line yields no item', function() {
        assert.deepEqual(
            cv.extractViolations('Formatted 495 files (3 changed) in 1.08 seconds.\n', 'static'), []);
    });

    test('UT-2 (AC2): a 0-changed run log yields no items at all (green run noise)', function() {
        var items = cv.extractViolations(
            'Formatted 495 files (0 changed) in 1.08 seconds.\n', 'static');
        assert.deepEqual(items, []);
    });

    test('Windows/CRLF variant: backslash path and trailing \\r extract and match the diff', function() {
        var items = cv.extractAndTagViolations([
            { name: 'static', logs: 'Formatted lib\\src\\js\\async_job_pool.dart\r\n' }
        ], STATIC_DIFF);
        assert.equal(items.length, 1, 'CRLF-safe line still matches: ' + JSON.stringify(items));
        assert.equal(items[0].rule, 'dart_format');
        assert.equal(items[0].path, 'lib\\src\\js\\async_job_pool.dart');
        assert.equal(items[0].ownership, 'owned', 'normalized backslash path matches the diff');
    });

    test('a non-.dart token after "Formatted" is not a violation line', function() {
        var items = cv.extractViolations(
            'Formatted 3 files in 1.08 seconds.\nFormatted output written.\n', 'static');
        assert.deepEqual(items, []);
    });

    test('I2/UT-3: a Formatted file OUTSIDE the diff is FOREIGN, still listed', function() {
        var items = cv.extractAndTagViolations([
            { name: 'static', logs: 'Formatted lib/src/js/async_job_pool.dart\nFormatted lib/generated/auto.dart\nFormatted lib/src/cli/run_command_processor.dart\n' }
        ], STATIC_DIFF);
        assert.equal(items.length, 3, 'every Formatted file is listed');
        var foreign = items.filter(function(v) { return v.ownership === 'foreign'; });
        assert.equal(foreign.length, 1, 'exactly one foreign item: ' + JSON.stringify(items));
        assert.equal(foreign[0].path, 'lib/generated/auto.dart');
        assert.equal(items.filter(function(v) { return v.ownership === 'owned'; }).length, 2,
            'the in-diff files stay owned');
    });

    test('UT-4 (AC4): the owned table renders the dart_format rows (snapshot)', function() {
        var md = cv.buildViolationsMarkdown(
            cv.extractAndTagViolations([{ name: 'static', logs: STATIC_LOG }], STATIC_DIFF));
        assert.contains(md, 'Violations you must fix (3 owned)');
        assert.contains(md, '| static | dart_format | `test/js/require_base_resolution_test.dart:1` | not dart-formatted |');
        assert.contains(md, '| static | dart_format | `lib/src/js/async_job_pool.dart:1` | not dart-formatted |');
        assert.contains(md, '| static | dart_format | `lib/src/cli/run_command_processor.dart:1` | not dart-formatted |');
    });

    test('UT-5 (AC5): the rework guidance carries the dart format remediation line', function() {
        var md = readPackFile('instructions/pr_rework/general_guidelines.md');
        assert.ok(md.indexOf('dart format .') !== -1,
            'remediation: `dart format .` on the whole tree');
        assert.ok(md.indexOf('dart format --set-exit-if-changed --output=none .') !== -1,
            'verification: `dart format --set-exit-if-changed --output=none .` before pushing');
    });
});

