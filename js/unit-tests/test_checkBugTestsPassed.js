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
            './checkBugTestsPassedHelpers.js': loadModule('js/checkBugTestsPassedHelpers.js', makeRequire({
                './common/prLookup.js': loadModule('js/common/prLookup.js', makeRequire({}), {})
            }), {}),
            './common/prLookup.js': loadModule('js/common/prLookup.js', makeRequire({}), {}),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {}, postRunTokenUsageSafely: function() { return undefined; }, customParamsOf: function(p) { return (p && p.customParams) || {}; }, },
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
        return loadModule('js/checkBugTestsPassedHelpers.js', makeRequire({
            './common/prLookup.js': loadModule('js/common/prLookup.js', makeRequire({}), {})
        }), {});
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

// ── gh-1188: action decomposition — characterization tests for the extracted
// step helpers and the previously uncovered catch branches. ──

// gh-1188: status-name comparison hoisted out of the stub literal — keeps
// the stub builder itself at plain-closure complexity.
function stubHasStage1188(tc, stage, statusName) {
    var name = tc.fields && tc.fields.status && tc.fields.status.name;
    return name !== undefined && name !== null && name === statusName;
}

function makeTrackerStub1188(overrides) {
    var stub = {
        provider: function() { return 'jira'; },
        stageFallback: function() { return 'none'; },
        hasStage: stubHasStage1188,
        getIssue: function() { return null; },
        searchIssues: function() { return []; },
        removeLabel: function() {},
        addLabel: function() {},
        moveToStatus: function() {},
        postComment: function() {}
    };
    if (overrides) {
        for (var k in overrides) {
            if (overrides.hasOwnProperty(k)) stub[k] = overrides[k];
        }
    }
    return stub;
}

