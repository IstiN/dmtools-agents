/**
 * Unit tests for js/common/setupCommands.js
 */

function loadSetupCommands(mocks) {
    var commands = [];
    var mod = loadModule(
        'js/common/setupCommands.js',
        null,
        Object.assign({
            cli_execute_command: function(args) {
                commands.push(args);
                return 'ok';
            }
        }, mocks || {})
    );
    return { mod: mod, commands: commands };
}

suite('setupCommands helper', function() {

    test('does nothing when customParams.setupCommands is absent', function() {
        var loaded = loadSetupCommands();
        var result = loaded.mod.runSetupCommands({}, './dependencies/repo');

        assert.equal(result.ran, 0);
        assert.deepEqual(loaded.commands, []);
    });

    test('does nothing when customParams.setupCommands is not an array', function() {
        var loaded = loadSetupCommands();
        var result = loaded.mod.runSetupCommands({ setupCommands: 'not-an-array' }, './dependencies/repo');

        assert.equal(result.ran, 0);
        assert.deepEqual(loaded.commands, []);
    });

    test('runs plain string commands in the default working directory', function() {
        var loaded = loadSetupCommands();
        var result = loaded.mod.runSetupCommands({
            setupCommands: ['bash agents/setup/java.sh 25', 'bash agents/setup/maven.sh 3.9.9']
        }, './dependencies/gens-igt');

        assert.equal(result.ran, 2);
        assert.equal(loaded.commands.length, 2);
        assert.equal(loaded.commands[0].command, 'bash agents/setup/java.sh 25');
        assert.equal(loaded.commands[0].workingDirectory, './dependencies/gens-igt');
        assert.equal(loaded.commands[1].workingDirectory, './dependencies/gens-igt');
        assert.equal(result.results[0].success, true);
    });

    test('object entries can override workingDir and name', function() {
        var loaded = loadSetupCommands();
        var result = loaded.mod.runSetupCommands({
            setupCommands: [
                { name: 'install-java', command: 'bash agents/setup/java.sh 25' },
                { name: 'custom-dir', command: 'ls', workingDir: '/tmp/other' }
            ]
        }, './dependencies/gens-igt');

        assert.equal(loaded.commands[0].workingDirectory, './dependencies/gens-igt', 'falls back to default working dir');
        assert.equal(loaded.commands[1].workingDirectory, '/tmp/other', 'entry-level workingDir overrides default');
        assert.equal(result.results[0].name, 'install-java');
        assert.equal(result.results[1].name, 'custom-dir');
    });

    test('plain string command failures are non-fatal and recorded', function() {
        var loaded = loadSetupCommands({
            cli_execute_command: function() { throw new Error('boom'); }
        });

        var result = loaded.mod.runSetupCommands({
            setupCommands: ['some-flaky-warmup-command']
        }, './dependencies/repo');

        assert.equal(result.ran, 1);
        assert.equal(result.results[0].success, false);
        assert.equal(result.results[0].error, 'boom');
    });

    test('allowFailure: false makes a failing command throw and stop the loop', function() {
        var calls = [];
        var loaded = loadSetupCommands({
            cli_execute_command: function(args) {
                calls.push(args.command);
                if (args.command === 'check-required-creds') {
                    throw new Error('MAVEN_USER not set');
                }
                return 'ok';
            }
        });

        var threw = false;
        try {
            loaded.mod.runSetupCommands({
                setupCommands: [
                    { name: 'required-check', command: 'check-required-creds', allowFailure: false },
                    { name: 'should-not-run', command: 'never-called' }
                ]
            }, './dependencies/repo');
        } catch (e) {
            threw = true;
            assert.ok(e.message.indexOf('required-check') !== -1, 'error should mention the failing step name');
            assert.ok(e.message.indexOf('MAVEN_USER not set') !== -1, 'error should include the underlying failure');
        }

        assert.equal(threw, true, 'should throw when a required setup command fails');
        assert.deepEqual(calls, ['check-required-creds'], 'must stop after the required command fails');
    });

    test('skips entries without a command', function() {
        var loaded = loadSetupCommands();
        var result = loaded.mod.runSetupCommands({
            setupCommands: [{ name: 'no-op' }, '']
        }, './dependencies/repo');

        assert.equal(result.ran, 0);
        assert.deepEqual(loaded.commands, []);
    });
});
