/**
 * Unit tests for js/common/feedbackLoop.js
 */

function loadFeedbackLoop(mocks) {
    var files = {};
    var commands = [];
    var mod = loadModule(
        'js/common/feedbackLoop.js',
        null,
        Object.assign({
            file_read: function(args) {
                var path = args && (args.path || args);
                if (files[path] !== undefined) return files[path];
                throw new Error('not found: ' + path);
            },
            file_write: function(args, content) {
                if (typeof args === 'string') {
                    files[args] = content;
                } else {
                    files[args.path] = args.content;
                }
            },
            cli_execute_command: function(args) {
                commands.push(args.command);
                return '';
            }
        }, mocks || {})
    );
    return { mod: mod, files: files, commands: commands };
}

suite('feedbackLoop helper', function() {

    test('does not resume when feedback loop is not enabled', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeAgent({
            ticketKey: 'TS-1',
            customParams: {},
            stage: 'post_action',
            error: 'boom'
        });

        assert.equal(result.attempted, false);
        assert.equal(result.reason, 'disabled');
        assert.deepEqual(loaded.commands, []);
    });

    test('does not resume unrelated-history git infrastructure failures', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeAgent({
            ticketKey: 'TS-1',
            customParams: { feedbackLoop: { postAction: { enabled: true, maxAttempts: 1 } } },
            section: 'postAction',
            stage: 'git_operations',
            error: 'fatal: refusing to merge unrelated histories'
        });

        assert.equal(result.attempted, false);
        assert.equal(result.reason, 'non-recoverable');
        assert.deepEqual(loaded.commands, []);
    });

    test('writes feedback prompt and resumes agent once when enabled', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeAgent({
            ticketKey: 'TS-1',
            customParams: { feedbackLoop: { postAction: { enabled: true, maxAttempts: 1 } } },
            section: 'postAction',
            stage: 'git_operations',
            error: 'git failed'
        });

        assert.equal(result.attempted, true);
        assert.equal(loaded.files['outputs/feedback/TS-1_git_operations.attempt'], '1');
        assert.contains(loaded.files['outputs/feedback/TS-1_git_operations.md'], 'git failed');
        assert.deepEqual(loaded.commands, [
            'mkdir -p outputs/feedback',
            'bash agents/scripts/run-agent.sh --continue --resume outputs/feedback/TS-1_git_operations.md'
        ]);
    });

    test('runs quality gate, resumes on first failure, then succeeds', function() {
        var gateCalls = 0;
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'flutter test --coverage') {
                    gateCalls++;
                    if (gateCalls === 1) throw new Error('test failed');
                }
                return '';
            }
        });

        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-2',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'flutter-test', command: 'flutter test --coverage', maxAttempts: 1 }]
                    }
                }
            },
            section: 'qualityGates'
        });

        assert.equal(result.success, true);
        assert.deepEqual(loaded.commands, [
            'flutter test --coverage',
            'mkdir -p outputs/feedback',
            'bash agents/scripts/run-agent.sh --continue --resume outputs/feedback/TS-2_quality_gate_flutter-test.md',
            'flutter test --coverage'
        ]);
    });

    test('defaults quality gates to two feedback loops', function() {
        var gateCalls = 0;
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'flutter analyze') {
                    gateCalls++;
                    if (gateCalls < 3) throw new Error('analyze failed');
                }
                return '';
            }
        });

        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-3',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'flutter-analyze', command: 'flutter analyze' }]
                    }
                }
            },
            section: 'qualityGates'
        });

        assert.equal(result.success, true);
        assert.equal(gateCalls, 3);
        assert.equal(loaded.files['outputs/feedback/TS-3_quality_gate_flutter-analyze.attempt'], '2');
    });

    test('runs policy gates with separate feedback attempt markers', function() {
        var gateCalls = 0;
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'dart run tool/check_theme_tokens.dart') {
                    gateCalls++;
                    if (gateCalls === 1) throw new Error('hardcoded color');
                }
                return '';
            }
        });

        var result = loaded.mod.runPolicyGates({
            ticketKey: 'TS-4',
            customParams: {
                feedbackLoop: {
                    policyGates: {
                        enabled: true,
                        gates: [
                            {
                                name: 'theme-token-lint',
                                command: 'dart run tool/check_theme_tokens.dart',
                                maxAttempts: 1
                            }
                        ]
                    }
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(gateCalls, 2);
        assert.equal(loaded.files['outputs/feedback/TS-4_policy_gate_theme-token-lint.attempt'], '1');
        assert.contains(loaded.files['outputs/feedback/TS-4_policy_gate_theme-token-lint.md'], 'hardcoded color');
    });

    test('post-publish gates run in working directory and return after resume', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args);
                if (args.command === 'yarn lint:a11y') {
                    assert.equal(args.workingDirectory, 'dependencies/example-mobile-app');
                    throw new Error('a11y failed');
                }
                return '';
            }
        });

        var result = loaded.mod.runPostPublishGates({
            ticketKey: 'TS-5',
            workingDir: 'dependencies/example-mobile-app',
            customParams: {
                feedbackLoop: {
                    postPublishGates: {
                        enabled: true,
                        maxAttempts: 1,
                        gates: [{ name: 'accessibility-lint', command: 'yarn lint:a11y' }]
                    }
                }
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.resumeAttempted, true);
        assert.equal(loaded.commands.length, 3);
        assert.equal(loaded.commands[0].command, 'yarn lint:a11y');
        assert.equal(loaded.commands[1].command, 'mkdir -p outputs/feedback');
        assert.equal(
            loaded.commands[2].command,
            'bash agents/scripts/run-agent.sh --continue --resume outputs/feedback/TS-5_post_publish_gate_accessibility-lint.md'
        );
        assert.contains(
            loaded.files['outputs/feedback/TS-5_post_publish_gate_accessibility-lint.md'],
            'Working directory: dependencies/example-mobile-app'
        );
    });

    test('non-blocking gate failure does not fail the overall result and continues to next gate', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'mvn spotbugs:check') {
                    throw new Error('pre-existing spotbugs findings');
                }
                if (args.command === 'mvn clean compile') {
                    return '';
                }
                return '';
            }
        });

        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-6',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [
                            { name: 'compile', command: 'mvn clean compile', maxAttempts: 2 },
                            { name: 'spotbugs', command: 'mvn spotbugs:check', maxAttempts: 1, blocking: false }
                        ]
                    }
                }
            },
            section: 'qualityGates'
        });

        assert.equal(result.success, true, 'overall result should still be success — the failing gate is non-blocking');
        assert.equal(result.nonBlockingFailures.length, 1);
        assert.equal(result.nonBlockingFailures[0].name, 'spotbugs');
        assert.contains(result.nonBlockingFailures[0].error, 'pre-existing spotbugs findings');

        // "compile" (blocking, unaffected) should have run and succeeded, then "spotbugs"
        // (non-blocking, maxAttempts=1) is retried once via the feedback loop before being
        // recorded as a non-blocking failure — it must never abort/return early.
        assert.equal(loaded.commands.filter(function(c) { return c === 'mvn clean compile'; }).length, 1);
        assert.equal(loaded.commands.filter(function(c) { return c === 'mvn spotbugs:check'; }).length, 2);
        assert.equal(loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; }).length, 1);
    });

    test('non-blocking gate with resume enabled still tries to resume before giving up', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'mvn spotbugs:check') {
                    throw new Error('still failing after fix attempt');
                }
                return '';
            }
        });

        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-7',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [
                            {
                                name: 'spotbugs',
                                command: 'mvn spotbugs:check',
                                maxAttempts: 1,
                                blocking: false
                            }
                        ]
                    }
                }
            },
            section: 'qualityGates'
        });

        assert.equal(result.success, true);
        assert.equal(result.nonBlockingFailures.length, 1);
        // maxAttempts=1 means: 1 initial try + 1 resume-and-retry, then give up non-blockingly
        assert.equal(loaded.commands.filter(function(c) { return c === 'mvn spotbugs:check'; }).length, 2);
        assert.equal(loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; }).length, 1);
    });

    test('blocking gate (default) still aborts the whole run on failure, as before', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'mvn clean compile') {
                    throw new Error('compile error');
                }
                return '';
            }
        });

        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-8',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [
                            { name: 'compile', command: 'mvn clean compile', maxAttempts: 0 },
                            { name: 'spotbugs', command: 'mvn spotbugs:check', maxAttempts: 1, blocking: false }
                        ]
                    }
                }
            },
            section: 'qualityGates'
        });

        assert.equal(result.success, false);
        assert.equal(result.failedGate, 'compile');
        // Should not have reached the spotbugs gate at all
        var spotbugsCalls = loaded.commands.filter(function(c) { return c === 'mvn spotbugs:check'; });
        assert.equal(spotbugsCalls.length, 0);
    });

});
