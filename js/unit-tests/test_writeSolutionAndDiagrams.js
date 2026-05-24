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

suite('writeSolutionAndDiagrams — required outputs', function() {
    test('fails when diagram is required but missing', function() {
        var module = loadModule(
            'agents/js/writeSolutionAndDiagrams.js',
            makeRequire({ './config.js': configModule }),
            {
                file_read: function(path) {
                    if (path === 'outputs/response.md') return 'h2. Solution';
                    throw new Error('not found: ' + path);
                },
                jira_update_field: function() {
                    throw new Error('should not update Jira when required diagram is missing');
                }
            }
        );

        var result = module.action({
            ticket: { key: 'MAPC-1' },
            customParams: {
                solutionField: 'High-Level Solution',
                diagramField: '',
                requireDiagram: true
            }
        });

        assert.equal(result.success, false, 'action fails');
        assert.equal(result.error, 'outputs/diagram.md is required but empty', 'clear error');
    });
});
