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
            var res = file_read(readOpts);
            if (res) return res;
        } catch (e) {}
        if (typeof p === 'string' && p.indexOf('agents/') === 0) {
            try {
                var stripped = file_read({ path: p.substring('agents/'.length) });
                if (stripped) return stripped;
            } catch (e) {}
        }
        return null;
    };
}

function realKeyModules() {
    var shapes = loadModule('js/common/ticketKeyShapes.js', makeRequire({}), {});
    var trackers = loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': shapes }), {});
    return {
        './validateInputJql.js': loadModule('js/common/validateInputJql.js', makeRequire({ './ticketKeyShapes.js': shapes, './trackers.js': trackers }), {}),
        './trackers.js': trackers
    };
}

function loadBuilder(fileMap) {
    var reader = makeFileMapReader(fileMap);
    return loadModule(
        'js/common/buildEncodedConfig.js',
        makeRequire(Object.assign({ '../configLoader.js': configLoaderModule }, realKeyModules())),
        { file_read: reader, encodeURIComponent: encodeURIComponent, JSON: JSON }
    );
}

function decode(encoded) {
    return JSON.parse(decodeURIComponent(encoded));
}

suite('buildEncodedConfig helper functions', function() {

    test('buildEncodedConfig JSDoc summary appears exactly once (no orphaned duplicate)', function() {
        var src = file_read({ path: 'js/common/buildEncodedConfig.js' });
        var count = src.split('Build the encoded config payload for a workflow dispatch.').length - 1;
        assert.equal(count, 1, 'found an orphaned duplicated buildEncodedConfig docblock');
    });

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

    test('sets customParams.localTeammate=true when isLocal is passed', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {}, true);
        var decoded = decode(encoded);
        assert.equal(decoded.params.customParams.localTeammate, true);
    });

    test('does not set customParams.localTeammate when isLocal is omitted (default/back-compat)', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.notOk(decoded.params.customParams, 'customParams should not be created just for isLocal when omitted');
    });

    test('preserves both configPath and localTeammate together in customParams', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var config = { _configPath: 'projects/web/.dmtools/config.js' };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, config, true);
        var decoded = decode(encoded);
        assert.equal(decoded.params.customParams.configPath, 'projects/web/.dmtools/config.js');
        assert.equal(decoded.params.customParams.localTeammate, true);
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

    test('metadata carries agentId and contextId derived from _configPath basename', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        // Only a config file NOT named "config.js" contributes a project key
        // (see resolveProjectKey: basename "config" is ignored).
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' },
            { _configPath: 'projects/web/.dmtools/web.js' });
        var decoded = decode(encoded);
        assert.equal(decoded.params.metadata.agentId, 'test');
        assert.equal(decoded.params.metadata.contextId, 'WEB');
    });

    test('metadata has no contextId when the config file is named config.js', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({ params: {} })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' },
            { _configPath: 'projects/web/.dmtools/config.js' });
        var decoded = decode(encoded);
        assert.equal(decoded.params.metadata.agentId, 'test');
        assert.notOk(decoded.params.metadata.contextId);
    });

    test('metadata is omitted when both agentId and contextId are absent', function() {
        var builder = loadBuilder({});
        var encoded = builder.buildEncodedConfig('T-1', {}, {});
        var decoded = decode(encoded);
        assert.notOk(decoded.params.metadata);
    });

    test('cliPromptsByTracker is not copied into encoded params (already flattened into cliPrompts)', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({
                params: {
                    cliPrompts: ['./base.md'],
                    cliPromptsByTracker: { jira: ['./jira.md'] }
                }
            })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.notOk(decoded.params.cliPromptsByTracker);
    });

    test('contentOutput.target=confluence in agent customParams selects confluence tracker prompts', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({
                params: {
                    cliPrompts: ['./base.md'],
                    cliPromptsByTracker: {
                        jira: ['./jira-markup.md'],
                        confluence: ['./confluence-markup.md']
                    },
                    customParams: { contentOutput: { target: 'confluence' } }
                }
            })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.deepEqual(decoded.params.cliPrompts, ['./base.md', './confluence-markup.md']);
    });

    test('jobParamPatches customParams.contentOutput.target wins over agent JSON', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({
                params: {
                    cliPrompts: ['./base.md'],
                    cliPromptsByTracker: {
                        jira: ['./jira-markup.md'],
                        confluence: ['./confluence-markup.md']
                    }
                }
            })
        });
        var config = {
            jobParamPatches: {
                test: { customParams: { contentOutput: { target: 'confluence' } } }
            }
        };
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, config);
        var decoded = decode(encoded);
        assert.deepEqual(decoded.params.cliPrompts, ['./base.md', './confluence-markup.md']);
    });

    test('confluence target without declared confluence prompts keeps default tracker prompts', function() {
        var builder = loadBuilder({
            'agents/test.json': JSON.stringify({
                params: {
                    cliPrompts: ['./base.md'],
                    cliPromptsByTracker: { jira: ['./jira-markup.md'] },
                    customParams: { contentOutput: { target: 'confluence' } }
                }
            })
        });
        var encoded = builder.buildEncodedConfig('T-1', { configFile: 'agents/test.json' }, {});
        var decoded = decode(encoded);
        assert.deepEqual(decoded.params.cliPrompts, ['./base.md', './jira-markup.md']);
    });

    test('resolveConfluenceTrackerOverride unit checks', function() {
        var builder = loadBuilder({});
        var agentParamsRoot = {
            cliPromptsByTracker: { confluence: ['./c.md'] },
            customParams: { contentOutput: { target: 'confluence' } }
        };
        assert.equal(builder.resolveConfluenceTrackerOverride(agentParamsRoot, {}, 'test'), 'confluence');
        assert.equal(builder.resolveConfluenceTrackerOverride(
            { cliPromptsByTracker: { confluence: ['./c.md'] }, customParams: { contentOutput: { target: 'wiki' } } },
            {}, 'test'), 'confluence');
        // target both → no override (tracker field still needs tracker markup)
        assert.equal(builder.resolveConfluenceTrackerOverride(
            { cliPromptsByTracker: { confluence: ['./c.md'] }, customParams: { contentOutput: { target: 'both' } } },
            {}, 'test'), null);
        // no confluence prompts declared → no override
        assert.equal(builder.resolveConfluenceTrackerOverride(
            { cliPromptsByTracker: { jira: ['./j.md'] }, customParams: { contentOutput: { target: 'confluence' } } },
            {}, 'test'), null);
        // no contentOutput → no override
        assert.equal(builder.resolveConfluenceTrackerOverride(
            { cliPromptsByTracker: { confluence: ['./c.md'] } }, {}, 'test'), null);
        // config-level confluence prompts are enough
        assert.equal(builder.resolveConfluenceTrackerOverride(
            { customParams: { contentOutput: { target: 'confluence' } } },
            { cliPromptsByTracker: { confluence: ['./c.md'] } }, 'test'), 'confluence');
    });

    test('gh-1160: real dev/review/rework configs inject only the active tracker comment format prompt and inline exact sections', function() {
        var builder = loadBuilder({});
        function assemblePrompt(cliPrompts) {
            return cliPrompts.map(function(entry) {
                if (entry.indexOf('./agents/') === 0) {
                    return file_read({ path: entry.replace(/^\.\/agents\//, '') }) || file_read({ path: entry });
                }
                return entry;
            }).filter(Boolean).join('\n\n');
        }
        var configs = [
            'agents/story_development.json',
            'agents/bug_development.json',
            'agents/bug_fix_batch_development.json',
            'agents/pr_review.json',
            'agents/pr_rework.json'
        ];
        configs.forEach(function(cfgFile) {
            var jiraPrompts = decode(builder.buildEncodedConfig('PROJ-1', { configFile: cfgFile }, { tracker: { provider: 'jira' } })).params.cliPrompts;
            assert.ok(jiraPrompts.indexOf('./agents/instructions/tracker/jira_comment_format.md') !== -1, cfgFile + ' jira: has jira_comment_format.md');
            assert.equal(jiraPrompts.indexOf('./agents/instructions/tracker/ado_comment_format.md'), -1, cfgFile + ' jira: excludes ado_comment_format.md');
            assert.equal(jiraPrompts.indexOf('./agents/instructions/common/github_comment_format.md'), -1, cfgFile + ' jira: excludes github_comment_format.md');
            var jiraText = assemblePrompt(jiraPrompts);
            assert.ok(jiraText.indexOf('# Jira tracker comment') !== -1, cfgFile + ' jira assembled: inlines # Jira tracker comment');
            assert.equal(jiraText.indexOf('# ADO tracker comment'), -1, cfgFile + ' jira assembled: excludes # ADO tracker comment');
            assert.equal(jiraText.indexOf('# GitHub tracker comment'), -1, cfgFile + ' jira assembled: excludes # GitHub tracker comment');

            var adoPrompts = decode(builder.buildEncodedConfig('101', { configFile: cfgFile }, { tracker: { provider: 'ado' } })).params.cliPrompts;
            assert.ok(adoPrompts.indexOf('./agents/instructions/tracker/ado_comment_format.md') !== -1, cfgFile + ' ado: has ado_comment_format.md');
            assert.equal(adoPrompts.indexOf('./agents/instructions/tracker/jira_comment_format.md'), -1, cfgFile + ' ado: excludes jira_comment_format.md');
            assert.equal(adoPrompts.indexOf('./agents/instructions/common/github_comment_format.md'), -1, cfgFile + ' ado: excludes github_comment_format.md');
            var adoText = assemblePrompt(adoPrompts);
            assert.ok(adoText.indexOf('# ADO tracker comment') !== -1, cfgFile + ' ado assembled: inlines # ADO tracker comment');
            assert.equal(adoText.indexOf('# Jira tracker comment'), -1, cfgFile + ' ado assembled: excludes # Jira tracker comment');
            assert.equal(adoText.indexOf('# GitHub tracker comment'), -1, cfgFile + ' ado assembled: excludes # GitHub tracker comment');

            var ghPrompts = decode(builder.buildEncodedConfig('42', { configFile: cfgFile }, { tracker: { provider: 'github' } })).params.cliPrompts;
            assert.ok(ghPrompts.indexOf('./agents/instructions/common/github_comment_format.md') !== -1, cfgFile + ' github: has github_comment_format.md');
            assert.equal(ghPrompts.indexOf('./agents/instructions/tracker/jira_comment_format.md'), -1, cfgFile + ' github: excludes jira_comment_format.md');
            assert.equal(ghPrompts.indexOf('./agents/instructions/tracker/ado_comment_format.md'), -1, cfgFile + ' github: excludes ado_comment_format.md');
            var ghText = assemblePrompt(ghPrompts);
            assert.ok(ghText.indexOf('# GitHub tracker comment') !== -1, cfgFile + ' github assembled: inlines # GitHub tracker comment');
            assert.equal(ghText.indexOf('# Jira tracker comment'), -1, cfgFile + ' github assembled: excludes # Jira tracker comment');
            assert.equal(ghText.indexOf('# ADO tracker comment'), -1, cfgFile + ' github assembled: excludes # ADO tracker comment');
        });
    });

    test('gh-1160: real story_solution/description/acceptance_criteria/wiki_publisher/discovery load confluence_comments.md only for confluence/wiki targets and assemble exact prompt sections', function() {
        var builder = loadBuilder({});
        function assemblePrompt(cliPrompts) {
            return cliPrompts.map(function(entry) {
                if (entry.indexOf('./agents/') === 0) {
                    return file_read({ path: entry.replace(/^\.\/agents\//, '') }) || file_read({ path: entry });
                }
                return entry;
            }).filter(Boolean).join('\n\n');
        }
        var contentConfigs = [
            { file: 'agents/story_solution.json', name: 'story_solution', jiraPrompt: './agents/instructions/tracker/jira_markup_transform.md' },
            { file: 'agents/story_description.json', name: 'story_description', jiraPrompt: './agents/instructions/tracker/jira_comment_format.md' },
            { file: 'agents/story_acceptance_criteria.json', name: 'story_acceptance_criteria', jiraPrompt: './agents/instructions/tracker/jira_markup_transform.md' },
            { file: 'agents/story_acceptance_criterias.json', name: 'story_acceptance_criterias', jiraPrompt: './agents/instructions/tracker/jira_markup_transform.md' }
        ];
        contentConfigs.forEach(function(item) {
            // Default jira_field target on jira tracker -> jira prompt, NO confluence_comments.md
            var jiraFieldPrompts = decode(builder.buildEncodedConfig('PROJ-1', { configFile: item.file }, { tracker: { provider: 'jira' } })).params.cliPrompts;
            assert.ok(jiraFieldPrompts.indexOf(item.jiraPrompt) !== -1, item.name + ' jira_field: has ' + item.jiraPrompt);
            assert.equal(jiraFieldPrompts.indexOf('./agents/instructions/common/confluence_comments.md'), -1, item.name + ' jira_field: excludes confluence_comments.md');
            var jiraText = assemblePrompt(jiraFieldPrompts);
            assert.equal(jiraText.indexOf('# Confluence output'), -1, item.name + ' jira_field assembled prompt: no # Confluence output section');

            // Default jira_field target on ado tracker -> ado markup + GFM table inlined, NO confluence_comments.md
            var adoFieldPrompts = decode(builder.buildEncodedConfig('101', { configFile: item.file }, { tracker: { provider: 'ado' } })).params.cliPrompts;
            assert.ok(adoFieldPrompts.indexOf('./agents/instructions/tracker/ado_markup_transform.md') !== -1, item.name + ' ado_field: has ado_markup_transform.md');
            assert.equal(adoFieldPrompts.indexOf('./agents/instructions/common/confluence_comments.md'), -1, item.name + ' ado_field: excludes confluence_comments.md');
            var adoText = assemblePrompt(adoFieldPrompts);
            assert.ok(adoText.indexOf('**GitHub-Flavored Markdown Placeholder Table**') !== -1, item.name + ' ado_field assembled prompt: inlines GFM placeholder table heading');
            assert.ok(adoText.indexOf('When the target tracker is Azure DevOps, replace every generic placeholder tag from the template with the GitHub-flavored Markdown from the **GitHub-Flavored Markdown Placeholder Table** section.') !== -1, item.name + ' ado_field assembled prompt: inlines ADO transform rules');
            assert.equal(adoText.indexOf('# Confluence output'), -1, item.name + ' ado_field assembled prompt: no # Confluence output section');

            // Patched to confluence target -> confluence markup + confluence_comments.md, NO jira/ado markup
            var patch = {};
            patch[item.name] = { customParams: { contentOutput: { target: 'confluence' } } };
            var cfPrompts = decode(builder.buildEncodedConfig('PROJ-1', { configFile: item.file }, { tracker: { provider: 'jira' }, jobParamPatches: patch })).params.cliPrompts;
            assert.ok(cfPrompts.indexOf('./agents/instructions/tracker/confluence_markup_transform.md') !== -1, item.name + ' confluence: has confluence_markup_transform.md');
            assert.ok(cfPrompts.indexOf('./agents/instructions/common/confluence_comments.md') !== -1, item.name + ' confluence: has confluence_comments.md');
            assert.equal(cfPrompts.indexOf(item.jiraPrompt), -1, item.name + ' confluence: excludes ' + item.jiraPrompt);
            var cfText = assemblePrompt(cfPrompts);
            assert.ok(cfText.indexOf('**GitHub-Flavored Markdown Placeholder Table**') !== -1, item.name + ' confluence assembled prompt: inlines GFM placeholder table heading');
            assert.ok(cfText.indexOf('# Confluence output') !== -1, item.name + ' confluence assembled prompt: inlines # Confluence output section');
        });

        // wiki_publisher defaults to target: 'wiki' -> selects confluence prompts including confluence_comments.md
        var wikiPrompts = decode(builder.buildEncodedConfig('PROJ-1', { configFile: 'agents/wiki_publisher.json' }, { tracker: { provider: 'jira' } })).params.cliPrompts;
        assert.ok(wikiPrompts.indexOf('./agents/instructions/tracker/confluence_markup_transform.md') !== -1, 'wiki_publisher: has confluence_markup_transform.md');
        assert.ok(wikiPrompts.indexOf('./agents/instructions/common/confluence_comments.md') !== -1, 'wiki_publisher: has confluence_comments.md');
        assert.equal(wikiPrompts.indexOf('./agents/instructions/tracker/jira_markup_transform.md'), -1, 'wiki_publisher: excludes jira_markup_transform.md');
        var wikiText = assemblePrompt(wikiPrompts);
        assert.ok(wikiText.indexOf('# Confluence output') !== -1, 'wiki_publisher assembled prompt: inlines # Confluence output');

        // discovery defaults to target: 'confluence' -> selects discovery/confluence_comments.md
        var discPrompts = decode(builder.buildEncodedConfig('PROJ-1', { configFile: 'agents/discovery.json' }, { tracker: { provider: 'jira' } })).params.cliPrompts;
        assert.ok(discPrompts.indexOf('./agents/instructions/discovery/confluence_comments.md') !== -1, 'discovery: has discovery/confluence_comments.md');
        var discText = assemblePrompt(discPrompts);
        assert.ok(discText.indexOf('# Confluence inline comments (discovery page tree)') !== -1, 'discovery assembled prompt: inlines discovery Confluence inline comments');
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

    test('returns empty params object when agentJson has no params block', function() {
        var builder = loadBuilder({});
        assert.deepEqual(builder.resolveParentMerge({}, 'agents/child.json'), {});
        assert.deepEqual(builder.resolveParentMerge(null, 'agents/child.json'), {});
    });

    test('keeps child params when the parent file is missing', function() {
        var builder = loadBuilder({});
        var childJson = { params: { a: 1 }, parent: { path: 'missing.json' } };
        assert.deepEqual(builder.resolveParentMerge(childJson, 'agents/child.json'), { a: 1 });
    });

    test('merge directive tolerates non-array parent and child values', function() {
        var builder = loadBuilder({
            'agents/parent.json': JSON.stringify({ params: { cliPrompts: 'not-an-array' } })
        });
        var childJson = {
            params: { cliPrompts: 42 },
            parent: { path: 'parent.json', merge: ['params.cliPrompts'] }
        };
        var merged = builder.resolveParentMerge(childJson, 'agents/child.json');
        assert.deepEqual(merged.cliPrompts, []);
    });

    test('recursion guard stops parent chains deeper than 10 levels', function() {
        var fileMap = {};
        for (var i = 0; i < 12; i++) {
            var entry = { params: {} };
            if (i === 11) {
                entry.params.deepMarker = true;
            } else {
                entry.parent = { path: 'p' + (i + 1) + '.json' };
            }
            fileMap['agents/p' + i + '.json'] = JSON.stringify(entry);
        }
        var builder = loadBuilder(fileMap);
        var childJson = { params: {}, parent: { path: 'p0.json' } };
        var merged = builder.resolveParentMerge(childJson, 'agents/child.json');
        assert.notOk(merged.deepMarker, 'level-11 parent params never merge in (depth guard)');
        // Control: a chain within the guard does merge the deep marker.
        var shallowMap = {
            'agents/q0.json': JSON.stringify({ params: {}, parent: { path: 'q1.json' } }),
            'agents/q1.json': JSON.stringify({ params: { deepMarker: true } })
        };
        var shallowBuilder = loadBuilder(shallowMap);
        var shallowMerged = shallowBuilder.resolveParentMerge(
            { params: {}, parent: { path: 'q0.json' } }, 'agents/child.json');
        assert.ok(shallowMerged.deepMarker, 'within the guard the deep parent merges normally');
    });

    test('config.js strategy:replace discards parent cliPrompts and uses only config.js prompts', function() {
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
            cliPrompts: {
                child: { strategy: 'replace', prompts: ['override-only.md'] }
            }
        };
        var encoded = builder.buildEncodedConfig('T-99', { configFile: 'agents/child.json' }, config);
        var decoded = decode(encoded);
        // replace: only config.js prompts, parent+child cliPrompts discarded
        assert.deepEqual(decoded.params.cliPrompts, ['override-only.md']);
    });
});



suite('buildEncodedConfig: ticket key format validation', function() {

    test('throws for an invalid ticket key format', function() {
        var builder = loadBuilder({});
        assert.throws(function() {
            builder.buildEncodedConfig('not-a-key', 'agents/story_questions.json', null);
        }, /Invalid ticket key/);
    });

    test('throws for an empty ticket key', function() {
        var builder = loadBuilder({});
        assert.throws(function() {
            builder.buildEncodedConfig('', 'agents/story_questions.json', null);
        }, /Invalid ticket key/);
    });

    test('throws for null ticket key', function() {
        var builder = loadBuilder({});
        assert.throws(function() {
            builder.buildEncodedConfig(null, 'agents/story_questions.json', null);
        }, /Invalid ticket key/);
    });

    test('throws for a key containing JQL injection characters', function() {
        var builder = loadBuilder({});
        assert.throws(function() {
            builder.buildEncodedConfig('PROJ-1 OR project = OTHER', 'agents/story_questions.json', null);
        }, /Invalid ticket key/);
    });

    test('accepts a valid ticket key and builds the config', function() {
        var builder = loadBuilder({});
        var encoded = builder.buildEncodedConfig('PROJ-42', 'agents/story_questions.json', null);
        var decoded = JSON.parse(decodeURIComponent(encoded));
        assert.equal(decoded.params.inputJql, 'key = PROJ-42');
    });

    test('Jira keys keep the exact historical inputJql (backward compatibility)', function() {
        var builder = loadBuilder({});
        ['PROJ-1', 'AB_C-123'].forEach(function(k) {
            assert.equal(decode(builder.buildEncodedConfig(k, 'agents/story_questions.json', null)).params.inputJql, 'key = ' + k);
        });
    });

    test('GitHub key shapes are accepted and keep "key = KEY"', function() {
        var builder = loadBuilder({});
        ['gh-12', 'acme/widgets#12', '#12'].forEach(function(k) {
            assert.equal(decode(builder.buildEncodedConfig(k, 'agents/story_questions.json', null)).params.inputJql, 'key = ' + k);
        });
    });

    test('a bare numeric ADO work item id is accepted and gets a WIQL id filter on the ado tracker (agents#804)', function() {
        var builder = loadBuilder({});
        var cfg = { tracker: { provider: 'ado' } };
        var decoded = decode(builder.buildEncodedConfig('1839749', 'agents/story_questions.json', cfg));
        assert.equal(decoded.params.inputJql, 'SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 1839749');
    });

    test('a bare number without a tracker config stays a "key = N" filter (GitHub issue number)', function() {
        var builder = loadBuilder({});
        assert.equal(decode(builder.buildEncodedConfig('12', 'agents/story_questions.json', null)).params.inputJql, 'key = 12');
    });

    test('injection-shaped keys are still rejected, also on the ado tracker', function() {
        var builder = loadBuilder({});
        var cfg = { tracker: { provider: 'ado' } };
        ['1839749 OR 1=1', "1' OR '1'='1", '12; DROP', 'a b'].forEach(function(k) {
            assert.throws(function() { builder.buildEncodedConfig(k, 'agents/story_questions.json', cfg); }, /Invalid ticket key/, k);
        });
    });

});
