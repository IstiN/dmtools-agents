/**
 * Unit tests for js/writeSolutionAndDiagrams.js module loading.
 */

function makeWriteSolutionModule(fileMap, extraGlobals) {
    var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), {
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            if (fileMap[path] !== undefined) return fileMap[path];
            throw new Error('not found: ' + path);
        }
    });
    var tokenUsageComment = { postTokenUsageComments: function() {} };
    var globals = {
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            if (fileMap[path] !== undefined) return fileMap[path];
            throw new Error('not found: ' + path);
        }
    };
    for (var k in (extraGlobals || {})) { globals[k] = extraGlobals[k]; }
    return loadModule(
        'js/writeSolutionAndDiagrams.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': { triggerSmIfIdle: function() {}, triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/outputFiles.js': outputFiles,
            './common/tokenUsageComment.js': tokenUsageComment
        }),
        globals
    );
}


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
                './common/tokenUsageComment.js': tokenUsageComment
            }),
            {}
        );

        assert.equal(typeof module.action, 'function', 'module.action');
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
                './common/tokenUsageComment.js': tokenUsageComment
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

suite('writeSolutionAndDiagrams — affected_repos labels', function() {
    test('adds a label for each repo in affected_repos.json', function() {
        var addedLabels = [];
        var module = makeWriteSolutionModule(
            {
                'outputs/response.md': 'h2. Solution',
                'outputs/affected_repos.json': '["gens-igt","admin-ui","gens-igt-db"]'
            },
            {
                jira_update_field: function() {},
                jira_assign_ticket_to: function() {},
                jira_move_to_status: function() {},
                jira_add_label: function(opts) { addedLabels.push(opts.label); },
                jira_remove_label: function() {}
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

    test('skips repo labels gracefully when affected_repos.json is missing', function() {
        var addedLabels = [];
        var module = makeWriteSolutionModule(
            { 'outputs/response.md': 'h2. Solution' },
            {
                jira_update_field: function() {},
                jira_assign_ticket_to: function() {},
                jira_move_to_status: function() {},
                jira_add_label: function(opts) { addedLabels.push(opts.label); },
                jira_remove_label: function() {}
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-11' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds without affected_repos.json');
        assert.equal(addedLabels.indexOf('gens-igt'), -1, 'no repo labels added');
    });

    test('skips empty array in affected_repos.json without adding labels', function() {
        var addedLabels = [];
        var module = makeWriteSolutionModule(
            {
                'outputs/response.md': 'h2. Solution',
                'outputs/affected_repos.json': '[]'
            },
            {
                jira_update_field: function() {},
                jira_assign_ticket_to: function() {},
                jira_move_to_status: function() {},
                jira_add_label: function(opts) { addedLabels.push(opts.label); },
                jira_remove_label: function() {}
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-12' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds');
        // ai_generated label still added, but no repo labels
        assert.equal(addedLabels.filter(function(l) { return l !== 'ai_generated'; }).length, 0, 'no repo labels for empty array');
    });
});
