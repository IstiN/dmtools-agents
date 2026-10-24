/**
 * Unit tests for js/enhanceSolutionDesignDescriptionAndAssess.js
 * (gh-1228 CRAP characterization).
 *
 * Pins parseSDCoreEnhancementResponse's file-reading contract (via action)
 * and the action() update/assign flow including every non-fatal path.
 */

/** Token-usage double for the module under test; g.__tokenUsage overrides the poster. */
function tokenUsageMock(g) {
    return Object.assign({ customParamsOf: function(params) {
        return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
    } }, g.__tokenUsage || { postTokenUsageComments: function() {} });
}

/** Require-spec map for enhanceSolutionDesignDescriptionAndAssess; g.__* keys inject doubles. */
function enhanceSDRequireMap(g, outputFilesMock) {
    return {
        './common/jiraHelpers.js': { extractTicketKey: function() { return null; } },
        './config.js': configModule,
        './configLoader.js': g.__configLoader || { loadProjectConfig: function() { return {}; } },
        './common/outputFiles.js': outputFilesMock,
        './common/tokenUsageComment.js': tokenUsageMock(g),
        './common/trackers.js': { createTracker: function(config, customParams) { return g.__tracker; } }
    };
}

function loadEnhanceSD(mocks) {
    var defaults = {
        file_read: function() { return null; },
        file_write: function() {}
    };
    var g = Object.assign({}, defaults, mocks || {});
    var outputFilesMock = g.__files || { readOutputFile: function(name) {
        return name === 'response.md' ? 'New description' : 'graph TD; A-->B;';
    } };
    return loadModule(
        'js/enhanceSolutionDesignDescriptionAndAssess.js',
        makeRequire(enhanceSDRequireMap(g, outputFilesMock)),
        g
    );
}

function sdTracker(overrides) {
    var calls = { updateDescription: [], updateField: [], assignForReview: [] };
    var t = {
        calls: calls,
        updateDescription: function(key, description) { calls.updateDescription.push({ key: key, description: description }); },
        updateField: function(key, field, value) { calls.updateField.push({ key: key, field: field, value: value }); },
        assignForReview: function(key, initiator, wipLabel, status) {
            calls.assignForReview.push({ key: key, initiator: initiator, wipLabel: wipLabel, status: status });
            return { success: true };
        }
    };
    for (var k in (overrides || {})) { t[k] = overrides[k]; }
    return t;
}

function enhanceParams(overrides) {
    return Object.assign({
        ticket: { key: 'PROJ-20' },
        initiator: 'acc',
        metadata: { contextId: 'enhance_sd' },
        jobParams: {}
    }, overrides || {});
}