suite('checkBugTestsPassed — gh-1188 extracted step helpers', function() {
    test('releaseLock: removed only with key+label; failure swallowed', function() {
        var removed = [];
        var tracker = makeTrackerStub1188({ removeLabel: function(k, l) { removed.push(l); } });
        var mod = loadCheckBugTestsPassed({});
        mod.releaseLock(tracker, 'TS-1', 'sm_l');
        assert.deepEqual(removed, ['sm_l']);
        mod.releaseLock(tracker, 'TS-1', null);
        assert.deepEqual(removed, ['sm_l']);
        var failing = makeTrackerStub1188({ removeLabel: function() { throw new Error('boom'); } });
        mod.releaseLock(failing, 'TS-1', 'sm_l');
        assert.deepEqual(removed, ['sm_l']);
    });

    test('getTicketSafely: issue or {}; read failure degrades to {}', function() {
        var mod = loadCheckBugTestsPassed({});
        assert.deepEqual(mod.getTicketSafely(makeTrackerStub1188({ getIssue: function() { return null; } }), 'TS-1'), {});
        assert.deepEqual(
            mod.getTicketSafely(makeTrackerStub1188({ getIssue: function() { return { key: 'TS-1' }; } }), 'TS-1'),
            { key: 'TS-1' }
        );
        assert.deepEqual(
            mod.getTicketSafely(makeTrackerStub1188({ getIssue: function() { throw new Error('boom'); } }), 'TS-1'),
            {}
        );
    });

    test('directLinkedTestCases: filters by issuetype, tolerates broken links, label-mode re-fetch', function() {
        var mod = loadCheckBugTestsPassed({});
        assert.deepEqual(mod.directLinkedTestCases({}, 'TS-1', 'Test Case', makeTrackerStub1188({})), []);
        var ticket = {
            fields: {
                issuelinks: [
                    { outwardIssue: makeTc('TS-A', 'Passed') },
                    { inwardIssue: makeTc('TS-B', 'In Testing') },
                    { outwardIssue: { fields: { summary: 'no issuetype' } } },
                    { outwardIssue: null },
                    { outwardIssue: makeTc('TS-C', 'Passed').fields && { key: 'TS-C', fields: { issuetype: { name: 'Bug' } } } }
                ]
            }
        };
        var tcs = mod.directLinkedTestCases(ticket, 'TS-1', 'Test Case', makeTrackerStub1188({}));
        assert.deepEqual(tcs.map(function(tc) { return tc.key; }), ['TS-A', 'TS-B']);

        var throwingTicket = { fields: {} };
        Object.defineProperty(throwingTicket.fields, 'issuelinks', { get: function() { throw new Error('boom'); } });
        assert.deepEqual(mod.directLinkedTestCases(throwingTicket, 'TS-1', 'Test Case', makeTrackerStub1188({})), []);

        var labelMode = makeTrackerStub1188({
            stageFallback: function() { return 'label'; },
            getIssue: function(k) { return { key: k, fields: { labels: ['stage_passed'] } }; }
        });
        var refetched = mod.directLinkedTestCases(ticket, 'TS-1', 'Test Case', labelMode);
        assert.deepEqual(refetched.map(function(tc) { return tc.key; }), ['TS-A', 'TS-B']);
        assert.equal(refetched[0].fields.labels[0], 'stage_passed', 'label mode re-fetches full fields');
    });

    test('allLinkedTestCases / linkedBugsOf: null-tolerant, failure → []', function() {
        var mod = loadCheckBugTestsPassed({});
        assert.deepEqual(mod.allLinkedTestCases(makeTrackerStub1188({ searchIssues: function() { return null; } }), 'jira', 'TS-1', 'Test Case'), []);
        assert.deepEqual(mod.allLinkedTestCases(makeTrackerStub1188({ searchIssues: function() { throw new Error('boom'); } }), 'jira', 'TS-1', 'Test Case'), []);
        assert.deepEqual(mod.linkedBugsOf(makeTrackerStub1188({ searchIssues: function() { return null; } }), 'jira', 'TC-1', 'Bug'), []);
        assert.deepEqual(mod.linkedBugsOf(makeTrackerStub1188({ searchIssues: function() { throw new Error('boom'); } }), 'jira', 'TC-1', 'Bug'), []);
    });

    test('isBlockingTestCase: passed/skipped/irrelevant false; bug-to-fix with another active bug false; otherwise true', function() {
        var jiraConfig = { statuses: { PASSED: 'Passed', SKIPPED: 'Skipped', IRRELEVANT: 'Irrelevant', BUG_TO_FIX: 'Bug To Fix', DONE: 'Done' } };
        var mod = loadCheckBugTestsPassed({});
        var tracker = makeTrackerStub1188({
            searchIssues: function() { return [{ key: 'B-9', fields: { status: { name: 'In Progress' } } }]; }
        });
        assert.equal(mod.isBlockingTestCase(tracker, makeTc('TC-1', 'Passed'), 'TS-1', 'Bug', 'jira', jiraConfig), false);
        assert.equal(mod.isBlockingTestCase(tracker, makeTc('TC-2', 'Skipped'), 'TS-1', 'Bug', 'jira', jiraConfig), false);
        assert.equal(mod.isBlockingTestCase(tracker, makeTc('TC-3', 'Irrelevant'), 'TS-1', 'Bug', 'jira', jiraConfig), false);
        assert.equal(mod.isBlockingTestCase(tracker, makeTc('TC-4', 'Bug To Fix'), 'TS-1', 'Bug', 'jira', jiraConfig), false, 'tracked by another active bug');
        assert.equal(mod.isBlockingTestCase(tracker, makeTc('TC-5', 'In Testing'), 'TS-1', 'Bug', 'jira', jiraConfig), true);
        var noBugs = makeTrackerStub1188({ searchIssues: function() { return []; } });
        assert.equal(mod.isBlockingTestCase(noBugs, makeTc('TC-6', 'Bug To Fix'), 'TS-1', 'Bug', 'jira', jiraConfig), true, 'no other bug → blocking');
    });

    test('findOpenTestPrForTicket: match, list failure and createScm failure → null', function() {
        var mod = loadCheckBugTestsPassed({});
        var matching = makeTrackerStub1188({});
        var scmFactory = {
            createScm: function() {
                return { listPrs: function() { return [{ number: 5, title: 'TS-1 tests', head: { ref: 'ai/ts-1' } }]; } };
            }
        };
        var pr = mod.findOpenTestPrForTicket(scmFactory, {}, 'TS-1');
        assert.equal(pr.number, 5);
        var throwingList = { createScm: function() { return { listPrs: function() { throw new Error('boom'); } }; } };
        assert.equal(mod.findOpenTestPrForTicket(throwingList, {}, 'TS-1'), null);
        var throwingCreate = { createScm: function() { throw new Error('boom'); } };
        assert.equal(mod.findOpenTestPrForTicket(throwingCreate, {}, 'TS-1'), null);
    });

    test('resolveBlockingRoute: blocked → Blocked move + comment + lock release', function() {
        var moves = [];
        var comments = [];
        var removed = [];
        var tracker = makeTrackerStub1188({
            moveToStatus: function(k, s) { moves.push(s); },
            postComment: function(k, c) { comments.push(c); },
            removeLabel: function(k, l) { removed.push(l); }
        });
        var jiraConfig = { statuses: { BLOCKED: 'Blocked', IN_REWORK: 'In Rework' } };
        var result = loadCheckBugTestsPassed({}).resolveBlockingRoute(
            tracker, 'TS-1', ['test_pr_finalized', 'sm_bug_rework_attempted'], 2,
            [makeTc('TC-1', 'In Testing'), makeTc('TC-2', 'Failed')],
            jiraConfig, 'sm_l'
        );
        assert.equal(result.action, 'moved_to_blocked');
        assert.deepEqual(moves, ['Blocked']);
        assert.contains(comments[0], 'Still Blocking After Rework');
        assert.deepEqual(removed, ['sm_l']);
        assert.deepEqual(result.blockingTCs, ['TC-1', 'TC-2']);
    });

    test('resolveBlockingRoute: rework → In Rework move + attempt label + comment + lock release', function() {
        var moves = [];
        var comments = [];
        var added = [];
        var removed = [];
        var tracker = makeTrackerStub1188({
            moveToStatus: function(k, s) { moves.push(s); },
            postComment: function(k, c) { comments.push(c); },
            addLabel: function(k, l) { added.push(l); },
            removeLabel: function(k, l) { removed.push(l); }
        });
        var jiraConfig = { statuses: { BLOCKED: 'Blocked', IN_REWORK: 'In Rework' } };
        var result = loadCheckBugTestsPassed({}).resolveBlockingRoute(
            tracker, 'TS-1', ['test_pr_finalized'], 1, [makeTc('TC-1', 'Failed')],
            jiraConfig, 'sm_l'
        );
        assert.equal(result.action, 'moved_to_rework');
        assert.deepEqual(moves, ['In Rework']);
        assert.deepEqual(added, ['sm_bug_rework_attempted']);
        assert.contains(comments[0], 'Still Blocking');
        assert.deepEqual(removed, ['sm_l']);
    });

    test('resolveBlockingRoute: not finalized → waiting, lock released, no moves', function() {
        var moves = [];
        var tracker = makeTrackerStub1188({
            moveToStatus: function(k, s) { moves.push(s); },
            removeLabel: function() {}
        });
        var result = loadCheckBugTestsPassed({}).resolveBlockingRoute(
            tracker, 'TS-1', [], 3, [makeTc('TC-1', 'In Testing')],
            { statuses: {} }, 'sm_l'
        );
        assert.equal(result.action, 'waiting');
        assert.equal(result.totalTCs, 3);
        assert.equal(result.blockingCount, 1);
        assert.deepEqual(result.blockingTCs, ['TC-1']);
        assert.deepEqual(moves, []);
    });

    test('action: Bug To Fix TC whose bug query fails still counts as blocking', function() {
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return { fields: { issuelinks: [{ outwardIssue: makeTc('TS-11', 'Bug To Fix') }] } };
            },
            jira_search_by_jql: function() { throw new Error('search down'); },
            jira_move_to_status: function() {},
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });
        var result = module.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { removeLabel: 'sm_l' } }
        });
        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting');
        assert.deepEqual(result.blockingTCs, ['TS-11']);
    });

    test('action: PR listing failure does not block the Done move', function() {
        var moved = [];
        var module = loadCheckBugTestsPassed({
            __scm: { createScm: function() { return { listPrs: function() { throw new Error('gh down'); } }; } },
            jira_get_ticket: function() {
                return { fields: { issuelinks: [{ outwardIssue: makeTc('TS-11', 'Passed') }] } };
            },
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });
        var result = module.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { removeLabel: 'sm_l' } }
        });
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-10', statusName: 'Done' }]);
    });

    test('action: sm_bug_rework_attempted label removal failure is swallowed on Done', function() {
        var module = loadCheckBugTestsPassed({
            jira_get_ticket: function() {
                return { fields: { issuelinks: [{ outwardIssue: makeTc('TS-11', 'Passed') }] } };
            },
            jira_search_by_jql: function() { return []; },
            jira_move_to_status: function() {},
            jira_post_comment: function() {},
            jira_remove_label: function(args) {
                if (args.label === 'sm_bug_rework_attempted') throw new Error('boom');
            }
        });
        var result = module.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { removeLabel: 'sm_l' } }
        });
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
    });

    test('resolveTicketKey / resolveSmLabelOptions / resolveTicketLabels: null-tolerant', function() {
        var mod = loadCheckBugTestsPassed({});
        assert.equal(mod.resolveTicketKey({ ticket: { key: 'TS-1' } }), 'TS-1');
        assert.equal(mod.resolveTicketKey({}), undefined);
        assert.equal(mod.resolveTicketKey({ ticket: null }), null);
        var opts = mod.resolveSmLabelOptions({ jobParams: { customParams: { removeLabel: 'sm_l' } } });
        assert.deepEqual(opts, { customParams: { removeLabel: 'sm_l' }, removeLabel: 'sm_l' });
        assert.deepEqual(mod.resolveSmLabelOptions({}), { customParams: undefined, removeLabel: undefined });
        assert.deepEqual(mod.resolveSmLabelOptions({ jobParams: {} }), { customParams: undefined, removeLabel: undefined });
        assert.deepEqual(mod.resolveTicketLabels({ fields: { labels: ['a'] } }), ['a']);
        assert.deepEqual(mod.resolveTicketLabels({}), []);
        assert.deepEqual(mod.resolveTicketLabels(null), []);
    });

    test('resolveTrackedIssueTypes: configured types with fallbacks', function() {
        var mod = loadCheckBugTestsPassed({});
        assert.deepEqual(
            mod.resolveTrackedIssueTypes({ issueTypes: { TEST_CASE: 'Testcase', BUG: 'Defect' } }),
            { testCaseType: 'Testcase', bugType: 'Defect' }
        );
        assert.deepEqual(
            mod.resolveTrackedIssueTypes({ issueTypes: {} }),
            { testCaseType: 'Test Case', bugType: 'Bug' }
        );
    });

    test('filterBlockingTestCases: keeps only blocking TCs (multi-item)', function() {
        var jiraConfig = { statuses: { PASSED: 'Passed', SKIPPED: 'Skipped', IRRELEVANT: 'Irrelevant', BUG_TO_FIX: 'Bug To Fix', DONE: 'Done' } };
        var tracker = makeTrackerStub1188({ searchIssues: function() { return []; } });
        var tcs = [
            makeTc('TC-1', 'Passed'),
            makeTc('TC-2', 'In Testing'),
            makeTc('TC-3', 'Skipped'),
            makeTc('TC-4', 'Failed')
        ];
        var blocking = loadCheckBugTestsPassed({}).filterBlockingTestCases(tcs, tracker, 'TS-1', 'Bug', 'jira', jiraConfig);
        assert.deepEqual(blocking.map(function(tc) { return tc.key; }), ['TC-2', 'TC-4']);
    });

    test('openTestPrWaitResult: no PR → null; PR → wait outcome + lock released', function() {
        var mod = loadCheckBugTestsPassed({});
        var tracker = makeTrackerStub1188({});
        assert.equal(mod.openTestPrWaitResult(null, tracker, 'TS-1', 2, 'sm_l'), null);
        var removed = [];
        var tracked = makeTrackerStub1188({ removeLabel: function(k, l) { removed.push(l); } });
        var result = mod.openTestPrWaitResult({ number: 7, html_url: 'http://pr/7' }, tracked, 'TS-1', 2, 'sm_l');
        assert.deepEqual(result, {
            success: true,
            action: 'waiting_for_test_pr_merge',
            reason: 'open_pr',
            prNumber: 7,
            prUrl: 'http://pr/7',
            totalTCs: 2,
            ticketKey: 'TS-1'
        });
        assert.deepEqual(removed, ['sm_l']);
    });

    test('completeBugDone: move + comment + lock release; rework label cleanup tolerated', function() {
        var mod = loadCheckBugTestsPassed({});
        var moves = [];
        var comments = [];
        var removed = [];
        var tracker = makeTrackerStub1188({
            moveToStatus: function(k, s) { moves.push(s); },
            postComment: function(k, c) { comments.push(c); },
            removeLabel: function(k, l) {
                if (l === 'sm_bug_rework_attempted') throw new Error('no such label');
                removed.push(l);
            }
        });
        var result = mod.completeBugDone(tracker, 'TS-1', 4, { statuses: { DONE: 'Done' } }, {}, 'sm_l');
        assert.deepEqual(result, { success: true, action: 'moved_to_done', totalTCs: 4, ticketKey: 'TS-1' });
        assert.deepEqual(moves, ['Done']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'Done');
        assert.deepEqual(removed, ['sm_l']);
    });
});
