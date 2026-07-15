/**
 * Unit tests for js/checkBugTestsPassed.js
 */

function loadCheckBugTestsPassed(mocks) {
    mocks = mocks || {};
    var configLoaderMock = {
        loadProjectConfig: function() {
            return {
                jira: {
                    issueTypes: {
                        TEST_CASE: 'Test Case',
                        BUG: 'Bug'
                    }
                }
            };
        }
    };

    return loadModule(
        'js/checkBugTestsPassed.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderMock,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/scm.js': {
                createScm: function() {
                    return { listPrs: function() { return []; } };
                }
            }
        }),
        mocks
    );
}

function makeTc(key, status) {
    return { key: key, fields: { status: { name: status }, issuetype: { name: 'Test Case' } } };
}

suite('checkBugTestsPassed', function() {

    test('moves Bug to Done when all directly linked TCs are Passed', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];
        var searchedJqls = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function(args) {
                assert.equal(args.key, 'TS-10');
                return {
                    fields: {
                        issuelinks: [
                            { outwardIssue: makeTc('TS-11', 'Passed') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function(args) {
                searchedJqls.push(args.jql);
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-10', statusName: 'Done' }]);
        assert.contains(comments[0].comment, 'Bug Complete');
        assert.ok(removedLabels.some(function(l) { return l.key === 'TS-10' && l.label === 'sm_bug_done_check_triggered'; }), 'lock should be released after Done');
        assert.equal(searchedJqls.length, 0, 'should not need broad JQL when direct links exist');
    });

    test('ignores transitive linked TCs and moves Bug to Done', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { outwardIssue: makeTc('TS-11', 'Passed') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function(args) {
                // Broad query would return unrelated failed TCs (simulating linkedIssues transitivity)
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [
                        makeTc('TS-11', 'Passed'),
                        makeTc('TS-12', 'Failed')
                    ];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-10', statusName: 'Done' }]);
        assert.ok(removedLabels.some(function(l) { return l.key === 'TS-10' && l.label === 'sm_bug_done_check_triggered'; }));
    });

    test('waits when a direct linked TC is not Passed', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { outwardIssue: makeTc('TS-21', 'In Review - Passed') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-20' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-20', label: 'sm_bug_done_check_triggered' }]);
    });

    test('treats Skipped and Irrelevant direct TCs as non-blocking', function() {
        var moved = [];
        var comments = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { outwardIssue: makeTc('TS-31', 'Passed') },
                            { outwardIssue: makeTc('TS-32', 'Skipped') },
                            { inwardIssue: makeTc('TS-33', 'Irrelevant') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-30' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-30', statusName: 'Done' }]);
        assert.contains(comments[0].comment, 'Bug Complete');
    });

    test('falls back to linkedIssues when no direct Test Case links exist', function() {
        var moved = [];
        var comments = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { outwardIssue: { key: 'TS-S1', fields: { issuetype: { name: 'Story' } } } }
                        ]
                    }
                };
            },
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-41', 'Passed')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-40' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-40', statusName: 'Done' }]);
    });

    test('waits when falling back and a linked TC is not Passed', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return { fields: { issuelinks: [] } };
            },
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-51', 'Passed'), makeTc('TS-52', 'Backlog')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-50' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-50', label: 'sm_bug_done_check_triggered' }]);
    });

    test('treats Bug To Fix TC as non-blocking when tracked by another Bug', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { outwardIssue: makeTc('TS-61', 'Passed') },
                            { outwardIssue: makeTc('TS-62', 'Bug To Fix') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function(args) {
                // Query for linked Bugs of TS-62
                if (args.jql.indexOf('TS-62') !== -1 && args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-70', fields: { status: { name: 'In Progress' } } }];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-60', statusName: 'Done' }]);
        assert.contains(comments[0].comment, 'Bug Complete');
        assert.ok(removedLabels.some(function(l) { return l.key === 'TS-60' && l.label === 'sm_bug_done_check_triggered'; }));
    });

    test('waits when Bug To Fix TC is only tracked by the current Bug', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        issuelinks: [
                            { outwardIssue: makeTc('TS-81', 'Passed') },
                            { outwardIssue: makeTc('TS-82', 'Bug To Fix') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('TS-82') !== -1 && args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-80', fields: { status: { name: 'In Progress' } } }];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-80' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-80', label: 'sm_bug_done_check_triggered' }]);
    });

    test('moves finalized Bug to In Rework when any linked TC is still blocking', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        labels: ['test_pr_finalized'],
                        issuelinks: [
                            { outwardIssue: makeTc('TS-91', 'Passed') },
                            { outwardIssue: makeTc('TS-92', 'Failed') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-90' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_rework');
        assert.deepEqual(moved, [{ key: 'TS-90', statusName: 'In Rework' }]);
        assert.contains(comments[0].comment, 'Test PR Merged But Acceptance Tests Still Blocking');
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_done_check_triggered' }]);
    });

    test('does not treat a Done linked Bug as handling an active Bug To Fix TC', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        labels: ['test_pr_finalized'],
                        issuelinks: [
                            { outwardIssue: makeTc('TS-91', 'Passed') },
                            { outwardIssue: makeTc('TS-92', 'Bug To Fix') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('TS-92') !== -1 && args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [
                        { key: 'TS-90', fields: { status: { name: 'In Testing' } } },
                        { key: 'TS-99', fields: { status: { name: 'Done' } } }
                    ];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-90' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_rework');
        assert.deepEqual(moved, [{ key: 'TS-90', statusName: 'In Rework' }]);
        assert.contains(comments[0].comment, 'Test PR Merged But Acceptance Tests Still Blocking');
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_done_check_triggered' }]);
    });

});
