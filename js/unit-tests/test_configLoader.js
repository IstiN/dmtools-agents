/**
 * Unit tests for agents/js/configLoader.js
 *
 * Uses: configModule, configLoaderModule (pre-loaded by testRunner)
 *       loadModule(), makeRequire(), assert, test(), suite()
 */

// ── formatTemplate ────────────────────────────────────────────────────────────

suite('configLoader.formatTemplate', function() {

    test('replaces a single placeholder', function() {
        var result = configLoaderModule.formatTemplate('{key} world', { key: 'hello' });
        assert.equal(result, 'hello world');
    });

    test('replaces multiple different placeholders', function() {
        var result = configLoaderModule.formatTemplate(
            '{ticketKey} {ticketSummary}',
            { ticketKey: 'PROJ-42', ticketSummary: 'Add login page' }
        );
        assert.equal(result, 'PROJ-42 Add login page');
    });

    test('replaces the same placeholder multiple times', function() {
        var result = configLoaderModule.formatTemplate('{k} and {k}', { k: 'X' });
        assert.equal(result, 'X and X');
    });

    test('returns empty string for null template', function() {
        var result = configLoaderModule.formatTemplate(null, { k: 'v' });
        assert.equal(result, '');
    });

    test('leaves unknown placeholders as-is', function() {
        var result = configLoaderModule.formatTemplate('{unknown}', { other: 'v' });
        assert.equal(result, '{unknown}');
    });

    test('handles empty vars object', function() {
        var result = configLoaderModule.formatTemplate('no placeholders', {});
        assert.equal(result, 'no placeholders');
    });

});

// ── interpolateJql ────────────────────────────────────────────────────────────

suite('configLoader.interpolateJql', function() {

    var mockConfig = {
        jira: { project: 'PROJ', parentTicket: 'PROJ-1' }
    };

    test('replaces {jiraProject}', function() {
        var result = configLoaderModule.interpolateJql(
            "project = {jiraProject} AND issuetype = 'Story'",
            mockConfig
        );
        assert.equal(result, "project = PROJ AND issuetype = 'Story'");
    });

    test('replaces {parentTicket}', function() {
        var result = configLoaderModule.interpolateJql(
            "project = {jiraProject} AND parent = {parentTicket}",
            mockConfig
        );
        assert.equal(result, "project = PROJ AND parent = PROJ-1");
    });

    test('returns null for null JQL', function() {
        var result = configLoaderModule.interpolateJql(null, mockConfig);
        assert.equal(result, null);
    });

    test('leaves JQL unchanged when no placeholders', function() {
        var jql = "project = FIXED AND status = 'Done'";
        var result = configLoaderModule.interpolateJql(jql, mockConfig);
        assert.equal(result, jql);
    });

});

// ── formatBranchName ──────────────────────────────────────────────────────────

suite('configLoader.formatBranchName', function() {

    test('builds prefix/ticketKey', function() {
        var result = configLoaderModule.formatBranchName('ai', 'PROJ-42');
        assert.equal(result, 'ai/PROJ-42');
    });

    test('works with feature prefix', function() {
        var result = configLoaderModule.formatBranchName('feature', 'PROJ-100');
        assert.equal(result, 'feature/PROJ-100');
    });

    test('works with test prefix', function() {
        var result = configLoaderModule.formatBranchName('test', 'PROJ-7');
        assert.equal(result, 'test/PROJ-7');
    });

});

// ── mergeProjectConfig ────────────────────────────────────────────────────────

