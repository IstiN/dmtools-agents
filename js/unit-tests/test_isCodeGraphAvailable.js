/**
 * Unit tests for js/conditions/isCodeGraphAvailable.js
 */

function loadCondition(mocks) {
    return loadModule(
        'js/conditions/isCodeGraphAvailable.js',
        null,
        Object.assign({
            file_exists: function () { return false; },
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
            file_exists: function (args) {
                return args.path === '.dmtools-target-workingdir';
            },
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

    test('uses whitelisted git command instead of bash and checks file_exists before reading marker (#1286)', function () {
        var commands = [];
        var readCalled = false;
        var mod = loadCondition({
            file_exists: function () { return false; },
            file_read: function () {
                readCalled = true;
                return null;
            },
            cli_execute_command: function (args) {
                commands.push(args);
                if (args.command.indexOf('bash ') === 0) {
                    throw new Error('SecurityException: Command not allowed: bash');
                }
                return '/usr/local/bin/codegraph\n';
            }
        });

        assert.equal(mod.action({}), true);
        assert.equal(readCalled, false, 'file_read must not be called when file_exists(.dmtools-target-workingdir) is false');
        assert.equal(commands.length, 2);
        assert.ok(commands[0].command.indexOf('git ') === 0, 'directory check must start with whitelisted git command');
        assert.ok(commands[1].command.indexOf('git ') === 0, 'binary check must start with whitelisted git command');
    });
});

    test('markerExists falls back gracefully when file_exists is absent or throws', function () {
        var readCount = 0;
        var modNoFileExists = loadCondition({
            file_exists: undefined,
            file_read: function (args) {
                readCount++;
                return '/tmp/from-read';
            },
            cli_execute_command: function () { return '/usr/local/bin/codegraph\n'; }
        });
        assert.equal(modNoFileExists.resolveWorkingDir({}), '/tmp/from-read');
        assert.equal(readCount, 1);

        var modThrowingExists = loadCondition({
            file_exists: function () { throw new Error('exists error'); },
            file_read: function () { throw new Error('should not be called'); }
        });
        assert.equal(modThrowingExists.resolveWorkingDir({}), null);
    });
