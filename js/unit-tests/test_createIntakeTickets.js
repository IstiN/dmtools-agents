/**
 * Characterization tests for js/createIntakeTickets.js (gh-963).
 * Pin the current behaviour of action(): two-pass creation (Bugs -> Epics ->
 * Stories), tempId/parent resolution, blockedBy/integrates links, final
 * comment/labels/assign/move and WIP-label removal — via the jira tracker
 * mocks (same wiring as test_wave2d3Tracker.js).
 */

function intakeTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function loadIntake(mocks, projectConfig) {
    return loadModule('js/createIntakeTickets.js', makeRequire({
        './common/aiResponseParser.js': loadModule('js/common/aiResponseParser.js', makeRequire({ '../config.js': configModule }), {}),
        './config.js': configModule,
        './configLoader.js': { loadProjectConfig: function() { return projectConfig || {}; } },
        './common/issuePlan.js': loadModule('js/common/issuePlan.js', makeRequire({}), {}),
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/outputFiles.js': loadModule('js/common/outputFiles.js', makeRequire({}), mocks),
        './common/trackers.js': intakeTrackers(mocks)
    }), mocks);
}

// Recorder mock for every jira tool the intake action can touch.
function intakeRecorder() {
    var calls = [];
    var keyCounter = 100;
    var api = {
        calls: calls,
        nextKey: function() { return 'P-' + (keyCounter++); },
        failCreate: false
    };
    api.jiraMocks = function() {
        return {
            jira_create_ticket_with_json: function(a) {
                calls.push(['create', a]);
                if (api.failCreate) throw new Error('create failed');
                return { key: api.nextKey() };
            },
            jira_attach_file_to_ticket: function(a) { calls.push(['attach', a]); },
            jira_update_field: function(a) { calls.push(['field', a]); },
            jira_link_issues: function(a) { calls.push(['link', a]); },
            jira_move_to_status: function(a) { calls.push(['move', a]); },
            jira_post_comment: function(a) { calls.push(['comment', a]); },
            jira_add_label: function(a) { calls.push(['label', a]); },
            jira_assign_ticket_to: function(a) { calls.push(['assign', a]); },
            jira_remove_label: function(a) { calls.push(['rm', a]); }
        };
    };
    return api;
}

function intakeFiles(stories, extra) {
    return Object.assign({
        file_read: function(a) {
            var p = typeof a === 'string' ? a : a.path;
            if (p === 'outputs/stories.json') return JSON.stringify(stories);
            if (p === 'outputs/comment.md') return 'AI comment';
            if (p === 'outputs/d.md') return 'desc';
            throw new Error('nf ' + p);
        }
    }, extra || {});
}

function toolSequence(calls) {
    return calls.map(function(c) { return c[0]; });
}

