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
