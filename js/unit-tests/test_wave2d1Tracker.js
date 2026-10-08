/**
 * Tracker-layer tests (wave 2d1): ADO coverage for postBugCreation, checkBugTestsPassed,
 * checkBugToFixReady, createRepoTasksMulti, fetchLinkedBugsToInput, prepareBulkBugsCreationContext,
 * preCliMobileTestAutomationSetup, preCliStoryTestAutomationSetup, writeSolutionAndLabels,
 * fetchParentContextToInput, triggerBitriseTestAutomation.
 * Each runs with customParams.trackerProvider='ado' and must touch ado_* tools only.
 */

function d1Recorder(extra) {
    var calls = [];
    var mocks = {};
    ['jira_get_ticket', 'jira_search_by_jql', 'jira_post_comment', 'jira_add_label', 'jira_remove_label',
     'jira_move_to_status', 'jira_link_issues', 'jira_update_field', 'jira_create_ticket_basic',
     'jira_create_ticket_with_parent', 'jira_get_field_custom_code',
     'ado_get_work_item', 'ado_search_by_wiql', 'ado_add_work_item_comment', 'ado_add_work_item_label',
     'ado_remove_work_item_label', 'ado_move_to_state', 'ado_link_work_items', 'ado_create_work_item',
     'ado_update_description', 'ado_update_tags', 'ado_update_field'].forEach(function(n) {
        mocks[n] = function(a) { calls.push({ tool: n, args: a }); return null; };
    });
    Object.keys(extra || {}).forEach(function(n) {
        mocks[n] = function(a) { calls.push({ tool: n, args: a }); return extra[n](a); };
    });
    return { calls: calls, mocks: mocks };
}
function d1Tools(calls) { return calls.map(function(c) { return c.tool; }); }
function d1NoJira(calls) {
    assert.equal(d1Tools(calls).filter(function(t) { return t.indexOf('jira_') === 0; }).length, 0, 'no jira_* tool used');
}
function d1Calls(calls, tool) { return calls.filter(function(c) { return c.tool === tool; }); }
function d1Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}
function d1Item(id, title, state, type, extra) {
    return { id: id, fields: Object.assign({ 'System.Title': title, 'System.State': state, 'System.WorkItemType': type || 'Task' }, extra || {}) };
}
var D1_ADO = { trackerProvider: 'ado' };

suite('wave2d1 tracker — postBugCreation', function() {
    function load(rec, decision) {
        var mocks = Object.assign({ file_read: function(o) { return o.path === 'outputs/bug_decision.json' ? JSON.stringify(decision) : null; } }, rec.mocks);
        return loadModule('js/postBugCreation.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': d1Trackers(mocks)
        }), mocks);
    }
    test('ado: link decision links work items and moves TC via ado_*', function() {
        var rec = d1Recorder();
        var r = load(rec, { action: 'link', existingKey: '55', reason: 'dup' }).action({
            ticket: { key: '12' }, metadata: { contextId: 'bug_creation' }, jobParams: { customParams: D1_ADO }
        });
        assert.equal(r.success, true);
        assert.deepEqual(d1Calls(rec.calls, 'ado_link_work_items')[0].args, { sourceId: '12', targetId: '55', relationship: 'Blocks' });
        assert.equal(d1Calls(rec.calls, 'ado_move_to_state').length >= 1, true);
        assert.equal(d1Calls(rec.calls, 'ado_add_work_item_comment')[0].args.id, '12');
        d1NoJira(rec.calls);
    });
    test('ado: create decision creates a Bug work item and links it', function() {
        var rec = d1Recorder({ ado_create_work_item: function() { return { id: 77 }; } });
        var r = load(rec, { action: 'create', summary: 'Broken', descriptionText: 'desc' }).action({
            ticket: { key: '12' }, metadata: { contextId: 'bug_creation' }, jobParams: { customParams: D1_ADO }
        });
        assert.equal(r.success, true);
        assert.equal(r.bugKey, '77');
        var cw = d1Calls(rec.calls, 'ado_create_work_item')[0].args;
        assert.equal(cw.workItemType, 'Bug');
        assert.equal(cw.title, 'Broken');
        assert.deepEqual(d1Calls(rec.calls, 'ado_link_work_items')[0].args, { sourceId: '12', targetId: '77', relationship: 'Blocks' });
        d1NoJira(rec.calls);
    });
});

