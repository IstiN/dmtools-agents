/**
 * Unit tests for agents/js/smAgent.js
 *
 * Tests JQL interpolation, config loading, rule dispatch, and label skipping.
 *
 * Uses: configModule, configLoaderModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a smAgent instance with full mock injection.
 *
 * The key design: a fresh configLoader is created per test using the SAME
 * file_read mock, so config discovery paths are fully controlled by fileMap.
 *
 * file_read mock strategy:
 *   - Paths containing ".dmtools/config" → only accessible if listed in fileMap
 *     (ensures "no config" tests don't accidentally load the real project config)
 *   - All other paths → forwarded to the real file_read (for agent JSON configs etc.)
 *
 * @param {Object} opts
 *   fileMap        - { path: content } for config file discovery (config paths only)
 *   tickets        - tickets returned by jira_search_by_jql (default: [])
 *   fullTicket     - ticket returned by jira_get_ticket
 *   onTrigger      - fn(owner, repo, workflow, inputs, ref) called on triggerWorkflow
 *   onAddLabel     - fn(opts) called on jira_add_label
 *   onMoveStatus   - fn(opts) called on jira_move_to_status
 */
function makeSmAgent(opts) {
    opts = opts || {};

    var capturedTriggers = [];
    var capturedLabels = [];
    var capturedStatusMoves = [];
    var capturedJqls = [];

    // Controlled file_read: config discovery paths from fileMap only; other paths from disk.
    var fileReadMock = function(readOpts) {
        var p = readOpts.path;
        var isConfigDiscovery = p.indexOf('.dmtools/config') !== -1;

        if (opts.fileMap && opts.fileMap.hasOwnProperty(p)) {
            return opts.fileMap[p];
        }
        // Block config discovery for paths not in fileMap (so tests control exactly which config loads)
        if (isConfigDiscovery) return null;

        // Forward agent JSON / JS reads to disk
        try { return file_read(readOpts); } catch (e) { return null; }
    };

    var jiraSearchMock = function(searchOpts) {
        capturedJqls.push(searchOpts.jql);
        return opts.tickets || [];
    };

    var smMocks = {
        file_read: fileReadMock,
        jira_search_by_jql: jiraSearchMock,
        jira_get_ticket: function(key) {
            return opts.fullTicket || { key: key, fields: { labels: [], summary: 'Test ticket' } };
        },
        jira_add_label: function(labelOpts) {
            capturedLabels.push(labelOpts);
            if (opts.onAddLabel) opts.onAddLabel(labelOpts);
        },
        jira_remove_label: function() {},
        jira_move_to_status: function(moveOpts) {
            capturedStatusMoves.push(moveOpts);
            if (opts.onMoveStatus) opts.onMoveStatus(moveOpts);
        },
        cli_execute_command: function() { return ''; },
        encodeURIComponent: encodeURIComponent,
        JSON: JSON,
        eval: eval
    };

    // SCM mock: intercepts triggerWorkflow so capturedTriggers is populated
    var mockScmProvider = {
        triggerWorkflow: function(owner, repo, workflow, inputs, ref) {
            capturedTriggers.push({ owner: owner, repo: repo, workflow: workflow, inputs: inputs, ref: ref });
            if (opts.onTrigger) opts.onTrigger(owner, repo, workflow, inputs, ref);
        },
        listPrs: function() { return '[]'; },
        getPr: function() { return '{}'; },
        getPrComments: function() { return '[]'; },
        addComment: function() {},
        replyToThread: function() {},
        resolveThread: function() {},
        mergePr: function() {},
        addLabel: function() {},
        removeLabel: function() {},
        fetchDiscussions: function() { return { markdown: '', rawThreads: [] }; },
        getRemoteRepoInfo: function() { return null; }
    };
    var mockScmModule = {
        createScm: function(config) { return mockScmProvider; }
    };

    // CRITICAL: create a fresh configLoader using the SAME file_read mock.
    // If we reuse the global configLoaderModule, it calls the real file_read and
    // would load the actual .dmtools/config.js regardless of what fileMap says.
    var freshConfigLoader = loadModule(
        'agents/js/configLoader.js',
        makeRequire({ './config.js': configModule, './common/scm.js': mockScmModule }),
        { file_read: fileReadMock }
    );

    var sm = loadModule(
        'agents/js/smAgent.js',
        makeRequire({ './configLoader.js': freshConfigLoader, './common/scm.js': mockScmModule }),
        smMocks
    );

    return {
        action: sm.action,
        capturedTriggers: capturedTriggers,
        capturedLabels: capturedLabels,
        capturedStatusMoves: capturedStatusMoves,
        capturedJqls: capturedJqls
    };
}

