/**
 * Unit tests for js/writeContentOutput.js and js/common/contentOutput.js.
 */

function loadContentOutputLib(mocks, projectConfig) {
    var configLoaderMock = {
        loadProjectConfig: function() { return projectConfig || {}; }
    };
    return loadModule(
        'js/common/contentOutput.js',
        makeRequire({ '../configLoader.js': configLoaderMock }),
        Object.assign({}, mocks || {})
    );
}

function loadWriteContentOutput(mocks, projectConfig, extraModules) {
    var configLoaderMock = {
        loadProjectConfig: function() { return projectConfig || {}; }
    };
    var modules = {
        './common/contentOutput.js': loadContentOutputLib(mocks, projectConfig),
        './common/outputFiles.js': (extraModules && extraModules.outputFiles) || {
            readOutputFile: function(name) { return (mocks.__outputs || {})[name] || null; }
        },
        './common/jiraHelpers.js': (extraModules && extraModules.jiraHelpers) || {
            assignForReview: function() { (mocks.__assignCalls = mocks.__assignCalls || []).push(true); return { success: true }; }
        },
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './config.js': { STATUSES: { IN_REVIEW: 'In Review' } },
        './configLoader.js': configLoaderMock
    };
    return loadModule('js/writeContentOutput.js', makeRequire(modules), Object.assign({}, mocks || {}));
}

function makeParams(overrides) {
    return Object.assign({
        ticket: { key: 'PROJ-10', fields: { summary: 'Some story' } },
        initiator: 'user-1',
        metadata: { contextId: 'story_description' },
        jobParams: {}
    }, overrides || {});
}

