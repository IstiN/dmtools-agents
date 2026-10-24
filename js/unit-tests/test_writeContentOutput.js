/**
 * Unit tests for js/writeContentOutput.js and js/common/contentOutput.js.
 */

function loadContentOutputLib(mocks, projectConfig) {
    var configLoaderMock = {
        loadProjectConfig: function() { return projectConfig || {}; }
    };
    return loadModule(
        'js/common/contentOutput.js',
        makeRequire({
            '../configLoader.js': configLoaderMock,
            './trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), Object.assign({}, mocks || {})),
            './mergeObjects.js': loadModule('js/common/mergeObjects.js', makeRequire({}))
        }),
        Object.assign({}, mocks || {})
    );
}

function loadTrackersWc(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

/**
 * Default implementations for the overridable './common/*' requires of
 * js/writeContentOutput.js. Keyed by short name; loadWriteContentOutput
 * resolves overrides against these without adding a decision per require.
 */
var WCO_DEFAULT_MODULES = {
    outputFiles: function(mocks) {
        return {
            readOutputFile: function(name) { return (mocks.__outputs || {})[name] || null; }
        };
    },
    jiraHelpers: function(mocks) {
        return {
            assignForReview: function() {
                (mocks.__assignCalls = mocks.__assignCalls || []).push(true);
                return { success: true };
            }
        };
    },
    tokenUsageComment: function() {
        return { postTokenUsageComments: function() {} };
    }
};

function loadWriteContentOutput(mocks, projectConfig, extraModules) {
    var configLoaderMock = {
        loadProjectConfig: function() { return projectConfig || {}; }
    };
    var overrides = extraModules || {};
    var modules = {
        './common/contentOutput.js': loadContentOutputLib(mocks, projectConfig),
        './config.js': { STATUSES: { IN_REVIEW: 'In Review' } },
        './configLoader.js': configLoaderMock,
        './common/trackers.js': loadTrackersWc(mocks)
    };
    Object.keys(WCO_DEFAULT_MODULES).forEach(function(name) {
        modules['./common/' + name + '.js'] = overrides[name] || WCO_DEFAULT_MODULES[name](mocks);
    });
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

    test('writeToTrackerField with an ado tracker calls ado_update_description {id}, never jira_* (wave2d3)', function() {
        var adoCalls = [];
        var mocks = {
            ado_update_description: function(a) { adoCalls.push(a); },
            jira_update_field: function() { throw new Error('jira_update_field must not be called'); }
        };
        var lib = loadContentOutputLib(mocks);
        var tracker = loadTrackersWc(mocks).createTracker(null, { trackerProvider: 'ado' });
        var r = lib.writeToTrackerField('77', 'description', 'body', 'replace', tracker);
        assert.equal(adoCalls.length, 1);
        assert.equal(String(adoCalls[0].id), '77');
        assert.equal(adoCalls[0].description, 'body');
        assert.equal(r.length, 4);
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

    test('ado provider: confluence link comment via ado_add_work_item_comment, no jira_post_comment (wave1c)', function() {
        var adoComments = [];
        var jiraComments = [];
        var mocks = {
            __outputs: { 'response.md': '# Doc\n\nBody' },
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function(a) { return { id: 'p1', title: a.title, _links: { webui: '/wiki/x', base: 'https://c.example.com' } }; },
            confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: [] }); },
            jira_post_comment: function(a) { jiraComments.push(a); },
            ado_add_work_item_comment: function(a) { adoComments.push(a); },
            file_write: function() {}
        };
        var mod = loadWriteContentOutput(mocks, { confluence: { space: 'S', parentPageId: '1' } });
        var result = mod.action(makeParams({
            ticket: { key: '10', fields: { summary: 'Some story' } },
            customParams: { trackerProvider: 'ado', contentOutput: { target: 'confluence', space: 'S', parentPageId: '1' } }
        }));
        assert.equal(jiraComments.length, 0);
        assert.equal(result.success, true, 'confluence target must succeed on ado: ' + result.error);
        assert.equal(adoComments.length, 1, 'exactly one confluence-link comment via ado_add_work_item_comment');
        assert.equal(adoComments[0].id, '10');
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
            './common/trackers.js': loadTrackersWc(mocks),
            './common/contentOutput.js': loadContentOutputLib(mocks),
            './common/outputFiles.js': { readOutputFile: function() { return 'content'; } },
            './common/jiraHelpers.js': { assignForReview: function() { throw new Error('must not run'); } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './config.js': { STATUSES: { IN_REVIEW: 'In Review' } },
            './configLoader.js': { loadProjectConfig: function() { return {}; } },
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

    test('real assignForSolutionArchitecture.js exports action (thenAction contract)', function() {
        var mod = loadModule('js/assignForSolutionArchitecture.js', makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function(k) { return k; } },
            './config.js': { LABELS: {} },
            './configLoader.js': { loadProjectConfig: function() { return { jira: { statuses: {} } }; } },
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': {},
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': { createTracker: function() { return {}; } }
        }), {
            jira_assign_ticket_to: function() {},
            jira_move_to_status: function() {},
            jira_add_label: function() {},
            jira_remove_label: function() {}
        });
        assert.equal(typeof mod.action, 'function', 'assignForSolutionArchitecture must export action for thenAction chaining');
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

    // ── gh-1037 characterization tests: pin behaviour of every branch that the
    //    CRAP refactor touches. All of these passed against the pre-refactor code. ──

    test('missing ticket key fails with a stable error shape', function() {
        var errors = [];
        var origError = console.error;
        console.error = function(msg) { errors.push(msg); };
        try {
            var mod = loadWriteContentOutput({ __outputs: { 'response.md': 'x' } });
            var result = mod.action(makeParams({ ticket: null }));
            assert.equal(result.success, false);
            assert.equal(result.error, 'missing ticket key');
            assert.equal(errors.some(function(m) { return String(m).indexOf('no ticket key') !== -1; }), true);
        } finally {
            console.error = origError;
        }
    });

    test('empty ticket object (no key) fails the same way', function() {
        var mod = loadWriteContentOutput({ __outputs: { 'response.md': 'x' } });
        var result = mod.action(makeParams({ ticket: {} }));
        assert.equal(result.success, false);
        assert.equal(result.error, 'missing ticket key');
    });

    test('wipLabel is null when metadata has no contextId', function() {
        var assignArgs = null;
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadWriteContentOutput(mocks, null, {
            jiraHelpers: {
                assignForReview: function(ticketKey, initiatorId, wipLabel) {
                    assignArgs = { ticketKey: ticketKey, initiatorId: initiatorId, wipLabel: wipLabel };
                }
            }
        });
        var result = mod.action(makeParams({
            metadata: {},
            customParams: { contentOutput: { target: 'jira_field', field: 'Description' } }
        }));
        assert.equal(result.success, true);
        assert.notEqual(assignArgs, null, 'assignForReview must run');
        assert.equal(assignArgs.wipLabel, null);
    });

    test('ticket without fields still works (summary falls back to empty string)', function() {
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            ticket: { key: 'PROJ-20' },
            customParams: { contentOutput: { target: 'jira_field', field: 'Description' } }
        }));
        assert.equal(result.success, true);
        assert.equal(result.ticketKey, 'PROJ-20');
    });

    test('params with neither jobParams.customParams nor customParams still resolve the tracker', function() {
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadWriteContentOutput(mocks);
        var params = makeParams({ customParams: undefined, jobParams: undefined });
        var result = mod.action(params);
        // no customParams → default jira_field target without a field: the tracker
        // resolution (jobParams/customParams || {} fallback) must not throw before
        // the config validation error is reported.
        assert.equal(result.success, false);
        assert.equal(result.error, 'contentOutput.field is required for jira_field target');
    });

    test('jira_field target without cfg.field fails with a stable error', function() {
        var mod = loadWriteContentOutput({ __outputs: { 'response.md': 'content' } });
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'jira_field' } }
        }));
        assert.equal(result.success, false);
        assert.equal(result.error, 'contentOutput.field is required for jira_field target');
    });

    test('field write failure returns Field update failed with the thrown message', function() {
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() { throw new Error('boom'); }
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'jira_field', field: 'Description' } }
        }));
        assert.equal(result.success, false);
        assert.contains(result.error, 'Field update failed:');
        assert.contains(result.error, 'boom');
    });

    test('operationType append merges with the existing field value', function() {
        var calls = [];
        var mocks = {
            __outputs: { 'response.md': 'new content' },
            jira_get_ticket: function() { return { fields: { Description: 'old content' } }; },
            jira_update_field: function(args) { calls.push(args); }
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'jira_field', field: 'Description', operationType: 'append' } }
        }));
        assert.equal(result.success, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].value, 'old content\n\n----\n\nnew content');
    });

    test('confluence target with posted replies logs and reports them in the result', function() {
        var logs = [];
        var origLog = console.log;
        console.log = function(msg) { logs.push(msg); };
        var fieldCalls = [];
        var mocks = {
            __outputs: { 'response.md': '# Solution' },
            file_read: function() { return JSON.stringify([{ pageId: 'p1', commentId: 'c1', body: 'Fixed' }]); },
            confluence_reply_to_inline_comment: function() { return {}; },
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function() {
                return { id: 'p1', _links: { webui: '/pages/p1', base: 'https://wiki.example.com' } };
            },
            confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index'] }); },
            file_write: function() {},
            jira_update_field: function(args) { fieldCalls.push(args); },
            jira_post_comment: function() {}
        };
        try {
            var mod = loadWriteContentOutput(mocks);
            var result = mod.action(makeParams({
                customParams: { contentOutput: {
                    target: 'confluence', field: 'Solution', space: 'DOC', parentPageId: '42'
                } }
            }));
            assert.equal(result.success, true);
            assert.equal(result.replies.posted, 1);
            assert.equal(logs.some(function(m) { return String(m).indexOf('Replied to 1 inline comment(s)') !== -1; }), true);
            assert.equal(fieldCalls.length, 1, 'link still written to the field');
        } finally {
            console.log = origLog;
        }
    });

    test('confluence page without a URL falls back to the page-id link text everywhere', function() {
        var fieldCalls = [];
        var comments = [];
        var mocks = {
            __outputs: { 'response.md': '# Solution' },
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function() { return { id: 'p9' }; },
            confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index'] }); },
            file_write: function() {},
            jira_update_field: function(args) { fieldCalls.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: {
                target: 'confluence', field: 'Solution', space: 'DOC', parentPageId: '42'
            } }
        }));
        assert.equal(result.success, true);
        assert.equal(result.pageUrl, null);
        assert.equal(fieldCalls.length, 1);
        assert.equal(fieldCalls[0].value, 'Published to Confluence page p9');
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Page id: p9');
    });

    test('updateTrackerField:false skips the Confluence link write but still posts the comment', function() {
        var fieldCalls = [];
        var comments = [];
        var mocks = {
            __outputs: { 'response.md': '# Solution' },
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function() {
                return { id: 'p1', _links: { webui: '/pages/p1', base: 'https://wiki.example.com' } };
            },
            confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index'] }); },
            file_write: function() {},
            jira_update_field: function(args) { fieldCalls.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: {
                target: 'confluence', field: 'Solution', space: 'DOC', parentPageId: '42',
                updateTrackerField: false
            } }
        }));
        assert.equal(result.success, true);
        assert.equal(fieldCalls.length, 0, 'no link write when updateTrackerField is false');
        assert.equal(comments.length, 1, 'link comment still posted');
    });

    test('failing link-comment post is non-fatal and logs a warning', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var mocks = {
            __outputs: { 'response.md': '# Solution' },
            confluence_get_children_by_id: function() { return []; },
            confluence_create_page: function() {
                return { id: 'p1', _links: { webui: '/pages/p1', base: 'https://wiki.example.com' } };
            },
            confluence_sync_markdown_directory: function() { return JSON.stringify({ syncedPages: ['index'] }); },
            file_write: function() {},
            jira_update_field: function() {},
            jira_post_comment: function() { throw new Error('comment api down'); }
        };
        try {
            var mod = loadWriteContentOutput(mocks);
            var result = mod.action(makeParams({
                customParams: { contentOutput: {
                    target: 'confluence', field: 'Solution', space: 'DOC', parentPageId: '42'
                } }
            }));
            assert.equal(result.success, true, 'comment failure must not fail the publish');
            assert.equal(warns.some(function(m) { return String(m).indexOf('Failed to post Confluence link comment') !== -1; }), true);
        } finally {
            console.warn = origWarn;
        }
    });

    test('confluence publish failure returns Confluence publish failed with the thrown message', function() {
        var mocks = {
            __outputs: { 'response.md': '# Solution' },
            confluence_get_children_by_id: function() { throw new Error('cf down'); },
            file_write: function() {},
            jira_post_comment: function() {}
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: {
                target: 'confluence', field: 'Solution', space: 'DOC', parentPageId: '42'
            } }
        }));
        assert.equal(result.success, false);
        assert.contains(result.error, 'Confluence publish failed:');
        assert.contains(result.error, 'cf down');
    });

    test('thenAction pointing at a module without an action export warns and skips', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadModule('js/writeContentOutput.js', makeRequire({
            './common/trackers.js': loadTrackersWc(mocks),
            './common/contentOutput.js': loadContentOutputLib(mocks),
            './common/outputFiles.js': { readOutputFile: function() { return 'content'; } },
            './common/jiraHelpers.js': { assignForReview: function() { throw new Error('must not run'); } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './config.js': { STATUSES: { IN_REVIEW: 'In Review' } },
            './configLoader.js': { loadProjectConfig: function() { return {}; } },
            './noActionModule.js': { notAction: true }
        }), mocks);
        try {
            var result = mod.action(makeParams({
                customParams: { contentOutput: {
                    target: 'jira_field', field: 'Description',
                    thenAction: 'noActionModule.js'
                } }
            }));
            assert.equal(result.success, true);
            assert.equal(result.thenAction, undefined, 'thenAction must not be recorded when skipped');
            assert.equal(warns.some(function(m) { return String(m).indexOf('has no exported action()') !== -1; }), true);
        } finally {
            console.warn = origWarn;
        }
    });

    test('thenAction whose module throws returns thenAction failed with the thrown message', function() {
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadModule('js/writeContentOutput.js', makeRequire({
            './common/trackers.js': loadTrackersWc(mocks),
            './common/contentOutput.js': loadContentOutputLib(mocks),
            './common/outputFiles.js': { readOutputFile: function() { return 'content'; } },
            './common/jiraHelpers.js': { assignForReview: function() { throw new Error('must not run'); } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './config.js': { STATUSES: { IN_REVIEW: 'In Review' } },
            './configLoader.js': { loadProjectConfig: function() { return {}; } },
            './explodingModule.js': {
                get action() { throw new Error('load exploded'); }
            }
        }), mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: {
                target: 'jira_field', field: 'Description',
                thenAction: 'explodingModule.js'
            } }
        }));
        assert.equal(result.success, false);
        assert.contains(result.error, 'thenAction failed:');
    });

    test('assignForReview:false skips the review assignment', function() {
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'jira_field', field: 'Description', assignForReview: false } }
        }));
        assert.equal(result.success, true);
        assert.equal((mocks.__assignCalls || []).length, 0, 'no assignForReview call');
    });

    test('assignForReview failure is non-fatal and logs a warning', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadWriteContentOutput(mocks, null, {
            jiraHelpers: { assignForReview: function() { throw new Error('assign api down'); } }
        });
        try {
            var result = mod.action(makeParams({
                customParams: { contentOutput: { target: 'jira_field', field: 'Description' } }
            }));
            assert.equal(result.success, true);
            assert.equal(warns.some(function(m) { return String(m).indexOf('assignForReview failed (non-fatal)') !== -1; }), true);
        } finally {
            console.warn = origWarn;
        }
    });

    test('token usage comment failure is non-fatal and logs a warning', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var mocks = {
            __outputs: { 'response.md': 'content' },
            jira_update_field: function() {}
        };
        var mod = loadWriteContentOutput(mocks, null, {
            tokenUsageComment: { postTokenUsageComments: function() { throw new Error('token api down'); } }
        });
        try {
            var result = mod.action(makeParams({
                customParams: { contentOutput: { target: 'jira_field', field: 'Description' } }
            }));
            assert.equal(result.success, true);
            assert.equal(warns.some(function(m) { return String(m).indexOf('Failed to post token usage comments') !== -1; }), true);
        } finally {
            console.warn = origWarn;
        }
    });

});

