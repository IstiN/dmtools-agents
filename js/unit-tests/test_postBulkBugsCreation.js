/**
 * Unit tests for js/postBulkBugsCreation.js
 */

function loadPostBulkBugsCreation(mocks) {
    var defaults = {
        jira_post_comment: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {},
        jira_add_label: function() {},
        jira_link_issues: function() {},
        jira_create_ticket_basic: function() { return ''; },
        jira_search_by_jql: function() { return []; },
        jira_attach_file_to_ticket: function() {},
        jira_get_ticket: function() { return { fields: {} }; },
        file_read: function() { return null; }
    };

    var freshConfigLoader = loadModule(
        'js/configLoader.js',
        makeRequire({
            './config.js': configModule,
            './common/scm.js': { createScm: function() { return {}; } }
        }),
        { file_read: function() { return null; } }
    );

    return loadModule(
        'js/postBulkBugsCreation.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': freshConfigLoader,
            './common/feedbackLoop.js': {
                resumeAgent: function() {
                    return { attempted: false, reason: 'unit test' };
                }
            },
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function() {}
            }
        }),
        Object.assign({}, defaults, mocks)
    );
}

suite('postBulkBugsCreation', function() {

    test('moves skipped test-code issues to In Rework and clears trigger labels', function() {
        var statusMoves = [];
        var removedLabels = [];
        var comments = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-396'],
                        newBugs: [],
                        links: [],
                        fixedByBug: [],
                        skipped: [
                            { tcKey: 'TS-396', reason: 'Failure is caused by outdated test code.' }
                        ]
                    });
                }
                return null;
            },
            jira_post_comment: function(args) { comments.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.results.skipped.length, 1);
        assert.deepEqual(statusMoves, [
            { key: 'TS-396', statusName: 'In Rework' }
        ]);
        assert.deepEqual(removedLabels, [
            { key: 'TS-396', label: 'sm_test_automation_triggered' },
            { key: 'TS-396', label: 'sm_bug_creation_triggered' },
            { key: 'TS-396', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'In Rework');
    });

    test('rejects fixedByBug decisions and does not move TC to Backlog', function() {
        var statusMoves = [];
        var removedLabels = [];
        var links = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-706'],
                        newBugs: [],
                        links: [],
                        fixedByBug: [
                            { tcKey: 'TS-706', bugKey: 'TS-1', reason: 'Done bug matched' }
                        ],
                        skipped: []
                    });
                }
                return null;
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_link_issues: function(args) { links.push(args); }
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered'
                }
            }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'fixedByBug is not supported');
        assert.deepEqual(statusMoves, []);
        assert.deepEqual(links, []);
        assert.deepEqual(removedLabels, [
            { key: 'TS-706', label: 'sm_bug_creation_triggered' },
            { key: 'TS-706', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
    });

    test('live-checks linked non-Done bugs before creating a duplicate', function() {
        var created = [];
        var linked = [];
        var statusMoves = [];
        var removedLabels = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-657'],
                        newBugs: [
                            {
                                summary: 'Duplicate candidate',
                                priority: 'Medium',
                                descriptionFile: 'outputs/bug_001_description.md',
                                linkedTCs: ['TS-657']
                            }
                        ],
                        links: [],
                        skipped: []
                    });
                }
                if (opts.path === 'outputs/bug_001_description.md') {
                    return 'Bug description';
                }
                return null;
            },
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-657")');
                assert.contains(args.jql, 'status not in (Done)');
                return [{ key: 'TS-1291' }];
            },
            jira_create_ticket_basic: function() {
                created.push(Array.prototype.slice.call(arguments));
                return '{"key":"TS-9999"}';
            },
            jira_link_issues: function(args) { linked.push(args); },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(created.length, 0);
        assert.equal(result.results.linked.length, 1);
        assert.deepEqual(linked, [
            { sourceKey: 'TS-657', anotherKey: 'TS-1291', relationship: 'Blocks' }
        ]);
        assert.deepEqual(statusMoves, [
            { key: 'TS-657', statusName: 'Bug To Fix' }
        ]);
        assert.deepEqual(removedLabels, [
            { key: 'TS-657', label: 'sm_bug_creation_triggered' },
            { key: 'TS-657', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
    });

    test('recovers processed TC without outcome when a linked non-Done bug exists', function() {
        var statusMoves = [];
        var removedLabels = [];
        var comments = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-42'],
                        newBugs: [],
                        links: [],
                        skipped: []
                    });
                }
                return null;
            },
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-42")');
                assert.contains(args.jql, 'status not in (Done)');
                return [{ key: 'TS-1300' }];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.results.linked.length, 1);
        assert.equal(result.results.linked[0].source, 'post_batch_recovery');
        assert.deepEqual(statusMoves, [
            { key: 'TS-42', statusName: 'Bug To Fix' }
        ]);
        assert.deepEqual(removedLabels, [
            { key: 'TS-42', label: 'sm_bug_creation_triggered' },
            { key: 'TS-42', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'linked non-Done bug already exists');
    });

    test('releases processed TC without outcome when no linked non-Done bug exists', function() {
        var statusMoves = [];
        var removedLabels = [];
        var comments = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-208'],
                        newBugs: [],
                        links: [],
                        skipped: []
                    });
                }
                return null;
            },
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'linkedIssues("TS-208")');
                assert.contains(args.jql, 'status not in (Done)');
                return [];
            },
            jira_move_to_status: function(args) { statusMoves.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered'
                }
            }
        });

        assert.equal(result.success, true);
        assert.deepEqual(statusMoves, []);
        assert.equal(result.results.released.length, 1);
        assert.deepEqual(removedLabels, [
            { key: 'TS-208', label: 'sm_bug_creation_triggered' },
            { key: 'TS-208', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'No linked non-Done bug was found');
    });

    test('uses Failed Reason field as description fallback and attaches file to new bug', function() {
        var created = [];
        var attached = [];
        var fieldReads = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-700'],
                        newBugs: [
                            {
                                summary: 'Login fails on iOS',
                                priority: 'High',
                                descriptionFile: 'outputs/bug_700_description.md',
                                linkedTCs: ['TS-700']
                            }
                        ],
                        links: [],
                        skipped: []
                    });
                }
                if (opts.path === 'outputs/bug_700_description.md') return null;
                return null;
            },
            jira_get_ticket: function(args) {
                fieldReads.push(args.key);
                return {
                    fields: {
                        'Failed Reason': 'Login button tap does not fire on iOS Safari.',
                        'customfield_10535': 'Login button tap does not fire on iOS Safari.'
                    }
                };
            },
            jira_create_ticket_basic: function(project, type, summary, description) {
                created.push({ summary: summary, description: description });
                return '{"key":"TS-7000"}';
            },
            jira_attach_file_to_ticket: function(args) { attached.push(args); },
            jira_link_issues: function() {},
            jira_move_to_status: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(created.length, 1);
        assert.contains(created[0].description, 'Login button tap does not fire on iOS Safari.');
        assert.equal(attached.length, 1);
        assert.equal(attached[0].ticketKey, 'TS-7000');
        assert.equal(attached[0].filePath, 'outputs/bug_700_description.md');
    });

    test('uses customParams.failedReasonField as description fallback', function() {
        var created = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-701'],
                        newBugs: [
                            {
                                summary: 'Custom field fallback bug',
                                priority: 'Medium',
                                descriptionFile: 'outputs/bug_701_description.md',
                                linkedTCs: ['TS-701']
                            }
                        ],
                        links: [],
                        skipped: []
                    });
                }
                if (opts.path === 'outputs/bug_701_description.md') return null;
                return null;
            },
            jira_get_ticket: function(args) {
                return {
                    fields: {
                        'Failed Reason': 'should not be used',
                        'Custom Failed Reason': 'custom field fallback value'
                    }
                };
            },
            jira_create_ticket_basic: function(project, type, summary, description) {
                created.push({ summary: summary, description: description });
                return '{"key":"TS-7001"}';
            },
            jira_attach_file_to_ticket: function() {},
            jira_link_issues: function() {},
            jira_move_to_status: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            jobParams: {
                customParams: {
                    removeLabel: 'sm_bug_creation_triggered',
                    smTriggerLabel: 'sm_bulk_bugs_creation_triggered',
                    failedReasonField: 'Custom Failed Reason'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(created.length, 1);
        assert.contains(created[0].description, 'custom field fallback value');
        assert.notContains(created[0].description, 'should not be used');
    });

});