suite('createIntakeTickets: full intake flow', function() {

    test('bug, epic, stories with tempId resolution, blockedBy and integrates links', function() {
        var rec = intakeRecorder();
        var stories = [
            { tempId: 'b1', type: 'Bug', summary: 'Bug one', description: 'outputs/d.md' },
            { tempId: 'e1', type: 'Epic', summary: 'Epic one', description: 'outputs/d.md', storyPoints: 3 },
            { tempId: 's1', type: 'Story', summary: 'Story one', parent: 'e1', description: 'outputs/d.md', blockedBy: ['b1'], integrates: ['s2'] },
            { tempId: 's2', type: 'Story', summary: 'Story two', parent: 'P-9' },
            { type: 'Story', summary: 'Orphan story', parent: 'epic-missing' }
        ];
        var mod = loadIntake(intakeFiles(stories, rec.jiraMocks()));
        var r = mod.action({ ticket: { key: 'P-1' }, initiator: 'acc1', metadata: { contextId: 'intake' } });

        assert.equal(r.success, true);
        assert.equal(r.results.length, 5);

        // Result entries in pass order (Bug, Epic, Story, Story, failed Story)
        assert.equal(r.results[0].type, 'Bug');
        assert.equal(r.results[0].success, true);
        assert.equal(r.results[0].key, 'P-100');
        assert.equal(r.results[1].type, 'Epic');
        assert.equal(r.results[1].key, 'P-101');
        assert.equal(r.results[2].type, 'Story');
        assert.equal(r.results[2].key, 'P-102');
        assert.equal(r.results[2].success, true);
        assert.equal(r.results[3].key, 'P-103');
        assert.equal(r.results[4].summary, 'Orphan story');
        assert.equal(r.results[4].success, false);
        assert.equal(r.results[4].error, 'Could not resolve parent "epic-missing"');

        // Story parent resolved through tempId: create payload carries the epic key
        var creates = rec.calls.filter(function(c) { return c[0] === 'create'; });
        assert.equal(creates.length, 4);
        var storyCreate = creates[2][1];
        assert.equal(storyCreate.fieldsJson.parent.key, 'P-101');
        var realParentCreate = creates[3][1];
        assert.equal(realParentCreate.fieldsJson.parent.key, 'P-9');

        // Bug moved to Ready For Development right after creation
        var moves = rec.calls.filter(function(c) { return c[0] === 'move'; });
        assert.deepEqual(moves[0][1], { key: 'P-100', statusName: 'Ready For Development' });

        // Story points set on the epic only (bug pass does not set them)
        var fields = rec.calls.filter(function(c) { return c[0] === 'field'; });
        assert.equal(fields.length, 1);
        assert.deepEqual(fields[0][1], { key: 'P-101', field: 'Story Points', value: 3 });

        // blockedBy: Blocks link P-102 -> P-100, then P-102 moved to Blocked
        var links = rec.calls.filter(function(c) { return c[0] === 'link'; });
        assert.deepEqual(links[0][1], { sourceKey: 'P-100', anotherKey: 'P-1', relationship: 'Relates' }); // linkToSource for bug
        var blocks = links.filter(function(c) { return c[1].relationship === 'Blocks'; });
        assert.equal(blocks.length, 1);
        assert.deepEqual(blocks[0][1], { sourceKey: 'P-102', anotherKey: 'P-100', relationship: 'Blocks' });
        var blockedMove = moves.filter(function(c) { return c[1].statusName === 'Blocked'; });
        assert.deepEqual(blockedMove[0][1], { key: 'P-102', statusName: 'Blocked' });

        // integrates: Relates link between the two stories
        var integration = links.filter(function(c) {
            return c[1].relationship === 'Relates' && c[1].sourceKey === 'P-102' && c[1].anotherKey === 'P-103';
        });
        assert.equal(integration.length, 1);

        // Finalization: comment, two labels, assign, In Progress move, WIP label removal
        var seq = toolSequence(rec.calls);
        var lastSix = seq.slice(-6);
        assert.deepEqual(lastSix, ['comment', 'label', 'label', 'assign', 'move', 'rm']);
        var comment = rec.calls.filter(function(c) { return c[0] === 'comment'; })[0][1];
        assert.equal(comment.key, 'P-1');
        assert.contains(comment.comment, 'AI comment');
        assert.contains(comment.comment, 'P-101');      // created ticket listed
        assert.contains(comment.comment, 'Orphan story'); // failure listed
        assert.contains(comment.comment, '*Total Created:* 4 ticket(s)');
        var labels = rec.calls.filter(function(c) { return c[0] === 'label'; });
        assert.deepEqual(labels[0][1], { key: 'P-1', label: 'ai_intake' });
        assert.deepEqual(labels[1][1], { key: 'P-1', label: 'ai_generated' });
        assert.deepEqual(rec.calls.filter(function(c) { return c[0] === 'assign'; })[0][1].accountId, 'acc1');
        var finalMove = moves.filter(function(c) { return c[1].statusName === 'In Progress'; });
        assert.deepEqual(finalMove[0][1], { key: 'P-1', statusName: 'In Progress' });
        var rm = rec.calls.filter(function(c) { return c[0] === 'rm'; })[0][1];
        assert.deepEqual(rm, { key: 'P-1', label: 'intake_wip' });
    });

    test('empty stories.json: no creates, comment says none created, ticket still finalized', function() {
        var rec = intakeRecorder();
        var mod = loadIntake(intakeFiles([], rec.jiraMocks()));
        var r = mod.action({ ticket: { key: 'P-2' }, initiator: 'acc1', metadata: {} });
        assert.equal(r.success, true);
        assert.equal(r.results.length, 0);
        assert.equal(r.message, 'Intake complete for P-2: created 0 ticket(s), moved to In Development');
        assert.equal(toolSequence(rec.calls).indexOf('create'), -1);
        assert.equal(toolSequence(rec.calls).indexOf('rm'), -1); // no WIP label without contextId
        var comment = rec.calls.filter(function(c) { return c[0] === 'comment'; })[0][1];
        assert.contains(comment.comment, '_No tickets were created (stories.json was empty)._');
    });

    test('ticket creation failure recorded as failed result, other passes continue', function() {
        var rec = intakeRecorder();
        // First create (epic) succeeds -> P-100; second (story) fails.
        var n = 0;
        var mocks = rec.jiraMocks();
        mocks.jira_create_ticket_with_json = function(a) {
            rec.calls.push(['create', a]);
            n++;
            if (n === 2) return null;
            return { key: 'P-100' };
        };
        var mod2 = loadIntake(intakeFiles([
            { tempId: 'e1', type: 'Epic', summary: 'Epic one', description: 'x' },
            { type: 'Story', summary: 'Story one', parent: 'e1' }
        ], mocks));
        var r = mod2.action({ ticket: { key: 'P-3' }, initiator: 'acc1', metadata: {} });
        assert.equal(r.success, true);
        assert.equal(r.results[0].success, true);
        assert.equal(r.results[1].success, false);
        assert.equal(r.results[1].error, 'Creation failed (see logs)');
        // Parent tempId still resolved through the epic key
        var storyCreate = rec.calls.filter(function(c) { return c[0] === 'create'; })[1][1];
        assert.equal(storyCreate.fieldsJson.parent.key, 'P-100');
    });

    test('unresolvable blockedBy ref logs a warning and does not block', function() {
        var rec = intakeRecorder();
        var mod = loadIntake(intakeFiles([
            { tempId: 's1', type: 'Story', summary: 'Story one', parent: null, blockedBy: ['ghost-1'] }
        ], rec.jiraMocks()));
        var r = mod.action({ ticket: { key: 'P-4' }, initiator: 'acc1', metadata: {} });
        assert.equal(r.success, true);
        assert.equal(rec.calls.filter(function(c) { return c[0] === 'link'; }).length, 1); // linkToSource only
        assert.equal(rec.calls.filter(function(c) { return c[0] === 'move' && c[1].statusName === 'Blocked'; }).length, 0);
    });

    test('integrates self-link skipped (otherKey === storyKey)', function() {
        var rec = intakeRecorder();
        var mod = loadIntake(intakeFiles([
            { tempId: 's1', type: 'Story', summary: 'Story one', parent: null, integrates: ['s1'] }
        ], rec.jiraMocks()));
        var r = mod.action({ ticket: { key: 'P-5' }, initiator: 'acc1', metadata: {} });
        assert.equal(r.success, true);
        assert.equal(rec.calls.filter(function(c) { return c[0] === 'link'; }).length, 1); // linkToSource only
    });

    test('finalize step failures are swallowed and do not fail the run', function() {
        var rec = intakeRecorder();
        var mocks = rec.jiraMocks();
        mocks.jira_post_comment = function(a) { rec.calls.push(['comment', a]); throw new Error('comment down'); };
        mocks.jira_add_label = function(a) { rec.calls.push(['label', a]); throw new Error('label down'); };
        mocks.jira_assign_ticket_to = function(a) { rec.calls.push(['assign', a]); throw new Error('assign down'); };
        mocks.jira_move_to_status = function(a) { rec.calls.push(['move', a]); throw new Error('move down'); };
        mocks.jira_remove_label = function(a) { rec.calls.push(['rm', a]); throw new Error('rm down'); };
        var mod = loadIntake(intakeFiles([], mocks));
        var r = mod.action({ ticket: { key: 'P-7' }, initiator: 'acc1', metadata: { contextId: 'intake' } });
        assert.equal(r.success, true);
        var seq = toolSequence(rec.calls);
        assert.deepEqual(seq, ['comment', 'label', 'label', 'assign', 'move', 'rm']);
    });

    test('failed Blocks link does not block; failed Blocked move is swallowed', function() {
        var rec = intakeRecorder();
        var mocks = rec.jiraMocks();
        mocks.jira_link_issues = function(a) {
            rec.calls.push(['link', a]);
            if (a.relationship === 'Blocks') throw new Error('link down');
        };
        var mod = loadIntake(intakeFiles([
            { tempId: 'b1', type: 'Bug', summary: 'Bug one', description: 'x' },
            { tempId: 's1', type: 'Story', summary: 'Story one', parent: null, blockedBy: ['missing-1', 'b1'] }
        ], mocks));
        var r = mod.action({ ticket: { key: 'P-8' }, initiator: 'acc1', metadata: {} });
        assert.equal(r.success, true);
        assert.equal(rec.calls.filter(function(c) { return c[0] === 'link' && c[1].relationship === 'Blocks'; }).length, 1);
        assert.equal(rec.calls.filter(function(c) { return c[0] === 'move' && c[1].statusName === 'Blocked'; }).length, 0);
    });

    test('exception in body posts error comment and returns success:false', function() {
        var rec = intakeRecorder();
        var mocks = rec.jiraMocks();
        var mod = loadIntake(mocks);
        // No params.ticket — params.ticket.key access throws inside action's try block.
        var r = mod.action({ initiator: 'acc1', metadata: {} });
        assert.equal(r.success, false);
        assert.contains(r.error, "'key'");
    });
});