suite('wave2d1 tracker — checkBugTestsPassed / checkBugToFixReady', function() {
    test('ado: checkBugTestsPassed reads via ado_get_work_item/wiql and releases the lock via ado_*', function() {
        var rec = d1Recorder({
            ado_get_work_item: function() { return d1Item(10, 'Bug', 'In Testing', 'Bug'); },
            ado_search_by_wiql: function() { return { value: [] }; }
        });
        var mod = loadModule('js/checkBugTestsPassed.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': d1Trackers(rec.mocks),
            './common/scm.js': { createScm: function() { return { listPrs: function() { return []; } }; } }
        }), rec.mocks);
        var r = mod.action({ ticket: { key: '10' }, jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_x' } } });
        assert.equal(r.action, 'no_test_cases');
        assert.deepEqual(d1Calls(rec.calls, 'ado_get_work_item')[0].args, { id: '10' });
        assert.equal(d1Calls(rec.calls, 'ado_search_by_wiql').length, 1);
        assert.deepEqual(d1Calls(rec.calls, 'ado_remove_work_item_label')[0].args, { id: '10', label: 'sm_x' });
        d1NoJira(rec.calls);
    });
    test('ado: checkBugToFixReady moves a Test Case via ado_move_to_state when all bugs are Done', function() {
        var rec = d1Recorder({
            ado_search_by_wiql: function(a) {
                if (a.wiql.indexOf('status != "Done"') !== -1) return { value: [] };
                return { value: [d1Item(91, 'b', 'Done', 'Bug')] };
            }
        });
        var mod = loadModule('js/checkBugToFixReady.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': d1Trackers(rec.mocks)
        }), rec.mocks);
        var r = mod.action({
            ticket: { key: '90', fields: { summary: 's', issuetype: { name: 'Test Case' } } },
            jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_y' } }
        });
        assert.equal(r.action, 'moved_to_backlog');
        assert.equal(d1Calls(rec.calls, 'ado_move_to_state')[0].args.id, '90');
        assert.deepEqual(d1Calls(rec.calls, 'ado_remove_work_item_label').map(function(c) { return c.args.label; }), ['sm_test_automation_triggered', 'sm_y']);
        d1NoJira(rec.calls);
    });
});

suite('wave2d1 tracker — createRepoTasksMulti', function() {
    test('ado: reads SA + parent, creates sub-task with parent link and labels via ado_*', function() {
        var desc = 'Sol\n\n{code:json|title=affected_repos}\n[{"name":"repo-a","reason":"r"}]\n{code}\n\n----';
        var rec = d1Recorder({
            ado_get_work_item: function(a) {
                if (a.id === '100') return d1Item(100, 'SA', 'Active', 'Task', { 'System.Description': desc, 'System.Parent': 50 });
                return d1Item(50, 'Parent story', 'Active', 'User Story');
            },
            ado_search_by_wiql: function() { return { value: [] }; },
            ado_create_work_item: function() { return { id: 201 }; }
        });
        var mod = loadModule('js/createRepoTasksMulti.js', makeRequire({
            './config.js': configModule,
            './common/trackers.js': d1Trackers(rec.mocks)
        }), Object.assign({ java: { lang: { System: { getenv: function() { return ''; } } } } }, rec.mocks));
        var r = mod.action({ ticket: { key: '100' }, jobParams: { customParams: { trackerProvider: 'ado', labels: ['development'] } } });
        assert.equal(r.success, true);
        assert.equal(r.created, 1);
        var cw = d1Calls(rec.calls, 'ado_create_work_item')[0].args;
        assert.contains(cw.title, '[repo-a]');
        assert.equal(cw.workItemType, 'Sub-task');
        assert.deepEqual(d1Calls(rec.calls, 'ado_link_work_items')[0].args, { sourceId: '201', targetId: '50', relationship: 'parent' });
        assert.deepEqual(d1Calls(rec.calls, 'ado_add_work_item_label')[0].args, { id: '201', label: 'development' });
        assert.equal(d1Calls(rec.calls, 'ado_add_work_item_comment')[0].args.id, '100');
        d1NoJira(rec.calls);
    });
});

