/**
 * Unit tests for js/common/issuePlan.js — the issue planning contract shared by
 * the issue_planning post-action and the SM advance_plan localAction.
 *
 * Tests: config resolution, outputs/plan.json validation, child body and
 * comment rendering, the sequential next-step decision.
 */

function loadIssuePlan() {
    return loadModule('js/common/issuePlan.js', makeRequire({}), {});
}

function filesReader(files) {
    return function (path) { return files[path] !== undefined ? files[path] : ''; };
}

suite('issuePlan — resolvePlanningConfig', function () {
    test('defaults apply without any config', function () {
        var cfg = loadIssuePlan().resolvePlanningConfig(null, null);
        assert.deepEqual(cfg, { devLabel: 'agent:dev', plannedLabel: 'ai_planned', maxChildren: 8, planFile: 'outputs/plan.json' });
    });

    test('project config overrides the defaults and customParams override the project', function () {
        var cfg = loadIssuePlan().resolvePlanningConfig(
            { issuePlanning: { devLabel: 'start-dev', maxChildren: 5 } },
            { issuePlanning: { maxChildren: '3', plannedLabel: 'planned' } }
        );
        assert.equal(cfg.devLabel, 'start-dev');
        assert.equal(cfg.plannedLabel, 'planned');
        assert.equal(cfg.maxChildren, 3);
        assert.equal(cfg.planFile, 'outputs/plan.json');
    });

    test('invalid values fall back to the defaults', function () {
        var cfg = loadIssuePlan().resolvePlanningConfig({ issuePlanning: { devLabel: '  ', maxChildren: 0 } }, {});
        assert.equal(cfg.devLabel, 'agent:dev');
        assert.equal(cfg.maxChildren, 8);
    });
});

suite('issuePlan — parsePlan', function () {
    var plan = loadIssuePlan();
    var cfg = plan.resolvePlanningConfig({}, {});

    test('split:false is a valid plan with no children', function () {
        var p = plan.parsePlan('{"split": false, "reason": "small"}', filesReader({}), cfg);
        assert.equal(p.ok, true);
        assert.equal(p.split, false);
        assert.equal(p.reason, 'small');
        assert.equal(p.children.length, 0);
    });

    test('split:true reads child bodies from bodyFile and keeps the order', function () {
        var p = plan.parsePlan(JSON.stringify({
            split: true, reason: 'two parts',
            children: [
                { title: 'First', bodyFile: 'outputs/plan/step-1.md' },
                { title: 'Second', body: 'inline body' }
            ]
        }), filesReader({ 'outputs/plan/step-1.md': 'file body' }), cfg);
        assert.equal(p.ok, true, p.error);
        assert.equal(p.split, true);
        assert.deepEqual(p.children, [{ title: 'First', body: 'file body' }, { title: 'Second', body: 'inline body' }]);
    });

    test('a missing or broken plan file is rejected with a readable error', function () {
        assert.equal(plan.parsePlan('', filesReader({}), cfg).ok, false);
        assert.contains(plan.parsePlan('{not json', filesReader({}), cfg).error, 'not valid JSON');
        assert.contains(plan.parsePlan('[]', filesReader({}), cfg).error, 'JSON object');
        assert.contains(plan.parsePlan('{"split": "yes"}', filesReader({}), cfg).error, '"split"');
    });

    test('a split needs 2 children and at most maxChildren', function () {
        var one = plan.parsePlan('{"split": true, "children": [{"title": "a", "body": "b"}]}', filesReader({}), cfg);
        assert.contains(one.error, 'at least 2');
        var many = [];
        for (var i = 0; i < 9; i++) many.push({ title: 't' + i, body: 'b' });
        var tooMany = plan.parsePlan(JSON.stringify({ split: true, children: many }), filesReader({}), cfg);
        assert.contains(tooMany.error, 'exceed the limit of 8');
    });

    test('every child needs a title and a non-empty body', function () {
        var noTitle = plan.parsePlan('{"split": true, "children": [{"body": "b"}, {"title": "t", "body": "b"}]}', filesReader({}), cfg);
        assert.contains(noTitle.error, 'child 1 has no title');
        var noBody = plan.parsePlan('{"split": true, "children": [{"title": "a", "bodyFile": "missing.md"}, {"title": "t", "body": "b"}]}', filesReader({}), cfg);
        assert.contains(noBody.error, 'missing.md');
    });
});

suite('issuePlan — rendering', function () {
    var plan = loadIssuePlan();
    var cfg = plan.resolvePlanningConfig({}, {});

    test('displayRef shortens GitHub keys and keeps other keys', function () {
        assert.equal(plan.displayRef('acme/widgets#12'), '#12');
        assert.equal(plan.displayRef('gh-12'), '#12');
        assert.equal(plan.displayRef(12), '#12');
        assert.equal(plan.displayRef('PROJ-7'), 'PROJ-7');
    });

    test('a child body names its parent and its step before the description', function () {
        var body = plan.renderChildBody('acme/widgets#12', 2, 3, 'Do the thing.');
        assert.equal(body.indexOf('Part of #12 — step 2 of 3'), 0);
        assert.contains(body, '\n\nDo the thing.');
    });

    test('the plan comment carries the marker and the ordered steps', function () {
        var c = plan.renderPlanComment(['acme/widgets#13', 'acme/widgets#14'], 'why', cfg);
        assert.equal(c.indexOf(plan.PLAN_MARKER), 0);
        assert.contains(c, '1. #13');
        assert.contains(c, '2. #14');
        assert.contains(c, '`agent:dev`');
    });
});

suite('issuePlan — decideNextStep', function () {
    var plan = loadIssuePlan();
    var cfg = plan.resolvePlanningConfig({}, {});

    function child(n, state, labels) { return { key: 'acme/widgets#' + n, status: state, labels: labels || [] }; }

    test('no children: empty', function () {
        assert.equal(plan.decideNextStep([], cfg).type, 'empty');
        assert.equal(plan.decideNextStep(null, cfg).type, 'empty');
    });

    test('the first open, unstarted child starts', function () {
        var s = plan.decideNextStep([child(1, 'closed', ['agent:dev']), child(2, 'open'), child(3, 'open')], cfg);
        assert.equal(s.type, 'start');
        assert.equal(s.child.key, 'acme/widgets#2');
        assert.equal(s.index, 2);
        assert.equal(s.total, 3);
    });

    test('a started first open child is waited on — later children never start early', function () {
        var s = plan.decideNextStep([child(1, 'open', ['agent:dev']), child(2, 'open')], cfg);
        assert.equal(s.type, 'wait');
        assert.equal(s.child.key, 'acme/widgets#1');
    });

    test('every child closed: complete', function () {
        var s = plan.decideNextStep([child(1, 'closed'), child(2, 'CLOSED')], cfg);
        assert.equal(s.type, 'complete');
        assert.equal(s.total, 2);
    });

    test('the dev label comes from the config', function () {
        var custom = plan.resolvePlanningConfig({ issuePlanning: { devLabel: 'start-dev' } }, {});
        assert.equal(plan.decideNextStep([child(1, 'open', ['agent:dev'])], custom).type, 'start');
        assert.equal(plan.decideNextStep([child(1, 'open', ['start-dev'])], custom).type, 'wait');
    });

    test('step comments name the step and the label', function () {
        var s = plan.decideNextStep([child(1, 'open')], cfg);
        assert.equal(plan.renderStepComment(s, cfg), 'Step 1 of 1: starting #1 (label `agent:dev`).');
        assert.contains(plan.renderCompleteComment({ total: 3 }), 'All 3 steps');
    });
});