suite('writeContentOutput — extracted helpers (gh-1037)', function() {
    function loadFull(mocks, projectConfig) {
        return loadWriteContentOutput(mocks || {}, projectConfig);
    }

    test('buildWipLabel appends _wip to the contextId, null without one', function() {
        var mod = loadFull({});
        assert.equal(mod.buildWipLabel({ metadata: { contextId: 'story_description' } }), 'story_description_wip');
        assert.equal(mod.buildWipLabel({ metadata: {} }), null);
        assert.equal(mod.buildWipLabel({}), null);
    });

    test('describeTarget renders field/space/pageId fallbacks', function() {
        var mod = loadFull({});
        assert.equal(mod.describeTarget({ target: 'jira_field', field: 'Description' }),
            'target=jira_field, field=Description, confluence=?/?');
        assert.equal(mod.describeTarget({ target: 'confluence', space: 'DOC', parentPageId: '42' }),
            'target=confluence, field=(none), confluence=DOC/42');
        assert.equal(mod.describeTarget({ target: 'both', field: 'F', space: 'S' }),
            'target=both, field=F, confluence=S/?');
    });

    test('readResponseContent trims content, null (with error log) when empty', function() {
        var errors = [];
        var origError = console.error;
        console.error = function(m) { errors.push(m); };
        try {
            var mod = loadFull({ __outputs: { 'response.md': '  padded  ' } });
            assert.equal(mod.readResponseContent('PROJ-1', null), 'padded');
            var mod2 = loadFull({ __outputs: {} });
            assert.equal(mod2.readResponseContent('PROJ-1', null), null);
            assert.equal(errors.some(function(m) { return String(m).indexOf('outputs/response.md not found or empty') !== -1; }), true);
        } finally {
            console.error = origError;
        }
    });

    test('buildConfluenceLinkText / buildConfluenceCommentText pick url or page id', function() {
        var mod = loadFull({});
        assert.equal(mod.buildConfluenceLinkText('https://x/p1', 'p1'), 'Published to Confluence: https://x/p1');
        assert.equal(mod.buildConfluenceLinkText(null, 'p9'), 'Published to Confluence page p9');
        assert.contains(mod.buildConfluenceCommentText('https://x/p1', 'p1'), 'Page: https://x/p1');
        assert.contains(mod.buildConfluenceCommentText(null, 'p9'), 'Page id: p9');
    });

    test('normalizeThenActionPath strips agents/ and js/ prefixes only', function() {
        var mod = loadFull({});
        assert.equal(mod.normalizeThenActionPath('assignForSolutionArchitecture.js'), 'assignForSolutionArchitecture.js');
        assert.equal(mod.normalizeThenActionPath('agents/assignForSolutionArchitecture.js'), 'assignForSolutionArchitecture.js');
        assert.equal(mod.normalizeThenActionPath('js/assignForSolutionArchitecture.js'), 'assignForSolutionArchitecture.js');
        assert.equal(mod.normalizeThenActionPath('agents/js/nested.js'), 'nested.js');
    });

    test('writeJiraFieldStep falls back to replace when operationType is falsy', function() {
        var calls = [];
        var mocks = {
            jira_get_ticket: function() { return { fields: { Description: 'old' } }; },
            jira_update_field: function(args) { calls.push(args); }
        };
        var mod = loadFull(mocks);
        var result = { success: true, ticketKey: 'PROJ-1', target: 'jira_field' };
        var cfg = { target: 'jira_field', field: 'Description', operationType: null };
        var out = mod.writeJiraFieldStep(result, cfg, 'PROJ-1', 'body', null);
        assert.equal(out, result, 'success returns the same result object');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].value, 'body', 'null operationType behaves as replace');
    });

    test('writeJiraFieldStep skips non-jira targets and reports the missing field', function() {
        var mod = loadFull({});
        var result = { success: true };
        assert.equal(mod.writeJiraFieldStep(result, { target: 'confluence' }, 'K', 'c', null), result);
        var out = mod.writeJiraFieldStep(result, { target: 'jira_field' }, 'K', 'c', null);
        assert.equal(out.success, false);
        assert.equal(out.error, 'contentOutput.field is required for jira_field target');
    });

    test('a failing inline reply logs the failed count (logReplySummary failed>0 arm)', function() {
        var logs = [];
        var origLog = console.log;
        console.log = function(m) { logs.push(m); };
        var mod = loadFull({});
        try {
            mod.logReplySummary({ posted: 0, failed: 2 });
            mod.logReplySummary({ posted: 0, failed: 0 });
            assert.equal(logs.length, 1, 'only the non-zero summary logs');
            assert.contains(logs[0], 'Replied to 0 inline comment(s), 2 failed');
        } finally {
            console.log = origLog;
        }
    });

    test('loadProjectConfigSafe returns null when the loader throws', function() {
        var mod = loadModule('js/writeContentOutput.js', makeRequire({
            './common/trackers.js': loadTrackersWc({}),
            './common/contentOutput.js': loadContentOutputLib({}),
            './common/outputFiles.js': { readOutputFile: function() { return null; } },
            './common/jiraHelpers.js': { assignForReview: function() {} },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './config.js': { STATUSES: { IN_REVIEW: 'In Review' } },
            './configLoader.js': { loadProjectConfig: function() { throw new Error('no config'); } }
        }), {});
        assert.equal(mod.loadProjectConfigSafe({}), null);
        assert.equal(mod.loadProjectConfigSafe({ jobParams: {} }), null);
    });
});

