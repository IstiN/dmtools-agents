/**
 * Unit tests for js/publishDiscoveryToConfluence.js.
 */

function loadTrackersPd(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

function loadPublishDiscovery(mocks, discoveryConfig) {
    var defaults = {
        confluence_get_children_by_id: function() { return []; },
        confluence_create_page: function(args) { return { id: 'new-page-id', title: args.title, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } }; },
        confluence_update_page: function(args) { return { id: args.contentId, title: args.title, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } }; },
        confluence_content_by_id: function(args) { return { id: args.contentId, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } }; },
        confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index', 'prd'] }); },
        confluence_reply_to_inline_comment: function() {},
        file_read: function(args) {
            var path = (args && args.path) || args;
            // Default to "well-behaved run": response.md exists (so tests unrelated to the
            // new resume-on-missing-response.md check don't trigger it); everything else
            // (e.g. outputs/confluence_replies.json, called as a bare string by
            // contentOutput.js) still behaves like "file not found".
            if (path === 'outputs/response.md') return 'Discovery run summary.';
            throw new Error('no replies file');
        },
        jira_post_comment: function() {}
    };

    var configLoaderMock = {
        loadProjectConfig: function() {
            return { discovery: discoveryConfig || {} };
        }
    };
    var globals = Object.assign({}, defaults, mocks || {});

    return loadModule(
        'js/publishDiscoveryToConfluence.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/trackers.js': loadTrackersPd(globals),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/feedbackLoop.js': (mocks && mocks.__feedbackLoop) || { resumeAgent: function() { return { attempted: false, reason: 'disabled' }; } },
            './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } }, './trackers.js': trackersMock() }),
                globals)
        }),
        globals
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

    test('ado provider: not-configured comment goes through ado_add_work_item_comment, no jira_* (wave1c)', function() {
        var adoComments = [];
        var jiraComments = [];
        var mod = loadPublishDiscovery({
            jira_post_comment: function(args) { jiraComments.push(args); },
            ado_add_work_item_comment: function(args) { adoComments.push(args); }
        }, {});
        var result = mod.action(makeParams({ ticket: { key: '2', fields: { summary: 'S' } }, jobParams: { customParams: { trackerProvider: 'ado' } } }));
        assert.equal(result.action, 'not_configured');
        assert.equal(jiraComments.length, 0);
        assert.equal(adoComments.length, 1);
        assert.contains(adoComments[0].comment, 'not published');
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

    test('posts replies from outputs/confluence_replies.json after sync (same principle as story_solution)', function() {
        var comments = [];
        var replies = [];
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            },
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                if (path === 'outputs/confluence_replies.json') {
                    return JSON.stringify([
                        { pageId: '457', commentId: 'c2', body: 'Addressed in the PRD update.' }
                    ]);
                }
                throw new Error('not found: ' + path);
            },
            confluence_reply_to_inline_comment: function(args) { replies.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.commentRepliesPosted, 1);
        assert.equal(replies.length, 1);
        assert.equal(replies[0].pageId, '457');
        assert.equal(replies[0].commentId, 'c2');
        assert.contains(comments[0].comment, 'Replied to *1* inline comment');
    });

    test('no replies file — publishes normally with commentRepliesPosted 0', function() {
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.commentRepliesPosted, 0);
    });

    test('outputs/response.md missing — resumes the CLI session and re-publishes once the retry succeeds', function() {
        var resumeCalls = [];
        var syncCalls = 0;
        var responseWritten = false;
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            },
            confluence_sync_markdown_directory: function() {
                syncCalls += 1;
                return JSON.stringify({ syncedPages: ['index'] });
            },
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                if (path === 'outputs/response.md') {
                    return responseWritten ? 'Discovery run summary.' : '';
                }
                throw new Error('not found: ' + path);
            },
            __feedbackLoop: {
                resumeAgent: function(options) {
                    resumeCalls.push(options);
                    responseWritten = true; // simulate the resumed CLI run writing the missing file
                    return { attempted: true, attempts: 1 };
                }
            }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(resumeCalls.length, 1);
        assert.equal(resumeCalls[0].stage, 'discovery_final_output');
        assert.equal(resumeCalls[0].ticketKey, 'PROJ-2');
        assert.contains(resumeCalls[0].promptOverride, 'outputs/response.md');
        assert.contains(resumeCalls[0].promptOverride, 'confluence_replies.json');
        assert.equal(syncCalls, 2); // once before resume, once on the recursive retry
        assert.equal(result.success, true);
    });

    test('outputs/response.md missing but resume not attempted (disabled/exhausted) — still publishes with what exists', function() {
        var syncCalls = 0;
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            },
            confluence_sync_markdown_directory: function() {
                syncCalls += 1;
                return JSON.stringify({ syncedPages: ['index'] });
            },
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                throw new Error('not found: ' + path);
            },
            __feedbackLoop: {
                resumeAgent: function() { return { attempted: false, reason: 'disabled' }; }
            }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(syncCalls, 1); // no recursive retry
        assert.equal(result.success, true);
        assert.equal(result.commentRepliesPosted, 0);
    });

    test('children lookup failure returns children_lookup_failed with the error', function() {
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() { throw new Error('confluence down'); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, false);
        assert.equal(result.action, 'children_lookup_failed');
        assert.contains(result.error, 'confluence down');
    });

    test('non-JSON sync summary falls back to { raw } and reports 0 synced pages', function() {
        var comments = [];
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            },
            confluence_sync_markdown_directory: function() { return 'not-json{{{'; },
            jira_post_comment: function(args) { comments.push(args); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.syncedPages, 0);
        assert.contains(comments[0].comment, 'Synced *0* page(s)');
    });

    test('page URL resolution failure publishes without the Page: link', function() {
        var comments = [];
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } }, _links: { webui: '/spaces/DISC/pages/456' } }];
            },
            confluence_content_by_id: function() { throw new Error('lookup down'); },
            jira_post_comment: function(args) { comments.push(args); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.pageUrl, null);
        assert.notContains(comments[0].comment, 'Page:');
        assert.contains(comments[0].comment, 'Synced *2* page(s)');
    });

    test('failed inline-comment replies are reported in the published comment', function() {
        var comments = [];
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
            },
            file_read: function(opts) {
                var path = opts && (opts.path || opts);
                if (path === 'outputs/confluence_replies.json') {
                    return JSON.stringify([
                        { pageId: '457', commentId: 'c2', body: 'Addressed.' },
                        { pageId: '457', commentId: 'c3', body: 'Declined.' }
                    ]);
                }
                throw new Error('not found: ' + path);
            },
            confluence_reply_to_inline_comment: function(args) {
                if (args.commentId === 'c3') throw new Error('reply rejected');
            },
            jira_post_comment: function(args) { comments.push(args); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.commentRepliesPosted, 1);
        assert.equal(result.commentRepliesFailed, 1);
        assert.contains(comments[0].comment, 'Replied to *1* inline comment');
        assert.contains(comments[0].comment, '(1 reply attempt(s) failed — see job log.)');
    });

    test('rename falls back to an empty paragraph body when the listed page has none', function() {
        var updateArgs = null;
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() {
                return [{ id: '456', title: 'PROJ-2 Old' }];
            },
            confluence_update_page: function(args) {
                updateArgs = args;
                return { id: '456', title: args.title, _links: { webui: '/wiki/spaces/DISC/pages/1', base: 'https://confluence.example.com' } };
            }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams({ ticket: { key: 'PROJ-2', fields: { summary: 'New summary' } } }));

        assert.equal(result.success, true);
        assert.equal(updateArgs.body, '<p></p>');
    });

});

