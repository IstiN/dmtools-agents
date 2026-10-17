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

function loadIntake(mocks) {
    return loadModule('js/createIntakeTickets.js', makeRequire({
        './common/aiResponseParser.js': loadModule('js/common/aiResponseParser.js', makeRequire({ '../config.js': configModule }), {}),
        './config.js': configModule,
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
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
