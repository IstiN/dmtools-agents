/**
 * Tracker-layer migration tests (wave 1a-ii): preparePRForReview,
 * assignForSolutionArchitecture, enhanceSolutionDesignDescriptionAndAssess.
 */

function w2Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function w2Recorder() {
    var calls = [];
    var mocks = {};
    ['move_to_status', 'post_comment', 'add_label', 'remove_label', 'assign_ticket_to', 'update_field', 'update_description',
     'move_to_state', 'add_work_item_comment', 'add_work_item_label', 'remove_work_item_label',
     'assign_work_item'].forEach(function(n) {
        mocks['jira_' + n] = function(a) { calls.push({ tool: 'jira_' + n, args: a }); };
        mocks['ado_' + n] = function(a) { calls.push({ tool: 'ado_' + n, args: a }); };
    });
    return { calls: calls, mocks: mocks };
}
function w2Tools(calls) { return calls.map(function(c) { return c.tool; }); }
function w2NoJira(calls) {
    assert.equal(w2Tools(calls).filter(function(t) { return t.indexOf('jira_') === 0; }).length, 0);
}

function w2LoadSA(rec) {
    return loadModule('js/assignForSolutionArchitecture.js', makeRequire({
        './common/jiraHelpers.js': { extractTicketKey: function() { return null; } },
        './config.js': configModule,
        './configLoader.js': { loadProjectConfig: function() { return { jira: { statuses: { SOLUTION_ARCHITECTURE: 'SA' } } }; } },
        './common/scm.js': {},
        './common/autoStart.js': {},
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/trackers.js': w2Trackers(rec.mocks)
    }), rec.mocks);
}

function w2LoadPR(rec) {
    return loadModule('js/preparePRForReview.js', makeRequire({
        './configLoader.js': { loadProjectConfig: function() { return {}; }, createScm: function() { return { getRemoteRepoInfo: function() { return null; } }; } },
        './common/githubHelpers.js': {},
        './common/gitOps.js': {},
        './common/commentMarkup.js': loadModule('js/common/commentMarkup.js', makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') })),
        './fetchParentContextToInput.js': {},
        './common/trackers.js': w2Trackers(rec.mocks)
    }), Object.assign({ config: {} }, rec.mocks));
}

function w2LoadEnh(rec) {
    return loadModule('js/enhanceSolutionDesignDescriptionAndAssess.js', makeRequire({
        './common/jiraHelpers.js': { extractTicketKey: function() { return null; } },
        './config.js': configModule,
        './common/outputFiles.js': { readOutputFile: function(n) { return n === 'response.md' ? 'DESC' : 'graph TD'; } },
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/trackers.js': w2Trackers(rec.mocks)
    }), rec.mocks);
}

suite('wave1a-ii tracker migration — assignForSolutionArchitecture', function() {
    test('jira: assign, move, label, remove labels via jira_* tools', function() {
        var rec = w2Recorder();
        var r = w2LoadSA(rec).action({ ticket: { key: 'TS-1' }, initiator: 'acc', metadata: { contextId: 'q' }, jobParams: {} });
        assert.equal(r.success, true);
        assert.deepEqual(w2Tools(rec.calls), ['jira_assign_ticket_to', 'jira_move_to_status', 'jira_add_label',
            'jira_remove_label', 'jira_remove_label', 'jira_remove_label']);
        assert.deepEqual(rec.calls[1].args, { key: 'TS-1', statusName: 'SA' });
    });
    test('ado: uses ado_* tools and no jira_* tool', function() {
        var rec = w2Recorder();
        var r = w2LoadSA(rec).action({ ticket: { key: '12' }, initiator: 'a@b.c', metadata: { contextId: 'q' }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(r.success, true);
        assert.deepEqual(w2Tools(rec.calls), ['ado_assign_work_item', 'ado_move_to_state', 'ado_add_work_item_label',
            'ado_remove_work_item_label', 'ado_remove_work_item_label', 'ado_remove_work_item_label']);
        assert.equal(rec.calls[1].args.id, '12');
        w2NoJira(rec.calls);
    });
});

suite('wave1a-ii tracker migration — preparePRForReview', function() {
    test('jira: repo resolution failure posts comment via jira_post_comment', function() {
        var rec = w2Recorder();
        var r = w2LoadPR(rec).action({ inputFolderPath: 'input/TS-3', jobParams: {} });
        assert.equal(r, false);
        assert.deepEqual(w2Tools(rec.calls), ['jira_post_comment']);
        assert.equal(rec.calls[0].args.key, 'TS-3');
    });
    test('ado: repo resolution failure posts comment via ado tool only', function() {
        var rec = w2Recorder();
        var r = w2LoadPR(rec).action({ inputFolderPath: 'input/33', jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(r, false);
        assert.deepEqual(w2Tools(rec.calls), ['ado_add_work_item_comment']);
        assert.equal(rec.calls[0].args.id, '33');
        w2NoJira(rec.calls);
    });
});

suite('wave1a-ii tracker migration — enhanceSolutionDesignDescriptionAndAssess', function() {
    test('jira: description, field, assign flow via jira_* tools', function() {
        var rec = w2Recorder();
        var r = w2LoadEnh(rec).action({ ticket: { key: 'TS-4' }, initiator: 'acc', metadata: { contextId: 'q' } });
        assert.equal(r.success, true);
        assert.deepEqual(w2Tools(rec.calls), ['jira_update_description', 'jira_update_field', 'jira_assign_ticket_to',
            'jira_move_to_status', 'jira_add_label', 'jira_remove_label']);
        assert.equal(rec.calls[0].args.description, 'DESC');
    });
    test('ado: uses ado_* tools and no jira_* tool', function() {
        var rec = w2Recorder();
        var r = w2LoadEnh(rec).action({ ticket: { key: '44' }, initiator: 'a@b.c', metadata: { contextId: 'q' }, customParams: { trackerProvider: 'ado' } });
        assert.equal(r.success, true);
        w2NoJira(rec.calls);
        var t = w2Tools(rec.calls);
        // ado_update_field is a real tool now (dm.ai#663); recorded through the same mock set.
        assert.deepEqual(t, ['ado_update_description', 'ado_update_field', 'ado_assign_work_item', 'ado_move_to_state',
            'ado_add_work_item_label', 'ado_remove_work_item_label']);
        assert.ok(t.indexOf('ado_move_to_state') >= 0);
        assert.ok(t.indexOf('ado_assign_work_item') >= 0);
    });
});
