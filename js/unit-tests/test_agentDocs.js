/**
 * Unit tests for agent documentation generators
 */

function makeMockFs(initialFiles) {
    var files = Object.assign({}, initialFiles);
    var calls = { write: [], mkdir: [], readdir: [], read: [] };

    function normalize(p) {
        return p.replace(/\\/g, '/');
    }

    return {
        calls: calls,
        fs: {
            readdirSync: function(dir) {
                calls.readdir.push(dir);
                var keys = Object.keys(files).filter(function(f) {
                    return normalize(f).indexOf(normalize(dir) + '/') === 0;
                }).map(function(f) {
                    return f.substring(dir.length + 1).split('/')[0];
                });
                var seen = {};
                return keys.filter(function(k) {
                    if (seen[k]) return false;
                    seen[k] = true;
                    return true;
                });
            },
            readFileSync: function(p, enc) {
                calls.read.push(p);
                var np = normalize(p);
                if (files[np] !== undefined) return files[np];
                throw new Error('ENOENT: ' + p);
            },
            mkdirSync: function(dir, opts) {
                calls.mkdir.push(dir);
            },
            writeFileSync: function(p, content) {
                calls.write.push({ path: p, content: content });
                files[normalize(p)] = content;
            },
            accessSync: function(p, mode) {
                calls.access = calls.access || [];
                calls.access.push(p);
                if (files[normalize(p)] === undefined) {
                    throw new Error('ENOENT: ' + p);
                }
            },
            existsSync: function(p) {
                return files[normalize(p)] !== undefined;
            },
            constants: { F_OK: 0 }
        }
    };
}

function makeMockPath() {
    return {
        join: function() {
            return Array.prototype.slice.call(arguments).join('/').replace(/\/+/g, '/');
        }
    };
}