suite('wave2d1 tracker — fetchLinkedBugsToInput / prepareBulkBugsCreationContext', function() {
    test('ado: fetchLinkedBugsToInput searches by WIQL and reads details via ado_get_work_item', function() {
        var rec = d1Recorder({
            ado_search_by_wiql: function() { return { value: [d1Item(31, 'Bug one', 'Active', 'Bug', { 'System.Description': 'dd' })] }; },
            ado_get_work_item: function() { return d1Item(31, 'Bug one', 'Active', 'Bug'); }
        });
        var written = {};
        var mocks = Object.assign({ file_write: function(p, c) { written[p] = c; } }, rec.mocks);
        var mod = loadModule('js/fetchLinkedBugsToInput.js', makeRequire({ './common/trackers.js': d1Trackers(mocks) }), mocks);
        mod.action({ inputFolderPath: 'input/30', customParams: D1_ADO });
        var md = written['input/30/linked_bugs.md'];
        assert.contains(md, '## 31: Bug one');
        assert.contains(md, '**Status**: Active');
        assert.equal(d1Calls(rec.calls, 'ado_search_by_wiql').length, 1);
        assert.deepEqual(d1Calls(rec.calls, 'ado_get_work_item')[0].args, { id: '31' });
        d1NoJira(rec.calls);
    });
    test('ado: prepareBulkBugsCreationContext runs both queries as WIQL', function() {
        var rec = d1Recorder({
            ado_search_by_wiql: function(a) {
                if (a.wiql === 'FAILED') return { value: [d1Item(5, 'tc', 'Failed', 'Test Case')] };
                if (a.wiql === 'OPEN') return { value: [d1Item(6, 'open bug', 'Active', 'Bug')] };
                return { value: [] };
            }
        });
        var written = {};
        var mocks = Object.assign({ file_write: function(p, c) { written[p] = c; } }, rec.mocks);
        var mod = loadModule('js/prepareBulkBugsCreationContext.js', makeRequire({
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './config.js': configModule,
            './common/trackers.js': d1Trackers(mocks)
        }), mocks);
        mod.action({ inputFolderPath: 'input/X', customParams: { trackerProvider: 'ado', failedTCsJql: 'FAILED', openBugsJql: 'OPEN' } });
        var bugs = JSON.parse(written['input/X/open_bugs.json']);
        assert.equal(bugs[0].key, '6');
        assert.equal(bugs[0].status, 'Active');
        var tcs = JSON.parse(written['input/X/failed_tcs.json']);
        assert.equal(tcs[0].key, '5');
        d1NoJira(rec.calls);
    });
});

