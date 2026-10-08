/**
 * Tracker-layer migration tests (wave 1c): closeQuestionTicket,
 * recoverDirtyReviewTestCase, finalizeBugFixBatchMerge, jiraHelpers.
 * Each script is exercised on Jira (jira_* tools) and on ADO (ado_* tools,
 * proving NO jira_* tool is touched).
 */

function w1cTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function w1cRecorder(prefix) {
    var calls = [];
    var mocks = {};
    ['move_to_status', 'post_comment', 'add_label', 'remove_label', 'assign_ticket_to', 'set_priority',
     'move_to_state', 'add_work_item_comment', 'add_work_item_label', 'remove_work_item_label',
     'assign_work_item', 'set_priority', 'update_field'].forEach(function(n) {
        mocks['jira_' + n] = function(a) { calls.push({ tool: 'jira_' + n, args: a }); };
        mocks['ado_' + n] = function(a) { calls.push({ tool: 'ado_' + n, args: a }); };
    });
    return { calls: calls, mocks: mocks };
}

function w1cTools(calls) { return calls.map(function(c) { return c.tool; }); }
function w1cNoJira(calls) {
    assert.equal(w1cTools(calls).filter(function(t) { return t.indexOf('jira_') === 0; }).length, 0);
}

var w1cKey = { k: 'TS-5' };
var W1C_CFG = { jira: { statuses: { DONE: 'Done', IN_REWORK: 'In Rework' } }, repository: { owner: 'o', repo: 'r' } };

function w1cLoadClose(rec) {
    return loadModule('js/closeQuestionTicket.js', makeRequire({
        './config.js': configModule,
        './configLoader.js': { loadProjectConfig: function() { return W1C_CFG; } },
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/trackers.js': w1cTrackers(rec.mocks)
    }), rec.mocks);
}

function w1cLoadDirty(rec) {
    return loadModule('js/recoverDirtyReviewTestCase.js', makeRequire({
        './configLoader.js': { loadProjectConfig: function() { return W1C_CFG; } },
        './common/scm.js': { createScm: function() {
            return { listPrs: function() { return [{ number: 7, title: String(w1cKey.k) + ' fix', head: { ref: 'ai/TS-5' }, mergeable: false }]; },
                     getPr: function() { return { mergeable: false }; } };
        } },
        './common/trackers.js': w1cTrackers(rec.mocks)
    }), Object.assign({ file_read: function() { return null; }, file_write: function() {} }, rec.mocks));
}

function w1cLoadFinalize(rec) {
    return loadModule('js/finalizeBugFixBatchMerge.js', makeRequire({
        './prepareBugFixBatchContext.js': { findBugsInEpic: function() { return [{ key: 'B-1' }]; } },
        './config.js': configModule,
        './common/trackers.js': w1cTrackers(rec.mocks)
    }), rec.mocks);
}