/** Minimal sm.json-style rule */
function makeRule(jql, overrides) {
    var base = {
        description: 'test rule',
        jql: jql,
        configFile: 'agents/test.json'
    };
    if (overrides) {
        for (var k in overrides) {
            if (overrides.hasOwnProperty(k)) base[k] = overrides[k];
        }
    }
    return base;
}

/** Base jobParams with owner/repo */
function baseParams(owner, repo, rules) {
    return {
        jobParams: {
            owner: owner || 'test-org',
            repo: repo || 'test-repo',
            rules: rules || []
        }
    };
}

/** JSON string for a minimal agent config with postJSAction */
var MINIMAL_AGENT_CONFIG = JSON.stringify({
    name: 'JSRunner',
    params: {
        postJSAction: 'agents/js/unit-tests/_fixtures/noop.js',
        customParams: {}
    }
});

// ── JQL interpolation ─────────────────────────────────────────────────────────

suite('smAgent: JQL interpolation', function() {

    test('replaces {jiraProject} with project from config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "MYPROJ", parentTicket: "MYPROJ-1" }, repository: { owner: "test-org", repo: "test-repo" } };'
            }
        });

        sm.action(baseParams('test-org', 'test-repo', [
            makeRule("project = {jiraProject} AND issuetype = 'Story'")
        ]));

        assert.equal(sm.capturedJqls.length, 1, 'one JQL was executed');
        assert.contains(sm.capturedJqls[0], 'project = MYPROJ', 'project placeholder replaced');
        assert.notContains(sm.capturedJqls[0], '{jiraProject}', 'placeholder removed');
    });

    test('replaces {parentTicket} with parentTicket from config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "PROJ", parentTicket: "PROJ-99" }, repository: { owner: "o", repo: "r" } };'
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND parent = {parentTicket}")
        ]));

        assert.contains(sm.capturedJqls[0], 'parent = PROJ-99', 'parentTicket placeholder replaced');
    });

    test('leaves JQL unchanged when no config file found', function() {
        var sm = makeSmAgent({ fileMap: {} }); // no config file

        sm.action(baseParams('test-org', 'test-repo', [
            makeRule("project = HARDCODED AND issuetype = 'Bug'")
        ]));

        assert.equal(sm.capturedJqls.length, 1);
        assert.contains(sm.capturedJqls[0], 'project = HARDCODED', 'hardcoded JQL preserved');
    });

    test('multiple rules each get JQL interpolated', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "MULTI", parentTicket: "MULTI-1" }, repository: { owner: "o", repo: "r" } };'
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Backlog'"),
            makeRule("project = {jiraProject} AND status = 'In Review'"),
            makeRule("project = {jiraProject} AND parent = {parentTicket}")
        ]));

        assert.equal(sm.capturedJqls.length, 3);
        assert.contains(sm.capturedJqls[0], 'project = MULTI');
        assert.contains(sm.capturedJqls[1], 'project = MULTI');
        assert.contains(sm.capturedJqls[2], 'parent = MULTI-1');
    });

});

// ── Config overrides ──────────────────────────────────────────────────────────