suite('enhanceSolutionDesignDescriptionAndAssess — parse (via action)', function() {

    test('happy path — description and diagram read, ticket updated 2/2', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({ __tracker: tracker });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, true, 'action succeeds');
        assert.contains(r.message, '2/2');
        assert.equal(r.enhancementData.description, 'New description', 'description trimmed/passed through');
        assert.equal(r.enhancementData.diagram, 'graph TD; A-->B;', 'diagram read from diagram.md');
        assert.equal(r.updateResults.descriptionUpdated, true, 'description updated');
        assert.equal(r.updateResults.diagramUpdated, true, 'diagram updated');
        assert.deepEqual(tracker.calls.updateDescription, [{ key: 'PROJ-20', description: 'New description' }], 'description pushed to tracker');
        assert.equal(tracker.calls.updateField.length, 1, 'diagrams field updated once');
        assert.contains(tracker.calls.updateField[0].value, 'graph TD; A-->B;', 'diagram wrapped for the diagrams field');
        assert.deepEqual(
            [tracker.calls.assignForReview[0].key, tracker.calls.assignForReview[0].initiator,
             tracker.calls.assignForReview[0].wipLabel, tracker.calls.assignForReview[0].status],
            ['PROJ-20', 'acc', 'enhance_sd_wip', configModule.STATUSES.READY_FOR_DEVELOPMENT],
            'assign-for-review flow ran with the context WIP label'
        );
    });

    test('missing description file fails the action before any tracker call', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({
            __tracker: tracker,
            __files: { readOutputFile: function(name) {
                return name === 'response.md' ? '' : 'graph TD; A-->B;';
            } }
        });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, false, 'fails without a description');
        assert.equal(r.error, 'Failed to read enhancement data from output files', 'error message pinned');
        assert.equal(tracker.calls.updateDescription.length, 0, 'no tracker writes');
        assert.equal(tracker.calls.assignForReview.length, 0, 'no assignment');
    });

    test('description read failure (throw) fails the action', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({
            __tracker: tracker,
            __files: { readOutputFile: function(name) {
                if (name === 'response.md') { throw new Error('disk error'); }
                return 'graph TD; A-->B;';
            } }
        });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, false, 'fails on read error');
        assert.equal(r.error, 'Failed to read enhancement data from output files', 'same contract error');
        assert.equal(tracker.calls.updateDescription.length, 0, 'no tracker writes');
    });

    test('whitespace-only description is rejected', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({
            __tracker: tracker,
            __files: { readOutputFile: function(name) {
                return name === 'response.md' ? '   \n\t  ' : 'graph TD; A-->B;';
            } }
        });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, false, 'blank description fails');
        assert.equal(r.error, 'Failed to read enhancement data from output files', 'contract error');
        assert.equal(tracker.calls.updateDescription.length, 0, 'no tracker writes');
    });

    test('missing diagram file falls back to the default CORE_GRAPH diagram', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({
            __tracker: tracker,
            __files: { readOutputFile: function(name) {
                return name === 'response.md' ? 'New description' : '';
            } }
        });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, true, 'still succeeds');
        assert.contains(r.message, '2/2');
        assert.equal(r.enhancementData.diagram, configModule.DIAGRAM_DEFAULTS.CORE_GRAPH, 'default diagram used');
        assert.contains(tracker.calls.updateField[0].value, configModule.DIAGRAM_DEFAULTS.CORE_GRAPH, 'default diagram pushed');
    });

    test('diagram read failure falls back to the default CORE_GRAPH diagram', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({
            __tracker: tracker,
            __files: { readOutputFile: function(name) {
                if (name === 'diagram.md') { throw new Error('disk error'); }
                return 'New description';
            } }
        });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, true, 'still succeeds');
        assert.equal(r.enhancementData.diagram, configModule.DIAGRAM_DEFAULTS.CORE_GRAPH, 'default diagram used');
    });

    test('whitespace-only diagram falls back to the default CORE_GRAPH diagram', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({
            __tracker: tracker,
            __files: { readOutputFile: function(name) {
                return name === 'response.md' ? 'New description' : '   ';
            } }
        });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, true, 'still succeeds');
        assert.equal(r.enhancementData.diagram, configModule.DIAGRAM_DEFAULTS.CORE_GRAPH, 'trimmed-empty diagram replaced by default');
    });
});

suite('enhanceSolutionDesignDescriptionAndAssess — action flow', function() {

    test('failed assignment short-circuits with the assign result', function() {
        var tracker = sdTracker({
            assignForReview: function() { return { success: false, error: 'assignee unknown' }; }
        });
        var mod = loadEnhanceSD({ __tracker: tracker });

        var r = mod.action(enhanceParams());

        assert.deepEqual(r, { success: false, error: 'assignee unknown' }, 'assign failure returned as-is');
        assert.equal(tracker.calls.updateDescription.length, 1, 'description was already updated before the assign');
    });

    test('tracker update failures are collected — action still succeeds with 0/2', function() {
        var tracker = sdTracker({
            updateDescription: function() { throw new Error('desc update failed'); },
            updateField: function() { throw new Error('field update failed'); }
        });
        var mod = loadEnhanceSD({ __tracker: tracker });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, true, 'update failures are non-fatal');
        assert.contains(r.message, '0/2');
        assert.equal(r.updateResults.descriptionUpdated, false, 'description not updated');
        assert.equal(r.updateResults.diagramUpdated, false, 'diagram not updated');
        assert.equal(r.updateResults.errors.length, 2, 'both errors recorded');
        assert.contains(r.updateResults.errors[0], 'desc update failed');
        assert.contains(r.updateResults.errors[1], 'field update failed');
    });

    test('token usage comment failure is non-fatal', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({
            __tracker: tracker,
            __tokenUsage: { postTokenUsageComments: function() { throw new Error('usage failed'); } }
        });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, true, 'still succeeds');
        assert.contains(r.message, '2/2');
    });

    test('partial update success reports 1/2', function() {
        var tracker = sdTracker({
            updateField: function() { throw new Error('field update failed'); }
        });
        var mod = loadEnhanceSD({ __tracker: tracker });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, true, 'still succeeds');
        assert.contains(r.message, '1/2');
        assert.equal(r.updateResults.descriptionUpdated, true, 'description updated');
        assert.equal(r.updateResults.diagramUpdated, false, 'diagram not updated');
    });

    test('tracker creation failure is reported as a failure result (outer catch)', function() {
        var mod = loadEnhanceSD({
            __tracker: sdTracker(),
            __configLoader: { loadProjectConfig: function() { throw new Error('no config'); } }
        });

        var r = mod.action(enhanceParams());

        assert.equal(r.success, false, 'fails');
        assert.contains(r.error, 'no config');
    });

    test('missing ticket key is reported as a failure result (outer catch)', function() {
        var tracker = sdTracker();
        var mod = loadEnhanceSD({ __tracker: tracker });

        var r = mod.action({ jobParams: {} });

        assert.equal(r.success, false, 'fails without a ticket key');
        assert.ok(r.error.indexOf('TypeError') !== -1 || r.error.indexOf('key') !== -1, 'underlying error surfaced');
        assert.equal(tracker.calls.updateDescription.length, 0, 'no tracker writes');
    });
});

