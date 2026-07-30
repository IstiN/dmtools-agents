/**
 * Unit tests for js/publishDiscoveryToConfluence.js.
 */

function loadPublishDiscovery(mocks, discoveryConfig) {
    var defaults = {
        confluence_get_children_by_id: function() { return []; },
        confluence_create_page: function(args) { return { id: 'new-page-id', title: args.title, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } }; },
        confluence_update_page: function(args) { return { id: args.contentId, title: args.title, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } }; },
        confluence_content_by_id: function(args) { return { id: args.contentId, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } }; },
        confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index', 'prd'] }); },
        jira_post_comment: function() {}
    };

    var configLoaderMock = {
        loadProjectConfig: function() {
            return { discovery: discoveryConfig || {} };
        }
    };

    return loadModule(
        'js/publishDiscoveryToConfluence.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
        }),
        Object.assign({}, defaults, mocks || {})
    );
}

function makeParams(overrides) {
    return Object.assign({
        ticket: { key: 'PROJ-2', fields: { summary: 'Some feature' } },
        jobParams: {}
    }, overrides || {});
}

suite('publishDiscoveryToConfluence', function() {

    test('missing ticket key returns failure without touching Confluence', function() {
        var called = false;
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() { called = true; return []; }
        });

        var result = mod.action({ ticket: {} });

        assert.equal(result.success, false);
        assert.equal(result.action, 'missing_ticket');
        assert.equal(called, false);
    });

    test('not configured — posts explanatory Jira comment, does not query Confluence', function() {
        var queried = false;
        var comments = [];
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() { queried = true; return []; },
            jira_post_comment: function(args) { comments.push(args); }
        }, {});

        var result = mod.action(makeParams());

        assert.equal(result.action, 'not_configured');
        assert.equal(queried, false);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'not published');
    });

    test('creates a new ticket page when none exists, then syncs and comments', function() {
        var created = null;
        var synced = null;
        var comments = [];
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function(args) {
                created = args;
                return { id: 'page-1', title: args.title, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } };
            },
            confluence_sync_markdown_directory: function(args) {
                synced = args;
                return JSON.stringify({ syncedPages: ['index', 'prd', 'discovery-plan'] });
            },
            jira_post_comment: function(args) { comments.push(args); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.action, 'published');
        assert.equal(result.pageId, 'page-1');
        assert.equal(result.syncedPages, 3);
        assert.equal(created.title, 'PROJ-2 Some feature');
        assert.equal(created.parentId, '123');
        assert.equal(created.space, 'DISC');
        assert.equal(synced.directory, 'outputs/discovery');
        assert.equal(synced.parentId, 'page-1');
        assert.equal(synced.space, 'DISC');
        assert.equal(synced.deleteOrphans, false);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'https://confluence.example.com/wiki/spaces/DISC/pages/1');
        assert.contains(comments[0].comment, '3');
    });

    test('reuses existing ticket page matched by ticket-key prefix, does not recreate', function() {
        var createCalled = false;
        var updateCalled = false;
        var synced = null;
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            },
            confluence_create_page: function() { createCalled = true; return {}; },
            confluence_update_page: function() { updateCalled = true; return {}; },
            confluence_sync_markdown_directory: function(args) {
                synced = args;
                return JSON.stringify({ syncedPages: ['index'] });
            }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.pageId, '456');
        assert.equal(createCalled, false, 'should not create a duplicate page');
        assert.equal(updateCalled, false, 'title unchanged — should not need an update');
        assert.equal(synced.parentId, '456');
    });

    test('resolves a full page URL via a follow-up lookup when the reused page (from children-list) lacks _links.base', function() {
        // Reproduces a real bug: confluence_get_children_by_id's results omit
        // _links.base (only a single-item confluence_content_by_id GET reliably
        // includes it) — the posted Jira comment previously ended up with just
        // the relative webui path (e.g. "/spaces/AINA/pages/...") with no domain,
        // a broken link.
        var comments = [];
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } }, _links: { webui: '/spaces/DISC/pages/456/PROJ-2' } }];
            },
            confluence_content_by_id: function(args) {
                assert.equal(args.contentId, '456');
                return { id: '456', _links: { webui: '/spaces/DISC/pages/456/PROJ-2', base: 'https://confluence.example.com' } };
            },
            jira_post_comment: function(args) { comments.push(args); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.pageUrl, 'https://confluence.example.com/spaces/DISC/pages/456/PROJ-2');
        assert.contains(comments[0].comment, 'https://confluence.example.com/spaces/DISC/pages/456/PROJ-2');
    });

    test('renames existing ticket page when the ticket summary changed', function() {
        var updateArgs = null;
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Old summary', body: { storage: { value: '<p>old</p>' } } }];
            },
            confluence_update_page: function(args) {
                updateArgs = args;
                return { id: '456', title: args.title, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } };
            }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams({ ticket: { key: 'PROJ-2', fields: { summary: 'New summary' } } }));

        assert.equal(result.success, true);
        assert.equal(updateArgs.title, 'PROJ-2 New summary');
        assert.equal(updateArgs.contentId, '456');
    });

    test('deleteOrphans config flows through to the sync call', function() {
        var synced = null;
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            },
            confluence_sync_markdown_directory: function(args) {
                synced = args;
                return JSON.stringify({ syncedPages: [] });
            }
        }, { space: 'DISC', parentPageId: '123', deleteOrphans: true });

        mod.action(makeParams());

        assert.equal(synced.deleteOrphans, true);
    });

    test('sync failure is caught and posts a failure comment', function() {
        var comments = [];
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            },
            confluence_sync_markdown_directory: function() { throw new Error('sync boom'); },
            jira_post_comment: function(args) { comments.push(args); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, false);
        assert.equal(result.action, 'error');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'publish failed');
    });

});
