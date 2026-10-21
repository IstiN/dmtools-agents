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
            './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
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

// ── gh-1043: pure helpers extracted from action() — direct characterization ──

suite('checkBugTestsPassedHelpers', function() {

    function loadHelpers() {
        return loadModule('js/checkBugTestsPassedHelpers.js', makeRequire({}), {});
    }

    test('decidePostFixRoute: not finalized keeps waiting', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decidePostFixRoute([], 'test_pr_finalized'), null);
        assert.equal(helpers.decidePostFixRoute(['other_label'], 'test_pr_finalized'), null);
        assert.equal(helpers.decidePostFixRoute(null, 'test_pr_finalized'), null);
        assert.equal(helpers.decidePostFixRoute(undefined, 'test_pr_finalized'), null);
    });

    test('decidePostFixRoute: finalized without rework label routes to rework', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decidePostFixRoute(['test_pr_finalized'], 'test_pr_finalized'), 'rework');
        assert.equal(helpers.decidePostFixRoute(['x', 'test_pr_finalized', 'y'], 'test_pr_finalized'), 'rework');
    });

    test('decidePostFixRoute: finalized after a rework attempt routes to blocked', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.decidePostFixRoute(['test_pr_finalized', 'sm_bug_rework_attempted'], 'test_pr_finalized'), 'blocked');
        assert.equal(helpers.decidePostFixRoute(['sm_bug_rework_attempted'], 'test_pr_finalized'), null, 'rework label alone is not enough');
    });

    test('decideOtherActiveBug: true only for a non-Done bug other than the current one', function() {
        var helpers = loadHelpers();
        var doneStatus = 'Done';
        assert.equal(helpers.decideOtherActiveBug([], 'TS-1', doneStatus), false);
        assert.equal(helpers.decideOtherActiveBug(null, 'TS-1', doneStatus), false);
        assert.equal(helpers.decideOtherActiveBug([{ key: 'TS-1', fields: { status: { name: 'In Progress' } } }], 'TS-1', doneStatus), false, 'current bug never counts');
        assert.equal(helpers.decideOtherActiveBug([{ key: 'TS-2', fields: { status: { name: 'Done' } } }], 'TS-1', doneStatus), false, 'Done bug does not count');
        assert.equal(helpers.decideOtherActiveBug([{ key: 'TS-2', fields: { status: { name: 'In Progress' } } }], 'TS-1', doneStatus), true);
        assert.equal(helpers.decideOtherActiveBug([{ key: 'TS-2' }], 'TS-1', doneStatus), true, 'missing status counts as active');
        assert.equal(helpers.decideOtherActiveBug([
            { key: 'TS-1', fields: { status: { name: 'In Testing' } } },
            { key: 'TS-2', fields: { status: { name: 'Done' } } },
            { key: 'TS-3', fields: { status: { name: 'Blocked' } } }
        ], 'TS-1', doneStatus), true);
    });

    test('buildBlockingList: one line per TC with unknown status fallback', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.buildBlockingList([]), '');
        assert.equal(helpers.buildBlockingList([
            { key: 'TS-1', fields: { status: { name: 'Failed' } } },
            { key: 'TS-2' }
        ]), '- TS-1 (Failed)\n- TS-2 (unknown)');
    });

    test('buildBlockedAfterReworkComment matches the original wording', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildBlockedAfterReworkComment([
            { key: 'TS-1', fields: { status: { name: 'Failed' } } }
        ]);
        assert.contains(comment, 'h3. 🚫 Test PR Finalized But Acceptance Tests Still Blocking After Rework\n\n');
        assert.contains(comment, 'one rework was already attempted, but the following linked Test Case(s) are still not *Passed*:\n');
        assert.contains(comment, '- TS-1 (Failed)\n\n');
        assert.contains(comment, 'Moving the Bug to *Blocked* for manual triage instead of cycling indefinitely.');
    });

    test('buildReworkComment matches the original wording', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildReworkComment([
            { key: 'TS-1', fields: { status: { name: 'Failed' } } },
            { key: 'TS-2', fields: { status: { name: 'Backlog' } } }
        ]);
        assert.contains(comment, 'h3. 🔄 Test PR Merged But Acceptance Tests Still Blocking\n\n');
        assert.contains(comment, 'The test-automation PR was merged and finalized, but the following linked Test Case(s) are still not *Passed*:\n');
        assert.contains(comment, '- TS-1 (Failed)\n- TS-2 (Backlog)\n\n');
        assert.contains(comment, 'Moving the Bug to *In Rework* for one more fix attempt. If it still fails, it will be moved to *Blocked*.');
    });

    test('buildBugDoneComment matches the original wording', function() {
        var helpers = loadHelpers();
        var comment = helpers.buildBugDoneComment(3);
        assert.contains(comment, 'h3. ✅ Bug Complete — All Linked Test Cases Resolved\n\n');
        assert.contains(comment, 'All *3* linked Test Case(s) are either *Passed*, *Skipped*, *Irrelevant*, or already tracked by another Bug.\n\n');
        assert.contains(comment, 'The bug has been automatically moved to *Done*.');
    });

    test('prMentionsTicket: title or head branch containing the key', function() {
        var helpers = loadHelpers();
        assert.equal(helpers.prMentionsTicket({ title: 'Fix TS-1 crash', head: {} }, 'TS-1'), true);
        assert.equal(helpers.prMentionsTicket({ title: 'Unrelated', head: { ref: 'bugfix/TS-1-crash' } }, 'TS-1'), true);
        assert.equal(helpers.prMentionsTicket({ title: 'Unrelated', head: { ref: 'main' } }, 'TS-1'), false);
        assert.equal(helpers.prMentionsTicket({}, 'TS-1'), false);
        assert.equal(helpers.prMentionsTicket(null, 'TS-1'), false);
    });

    test('findOpenTestPr: first matching PR in list order, null when none', function() {
        var helpers = loadHelpers();
        var none = [{ title: 'Other', head: { ref: 'main' } }];
        var hit = { title: 'TS-1 fix', head: { ref: 'main' } };
        var later = { title: 'TS-1 again', head: { ref: 'main' } };
        assert.equal(helpers.findOpenTestPr(none, 'TS-1'), null);
        assert.equal(helpers.findOpenTestPr([], 'TS-1'), null);
        assert.equal(helpers.findOpenTestPr(null, 'TS-1'), null);
        assert.equal(helpers.findOpenTestPr([hit, later], 'TS-1'), hit, 'first match wins like Array.find');
        assert.equal(helpers.findOpenTestPr([none[0], hit], 'TS-1'), hit);
    });

});