suite('agentDocGenerator', function() {

    test('generates markdown for agent configs', function() {
        var sampleAgent = JSON.stringify({
            name: 'Teammate',
            params: {
                metadata: { contextId: 'pr_review' },
                outputType: 'none',
                skipAIProcessing: true,
                preJSAction: 'agents/js/checkWipLabel.js',
                preCliJSAction: 'agents/js/preparePRForReview.js',
                postJSAction: 'agents/js/postPRReviewComments.js',
                customParams: { removeLabel: 'sm_story_review_triggered' },
                cliPrompts: ['./agents/instructions/pr_review/general_guidelines.md'],
                outputSchemas: {
                    'outputs/pr_review.json': {
                        required: ['recommendation', 'inlineComments']
                    }
                }
            }
        }, null, 2);

        var mock = makeMockFs({
            'agents/js/agentDocGenerator.js': '// probe',
            'agents/pr_review.json': sampleAgent,
            'agents/sm.json': '{}',
            'agents/sm_merge.json': '{}',
            'agents/run_all.json': '{}',
            'agents/snapshots/pr_review.md': '# snapshot'
        });

        var generator = loadModule(
            'js/agentDocGenerator.js',
            makeRequire({
                'fs': mock.fs,
                'path': makeMockPath()
            }),
            {}
        );

        var result = generator.generate();

        assert.equal(result.success, true);
        assert.equal(result.generated, 1);
        assert.equal(mock.calls.write.length, 1);
        var written = mock.calls.write[0];
        assert.contains(written.path, 'docs/agents/generated/pr_review.md');
        assert.contains(written.content, 'pr_review');
        assert.contains(written.content, 'checkWipLabel.js');
        assert.contains(written.content, 'outputs/pr_review.json');
        assert.contains(written.content, 'agents/snapshots/pr_review.md');
    });

    test('follows local relative requires when collecting customParams usage', function() {
        // gh-961 rework: postTestAutomationResults.js moved its
        // customParams.removeLabel access into postTestAutomationResultsHelpers.js.
        // The generator must follow local relative requires so the generated
        // doc keeps listing removeLabel (docs-freshness CI job).
        var agent = JSON.stringify({
            name: 'Teammate',
            params: {
                postJSAction: 'agents/js/doThing.js'
            }
        }, null, 2);

        var mock = makeMockFs({
            'agents/js/agentDocGenerator.js': '// probe',
            'agents/my_agent.json': agent,
            'agents/js/doThing.js':
                "var helpers = require('./doThingHelpers.js');\n" +
                'function action(params) { return helpers.decide(params); }',
            'agents/js/doThingHelpers.js':
                'function decide(params) { return params.jobParams.customParams.removeLabel; }'
        });

        var generator = loadModule(
            'js/agentDocGenerator.js',
            makeRequire({
                'fs': mock.fs,
                'path': makeMockPath()
            }),
            {}
        );

        var result = generator.generate();
        assert.equal(result.success, true);
        assert.contains(mock.calls.write[0].content, '`removeLabel`');
    });

    test('follows transitive local relative requires without double-counting', function() {
        var agent = JSON.stringify({
            name: 'Teammate',
            params: {
                postJSAction: 'agents/js/doThing.js'
            }
        }, null, 2);

        var mock = makeMockFs({
            'agents/js/agentDocGenerator.js': '// probe',
            'agents/my_agent.json': agent,
            'agents/js/doThing.js':
                "var mid = require('./mid.js');\n" +
                'function action(params) { return mid.go(params); }',
            'agents/js/mid.js':
                "var leaf = require('./leaf.js');\n" +
                "var cyc = require('./doThing.js');\n" + // cycle back to the action file
                'function go(params) { return [leaf.decide(params), cyc]; }',
            'agents/js/leaf.js':
                'function decide(params) { return params.jobParams.customParams.removeLabel; }'
        });

        var generator = loadModule(
            'js/agentDocGenerator.js',
            makeRequire({
                'fs': mock.fs,
                'path': makeMockPath()
            }),
            {}
        );

        var result = generator.generate();
        assert.equal(result.success, true);
        var content = mock.calls.write[0].content;
        // single occurrence inside the Actions section (the merged
        // "## Custom params" section legitimately repeats it)
        var actionsSection = content.split('## LLM step')[0];
        assert.contains(actionsSection, '`removeLabel`');
        var occurrences = actionsSection.split('`removeLabel`').length - 1;
        assert.equal(occurrences, 1);
    });

    test('ignores local relative requires that cannot be resolved', function() {
        var agent = JSON.stringify({
            name: 'Teammate',
            params: {
                postJSAction: 'agents/js/doThing.js'
            }
        }, null, 2);

        var mock = makeMockFs({
            'agents/js/agentDocGenerator.js': '// probe',
            'agents/my_agent.json': agent,
            'agents/js/doThing.js':
                "var missing = require('./notThere.js');\n" +
                'function action(params) { return params.jobParams.customParams.keepMe; }'
        });

        var generator = loadModule(
            'js/agentDocGenerator.js',
            makeRequire({
                'fs': mock.fs,
                'path': makeMockPath()
            }),
            {}
        );

        var result = generator.generate();
        assert.equal(result.success, true);
        var content = mock.calls.write[0].content;
        assert.contains(content, '`keepMe`');
    });

    test('ignores sm.json, sm_merge.json and run_ files', function() {
        var mock = makeMockFs({
            'agents/js/agentDocGenerator.js': '// probe',
            'agents/sm.json': '{}',
            'agents/sm_merge.json': '{}',
            'agents/run_foo.json': '{}',
            'agents/real_agent.json': JSON.stringify({ name: 'Real', params: {} })
        });

        var generator = loadModule(
            'js/agentDocGenerator.js',
            makeRequire({
                'fs': mock.fs,
                'path': makeMockPath()
            }),
            {}
        );

        var result = generator.generate();
        assert.equal(result.generated, 1);
        assert.contains(mock.calls.write[0].path, 'real_agent.md');
    });

});

suite('agentWorkflowGraph', function() {

    test('generates workflow markdown from sm.json', function() {
        var sm = JSON.stringify({
            params: {
                jobParams: {
                    rules: [
                        {
                            description: 'Ready For Development → development',
                            jql: "project = TS AND issuetype = 'Story' AND status = 'Ready For Development'",
                            configFile: 'agents/story_development.json',
                            targetStatus: 'In Review',
                            enabled: true
                        },
                        {
                            description: 'Disabled rule',
                            configFile: 'agents/disabled.json',
                            enabled: false
                        }
                    ]
                }
            }
        }, null, 2);

        var mock = makeMockFs({
            'agents/sm.json': sm
        });

        var generator = loadModule(
            'js/agentWorkflowGraph.js',
            makeRequire({
                'fs': mock.fs,
                'path': makeMockPath()
            }),
            {}
        );

        var result = generator.generate();

        assert.equal(result.success, true);
        assert.equal(result.rules, 2);
        assert.equal(mock.calls.write.length, 1);
        var written = mock.calls.write[0];
        assert.contains(written.path, 'docs/agents/workflow.md');
        assert.contains(written.content, 'flowchart TD');
        assert.contains(written.content, 'Ready For Development');
        assert.contains(written.content, 'story_development');
        assert.contains(written.content, 'In Review');
        assert.contains(written.content, 'SM rules');
        assert.ok(written.content.indexOf('disabled') === -1, 'disabled rule should not appear');
    });

});

