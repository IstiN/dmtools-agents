/**
 * Unit tests for js/writeSolutionAndLabels.js
 *
 * Verifies that the e2e wrapper calls the base action and then adds
 * affected-repository labels from outputs/affected_repos.json.
 */

function makeOutputFiles(fileMap) {
    return loadModule('js/common/outputFiles.js', makeRequire({}), {
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        }
    });
}

function makeLabelsModule(fileMap, extraGlobals) {
    var outputFiles = makeOutputFiles(fileMap);
    var tokenUsageComment = { postTokenUsageComments: function() {} };

    // Mock the base writeSolutionAndDiagrams so we control its output
    var baseModule = {
        action: function(params) {
            return { success: true, ticketKey: params.ticket && params.ticket.key };
        }
    };

    var globals = {
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        },
        jira_add_label: function() {},
        jira_remove_label: function() {},
        jira_get_ticket: function() { return { fields: {} }; },
        jira_update_field: function() {}
    };
    for (var k in (extraGlobals || {})) { globals[k] = extraGlobals[k]; }

    return loadModule(
        'js/writeSolutionAndLabels.js',
        makeRequire({
            './writeSolutionAndDiagrams.js': baseModule,
            './common/outputFiles.js': outputFiles,
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': { triggerSmIfIdle: function() {}, triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/tokenUsageComment.js': tokenUsageComment
        }),
        globals
    );
}

suite('writeSolutionAndLabels — postJSAction compatibility', function() {
    test('module.exports is guarded with typeof for direct execution (postJSAction) compatibility', function() {
        // When dmtools runs a postJSAction it evals the file directly — no CommonJS wrapper,
        // so bare `module.exports = ...` throws ReferenceError: module is not defined.
        // This test enforces the guard pattern used by all other postJSAction scripts.
        var code = file_read({ path: 'js/writeSolutionAndLabels.js' });
        var hasGuard = code.indexOf('typeof module') !== -1 && code.indexOf('module.exports') !== -1;
        assert.equal(hasGuard, true, 'module.exports must be inside typeof module guard');
    });
});

suite('writeSolutionAndLabels — module export', function() {
    test('exports action, topologicalSort, buildJiraSection, buildMarkdownSection', function() {
        var module = makeLabelsModule({ 'outputs/response.md': 'h2. Solution' });
        assert.equal(typeof module.action, 'function', 'action exported');
        assert.equal(typeof module.topologicalSort, 'function', 'topologicalSort exported');
        assert.equal(typeof module.buildJiraSection, 'function', 'buildJiraSection exported');
        assert.equal(typeof module.buildMarkdownSection, 'function', 'buildMarkdownSection exported');
    });
});

suite('writeSolutionAndLabels — topologicalSort', function() {
    test('returns items with no deps first', function() {
        var mod = makeLabelsModule({});
        var repos = [
            { name: 'lims-ui', reason: 'UI', depends_on: ['gens-igt'] },
            { name: 'gens-igt', reason: 'API', depends_on: ['gens-igt-db'] },
            { name: 'gens-igt-db', reason: 'DB' }
        ];
        var sorted = mod.topologicalSort(repos);
        var names = sorted.map(function(r) { return r.name; });
        assert.equal(names.indexOf('gens-igt-db') < names.indexOf('gens-igt'), true, 'gens-igt-db before gens-igt');
        assert.equal(names.indexOf('gens-igt') < names.indexOf('lims-ui'), true, 'gens-igt before lims-ui');
    });

    test('handles plain strings', function() {
        var mod = makeLabelsModule({});
        var sorted = mod.topologicalSort(['repo-a', 'repo-b']);
        assert.equal(sorted.length, 2, 'two items');
        assert.equal(typeof sorted[0], 'object', 'normalised to object');
    });
});

suite('writeSolutionAndLabels — buildJiraSection', function() {
    test('produces wiki table with || headers and {code:json|title=affected_repos} anchor', function() {
        var mod = makeLabelsModule({});
        var repos = [
            { name: 'gens-igt-db', reason: 'DB migration' },
            { name: 'gens-igt', reason: 'API change', depends_on: ['gens-igt-db'] }
        ];
        var section = mod.buildJiraSection(repos);
        assert.equal(section.indexOf('|| # ||') !== -1, true, 'Jira table header');
        assert.equal(section.indexOf('{code:json|title=affected_repos}') !== -1, true, 'JSON anchor present');
        assert.equal(section.indexOf('gens-igt-db --> gens-igt') !== -1, true, 'mermaid edge present');
        assert.equal(section.indexOf('----') !== -1, true, 'section delimiters');
        assert.equal(section.indexOf('{code:mermaid}'), -1, '{code:mermaid} must NOT be used (Jira Server does not support mermaid formatter)');
        assert.equal(section.indexOf('{code}') !== -1, true, 'plain {code} block used for diagram');
    });

    test('omits mermaid block when no depends_on edges', function() {
        var mod = makeLabelsModule({});
        var section = mod.buildJiraSection([{ name: 'repo-a', reason: 'standalone' }]);
        assert.equal(section.indexOf('{code:mermaid}'), -1, 'no mermaid when no edges');
    });
});

suite('writeSolutionAndLabels — buildMarkdownSection', function() {
    test('produces markdown table with --- delimiters and json code block', function() {
        var mod = makeLabelsModule({});
        var repos = [
            { name: 'gens-igt-db', reason: 'DB migration' },
            { name: 'gens-igt', reason: 'API', depends_on: ['gens-igt-db'] }
        ];
        var section = mod.buildMarkdownSection(repos);
        assert.equal(section.indexOf('| # | Repository |') !== -1, true, 'markdown table header');
        assert.equal(section.indexOf('```json') !== -1, true, 'json code block');
        assert.equal(section.indexOf('```mermaid') !== -1, true, 'mermaid block');
    });
});


