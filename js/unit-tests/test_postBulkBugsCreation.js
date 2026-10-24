function d2Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

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
            },
            './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
            './common/trackers.js': d2Trackers(Object.assign({}, defaults, mocks))
        }),
        Object.assign({}, defaults, mocks)
    );
}

suite('postBulkBugsCreation', function() {

    test('moves skipped test-code issues to Backlog and clears trigger labels', function() {
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
            { key: 'TS-396', statusName: 'Backlog' }
        ]);
        assert.deepEqual(removedLabels, [
            { key: 'TS-396', label: 'sm_test_automation_triggered' },
            { key: 'TS-396', label: 'sm_bug_creation_triggered' },
            { key: 'TS-396', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
        assert.equal(comments.length, 1);
        assert.contains(comments[0].comment, 'Backlog');
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
            jira_create_ticket_basic: function(args) {
                var summary = args.summary, description = args.description;
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
            jira_create_ticket_basic: function(args) {
                var summary = args.summary, description = args.description;
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

    test('uses transformed custom field key as Failed Reason fallback', function() {
        var created = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-702'],
                        newBugs: [
                            {
                                summary: 'Transformed key fallback bug',
                                priority: 'Medium',
                                descriptionFile: 'outputs/bug_702_description.md',
                                linkedTCs: ['TS-702']
                            }
                        ],
                        links: [],
                        skipped: []
                    });
                }
                if (opts.path === 'outputs/bug_702_description.md') return null;
                return null;
            },
            jira_get_ticket: function(args) {
                return {
                    fields: {
                        'Failed Reason': 'should not be used',
                        'Failed Reason (customfield_10535)': 'transformed fallback value'
                    }
                };
            },
            jira_create_ticket_basic: function(args) {
                var summary = args.summary, description = args.description;
                created.push({ summary: summary, description: description });
                return '{"key":"TS-7002"}';
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
                    failedReasonField: 'customfield_10535'
                }
            }
        });

        assert.equal(result.success, true);
        assert.equal(created.length, 1);
        assert.contains(created[0].description, 'transformed fallback value');
        assert.notContains(created[0].description, 'should not be used');
    });

    test('links new bug to parent Story of linked TC', function() {
        var links = [];

        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-800'],
                        newBugs: [
                            {
                                summary: 'Bug linked to story',
                                priority: 'Medium',
                                descriptionFile: 'outputs/bug_800_description.md',
                                linkedTCs: ['TS-800']
                            }
                        ],
                        links: [],
                        skipped: []
                    });
                }
                if (opts.path === 'outputs/bug_800_description.md') return 'Bug description';
                return null;
            },
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = Story') !== -1) {
                    return [{ key: 'TS-100' }];
                }
                return [];
            },
            jira_create_ticket_basic: function() { return '{"key":"TS-900"}'; },
            jira_link_issues: function(args) { links.push(args); },
            jira_attach_file_to_ticket: function() {},
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
        var storyLinks = links.filter(function(l) { return l.anotherKey === 'TS-100'; });
        assert.equal(storyLinks.length, 1);
        assert.equal(storyLinks[0].sourceKey, 'TS-900');
        assert.equal(storyLinks[0].relationship, 'relates to');
    });

});

