/**
 * Tracker-layer tests (wave 2d4) for scripts without dedicated tracker tests:
 * recoverFailedTCBugStatus, fetchLinkedTestsToInput, redirectToRepoAgent,
 * triggerBitriseIosBuild, workflowFailureReporter, createBugFixBatchEpic,
 * createSolutionDesignTicketsAndAssignForReview, postTestReworkResults.
 * (merge/retry/prepare ADO cases live in their own test files.)
 * Each runs on ado: only ado_* tools may be touched, never jira_*.
 */

function d4Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

function d4Forbid(name) {
    return function() { throw new Error(name + ' must not be called on ado'); };
}

function d4Mocks(calls, extra) {
    var m = {};
    ['ado_move_to_state', 'ado_add_work_item_comment', 'ado_add_work_item_label', 'ado_remove_work_item_label',
     'ado_assign_work_item', 'ado_link_work_items', 'ado_update_description', 'ado_update_tags'].forEach(function(n) {
        m[n] = function(a) { calls.push({ tool: n, args: a }); };
    });
    ['jira_get_ticket', 'jira_search_by_jql', 'jira_post_comment', 'jira_add_label', 'jira_remove_label',
     'jira_move_to_status', 'jira_assign_ticket_to', 'jira_link_issues', 'jira_set_priority',
     'jira_create_ticket_basic', 'jira_create_ticket_with_json', 'jira_create_ticket_with_parent',
     'jira_update_field'].forEach(function(n) { m[n] = d4Forbid(n); });
    return Object.assign(m, extra || {});
}

function d4Find(calls, tool) {
    return calls.filter(function(c) { return c.tool === tool; });
}

var D4_ADO = { customParams: { trackerProvider: 'ado' } };

function d4Wi(id, title, state) {
    return { id: id, fields: { 'System.Title': title, 'System.State': state || 'New' } };
}

suite('wave2d4 tracker — recoverFailedTCBugStatus', function() {
    function load(mocks) {
        return loadModule('js/recoverFailedTCBugStatus.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function() {
                return { jira: { statuses: { DONE: 'Done', BUG_TO_FIX: 'Bug To Fix' } } };
            } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': d4Trackers(mocks)
        }), mocks);
    }
    test('ado: linked open bug -> ado_move_to_state, labels, comment', function() {
        var calls = [];
        var mocks = d4Mocks(calls, { ado_search_by_wiql: function(a) { calls.push({ tool: 'ado_search_by_wiql', args: a }); return [d4Wi(5, 'bug')]; } });
        var r = load(mocks).action({ ticket: { key: '222' }, jobParams: D4_ADO });
        assert.equal(r.action, 'moved_to_bug_to_fix');
        assert.equal(r.linkedBugs, 1);
        assert.deepEqual(d4Find(calls, 'ado_move_to_state')[0].args, { id: '222', state: 'Bug To Fix' });
        assert.equal(d4Find(calls, 'ado_remove_work_item_label').length, 3);
        assert.equal(d4Find(calls, 'ado_add_work_item_comment')[0].args.id, '222');
        assert.contains(d4Find(calls, 'ado_search_by_wiql')[0].args.wiql, 'linkedIssues("222")');
    });
});

suite('wave2d4 tracker — fetchLinkedTestsToInput', function() {
    test('ado: WIQL search + ado_get_work_item for details, writes linked_tests.md', function() {
        var calls = [];
        var written = {};
        var mocks = d4Mocks(calls, {
            ado_search_by_wiql: function(a) { calls.push({ tool: 'ado_search_by_wiql', args: a }); return [d4Wi(7, 'Login test', 'Failed')]; },
            ado_get_work_item: function(a) { calls.push({ tool: 'ado_get_work_item', args: a }); return d4Wi(7, 'Login test', 'Failed'); },
            file_write: function(p, c) { written.path = p; written.content = c; }
        });
        var mod = loadModule('js/fetchLinkedTestsToInput.js', makeRequire({ './common/trackers.js': d4Trackers(mocks) }), mocks);
        mod.action({ inputFolderPath: 'input/12', jobParams: D4_ADO });
        assert.deepEqual(d4Find(calls, 'ado_get_work_item')[0].args, { id: '7' });
        assert.equal(written.path, 'input/12/linked_tests.md');
        assert.contains(written.content, '## 7: Login test');
        assert.contains(written.content, '**Status**: Failed');
    });
});

