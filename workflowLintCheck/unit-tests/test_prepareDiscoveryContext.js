/**
 * Unit tests for js/prepareDiscoveryContext.js.
 */

function loadPrepareDiscoveryContext(mocks, discoveryConfig) {
    var defaults = {
        confluence_get_children_by_id: function() { return []; },
        confluence_content_by_id: function() { return { body: { storage: { value: '' } } }; },
        confluence_get_page_inline_comments: function() { return '{}'; },
        file_write: function() {}
    };

    var configLoaderMock = {
        loadProjectConfig: function() {
            return { discovery: discoveryConfig || {} };
        }
    };
    var globals = Object.assign({}, defaults, mocks || {});

    return loadModule(
        'js/prepareDiscoveryContext.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } } }),
                globals)
        }),
        globals
    );
}

function makeParams(overrides) {
    return Object.assign({
        inputFolderPath: 'input/PROJ-2',
        ticket: { key: 'PROJ-2' },
        jobParams: {}
    }, overrides || {});
}

suite('prepareDiscoveryContext', function() {

    test('not configured — writes meta with nulls and does not query Confluence', function() {
        var queried = false;
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() { queried = true; return []; },
            file_write: function(p, c) { writes[p] = c; }
        }, {});

        var result = mod.action(makeParams());

        assert.equal(result.action, 'not_configured');
        assert.equal(queried, false, 'should not query Confluence when not configured');
        var meta = JSON.parse(writes['input/PROJ-2/discovery_meta.json']);
        assert.equal(meta.space, null);
        assert.equal(meta.parentPageId, null);
        assert.equal(meta.existingPageId, null);
    });

    test('first run — no existing page found for ticket key', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() {
                return [{ id: '999', title: 'OTHER-1 Unrelated ticket' }];
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'first_run');
        var meta = JSON.parse(writes['input/PROJ-2/discovery_meta.json']);
        assert.equal(meta.space, 'DISC');
        assert.equal(meta.parentPageId, '123');
        assert.equal(meta.existingPageId, null);
    });

    test('iteration — existing page found, seeds outputs/discovery/ with root + children content', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') {
                    return [{ id: '456', title: 'PROJ-2 Some feature' }];
                }
                if (args.contentId === '456') {
                    return [
                        { id: '457', title: 'PRD', body: { storage: { value: '# PRD\ncontent' } } }
                    ];
                }
                return [];
            },
            confluence_content_by_id: function(args) {
                assert.equal(args.contentId, '456');
                return { body: { storage: { value: '# Index\nlanding page' } } };
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'iteration');
        assert.equal(result.existingPageId, '456');
        assert.equal(result.snapshottedPages, 1);
        assert.equal(writes['outputs/discovery/index.md'], '# Index\nlanding page');
        assert.equal(writes['outputs/discovery/PRD.md'], '# PRD\ncontent');

        var meta = JSON.parse(writes['input/PROJ-2/discovery_meta.json']);
        assert.equal(meta.existingPageId, '456');
    });

    test('iteration — recursively seeds a MULTI-LEVEL tree (grandchildren into a subfolder)', function() {
        // Mirrors a real, mature discovery page tree that has grown nested
        // sub-trees over time: root -> "Topic Area" (a child with its OWN
        // children) -> "Detail Page" (a leaf grandchild), alongside a plain
        // leaf child ("PRD"). Before the recursive fix, only the direct
        // children (root's own level) were snapshotted, silently dropping
        // "Detail Page" from the seeded outputs/discovery/ tree.
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_content_by_id: function(args) {
                if (args.contentId === '456') return { body: { storage: { value: '# Index\nroot body' } } };
                if (args.contentId === '500') return { body: { storage: { value: '# Topic Area\nintro' } } };
                return { body: { storage: { value: '' } } };
            },
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') {
                    return [{ id: '456', title: 'PROJ-2 Some feature' }];
                }
                if (args.contentId === '456') {
                    return [
                        { id: '457', title: 'PRD', body: { storage: { value: '# PRD\ncontent' } } },
                        { id: '500', title: 'Topic Area' }
                    ];
                }
                if (args.contentId === '500') {
                    return [
                        { id: '501', title: 'Detail Page', body: { storage: { value: '# Detail Page\nnested content' } } }
                    ];
                }
                return [];
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'iteration');
        // 3 descendants total: PRD (leaf), Topic Area (branch), Detail Page (leaf grandchild)
        assert.equal(result.snapshottedPages, 3);
        assert.equal(writes['outputs/discovery/index.md'], '# Index\nroot body');
        assert.equal(writes['outputs/discovery/PRD.md'], '# PRD\ncontent');
        // The branch child becomes a SUBFOLDER with its own index.md ...
        assert.equal(writes['outputs/discovery/Topic Area/index.md'], '# Topic Area\nintro');
        // ... and its own child becomes a leaf file inside that subfolder.
        assert.equal(writes['outputs/discovery/Topic Area/Detail Page.md'], '# Detail Page\nnested content');
    });

    test('iteration — collects inline comments across the whole tree into discovery_comments.md/json', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') {
                    return [{ id: '456', title: 'PROJ-2 Some feature' }];
                }
                if (args.contentId === '456') {
                    return [{ id: '457', title: 'PRD', body: { storage: { value: '# PRD\ncontent' } } }];
                }
                return [];
            },
            confluence_content_by_id: function(args) {
                return { body: { storage: { value: '' } } };
            },
            confluence_get_page_inline_comments: function(args) {
                if (args.pageId === '456') {
                    return JSON.stringify({ results: [{ id: 'c1', resolutionStatus: 'open', body: 'Root comment' }] });
                }
                if (args.pageId === '457') {
                    return JSON.stringify({ results: [{ id: 'c2', resolutionStatus: 'open', body: 'PRD comment' }] });
                }
                return '{}';
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'iteration');
        assert.equal(result.commentsCount, 2);
        var commentsJson = JSON.parse(writes['input/PROJ-2/discovery_comments.json']);
        assert.equal(commentsJson.comments.length, 2);
        assert.equal(commentsJson.comments[0].pageId, '456');
        assert.equal(commentsJson.comments[0].commentId, 'c1');
        assert.equal(commentsJson.comments[1].pageId, '457');
        assert.equal(commentsJson.comments[1].commentId, 'c2');
        assert.contains(writes['input/PROJ-2/discovery_comments.md'], 'Root comment');
        assert.contains(writes['input/PROJ-2/discovery_comments.md'], 'PRD comment');
    });

    test('iteration — no comments anywhere in the tree does not write discovery_comments files', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') return [{ id: '456', title: 'PROJ-2 Some feature' }];
                return [];
            },
            confluence_get_page_inline_comments: function() { return '{}'; },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        mod.action(makeParams());

        assert.equal(writes['input/PROJ-2/discovery_comments.json'], undefined);
        assert.equal(writes['input/PROJ-2/discovery_comments.md'], undefined);
    });

    test('iteration — inline comment anchors are re-exposed as [[ic:REF]] placeholders in the snapshotted body', function() {
        var writes = {};
        var REF = 'a40ec14d-0d73-4f55-9a69-7026900b6623';
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') return [{ id: '456', title: 'PROJ-2 Some feature' }];
                return [];
            },
            confluence_content_by_id: function(args) {
                // First call (format:'md') returns the Markdown body; the second,
                // format-less call (from injectCommentAnchors) returns the storage
                // XML carrying the actual marker.
                if (args.format === 'md') {
                    return { body: { storage: { value: '# Index\nSome important text here.' } } };
                }
                return { body: { storage: { value: '<p>Some <ac:inline-comment-marker ac:ref="' + REF + '">important text</ac:inline-comment-marker> here.</p>' } } };
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        mod.action(makeParams());

        assert.contains(writes['outputs/discovery/index.md'], '[[ic:' + REF + ']]important text[[/ic]]');
    });

    test('ticket-key prefix matching ignores tickets with the key as a substring elsewhere', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() {
                return [{ id: '999', title: 'Something mentions PROJ-2 but is not it' }];
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'first_run');
    });

    test('children lookup failure is resilient — returns failure without throwing', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() { throw new Error('Confluence unavailable'); },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, false);
        assert.equal(result.action, 'children_lookup_failed');
        assert.contains(writes['input/PROJ-2/discovery_meta.json'], '"space": "DISC"');
    });

});
