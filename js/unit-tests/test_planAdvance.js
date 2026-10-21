/**
 * Tests for js/common/planAdvance.js — the SM localAction advance_plan — and the
 * decision core it shares with the intake post-action (js/common/issuePlan.js).
 * The tracker is a hand-written fake: the module only talks to the tracker API.
 */

function loadPlanAdvance() {
    return loadModule('js/common/planAdvance.js', makeRequire({
        './issuePlan.js': loadModule('js/common/issuePlan.js', makeRequire({}), {})
    }), {});
}

var CFG = { devLabel: 'agent:dev', plannedLabel: 'ai_planned', maxParallel: 1 };

function child(n, state, labels) {
    return { key: 'acme/widgets#' + n, title: 'Step ' + n, status: state, labels: labels || [] };
}

function planComment(plan) {
    return { body: 'Plan\n\n<!-- dmtools:issue-plan ' + JSON.stringify(plan) + ' -->' };
}

/** A fake GitHub tracker: sub-issues, comments, other tickets; records every write. */
function fakeTracker(children, comments, others) {
    var t = { writes: [], closed: [] };
    t.provider = function() { return 'github'; };
    t.listChildTickets = function() { return children; };
    t.getComments = function() { return comments || []; };
    t.getTicket = function(key) { t.writes.push(['get', key]); return (others || {})[key] || { key: key, status: 'open' }; };
    t.addLabel = function(key, label) { t.writes.push(['label', key, label]); };
    t.assignTo = function(key, user) { t.writes.push(['assign', key, user]); };
    t.postComment = function(key, text) { t.writes.push(['comment', key, text]); };
    return t;
}

function run(tracker, cfg, dryRun) {
    return loadPlanAdvance().advancePlan(tracker, '12', cfg || CFG, {
        dryRun: !!dryRun,
        closeIssue: function(key) { tracker.closed.push(key); }
    });
}

function labelsAdded(tracker) {
    return tracker.writes.filter(function(w) { return w[0] === 'label'; }).map(function(w) { return w[1]; });
}

suite('planAdvance: next step of a planned parent', function() {

    test('without recorded blockers, sub-issues start one at a time in order', function() {
        var t = fakeTracker([child(13, 'closed', ['agent:dev']), child(14, 'open'), child(15, 'open')]);
        var d = run(t);
        assert.equal(d.type, 'start');
        assert.deepEqual(labelsAdded(t), ['acme/widgets#14']);
        var comment = t.writes.filter(function(w) { return w[0] === 'comment'; })[0];
        assert.equal(comment[1], '12', 'the comment goes on the parent');
        assert.contains(comment[2], 'Starting #14');
    });

    test('a started sub-issue fills the only slot — the next one waits', function() {
        var t = fakeTracker([child(13, 'open', ['agent:dev']), child(14, 'open')]);
        assert.equal(run(t).type, 'wait');
        assert.equal(t.writes.length, 0);
    });

    test('a sub-issue whose recorded blocker is open is skipped for a later ready one', function() {
        var plan = { blockedBy: [], deps: { 'acme/widgets#13': ['acme/widgets#99'], 'acme/widgets#14': [] } };
        var t = fakeTracker([child(13, 'open'), child(14, 'open')], [planComment(plan)],
            { 'acme/widgets#99': { status: 'open' } });
        run(t);
        assert.deepEqual(labelsAdded(t), ['acme/widgets#14']);
        assert.ok(t.writes.some(function(w) { return w[0] === 'get' && w[1] === 'acme/widgets#99'; }),
            'a blocker outside the sub-issues is read from the tracker');
    });

    test('maxParallel starts several ready sub-issues, blockers between siblings respected', function() {
        var plan = { blockedBy: [], deps: { 'acme/widgets#15': ['acme/widgets#13'] } };
        var t = fakeTracker([child(13, 'open'), child(14, 'open'), child(15, 'open')], [planComment(plan)]);
        run(t, { devLabel: 'agent:dev', plannedLabel: 'ai_planned', maxParallel: 3 });
        assert.deepEqual(labelsAdded(t), ['acme/widgets#13', 'acme/widgets#14']);
    });

    test('a nested plan (an epic) never gets the dev label and takes no slot', function() {
        var t = fakeTracker([child(13, 'open', ['ai_planned']), child(14, 'open')]);
        run(t);
        assert.deepEqual(labelsAdded(t), ['acme/widgets#14']);
    });

    test('the latest plan comment wins', function() {
        var older = { blockedBy: [], deps: { 'acme/widgets#13': ['acme/widgets#14'] } };
        var newer = { blockedBy: [], deps: {} };
        var t = fakeTracker([child(13, 'open'), child(14, 'open')], [planComment(older), { body: 'chat' }, planComment(newer)]);
        run(t);
        assert.deepEqual(labelsAdded(t), ['acme/widgets#13']);
    });

    test('an open blocker of the parent itself holds every sub-issue', function() {
        var plan = { blockedBy: ['acme/widgets#5'], deps: {} };
        var t = fakeTracker([child(13, 'open')], [planComment(plan)], { 'acme/widgets#5': { status: 'open' } });
        assert.equal(run(t).type, 'blocked');
        assert.deepEqual(labelsAdded(t), []);
    });

    test('closes the parent when every sub-issue is closed', function() {
        var t = fakeTracker([child(13, 'closed'), child(14, 'closed')]);
        assert.equal(run(t).type, 'complete');
        assert.deepEqual(t.closed, ['12']);
        assert.contains(t.writes[0][2], 'All 2 sub-issues');
    });

    test('a parent without sub-issues changes nothing', function() {
        var t = fakeTracker([]);
        assert.equal(run(t).type, 'empty');
        assert.equal(t.writes.length, 0);
        assert.equal(t.closed.length, 0);
    });

    test('dry run decides without writing', function() {
        var t = fakeTracker([child(13, 'open')]);
        assert.equal(run(t, CFG, true).type, 'start');
        assert.equal(t.writes.length, 0);
    });

    test('a non-GitHub tracker is skipped without a single tracker call', function() {
        var t = fakeTracker([child(13, 'open')]);
        t.provider = function() { return 'jira'; };
        t.listChildTickets = function() { throw new Error('must not be called'); };
        assert.equal(run(t).type, 'unsupported');
    });

    test('describe gives one log line per decision', function() {
        var pa = loadPlanAdvance();
        assert.contains(pa.describe({ type: 'start', start: [child(14, 'open')] }, CFG), 'acme/widgets#14 +agent:dev');
        assert.contains(pa.describe({ type: 'start', start: [child(14, 'open')] },
            { devLabel: 'agent:dev', devAssignee: 'ai-teammate', plannedLabel: 'ai_planned', maxParallel: 1 }),
            'acme/widgets#14 +agent:dev @ai-teammate');
        assert.contains(pa.describe({ type: 'unsupported', start: [] }, CFG), 'GitHub only');
    });

    test('when devAssignee is configured, starting a sub-issue also assigns it', function() {
        var t = fakeTracker([child(14, 'open')]);
        var cfgWithAssignee = { devLabel: 'agent:dev', devAssignee: 'ai-teammate', plannedLabel: 'ai_planned', maxParallel: 1 };
        var d = run(t, cfgWithAssignee);
        assert.equal(d.type, 'start');
        assert.deepEqual(t.writes.filter(function(w) { return w[0] === 'assign'; }),
            [['assign', 'acme/widgets#14', 'ai-teammate']]);
        var comment = t.writes.filter(function(w) { return w[0] === 'comment'; })[0];
        assert.contains(comment[2], 'assignee `ai-teammate`');
    });
});
