/**
 * Unit tests for js/common/feedbackLoop.js
 */

// gh-122: bare module loader for the pure missingResponse helpers (no file/exec side effects expected).
function feedbackLoopModule() {
    return loadModule('js/common/feedbackLoop.js', null, {
        file_read: function() { throw new Error('unexpected file_read in pure-helper test'); },
        file_write: function() {},
        cli_execute_command: function() { return ''; }
    });
}

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

// ── gh-122: extracted missingResponse helpers (tests written first, then the extraction) ──

suite('feedbackLoop — extracted missingResponse helpers (gh-122)', function() {

    test('missingResponseScoped extracts the scoped config or an empty object', function() {
        assert.deepEqual(feedbackLoopModule().missingResponseScoped({ missingResponse: { a: 1 } }), { a: 1 });
        assert.deepEqual(feedbackLoopModule().missingResponseScoped({}), {});
        assert.deepEqual(feedbackLoopModule().missingResponseScoped({ missingResponse: 'junk' }), {},
            'a non-object scoped block is ignored');
        assert.deepEqual(feedbackLoopModule().missingResponseScoped({ missingResponse: null }), {},
            'a null scoped block is ignored');
    });

    test('missingResponseDisabled: section opt-out wins over force, generic switch does not', function() {
        var fb = feedbackLoopModule();
        assert.equal(fb.missingResponseDisabled({ enabled: false }, { force: true }, {}), true,
            'explicit missingResponse.enabled=false opts out even under force');
        assert.equal(fb.missingResponseDisabled({}, {}, {}), true,
            'generic feedbackLoop not enabled → disabled');
        assert.equal(fb.missingResponseDisabled({}, { force: true }, {}), false,
            'force bypasses the generic enablement switch');
        assert.equal(fb.missingResponseDisabled({}, {}, { feedbackLoop: { enabled: true } }), false,
            'an enabled generic switch lets the resume proceed');
    });

    test('missingResponseTimeoutSeconds falls back to the default on unusable values', function() {
        assert.equal(feedbackLoopModule().missingResponseTimeoutSeconds({ timeoutSeconds: 600 }), 600);
        assert.equal(feedbackLoopModule().missingResponseTimeoutSeconds({ timeoutSeconds: '900' }), 900);
        assert.equal(feedbackLoopModule().missingResponseTimeoutSeconds({}), 2400);
        assert.equal(feedbackLoopModule().missingResponseTimeoutSeconds({ timeoutSeconds: 0 }), 2400);
        assert.equal(feedbackLoopModule().missingResponseTimeoutSeconds({ timeoutSeconds: -5 }), 2400);
        assert.equal(feedbackLoopModule().missingResponseTimeoutSeconds({ timeoutSeconds: 'abc' }), 2400);
    });

    test('missingResponseResumeOptions assembles the bounded-resume invocation', function() {
        var options = {
            ticketKey: 'TS-9',
            error: 'boom',
            promptOverride: 'custom prompt',
            extra: 'ignored'
        };
        var resumeOptions = feedbackLoopModule().missingResponseResumeOptions(options, { forced: true }, 300);
        assert.deepEqual(resumeOptions, {
            ticketKey: 'TS-9',
            customParams: { forced: true },
            section: 'missingResponse',
            stage: 'missing_response',
            error: 'boom',
            promptOverride: 'custom prompt',
            timeoutSeconds: 300
        });
    });

    test('missingResponseResumeOptions defaults the prompt to the built missing-response text', function() {
        var resumeOptions = feedbackLoopModule().missingResponseResumeOptions(
            { ticketKey: 'TS-10', error: undefined }, {}, 2400);
        assert.equal(resumeOptions.error, '');
        assert.contains(resumeOptions.promptOverride, 'Ticket: TS-10');
        assert.contains(resumeOptions.promptOverride, 'outputs/response.md');
        assert.equal(resumeOptions.stage, 'missing_response');
        assert.equal(resumeOptions.timeoutSeconds, 2400);
    });

});

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

