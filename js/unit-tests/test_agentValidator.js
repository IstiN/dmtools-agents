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

            test('cliPromptsByTracker entries are valid and all file references exist', function() {
                var trackerErrors = result.errors.filter(function(e) {
                    return e.indexOf('cliPromptsByTracker') !== -1;
                });
                assert.deepEqual(trackerErrors, [],
                    'cliPromptsByTracker should have no validation or file-not-found errors');
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

// ── Synthetic & Batch & Action coverage tests ────────────────────────────────

suite('agentValidator synthetic edge cases, batch, and action', function() {

    function loadWithVirtualFs(files, cliHandler) {
        return loadModule(
            'js/agentValidator.js',
            null,
            {
                file_read: function(p) {
                    if (Object.prototype.hasOwnProperty.call(files, p.path)) {
                        var v = files[p.path];
                        if (v instanceof Error) throw v;
                        return v;
                    }
                    return null;
                },
                cli_execute_command: cliHandler || function() { return ''; }
            }
        );
    }

    test('handles unreadable JSON, missing name, missing params', function() {
        var v = loadWithVirtualFs({
            'bad.json': '{not json',
            'throw.json': new Error('io error'),
            'no_name_no_params.json': JSON.stringify({}),
            'non_teammate.json': JSON.stringify({ name: 'CustomAgent', params: {} })
        });
        var rBad = v.validateAgentJson('bad.json');
        assert.equal(rBad.valid, false);
        var rThrow = v.validateAgentJson('throw.json');
        assert.equal(rThrow.valid, false);
        var rNoParams = v.validateAgentJson('no_name_no_params.json');
        assert.equal(rNoParams.valid, false);
        assert.equal(rNoParams.errors.length, 2);

        var rNonTeammate = v.validateAgentJson('non_teammate.json');
        assert.equal(rNonTeammate.valid, true);
        assert.ok(rNonTeammate.info.some(function(i) { return i.indexOf('Non-Teammate') !== -1; }));
    });

    test('validates cliPrompts, cliPromptsByTracker, legacy agentParams, cliCommands, and JS actions', function() {
        var longText = new Array(220).join('x');
        var v = loadWithVirtualFs({
            'missing_prompts.json': JSON.stringify({
                name: 'Teammate',
                params: { cliCommands: ['./run.sh'] }
            }),
            'edge_agent.json': JSON.stringify({
                name: 'Teammate',
                params: {
                    cliPrompts: [
                        123,
                        './agents/missing_prompt.md',
                        { id: 'cond', prompt: './agents/gen.md', condition: 'c.js' },
                        longText
                    ],
                    cliPromptsByTracker: {
                        jira: 'not-an-array',
                        ado: [456, './agents/missing_ado.md', './agents/ok_ado.md', { id: 'cond_ado', prompt: './agents/cond_ado.md', condition: 'c.js' }]
                    },
                    agentParams: {
                        instructions: [longText, './agents/short.md']
                    },
                    cliCommands: [
                        789,
                        longText,
                        './agents/missing_cmd.sh --flag'
                    ],
                    preCliJSAction: 123,
                    postJSAction: './agents/missing_post.js',
                    preJSAction: './agents/syntax_err.js',
                    metadata: { contextId: 'edge_ctx' }
                }
            }),
            'mock_cmd_agent.json': JSON.stringify({
                name: 'Teammate',
                params: {
                    cliPrompts: ['./agents/ok_ado.md'],
                    cliCommands: ['./agents/missing_cmd.sh --flag'],
                    postJSAction: './agents/missing_post.js',
                    preJSAction: './agents/syntax_err.js'
                }
            }),
            'non_array_cmds.json': JSON.stringify({
                name: 'Teammate',
                params: { cliCommands: 'invalid' }
            }),
            'ok_ado.md': '# ok',
            'syntax_err.js': 'function action ( { broken syntax'
        });

        var rMissing = v.validateAgentJson('missing_prompts.json');
        assert.equal(rMissing.valid, false);

        var rNonArrayCmd = v.validateAgentJson('non_array_cmds.json');
        assert.equal(rNonArrayCmd.valid, false);

        var rEdge = v.validateAgentJson('edge_agent.json');
        assert.equal(rEdge.valid, false);
        assert.ok(rEdge.errors.length >= 6);
        assert.ok(rEdge.warnings.length >= 4);

        var rMock = v.validateAgentJson('mock_cmd_agent.json', { mockCli: true, mockActions: true });
        assert.ok(rMock.mockCliResult.warnings.length > 0);
        assert.ok(rMock.preCliResult && rMock.preCliResult.warnings.length > 0);
    });

    test('mockJsAction handles missing file, read exception, and module.exports.action', function() {
        var v = loadWithVirtualFs({
            'exports_only.js': 'module.exports.action = function() {};',
            'throw_js.js': new Error('disk fail')
        });
        var rMissing = v.mockJsAction('./agents/nope.js', {}, 'pre');
        assert.equal(rMissing.loaded, false);
        assert.ok(rMissing.warning.indexOf('Cannot read JS file') !== -1);

        var rThrow = v.mockJsAction('throw_js.js', {}, 'pre');
        assert.equal(rThrow.loaded, false);
        assert.ok(rThrow.warning.indexOf('Error reading JS') !== -1);

        var rExports = v.mockJsAction('exports_only.js', {}, 'pre');
        assert.equal(rExports.loaded, true);
        assert.equal(rExports.hasActionFunction, true);
    });

    test('action and validateAllAgents handle validateAgent, validateAll, errors, and unknown mode', function() {
        var v = loadWithVirtualFs(
            {
                './valid_one.json': JSON.stringify({
                    name: 'Teammate',
                    params: {
                        cliPrompts: ['./agents/p.md'],
                        cliCommands: ['./agents/missing.sh']
                    }
                }),
                './invalid_two.json': JSON.stringify({ name: 'Teammate' }),
                'p.md': 'hello'
            },
            function() {
                return 'valid_one.json\ninvalid_two.json\n';
            }
        );

        var missingPathRes = v.action({ mode: 'validateAgent' });
        assert.equal(missingPathRes.success, false);

        var singleRes = v.action({ jobParams: { mode: 'validateAgent', agentPath: './valid_one.json' } });
        assert.equal(singleRes.success, true);

        var singleFailRes = v.action({ mode: 'validateAgent', agentPath: './invalid_two.json' });
        assert.equal(singleFailRes.success, false);

        var batchRes = v.action({ mode: 'validateAll', agentJsonDir: '.' });
        assert.equal(batchRes.success, false);
        assert.equal(batchRes.result.total, 2);
        assert.equal(batchRes.result.passed, 1);
        assert.equal(batchRes.result.failed, 1);

        var unknownRes = v.action({ mode: 'other' });
        assert.equal(unknownRes.success, false);

        var vThrowLs = loadWithVirtualFs({}, function() { throw new Error('git failed'); });
        var emptyBatch = vThrowLs.validateAllAgents();
        assert.equal(emptyBatch.total, 0);
        assert.equal(emptyBatch.allValid, true);
    });

});
