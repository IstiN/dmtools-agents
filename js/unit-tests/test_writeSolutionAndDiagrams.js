/**
 * Unit tests for js/writeSolutionAndDiagrams.js module loading.
 */

// gh-1250 shared helpers: pure modules with no requires of their own, so the
// real implementation is loaded everywhere (no mocks needed). Both
// writeSolutionAndDiagrams.js (trackerFieldValue) and the lazily-required
// writeSolutionAndLabels.js (trackerFieldValue + affectedReposSection) use them.
function wd3TrackerFieldValue() {
    return loadModule('js/common/trackerFieldValue.js', makeRequire({}), {});
}
function wd3AffectedReposSection() {
    return loadModule('js/common/affectedReposSection.js', makeRequire({}), {});
}

// Shared full-fidelity loader for the gh-978 characterization suites: wires the
// module against jira globals with per-test failure switches, and exposes the
// call log so tests can assert side-effect order and partial-failure behaviour.

// Per-test failure switch: returns a stub that throws when opts[key] is set.
function wd3Guard(opts, key) {
    return function() {
        if (opts[key]) { throw new Error(key + ' boom'); }
    };
}

// jira_* global stubs. jiraUpdates records every field write; calls collects the
// side-effect log assertions read.
function wd3JiraGlobals(opts, jiraUpdates, calls) {
    return {
        jira_update_field: function(args) {
            if (opts.failUpdateField === args.field) {
                throw new Error('updateField boom: ' + args.field);
            }
            jiraUpdates.push(args);
        },
        jira_get_ticket: function() {
            if (opts.existingFieldThrows) {
                throw new Error('getIssue boom');
            }
            var fields = { summary: 'Some story' };
            if (opts.existingFieldValue !== undefined) {
                fields[opts.solutionField || 'description'] = opts.existingFieldValue;
            }
            return { key: 'PROJ-1', fields: fields };
        },
        jira_assign_ticket_to: wd3Guard(opts, 'failAssign'),
        jira_move_to_status: wd3Guard(opts, 'failMove'),
        jira_add_label: wd3Guard(opts, 'failAddLabel'),
        jira_remove_label: function() {
            if (opts.failRemoveLabel) { throw new Error('removeLabel boom'); }
            calls.removedLabels = (calls.removedLabels || 0) + 1;
        },
        jira_post_comment: function(args) {
            if (opts.failPostComment) { throw new Error('postComment boom'); }
            calls.postComments.push(args);
        }
    };
}

// confluence_* / file_* global stubs for the publish path.
function wd3ConfluenceGlobals(opts) {
    return {
        confluence_get_children_by_id: function() { return []; },
        confluence_create_page: function(args) {
            if (opts.failConfluenceCreate) { throw new Error('confluence boom'); }
            return { id: '777', title: args.title };
        },
        confluence_sync_markdown_directory: function() {},
        file_write: function() {},
        file_read: function(o) {
            throw new Error('not found: ' + (o && (o.path || o)));
        }
    };
}

function wd3LoadFull(opts) {
    opts = opts || {};
    var jiraUpdates = [];
    var calls = {
        autoStartConfigured: [],
        smIdle: 0,
        tokenUsage: 0,
        postComments: []
    };
    var globals = wd3JiraGlobals(opts, jiraUpdates, calls);
    var confGlobals = wd3ConfluenceGlobals(opts);
    for (var key in confGlobals) {
        if (Object.prototype.hasOwnProperty.call(confGlobals, key)) {
            globals[key] = confGlobals[key];
        }
    }
    var autoStartMock = {
        triggerConfiguredWorkflowForTicket: function(a) {
            calls.autoStartConfigured.push(a);
            if (opts.autoStartThrows) { throw new Error('autoStart boom'); }
            return opts.autoStartResult === undefined ? false : opts.autoStartResult;
        },
        triggerSmIfIdle: function() { calls.smIdle++; }
    };
    var tokenUsageMock = {
        postTokenUsageComments: function() {
            calls.tokenUsage++;
            if (opts.tokenUsageThrows) { throw new Error('tokenUsage boom'); }
        }
    };
    var outputs = {
        'response.md': 'Solution body',
        'diagram.md': 'graph TD\nA --> B'
    };
    var outputFilesMock = {
        readOutputFile: function(name) {
            return outputs[name] === undefined ? null : outputs[name];
        }
    };
    var configLoaderMock = {
        loadProjectConfig: function() {
            return { jira: { statuses: { READY_FOR_DEVELOPMENT: 'Ready' } } };
        }
    };
    var module = loadModule(
        'js/writeSolutionAndDiagrams.js',
        makeRequire({
            './common/trackers.js': wd3Trackers(globals),
            './config.js': configModule,
            './common/trackerFieldValue.js': wd3TrackerFieldValue(),
            './configLoader.js': configLoaderMock,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': autoStartMock,
            './common/outputFiles.js': outputFilesMock,
            './common/tokenUsageComment.js': tokenUsageMock,
            './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                makeRequire({
                    '../configLoader.js': configLoaderMock,
                    './trackers.js': trackersMock()
                }),
                globals)
        }),
        globals
    );
    return { module: module, jiraUpdates: jiraUpdates, calls: calls };
}

