/**
 * Unit tests for js/checkStoryTestsPassed.js
 */

function loadCheckStoryTestsPassed(mocks) {
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
        'js/checkStoryTestsPassed.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderMock,
            './common/tokenUsageComment.js': mocks.tokenUsage || { postTokenUsageComments: function() {}, postTokenUsageSafely: function() { return undefined; }, customParamsOf: function(p) { return (p && p.customParams) || {}; } },
            './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), mocks)
        }),
        mocks
    );
}

function makeTc(key, status) {
    return { key: key, fields: { status: { name: status } } };
}

suite('checkStoryTestsPassed', function() {

    test('moves Story to Done when all linked TCs are Passed', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-11', 'Passed'), makeTc('TS-12', 'Passed')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-10', statusName: 'Done' }]);
        assert.contains(comments[0].comment, 'All Test Cases Passed');
        assert.equal(removedLabels.length, 0, 'lock should not be released after Done');
    });

    test('moves Story to Done when TCs are Passed, Skipped, or Irrelevant', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-21', 'Passed'), makeTc('TS-22', 'Skipped'), makeTc('TS-23', 'Irrelevant')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-20' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        // gh-1330: with skips present the report must show the buckets and must
        // NOT claim "All Test Cases Passed".
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-20', statusName: 'Done' }]);
        var storyComment = comments.filter(function(c) { return c.key === 'TS-20'; })[0].comment;
        assert.contains(storyComment, 'Test results: 1 Passed, 1 Skipped (never executed — see TC comments), 1 Irrelevant (no longer applicable)');
        assert.notContains(storyComment, 'All Test Cases Passed');
        assert.equal(removedLabels.length, 0, 'lock should not be released after Done');
    });

    test('waits when a TC is still in In Review - Passed', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-21', 'In Review - Passed')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-20' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_in_flight');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-20', label: 'sm_story_done_check_triggered' }]);
    });

    test('waits when a Failed TC has no linked bug yet', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-31', 'Failed')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-30' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_for_bugs');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-30', label: 'sm_story_done_check_triggered' }]);
    });

    test('waits when a Failed TC coexists with Skipped or Irrelevant TCs', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-33', 'Failed'), makeTc('TS-34', 'Skipped'), makeTc('TS-35', 'Irrelevant')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-35' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_for_bugs');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-35', label: 'sm_story_done_check_triggered' }]);
    });

    test('moves Story to Bug To Fix when a TC has a non-Done linked bug', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-41', 'Bug To Fix')];
                }
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-50', fields: { status: { name: 'In Progress' } } }];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-40' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_bug_to_fix');
        assert.deepEqual(moved, [{ key: 'TS-40', statusName: 'Bug To Fix' }]);
        assert.contains(comments[0].comment, 'Story Moved to Bug To Fix');
        assert.contains(comments[0].comment, 'TS-50');
        assert.deepEqual(removedLabels, [{ key: 'TS-40', label: 'sm_story_done_check_triggered' }]);
    });

    test('moves Story back to Ready For Testing when all linked bugs are Done', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status']);
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-61', 'Bug To Fix'), makeTc('TS-62', 'Passed')];
                }
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-70', fields: { status: { name: 'Done' } } }];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.deepEqual(moved, [{ key: 'TS-60', statusName: 'Ready For Testing' }]);
        assert.contains(comments[0].comment, 'Ready for Re-test');
        assert.deepEqual(removedLabels, [{ key: 'TS-60', label: 'sm_story_done_check_triggered' }]);
    });

    test('honors customParams.customStatuses override over config statuses', function() {
        var moved = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-81', 'Bug To Fix')];
                }
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'TS-90', fields: { status: { name: 'Done' } } }];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-80' },
            jobParams: { customParams: { customStatuses: { READY_FOR_TESTING: 'Retest Needed' } } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.deepEqual(moved, [{ key: 'TS-80', statusName: 'Retest Needed' }]);
    });

});

