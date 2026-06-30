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
        jira_remove_label: function() {}
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

suite('writeSolutionAndLabels — module export', function() {
    test('exports action function', function() {
        var module = makeLabelsModule({ 'outputs/response.md': 'h2. Solution' });
        assert.equal(typeof module.action, 'function', 'module.action is a function');
    });
});

suite('writeSolutionAndLabels — repo label flow', function() {
    test('adds a label for each repo in affected_repos.json', function() {
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