suite('writeContentOutput uses the configured tracker for the field write (agents#873)', function() {

    test('ado provider: the field is written through ADO and jira_update_field is never called', function() {
        var adoCalls = [];
        var mocks = {
            __outputs: { 'response.md': '# Description\n\nContent here' },
            ado_update_description: function(a) { adoCalls.push(a); },
            ado_update_field: function(a) { adoCalls.push(a); },
            jira_update_field: function() { throw new Error('jira_update_field must not be called on an ADO run'); }
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            ticket: { key: '2039670', fields: { summary: 'Some story' } },
            customParams: { trackerProvider: 'ado', contentOutput: { target: 'jira_field', field: 'Description' } }
        }));

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(adoCalls.length, 1, 'exactly one ADO write');
        assert.equal(adoCalls[0].id, '2039670');
    });

    test('ado provider: a non-Description field goes through ado_update_field, not Jira', function() {
        var adoCalls = [];
        var mocks = {
            __outputs: { 'response.md': 'Criteria text' },
            ado_update_field: function(a) { adoCalls.push(a); },
            jira_update_field: function() { throw new Error('jira_update_field must not be called on an ADO run'); }
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            ticket: { key: '77', fields: { summary: 's' } },
            customParams: { trackerProvider: 'ado', contentOutput: { target: 'jira_field', field: 'Microsoft.VSTS.Common.AcceptanceCriteria' } }
        }));
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(adoCalls.length, 1);
        assert.equal(adoCalls[0].field, 'Microsoft.VSTS.Common.AcceptanceCriteria');
    });

    test('jira (default) is unchanged: still jira_update_field', function() {
        var jiraCalls = [];
        var mocks = {
            __outputs: { 'response.md': 'x' },
            jira_update_field: function(a) { jiraCalls.push(a); }
        };
        var mod = loadWriteContentOutput(mocks);
        mod.action(makeParams({ customParams: { contentOutput: { target: 'jira_field', field: 'Description' } } }));
        assert.equal(jiraCalls.length, 1);
    });

    test('both writeToTrackerField calls in writeContentOutput.js pass the tracker (guard)', function() {
        var src = file_read({ path: 'js/writeContentOutput.js' });
        var calls = src.match(/writeToTrackerField\([^;]*\);/g) || [];
        assert.ok(calls.length >= 2, 'expected the field write and the Confluence-link write, saw ' + calls.length);
        calls.forEach(function(c) { assert.contains(c, 'tracker', 'call does not pass the tracker: ' + c); });
    });
});

