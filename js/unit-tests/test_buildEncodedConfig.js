/**
 * Unit tests for js/common/buildEncodedConfig.js
 *
 * Tests the shared encoded_config builder used by smAgent.js and autoStart.js.
 */

function makeFileMapReader(fileMap) {
    return function(readOpts) {
        var p = readOpts.path;
        if (fileMap && fileMap.hasOwnProperty(p)) {
            return fileMap[p];
        }
        try {
            return file_read(readOpts);
        } catch (e) {}
        return null;
    };
}

function loadBuilder(fileMap) {
    var reader = makeFileMapReader(fileMap);
    return loadModule(
        'js/common/buildEncodedConfig.js',
        makeRequire({ '../configLoader.js': configLoaderModule }),
        { file_read: reader, encodeURIComponent: encodeURIComponent, JSON: JSON }
    );
}

function decode(encoded) {
    return JSON.parse(decodeURIComponent(encoded));
}

suite('buildEncodedConfig helper functions', function() {

    test('extractAgentName strips directories and .json extension', function() {
        var builder = loadBuilder({});
        assert.equal(builder.extractAgentName('agents/story_development.json'), 'story_development');
        assert.equal(builder.extractAgentName('story_development.json'), 'story_development');
        assert.equal(builder.extractAgentName('story_development'), 'story_development');
        assert.equal(builder.extractAgentName(''), '');
        assert.equal(builder.extractAgentName(null), '');
    });

    test('resolveConfigFile returns full paths unchanged', function() {
        var builder = loadBuilder({});
        assert.equal(builder.resolveConfigFile({ configFile: 'projects/demo/Agent.json' }, {}), 'projects/demo/Agent.json');
    });

    test('resolveConfigFile prepends agentConfigsDir for bare filenames', function() {
        var builder = loadBuilder({});
        assert.equal(
            builder.resolveConfigFile({ configFile: 'StoryAgent.json' }, { agentConfigsDir: 'projects/demo/' }),
            'projects/demo/StoryAgent.json'
        );
        assert.equal(
            builder.resolveConfigFile({ configFile: 'StoryAgent.json' }, { agentConfigsDir: 'projects/demo' }),
            'projects/demo/StoryAgent.json'
        );
    });

    test('resolveConfigFile accepts a bare string instead of a rule object', function() {
        var builder = loadBuilder({});
        assert.equal(builder.resolveConfigFile('agents/test.json', {}), 'agents/test.json');
    });
});

