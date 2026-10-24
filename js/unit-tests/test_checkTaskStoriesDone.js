/**
 * Unit tests for js/checkTaskStoriesDone.js — characterization coverage of
 * action() — and js/common/smDoneCheck.js — unit coverage of every helper
 * branch (gh-1250).
 */

function doneTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function loadTaskDone(mocks) {
    return loadModule('js/checkTaskStoriesDone.js', makeRequire({
        './configLoader.js': {
            loadProjectConfig: function() {
                return { jira: { statuses: { DONE: 'Done', READY_FOR_TESTING: 'Ready For Testing' } } };
            }
        },
        './common/tokenUsageComment.js': {
            postTokenUsageComments: function() {},
            postTokenUsageCommentsSafely: function() {}
        },
        './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js'),
        './common/trackers.js': doneTrackers(mocks),
        './common/smDoneCheck.js': loadModule('js/common/smDoneCheck.js', makeRequire({}))
    }), mocks);
}

function loadSmDoneCheck() {
    return loadModule('js/common/smDoneCheck.js', makeRequire({}));
}

suite('checkTaskStoriesDone', function() {

    test('no linked Stories/Bugs → releases SM lock and returns no_stories', function() {
        var removedLabels = [];
        var moved = [];
        var taskDone = loadTaskDone({
            jira_search_by_jql: function() { return []; },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_move_to_status: function(args) { moved.push(args); }
        });

        var result = taskDone.action({
            ticket: { key: 'T-1' },
            jobParams: { customParams: { removeLabel: 'sm_task_done_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'no_stories');
        assert.equal(result.ticketKey, 'T-1');
        assert.deepEqual(removedLabels[0], { key: 'T-1', label: 'sm_task_done_triggered' });
        assert.equal(moved.length, 0, 'task must not move when nothing is linked');
    });

    test('all linked Stories/Bugs Done (2+ items) → moves task to Ready For Testing', function() {
        var moved = [];
        var comments = [];
        var searchCalls = 0;
        var taskDone = loadTaskDone({
            jira_search_by_jql: function(args) {
                searchCalls++;
                return searchCalls === 1
                    ? [{ key: 'S-1' }, { key: 'B-2' }]
                    : [];
            },
            jira_move_to_status: function(args) { moved.push(args); },
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = taskDone.action({
            ticket: { key: 'T-1' },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'moved_to_ready_for_testing');
        assert.equal(result.total, 2);
        assert.deepEqual(moved[0], { key: 'T-1', statusName: 'Ready For Testing' });
        assert.contains(comments[0].comment, 'All *2* linked Story/Bug(s) are in *Done* status');
    });

    test('some linked Stories/Bugs not Done (2+ items) → waiting and lock released', function() {
        var removedLabels = [];
        var moved = [];
        var searchCalls = 0;
        var taskDone = loadTaskDone({
            jira_search_by_jql: function() {
                searchCalls++;
                return searchCalls === 1
                    ? [{ key: 'S-1' }, { key: 'B-2' }]
                    : [{ key: 'B-2' }];
            },
            jira_remove_label: function(args) { removedLabels.push(args); },
            jira_move_to_status: function(args) { moved.push(args); }
        });

        var result = taskDone.action({
            ticket: { key: 'T-1' },
            jobParams: { customParams: { removeLabel: 'sm_task_done_triggered' } }
        });

        assert.equal(result.success, true);
        assert.equal(result.action, 'waiting');
        assert.equal(result.total, 2);
        assert.equal(result.notDone, 1);
        assert.equal(moved.length, 0, 'task must not move while items are open');
        assert.deepEqual(removedLabels[0], { key: 'T-1', label: 'sm_task_done_triggered' });
    });

    test('missing ticketKey → failure result', function() {
        var taskDone = loadTaskDone({
            jira_search_by_jql: function() { return []; }
        });

        var result = taskDone.action({ jobParams: { customParams: {} } });

        assert.equal(result.success, false);
        assert.contains(result.error, 'params.ticket.key is missing');
    });
});

suite('smDoneCheck', function() {

    test('releaseSmLock removes the label and logs', function() {
        var smDoneCheck = loadSmDoneCheck();
        var removedLabels = [];
        var logs = [];
        var origLog = console.log;
        console.log = function(msg) { logs.push(msg); };
        try {
            smDoneCheck.releaseSmLock(
                { removeLabel: function(key, label) { removedLabels.push({ key: key, label: label }); } },
                'T-1',
                'sm_lock'
            );
        } finally {
            console.log = origLog;
        }
        assert.deepEqual(removedLabels, [{ key: 'T-1', label: 'sm_lock' }]);
        assert.contains(logs.join(' '), 'will re-check next cycle');
    });

    test('releaseSmLock is a no-op without ticketKey or removeLabel', function() {
        var smDoneCheck = loadSmDoneCheck();
        var calls = 0;
        var tracker = { removeLabel: function() { calls++; } };
        smDoneCheck.releaseSmLock(tracker, null, 'sm_lock');
        smDoneCheck.releaseSmLock(tracker, 'T-1', null);
        smDoneCheck.releaseSmLock(tracker, null, null);
        assert.equal(calls, 0, 'tracker must not be touched when key or label is missing');
    });

    test('releaseSmLock swallows tracker errors with a warning', function() {
        var smDoneCheck = loadSmDoneCheck();
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(String(msg)); };
        try {
            smDoneCheck.releaseSmLock({
                removeLabel: function() { throw new Error('label tool down'); }
            }, 'T-1', 'sm_lock');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.length, 1);
        assert.contains(warns[0], 'Failed to remove SM label');
    });

    test('waitingResult releases the lock and returns the waiting shape (2+ items)', function() {
        var smDoneCheck = loadSmDoneCheck();
        var removedLabels = [];
        var result = smDoneCheck.waitingResult(
            { removeLabel: function(key, label) { removedLabels.push({ key: key, label: label }); } },
            'T-1',
            'sm_lock',
            'Not all done yet',
            3,
            2
        );
        assert.deepEqual(result, {
            success: true,
            action: 'waiting',
            total: 3,
            notDone: 2,
            ticketKey: 'T-1'
        });
        assert.deepEqual(removedLabels, [{ key: 'T-1', label: 'sm_lock' }]);
    });

    test('runDoneCheckAction resolves params and returns checkFn result', function() {
        var smDoneCheck = loadSmDoneCheck();
        var seen = {};
        var configLoader = {
            loadProjectConfig: function(p) { seen.loadedWith = p; return { jira: { marker: true } }; }
        };
        var tracker = { provider: function() { return 'jira'; } };
        var trackersModule = {
            createTracker: function(cfg, cp) { seen.cfg = cfg; seen.cp = cp; return tracker; }
        };
        var checkFn = function(t, cfg, key, label, initiator) {
            seen.checkArgs = [t, cfg, key, label, initiator];
            return { ok: true };
        };

        var result = smDoneCheck.runDoneCheckAction(
            { ticket: { key: 'T-1' }, initiator: 'init-1', jobParams: { customParams: { removeLabel: 'sm_lock' } } },
            checkFn,
            'someScript',
            configLoader,
            trackersModule
        );

        assert.equal(result.ok, true);
        assert.equal(seen.checkArgs[0], tracker);
        assert.equal(seen.checkArgs[1].jira.marker, true);
        assert.deepEqual(seen.checkArgs.slice(2), ['T-1', 'sm_lock', 'init-1']);
    });

    test('runDoneCheckAction releases the lock and returns the failure shape when checkFn throws', function() {
        var smDoneCheck = loadSmDoneCheck();
        var removedLabels = [];
        var tracker = {
            removeLabel: function(key, label) { removedLabels.push({ key: key, label: label }); }
        };
        var result = smDoneCheck.runDoneCheckAction(
            { ticket: { key: 'T-1' }, jobParams: { customParams: { removeLabel: 'sm_lock' } } },
            function() { throw new Error('boom'); },
            'someScript',
            { loadProjectConfig: function() { return {}; } },
            { createTracker: function() { return tracker; } }
        );
        assert.equal(result.success, false);
        assert.contains(result.error, 'boom');
        assert.deepEqual(removedLabels, [{ key: 'T-1', label: 'sm_lock' }]);
    });

    test('resolveActionContext tolerates bare params without jobParams or ticket', function() {
        var smDoneCheck = loadSmDoneCheck();
        var loadedWith = null;
        var ctx = smDoneCheck.resolveActionContext(
            {},
            { loadProjectConfig: function(p) { loadedWith = p; return { cfg: true }; } },
            { createTracker: function(cfg, cp) { return { cfgSeen: cfg, cpSeen: cp }; } }
        );
        assert.equal(ctx.ticketKey, undefined);
        assert.equal(ctx.removeLabel, undefined);
        assert.deepEqual(loadedWith, {}, 'loadProjectConfig falls back to bare params');
        assert.equal(ctx.tracker.cfgSeen.cfg, true);
        assert.deepEqual(ctx.tracker.cpSeen, {}, 'customParams defaults to {}');
    });

    test('runDoneCheckAction fails when ticketKey is missing', function() {
        var smDoneCheck = loadSmDoneCheck();
        var result = smDoneCheck.runDoneCheckAction(
            { jobParams: { customParams: {} } },
            function() { return { ok: true }; },
            'someScript',
            { loadProjectConfig: function() { return {}; } },
            { createTracker: function() { return {}; } }
        );
        assert.equal(result.success, false);
        assert.contains(result.error, 'params.ticket.key is missing');
    });
});
