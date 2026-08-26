/**
 * Unit tests for js/writeSolutionAndDiagrams.js module loading.
 */

suite('writeSolutionAndDiagrams — module export', function() {
    test('exports action for GraalJS require wrappers', function() {
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), {});
        var tokenUsageComment = { postTokenUsageComments: function() {} };
        var module = loadModule(
            'js/writeSolutionAndDiagrams.js',
            makeRequire({
                './config.js': configModule,
                './configLoader.js': configLoaderModule,
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': {},
                './common/outputFiles.js': outputFiles,
                './common/tokenUsageComment.js': tokenUsageComment,
                './common/contentOutput.js': loadModule('js/common/contentOutput.js', makeRequire({ '../configLoader.js': configLoaderModule }), {})
            }),
            {}
        );

        assert.equal(typeof module.action, 'function', 'module.action');
    });
});

suite('writeSolutionAndDiagrams — diagram handling for Confluence targets', function() {

    function loadModuleWithDiagramFlow(jiraUpdates, confluenceCalls, repliesFile, affectedRepos, responseMd) {
        var outputFilesMock = {
            readOutputFile: function(name) {
                if (name === 'response.md') return responseMd || '## Solution\nBody text';
                if (name === 'diagram.md') return 'graph TD\nA --> B';
                if (name === 'affected_repos.json') return affectedRepos || null;
                return null;
            }
        };
        var globals = {
            jira_update_field: function(args) { jiraUpdates.push(args); },
            jira_get_ticket: function() { return { fields: {} }; },
            jira_assign_ticket_to: function() {},
            jira_move_to_status: function() {},
            jira_add_label: function() {},
            jira_remove_label: function() {},
            jira_post_comment: function() {},
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function(args) {
                confluenceCalls.push({ op: 'create', title: args.title });
                return { id: '777', title: args.title };
            },
            confluence_sync_markdown_directory: function(args) {
                confluenceCalls.push({ op: 'sync', parentId: args.parentId });
            },
            file_write: function(path, content) {
                if (typeof path === 'string' && path.indexOf('confluence_sync_') !== -1 && path.indexOf('index.md') !== -1) {
                    confluenceCalls.push({ op: 'write', path: path, content: content });
                }
            },
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                if (path === (repliesFile || 'outputs/confluence_replies.json')) throw new Error('no replies');
                throw new Error('not found: ' + path);
            }
        };
        var module = loadModule(
            'js/writeSolutionAndDiagrams.js',
            makeRequire({
                './config.js': configModule,
                './configLoader.js': { loadProjectConfig: function() { return {}; } },
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() {}
                },
                './common/outputFiles.js': outputFilesMock,
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
                './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                    makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } } }),
                    globals),
                './writeSolutionAndLabels.js': loadModule('js/writeSolutionAndLabels.js',
                    makeRequire({
                        './writeSolutionAndDiagrams.js': { action: function() { return { success: true }; } },
                        './common/outputFiles.js': outputFilesMock,
                        './config.js': configModule
                    }),
                    globals)
            }),
            globals
        );
        return module;
    }

    var CONF_PARAMS = {
        ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
        customParams: {
            solutionField: 'description',
            diagramField: '',
            outputType: 'replace',
            contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' }
        }
    };

    test('confluence target: solution has NO jira {code} diagram block; markdown Diagram section is published', function() {
        var jiraUpdates = [];
        var confluenceCalls = [];
        var module = loadModuleWithDiagramFlow(jiraUpdates, confluenceCalls, 'outputs/confluence_replies.json',
            JSON.stringify([{ name: 'backend', reason: 'API changes' }, { name: 'ui', reason: 'screen', depends_on: ['backend'] }]));

        var result = module.action(CONF_PARAMS);

        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        // Jira field must receive only the Confluence link — never the solution body
        assert.equal(jiraUpdates.length, 1, 'one jira update (the link)');
        assert.ok(jiraUpdates[0].value.indexOf('Confluence') !== -1, 'jira field gets the page link');
        assert.ok(jiraUpdates[0].value.indexOf('{code}') === -1, 'no jira code block in jira link update');
        // The markdown published to Confluence must contain the diagram as markdown fence
        var write = null;
        confluenceCalls.forEach(function(c) { if (c.op === 'write') write = c; });
        assert.ok(write, 'sync content was written');
        assert.ok(write.content.indexOf('## Diagram') !== -1, 'markdown Diagram section present');
        assert.ok(write.content.indexOf('```mermaid') !== -1, 'mermaid fence present');
        assert.ok(write.content.indexOf('{code}') === -1, 'no jira {code} markup in confluence content');
        assert.ok(write.content.indexOf('## Solution') !== -1, 'solution body present');
    });

    test('confluence target: human-readable Affected Repositories section appended to page content', function() {
        var jiraUpdates = [];
        var confluenceCalls = [];
        var module = loadModuleWithDiagramFlow(jiraUpdates, confluenceCalls, 'outputs/confluence_replies.json',
            JSON.stringify([{ name: 'backend', reason: 'API changes' }, { name: 'ui', reason: 'screen', depends_on: ['backend'] }]));

        var result = module.action(CONF_PARAMS);

        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        var write = null;
        confluenceCalls.forEach(function(c) { if (c.op === 'write') write = c; });
        assert.ok(write, 'sync content was written');
        assert.ok(write.content.indexOf('## Affected Repositories') !== -1, 'Affected Repositories heading present');
        assert.ok(write.content.indexOf('| # | Repository | Reason | Depends On |') !== -1, 'markdown table present');
        assert.ok(write.content.indexOf('| 1 | backend | API changes |') !== -1, 'topologically sorted rows present');
        assert.ok(write.content.indexOf('```json') !== -1, 'json anchor present');
        assert.ok(write.content.indexOf('{code') === -1, 'no jira wiki table/code in confluence content');
    });

    test('confluence target rerun: publish-managed sections copied by the model are not duplicated', function() {
        var jiraUpdates = [];
        var confluenceCalls = [];
        // Model iterated over the previous page and kept the old Diagram and
        // Affected Repositories sections in its fresh response.md
        var responseWithStaleSections = '## Solution\nUpdated body text\n\n## Diagram\n\n```mermaid\ngraph TD\nOLD --> STALE\n```\n\n## Affected Repositories\n\n| # | Repository | Reason | Depends On |\n|---|---|---|---|\n| 1 | old-repo | stale | — |\n\n```json\n[{"name":"old-repo"}]\n```\n\n---\n';
        var module = loadModuleWithDiagramFlow(jiraUpdates, confluenceCalls, 'outputs/confluence_replies.json',
            JSON.stringify([{ name: 'backend', reason: 'API changes' }]),
            responseWithStaleSections);

        var result = module.action(CONF_PARAMS);

        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        var write = null;
        confluenceCalls.forEach(function(c) { if (c.op === 'write') write = c; });
        assert.ok(write, 'sync content was written');
        assert.equal(write.content.split('## Diagram').length - 1, 1, 'exactly one Diagram section');
        assert.equal(write.content.split('## Affected Repositories').length - 1, 1, 'exactly one Affected Repositories section');
        assert.ok(write.content.indexOf('OLD --> STALE') === -1, 'stale mermaid removed');
        assert.ok(write.content.indexOf('old-repo') === -1, 'stale repos table removed');
        assert.ok(write.content.indexOf('graph TD\nA --> B') !== -1, 'fresh diagram present');
        assert.ok(write.content.indexOf('| 1 | backend | API changes |') !== -1, 'fresh repos table present');
        assert.ok(write.content.indexOf('Updated body text') !== -1, 'model body kept');
    });

    test('stripManagedConfluenceSections unit checks', function() {
        var module = loadModuleWithDiagramFlow([], [], 'outputs/confluence_replies.json');
        var strip = module.stripManagedConfluenceSections;

        // sections at the end
        assert.equal(strip('text\n\n## Diagram\n\n```mermaid\nx\n```\n'), 'text');
        // section followed by another same-level section keeps the tail
        assert.equal(strip('text\n\n## Affected Repositories\n\nstuff\n\n## Risks\nkeep me'),
            'text\n\n## Risks\nkeep me');
        // both managed sections
        assert.equal(strip('body\n\n## Diagram\nd\n\n## Affected Repositories\nr\n'), 'body');
        // nothing to strip
        assert.equal(strip('plain content'), 'plain content');
        // unrelated headings survive
        assert.equal(strip('## Solution\n\n## Test Scope\nx'), '## Solution\n\n## Test Scope\nx');
    });

    test('confluence target without affected_repos.json: page publishes without the section (non-fatal)', function() {
        var jiraUpdates = [];
        var confluenceCalls = [];
        var module = loadModuleWithDiagramFlow(jiraUpdates, confluenceCalls, 'outputs/confluence_replies.json', null);

        var result = module.action(CONF_PARAMS);

        assert.equal(result.success, true);
        var write = null;
        confluenceCalls.forEach(function(c) { if (c.op === 'write') write = c; });
        assert.ok(write.content.indexOf('## Affected Repositories') === -1, 'no section when no affected_repos.json');
    });

    test('jira_field target (no contentOutput): diagram is prepended as {code} block (unchanged behavior)', function() {
        var jiraUpdates = [];
        var module = loadModuleWithDiagramFlow(jiraUpdates, [], 'outputs/confluence_replies.json');

        var result = module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            customParams: { solutionField: 'description', diagramField: '', outputType: 'replace' }
        });

        assert.equal(result.success, true);
        var solutionUpdate = null;
        jiraUpdates.forEach(function(u) {
            if (u.value && u.value.indexOf('## Solution') !== -1) solutionUpdate = u;
        });
        assert.ok(solutionUpdate, 'solution written to jira field');
        assert.ok(solutionUpdate.value.indexOf('{code}\ngraph TD') === 0, 'diagram prepended as jira {code} block');
    });
});

