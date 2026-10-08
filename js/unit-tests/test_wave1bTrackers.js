/**
 * Tracker-layer tests (jira + ado) for scripts without a dedicated test file:
 * recoverStuckDevelopment, enhanceSDAPIDescriptionAndAssess, preCliTestAutomationSetup.
 */

function trackersWithMocks(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

function jiraBoom(name) {
    return function() { throw new Error(name + ' must not be called on ado'); };
}

function loadRecoverStuck(mocks, scm) {
    return loadModule('js/recoverStuckDevelopment.js', makeRequire({
        './configLoader.js': {
            loadProjectConfig: function() { return { jira: {} }; },
            createScm: function() { return scm; }
        },
        './config.js': configModule,
        './common/trackers.js': trackersWithMocks(mocks)
    }), mocks);
}

suite('recoverStuckDevelopment: tracker layer', function() {
    test('jira: no PR -> jira_move_to_status / jira_remove_label / jira_post_comment', function() {
        var calls = [];
        var mod = loadRecoverStuck({
            jira_move_to_status: function(a) { calls.push(['move', a]); },
            jira_remove_label: function(a) { calls.push(['rm', a]); },
            jira_post_comment: function(a) { calls.push(['comment', a]); }
        }, { listPrs: function() { return []; } });
        var r = mod.action({ ticket: { key: 'TS-1' }, jobParams: {} });
        assert.equal(r.action, 'moved_to_ready_for_development');
        assert.deepEqual(calls[0], ['move', { key: 'TS-1', statusName: 'Ready For Development' }]);
        assert.equal(calls.filter(function(c) { return c[0] === 'rm'; }).length, 3);
        assert.equal(calls[calls.length - 1][0], 'comment');
        assert.equal(calls[calls.length - 1][1].key, 'TS-1');
    });

    test('ado: open PR -> ado_move_to_state / ado_add_work_item_comment, no jira_*', function() {
        var calls = [];
        var mod = loadRecoverStuck({
            ado_move_to_state: function(a) { calls.push(['move', a]); },
            ado_remove_work_item_label: function(a) { calls.push(['rm', a]); },
            ado_add_work_item_comment: function(a) { calls.push(['comment', a]); },
            jira_move_to_status: jiraBoom('jira_move_to_status'),
            jira_remove_label: jiraBoom('jira_remove_label'),
            jira_post_comment: jiraBoom('jira_post_comment')
        }, { listPrs: function() { return [{ number: 3, title: '77 x', head: { ref: 'ai/77' } }]; } });
        var r = mod.action({ ticket: { key: '77' }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(r.action, 'moved_to_review');
        assert.deepEqual(calls[0], ['move', { id: '77', state: 'In Review' }]);
        assert.equal(calls.filter(function(c) { return c[0] === 'comment'; }).length, 1);
    });
});

function loadEnhanceSD(mocks) {
    return loadModule('js/enhanceSDAPIDescriptionAndAssess.js', makeRequire({
        './common/jiraHelpers.js': { extractTicketKey: function(k) { return k; } },
        './config.js': configModule,
        './common/trackers.js': trackersWithMocks(mocks)
    }), mocks);
}

var ENHANCE_RESPONSE = JSON.stringify({ description: 'New desc', diagram: 'graph TD', apiSubtaskCreation: true });

suite('enhanceSDAPIDescriptionAndAssess: tracker layer', function() {
    test('jira: description, diagram field, labels and assignment via jira_* tools', function() {
        var calls = [];
        var mod = loadEnhanceSD({
            jira_update_description: function(a) { calls.push(['desc', a]); },
            jira_update_field: function(a) { calls.push(['field', a]); },
            jira_add_label: function(a) { calls.push(['label', a]); },
            jira_assign_ticket_to: function(a) { calls.push(['assign', a]); },
            jira_move_to_status: function(a) { calls.push(['move', a]); },
            jira_remove_label: function(a) { calls.push(['rm', a]); }
        });
        var r = mod.action({ ticket: { key: 'TS-5' }, initiator: 'acc1', response: ENHANCE_RESPONSE, metadata: { contextId: 'ctx' } });
        assert.equal(r.success, true);
        assert.deepEqual(calls[0], ['desc', { key: 'TS-5', description: 'New desc' }]);
        assert.equal(calls[1][0], 'field');
        assert.equal(calls[1][1].key, 'TS-5');
        assert.ok(calls.some(function(c) { return c[0] === 'assign' && c[1].accountId === 'acc1'; }));
    });

    test('ado: uses ado_* tools only', function() {
        var calls = [];
        var mod = loadEnhanceSD({
            ado_update_description: function(a) { calls.push(['desc', a]); },
            ado_update_field: function(a) { calls.push(['field', a]); },
            ado_add_work_item_label: function(a) { calls.push(['label', a]); },
            ado_assign_work_item: function(a) { calls.push(['assign', a]); },
            ado_move_to_state: function(a) { calls.push(['move', a]); },
            ado_remove_work_item_label: function(a) { calls.push(['rm', a]); },
            jira_update_description: jiraBoom('jira_update_description'),
            jira_update_field: jiraBoom('jira_update_field'),
            jira_add_label: jiraBoom('jira_add_label'),
            jira_assign_ticket_to: jiraBoom('jira_assign_ticket_to'),
            jira_move_to_status: jiraBoom('jira_move_to_status'),
            jira_remove_label: jiraBoom('jira_remove_label')
        });
        var r = mod.action({
            ticket: { key: '42' }, initiator: 'a@b.c', response: ENHANCE_RESPONSE,
            metadata: { contextId: 'ctx' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(r.success, true);
        assert.deepEqual(calls[0], ['desc', { id: '42', description: 'New desc' }]);
        assert.ok(calls.some(function(c) { return c[0] === 'assign'; }));
        assert.ok(calls.some(function(c) { return c[0] === 'move'; }));
    });
});

function loadPreCliTest(mocks) {
    var cfg = { git: { baseBranch: 'main', branchPrefix: 'ai' }, jira: {} };
    return loadModule('js/preCliTestAutomationSetup.js', makeRequire({
        './configLoader.js': { loadProjectConfig: function() { return cfg; } },
        './common/pullRequest.js': {},
        './config.js': configModule,
        './fetchLinkedBugsToInput.js': { action: function() {} },
        './common/trackers.js': trackersWithMocks(mocks)
    }), Object.assign({ cli_execute_command: function() { return ''; } }, mocks));
}

suite('preCliTestAutomationSetup: tracker layer', function() {
    test('jira: moves ticket to In Development via jira_move_to_status', function() {
        var moves = [];
        var mod = loadPreCliTest({ jira_move_to_status: function(a) { moves.push(a); } });
        mod.action({ inputFolderPath: 'input/TS-9' });
        assert.deepEqual(moves, [{ key: 'TS-9', statusName: 'In Development' }]);
    });

    test('ado: moves ticket via ado_move_to_state, no jira_*', function() {
        var moves = [];
        var mod = loadPreCliTest({
            ado_move_to_state: function(a) { moves.push(a); },
            jira_move_to_status: jiraBoom('jira_move_to_status')
        });
        mod.action({ inputFolderPath: 'input/9', jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.deepEqual(moves, [{ id: '9', state: 'In Development' }]);
    });
});