// ── gh-1227 CRAP — generate() branch characterization ────────────────────────
// Locks every rule-shape branch (status in / status =, issuetype in / =,
// no jql, targetStatus, skipIfLabel / skipIfLabels, addLabel, flat
// params.rules) before the table/edge helpers are extracted.

suite('agentWorkflowGraph — branch characterization (gh-1227)', function() {

    function graphFor(rules, smShape) {
        var sm = smShape || { params: { jobParams: { rules: rules } } };
        var mock = makeMockFs({ 'agents/sm.json': JSON.stringify(sm) });
        var generator = loadModule(
            'js/agentWorkflowGraph.js',
            makeRequire({ 'fs': mock.fs, 'path': makeMockPath() }),
            {}
        );
        var result = generator.generate();
        return { result: result, content: mock.calls.write[0].content };
    }

    test('status in (...) + issuetype in (...) parse into cells, nodes and edges', function() {
        var out = graphFor([{
            description: 'multi',
            jql: "project = TS AND issuetype in ('Story', 'Bug') AND status in ('Ready For Development', 'In Rework')",
            configFile: 'agents/story_development.json',
            targetStatus: 'In Review',
            skipIfLabel: 'sm_story_development_triggered',
            addLabel: 'sm_story_development_triggered'
        }]);
        assert.equal(out.result.success, true);
        assert.contains(out.content, 'Story, Bug');
        assert.contains(out.content, 'Ready For Development, In Rework');
        assert.contains(out.content,
            'S_Ready_For_Development["Ready For Development"] --> A0_["story_development"]');
        assert.contains(out.content,
            'S_In_Rework["In Rework"] --> A0_["story_development"]');
        assert.contains(out.content,
            'A0_["story_development"] --> S_In_Review["In Review"]');
        assert.contains(out.content, '`sm_story_development_triggered`');
    });

    test('status = ... / issuetype = ... single-value forms parse', function() {
        var out = graphFor([{
            description: 'single',
            jql: "project = TS AND issuetype = 'Task' AND status = 'In Progress'",
            configFile: 'agents/story_questions.json'
        }]);
        assert.contains(out.content, 'Task');
        assert.contains(out.content, 'In Progress');
        assert.contains(out.content, 'S_In_Progress["In Progress"]');
    });

    test('rule without jql renders empty type/status cells', function() {
        var out = graphFor([{
            description: 'nojql',
            configFile: 'agents/nojql.json'
        }]);
        assert.contains(out.content, '| nojql |  |  |');
    });

    test('skipIfLabels array renders quoted, comma-joined', function() {
        var out = graphFor([{
            description: 'labels',
            jql: "status = 'In Progress'",
            configFile: 'agents/a.json',
            skipIfLabels: ['lbl_one', 'lbl_two']
        }]);
        assert.contains(out.content, '`lbl_one`, `lbl_two`');
    });

    test('flat params.rules (legacy sm shape) still drives the graph', function() {
        var out = graphFor([{
            description: 'flat',
            jql: "status = 'In Progress'",
            configFile: 'agents/flat.json'
        }], { params: { rules: [{
            description: 'flat',
            jql: "status = 'In Progress'",
            configFile: 'agents/flat.json'
        }] } });
        assert.equal(out.result.rules, 1);
        assert.contains(out.content, 'flat');
    });

    test('rule fields missing (no targetStatus/skip labels/addLabel) render empty cells', function() {
        var out = graphFor([{
            description: 'plain',
            jql: "status = 'In Progress'",
            configFile: 'agents/plain.json'
        }]);
        assert.ok(out.content.indexOf('--> S_In_Progress["In Progress"]') === -1,
            'no target edge without targetStatus');
    });
});

