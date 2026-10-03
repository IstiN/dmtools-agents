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
        }, './dependencies/example-repo');

        assert.equal(result.ran, 2);
        assert.equal(loaded.commands.length, 2);
        assert.equal(loaded.commands[0].command, 'bash agents/setup/java.sh 25');
        assert.equal(loaded.commands[0].workingDirectory, './dependencies/example-repo');
        assert.equal(loaded.commands[1].workingDirectory, './dependencies/example-repo');
        assert.equal(result.results[0].success, true);
    });

    test('object entries can override workingDir and name', function() {
        var loaded = loadSetupCommands();
        var result = loaded.mod.runSetupCommands({
            setupCommands: [
                { name: 'install-java', command: 'bash agents/setup/java.sh 25' },
                { name: 'custom-dir', command: 'ls', workingDir: '/tmp/other' }
            ]
        }, './dependencies/example-repo');

        assert.equal(loaded.commands[0].workingDirectory, './dependencies/example-repo', 'falls back to default working dir');
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
                    throw new Error('REQUIRED_TOKEN not set');
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
            assert.ok(e.message.indexOf('REQUIRED_TOKEN not set') !== -1, 'error should include the underlying failure');
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

    test('required setup command failure with huge output is truncated in the thrown message', function() {
        // Regression test: a required setup command (e.g. `mvn clean verify`) can fail
        // with megabytes of console output embedded in the error message. That message
        // is later posted verbatim as a Jira/tracker comment by callers of
        // runSetupCommands (preCliDevelopmentSetup.js, preCliReworkSetup.js); trackers
        // reject oversized comments (e.g. Jira's ~350000 char limit), and previously
        // that posting failure was silently swallowed — leaving the ticket with zero
        // visibility into why setup failed. The thrown error must stay bounded.
        var hugeOutput = 'X'.repeat(500000);
        var loaded = loadSetupCommands({
            cli_execute_command: function() { throw new Error(hugeOutput); }
        });

        var threw = false;
        try {
            loaded.mod.runSetupCommands({
                setupCommands: [
                    { name: 'build-test-database-image', command: 'mvn clean verify', allowFailure: false }
                ]
            }, './dependencies/repo');
        } catch (e) {
            threw = true;
            assert.ok(e.message.length < 10000, 'thrown message must be bounded, got ' + e.message.length + ' chars');
            assert.ok(e.message.indexOf('build-test-database-image') !== -1, 'error should mention the failing step name');
            assert.ok(e.message.indexOf('truncated') !== -1, 'truncated message should say so');
        }

        assert.equal(threw, true, 'should throw when a required setup command fails');
    });

    test('short error messages pass through truncateSetupError unchanged', function() {
        var loaded = loadSetupCommands();
        assert.equal(loaded.mod.truncateSetupError('short message'), 'short message');
        assert.equal(loaded.mod.truncateSetupError(undefined), undefined);
    });
});

suite('setupCommands buildSetupWarningsMarkdown', function() {

    test('returns null when there are no failures', function() {
        var loaded = loadSetupCommands();
        var result = loaded.mod.runSetupCommands({
            setupCommands: ['bash agents/setup/java.sh 25']
        }, './dependencies/repo');

        assert.equal(loaded.mod.buildSetupWarningsMarkdown(result), null);
    });

    test('returns null for an empty/undefined result', function() {
        var loaded = loadSetupCommands();
        assert.equal(loaded.mod.buildSetupWarningsMarkdown(undefined), null);
        assert.equal(loaded.mod.buildSetupWarningsMarkdown({}), null);
    });

    test('summarizes a non-fatal (default allowFailure) command failure', function() {
        // Regression test for: a setup command like "build-test-database-image" can be
        // downgraded from allowFailure:false (hard job-stopping) to the default
        // non-fatal behavior once its underlying infra prerequisite (e.g. Docker/
        // Testcontainers reachability) is already verified by an earlier, separate
        // required step. Non-fatal failures are otherwise only logged to the CI
        // console (see runSetupCommands) — the CLI coding agent never sees them unless
        // the caller writes this markdown out to an input file (e.g.
        // setup_warnings.md), so the agent can notice and attempt a fix instead of
        // working on the ticket with zero awareness that setup found a real problem.
        var loaded = loadSetupCommands({
            cli_execute_command: function(args) {
                if (args.command === 'mvn clean verify') {
                    throw new Error('Found more than one migration with version 2026.08.31.11.00');
                }
                return 'ok';
            }
        });

        var result = loaded.mod.runSetupCommands({
            setupCommands: [
                { name: 'build-test-database-image', command: 'mvn clean verify' }
            ]
        }, './dependencies/repo');

        var markdown = loaded.mod.buildSetupWarningsMarkdown(result);
        assert.ok(markdown, 'should produce a markdown summary');
        assert.ok(markdown.indexOf('build-test-database-image') !== -1, 'should mention the failing step name');
        assert.ok(markdown.indexOf('Found more than one migration') !== -1, 'should include the underlying error');
    });

    test('summarizes multiple non-fatal failures and skips successful commands', function() {
        var loaded = loadSetupCommands({
            cli_execute_command: function(args) {
                if (args.command === 'fails-one') throw new Error('error one');
                if (args.command === 'fails-two') throw new Error('error two');
                return 'ok';
            }
        });

        var result = loaded.mod.runSetupCommands({
            setupCommands: [
                { name: 'step-ok', command: 'succeeds' },
                { name: 'step-one', command: 'fails-one' },
                { name: 'step-two', command: 'fails-two' }
            ]
        }, './dependencies/repo');

        var markdown = loaded.mod.buildSetupWarningsMarkdown(result);
        assert.ok(markdown.indexOf('step-one') !== -1);
        assert.ok(markdown.indexOf('error one') !== -1);
        assert.ok(markdown.indexOf('step-two') !== -1);
        assert.ok(markdown.indexOf('error two') !== -1);
        assert.equal(markdown.indexOf('step-ok'), -1, 'should not mention successful commands');
    });

    test('truncates huge error output embedded in the markdown', function() {
        var hugeOutput = 'Y'.repeat(500000);
        var loaded = loadSetupCommands({
            cli_execute_command: function() { throw new Error(hugeOutput); }
        });

        var result = loaded.mod.runSetupCommands({
            setupCommands: [{ name: 'flaky-step', command: 'flaky' }]
        }, './dependencies/repo');

        var markdown = loaded.mod.buildSetupWarningsMarkdown(result);
        assert.ok(markdown.length < 10000, 'markdown must stay bounded, got ' + markdown.length + ' chars');
        assert.ok(markdown.indexOf('truncated') !== -1);
    });
});