// ── gh-916: stage-label fallback — a TC marked stage_<key> by a rejected transition ──

suite('checkStoryTestsPassed: stage-label fallback (gh-916)', function() {
    function storyGh916Tc(key, status, labels) {
        var tc = makeTc(key, status);
        if (labels) tc.fields.labels = labels;
        return tc;
    }

    test("'label' mode: search requests labels in addition to key/status", function() {
        var seenFields = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                seenFields.push(args.fields);
                return [];
            },
            jira_move_to_status: function() {},
            jira_post_comment: function() {}
        });

        module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.deepEqual(seenFields[0], ['key', 'status', 'labels']);
    });

    test("'label' mode: a TC marked stage_in_review_passed is in flight — the Story waits", function() {
        var moved = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [storyGh916Tc('TS-61', 'New', ['stage_in_review_passed'])];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'waiting_in_flight');
        assert.deepEqual(moved, [], 'nothing is moved while a TC is in flight');
    });

    test("'label' mode: a TC marked stage_failed waits for bulk bug creation", function() {
        var moved = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [storyGh916Tc('TS-62', 'New', ['stage_failed'])];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'waiting_for_bugs');
        assert.deepEqual(moved, []);
    });

    test("'label' mode: TCs marked stage_passed/stage_skipped complete the Story (Done move succeeds)", function() {
        var moved = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [storyGh916Tc('TS-63', 'New', ['stage_passed']), storyGh916Tc('TS-64', 'New', ['stage_skipped'])];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-60', statusName: 'Done' }]);
    });

    test("'label' mode: a rejected Bug To Fix move marks stage_bug_to_fix — no throw, lock released", function() {
        var added = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'BUG-1', fields: { status: { name: 'New' } } }];
                }
                return [storyGh916Tc('TS-65', 'New', ['stage_failed'])];
            },
            jira_move_to_status: function(args) {
                if (args.statusName === 'Bug To Fix') throw new Error('state rejected');
                return {};
            },
            jira_add_label: function(args) { added.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_bug_to_fix');
        assert.deepEqual(added, [{ key: 'TS-60', label: 'stage_bug_to_fix' }]);
    });

    test("'none' mode: a stage_passed marker does NOT count as Passed — the Story is re-tested", function() {
        var moved = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                assert.deepEqual(args.fields, ['key', 'status'], 'no labels requested in none mode');
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [storyGh916Tc('TS-66', 'New', ['stage_passed'])];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-60' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_ready_for_testing', 'marker-only TCs are not Passed in none mode');
        assert.deepEqual(moved, [{ key: 'TS-60', statusName: 'Ready For Testing' }]);
    });
});

// ── gh-1080: characterization tests pinning current action() behaviour before
// the CRAP split. Every branch of the refactored dispatch is exercised here. ──

