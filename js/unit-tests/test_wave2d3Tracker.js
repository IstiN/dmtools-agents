/**
 * Tracker-layer tests (wave 2d3): createIntakeTickets, intakePreAction,
 * preCliTestReworkSetup, checkTaskStoriesDone — jira (jira_* tools) and ado
 * (ado_* tools, proving NO jira_* tool is touched).
 */

function d3Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function d3Boom(name) {
    return function() { throw new Error(name + ' must not be called'); };
}

// ── checkTaskStoriesDone ─────────────────────────────────────────────────────

function d3LoadCheckTask(mocks) {
    return loadModule('js/checkTaskStoriesDone.js', makeRequire({
        './configLoader.js': { loadProjectConfig: function() { return { jira: { statuses: { DONE: 'Done', READY_FOR_TESTING: 'Ready For Testing' } } }; } },
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/trackers.js': d3Trackers(mocks)
    }), mocks);
}

suite('checkTaskStoriesDone: tracker layer', function() {
    test('jira: all linked Done -> jira_move_to_status + jira_post_comment', function() {
        var calls = [];
        var n = 0;
        var mod = d3LoadCheckTask({
            jira_search_by_jql: function(a) { n++; calls.push(['search', a]); return n === 1 ? [{ key: 'S-1' }, { key: 'S-2' }] : []; },
            jira_move_to_status: function(a) { calls.push(['move', a]); },
            jira_post_comment: function(a) { calls.push(['comment', a]); }
        });
        var r = mod.action({ ticket: { key: 'T-1' }, jobParams: { customParams: {} } });
        assert.equal(r.action, 'moved_to_ready_for_testing');
        assert.equal(r.total, 2);
        assert.deepEqual(calls[0][1], { jql: 'issue in linkedIssues("T-1") AND issuetype in (Story, Bug)', maxResults: 100 });
        assert.deepEqual(calls[2], ['move', { key: 'T-1', statusName: 'Ready For Testing' }]);
    });

    test('ado: no linked items -> ado_search_by_wiql then ado_remove_work_item_label, no jira_*', function() {
        var calls = [];
        var mod = d3LoadCheckTask({
            ado_search_by_wiql: function(a) { calls.push(['search', a]); return { value: [] }; },
            ado_remove_work_item_label: function(a) { calls.push(['rm', a]); },
            jira_search_by_jql: d3Boom('jira_search_by_jql'),
            jira_remove_label: d3Boom('jira_remove_label')
        });
        var r = mod.action({ ticket: { key: '90' }, jobParams: { customParams: { trackerProvider: 'ado', removeLabel: 'sm_x' } } });
        assert.equal(r.action, 'no_stories');
        assert.equal(calls[0][0], 'search');
        assert.deepEqual(calls[1], ['rm', { id: '90', label: 'sm_x' }]);
    });

    test('ado: all Done -> ado_move_to_state + ado_add_work_item_comment', function() {
        var calls = [];
        var n = 0;
        var mod = d3LoadCheckTask({
            ado_search_by_wiql: function() { n++; return { value: n === 1 ? [{ id: 1, fields: { 'System.Title': 'S', 'System.State': 'Done' } }] : [] }; },
            ado_move_to_state: function(a) { calls.push(['move', a]); },
            ado_add_work_item_comment: function(a) { calls.push(['comment', a]); },
            jira_move_to_status: d3Boom('jira_move_to_status'),
            jira_post_comment: d3Boom('jira_post_comment')
        });
        var r = mod.action({ ticket: { key: '90' }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(r.action, 'moved_to_ready_for_testing');
        assert.deepEqual(calls[0], ['move', { id: '90', state: 'Ready For Testing' }]);
        assert.equal(calls[1][1].id, '90');
    });
});

// ── intakePreAction ──────────────────────────────────────────────────────────

function d3LoadIntakePre(mocks) {
    return loadModule('js/intakePreAction.js', makeRequire({
        './common/trackers.js': d3Trackers(mocks)
    }), mocks);
}

suite('intakePreAction: tracker layer', function() {
    test('jira: writes epics and stories files from jira_search_by_jql', function() {
        var writes = {};
        var jqls = [];
        var mod = d3LoadIntakePre({
            file_write: function(p, c) { writes[p] = c; },
            jira_search_by_jql: function(a) {
                jqls.push(a);
                return [{ key: 'P-1', fields: { summary: 'E', status: { name: 'Open' } } }];
            }
        });
        var r = mod.action({ ticket: { key: 'P-9', fields: { labels: [] } }, metadata: {} });
        assert.equal(r, true);
        assert.equal(jqls.length, 2);
        assert.equal(jqls[0].jql, 'project = P AND issuetype = Epic ORDER BY created DESC');
        assert.equal(JSON.parse(writes['input/P-9/existing_epics.json']).epics[0].key, 'P-1');
        assert.equal(JSON.parse(writes['input/P-9/existing_stories.json']).stories[0].status, 'Open');
    });

    test('ado: WIP label -> ado_add_work_item_comment, no jira_*', function() {
        var comments = [];
        var mod = d3LoadIntakePre({
            ado_add_work_item_comment: function(a) { comments.push(a); },
            jira_post_comment: d3Boom('jira_post_comment')
        });
        var r = mod.action({
            ticket: { key: '12', fields: { labels: ['intake_wip'] } },
            metadata: { contextId: 'intake' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(r, false);
        assert.equal(comments.length, 1);
        assert.equal(comments[0].id, '12');
    });

    test('ado: epics/stories fetched through ado_search_by_wiql with Jira-shaped readers', function() {
        var writes = {};
        var wiqls = [];
        var mod = d3LoadIntakePre({
            file_write: function(p, c) { writes[p] = c; },
            ado_search_by_wiql: function(a) {
                wiqls.push(a);
                return { value: [{ id: 5, fields: { 'System.Title': 'Epic five', 'System.State': 'New', 'System.WorkItemType': 'Epic' } }] };
            },
            jira_search_by_jql: d3Boom('jira_search_by_jql')
        });
        var r = mod.action({ ticket: { key: 'proj-1', fields: {} }, jobParams: { customParams: { trackerProvider: 'ado' } } });
        assert.equal(r, true);
        assert.equal(wiqls.length, 2);
        var epics = JSON.parse(writes['input/proj-1/existing_epics.json']).epics;
        assert.equal(epics.length, 1);
        assert.equal(epics[0].summary, 'Epic five');
    });
});

// ── createIntakeTickets ──────────────────────────────────────────────────────

function d3LoadIntake(mocks) {
    return loadModule('js/createIntakeTickets.js', makeRequire({
        './common/aiResponseParser.js': loadModule('js/common/aiResponseParser.js', makeRequire({ '../config.js': configModule }), {}),
        './config.js': configModule,
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/trackers.js': d3Trackers(mocks)
    }), mocks);
}

function d3IntakeFiles(extra) {
    return Object.assign({
        file_read: function(a) {
            var p = typeof a === 'string' ? a : a.path;
            if (p === 'outputs/stories.json') return JSON.stringify([{ tempId: 'e1', type: 'Epic', summary: 'Epic one', description: 'outputs/d.md', storyPoints: 3, attachments: ['outputs/a.png'] }]);
            if (p === 'outputs/comment.md') return 'AI comment';
            if (p === 'outputs/d.md') return 'desc';
            throw new Error('nf ' + p);
        }
    }, extra);
}

suite('createIntakeTickets: tracker layer', function() {
    test('jira: create_ticket_with_json + attach + story points + labels via jira_* tools', function() {
        var calls = [];
        var rec = function(n) { return function(a) { calls.push([n, a]); return n === 'create' ? { key: 'P-100' } : undefined; }; };
        var mod = d3LoadIntake(d3IntakeFiles({
            jira_create_ticket_with_json: rec('create'),
            jira_attach_file_to_ticket: rec('attach'),
            jira_update_field: rec('field'),
            jira_link_issues: rec('link'),
            jira_move_to_status: rec('move'),
            jira_post_comment: rec('comment'),
            jira_add_label: rec('label'),
            jira_assign_ticket_to: rec('assign'),
            jira_remove_label: rec('rm')
        }));
        var r = mod.action({ ticket: { key: 'P-1' }, initiator: 'acc1', metadata: { contextId: 'intake' } });
        assert.equal(r.success, true);
        var create = calls.filter(function(c) { return c[0] === 'create'; })[0][1];
        assert.equal(create.project, 'P');
        assert.equal(create.fieldsJson.summary.indexOf('Epic one') !== -1, true);
        var attach = calls.filter(function(c) { return c[0] === 'attach'; })[0][1];
        assert.equal(attach.ticketKey, 'P-100');
        assert.equal(attach.name, 'a.png');
        assert.equal(attach.contentType, 'image/png');
        var field = calls.filter(function(c) { return c[0] === 'field'; })[0][1];
        assert.deepEqual(field, { key: 'P-100', field: 'Story Points', value: 3 });
        assert.equal(calls.filter(function(c) { return c[0] === 'assign'; })[0][1].accountId, 'acc1');
    });

    test('ado: creation via ado_create_work_item and mechanical ops via ado_*, no jira_*', function() {
        var calls = [];
        var rec = function(n, ret) { return function(a) { calls.push([n, a]); return ret; }; };
        var mod = d3LoadIntake(d3IntakeFiles({
            file_read: function(a) {
                var p = typeof a === 'string' ? a : a.path;
                if (p === 'outputs/stories.json') return JSON.stringify([{ tempId: 'e1', type: 'Epic', summary: 'Epic one', description: 'x' }]);
                throw new Error('nf ' + p);
            },
            ado_create_work_item: rec('create', { id: 321 }),
            ado_link_work_items: rec('link'),
            ado_move_to_state: rec('move'),
            ado_add_work_item_comment: rec('comment'),
            ado_add_work_item_label: rec('label'),
            ado_assign_work_item: rec('assign'),
            ado_remove_work_item_label: rec('rm'),
            jira_create_ticket_with_json: d3Boom('jira_create_ticket_with_json'),
            jira_post_comment: d3Boom('jira_post_comment'),
            jira_add_label: d3Boom('jira_add_label'),
            jira_assign_ticket_to: d3Boom('jira_assign_ticket_to'),
            jira_move_to_status: d3Boom('jira_move_to_status')
        }));
        var r = mod.action({
            ticket: { key: '50' }, initiator: 'me@x', metadata: { contextId: 'intake' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(r.success, true);
        // ADO needs workItemType+title in fieldsJson; Jira-shaped fields miss them, so the
        // create attempt fails and is reported as a failed entry (documented degradation).
        var tools = calls.map(function(c) { return c[0]; });
        assert.ok(tools.indexOf('comment') !== -1, 'comment posted via ado');
        assert.ok(tools.indexOf('assign') !== -1, 'assigned via ado');
        var mv = calls.filter(function(c) { return c[0] === 'move'; })[0][1];
        assert.equal(mv.id, '50');
        assert.equal(r.results[0].success, false);
    });
});

// ── preCliTestReworkSetup ────────────────────────────────────────────────────

function d3LoadPreCli(mocks, scm) {
    return loadModule('js/preCliTestReworkSetup.js', makeRequire({
        './configLoader.js': {
            loadProjectConfig: function() { return { jira: { statuses: { BACKLOG: 'Backlog' } }, git: { baseBranch: 'main' }, formats: { prTitle: { rework: 'x' } } }; },
            createScm: function() { return scm; }
        },
        './common/githubHelpers.js': {},
        './common/gitOps.js': {},
        './common/pullRequest.js': {},
        './fetchQuestionsToInput.js': { action: function() {} },
        './fetchLinkedBugsToInput.js': { action: function() {} },
        './common/trackers.js': d3Trackers(mocks)
    }), mocks);
}

suite('preCliTestReworkSetup: tracker layer', function() {
    var scm = { getRemoteRepoInfo: function() { return null; } };
    test('jira: missing repo info -> jira_post_comment', function() {
        var comments = [];
        var mod = d3LoadPreCli({
            cli_execute_command: function() { return ''; },
            jira_post_comment: function(a) { comments.push(a); }
        }, scm);
        var r = mod.action({ inputFolderPath: 'input/TS-7' });
        assert.equal(r.success, false);
        assert.equal(comments[0].key, 'TS-7');
        assert.contains(comments[0].comment, 'Test Rework Setup Failed');
    });

    test('ado: missing repo info -> ado_add_work_item_comment {id}, no jira_*', function() {
        var comments = [];
        var mod = d3LoadPreCli({
            cli_execute_command: function() { return ''; },
            ado_add_work_item_comment: function(a) { comments.push(a); },
            jira_post_comment: d3Boom('jira_post_comment')
        }, scm);
        var r = mod.action({ inputFolderPath: 'input/77', customParams: { trackerProvider: 'ado' } });
        assert.equal(r.success, false);
        assert.equal(comments.length, 1);
        assert.equal(comments[0].id, '77');
    });
});