function wd3Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

suite('writeSolutionAndDiagrams — module export', function() {
    test('exports action for GraalJS require wrappers', function() {
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), {});
        var tokenUsageComment = { postTokenUsageComments: function() {} };
        var module = loadModule(
            'js/writeSolutionAndDiagrams.js',
            makeRequire({
                './common/trackers.js': wd3Trackers({}),
                './config.js': configModule,
                './common/trackerFieldValue.js': wd3TrackerFieldValue(),
                './configLoader.js': configLoaderModule,
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': {},
                './common/outputFiles.js': outputFiles,
                './common/tokenUsageComment.js': tokenUsageComment,
                './common/contentOutput.js': loadModule('js/common/contentOutput.js', makeRequire({ '../configLoader.js': configLoaderModule, './trackers.js': trackersMock() }), {})
            }),
            {}
        );

        assert.equal(typeof module.action, 'function', 'module.action');
    });
});

// ── gh-1230 CRAP: diagram-flow fixture factories (characterized at EOF) ──────

// outputFiles.readOutputFile mock for the diagram-flow suites: fixed fixtures
// with per-file defaults.
function wd3OutputFilesMock(responseMd, diagramMd, affectedRepos) {
    function readOutputFile(name) {
        if (name === 'response.md') return responseMd || '## Solution\nBody text';
        if (name === 'diagram.md') return diagramMd || 'graph TD\nA --> B';
        if (name === 'affected_repos.json') return affectedRepos || null;
        return null;
    }
    return { readOutputFile: readOutputFile };
}

// Recorder globals for the diagram-flow suites: jira field updates and
// confluence create/sync calls land in the given arrays; file_write only
// records confluence sync index payloads; file_read always throws.
function wd3DiagramGlobals(jiraUpdates, confluenceCalls, repliesFile) {
    function file_write(path, content) {
        if (typeof path === 'string' && path.indexOf('confluence_sync_') !== -1 && path.indexOf('index.md') !== -1) {
            confluenceCalls.push({ op: 'write', path: path, content: content });
        }
    }
    function file_read(opts) {
        var path = opts && (opts.path || opts);
        if (path === (repliesFile || 'outputs/confluence_replies.json')) throw new Error('no replies');
        throw new Error('not found: ' + path);
    }
    return {
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
        file_write: file_write,
        file_read: file_read
    };
}