suite('contentOutput lib', function() {

    test('resolveConfig defaults to jira_field target', function() {
        var lib = loadContentOutputLib({});
        var cfg = lib.resolveConfig(makeParams());
        assert.equal(cfg.target, 'jira_field');
        assert.equal(cfg.operationType, 'replace');
        assert.equal(cfg.includeInlineComments, true);
    });

    test('customParams.contentOutput overrides defaults', function() {
        var lib = loadContentOutputLib({});
        var cfg = lib.resolveConfig(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42', pageTitleSuffix: 'Solution Design' } }
        }));
        assert.equal(cfg.target, 'confluence');
        assert.equal(cfg.space, 'DOC');
        assert.equal(cfg.pageTitleSuffix, 'Solution Design');
    });

    test('caller defaults lose to customParams but fill gaps', function() {
        var lib = loadContentOutputLib({});
        var cfg = lib.resolveConfig(makeParams({
            customParams: { contentOutput: { target: 'confluence', space: 'DOC', parentPageId: '42' } }
        }), { target: 'jira_field', field: 'Solution', pageTitleSuffix: 'Solution Design' });
        assert.equal(cfg.target, 'confluence', 'customParams target must win over caller defaults');
        assert.equal(cfg.field, 'Solution', 'caller default fills missing field');
        assert.equal(cfg.pageTitleSuffix, 'Solution Design');
    });

    test('buildPageTitle adds suffix', function() {
        var lib = loadContentOutputLib({});
        var title = lib.buildPageTitle({ pageTitleSuffix: 'Solution Design' }, 'PROJ-10', 'Some story');
        assert.equal(title, 'PROJ-10 Some story — Solution Design');
        assert.equal(lib.buildPageTitle({}, 'PROJ-10', ''), 'PROJ-10');
    });

    test('writeToTrackerField replace mode writes content as-is', function() {
        var calls = [];
        var lib = loadContentOutputLib({
            jira_update_field: function(args) { calls.push(args); }
        });
        lib.writeToTrackerField('PROJ-10', 'Description', '# Hello', 'replace');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].value, '# Hello');
    });

    test('writeToTrackerField append mode merges with existing wiki content', function() {
        var calls = [];
        var lib = loadContentOutputLib({
            jira_get_ticket: function() { return { fields: { Description: 'old content' } }; },
            jira_update_field: function(args) { calls.push(args); }
        });
        lib.writeToTrackerField('PROJ-10', 'Description', 'new', 'append');
        assert.equal(calls[0].value, 'old content\n\n----\n\nnew');
    });

    test('writeToTrackerField append falls back to replace on ADF value', function() {
        var calls = [];
        var lib = loadContentOutputLib({
            jira_get_ticket: function() { return { fields: { Description: { type: 'doc', content: [] } } }; },
            jira_update_field: function(args) { calls.push(args); }
        });
        lib.writeToTrackerField('PROJ-10', 'Description', 'new', 'append');
        assert.equal(calls[0].value, 'new');
    });

    test('publishPage creates a page when none exists', function() {
        var created = null;
        var synced = null;
        var writes = {};
        var lib = loadContentOutputLib({
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function(args) {
                created = args;
                return { id: 'p1', _links: { webui: '/pages/p1', base: 'https://wiki.example.com' } };
            },
            confluence_sync_markdown_directory: function(args) {
                synced = args;
                return JSON.stringify({ syncedPages: ['index'] });
            },
            file_write: function(p, c) { writes[p] = c; }
        });
        var result = lib.publishPage({ space: 'DOC', parentPageId: '42' }, 'PROJ-10', 'Some story', 'body text');
        assert.equal(result.created, true);
        assert.equal(created.title, 'PROJ-10 Some story');
        assert.equal(result.url, 'https://wiki.example.com/pages/p1');
        assert.equal(synced.parentId, 'p1');
        assert.equal(writes['outputs/confluence_sync_PROJ-10/index.md'], 'body text');
    });

    test('publishPage updates existing page matched by ticket-key prefix', function() {
        var updated = null;
        var synced = null;
        var lib = loadContentOutputLib({
            confluence_get_children_by_id: function() {
                return [{ id: 'p9', title: 'PROJ-10 Old title', body: { storage: { value: 'old' } } }];
            },
            confluence_update_page: function(args) {
                updated = args;
                return { id: 'p9', _links: { webui: '/pages/p9', base: 'https://wiki.example.com' } };
            },
            confluence_create_page: function() { throw new Error('must not create'); },
            confluence_sync_markdown_directory: function(args) {
                synced = args;
                return JSON.stringify({ syncedPages: ['index'] });
            },
            file_write: function() {}
        });
        var result = lib.publishPage({ space: 'DOC', parentPageId: '42' }, 'PROJ-10', 'New summary', 'new body');
        assert.equal(result.created, false);
        assert.equal(updated.contentId, 'p9');
        assert.equal(updated.title, 'PROJ-10 New summary');
        assert.equal(synced.parentId, 'p9');
    });

    test('publishPage fails without space/parentPageId', function() {
        var lib = loadContentOutputLib({});
        var threw = false;
        try {
            lib.publishPage({}, 'PROJ-10', 'x', 'y');
        } catch (e) { threw = true; }
        assert.equal(threw, true);
    });

    test('fetchPageInlineComments normalizes API v2 results', function() {
        var lib = loadContentOutputLib({
            confluence_get_page_inline_comments: function(args) {
                assert.equal(args.pageId, 'p1');
                return JSON.stringify({
                    results: [
                        {
                            id: 'c1',
                            resolutionStatus: 'open',
                            version: { createdAt: '2026-08-01T00:00:00Z' },
                            body: { storage: { value: '<p>Check this</p>' } }
                        },
                        {
                            id: 'c2',
                            resolutionStatus: 'resolved',
                            body: { storage: { value: '<p>Done</p>' } }
                        }
                    ]
                });
            }
        });
        var comments = lib.fetchPageInlineComments('p1', 'Page', 100);
        assert.equal(comments.length, 2);
        assert.equal(comments[0].commentId, 'c1');
        assert.equal(comments[0].resolved, false);
        assert.equal(comments[0].created, '2026-08-01T00:00:00Z');
        assert.equal(comments[1].resolved, true);
        assert.contains(comments[0].body, 'Check this');
    });

    test('publishCommentReplies posts replies from the replies file', function() {
        var replies = [];
        var lib = loadContentOutputLib({
            file_read: function() {
                return JSON.stringify([{ pageId: 'p1', commentId: 'c1', body: 'Fixed' }]);
            },
            confluence_reply_to_inline_comment: function(args) { replies.push(args); }
        });
        var result = lib.publishCommentReplies('outputs/confluence_replies.json');
        assert.equal(result.posted, 1);
        assert.equal(result.failed, 0);
        assert.equal(replies[0].commentId, 'c1');
    });

    test('publishCommentReplies ignores missing file and skips invalid entries', function() {
        var replies = [];
        var lib = loadContentOutputLib({
            file_read: function() { throw new Error('not found'); },
            confluence_reply_to_inline_comment: function(args) { replies.push(args); }
        });
        var result = lib.publishCommentReplies('outputs/confluence_replies.json');
        assert.equal(result.posted, 0);
        assert.equal(replies.length, 0);
    });

});