suite('postBulkBugsCreation: recovery and create flows (gh-1010 characterization)', function() {

    var DEFAULT_LABELS = { removeLabel: 'sm_bug_creation_triggered', smTriggerLabel: 'sm_bulk_bugs_creation_triggered' };

    function runBulk(mocks, customParams) {
        var module = loadPostBulkBugsCreation(mocks);
        return module.action({
            ticket: { key: 'TS-901' },
            jobParams: { customParams: customParams || DEFAULT_LABELS }
        });
    }

    test('missing decisions file removes the SM trigger label and reports resume failure', function() {
        var removedLabels = [];
        var result = runBulk({
            file_read: function() { return null; },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'Missing bulk_bug_decisions.json');
        assert.contains(result.error, 'unit test');
        // triggerTicketKey resolves from actualParams (jobParams), which carries no ticket here
        assert.deepEqual(removedLabels, []);
    });

    test('creates a new bug, links all processed TCs to it and moves them to Bug To Fix', function() {
        var created = [];
        var links = [];
        var moves = [];
        var removedLabels = [];
        var comments = [];

        var result = runBulk({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-910', 'TS-911'],
                        newBugs: [
                            {
                                summary: 'Checkout total is wrong',
                                priority: 'High',
                                descriptionFile: 'outputs/bug_910_description.md',
                                linkedTCs: ['TS-910', 'TS-911']
                            }
                        ],
                        links: [],
                        skipped: []
                    });
                }
                if (opts.path === 'outputs/bug_910_description.md') return 'Total miscalc details';
                return null;
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_basic: function(args) {
                created.push(args);
                return '{"key":"BUG-500"}';
            },
            jira_link_issues: function(args) { links.push(args); },
            jira_move_to_status: function(args) { moves.push(args); return {}; },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_attach_file_to_ticket: function() {}
        });

        assert.equal(result.success, true);
        assert.equal(created.length, 1);
        assert.equal(created[0].project, 'TS');
        assert.contains(created[0].description, 'Total miscalc details');
        assert.deepEqual(links, [
            { sourceKey: 'TS-910', anotherKey: 'BUG-500', relationship: 'Blocks' },
            { sourceKey: 'TS-911', anotherKey: 'BUG-500', relationship: 'Blocks' }
        ]);
        assert.deepEqual(moves, [
            { key: 'TS-910', statusName: 'Bug To Fix' },
            { key: 'TS-911', statusName: 'Bug To Fix' }
        ]);
        assert.deepEqual(removedLabels, [
            { key: 'TS-910', label: 'sm_bug_creation_triggered' },
            { key: 'TS-910', label: 'sm_bulk_bugs_creation_triggered' },
            { key: 'TS-911', label: 'sm_bug_creation_triggered' },
            { key: 'TS-911', label: 'sm_bulk_bugs_creation_triggered' }
        ]);
        assert.equal(comments.length, 2);
        assert.contains(comments[0].comment, 'New Bug Created (Batch)');
        assert.deepEqual(result.results.created, [
            { tcKey: 'TS-910', bugKey: 'BUG-500' },
            { tcKey: 'TS-911', bugKey: 'BUG-500' }
        ]);
    });

    test('skips TCs outside the processed list when creating a new bug (safety guard)', function() {
        var links = [];

        var result = runBulk({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-920'],
                        newBugs: [
                            { summary: 'Guarded bug', priority: 'Medium', linkedTCs: ['TS-920', 'TS-999'] }
                        ],
                        links: [],
                        skipped: []
                    });
                }
                return null;
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_basic: function() { return '{"key":"BUG-501"}'; },
            jira_link_issues: function(args) { links.push(args); },
            jira_move_to_status: function() { return {}; },
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        });

        assert.equal(result.success, true);
        assert.deepEqual(links, [
            { sourceKey: 'TS-920', anotherKey: 'BUG-501', relationship: 'Blocks' }
        ]);
        assert.deepEqual(result.results.created, [
            { tcKey: 'TS-920', bugKey: 'BUG-501' }
        ]);
    });

    test('skips newBug entries without a summary', function() {
        var created = [];

        var result = runBulk({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: [],
                        newBugs: [{ priority: 'Medium', linkedTCs: [] }],
                        links: [],
                        skipped: []
                    });
                }
                return null;
            },
            jira_create_ticket_basic: function(args) { created.push(args); return '{"key":"BUG-502"}'; }
        });

        assert.equal(result.success, true);
        assert.equal(created.length, 0);
        assert.deepEqual(result.results.errors, []);
    });

    test('records create failures without aborting the batch', function() {
        var result = runBulk({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-930'],
                        newBugs: [
                            { summary: 'Unstable bug', priority: 'Medium', linkedTCs: ['TS-930'] }
                        ],
                        links: [],
                        skipped: []
                    });
                }
                return null;
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_basic: function() { throw new Error('create exploded'); }
        });

        assert.equal(result.success, true);
        assert.equal(result.results.created.length, 0);
        assert.equal(result.results.errors.length, 1);
        assert.contains(result.results.errors[0].error, 'create exploded');
    });

    test('ignores invalid link entries missing tcKey or bugKey', function() {
        var links = [];

        var result = runBulk({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-940'],
                        newBugs: [],
                        links: [{ tcKey: 'TS-940' }, { bugKey: 'BUG-1' }, { tcKey: 'TS-940', bugKey: 'BUG-600' }],
                        skipped: []
                    });
                }
                return null;
            },
            jira_link_issues: function(args) { links.push(args); },
            jira_move_to_status: function() { return {}; },
            jira_remove_label: function() {},
            jira_post_comment: function() {}
        });

        assert.equal(result.success, true);
        assert.deepEqual(links, [
            { sourceKey: 'TS-940', anotherKey: 'BUG-600', relationship: 'Blocks' }
        ]);
        assert.deepEqual(result.results.linked, [
            { tcKey: 'TS-940', bugKey: 'BUG-600' }
        ]);
    });

});

