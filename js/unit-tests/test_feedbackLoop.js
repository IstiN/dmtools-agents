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
            'bash -c "mkdir -p outputs/feedback"',
            'bash agents/scripts/run-agent.sh --continue outputs/feedback/TS-1_git_operations.md'
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
            'bash -c "mkdir -p outputs/feedback"',
            'bash agents/scripts/run-agent.sh --continue outputs/feedback/TS-2_quality_gate_flutter-test.md',
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
        assert.equal(loaded.commands[1].command, 'bash -c "mkdir -p outputs/feedback"');
        assert.equal(
            loaded.commands[2].command,
            'bash agents/scripts/run-agent.sh --continue outputs/feedback/TS-5_post_publish_gate_accessibility-lint.md'
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

suite('feedbackLoop > resumeOnceForMissingResponse (gh-775)', function() {

    test('disabled when the feedback loop is not enabled', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForMissingResponse({ ticketKey: 'TS-1' });

        assert.equal(result.attempted, false);
        assert.equal(result.reason, 'disabled');
        assert.deepEqual(loaded.commands, []);
    });

    test('section-level disable wins over the root switch', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-1',
            customParams: { feedbackLoop: { enabled: true, missingResponse: { enabled: false } } }
        });

        assert.equal(result.attempted, false);
        assert.deepEqual(loaded.commands, []);
    });

    test('resumes exactly once with the bounded wrapper command and the follow-up prompt', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-775',
            customParams: { feedbackLoop: { enabled: true } }
        });

        assert.equal(result.attempted, true);
        assert.deepEqual(loaded.commands, [
            'bash -c "mkdir -p outputs/feedback"',
            'bash -c "timeout -k 60 2400 bash agents/scripts/run-agent.sh --continue outputs/feedback/TS-775_missing_response.md"'
        ]);
        assert.equal(loaded.files['outputs/feedback/TS-775_missing_response.attempt'], '1');
        var prompt = loaded.files['outputs/feedback/TS-775_missing_response.md'];
        assert.contains(prompt, 'Ticket: TS-775', 'the follow-up prompt stamps the ticket identifier like buildFeedbackPrompt — the context must not depend on --continue restoring the session');
        assert.contains(prompt, 'bash_job stop', 'the follow-up prompt names the hung-job disposal');
        assert.contains(prompt, 'outputs/response.md', 'the follow-up prompt names the missing deliverable');
        assert.contains(prompt, 'Do not push', 'the no-push contract holds for the resume too');
    });

    test('exactly ONE attempt — a second call does not re-invoke the wrapper', function() {
        var loaded = loadFeedbackLoop();
        var first = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-2',
            customParams: { feedbackLoop: { enabled: true } }
        });
        var second = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-2',
            customParams: { feedbackLoop: { enabled: true } }
        });

        assert.equal(first.attempted, true);
        assert.equal(second.attempted, false);
        assert.equal(second.reason, 'attempts-exhausted');
        var wrapperCalls = loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; });
        assert.equal(wrapperCalls.length, 1);
    });

    test('timeoutSeconds override tightens the hard cap', function() {
        var loaded = loadFeedbackLoop();
        loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-3',
            customParams: { feedbackLoop: { enabled: true, missingResponse: { timeoutSeconds: 600 } } }
        });

        assert.equal(loaded.commands.length, 2);
        assert.contains(loaded.commands[1], 'timeout -k 60 600 ');
    });

    test('a failed/timed-out wrapper invocation is a resume FAILURE, not a crash — the caller falls back to the cold reset', function() {
        var commands = [];
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                commands.push(args.command);
                if (args.command.indexOf('run-agent.sh') !== -1) {
                    throw new Error('Command failed (exit code 124): timeout -k 60 2400 ...');
                }
                return '';
            }
        });
        var result = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-4',
            customParams: { feedbackLoop: { enabled: true } }
        });

        assert.equal(result.attempted, true, 'the one bounded attempt was made');
        assert.equal(result.failed, true, 'the failure is reported instead of thrown');
        assert.equal(commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; }).length, 1);
    });

});

// ── gh-1079: runConfiguredGates characterization ─────────────────────────────
// Pins every branch of the gate runner (skip rules, name indexing, command
// interpolation, workingDir precedence, maxAttempts parsing, the
// retry/no-resume/non-blocking/returnAfterResume decision table) BEFORE the
// helper extraction — these must stay green across the refactor verbatim.