// ── Local helpers for the assignForReview suite (agents#874) ────────────────
// These were written against test_trackers.js's helper set but the suite
// lives here: define them locally so this file is self-contained (the dart
// agents-gate runs the full suite; a missing helper = ReferenceError).
function recorder(name, result) {
    var calls = [];
    var fn = function (args) {
        calls.push(args);
        if (result && result.__throw__) {
            throw result.__throw__;
        }
        return typeof result === 'function' ? result(args) : result;
    };
    fn.calls = calls;
    fn.toolName = name;
    return fn;
}

var JIRA_TICKET = {
    key: 'PROJ-1',
    id: '10001',
    fields: {
        summary: 'Sample ticket',
        status: { name: 'Open' },
        assignee: null,
        reporter: { name: 'reviewer', displayName: 'Reviewer' },
        labels: [],
        priority: { name: 'Major' }
    }
};

/** Standard jira provider mock set (canonical jira_* tools). */
function jiraMocks(opts) {
    return {
        jira_get_ticket: recorder('jira_get_ticket', JSON.stringify(JIRA_TICKET)),
        jira_search_by_jql: recorder('jira_search_by_jql', JSON.stringify({
            issues: [JIRA_TICKET]
        })),
        jira_post_comment: recorder('jira_post_comment', '{}'),
        jira_get_comments: recorder('jira_get_comments', JSON.stringify({
            comments: [{ author: { displayName: 'Reviewer' }, body: 'please fix', created: '2026-09-07T10:00:00.000+0000' }]
        })),
        jira_add_label: recorder('jira_add_label', '{}'),
        jira_remove_label: opts && opts.removeLabelFails
            ? recorder('jira_remove_label', { __throw__: new Error('label api down') })
            : recorder('jira_remove_label', '{}'),
        jira_move_to_status: recorder('jira_move_to_status', '{}'),
        jira_assign_ticket_to: recorder('jira_assign_ticket_to', '{}'),
        jira_create_ticket_basic: recorder('jira_create_ticket_basic', '{"key":"PROJ-9"}')
    };
}

