/**
 * Unit tests for js/fetchConfluenceOutputContext.js.
 */

function loadFetchConfluenceContext(mocks, projectConfig) {
    var configLoaderMock = {
        loadProjectConfig: function() { return projectConfig || {}; }
    };
    var contentOutputLib = loadModule(
        'js/common/contentOutput.js',
        makeRequire({
            '../configLoader.js': configLoaderMock,
            // gh-823: contentOutput requires ./trackers.js at load time
            './trackers.js': trackersMock()
        }),
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

    test('first run — no existing page, but target marker is written', function() {
        var writes = {};
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{ id: 'p9', title: 'OTHER-1 Something else' }];
            },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42', pageTitleSuffix: 'Solution Design' } }
        }));

        assert.equal(result.action, 'first_run');
        assert.equal(writes['input/PROJ-10/confluence_output_current.md'], undefined);
        var marker = JSON.parse(writes['input/PROJ-10/confluence_output_target.json']);
        assert.equal(marker.target, 'confluence');
        assert.equal(marker.format, 'markdown');
        assert.equal(marker.pageTitle, 'PROJ-10 Some story — Solution Design');
    });

    test('no marker written for jira_field target', function() {
        var writes = {};
        var mod = loadFetchConfluenceContext({
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'skipped_not_confluence_target');
        assert.equal(writes['input/PROJ-10/confluence_output_target.json'], undefined);
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

    test('empty list body falls back to a single-item GET (format md)', function() {
        var calls = [];
        var writes = {};
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{ id: 'p1', title: 'PROJ-10 Story', body: { storage: { value: '' } } }];
            },
            confluence_content_by_id: function(args) {
                calls.push(args);
                return { id: 'p1', body: { storage: { value: '# Full body' } } };
            },
            confluence_get_page_inline_comments: function() { return '{"results":[]}'; },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        }));

        assert.equal(result.action, 'context_fetched');
        assert.equal(writes['input/PROJ-10/confluence_output_current.md'], '# Full body');
        var mdCalls = calls.filter(function(c) { return c.format === 'md'; });
        assert.equal(mdCalls.length, 1, 'exactly one md-format follow-up GET');
        assert.equal(mdCalls[0].contentId, 'p1');
    });

    test('inline comment anchors are re-injected as placeholders into the Markdown body', function() {
        var writes = {};
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{ id: 'p1', title: 'PROJ-10 Story', body: { storage: { value: 'Some text with anchor here.' } } }];
            },
            confluence_content_by_id: function(args) {
                if (args.format === 'md') return {};
                return {
                    id: 'p1',
                    body: { storage: { value: '<p>Some <ac:inline-comment-marker ac:ref="c-9">anchor</ac:inline-comment-marker> text.</p>' } }
                };
            },
            confluence_get_page_inline_comments: function() { return '{"results":[]}'; },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        }));

        assert.equal(result.action, 'context_fetched');
        assert.contains(writes['input/PROJ-10/confluence_output_current.md'], '[[ic:c-9]]anchor[[/ic]]');
    });

    test('marker extraction failure is non-fatal — the plain body is still written', function() {
        var writes = {};
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{ id: 'p1', title: 'PROJ-10 Story', body: { storage: { value: 'Plain body' } } }];
            },
            confluence_content_by_id: function(args) {
                if (args.format === 'md') return {};
                throw new Error('storage fetch down');
            },
            confluence_get_page_inline_comments: function() { return '{"results":[]}'; },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        }));

        assert.equal(result.action, 'context_fetched');
        assert.equal(writes['input/PROJ-10/confluence_output_current.md'], 'Plain body');
    });

    test('body fetch failure is non-fatal — comments are still collected', function() {
        var writes = {};
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{ id: 'p1', title: 'PROJ-10 Story' }];
            },
            confluence_content_by_id: function(args) {
                assert.equal(args.format, 'md');
                throw new Error('content down');
            },
            confluence_get_page_inline_comments: function() {
                return JSON.stringify({
                    results: [{
                        id: 'c2',
                        resolutionStatus: 'open',
                        version: { createdAt: '2026-08-21T10:00:00Z' },
                        body: { storage: { value: '<p>Follow-up?</p>' } }
                    }]
                });
            },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        }));

        assert.equal(result.action, 'context_fetched');
        assert.equal(result.commentsCount, 1);
        assert.equal(writes['input/PROJ-10/confluence_output_current.md'], undefined, 'no content file when the body fetch fails');
        assert.contains(writes['input/PROJ-10/confluence_output_comments.md'], 'Follow-up?');
    });

    test('no input folder — marker and content files are skipped, comments not fetched', function() {
        var writes = {};
        var commentCalls = [];
        var mod = loadFetchConfluenceContext({
            confluence_get_children_by_id: function() {
                return [{ id: 'p1', title: 'PROJ-10 Story', body: { storage: { value: 'Body' } } }];
            },
            confluence_content_by_id: function(args) {
                if (args.format === 'md') return {};
                return { id: 'p1', body: { storage: { value: '' } } };
            },
            confluence_get_page_inline_comments: function(args) { commentCalls.push(args); return '{"results":[]}'; },
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action({
            inputFolderPath: null,
            ticket: { key: 'PROJ-10', fields: { summary: 'Some story' } },
            jobParams: {},
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        });

        assert.equal(result.action, 'context_fetched');
        assert.deepEqual(writes, {});
        assert.equal(commentCalls.length, 0);
        assert.equal(result.commentsCount, 0);
    });

});

