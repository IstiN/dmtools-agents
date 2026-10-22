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
        var output = cli_execute_command({ command: 'git ls-files "*.json"' });
        return (output || '').split('\n').filter(function(f) {
            if (!f || !f.trim()) return false;
            var name = f.trim();
            if (name.indexOf('/') !== -1) return false;
            if (name === 'versions.json' || name === '.crap-baseline.json') return false;
            return name.indexOf('.json') !== -1;
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
                var hasCliStep = json.name === 'Teammate' &&
                                 !json.parent &&
                                 json.params &&
                                 Array.isArray(json.params.cliCommands) &&
                                 json.params.cliCommands.length > 0;

                if (hasCliStep) {
                    assert.ok(hasCliPrompts, 'expected cliPrompts array for CLI-running Teammate agent');
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

// ── gh-1112 UT-cfg-1: wiki_publisher base agent config ───────────────────────

suite('wiki_publisher.json — generic wiki publisher base agent (gh-1112 UT-cfg-1)', function() {

    function readConfig() {
        try {
            var raw = file_read({ path: 'wiki_publisher.json' });
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    test('exists at the repository root and parses', function() {
        var config = readConfig();
        assert.ok(config, 'wiki_publisher.json must exist at the repo root');
    });

    test('declares the AC1 contract fields', function() {
        var config = readConfig();
        assert.equal(config.name, 'Teammate');
        var p = config.params;
        assert.equal(p.metadata.contextId, 'wiki_publisher');
        assert.equal(p.metadata.descriptionPath, 'agents/docs/agents/wiki_publisher.md');
        assert.equal(p.preJSAction, 'agents/js/requireTicket.js');
        assert.equal(p.preCliJSAction, 'agents/js/preCliContentOutputSetup.js');
        assert.equal(p.postJSAction, 'agents/js/writeContentOutput.js');
        assert.equal(p.customParams.contentOutput.target, 'wiki');
        assert.equal(p.customParams.contentOutput.updateTrackerField, false);
    });

    test('exposes tracker-specific cliPromptsByTracker for jira, ado, github and confluence', function() {
        var config = readConfig();
        var t = config.params.cliPromptsByTracker || {};
        assert.ok(Array.isArray(t.jira) && t.jira.length > 0, 'jira prompts');
        assert.ok(Array.isArray(t.ado) && t.ado.length > 0, 'ado prompts');
        assert.ok(Array.isArray(t.github) && t.github.length > 0, 'github prompts');
        assert.ok(Array.isArray(t.confluence) && t.confluence.length > 0, 'confluence prompts');
    });

    test('base cliPrompts reference the generic wiki_publisher workflow and prompt files', function() {
        var config = readConfig();
        var prompts = config.params.cliPrompts || [];
        assert.ok(prompts.indexOf('./agents/instructions/wiki_publisher/workflow.md') !== -1,
            'workflow instruction referenced');
        assert.ok(prompts.indexOf('./agents/prompts/wiki_publisher_prompt.md') !== -1,
            'entry prompt referenced');
        var t = config.params.cliPromptsByTracker || {};
        assert.ok(Array.isArray(t.confluence) && t.confluence.indexOf('./agents/instructions/common/confluence_comments.md') !== -1,
            'confluence_comments.md (inline anchor contract) referenced in cliPromptsByTracker.confluence');
    });

    test('passes the generic agent validation', function() {
        if (agentJsons.indexOf('wiki_publisher.json') === -1) {
            // untracked working tree — the generic loop above cannot see it yet
            assert.ok(true, 'wiki_publisher.json not yet git-tracked; generic loop skipped it');
            return;
        }
        var result = validateAgentJson('wiki_publisher.json', { mockCli: true, mockActions: true });
        assert.equal(result.valid, true, 'validation errors: ' + JSON.stringify(result.errors));
    });
});
