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
