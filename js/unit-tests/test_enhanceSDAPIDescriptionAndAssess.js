/**
 * Unit tests for js/enhanceSDAPIDescriptionAndAssess.js
 *
 * Characterization tests (gh-1191): pin the current behaviour of
 * parseSDAPIEnhancementResponse and action() so the CRAP refactor
 * (pure-helper extraction) cannot change it.
 *
 * Covers: string/object responses, invalid JSON, wrong shapes, the empty
 * diagram default, ticket update fan-out (description / Diagrams field /
 * needs_api_implementation label), the 3-step success count, the
 * assignForReview failure pass-through and the fatal-throw contract.
 */

function d2Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function loadEnhanceSDAPI(fileMap, extraGlobals, trackerMockOverrides) {
    var globals = {
        jira_update_description: function (args) { return null; },
        jira_update_field: function (args) { return null; },
        jira_add_label: function (args) { return null; },
        jira_assign_ticket_to: function (args) { return null; },
        jira_move_to_status: function (args) { return null; },
        jira_remove_label: function (args) { return null; }
    };
    for (var k in (extraGlobals || {})) { globals[k] = extraGlobals[k]; }

    return loadModule(
        'js/enhanceSDAPIDescriptionAndAssess.js',
        makeRequire({
            './common/jiraHelpers.js': {
                extractTicketKey: function (result) {
                    try { return JSON.parse(result).key; } catch (e) { return null; }
                }
            },
            './config.js': configModule,
            './common/aiResponseParser.js': loadModule(
                'js/common/aiResponseParser.js',
                makeRequire({ '../config.js': configModule }),
                {}
            ),
            './configLoader.js': {
                loadProjectConfig: function () {
                    return {
                        tracker: { provider: 'jira' },
                        repository: { owner: 'acme', repo: 'demo' },
                        jira: { statuses: { PO_REVIEW: 'PO Review', IN_REVIEW: 'In Review' } },
                        labels: { AI_GENERATED: 'ai_generated' }
                    };
                }
            },
            './common/trackers.js': d2Trackers(globals)
        }),
        globals
    );
}

function silenceConsole() {
    var orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = function () {};
    console.warn = function () {};
    console.error = function () {};
    return orig;
}

suite('enhanceSDAPIDescriptionAndAssess.parseSDAPIEnhancementResponse — valid inputs', function () {

    test('a well-formed object passes through unchanged', function () {
        var mod = loadEnhanceSDAPI();
        var response = { description: 'h2. Enhanced', apiSubtaskCreation: true, diagram: 'sequenceDiagram\n A->>B: hi' };
        var parsed = mod.parseSDAPIEnhancementResponse(response);
        assert.equal(parsed, response, 'the same object is returned');
        assert.equal(parsed.description, 'h2. Enhanced');
        assert.equal(parsed.apiSubtaskCreation, true);
        assert.equal(parsed.diagram, 'sequenceDiagram\n A->>B: hi');
    });

    test('a JSON string is parsed into the enhancement object', function () {
        var mod = loadEnhanceSDAPI();
        var parsed = mod.parseSDAPIEnhancementResponse(
            '{"description":"d","apiSubtaskCreation":false,"diagram":"sequenceDiagram"}'
        );
        assert.equal(parsed.description, 'd');
        assert.equal(parsed.apiSubtaskCreation, false);
        assert.equal(parsed.diagram, 'sequenceDiagram');
    });

    test('a whitespace-only diagram is replaced with the API sequence default', function () {
        var mod = loadEnhanceSDAPI();
        var parsed = mod.parseSDAPIEnhancementResponse({ description: 'd', apiSubtaskCreation: true, diagram: '   ' });
        assert.equal(parsed.diagram, configModule.DIAGRAM_DEFAULTS.API_SEQUENCE);
    });

    test('an empty-string diagram is replaced with the API sequence default', function () {
        var mod = loadEnhanceSDAPI();
        var parsed = mod.parseSDAPIEnhancementResponse({ description: 'd', apiSubtaskCreation: true, diagram: '' });
        assert.equal(parsed.diagram, configModule.DIAGRAM_DEFAULTS.API_SEQUENCE);
    });
});