suite('configLoader.mergeProjectConfig', function() {

    var defaults = configLoaderModule.DEFAULTS;

    test('deep merges git section', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            git: { baseBranch: 'master' }
        });
        assert.equal(result.git.baseBranch, 'master');
        assert.equal(result.git.authorName, defaults.git.authorName, 'other git fields preserved');
    });

    test('fully replaces jira.statuses when provided', function() {
        var customStatuses = { DONE: 'Closed', IN_REVIEW: 'Under Review' };
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            jira: { statuses: customStatuses }
        });
        assert.deepEqual(result.jira.statuses, customStatuses);
        assert.notOk(result.jira.statuses.BACKLOG, 'old statuses removed');
    });

    test('preserves default statuses when not overridden', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            jira: { project: 'TEST' }
        });
        assert.equal(result.jira.project, 'TEST');
        assert.ok(result.jira.statuses.DONE, 'default statuses preserved');
    });

    test('fully replaces labels when provided', function() {
        var customLabels = { MY_LABEL: 'my_label' };
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            labels: customLabels
        });
        assert.deepEqual(result.labels, customLabels);
        assert.notOk(result.labels.PR_APPROVED, 'old labels removed');
    });

    test('fully replaces smRules when provided', function() {
        var customRules = [{ jql: 'custom', configFile: 'custom.json' }];
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            smRules: customRules
        });
        assert.deepEqual(result.smRules, customRules);
    });

    test('smRules null when not overridden', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, { jira: { project: 'X' } });
        assert.equal(result.smRules, null);
    });

    test('deep merges confluence URLs', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, {
            confluence: {
                templateStory: 'https://my-confluence/story'
            }
        });
        assert.equal(result.confluence.templateStory, 'https://my-confluence/story');
        assert.equal(
            result.confluence.templateJiraMarkdown,
            defaults.confluence.templateJiraMarkdown,
            'other confluence URLs preserved'
        );
    });

    test('handles null override gracefully', function() {
        var result = configLoaderModule.mergeProjectConfig(defaults, null);
        assert.equal(result.git.baseBranch, 'main');
    });

});

// ── loadProjectConfig ─────────────────────────────────────────────────────────

suite('configLoader.loadProjectConfig', function() {

    /**
     * Create a fresh configLoader instance with a controlled file_read mock.
     * fileMap: { 'path': 'file content' | null }
     */
    function makeLoader(fileMap) {
        return loadModule(
            'agents/js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            {
                file_read: function(opts) {
                    if (fileMap.hasOwnProperty(opts.path)) return fileMap[opts.path];
                    return null;
                }
            }
        );
    }

    test('returns defaults when no config file found', function() {
        var cl = makeLoader({});
        var config = cl.loadProjectConfig({});
        assert.equal(config.git.baseBranch, 'main');
        assert.equal(config.git.branchPrefix.development, 'ai');
        assert.equal(config.jira.project, '');
        assert.equal(config.repository.owner, '');
    });

    test('loads config from ../.dmtools/config.js', function() {
        var cl = makeLoader({
            '../.dmtools/config.js':
                'module.exports = { jira: { project: "PROJ", parentTicket: "PROJ-1" }, repository: { owner: "my-org", repo: "my-repo" } };'
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.jira.project, 'PROJ');
        assert.equal(config.jira.parentTicket, 'PROJ-1');
        assert.equal(config.repository.owner, 'my-org');
        assert.equal(config.repository.repo, 'my-repo');
        assert.equal(config.git.baseBranch, 'main', 'defaults preserved');
    });

    test('falls back to .dmtools/config.js if relative path not found', function() {
        var cl = makeLoader({
            '../.dmtools/config.js': null,
            '.dmtools/config.js':
                'module.exports = { jira: { project: "FALLBACK" } };'
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.jira.project, 'FALLBACK');
    });

    test('uses customParams.configPath when provided', function() {
        var cl = makeLoader({
            '/custom/path/config.js':
                'module.exports = { repository: { owner: "custom-org", repo: "custom-repo" } };'
        });
        var config = cl.loadProjectConfig({
            customParams: { configPath: '/custom/path/config.js' }
        });
        assert.equal(config.repository.owner, 'custom-org');
    });

    test('applies targetRepository override from customParams', function() {
        var cl = makeLoader({});
        var config = cl.loadProjectConfig({
            customParams: {
                targetRepository: {
                    owner: 'other-org',
                    repo: 'other-repo',
                    baseBranch: 'master',
                    workingDir: 'other-repo'
                }
            }
        });
        assert.equal(config.repository.owner, 'other-org');
        assert.equal(config.repository.repo, 'other-repo');
        assert.equal(config.git.baseBranch, 'master');
        assert.equal(config.workingDir, 'other-repo');
    });

    test('partial config — only overridden fields change', function() {
        var cl = makeLoader({
            '../.dmtools/config.js':
                'module.exports = { git: { baseBranch: "develop" } };'
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.git.baseBranch, 'develop');
        assert.equal(config.git.authorName, 'AI Teammate', 'other git fields preserved');
        assert.equal(config.git.branchPrefix.development, 'ai', 'branchPrefix preserved');
    });

    test('invalid JS in config file falls back to defaults', function() {
        var cl = makeLoader({
            '../.dmtools/config.js': 'this is not valid js }{{'
        });
        var config = cl.loadProjectConfig({});
        assert.equal(config.git.baseBranch, 'main', 'falls back to defaults on parse error');
    });

});

// ── resolveConfluenceUrls ─────────────────────────────────────────────────────

suite('configLoader.resolveConfluenceUrls', function() {

    var defaults = configLoaderModule.DEFAULTS;

    test('replaces a known default URL with project override', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            confluence: {
                templateStory: 'https://my-confluence/pages/999/My+Story+Template'
            }
        });
        var result = configLoaderModule.resolveConfluenceUrls(
            [defaults.confluence.templateStory, 'some other instruction'],
            config
        );
        assert.equal(result[0], 'https://my-confluence/pages/999/My+Story+Template');
        assert.equal(result[1], 'some other instruction', 'non-URL items unchanged');
    });

    test('does not replace URLs when no override provided', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var original = [defaults.confluence.templateJiraMarkdown, './local-file.md'];
        var result = configLoaderModule.resolveConfluenceUrls(original, config);
        assert.equal(result[0], defaults.confluence.templateJiraMarkdown);
        assert.equal(result[1], './local-file.md');
    });

    test('handles null array gracefully', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var result = configLoaderModule.resolveConfluenceUrls(null, config);
        assert.equal(result, null);
    });

    test('leaves unknown URLs unchanged', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var unknown = 'https://other-wiki/pages/123/SomePage';
        var result = configLoaderModule.resolveConfluenceUrls([unknown], config);
        assert.equal(result[0], unknown);
    });

});