suite('wave2d4 tracker — redirectToRepoAgent', function() {
    test('ado: fetches ticket via ado_get_work_item and redirects by [repo] tag', function() {
        var calls = [];
        var cmds = [];
        var mocks = d4Mocks(calls, {
            ado_get_work_item: function(a) { calls.push({ tool: 'ado_get_work_item', args: a }); return d4Wi(12, '[my-repo] do it'); },
            cli_execute_command: function(o) { cmds.push(o.command); return ''; }
        });
        var mod = loadModule('js/redirectToRepoAgent.js', makeRequire({ './common/trackers.js': d4Trackers(mocks) }), mocks);
        var r = mod.action({ inputFolderPath: 'input/12', jobParams: Object.assign({ customParams: { trackerProvider: 'ado' } }) });
        assert.equal(r, false);
        assert.deepEqual(d4Find(calls, 'ado_get_work_item')[0].args, { id: '12' });
        assert.equal(cmds.length, 1);
        assert.contains(cmds[0], 'repo-agents/my-repo/story_development.json');
        assert.contains(cmds[0], 'key=12');
    });
});

suite('wave2d4 tracker — triggerBitriseIosBuild', function() {
    test('ado: finds ticket via WIQL search and posts the comment via ado_add_work_item_comment', function() {
        var calls = [];
        var mocks = d4Mocks(calls, {
            ado_search_by_wiql: function(a) { calls.push({ tool: 'ado_search_by_wiql', args: a }); return [d4Wi(5, 'iOS thing')]; },
            bitrise_trigger_build: function() { return { build_number: 3, build_url: 'https://bitrise/b' }; }
        });
        var mod = loadModule('js/triggerBitriseIosBuild.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return {}; }, createScm: function() { return { listPrs: function() { return []; } }; } },
            './common/trackers.js': d4Trackers(mocks)
        }), mocks);
        var r = mod.action({ jobParams: {
            inputJql: 'SELECT [System.Id] FROM WorkItems',
            bitriseBuild: { appSlug: 'app' },
            customParams: { trackerProvider: 'ado' }
        } });
        assert.equal(r.success, true);
        assert.equal(d4Find(calls, 'ado_search_by_wiql')[0].args.wiql, 'SELECT [System.Id] FROM WorkItems');
        var c = d4Find(calls, 'ado_add_work_item_comment');
        assert.equal(c.length, 1);
        assert.equal(c[0].args.id, '5');
        assert.contains(c[0].args.comment, 'iOS Build Triggered');
    });
});

suite('wave2d4 tracker — workflowFailureReporter', function() {
    test('ado: creates bug via ado_create_work_item, labels and links via ado_*', function() {
        var calls = [];
        var mocks = d4Mocks(calls, {
            ado_search_by_wiql: function(a) { calls.push({ tool: 'ado_search_by_wiql', args: a }); return []; },
            ado_create_work_item: function(a) { calls.push({ tool: 'ado_create_work_item', args: a }); return { id: 77 }; }
        });
        var mod = loadModule('js/workflowFailureReporter.js', makeRequire({
            './common/scm.js': { createScm: function() {
                return { listWorkflowRuns: function() {
                    return { workflow_runs: [{ id: 9, name: 'ci : PROJ-1', run_number: 3, html_url: 'u', head_branch: 'main' }] };
                } };
            } },
            './common/trackers.js': d4Trackers(mocks)
        }), mocks);
        var r = mod.action({ jobParams: { customParams: { workspace: 'w', repository: 'r', jiraProject: 'P', trackerProvider: 'ado' } } });
        assert.equal(r.success, true);
        assert.equal(r.created, 1);
        assert.deepEqual(r.createdKeys, ['77']);
        var create = d4Find(calls, 'ado_create_work_item')[0].args;
        assert.equal(create.project, 'P');
        assert.equal(create.workItemType, 'Bug');
        var labels = d4Find(calls, 'ado_add_work_item_label').map(function(c) { return c.args.id + ':' + c.args.label; });
        assert.deepEqual(labels, ['77:ci-run-9', '77:ci-ticket-PROJ-1']);
        assert.deepEqual(d4Find(calls, 'ado_link_work_items')[0].args,
            { sourceId: 'PROJ-1', targetId: '77', relationship: 'is blocked by' });
        assert.equal(d4Find(calls, 'ado_search_by_wiql').length, 2);
    });
});

