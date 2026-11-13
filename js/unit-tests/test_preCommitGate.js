/**
 * Unit tests for ci/preCommitGate.cjs and .githooks/pre-commit contract.
 *
 * Uses: loadModule(), assert, test(), suite(), file_read
 */
'use strict';

/* global loadModule, assert, test, suite, file_read */

var gate = loadModule('ci/preCommitGate.cjs');

suite('preCommitGate.isProdJsPath / isTestJsPath', function() {

    test('identifies production js/**/*.js files and excludes test dirs', function() {
        assert.equal(gate.isProdJsPath('js/smAgent.js'), true);
        assert.equal(gate.isProdJsPath('js/common/scm.js'), true);
        assert.equal(gate.isProdJsPath('js/sm/sources/githubSource.js'), true);
        assert.equal(gate.isProdJsPath('js/unit-tests/test_smAgent.js'), false);
        assert.equal(gate.isProdJsPath('js/test/foo.js'), false);
        assert.equal(gate.isProdJsPath('js/integration-tests/bar.js'), false);
        assert.equal(gate.isProdJsPath('ci/preCommitGate.cjs'), false);
        assert.equal(gate.isProdJsPath('README.md'), false);
        assert.equal(gate.isProdJsPath(''), false);
        assert.equal(gate.isProdJsPath(null), false);
    });

    test('identifies test paths across unit-tests, test, integration-tests', function() {
        assert.equal(gate.isTestJsPath('js/unit-tests/test_smAgent.js'), true);
        assert.equal(gate.isTestJsPath('js/test/helper.js'), true);
        assert.equal(gate.isTestJsPath('js/integration-tests/e2e.js'), true);
        assert.equal(gate.isTestJsPath('js/smAgent.js'), false);
        assert.equal(gate.isTestJsPath(''), false);
    });

});

suite('preCommitGate.classifyStagedFiles', function() {

    test('partitions staged paths into prodJs and testJs', function() {
        var res = gate.classifyStagedFiles([
            './js/smAgent.js',
            'js/common/pullRequest.js',
            'js/unit-tests/test_smAgent.js',
            'js/unit-tests/run_smAgent.json',
            'README.md',
            ''
        ]);
        assert.deepEqual(res.prodJs, ['js/smAgent.js', 'js/common/pullRequest.js']);
        assert.deepEqual(res.testJs, ['js/unit-tests/test_smAgent.js']);
    });

    test('handles non-array input gracefully', function() {
        var res = gate.classifyStagedFiles(null);
        assert.deepEqual(res.prodJs, []);
        assert.deepEqual(res.testJs, []);
    });

});

suite('preCommitGate.extractCrap4jsRef', function() {

    test('extracts CRAP4JS_REF sha from quality.yml content', function() {
        var yml = 'env:\n  CRAP4JS_REF: 2d99360df25cec4c7e713801eb2c2da22731a6e\n';
        assert.equal(gate.extractCrap4jsRef(yml), '2d99360df25cec4c7e713801eb2c2da22731a6e');
    });

    test('falls back to DEFAULT_CRAP4JS_REF when missing', function() {
        assert.equal(gate.extractCrap4jsRef('name: empty\n'), gate.DEFAULT_CRAP4JS_REF);
        assert.equal(gate.extractCrap4jsRef(null), gate.DEFAULT_CRAP4JS_REF);
    });

    test('matches the live .github/workflows/quality.yml CRAP4JS_REF', function() {
        var liveYml = file_read({ path: '.github/workflows/quality.yml' });
        var ref = gate.extractCrap4jsRef(liveYml);
        assert.ok(/^[0-9a-f]{40}$/.test(ref), 'live CRAP4JS_REF must be a 40-char git sha: ' + ref);
    });

});

suite('preCommitGate.resolveMatchingTestFiles', function() {

    test('resolves via run_<stem>.json and test_<stem>.js when present', function() {
        var fakeFs = {
            'js/unit-tests/run_smAgent.json': JSON.stringify({
                params: { jobParams: { testFiles: ['js/unit-tests/test_smAgent.js', 'js/unit-tests/test_smAsync.js'] } }
            }),
            'js/unit-tests/test_smAgent.js': '// test'
        };
        var res = gate.resolveMatchingTestFiles({
            stagedProdFiles: ['js/smAgent.js'],
            stagedTestFiles: [],
            readFile: function(p) { return fakeFs[p] || null; },
            unitTestEntries: []
        });
        assert.deepEqual(res.testFiles, ['js/unit-tests/test_smAgent.js', 'js/unit-tests/test_smAsync.js']);
        assert.deepEqual(res.unmatchedProd, []);
    });

    test('falls back to scanning unitTestEntries when no direct run_<stem>.json or test_<stem>.js exists', function() {
        var res = gate.resolveMatchingTestFiles({
            stagedProdFiles: ['js/agentDocGenerator.js'],
            stagedTestFiles: ['js/unit-tests/test_preCommitGate.js'],
            readFile: function() { return null; },
            unitTestEntries: [
                { path: 'js/unit-tests/test_agentDocs.js', content: "loadModule('js/agentDocGenerator.js');" },
                { path: 'js/unit-tests/test_other.js', content: "loadModule('js/other.js');" }
            ]
        });
        assert.deepEqual(res.testFiles, [
            'js/unit-tests/test_preCommitGate.js',
            'js/unit-tests/test_agentDocs.js'
        ]);
        assert.deepEqual(res.unmatchedProd, []);
    });

    test('records unmatchedProd when neither direct nor fallback test exists', function() {
        var res = gate.resolveMatchingTestFiles({
            stagedProdFiles: ['js/brandNewUntestedModule.js'],
            stagedTestFiles: [],
            readFile: function() { return null; },
            unitTestEntries: [
                { path: 'js/unit-tests/test_other.js', content: "loadModule('js/other.js');" }
            ]
        });
        assert.deepEqual(res.testFiles, []);
        assert.deepEqual(res.unmatchedProd, ['js/brandNewUntestedModule.js']);
    });

});

suite('.githooks/pre-commit contract', function() {

    test('tracked .githooks/pre-commit enforces runtime-artifact guard, nyc instrument, module-size, nesting, and crap4js threshold 8', function() {
        var hook = file_read({ path: '.githooks/pre-commit' });
        assert.contains(hook, 'ci/runtime-artifact-patterns.txt');
        assert.contains(hook, 'instrument --exit-on-error');
        assert.contains(hook, 'module-size --max-lines 500');
        assert.contains(hook, 'ci/module-size-baseline.json');
        assert.contains(hook, 'nesting "${PROD_JS[@]}"');
        assert.contains(hook, '--threshold 8');
        assert.contains(hook, '--require-coverage');
        assert.contains(hook, '.cache/crap-tools');
    });

});