suite('writeSolutionAndLabels — repo label flow', function() {
    test('adds a label for each repo — plain string format', function() {
        var addedLabels = [];
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Solution',
                'outputs/affected_repos.json': '["gens-igt","admin-ui","gens-igt-db"]'
            },
            {
                jira_add_label: function(opts) { addedLabels.push(opts.label); }
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-10' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(addedLabels.indexOf('gens-igt') !== -1, true, 'gens-igt label added');
        assert.equal(addedLabels.indexOf('admin-ui') !== -1, true, 'admin-ui label added');
        assert.equal(addedLabels.indexOf('gens-igt-db') !== -1, true, 'gens-igt-db label added');
    });

    test('adds a label for each repo — enriched object format with name+reason+depends_on', function() {
        var addedLabels = [];
        var enriched = JSON.stringify([
            { name: 'gens-igt-db', reason: 'DB migration required.' },
            { name: 'gens-igt', reason: 'New API endpoint.', depends_on: ['gens-igt-db'] },
            { name: 'lims-ui', reason: 'UI column update.', depends_on: ['gens-igt'] }
        ]);
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Solution',
                'outputs/affected_repos.json': enriched
            },
            {
                jira_add_label: function(opts) { addedLabels.push(opts.label); }
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-14' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(addedLabels.indexOf('gens-igt-db') !== -1, true, 'gens-igt-db label added');
        assert.equal(addedLabels.indexOf('gens-igt') !== -1, true, 'gens-igt label added');
        assert.equal(addedLabels.indexOf('lims-ui') !== -1, true, 'lims-ui label added');
    });

    test('skips labels gracefully when affected_repos.json is missing', function() {
        var addedLabels = [];
        var module = makeLabelsModule(
            { 'outputs/response.md': 'h2. Solution' },
            {
                jira_add_label: function(opts) { addedLabels.push(opts.label); }
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-11' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds without affected_repos.json');
        assert.equal(addedLabels.length, 0, 'no labels added');
    });

    test('skips labels for empty array in affected_repos.json', function() {
        var addedLabels = [];
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Solution',
                'outputs/affected_repos.json': '[]'
            },
            {
                jira_add_label: function(opts) { addedLabels.push(opts.label); }
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-12' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(addedLabels.length, 0, 'no repo labels for empty array');
    });

    test('ADF description: falls back to response.md when field returns object (Jira Cloud ADF)', function() {
        var writtenValues = [];
        var adfObject = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original text' }] }] };

        var module = loadModule(
            'js/writeSolutionAndLabels.js',
            makeRequire({
                './writeSolutionAndDiagrams.js': { action: function() { return { success: true }; } },
                './common/outputFiles.js': makeOutputFiles({
                    'outputs/response.md': 'h2. Solution Design\n\nFull solution text.',
                    'outputs/affected_repos.json': JSON.stringify([
                        { name: 'gens-igt-db', reason: 'DB migration' },
                        { name: 'gens-igt', reason: 'API', depends_on: ['gens-igt-db'] }
                    ])
                }),
                './config.js': configModule,
                './configLoader.js': configLoaderModule,
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': { triggerSmIfIdle: function() {}, triggerConfiguredWorkflowForTicket: function() { return false; } },
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
            }),
            {
                file_read: function(opts) {
                    var p = opts && (opts.path || opts);
                    if (p === 'outputs/response.md') return 'h2. Solution Design\n\nFull solution text.';
                    if (p === 'outputs/affected_repos.json') return JSON.stringify([{ name: 'gens-igt-db', reason: 'DB' }, { name: 'gens-igt', reason: 'API', depends_on: ['gens-igt-db'] }]);
                    return null;
                },
                jira_get_ticket: function() { return { fields: { description: adfObject } }; },
                jira_update_field: function(opts) { writtenValues.push(opts.value); },
                jira_add_label: function() {}
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-ADF' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds with ADF field');
        assert.equal(writtenValues.length, 1, 'description updated once');
        assert.equal(writtenValues[0].indexOf('h2. Solution Design') !== -1, true, 'response.md content preserved');
        assert.equal(writtenValues[0].indexOf('h2. Affected Repositories') !== -1, true, 'repos section appended');
        assert.equal(writtenValues[0].indexOf('[object Object]'), -1, 'ADF object toString must NOT appear in output');
    });

    test('stops early if base action fails', function() {
        var addedLabels = [];
        var outputFiles = makeOutputFiles({
            'outputs/response.md': 'h2. Solution',
            'outputs/affected_repos.json': '["some-repo"]'
        });
        var failingBase = { action: function() { return { success: false, error: 'base failed' }; } };

        var module = loadModule(
            'js/writeSolutionAndLabels.js',
            makeRequire({
                './writeSolutionAndDiagrams.js': failingBase,
                './common/outputFiles.js': outputFiles,
                './config.js': configModule,
                './configLoader.js': configLoaderModule,
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': {},
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
            }),
            {
                file_read: function() { return null; },
                jira_add_label: function(opts) { addedLabels.push(opts.label); },
                jira_remove_label: function() {}
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-13' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, false, 'returns base failure');
        assert.equal(result.error, 'base failed', 'propagates error message');
        assert.equal(addedLabels.length, 0, 'no labels added when base fails');
    });
});
