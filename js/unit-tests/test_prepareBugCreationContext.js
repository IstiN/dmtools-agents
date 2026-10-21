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
            './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
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
            './configLoader.js': loaderWith(jiraOverrides), './config.js': configModule, './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'), './common/trackers.js': bulkTrackers
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

// ── gh-1081: characterization of the bulk action wiring (pinned before the
// CRAP refactor — outputs, file writes and search order must not move).

function bulkLoaderWithFields(fields) {
    // real loader, but loadProjectConfig patches jira.fields with the given map
    return {
        loadProjectConfig: function() {
            var base = configLoaderModule.loadProjectConfig({});
            return Object.assign({}, base, { jira: Object.assign({}, base.jira, { fields: fields }) });
        },
        interpolateJql: configLoaderModule.interpolateJql
    };
}

function loadBulk(mocks, requireOverrides, configModuleOverride) {
    var allMocks = Object.assign({ file_write: function() {} }, mocks || {});
    var req = {
        './configLoader.js': configLoaderModule,
        './config.js': configModuleOverride || configModule,
        './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
        './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModuleOverride || configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), allMocks)
    };
    Object.keys(requireOverrides || {}).forEach(function(k) { req[k] = requireOverrides[k]; });
    return loadModule('js/prepareBulkBugsCreationContext.js', makeRequire(req), allMocks);
}

function makeBulkWrites() {
    var writes = [];
    return {
        writes: writes,
        file_write: function(path, content) { writes.push({ path: path, content: content }); },
        byPath: function(name) {
            return writes.filter(function(w) { return w.path.indexOf('/' + name) !== -1; })[0];
        },
        paths: function() { return writes.map(function(w) { return w.path; }); }
    };
}

