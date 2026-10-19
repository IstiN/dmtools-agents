/**
 * Unit tests for js/createSolutionDesignTicketsAndAssignForReview.js (gh-1086):
 *   - parseModuleAnalysisResponse characterization (valid/invalid AI responses)
 *   - action() orchestration: ticket creation, labeling, assignment, error paths
 *
 * All tracker and jiraHelpers dependencies are injected via makeRequire; no
 * real service is ever contacted.
 */

// ── Loader helpers ────────────────────────────────────────────────────────────

function makeTrackerMock() {
    var calls = { created: [], priorities: [], labels: [], comments: [] };
    var seq = 0;
    var tracker = {
        createTicketWithParent: function(projectKey, type, summary, description, parentKey) {
            seq += 1;
            calls.created.push({
                projectKey: projectKey,
                type: type,
                summary: summary,
                description: description,
                parentKey: parentKey
            });
            return 'PROJ-' + (100 + seq);
        },
        setPriority: function(key, priority) { calls.priorities.push([key, priority]); },
        addLabel: function(key, label) { calls.labels.push([key, label]); },
        postComment: function(key, comment) { calls.comments.push([key, comment]); }
    };
    tracker._calls = calls;
    return tracker;
}

function loadActionModule(tracker, assignStub) {
    return loadModule(
        'js/createSolutionDesignTicketsAndAssignForReview.js',
        makeRequire({
            './common/jiraHelpers.js': {
                assignForReview: assignStub || function(ticketKey, initiatorId, wipLabel, targetStatus, tr) {
                    return { success: true };
                },
                extractTicketKey: function(result) {
                    if (result && typeof result === 'object' && result.key) return result.key;
                    if (typeof result === 'string' && result.trim()) return result.trim();
                    return null;
                }
            },
            './config.js': configModule,
            './common/trackers.js': {
                createTracker: function(config, customParams) {
                    tracker._createTrackerArgs = [config, customParams];
                    return tracker;
                }
            }
        }),
        {}
    );
}

function makeParams(response, overrides) {
    var params = {
        ticket: { key: 'PROJ-1', fields: { summary: 'My summary' } },
        initiator: 'user1',
        metadata: { contextId: 'solution_design' },
        jobParams: { customParams: { keep: true } },
        response: response
    };
    if (overrides) {
        for (var k in overrides) {
            if (overrides[k] === undefined) delete params[k];
            else params[k] = overrides[k];
        }
    }
    return params;
}

// ── action — success paths ────────────────────────────────────────────────────