suite('enhanceSDAPIDescriptionAndAssess.parseSDAPIEnhancementResponse — invalid inputs', function () {

    test('invalid JSON string → null (error announced)', function () {
        var errors = [];
        var orig = silenceConsole();
        console.error = function () { errors.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var mod = loadEnhanceSDAPI();
            var parsed = mod.parseSDAPIEnhancementResponse('{oops');
            assert.equal(parsed, null, 'invalid JSON yields null');
        } finally {
            console.error = orig.error; console.warn = orig.warn; console.log = orig.log;
        }
        assert.ok(errors.some(function (e) { return e.indexOf('Invalid JSON from AI') !== -1; }));
    });

    test('null / undefined response → null (warn announced)', function () {
        var warns = [];
        var orig = silenceConsole();
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var mod = loadEnhanceSDAPI();
            assert.equal(mod.parseSDAPIEnhancementResponse(null), null);
            assert.equal(mod.parseSDAPIEnhancementResponse(undefined), null);
        } finally {
            console.error = orig.error; console.warn = orig.warn; console.log = orig.log;
        }
        assert.equal(warns.length, 2, 'each null-ish response warns once');
        assert.ok(warns[0].indexOf('not an object') !== -1);
    });

    test('non-object primitives (number, boolean, string-after-parse failure) → null', function () {
        var orig = silenceConsole();
        try {
            var mod = loadEnhanceSDAPI();
            assert.equal(mod.parseSDAPIEnhancementResponse(42), null);
            assert.equal(mod.parseSDAPIEnhancementResponse(true), null);
        } finally {
            console.error = orig.error; console.warn = orig.warn; console.log = orig.log;
        }
    });

    test('missing required fields → null (each wrong shape covered)', function () {
        var orig = silenceConsole();
        try {
            var mod = loadEnhanceSDAPI();
            assert.equal(mod.parseSDAPIEnhancementResponse({}), null, 'no fields at all');
            assert.equal(mod.parseSDAPIEnhancementResponse({ description: 'd' }), null, 'missing the rest');
            assert.equal(
                mod.parseSDAPIEnhancementResponse({ description: 'd', apiSubtaskCreation: true }),
                null,
                'missing diagram'
            );
            assert.equal(
                mod.parseSDAPIEnhancementResponse({ description: 'd', apiSubtaskCreation: 'yes', diagram: 'seq' }),
                null,
                'apiSubtaskCreation must be a boolean, not a string'
            );
            assert.equal(
                mod.parseSDAPIEnhancementResponse({ description: 42, apiSubtaskCreation: true, diagram: 'seq' }),
                null,
                'description must be a string'
            );
            assert.equal(
                mod.parseSDAPIEnhancementResponse({ description: 'd', apiSubtaskCreation: true, diagram: 7 }),
                null,
                'diagram must be a string'
            );
        } finally {
            console.error = orig.error; console.warn = orig.warn; console.log = orig.log;
        }
    });

    test('a JSON string parsing to a non-object (number) → null', function () {
        var orig = silenceConsole();
        try {
            var mod = loadEnhanceSDAPI();
            assert.equal(mod.parseSDAPIEnhancementResponse('42'), null);
        } finally {
            console.error = orig.error; console.warn = orig.warn; console.log = orig.log;
        }
    });
});

suite('enhanceSDAPIDescriptionAndAssess.action — happy paths', function () {

    function validResponse() {
        return { description: 'h2. Enhanced description', apiSubtaskCreation: true, diagram: 'sequenceDiagram\n A->>B: call' };
    }

    test('updates description, Diagrams field, adds the label, assigns and reports 3/3', function () {
        var calls = { desc: [], field: [], label: [], assign: [], move: [], remove: [] };
        var mod = loadEnhanceSDAPI({}, {
            jira_update_description: function (a) { calls.desc.push(a); },
            jira_update_field: function (a) { calls.field.push(a); },
            jira_add_label: function (a) { calls.label.push(a); },
            jira_assign_ticket_to: function (a) { calls.assign.push(a); },
            jira_move_to_status: function (a) { calls.move.push(a); },
            jira_remove_label: function (a) { calls.remove.push(a); }
        });
        var result = mod.action({
            ticket: { key: 'BICE-500' },
            initiator: '712020:abc',
            metadata: { contextId: 'solution_e2e' },
            jobParams: { customParams: {} },
            response: validResponse()
        });

        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(calls.desc.length, 1);
        assert.equal(calls.desc[0].key, 'BICE-500');
        assert.equal(calls.desc[0].description, 'h2. Enhanced description');
        assert.equal(calls.field.length, 1);
        assert.equal(calls.field[0].field, configModule.JIRA_FIELDS.DIAGRAMS);
        assert.equal(calls.field[0].value, configModule.DIAGRAM_FORMAT.MERMAID_WRAPPER_START + 'sequenceDiagram\n A->>B: call' + configModule.DIAGRAM_FORMAT.MERMAID_WRAPPER_END);
        assert.ok(calls.label.some(function (l) { return l.label === configModule.LABELS.NEEDS_API_IMPLEMENTATION; }), 'needs_api_implementation added');
        assert.equal(calls.assign.length, 1, 'assigned to the initiator');
        assert.equal(calls.remove.length, 1, 'the context WIP label is dropped');
        assert.equal(calls.remove[0].label, 'solution_e2e_wip');
        assert.contains(result.message, 'Updates: 3/3');
        assert.contains(result.message, 'BICE-500');
        assert.equal(result.enhancementData.apiSubtaskCreation, true);
        assert.equal(result.updateResults.descriptionUpdated, true);
        assert.equal(result.updateResults.diagramUpdated, true);
        assert.equal(result.updateResults.labelAdded, true);
    });

    test('apiSubtaskCreation=false skips the label and counts 2/3', function () {
        var labels = [];
        var mod = loadEnhanceSDAPI({}, {
            jira_add_label: function (a) { labels.push(a); }
        });
        var result = mod.action({
            ticket: { key: 'BICE-501' },
            initiator: '712020:abc',
            metadata: { contextId: 'solution_e2e' },
            jobParams: { customParams: {} },
            response: { description: 'd', apiSubtaskCreation: false, diagram: 'seq' }
        });
        assert.equal(result.success, true);
        assert.ok(!labels.some(function (l) { return l.label === configModule.LABELS.NEEDS_API_IMPLEMENTATION; }), 'no implementation label');
        assert.equal(result.updateResults.labelAdded, false);
        assert.contains(result.message, 'Updates: 2/3');
    });

    test('no metadata.contextId → no WIP label cleanup, no crash', function () {
        var removed = [];
        var mod = loadEnhanceSDAPI({}, {
            jira_remove_label: function (a) { removed.push(a); }
        });
        var result = mod.action({
            ticket: { key: 'BICE-502' },
            initiator: '712020:abc',
            jobParams: { customParams: {} },
            response: { description: 'd', apiSubtaskCreation: false, diagram: 'seq' }
        });
        assert.equal(result.success, true);
        assert.equal(removed.length, 0, 'nothing to remove without a WIP label');
    });
});