// ─── gh-119 CRAP: uncovered branches + extracted pure helpers ────────────────

suite('fetchConfluenceOutputContext — uncovered branches (gh-119 characterization)', function() {

    test('ticket key falls back to the input folder name when ticket.key is absent', function() {
        var writes = {};
        var mod = loadFetchConfluenceContext({
            file_write: function(p, c) { writes[p] = c; },
            confluence_get_children_by_id: function() { return []; }
        });
        var result = mod.action({
            inputFolderPath: 'input/PROJ-99',
            ticket: {},
            jobParams: {},
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        });
        assert.equal(result.success, true);
        assert.equal(result.action, 'first_run');
        var marker = JSON.parse(writes['input/PROJ-99/confluence_output_target.json']);
        assert.equal(marker.pageTitle.indexOf('PROJ-99') === 0, true, 'marker page title uses the folder-derived key');
    });

    test('no input folder: marker skipped, comments not fetched, first_run still reported', function() {
        var writes = 0;
        var mod = loadFetchConfluenceContext({
            file_write: function() { writes++; return null; },
            confluence_get_children_by_id: function() { return []; }
        });
        var result = mod.action({
            ticket: { key: 'PROJ-11' },
            jobParams: {},
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        });
        assert.equal(result.action, 'first_run');
        assert.equal(writes, 0);
    });
});

suite('fetchConfluenceOutputContext — pure helpers (gh-119)', function() {
    var mod = loadFetchConfluenceContext({});

    test('resolveTicketKey: ticket.key wins, folder basename fallback, null last', function() {
        assert.equal(mod.resolveTicketKey({ ticket: { key: 'K-1' }, inputFolderPath: 'input/K-2' }), 'K-1');
        assert.equal(mod.resolveTicketKey({ ticket: {}, inputFolderPath: 'input/K-2/sub' }), 'sub');
        assert.equal(mod.resolveTicketKey({ ticket: {}, inputFolderPath: 'input/K-2/' }), '');
        assert.equal(mod.resolveTicketKey({}), null);
        assert.equal(mod.resolveTicketKey({ inputFolderPath: null }), null);
    });

    test('ticketSummary: fields.summary with a no-fields fallback', function() {
        assert.equal(mod.ticketSummary({ fields: { summary: 'S' } }), 'S');
        assert.equal(mod.ticketSummary({ fields: {} }), '');
        assert.equal(mod.ticketSummary({}), '');
        assert.equal(mod.ticketSummary(null), '');
    });

    test('existingPageTitle: page title wins, ticketKey fallback', function() {
        assert.equal(mod.existingPageTitle({ title: 'T' }, 'K'), 'T');
        assert.equal(mod.existingPageTitle({}, 'K'), 'K');
        assert.equal(mod.existingPageTitle({ title: '' }, 'K'), 'K');
    });

    test('scm-agnostic target marker shape', function() {
        var cfg = { target: 'confluence', space: 'DOC', parentPageId: '42' };
        assert.deepEqual(mod.buildTargetMarker(cfg, 'Title'), {
            target: 'confluence', format: 'markdown', pageTitle: 'Title', space: 'DOC', parentPageId: '42'
        });
    });
});