// ── resolveInstructions ───────────────────────────────────────────────────────

suite('configLoader.resolveInstructions', function() {

    var defaults = configLoaderModule.DEFAULTS;

    test('returns defaults when no overrides configured', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {});
        var defaultInstructions = ['./agents/instructions/default.md', 'some text'];
        var result = configLoaderModule.resolveInstructions('story_development', defaultInstructions, config);
        assert.deepEqual(result.instructions, defaultInstructions);
        assert.deepEqual(result.additionalInstructions, []);
    });

    test('applies instructionOverrides — full replacement', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            instructionOverrides: {
                story_development: ['./custom/dev-instructions.md']
            }
        });
        var result = configLoaderModule.resolveInstructions(
            'story_development',
            ['./original/instructions.md'],
            config
        );
        assert.deepEqual(result.instructions, ['./custom/dev-instructions.md']);
    });

    test('applies additionalInstructions — appended separately', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            additionalInstructions: {
                bug_development: ['https://my-confluence/pages/42/Bug+Guidelines']
            }
        });
        var result = configLoaderModule.resolveInstructions(
            'bug_development',
            ['./base.md'],
            config
        );
        assert.deepEqual(result.instructions, ['./base.md']);
        assert.deepEqual(result.additionalInstructions, ['https://my-confluence/pages/42/Bug+Guidelines']);
    });

    test('instructionOverrides does not affect additionalInstructions', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            instructionOverrides: { story_development: ['./override.md'] },
            additionalInstructions: { story_development: ['./extra.md'] }
        });
        var result = configLoaderModule.resolveInstructions('story_development', ['./base.md'], config);
        assert.deepEqual(result.instructions, ['./override.md']);
        assert.deepEqual(result.additionalInstructions, ['./extra.md']);
    });

    test('agent not in overrides returns default + empty additional', function() {
        var config = configLoaderModule.mergeProjectConfig(defaults, {
            instructionOverrides: { other_agent: ['./other.md'] }
        });
        var base = ['./base.md'];
        var result = configLoaderModule.resolveInstructions('story_development', base, config);
        assert.deepEqual(result.instructions, base);
        assert.deepEqual(result.additionalInstructions, []);
    });

});