suite('enhanceSDAPIDescriptionAndAssess.action — failure paths', function () {

    test('invalid AI response → { success: false, error } without touching the ticket', function () {
        var touched = 0;
        var mod = loadEnhanceSDAPI({}, {
            jira_update_description: function () { touched++; },
            jira_update_field: function () { touched++; }
        });
        var result = mod.action({
            ticket: { key: 'BICE-503' },
            jobParams: { customParams: {} },
            response: 'not-json'
        });
        assert.equal(result.success, false);
        assert.equal(result.error, 'Invalid AI response format for SD API enhancement');
        assert.equal(touched, 0, 'the ticket is never touched on a parse failure');
        assert.equal(result.enhancementData, undefined);
    });

    test('a failing assignForReview is returned as-is (success: false pass-through)', function () {
        var mod = loadEnhanceSDAPI({}, {
            jira_assign_ticket_to: function () { throw new Error('no such user'); }
        });
        var result = mod.action({
            ticket: { key: 'BICE-504' },
            initiator: 'ghost',
            jobParams: { customParams: {} },
            response: { description: 'd', apiSubtaskCreation: false, diagram: 'seq' }
        });
        assert.equal(result.success, false, 'the tracker failure is surfaced');
        assert.ok(result.error.indexOf('no such user') !== -1, JSON.stringify(result));
    });

    test('a ticket-update failure is reported per-field, not fatal (1/3 + errors array)', function () {
        var mod = loadEnhanceSDAPI({}, {
            jira_update_description: function () { throw new Error('field locked'); }
        });
        var result = mod.action({
            ticket: { key: 'BICE-505' },
            initiator: '712020:abc',
            jobParams: { customParams: {} },
            response: { description: 'd', apiSubtaskCreation: true, diagram: 'seq' }
        });
        assert.equal(result.success, true, 'partial update success still completes the flow');
        assert.equal(result.updateResults.descriptionUpdated, false);
        assert.equal(result.updateResults.diagramUpdated, true);
        assert.equal(result.updateResults.labelAdded, true);
        assert.equal(result.updateResults.errors.length, 1);
        assert.ok(result.updateResults.errors[0].indexOf('Description update failed') !== -1);
        assert.contains(result.message, 'Updates: 2/3');
    });

    test('a Diagrams-field failure adds its own error entry (per-step isolation)', function () {
        var mod = loadEnhanceSDAPI({}, {
            jira_update_field: function () { throw new Error('no such field'); }
        });
        var result = mod.action({
            ticket: { key: 'BICE-506' },
            initiator: '712020:abc',
            jobParams: { customParams: {} },
            response: { description: 'd', apiSubtaskCreation: false, diagram: 'seq' }
        });
        assert.equal(result.success, true);
        assert.equal(result.updateResults.diagramUpdated, false);
        assert.ok(result.updateResults.errors[0].indexOf('Diagrams field update failed') !== -1);
    });

    test('an unexpected error is caught by the action safety net → { success: false, error }', function () {
        var orig = silenceConsole();
        try {
            var mod = loadEnhanceSDAPI();
            // No params.ticket → reading params.ticket.key throws inside action.
            var result = mod.action({ jobParams: { customParams: {} } });
            assert.equal(result.success, false, 'the safety net reports the failure');
            assert.ok(String(result.error).indexOf('Error') !== -1,
                'the error is stringified into the result, got: ' + result.error);
        } finally {
            console.error = orig.error; console.warn = orig.warn; console.log = orig.log;
        }
    });
});
