/**
 * Unit tests for js/writeSolutionAndLabels.js
 *
 * Verifies that the e2e wrapper calls the base action and then adds
 * affected-repository labels from outputs/affected_repos.json.
 */

function makeOutputFiles(fileMap) {
    return loadModule('js/common/outputFiles.js', makeRequire({}), {
        // The suite only reads via `file_read({ path })` (see js/common/outputFiles.js::readRaw).
        file_read: function(opts) {
            return fileMap[opts.path] === undefined ? null : fileMap[opts.path];
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
        // Same { path }-only contract as makeOutputFiles above.
        file_read: function(opts) {
            return fileMap[opts.path] === undefined ? null : fileMap[opts.path];
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
            './common/tokenUsageComment.js': tokenUsageComment,
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), globals)
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
            { name: 'web-ui', reason: 'UI', depends_on: ['service-api'] },
            { name: 'service-api', reason: 'API', depends_on: ['core-db'] },
            { name: 'core-db', reason: 'DB' }
        ];
        var sorted = mod.topologicalSort(repos);
        var names = sorted.map(function(r) { return r.name; });
        assert.equal(names.indexOf('core-db') < names.indexOf('service-api'), true, 'core-db before service-api');
        assert.equal(names.indexOf('service-api') < names.indexOf('web-ui'), true, 'service-api before web-ui');
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
            { name: 'core-db', reason: 'DB migration' },
            { name: 'service-api', reason: 'API change', depends_on: ['core-db'] }
        ];
        var section = mod.buildJiraSection(repos);
        assert.equal(section.indexOf('|| # ||') !== -1, true, 'Jira table header');
        assert.equal(section.indexOf('{code:json|title=affected_repos}') !== -1, true, 'JSON anchor present');
        assert.equal(section.indexOf('core-db --> service-api') !== -1, true, 'mermaid edge present');
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
            { name: 'core-db', reason: 'DB migration' },
            { name: 'service-api', reason: 'API', depends_on: ['core-db'] }
        ];
        var section = mod.buildMarkdownSection(repos);
        assert.equal(section.indexOf('| # | Repository |') !== -1, true, 'markdown table header');
        assert.equal(section.indexOf('```json') !== -1, true, 'json code block');
        assert.equal(section.indexOf('```mermaid') !== -1, true, 'mermaid block');
    });

    // ── gh-1037 characterization: byte-identical golden outputs (CRAP refactor) ──
    var GOLDEN_REPOS = [
        { name: 'core-db', reason: 'DB migration' },
        { name: 'service-api', reason: 'API', depends_on: ['core-db'] },
        { name: 'web-ui', depends_on: ['service-api', 'core-db'] }
    ];
    var GOLDEN_MARKDOWN = [
        '---',
        '## Affected Repositories',
        '',
        '| # | Repository | Reason | Depends On |',
        '|---|---|---|---|',
        '| 1 | core-db | DB migration | \u2014 |',
        '| 2 | service-api | API | core-db |',
        '| 3 | web-ui |  | service-api, core-db |',
        '',
        '```mermaid',
        'graph LR',
        '    core-db --> service-api',
        '    service-api --> web-ui',
        '    core-db --> web-ui',
        '```',
        '',
        '```json',
        '[',
        '  {',
        '    "name": "core-db",',
        '    "reason": "DB migration"',
        '  },',
        '  {',
        '    "name": "service-api",',
        '    "reason": "API",',
        '    "depends_on": [',
        '      "core-db"',
        '    ]',
        '  },',
        '  {',
        '    "name": "web-ui",',
        '    "depends_on": [',
        '      "service-api",',
        '      "core-db"',
        '    ]',
        '  }',
        ']',
        '```',
        '---'
    ].join('\n');

    test('multi-repo output with edges is byte-identical to the pre-refactor golden (gh-1037)', function() {
        var mod = makeLabelsModule({});
        var section = mod.buildMarkdownSection(mod.topologicalSort(GOLDEN_REPOS));
        assert.equal(section, GOLDEN_MARKDOWN);
    });

    test('no-edge output omits the mermaid block entirely (gh-1037 golden)', function() {
        var mod = makeLabelsModule({});
        var section = mod.buildMarkdownSection([{ name: 'solo', reason: 'r' }]);
        assert.equal(section.indexOf('```mermaid'), -1, 'no mermaid block when no edges');
        assert.equal(section.indexOf('|---|---|---|---|') !== -1, true, 'table separator kept');
        assert.equal(section.split('\n')[0], '---', 'leading delimiter');
        assert.equal(section.split('\n').pop(), '---', 'trailing delimiter');
        assert.equal(section.indexOf('| 1 | solo | r | \u2014 |') !== -1, true, 'em-dash for missing deps');
    });

    test('empty depends_on array renders the em-dash, not an empty cell', function() {
        var mod = makeLabelsModule({});
        var section = mod.buildMarkdownSection([{ name: 'a', reason: '', depends_on: [] }]);
        assert.equal(section.indexOf('| 1 | a |  | \u2014 |') !== -1, true, 'empty deps array → em-dash');
    });

    test('extracted helpers buildRepoTableRows / buildDependencyEdges / formatRepoDeps are pure and byte-identical (gh-1037)', function() {
        var mod = makeLabelsModule({});
        assert.equal(typeof mod.buildRepoTableRows, 'function', 'buildRepoTableRows exported');
        assert.equal(typeof mod.buildDependencyEdges, 'function', 'buildDependencyEdges exported');
        assert.equal(typeof mod.formatRepoDeps, 'function', 'formatRepoDeps exported');
        var sorted = mod.topologicalSort(GOLDEN_REPOS);
        assert.deepEqual(mod.buildRepoTableRows(sorted), [
            '| 1 | core-db | DB migration | \u2014 |',
            '| 2 | service-api | API | core-db |',
            '| 3 | web-ui |  | service-api, core-db |'
        ]);
        assert.deepEqual(mod.buildDependencyEdges(sorted), [
            '    core-db --> service-api',
            '    service-api --> web-ui',
            '    core-db --> web-ui'
        ]);
        assert.equal(mod.formatRepoDeps({}), '\u2014');
        assert.equal(mod.formatRepoDeps({ depends_on: [] }), '\u2014');
        assert.equal(mod.formatRepoDeps({ depends_on: ['x', 'y'] }), 'x, y');
        assert.equal(mod.formatRepoDeps({ depends_on: 'not-an-array' }), '\u2014');
    });
});


