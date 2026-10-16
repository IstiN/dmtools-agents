/**
 * Unit tests for js/createPlannedSubIssues.js — the issue_planning post-action.
 *
 * The tracker is a recording fake: these tests are about what the post-action
 * decides from outputs/plan.json (keep whole, create children in order, stay
 * idempotent, never mark a broken or partial plan as planned), not about the
 * provider calls (those are covered in test_trackers.js).
 */

function fakeTracker(opts) {
    opts = opts || {};
    var t = {
        labelsAdded: [],
        labelsRemoved: [],
        comments: [],
        created: [],
        usagePosts: [],
        addLabel: function (key, label) { t.labelsAdded.push({ key: key, label: label }); },
        removeLabel: function (key, label) { t.labelsRemoved.push({ key: key, label: label }); },
        postComment: function (key, text) { t.comments.push({ key: key, text: text }); },
        createTicketWithParent: function (project, type, title, body, parentKey) {
            if (opts.failAt === t.created.length + 1) throw new Error('API down');
            var childKey = 'acme/widgets#' + (100 + t.created.length + 1);
            t.created.push({ project: project, type: type, title: title, body: body, parentKey: parentKey, key: childKey });
            return childKey;
        }
    };
    return t;
}

function loadPostAction(files, tracker, projectConfig) {
    var fileRead = function (arg) {
        var p = typeof arg === 'string' ? arg : arg && arg.path;
        if (files[p] !== undefined) return files[p];
        throw new Error('not found: ' + p);
    };
    return loadModule(
        'js/createPlannedSubIssues.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': { loadProjectConfig: function () { return projectConfig || {}; } },
            './common/trackers.js': { createTracker: function () { return tracker; } },
            './common/issuePlan.js': loadModule('js/common/issuePlan.js', makeRequire({}), {}),
            './common/tokenUsageComment.js': {
                postTokenUsageComments: function (key, ctx) { tracker.usagePosts.push({ key: key, ctx: ctx }); }
            }
        }),
        { file_read: fileRead }
    );
}

function params(labels) {
    return {
        ticket: { key: 'acme/widgets#12', fields: { labels: labels || [] } },
        metadata: { contextId: 'issue_planning' },
        jobParams: { customParams: {} }
    };
}

var SPLIT_PLAN = JSON.stringify({
    split: true,
    reason: 'Two deliverables.',
    children: [
        { title: 'Add the model', bodyFile: 'outputs/plan/step-1.md' },
        { title: 'Add the report', bodyFile: 'outputs/plan/step-2.md' }
    ]
});
var SPLIT_FILES = {
    'outputs/plan.json': SPLIT_PLAN,
    'outputs/plan/step-1.md': 'Model body',
    'outputs/plan/step-2.md': 'Report body'
};

suite('createPlannedSubIssues — split', function () {
    test('creates the children in order under the parent, then marks the parent planned and lists them', function () {
        var tracker = fakeTracker();
        var result = loadPostAction(SPLIT_FILES, tracker).action(params());

        assert.equal(result.success, true, result.error);
        assert.deepEqual(result.created, ['acme/widgets#101', 'acme/widgets#102']);
        assert.equal(tracker.created[0].title, 'Add the model');
        assert.equal(tracker.created[0].parentKey, 'acme/widgets#12');
        assert.equal(tracker.created[0].body.indexOf('Part of #12 — step 1 of 2'), 0);
        assert.contains(tracker.created[0].body, 'Model body');
        assert.contains(tracker.created[1].body, 'step 2 of 2');

        assert.deepEqual(tracker.labelsAdded, [{ key: 'acme/widgets#12', label: 'ai_planned' }]);
        var planComment = tracker.comments[tracker.comments.length - 1].text;
        assert.contains(planComment, '1. #101');
        assert.contains(planComment, '2. #102');
        assert.contains(planComment, 'Two deliverables.');
    });

    test('a child that cannot be created stops the run: no planned label, a comment lists what exists', function () {
        var tracker = fakeTracker({ failAt: 2 });
        var result = loadPostAction(SPLIT_FILES, tracker).action(params());

        assert.equal(result.success, false);
        assert.deepEqual(result.created, ['acme/widgets#101']);
        assert.equal(tracker.labelsAdded.length, 0, 'a partial plan is never marked planned');
        var comment = tracker.comments[0].text;
        assert.contains(comment, 'step 2 of 2');
        assert.contains(comment, 'API down');
        assert.contains(comment, 'Already created: #101');
    });

    test('Jira projects pass their project key and the Story type', function () {
        var tracker = fakeTracker();
        loadPostAction(SPLIT_FILES, tracker, { jira: { project: 'PROJ' } }).action(params());
        assert.equal(tracker.created[0].project, 'PROJ');
        assert.equal(tracker.created[0].type, 'Story');
    });
});

suite('createPlannedSubIssues — keep whole, guards, broken plans', function () {
    test('split:false adds the dev label to the issue and explains why', function () {
        var tracker = fakeTracker();
        var result = loadPostAction({ 'outputs/plan.json': '{"split": false, "reason": "One small change."}' }, tracker)
            .action(params());

        assert.equal(result.success, true);
        assert.equal(result.split, false);
        assert.deepEqual(tracker.labelsAdded, [{ key: 'acme/widgets#12', label: 'agent:dev' }]);
        assert.equal(tracker.created.length, 0);
        assert.contains(tracker.comments[0].text, 'One small change.');
    });

    test('the dev label comes from the project issuePlanning config', function () {
        var tracker = fakeTracker();
        loadPostAction({ 'outputs/plan.json': '{"split": false, "reason": "r"}' }, tracker,
            { issuePlanning: { devLabel: 'start-dev' } }).action(params());
        assert.deepEqual(tracker.labelsAdded, [{ key: 'acme/widgets#12', label: 'start-dev' }]);
    });

    test('an already planned parent is left alone (no duplicate children)', function () {
        var tracker = fakeTracker();
        var result = loadPostAction(SPLIT_FILES, tracker).action(params(['ai_planned']));

        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        assert.equal(tracker.created.length, 0);
        assert.equal(tracker.labelsAdded.length, 0);
    });

    test('a missing plan creates nothing, labels nothing and says so', function () {
        var tracker = fakeTracker();
        var result = loadPostAction({}, tracker).action(params());

        assert.equal(result.success, false);
        assert.equal(tracker.created.length, 0);
        assert.equal(tracker.labelsAdded.length, 0);
        assert.contains(tracker.comments[0].text, 'no usable plan');
        assert.contains(tracker.comments[0].text, '`agent:dev`');
    });

    test('token usage is posted through the run tracker, whatever the outcome', function () {
        [{ 'outputs/plan.json': '{"split": false, "reason": "r"}' }, {}].forEach(function (files) {
            var tracker = fakeTracker();
            loadPostAction(files, tracker).action(params());
            assert.equal(tracker.usagePosts.length, 1);
            assert.equal(tracker.usagePosts[0].key, 'acme/widgets#12');
            assert.ok(tracker.usagePosts[0].ctx.tracker === tracker, 'never falls back to a Jira tracker');
        });
    });

    test('the WIP label of the context is cleared', function () {
        var tracker = fakeTracker();
        loadPostAction({ 'outputs/plan.json': '{"split": false, "reason": "r"}' }, tracker).action(params());
        assert.deepEqual(tracker.labelsRemoved, [{ key: 'acme/widgets#12', label: 'issue_planning_wip' }]);
    });
});
