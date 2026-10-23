/**
 * Unit tests for js/assignForSolutionArchitecture.js.
 *
 * The wave1a-ii tracker-migration suite (test_wave1aiiTrackerMigration.js)
 * covers the jira/ado tool mapping; these tests characterize the action's
 * step sequencing and the quiet-failure contract of every step, plus the
 * gh-1187 extracted helpers.
 */

function asaLoad(opts) {
    opts = opts || {};
    var calls = [];
    var trackerGlobals = {};
    ['assign_ticket_to', 'move_to_status', 'add_label', 'remove_label'].forEach(function(n) {
        trackerGlobals['jira_' + n] = function(a) {
            calls.push({ tool: 'jira_' + n, args: a });
            if (opts['fail' + n]) { throw new Error(n + ' boom'); }
        };
        trackerGlobals['ado_' + n] = function(a) {
            calls.push({ tool: 'ado_' + n, args: a });
            if (opts['failAdo' + n]) { throw new Error(n + ' boom'); }
        };
    });
    var tokenUsageCalls = [];
    var autoStartCalls = [];
    var mod = loadModule('js/assignForSolutionArchitecture.js', makeRequire({
        './common/jiraHelpers.js': { extractTicketKey: function() { return null; } },
        './config.js': configModule,
        './configLoader.js': { loadProjectConfig: function() {
            if (opts.failConfig) { throw new Error('cfg boom'); }
            return { jira: { statuses: { SOLUTION_ARCHITECTURE: 'Solution Architecture' } } };
        } },
        './common/scm.js': { createScm: function() { return {}; } },
        './common/autoStart.js': {
            triggerConfiguredWorkflowForTicket: function(a) {
                autoStartCalls.push(a);
                if (opts.failAutoStart) { throw new Error('autoStart boom'); }
                return true;
            },
            triggerSmIfIdle: function() {}
        },
        './common/tokenUsageComment.js': {
            postTokenUsageComments: function(key, o) {
                tokenUsageCalls.push({ key: key, options: o });
                if (opts.failTokenUsage) { throw new Error('tokenUsage boom'); }
            },
            customParamsOf: function(params) {
                return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
            }
        },
        './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }), trackerGlobals)
    }), trackerGlobals);
    return { mod: mod, calls: calls, tokenUsageCalls: tokenUsageCalls, autoStartCalls: autoStartCalls };
}

function asaParams(overrides) {
    return Object.assign({
        ticket: { key: 'PROJ-1' },
        initiator: 'initiator-account',
        metadata: { contextId: 'story_acceptance_criteria' },
        jobParams: {}
    }, overrides || {});
}

function asaTools(calls) { return calls.map(function(c) { return c.tool; }); }

suite('assignForSolutionArchitecture — action step sequencing', function() {

    test('happy path: assign, move, ai_generated label, WIP + trigger labels removed, token usage', function() {
        var env = asaLoad();

        var result = env.mod.action(asaParams());

        assert.equal(result.success, true);
        assert.equal(result.message, 'PROJ-1 assigned and moved to Solution Architecture');
        assert.deepEqual(asaTools(env.calls), [
            'jira_assign_ticket_to', 'jira_move_to_status', 'jira_add_label',
            'jira_remove_label', 'jira_remove_label', 'jira_remove_label'
        ]);
        // Remove order: WIP label first, then the two acceptance-criteria trigger labels.
        assert.deepEqual(env.calls.slice(3).map(function(c) { return c.args.label; }), [
            'story_acceptance_criteria_wip',
            'sm_story_acceptance_criteria_triggered',
            'sm_story_acceptance_criterias_triggered'
        ]);
        assert.equal(env.tokenUsageCalls.length, 1);
        assert.equal(env.tokenUsageCalls[0].key, 'PROJ-1');
        assert.equal(env.tokenUsageCalls[0].options.initiator, 'initiator-account');
    });

    test('no initiator — assignment is skipped, everything else runs', function() {
        var env = asaLoad();

        var result = env.mod.action(asaParams({ initiator: null }));

        assert.equal(result.success, true);
        assert.deepEqual(asaTools(env.calls), [
            'jira_move_to_status', 'jira_add_label',
            'jira_remove_label', 'jira_remove_label', 'jira_remove_label'
        ]);
    });

    test('assignment failure is non-fatal — move and labels still happen', function() {
        var env = asaLoad({ failassign_ticket_to: true });

        var result = env.mod.action(asaParams());

        assert.equal(result.success, true);
        assert.deepEqual(asaTools(env.calls).slice(0, 2), ['jira_assign_ticket_to', 'jira_move_to_status']);
    });

    test('move failure aborts the action — labels NOT removed, failure returned', function() {
        var env = asaLoad({ failmove_to_status: true });

        var result = env.mod.action(asaParams());

        assert.equal(result.success, false);
        assert.contains(result.error, 'move_to_status boom');
        assert.deepEqual(asaTools(env.calls), ['jira_assign_ticket_to', 'jira_move_to_status']);
        assert.equal(env.tokenUsageCalls.length, 0, 'token usage not posted after move failure');
    });

    test('ai_generated label failure is non-fatal — WIP + trigger labels still removed', function() {
        var env = asaLoad({ failadd_label: true });

        var result = env.mod.action(asaParams());

        assert.equal(result.success, true);
        assert.equal(asaTools(env.calls).filter(function(t) { return t === 'jira_remove_label'; }).length, 3);
    });

    test('WIP label removal failure is non-fatal — trigger labels still removed', function() {
        var env = asaLoad({ failremove_label: true });

        var result = env.mod.action(asaParams());

        assert.equal(result.success, true);
        assert.equal(asaTools(env.calls).filter(function(t) { return t === 'jira_remove_label'; }).length, 3);
    });

    test('no metadata.contextId — no WIP label removal, trigger labels still removed', function() {
        var env = asaLoad();

        var result = env.mod.action(asaParams({ metadata: null }));

        assert.equal(result.success, true);
        assert.deepEqual(asaTools(env.calls), [
            'jira_assign_ticket_to', 'jira_move_to_status', 'jira_add_label',
            'jira_remove_label', 'jira_remove_label'
        ]);
        assert.deepEqual(env.calls.slice(3).map(function(c) { return c.args.label; }), [
            'sm_story_acceptance_criteria_triggered',
            'sm_story_acceptance_criterias_triggered'
        ]);
    });

    test('token usage posting failure is non-fatal', function() {
        var env = asaLoad({ failTokenUsage: true });

        var result = env.mod.action(asaParams());

        assert.equal(result.success, true);
        assert.equal(env.autoStartCalls.length, 0, 'no auto-start without customParams');
    });

    test('project config load failure — error result', function() {
        var env = asaLoad({ failConfig: true });

        var result = env.mod.action(asaParams());

        assert.equal(result.success, false);
        assert.contains(result.error, 'cfg boom');
    });

});

