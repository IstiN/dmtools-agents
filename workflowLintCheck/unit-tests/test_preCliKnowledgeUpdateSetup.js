/**
 * Unit tests for js/preCliKnowledgeUpdateSetup.js
 *
 * Scope: the three PR-context resolution modes (direct content, direct PR/MR
 * reference, ticket-based fallback), the knowledgeDir no-op gate, and the
 * "neither diff nor discussions available" no-op path. This action is
 * intentionally NOT tracker-bound — see the module docstring — so most tests
 * exercise it purely via customParams, without any ticket in context.
 */

function makeGhStub(overrides) {
    var base = {
        getPRDetails: function() { return null; },
        findMergedPRForTicket: function() { return null; },
        fetchDiscussionsAndRawData: function() { return {}; },
        writePRContext: function() {}
    };
    return Object.assign(base, overrides || {});
}

function loadPreCliKnowledgeUpdateSetup(ghStub, scm, mocks) {
    return loadModule(
        'js/preCliKnowledgeUpdateSetup.js',
        makeRequire({
            './configLoader.js': {
                loadProjectConfig: function() { return {}; },
                createScm: function() { return scm || {}; }
            },
            './common/githubHelpers.js': ghStub
        }),
        mocks || {}
    );
}

function makeWriteTracker() {
    var writes = [];
    return {
        writes: writes,
        file_write: function(opts) { writes.push(opts); },
        find: function(path) {
            for (var i = 0; i < writes.length; i++) {
                if (writes[i].path === path) return writes[i];
            }
            return null;
        }
    };
}

suite('preCliKnowledgeUpdateSetup — knowledgeDir no-op gate', function() {

    test('no-ops when customParams.knowledgeDir is not set, regardless of other params', function() {
        var tracker = makeWriteTracker();
        var mod = loadPreCliKnowledgeUpdateSetup(makeGhStub(), {}, { file_write: tracker.file_write });

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { prNumber: '42' }
        });

        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        assert.equal(result.reason, 'knowledgeDir not configured');

        var marker = tracker.find('input/pr_knowledge_update/knowledge_task.md');
        assert.ok(marker, 'should still write a no-op knowledge_task.md');
        assert.contains(marker.content, 'has not configured');
    });
});

suite('preCliKnowledgeUpdateSetup — direct PR reference mode (customParams.prNumber)', function() {

    test('fetches PR details/diff/discussions directly via scm, with no ticket involved', function() {
        var tracker = makeWriteTracker();
        var getPrDetailsCalls = [];
        var getDiffTextCalls = [];
        var fetchDiscussionsCalls = [];
        var writePRContextCalls = [];

        var scm = {
            getDiffText: function(prId) {
                getDiffTextCalls.push(prId);
                return 'diff --git a/x b/x';
            }
        };

        var gh = makeGhStub({
            getPRDetails: function(scmArg, prId) {
                getPrDetailsCalls.push(prId);
                return { number: 42, html_url: 'https://example.com/pr/42', title: 'Fix thing', state: 'merged' };
            },
            fetchDiscussionsAndRawData: function(scmArg, prId) {
                fetchDiscussionsCalls.push(prId);
                return { markdown: '## Thread\nSome comment', rawThreads: { threads: [] } };
            },
            writePRContext: function(inputFolder, prDetails, diff, markdown, rawThreads) {
                writePRContextCalls.push({ inputFolder: inputFolder, prDetails: prDetails, diff: diff, markdown: markdown, rawThreads: rawThreads });
            }
        });

        var mod = loadPreCliKnowledgeUpdateSetup(gh, scm, { file_write: tracker.file_write });

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', prNumber: '42' }
        });

        assert.equal(result.success, true);
        assert.ok(!result.skipped, 'should not be skipped when a PR reference resolves successfully');
        assert.equal(result.prNumber, 42);
        assert.equal(result.knowledgeDir, 'knowledge');

        assert.deepEqual(getPrDetailsCalls, ['42']);
        assert.deepEqual(getDiffTextCalls, [42]);
        assert.deepEqual(fetchDiscussionsCalls, [42]);

        assert.equal(writePRContextCalls.length, 1);
        assert.equal(writePRContextCalls[0].diff, 'diff --git a/x b/x');
        assert.equal(writePRContextCalls[0].markdown, '## Thread\nSome comment');

        var taskMarker = tracker.find('input/pr_knowledge_update/knowledge_task.md');
        assert.ok(taskMarker, 'should write knowledge_task.md');
        assert.contains(taskMarker.content, 'knowledge');
        assert.contains(taskMarker.content, '#42');
    });

    test('no-ops when the referenced PR/MR cannot be fetched', function() {
        var tracker = makeWriteTracker();
        var gh = makeGhStub({ getPRDetails: function() { return null; } });
        var mod = loadPreCliKnowledgeUpdateSetup(gh, {}, { file_write: tracker.file_write });

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', prNumber: '999' }
        });

        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        var marker = tracker.find('input/pr_knowledge_update/knowledge_task.md');
        assert.ok(marker);
        assert.contains(marker.content, 'nothing to do');
    });
});