suite('writeSolutionAndDiagrams — diagram handling for Confluence targets', function() {

    function loadModuleWithDiagramFlow(jiraUpdates, confluenceCalls, repliesFile, affectedRepos, responseMd, diagramMd) {
        var outputFilesMock = wd3OutputFilesMock(responseMd, diagramMd, affectedRepos);
        var globals = wd3DiagramGlobals(jiraUpdates, confluenceCalls, repliesFile);
        var module = loadModule(
            'js/writeSolutionAndDiagrams.js',
            makeRequire({
                './common/trackers.js': wd3Trackers(globals),
                './config.js': configModule,
                './common/trackerFieldValue.js': wd3TrackerFieldValue(),
                './configLoader.js': { loadProjectConfig: function() { return {}; } },
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function() { return false; },
                    triggerSmIfIdle: function() {}
                },
                './common/outputFiles.js': outputFilesMock,
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
                './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                    makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } }, './trackers.js': trackersMock() }),
                    globals),
                './writeSolutionAndLabels.js': loadModule('js/writeSolutionAndLabels.js',
                    makeRequire({
                        './writeSolutionAndDiagrams.js': { action: function() { return { success: true }; } },
                        './common/outputFiles.js': outputFilesMock,
                        './config.js': configModule,
                        './common/trackerFieldValue.js': wd3TrackerFieldValue(),
                        './common/affectedReposSection.js': wd3AffectedReposSection(),
                        './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), globals)
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

    test('confluence target: model-supplied ```mermaid fence in diagram.md is stripped, not double-wrapped', function() {
        var jiraUpdates = [];
        var confluenceCalls = [];
        var module = loadModuleWithDiagramFlow(jiraUpdates, confluenceCalls, 'outputs/confluence_replies.json',
            null, null, '```mermaid\ngraph TD\nA --> B\n```');

        var result = module.action(CONF_PARAMS);

        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        var write = null;
        confluenceCalls.forEach(function(c) { if (c.op === 'write') write = c; });
        assert.ok(write, 'sync content was written');
        assert.equal((write.content.match(/```mermaid/g) || []).length, 1, 'exactly one opening mermaid fence — not double-wrapped');
        assert.ok(write.content.indexOf('```mermaid\ngraph TD\nA --> B\n```') !== -1, 'clean single-fenced diagram content');
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
        // The Confluence formatter is dedicated (buildConfluenceMarkdownSection) and
        // intentionally omits the ```json anchor block — that anchor is only meaningful
        // on the tracker field for createRepoTasks to parse, not on a Confluence page,
        // and mixing it in here previously produced a garbled trailing code macro.
        assert.ok(write.content.indexOf('```json') === -1, 'no json anchor on confluence page');
        assert.ok(write.content.indexOf('```mermaid\ngraph LR') !== -1, 'dependency mermaid diagram present');
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
                './common/trackers.js': wd3Trackers({ file_read: function(opts) { var path = opts && (opts.path || opts); if (path === 'outputs/response.md') return 'h2. Solution'; throw new Error('not found: ' + path); } }),
                './config.js': configModule,
                './common/trackerFieldValue.js': wd3TrackerFieldValue(),
                './configLoader.js': configLoaderModule,
                './common/scm.js': { createScm: function() { return {}; } },
                './common/autoStart.js': {},
                './common/outputFiles.js': outputFiles,
                './common/tokenUsageComment.js': tokenUsageComment,
                './common/contentOutput.js': loadModule('js/common/contentOutput.js', makeRequire({ '../configLoader.js': configLoaderModule, './trackers.js': trackersMock() }), {})
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

suite('writeSolutionAndDiagrams — ado tracker (wave2d3)', function() {
    test('ado provider: field/assign/state/label go through ado_* tools, no jira_*', function() {
        var calls = [];
        var rec = function(n) { return function(a) { calls.push({ tool: n, args: a }); }; };
        var jiraGuard = function(n) { return function() { throw new Error(n + ' must not be called'); }; };
        var globals = {
            ado_update_description: rec('ado_update_description'),
            ado_assign_work_item: rec('ado_assign_work_item'),
            ado_move_to_state: rec('ado_move_to_state'),
            ado_add_work_item_label: rec('ado_add_work_item_label'),
            ado_remove_work_item_label: rec('ado_remove_work_item_label'),
            ado_add_work_item_comment: rec('ado_add_work_item_comment'),
            jira_update_field: jiraGuard('jira_update_field'),
            jira_get_ticket: jiraGuard('jira_get_ticket'),
            jira_assign_ticket_to: jiraGuard('jira_assign_ticket_to'),
            jira_move_to_status: jiraGuard('jira_move_to_status'),
            jira_add_label: jiraGuard('jira_add_label'),
            jira_remove_label: jiraGuard('jira_remove_label'),
            jira_post_comment: jiraGuard('jira_post_comment')
        };
        var outputFilesMock = { readOutputFile: function(n) { return n === 'response.md' ? 'Solution body' : null; } };
        var module = loadModule('js/writeSolutionAndDiagrams.js', makeRequire({
            './common/trackers.js': wd3Trackers(globals),
            './config.js': configModule,
            './common/trackerFieldValue.js': wd3TrackerFieldValue(),
            './configLoader.js': { loadProjectConfig: function() { return { jira: { statuses: { READY_FOR_DEVELOPMENT: 'Ready' } } }; } },
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; }, triggerSmIfIdle: function() {} },
            './common/outputFiles.js': outputFilesMock,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } }, './trackers.js': wd3Trackers(globals) }), globals)
        }), globals);
        var result = module.action({
            ticket: { key: '55', fields: { summary: 's' } },
            initiator: 'user@x',
            customParams: { trackerProvider: 'ado', solutionField: 'description', diagramField: '' }
        });
        assert.equal(result.success, true);
        var tools = calls.map(function(c) { return c.tool; });
        assert.ok(tools.indexOf('ado_update_description') !== -1, 'ado_update_description called');
        assert.ok(tools.indexOf('ado_assign_work_item') !== -1, 'ado_assign_work_item called');
        assert.ok(tools.indexOf('ado_move_to_state') !== -1, 'ado_move_to_state called');
        calls.forEach(function(c) { assert.equal(String(c.args.id), '55'); });
    });
});

suite('writeSolutionAndDiagrams — pure builders (gh-978 refactor)', function() {

    function loadPure() {
        return wd3LoadFull({}).module;
    }

    test('resolveOutputOptions: defaults when customParams are absent', function() {
        var m = loadPure();
        var options = m.resolveOutputOptions({});
        assert.equal(options.solutionField, configModule.JIRA_FIELDS.SOLUTION, 'default solution field');
        assert.equal(options.diagramField, configModule.JIRA_FIELDS.DIAGRAMS, 'default diagram field');
        assert.equal(options.outputType, 'replace', 'default output type');
        assert.equal(options.requireDiagram, false, 'diagram not required by default');
    });

    test('resolveOutputOptions: explicit overrides win, empty diagramField is preserved, string requireDiagram works', function() {
        var m = loadPure();
        var options = m.resolveOutputOptions({
            solutionField: 'description',
            diagramField: '',
            outputType: 'append',
            requireDiagram: 'true'
        });
        assert.equal(options.solutionField, 'description');
        assert.equal(options.diagramField, '', 'empty diagramField stays empty (means prepend/publish)');
        assert.equal(options.outputType, 'append');
        assert.equal(options.requireDiagram, true, "'true' string is accepted");
    });

    test('decideDiagramPlacement: jira target prepends, confluence-only defers, dedicated field keeps both', function() {
        var m = loadPure();
        var jira = m.decideDiagramPlacement('graph TD\nA', '', false);
        assert.equal(jira.prependToSolution, true, 'jira target prepends as {code}');
        assert.equal(jira.deferToConfluence, false);

        var conf = m.decideDiagramPlacement('graph TD\nA', '', true);
        assert.equal(conf.prependToSolution, false, 'confluence-only target must not get a jira {code} block');
        assert.equal(conf.deferToConfluence, true, 'confluence-only target defers to the publish step');

        var dedicated = m.decideDiagramPlacement('graph TD\nA', 'Diagrams', false);
        assert.equal(dedicated.prependToSolution, false);
        assert.equal(dedicated.deferToConfluence, false, 'dedicated diagram field needs no special handling');

        var noDiagram = m.decideDiagramPlacement('', '', false);
        assert.equal(noDiagram.prependToSolution, false);
        assert.equal(noDiagram.deferToConfluence, false);
    });

    test('buildAppendValue: separator only when existing content is present', function() {
        var m = loadPure();
        assert.equal(m.buildAppendValue('Existing', 'Fresh'), 'Existing\n\n----\n\nFresh', 'separator between old and new');
        assert.equal(m.buildAppendValue('', 'Fresh'), 'Fresh', 'no separator without existing content');
    });

    test('buildConfluencePageContent: strips managed sections then appends a single Diagram section', function() {
        var m = loadPure();
        var solution = '## Solution\nBody\n\n## Diagram\n\n```mermaid\nOLD --> STALE\n```\n\n---\n';
        var content = m.buildConfluencePageContent(solution, 'graph TD\nA --> B');
        assert.equal(content.split('## Diagram').length - 1, 1, 'exactly one Diagram section');
        assert.ok(content.indexOf('OLD --> STALE') === -1, 'stale diagram stripped');
        assert.ok(content.indexOf('```mermaid\ngraph TD\nA --> B\n```') !== -1, 'fresh single-fenced diagram appended');

        var noDiagram = m.buildConfluencePageContent('Plain body', '');
        assert.equal(noDiagram, 'Plain body', 'no diagram section when diagram is empty');
    });

    test('buildConfluenceLinkText: url vs page-id fallback', function() {
        var m = loadPure();
        assert.equal(m.buildConfluenceLinkText('http://x/123', { page: { id: '123' } }),
            'Solution published to Confluence: http://x/123', 'url form when available');
        assert.equal(m.buildConfluenceLinkText('', { page: { id: '123' } }),
            'Solution published to Confluence page 123', 'page-id form without url');
    });

    test('buildConfluenceCommentText: url vs page-id fallback', function() {
        var m = loadPure();
        assert.equal(m.buildConfluenceCommentText('http://x/123', { page: { id: '123' } }),
            'h3. 📐 Solution published to Confluence\n\nPage: http://x/123', 'url form when available');
        assert.equal(m.buildConfluenceCommentText(null, { page: { id: '123' } }),
            'h3. 📐 Solution published to Confluence\n\nPage id: 123', 'page-id form without url');
    });

    test('stripMermaidFence unit checks', function() {
        var m = loadPure();
        assert.equal(m.stripMermaidFence('```mermaid\ngraph TD\nA\n```'), 'graph TD\nA', 'wrapped fence stripped');
        assert.equal(m.stripMermaidFence('```\ngraph TD\nA\n```'), 'graph TD\nA', 'bare fence stripped');
        assert.equal(m.stripMermaidFence('graph TD\n```\nA --> B'), 'graph TD\nA --> B', 'stray fence lines removed');
        assert.equal(m.stripMermaidFence('graph TD\nA --> B'), 'graph TD\nA --> B', 'clean diagram untouched');
        assert.equal(m.stripMermaidFence(''), '', 'empty stays empty');
    });

    test('appendAffectedRepositoriesSection: null/empty repos leave content unchanged, valid repos append sorted section', function() {
        var m = loadPure();
        var shared = {
            topologicalSort: function(repos) { return repos.slice().reverse(); },
            buildConfluenceMarkdownSection: function(sorted) {
                return '## Affected Repositories\n\n' + sorted.map(function(r) { return r.name; }).join(',');
            }
        };
        assert.equal(m.appendAffectedRepositoriesSection('body', null, shared), 'body', 'null reposJson untouched');
        assert.equal(m.appendAffectedRepositoriesSection('body', '[]', shared), 'body', 'empty array untouched');
        var repos = JSON.stringify([{ name: 'a' }, { name: 'b' }]);
        var out = m.appendAffectedRepositoriesSection('body', repos, shared);
        assert.ok(out.indexOf('## Affected Repositories') !== -1, 'section appended');
        assert.ok(out.indexOf('b,a') !== -1, 'repos sorted through shared.topologicalSort');
        assert.ok(out.indexOf('body') === 0, 'original content kept as prefix');
    });
});

suite('writeSolutionAndDiagrams — append outputType (gh-978 characterization)', function() {

    function runAppend(opts, customParams) {
        var env = wd3LoadFull(opts);
        var params = {
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            initiator: 'user@x',
            customParams: customParams
        };
        var result = env.module.action(params);
        return { result: result, jiraUpdates: env.jiraUpdates };
    }

    var APPEND_PARAMS = {
        solutionField: 'description',
        diagramField: '',
        outputType: 'append'
    };

    test('append: existing plain-text value is merged after the ---- separator', function() {
        var env = wd3LoadFull({ solutionField: 'description', existingFieldValue: 'Existing solution text' });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            customParams: APPEND_PARAMS
        });
        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        assert.equal(env.jiraUpdates.length, 1, 'single solution field update');
        assert.ok(env.jiraUpdates[0].value.indexOf('Existing solution text\n\n----\n\n') === 0,
            'existing content kept as prefix before separator');
        assert.ok(env.jiraUpdates[0].value.indexOf('Solution body') !== -1, 'fresh solution appended');
        // no diagram field and no confluence target → diagram prepended as {code} into the solution
        assert.ok(env.jiraUpdates[0].value.indexOf('{code}\ngraph TD\nA --> B\n{code}') !== -1,
            'diagram prepended as jira {code} block');
    });

    test('append: ADF object in the field falls back to replace mode (no merge)', function() {
        var env = wd3LoadFull({
            solutionField: 'description',
            existingFieldValue: { type: 'doc', content: [] }
        });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            customParams: APPEND_PARAMS
        });
        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        assert.ok(env.jiraUpdates[0].value.indexOf('Existing') === -1, 'ADF content not merged');
        assert.ok(env.jiraUpdates[0].value.indexOf('{code}') === 0, 'plain replace with diagram prepend');
    });

    test('append: unreadable existing field appends without prefix', function() {
        var env = wd3LoadFull({ solutionField: 'description', existingFieldThrows: true });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            customParams: APPEND_PARAMS
        });
        assert.equal(result.success, true, 'action succeeds despite unreadable field: ' + JSON.stringify(result));
        assert.ok(env.jiraUpdates[0].value.indexOf('----') === -1, 'no separator without existing content');
        assert.ok(env.jiraUpdates[0].value.indexOf('Solution body') !== -1, 'fresh solution written');
    });
});