suite('feedbackLoop > runConfiguredGates characterization (gh-1079)', function() {

    test('no arguments at all → defaulted section/stagePrefix, empty success result', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.runConfiguredGates();

        assert.deepEqual(result, { success: true, results: [], nonBlockingFailures: [] });
        assert.deepEqual(loaded.commands, []);
    });

    test('null, disabled and command-less gate entries are skipped without running anything', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.runConfiguredGates({
            ticketKey: 'TS-SKIP',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [null, { enabled: false, command: 'echo disabled' }, { name: 'no-command' }]
                    }
                }
            }
        });

        assert.equal(result.success, true);
        assert.deepEqual(result.results, []);
        assert.deepEqual(loaded.commands, []);
    });

    test('gates without a name are indexed gate_N by 1-based position', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.runConfiguredGates({
            ticketKey: 'TS-IDX',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ command: 'echo one' }, null, { command: 'echo two' }]
                    }
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.results.length, 2);
        assert.equal(result.results[0].name, 'gate_1');
        assert.equal(result.results[1].name, 'gate_3', 'index follows the ARRAY position, not the runnable count');
    });

    test('{ticketKey} placeholders in the command are replaced with the ticket key', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.runConfiguredGates({
            ticketKey: 'TS-KY',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'subst', command: 'echo {ticketKey} && echo {ticketKey}:done' }]
                    }
                }
            }
        });

        assert.equal(result.success, true);
        assert.contains(loaded.commands[0], 'echo TS-KY && echo TS-KY:done');
    });

    test('workingDir precedence: gate > options > config > none', function() {
        var argLog = [];
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                argLog.push(args);
                return '';
            }
        });
        var withOptions = loaded.mod.runConfiguredGates({
            ticketKey: 'TS-WD',
            workingDir: 'options-dir',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        workingDir: 'config-dir',
                        gates: [
                            { name: 'gate-wins', command: 'echo a', workingDir: 'gate-dir' },
                            { name: 'options-wins', command: 'echo b' }
                        ]
                    }
                }
            }
        });

        assert.equal(withOptions.success, true);
        assert.equal(argLog[0].workingDirectory, 'gate-dir');
        assert.equal(argLog[1].workingDirectory, 'options-dir',
            'options.workingDir beats the section-config workingDir');

        var withoutOptions = loaded.mod.runConfiguredGates({
            ticketKey: 'TS-WD2',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        workingDir: 'config-dir',
                        gates: [{ name: 'config-wins', command: 'echo c' }]
                    }
                }
            }
        });

        assert.equal(withoutOptions.success, true);
        assert.equal(argLog[2].workingDirectory, 'config-dir');

        var bare = loaded.mod.runConfiguredGates({
            ticketKey: 'TS-WD3',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'none', command: 'echo d' }]
                    }
                }
            }
        });

        assert.equal(bare.success, true);
        assert.equal(argLog[3].workingDirectory, undefined, 'no dir anywhere → no workingDirectory on the invocation');
    });

    test('explicit options.section overrides the section argument for config/gates lookup', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.runConfiguredGates({
            ticketKey: 'TS-SEC',
            section: 'qualityGates',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'via-section', command: 'echo sec' }]
                    }
                }
            }
        }, 'qualityGates', 'quality_gate');

        assert.equal(result.success, true);
        assert.equal(result.results[0].name, 'via-section');
        assert.equal(loaded.commands[0], 'echo sec');
    });

    test('maxAttempts null → the default of two feedback loops', function() {
        var calls = 0;
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'flaky') {
                    calls++;
                    if (calls === 1) throw new Error('flaky failed');
                }
                return '';
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-DEF',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'mnull', command: 'flaky', maxAttempts: null }]
                    }
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.results[0].attempts, 2);
        assert.equal(loaded.files['outputs/feedback/TS-DEF_quality_gate_mnull.attempt'], '1');
    });

    test('maxAttempts numeric string is parsed (3 → two resumes, third attempt succeeds)', function() {
        var calls = 0;
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'flaky3') {
                    calls++;
                    if (calls < 3) throw new Error('flaky3 failed ' + calls);
                }
                return '';
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-STR',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'mstr', command: 'flaky3', maxAttempts: '3' }]
                    }
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.results[0].attempts, 3);
        assert.equal(loaded.files['outputs/feedback/TS-STR_quality_gate_mstr.attempt'], '2');
    });

    test('garbage maxAttempts parses to 0 → first failure aborts a blocking gate with NO resume', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                throw new Error('always broken');
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-NAN',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'mgarbage', command: 'broken', maxAttempts: 'abc' }]
                    }
                }
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.failedGate, 'mgarbage');
        assert.equal(result.error, 'always broken');
        assert.deepEqual(loaded.commands, ['broken'], 'zero resume machinery: no mkdir, no run-agent.sh');
    });

    test('retryWithAgent=false → immediate failure, no resume (blocking aborts, non-blocking records and continues)', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'no-retry') throw new Error('no-retry failed');
                return '';
            }
        });
        var blocking = loaded.mod.runQualityGates({
            ticketKey: 'TS-NR1',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'noretry', command: 'no-retry', retryWithAgent: false }]
                    }
                }
            }
        });
        assert.equal(blocking.success, false);
        assert.equal(blocking.failedGate, 'noretry');
        assert.deepEqual(loaded.commands, ['no-retry']);

        var nonBlocking = loaded.mod.runQualityGates({
            ticketKey: 'TS-NR2',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [
                            { name: 'noretry', command: 'no-retry', retryWithAgent: false, blocking: false },
                            { name: 'after', command: 'echo after' }
                        ]
                    }
                }
            }
        });
        assert.equal(nonBlocking.success, true);
        assert.deepEqual(nonBlocking.nonBlockingFailures, [{ name: 'noretry', error: 'no-retry failed' }]);
        assert.equal(nonBlocking.results[1].name, 'after', 'the next gate still ran');
        assert.equal(loaded.commands.filter(function(c) { return c === 'no-retry'; }).length, 2,
            'one run per scenario, never retried via the agent');
        assert.equal(loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; }).length, 0);
    });

    test('non-recoverable gate failure → resume declines → blocking gate fails without feedback-dir machinery', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                throw new Error('remote: Bad credentials');
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-AUTH',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'auth', command: 'push-it' }]
                    }
                }
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.failedGate, 'auth');
        assert.contains(result.error, 'Bad credentials');
        assert.deepEqual(loaded.commands, ['push-it'], 'no mkdir/run-agent: the resume refused before any command');
    });

    test('non-recoverable failure on a non-blocking gate → recorded as a non-blocking failure, next gate runs', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'auth-nb') throw new Error('Authentication failed');
                return '';
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-AUTH2',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [
                            { name: 'auth-nb', command: 'auth-nb', blocking: false },
                            { name: 'next', command: 'echo next' }
                        ]
                    }
                }
            }
        });

        assert.equal(result.success, true);
        assert.deepEqual(result.nonBlockingFailures, [{ name: 'auth-nb', error: 'Authentication failed' }]);
        assert.equal(result.results[0].blocking, false);
        assert.equal(result.results[1].name, 'next');
    });

    test('exhausted attempt marker → gate fails without another resume (blocking and non-blocking)', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                throw new Error('still red');
            }
        });
        loaded.files['outputs/feedback/TS-XH_quality_gate_xh.attempt'] = '2';
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-XH',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'xh', command: 'red', maxAttempts: 2 }]
                    }
                }
            }
        });
        assert.equal(result.success, false);
        assert.equal(result.failedGate, 'xh');
        assert.deepEqual(loaded.commands,
            ['red', 'bash -c "mkdir -p outputs/feedback"'],
            'marker at max → the resume enters the feedback dir, then declines — no run-agent.sh');

        loaded.files['outputs/feedback/TS-XH2_quality_gate_xh2.attempt'] = '2';
        var nb = loaded.mod.runQualityGates({
            ticketKey: 'TS-XH2',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'xh2', command: 'red', maxAttempts: 2, blocking: false }]
                    }
                }
            }
        });
        assert.equal(nb.success, true);
        assert.deepEqual(nb.nonBlockingFailures, [{ name: 'xh2', error: 'still red' }]);
    });

    test('returnAfterResume=true at the OPTIONS level → resume then result carries resumeAttempted', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'rropts') throw new Error('rropts failed');
                return '';
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-RRO',
            returnAfterResume: true,
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'rropts', command: 'rropts' }]
                    }
                }
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.resumeAttempted, true);
        assert.equal(result.failedGate, 'rropts');
        assert.equal(result.results.length, 0);
        assert.equal(loaded.files['outputs/feedback/TS-RRO_quality_gate_rropts.attempt'], '1',
            'the resume DID run before the return');
        assert.equal(loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; }).length, 1);
    });

    test('returnAfterResume=true at the GATE level → same bounded result', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'rrgate') throw new Error('rrgate failed');
                return '';
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-RRG',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'rrgate', command: 'rrgate', returnAfterResume: true }]
                    }
                }
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.resumeAttempted, true);
        assert.equal(loaded.files['outputs/feedback/TS-RRG_quality_gate_rrgate.attempt'], '1');
    });

    test('returnAfterResume=true at the SECTION-CONFIG level → same bounded result', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'rrcfg') throw new Error('rrcfg failed');
                return '';
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-RRC',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        returnAfterResume: true,
                        gates: [{ name: 'rrcfg', command: 'rrcfg' }]
                    }
                }
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.resumeAttempted, true);
        assert.equal(loaded.files['outputs/feedback/TS-RRC_quality_gate_rrcfg.attempt'], '1');
    });

    test('non-Error throws are stringified: plain string rides verbatim, bare object becomes [object Object]', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function() {
                loaded.commands.push('string-throw');
                throw 'plain fail';
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-THR',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'strthrow', command: 'string-throw', retryWithAgent: false }]
                    }
                }
            }
        });
        assert.equal(result.success, false);
        assert.equal(result.error, 'plain fail');

        var loaded2 = loadFeedbackLoop({
            cli_execute_command: function() {
                loaded2.commands.push('obj-throw');
                throw { code: 1 };
            }
        });
        var result2 = loaded2.mod.runQualityGates({
            ticketKey: 'TS-THR2',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'objthrow', command: 'obj-throw', retryWithAgent: false }]
                    }
                }
            }
        });
        assert.equal(result2.success, false);
        assert.equal(result2.error, '[object Object]');
    });

    test('a null command output is normalized to the empty string in the result entry', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                return null;
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-OUT',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [{ name: 'quiet', command: 'echo quiet' }]
                    }
                }
            }
        });

        assert.deepEqual(result.results, [{ name: 'quiet', success: true, attempts: 1, output: '' }]);
    });

    test('results accumulate in gate order with the exact per-entry shape', function() {
        var calls = 0;
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                loaded.commands.push(args.command);
                if (args.command === 'spotbugs:check') {
                    calls++;
                    throw new Error('findings');
                }
                return '';
            }
        });
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-SHAPE',
            customParams: {
                feedbackLoop: {
                    qualityGates: {
                        enabled: true,
                        gates: [
                            { name: 'compile', command: 'mvn compile', maxAttempts: 1 },
                            { name: 'spot', command: 'spotbugs:check', maxAttempts: 1, blocking: false },
                            { name: 'lint', command: 'eslint .', maxAttempts: 1 }
                        ]
                    }
                }
            }
        });

        assert.equal(result.success, true);
        assert.deepEqual(result.results, [
            { name: 'compile', success: true, attempts: 1, output: '' },
            { name: 'spot', success: false, attempts: 2, error: 'findings', blocking: false },
            { name: 'lint', success: true, attempts: 1, output: '' }
        ]);
        assert.deepEqual(result.nonBlockingFailures, [{ name: 'spot', error: 'findings' }]);
    });

    test('legacy root-section gate array (customParams.qualityGates) still configures gates', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-LEG',
            customParams: {
                qualityGates: [{ name: 'legacy', command: 'echo legacy' }]
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.results[0].name, 'legacy');
        assert.deepEqual(loaded.commands, ['echo legacy']);
    });

    test('a non-array gates value (legacy section object without gates) yields an empty successful run', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.runQualityGates({
            ticketKey: 'TS-OBJ',
            customParams: {
                qualityGates: { someFutureShape: true }
            }
        });

        assert.deepEqual(result, { success: true, results: [], nonBlockingFailures: [] });
        assert.deepEqual(loaded.commands, []);
    });

});