suite('collectArtifacts', function() {
    function generator() {
        var mock = makeMockFs({ 'agents/js/agentDocGenerator.js': '// probe' });
        var mod = loadModule(
            'js/agentDocGenerator.js',
            makeRequire({ 'fs': mock.fs, 'path': makeMockPath() }),
            {}
        );
        return mod;
    }

    test('captures literal file_write / file_read paths under input/ or outputs/', function() {
        var src = [
            "file_write('outputs/report.md', data);",
            "var t = file_read('input/ticket.md');"
        ].join('\n');
        var out = generator().collectArtifacts(src, 'postJSAction');
        assert.deepEqual(out, {
            reads: ['input/ticket.md'],
            writes: ['outputs/report.md']
        });
    });

    test('captures the file_write({ path: ... }) object form', function() {
        var src = "file_write({ path: 'outputs/result.json', content: data });";
        var out = generator().collectArtifacts(src, 'postJSAction');
        assert.deepEqual(out.writes, ['outputs/result.json']);
        assert.deepEqual(out.reads, []);
    });

    test('concat forms insert the <KEY> placeholder between the two literals', function() {
        var src = [
            "file_write('input/' + ticketKey + '/a.md', data);",        // slash/slash branch
            "file_write({ path: 'outputs/r_' + key + '.md' }, data);",  // non-slash branch (object path)
            "file_read('outputs/' + key + '/summary.md');"
        ].join('\n');
        var out = generator().collectArtifacts(src, 'postJSAction');
        // Characterization quirk (preserved, gh-1085): the plain literal
        // pattern also matches the LEFT half of a concat form whose path
        // has no trailing slash ('outputs/r_'), so that partial path lands
        // in the list next to the <KEY> form.
        assert.deepEqual(out.writes.sort(), ['input/<KEY>/a.md', 'outputs/r_', 'outputs/r_<KEY>.md']);
        // file_read has no concat pattern — the bare 'outputs/' capture is
        // filtered by the bare-dir guard, so the read list stays empty.
        assert.deepEqual(out.reads, []);
    });

    test('non-concat two-literal shape (slash only on one side) still inserts <KEY>', function() {
        var src = "file_write('outputs/r_' + key + '.md', data);";
        var out = generator().collectArtifacts(src, 'postJSAction');
        assert.deepEqual(out.writes, ['outputs/r_', 'outputs/r_<KEY>.md']);
    });

    test('inputFolder / inputFolderPath / folder concatenations map to input/<KEY>', function() {
        var src = [
            "file_write(inputFolder + '/a.md', data);",
            "var b = file_read(inputFolderPath + '/b.md');",
            "fs.writeFileSync(path.join(folder, 'c.md'), data);",
            "var d = fs.readFileSync(path.join(inputFolder, 'd.md'), 'utf8');",
            "file_write(path.join(inputFolderPath, 'e.md'), data);",
            "var f = file_read(path.join(folder, 'f.md'));"
        ].join('\n');
        var out = generator().collectArtifacts(src, 'preJSAction');
        // Characterization quirk (preserved, gh-1085): the path.join/folder
        // patterns prepend 'input/<KEY>' WITHOUT a separator — the slash in
        // the output comes only from the captured literal itself.
        assert.deepEqual(out.writes, ['input/<KEY>/a.md', 'input/<KEY>c.md', 'input/<KEY>e.md']);
        assert.deepEqual(out.reads, ['input/<KEY>/b.md', 'input/<KEY>d.md', 'input/<KEY>f.md']);
    });

    test('jira_attach_file_to_ticket filePath counts as a read', function() {
        var src = "jira_attach_file_to_ticket({ ticketKey: key, filePath: 'outputs/g.pdf' });";
        var out = generator().collectArtifacts(src, 'postJSAction');
        assert.deepEqual(out.reads, ['outputs/g.pdf']);
        assert.deepEqual(out.writes, []);
    });

    test('bare input/ and outputs/ paths are dropped', function() {
        var src = [
            "file_write('outputs/', data);",
            "var t = file_read('input/');",
            "file_write('outputs/real.md', data);"
        ].join('\n');
        var out = generator().collectArtifacts(src, 'postJSAction');
        assert.deepEqual(out.writes, ['outputs/real.md']);
        assert.deepEqual(out.reads, []);
    });

    test('MULTI-ITEM: results are deduplicated and sorted; ./ prefixes are normalized', function() {
        var src = [
            "file_write('outputs/b.md', data);",
            "file_write('./outputs/a.md', data);",
            "file_write('outputs/a.md', data);",
            "var t = file_read('outputs/z.md');"
        ].join('\n');
        var out = generator().collectArtifacts(src, 'postJSAction');
        assert.deepEqual(out.writes, ['outputs/a.md', 'outputs/b.md']);
        assert.deepEqual(out.reads, ['outputs/z.md']);
    });

    test('sources with no artifact calls produce empty lists', function() {
        var out = generator().collectArtifacts("console.log('nothing here');", 'postJSAction');
        assert.deepEqual(out, { reads: [], writes: [] });
    });
});