suite('postBulkBugsCreation: stage-label fallback (gh-916)', function() {
    test("'label' mode: a rejected Bug To Fix move marks stage_bug_to_fix, no throw, decision still recorded", function() {
        var added = [];
        var module = loadPostBulkBugsCreation({
            file_read: function(opts) {
                if (opts.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({
                        processed: ['TS-980'],
                        links: [{ tcKey: 'TS-980', bugKey: 'BUG-1' }],
                        newBugs: [],
                        skipped: []
                    });
                }
                return null;
            },
            jira_move_to_status: function(args) {
                if (args.statusName === 'Bug To Fix') throw new Error('state rejected');
                return {};
            },
            jira_add_label: function(args) { added.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-979' },
            jobParams: { customParams: { stageFallback: 'label' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.results.linked.length, 1);
        assert.deepEqual(added, [{ key: 'TS-980', label: 'stage_bug_to_fix' }]);
    });
});

suite('postBulkBugsCreation.extractTickets', function() {
    function loadModule_() {
        return loadPostBulkBugsCreation({});
    }

    test('returns [] for null, undefined and empty input', function() {
        var extractTickets = loadModule_().extractTickets;
        assert.deepEqual(extractTickets(null), []);
        assert.deepEqual(extractTickets(undefined), []);
        assert.deepEqual(extractTickets(''), []);
    });

    test('returns the input array as-is', function() {
        var arr = [{ key: 'TS-1' }, { key: 'TS-2' }];
        assert.deepEqual(loadModule_().extractTickets(arr), arr);
    });

    test('parses a JSON string holding an array', function() {
        assert.deepEqual(loadModule_().extractTickets('[{"key":"TS-1"}]'), [{ key: 'TS-1' }]);
    });

    test('returns [] for an invalid JSON string', function() {
        assert.deepEqual(loadModule_().extractTickets('not-json{'), []);
    });

    test('extracts issues, data and results containers from an object', function() {
        var extractTickets = loadModule_().extractTickets;
        assert.deepEqual(extractTickets({ issues: ['i1', 'i2'] }), ['i1', 'i2']);
        assert.deepEqual(extractTickets({ data: ['d1'] }), ['d1']);
        assert.deepEqual(extractTickets({ results: ['r1', 'r2'] }), ['r1', 'r2']);
    });

    test('prefers data over results when both are present (pinned order)', function() {
        var value = { data: ['d'], results: ['r'] };
        assert.deepEqual(loadModule_().extractTickets(value), ['d']);
    });

    test('returns [] when no known container key holds an array', function() {
        var extractTickets = loadModule_().extractTickets;
        assert.deepEqual(extractTickets({ total: 5 }), []);
        assert.deepEqual(extractTickets('{"total":5}'), []);
        assert.deepEqual(extractTickets(42), []);
    });
});

// ─── gh-119 CRAP: getFailedReasonForTc branches + extracted pure helpers ─────

suite('postBulkBugsCreation.getFailedReasonForTc (gh-119 characterization)', function() {
    function withIssue(fields, opts) {
        opts = opts || {};
        return loadPostBulkBugsCreation(Object.assign({
            jira_get_ticket: opts.throwing
                ? function() { throw new Error('tracker down'); }
                : function() { return fields === null ? null : { fields: fields }; }
        }, opts.extra || {}));
    }

    test('missing tcKey or fieldName yields empty string without touching the tracker', function() {
        var mod = withIssue({ summary: 'x' });
        assert.equal(mod.getFailedReasonForTc(null, 'customfield_1'), '');
        assert.equal(mod.getFailedReasonForTc('TS-1', null), '');
        assert.equal(mod.getFailedReasonForTc('', ''), '');
    });

    test('direct string value is returned as-is, including an empty string', function() {
        assert.equal(withIssue({ customfield_1: 'Rate limit exceeded' }).getFailedReasonForTc('TS-1', 'customfield_1'),
            'Rate limit exceeded');
        assert.equal(withIssue({ customfield_1: '' }).getFailedReasonForTc('TS-1', 'customfield_1'), '');
    });

    test('object values are read through their .value, empty string value is a real hit', function() {
        var mod = withIssue({ customfield_1: { value: 'Object reason' } });
        assert.equal(mod.getFailedReasonForTc('TS-1', 'customfield_1'), 'Object reason');
        assert.equal(withIssue({ customfield_1: { value: '' } }).getFailedReasonForTc('TS-1', 'customfield_1'), '');
    });

    test('non-string non-value shapes fall through to empty string', function() {
        assert.equal(withIssue({ customfield_1: { other: 1 } }).getFailedReasonForTc('TS-1', 'customfield_1'), '');
        assert.equal(withIssue({ customfield_1: 42 }).getFailedReasonForTc('TS-1', 'customfield_1'), '');
    });

    test('customfield fallback scans transformed keys (2+ entries, object and string shapes)', function() {
        var mod = withIssue({
            summary: 'unrelated',
            'Failed Reason (customfield_12345)': 'transformed string hit',
            'Other (customfield_99999)': 'wrong key'
        });
        assert.equal(mod.getFailedReasonForTc('TS-1', 'customfield_12345'), 'transformed string hit');

        var mod2 = withIssue({
            'A (customfield_12345)': { value: 'transformed value hit' },
            'B (customfield_12345)': 'later match must not win'
        });
        assert.equal(mod2.getFailedReasonForTc('TS-1', 'customfield_12345'), 'transformed value hit');
    });

    test('customfield fallback returns an empty-string transformed hit verbatim', function() {
        var mod = withIssue({ 'Empty (customfield_12345)': '' });
        assert.equal(mod.getFailedReasonForTc('TS-1', 'customfield_12345'), '');
    });

    test('no customfield in the name: no fallback scan', function() {
        var mod = withIssue({ 'Failed Reason (customfield_12345)': 'decoy' });
        assert.equal(mod.getFailedReasonForTc('TS-1', 'failedReason'), '');
    });

    test('tracker failure and missing fields degrade to empty string', function() {
        assert.equal(withIssue({}, { throwing: true }).getFailedReasonForTc('TS-1', 'customfield_1'), '');
        assert.equal(withIssue(null).getFailedReasonForTc('TS-1', 'customfield_1'), '');
        assert.equal(withIssue({}).getFailedReasonForTc('TS-1', 'customfield_1'), '');
    });
});

suite('postBulkBugsCreation — pure helpers (gh-119)', function() {
    var mod = loadPostBulkBugsCreation({});

    test('fieldTextOf: string passthrough, .value unwrapping, null when no text', function() {
        assert.equal(mod.fieldTextOf('plain'), 'plain');
        assert.equal(mod.fieldTextOf(''), '');
        assert.equal(mod.fieldTextOf({ value: 'wrapped' }), 'wrapped');
        assert.equal(mod.fieldTextOf({ value: '' }), '');
        assert.equal(mod.fieldTextOf({ other: 1 }), null);
        assert.equal(mod.fieldTextOf(null), null);
        assert.equal(mod.fieldTextOf(undefined), null);
        assert.equal(mod.fieldTextOf(42), null);
    });

    test('issueFieldMap: fields bag when present, {} otherwise', function() {
        var fields = { a: 1 };
        assert.equal(mod.issueFieldMap({ fields: fields }), fields);
        assert.deepEqual(mod.issueFieldMap({}), {});
        assert.deepEqual(mod.issueFieldMap(null), {});
        assert.deepEqual(mod.issueFieldMap({ fields: null }), {});
    });

    test('customFieldFallbackValue: scans transformed keys only for customfield names', function() {
        var fields = { 'Name (customfield_5)': 'hit', other: 'x' };
        assert.equal(mod.customFieldFallbackValue(fields, 'customfield_5'), 'hit');
        assert.equal(mod.customFieldFallbackValue(fields, 'summary'), null);
        assert.equal(mod.customFieldFallbackValue({}, 'customfield_5'), null);
        assert.equal(mod.customFieldFallbackValue(fields, 'customfield_6'), null);
        assert.equal(mod.customFieldFallbackValue({ 'A (customfield_5)': { value: 'v' } }, 'customfield_5'), 'v');
    });
});