suite('writeSolutionAndDiagrams — required outputs', function() {
    test('fails when diagram is required but missing', function() {
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), {
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                if (path === 'outputs/response.md') return 'h2. Solution';
                throw new Error('not found: ' + path);
            }
        });
        var tokenUsageComment = { postTokenUsageComments: function() {} };
        var module = loadModule(
            'js/writeSolutionAndDiagrams.js',
            makeRequire({
                './config.js': configModule,
                './configLoader.js': configLoaderModule,
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': {},
                './common/outputFiles.js': outputFiles,
                './common/tokenUsageComment.js': tokenUsageComment,
                './common/contentOutput.js': loadModule('js/common/contentOutput.js', makeRequire({ '../configLoader.js': configLoaderModule }), {})
            }),
            {
                file_read: function(opts) {
                    var path = opts && (opts.path || opts);
                    if (path === 'outputs/response.md') return 'h2. Solution';
                    throw new Error('not found: ' + path);
                },
                jira_update_field: function() {
                    throw new Error('should not update Jira when required diagram is missing');
                }
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-1' },
            customParams: {
                solutionField: 'High-Level Solution',
                diagramField: '',
                requireDiagram: true
            }
        });

        assert.equal(result.success, false, 'action fails');
        assert.equal(result.error, 'outputs/diagram.md is required but empty', 'clear error');
    });
});
