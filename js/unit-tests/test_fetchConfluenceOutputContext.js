/**
 * Unit tests for js/fetchConfluenceOutputContext.js.
 */

function loadFetchConfluenceContext(mocks, projectConfig) {
    var configLoaderMock = {
        loadProjectConfig: function() { return projectConfig || {}; }
    };
    var contentOutputLib = loadModule(
        'js/common/contentOutput.js',
        makeRequire({ '../configLoader.js': configLoaderMock }),
        Object.assign({}, mocks || {})
    );
    return loadModule(
        'js/fetchConfluenceOutputContext.js',
        makeRequire({ './common/contentOutput.js': contentOutputLib }),
        Object.assign({}, mocks || {})
    );
}

function makeParams(overrides) {
    return Object.assign({
        inputFolderPath: 'input/PROJ-10',
        ticket: { key: 'PROJ-10', fields: { summary: 'Some story' } },
        jobParams: {}
    }, overrides || {});
}

suite('fetchConfluenceOutputContext', function() {

    test('skips silently when target is jira_field (default)', function() {
        var queried = false;
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() { queried = true; return []; }
        });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.action, 'skipped_not_confluence_target');
        assert.equal(queried, false, 'should not touch Confluence for jira_field target');
    });

    test('skips with warning when Confluence target is not configured', function() {
        var mod = loadFetchConfluenceContext({}, {});

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence' } }
        }));

        assert.equal(result.action, 'skipped_not_configured');
    });

    test('first run — no existing page, nothing written', function() {
        var writes = {};
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{ id: 'p9', title: 'OTHER-1 Something else' }];
            },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        }));

        assert.equal(result.action, 'first_run');
        assert.equal(writes['input/PROJ-10/confluence_output_current.md'], undefined);
    });

    test('existing page — writes current content and inline comments into input', function() {
        var writes = {};
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{
                    id: 'p1',
                    title: 'PROJ-10 Some story — Solution Design',
                    body: { storage: { value: '# Existing solution' } }
                }];
            },
            confluence_get_page_inline_comments: function(args) {
                assert.equal(args.pageId, 'p1');
                return JSON.stringify({
                    results: [{
                        id: 'c1',
                        resolutionStatus: 'open',
                        version: { createdAt: '2026-08-20T10:00:00Z' },
                        body: { storage: { value: '<p>What about retries?</p>' } }
                    }]
                });
            },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        }));

        assert.equal(result.action, 'context_fetched');
        assert.equal(result.pageId, 'p1');
        assert.equal(result.commentsCount, 1);
        assert.equal(writes['input/PROJ-10/confluence_output_current.md'], '# Existing solution');
        assert.contains(writes['input/PROJ-10/confluence_output_comments.md'], 'What about retries?');
        assert.contains(writes['input/PROJ-10/confluence_output_comments.md'], 'Comment c1');
        assert.contains(writes['input/PROJ-10/confluence_output_comments.json'], '"commentId": "c1"');
    });

    test('includeInlineComments=false skips comment fetching but still writes content', function() {
        var commentCalls = [];
        var writes = {};
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{ id: 'p1', title: 'PROJ-10 Story', body: { storage: { value: 'body' } } }];
            },
            confluence_get_page_inline_comments: function(args) { commentCalls.push(args); return '{}'; },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: {
                target: 'confluence', space: 'DOC', parentPageId: '42',
                includeInlineComments: false
            } }
        }));

        assert.equal(result.action, 'context_fetched');
        assert.equal(commentCalls.length, 0);
        assert.equal(writes['input/PROJ-10/confluence_output_current.md'], 'body');
        assert.equal(writes['input/PROJ-10/confluence_output_comments.md'], undefined);
    });

    test('children lookup failure is non-fatal', function() {
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() { throw new Error('Confluence down'); }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        }));

        assert.equal(result.success, false);
        assert.equal(result.action, 'children_lookup_failed');
    });

});
