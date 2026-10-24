/**
 * Unit tests for js/closeQuestionTicket.js (gh-1228 CRAP characterization).
 *
 * Pins the action() contract: ai_generated label, WIP label removal, move to
 * Done, token usage comments, and every non-fatal failure path.
 */

function loadCloseQuestionTicket(mocks) {
    var defaults = {
        file_read: function() { return null; },
        file_write: function() {}
    };
    var g = Object.assign({}, defaults, mocks || {});
    return loadModule(
        'js/closeQuestionTicket.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': g.__configLoader || { loadProjectConfig: function() {
                return { jira: { statuses: { DONE: 'Done' } } };
            } },
            './common/tokenUsageComment.js': g.__tokenUsage || { postTokenUsageComments: function() {} },
            './common/trackers.js': { createTracker: function(config, customParams) {
                return g.__tracker;
            } }
        }),
        g
    );
}

function recordingTracker(overrides) {
    var calls = { addLabel: [], removeLabel: [], moveToStatus: [] };
    var t = {
        calls: calls,
        addLabel: function(key, label) { calls.addLabel.push({ key: key, label: label }); },
        removeLabel: function(key, label) { calls.removeLabel.push({ key: key, label: label }); },
        moveToStatus: function(key, status) { calls.moveToStatus.push({ key: key, status: status }); }
    };
    for (var k in (overrides || {})) { t[k] = overrides[k]; }
    return t;
}

suite('closeQuestionTicket — action contract', function() {

    test('happy path — ai_generated label, WIP removal, move to Done, token usage comments', function() {
        var usageCalls = [];
        var tracker = recordingTracker();
        var mod = loadCloseQuestionTicket({
            __tracker: tracker,
            __tokenUsage: { postTokenUsageComments: function(key, opts) { usageCalls.push({ key: key, opts: opts }); } }
        });

        var r = mod.action({ ticket: { key: 'PROJ-7' }, metadata: { contextId: 'question' }, initiator: 'acc', jobParams: {} });

        assert.equal(r.success, true, 'action succeeds');
        assert.contains(r.message, 'PROJ-7');
        assert.deepEqual(tracker.calls.addLabel, [{ key: 'PROJ-7', label: configModule.LABELS.AI_GENERATED }], 'ai_generated label added');
        assert.deepEqual(tracker.calls.removeLabel, [{ key: 'PROJ-7', label: 'question_wip' }], 'context WIP label removed');
        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-7', status: 'Done' }], 'moved to Done');
        assert.equal(usageCalls.length, 1, 'token usage comments posted');
        assert.equal(usageCalls[0].key, 'PROJ-7');
        assert.equal(usageCalls[0].opts.initiator, 'acc');
    });

    test('no metadata.contextId — WIP label is not touched', function() {
        var tracker = recordingTracker();
        var mod = loadCloseQuestionTicket({ __tracker: tracker });

        var r = mod.action({ ticket: { key: 'PROJ-8' }, jobParams: {} });

        assert.equal(r.success, true, 'action succeeds');
        assert.equal(tracker.calls.removeLabel.length, 0, 'no WIP label removal without a contextId');
        assert.deepEqual(tracker.calls.addLabel, [{ key: 'PROJ-8', label: configModule.LABELS.AI_GENERATED }], 'ai_generated still added');
    });

    test('addLabel failure is non-fatal — WIP removal and move still happen', function() {
        var tracker = recordingTracker({
            addLabel: function() { throw new Error('label service down'); }
        });
        var mod = loadCloseQuestionTicket({ __tracker: tracker });

        var r = mod.action({ ticket: { key: 'PROJ-9' }, metadata: { contextId: 'q' }, jobParams: {} });

        assert.equal(r.success, true, 'still succeeds');
        assert.deepEqual(tracker.calls.removeLabel, [{ key: 'PROJ-9', label: 'q_wip' }], 'WIP removal still attempted');
        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-9', status: 'Done' }], 'still moved to Done');
    });

    test('removeLabel failure is non-fatal — move still happens', function() {
        var tracker = recordingTracker({
            removeLabel: function() { throw new Error('remove failed'); }
        });
        var mod = loadCloseQuestionTicket({ __tracker: tracker });

        var r = mod.action({ ticket: { key: 'PROJ-10' }, metadata: { contextId: 'q' }, jobParams: {} });

        assert.equal(r.success, true, 'still succeeds');
        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-10', status: 'Done' }], 'still moved to Done');
    });

    test('token usage comment failure is non-fatal', function() {
        var tracker = recordingTracker();
        var mod = loadCloseQuestionTicket({
            __tracker: tracker,
            __tokenUsage: { postTokenUsageComments: function() { throw new Error('usage post failed'); } }
        });

        var r = mod.action({ ticket: { key: 'PROJ-11' }, metadata: { contextId: 'q' }, jobParams: {} });

        assert.equal(r.success, true, 'still succeeds');
        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-11', status: 'Done' }], 'still moved to Done');
    });

    test('moveToStatus failure propagates as a failure result (outer catch)', function() {
        var tracker = recordingTracker({
            moveToStatus: function() { throw new Error('transition rejected'); }
        });
        var mod = loadCloseQuestionTicket({ __tracker: tracker });

        var r = mod.action({ ticket: { key: 'PROJ-12' }, metadata: { contextId: 'q' }, jobParams: {} });

        assert.equal(r.success, false, 'move failure fails the action');
        assert.contains(r.error, 'transition rejected');
    });

    test('config load failure is reported as a failure result', function() {
        var mod = loadCloseQuestionTicket({
            __configLoader: { loadProjectConfig: function() { throw new Error('bad config'); } },
            __tracker: recordingTracker()
        });

        var r = mod.action({ ticket: { key: 'PROJ-13' }, jobParams: {} });

        assert.equal(r.success, false, 'config failure fails the action');
        assert.contains(r.error, 'bad config');
    });
});