// ── GitHub: entries become sub-issues ─────────────────────────────────────

var GH_CONFIG = { repository: { owner: 'acme', repo: 'widgets' } };
var GH_PARAMS = {
    ticket: { key: 'acme/widgets#12' }, initiator: 'octocat', metadata: { contextId: 'intake' },
    jobParams: { customParams: { trackerProvider: 'github' } }
};

/**
 * A GitHub with persistent sub-issues: github_create_issue creates an issue and
 * `gh api` lists / attaches sub-issues. Survives across runs (retry tests).
 */
function githubWorld() {
    var w = { issues: {}, subIssues: {}, calls: [], next: 13, failTitles: [] };
    function rec(name) { return function(a) { w.calls.push([name, a]); return '{}'; }; }
    w.mocks = function() {
        return {
            github_create_issue: function(a) {
                w.calls.push(['create', a]);
                if (w.failTitles.indexOf(a.title) !== -1) throw new Error('create failed');
                var n = w.next++;
                w.issues[1000 + n] = { id: 1000 + n, number: n, title: a.title, body: a.body, state: 'open', labels: [] };
                return w.issues[1000 + n];
            },
            cli_execute_command: function(a) {
                w.calls.push(['gh', a.command]);
                var m = /issues\/(\d+)\/sub_issues/.exec(a.command);
                var list = w.subIssues[m[1]] || (w.subIssues[m[1]] = []);
                var attach = /sub_issue_id=(\d+)/.exec(a.command);
                if (attach) { list.push(w.issues[attach[1]]); return '{}'; }
                return JSON.stringify(/page=1(\s|$)/.test(a.command) ? list : []);
            },
            github_create_comment: rec('comment'),
            github_add_labels: rec('label'),
            github_remove_label: rec('rm'),
            github_assign_issue: rec('assign'),
            github_move_issue_to_status: rec('move'),
            jira_create_ticket_with_json: function() { throw new Error('jira must not be called'); }
        };
    };
    w.of = function(name) { return w.calls.filter(function(c) { return c[0] === name; }).map(function(c) { return c[1]; }); };
    w.reset = function() { w.calls = []; };
    return w;
}