// ─── gh-119 CRAP: renderActionSection / renderAgentDoc characterization ──────

var GH119_ACTION_SRC = [
    '/**',
    ' * Do the thing — preCLI setup helper.',
    ' */',
    'function setup(params) {',
    "    var raw = file_read('input/ticket.json');",
    "    file_write('outputs/result.md', raw);",
    "    jira_post_comment({ key: params.ticketKey, comment: 'x' });",
    '    return params.customParams.removeLabel;',
    '}'
].join('\n');

function loadRenderHarness(files) {
    var mock = makeMockFs(Object.assign({ 'agents/js/agentDocGenerator.js': '// probe' }, files || {}));
    var mod = loadModule(
        'js/agentDocGenerator.js',
        makeRequire({ 'fs': mock.fs, 'path': makeMockPath() }),
        {}
    );
    return mod;
}

suite('agentDocGenerator.renderActionSection (gh-119 characterization)', function() {

    test('empty filePath renders nothing', function() {
        var mod = loadRenderHarness({});
        assert.equal(mod.renderActionSection('preJSAction', '', 'pre'), '');
        assert.equal(mod.renderActionSection('preJSAction', null, 'pre'), '');
    });

    test('full analysis: description, reads, writes, side effects, params (2+ items each)', function() {
        var mod = loadRenderHarness({ 'agents/js/doThing.js': GH119_ACTION_SRC.replace(
            "file_read('input/ticket.json')",
            "file_read('input/ticket.json'); file_read('input/extra.json')"
        ) });
        var md = mod.renderActionSection('preCliJSAction', 'agents/js/doThing.js', 'pre');
        assert.equal(md, [
            '### preCliJSAction: `doThing.js`',
            '',
            '_Do the thing — preCLI setup helper._',
            '',
            '- Source: `agents/js/doThing.js`',
            '- Reads:',
            '  - `input/extra.json`',
            '  - `input/ticket.json`',
            '- Writes:',
            '  - `outputs/result.md`',
            '- Side effects:',
            '  - post Jira comment',
            '- Parameters (customParams):',
            '  - `removeLabel`',
            ''
        ].join('\n'));
    });

    test('an action with no detected artifacts gets the placeholder line', function() {
        var mod = loadRenderHarness({ 'agents/js/empty.js': '// no artifacts here' });
        var md = mod.renderActionSection('postJSAction', 'agents/js/empty.js', 'post');
        assert.equal(md, [
            '### postJSAction: `empty.js`',
            '',
            '- Source: `agents/js/empty.js`',
            '- No detected file I/O or side effects.',
            ''
        ].join('\n'));
    });

    test('params-only analysis: Parameters group without the placeholder line', function() {
        var mod = loadRenderHarness({ 'agents/js/paramsOnly.js': 'var x = params.customParams.onlyParam;' });
        var md = mod.renderActionSection('timerJSAction', 'agents/js/paramsOnly.js', 'post');
        assert.equal(md, [
            '### timerJSAction: `paramsOnly.js`',
            '',
            '- Source: `agents/js/paramsOnly.js`',
            '- Parameters (customParams):',
            '  - `onlyParam`',
            ''
        ].join('\n'));
    });

    test('a missing action file renders the placeholder section (no throw)', function() {
        var mod = loadRenderHarness({});
        var md = mod.renderActionSection('postCliJSAction', 'agents/js/missing.js', 'post');
        assert.contains(md, '### postCliJSAction: `missing.js`');
        assert.contains(md, '- No detected file I/O or side effects.');
    });
});