suite('buildEncodedConfig payload', function() {

    test('inputJql is always the real ticket key', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: { inputJql: 'key in (OLD-1)' } })
        });
        var encoded = builder.buildEncodedConfig('TS-24', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.equal(decoded.params.inputJql, 'key = TS-24');
    });

    test('copies primitive, boolean, number, array and object params from agent JSON', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({
                params: {
                    str: 'hello',
                    flag: true,
                    count: 42,
                    list: ['a', 'b'],
                    nested: { key: 'value' }
                }
            })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.equal(decoded.params.str, 'hello');
        assert.equal(decoded.params.flag, true);
        assert.equal(decoded.params.count, 42);
        assert.deepEqual(decoded.params.list, ['a', 'b']);
        assert.deepEqual(decoded.params.nested, { key: 'value' });
    });

    test('copies agentParams and customParams from agent JSON', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({
                params: {
                    agentParams: { aiRole: 'Engineer', nested: { x: 1 } },
                    customParams: { project: 'P' }
                }
            })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.equal(decoded.params.agentParams.aiRole, 'Engineer');
        assert.deepEqual(decoded.params.agentParams.nested, { x: 1 });
        assert.deepEqual(decoded.params.customParams, { project: 'P' });
    });

    test('agentParams is always present even when agent JSON has none', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.ok(typeof decoded.params.agentParams === 'object' && decoded.params.agentParams !== null);
    });

    test('interpolates jiraProject and parentTicket placeholders', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({
                params: {
                    jqlA: 'project = {jiraProject}',
                    jqlB: 'parent = {parentTicket}'
                }
            })
        });
        var config = {
            jira: { project: 'PROJ', parentTicket: 'PROJ-99' }
        };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, config);
        var decoded = decode(encoded);
        assert.equal(decoded.params.jqlA, 'project = PROJ');
        assert.equal(decoded.params.jqlB, 'parent = PROJ-99');
    });

    test('adds configPath to customParams when config has _configPath', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var config = { _configPath: 'projects/web/.dmtools/config.js' };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, config);
        var decoded = decode(encoded);
        assert.equal(decoded.params.customParams.configPath, 'projects/web/.dmtools/config.js');
    });

    test('uses project-specific agent JSON when it exists', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: { generic: true, value: 'base' } }),
            'ai_teammate/web/test.json': JSON.stringify({ params: { projectSpecific: true, value: 'web' } })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json', projectKey: 'web' }, {});
        var decoded = decode(encoded);
        assert.equal(decoded.params.projectSpecific, true);
        assert.equal(decoded.params.value, 'web');
        assert.notOk(decoded.params.generic);
    });

    test('falls back to generic agent JSON when project-specific variant is missing', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: { generic: true } })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json', projectKey: 'mobile' }, {});
        var decoded = decode(encoded);
        assert.equal(decoded.params.generic, true);
    });

    test('merges config cliPrompts and cliPromptOverride', function() {
        var builder = loadBuilder({
            'agents/story_development.json': JSON.stringify({
                params: {
                    cliPrompts: ['agent-prompt.md']
                }
            })
        });
        var config = {
            cliPromptOverrides: { story_development: './.dmtools/prompts/main.md' },
            cliPrompts: { story_development: ['./.dmtools/prompts/role.md'] }
        };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/story_development.json' }, config);
        var decoded = decode(encoded);
        assert.equal(decoded.params.cliPrompt, './.dmtools/prompts/main.md');
        assert.deepEqual(decoded.params.cliPrompts, ['agent-prompt.md', './.dmtools/prompts/role.md']);
    });

    test('merges config additionalInstructions', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var config = {
            additionalInstructions: { test: ['Use TypeScript'] }
        };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, config);
        var decoded = decode(encoded);
        assert.deepEqual(decoded.params.additionalInstructions, ['Use TypeScript']);
    });

    test('applies agentParamPatch and jobParamPatch from config', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({
                params: {
                    agentParams: { existing: true }
                }
            })
        });
        var config = {
            agentParamPatches: { test: { aiRole: 'Senior' } },
            jobParamPatches: { test: { confluencePages: ['./doc.md'] } }
        };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, config);
        var decoded = decode(encoded);
        assert.equal(decoded.params.agentParams.existing, true);
        assert.equal(decoded.params.agentParams.aiRole, 'Senior');
        assert.deepEqual(decoded.params.confluencePages, ['./doc.md']);
    });

    test('injects instructions override into agentParams when configured', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var config = {
            instructionOverrides: { test: ['./.dmtools/instructions/custom.md'] }
        };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, config);
        var decoded = decode(encoded);
        assert.deepEqual(decoded.params.agentParams.instructions, ['./.dmtools/instructions/custom.md']);
    });

    test('maps fieldName for story_acceptance_criteria agents from jira.fields', function() {
        var builder = loadBuilder({
            'agents/story_acceptance_criterias.json': JSON.stringify({ params: {} })
        });
        var config = {
            jira: { fields: { acceptanceCriteria: 'customfield_12345' } }
        };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/story_acceptance_criterias.json' }, config);
        var decoded = decode(encoded);
        assert.equal(decoded.params.fieldName, 'customfield_12345');
    });

    test('maps fieldName for story_acceptance_criteria agent too', function() {
        var builder = loadBuilder({
            'agents/story_acceptance_criteria.json': JSON.stringify({ params: {} })
        });
        var config = {
            jira: { fields: { acceptanceCriteria: 'customfield_99999' } }
        };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/story_acceptance_criteria.json' }, config);
        var decoded = decode(encoded);
        assert.equal(decoded.params.fieldName, 'customfield_99999');
    });

    test('does not add additionalInstructions when not configured', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.notOk(decoded.params.additionalInstructions);
    });

    test('produces minimal payload when no config file is provided', function() {
        var builder = loadBuilder({});
        var encoded = builder.buildEncodedConfig('T-1', {}, {});
        var decoded = decode(encoded);
        assert.equal(decoded.params.inputJql, 'key = T-1');
        assert.deepEqual(decoded.params.agentParams, {});
        assert.notOk(decoded.params.customParams);
    });
});

