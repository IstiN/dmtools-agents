/**
 * Unit tests for js/common/issuePlan.js — the issue plan contract shared by the
 * intake post-action (GitHub sub-issues) and the SM advance_plan localAction.
 *
 * Tests: config resolution, the entry and plan markers, the next-step decision.
 */

function loadIssuePlan() {
    return loadModule('js/common/issuePlan.js', makeRequire({}), {});
}

var PLAN_CFG = { devLabel: 'agent:dev', plannedLabel: 'ai_planned', maxParallel: 1 };

function view(n, status, labels) {
    return { key: 'acme/widgets#' + n, status: status, labels: labels || [] };
}

function neverClosed() { return false; }

suite('issuePlan — resolvePlanningConfig', function () {
    test('defaults apply without any config', function () {
        var cfg = loadIssuePlan().resolvePlanningConfig(null, null);
        assert.deepEqual(cfg, { devLabel: 'agent:dev', devAssignee: null, plannedLabel: 'ai_planned', maxParallel: 1 });
    });

    test('project config overrides the defaults and customParams override the project', function () {
        var cfg = loadIssuePlan().resolvePlanningConfig(
            { issuePlanning: { devLabel: 'start-dev', devAssignee: 'bot-a', maxParallel: 5 } },
            { issuePlanning: { maxParallel: '3', devAssignee: 'bot-b', plannedLabel: 'planned' } }
        );
        assert.deepEqual(cfg, { devLabel: 'start-dev', devAssignee: 'bot-b', plannedLabel: 'planned', maxParallel: 3 });
    });

    test('invalid values are ignored', function () {
        var cfg = loadIssuePlan().resolvePlanningConfig(
            { issuePlanning: { devLabel: '  ', devAssignee: '  ', maxParallel: 0, plannedLabel: 7 } }, {});
        assert.deepEqual(cfg, { devLabel: 'agent:dev', devAssignee: null, plannedLabel: 'ai_planned', maxParallel: 1 });
    });
});

suite('issuePlan — markers', function () {
    test('an entry marker round-trips and is found inside a body', function () {
        var ip = loadIssuePlan();
        assert.equal(ip.itemIdOf('Desc\n\n' + ip.itemMarker('s1')), 's1');
        assert.equal(ip.itemIdOf('no marker'), null);
        assert.equal(ip.itemIdOf(null), null);
    });

    test('findExistingItem prefers the marker, falls back to the title, else null', function () {
        var ip = loadIssuePlan();
        var children = [
            { key: 'a', title: 'Order model', description: 'x' },
            { key: 'b', title: 'Renamed by hand', description: ip.itemMarker('s1') }
        ];
        assert.equal(ip.findExistingItem(children, 's1', 'Order model').key, 'b');
        assert.equal(ip.findExistingItem(children, 's9', ' order MODEL ').key, 'a');
        assert.equal(ip.findExistingItem(children, 's9', 'Other'), null);
        assert.equal(ip.findExistingItem(null, 's9', 'Other'), null);
    });

    test('a plan marker round-trips; findPlan takes the last one and defaults to an empty plan', function () {
        var ip = loadIssuePlan();
        var plan = { blockedBy: ['x#1'], deps: { 'x#2': ['x#3'] } };
        assert.deepEqual(ip.parsePlanMarker('Plan\n' + ip.renderPlanMarker(plan)), plan);
        assert.equal(ip.parsePlanMarker('<!-- dmtools:issue-plan {broken -->'), null);
        assert.equal(ip.parsePlanMarker('none'), null);
        var older = { body: ip.renderPlanMarker({ deps: { 'x#2': ['x#1'] } }) };
        var newer = { body: ip.renderPlanMarker({ deps: {} }) };
        assert.deepEqual(ip.findPlan([older, newer, { body: 'chat' }]), { blockedBy: [], deps: {} });
        assert.deepEqual(ip.findPlan(null), { blockedBy: [], deps: {} });
    });

    test('blockersOf compares keys case-insensitively', function () {
        var ip = loadIssuePlan();
        var plan = { deps: { 'Acme/Widgets#2': ['acme/widgets#1'] } };
        assert.deepEqual(ip.blockersOf(plan, 'acme/widgets#2'), ['acme/widgets#1']);
        assert.deepEqual(ip.blockersOf(plan, 'acme/widgets#3'), []);
    });

    test('displayRef shortens GitHub keys only', function () {
        var ip = loadIssuePlan();
        assert.equal(ip.displayRef('acme/widgets#12'), '#12');
        assert.equal(ip.displayRef('gh-12'), '#12');
        assert.equal(ip.displayRef(12), '#12');
        assert.equal(ip.displayRef('PROJ-7'), 'PROJ-7');
    });
});

