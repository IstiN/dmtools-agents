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
            }
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
            'agents/pr_review.json': sampleAgent,
            'agents/sm.json': '{}',
            'agents/sm_merge.json': '{}',
            'agents/run_all.json': '{}'
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
    });

    test('ignores sm.json, sm_merge.json and run_ files', function() {
        var mock = makeMockFs({
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
        assert.ok(written.content.indexOf('disabled') === -1, 'disabled rule should not appear');
    });

});