suite('checkStoryTestsPassed: characterization (gh-1080 CRAP split)', function() {

    test('missing params.ticket.key fails softly through the error path', function() {
        var removedLabels = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function() { throw new Error('must not be queried without a ticket'); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: {},
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'params.ticket.key is missing');
        assert.deepEqual(removedLabels, [], 'nothing to release without a ticket key');
    });

    test('no linked Test Cases releases the lock and reports no_test_cases', function() {
        var removedLabels = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function() { return []; },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-70' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'no_test_cases');
        assert.deepEqual(removedLabels, [{ key: 'TS-70', label: 'sm_story_done_check_triggered' }]);
    });

    test('a failing Test Case search degrades to no_test_cases', function() {
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function() { throw new Error('jira down'); },
            jira_move_to_status: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-71' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'no_test_cases');
    });

    test('a failing bug search treats the TC as bugless — the Story waits for bug creation', function() {
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) throw new Error('jira down');
                return [makeTc('TS-72', 'Failed')];
            },
            jira_move_to_status: function() {},
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-72' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'waiting_for_bugs');
    });

    test('a failing SM label removal does not break the re-test move', function() {
        var moved = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'BUG-2', fields: { status: { name: 'Done' } } }];
                }
                return [makeTc('TS-73', 'Bug To Fix')];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() { throw new Error('permission denied'); }
        });

        var result = module.action({
            ticket: { key: 'TS-73' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.deepEqual(moved, [{ key: 'TS-73', statusName: 'Ready For Testing' }]);
    });

    test('a failing token usage comment does not fail the run', function() {
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function() { return [makeTc('TS-74', 'Passed')]; },
            jira_move_to_status: function() {},
            jira_post_comment: function() {},
            jira_remove_label: function() {},
            tokenUsage: { postTokenUsageComments: function() { throw new Error('no ledger'); } }
        });

        var result = module.action({
            ticket: { key: 'TS-74' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_done');
    });

    test("'label' mode: a rejected Ready For Testing move marks stage_ready_for_testing and still comments", function() {
        var added = [];
        var comments = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'BUG-3', fields: { status: { name: 'Done' } } }];
                }
                return [makeTc('TS-75', 'Bug To Fix')];
            },
            jira_move_to_status: function() { throw new Error('state rejected'); },
            jira_add_label: function(args) { added.push(args); },
            jira_post_comment: function(args) { comments.push(args.comment); },
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-75' },
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.deepEqual(added, [{ key: 'TS-75', label: 'stage_ready_for_testing' }]);
        assert.ok(comments.some(function(c) { return c.indexOf('Ready for Re-test') !== -1; }));
    });

    test("'none' mode: a rejected Bug To Fix move fails the run through the error path", function() {
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Bug"') !== -1) {
                    return [{ key: 'BUG-9', fields: { status: { name: 'New' } } }];
                }
                return [makeTc('TS-76', 'Bug To Fix')];
            },
            jira_move_to_status: function() { throw new Error('state rejected'); },
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: { key: 'TS-76' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, false);
        assert.contains(result.error, 'state rejected');
    });
});

// ── gh-1330: truthful bucket report — never claim "All Passed" when tests were
// skipped, and stamp skip context on each skipped TC itself ──

suite('checkStoryTestsPassed: truthful bucket report (gh-1330)', function() {

    function sevenPassedThreeSkippedTcs() {
        var tcs = [];
        for (var p = 1; p <= 7; p++) tcs.push(makeTc('TS-P' + p, 'Passed'));
        for (var s = 1; s <= 3; s++) tcs.push(makeTc('TS-S' + s, 'Skipped'));
        return tcs;
    }

    test('7 Passed + 3 Skipped → Done (unchanged), report shows buckets, no "All … Passed" claim', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) return sevenPassedThreeSkippedTcs();
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-10' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done', 'default flow still moves to Done');
        assert.deepEqual(moved, [{ key: 'TS-10', statusName: 'Done' }]);
        var storyComment = comments.filter(function(c) { return c.key === 'TS-10'; })[0].comment;
        assert.contains(storyComment, 'Test results: 7 Passed, 3 Skipped');
        assert.contains(storyComment, 'never executed');
        assert.notContains(storyComment, 'All Test Cases Passed');
        assert.notContains(storyComment, 'are in *Passed* status');
        assert.equal(result.totalTCs, 10);
        assert.equal(result.passedTCs, 7);
        assert.equal(result.skippedTCs, 3);
        assert.equal(removedLabels.length, 0, 'lock should not be released after Done');
    });

    test('full-suite green story (0 skipped) keeps the exact report wording of today', function() {
        var comments = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-G1', 'Passed'), makeTc('TS-G2', 'Passed')];
                }
                return [];
            },
            jira_move_to_status: function() {},
            jira_post_comment: function(args) { comments.push(args); },
            jira_add_label: function(args) { throw new Error('no label expected on a green story: ' + JSON.stringify(args)); }
        });

        var result = module.action({
            ticket: { key: 'TS-G0' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_done');
        var storyComment = comments.filter(function(c) { return c.key === 'TS-G0'; })[0].comment;
        assert.equal(storyComment,
            'h3. ✅ Story Complete — All Test Cases Passed\n\n' +
            'All *2* linked Test Case(s) are in *Passed* status.\n\n' +
            'The story has been automatically moved to *Done*.',
            'green-story wording is byte-identical to the pre-gh-1330 report');
    });

    test('Irrelevant TCs also block the "All … Passed" claim', function() {
        var comments = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [makeTc('TS-I1', 'Passed'), makeTc('TS-I2', 'Irrelevant'), makeTc('TS-I3', 'Irrelevant')];
                }
                return [];
            },
            jira_move_to_status: function() {},
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-I0' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_done');
        var storyComment = comments.filter(function(c) { return c.key === 'TS-I0'; })[0].comment;
        assert.contains(storyComment, 'Test results: 1 Passed, 2 Irrelevant');
        assert.notContains(storyComment, 'All Test Cases Passed');
    });

    test('multi-status summary lists every non-zero bucket', function() {
        var comments = [];

        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [
                        makeTc('TS-M1', 'Passed'), makeTc('TS-M2', 'Passed'),
                        makeTc('TS-M3', 'Skipped'), makeTc('TS-M4', 'Skipped'),
                        makeTc('TS-M5', 'Irrelevant')
                    ];
                }
                return [];
            },
            jira_move_to_status: function() {},
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: { key: 'TS-M0' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_done');
        var storyComment = comments.filter(function(c) { return c.key === 'TS-M0'; })[0].comment;
        assert.contains(storyComment, 'Test results: 2 Passed, 2 Skipped (never executed — see TC comments), 1 Irrelevant');
        assert.notContains(storyComment, 'All Test Cases Passed');
    });
});

