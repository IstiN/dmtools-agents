function d2Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

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
        makeRequire({ './common/trackers.js': d2Trackers(Object.assign({}, defaults, mocks || {})), './configLoader.js': configLoaderModule }),
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

    var allMocks = Object.assign({}, defaults, mocks || {});
    var mod = loadModule(
        'js/prepareBulkBugsCreationContext.js',
        makeRequire({
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), allMocks)
        }),
        allMocks
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
                if (args.jql.indexOf("status in ('Failed')") !== -1) {
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

    test('customParams.failedReasonField overrides config field name', function() {
        var loaded = loadPrepareBulkBugsCreationContext({
            jira_search_by_jql: function(args) {
                loaded.calls.searches.push(args);
                if (args.jql.indexOf("status in ('Failed')") !== -1) {
                    return [{
                        key: 'TS-800',
                        fields: {
                            summary: 'Custom field TC',
                            description: 'Testing custom failed reason field',
                            'Custom Failed Reason': 'Custom field value'
                        }
                    }];
                }
                return [];
            }
        });

        loaded.mod.action({
            inputFolderPath: 'input/bulk-custom',
            customParams: {
                batchSize: 50,
                failedReasonField: 'Custom Failed Reason'
            },
            jira: { project: 'TS' }
        });

        var failedWrite = loaded.calls.writes.filter(function(w) {
            return w.path === 'input/bulk-custom/failed_tcs.json';
        })[0];
        assert.ok(failedWrite, 'failed_tcs.json should be written');
        assert.contains(failedWrite.content, '"failedReason"');
        assert.contains(failedWrite.content, 'Custom field value');
    });

    test('extracts Failed Reason when dmtools transforms customfield ID to friendly key', function() {
        var loaded = loadPrepareBulkBugsCreationContext({
            jira_search_by_jql: function(args) {
                loaded.calls.searches.push(args);
                if (args.jql.indexOf("status in ('Failed')") !== -1) {
                    // Verify the raw custom field ID is requested
                    assert.ok(args.fields.indexOf('customfield_10535') !== -1,
                        'raw customfield ID should be requested');
                    return [{
                        key: 'TS-801',
                        fields: {
                            summary: 'Transformed key TC',
                            description: 'Testing transformed field key',
                            'Failed Reason (customfield_10535)': 'Transformed field value'
                        }
                    }];
                }
                return [];
            }
        });

        loaded.mod.action({
            inputFolderPath: 'input/bulk-transformed',
            customParams: {
                batchSize: 50,
                failedReasonField: 'customfield_10535'
            },
            jira: { project: 'TS' }
        });

        var failedWrite = loaded.calls.writes.filter(function(w) {
            return w.path === 'input/bulk-transformed/failed_tcs.json';
        })[0];
        assert.ok(failedWrite, 'failed_tcs.json should be written');
        assert.contains(failedWrite.content, 'Transformed field value');
    });

});