// ── Extracted step helpers (gh-1228 CRAP split) ─────────────────────────────

suite('enhanceSolutionDesignDescriptionAndAssess — extracted helpers', function() {

    test('resolveWipLabel derives the context label or null', function() {
        var mod = loadEnhanceSD({});
        assert.equal(mod.resolveWipLabel({ metadata: { contextId: 'enhance_sd' } }), 'enhance_sd_wip', 'context label derived');
        assert.equal(mod.resolveWipLabel({}), null, 'no metadata → null');
        assert.equal(mod.resolveWipLabel({ metadata: {} }), null, 'no contextId → null');
    });

    test('enhancementFailureResult keeps the uniform failure shape', function() {
        var mod = loadEnhanceSD({});
        assert.deepEqual(mod.enhancementFailureResult('boom'), { success: false, error: 'boom' }, 'shape pinned');
    });

    test('countSuccessfulUpdates counts landed updates', function() {
        var mod = loadEnhanceSD({});
        assert.equal(mod.countSuccessfulUpdates({ descriptionUpdated: true, diagramUpdated: true }), 2, 'both landed');
        assert.equal(mod.countSuccessfulUpdates({ descriptionUpdated: true, diagramUpdated: false }), 1, 'one landed');
        assert.equal(mod.countSuccessfulUpdates({ descriptionUpdated: false, diagramUpdated: false }), 0, 'none landed');
    });

    test('parseSDCoreEnhancementResponse returns the trimmed pair on success', function() {
        var mod = loadEnhanceSD({
            __files: { readOutputFile: function(name) {
                return name === 'response.md' ? '  Desc  ' : ' graph ';
            } }
        });
        assert.deepEqual(
            mod.parseSDCoreEnhancementResponse('PROJ-20', null),
            { description: 'Desc', diagram: 'graph' },
            'both values trimmed'
        );
    });

    test('parseSDCoreEnhancementResponse returns null when the description is unusable', function() {
        var mod = loadEnhanceSD({ __files: { readOutputFile: function() { return ''; } } });
        assert.equal(mod.parseSDCoreEnhancementResponse('PROJ-20', null), null, 'null without a description');
    });

    test('postTokenUsageCommentsSafely posts and swallows failures', function() {
        var calls = [];
        var ok = loadEnhanceSD({
            __tokenUsage: { postTokenUsageComments: function(key, opts) { calls.push({ key: key, opts: opts }); } }
        });
        var params = { initiator: 'acc', jobParams: { customParams: { trackerProvider: 'jira' } } };
        ok.postTokenUsageCommentsSafely(params, 'PROJ-20');
        assert.equal(calls.length, 1, 'posted once');
        assert.equal(calls[0].key, 'PROJ-20');

        var failing = loadEnhanceSD({
            __tokenUsage: { postTokenUsageComments: function() { throw new Error('usage down'); } }
        });
        assert.doesNotThrow(function() { failing.postTokenUsageCommentsSafely(params, 'PROJ-20'); }, 'failure swallowed');
    });
});