suite('feedbackLoop > resumeOnceForProviderOutage (gh-1121)', function() {

    var feedbackLoopMod = loadModule('js/common/feedbackLoop.js');

    test('providerTransientBackoffSeconds: default 90, configured override, garbage/0/negative fall back', function() {
        assert.equal(feedbackLoopMod.providerTransientBackoffSeconds({}), 90);
        assert.equal(feedbackLoopMod.providerTransientBackoffSeconds(null), 90);
        assert.equal(feedbackLoopMod.providerTransientBackoffSeconds({ providerTransientBackoffSec: 7 }), 7);
        assert.equal(feedbackLoopMod.providerTransientBackoffSeconds({ providerTransientBackoffSec: '12' }), 12);
        assert.equal(feedbackLoopMod.providerTransientBackoffSeconds({ providerTransientBackoffSec: 'garbage' }), 90);
        assert.equal(feedbackLoopMod.providerTransientBackoffSeconds({ providerTransientBackoffSec: 0 }), 90);
        assert.equal(feedbackLoopMod.providerTransientBackoffSeconds({ providerTransientBackoffSec: -5 }), 90);
    });

    test('UT-5 default: backs off 90s (through the whitelisted bash token) BEFORE the bounded wrapper', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForProviderOutage({ ticketKey: 'TS-900', customParams: {} });

        assert.equal(result.attempted, true, 'the outage resume ignores the generic feedbackLoop flag');
        assert.equal(loaded.commands.length, 3);
        assert.equal(loaded.commands[0], 'bash -c "sleep 90"', 'the default backoff sleep precedes the resume mechanics');
        assert.equal(loaded.commands[1], 'bash -c "mkdir -p outputs/feedback"');
        assert.contains(loaded.commands[2], 'bash agents/scripts/run-agent.sh --continue outputs/feedback/TS-900_missing_response.md');
    });

    test('UT-5 configurable: providerTransientBackoffSec is honored verbatim', function() {
        var loaded = loadFeedbackLoop();
        loaded.mod.resumeOnceForProviderOutage({
            ticketKey: 'TS-901',
            customParams: { providerTransientBackoffSec: 7 }
        });

        assert.contains(loaded.commands[0], 'bash -c "sleep 7"');
    });

    test('UT-2: the outage resume fires even when the feedback loop is disabled globally', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForProviderOutage({
            ticketKey: 'TS-902',
            customParams: {} // no feedbackLoop config at all
        });

        assert.equal(result.attempted, true);
        var wrapperCalls = loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; });
        assert.equal(wrapperCalls.length, 1);
    });

    test('an explicit missingResponse.enabled=false still opts out of the outage resume', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForProviderOutage({
            ticketKey: 'TS-903',
            customParams: { feedbackLoop: { missingResponse: { enabled: false } } }
        });

        assert.equal(result.attempted, false);
        assert.equal(result.reason, 'disabled');
        assert.deepEqual(loaded.commands, []);
    });

    test('I2: exactly ONE outage resume per leg — the missing_response attempt marker is shared', function() {
        var loaded = loadFeedbackLoop();
        var first = loaded.mod.resumeOnceForProviderOutage({ ticketKey: 'TS-904', customParams: {} });
        var second = loaded.mod.resumeOnceForProviderOutage({ ticketKey: 'TS-904', customParams: {} });

        assert.equal(first.attempted, true);
        assert.equal(second.attempted, false);
        assert.equal(second.reason, 'attempts-exhausted');
        var wrapperCalls = loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; });
        assert.equal(wrapperCalls.length, 1, 'never more than one resume per leg');
        assert.equal(loaded.files['outputs/feedback/TS-904_missing_response.attempt'], '1');
    });

    test('the outage resume shares the marker with the generic missing-response resume', function() {
        var loaded = loadFeedbackLoop();
        var generic = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-905',
            customParams: { feedbackLoop: { enabled: true } }
        });
        var outage = loaded.mod.resumeOnceForProviderOutage({ ticketKey: 'TS-905', customParams: {} });

        assert.equal(generic.attempted, true);
        assert.equal(outage.attempted, false, 'a leg that already resumed generically never resumes again');
        assert.equal(outage.reason, 'attempts-exhausted');
    });

    test('the outage prompt names the transient outage, the deliverable and the no-push contract', function() {
        var loaded = loadFeedbackLoop();
        loaded.mod.resumeOnceForProviderOutage({ ticketKey: 'TS-906', customParams: {} });

        var prompt = loaded.files['outputs/feedback/TS-906_missing_response.md'];
        assert.contains(prompt, 'Ticket: TS-906');
        assert.contains(prompt, 'provider outage');
        assert.contains(prompt, 'outputs/response.md');
        assert.contains(prompt, 'Do not push');
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

// ── gh-122: resumeOnceForMissingResponse characterization ────────────────────
// Pins the remaining gate/error branches BEFORE the helper extraction — these
// must stay green across the refactor verbatim.

suite('feedbackLoop > resumeOnceForMissingResponse characterization (gh-122)', function() {

    test('no arguments at all → disabled, nothing executed', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForMissingResponse();

        assert.deepEqual(result, { attempted: false, reason: 'disabled' });
        assert.deepEqual(loaded.commands, []);
        assert.deepEqual(Object.keys(loaded.files), []);
    });

    test('force bypasses the generic enablement switch', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-F1',
            customParams: {},
            force: true
        });

        assert.equal(result.attempted, true, 'an outage resume must not depend on feedbackLoop being configured');
        var wrapper = loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; });
        assert.equal(wrapper.length, 1);
        assert.contains(wrapper[0], 'timeout -k 60 2400 ', 'default 2400s hard cap without an override');
    });

    test('section-level enabled:false wins even over force', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-F2',
            customParams: { feedbackLoop: { missingResponse: { enabled: false } } },
            force: true
        });

        assert.deepEqual(result, { attempted: false, reason: 'disabled' });
        assert.deepEqual(loaded.commands, []);
    });

    test('invalid timeoutSeconds values fall back to the default hard cap', function() {
        var badValues = ['abc', 0, -5, null];
        for (var i = 0; i < badValues.length; i++) {
            var loaded = loadFeedbackLoop();
            loaded.mod.resumeOnceForMissingResponse({
                ticketKey: 'TS-F3',
                customParams: { feedbackLoop: { enabled: true, missingResponse: { timeoutSeconds: badValues[i] } } }
            });
            var wrapper = loaded.commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; });
            assert.contains(wrapper[0], 'timeout -k 60 2400 ',
                'timeoutSeconds=' + JSON.stringify(badValues[i]) + ' must fall back to the default');
        }
    });

    test('a thrown non-Error is reported as failed with String(error)', function() {
        var loaded = loadFeedbackLoop({
            cli_execute_command: function(args) {
                if (args.command.indexOf('run-agent.sh') !== -1) {
                    throw 'raw failure'; // eslint-disable-line no-throw-literal
                }
                return '';
            }
        });
        var result = loaded.mod.resumeOnceForMissingResponse({
            ticketKey: 'TS-F4',
            customParams: { feedbackLoop: { enabled: true } }
        });

        assert.equal(result.attempted, true);
        assert.equal(result.failed, true);
        assert.equal(result.error, 'raw failure');
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

// ── gh-1079: extracted gate-runner helper contracts ─────────────────────────
// Direct pins for the pure pieces the characterization suite exercises
// through runConfiguredGates — they document the seams the refactor opened.

suite('feedbackLoop > gate-runner helper contracts (gh-1079)', function() {

    test('errorTextOf: Error.message wins, plain values are stringified', function() {
        var mod = loadFeedbackLoop().mod;
        assert.equal(mod.errorTextOf(new Error('the message')), 'the message');
        assert.equal(mod.errorTextOf('plain'), 'plain');
        assert.equal(mod.errorTextOf({ code: 7 }), '[object Object]');
    });

    test('gateRunnable: only null gates and enabled:false are skipped', function() {
        var mod = loadFeedbackLoop().mod;
        assert.equal(mod.gateRunnable(null), false);
        assert.equal(mod.gateRunnable(undefined), false);
        assert.equal(mod.gateRunnable({ enabled: false }), false);
        assert.equal(mod.gateRunnable({}), true);
        assert.equal(mod.gateRunnable({ enabled: true }), true);
        assert.equal(mod.gateRunnable({ enabled: 'yes' }), true, 'only the literal false disables');
    });

    test('gateCommand: {ticketKey} interpolation, missing command → null', function() {
        var mod = loadFeedbackLoop().mod;
        assert.equal(mod.gateCommand({ command: 'run {ticketKey}' }, 'AB-9'), 'run AB-9');
        assert.equal(mod.gateCommand({ command: 'run {ticketKey}' }, undefined), 'run ');
        assert.equal(mod.gateCommand({}, 'AB-9'), null);
        assert.equal(mod.gateCommand({ command: 123 }, 'AB-9'), '123', 'non-string commands are coerced');
    });

    test('gateWorkingDir: gate > options > config, else null', function() {
        var mod = loadFeedbackLoop().mod;
        assert.equal(mod.gateWorkingDir({ workingDir: 'g' }, { workingDir: 'o' }, { workingDir: 'c' }), 'g');
        assert.equal(mod.gateWorkingDir({}, { workingDir: 'o' }, { workingDir: 'c' }), 'o');
        assert.equal(mod.gateWorkingDir({}, {}, { workingDir: 'c' }), 'c');
        assert.equal(mod.gateWorkingDir({}, {}, {}), null);
    });

    test('gateMaxAttempts: null/undefined → 2, strings parsed, garbage → 0', function() {
        var mod = loadFeedbackLoop().mod;
        assert.equal(mod.gateMaxAttempts({}), 2);
        assert.equal(mod.gateMaxAttempts({ maxAttempts: null }), 2);
        assert.equal(mod.gateMaxAttempts({ maxAttempts: '3' }), 3);
        assert.equal(mod.gateMaxAttempts({ maxAttempts: 5 }), 5);
        assert.equal(mod.gateMaxAttempts({ maxAttempts: 'junk' }), 0);
        assert.equal(mod.gateMaxAttempts({ maxAttempts: 0 }), 0);
    });

    test('gateFeedbackConfig: the section-scoped resume contract, exactly as resumeAgent reads it', function() {
        var mod = loadFeedbackLoop().mod;
        var cfg = mod.gateFeedbackConfig('qualityGates', { resumeArgs: '--resume x', nonRecoverablePatterns: ['p'] }, 4);
        assert.deepEqual(cfg, {
            feedbackLoop: {
                qualityGates: { enabled: true, maxAttempts: 4, resumeArgs: '--resume x', nonRecoverablePatterns: ['p'] }
            }
        });
        var bare = mod.gateFeedbackConfig('policyGates', {}, 2);
        assert.deepEqual(bare.feedbackLoop.policyGates, {
            enabled: true, maxAttempts: 2, resumeArgs: undefined, nonRecoverablePatterns: undefined
        });
    });

    test('gateResumeOptions: the resumeAgent payload (stage, error banner, ticket key)', function() {
        var loaded = loadFeedbackLoop();
        var mod = loaded.mod;
        var ctx = {
            options: { ticketKey: 'TS-R' },
            section: 'qualityGates',
            stagePrefix: 'quality_gate'
        };
        var resume = mod.gateResumeOptions(ctx, { resumeArgs: '--resume sid' }, 'gate-x', 'cmd x', 'dir x', 3, 'boom');
        assert.deepEqual(resume, {
            ticketKey: 'TS-R',
            customParams: { feedbackLoop: { qualityGates: {
                enabled: true, maxAttempts: 3, resumeArgs: '--resume sid', nonRecoverablePatterns: undefined
            } } },
            section: 'qualityGates',
            stage: 'quality_gate_gate-x',
            error: 'Command failed: cmd x\nWorking directory: dir x\n\nboom'
        });
        var noDir = mod.gateResumeOptions(ctx, {}, 'gate-y', 'cmd y', null, 3, 'boom');
        assert.equal(noDir.error, 'Command failed: cmd y\n\nboom', 'no workingDir → no directory line');
    });

    test('gateWantsReturnAfterResume: any of options/config/gate opts in', function() {
        var mod = loadFeedbackLoop().mod;
        assert.equal(mod.gateWantsReturnAfterResume({ options: { returnAfterResume: true } }, {}), true);
        assert.equal(mod.gateWantsReturnAfterResume({ options: {}, config: { returnAfterResume: true } }, {}), true);
        assert.equal(mod.gateWantsReturnAfterResume({ options: {}, config: {} }, { returnAfterResume: true }), true);
        assert.equal(mod.gateWantsReturnAfterResume({ options: {}, config: {} }, {}), false);
    });

    test('gateFailureResult: the blocking failure shape, with and without resumeAttempted', function() {
        var mod = loadFeedbackLoop().mod;
        var ctx = { results: [1], nonBlockingFailures: [2] };
        assert.deepEqual(
            mod.gateFailureResult('g', 'err', ctx, false),
            { success: false, failedGate: 'g', error: 'err', results: [1], nonBlockingFailures: [2] });
        assert.deepEqual(
            mod.gateFailureResult('g', 'err', ctx, true),
            { success: false, failedGate: 'g', error: 'err', resumeAttempted: true, results: [1], nonBlockingFailures: [2] });
    });

    test('gateSection + runGateContext: options.section wins, gateType follows the section', function() {
        var mod = loadFeedbackLoop().mod;
        assert.equal(mod.gateSection({}, 'qualityGates'), 'qualityGates');
        assert.equal(mod.gateSection({ section: 'policyGates' }, 'qualityGates'), 'policyGates');

        var ctx = mod.runGateContext({ customParams: { feedbackLoop: { policyGates: { workingDir: 'wd' } } } },
            'policyGates', 'policy_gate');
        assert.equal(ctx.gateType, 'policy gate');
        assert.equal(ctx.config.workingDir, 'wd');
        assert.deepEqual(ctx.results, []);
        assert.deepEqual(ctx.nonBlockingFailures, []);

        var qctx = mod.runGateContext({}, 'qualityGates', 'quality_gate');
        assert.equal(qctx.gateType, 'quality gate');
    });

});

// ── gh-1196: resumeAgent characterization ────────────────────────────────────
// Pins the enablement/maxAttempts/non-recoverable gates, the marker-file
// attempt lifecycle, the wrapper command shape (resumeArgs, timeout) and the
// prompt override BEFORE the gate-helper extraction — these must stay green
// across the refactor verbatim.
suite('feedbackLoop > resumeAgent characterization (gh-1196)', function() {

    function resumeOpts(over) {
        over = over || {};
        return {
            ticketKey: over.ticketKey !== undefined ? over.ticketKey : 'TS-1196',
            section: over.section !== undefined ? over.section : 'postAction',
            stage: over.stage !== undefined ? over.stage : 'git_operations',
            error: over.error !== undefined ? over.error : 'git failed',
            timeoutSeconds: over.timeoutSeconds,
            promptOverride: over.promptOverride,
            customParams: over.customParams !== undefined ? over.customParams
                : { feedbackLoop: { postAction: { enabled: true } } }
        };
    }
    function wrapperCalls(commands) {
        return commands.filter(function(c) { return c.indexOf('run-agent.sh') !== -1; });
    }

    test('default maxAttempts is DEFAULT_MAX_ATTEMPTS=2 — the third call is attempts-exhausted', function() {
        var loaded = loadFeedbackLoop();
        var opts = resumeOpts();
        var first = loaded.mod.resumeAgent(opts);
        var second = loaded.mod.resumeAgent(opts);
        var third = loaded.mod.resumeAgent(opts);

        assert.equal(first.attempted, true);
        assert.equal(second.attempted, true);
        assert.equal(third.attempted, false);
        assert.equal(third.reason, 'attempts-exhausted');
        assert.equal(third.attempts, 2);
        assert.equal(loaded.files['outputs/feedback/TS-1196_git_operations.attempt'], '2');
        assert.equal(wrapperCalls(loaded.commands).length, 2);
    });

    test('maxAttempts=null rides the default; non-numeric, 0 and negative disable the resume', function() {
        var nulled = loadFeedbackLoop();
        var out = nulled.mod.resumeAgent(resumeOpts({
            customParams: { feedbackLoop: { postAction: { enabled: true, maxAttempts: null } } }
        }));
        assert.equal(out.attempted, true, 'explicit null → DEFAULT_MAX_ATTEMPTS');
        assert.equal(nulled.files['outputs/feedback/TS-1196_git_operations.attempt'], '1');

        ['garbage', 0, -1].forEach(function(bad) {
            var loaded = loadFeedbackLoop();
            var result = loaded.mod.resumeAgent(resumeOpts({
                customParams: { feedbackLoop: { postAction: { enabled: true, maxAttempts: bad } } }
            }));
            assert.equal(result.attempted, false, 'maxAttempts=' + bad);
            assert.equal(result.reason, 'maxAttempts=0', 'maxAttempts=' + bad);
            assert.deepEqual(loaded.commands, [], 'maxAttempts=' + bad + ' — nothing runs');
        });
    });

    test('resumeArgs replaces --continue; promptOverride replaces the built prompt', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeAgent(resumeOpts({
            promptOverride: 'OVERRIDE PROMPT',
            customParams: { feedbackLoop: {
                postAction: { enabled: true, maxAttempts: 1, resumeArgs: '-r sess-42' } } }
        }));

        assert.equal(result.attempted, true);
        assert.deepEqual(wrapperCalls(loaded.commands), [
            'bash agents/scripts/run-agent.sh -r sess-42 outputs/feedback/TS-1196_git_operations.md'
        ]);
        assert.equal(loaded.files['outputs/feedback/TS-1196_git_operations.md'], 'OVERRIDE PROMPT');
    });

    test('a direct timeoutSeconds wraps the wrapper command (the bounded resume contract)', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeAgent(resumeOpts({
            timeoutSeconds: '30',
            customParams: { feedbackLoop: { postAction: { enabled: true, maxAttempts: 1 } } }
        }));

        assert.equal(result.attempted, true);
        assert.deepEqual(wrapperCalls(loaded.commands), [
            'bash -c "timeout -k 60 30 bash agents/scripts/run-agent.sh --continue outputs/feedback/TS-1196_git_operations.md"'
        ]);
    });

    test('missing stage/ticketKey default the marker key to unknown_feedback; config patterns replace the builtin non-recoverable list', function() {
        var loaded = loadFeedbackLoop();
        var result = loaded.mod.resumeAgent({
            error: 'transient hiccup',
            customParams: { feedbackLoop: {
                postAction: { enabled: true, maxAttempts: 1, nonRecoverablePatterns: ['PLAN QUOTA'] } } }
        });
        assert.equal(result.attempted, true,
            'the override replaces the builtin pattern list — transient text is no longer misclassified');
        assert.equal(loaded.files['outputs/feedback/unknown_feedback.attempt'], '1');
        assert.contains(loaded.files['outputs/feedback/unknown_feedback.md'], 'Ticket: unknown');

        var blocked = loadFeedbackLoop();
        var out = blocked.mod.resumeAgent({
            error: 'PLAN QUOTA exhausted',
            customParams: { feedbackLoop: {
                postAction: { enabled: true, maxAttempts: 1, nonRecoverablePatterns: ['PLAN QUOTA'] } } }
        });
        assert.equal(out.attempted, false);
        assert.equal(out.reason, 'non-recoverable');
        assert.deepEqual(blocked.commands, []);
    });
});

