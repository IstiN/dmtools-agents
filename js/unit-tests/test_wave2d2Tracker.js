/**
 * Wave 2d2 — ADO coverage for scripts migrated to the tracker layer.
 * Each case runs with trackerProvider='ado', mocks ado_* tools and asserts
 * NO jira_* tool was touched.
 */

function w2Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function w2Rec(extra) {
    var calls = [];
    var mocks = {};
    ['get_work_item', 'search_by_wiql', 'add_work_item_comment', 'add_work_item_label', 'remove_work_item_label',
     'move_to_state', 'assign_work_item', 'create_work_item', 'link_work_items', 'update_field', 'attach_file'].forEach(function(n) {
        mocks['ado_' + n] = function(a) { calls.push({ tool: 'ado_' + n, args: a }); return null; };
    });
    ['get_ticket', 'search_by_jql', 'post_comment', 'add_label', 'remove_label', 'move_to_status', 'assign_ticket_to',
     'create_ticket_basic', 'create_ticket_with_parent', 'create_ticket_with_json', 'link_issues', 'update_field',
     'attach_file_to_ticket'].forEach(function(n) {
        mocks['jira_' + n] = function(a) { calls.push({ tool: 'jira_' + n, args: a }); return null; };
    });
    Object.keys(extra || {}).forEach(function(k) {
        var f = extra[k];
        mocks[k] = function(a) { calls.push({ tool: k, args: a }); return f(a); };
    });
    return { calls: calls, mocks: mocks };
}

function w2Tools(calls) { return calls.map(function(c) { return c.tool; }); }
function w2NoJira(calls) {
    assert.equal(w2Tools(calls).filter(function(t) { return t.indexOf('jira_') === 0; }).length, 0);
}
function w2Args(calls, tool) {
    return calls.filter(function(c) { return c.tool === tool; }).map(function(c) { return c.args; });
}
function w2Wi(id, title, state, extra) {
    var fields = { 'System.Title': title, 'System.State': state, 'System.WorkItemType': 'Bug' };
    Object.keys(extra || {}).forEach(function(k) { fields[k] = extra[k]; });
    return { id: id, fields: fields };
}

var W2_ADO = { customParams: { trackerProvider: 'ado' } };