/** Mock-injecting trackers loader (name-compat with test_trackers.js). */
function loadTrackers(mocks) {
    return loadTrackersWc(mocks);
}

suite('assignForReview without an initiator (agents#874)', function() {

    function setup(provider) {
        var m = jiraMocks();
        m.ado_assign_work_item = recorder('ado_assign_work_item', function() { throw new Error("Required parameter 'userEmail' is missing"); });
        m.ado_move_to_state = recorder('ado_move_to_state', '{}');
        m.ado_add_work_item_label = recorder('ado_add_work_item_label', '{}');
        m.ado_remove_work_item_label = recorder('ado_remove_work_item_label', '{}');
        var t = loadTrackers(m).createTracker({}, { trackerProvider: provider });
        return { t: t, m: m };
    }

    test('ADO: no initiator skips ONLY the assignment; status move, AI label and WIP cleanup still happen', function() {
        var x = setup('ado');
        var r = x.t.assignForReview('2039670', undefined, 'wip_label', 'Committed');
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(x.m.ado_assign_work_item.calls.length, 0, 'no assignment attempted');
        assert.equal(x.m.ado_move_to_state.calls.length, 1);
        assert.equal(x.m.ado_move_to_state.calls[0].state, 'Committed');
        assert.ok(x.m.ado_add_work_item_label.calls.some(function(c) { return c.label === 'ai_generated'; }), 'AI label added');
        assert.ok(x.m.ado_remove_work_item_label.calls.some(function(c) { return c.label === 'wip_label'; }), 'WIP label removed');
    });

    test('empty string, null and whitespace count as "no initiator" on every provider', function() {
        ['', null, '   '].forEach(function(blank) {
            var x = setup('jira');
            var r = x.t.assignForReview('PROJ-1', blank);
            assert.equal(r.success, true, JSON.stringify(r));
            assert.equal(x.m.jira_assign_ticket_to.calls.length, 0);
            assert.equal(x.m.jira_move_to_status.calls.length, 1);
        });
    });

    test('with an initiator the assignment is made exactly as before (Jira and ADO)', function() {
        var j = setup('jira');
        j.t.assignForReview('PROJ-1', 'acc-1');
        assert.equal(j.m.jira_assign_ticket_to.calls.length, 1);
        assert.equal(j.m.jira_assign_ticket_to.calls[0].accountId, 'acc-1');

        var a = setup('ado');
        a.m.ado_assign_work_item = recorder('ado_assign_work_item', '{}');
        var t = loadTrackers(a.m).createTracker({}, { trackerProvider: 'ado' });
        t.assignForReview('42', 'jane@acme.dev');
        assert.equal(a.m.ado_assign_work_item.calls.length, 1);
        assert.equal(a.m.ado_assign_work_item.calls[0].userEmail, 'jane@acme.dev');
    });

    test('a real assignment failure with an initiator still fails the hand-off (no silent swallow)', function() {
        var x = setup('ado');
        var r = x.t.assignForReview('42', 'jane@acme.dev');
        assert.equal(r.success, false);
        assert.contains(r.error, 'userEmail');
    });
});