suite('wave2d1 tracker — preCli setups / writeSolutionAndLabels', function() {
    test('ado: preCliMobileTestAutomationSetup moves state and searches linked TCs via ado_*', function() {
        var rec = d1Recorder({
            ado_search_by_wiql: function() { return { value: [d1Item(8, 'TC', 'Ready', 'Test Case')] }; },
            ado_get_work_item: function() { return d1Item(8, 'TC', 'Ready', 'Test Case'); }
        });
        var written = {};
        var mocks = Object.assign({
            file_write: function(p, c) { written[p] = c; },
            file_read: function() { return null; },
            cli_execute_command: function() { return ''; }
        }, rec.mocks);
        var mod = loadModule('js/preCliMobileTestAutomationSetup.js', makeRequire({
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './config.js': configModule,
            './common/mergeState.js': loadModule('js/common/mergeState.js'),
            './mergeState.js': loadModule('js/common/mergeState.js'),
            './common/pullRequest.js': {},
            './common/trackers.js': d1Trackers(mocks)
        }), mocks);
        mod.action({ inputFolderPath: 'input/9', jobParams: { customParams: D1_ADO } });
        assert.equal(d1Calls(rec.calls, 'ado_move_to_state')[0].args.id, '9');
        assert.equal(d1Calls(rec.calls, 'ado_search_by_wiql').length >= 1, true);
        assert.contains(written['input/9/linked_test_cases.md'], '## 8: TC');
        d1NoJira(rec.calls);
    });
    test('ado: preCliStoryTestAutomationSetup fetches linked Test Cases via WIQL', function() {
        var rec = d1Recorder({
            ado_search_by_wiql: function() { return { value: [d1Item(21, 'TC one', 'Ready', 'Test Case')] }; }
        });
        var written = {};
        var mocks = Object.assign({
            file_write: function(a) { written[a.path] = a.content; },
            file_read: function() { return null; },
            cli_execute_command: function() { return ''; }
        }, rec.mocks);
        var mod = loadModule('js/preCliStoryTestAutomationSetup.js', makeRequire({
            './config.js': configModule,
            './common/trackers.js': d1Trackers(mocks),
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/pullRequest.js': { buildTargetedOriginFetchCommand: function() { return null; }, buildOriginFetchCommand: function() { return null; } },
            './common/githubHelpers.js': {},
            './common/scm.js': { createScm: function() { return { listPrs: function() { return []; } }; } }
        }), mocks);
        mod.action({ inputFolderPath: 'input/20', jobParams: { customParams: D1_ADO } });
        var q = d1Calls(rec.calls, 'ado_search_by_wiql')[0].args.wiql;
        assert.contains(q, 'linkedIssues("20")');
        assert.contains(written['input/20/linked_test_cases.md'], '21');
        assert.equal(JSON.parse(written['input/20/linked_test_cases.json']).testCases[0].key, '21');
        d1NoJira(rec.calls);
    });
    test('ado: writeSolutionAndLabels labels via ado_add_work_item_label and updates the field via ado_update_field', function() {
        var rec = d1Recorder({
            ado_get_work_item: function() { return d1Item(40, 'T', 'Active', 'Task', { 'System.Description': 'base' }); },
            ado_update_field: function() { return null; }
        });
        var files = { 'outputs/response.md': 'Solution', 'outputs/affected_repos.json': '[{"name":"repo-a"}]' };
        var mocks = Object.assign({ file_read: function(o) { var p = o && (o.path || o); return files[p] !== undefined ? files[p] : null; } }, rec.mocks);
        var mod = loadModule('js/writeSolutionAndLabels.js', makeRequire({
            './writeSolutionAndDiagrams.js': { action: function() { return { success: true }; } },
            './common/outputFiles.js': loadModule('js/common/outputFiles.js', makeRequire({}), mocks),
            './config.js': configModule,
            './common/trackers.js': d1Trackers(mocks)
        }), mocks);
        var r = mod.action({ ticket: { key: '40' }, customParams: { trackerProvider: 'ado', solutionField: 'description' } });
        assert.equal(r.success, true);
        assert.deepEqual(d1Calls(rec.calls, 'ado_add_work_item_label')[0].args, { id: '40', label: 'repo-a' });
        assert.equal(d1Calls(rec.calls, 'ado_update_description')[0].args.id, '40');
        d1NoJira(rec.calls);
    });
});