suite('wave2d2 ado — checkStoryTestsPassed', function() {
    test('moves story to Done via ado_move_to_state when all TCs passed', function() {
        var rec = w2Rec({ ado_search_by_wiql: function() { return [w2Wi(11, 'tc1', 'Passed'), w2Wi(12, 'tc2', 'Passed')]; } });
        var mod = loadModule('js/checkStoryTestsPassed.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock({ jira: { issueTypes: { TEST_CASE: 'Test Case', BUG: 'Bug' } } }),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': w2Trackers(rec.mocks)
        }), rec.mocks);
        var r = mod.action({ ticket: { key: '10' }, jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_x' } } });
        assert.equal(r.action, 'moved_to_done');
        assert.deepEqual(w2Args(rec.calls, 'ado_move_to_state'), [{ id: '10', state: 'Done' }]);
        assert.equal(w2Args(rec.calls, 'ado_add_work_item_comment')[0].id, '10');
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — unblockResolvedDependencies', function() {
    test('no blockers: moves to Backlog and comments through ado tools', function() {
        var rec = w2Rec({ ado_get_work_item: function() { return w2Wi(7, 't', 'Blocked'); } });
        var mod = loadModule('js/unblockResolvedDependencies.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': w2Trackers(rec.mocks)
        }), rec.mocks);
        var r = mod.action({ ticket: { key: '7' }, jobParams: W2_ADO });
        assert.equal(r.action, 'moved_to_backlog_no_blockers');
        assert.deepEqual(w2Args(rec.calls, 'ado_move_to_state'), [{ id: '7', state: 'Backlog' }]);
        assert.equal(w2Args(rec.calls, 'ado_add_work_item_comment').length, 1);
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — dfManager', function() {
    test('searches with WIQL and removes stale label via ado tool', function() {
        var rec = w2Rec({ ado_search_by_wiql: function() {
            return [w2Wi(86, 'story', 'In Rework', { 'System.Tags': 'sm_story_rework_triggered', 'System.ChangedDate': '2026-05-09T15:00:00.000Z' })];
        } });
        var scm = { listPrs: function() { return []; }, listWorkflowRuns: function() { return []; },
            triggerWorkflow: function() {}, getRemoteRepoInfo: function() { return { owner: 'o', repo: 'r' }; } };
        var df = loadModule('js/dfManager.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return { repository: { owner: 'o', repo: 'r' }, jira: { project: 'TS' } }; } },
            './common/scm.js': { createScm: function() { return scm; } },
            './common/trackers.js': w2Trackers(rec.mocks)
        }), Object.assign({ file_read: function() { return null; }, file_write: function() {}, cli_execute_command: function() { return ''; } }, rec.mocks));
        df.action({ jobParams: { customParams: { trackerProvider: 'ado', autoRecover: true,
            nowMs: Date.parse('2026-05-09T17:00:00.000Z'), staleMinutes: 45 } } });
        var searches = w2Args(rec.calls, 'ado_search_by_wiql');
        assert.equal(searches.length, 1);
        assert.contains(searches[0].wiql, 'project = TS');
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — fetchEpicsToInput', function() {
    test('reads epics/stories via ado_search_by_wiql + ado_get_work_item by id', function() {
        var writes = {};
        var rec = w2Rec({
            ado_search_by_wiql: function() { return [w2Wi(5, 'Epic five', 'New')]; },
            ado_get_work_item: function(a) { return w2Wi(Number(a.id), 'Item ' + a.id, 'New'); }
        });
        var mod = loadModule('js/fetchEpicsToInput.js', makeRequire({ './common/trackers.js': w2Trackers(rec.mocks) }),
            Object.assign({ file_write: function(p, c) { writes[p] = c; } }, rec.mocks));
        mod.action({ inputFolderPath: 'input/TS-1', jobParams: W2_ADO });
        assert.deepEqual(w2Args(rec.calls, 'ado_get_work_item').map(function(a) { return a.id; }), ['5', '5']);
        var epics = JSON.parse(writes['input/TS-1/existing_epics.json']).epics;
        assert.equal(epics.length, 1);
        assert.equal(epics[0].key, '5');
        assert.equal(epics[0].summary, 'Item 5');
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — prepareBugCreationContext', function() {
    test('fetches TC + bugs via ado tools and comments via ado', function() {
        var writes = [];
        var rec = w2Rec({
            ado_get_work_item: function(a) { return w2Wi(Number(a.id), 'TC title', 'Ready', { 'System.Description': 'tc desc' }); },
            ado_search_by_wiql: function() { return [w2Wi(900, 'Existing bug', 'Active', { 'System.Description': 'bug desc' })]; }
        });
        var mod = loadModule('js/prepareBugCreationContext.js', makeRequire({ './common/trackers.js': w2Trackers(rec.mocks) }),
            Object.assign({ file_write: function(p, c) { writes.push({ path: p, content: c }); } }, rec.mocks));
        var r = mod.action({ inputFolderPath: 'input/614', customParams: { trackerProvider: 'ado', openBugsJql: 'SELECT [System.Id] FROM WorkItems' } });
        assert.equal(r.success, true);
        var ticketMd = writes.filter(function(w) { return w.path === 'input/614/ticket.md'; })[0];
        assert.contains(ticketMd.content, 'TC title');
        assert.equal(writes.filter(function(w) { return w.path.indexOf('Bug 900') !== -1; }).length, 1);
        assert.equal(w2Args(rec.calls, 'ado_add_work_item_comment')[0].id, '614');
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — createRepoTasks', function() {
    test('creates sub-tasks through ado_create_work_item, links to parent by id', function() {
        var n = 0;
        var desc = 'x\n\n{code:json|title=affected_repos}\n[{"name":"core"}]\n{code}\n';
        var rec = w2Rec({
            ado_get_work_item: function(a) {
                if (a.id === '100') return { id: 100, fields: { 'System.Title': 'SA', 'System.State': 'New', 'System.Description': desc, 'System.Parent': 50 } };
                return w2Wi(Number(a.id), 'Parent story', 'New');
            },
            ado_search_by_wiql: function() { return []; },
            ado_create_work_item: function() { n++; return { id: 200 + n }; }
        });
        var mod = loadModule('js/createRepoTasks.js', makeRequire({ './config.js': configModule, './common/trackers.js': w2Trackers(rec.mocks) }),
            Object.assign({ java: { lang: { System: { getenv: function() { return ''; } } } } }, rec.mocks));
        var r = mod.action({ ticket: { key: '100' }, customParams: { trackerProvider: 'ado' } });
        assert.equal(r.success, true);
        var created = w2Args(rec.calls, 'ado_create_work_item');
        assert.equal(created.length, 1);
        assert.equal(created[0].workItemType, 'Sub-task');
        assert.equal(w2Args(rec.calls, 'ado_link_work_items')[0].targetId, '50');
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — createQuestionsAndAssignForReview', function() {
    test('no-questions path comments, labels and moves via ado tools', function() {
        var rec = w2Rec({});
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), { file_read: function() { return null; } });
        var mod = loadModule('js/createQuestionsAndAssignForReview.js', makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function() { return null; } },
            './common/aiResponseParser.js': { buildSummary: function(s) { return s; } },
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/outputFiles.js': outputFiles,
            './common/trackers.js': w2Trackers(rec.mocks)
        }), Object.assign({ file_read: function() { return null; } }, rec.mocks));
        var r = mod.action({ ticket: { key: '829' }, metadata: { contextId: 'story_questions' }, initiator: 'a@b.c', jobParams: W2_ADO });
        assert.equal(r.success, true);
        var tools = w2Tools(rec.calls);
        assert.ok(tools.indexOf('ado_add_work_item_comment') !== -1, 'comment via ado');
        assert.ok(tools.indexOf('ado_add_work_item_label') !== -1, 'label via ado');
        assert.deepEqual(w2Args(rec.calls, 'ado_assign_work_item')[0], { id: '829', userEmail: 'a@b.c' });
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — postBulkBugsCreation', function() {
    test('creates bug through ado_create_work_item and links to TC by id', function() {
        var rec = w2Rec({
            ado_create_work_item: function() { return { id: 7000 }; },
            ado_search_by_wiql: function() { return []; },
            ado_get_work_item: function(a) { return w2Wi(Number(a.id), 'tc', 'Failed'); },
            ado_attach_file: function() { return null; },
            file_read: function(o) {
                if (o.path === 'outputs/bulk_bug_decisions.json') {
                    return JSON.stringify({ processed: ['700'], newBugs: [{ summary: 'B', description: 'D', linkedTCs: ['700'] }], links: [], skipped: [] });
                }
                return null;
            }
        });
        var cfgLoader = loadModule('js/configLoader.js', makeRequire({ './config.js': configModule, './common/scm.js': { createScm: function() { return {}; } } }), { file_read: function() { return null; } });
        var mod = loadModule('js/postBulkBugsCreation.js', makeRequire({
            './config.js': configModule, './configLoader.js': cfgLoader,
            './common/feedbackLoop.js': { resumeAgent: function() { return { attempted: false }; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': w2Trackers(rec.mocks)
        }), Object.assign({}, rec.mocks, { file_read: rec.mocks.file_read }));
        var r = mod.action({ jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_a', smTriggerLabel: 'sm_b' } } });
        assert.equal(r.success, true);
        assert.equal(w2Args(rec.calls, 'ado_create_work_item')[0].workItemType, 'Bug');
        var link = w2Args(rec.calls, 'ado_link_work_items')[0];
        assert.equal(link.sourceId, '700');
        assert.equal(link.targetId, '7000');
        assert.equal(w2Args(rec.calls, 'ado_move_to_state')[0].id, '700');
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — postStoryTestAutomationResults', function() {
    test('blocked_by_human moves story to Blocked via ado_move_to_state', function() {
        var rec = w2Rec({
            file_read: function(o) {
                if (o.path === 'outputs/story_test_automation_result.json') {
                    return JSON.stringify({ storyKey: '90', overall: 'blocked_by_human', summary: 's', blockedReason: 'r', results: [] });
                }
                return null;
            },
            ado_search_by_wiql: function() { return []; },
            cli_execute_command: function() { return ''; },
            file_write: function() {}
        });
        var cfgLoader = loadModule('js/configLoader.js', makeRequire({ './config.js': configModule, './common/scm.js': { createScm: function() { return {}; } } }), { file_read: function() { return null; } });
        var outputFiles = loadModule('js/common/outputFiles.js', makeRequire({}), rec.mocks);
        var prHelper = loadModule('js/common/pullRequest.js', makeRequire({
            './mergeState.js': loadModule('js/common/mergeState.js'), './common/mergeState.js': loadModule('js/common/mergeState.js')
        }), rec.mocks);
        var mod = loadModule('js/postStoryTestAutomationResults.js', makeRequire({
            './configLoader.js': cfgLoader, './config.js': configModule, './common/pullRequest.js': prHelper,
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; }, triggerSmIfIdle: function() { return { success: true }; } },
            './common/outputFiles.js': outputFiles,
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
            './common/trackers.js': w2Trackers(rec.mocks)
        }), rec.mocks);
        var r = mod.action({ ticket: { key: '90', fields: { summary: 'S' } }, jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_t' } } });
        assert.equal(r.status, 'blocked_by_human', JSON.stringify(r));
        assert.deepEqual(w2Args(rec.calls, 'ado_move_to_state'), [{ id: '90', state: 'Blocked' }]);
        assert.equal(w2Args(rec.calls, 'ado_add_work_item_comment').length, 1);
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — prepareBugFixBatchContext', function() {
    test('findBugsInEpic searches via WIQL; action moves epic through ado', function() {
        var rec = w2Rec({
            ado_search_by_wiql: function() { return [w2Wi(31, 'bug', 'Active', { 'System.WorkItemType': 'Bug' })]; },
            ado_get_work_item: function(a) { return w2Wi(Number(a.id), 'Epic', 'New', { 'System.WorkItemType': 'Epic' }); }
        });
        var stub = { action: function() {} };
        var mod = loadModule('js/prepareBugFixBatchContext.js', makeRequire({
            './config.js': configModule,
            './configLoader.js': makeDefaultConfigLoaderMock(),
            './fetchQuestionsToInput.js': stub, './fetchLinkedTestsToInput.js': stub,
            './common/trackers.js': w2Trackers(rec.mocks)
        }), Object.assign({ file_write: function() {}, cli_execute_command: function() { return ''; } }, rec.mocks));
        mod.action({ inputFolderPath: 'input/20', customParams: { trackerProvider: 'ado' } });
        assert.equal(w2Args(rec.calls, 'ado_search_by_wiql').length, 1);
        assert.equal(w2Args(rec.calls, 'ado_move_to_state')[0].id, '20');
        w2NoJira(rec.calls);
    });
});

suite('wave2d2 ado — fetchQuestionsToInput', function() {
    test('ado provider skips the Jira-speak question query without any jira_* call', function() {
        var rec = w2Rec({});
        var mod = loadModule('js/fetchQuestionsToInput.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function() { return { jira: { questions: { fetchJql: 'parent = {ticketKey}', answerField: 'Answer' } } }; } },
            './common/trackers.js': w2Trackers(rec.mocks),
            './fetchParentContextToInput.js': { action: function() {} }
        }), Object.assign({ file_write: function() {} }, rec.mocks));
        mod.action({ inputFolderPath: 'input/20', jobParams: W2_ADO });
        assert.equal(w2Args(rec.calls, 'ado_search_by_wiql').length, 0);
        w2NoJira(rec.calls);
    });
});