suite('writeSolutionAndDiagrams — finalization and partial-failure paths (gh-978 characterization)', function() {

    var JIRA_PARAMS = { solutionField: 'description', diagramField: '' };

    test('autoStartDevelopment with config file triggers the configured workflow and skips the SM idle trigger', function() {
        var env = wd3LoadFull({ autoStartResult: true });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 's' } },
            customParams: {
                solutionField: 'description',
                diagramField: '',
                autoStartDevelopment: true,
                autoStartDevelopmentConfigFile: 'story_development.json'
            }
        });
        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        assert.equal(env.calls.autoStartConfigured.length, 1, 'configured workflow triggered');
        assert.equal(env.calls.autoStartConfigured[0].configFile, 'story_development.json', 'config file forwarded');
        assert.equal(env.calls.autoStartConfigured[0].label, 'development', 'label forwarded');
        assert.deepEqual(env.calls.autoStartConfigured[0].stripKeys,
            ['autoStartDevelopment', 'autoStartDevelopmentConfigFile'], 'autoStart keys stripped from follow-up params');
        assert.equal(env.calls.smIdle, 0, 'SM idle trigger skipped when dev workflow started');
    });

    test('autoStartDevelopment trigger failure falls back to the SM idle trigger (non-fatal)', function() {
        var env = wd3LoadFull({ autoStartThrows: true });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 's' } },
            customParams: {
                solutionField: 'description',
                diagramField: '',
                autoStartDevelopment: true,
                autoStartDevelopmentConfigFile: 'story_development.json'
            }
        });
        assert.equal(result.success, true, 'action still succeeds: ' + JSON.stringify(result));
        assert.equal(env.calls.smIdle, 1, 'SM idle trigger used as fallback');
    });

    test('dedicated diagram field receives the diagram as a separate update (same order: solution first, diagram second)', function() {
        var env = wd3LoadFull({});
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 's' } },
            customParams: { solutionField: 'description', diagramField: 'Diagrams' }
        });
        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        assert.equal(env.jiraUpdates.length, 2, 'solution + diagram updates');
        assert.equal(env.jiraUpdates[0].field, 'description', 'solution field first');
        assert.equal(env.jiraUpdates[1].field, 'Diagrams', 'diagram field second');
        assert.equal(env.jiraUpdates[1].value, 'graph TD\nA --> B', 'raw diagram written to diagram field');
        assert.ok(env.jiraUpdates[0].value.indexOf('{code}') === -1, 'solution not prepended when a diagram field exists');
    });

    test('confluence publish failure returns a failure result', function() {
        var env = wd3LoadFull({ failConfluenceCreate: true });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            customParams: {
                solutionField: 'description',
                diagramField: '',
                contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' }
            }
        });
        assert.equal(result.success, false, 'action fails');
        assert.ok(result.error.indexOf('Confluence publish failed') === 0, 'publish failure surfaced: ' + result.error);
    });

    test('confluence-only target: link write and link comment failures are non-fatal', function() {
        var env = wd3LoadFull({ failUpdateField: 'description', failPostComment: true });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            customParams: {
                solutionField: 'description',
                diagramField: '',
                contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' }
            }
        });
        assert.equal(result.success, true, 'action still succeeds: ' + JSON.stringify(result));
        assert.equal(env.jiraUpdates.length, 0, 'failed link write not recorded');
    });

    test('confluence-only target with updateTrackerField false: no tracker link write at all', function() {
        var env = wd3LoadFull({});
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            customParams: {
                solutionField: 'description',
                diagramField: '',
                contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42', updateTrackerField: false }
            }
        });
        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        assert.equal(env.jiraUpdates.length, 0, 'tracker field untouched when updateTrackerField is false');
        assert.ok(env.calls.removedLabels === undefined, 'no label activity needed for this path');
    });

    test('both target: jira field write and confluence publish both happen', function() {
        var env = wd3LoadFull({});
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 'Some story' } },
            customParams: {
                solutionField: 'description',
                diagramField: '',
                contentOutput: { target: 'both', space: 'DOC', parentPageId: '42' }
            }
        });
        assert.equal(result.success, true, 'action succeeds: ' + JSON.stringify(result));
        assert.equal(env.jiraUpdates.length, 1, 'jira solution field written (no confluence link — target is both)');
        assert.ok(env.jiraUpdates[0].value.indexOf('Solution body') !== -1, 'solution body in jira field');
        assert.equal(env.calls.postComments.length, 1, 'confluence link comment posted');
    });

    test('finalize step failures (assign/move/labels) never fail the action', function() {
        var env = wd3LoadFull({ failAssign: true, failMove: true, failAddLabel: true, failRemoveLabel: true });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 's' } },
            initiator: 'user@x',
            metadata: { contextId: 'story_solution' },
            customParams: {
                solutionField: 'description',
                diagramField: '',
                removeLabel: 'sm_trigger_label'
            }
        });
        assert.equal(result.success, true, 'action still succeeds: ' + JSON.stringify(result));
        assert.equal(env.jiraUpdates.length, 1, 'solution still written');
        assert.equal(env.calls.tokenUsage, 1, 'token usage step still reached');
    });

    test('token usage comment failure is non-fatal', function() {
        var env = wd3LoadFull({ tokenUsageThrows: true });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 's' } },
            customParams: JIRA_PARAMS
        });
        assert.equal(result.success, true, 'action still succeeds: ' + JSON.stringify(result));
    });
});

