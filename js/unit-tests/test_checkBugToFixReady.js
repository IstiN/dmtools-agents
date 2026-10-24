/**
 * Unit tests for js/checkBugToFixReady.js
 */

function loadCheckBugToFixReady(mocks, requireOverrides) {
    mocks = mocks || {};
    var requireMap = checkBugToFixReadyRequireMap(mocks);
    applyCheckBugToFixReadyOverrides(requireMap, requireOverrides);
    return loadModule(
        'js/checkBugToFixReady.js',
        makeRequire(requireMap),
        mocks
    );
}

// gh-1250: build the makeRequire map in named steps so the loader stays under
// the CRAP gate; the module mapping itself is unchanged.
function checkBugToFixReadyRequireMap(mocks) {
    return {
        './config.js': configModule,
        './configLoader.js': makeDefaultConfigLoaderMock(),
        './common/tokenUsageComment.js': checkBugToFixReadyTokenUsageMock(),
        './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
        './common/smLock.js': loadModule('js/common/smLock.js', makeRequire({}), {}),
        './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), mocks)
    };
}

function applyCheckBugToFixReadyOverrides(requireMap, requireOverrides) {
    if (!requireOverrides) return;
    for (var k in requireOverrides) {
        if (requireOverrides.hasOwnProperty(k)) requireMap[k] = requireOverrides[k];
    }
}

function checkBugToFixReadyTokenUsageMock() {
    return {
        postTokenUsageComments: function() {},
        postTokenUsageCommentsSafely: function() {},
        customParamsOf: checkBugToFixReadyCustomParamsOf
    };
}

function checkBugToFixReadyCustomParamsOf(params) {
    return (params && params.jobParams && params.jobParams.customParams) || (params && params.customParams) || {};
}

function makeTicket(key, issueType) {
    return {
        key: key,
        fields: {
            summary: 's',
            issuetype: { name: issueType }
        }
    };
}

// gh-1250: JQL-dispatch condition helpers — hoisted named functions keep the
// jira_search_by_jql mock closures under the CRAP gate; the routing logic and
// the returned data are unchanged.
function storyDirectBugsJql(jql) {
    return jql.indexOf('linkedIssues("TS-90")') !== -1 && jql.indexOf('issuetype = Bug') !== -1;
}

function storyLinkedTestCasesJql(jql) {
    return jql.indexOf('linkedIssues("TS-90")') !== -1 && jql.indexOf('issuetype = "Test Case"') !== -1;
}

function tc1LinkedBugsJql(jql) {
    return jql.indexOf('linkedIssues("TS-TC-1")') !== -1 && jql.indexOf('issuetype = Bug') !== -1;
}

function notDoneBugsFilterJql(jql) {
    return jql.indexOf('status != "Done"') !== -1;
}