// ── gh-1112: wiki_publisher base agent — target aliases, tracker-agnostic
//    notification and publish ordering ────────────────────────────────────────

suite('writeContentOutput — wiki target + tracker-agnostic notify (gh-1112)', function() {

    /** Confluence-backed mocks recording every publish-side call. */
    function wikiMocks(overrides) {
        var calls = { sequence: [], comments: [], fields: [], syncArgs: null, created: null };
        var mocks = {
            __outputs: { 'response.md': '# Wiki page\n\nBody' },
            confluence_get_children_by_id: function() {
                calls.sequence.push('children');
                return [];
            },
            confluence_create_page: function(a) {
                calls.created = a;
                calls.sequence.push('create');
                return { id: 'p1', _links: { webui: '/pages/p1', base: 'https://wiki.example.com' } };
            },
            confluence_sync_markdown_directory: function(a) {
                calls.syncArgs = a;
                calls.sequence.push('sync');
                return JSON.stringify({ syncedPages: ['index'] });
            },
            confluence_reply_to_inline_comment: function(a) {
                calls.sequence.push('reply');
                return {};
            },
            file_write: function() {},
            file_read: function() { return '[]'; },
            jira_post_comment: function(a) { calls.comments.push(['jira', a]); },
            github_create_comment: function(a) { calls.comments.push(['github', a]); },
            ado_add_work_item_comment: function(a) { calls.comments.push(['ado', a]); },
            jira_update_field: function(a) { calls.fields.push(a); return {}; }
        };
        Object.keys(overrides || {}).forEach(function(k) { mocks[k] = overrides[k]; });
        return { calls: calls, mocks: mocks };
    }

    test("target 'wiki' publishes the Confluence page exactly like 'confluence' (AC4)", function() {
        var w = wikiMocks({});
        var mod = loadWriteContentOutput(w.mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'wiki', space: 'DOC', parentPageId: '42', updateTrackerField: false } }
        }));
        assert.equal(result.success, true, 'wiki target must publish: ' + result.error);
        assert.equal(result.target, 'wiki');
        assert.equal(result.pageId, 'p1');
        assert.equal(result.pageUrl, 'https://wiki.example.com/pages/p1');
        assert.notEqual(w.calls.syncArgs, null, 'markdown directory sync must run');
        assert.equal(w.calls.syncArgs.parentId, 'p1');
    });

    test("target 'wiki' with updateTrackerField:false (the wiki_publisher default) writes ZERO tracker fields (E3)", function() {
        var w = wikiMocks({});
        var mod = loadWriteContentOutput(w.mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'wiki', space: 'DOC', parentPageId: '42', updateTrackerField: false } }
        }));
        assert.equal(result.success, true);
        assert.equal(w.calls.fields.length, 0, 'no jira_update_field calls under updateTrackerField:false');
        assert.equal(w.calls.comments.length, 1, 'link comment still posted');
    });

    test("target 'wiki' with updateTrackerField:true writes the link field like 'confluence' (alias parity)", function() {
        var w = wikiMocks({});
        var mod = loadWriteContentOutput(w.mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'wiki', field: 'Description', space: 'DOC', parentPageId: '42' } }
        }));
        assert.equal(result.success, true);
        assert.equal(w.calls.fields.length, 1, 'link written to the field under updateTrackerField:true');
        assert.contains(w.calls.fields[0].value, 'https://wiki.example.com/pages/p1');
    });

    test("target 'tracker_field' writes the field exactly like 'jira_field' (AC4)", function() {
        var fieldCalls = [];
        var mocks = {
            __outputs: { 'response.md': '# Description' },
            jira_update_field: function(a) { fieldCalls.push(a); }
        };
        var mod = loadWriteContentOutput(mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'tracker_field', field: 'Description' } }
        }));
        assert.equal(result.success, true, 'tracker_field alias must write the field: ' + result.error);
        assert.equal(result.target, 'tracker_field');
        assert.equal(fieldCalls.length, 1);
        assert.equal(fieldCalls[0].field, 'Description');
        assert.contains(fieldCalls[0].value, '# Description');
    });

    test('github tracker receives the wiki link comment via github_create_comment; jira tools are never called (AC6)', function() {
        var jiraCalls = [];
        var w = wikiMocks({
            jira_post_comment: function(a) { jiraCalls.push(a); }
        });
        var mod = loadWriteContentOutput(w.mocks);
        var result = mod.action(makeParams({
            ticket: { key: 'gh-1112', fields: { summary: 'wiki publisher' } },
            customParams: {
                trackerProvider: 'github',
                contentOutput: { target: 'wiki', space: 'DOC', parentPageId: '42', updateTrackerField: false }
            }
        }));
        assert.equal(result.success, true, 'github + wiki target must succeed: ' + result.error);
        assert.equal(w.calls.comments.length, 1, 'exactly one link comment');
        assert.equal(w.calls.comments[0][0], 'github', 'comment posted through the github provider');
        assert.equal(String(w.calls.comments[0][1].pullRequestId), '1112');
        assert.equal(jiraCalls.length, 0, 'jira_post_comment must not fire on a github tracker');
        assert.equal(w.calls.fields.length, 0, 'no field writes on github (no custom fields)');
    });

    test('ado tracker receives the wiki link comment via ado_add_work_item_comment (AC6)', function() {
        var jiraCalls = [];
        var w = wikiMocks({
            jira_post_comment: function(a) { jiraCalls.push(a); }
        });
        var mod = loadWriteContentOutput(w.mocks);
        var result = mod.action(makeParams({
            ticket: { key: '2039670', fields: { summary: 'wiki publisher' } },
            customParams: {
                trackerProvider: 'ado',
                contentOutput: { target: 'wiki', space: 'DOC', parentPageId: '42', updateTrackerField: false }
            }
        }));
        assert.equal(result.success, true, 'ado + wiki target must succeed: ' + result.error);
        assert.equal(w.calls.comments.length, 1);
        assert.equal(w.calls.comments[0][0], 'ado', 'comment posted through the ado provider');
        assert.equal(String(w.calls.comments[0][1].id), '2039670');
        assert.equal(jiraCalls.length, 0);
    });

    test('inline replies are posted BEFORE the page body sync (E5 ordering)', function() {
        var w = wikiMocks({
            file_read: function() {
                return JSON.stringify([{ pageId: 'p1', commentId: 'c1', body: 'Fixed' }]);
            }
        });
        var mod = loadWriteContentOutput(w.mocks);
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'wiki', space: 'DOC', parentPageId: '42', updateTrackerField: false } }
        }));
        assert.equal(result.success, true, 'publish must succeed: ' + result.error);
        assert.equal(result.replies.posted, 1);
        var replyIdx = w.calls.sequence.indexOf('reply');
        var syncIdx = w.calls.sequence.indexOf('sync');
        assert.ok(replyIdx !== -1, 'a reply must have been posted');
        assert.ok(syncIdx !== -1, 'the directory sync must have run');
        assert.ok(replyIdx < syncIdx, 'replies must be posted before the page body is replaced, sequence: ' + w.calls.sequence.join(','));
    });

    test('missing confluence config under target wiki returns Confluence publish failed without crashing (E2)', function() {
        var mod = loadWriteContentOutput({ __outputs: { 'response.md': '# Wiki page' } });
        var result = mod.action(makeParams({
            customParams: { contentOutput: { target: 'wiki' } }
        }));
        assert.equal(result.success, false);
        assert.contains(result.error, 'Confluence publish failed:');
    });
});
