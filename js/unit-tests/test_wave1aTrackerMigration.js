/**
 * Tracker-layer migration tests (wave 1a-i): moveToDone, moveToInTesting,
 * moveToReadyForTesting, triggerStoryTestAutomation, commitAndPushToBaseBranch.
 */

function w1aTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function w1aRecorder() {
    var calls = [];
    var mocks = {};
    ['move_to_status', 'post_comment', 'add_label', 'remove_label', 'assign_ticket_to',
     'move_to_state', 'add_work_item_comment', 'add_work_item_label', 'remove_work_item_label',
     'assign_work_item'].forEach(function(n) {
        mocks['jira_' + n] = function(a) { calls.push({ tool: 'jira_' + n, args: a }); };
        mocks['ado_' + n] = function(a) { calls.push({ tool: 'ado_' + n, args: a }); };
    });
    return { calls: calls, mocks: mocks };
}
function w1aTools(calls) { return calls.map(function(c) { return c.tool; }); }
function w1aNoJira(calls) {
    assert.equal(w1aTools(calls).filter(function(t) { return t.indexOf('jira_') === 0; }).length, 0);
}

var W1A_CFG = { jira: { statuses: { DONE: 'Done', IN_TESTING: 'In Testing', READY_FOR_TESTING: 'Ready For Testing' } } };

function w1aLoad(file, rec) {
    return loadModule('js/' + file, makeRequire({
        './configLoader.js': { loadProjectConfig: function() { return W1A_CFG; } },
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/trackers.js': w1aTrackers(rec.mocks)
    }), rec.mocks);
}
function w1aParams(key, ado) {
    var p = { ticket: { key: key }, jobParams: {} };
    if (ado) p.jobParams.customParams = { trackerProvider: 'ado' };
    return p;
}

suite('wave1a tracker migration — moveToDone', function() {
    test('jira', function() {
        var rec = w1aRecorder();
        var r = w1aLoad('moveToDone.js', rec).action(w1aParams('TS-1'));
        assert.equal(r.success, true);
        assert.deepEqual(w1aTools(rec.calls), ['jira_move_to_status', 'jira_remove_label', 'jira_post_comment']);
        assert.deepEqual(rec.calls[0].args, { key: 'TS-1', statusName: 'Done' });
        assert.deepEqual(rec.calls[1].args, { key: 'TS-1', label: 'sm_bug_test_cases_triggered' });
    });
    test('ado', function() {
        var rec = w1aRecorder();
        var r = w1aLoad('moveToDone.js', rec).action(w1aParams('12', true));
        assert.equal(r.success, true);
        assert.deepEqual(w1aTools(rec.calls), ['ado_move_to_state', 'ado_remove_work_item_label', 'ado_add_work_item_comment']);
        assert.equal(rec.calls[0].args.id, '12');
        w1aNoJira(rec.calls);
    });
});

suite('wave1a tracker migration — moveToInTesting', function() {
    test('jira', function() {
        var rec = w1aRecorder();
        var r = w1aLoad('moveToInTesting.js', rec).action(w1aParams('TS-2'));
        assert.equal(r.success, true);
        assert.deepEqual(w1aTools(rec.calls), ['jira_move_to_status', 'jira_remove_label']);
        assert.deepEqual(rec.calls[0].args, { key: 'TS-2', statusName: 'In Testing' });
    });
    test('ado', function() {
        var rec = w1aRecorder();
        var r = w1aLoad('moveToInTesting.js', rec).action(w1aParams('12', true));
        assert.equal(r.success, true);
        assert.deepEqual(w1aTools(rec.calls), ['ado_move_to_state', 'ado_remove_work_item_label']);
        assert.equal(rec.calls[0].args.id, '12');
        assert.equal(rec.calls[1].args.id, '12');
        w1aNoJira(rec.calls);
    });
});

suite('wave1a tracker migration — moveToReadyForTesting', function() {
    test('jira', function() {
        var rec = w1aRecorder();
        var r = w1aLoad('moveToReadyForTesting.js', rec).action(w1aParams('TS-3'));
        assert.equal(r.success, true);
        assert.deepEqual(w1aTools(rec.calls), ['jira_move_to_status']);
        assert.deepEqual(rec.calls[0].args, { key: 'TS-3', statusName: 'Ready For Testing' });
    });
    test('ado', function() {
        var rec = w1aRecorder();
        var r = w1aLoad('moveToReadyForTesting.js', rec).action(w1aParams('12', true));
        assert.equal(r.success, true);
        assert.deepEqual(w1aTools(rec.calls), ['ado_move_to_state']);
        assert.equal(rec.calls[0].args.id, '12');
    });
});

suite('wave1a tracker migration — triggerStoryTestAutomation (ado)', function() {
    test('ado removes SM label via ado tool only', function() {
        var rec = w1aRecorder();
        var m = loadModule('js/triggerStoryTestAutomation.js', makeRequire({
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; }, triggerSmIfIdle: function() {} },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': w1aTrackers(rec.mocks)
        }), rec.mocks);
        var r = m.action({ ticket: { key: '12' }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(r.success, true);
        assert.deepEqual(w1aTools(rec.calls), ['ado_remove_work_item_label']);
        assert.equal(rec.calls[0].args.id, '12');
        w1aNoJira(rec.calls);
    });
});

function w1aLoadCommit(rec, status, cfg) {
    var mocks = Object.assign({
        cli_execute_command: function(a) { return a.command === 'git status --porcelain' ? status : ''; }
    }, rec.mocks);
    return loadModule('js/commitAndPushToBaseBranch.js', makeRequire({
        './common/jiraHelpers.js': { extractTicketKey: function(p) { return p.ticket.key; } },
        './configLoader.js': { loadProjectConfig: function() { return cfg; } },
        './common/gitStaging.js': { buildExclusionPathspecs: function() { return ':!factory-kit'; } },
        './common/trackers.js': w1aTrackers(rec.mocks)
    }), mocks);
}

suite('wave1a tracker migration — commitAndPushToBaseBranch', function() {
    var cfg = { customParams: { directPush: { successComment: 'Done {ticketKey}', noChangesComment: 'Nothing {ticketKey}' } } };
    test('jira: success comment is actually posted (object-arg bug fixed)', function() {
        var rec = w1aRecorder();
        var ok = w1aLoadCommit(rec, ' M a.txt', cfg).action({ ticket: { key: 'TS-9' } });
        assert.equal(ok, true);
        assert.deepEqual(w1aTools(rec.calls), ['jira_post_comment']);
        assert.deepEqual(rec.calls[0].args, { key: 'TS-9', comment: 'Done TS-9' });
    });
    test('jira: no-changes comment posted', function() {
        var rec = w1aRecorder();
        var ok = w1aLoadCommit(rec, '', cfg).action({ ticket: { key: 'TS-9' } });
        assert.equal(ok, true);
        assert.deepEqual(rec.calls[0].args, { key: 'TS-9', comment: 'Nothing TS-9' });
    });
    test('ado: comment via ado tool only', function() {
        var rec = w1aRecorder();
        var c = { customParams: { trackerProvider: 'ado', directPush: cfg.customParams.directPush } };
        var ok = w1aLoadCommit(rec, ' M a.txt', c).action({ ticket: { key: '12' } });
        assert.equal(ok, true);
        assert.deepEqual(w1aTools(rec.calls), ['ado_add_work_item_comment']);
        assert.equal(rec.calls[0].args.id, '12');
        w1aNoJira(rec.calls);
    });
});