// ── gh-1196: resumeAgent helper contracts ────────────────────────────────────
// Direct pins for the extracted pure helpers (the gh-1079 decomposition
// pattern): each helper's decision table, independent of resumeAgent's
// orchestration.
suite('feedbackLoop > resumeAgent helper contracts (gh-1196)', function() {
    var mod = loadFeedbackLoop().mod;

    test('feedbackSection defaults to postAction', function() {
        assert.equal(mod.feedbackSection({}), 'postAction');
        assert.equal(mod.feedbackSection({ section: 'qualityGates' }), 'qualityGates');
    });

    test('resumeEnabled: root/section switch on, explicit enabled:false wins', function() {
        var cp = { feedbackLoop: { postAction: { enabled: true } } };
        assert.equal(mod.resumeEnabled(cp, 'postAction', mod.normalizeConfig(cp, 'postAction')), true);

        var off = { feedbackLoop: { enabled: true, postAction: { enabled: false } } };
        assert.equal(mod.resumeEnabled(off, 'postAction', mod.normalizeConfig(off, 'postAction')), false);

        var none = {};
        assert.equal(mod.resumeEnabled(none, 'postAction', mod.normalizeConfig(none, 'postAction')), false);
    });

    test('maxAttemptsFrom: null rides the default, garbage parses to 0', function() {
        assert.equal(mod.maxAttemptsFrom({}), mod.DEFAULT_MAX_ATTEMPTS);
        assert.equal(mod.maxAttemptsFrom({ maxAttempts: null }), mod.DEFAULT_MAX_ATTEMPTS);
        assert.equal(mod.maxAttemptsFrom({ maxAttempts: '3' }), 3);
        assert.equal(mod.maxAttemptsFrom({ maxAttempts: 'garbage' }), 0);
        assert.equal(mod.maxAttemptsFrom({ maxAttempts: 0 }), 0);
        assert.equal(mod.maxAttemptsFrom({ maxAttempts: -2 }), 0);
    });

    test('resumeBlocker: the three early exits in contract order, null = proceed', function() {
        var enabled = { feedbackLoop: { postAction: { enabled: true, maxAttempts: 1 } } };
        var cfg = mod.normalizeConfig(enabled, 'postAction');
        assert.equal(mod.resumeBlocker({}, enabled, cfg, 'postAction'), null);
        assert.deepEqual(
            mod.resumeBlocker({ error: 'refusing to merge unrelated histories' }, enabled, cfg, 'postAction'),
            { attempted: false, reason: 'non-recoverable' });

        var disabled = {};
        assert.deepEqual(
            mod.resumeBlocker({}, disabled, mod.normalizeConfig(disabled, 'postAction'), 'postAction'),
            { attempted: false, reason: 'disabled' });

        var zero = { feedbackLoop: { postAction: { enabled: true, maxAttempts: 0 } } };
        assert.deepEqual(
            mod.resumeBlocker({}, zero, mod.normalizeConfig(zero, 'postAction'), 'postAction'),
            { attempted: false, reason: 'maxAttempts=0' });
    });

    test('resumeKey + feedbackMarkerPaths: the sanitized <ticket>_<stage> marker pair', function() {
        var paths = mod.feedbackMarkerPaths(mod.resumeKey({ ticketKey: 'TS 1/x', stage: 'git ops' }));
        assert.deepEqual(paths, {
            marker: 'outputs/feedback/TS_1_x_git_ops.attempt',
            prompt: 'outputs/feedback/TS_1_x_git_ops.md'
        });
        assert.deepEqual(mod.feedbackMarkerPaths(mod.resumeKey({})), {
            marker: 'outputs/feedback/unknown_feedback.attempt',
            prompt: 'outputs/feedback/unknown_feedback.md'
        });
    });

    test('resumePromptFor: override wins, buildFeedbackPrompt stamps the attempt', function() {
        assert.equal(mod.resumePromptFor({ promptOverride: 'OVR' }, 'err', 2), 'OVR');
        var built = mod.resumePromptFor({ ticketKey: 'TS-1', stage: 'git_operations' }, 'err', 3);
        assert.contains(built, 'Ticket: TS-1');
        assert.contains(built, 'Stage: git_operations');
        assert.contains(built, 'Attempt: 3');
        assert.contains(built, 'err');
    });

    test('buildResumeCommand: --continue default, resumeArgs override, hard timeout wrap', function() {
        assert.equal(
            mod.buildResumeCommand({}, 'outputs/feedback/k.md', undefined),
            'bash agents/scripts/run-agent.sh --continue outputs/feedback/k.md');
        assert.equal(
            mod.buildResumeCommand({ resumeArgs: '-r sess-9' }, 'outputs/feedback/k.md', '30'),
            'bash -c "timeout -k 60 30 bash agents/scripts/run-agent.sh -r sess-9 outputs/feedback/k.md"');
        assert.equal(
            mod.buildResumeCommand({}, 'k.md', 'nope'),
            'bash agents/scripts/run-agent.sh --continue k.md', 'unparseable timeout → no wrap');
        assert.equal(
            mod.buildResumeCommand({}, 'k.md', 0),
            'bash agents/scripts/run-agent.sh --continue k.md', 'zero timeout → no wrap');
    });

    test('resumeLogLine: the attempt progress line, stage default failure', function() {
        assert.equal(mod.resumeLogLine('git_operations', 1, 2),
            'Feedback loop: resuming agent for git_operations attempt 1/2');
        assert.equal(mod.resumeLogLine(undefined, 2, 2),
            'Feedback loop: resuming agent for failure attempt 2/2');
    });
});
