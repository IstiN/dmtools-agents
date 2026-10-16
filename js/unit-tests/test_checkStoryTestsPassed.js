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
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
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

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_done');
        assert.deepEqual(moved, [{ key: 'TS-20', statusName: 'Done' }]);
        assert.contains(comments[0].comment, 'All Test Cases Passed');
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