suite('prepareBulkBugsCreationContext: action wiring characterization (gh-1081)', function() {

    function tcFixture() {
        return {
            key: 'TS-614',
            fields: {
                summary: 'Desktop header alignment',
                description: 'Expected 32px controls',
                comment: { comments: [{ body: 'first note' }, { body: 'Still failing at 32px' }] }
            }
        };
    }

    test('no failed TCs: early return writes ONLY no_failed_tcs.md and never queries open bugs', function() {
        var searches = [];
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) { searches.push(args); return []; }
        });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        assert.deepEqual(w.paths(), ['input/bulk/no_failed_tcs.md'],
            'the early return must not write failed_tcs.json / open_bugs.json / context.md');
        assert.contains(w.byPath('no_failed_tcs.md').content, 'No failed Test Cases to process');
        assert.equal(searches.length, 1, 'only the failed-TC query ran');
    });

    test('failed TC search failure degrades to the no_failed_tcs path', function() {
        var searches = [];
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) {
                searches.push(args);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) throw new Error('jira down');
                return [];
            }
        });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        assert.deepEqual(w.paths(), ['input/bulk/no_failed_tcs.md']);
        assert.equal(searches.length, 1);
    });

    test('failed TC search returning null is treated as no results', function() {
        var searches = [];
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) { searches.push(args); return null; }
        });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        assert.deepEqual(w.paths(), ['input/bulk/no_failed_tcs.md']);
    });

    test('open bugs search failure still writes context.md with zero bugs', function() {
        var searches = [];
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) {
                searches.push(args);
                if (args.jql.indexOf('issuetype in (Bug)') !== -1) throw new Error('bugs down');
                return [tcFixture()];
            }
        });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        assert.contains(w.byPath('open_bugs.json').content, '[]');
        var ctx = w.byPath('context.md').content;
        assert.contains(ctx, 'Failed TCs to process**: 1');
        assert.contains(ctx, 'Non-Done bugs for dedup check**: 0');
        assert.equal(searches.length, 3, 'TC query + linked Done bugs + open bugs');
    });

    test('open bugs search returning null is treated as empty', function() {
        var searches = [];
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) {
                searches.push(args);
                if (args.jql.indexOf('issuetype in (Bug)') !== -1) return null;
                return [tcFixture()];
            }
        });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        assert.contains(w.byPath('open_bugs.json').content, '[]');
    });

    test('params wrapped in jobParams drive the action', function() {
        var searches = [];
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) { searches.push(args); return [tcFixture()]; }
        });
        mod.action({ jobParams: { inputFolderPath: 'input/wrapped', customParams: { batchSize: 5 }, jira: { project: 'JP' } } });
        assert.ok(w.paths().indexOf('input/wrapped/failed_tcs.json') !== -1, JSON.stringify(w.paths()));
        assert.contains(searches[0].jql, 'project = JP');
    });

    test('project key falls back to the params.ticket.key prefix, then to TS', function() {
        var searches = [];
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) { searches.push(args); return [tcFixture()]; }
        });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, ticket: { key: 'AB-9' } });
        assert.contains(searches[0].jql, 'project = AB');
        assert.contains(w.byPath('context.md').content, '**Project**: AB');

        var searches2 = [];
        var w2 = makeBulkWrites();
        var mod2 = loadBulk({
            file_write: w2.file_write,
            jira_search_by_jql: function(args) { searches2.push(args); return [tcFixture()]; }
        });
        mod2.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 } });
        assert.contains(searches2[0].jql, 'project = TS');
        assert.contains(w2.byPath('context.md').content, '**Project**: TS');
    });

    test('default batchSize is 50; customParams.batchSize overrides (maxResults observed)', function() {
        var searches = [];
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) { searches.push(args); return [tcFixture()]; }
        });
        mod.action({ inputFolderPath: 'input/bulk', customParams: {}, jira: { project: 'TS' } });
        assert.equal(searches[0].maxResults, 50, 'default batchSize');

        var searches2 = [];
        var w2 = makeBulkWrites();
        var mod2 = loadBulk({
            file_write: w2.file_write,
            jira_search_by_jql: function(args) { searches2.push(args); return [tcFixture()]; }
        });
        mod2.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 7 }, jira: { project: 'TS' } });
        assert.equal(searches2[0].maxResults, 7, 'custom batchSize');
    });

    test('parent and last-comment shapes land in failed_tcs.json (2+ comments)', function() {
        var w = makeBulkWrites();
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [
                        {
                            key: 'TS-1',
                            fields: {
                                summary: 's1',
                                description: 'd1',
                                comment: { comments: [{ body: 'first note' }, { body: 'LAST wins' }] },
                                parent: { key: 'PK-1', fields: { summary: 'Parent summary' } }
                            }
                        },
                        {
                            key: 'TS-2',
                            fields: {
                                summary: 's2',
                                description: 'd2',
                                parent: { key: 'PK-2' }
                            }
                        },
                        { key: 'TS-3', fields: { summary: 's3', description: 'd3' } }
                    ];
                }
                return [];
            }
        });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        var list = JSON.parse(w.byPath('failed_tcs.json').content);
        assert.equal(list.length, 3);
        assert.equal(list[0].lastComment, 'LAST wins', 'the LAST comment body wins');
        assert.equal(list[0].parent, 'PK-1 — Parent summary');
        assert.equal(list[1].lastComment, '', 'TC without comments gets an empty lastComment');
        assert.equal(list[1].parent, 'PK-2 — ', 'parent without fields still carries the key');
        assert.equal(list[2].parent, '', 'TC without parent gets an empty parent');
    });

    test('failedReason resolves from config.jira.fields.failedReason when customParams does not override', function() {
        var searches = [];
        var w = makeBulkWrites();
        var loader = bulkLoaderWithFields({ failedReason: 'Cfg Failed Reason' });
        var trackersMod = loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {
            jira_search_by_jql: function(args) {
                searches.push(args);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [{ key: 'TS-9', fields: { summary: 's', description: 'd', 'Cfg Failed Reason': 'From config' } }];
                }
                return [];
            }
        });
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) { searches.push(args); return []; }
        }, { './configLoader.js': loader, './common/trackers.js': trackersMod });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        assert.contains(w.byPath('failed_tcs.json').content, 'From config');
    });

    test("'Failed Reason' literal is used when the config module carries no FAILED_REASON", function() {
        var stubConfig = Object.assign({}, configModule);
        stubConfig.JIRA_FIELDS = Object.assign({}, configModule.JIRA_FIELDS, { FAILED_REASON: '' });
        var searches = [];
        var w = makeBulkWrites();
        var trackersMod = loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {
            jira_search_by_jql: function(args) {
                searches.push(args);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [{ key: 'TS-9', fields: { summary: 's', description: 'd', 'Failed Reason': 'literal win' } }];
                }
                return [];
            }
        });
        var mod = loadBulk({
            file_write: w.file_write,
            jira_search_by_jql: function(args) { searches.push(args); return []; }
        }, { './config.js': stubConfig, './common/trackers.js': trackersMod });
        mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        assert.contains(w.byPath('failed_tcs.json').content, 'literal win');
    });

    test('unexpected errors are logged and RETHROWN (JSRunner job failure)', function() {
        var w = makeBulkWrites();
        var brokenLoader = {
            loadProjectConfig: function() { throw new Error('config exploded'); },
            interpolateJql: configLoaderModule.interpolateJql
        };
        var mod = loadBulk({ file_write: w.file_write }, { './configLoader.js': brokenLoader });
        var rethrown = false;
        try {
            mod.action({ inputFolderPath: 'input/bulk', customParams: { batchSize: 5 }, jira: { project: 'TS' } });
        } catch (e) {
            rethrown = e.message === 'config exploded';
        }
        assert.equal(rethrown, true, 'the original error surfaces after logging');
        assert.equal(w.writes.length, 0, 'nothing is written when setup fails');
    });
});