suite('smAgent: config repository override', function() {

    test('uses repository from config when provided', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { repository: { owner: "config-org", repo: "config-repo" }, jira: { project: "P" } };'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action({
            jobParams: {
                owner: 'params-org',   // should be overridden
                repo: 'params-repo',   // should be overridden
                rules: [makeRule("project = {jiraProject} AND status = 'Backlog'")]
            }
        });

        assert.equal(sm.capturedTriggers.length, 1);
        assert.equal(sm.capturedTriggers[0].owner, 'config-org', 'config owner used');
        assert.equal(sm.capturedTriggers[0].repo, 'config-repo', 'config repo used');
    });

    test('uses params owner/repo when no config file', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('param-owner', 'param-repo', [
            makeRule("project = FIXED AND status = 'Ready'")
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        assert.equal(sm.capturedTriggers[0].owner, 'param-owner');
        assert.equal(sm.capturedTriggers[0].repo, 'param-repo');
    });

});

// ── smRules override ──────────────────────────────────────────────────────────

suite('smAgent: smRules override from config', function() {

    test('uses smRules from config when provided — ignores params.rules', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  jira: { project: "PROJ" },' +
                    '  smRules: [{' +
                    '    jql: "project = {jiraProject} AND status = \'Custom\'",' +
                    '    configFile: "agents/custom.json",' +
                    '    description: "custom rule from config"' +
                    '  }]' +
                    '};'
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = SHOULD_NOT_RUN AND status = 'Backlog'") // should be ignored
        ]));

        assert.equal(sm.capturedJqls.length, 1, 'only config rules ran');
        assert.contains(sm.capturedJqls[0], "status = 'Custom'", 'config rule JQL used');
        assert.notContains(sm.capturedJqls[0], 'SHOULD_NOT_RUN', 'params rule ignored');
    });

    test('uses params.rules when config smRules is null', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" }, smRules: null };'
            }
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Params Rule'")
        ]));

        assert.equal(sm.capturedJqls.length, 1);
        assert.contains(sm.capturedJqls[0], "status = 'Params Rule'", 'params rule used');
    });

});

// ── Ticket dispatch ───────────────────────────────────────────────────────────

suite('smAgent: ticket dispatch', function() {

    test('triggers workflow for each ticket found', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [
                { key: 'P-1', fields: { labels: [] } },
                { key: 'P-2', fields: { labels: [] } },
                { key: 'P-3', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject} AND status = 'Ready'")
        ]));

        assert.equal(sm.capturedTriggers.length, 3, 'one trigger per ticket');
        assert.equal(sm.capturedTriggers[0].owner, 'o');
        assert.equal(sm.capturedTriggers[0].workflow, 'ai-teammate.yml');
    });

    test('encodes ticket key in triggered workflow inputs', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: [{ key: 'P-42', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { configFile: 'agents/story_development.json' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.concurrency_key, 'P-42', 'concurrency key set to ticket key');
        assert.equal(inputs.config_file, 'agents/story_development.json', 'config_file passed');
        assert.ok(inputs.encoded_config, 'encoded_config present');

        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.contains(decoded.params.inputJql, 'P-42', 'ticket key in inputJql');
    });

    test('no triggers when no tickets found', function() {
        var sm = makeSmAgent({
            fileMap: { '../.dmtools/config.js': 'module.exports = { jira: { project: "P" }, repository: { owner: "o", repo: "r" } };' },
            tickets: []
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}")
        ]));

        assert.equal(sm.capturedTriggers.length, 0);
    });

    test('uses workflowFile from rule when provided', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule('project = X', {
                workflowFile: 'custom-workflow.yml',
                workflowRef: 'develop'
            })
        ]));

        assert.equal(sm.capturedTriggers[0].workflow, 'custom-workflow.yml');
        assert.equal(sm.capturedTriggers[0].ref, 'develop');
    });

});

// ── skipIfLabel ───────────────────────────────────────────────────────────────

