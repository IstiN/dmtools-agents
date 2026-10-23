// Real tracker layer loaded WITH the same tool mocks as the script under test
// (loadModule mocks only shadow globals inside the module they are passed to).
function trackersWith(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

suite('notifyBugMerged — solution field config', function() {
    function makeAiChatMock(returnValue) {
        return {
            './common/aiChat.js': {
                aiChat: function() { return returnValue; }
            }
        };
    }

    test('uses project bugSolution field when updating RCA', function() {
        var updated = null;
        var module = (function (_m) { return loadModule('js/notifyBugMerged.js', makeRequire(Object.assign({}, Object.assign({
                './configLoader.js': {
                    loadProjectConfig: function() {
                        return {
                            jira: {
                                fields: {
                                    bugSolution: 'customfield_10400'
                                }
                            }
                        };
                    }
                },
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
            }, makeAiChatMock('h4. Root Cause\nPolicy field mismatch.')), { './common/trackers.js': trackersWith(_m) })), _m); })({
                jira_get_comments: function() {
                    return [{ body: 'Bug Fix Summary\nFixed the timeout policy.' }];
                },
                jira_update_field: function(args) {
                    updated = args;
                },
                jira_post_comment: function() {},
                jira_remove_label: function() {}
            });

        var result = module.action({
            ticket: {
                key: 'TS-1',
                fields: { description: 'Bug description' }
            },
            jobParams: {
                customParams: { configPath: '.dmtools/config.js' }
            }
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(updated.key, 'TS-1', 'updates ticket');
        assert.equal(updated.field, 'customfield_10400', 'uses configured field id');
        assert.equal(updated.value, 'h4. Root Cause\nPolicy field mismatch.', 'writes generated RCA');
    });

    test('falls back to Solution field by default', function() {
        var updated = null;
        var module = (function (_m) { return loadModule('js/notifyBugMerged.js', makeRequire(Object.assign({}, Object.assign({
                './configLoader.js': {
                    loadProjectConfig: function() {
                        return { jira: { fields: {} } };
                    }
                },
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
            }, makeAiChatMock('RCA')), { './common/trackers.js': trackersWith(_m) })), _m); })({
                jira_get_comments: function() { return []; },
                jira_update_field: function(args) { updated = args; },
                jira_post_comment: function() {},
                jira_remove_label: function() {}
            });

        var result = module.action({
            ticket: { key: 'TS-2', fields: {} },
            jobParams: {}
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(updated.field, 'Solution', 'default field');
    });
});


suite('notifyBugMerged: ado tracker provider', function() {
    test('reads normalised comments and writes via ado_* tools only', function() {
        var calls = [];
        var mocks = {
            ado_get_work_item_comments: function() { return { value: [{ text: 'Bug Fix Summary\nFixed it', createdBy: { displayName: 'dev' } }] }; },
            ado_update_description: function(a) { calls.push(['field', a]); },
            ado_add_work_item_comment: function(a) { calls.push(['comment', a]); },
            ado_remove_work_item_label: function(a) { calls.push(['rm', a]); },
            jira_get_comments: function() { throw new Error('jira_get_comments must not be called on ado'); },
            jira_update_field: function() { throw new Error('jira_update_field must not be called on ado'); },
            jira_post_comment: function() { throw new Error('jira_post_comment must not be called on ado'); },
            jira_remove_label: function() { throw new Error('jira_remove_label must not be called on ado'); }
        };
        var module = loadModule('js/notifyBugMerged.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return { jira: { fields: { bugSolution: 'description' } } }; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/aiChat.js': { aiChat: function() { return 'RCA'; } },
            './common/trackers.js': trackersWith(mocks)
        }), mocks);
        var result = module.action({
            ticket: { key: '9', fields: {} },
            metadata: { contextId: 'x' },
            jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_l' } }
        });
        assert.equal(result.success, true);
        assert.equal(calls.filter(function(c) { return c[0] === 'field'; }).length, 1);
        assert.equal(calls.filter(function(c) { return c[0] === 'comment'; }).length, 1);
        assert.equal(calls.filter(function(c) { return c[0] === 'rm'; }).length, 2);
    });
});

// ── gh-1188: action decomposition — characterization tests for the extracted
// step helpers and the previously uncovered branches (comment-fetch failure,
// post-comment failure, label-removal failure, empty AI solution, null config). ──

function loadNotifyBugMerged1188(mocks, requireOverrides) {
    var base = {
        './configLoader.js': { loadProjectConfig: function() { return { jira: { fields: {} } }; } },
        './common/aiChat.js': { aiChat: function() { return 'RCA'; } },
        './common/tokenUsageComment.js': {
            postTokenUsageComments: function() {},
            customParamsOf: function() { return {}; }
        },
        './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }), mocks || {})
    };
    if (requireOverrides) {
        for (var k in requireOverrides) {
            if (requireOverrides.hasOwnProperty(k)) base[k] = requireOverrides[k];
        }
    }
    return loadModule('js/notifyBugMerged.js', makeRequire(base), mocks || {});
}

suite('notifyBugMerged — gh-1188 extracted step helpers', function() {
    test('resolveWipLabel: contextId suffix or null', function() {
        var mod = loadNotifyBugMerged1188({});
        assert.equal(mod.resolveWipLabel({ metadata: { contextId: 'bug_merged' } }), 'bug_merged_wip');
        assert.equal(mod.resolveWipLabel({}), null);
        assert.equal(mod.resolveWipLabel({ metadata: {} }), null);
    });

    test('resolveSmRemoveLabel: jobParams customParams win; absent → falsy', function() {
        var mod = loadNotifyBugMerged1188({});
        assert.equal(mod.resolveSmRemoveLabel({ jobParams: { customParams: { removeLabel: 'sm_x' } } }), 'sm_x');
        assert.notOk(mod.resolveSmRemoveLabel({ jobParams: {} }));
        assert.notOk(mod.resolveSmRemoveLabel({}));
    });

    test('resolveActionCustomParams: jobParams win, then bare customParams, then {}', function() {
        var mod = loadNotifyBugMerged1188({});
        assert.deepEqual(mod.resolveActionCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(mod.resolveActionCustomParams({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(mod.resolveActionCustomParams({}), {});
    });

    test('resolveTicketDescription: present / missing / missing fields', function() {
        var mod = loadNotifyBugMerged1188({});
        assert.equal(mod.resolveTicketDescription({ fields: { description: 'd' } }), 'd');
        assert.equal(mod.resolveTicketDescription({ fields: {} }), '');
        assert.equal(mod.resolveTicketDescription({}), '');
        assert.equal(mod.resolveTicketDescription(null), '');
    });

    test('buildMergeNotificationComment mentions merged + Solution field', function() {
        var mod = loadNotifyBugMerged1188({});
        var comment = mod.buildMergeNotificationComment();
        assert.contains(comment, 'Bug Fix Merged');
        assert.contains(comment, 'Solution');
    });

    test('findDevSummaryComment: non-array → empty; markers pick the last match', function() {
        var mod = loadNotifyBugMerged1188({});
        assert.equal(mod.findDevSummaryComment(null), '');
        assert.equal(mod.findDevSummaryComment('nope'), '');
        assert.equal(mod.findDevSummaryComment([]), '');
        assert.equal(mod.findDevSummaryComment([{ body: 'nothing here' }]), '');
        assert.equal(
            mod.findDevSummaryComment([
                { body: 'Root Cause: first' },
                { body: 'unrelated' },
                { body: 'Fix Applied: second' }
            ]),
            'Fix Applied: second'
        );
    });

    test('updateSolutionField: whitespace-only AI answer → no field update', function() {
        var updated = [];
        var mod = loadNotifyBugMerged1188({
            jira_get_comments: function() { return []; },
            jira_update_field: function(a) { updated.push(a); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        }, {
            './common/aiChat.js': { aiChat: function() { return '   '; } }
        });
        mod.updateSolutionField('TS-1', 'desc', [], {});
        assert.deepEqual(updated, [], 'whitespace solution must not be written');
    });

    test('updateSolutionField: aiChat failure is swallowed (field-update catch)', function() {
        var updated = [];
        var mod = loadNotifyBugMerged1188({
            jira_get_comments: function() { return []; },
            jira_update_field: function(a) { updated.push(a); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        }, {
            './common/aiChat.js': { aiChat: function() { throw new Error('provider down'); } }
        });
        mod.updateSolutionField('TS-1', 'desc', [], {});
        assert.deepEqual(updated, [], 'aiChat failure must be swallowed');
    });

    test('updateSolutionField: null project config falls back to the Solution field', function() {
        var updated = null;
        var mod = loadNotifyBugMerged1188({
            jira_get_comments: function() { return []; },
            jira_update_field: function(a) { updated = a; },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        }, {
            './configLoader.js': { loadProjectConfig: function() { return null; } }
        });
        mod.updateSolutionField('TS-1', 'desc', [], { jobParams: {} });
        assert.ok(updated, 'field must be written');
        assert.equal(updated.field, 'Solution', 'null config degrades to the default field');
    });

    test('action: comment fetch failure degrades to no comments and still posts the merge note', function() {
        var comments = [];
        var mod = loadNotifyBugMerged1188({
            jira_get_comments: function() { throw new Error('boom'); },
            jira_update_field: function() {},
            jira_post_comment: function(a) { comments.push(a); },
            jira_remove_label: function() {}
        });
        var result = mod.action({ ticket: { key: 'TS-7', fields: {} }, jobParams: {} });
        assert.equal(result.success, true);
        assert.equal(comments.length, 1, 'merge notification still posted');
        assert.contains(comments[0].comment, 'Bug Fix Merged');
    });

    test('action: post-comment failure is swallowed; WIP + SM labels removed in order', function() {
        var removed = [];
        var mod = loadNotifyBugMerged1188({
            jira_get_comments: function() { return []; },
            jira_update_field: function() {},
            jira_post_comment: function() { throw new Error('cannot post'); },
            jira_remove_label: function(a) { removed.push(a.label); }
        });
        var result = mod.action({
            ticket: { key: 'TS-8', fields: {} },
            metadata: { contextId: 'bug_merged' },
            jobParams: { customParams: { removeLabel: 'sm_bug_merged_triggered' } }
        });
        assert.equal(result.success, true);
        assert.deepEqual(removed, ['bug_merged_wip', 'sm_bug_merged_triggered'], 'wip label first, then SM label');
    });

    test('action: label-removal failure is swallowed', function() {
        var mod = loadNotifyBugMerged1188({
            jira_get_comments: function() { return []; },
            jira_update_field: function() {},
            jira_post_comment: function() {},
            jira_remove_label: function() { throw new Error('no labels'); }
        });
        var result = mod.action({
            ticket: { key: 'TS-9', fields: {} },
            metadata: { contextId: 'bug_merged' },
            jobParams: { customParams: { removeLabel: 'sm_l' } }
        });
        assert.equal(result.success, true);
    });

    test('action: token-usage failure is swallowed', function() {
        var mod = loadNotifyBugMerged1188({
            jira_get_comments: function() { return []; },
            jira_update_field: function() {},
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        }, {
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function() { throw new Error('usage boom'); },
                customParamsOf: function() { return {}; }
            }
        });
        var result = mod.action({ ticket: { key: 'TS-10', fields: {} }, jobParams: {} });
        assert.equal(result.success, true);
    });
});