suite('wave2d1 tracker — fetchParentContextToInput', function() {
    test('ado: parent, siblings and child questions read via ado_* tools', function() {
        var rec = d1Recorder({
            ado_get_work_item: function(a) {
                if (a.id === '50') return d1Item(50, 'Parent story', 'Active', 'User Story', { 'System.Description': 'pdesc' });
                return d1Item(a.id, 'x', 'Active', 'Task');
            },
            ado_search_by_wiql: function(a) {
                if (a.wiql.indexOf('PARENT-50') !== -1) return { value: [d1Item(61, '[BA] Analysis', 'Done', 'Task', { 'System.Description': 'ba text' })] };
                return { value: [] };
            }
        });
        var written = {};
        var mocks = Object.assign({ file_write: function(p, c) { written[p] = c; } }, rec.mocks);
        var mod = loadModule('js/fetchParentContextToInput.js', makeRequire({ './common/trackers.js': d1Trackers(mocks) }), mocks);
        mod.action({
            inputFolderPath: 'input/51',
            ticket: { key: '51', fields: { parent: { key: '50' }, summary: 's', status: { name: 'New' } } },
            jobParams: { customParams: { trackerProvider: 'ado', parentContextFetch: {
                jql: 'PARENT-{parentKey}', fields: ['key', 'summary', 'description', 'status'],
                contexts: [{ prefix: '[BA]', file: 'ba.md', label: 'Business Analysis' }]
            } } }
        });
        assert.equal(d1Calls(rec.calls, 'ado_get_work_item')[0].args.id, '50');
        assert.equal(d1Calls(rec.calls, 'ado_search_by_wiql')[0].args.wiql, 'PARENT-50');
        assert.contains(written['input/51/ba.md'], 'Business Analysis — [BA] Analysis');
        assert.contains(written['input/51/ba.md'], 'ba text');
        d1NoJira(rec.calls);
    });
    test('jira: resolveFieldNames uses jira_get_field_custom_code through the tracker', function() {
        var seen = [];
        var rec = d1Recorder({
            jira_get_field_custom_code: function(a) { seen.push(a); return 'customfield_100'; },
            jira_get_ticket: function() { return { key: 'P-50', fields: { summary: 'Par', status: { name: 'Open' }, customfield_100: 'cf value' } }; },
            jira_search_by_jql: function() { return []; }
        });
        var written = {};
        var mocks = Object.assign({ file_write: function(p, c) { written[p] = c; } }, rec.mocks);
        var mod = loadModule('js/fetchParentContextToInput.js', makeRequire({ './common/trackers.js': d1Trackers(mocks) }), mocks);
        mod.action({
            inputFolderPath: 'input/P-51',
            ticket: { key: 'P-51', fields: { parent: { key: 'P-50' }, summary: 's' } },
            jobParams: { customParams: { parentContextFetch: {
                resolveFieldNames: true, parentFields: ['summary', 'My Field'], jql: 'parent = {parentKey}',
                contexts: [{ prefix: '[BA]', file: 'ba.md', label: 'BA' }]
            } } }
        });
        assert.deepEqual(seen[0], { project: 'P', fieldName: 'My Field' });
        assert.deepEqual(d1Calls(rec.calls, 'jira_get_ticket')[0].args.fields.indexOf('customfield_100') !== -1, true);
    });
});

suite('wave2d1 tracker — triggerBitriseTestAutomation', function() {
    test('ado: comment, state move and label removal via ado_*', function() {
        var rec = d1Recorder();
        var mocks = Object.assign({
            bitrise_list_builds: function() { return { data: [] }; },
            bitrise_trigger_build: function() { return { build_url: 'http://b', build_number: 3 }; }
        }, rec.mocks);
        var mod = loadModule('js/triggerBitriseTestAutomation.js', makeRequire({
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './config.js': configModule,
            './common/trackers.js': d1Trackers(mocks)
        }), mocks);
        var r = mod.action({
            ticket: { key: '15', fields: { summary: 's' } },
            metadata: { contextId: 'ios' },
            jobParams: { customParams: { trackerProvider: 'ado', bitriseBuild: { appSlug: 'app' }, removeLabel: 'sm_t' } }
        });
        assert.equal(r.success, true);
        assert.equal(d1Calls(rec.calls, 'ado_add_work_item_comment')[0].args.id, '15');
        assert.equal(d1Calls(rec.calls, 'ado_move_to_state')[0].args.id, '15');
        assert.deepEqual(d1Calls(rec.calls, 'ado_remove_work_item_label').map(function(c) { return c.args.label; }), ['sm_t', 'ios_wip']);
        d1NoJira(rec.calls);
    });
});
