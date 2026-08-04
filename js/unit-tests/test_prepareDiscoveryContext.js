/**
 * Unit tests for js/prepareDiscoveryContext.js.
 */

function loadPrepareDiscoveryContext(mocks, discoveryConfig) {
    var defaults = {
        confluence_get_children_by_id: function() { return []; },
        confluence_content_by_id: function() { return { body: { storage: { value: '' } } }; },
        file_write: function() {}
    };

    var configLoaderMock = {
        loadProjectConfig: function() {
            return { discovery: discoveryConfig || {} };
        }
    };

    return loadModule(
        'js/prepareDiscoveryContext.js',
        makeRequire({
            './configLoader.js': configLoaderMock
        }),
        Object.assign({}, defaults, mocks || {})
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