suite('creation automation queries follow jira.statuses when the project opts in (agents#855)', function() {

    // real loader, but loadProjectConfig returns the defaults patched with the given jira overrides
    function loaderWith(jiraOverrides) {
        return {
            loadProjectConfig: function() {
                // build a fresh object: loadProjectConfig shares nested default objects between calls, so
                // mutating its result would leak one test's overrides into the next
                var base = configLoaderModule.loadProjectConfig({});
                var jira = Object.assign({}, base.jira);
                Object.keys(jiraOverrides || {}).forEach(function(k) {
                    jira[k] = (k === 'statuses') ? Object.assign({}, base.jira.statuses, jiraOverrides[k]) : jiraOverrides[k];
                });
                return Object.assign({}, base, { jira: jira });
            },
            interpolateJql: configLoaderModule.interpolateJql
        };
    }
    function trackersFor(searches) {
        return loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {
            jira_search_by_jql: function(args) { searches.push(args.jql); return []; },
            jira_get_ticket: function() { return JSON.stringify({ key: 'TS-1', fields: { summary: 's' } }); },
            jira_post_comment: function() {}
        });
    }
    function runBug(jiraOverrides, customParams) {
        var searches = [];
        var mocks = { jira_search_by_jql: function(a) { searches.push(a.jql); return []; },
            jira_get_ticket: function() { return JSON.stringify({ key: 'TS-1', fields: { summary: 's' } }); },
            file_write: function() {} };
        var mod = loadModule('js/prepareBugCreationContext.js', makeRequire({
            './common/trackers.js': trackersFor(searches), './configLoader.js': loaderWith(jiraOverrides)
        }), mocks);
        mod.action({ inputFolderPath: 'input/TS-614', customParams: customParams || {} });
        return searches;
    }
    function runBulk(jiraOverrides, customParams) {
        var searches = [];
        var mocks = { file_write: function() {} };
        // the open-bugs query only runs after at least one failed Test Case was found
        var bulkTrackers = loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {
            jira_search_by_jql: function(args) {
                searches.push(args.jql);
                return args.jql.indexOf('issuetype = "Test Case"') !== -1
                    ? [{ key: 'TS-9', fields: { summary: 'tc', description: 'd', comment: { comments: [] } } }]
                    : [];
            },
            jira_get_ticket: function() { return JSON.stringify({ key: 'TS-9', fields: { summary: 'tc' } }); }
        });
        var mod = loadModule('js/prepareBulkBugsCreationContext.js', makeRequire({
            './configLoader.js': loaderWith(jiraOverrides), './config.js': configModule, './common/trackers.js': bulkTrackers
        }), mocks);
        mod.action({ inputFolderPath: 'input/bulk', customParams: customParams || { batchSize: 5 }, jira: { project: 'TS' } });
        return searches;
    }

    test('default: bug creation queries are exactly the previous ones', function() {
        var q = runBug({});
        assert.ok(q.some(function(j) { return j === 'project = TS AND issuetype in (Bug) AND status not in (Done)'; }), JSON.stringify(q));
        assert.ok(q.some(function(j) { return j.indexOf('issuetype = Bug AND status in (Done) ORDER BY updated DESC') !== -1; }), JSON.stringify(q));
    });

    test('opt-in: the Done status of bug creation follows jira.statuses.DONE', function() {
        var q = runBug({ useConfiguredStatusesInQueries: true, statuses: { DONE: 'Closed' } });
        assert.ok(q.some(function(j) { return j === 'project = TS AND issuetype in (Bug) AND status not in (Closed)'; }), JSON.stringify(q));
        assert.ok(q.some(function(j) { return j.indexOf('status in (Closed)') !== -1; }), JSON.stringify(q));
    });

    test('override without opt-in changes nothing (existing deployments keep their queries)', function() {
        var q = runBug({ statuses: { DONE: 'Closed' } });
        assert.ok(q.some(function(j) { return j.indexOf('status not in (Done)') !== -1; }), JSON.stringify(q));
        assert.ok(!q.some(function(j) { return j.indexOf('Closed') !== -1; }), JSON.stringify(q));
    });

    test('an explicit customParams.openBugsJql is used as given (with placeholders still resolved)', function() {
        var q = runBug({}, { openBugsJql: 'project = X AND status = {status.DONE:Done}' });
        assert.ok(q.some(function(j) { return j === 'project = X AND status = Done'; }), JSON.stringify(q));
    });

    test('bulk: default queries are exactly the previous ones', function() {
        var q = runBulk({});
        assert.ok(q.some(function(j) { return j === 'project = TS AND issuetype in (Bug) AND status not in (Done)'; }), JSON.stringify(q));
        assert.ok(q.some(function(j) { return j.indexOf('issuetype = "Test Case" AND status in (\'Failed\') AND (labels is EMPTY') !== -1; }), JSON.stringify(q));
    });

    test('bulk opt-in: Failed and Done both follow jira.statuses', function() {
        var q = runBulk({ useConfiguredStatusesInQueries: true, statuses: { FAILED: 'Test Failed', DONE: 'Closed' } });
        assert.ok(q.some(function(j) { return j.indexOf("status in ('Test Failed') AND (labels is EMPTY") !== -1; }), JSON.stringify(q));
        assert.ok(q.some(function(j) { return j === 'project = TS AND issuetype in (Bug) AND status not in (Closed)'; }), JSON.stringify(q));
    });

    test('the shipped bug-creation agent JSONs use placeholders whose defaults equal the old literals', function() {
        ['bug_creation.json', 'bulk_bugs_creation.json'].forEach(function(f) {
            var cp = JSON.parse(file_read({ path: f })).params.customParams;
            var cfg = { jira: { project: 'TS', parentTicket: '', statuses: configModule.STATUSES } };
            assert.equal(configLoaderModule.interpolateJql(cp.openBugsJql, cfg), 'project = TS AND issuetype in (Bug) AND status not in (Done)', f);
            if (cp.failedTCsJql) {
                assert.contains(configLoaderModule.interpolateJql(cp.failedTCsJql, cfg), "status in ('Failed') AND");
            }
        });
    });
});