suite('preCliKnowledgeUpdateSetup — direct content mode (customParams.diffText / discussionsMarkdown)', function() {

    test('uses supplied diff/discussions directly without touching the SCM at all', function() {
        var tracker = makeWriteTracker();
        var createScmCalls = 0;
        var writePRContextCalls = [];

        var gh = makeGhStub({
            writePRContext: function(inputFolder, prDetails, diff, markdown, rawThreads) {
                writePRContextCalls.push({ prDetails: prDetails, diff: diff, markdown: markdown });
            }
        });

        var mod = loadModule(
            'js/preCliKnowledgeUpdateSetup.js',
            makeRequire({
                './configLoader.js': {
                    loadProjectConfig: function() { return {}; },
                    createScm: function() { createScmCalls++; return {}; }
                },
                './common/githubHelpers.js': gh
            }),
            { file_write: tracker.file_write }
        );

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: {
                knowledgeDir: 'knowledge',
                diffText: 'diff --git a/x b/x',
                discussionsMarkdown: '## Thread\nComment',
                prNumber: '7',
                prUrl: 'https://example.com/pr/7'
            }
        });

        assert.equal(result.success, true);
        assert.ok(!result.skipped);
        assert.equal(createScmCalls, 0, 'must not create an scm client in direct-content mode');
        assert.equal(writePRContextCalls.length, 1);
        assert.equal(writePRContextCalls[0].diff, 'diff --git a/x b/x');
        assert.equal(writePRContextCalls[0].markdown, '## Thread\nComment');
    });

    test('works with diff only (no discussions supplied)', function() {
        var tracker = makeWriteTracker();
        var writePRContextCalls = [];
        var gh = makeGhStub({
            writePRContext: function(inputFolder, prDetails, diff, markdown) {
                writePRContextCalls.push({ diff: diff, markdown: markdown });
            }
        });

        var mod = loadPreCliKnowledgeUpdateSetup(gh, {}, { file_write: tracker.file_write });

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', diffText: 'diff --git a/x b/x' }
        });

        assert.equal(result.success, true);
        assert.ok(!result.skipped);
        assert.equal(writePRContextCalls[0].diff, 'diff --git a/x b/x');
        assert.ok(!writePRContextCalls[0].markdown);
    });

    test('works with discussions only (no diff supplied)', function() {
        var tracker = makeWriteTracker();
        var writePRContextCalls = [];
        var gh = makeGhStub({
            writePRContext: function(inputFolder, prDetails, diff, markdown) {
                writePRContextCalls.push({ diff: diff, markdown: markdown });
            }
        });

        var mod = loadPreCliKnowledgeUpdateSetup(gh, {}, { file_write: tracker.file_write });

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', discussionsMarkdown: '## Thread\nComment' }
        });

        assert.equal(result.success, true);
        assert.ok(!result.skipped);
        assert.ok(!writePRContextCalls[0].diff);
        assert.equal(writePRContextCalls[0].markdown, '## Thread\nComment');
    });
});

suite('preCliKnowledgeUpdateSetup — ticket-based fallback mode', function() {

    test('resolves via findMergedPRForTicket when a ticket is present and no direct PR/content params are given', function() {
        var tracker = makeWriteTracker();
        var findCalls = [];
        var scm = { getDiffText: function() { return 'diff text'; } };
        var gh = makeGhStub({
            findMergedPRForTicket: function(scmArg, ticketKey) {
                findCalls.push(ticketKey);
                return { number: 55 };
            },
            getPRDetails: function() {
                return { number: 55, html_url: 'https://example.com/pr/55', title: 'x', state: 'merged' };
            },
            fetchDiscussionsAndRawData: function() { return { markdown: 'comments', rawThreads: null }; },
            writePRContext: function() {}
        });

        var mod = loadPreCliKnowledgeUpdateSetup(gh, scm, { file_write: tracker.file_write });

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            ticket: { key: 'ABC-123' },
            customParams: { knowledgeDir: 'knowledge' }
        });

        assert.equal(result.success, true);
        assert.ok(!result.skipped);
        assert.deepEqual(findCalls, ['ABC-123']);
    });

    test('no-ops when there is no direct PR reference, no direct content, and no ticket in context', function() {
        var tracker = makeWriteTracker();
        var gh = makeGhStub();
        var mod = loadPreCliKnowledgeUpdateSetup(gh, {}, { file_write: tracker.file_write });

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge' }
        });

        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        var marker = tracker.find('input/pr_knowledge_update/knowledge_task.md');
        assert.contains(marker.content, 'customParams.prNumber');
    });
});

suite('preCliKnowledgeUpdateSetup — no usable material at all', function() {

    test('no-ops when both diff and discussions come back empty for a resolved PR', function() {
        var tracker = makeWriteTracker();
        var scm = { getDiffText: function() { return null; } };
        var gh = makeGhStub({
            getPRDetails: function() { return { number: 42, html_url: 'x', title: 'x', state: 'merged' }; },
            fetchDiscussionsAndRawData: function() { return { markdown: null, rawThreads: null }; },
            writePRContext: function() {}
        });

        var mod = loadPreCliKnowledgeUpdateSetup(gh, scm, { file_write: tracker.file_write });

        var result = mod.action({
            inputFolderPath: 'input/pr_knowledge_update',
            customParams: { knowledgeDir: 'knowledge', prNumber: '42' }
        });

        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        assert.equal(result.reason, 'no diff or discussions available');
    });
});
