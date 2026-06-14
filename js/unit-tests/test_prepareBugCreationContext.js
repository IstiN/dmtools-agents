/**
 * Unit tests for bug creation context preparation scripts.
 */

function loadPrepareBugCreationContext(mocks) {
    var calls = {
        searches: [],
        writes: [],
        comments: []
    };

    var defaults = {
        jira_get_ticket: function(args) {
            return {
                key: args.key,
                fields: {
                    summary: 'Test summary',
                    description: 'Test description'
                }
            };
        },
        jira_search_by_jql: function(args) {
            calls.searches.push(args);
            return [];
        },
        jira_post_comment: function(args) { calls.comments.push(args); },
        file_write: function(path, content) { calls.writes.push({ path: path, content: content }); }
    };

    var mod = loadModule(
        'js/prepareBugCreationContext.js',
        makeRequire({}),
        Object.assign({}, defaults, mocks || {})
    );

    return { mod: mod, calls: calls };
}

function loadPrepareBulkBugsCreationContext(mocks) {
    var calls = {
        searches: [],
        writes: []
    };

    var defaults = {
        jira_search_by_jql: function(args) {
            calls.searches.push(args);
            return [];
        },
        file_write: function(path, content) { calls.writes.push({ path: path, content: content }); }
    };

    var mod = loadModule(
        'js/prepareBulkBugsCreationContext.js',
        makeRequire({
            './configLoader.js': configLoaderModule,
            './config.js': configModule
        }),
        Object.assign({}, defaults, mocks || {})
    );

    return { mod: mod, calls: calls };
}

suite('prepareBugCreationContext', function() {

    test('writes linked Done bugs as recurrence history without adding them to open bug matches', function() {
        var loaded = loadPrepareBugCreationContext({
            jira_search_by_jql: function(args) {
                loaded.calls.searches.push(args);
                if (args.jql.indexOf('status in (Done)') !== -1) {
                    return [{
                        key: 'TS-1196',
                        fields: {
                            summary: 'Desktop header controls are mis-sized',
                            description: 'Prior fix details',
                            status: { name: 'Done' },
                            updated: '2026-05-28T11:36:51.621+0300'
                        }
                    }];
                }
                assert.contains(args.jql, 'status not in (Done)');
                return [];
            }
        });

        var result = loaded.mod.action({
            inputFolderPath: 'input/TS-614'
        });

        assert.equal(result.success, true);
        assert.equal(result.historicalDoneBugsLoaded, 1);
        assert.equal(loaded.calls.searches.length, 2);
        assert.contains(loaded.calls.searches[0].jql, 'status in (Done)');
        assert.contains(loaded.calls.searches[1].jql, 'status not in (Done)');

        var historyWrite = loaded.calls.writes.filter(function(w) {
            return w.path === 'input/TS-614/historical_done_bugs.md';
        })[0];
        assert.ok(historyWrite, 'historical_done_bugs.md should be written');
        assert.contains(historyWrite.content, 'TS-1196');
        assert.contains(historyWrite.content, 'recurrence context only');
    });

});

suite('prepareBulkBugsCreationContext', function() {

    test('includes linked Done bug history inside failed_tcs.json', function() {
        var loaded = loadPrepareBulkBugsCreationContext({
            jira_search_by_jql: function(args) {
                loaded.calls.searches.push(args);
                if (args.jql.indexOf('status = Failed') !== -1) {
                    return [{
                        key: 'TS-614',
                        fields: {
                            summary: 'Desktop header alignment',
                            description: 'Expected 32px controls',
                            comment: { comments: [{ body: 'Still failing at 32px alignment' }] }
                        }
                    }];
                }
                if (args.jql.indexOf('linkedIssues("TS-614")') !== -1 && args.jql.indexOf('status in (Done)') !== -1) {
                    return [{
                        key: 'TS-1196',
                        fields: {
                            summary: 'Desktop header controls are mis-sized',
                            description: 'Prior fix details',
                            status: { name: 'Done' },
                            updated: '2026-05-28T11:36:51.621+0300'
                        }
                    }];
                }
                assert.contains(args.jql, 'status not in (Done)');
                return [];
            }
        });

        loaded.mod.action({
            inputFolderPath: 'input/bulk',
            customParams: {
                batchSize: 50
            },
            jira: { project: 'TS' }
        });

        var failedWrite = loaded.calls.writes.filter(function(w) {
            return w.path === 'input/bulk/failed_tcs.json';
        })[0];
        assert.ok(failedWrite, 'failed_tcs.json should be written');
        assert.contains(failedWrite.content, '"historicalDoneBugs"');
        assert.contains(failedWrite.content, 'TS-1196');

        var contextWrite = loaded.calls.writes.filter(function(w) {
            return w.path === 'input/bulk/context.md';
        })[0];
        assert.ok(contextWrite, 'context.md should be written');
        assert.contains(contextWrite.content, 'Historical Done linked bugs**: 1');
    });

});