suite('agentDocGenerator.renderAgentDoc (gh-119 characterization)', function() {

    function configWith(params) {
        return { name: 'Teammate', params: params };
    }

    var FULL_PARAMS = {
        metadata: { contextId: 'my_ctx' },
        outputType: 'mark',
        skipAIProcessing: true,
        preJSAction: 'agents/js/doThing.js',
        customParams: { removeLabel: 'x', flags: { a: 1 } },
        outputSchemas: { 'outputs/out.json': { required: ['r1', 'r2'] } }
    };

    test('full document: title, attributes, actions, LLM step, schemas, custom params, footer', function() {
        var mod = loadRenderHarness({ 'agents/js/doThing.js': GH119_ACTION_SRC });
        var doc = mod.renderAgentDoc('my_agent.json', configWith(FULL_PARAMS));

        assert.contains(doc, '# My Agent\n');
        assert.contains(doc, '| Job | `Teammate` |');
        assert.contains(doc, '| Config | `my_agent.json` |');
        assert.contains(doc, '| ContextId | `my_ctx` |');
        assert.contains(doc, '| outputType | `mark` |');
        assert.contains(doc, '| skipAIProcessing | `true` |');
        assert.contains(doc, '## Actions');
        assert.contains(doc, '### preJSAction: `doThing.js`');
        assert.contains(doc, '- Reads:\n  - `input/ticket.json`');
        assert.contains(doc, '## LLM step');
        assert.contains(doc, '- outputType: `mark`');
        assert.contains(doc, '### Output schemas');
        assert.contains(doc, '- `outputs/out.json`\n  - required: `r1`, `r2`');
        assert.contains(doc, '## Custom params');
        assert.contains(doc, '- `removeLabel`: `"x"`');
        assert.contains(doc, '  ```json');
        assert.contains(doc, '_Generated by js/agentDocGenerator.js_');
        // jsParamsUsed 'removeLabel' shares the root key with customParams — no duplicate row.
        assert.equal(doc.indexOf('(used by JS action)'), -1);
        // No snapshot when none exists.
        assert.equal(doc.indexOf('Prompt snapshot'), -1);
        // The four absent action slots render empty (no stray headings).
        assert.equal(doc.indexOf('### preCliJSAction'), -1);
        assert.equal(doc.indexOf('### postJSAction'), -1);
    });

    test('defaults hold when metadata/customParams/outputSchemas are absent', function() {
        var mod = loadRenderHarness({});
        var doc = mod.renderAgentDoc('bare.json', configWith({}));
        assert.contains(doc, '# Bare\n');
        assert.contains(doc, '| Job | `Teammate` |');
        assert.contains(doc, '| ContextId | `—` |');
        assert.contains(doc, '| outputType | `—` |');
        assert.contains(doc, '| skipAIProcessing | `false` |');
        assert.contains(doc, '- outputType: `none`');
        assert.equal(doc.indexOf('## Custom params'), -1);
    });

    test('human doc is embedded (title dropped) and referenced', function() {
        var mod = loadRenderHarness({
            'agents/docs/agents/my_agent.md': '# My own title\n\nBody of the human doc.\n'
        });
        var doc = mod.renderAgentDoc('my_agent.json', configWith({}));
        assert.contains(doc, 'Body of the human doc.');
        assert.contains(doc, '_Human doc: [`agents/docs/agents/my_agent.md`](agents/docs/agents/my_agent.md)_');
        assert.equal(doc.indexOf('# My own title'), -1, 'the human doc title is dropped');
    });

    test('prompt snapshot renders both the section and the LM-step bullet', function() {
        var mod = loadRenderHarness({
            'agents/snapshots/my_agent.md': '# snapshot'
        });
        var doc = mod.renderAgentDoc('my_agent.json', configWith({}));
        assert.contains(doc, '## Prompt snapshot');
        assert.contains(doc, '[`agents/snapshots/my_agent.md`](agents/snapshots/my_agent.md)');
        assert.contains(doc, '- Prompt snapshot: `agents/snapshots/my_agent.md`');
    });

    test('jsParamsUsed merge: JS-only params get their own row, one per path', function() {
        var mod = loadRenderHarness({
            'agents/js/doThing.js': GH119_ACTION_SRC + '\nvar y = params.customParams.jsOnlyFlag;'
        });
        var doc = mod.renderAgentDoc('my_agent.json', configWith({
            preJSAction: 'agents/js/doThing.js',
            customParams: { removeLabel: 'x' }
        }));
        assert.contains(doc, '- `jsOnlyFlag` _(used by JS action)_');
        assert.equal(doc.indexOf('- `removeLabel` _(used by JS action)_'), -1, 'root keys already documented are skipped');
    });

    test('empty customParams object with JS usage still renders the section', function() {
        var mod = loadRenderHarness({ 'agents/js/doThing.js': GH119_ACTION_SRC });
        var doc = mod.renderAgentDoc('my_agent.json', configWith({
            preJSAction: 'agents/js/doThing.js',
            customParams: {}
        }));
        assert.contains(doc, '## Custom params');
        assert.contains(doc, '- `removeLabel` _(used by JS action)_');
    });
});