// ── gh-1081: direct tests of the extracted pure parse/build helpers.

function loadBulkPure(configModuleOverride) {
    return loadModule('js/prepareBulkBugsCreationContext.js', makeRequire({
        './configLoader.js': configLoaderModule,
        './config.js': configModuleOverride || configModule,
        './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
        './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModuleOverride || configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {})
    }), {});
}

suite('prepareBulkBugsCreationContext: extracted helpers (gh-1081)', function() {
    var mod = loadBulkPure();

    test('resolveActionParams: inputFolderPath / jobParams / bare params', function() {
        var direct = { inputFolderPath: 'in' };
        assert.equal(mod.resolveActionParams(direct), direct);
        var wrapped = { jobParams: { inputFolderPath: 'in2' } };
        assert.equal(mod.resolveActionParams(wrapped), wrapped.jobParams);
        var bare = { customParams: {} };
        assert.equal(mod.resolveActionParams(bare), bare);
    });

    test('resolveSettings: project key chain and batchSize defaults', function() {
        var s1 = mod.resolveSettings({ inputFolderPath: 'in', jira: { project: 'JP' }, customParams: { batchSize: 9 } }, {});
        assert.equal(s1.inputFolder, 'in');
        assert.equal(s1.projectKey, 'JP');
        assert.equal(s1.batchSize, 9);
        var s2 = mod.resolveSettings({ inputFolderPath: 'in' }, { ticket: { key: 'AB-7' } });
        assert.equal(s2.projectKey, 'AB');
        assert.equal(s2.batchSize, 50, 'default batchSize');
        var s3 = mod.resolveSettings({ inputFolderPath: 'in' }, {});
        assert.equal(s3.projectKey, 'TS', 'final fallback');
        assert.deepEqual(s3.customParams, {}, 'customParams default');
    });

    test('buildStatusConfig: jira-less config degrades to empty statuses', function() {
        var withJira = mod.buildStatusConfig({ jira: { statuses: { DONE: 'Closed' }, useConfiguredStatusesInQueries: true } }, 'TS');
        assert.deepEqual(withJira.jira.statuses, { DONE: 'Closed' });
        assert.equal(withJira.jira.useConfiguredStatusesInQueries, true);
        assert.equal(withJira.jira.project, 'TS');
        assert.equal(withJira.jira.parentTicket, '');
        var noJira = mod.buildStatusConfig({}, 'TS');
        assert.deepEqual(noJira.jira.statuses, {});
        assert.equal(noJira.jira.useConfiguredStatusesInQueries, false);
    });

    test('buildQueries: defaults are the historical literals; overrides win', function() {
        var cfg = { jira: { project: 'TS', parentTicket: '', statuses: configModule.STATUSES } };
        var q = mod.buildQueries({}, cfg);
        assert.equal(q.openBugsJql, 'project = TS AND issuetype in (Bug) AND status not in (Done)');
        assert.contains(q.failedTCsJql, 'issuetype = "Test Case"');
        assert.contains(q.failedTCsJql, "status in ('Failed')");
        assert.contains(q.failedTCsJql, 'sm_bug_creation_triggered');
        var q2 = mod.buildQueries({ openBugsJql: 'project = X', failedTCsJql: 'project = Y' }, cfg);
        assert.equal(q2.openBugsJql, 'project = X');
        assert.equal(q2.failedTCsJql, 'project = Y');
    });

    test('extractFailedReason: every branch', function() {
        assert.equal(mod.extractFailedReason(null, 'F'), '');
        assert.equal(mod.extractFailedReason({}, null), '');
        assert.equal(mod.extractFailedReason({}, 'F'), '');
        assert.equal(mod.extractFailedReason({ F: 'plain' }, 'F'), 'plain');
        assert.equal(mod.extractFailedReason({ F: '' }, 'F'), '', 'an empty STRING is returned as-is (no sibling scan)');
        assert.equal(mod.extractFailedReason({ F: { value: 'obj' } }, 'F'), 'obj');
        assert.equal(mod.extractFailedReason({ F: {} }, 'F'), '');
        assert.equal(mod.extractFailedReason({ F: null, other: 'x' }, 'F'), '',
            'a non-customfield name never scans siblings');
        assert.equal(mod.extractFailedReason(
            { customfield_9: null, 'Failed Reason (customfield_9)': 'sib' }, 'customfield_9'), 'sib');
        assert.equal(mod.extractFailedReason(
            { customfield_9: null, 'Failed Reason (customfield_9)': { value: 'sibObj' } }, 'customfield_9'), 'sibObj');
        assert.equal(mod.extractFailedReason({ customfield_9: null, other: 'x' }, 'customfield_9'), '',
            'customfield name with no matching sibling returns empty');
        assert.equal(mod.extractFailedReason(
            { customfield_9: 'direct', 'Failed Reason (customfield_9)': 'sib' }, 'customfield_9'), 'direct',
            'a direct string beats the sibling scan');
    });

    test('extractAttachmentNames: missing/non-array/filter/multi', function() {
        assert.deepEqual(mod.extractAttachmentNames(undefined), []);
        assert.deepEqual(mod.extractAttachmentNames({}), []);
        assert.deepEqual(mod.extractAttachmentNames({ attachment: 'nope' }), []);
        assert.deepEqual(mod.extractAttachmentNames({ attachment: [
            { filename: 'a.log' }, { filename: '' }, {}, { filename: 'b.png' }
        ] }), ['a.log', 'b.png']);
    });

    test('summarizeDoneBug: defaults and 500-char description truncation', function() {
        var full = mod.summarizeDoneBug({
            key: 'B-1',
            fields: { summary: 'S', status: { name: 'Done' }, updated: 'U', description: new Array(502).join('x') }
        });
        assert.deepEqual(full, { key: 'B-1', summary: 'S', status: 'Done', updated: 'U', description: new Array(501).join('x') });
        var minimal = mod.summarizeDoneBug({ key: 'B-2', fields: {} });
        assert.deepEqual(minimal, { key: 'B-2', summary: '', status: '', updated: '', description: '' });
        var noFields = mod.summarizeDoneBug({ key: 'B-3' });
        assert.deepEqual(noFields, { key: 'B-3', summary: '', status: '', updated: '', description: '' });
    });

    test('getFailedReasonFieldName: customParams > config.jira.fields > JIRA_FIELDS > literal', function() {
        assert.equal(mod.getFailedReasonFieldName({}, { failedReasonField: 'CP' }), 'CP');
        assert.equal(mod.getFailedReasonFieldName({ jira: { fields: { failedReason: 'CF' } } }, {}), 'CF');
        assert.equal(mod.getFailedReasonFieldName({}, {}), configModule.JIRA_FIELDS.FAILED_REASON);
        var stub = Object.assign({}, configModule);
        stub.JIRA_FIELDS = Object.assign({}, configModule.JIRA_FIELDS, { FAILED_REASON: '' });
        assert.equal(loadBulkPure(stub).getFailedReasonFieldName({}, {}), 'Failed Reason');
    });

    test('lastCommentOf: none / empty / multiple (last wins)', function() {
        assert.equal(mod.lastCommentOf({}), '');
        assert.equal(mod.lastCommentOf({ comment: { comments: [] } }), '');
        assert.equal(mod.lastCommentOf({ comment: { comments: [{ body: 'a' }, { body: 'b' }] } }), 'b');
    });

    test('parentLabel: none / key only / key + summary', function() {
        assert.equal(mod.parentLabel({}), '');
        assert.equal(mod.parentLabel({ parent: { key: 'PK' } }), 'PK — ');
        assert.equal(mod.parentLabel({ parent: { key: 'PK', fields: { summary: 'S' } } }), 'PK — S');
        assert.equal(mod.parentLabel({ parent: { key: 'PK', fields: null } }), 'PK — ');
    });

    test('bugToEntry: full and minimal shapes, description truncation', function() {
        var full = mod.bugToEntry({
            key: 'B-1',
            fields: { summary: 'S', description: new Array(502).join('y'), status: { name: 'Open' }, priority: { name: 'P1' } }
        });
        assert.deepEqual(full, {
            key: 'B-1', summary: 'S', description: new Array(501).join('y'), status: 'Open', priority: 'P1'
        });
        var minimal = mod.bugToEntry({ key: 'B-2', fields: {} });
        assert.deepEqual(minimal, { key: 'B-2', summary: '', description: '', status: '', priority: '' });
        var noFields = mod.bugToEntry({ key: 'B-3' });
        assert.deepEqual(noFields, { key: 'B-3', summary: '', description: '', status: '', priority: '' });
    });

    test('fetchFailedTCs: customfield field requested, null results, error swallowed', function() {
        var seen = [];
        function tracker(impl) {
            return { searchIssues: function(jql, opts) { seen.push({ jql: jql, opts: opts }); return impl(); } };
        }
        var r1 = mod.fetchFailedTCs(tracker(function() { return [{ key: 'T-1' }]; }), 'JQL', 7, 'customfield_1');
        assert.deepEqual(r1, [{ key: 'T-1' }]);
        assert.equal(seen[0].opts.maxResults, 7);
        assert.ok(seen[0].opts.fields.indexOf('customfield_1') !== -1, 'customfield is requested explicitly');
        assert.ok(seen[0].opts.fields.indexOf('labels') !== -1);

        var r2 = mod.fetchFailedTCs(tracker(function() { return [{ key: 'T-2' }]; }), 'JQL', 7, 'Failed Reason');
        assert.ok(seen[1].opts.fields.indexOf('customfield') === -1 || seen[1].opts.fields.indexOf('customfield_1') === -1,
            'non-customfield names are not pushed');

        var r3 = mod.fetchFailedTCs(tracker(function() { return null; }), 'JQL', 7, 'F');
        assert.deepEqual(r3, [], 'null search results normalize to []');

        var r4 = mod.fetchFailedTCs(tracker(function() { throw new Error('down'); }), 'JQL', 7, 'F');
        assert.deepEqual(r4, [], 'search errors degrade to []');
    });

    test('fetchOpenBugs: fixed field set, null results, error swallowed', function() {
        var seen = [];
        function tracker(impl) {
            return { searchIssues: function(jql, opts) { seen.push(opts); return impl(); } };
        }
        var r1 = mod.fetchOpenBugs(tracker(function() { return [{ key: 'B-1' }]; }), 'JQL');
        assert.deepEqual(r1, [{ key: 'B-1' }]);
        assert.deepEqual(seen[0].fields, ['key', 'summary', 'description', 'status', 'priority']);
        assert.equal(seen[0].maxResults, 300);
        assert.deepEqual(mod.fetchOpenBugs(tracker(function() { return null; }), 'JQL'), []);
        assert.deepEqual(mod.fetchOpenBugs(tracker(function() { throw new Error('down'); }), 'JQL'), []);
    });

    test('fetchHistoricalDoneBugs: injected tracker success, error swallowed, default tracker path', function() {
        var t = {
            searchIssues: function(jql, opts) {
                assert.contains(jql, 'linkedIssues("TS-614")');
                assert.contains(jql, 'status in (Done)');
                assert.deepEqual(opts.fields, ['key', 'summary', 'description', 'status', 'updated']);
                assert.equal(opts.maxResults, 10);
                return [{ key: 'B-9', fields: { summary: 'S', status: { name: 'Done' } } }];
            }
        };
        var bugs = mod.fetchHistoricalDoneBugs('TS-614', t);
        assert.equal(bugs.length, 1);
        assert.equal(bugs[0].key, 'B-9');

        assert.deepEqual(mod.fetchHistoricalDoneBugs('TS-614', {
            searchIssues: function() { throw new Error('down'); }
        }), [], 'search errors degrade to []');

        // no tracker passed → the real (jira) tracker is built; the stubbed
        // jira_search_by_jql global answers with an empty page
        var empty = loadModule('js/prepareBulkBugsCreationContext.js', makeRequire({
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {
                jira_search_by_jql: function() { return []; }
            })
        }), {}).fetchHistoricalDoneBugs('TS-1');
        assert.deepEqual(empty, []);
    });

    test('buildTcList: 2+ TCs accumulate historical counts and keep shapes', function() {
        var t = {
            searchIssues: function(jql) {
                return jql.indexOf('TS-1') !== -1 ? [{ key: 'B-1', fields: { summary: 's' } }] : [];
            }
        };
        var out = mod.buildTcList([
            { key: 'TS-1', fields: { summary: 's1', description: 'd1', comment: { comments: [{ body: 'c1' }] } } },
            { key: 'TS-2', fields: { summary: 's2', description: 'd2' } }
        ], t, 'F');
        assert.equal(out.tcList.length, 2);
        assert.equal(out.tcList[0].key, 'TS-1');
        assert.equal(out.tcList[0].lastComment, 'c1');
        assert.equal(out.tcList[0].historicalDoneBugs.length, 1);
        assert.equal(out.tcList[1].historicalDoneBugs.length, 0);
        assert.equal(out.totalHistoricalDoneBugs, 1, 'counts sum across TCs');
    });

    test('writeOpenBugs: empty writes [] literal; non-empty writes pretty JSON', function() {
        var w = makeBulkWrites();
        var mod2 = loadModule('js/prepareBulkBugsCreationContext.js', makeRequire({
            './configLoader.js': configLoaderModule,
            './config.js': configModule,
            './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {})
        }), { file_write: w.file_write });
        mod2.writeOpenBugs('input/x', []);
        assert.equal(w.byPath('open_bugs.json').content, '[]');
        mod2.writeOpenBugs('input/x', [{ key: 'B-1' }]);
        var lastWrite = w.writes.filter(function(wr) { return wr.path.indexOf('/open_bugs.json') !== -1; })[1];
        assert.deepEqual(JSON.parse(lastWrite.content), [{ key: 'B-1' }]);
    });

    test('buildContextMd carries the project and all three counters', function() {
        var md = mod.buildContextMd('TS', 3, 5, 7);
        assert.contains(md, '**Project**: TS');
        assert.contains(md, 'Failed TCs to process**: 3');
        assert.contains(md, 'Non-Done bugs for dedup check**: 5');
        assert.contains(md, 'Historical Done linked bugs**: 7');
        assert.contains(md, 'input/failed_tcs.json');
        assert.contains(md, 'input/open_bugs.json');
    });

    test('defaultOpenBugsTemplate, defaultFailedTCsTemplate, and buildQueries support ado provider (gh-1122)', function() {
        assert.contains(mod.defaultOpenBugsTemplate('ado'), "FROM WorkItems WHERE [System.TeamProject] = '{jiraProject}'");
        assert.contains(mod.defaultOpenBugsTemplate('jira'), 'project = {jiraProject}');
        assert.contains(mod.defaultFailedTCsTemplate('ado'), "FROM WorkItems WHERE [System.TeamProject] = '{jiraProject}'");
        assert.contains(mod.defaultFailedTCsTemplate('jira'), 'project = {jiraProject}');

        var sc = mod.buildStatusConfig({ jira: { statuses: { DONE: 'Closed', FAILED: 'Failed' }, useConfiguredStatusesInQueries: true } }, 'MyProj');
        var adoQueries = mod.buildQueries({}, sc, 'ado');
        assert.equal(
            adoQueries.openBugsJql,
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'MyProj' AND [System.WorkItemType] = 'Bug' AND [System.State] NOT IN ('Closed')"
        );
        assert.equal(
            adoQueries.failedTCsJql,
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'MyProj' AND [System.WorkItemType] = 'Test Case' AND [System.State] IN ('Failed') AND NOT [System.Tags] CONTAINS 'sm_bug_creation_triggered' ORDER BY [System.CreatedDate] ASC"
        );
    });
});