suite('checkStoryTestsPassed: skip markers on TCs (gh-1330)', function() {

    function runWithTcs(tcList, extraMocks, customParams) {
        var recorded = { comments: [], labels: [], moves: [], events: [] };
        var mocks = {
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) return tcList;
                return [];
            },
            jira_move_to_status: function(args) {
                recorded.moves.push(args);
                recorded.events.push('move:' + args.key);
            },
            jira_post_comment: function(args) {
                recorded.comments.push(args);
                recorded.events.push('comment:' + args.key);
            },
            jira_add_label: function(args) {
                recorded.labels.push(args);
                recorded.events.push('label:' + args.key + ':' + args.label);
            },
            jira_remove_label: function() {}
        };
        if (extraMocks) {
            for (var k in extraMocks) mocks[k] = extraMocks[k];
        }
        var module = loadCheckStoryTestsPassed(mocks);
        recorded.result = module.action({
            ticket: { key: 'TS-100' },
            jobParams: { customParams: customParams || { removeLabel: 'sm_story_done_check_triggered' } }
        });
        return recorded;
    }

    test('each skipped TC gets a marker comment + label; passed TCs stay untouched', function() {
        var recorded = runWithTcs([
            makeTc('TS-P1', 'Passed'),
            makeTc('TS-S1', 'Skipped'),
            makeTc('TS-S2', 'Skipped')
        ]);

        var markerComments = recorded.comments.filter(function(c) {
            return c.comment.indexOf('[tc-skip-marker]') !== -1;
        });
        assert.equal(markerComments.length, 2, 'one marker per skipped TC');
        var markedKeys = markerComments.map(function(c) { return c.key; }).sort();
        assert.deepEqual(markedKeys, ['TS-S1', 'TS-S2']);

        markerComments.forEach(function(c) {
            assert.contains(c.comment, 'skipped at TS-100 done-check (');
            assert.contains(c.comment, 'never executed');
            assert.ok(/— \d{4}-\d{2}-\d{2}/.test(c.comment), 'marker carries the date: ' + c.comment);
        });

        var markerLabels = recorded.labels.filter(function(l) { return l.label === 'skipped_at_TS-100'; });
        assert.deepEqual(markerLabels.map(function(l) { return l.key; }).sort(), ['TS-S1', 'TS-S2']);

        var touchedKeys = recorded.comments.filter(function(c) { return c.key.indexOf('TS-P') === 0; });
        assert.deepEqual(touchedKeys, [], 'no marker noise on passed TCs');
        assert.deepEqual(recorded.labels.filter(function(l) { return l.key === 'TS-P1'; }), []);
    });

    test('markers are stamped before the story Done move', function() {
        var recorded = runWithTcs([makeTc('TS-P1', 'Passed'), makeTc('TS-S1', 'Skipped')]);

        var firstMarkerEvent = recorded.events.indexOf('comment:TS-S1');
        var doneMoveEvent = recorded.events.indexOf('move:TS-100');
        assert.ok(firstMarkerEvent !== -1 && doneMoveEvent !== -1, 'both events happened');
        assert.ok(firstMarkerEvent < doneMoveEvent, 'skip context must exist even if the Done move later fails');
    });

    test('a failing Done move still leaves the markers stamped', function() {
        var recorded = runWithTcs([makeTc('TS-S1', 'Skipped')], {
            jira_move_to_status: function() { throw new Error('state rejected'); }
        });

        assert.equal(recorded.result.success, false, 'the move failure still fails the run');
        var markerComments = recorded.comments.filter(function(c) {
            return c.comment.indexOf('[tc-skip-marker]') !== -1;
        });
        assert.equal(markerComments.length, 1, 'marker was stamped before the failing move');
    });

    test('customParams.skipReason rides the marker', function() {
        var recordedComments = [];
        var module = loadCheckStoryTestsPassed({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) return [makeTc('TS-S1', 'Skipped')];
                return [];
            },
            jira_move_to_status: function() {},
            jira_post_comment: function(args) { recordedComments.push(args); }
        });

        module.action({
            ticket: { key: 'TS-100' },
            jobParams: { customParams: { removeLabel: 'sm_story_done_check_triggered', skipReason: 'device farm unavailable' } }
        });

        var marker = recordedComments.filter(function(c) { return c.comment.indexOf('[tc-skip-marker]') !== -1; })[0];
        assert.contains(marker.comment, 'skipped at TS-100 done-check (device farm unavailable), never executed');
    });

    test('marker states the default reason when none is provided', function() {
        var recorded = runWithTcs([makeTc('TS-S1', 'Skipped')]);
        var marker = recorded.comments.filter(function(c) { return c.comment.indexOf('[tc-skip-marker]') !== -1; })[0];
        assert.contains(marker.comment, 'skipped at TS-100 done-check (no reason recorded), never executed');
    });

    test("'label' mode: an already-marked skipped TC is not stamped twice", function() {
        var markedTc = makeTc('TS-S1', 'Skipped');
        markedTc.fields.labels = ['skipped_at_TS-100'];
        var freshTc = makeTc('TS-S2', 'Skipped');

        var recorded = runWithTcs([markedTc, freshTc], {
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) {
                    assert.deepEqual(args.fields, ['key', 'status', 'labels']);
                    return [markedTc, freshTc];
                }
                return [];
            }
        }, { stageFallback: 'label', removeLabel: 'sm_story_done_check_triggered' });

        var markerComments = recorded.comments.filter(function(c) {
            return c.comment.indexOf('[tc-skip-marker]') !== -1;
        });
        assert.deepEqual(markerComments.map(function(c) { return c.key; }), ['TS-S2'],
            'only the not-yet-marked TC gets a marker');
        assert.deepEqual(recorded.labels, [{ key: 'TS-S2', label: 'skipped_at_TS-100' }]);
        assert.equal(recorded.result.action, 'moved_to_done');
    });

    test('a failing marker write does not fail the completion', function() {
        var recorded = runWithTcs([makeTc('TS-S1', 'Skipped')], {
            jira_post_comment: function(args) {
                if (args.key === 'TS-S1') throw new Error('comment denied');
                return {};
            }
        });

        assert.equal(recorded.result.action, 'moved_to_done', 'completion survives a marker failure');
        assert.ok(recorded.labels.length > 0, 'best-effort: label still attempted for the skipped TC');
    });
});