function planMarkerOf(text) {
    var m = /<!-- dmtools:issue-plan (.*) -->/.exec(text);
    return m ? JSON.parse(m[1]) : null;
}

suite('createIntakeTickets: GitHub sub-issues', function() {

    var STORIES = [
        { tempId: 'b1', type: 'Bug', summary: 'Fix the crash', description: 'outputs/d.md' },
        { tempId: 'e1', type: 'Epic', summary: 'Orders', description: 'outputs/d.md', storyPoints: 3, attachments: ['outputs/attachments/a.png'] },
        { tempId: 's1', type: 'Story', summary: 'Order model', parent: 'e1', description: 'outputs/d.md' },
        { tempId: 's2', type: 'Story', summary: 'Order import', parent: 'e1', blockedBy: ['s1', 'b1'] }
    ];

    test('entries become sub-issues, the blockedBy ordering is recorded, parents are labeled planned', function() {
        var w = githubWorld();
        var r = loadIntake(intakeFiles(STORIES, w.mocks()), GH_CONFIG).action(GH_PARAMS);

        assert.equal(r.success, true);
        assert.deepEqual(r.results.map(function(x) { return x.key; }),
            ['acme/widgets#13', 'acme/widgets#14', 'acme/widgets#15', 'acme/widgets#16']);
        // Bug and epic are sub-issues of the source issue, the stories of the epic
        assert.deepEqual(w.subIssues['12'].map(function(i) { return i.number; }), [13, 14]);
        assert.deepEqual(w.subIssues['14'].map(function(i) { return i.number; }), [15, 16]);
        // Every body carries the entry marker, the description stays first
        var bodies = w.of('create').map(function(a) { return a.body; });
        assert.contains(bodies[2], 'desc');
        assert.contains(bodies[2], '<!-- dmtools:intake-item s1 -->');

        // Epic plan first, then the source plan; label after its comment
        var comments = w.of('comment');
        assert.equal(comments[0].pullRequestId, 14);
        assert.deepEqual(planMarkerOf(comments[0].text),
            { blockedBy: [], deps: { 'acme/widgets#15': [], 'acme/widgets#16': ['acme/widgets#15', 'acme/widgets#13'] } });
        assert.equal(comments[1].pullRequestId, 12);
        assert.deepEqual(planMarkerOf(comments[1].text),
            { blockedBy: [], deps: { 'acme/widgets#13': [], 'acme/widgets#14': [] } });
        var labels = w.of('label');
        assert.deepEqual(labels.slice(0, 2).map(function(a) { return [a.number, a.labels[0]]; }),
            [[14, 'ai_planned'], [12, 'ai_planned']]);

        // Final comment in Markdown, then the usual finalization
        assert.contains(comments[2].text, 'AI comment');
        assert.contains(comments[2].text, '- #16 (Story) - Order import');
        assert.contains(comments[2].text, '**Total:** 4 sub-issue(s)');
        assert.equal(comments[2].text.indexOf('Not every entry exists'), -1);
        // No Jira-only extras on a planned GitHub parent: no status moves, no links, no attachments
        assert.deepEqual(w.of('move'), []);
    });

    test('a failed entry leaves every parent unplanned; the re-run reuses what exists and creates only the rest', function() {
        var w = githubWorld();
        w.failTitles = ['Order import'];
        var first = loadIntake(intakeFiles(STORIES, w.mocks()), GH_CONFIG).action(GH_PARAMS);
        assert.equal(first.results[3].success, false);
        assert.equal(w.of('label').filter(function(a) { return a.labels[0] === 'ai_planned'; }).length, 0);
        assert.equal(w.of('comment').filter(function(a) { return planMarkerOf(a.text); }).length, 0);
        assert.contains(w.of('comment')[0].text, 'Not every entry exists yet');

        w.reset();
        w.failTitles = [];
        var second = loadIntake(intakeFiles(STORIES, w.mocks()), GH_CONFIG).action(GH_PARAMS);
        assert.deepEqual(w.of('create').map(function(a) { return a.title; }), ['Order import'], 'only the missing entry');
        assert.deepEqual(second.results.map(function(x) { return x.reused; }), [true, true, true, false]);
        assert.deepEqual(w.subIssues['14'].map(function(i) { return i.number; }), [15, 16]);
        assert.equal(w.of('label').filter(function(a) { return a.labels[0] === 'ai_planned'; }).length, 2);
        assert.contains(w.of('comment')[2].text, '_(existing)_');
    });

    test('an entry is matched by title when its marker is gone', function() {
        var w = githubWorld();
        w.issues[1099] = { id: 1099, number: 99, title: 'fix the crash ', body: 'edited by hand', state: 'open', labels: [] };
        w.subIssues['12'] = [w.issues[1099]];
        var r = loadIntake(intakeFiles([STORIES[0]], w.mocks()), GH_CONFIG).action(GH_PARAMS);
        assert.equal(r.results[0].key, 'acme/widgets#99');
        assert.equal(w.of('create').length, 0);
    });

    test('unreadable sub-issues (no gh): nothing is created, nothing is planned', function() {
        var w = githubWorld();
        var mocks = w.mocks();
        mocks.cli_execute_command = function() { return 'bash: gh: command not found'; };
        var r = loadIntake(intakeFiles(STORIES, mocks), GH_CONFIG).action(GH_PARAMS);
        assert.equal(r.success, true);
        assert.equal(w.of('create').length, 0);
        assert.equal(r.results.filter(function(x) { return x.success; }).length, 0);
        assert.equal(w.of('label').filter(function(a) { return a.labels[0] === 'ai_planned'; }).length, 0);
    });

    test('empty stories.json: nothing planned, the comment says so', function() {
        var w = githubWorld();
        loadIntake(intakeFiles([], w.mocks()), GH_CONFIG).action(GH_PARAMS);
        assert.equal(w.of('create').length, 0);
        assert.contains(w.of('comment')[0].text, '_No sub-issues were created (stories.json was empty)._');
        assert.equal(w.of('label').filter(function(a) { return a.labels[0] === 'ai_planned'; }).length, 0);
    });

    test('planned label comes from the issuePlanning config', function() {
        var w = githubWorld();
        var cfg = { repository: GH_CONFIG.repository, issuePlanning: { plannedLabel: 'sequenced' } };
        loadIntake(intakeFiles([STORIES[0]], w.mocks()), cfg).action(GH_PARAMS);
        assert.deepEqual(w.of('label')[0].labels, ['sequenced']);
    });
});