suite('createSolutionDesignTicketsAndAssignForReview.action — success', function() {

    test('creates one subtask per flagged module from a JSON string response', function() {
        var tracker = makeTrackerMock();
        var mod = loadActionModule(tracker);
        var seenAssign = [];
        var assignStub = function(ticketKey, initiatorId, wipLabel, targetStatus, tr) {
            seenAssign.push([ticketKey, initiatorId, wipLabel, targetStatus, tr]);
            return { success: true };
        };
        var assignMod = (function() {
            // reload with the recording assign stub
            return loadModule(
                'js/createSolutionDesignTicketsAndAssignForReview.js',
                makeRequire({
                    './common/jiraHelpers.js': {
                        assignForReview: assignStub,
                        extractTicketKey: function(r) { return (r && r.key) || (typeof r === 'string' ? r : null); }
                    },
                    './config.js': configModule,
                    './common/trackers.js': { createTracker: function() { return tracker; } }
                }),
                {}
            );
        })();

        var result = assignMod.action(makeParams(JSON.stringify({
            core: true, api: true, ui: true, description: 'All modules needed'
        })));

        assert.equal(result.success, true);
        assert.equal(result.createdTickets.length, 3);
        assert.deepEqual(
            result.createdTickets.map(function(t) { return t.module; }),
            ['core', 'api', 'ui']
        );
        assert.ok(result.createdTickets.every(function(t) { return t.success === true; }));

        // subtask creation: one per module, in SOLUTION_DESIGN_MODULES order
        var created = tracker._calls.created;
        assert.equal(created.length, 3);
        assert.equal(created[0].summary, '[SD CORE] My summary');
        assert.equal(created[1].summary, '[SD API] My summary');
        assert.equal(created[2].summary, '[SD UI] My summary');
        created.forEach(function(c) {
            assert.equal(c.projectKey, 'PROJ');
            assert.equal(c.parentKey, 'PROJ-1');
            assert.ok(c.description.indexOf('PROJ-1') !== -1);
            assert.ok(c.description.indexOf('All modules needed') !== -1);
        });

        // priority + module label on every created subtask
        assert.deepEqual(tracker._calls.priorities, [
            ['PROJ-101', 'Medium'], ['PROJ-102', 'Medium'], ['PROJ-103', 'Medium']
        ]);
        assert.deepEqual(tracker._calls.labels, [
            ['PROJ-101', 'sd_core'], ['PROJ-102', 'sd_api'], ['PROJ-103', 'sd_ui'],
            ['PROJ-1', 'ai_solution_design_created']
        ]);

        // summary comment to the parent
        assert.equal(tracker._calls.comments.length, 1);
        assert.equal(tracker._calls.comments[0][0], 'PROJ-1');
        assert.ok(tracker._calls.comments[0][1].indexOf('Solution Design Analysis Results') !== -1);
        assert.ok(tracker._calls.comments[0][1].indexOf('Total Created:* 3') !== -1);

        // assignment last, with the context-derived WIP label
        assert.equal(seenAssign.length, 1);
        assert.equal(seenAssign[0][0], 'PROJ-1');
        assert.equal(seenAssign[0][1], 'user1');
        assert.equal(seenAssign[0][2], 'solution_design_wip');
        assert.equal(seenAssign[0][3], undefined);

        assert.ok(result.message.indexOf('created 3 solution design subtasks') !== -1);
        assert.deepEqual(result.moduleAnalysis, { core: true, api: true, ui: true, description: 'All modules needed' });
    });

    test('creates only the flagged modules (2 of 3)', function() {
        var tracker = makeTrackerMock();
        var mod = loadActionModule(tracker);
        var result = mod.action(makeParams({
            core: true, api: false, ui: true, description: 'core and ui'
        }));
        assert.equal(result.success, true);
        assert.equal(result.createdTickets.length, 2);
        assert.deepEqual(
            result.createdTickets.map(function(t) { return t.module; }),
            ['core', 'ui']
        );
        assert.equal(tracker._calls.created.length, 2);
        assert.deepEqual(
            tracker._calls.labels.slice(0, 2).map(function(p) { return p[1]; }),
            ['sd_core', 'sd_ui']
        );
    });

    test('subtask with unknown key still counts as created (no priority/label on it)', function() {
        var tracker = makeTrackerMock();
        var seq = 0;
        tracker.createTicketWithParent = function() {
            seq += 1;
            return seq === 1 ? { key: 'PROJ-OBJ' } : (seq === 2 ? 'PROJ-STR ' : null);
        };
        var mod = loadActionModule(tracker);
        var result = mod.action(makeParams({
            core: true, api: true, ui: true, description: 'mixed key shapes'
        }));
        assert.equal(result.success, true);
        assert.equal(result.createdTickets.length, 3);
        assert.equal(result.createdTickets[0].key, 'PROJ-OBJ');
        assert.equal(result.createdTickets[1].key, 'PROJ-STR');
        assert.equal(result.createdTickets[2].key, null);
        assert.ok(result.createdTickets.every(function(t) { return t.success === true; }));
        // unknown-key subtask gets no priority and no module label
        assert.deepEqual(tracker._calls.priorities, [['PROJ-OBJ', 'Medium'], ['PROJ-STR', 'Medium']]);
        assert.deepEqual(tracker._calls.labels, [['PROJ-OBJ', 'sd_core'], ['PROJ-STR', 'sd_api'], ['PROJ-1', 'ai_solution_design_created']]);
    });

    test('createTicketWithParent failure records the failed module and keeps going', function() {
        var tracker = makeTrackerMock();
        var seq = 0;
        tracker.createTicketWithParent = function() {
            seq += 1;
            if (seq === 1) throw new Error('jira down');
            return 'PROJ-OK';
        };
        var mod = loadActionModule(tracker);
        var result = mod.action(makeParams({
            core: true, api: true, ui: false, description: 'partial failure'
        }));
        assert.equal(result.success, true);
        assert.equal(result.createdTickets.length, 2);
        assert.equal(result.createdTickets[0].success, false);
        assert.ok(result.createdTickets[0].error.indexOf('jira down') !== -1);
        assert.equal(result.createdTickets[1].success, true);
        assert.ok(tracker._calls.comments[0][1].indexOf('Failed to Create') !== -1);
        assert.ok(tracker._calls.comments[0][1].indexOf('Total Created:* 1') !== -1);
    });

    test('assignForReview failure is returned as-is (label already added)', function() {
        var tracker = makeTrackerMock();
        var mod = loadActionModule(tracker, function() {
            return { success: false, error: 'transition blocked' };
        });
        var result = mod.action(makeParams({ core: true, api: false, ui: false, description: 'd' }));
        assert.deepEqual(result, { success: false, error: 'transition blocked' });
        // the ai_solution_design_created label is added before assignment
        assert.ok(tracker._calls.labels.some(function(p) { return p[0] === 'PROJ-1' && p[1] === 'ai_solution_design_created'; }));
    });

    test('missing metadata.contextId yields a null WIP label', function() {
        var tracker = makeTrackerMock();
        var seen = [];
        var mod = loadModule(
            'js/createSolutionDesignTicketsAndAssignForReview.js',
            makeRequire({
                './common/jiraHelpers.js': {
                    assignForReview: function(ticketKey, initiatorId, wipLabel) {
                        seen.push(wipLabel);
                        return { success: true };
                    },
                    extractTicketKey: function(r) { return (r && r.key) || null; }
                },
                './config.js': configModule,
                './common/trackers.js': { createTracker: function() { return tracker; } }
            }),
            {}
        );
        var result = mod.action(makeParams(
            { core: true, api: false, ui: false, description: 'd' },
            { metadata: {} }
        ));
        assert.equal(result.success, true);
        assert.equal(seen[0], null);
    });

    test('customParams resolution prefers jobParams.customParams over params.customParams', function() {
        var tracker = makeTrackerMock();
        var mod = loadActionModule(tracker);
        mod.action(makeParams({ core: false, api: false, ui: false, description: 'd' }));
        assert.deepEqual(tracker._createTrackerArgs, [null, { keep: true }]);
    });
});