// ── gh-1187 CRAP split: characterization tests for the extracted helpers ────

// Loader variant with a fully mocked contentOutput module (the default loader
// wires the real one; the publishCommentReplies-throws test needs a throwing one).
function loadPublishDiscoveryWithRepliesModule(repliesModuleMock, mocks, discoveryConfig) {
    var globals = {
        confluence_get_children_by_id: function() {
            return [{ id: '456', title: 'PROJ-2 Some feature', body: { storage: { value: '' } } }];
        },
        confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index'] }); },
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            if (path === 'outputs/response.md') { return 'Discovery run summary.'; }
            throw new Error('not found: ' + path);
        },
        jira_post_comment: function() {}
    };
    for (var k in (mocks || {})) { globals[k] = mocks[k]; }
    return loadModule(
        'js/publishDiscoveryToConfluence.js',
        makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return { discovery: discoveryConfig || {} }; } },
            './common/trackers.js': loadTrackersPd(globals),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/feedbackLoop.js': { resumeAgent: function() { return { attempted: false }; } },
            './common/contentOutput.js': repliesModuleMock
        }),
        globals
    );
}

suite('publishDiscoveryToConfluence — gh-1187 extracted helpers', function() {

    test('ticketSummaryOf: summary or empty string', function() {
        var mod = loadPublishDiscovery({});
        assert.equal(mod.ticketSummaryOf({ ticket: { key: 'P-1', fields: { summary: 'Sum' } } }), 'Sum');
        assert.equal(mod.ticketSummaryOf({ ticket: { key: 'P-1' } }), '');
        assert.equal(mod.ticketSummaryOf({ ticket: { key: 'P-1', fields: {} } }), '');
    });

    test('syncedCountOf: array length, with a 0 fallback', function() {
        var mod = loadPublishDiscovery({});
        assert.equal(mod.syncedCountOf({ syncedPages: ['a', 'b'] }), 2);
        assert.equal(mod.syncedCountOf({}), 0);
        assert.equal(mod.syncedCountOf({ syncedPages: [] }), 0);
    });

    test('isUnconfiguredDiscovery: missing space or parentPageId', function() {
        var mod = loadPublishDiscovery({});
        assert.equal(mod.isUnconfiguredDiscovery({ space: 'S', parentPageId: '1' }), false);
        assert.equal(mod.isUnconfiguredDiscovery({ space: null, parentPageId: '1' }), true);
        assert.equal(mod.isUnconfiguredDiscovery({ space: 'S', parentPageId: null }), true);
    });

    test('buildPublishedResult: success payload mirrors the original shape, with and without replies', function() {
        var mod = loadPublishDiscovery({});
        var page = { id: 'p1' };
        var r = mod.buildPublishedResult('PROJ-2', page, 'https://x', 3, { posted: 2, failed: 1 });
        assert.deepEqual(r, {
            success: true, action: 'published', ticketKey: 'PROJ-2', pageId: 'p1',
            pageUrl: 'https://x', syncedPages: 3, commentRepliesPosted: 2, commentRepliesFailed: 1
        });
        var r0 = mod.buildPublishedResult('PROJ-2', page, null, 0, { posted: 0, failed: 0 });
        assert.equal(r0.pageUrl, null);
        assert.equal(r0.commentRepliesPosted, 0);
    });

    test('fetchParentChildren: children payload on success, error marker on failure', function() {
        var mod = loadPublishDiscovery({
            confluence_get_children_by_id: function() { return [{ id: 'c1' }]; }
        }, { space: 'DISC', parentPageId: '123' });
        var ok = mod.fetchParentChildren('123');
        assert.equal(ok.children.length, 1);

        var failing = loadPublishDiscovery({
            confluence_get_children_by_id: function() { throw new Error('boom'); }
        }, { space: 'DISC', parentPageId: '123' });
        assert.contains(failing.fetchParentChildren('123').error, 'boom');
    });

    test('ensureTicketPage: create / rename / reuse branches', function() {
        var mod = loadPublishDiscovery({
            confluence_create_page: function(args) { return { id: 'created', title: args.title }; },
            confluence_update_page: function(args) { return { id: args.contentId, title: args.title }; }
        }, { space: 'DISC', parentPageId: '123' });
        var ctx = { space: 'DISC', parentPageId: '123' };

        var created = mod.ensureTicketPage(ctx, [], 'PROJ-2', 'PROJ-2 Title');
        assert.equal(created.id, 'created');

        var renamed = mod.ensureTicketPage(ctx, [{ id: '456', title: 'PROJ-2 Old', body: { storage: { value: '<p>x</p>' } } }], 'PROJ-2', 'PROJ-2 New');
        assert.equal(renamed.id, '456');
        assert.equal(renamed.title, 'PROJ-2 New');

        var reused = mod.ensureTicketPage(ctx, [{ id: '456', title: 'PROJ-2 Same', body: { storage: { value: '' } } }], 'PROJ-2', 'PROJ-2 Same');
        assert.equal(reused.id, '456');
        assert.equal(reused.title, 'PROJ-2 Same');
    });

    test('resumeIfFinalOutputMissing: false when response.md exists; true only when the resume is attempted', function() {
        var mod = loadPublishDiscovery({});
        assert.equal(mod.resumeIfFinalOutputMissing(makeParams(), 'PROJ-2'), false, 'response.md present → no resume');

        var resuming = loadPublishDiscovery({
            file_read: function() { throw new Error('not found'); },
            __feedbackLoop: { resumeAgent: function() { return { attempted: true }; } }
        }, { space: 'DISC', parentPageId: '123' });
        assert.equal(resuming.resumeIfFinalOutputMissing(makeParams(), 'PROJ-2'), true);

        var declining = loadPublishDiscovery({
            file_read: function() { throw new Error('not found'); },
            __feedbackLoop: { resumeAgent: function() { return { attempted: false }; } }
        }, { space: 'DISC', parentPageId: '123' });
        assert.equal(declining.resumeIfFinalOutputMissing(makeParams(), 'PROJ-2'), false);
    });

    test('action without jobParams (root-level customParams) publishes normally', function() {
        var mod = loadPublishDiscovery({}, { space: 'DISC', parentPageId: '123' });

        var result = mod.action({
            ticket: { key: 'PROJ-7', fields: { summary: 'No jobParams' } },
            customParams: { anything: true }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'published');
    });

    test('response.md missing without jobParams — customParams fallback reached, resume declined, publish continues', function() {
        var mod = loadPublishDiscovery({
            file_read: function(opts) { throw new Error('not found: ' + (opts && (opts.path || opts))); },
            __feedbackLoop: { resumeAgent: function() { return { attempted: false, reason: 'disabled' }; } }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action({
            ticket: { key: 'PROJ-8', fields: { summary: 'S' } },
            customParams: { trackerProvider: 'jira' }
        });

        assert.equal(result.success, true);
        assert.equal(result.commentRepliesPosted, 0);
    });

    test('published-comment postComment failure is non-fatal — publish result returned', function() {
        var mod = loadPublishDiscovery({
            jira_post_comment: function() { throw new Error('jira comment api down'); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, true);
        assert.equal(result.action, 'published');
    });

    test('sync failure with a failing failure-comment post — still returns the error result', function() {
        var mod = loadPublishDiscovery({
            confluence_sync_markdown_directory: function() { throw new Error('sync boom'); },
            jira_post_comment: function() { throw new Error('comment boom'); }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, false);
        assert.equal(result.action, 'error');
        assert.contains(result.error, 'sync boom');
    });

    test('not-configured comment failure is non-fatal — not_configured result returned', function() {
        var mod = loadPublishDiscovery({
            jira_post_comment: function() { throw new Error('comment boom'); }
        }, {});

        var result = mod.action(makeParams());

        assert.equal(result.action, 'not_configured');
        assert.equal(result.success, false);
    });

    test('collectReplyResult: a throwing publishCommentReplies is contained (posted 0)', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(m) { warns.push(m); };
        var mod = loadPublishDiscoveryWithRepliesModule({
            publishCommentReplies: function() { throw new Error('replies boom'); }
        }, {}, { space: 'DISC', parentPageId: '123' });
        try {
            var result = mod.action(makeParams());
        } finally {
            console.warn = origWarn;
        }
        assert.equal(result.success, true);
        assert.equal(result.commentRepliesPosted, 0);
        assert.equal(warns.some(function(m) { return String(m).indexOf('Failed to publish inline comment replies') !== -1; }), true);
    });

});


