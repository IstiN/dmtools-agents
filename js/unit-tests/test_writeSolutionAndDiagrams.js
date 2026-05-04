/**
 * Unit tests for agents/js/writeSolutionAndDiagrams.js module loading.
 */

suite('writeSolutionAndDiagrams — module export', function() {
    test('exports action for GraalJS require wrappers', function() {
        var module = loadModule(
            'agents/js/writeSolutionAndDiagrams.js',
            makeRequire({ './config.js': configModule }),
            {}
        );

        assert.equal(typeof module.action, 'function', 'module.action');
    });
});