// ── gh-1043: action paths that had no characterization test ──

suite('checkBugTestsPassed: uncovered paths (gh-1043)', function() {

    test('finalized + rework attempted + still blocking → moved_to_blocked', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return {
                    fields: {
                        summary: 's',
                        labels: ['test_pr_finalized', 'sm_bug_rework_attempted'],
                        issuelinks: [
                            { outwardIssue: makeTc('TS-101', 'Passed') },
                            { outwardIssue: makeTc('TS-102', 'Failed') }
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
            ticket: { key: 'TS-100' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_blocked');
        assert.deepEqual(moved, [{ key: 'TS-100', statusName: 'Blocked' }]);
        assert.deepEqual(result.blockingTCs, ['TS-102']);
        assert.contains(comments[0].comment, 'Still Blocking After Rework');
        assert.contains(comments[0].comment, '- TS-102 (Failed)');
        assert.contains(comments[0].comment, 'Moving the Bug to *Blocked* for manual triage');
        assert.ok(removedLabels.some(function(l) { return l.label === 'sm_bug_done_check_triggered'; }), 'lock released after Blocked');
    });

    test('waits for an open test-automation PR before moving to Done', function() {
        var moved = [];
        var module = loadCheckBugTestsPassed({
            __scm: {
                createScm: function() {
                    return {
                        listPrs: function(state) {
                            assert.equal(state, 'open');
                            return [
                                { title: 'Unrelated change', head: { ref: 'feature/other' }, number: 5, html_url: 'https://pr/5' },
                                { title: 'Automate tests for TS-110', head: { ref: 'test/TS-110' }, number: 7, html_url: 'https://pr/7' }
                            ];
                        }
                    };
                }
            },
            jira_get_ticket: function() {
                return {
                    fields: {
                        summary: 's',
                        issuelinks: [{ outwardIssue: makeTc('TS-111', 'Passed') }]
                    }
                };
            },
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });
        var removedLabels = [];

        var result = module.action({
            ticket: { key: 'TS-110' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_for_test_pr_merge');
        assert.equal(result.reason, 'open_pr');
        assert.equal(result.prNumber, 7);
        assert.equal(result.prUrl, 'https://pr/7');
        assert.deepEqual(moved, [], 'must not move to Done while a test PR is open');
    });

    test('no linked Test Cases at all → no_test_cases, lock released', function() {
        var moved = [];
        var removedLabels = [];
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return { fields: { summary: 's', issuelinks: [] } };
            },
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-120' },
            jobParams: { customParams: { removeLabel: 'sm_bug_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'no_test_cases');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-120', label: 'sm_bug_done_check_triggered' }]);
    });

    test('missing ticket key → failure result', function() {
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() { throw new Error('must not read a ticket'); },
            jira_search_by_jql: function() { return []; }
        });

        var result = module.action({ ticket: {}, jobParams: {} });

        assert.equal(result.success, false);
        assert.contains(result.error, 'params.ticket.key is missing');
    });

});
