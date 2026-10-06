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

    test('gh-761: the timer must never publish a "git merge" side effect — real timerAutoCommitAndSave.js source stays clean', function() {
        // collectSideEffects() matches /git merge/g against RAW source — comments
        // included. A comment mentioning `git merge` in timerAutoCommitAndSave.js
        // (the timerJSAction of story_development / bug_development / pr_rework)
        // made the docs-freshness gate red with a FALSE side effect: the gh-761
        // timer only REFUSES to run while a merge is in progress, it never merges.
        // This test pins the real source file, not a synthetic fixture.
        var timerSource = file_read({ path: 'js/timerAutoCommitAndSave.js' });
        assert.ok(timerSource && timerSource.indexOf('isMergeInProgress') !== -1,
            'precondition: the real timer source was loaded');

        var sampleAgent = JSON.stringify({
            name: 'Teammate',
            params: {
                metadata: { contextId: 'story_development' },
                outputType: 'none',
                timerJSAction: 'agents/js/timerAutoCommitAndSave.js'
            }
        }, null, 2);

        var mock = makeMockFs({
            'agents/js/agentDocGenerator.js': '// probe',
            'agents/story_development.json': sampleAgent,
            'agents/js/timerAutoCommitAndSave.js': timerSource
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

        var doc = mock.calls.write[0].content;
        var timerSection = doc.substring(doc.indexOf('timerJSAction'));
        assert.contains(timerSection, 'timerAutoCommitAndSave.js');
        assert.contains(timerSection, 'git push');
        assert.equal(timerSection.indexOf('git merge') !== -1, false,
            'timer section must NOT list "git merge" — the timer refuses merges (gh-761). ' +
            'If this fires, the source text (comment included) mentions "git merge" and ' +
            'the doc generator would publish it as a false side effect (docs-freshness red). ' +
            'Reword the comment instead of fixing the doc.');
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