suite('writeSolutionAndLabels — repo label flow', function() {
    test('adds a label for each repo — plain string format', function() {
        var addedLabels = [];
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Solution',
                'outputs/affected_repos.json': '["service-api","admin-portal","core-db"]'
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
        assert.equal(addedLabels.indexOf('service-api') !== -1, true, 'service-api label added');
        assert.equal(addedLabels.indexOf('admin-portal') !== -1, true, 'admin-portal label added');
        assert.equal(addedLabels.indexOf('core-db') !== -1, true, 'core-db label added');
    });

    test('adds a label for each repo — enriched object format with name+reason+depends_on', function() {
        var addedLabels = [];
        var enriched = JSON.stringify([
            { name: 'core-db', reason: 'DB migration required.' },
            { name: 'service-api', reason: 'New API endpoint.', depends_on: ['core-db'] },
            { name: 'web-ui', reason: 'UI column update.', depends_on: ['service-api'] }
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
        assert.equal(addedLabels.indexOf('core-db') !== -1, true, 'core-db label added');
        assert.equal(addedLabels.indexOf('service-api') !== -1, true, 'service-api label added');
        assert.equal(addedLabels.indexOf('web-ui') !== -1, true, 'web-ui label added');
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

    test('uses current Jira field as base (preserves diagram written by base.action)', function() {
        var writtenValues = [];
        // Simulate what base.action() writes: diagram prepended to solution
        var freshJiraValue = '{code}\ngraph LR\n    A --> B\n{code}\n\nh2. Solution Design\n\nFull solution text.';

        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Solution Design\n\nFull solution text.',
                'outputs/affected_repos.json': JSON.stringify([
                    { name: 'core-db', reason: 'DB migration' },
                    { name: 'service-api', reason: 'API', depends_on: ['core-db'] }
                ])
            },
            {
                // jira_get_ticket returns fresh value (as with dmtools >= v1.7.219 + DMTOOLS_CACHE_ENABLED=false)
                jira_get_ticket: function() { return { fields: { description: freshJiraValue } }; },
                jira_update_field: function(opts) { writtenValues.push(opts.value); }
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-CACHE' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(writtenValues.length, 1, 'description updated once');
        assert.equal(writtenValues[0].indexOf('{code}') !== -1, true, 'diagram block preserved from Jira field');
        assert.equal(writtenValues[0].indexOf('h2. Solution Design') !== -1, true, 'solution text preserved');
        assert.equal(writtenValues[0].indexOf('h2. Affected Repositories') !== -1, true, 'repos section appended');
    });

    test('falls back to response.md when Jira GET returns empty (cache miss / first run)', function() {
        var writtenValues = [];

        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Solution Design\n\nFull solution text.',
                'outputs/affected_repos.json': JSON.stringify([
                    { name: 'core-db', reason: 'DB migration' }
                ])
            },
            {
                jira_get_ticket: function() { return { fields: { description: '' } }; },
                jira_update_field: function(opts) { writtenValues.push(opts.value); }
            }
        );

        var result = module.action({
            ticket: { key: 'PROJ-FALLBACK' },
            customParams: { solutionField: 'description', diagramField: '' }
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(writtenValues.length, 1, 'description updated once');
        assert.equal(writtenValues[0].indexOf('h2. Solution Design') !== -1, true, 'response.md used as fallback base');
        assert.equal(writtenValues[0].indexOf('h2. Affected Repositories') !== -1, true, 'repos section appended');
    });

    test('topologicalSort skips deps that are not in the list and dedupes duplicate names (last wins)', function() {
        var mod = makeLabelsModule({});
        var sorted = mod.topologicalSort([
            { name: 'a', depends_on: ['ghost'] },
            { name: 'b', reason: 'first' },
            { name: 'b', reason: 'dup' }
        ]);
        assert.equal(sorted.length, 2, 'ghost dep adds no entry, duplicate name collapses');
        var bs = sorted.filter(function(r) { return r.name === 'b'; });
        assert.equal(bs.length, 1);
        assert.equal(bs[0].reason, 'dup', 'the last duplicate wins (byName overwrite)');
    });

    test('ADF field value falls back to response.md as the append base', function() {
        var writtenValues = [];
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(m) { warns.push(m); };
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Solution Design',
                'outputs/affected_repos.json': JSON.stringify([{ name: 'core-db', reason: 'DB' }])
            },
            {
                jira_get_ticket: function() { return { fields: { description: { type: 'doc', content: [] } } }; },
                jira_update_field: function(opts) { writtenValues.push(opts.value); }
            }
        );
        try {
            var result = module.action({
                ticket: { key: 'PROJ-ADF' },
                customParams: { solutionField: 'description', diagramField: '' }
            });
            assert.equal(result.success, true);
            assert.equal(writtenValues.length, 1);
            assert.equal(writtenValues[0].indexOf('h2. Solution Design') === 0, true, 'response.md is the base');
            assert.equal(warns.some(function(m) { return String(m).indexOf('is ADF') !== -1; }), true);
        } finally {
            console.warn = origWarn;
        }
    });

    test('a failing getIssue falls back to response.md and still appends', function() {
        var writtenValues = [];
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Base',
                'outputs/affected_repos.json': JSON.stringify([{ name: 'svc', reason: 'API' }])
            },
            {
                jira_get_ticket: function() { throw new Error('jira down'); },
                jira_update_field: function(opts) { writtenValues.push(opts.value); }
            }
        );
        var result = module.action({
            ticket: { key: 'PROJ-GETFAIL' },
            customParams: { solutionField: 'description', diagramField: '' }
        });
        assert.equal(result.success, true);
        assert.equal(writtenValues.length, 1);
        assert.contains(writtenValues[0], 'h2. Base');
        assert.contains(writtenValues[0], 'h2. Affected Repositories');
    });

    test('a failing addLabel is non-fatal: later labels are still added', function() {
        var added = [];
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. S',
                'outputs/affected_repos.json': JSON.stringify([{ name: 'bad one' }, { name: 'good' }])
            },
            {
                jira_add_label: function(opts) {
                    added.push(opts.label);
                    if (opts.label === 'bad one') { throw new Error('label api down'); }
                }
            }
        );
        var result = module.action({
            ticket: { key: 'PROJ-LABELFAIL' },
            customParams: { solutionField: 'description', diagramField: '' }
        });
        assert.equal(result.success, true, 'label failure must not fail the action');
        assert.deepEqual(added, ['bad one', 'good'], 'label loop continues after a failure');
    });

    test('invalid affected_repos.json is non-fatal and skips the section', function() {
        var writtenValues = [];
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. S',
                'outputs/affected_repos.json': '{not json'
            },
            {
                jira_update_field: function(opts) { writtenValues.push(opts.value); }
            }
        );
        var result = module.action({
            ticket: { key: 'PROJ-BADJSON' },
            customParams: { solutionField: 'description', diagramField: '' }
        });
        assert.equal(result.success, true);
        assert.equal(writtenValues.length, 0, 'no field write when repos json is invalid');
    });

    test('non-array affected_repos.json is skipped gracefully', function() {
        var writtenValues = [];
        var module = makeLabelsModule(
            {
                'outputs/response.md': 'h2. S',
                'outputs/affected_repos.json': '{"name":"not-an-array"}'
            },
            {
                jira_update_field: function(opts) { writtenValues.push(opts.value); }
            }
        );
        var result = module.action({
            ticket: { key: 'PROJ-NOTARRAY' },
            customParams: { solutionField: 'description', diagramField: '' }
        });
        assert.equal(result.success, true);
        assert.equal(writtenValues.length, 0, 'no field write for non-array repos');
    });

    test('stops early if base action fails', function() {
        var addedLabels = [];
        var outputFiles = makeOutputFiles({
            'outputs/response.md': 'h2. Solution',
            'outputs/affected_repos.json': '["some-repo"]'
        });
        var failingBase = { action: function() { return { success: false, error: 'base failed' }; } };

        var trackerMocks = {
            file_read: function() { return null; },
            jira_add_label: function(opts) { addedLabels.push(opts.label); },
            jira_remove_label: function() {}
        };
        var module = loadModule(
            'js/writeSolutionAndLabels.js',
            makeRequire({
                './writeSolutionAndDiagrams.js': failingBase,
                './common/outputFiles.js': outputFiles,
                './config.js': configModule,
                './configLoader.js': configLoaderModule,
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': {},
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
                './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), trackerMocks)
            }),
            trackerMocks
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

// ── gh-1187 CRAP split: characterization tests for the extracted helpers ────

suite('writeSolutionAndLabels — gh-1187 extracted helpers', function() {

    test('readSortedRepos: null for a missing file, an empty array, or a non-array payload', function() {
        var mod = makeLabelsModule({});
        assert.equal(mod.readSortedRepos(), null, 'missing file → null');

        var modEmpty = makeLabelsModule({ 'outputs/affected_repos.json': '[]' });
        assert.equal(modEmpty.readSortedRepos(), null, 'empty array → null');

        var modNotArray = makeLabelsModule({ 'outputs/affected_repos.json': '{"name":"x"}' });
        assert.equal(modNotArray.readSortedRepos(), null, 'non-array → null');
    });

    test('readSortedRepos: topologically sorts a valid payload', function() {
        var mod = makeLabelsModule({
            'outputs/affected_repos.json': JSON.stringify([
                { name: 'web-ui', depends_on: ['service-api'] },
                { name: 'service-api' }
            ])
        });
        var sorted = mod.readSortedRepos();
        assert.deepEqual(sorted.map(function(r) { return r.name; }), ['service-api', 'web-ui']);
    });

    test('readSortedRepos: invalid JSON propagates to the caller (non-fatal outer catch)', function() {
        var mod = makeLabelsModule({ 'outputs/affected_repos.json': '{not json' });
        var threw = false;
        try {
            mod.readSortedRepos();
        } catch (e) {
            threw = true;
        }
        assert.equal(threw, true, 'JSON parse error propagates');
    });

    test('currentFieldValue: trims a plain wiki-markup value', function() {
        var mod = makeLabelsModule({}, {
            jira_get_ticket: function() { return { fields: { description: '  body text  ' } }; }
        });
        assert.equal(mod.currentFieldValue(
            { getIssue: function(key, fields) { return { fields: { description: '  body text  ' } }; } },
            'PROJ-1', 'description'), 'body text');
    });

    test('currentFieldValue: ADF object yields an empty base with a warning', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(m) { warns.push(m); };
        try {
            var mod = makeLabelsModule({});
            var value = mod.currentFieldValue(
                { getIssue: function() { return { fields: { description: { type: 'doc' } } }; } },
                'PROJ-1', 'description');
            assert.equal(value, '');
            assert.equal(warns.some(function(m) { return String(m).indexOf('is ADF') !== -1; }), true);
        } finally {
            console.warn = origWarn;
        }
    });

    test('currentFieldValue: ticket without a fields wrapper and null values yield an empty base', function() {
        var mod = makeLabelsModule({});
        assert.equal(mod.currentFieldValue(
            { getIssue: function() { return { description: 'raw on ticket' }; } },
            'PROJ-1', 'description'), 'raw on ticket');
        assert.equal(mod.currentFieldValue(
            { getIssue: function() { return { fields: {} }; } },
            'PROJ-1', 'description'), '');
        assert.equal(mod.currentFieldValue(
            { getIssue: function() { return null; } },
            'PROJ-1', 'description'), '');
    });

    test('resolveAppendBase: current field wins; getIssue and empty-field fall back to response.md', function() {
        var mod = makeLabelsModule({ 'outputs/response.md': 'md base' }, {
            jira_get_ticket: function() { return { fields: { description: 'field base' } }; }
        });
        var tracker = { getIssue: function() { return { fields: { description: 'field base' } }; } };
        var logs = [];
        var origLog = console.log;
        console.log = function(m) { logs.push(m); };
        try {
            assert.equal(mod.resolveAppendBase(tracker, 'PROJ-1', 'description'), 'field base');
            assert.equal(logs.some(function(m) { return String(m).indexOf('Using current Jira field as base') !== -1; }), true);
        } finally {
            console.log = origLog;
        }

        var failing = { getIssue: function() { throw new Error('jira down'); } };
        assert.equal(mod.resolveAppendBase(failing, 'PROJ-2', 'description'), 'md base', 'getIssue failure → response.md');

        var empty = { getIssue: function() { return { fields: { description: '' } }; } };
        assert.equal(mod.resolveAppendBase(empty, 'PROJ-3', 'description'), 'md base', 'empty field → response.md');
    });

    test('resolveAppendBase: missing response.md yields an empty base (0 chars log)', function() {
        var mod = makeLabelsModule({});
        var empty = { getIssue: function() { return { fields: { description: '' } }; } };
        assert.equal(mod.resolveAppendBase(empty, 'PROJ-4', 'description'), '');
    });

    test('addRepoLabelsQuietly: trims names, skips blank ones, keeps going past failures', function() {
        var added = [];
        var tracker = {
            addLabel: function(key, label) {
                added.push(label);
                if (label === 'boom') { throw new Error('label api down'); }
            }
        };
        var mod = makeLabelsModule({});
        mod.addRepoLabelsQuietly(tracker, 'PROJ-5', [
            { name: '  spaced  ' },
            { name: '   ' },
            { name: 'boom' },
            { name: 'after-boom' }
        ]);
        assert.deepEqual(added, ['spaced', 'boom', 'after-boom'], 'blank skipped, failures non-fatal');
    });

    test('ado tracker type renders the markdown section into the field (no jira {code} anchor)', function() {
        var written = [];
        var mod = makeLabelsModule(
            {
                'outputs/response.md': 'h2. Solution',
                'outputs/affected_repos.json': JSON.stringify([{ name: 'core-db', reason: 'DB' }])
            },
            {
                ado_update_description: function(opts) { written.push(opts.description); },
                ado_get_work_item: function() { return { fields: {} }; }
            }
        );

        var result = mod.action({
            ticket: { key: 'PROJ-ADO' },
            customParams: { solutionField: 'description', trackerProvider: 'ado' }
        });

        assert.equal(result.success, true);
        assert.equal(written.length, 1);
        assert.contains(written[0], '## Affected Repositories');
        assert.contains(written[0], '```json');
        assert.equal(written[0].indexOf('{code:json'), -1, 'ADO must not get jira wiki markup');
    });

});