suite('wave2d4 tracker — createBugFixBatchEpic', function() {
    function load(mocks) {
        return loadModule('js/createBugFixBatchEpic.js', makeRequire({
            './config.js': configModule,
            './common/jiraHelpers.js': loadModule('js/common/jiraHelpers.js', makeRequire({
                '../config.js': configModule, './trackers.js': d4Trackers(mocks)
            }), mocks),
            './configLoader.js': { loadProjectConfig: function() {
                return { jira: { statuses: { BACKLOG: 'Backlog', TODO: 'To Do', READY_FOR_DEVELOPMENT: 'Ready For Development', DONE: 'Done', FAILED: 'Failed', BUG_TO_FIX: 'Bug To Fix' }, issueTypes: { EPIC: 'Epic' } } };
            } },
            './common/trackers.js': d4Trackers(mocks)
        }), mocks);
    }
    test('ado: existing epic -> link/label/move/comments via ado_*, lock released', function() {
        var calls = [];
        var mocks = d4Mocks(calls, { ado_search_by_wiql: function(a) {
            calls.push({ tool: 'ado_search_by_wiql', args: a });
            if (a.wiql.indexOf('issuetype = Bug') !== -1) return [d4Wi(11, 'bug')];
            if (a.wiql.indexOf('"Test Case"') !== -1) return [d4Wi(21, 'tc')];
            return [d4Wi(30, 'epic')];
        } });
        var r = load(mocks).action({ ticket: { key: '10' }, jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_lock' } } });
        assert.equal(r.success, true);
        assert.equal(r.action, 'batch_updated');
        assert.equal(r.epicKey, '30');
        assert.deepEqual(d4Find(calls, 'ado_link_work_items')[0].args, { sourceId: '30', targetId: '11', relationship: 'Relates' });
        assert.deepEqual(d4Find(calls, 'ado_add_work_item_label')[0].args, { id: '11', label: 'bug_fix_batch' });
        assert.deepEqual(d4Find(calls, 'ado_move_to_state')[0].args, { id: '30', state: 'Ready For Development' });
        assert.deepEqual(d4Find(calls, 'ado_add_work_item_comment').map(function(c) { return c.args.id; }), ['30', '10']);
        assert.deepEqual(d4Find(calls, 'ado_remove_work_item_label')[0].args, { id: '10', label: 'sm_lock' });
    });
    test('ado: no candidates -> releases lock via ado_remove_work_item_label', function() {
        var calls = [];
        var mocks = d4Mocks(calls, { ado_search_by_wiql: function() { return []; } });
        var r = load(mocks).action({ ticket: { key: '10' }, jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_lock' } } });
        assert.equal(r.action, 'no_candidates');
        assert.deepEqual(d4Find(calls, 'ado_remove_work_item_label')[0].args, { id: '10', label: 'sm_lock' });
    });
});

suite('wave2d4 tracker — createSolutionDesignTicketsAndAssignForReview', function() {
    test('ado: creates subtask via ado_create_work_item + parent link, assigns for review', function() {
        var calls = [];
        var mocks = d4Mocks(calls, {
            ado_create_work_item: function(a) { calls.push({ tool: 'ado_create_work_item', args: a }); return { id: 101 }; }
        });
        var trackers = d4Trackers(mocks);
        var mod = loadModule('js/createSolutionDesignTicketsAndAssignForReview.js', makeRequire({
            './common/jiraHelpers.js': loadModule('js/common/jiraHelpers.js', makeRequire({
                '../config.js': configModule, './trackers.js': trackers
            }), mocks),
            './config.js': configModule,
            './common/trackers.js': trackers
        }), mocks);
        var r = mod.action({
            ticket: { key: '12', fields: { summary: 'Feature' } },
            initiator: 'user@x.y',
            metadata: { contextId: 'sd' },
            response: { core: true, api: false, ui: false, description: 'analysis' },
            jobParams: D4_ADO
        });
        assert.equal(r.success, true);
        assert.equal(r.createdTickets.length, 1);
        assert.equal(d4Find(calls, 'ado_create_work_item')[0].args.project, '12');
        assert.deepEqual(d4Find(calls, 'ado_link_work_items')[0].args, { sourceId: '101', targetId: '12', relationship: 'parent' });
        assert.deepEqual(d4Find(calls, 'ado_assign_work_item')[0].args.id, '12');
        assert.equal(d4Find(calls, 'ado_move_to_state').length, 1);
        assert.ok(d4Find(calls, 'ado_add_work_item_comment').length >= 1);
    });
});

suite('wave2d4 tracker — postTestReworkResults', function() {
    test('ado: missing result file -> error comment and lock release via ado_*', function() {
        var calls = [];
        var mocks = d4Mocks(calls, { file_read: function() { return null; }, cli_execute_command: function() { return ''; } });
        var mod = loadModule('js/postTestReworkResults.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': {
                loadProjectConfig: function() { return { jira: { statuses: {} }, git: {} }; },
                createScm: function() { return {}; },
                resolveInstructions: function() { return { jobParamPatch: null }; },
                formatTemplate: function() { return ''; }
            },
            './common/autoStart.js': {},
            './common/feedbackLoop.js': {},
            './common/commentMarkup.js': loadModule('js/common/commentMarkup.js',
                makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') })),
            './common/trackers.js': d4Trackers(mocks),
            './common/pullRequest.js': {},
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/mergeState.js': loadModule('js/common/mergeState.js')
        }), mocks);
        var r = mod.action({
            ticket: { key: '42' },
            metadata: { contextId: 'pr_test_automation_rework' },
            jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_rework' } }
        });
        assert.equal(r.success, false);
        var c = d4Find(calls, 'ado_add_work_item_comment');
        assert.equal(c.length, 1);
        assert.equal(c[0].args.id, '42');
        assert.contains(c[0].args.comment, 'Rework Error');
        assert.deepEqual(d4Find(calls, 'ado_remove_work_item_label').map(function(x) { return x.args.label; }),
            ['pr_test_automation_rework_wip', 'sm_rework']);
    });
});

suite('wave2d4 tracker — toIssueView restricted-field Jira payloads', function() {
    test('jira issue with fields:[key,status] (no summary) passes through unchanged', function() {
        var t = d4Trackers({}).createTracker(null, {});
        var raw = { key: 'TS-1', fields: { status: { name: 'Done' } } };
        var v = t.toIssueView(raw);
        assert.equal(v.key, 'TS-1');
        assert.equal(v.fields.status.name, 'Done');
    });
    test('ado work item is still normalized (not passed through)', function() {
        var t = d4Trackers({}).createTracker(null, { trackerProvider: 'ado' });
        var v = t.toIssueView({ id: 5, fields: { 'System.Title': 'x', 'System.State': 'New' } });
        assert.equal(v.key, '5');
        assert.equal(v.fields.summary, 'x');
    });
});