// ── gh-1187 CRAP split: characterization tests for the extracted helpers ────

// Minimal branchless loader for the empty-response flow (the shared loaders
// above hardcode non-empty outputs; this one takes them explicitly).
function gh1187LoadWithOutputs(outputs) {
    var jiraUpdates = [];
    var globals = {
        jira_update_field: function(args) { jiraUpdates.push(args); },
        jira_get_ticket: function() { return { key: 'PROJ-1', fields: { summary: 'S' } }; },
        jira_assign_ticket_to: function() {},
        jira_move_to_status: function() {},
        jira_add_label: function() {},
        jira_remove_label: function() {},
        jira_post_comment: function() {},
        confluence_get_children_by_id: function() { return []; },
        confluence_create_page: function(args) { return { id: '777', title: args.title }; },
        confluence_sync_markdown_directory: function() {},
        file_write: function() {},
        file_read: function(o) { throw new Error('not found: ' + (o && (o.path || o))); }
    };
    var module = loadModule(
        'js/writeSolutionAndDiagrams.js',
        makeRequire({
            './common/trackers.js': wd3Trackers(globals),
            './config.js': configModule,
            './common/trackerFieldValue.js': wd3TrackerFieldValue(),
            './configLoader.js': { loadProjectConfig: function() { return { jira: { statuses: { READY_FOR_DEVELOPMENT: 'Ready' } } }; } },
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function() { return false; },
                triggerSmIfIdle: function() {}
            },
            './common/outputFiles.js': { readOutputFile: function(name) { return outputs[name] === undefined ? null : outputs[name]; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } }, './trackers.js': trackersMock() }),
                globals)
        }),
        globals
    );
    return { module: module, jiraUpdates: jiraUpdates };
}