suite('issuePlan — decideNextSteps', function () {
    var empty = { blockedBy: [], deps: {} };

    test('no sub-issues → empty; all closed → complete', function () {
        var ip = loadIssuePlan();
        assert.equal(ip.decideNextSteps([], empty, PLAN_CFG, neverClosed).type, 'empty');
        assert.equal(ip.decideNextSteps(null, empty, PLAN_CFG, neverClosed).type, 'empty');
        var d = ip.decideNextSteps([view(1, 'closed'), view(2, 'Done')], empty, PLAN_CFG, neverClosed);
        assert.equal(d.type, 'complete');
        assert.equal(d.total, 2);
    });

    test('starts the first ready sub-issue; a started one takes the slot', function () {
        var ip = loadIssuePlan();
        var d = ip.decideNextSteps([view(1, 'closed'), view(2, 'open'), view(3, 'open')], empty, PLAN_CFG, neverClosed);
        assert.equal(d.type, 'start');
        assert.deepEqual(d.start.map(function (c) { return c.key; }), ['acme/widgets#2']);
        var busy = ip.decideNextSteps([view(2, 'open', ['agent:dev']), view(3, 'open')], empty, PLAN_CFG, neverClosed);
        assert.equal(busy.type, 'wait');
    });

    test('recorded blockers gate a sub-issue; when nothing is ready it waits', function () {
        var ip = loadIssuePlan();
        var plan = { blockedBy: [], deps: { 'acme/widgets#2': ['acme/widgets#9'] } };
        var d = ip.decideNextSteps([view(2, 'open')], plan, PLAN_CFG, neverClosed);
        assert.equal(d.type, 'wait');
        var unblocked = ip.decideNextSteps([view(2, 'open')], plan, PLAN_CFG, function () { return true; });
        assert.equal(unblocked.type, 'start');
    });

    test('a blocker of the parent itself → blocked', function () {
        var ip = loadIssuePlan();
        var d = ip.decideNextSteps([view(2, 'open')], { blockedBy: ['x#1'], deps: {} }, PLAN_CFG, neverClosed);
        assert.equal(d.type, 'blocked');
    });

    test('labels on the Jira field shape are understood', function () {
        var ip = loadIssuePlan();
        var started = { key: 'k', status: 'open', fields: { labels: ['agent:dev'] } };
        assert.equal(ip.decideNextSteps([started], empty, PLAN_CFG, neverClosed).type, 'wait');
    });

    test('comments name the started sub-issues and the completed plan', function () {
        var ip = loadIssuePlan();
        assert.equal(ip.renderStartComment({ start: [view(2), view(3)] }, PLAN_CFG),
            'Starting #2, #3 (label `agent:dev`).');
        assert.equal(ip.renderStartComment({ start: [view(2)] },
            { devLabel: 'agent:dev', devAssignee: 'ai-teammate', plannedLabel: 'ai_planned', maxParallel: 1 }),
            'Starting #2 (label `agent:dev`, assignee `ai-teammate`).');
        assert.contains(ip.renderCompleteComment({ total: 4 }), 'All 4 sub-issues');
    });
});