// ── action — invalid AI response ──────────────────────────────────────────────

suite('createSolutionDesignTicketsAndAssignForReview.action — invalid response', function() {

    var INVALID = [
        ['broken JSON string', '{not json'],
        ['null response', null],
        ['number response', 42],
        ['array response', []],
        ['missing description', { core: true, api: true, ui: false }],
        ['non-boolean flag', { core: 'yes', api: true, ui: false, description: 'd' }],
        ['non-string description', { core: true, api: true, ui: false, description: 7 }],
        ['empty object', {}]
    ];

    INVALID.forEach(function(pair) {
        test('invalid response (' + pair[0] + ') posts an error comment and fails without side effects', function() {
            var tracker = makeTrackerMock();
            var assignCalls = 0;
            var mod = loadActionModule(tracker, function() { assignCalls += 1; return { success: true }; });
            var result = mod.action(makeParams(pair[1]));

            assert.equal(result.success, false);
            assert.equal(result.error, 'Invalid AI response format for module analysis');
            assert.equal(tracker._calls.created.length, 0, 'no subtasks created');
            assert.equal(tracker._calls.labels.length, 0, 'no label added');
            assert.equal(assignCalls, 0, 'no assignment');
            // exactly one comment: the error comment
            assert.equal(tracker._calls.comments.length, 1);
            assert.equal(tracker._calls.comments[0][0], 'PROJ-1');
            assert.ok(tracker._calls.comments[0][1].indexOf('*Error:* Invalid AI response format for module analysis') !== -1);
        });
    });

    test('error comment failure on the invalid path is swallowed', function() {
        var tracker = makeTrackerMock();
        tracker.postComment = function() { throw new Error('comment failed'); };
        var mod = loadActionModule(tracker);
        var result = mod.action(makeParams(null));
        assert.equal(result.success, false);
        assert.equal(result.error, 'Invalid AI response format for module analysis');
    });
});

// ── action — unexpected errors ────────────────────────────────────────────────

suite('createSolutionDesignTicketsAndAssignForReview.action — workflow errors', function() {

    test('missing ticket yields the workflow error result and an error comment', function() {
        var tracker = makeTrackerMock();
        var mod = loadActionModule(tracker);
        var result = mod.action(makeParams({ core: true, api: true, ui: false, description: 'd' }, { ticket: undefined }));
        assert.equal(result.success, false);
        assert.ok(result.error.indexOf('TypeError') !== -1 || result.error.indexOf("Cannot read propert") !== -1 ||
            result.error.indexOf("Cannot read properties") !== -1);
        // no ticket key → no comment possible
        assert.equal(tracker._calls.comments.length, 0);
    });

    test('workflow error comment failure is swallowed', function() {
        var tracker = makeTrackerMock();
        tracker.postComment = function(key) {
            if (key === 'PROJ-1') throw new Error('no comment allowed');
            // subtask comments never reach here
            throw new Error('unexpected comment target: ' + key);
        };
        var mod = loadActionModule(tracker);
        var result = mod.action(makeParams({ core: true, api: true, ui: false, description: 'd' }, { ticket: undefined }));
        assert.equal(result.success, false);
    });

    test('tracker failure during summary comment does not fail the action', function() {
        var tracker = makeTrackerMock();
        var mod = loadActionModule(tracker);
        // break only postComment (called after ticket creation succeeded)
        tracker.postComment = function(key, comment) {
            if (comment.indexOf('Solution Design Analysis Results') === 0) throw new Error('comment endpoint down');
            throw new Error('unexpected comment: ' + comment.substring(0, 30));
        };
        var result = mod.action(makeParams({ core: true, api: false, ui: false, description: 'd' }));
        assert.equal(result.success, true);
        assert.equal(result.createdTickets.length, 1);
    });
});