suite('assignForSolutionArchitecture — autoStartSolution trigger', function() {

    test('autoStartSolution=true with a config file triggers the configured workflow', function() {
        var env = asaLoad();
        var customParams = {
            autoStartSolution: true,
            autoStartSolutionConfigFile: 'agents/solution_design.json',
            unrelated: 'keep'
        };

        var result = env.mod.action(asaParams({ jobParams: { customParams: customParams } }));

        assert.equal(result.success, true);
        assert.equal(env.autoStartCalls.length, 1);
        assert.equal(env.autoStartCalls[0].configFile, 'agents/solution_design.json');
        assert.equal(env.autoStartCalls[0].label, 'solution');
        assert.deepEqual(env.autoStartCalls[0].stripKeys, ['autoStartSolution', 'autoStartSolutionConfigFile']);
        assert.equal(env.autoStartCalls[0].ticketKey, 'PROJ-1');
        assert.equal(env.autoStartCalls[0].customParams.unrelated, 'keep');
    });

    test("autoStartSolution='true' (string) also triggers", function() {
        var env = asaLoad();
        var customParams = { autoStartSolution: 'true', autoStartSolutionConfigFile: 'agents/solution_design.json' };

        env.mod.action(asaParams({ jobParams: { customParams: customParams } }));

        assert.equal(env.autoStartCalls.length, 1);
    });

    test('autoStartSolution without a config file does not trigger', function() {
        var env = asaLoad();
        var customParams = { autoStartSolution: true };

        env.mod.action(asaParams({ jobParams: { customParams: customParams } }));

        assert.equal(env.autoStartCalls.length, 0);
    });

    test('autoStart trigger failure is non-fatal', function() {
        var env = asaLoad({ failAutoStart: true });
        var customParams = { autoStartSolution: true, autoStartSolutionConfigFile: 'agents/solution_design.json' };

        var result = env.mod.action(asaParams({ jobParams: { customParams: customParams } }));

        assert.equal(result.success, true);
        assert.equal(env.autoStartCalls.length, 1);
    });

});

suite('assignForSolutionArchitecture — gh-1187 extracted helpers', function() {

    test('resolveWipLabel: contextId + _wip, null without metadata', function() {
        var env = asaLoad();
        assert.equal(env.mod.resolveWipLabel({ metadata: { contextId: 'story_questions' } }), 'story_questions_wip');
        assert.equal(env.mod.resolveWipLabel({ metadata: null }), null);
        assert.equal(env.mod.resolveWipLabel({}), null);
    });

    test('resolveCustomParams: jobParams.customParams wins, params.customParams is the fallback', function() {
        var env = asaLoad();
        assert.deepEqual(env.mod.resolveCustomParams({ jobParams: { customParams: { a: 1 } } }), { a: 1 });
        assert.deepEqual(env.mod.resolveCustomParams({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(env.mod.resolveCustomParams({ jobParams: {} }), {});
    });

});
