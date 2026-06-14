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
        var module = loadModule(
            'js/notifyBugMerged.js',
            makeRequire(Object.assign({
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
            }, makeAiChatMock('h4. Root Cause\nPolicy field mismatch.'))),
            {
                jira_get_comments: function() {
                    return [{ body: 'Bug Fix Summary\nFixed the timeout policy.' }];
                },
                jira_update_field: function(args) {
                    updated = args;
                },
                jira_post_comment: function() {},
                jira_remove_label: function() {}
            }
        );

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
        var module = loadModule(
            'js/notifyBugMerged.js',
            makeRequire(Object.assign({
                './configLoader.js': {
                    loadProjectConfig: function() {
                        return { jira: { fields: {} } };
                    }
                },
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} }
            }, makeAiChatMock('RCA'))),
            {
                jira_get_comments: function() { return []; },
                jira_update_field: function(args) { updated = args; },
                jira_post_comment: function() {},
                jira_remove_label: function() {}
            }
        );

        var result = module.action({
            ticket: { key: 'TS-2', fields: {} },
            jobParams: {}
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(updated.field, 'Solution', 'default field');
    });
});