suite('writeSolutionAndDiagrams — gh-1187 extracted helpers', function() {

    test('readSolutionOutputs: empty response.md yields the failure result', function() {
        var mod = wd3LoadFull().module;
        var out = mod.readSolutionOutputs(function(name) {
            return name === 'response.md' ? '' : 'graph';
        }, { requireDiagram: false });
        assert.deepEqual(out, { error: { success: false, error: 'outputs/response.md is empty' } });
    });

    test('readSolutionOutputs: requireDiagram with an empty diagram fails the action', function() {
        var mod = wd3LoadFull().module;
        var out = mod.readSolutionOutputs(function(name) {
            if (name === 'response.md') { return 'Solution body'; }
            return '';
        }, { requireDiagram: true });
        assert.deepEqual(out, { error: { success: false, error: 'outputs/diagram.md is required but empty' } });
    });

    test('readSolutionOutputs: solution + diagram returned when both are present', function() {
        var mod = wd3LoadFull().module;
        var out = mod.readSolutionOutputs(function(name) {
            return name === 'response.md' ? 'Solution body' : 'graph TD';
        }, { requireDiagram: true });
        assert.deepEqual(out, { solution: 'Solution body', diagram: 'graph TD' });
    });

    test('placeDiagram: prepends a {code} block for jira targets without a diagram field', function() {
        var mod = wd3LoadFull().module;
        var out = mod.placeDiagram('Solution body', 'graph TD', '', false);
        assert.equal(out.solution, '{code}\ngraph TD\n{code}\n\nSolution body');
        assert.equal(out.diagram, '', 'diagram marked as handled');
    });

    test('placeDiagram: defers to the Confluence publish step for confluence-only targets', function() {
        var mod = wd3LoadFull().module;
        var out = mod.placeDiagram('Solution body', 'graph TD', '', true);
        assert.equal(out.solution, 'Solution body', 'no jira {code} block on confluence-bound content');
        assert.equal(out.diagram, 'graph TD');
    });

    test('placeDiagram: dedicated diagram field leaves both values untouched', function() {
        var mod = wd3LoadFull().module;
        var out = mod.placeDiagram('Solution body', 'graph TD', 'diagrams', false);
        assert.equal(out.solution, 'Solution body');
        assert.equal(out.diagram, 'graph TD');
    });

    test('placeDiagram: no diagram is a no-op', function() {
        var mod = wd3LoadFull().module;
        var out = mod.placeDiagram('Solution body', '', '', false);
        assert.equal(out.solution, 'Solution body');
        assert.equal(out.diagram, '');
    });

    test('loadActionContext: resolves ticket key, WIP label, customParams, tracker and options', function() {
        var mod = wd3LoadFull().module;
        var ctx = mod.loadActionContext({
            ticket: { key: 'PROJ-9', fields: { summary: 's' } },
            initiator: 'initiator-1',
            metadata: { contextId: 'story_solution' },
            customParams: { diagramField: '' }
        });
        assert.equal(ctx.ticketKey, 'PROJ-9');
        assert.equal(ctx.initiatorId, 'initiator-1');
        assert.equal(ctx.wipLabel, 'story_solution_wip');
        assert.deepEqual(ctx.customParams, { diagramField: '' });
        assert.equal(ctx.options.solutionField, 'Customized' === 'never' ? '' : configModule.JIRA_FIELDS.SOLUTION, 'solutionField defaults to the Jira field');
        assert.equal(ctx.options.diagramField, '');
        assert.equal(ctx.options.outputType, 'replace');
        assert.deepEqual(ctx.jiraConfig, { statuses: { READY_FOR_DEVELOPMENT: 'Ready' } });
        assert.equal(typeof ctx.tracker.updateField, 'function');
    });

    test('loadActionContext: metadata without contextId yields a null WIP label; jobParams.customParams used as fallback', function() {
        var mod = wd3LoadFull().module;
        var ctx = mod.loadActionContext({
            ticket: { key: 'PROJ-9', fields: { summary: 's' } },
            initiator: 'i',
            jobParams: { customParams: { outputType: 'append' } }
        });
        assert.equal(ctx.wipLabel, null);
        assert.deepEqual(ctx.customParams, { outputType: 'append' });
        assert.equal(ctx.options.outputType, 'append');
    });

    test('action flow: empty response.md fails before any tracker write', function() {
        var env = gh1187LoadWithOutputs({ 'response.md': '', 'diagram.md': 'graph TD' });
        var result = env.module.action({
            ticket: { key: 'PROJ-1', fields: { summary: 's' } },
            customParams: { solutionField: 'description' }
        });
        assert.deepEqual(result, { success: false, error: 'outputs/response.md is empty' });
        assert.equal(env.jiraUpdates.length, 0, 'no field writes on missing solution');
    });

});