suite('checkBugToFixReady', function() {

    test('moves Test Case to Backlog when all linked bugs are Done', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('status != "Done"') !== -1) {
                    return [];
                }
                return [{ key: 'TS-91', fields: { summary: 's', status: { name: 'Done' } } }];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-90', 'Test Case'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(moved, [{ key: 'TS-90', statusName: 'Backlog' }]);
        assert.contains(comments[0].comment, 'Test Case Ready for Re-automation');
        assert.ok(removedLabels.some(function(l) { return l.label === 'sm_test_automation_triggered'; }));
    });

    test('moves Story to Ready For Testing when all linked bugs are Done', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('status != "Done"') !== -1) {
                    return [];
                }
                return [
                    { key: 'TS-92', fields: { summary: 's', status: { name: 'Done' } } },
                    { key: 'TS-93', fields: { summary: 's', status: { name: 'Done' } } }
                ];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-90', 'Story'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.deepEqual(moved, [{ key: 'TS-90', statusName: 'Ready For Testing' }]);
        assert.contains(comments[0].comment, 'Story Ready for Re-test');
        assert.ok(removedLabels.some(function(l) { return l.label === 'sm_story_done_check_triggered'; }));
    });

    test('releases lock when a linked bug is not Done', function() {
        var moved = [];
        var removedLabels = [];

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('status != "Done"') !== -1) {
                    return [{ key: 'TS-94', fields: { summary: 's', status: { name: 'In Progress' } } }];
                }
                return [{ key: 'TS-94', fields: { summary: 's', status: { name: 'In Progress' } } }];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-90', 'Story'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_to_fix_check_triggered' }]);
    });

    test('keeps Story in Bug To Fix when a linked Test Case has a pending Bug', function() {
        var moved = [];
        var comments = [];
        var removedLabels = [];

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                var jql = args.jql;
                // Direct linked bugs of the Story: one Done bug.
                if (storyDirectBugsJql(jql)) {
                    if (notDoneBugsFilterJql(jql)) {
                        return [];
                    }
                    return [{ key: 'TS-92', fields: { summary: 's', status: { name: 'Done' } } }];
                }
                // Linked Test Cases of the Story.
                if (storyLinkedTestCasesJql(jql)) {
                    return [{ key: 'TS-TC-1', fields: { summary: 's', status: { name: 'Bug To Fix' } } }];
                }
                // Bugs linked to the Test Case: one not-Done bug.
                if (tc1LinkedBugsJql(jql)) {
                    if (notDoneBugsFilterJql(jql)) {
                        return [{ key: 'TS-95', fields: { summary: 's', status: { name: 'Ready For Testing' } } }];
                    }
                    return [
                        { key: 'TS-95', fields: { summary: 's', status: { name: 'Ready For Testing' } } }
                    ];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); },
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-90', 'Story'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_for_tc_bugs');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_to_fix_check_triggered' }]);
    });

    test('keeps Story in Bug To Fix when search results are host objects (GraalJS)', function() {
        var moved = [];
        var removedLabels = [];

        // Simulates DMTools host objects where direct .key access returns undefined
        // but JSON.stringify() serialises the underlying data.
        function hostIssue(key, statusName) {
            return {
                toJSON: function() {
                    return { key: key, fields: { summary: 's', status: { name: statusName } } };
                }
            };
        }

        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                var jql = args.jql;
                if (storyDirectBugsJql(jql)) {
                    if (notDoneBugsFilterJql(jql)) {
                        return [];
                    }
                    return [hostIssue('TS-92', 'Done')];
                }
                if (storyLinkedTestCasesJql(jql)) {
                    return [hostIssue('TS-TC-1', 'Bug To Fix')];
                }
                if (tc1LinkedBugsJql(jql)) {
                    if (notDoneBugsFilterJql(jql)) {
                        return [hostIssue('TS-95', 'Ready For Testing')];
                    }
                    return [hostIssue('TS-95', 'Ready For Testing')];
                }
                return [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function(args) { removedLabels.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-90', 'Story'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting_for_tc_bugs');
        assert.deepEqual(moved, []);
        assert.deepEqual(removedLabels, [{ key: 'TS-90', label: 'sm_bug_to_fix_check_triggered' }]);
    });

});

// ── gh-916: stage-label fallback — Ready For Testing is markable; Backlog stays direct ──

suite('checkBugToFixReady: stage-label fallback (gh-916)', function() {
    test("'label' mode: a rejected Ready For Testing move marks stage_ready_for_testing, no throw", function() {
        var added = [];
        var moved = [];
        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('status != "Done"') !== -1) return [];
                return [{ key: 'BUG-2', fields: { summary: 's', status: { name: 'Done' } } }];
            },
            jira_move_to_status: function(args) {
                moved.push(args);
                throw new Error("The field 'State' contains the value 'Ready For Testing' that is not in the list of supported values");
            },
            jira_add_label: function(args) { added.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: makeTicket('TS-95', 'Story'),
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.success, true);
        assert.deepEqual(moved, [{ key: 'TS-95', statusName: 'Ready For Testing' }]);
        assert.deepEqual(added, [{ key: 'TS-95', label: 'stage_ready_for_testing' }]);
    });

    test("'label' mode: the Backlog move for a Test Case stays a direct transition (no marker)", function() {
        var added = [];
        var moved = [];
        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function(args) {
                if (args.jql.indexOf('status != "Done"') !== -1) return [];
                return [{ key: 'BUG-3', fields: { summary: 's', status: { name: 'Done' } } }];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_add_label: function(args) { added.push(args); },
            jira_post_comment: function() {},
            jira_remove_label: function() {}
        });

        var result = module.action({
            ticket: makeTicket('TS-96', 'Test Case'),
            jobParams: { customParams: { stageFallback: 'label', removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });

        assert.equal(result.action, 'moved_to_backlog');
        assert.deepEqual(moved, [{ key: 'TS-96', statusName: 'Backlog' }]);
        assert.deepEqual(added, [], 'Backlog is not a tag-only stage — no marker');
    });
});