// ── configPath top-level param ────────────────────────────────────────────────

suite('configLoader.loadProjectConfig top-level configPath', function() {

    test('loads config from params.configPath (top-level, no customParams wrapper)', function() {
        var mockRead = function(opts) {
            if (opts.path === 'custom/path/my-config.js') {
                return 'module.exports = { jira: { project: "TOPLEVEL" }, repository: { owner: "top-org", repo: "top-repo" } };';
            }
            return null;
        };
        var loader = loadModule('agents/js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            { file_read: mockRead }
        );

        var config = loader.loadProjectConfig({ configPath: 'custom/path/my-config.js' });
        assert.equal(config.jira.project, 'TOPLEVEL', 'project loaded from top-level configPath');
        assert.equal(config.repository.owner, 'top-org', 'owner loaded');
        assert.equal(config._configPath, 'custom/path/my-config.js', '_configPath stored');
    });

    test('top-level configPath takes priority over customParams.configPath', function() {
        var mockRead = function(opts) {
            if (opts.path === 'top.js') {
                return 'module.exports = { jira: { project: "TOP" } };';
            }
            if (opts.path === 'custom.js') {
                return 'module.exports = { jira: { project: "CUSTOM" } };';
            }
            return null;
        };
        var loader = loadModule('agents/js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            { file_read: mockRead }
        );

        var config = loader.loadProjectConfig({
            configPath: 'top.js',
            customParams: { configPath: 'custom.js' }
        });
        assert.equal(config.jira.project, 'TOP', 'top-level configPath wins');
    });

    test('_configPath is stored for discovered paths (not just explicit)', function() {
        var mockRead = function(opts) {
            if (opts.path === '../.dmtools/config.js') {
                return 'module.exports = { jira: { project: "DISC" } };';
            }
            return null;
        };
        var loader = loadModule('agents/js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            { file_read: mockRead }
        );

        var config = loader.loadProjectConfig({});
        assert.equal(config.jira.project, 'DISC', 'discovered config loaded');
        assert.equal(config._configPath, '../.dmtools/config.js', '_configPath set for discovered path');
    });

    test('_configPath is undefined when using defaults (no config file found)', function() {
        var loader = loadModule('agents/js/configLoader.js',
            makeRequire({ './config.js': configModule }),
            { file_read: function() { return null; } }
        );

        var config = loader.loadProjectConfig({});
        assert.notOk(config._configPath, '_configPath absent when no config file');
    });

});

// ── testCaseIssueType in config ───────────────────────────────────────────────

suite('configLoader: testCaseIssueType', function() {

    test('defaults include TEST_CASE issue type', function() {
        assert.equal(configLoaderModule.DEFAULTS.jira.issueTypes.TEST_CASE, 'Test Case');
    });

    test('config.js ISSUE_TYPES includes TEST_CASE', function() {
        assert.equal(configModule.ISSUE_TYPES.TEST_CASE, 'Test Case');
    });

    test('custom testCaseIssueType survives mergeProjectConfig as full replacement', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            jira: {
                issueTypes: {
                    TEST_CASE: 'XRay Test',
                    BUG: 'Bug',
                    STORY: 'Story'
                }
            }
        });
        assert.equal(config.jira.issueTypes.TEST_CASE, 'XRay Test', 'custom TEST_CASE applied');
        assert.equal(config.jira.issueTypes.BUG, 'Bug', 'BUG preserved');
    });

    test('merged config issueTypes used in JQL interpolation pattern', function() {
        var config = configLoaderModule.mergeProjectConfig(configLoaderModule.DEFAULTS, {
            jira: {
                issueTypes: { TEST_CASE: 'XRay Test', BUG: 'Bug', STORY: 'Story', TASK: 'Task', SUBTASK: 'Subtask', EPIC: 'Epic' }
            }
        });
        var jql = 'issuetype = "' + config.jira.issueTypes.TEST_CASE + '" AND project = "PROJ"';
        assert.contains(jql, 'XRay Test', 'custom issueType used in JQL string');
    });

});