// ── gh-1230 CRAP characterization: diagram-flow fixture factories ────────────

suite('writeSolutionAndDiagrams — fixture factories (gh-1230 characterization)', function() {

    test('wd3OutputFilesMock: per-file defaults when fixtures are absent', function() {
        var m = wd3OutputFilesMock(undefined, undefined, undefined);
        assert.equal(m.readOutputFile('response.md'), '## Solution\nBody text');
        assert.equal(m.readOutputFile('diagram.md'), 'graph TD\nA --> B');
        assert.equal(m.readOutputFile('affected_repos.json'), null);
        assert.equal(m.readOutputFile('other.md'), null);
    });

    test('wd3OutputFilesMock: fixture overrides win for every file (2+ shapes)', function() {
        var m = wd3OutputFilesMock('# custom response', 'graph LR\nX --> Y', '[{"name":"api"}]');
        assert.equal(m.readOutputFile('response.md'), '# custom response');
        assert.equal(m.readOutputFile('diagram.md'), 'graph LR\nX --> Y');
        assert.equal(m.readOutputFile('affected_repos.json'), '[{"name":"api"}]');
    });

    test('wd3DiagramGlobals: jira and confluence recorders land in the arrays', function() {
        var jiraUpdates = [];
        var calls = [];
        var g = wd3DiagramGlobals(jiraUpdates, calls, 'outputs/replies-gh1230.json');
        g.jira_update_field({ field: 'description', value: 'v1' });
        g.jira_update_field({ field: 'description', value: 'v2' });
        assert.deepEqual(jiraUpdates, [{ field: 'description', value: 'v1' }, { field: 'description', value: 'v2' }]);
        var page = g.confluence_create_page({ title: 'T' });
        assert.deepEqual(page, { id: '777', title: 'T' });
        g.confluence_sync_markdown_directory({ parentId: '42' });
        assert.deepEqual(calls, [{ op: 'create', title: 'T' }, { op: 'sync', parentId: '42' }]);
        assert.deepEqual(g.jira_get_ticket(), { fields: {} });
        assert.equal(g.confluence_get_children_by_id().length, 0);
        g.jira_assign_ticket_to(); g.jira_move_to_status(); g.jira_add_label(); g.jira_remove_label(); g.jira_post_comment();
    });

    test('wd3DiagramGlobals: file_write records only confluence sync index payloads', function() {
        var calls = [];
        var g = wd3DiagramGlobals([], calls, null);
        g.file_write('confluence_sync_DOC/index.md', 'body');
        assert.deepEqual(calls, [{ op: 'write', path: 'confluence_sync_DOC/index.md', content: 'body' }]);
        calls.length = 0;
        g.file_write('confluence_sync_DOC/other.md', 'body');
        g.file_write('outputs/index.md', 'body');
        g.file_write(42, 'body');
        assert.deepEqual(calls, [], 'non-sync-index writes are not recorded');
    });

    test('wd3DiagramGlobals: file_read throws no-replies for the replies path, not-found otherwise', function () {
        var g = wd3DiagramGlobals([], [], 'outputs/my-replies.json');
        var e1 = null;
        try { g.file_read({ path: 'outputs/my-replies.json' }); } catch (e) { e1 = e; }
        assert.ok(e1, 'replies path must throw');
        assert.contains(e1.message, 'no replies');
        var g2 = wd3DiagramGlobals([], [], null);
        var e2 = null;
        try { g2.file_read('outputs/confluence_replies.json'); } catch (e) { e2 = e; }
        assert.ok(e2, 'default replies path throws when repliesFile is absent');
        assert.contains(e2.message, 'no replies');
        var e3 = null;
        try { g2.file_read({ path: 'outputs/other.json' }); } catch (e) { e3 = e; }
        assert.ok(e3, 'other paths must throw');
        assert.contains(e3.message, 'not found: outputs/other.json');
    });
});