suite('checkStoryTestsPassed: skipsNeedHuman knob (gh-1330)', function() {

    function runKnob(tcs, customParams, extraMocks) {
        var recorded = { comments: [], labels: [], moves: [], removedLabels: [] };
        var mocks = {
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('issuetype = "Test Case"') !== -1) return tcs;
                return [];
            },
            jira_move_to_status: function(args) { recorded.moves.push(args); },
            jira_post_comment: function(args) { recorded.comments.push(args); },
            jira_add_label: function(args) { recorded.labels.push(args); },
            jira_remove_label: function(args) { recorded.removedLabels.push(args); }
        };
        if (extraMocks) {
            for (var k in extraMocks) mocks[k] = extraMocks[k];
        }
        var module = loadCheckStoryTestsPassed(mocks);
        recorded.result = module.action({
            ticket: { key: 'TS-200' },
            jobParams: { customParams: customParams }
        });
        return recorded;
    }

    test('skipsNeedHuman: true → needs-human label instead of Done, markers still stamped', function() {
        var tcs = [];
        for (var p = 1; p <= 7; p++) tcs.push(makeTc('TS-P' + p, 'Passed'));
        for (var s = 1; s <= 3; s++) tcs.push(makeTc('TS-S' + s, 'Skipped'));

        var recorded = runKnob(tcs, {
            removeLabel: 'sm_story_done_check_triggered',
            skipsNeedHuman: true
        });

        assert.equal(recorded.result.action, 'needs_human_skips');
        assert.deepEqual(recorded.moves, [], 'story is NOT moved to Done');
        assert.deepEqual(recorded.labels.filter(function(l) { return l.key === 'TS-200'; }),
            [{ key: 'TS-200', label: 'needs_human_skips' }]);
        assert.deepEqual(recorded.removedLabels, [], 'lock stays — the story waits for a human');

        var storyComment = recorded.comments.filter(function(c) { return c.key === 'TS-200'; })[0].comment;
        assert.contains(storyComment, 'Test results: 7 Passed, 3 Skipped');
        assert.notContains(storyComment, 'All Test Cases Passed');

        var markerComments = recorded.comments.filter(function(c) {
            return c.comment.indexOf('[tc-skip-marker]') !== -1;
        });
        assert.equal(markerComments.length, 3, 'skip markers ride the TCs in this flow too');
    });

    test('skipsNeedHuman: true with no skips still completes normally', function() {
        var recorded = runKnob([makeTc('TS-P1', 'Passed')], {
            removeLabel: 'sm_story_done_check_triggered',
            skipsNeedHuman: true
        });

        assert.equal(recorded.result.action, 'moved_to_done');
        assert.deepEqual(recorded.moves, [{ key: 'TS-200', statusName: 'Done' }]);
        assert.deepEqual(recorded.labels, []);
    });

    test('needs-human flag is not duplicated when the story already carries it', function() {
        var recorded = runKnob([makeTc('TS-S1', 'Skipped')], {
            removeLabel: 'sm_story_done_check_triggered',
            skipsNeedHuman: true
        }, {
            jira_get_ticket: function() {
                return { key: 'TS-200', fields: { labels: ['needs_human_skips'] } };
            }
        });

        assert.equal(recorded.result.action, 'needs_human_skips');
        assert.deepEqual(recorded.labels.filter(function(l) { return l.key === 'TS-200'; }), [],
            'no duplicate needs-human label');
        assert.deepEqual(recorded.comments.filter(function(c) { return c.key === 'TS-200'; }), [],
            'no duplicate needs-human comment');
        assert.equal(recorded.result.alreadyFlagged, true);
        var markerComments = recorded.comments.filter(function(c) {
            return c.comment.indexOf('[tc-skip-marker]') !== -1;
        });
        assert.equal(markerComments.length, 1, 'TC markers still stamped (idempotent by TC label)');
    });

    test('a failing story-label read degrades to flagging once more (best effort)', function() {
        var recorded = runKnob([makeTc('TS-S1', 'Skipped')], {
            removeLabel: 'sm_story_done_check_triggered',
            skipsNeedHuman: true
        }, {
            jira_get_ticket: function() { throw new Error('jira down'); }
        });

        assert.equal(recorded.result.action, 'needs_human_skips');
        assert.deepEqual(recorded.labels.filter(function(l) { return l.key === 'TS-200'; }),
            [{ key: 'TS-200', label: 'needs_human_skips' }]);
        assert.equal(recorded.result.alreadyFlagged, false);
    });
});

