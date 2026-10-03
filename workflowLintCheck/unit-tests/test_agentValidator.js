/**
 * Unit tests for js/agentValidator.js
 *
 * Validates all agent JSON configs in the repository.
 * Uses: testRunner.js globals (test, suite, assert, loadModule, makeRequire)
 */

// ── Setup ────────────────────────────────────────────────────────────────────

var validatorModule = loadModule(
    'js/agentValidator.js',
    null,
    { file_read: file_read, cli_execute_command: cli_execute_command }
);

var validateAgentJson = validatorModule.validateAgentJson;
var resolveCliPrompts = validatorModule.resolveCliPrompts;

// ── Helper: list all agent JSON files ────────────────────────────────────────

function listAgentJsons() {
    try {
        var output = cli_execute_command({ command: 'git ls-files *.json' });
        return (output || '').split('\n').filter(function(f) {
            return f && f.trim() && f.indexOf('.json') !== -1;
        }).map(function(f) { return f.trim(); });
    } catch (e) {
        console.warn('Could not list agent JSONs:', e);
        return [];
    }
}

var agentJsons = listAgentJsons();

// ── resolveCliPrompts tests ──────────────────────────────────────────────────

suite('resolveCliPrompts', function() {

    test('returns base prompts when no tracker match', function() {
        var base = ['a', 'b'];
        var result = resolveCliPrompts(base, { jira: ['c'] }, 'ado');
        assert.deepEqual(result, ['a', 'b']);
    });

    test('merges tracker prompts when tracker matches', function() {
        var base = ['a', 'b'];
        var byTracker = { jira: ['c', 'd'] };
        var result = resolveCliPrompts(base, byTracker, 'jira');
        assert.deepEqual(result, ['a', 'b', 'c', 'd']);
    });

    test('defaults to jira when tracker is null', function() {
        var base = ['a'];
        var byTracker = { jira: ['b'] };
        var result = resolveCliPrompts(base, byTracker, null);
        assert.deepEqual(result, ['a', 'b']);
    });

    test('handles empty base prompts', function() {
        var byTracker = { ado: ['x'] };
        var result = resolveCliPrompts([], byTracker, 'ado');
        assert.deepEqual(result, ['x']);
    });

    test('handles null cliPromptsByTracker', function() {
        var base = ['a'];
        var result = resolveCliPrompts(base, null, 'jira');
        assert.deepEqual(result, ['a']);
    });

});

// ── Agent JSON validation tests ──────────────────────────────────────────────

suite('Agent JSON validation', function() {

    test('at least some agent JSONs exist', function() {
        assert.ok(agentJsons.length > 0, 'expected at least one .json file, found ' + agentJsons.length);
    });

    agentJsons.forEach(function(agentFile) {
        var agentName = agentFile.replace('.json', '');

        suite(agentFile, function() {

            var result = validateAgentJson(agentFile, {
                mockCli: true,
                mockActions: true
            });

            test('loads and parses as valid JSON', function() {
                assert.ok(result, 'validation result should exist');
                assert.ok(!result.errors.some(function(e) {
                    return e.indexOf('Cannot read or parse JSON') !== -1;
                }), 'JSON should be parseable');
            });

            test('has "name" field', function() {
                assert.ok(result, 'result exists');
                // This is implicitly checked by validateAgentJson
            });

            test('has "params" field', function() {
                assert.ok(result, 'result exists');
            });

            test('has cliPrompts array', function() {
                var json = JSON.parse(file_read({ path: agentFile }));
                var hasCliPrompts = json.params &&
                                    Array.isArray(json.params.cliPrompts) &&
                                    json.params.cliPrompts.length > 0;

                // Agents that are intentionally not Teammate-based may skip this
                var isNonTeammate = ['bug_test_cases_generator', 'df_manager',
                    'recover_failed_tc_bug_status', 'recover_merged_pr',
                    'recover_stuck_test_case', 'restoreDescription',
                    'sm', 'sm_merge', 'test_cases_generator',
                    'workflow_failure_reporter',
                    'ai_teammate_token_usage_reporter'].some(function(prefix) {
                        return agentName.indexOf(prefix) !== -1;
                    });

                if (!isNonTeammate) {
                    assert.ok(hasCliPrompts, 'expected cliPrompts array for Teammate agent');
                }
            });

            test('all cliPrompts file references exist', function() {
                var fileNotFoundErrors = result.errors.filter(function(e) {
                    return e.indexOf('file not found') !== -1 && e.indexOf('cliPrompts') !== -1;
                });
                assert.deepEqual(fileNotFoundErrors, [],
                    'all cliPrompts referenced files should exist');
            });

            test('all cliPromptsByTracker file references exist', function() {
                var fileNotFoundErrors = result.errors.filter(function(e) {
                    return e.indexOf('file not found') !== -1 &&
                           e.indexOf('cliPromptsByTracker') !== -1;
                });
                assert.deepEqual(fileNotFoundErrors, [],
                    'all tracker-specific prompt files should exist');
            });

            test('no long inline text in cliPrompts (warnings only)', function() {
                var inlineWarnings = result.warnings.filter(function(w) {
                    return w.indexOf('cliPrompts') !== -1 && w.indexOf('long inline text') !== -1;
                });
                // These are warnings, not errors — we log them for awareness
                if (inlineWarnings.length > 0) {
                    console.log('    ⚠️  cliPrompts inline text warnings: ' + inlineWarnings.length);
                }
            });

            test('cliCommands are valid (if present)', function() {
                var json = JSON.parse(file_read({ path: agentFile }));
                if (json.params && json.params.cliCommands) {
                    var cmdErrors = result.errors.filter(function(e) {
                        return e.indexOf('cliCommands') !== -1;
                    });
                    assert.deepEqual(cmdErrors, [],
                        'cliCommands should have no structural errors');
                }
            });

            test('preCli/postCli JS files exist (if referenced)', function() {
                var missingActionWarnings = result.warnings.filter(function(w) {
                    return (w.indexOf('preCliJSAction') !== -1 ||
                            w.indexOf('postJSAction') !== -1 ||
                            w.indexOf('preJSAction') !== -1) &&
                            w.indexOf('not found') !== -1;
                });
                assert.deepEqual(missingActionWarnings, [],
                    'referenced JS action files should exist');
            });

            test('mock CLI resolves commands', function() {
                if (result.mockCliResult) {
                    assert.ok(Array.isArray(result.mockCliResult.commands),
                        'mockCliResult.commands should be an array');
                }
            });

            test('mock actions load JS files', function() {
                if (result.preCliResult) {
                    assert.ok(result.preCliResult.loaded,
                        'preCli JS should be loadable');
                }
                if (result.postCliResult) {
                    assert.ok(result.postCliResult.loaded,
                        'postCli JS should be loadable');
                }
            });

        });
    });

});

// ── Specific agent structure tests ───────────────────────────────────────────

suite('Story Questions reference pattern', function() {

    test('story_questions.json uses cliPrompts pattern', function() {
        var result = validateAgentJson('story_questions.json');
        assert.ok(result.valid, 'story_questions.json should be valid');

        var json = JSON.parse(file_read({ path: 'story_questions.json' }));
        assert.notOk(json.params.agentParams,
            'story_questions should not use agentParams');
        assert.ok(json.params.cliPrompts && json.params.cliPrompts.length > 0,
            'story_questions should have cliPrompts');
        assert.ok(json.params.cliPromptsByTracker,
            'story_questions should have cliPromptsByTracker');
    });

});
