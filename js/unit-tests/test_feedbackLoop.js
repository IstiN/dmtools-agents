/**
 * Unit tests for agents/js/common/feedbackLoop.js
 */

function loadFeedbackLoop(mocks) {
    var files = {};
    var commands = [];
    var mod = loadModule(
        'agents/js/common/feedbackLoop.js',
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

});