suite('resolveParentMerge — parent inheritance', function() {

    test('returns child params as-is when no parent block', function() {
        var builder = loadBuilder({});
        var result = builder.resolveParentMerge(
            { params: { cliPrompts: ['child.md'] } },
            'agents/child.json'
        );
        assert.deepEqual(result.cliPrompts, ['child.md']);
    });

    test('deep-merges parent params when parent.path exists but no merge directive', function() {
        var builder = loadBuilder({
            'agents/parent.json': JSON.stringify({ params: { postJSAction: 'base.js', cliPrompts: ['parent.md'] } })
        });
        var result = builder.resolveParentMerge(
            { parent: { path: 'parent.json' }, params: { postJSAction: 'child.js' } },
            'agents/child.json'
        );
        // Child scalar wins
        assert.equal(result.postJSAction, 'child.js');
        // Parent array replaced by child (no merge directive) — child wins
        assert.deepEqual(result.cliPrompts, ['parent.md']);
    });

    test('prepends parent cliPrompts before child when merge contains params.cliPrompts', function() {
        var builder = loadBuilder({
            'agents/parent.json': JSON.stringify({
                params: { cliPrompts: ['parent-a.md', 'parent-b.md'] }
            })
        });
        var result = builder.resolveParentMerge(
            {
                parent: { path: 'parent.json', merge: ['params.cliPrompts'] },
                params: { cliPrompts: ['child-1.md', 'child-2.md'] }
            },
            'agents/child.json'
        );
        assert.deepEqual(result.cliPrompts, ['parent-a.md', 'parent-b.md', 'child-1.md', 'child-2.md']);
    });

    test('merge works with bare key notation (without params. prefix)', function() {
        var builder = loadBuilder({
            'agents/parent.json': JSON.stringify({ params: { cliPrompts: ['p.md'] } })
        });
        var result = builder.resolveParentMerge(
            { parent: { path: 'parent.json', merge: ['cliPrompts'] }, params: { cliPrompts: ['c.md'] } },
            'agents/child.json'
        );
        assert.deepEqual(result.cliPrompts, ['p.md', 'c.md']);
    });

    test('resolveParentMerge flows into buildEncodedConfig — child sees merged cliPrompts + config.js appended', function() {
        var builder = loadBuilder({
            'agents/parent.json': JSON.stringify({
                params: { cliPrompts: ['base-a.md', 'base-b.md'] }
            }),
            'agents/child.json': JSON.stringify({
                parent: { path: 'parent.json', merge: ['params.cliPrompts'] },
                params: { cliPrompts: ['e2e-extra.md'] }
            })
        });
        var config = {
            cliPrompts: { child: ['project-specific.md'] }
        };
        var encoded = builder.buildEncodedConfig('T-99', { configFile: 'agents/child.json' }, config);
        var decoded = decode(encoded);
        // Expected: [parent items + child items] + config.js items
        assert.deepEqual(decoded.params.cliPrompts, [
            'base-a.md', 'base-b.md', 'e2e-extra.md', 'project-specific.md'
        ]);
    });
});