suite('smAgent: skipIfLabel', function() {

    test('skips ticket that already has the label', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-1', fields: { labels: ['sm_triggered'] } },
                { key: 'T-2', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { skipIfLabel: 'sm_triggered' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1, 'only T-2 triggered');
        assert.equal(sm.capturedTriggers[0].owner, 'o');
        // Check which ticket was triggered
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.contains(inputs.encoded_config, 'T-2', 'T-2 was triggered, not T-1');
    });

    test('adds label after successful trigger', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-10', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { addLabel: 'sm_dev_triggered' })
        ]));

        assert.equal(sm.capturedLabels.length, 1);
        assert.equal(sm.capturedLabels[0].key, 'T-10');
        assert.equal(sm.capturedLabels[0].label, 'sm_dev_triggered');
    });

    test('does not add label when ticket already had skipIfLabel', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-1', fields: { labels: ['sm_triggered'] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { skipIfLabel: 'sm_triggered', addLabel: 'sm_triggered' })
        ]));

        assert.equal(sm.capturedTriggers.length, 0, 'no trigger for skipped ticket');
        assert.equal(sm.capturedLabels.length, 0, 'no label added for skipped ticket');
    });

    test('skips ticket that has any skipIfLabels entry', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-old', fields: { labels: ['sm_story_acceptance_criterias_triggered'] } },
                { key: 'T-new', fields: { labels: ['sm_story_acceptance_criteria_triggered'] } },
                { key: 'T-open', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", {
                skipIfLabels: [
                    'sm_story_acceptance_criteria_triggered',
                    'sm_story_acceptance_criterias_triggered'
                ]
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 1, 'only unlabeled ticket triggered');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.contains(inputs.encoded_config, 'T-open', 'T-open was triggered');
    });

    test('adds all configured addLabels after successful trigger', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-20', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", {
                addLabel: 'primary_label',
                addLabels: ['secondary_label']
            })
        ]));

        assert.equal(sm.capturedLabels.length, 2);
        assert.equal(sm.capturedLabels[0].label, 'primary_label');
        assert.equal(sm.capturedLabels[1].label, 'secondary_label');
    });

});

// ── Rule enabled flag ─────────────────────────────────────────────────────────

suite('smAgent: rule enabled flag', function() {

    test('skips rule with enabled: false', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { enabled: false })
        ]));

        assert.equal(sm.capturedJqls.length, 0, 'JQL not executed for disabled rule');
        assert.equal(sm.capturedTriggers.length, 0);
    });

    test('runs rule with enabled: true (explicit)', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: []
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { enabled: true })
        ]));

        assert.equal(sm.capturedJqls.length, 1, 'enabled rule executed');
    });

    test('limit caps tickets processed', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [
                { key: 'T-1', fields: { labels: [] } },
                { key: 'T-2', fields: { labels: [] } },
                { key: 'T-3', fields: { labels: [] } }
            ]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { limit: 2 })
        ]));

        assert.equal(sm.capturedTriggers.length, 2, 'only 2 tickets processed (limit: 2)');
    });

});

// ── additionalInstructions injection ─────────────────────────────────────────

suite('smAgent: additionalInstructions in encoded_config', function() {

    test('injects additionalInstructions from config into encoded_config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  additionalInstructions: {' +
                    '    story_development: ["https://my-wiki/pages/123", "./custom/rules.md"]' +
                    '  }' +
                    '};'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { configFile: 'agents/story_development.json' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.ok(decoded.params.additionalInstructions, 'additionalInstructions present in encoded_config');
        assert.equal(decoded.params.additionalInstructions.length, 2);
        assert.contains(decoded.params.additionalInstructions[0], 'my-wiki', 'first instruction');
    });

    test('no additionalInstructions field in encoded_config when not configured', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { configFile: 'agents/story_development.json' })
        ]));

        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.notOk(decoded.params.additionalInstructions, 'no additionalInstructions when not configured');
        assert.equal(decoded.params.agentParams.instructions.length, 2, 'default agent instructions preserved');
    });

    test('injects cliPrompts and agent param patches from config into encoded_config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  cliPromptOverrides: {' +
                    '    story_development: "./.dmtools/prompts/main.md"' +
                    '  },' +
                    '  cliPrompts: {' +
                    '    story_development: ["./.dmtools/prompts/role.md", "./.dmtools/prompts/focus.md"]' +
                    '  },' +
                    '  agentParamPatches: {' +
                    '    story_development: { aiRole: "Senior Engineer", customFlag: true }' +
                    '  }' +
                    '};'
            },
            tickets: [{ key: 'P-2', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", { configFile: 'agents/story_development.json' })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.equal(decoded.params.cliPrompt, './.dmtools/prompts/main.md');
        assert.deepEqual(decoded.params.cliPrompts, ['./.dmtools/prompts/role.md', './.dmtools/prompts/focus.md']);
        assert.equal(decoded.params.agentParams.aiRole, 'Senior Engineer');
        assert.equal(decoded.params.agentParams.customFlag, true);
    });

});