suite('writeContentOutput', function() {

    test('jira_field target writes response.md to the field (backward compat)', function() {
        var fieldCalls = [];
        var mocks = {
            __outputs: { 'response.md': '# Description\n\nContent here' },
            jira_update_field: function(args) { fieldCalls.push(args); }
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'jira_field', field: 'Description' } }
        }));

        assert.equal(result.success, true);
        assert.equal(fieldCalls.length, 1);
        assert.equal(fieldCalls[0].field, 'Description');
        assert.contains(fieldCalls[0].value, 'Content here');
    });

    test('missing response.md returns failure', function() {
        var mod = loadWriteContentOutput({ __outputs: {} });
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'jira_field', field: 'Description' } }
        }));
        assert.equal(result.success, false);
        assert.contains(result.error, 'response.md');
    });

    test('confluence target publishes page and writes link to the field', function() {
        var fieldCalls = [];
        var mocks = {
            __outputs: { 'response.md': '# Solution' },
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function(args) {
                return { id: 'p1', _links: { webui: '/pages/p1', base: 'https://wiki.example.com' } };
            },
            confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index'] }); },
            file_write: function() {},
            jira_update_field: function(args) { fieldCalls.push(args); },
            jira_post_comment: function() {}
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: {
                target: 'confluence', field: 'Solution',
                space: 'DOC', parentPageId: '42'
            } }
        }));

        assert.equal(result.success, true);
        assert.equal(result.pageId, 'p1');
        assert.equal(result.pageUrl, 'https://wiki.example.com/pages/p1');
        assert.equal(fieldCalls.length, 1);
        assert.contains(fieldCalls[0].value, 'https://wiki.example.com/pages/p1');
    });

    test('both target writes field content AND publishes page', function() {
        var fieldCalls = [];
        var mocks = {
            __outputs: { 'response.md': '# AC' },
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function() {
                return { id: 'p2', _links: { webui: '/pages/p2', base: 'https://wiki.example.com' } };
            },
            confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index'] }); },
            file_write: function() {},
            jira_update_field: function(args) { fieldCalls.push(args); },
            jira_post_comment: function() {}
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: {
                target: 'both', field: 'Acceptance Criteria',
                space: 'DOC', parentPageId: '42'
            } }
        }));

        assert.equal(result.success, true);
        assert.equal(fieldCalls.length, 1);
        assert.contains(fieldCalls[0].value, '# AC');
        assert.equal(result.pageId, 'p2');
    });

    test('thenAction is chained after a successful write', function() {
        var chainedParams = null;
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadWriteContentOutput(mocks, null, {
            jiraHelpers: { assignForReview: function() { throw new Error('must not run when thenAction set'); } }
        });
        // makeRequire resolves './assignForSolutionArchitecture.js'
        var innerMod = loadModule('js/writeContentOutput.js', makeRequire({
            './common/contentOutput.js': loadContentOutputLib(mocks),
            './common/outputFiles.js': { readOutputFile: function() { return 'content'; } },
            './common/jiraHelpers.js': { assignForReview: function() { throw new Error('must not run'); } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './config.js': { STATUSES: { IN_REVIEW: 'In Review' } },
            './assignForSolutionArchitecture.js': {
                action: function(p) { chainedParams = p; return { success: true }; }
            }
        }), mocks);

        var result = innerMod.action(makeParams({
            customParams: { contentOutput: {
                target: 'jira_field', field: 'Acceptance Criteria',
                thenAction: 'assignForSolutionArchitecture.js'
            } }
        }));

        assert.equal(result.success, true);
        assert.equal(result.thenAction, 'assignForSolutionArchitecture.js');
        assert.notEqual(chainedParams, null);
        assert.equal(chainedParams.ticket.key, 'PROJ-10');
    });

    test('assignForReview runs by default when no thenAction', function() {
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'jira_field', field: 'Description' } }
        }));
        assert.equal(result.success, true);
        assert.equal((mocks.__assignCalls || []).length, 1);
    });

});
