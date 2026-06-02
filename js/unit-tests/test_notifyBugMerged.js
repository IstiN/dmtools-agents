suite('notifyBugMerged — solution field config', function() {
    test('uses project bugSolution field when updating RCA', function() {
        var updated = null;
        var module = loadModule(
            'js/notifyBugMerged.js',
            makeRequire({
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
                }
            }),
            {
                jira_get_comments: function() {
                    return [{ body: 'Bug Fix Summary\nFixed the timeout policy.' }];
                },
                gemini_ai_chat: function() {
                    return 'h4. Root Cause\nPolicy field mismatch.';
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
            makeRequire({
                './configLoader.js': {
                    loadProjectConfig: function() {
                        return { jira: { fields: {} } };
                    }
                }
            }),
            {
                jira_get_comments: function() { return []; },
                gemini_ai_chat: function() { return 'RCA'; },
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