// ── targetStatus ──────────────────────────────────────────────────────────────

suite('smAgent: targetStatus', function() {

    test('moves ticket to targetStatus before triggering workflow', function() {
        var sm = makeSmAgent({
            fileMap: {},
            tickets: [{ key: 'T-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = X", { targetStatus: 'In Development' })
        ]));

        assert.equal(sm.capturedStatusMoves.length, 1);
        assert.equal(sm.capturedStatusMoves[0].key, 'T-1');
        assert.equal(sm.capturedStatusMoves[0].statusName, 'In Development');
        assert.equal(sm.capturedTriggers.length, 1, 'workflow also triggered');
    });

});

// ── Per-rule configPath (multi-project) ───────────────────────────────────────

suite('smAgent: per-rule configPath (multi-project)', function() {

    test('rule with configPath uses its own jiraProject for JQL', function() {
        var sm = makeSmAgent({
            fileMap: {
                'projects/web/.dmtools/config.js':
                    'module.exports = { jira: { project: "WEB", parentTicket: "WEB-1" }, repository: { owner: "web-org", repo: "web-repo" } };'
            }
        });

        sm.action(baseParams('global-org', 'global-repo', [
            makeRule("project = {jiraProject} AND status = 'Ready'", {
                configPath: 'projects/web/.dmtools/config.js'
            })
        ]));

        assert.equal(sm.capturedJqls.length, 1);
        assert.contains(sm.capturedJqls[0], 'project = WEB', 'per-rule jiraProject used');
        assert.notContains(sm.capturedJqls[0], 'global', 'global config not used in JQL');
    });

    test('rule with configPath triggers workflow against its own repo', function() {
        var sm = makeSmAgent({
            fileMap: {
                'projects/web/.dmtools/config.js':
                    'module.exports = { jira: { project: "WEB" }, repository: { owner: "web-org", repo: "web-repo" } };'
            },
            tickets: [{ key: 'WEB-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('global-org', 'global-repo', [
            makeRule("project = {jiraProject}", {
                configPath: 'projects/web/.dmtools/config.js'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        assert.equal(sm.capturedTriggers[0].owner, 'web-org', 'web-org used for trigger');
        assert.equal(sm.capturedTriggers[0].repo, 'web-repo', 'web-repo used for trigger');
    });

    test('mixed rules: some with configPath, some using global', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = { jira: { project: "GLOBAL", parentTicket: "GLOBAL-1" }, repository: { owner: "global-org", repo: "global-repo" } };',
                'projects/mobile/.dmtools/config.js':
                    'module.exports = { jira: { project: "MOBILE" }, repository: { owner: "mobile-org", repo: "mobile-repo" } };'
            }
        });

        sm.action(baseParams('global-org', 'global-repo', [
            makeRule("project = {jiraProject} AND status = 'Backlog'"),
            makeRule("project = {jiraProject} AND status = 'Ready'", {
                configPath: 'projects/mobile/.dmtools/config.js'
            })
        ]));

        assert.equal(sm.capturedJqls.length, 2);
        assert.contains(sm.capturedJqls[0], 'project = GLOBAL', 'global rule uses global config');
        assert.contains(sm.capturedJqls[1], 'project = MOBILE', 'per-rule config used for mobile');
    });

    test('per-rule configPath is propagated to encoded_config customParams', function() {
        var sm = makeSmAgent({
            fileMap: {
                'projects/web/.dmtools/config.js':
                    'module.exports = { jira: { project: "WEB" }, repository: { owner: "web-org", repo: "web-repo" } };'
            },
            tickets: [{ key: 'WEB-5', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [
            makeRule("project = {jiraProject}", {
                configPath: 'projects/web/.dmtools/config.js'
            })
        ]));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        var decoded = JSON.parse(decodeURIComponent(inputs.encoded_config));
        assert.ok(decoded.params.customParams, 'customParams present');
        assert.equal(decoded.params.customParams.configPath, 'projects/web/.dmtools/config.js',
            'configPath propagated downstream');
    });

    test('rule with configPath that fails to load falls back to global config', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js': 'module.exports = { jira: { project: "GLOBAL" }, repository: { owner: "g-org", repo: "g-repo" } };'
            }
        });

        sm.action(baseParams('g-org', 'g-repo', [
            makeRule("project = {jiraProject}", {
                configPath: 'nonexistent/path/config.js'  // doesn't exist in fileMap
            })
        ]));

        assert.equal(sm.capturedJqls.length, 1);
        assert.contains(sm.capturedJqls[0], 'project = GLOBAL', 'falls back to global when configPath fails');
    });

});

// ── agentConfigsDir — config.js owns agent paths ─────────────────────────────

suite('smAgent: agentConfigsDir (config.js owns agent paths)', function() {

    test('short configFile resolved against agentConfigsDir', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  agentConfigsDir: "projects/demo",' +
                    '  smRules: [{ jql: "project = {jiraProject}", configFile: "StoryAgent.json" }]' +
                    '};'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', [])); // rules from config (smRules override)

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.config_file, 'projects/demo/StoryAgent.json',
            'short configFile prefixed with agentConfigsDir');
    });

    test('full configFile path (contains "/") is NOT modified by agentConfigsDir', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  agentConfigsDir: "projects/demo",' +
                    '  smRules: [{ jql: "project = {jiraProject}", configFile: "agents/story_development.json" }]' +
                    '};'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', []));

        assert.equal(sm.capturedTriggers.length, 1);
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.config_file, 'agents/story_development.json',
            'full path left unchanged');
    });

    test('agentConfigsDir config discovery: sm.json can use agentConfigsDir instead of configPath', function() {
        var sm = makeSmAgent({
            fileMap: {
                'projects/alpha/.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "ALPHA" },' +
                    '  repository: { owner: "test-org", repo: "alpha-repo" },' +
                    '  agentConfigsDir: "projects/alpha",' +
                    '  smRules: [{ jql: "project = {jiraProject}", configFile: "StoryAgent.json" }]' +
                    '};'
            },
            tickets: [{ key: 'ALPHA-5', fields: { labels: [] } }]
        });

        // sm.json passes agentConfigsDir instead of configPath — no configPath needed
        sm.action({ jobParams: { agentConfigsDir: 'projects/alpha' } });

        assert.equal(sm.capturedTriggers.length, 1);
        assert.equal(sm.capturedTriggers[0].owner, 'test-org');
        assert.equal(sm.capturedTriggers[0].repo, 'alpha-repo');
        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.contains(sm.capturedJqls[0], 'project = ALPHA', 'ALPHA project from config');
        assert.equal(inputs.config_file, 'projects/alpha/StoryAgent.json',
            'short configFile resolved to full path');
    });

    test('agentConfigsDir trailing slash is stripped', function() {
        var sm = makeSmAgent({
            fileMap: {
                '../.dmtools/config.js':
                    'module.exports = {' +
                    '  jira: { project: "P" },' +
                    '  repository: { owner: "o", repo: "r" },' +
                    '  agentConfigsDir: "projects/demo/",' + // trailing slash
                    '  smRules: [{ jql: "project = {jiraProject}", configFile: "ReviewAgent.json" }]' +
                    '};'
            },
            tickets: [{ key: 'P-1', fields: { labels: [] } }]
        });

        sm.action(baseParams('o', 'r', []));

        var inputs = JSON.parse(sm.capturedTriggers[0].inputs);
        assert.equal(inputs.config_file, 'projects/demo/ReviewAgent.json',
            'no double slash from trailing agentConfigsDir slash');
    });

});