// ── gh-1188: action decomposition — characterization tests for the extracted
// step helpers and the previously uncovered branches (null/primitive toPlain,
// label-removal failures, TC without key, missing ticket key, no linked bugs). ──

function makeTrackerStub(overrides) {
    var stub = {
        provider: function() { return 'jira'; },
        searchIssues: function() { return []; },
        removeLabel: function() {},
        moveToStatus: function() {},
        moveToStatusOrMark: function() { return { moved: true }; },
        postComment: function() {}
    };
    if (overrides) {
        for (var k in overrides) {
            if (overrides.hasOwnProperty(k)) stub[k] = overrides[k];
        }
    }
    return stub;
}

suite('checkBugToFixReady — gh-1188 extracted step helpers', function() {
    test('toPlain: null, primitives and objects', function() {
        var mod = loadCheckBugToFixReady({});
        assert.equal(mod.toPlain(null), null);
        assert.equal(mod.toPlain(undefined), undefined);
        assert.equal(mod.toPlain('s'), 's');
        assert.equal(mod.toPlain(7), 7);
        assert.equal(mod.toPlain(true), true);
        assert.deepEqual(mod.toPlain({ key: 'K' }), { key: 'K' });
    });

    test('releaseLock: removed only when key and label are present; removal failure is swallowed', function() {
        var removed = [];
        var tracker = makeTrackerStub({ removeLabel: function(k, l) { removed.push(l); } });
        loadCheckBugToFixReady({}).releaseLock(tracker, 'TS-1', 'sm_l');
        assert.deepEqual(removed, ['sm_l']);

        loadCheckBugToFixReady({}).releaseLock(tracker, 'TS-1', null);
        assert.deepEqual(removed, ['sm_l'], 'no label → no call');

        var failing = makeTrackerStub({ removeLabel: function() { throw new Error('boom'); } });
        loadCheckBugToFixReady({}).releaseLock(failing, 'TS-1', 'sm_l');
        assert.deepEqual(removed, ['sm_l'], 'removal failure must be swallowed');
    });

    test('findLinkedBugs/findNotDoneBugs/findLinkedTestCases: exact query shapes and null-tolerance', function() {
        var queries = [];
        var tracker = makeTrackerStub({
            searchIssues: function(jql, opts) { queries.push([jql, opts.maxResults]); return null; }
        });
        var mod = loadCheckBugToFixReady({});
        assert.deepEqual(mod.findLinkedBugs(tracker, 'jira', 'TS-1'), []);
        assert.deepEqual(mod.findNotDoneBugs(tracker, 'jira', 'TS-1', 'Done'), []);
        assert.deepEqual(mod.findLinkedTestCases(tracker, 'jira', 'TS-1'), []);
        assert.equal(queries.length, 3);
        assert.contains(queries[0][0], 'issuetype = Bug');
        assert.contains(queries[1][0], 'issuetype = Bug AND status != "Done"');
        assert.contains(queries[2][0], 'issuetype = "Test Case"');
        assert.deepEqual(queries.map(function(q) { return q[1]; }), [50, 50, 100]);
    });

    test('findPendingBugsInLinkedTestCases: skips TCs without a key, collects per-TC pending bugs', function() {
        var tracker = makeTrackerStub({
            searchIssues: function(jql) {
                if (jql.indexOf('issuetype = "Test Case"') !== -1) {
                    return [
                        { key: 'TC-1', fields: { status: { name: 'Bug To Fix' } } },
                        { fields: { summary: 'no key' } }
                    ];
                }
                return [
                    { key: 'B-1', fields: { status: { name: 'In Progress' } } },
                    { key: 'B-2', fields: { status: { name: 'Ready For Testing' } } }
                ];
            }
        });
        var pending = loadCheckBugToFixReady({}).findPendingBugsInLinkedTestCases(tracker, 'jira', 'TS-9', 'Done');
        assert.deepEqual(pending, [
            { tcKey: 'TC-1', bugKey: 'B-1', status: 'In Progress' },
            { tcKey: 'TC-1', bugKey: 'B-2', status: 'Ready For Testing' }
        ]);
    });

    test('formatPendingTcBugLines: one line per pending bug', function() {
        var lines = loadCheckBugToFixReady({}).formatPendingTcBugLines([
            { bugKey: 'B-1', status: 'In Progress', tcKey: 'TC-1' },
            { bugKey: 'B-2', status: null, tcKey: 'TC-2' }
        ]);
        assert.equal(lines, '* B-1 (In Progress) via Test Case TC-1\n* B-2 (null) via Test Case TC-2');
    });

    test('moveStoryToReadyForTesting: moved → story_done_check label removed, lock released, comment posted', function() {
        var removed = [];
        var comments = [];
        var tracker = makeTrackerStub({
            moveToStatusOrMark: function() { return { moved: true }; },
            removeLabel: function(k, l) { removed.push(l); },
            postComment: function(k, c) { comments.push(c); }
        });
        loadCheckBugToFixReady({}).moveStoryToReadyForTesting(tracker, 'TS-1', 2, { READY_FOR_TESTING: 'Ready For Testing' }, 'sm_l');
        assert.deepEqual(removed, ['sm_story_done_check_triggered', 'sm_l']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'Story Ready for Re-test');
    });

    test('moveStoryToReadyForTesting: neither moved nor marked → no labels, no comment', function() {
        var removed = [];
        var comments = [];
        var tracker = makeTrackerStub({
            moveToStatusOrMark: function() { return { moved: false, marked: false }; },
            removeLabel: function(k, l) { removed.push(l); },
            postComment: function(k, c) { comments.push(c); }
        });
        loadCheckBugToFixReady({}).moveStoryToReadyForTesting(tracker, 'TS-1', 2, {}, 'sm_l');
        assert.deepEqual(removed, []);
        assert.deepEqual(comments, []);
    });

    test('moveStoryToReadyForTesting: story_done_check label failure is swallowed', function() {
        var removed = [];
        var comments = [];
        var tracker = makeTrackerStub({
            moveToStatusOrMark: function() { return { moved: true }; },
            removeLabel: function(k, l) {
                if (l === 'sm_story_done_check_triggered') throw new Error('boom');
                removed.push(l);
            },
            postComment: function(k, c) { comments.push(c); }
        });
        loadCheckBugToFixReady({}).moveStoryToReadyForTesting(tracker, 'TS-1', 1, {}, 'sm_l');
        assert.deepEqual(removed, ['sm_l'], 'lock still released');
        assert.equal(comments.length, 1, 'comment still posted');
    });

    test('moveTestCaseToBacklog: direct transition, automation label removed, lock released, comment posted', function() {
        var moved = [];
        var removed = [];
        var comments = [];
        var tracker = makeTrackerStub({
            moveToStatus: function(k, s) { moved.push([k, s]); },
            removeLabel: function(k, l) { removed.push(l); },
            postComment: function(k, c) { comments.push(c); }
        });
        loadCheckBugToFixReady({}).moveTestCaseToBacklog(tracker, 'TS-2', 3, { BACKLOG: 'Backlog' }, 'sm_l');
        assert.deepEqual(moved, [['TS-2', 'Backlog']]);
        assert.deepEqual(removed, ['sm_test_automation_triggered', 'sm_l']);
        assert.equal(comments.length, 1);
        assert.contains(comments[0], 'Test Case Ready for Re-automation');
    });

    test('moveTestCaseToBacklog: automation-label failure is swallowed', function() {
        var removed = [];
        var tracker = makeTrackerStub({
            removeLabel: function(k, l) {
                if (l === 'sm_test_automation_triggered') throw new Error('boom');
                removed.push(l);
            },
            postComment: function() {}
        });
        loadCheckBugToFixReady({}).moveTestCaseToBacklog(tracker, 'TS-2', 1, {}, 'sm_l');
        assert.deepEqual(removed, ['sm_l']);
    });

    test('postTokenUsageSafely: delegates to postTokenUsageCommentsSafely with initiator + customParams', function() {
        var calls = [];
        var mod = loadCheckBugToFixReady({}, {
            './common/tokenUsageComment.js': {
                postTokenUsageCommentsSafely: function(key, options) { calls.push([key, options]); },
                customParamsOf: function() { return { trackerProvider: 'github' }; }
            }
        });
        mod.postTokenUsageSafely('TS-1', { initiator: 'sm' });
        assert.equal(calls.length, 1, 'delegated exactly once');
        assert.equal(calls[0][0], 'TS-1', 'ticketKey forwarded');
        assert.equal(calls[0][1].initiator, 'sm', 'initiator forwarded');
        assert.deepEqual(calls[0][1].customParams, { trackerProvider: 'github' }, 'customParamsOf result forwarded');
    });

    test('postTokenUsageCommentsSafely: a provider failure is logged and swallowed (gh-1250 contract)', function() {
        // Load the real shared wrapper — the module under test relies on it never throwing.
        var realTuc = loadModule('js/common/tokenUsageComment.js', makeRequire({
            './trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), {})
        }), { file_read: function() { return null; } });

        var warned = [];
        var origWarn = console.warn;
        console.warn = function(m) { warned.push(String(m)); };
        var threw = false;
        var options = {};
        Object.defineProperty(options, 'outputsDir', {
            get: function() { throw new Error('provider down'); }
        });
        try {
            realTuc.postTokenUsageCommentsSafely('TS-2', options);
        } catch (e) {
            threw = true;
        } finally {
            console.warn = origWarn;
        }
        assert.equal(threw, false, 'failure never propagates');
        assert.equal(warned.length, 1, 'exactly one warning');
        assert.contains(warned[0], 'Failed to post token usage comments');
    });

    test('action: missing ticket key → failure result and lock release attempt', function() {
        var removed = [];
        var module = loadCheckBugToFixReady({
            jira_remove_label: function(args) { removed.push(args); }
        });
        var result = module.action({ ticket: {}, jobParams: { customParams: { removeLabel: 'sm_l' } } });
        assert.equal(result.success, false);
        assert.contains(result.error, 'params.ticket.key is missing');
        assert.ok(removed.length === 0 || removed.every(function(l) { return l.key === undefined; }), 'no key → no label target');
    });

    test('action: no linked Bugs → no_linked_bugs, lock released', function() {
        var removed = [];
        var module = loadCheckBugToFixReady({
            jira_search_by_jql: function() { return []; },
            jira_remove_label: function(args) { removed.push(args.label); }
        });
        var result = module.action({
            ticket: makeTicket('TS-30', 'Test Case'),
            jobParams: { customParams: { removeLabel: 'sm_bug_to_fix_check_triggered' } }
        });
        assert.equal(result.success, true);
        assert.equal(result.action, 'no_linked_bugs');
        assert.deepEqual(removed, ['sm_bug_to_fix_check_triggered']);
    });

    test('action: completeStoryReady delegates the story branch', function() {
        var result = loadCheckBugToFixReady({}).completeStoryReady({}, makeTrackerStub({}), 'jira', 'TS-1', 'Story', 2, {
            statuses: { DONE: 'Done', READY_FOR_TESTING: 'Ready For Testing' },
            issueTypes: { STORY: 'Story' }
        }, 'sm_l');
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.equal(result.totalBugs, 2);
    });

    test('action: completeTestCaseReady delegates the Test Case branch', function() {
        var result = loadCheckBugToFixReady({}).completeTestCaseReady({}, makeTrackerStub({}), 'TS-1', 'Test Case', 1, {
            statuses: { DONE: 'Done', BACKLOG: 'Backlog' }
        }, 'sm_l');
        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_backlog');
        assert.equal(result.totalBugs, 1);
    });
});
