/**
 * Unit tests for js/checkBugTestsPassed.js
 */

function loadCheckBugTestsPassed(mocks) {
    mocks = mocks || {};
    var configLoaderMock = makeDefaultConfigLoaderMock({
        jira: {
            issueTypes: {
                TEST_CASE: 'Test Case',
                BUG: 'Bug'
            }
        }
    });

    return loadModule(
        'js/checkBugTestsPassed.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderMock,
            './checkBugTestsPassedHelpers.js': loadModule('js/checkBugTestsPassedHelpers.js', makeRequire({}), {}),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), mocks),
            './common/scm.js': mocks.__scm || {
                createScm: function() {
                    return { listPrs: function() { return []; } };
                }
            }
        }),
        mocks
    );
}

function makeTc(key, status) {
    return { key: key, fields: { summary: 's', status: { name: status }, issuetype: { name: 'Test Case' } } };
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
                        summary: 's',
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
                        summary: 's',
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
                        summary: 's',
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
                        summary: 's',
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
                        summary: 's',
                        issuelinks: [
                            { outwardIssue: { key: 'TS-S1', fields: { summary: 's', issuetype: { name: 'Story' } } } }
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
                return { fields: { summary: 's', issuelinks: [] } };
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
                        summary: 's',
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
                    return [{ key: 'TS-70', fields: { summary: 's', status: { name: 'In Progress' } } }];
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
                        summary: 's',
                        issuelinks: [
                            { outwardIssue: makeTc('TS-81', 'Passed') },
                            { outwardIssue: makeTc('TS-82', 'Bug To Fix') }
                        ]
                    }
                };
            },
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('TS-82') !== -1 && args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-80', fields: { summary: 's', status: { name: 'In Progress' } } }];
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
        var addedLabels = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        summary: 's',
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
            jira_add_label: function(args) { addedLabels.push(args); },
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
        assert.deepEqual(addedLabels, [{ key: 'TS-90', label: 'sm_bug_rework_attempted' }]);
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_done_check_triggered' }]);
    });

    test('does not treat a Done linked Bug as handling an active Bug To Fix TC', function() {
        var moved = [];
        var comments = [];
        var addedLabels = [];
        var removedLabels = [];

        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        summary: 's',
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
                        { key: 'TS-90', fields: { summary: 's', status: { name: 'In Testing' } } },
                        { key: 'TS-99', fields: { summary: 's', status: { name: 'Done' } } }
                    ];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_add_label: function(args) { addedLabels.push(args); },
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
        assert.deepEqual(addedLabels, [{ key: 'TS-90', label: 'sm_bug_rework_attempted' }]);
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_done_check_triggered' }]);
    });

});

// ── gh-916: stage-label fallback — gates recognise the stage_<key> marker in label mode ──

suite('checkBugTestsPassed: stage-label fallback (gh-916)', function() {
    // Realistic Jira issuelinks stub (gh-916 review): the embedded issue carries a REDUCED
    // field set — summary/status/issuetype, NEVER labels. The full issue is what a
    // tracker.getIssue(key) re-fetch returns; only that shape can carry stage markers.
    function gh916DirectTc(key, status) {
        return { key: key, fields: { summary: 's', issuetype: { name: 'Test Case' }, status: { name: status } } };
    }

    function gh916FullTc(key, status, labels) {
        var fields = { summary: 's', issuetype: { name: 'Test Case' }, status: { name: status } };
        if (labels) fields.labels = labels;
        return { key: key, fields: fields };
    }

    function gh916BugTicket(tc) {
        return {
            key: 'BUG-77',
            fields: {
                labels: [],
                issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: tc }]
            }
        };
    }

    // Key-aware jira_get_ticket mock: BUG-77 → the bug ticket (with the label-less link stub),
    // a TC key → the full issue. Records every fetched key for re-fetch assertions.
    function gh916JiraMock(tc, fetchedKeys) {
        var bug = gh916BugTicket(gh916DirectTc(tc.key, tc.status));
        return function(args) {
            fetchedKeys.push(args && args.key);
            if (args && args.key === 'BUG-77') return bug;
            return gh916FullTc(args && args.key, tc.status, tc.labels);
        };
    }

    test("'none' mode: a stage_passed stub does NOT make a TC non-blocking — the Bug waits, no TC re-fetch", function() {
        var moved = [];
        var fetchedKeys = [];
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: gh916JiraMock({ key: 'TS-70', status: 'New', labels: ['stage_passed'] }, fetchedKeys),
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'BUG-77' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.action, 'waiting');
        assert.deepEqual(moved, []);
        assert.deepEqual(fetchedKeys, ['BUG-77'], 'the default mode must not spend extra reads on the link stubs');
    });

    test("'label' mode: a TC marked stage_passed is non-blocking even though the link stub carries no labels", function() {
        var moved = [];
        var fetchedKeys = [];
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: gh916JiraMock({ key: 'TS-71', status: 'New', labels: ['stage_passed'] }, fetchedKeys),
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'BUG-77' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'BUG-77', statusName: 'Done' }]);
        assert.ok(fetchedKeys.indexOf('TS-71') !== -1, 'label mode must re-fetch the TC to see real labels');
    });

    test("'label' mode: a TC marked stage_bug_to_fix with another linked non-Done bug is non-blocking", function() {
        var moved = [];
        var fetchedKeys = [];
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: gh916JiraMock({ key: 'TS-72', status: 'New', labels: ['stage_bug_to_fix'] }, fetchedKeys),
            jira_search_by_jql: function() {
                return [{ key: 'BUG-OTHER', fields: { status: { name: 'New' } } }];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'BUG-77' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'BUG-77', statusName: 'Done' }]);
        assert.ok(fetchedKeys.indexOf('TS-72') !== -1, 'label mode must re-fetch the TC to see real labels');
    });

    test("'label' mode: a TC whose re-fetch fails degrades to the link stub — the Bug keeps waiting", function() {
        var moved = [];
        var bug = gh916BugTicket(gh916DirectTc('TS-73', 'New'));
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function(args) {
                if (args && args.key === 'BUG-77') return bug;
                throw new Error('read timeout');
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'BUG-77' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.action, 'waiting');
        assert.deepEqual(moved, []);
    });
});