suite('checkStoryTestsPassed: pure bucket helpers (gh-1330)', function() {

    test('statusBuckets counts every concluded TC and collects skipped TCs', function() {
        var module = loadCheckStoryTestsPassed({});
        var gate = {
            statuses: {},
            hasStage: function(tc, stageKey) {
                var status = tc.fields.status.name;
                if (stageKey === 'PASSED') return status === 'Passed';
                if (stageKey === 'SKIPPED') return status === 'Skipped';
                if (stageKey === 'IRRELEVANT') return status === 'Irrelevant';
                return false;
            }
        };

        var split = module.statusBuckets([
            makeTc('A', 'Passed'), makeTc('B', 'Passed'), makeTc('B2', 'Passed'),
            makeTc('C', 'Skipped'), makeTc('D', 'Skipped'),
            makeTc('E', 'Irrelevant')
        ], gate);

        assert.deepEqual(split.counts, { passed: 3, skipped: 2, irrelevant: 1, other: 0 });
        assert.deepEqual(split.skippedTcs.map(function(tc) { return tc.key; }), ['C', 'D']);
    });

    test('buildBucketSummary renders only non-zero buckets in a fixed order', function() {
        var module = loadCheckStoryTestsPassed({});
        assert.equal(module.buildBucketSummary({ passed: 7, skipped: 3, irrelevant: 0, other: 0 }),
            '7 Passed, 3 Skipped (never executed — see TC comments)');
        assert.equal(module.buildBucketSummary({ passed: 0, skipped: 0, irrelevant: 2, other: 0 }),
            '2 Irrelevant (no longer applicable)');
        assert.equal(module.buildBucketSummary({ passed: 1, skipped: 1, irrelevant: 1, other: 1 }),
            '1 Passed, 1 Skipped (never executed — see TC comments), 1 Irrelevant (no longer applicable), 1 Other');
        assert.equal(module.buildBucketSummary({ passed: 0, skipped: 0, irrelevant: 0, other: 0 }), '');
    });

    test('buildSkipMarkerComment emits the machine-parseable marker line', function() {
        var module = loadCheckStoryTestsPassed({});
        var comment = module.buildSkipMarkerComment('TS-100', 'TS-S1', 'no reason recorded', '2026-01-11');
        assert.contains(comment, '[tc-skip-marker] skipped at TS-100 done-check (no reason recorded), never executed — 2026-01-11');
        assert.contains(comment, 'unverified, not exonerated');
    });

    test('buildStoryDoneComment never claims All Passed when skipped + irrelevant > 0', function() {
        var module = loadCheckStoryTestsPassed({});
        var mixed = module.buildStoryDoneComment({ passed: 7, skipped: 3, irrelevant: 0, other: 0 }, 10);
        assert.contains(mixed, 'Test results: 7 Passed, 3 Skipped (never executed — see TC comments)');
        assert.notContains(mixed, 'All Test Cases Passed');

        var allIrrelevant = module.buildStoryDoneComment({ passed: 0, skipped: 0, irrelevant: 4, other: 0 }, 4);
        assert.notContains(allIrrelevant, 'All Test Cases Passed');

        var green = module.buildStoryDoneComment({ passed: 2, skipped: 0, irrelevant: 0, other: 0 }, 2);
        assert.contains(green, 'All Test Cases Passed');
    });
});
