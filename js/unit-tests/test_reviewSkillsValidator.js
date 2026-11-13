/**
 * The gh-1406 §8 validator wiring: `scripts/validate-review-skills.js`
 * runs green on THIS repo's own pool configuration (factory base +
 * security) and on a valid repo fixture, and exits 1 naming the failure on
 * a deliberately broken repo fixture.
 *
 * Guarded like the other cli_execute_command suites: when node is not on
 * PATH in the test environment the suite skips (the CI quality gate runs
 * the validator as a workflow step too — that gate does not skip).
 */

function nodeAvailable() {
    try {
        var out = cli_execute_command({ command: "bash -lc 'node --version'" });
        return !!(out && String(out).indexOf('v') === 0);
    } catch (e) {
        return false;
    }
}

var VALIDATOR = 'scripts/validate-review-skills.js';
var FIXTURES = 'js/unit-tests/_fixtures/review-skills';

// node is not on the dmtools runner's command whitelist; bash is — the
// validator runs through bash with the exit code echoed on the last line.
function runValidator(repoRoot) {
    var raw = cli_execute_command({ command: "bash -lc 'node " + VALIDATOR + ' ' + repoRoot + " 2>&1; echo EXIT=$?'" });
    var text = String(raw || '');
    var match = /EXIT=(\d+)/.exec(text);
    return { exit: match ? parseInt(match[1], 10) : -1, output: text };
}

suite('validate-review-skills — the gh-1406 §8 CI gate wiring', function() {
    if (!nodeAvailable()) {
        test('skipped (node unavailable in this environment)', function() {
            assert.ok(true, 'the validator wiring test needs node; the CI workflow gate covers it');
        });
        return;
    }

    test('this repo validates: factory base + security, exit 0', function() {
        var r = runValidator('.');
        assert.equal(r.exit, 0, 'validator output:\n' + r.output);
        assert.ok(r.output.indexOf('reviewer "base" (factory)') !== -1);
        assert.ok(r.output.indexOf('reviewer "security" (factory)') !== -1);
        assert.ok(r.output.indexOf('OK') !== -1);
    });

    test('a valid repo fixture passes (repo-defined reviewers + promptAppend + tuning)', function() {
        var r = runValidator(FIXTURES + '/valid');
        assert.equal(r.exit, 0, 'validator output:\n' + r.output);
        assert.ok(r.output.indexOf('reviewer "legal" (repo)') !== -1, 'repo-defined reviewer listed');
    });

    test('the consuming-repo layout (pack at agents/) validates — factory lens paths resolve against the pack root', function() {
        // gh-1406 §8 usage contract: "from the consuming repo root, with the
        // agents pack available". The factory skill files' `lens` values are
        // PACK-relative ("instructions/pr_review/..."); with the pack at
        // agents/ the read must resolve against <repoRoot>/agents/ — not
        // repoRoot — or every factory lens false-fails as "missing or empty"
        // and the gate exits 1 with no flag combination to fix it.
        var r = runValidator(FIXTURES + '/consuming');
        assert.equal(r.exit, 0, 'validator output:\n' + r.output);
        assert.ok(r.output.indexOf('reviewer "base" (factory)') !== -1);
        assert.ok(r.output.indexOf('reviewer "security" (factory)') !== -1);
        assert.ok(r.output.indexOf('lens file missing or empty') === -1,
            'factory lens files exist under agents/ — no missing-lens error may surface:\n' + r.output);
        assert.ok(r.output.indexOf('OK') !== -1);
    });

    test('a broken repo fixture fails with exit 1 and names the duplicate-reviewer error', function() {
        var r = runValidator(FIXTURES + '/broken');
        assert.equal(r.exit, 1, 'validator output:\n' + r.output);
        assert.ok(r.output.indexOf('FAILED') !== -1);
        assert.ok(r.output.indexOf('duplicate reviewer name') !== -1,
            'the §8 check 4 error must surface: ' + r.output);
    });

    test('a repo with no pool files at all passes trivially (no pool configured)', function() {
        var r = runValidator('js/unit-tests/_fixtures');
        assert.equal(r.exit, 0, 'validator output:\n' + r.output);
        assert.ok(r.output.indexOf('0 reviewer(s) validated') !== -1);
    });
});