suite('wave1c tracker migration — closeQuestionTicket', function() {
    test('jira: label, status and wip handling via jira_* tools', function() {
        var rec = w1cRecorder();
        var r = w1cLoadClose(rec).action({ ticket: { key: 'TS-1' }, metadata: { contextId: 'q' }, jobParams: {} });
        assert.equal(r.success, true);
        assert.deepEqual(w1cTools(rec.calls), ['jira_add_label', 'jira_remove_label', 'jira_move_to_status']);
        assert.deepEqual(rec.calls[2].args, { key: 'TS-1', statusName: 'Done' });
    });
    test('ado: uses ado_* tools and no jira_* tool', function() {
        var rec = w1cRecorder();
        var r = w1cLoadClose(rec).action({ ticket: { key: '12' }, metadata: { contextId: 'q' }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(r.success, true);
        assert.deepEqual(w1cTools(rec.calls), ['ado_add_work_item_label', 'ado_remove_work_item_label', 'ado_move_to_state']);
        w1cNoJira(rec.calls);
    });
});

suite('wave1c tracker migration — recoverDirtyReviewTestCase', function() {
    test('jira: moves to rework, drops labels, comments', function() {
        var rec = w1cRecorder();
        var r = w1cLoadDirty(rec).action({ ticket: { key: 'TS-5' }, jobParams: {} });
        assert.equal(r.action, 'moved_to_rework');
        assert.deepEqual(w1cTools(rec.calls), ['jira_move_to_status', 'jira_remove_label', 'jira_remove_label', 'jira_remove_label', 'jira_post_comment']);
    });
    test('ado: uses ado_* tools and no jira_* tool', function() {
        var rec = w1cRecorder();
        w1cKey.k = '5';
        var r = w1cLoadDirty(rec).action({ ticket: { key: '5' }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(r.action, 'moved_to_rework');
        assert.deepEqual(w1cTools(rec.calls), ['ado_move_to_state', 'ado_remove_work_item_label', 'ado_remove_work_item_label', 'ado_remove_work_item_label', 'ado_add_work_item_comment']);
        w1cNoJira(rec.calls);
    });
});

suite('wave1c tracker migration — finalizeBugFixBatchMerge', function() {
    test('jira: moves bug and epic to Done and comments', function() {
        var rec = w1cRecorder();
        var r = w1cLoadFinalize(rec).action({ inputFolderPath: 'input/EP-1', customParams: {} });
        assert.deepEqual(r.movedBugs, ['B-1']);
        assert.deepEqual(w1cTools(rec.calls), ['jira_move_to_status', 'jira_move_to_status', 'jira_post_comment']);
    });
    test('ado: uses ado_* tools and no jira_* tool', function() {
        var rec = w1cRecorder();
        var r = w1cLoadFinalize(rec).action({ inputFolderPath: 'input/30', customParams: { trackerProvider: 'ado' } });
        assert.deepEqual(r.movedBugs, ['B-1']);
        assert.deepEqual(w1cTools(rec.calls), ['ado_move_to_state', 'ado_move_to_state', 'ado_add_work_item_comment']);
        w1cNoJira(rec.calls);
    });
});

suite('wave1c tracker migration — jiraHelpers', function() {
    function helpers(rec) {
        return loadModule('js/common/jiraHelpers.js', makeRequire({
            '../config.js': configModule,
            './trackers.js': w1cTrackers(rec.mocks)
        }), rec.mocks);
    }
    test('assignForReview default tracker (jira) keeps jira_* call order', function() {
        var rec = w1cRecorder();
        var r = helpers(rec).assignForReview('TS-9', 'acc', 'wip', 'In Review');
        assert.equal(r.success, true);
        assert.deepEqual(w1cTools(rec.calls), ['jira_assign_ticket_to', 'jira_move_to_status', 'jira_add_label', 'jira_remove_label']);
    });
    test('assignForReview with explicit ado tracker uses ado_* tools only', function() {
        var rec = w1cRecorder();
        var tracker = w1cTrackers(rec.mocks).createTracker(null, { trackerProvider: 'ado' });
        var r = helpers(rec).assignForReview('9', 'a@b.c', 'wip', 'In Review', tracker);
        assert.equal(r.success, true);
        assert.deepEqual(w1cTools(rec.calls), ['ado_assign_work_item', 'ado_move_to_state', 'ado_add_work_item_label', 'ado_remove_work_item_label']);
        w1cNoJira(rec.calls);
    });
    test('setTicketPriority jira default and ado tracker', function() {
        var rec = w1cRecorder();
        assert.equal(helpers(rec).setTicketPriority('TS-9', 'High'), true);
        assert.equal(rec.calls[0].tool, 'jira_set_priority');
        var rec2 = w1cRecorder();
        var tracker = w1cTrackers(rec2.mocks).createTracker(null, { trackerProvider: 'ado' });
        // ado tools resolve via globals (not module mocks): must fail soft, never touching jira_*
        helpers(rec2).setTicketPriority('9', 'High', tracker);
        w1cNoJira(rec2.calls);
    });
});
