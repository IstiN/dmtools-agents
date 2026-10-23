/**
 * Unit tests for js/conditions/isCodeGraphAvailable.js
 */

function loadCondition(mocks) {
    return loadModule(
        'js/conditions/isCodeGraphAvailable.js',
        null,
        Object.assign({
            file_read: function () { throw new Error('ENOENT'); },
            cli_execute_command: function () { return '/usr/local/bin/codegraph\n'; }
        }, mocks || {})
    );
}

suite('isCodeGraphAvailable condition', function () {

    test('returns true when .codegraph exists and codegraph binary is on PATH', function () {
        var commands = [];
        var mod = loadCondition({
            cli_execute_command: function (args) {
                commands.push(args);
                if (args.command.indexOf('command -v codegraph') !== -1) {
                    return '/usr/local/bin/codegraph\n';
                }
                return '';
            }
        });

        assert.equal(mod.action({}), true);
        assert.equal(commands.length, 2);
        assert.contains(commands[0].command, 'test -d .codegraph');
        assert.contains(commands[1].command, 'command -v codegraph');
    });

    test('returns false when .codegraph directory does not exist', function () {
        var mod = loadCondition({
            cli_execute_command: function (args) {
                if (args.command.indexOf('test -d .codegraph') !== -1) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                return '/usr/local/bin/codegraph\n';
            }
        });

        assert.equal(mod.action({}), false);
    });

    test('returns false when codegraph binary is not installed', function () {
        var mod = loadCondition({
            cli_execute_command: function (args) {
                if (args.command.indexOf('command -v codegraph') !== -1) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                return '';
            }
        });

        assert.equal(mod.action({}), false);
    });

    test('returns false when command -v codegraph returns empty output', function () {
        var mod = loadCondition({
            cli_execute_command: function () {
                return '   \n';
            }
        });

        assert.equal(mod.action({}), false);
    });

    test('resolves workingDirectory from .dmtools-target-workingdir when present', function () {
        var commands = [];
        var mod = loadCondition({
            file_read: function (args) {
                if (args.path === '.dmtools-target-workingdir') {
                    return ' /tmp/target-repo \n';
                }
                throw new Error('ENOENT');
            },
            cli_execute_command: function (args) {
                commands.push(args);
                return '/usr/local/bin/codegraph\n';
            }
        });

        assert.equal(mod.action({ workingDirectory: '/tmp/fallback' }), true);
        assert.equal(commands[0].workingDirectory, '/tmp/target-repo');
        assert.equal(commands[1].workingDirectory, '/tmp/target-repo');
    });

    test('falls back to params.workingDirectory when .dmtools-target-workingdir is absent', function () {
        var commands = [];
        var mod = loadCondition({
            cli_execute_command: function (args) {
                commands.push(args);
                return '/usr/local/bin/codegraph\n';
            }
        });

        assert.equal(mod.action({ workingDirectory: '/tmp/work-dir' }), true);
        assert.equal(commands[0].workingDirectory, '/tmp/work-dir');
        assert.equal(commands[1].workingDirectory, '/tmp/work-dir');
    });
});

// ── Conditional cliPrompts section validation ────────────────────────────────

suite('validateAgentJson — conditional cliPrompts section objects', function() {

    function mockCliWithExistingFiles(args) {
        var cmd = (args && args.command) || '';
        if (cmd.indexOf('prompts/codegraph_tools.md') !== -1 ||
            cmd.indexOf('js/conditions/isCodeGraphAvailable.js') !== -1) {
            return 'EXISTS';
        }
        return 'MISSING';
    }

    test('accepts section object with id, prompt, and existing condition script', function() {
        var mockValidator = loadModule(
            'js/agentValidator.js',
            null,
            {
                file_read: function(args) {
                    if (args.path === 'mock_agent.json') {
                        return JSON.stringify({
                            name: 'Teammate',
                            params: {
                                cliPrompts: [
                                    'Role',
                                    {
                                        id: 'codegraph',
                                        prompt: './agents/prompts/codegraph_tools.md',
                                        condition: 'agents/js/conditions/isCodeGraphAvailable.js'
                                    }
                                ]
                            }
                        });
                    }
                    return file_read(args);
                },
                cli_execute_command: mockCliWithExistingFiles
            }
        );
        var res = mockValidator.validateAgentJson('mock_agent.json');
        assert.equal(res.valid, true, 'errors: ' + JSON.stringify(res.errors));
    });

    test('reports error when section object is missing id, prompt/prompts, or condition file does not exist', function() {
        var mockValidator = loadModule(
            'js/agentValidator.js',
            null,
            {
                file_read: function(args) {
                    if (args.path === 'bad_agent.json') {
                        return JSON.stringify({
                            name: 'Teammate',
                            params: {
                                cliPrompts: [
                                    {
                                        id: '',
                                        condition: 'agents/js/conditions/nonExistentCondition.js'
                                    }
                                ]
                            }
                        });
                    }
                    return null;
                },
                cli_execute_command: mockCliWithExistingFiles
            }
        );
        var res = mockValidator.validateAgentJson('bad_agent.json');
        assert.equal(res.valid, false);
        assert.ok(res.errors.some(function(e) { return e.indexOf('non-empty string "id"') !== -1; }));
        assert.ok(res.errors.some(function(e) { return e.indexOf('must define "prompt"') !== -1; }));
        assert.ok(res.errors.some(function(e) { return e.indexOf('condition file not found') !== -1; }));
    });
});
