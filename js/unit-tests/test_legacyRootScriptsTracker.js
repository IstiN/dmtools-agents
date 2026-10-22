/**
 * Unit tests for gh-1162: legacy root-level scripts migrated to tracker abstraction.
 *
 * Covers:
 *   - common/jiraHelpers.js
 *   - assignForReview.js (root)
 *   - createQuestionsAndAssignForReview.js (root)
 *   - restoreDescription.js (root)
 *
 * Verifies Jira backward compatibility, ADO/GitHub provider routing without touching
 * any jira_* globals, and 100% branch coverage of all helper functions.
 */

'use strict';

function lrsRecorder(extra) {
    var calls = [];
    var mocks = {};
    [
        'jira_assign_ticket_to', 'jira_move_to_status', 'jira_add_label', 'jira_remove_label',
        'jira_set_priority', 'jira_create_ticket_with_json', 'jira_create_ticket_with_parent',
        'jira_post_comment', 'jira_execute_request', 'jira_update_description', 'jira_update_ticket',
        'ado_assign_work_item', 'ado_move_to_state', 'ado_add_work_item_label',
        'ado_remove_work_item_label', 'ado_create_work_item', 'ado_link_work_items',
        'ado_set_priority', 'ado_update_field', 'ado_add_work_item_comment',
        'ado_update_description',
        'github_assign_issue', 'github_move_issue_to_status', 'github_add_labels',
        'github_remove_label', 'github_create_comment'
    ].forEach(function (name) {
        mocks[name] = function (args) {
            calls.push({ tool: name, args: args });
            return null;
        };
    });
    Object.keys(extra || {}).forEach(function (name) {
        mocks[name] = function (args, b) {
            calls.push({ tool: name, args: args, extraArg: b });
            return extra[name](args, b);
        };
    });
    return { calls: calls, mocks: mocks };
}

function lrsTools(calls) {
    return calls.map(function (c) { return c.tool; });
}

function lrsNoJira(calls) {
    var jiraCalls = lrsTools(calls).filter(function (t) { return t.indexOf('jira_') === 0; });
    assert.deepEqual(jiraCalls, [], 'must not call any jira_* tool when provider is non-jira');
}

function lrsCalls(calls, tool) {
    return calls.filter(function (c) { return c.tool === tool; });
}

function lrsLoadTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function lrsLoadJiraHelpers(mocks, trackersMod) {
    return loadModule('common/jiraHelpers.js', makeRequire({
        '../js/config.js': configModule,
        '../js/common/trackers.js': trackersMod || lrsLoadTrackers(mocks)
    }), mocks);
}

// ── 1. common/jiraHelpers.js ─────────────────────────────────────────────────

suite('gh-1162 — common/jiraHelpers.js', function () {

    test('assignForReview with default (jira) calls jira_assign_ticket_to, jira_move_to_status, jira_add_label', function () {
        var rec = lrsRecorder();
        var helpers = lrsLoadJiraHelpers(rec.mocks);
        var res = helpers.assignForReview('PROJ-10', 'acc-1', 'ctx_wip', 'Custom Review');
        assert.equal(res.success, true);
        assert.deepEqual(lrsTools(rec.calls), [
            'jira_assign_ticket_to',
            'jira_move_to_status',
            'jira_add_label',
            'jira_remove_label'
        ]);
        assert.equal(lrsCalls(rec.calls, 'jira_move_to_status')[0].args.statusName, 'Custom Review');
    });

    test('assignForReview with explicit ADO tracker uses ado_* tools and zero jira_* tools', function () {
        var rec = lrsRecorder();
        var trackersMod = lrsLoadTrackers(rec.mocks);
        var helpers = lrsLoadJiraHelpers(rec.mocks, trackersMod);
        var adoTracker = trackersMod.createTracker(null, { trackerProvider: 'ado' });
        var res = helpers.assignForReview('42', 'dev@example.com', 'story_wip', null, adoTracker);
        assert.equal(res.success, true);
        assert.deepEqual(lrsTools(rec.calls), [
            'ado_assign_work_item',
            'ado_move_to_state',
            'ado_add_work_item_label',
            'ado_remove_work_item_label'
        ]);
        assert.equal(lrsCalls(rec.calls, 'ado_move_to_state')[0].args.state, 'In Review');
        lrsNoJira(rec.calls);
    });

    test('assignForReview catches exceptions when tracker factory or tracker throws', function () {
        var rec = lrsRecorder();
        var brokenHelpers = loadModule('common/jiraHelpers.js', makeRequire({
            '../js/config.js': configModule,
            '../js/common/trackers.js': {
                createTracker: function () { throw new Error('boom tracker'); }
            }
        }), rec.mocks);
        var res = brokenHelpers.assignForReview('PROJ-1', 'user');
        assert.equal(res.success, false);
        assert.contains(res.error, 'boom tracker');
    });

    test('extractTicketKey handles null, JSON strings, invalid JSON, objects with key, and objects without key', function () {
        var rec = lrsRecorder();
        var helpers = lrsLoadJiraHelpers(rec.mocks);
        assert.equal(helpers.extractTicketKey(null), null);
        assert.equal(helpers.extractTicketKey(''), null);
        assert.equal(helpers.extractTicketKey('{"key":"PROJ-99"}'), 'PROJ-99');
        assert.equal(helpers.extractTicketKey('{"id":123}'), null);
        assert.equal(helpers.extractTicketKey('not-json'), null);
        assert.equal(helpers.extractTicketKey({ key: 'PROJ-77' }), 'PROJ-77');
        assert.equal(helpers.extractTicketKey({ key: 123 }), null);
        assert.equal(helpers.extractTicketKey(42), null);
    });

    test('setTicketPriority validates args, delegates to jira default and ADO tracker, and catches errors', function () {
        var rec = lrsRecorder();
        var trackersMod = lrsLoadTrackers(rec.mocks);
        var helpers = lrsLoadJiraHelpers(rec.mocks, trackersMod);

        assert.equal(helpers.setTicketPriority('', 'High'), false);
        assert.equal(helpers.setTicketPriority('PROJ-1', ''), false);

        assert.equal(helpers.setTicketPriority('PROJ-1', 'High'), true);
        assert.deepEqual(lrsCalls(rec.calls, 'jira_set_priority')[0].args, { key: 'PROJ-1', priority: 'High' });

        var recAdo = lrsRecorder();
        var adoTrackers = lrsLoadTrackers(recAdo.mocks);
        var adoHelpers = lrsLoadJiraHelpers(recAdo.mocks, adoTrackers);
        var adoTracker = adoTrackers.createTracker(null, { trackerProvider: 'ado' });
        assert.equal(adoHelpers.setTicketPriority('88', 'High', adoTracker), true);
        assert.deepEqual(lrsCalls(recAdo.calls, 'ado_set_priority')[0].args, { id: '88', priority: 'High' });
        lrsNoJira(recAdo.calls);

        // Error path: unknown priority on ADO throws inside setPriority
        assert.equal(adoHelpers.setTicketPriority('88', 'NotAPriority', adoTracker), false);
    });
});

// ── 2. assignForReview.js (root) ─────────────────────────────────────────────

suite('gh-1162 — root assignForReview.js', function () {

    function loadRootAssign(rec, tokenMock, withConfigLoader) {
        var trackersMod = lrsLoadTrackers(rec.mocks);
        var helpersMod = lrsLoadJiraHelpers(rec.mocks, trackersMod);
        var reqMap = {
            './common/jiraHelpers.js': helpersMod,
            './js/common/tokenUsageComment.js': tokenMock || {
                postTokenUsageComments: function () {}
            },
            './js/common/trackers.js': trackersMod
        };
        if (withConfigLoader !== false) {
            reqMap['./js/configLoader.js'] = makeDefaultConfigLoaderMock();
        }
        return loadModule('assignForReview.js', makeRequire(reqMap), rec.mocks);
    }

    test('ado: assigns, moves state, adds ai_generated label, removes wip label, and posts usage via ado_* only', function () {
        var rec = lrsRecorder();
        var usageArgs = null;
        var mod = loadRootAssign(rec, {
            postTokenUsageComments: function (key, opts) {
                usageArgs = { key: key, opts: opts };
            }
        }, true);

        var res = mod.action({
            ticket: { key: '501' },
            initiator: 'reviewer@example.com',
            metadata: { contextId: 'story_ac' },
            targetStatus: 'PO Review',
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });

        assert.equal(res.success, true);
        assert.equal(usageArgs.key, '501');
        assert.equal(usageArgs.opts.initiator, 'reviewer@example.com');
        assert.equal(usageArgs.opts.tracker.provider(), 'ado');
        assert.deepEqual(usageArgs.opts.customParams, { trackerProvider: 'ado' });
        assert.deepEqual(lrsTools(rec.calls), [
            'ado_assign_work_item',
            'ado_move_to_state',
            'ado_add_work_item_label',
            'ado_remove_work_item_label'
        ]);
        assert.equal(lrsCalls(rec.calls, 'ado_move_to_state')[0].args.state, 'PO Review');
        assert.equal(lrsCalls(rec.calls, 'ado_remove_work_item_label')[0].args.label, 'story_ac_wip');
        lrsNoJira(rec.calls);
    });

    test('jira default without configLoader or metadata still succeeds and logs usage errors non-fatally', function () {
        var rec = lrsRecorder();
        var mod = loadRootAssign(rec, {
            postTokenUsageComments: function () {
                throw new Error('usage read error');
            }
        }, false);

        var res = mod.action({
            ticket: { key: 'PROJ-12' },
            initiator: 'acc-12',
            customParams: {}
        });

        assert.equal(res.success, true);
        assert.deepEqual(lrsTools(rec.calls), [
            'jira_assign_ticket_to',
            'jira_move_to_status',
            'jira_add_label'
        ]);
        assert.equal(mod.resolveProjectConfig({}), null);
        assert.deepEqual(mod.resolveCustomParams(null), {});
        assert.equal(mod.resolveWipLabel(null), null);
    });

    test('action returns { success: false, error } when params.ticket is missing', function () {
        var rec = lrsRecorder();
        var mod = loadRootAssign(rec, null, true);
        var res = mod.action(null);
        assert.equal(res.success, false);
        assert.ok(res.error);
    });
});

// ── 3. createQuestionsAndAssignForReview.js (root) ───────────────────────────

suite('gh-1162 — root createQuestionsAndAssignForReview.js', function () {

    function loadRootQuestions(rec, withConfigLoader, customConfig) {
        var trackersMod = lrsLoadTrackers(rec.mocks);
        var helpersMod = lrsLoadJiraHelpers(rec.mocks, trackersMod);
        var parserMod = loadModule('common/aiResponseParser.js', makeRequire({}), {});
        var reqMap = {
            './common/jiraHelpers.js': helpersMod,
            './common/aiResponseParser.js': parserMod,
            './js/common/trackers.js': trackersMod
        };
        if (withConfigLoader !== false) {
            reqMap['./js/configLoader.js'] = customConfig
                ? { loadProjectConfig: function () { return customConfig; } }
                : makeDefaultConfigLoaderMock();
        }
        return loadModule('createQuestionsAndAssignForReview.js', makeRequire(reqMap), rec.mocks);
    }

    test('ado: creates question child work items, links to parent, sets priority, labels parent, and assigns for review via ado_* only', function () {
        var nextId = 900;
        var rec = lrsRecorder({
            ado_create_work_item: function () {
                nextId += 1;
                return { id: nextId };
            }
        });
        var mod = loadRootQuestions(rec, true);
        var questions = [
            { summary: 'First question?', description: 'Desc 1', priority: 'High' },
            { summary: 'Second question no priority', description: 'Desc 2' }
        ];

        var res = mod.action({
            ticket: { key: '700' },
            initiator: 'po@example.com',
            response: JSON.stringify(questions),
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });

        assert.equal(res.success, true);
        assert.equal(res.createdQuestions.length, 2);
        assert.equal(res.createdQuestions[0].key, '901');
        assert.equal(res.createdQuestions[1].key, '902');
        assert.equal(lrsCalls(rec.calls, 'ado_create_work_item').length, 2);
        assert.equal(lrsCalls(rec.calls, 'ado_create_work_item')[0].args.workItemType, 'Task');
        assert.equal(lrsCalls(rec.calls, 'ado_link_work_items').length, 2);
        assert.deepEqual(lrsCalls(rec.calls, 'ado_link_work_items')[0].args, {
            sourceId: '901',
            targetId: '700',
            relationship: 'parent'
        });
        assert.equal(lrsCalls(rec.calls, 'ado_set_priority').length, 1);
        assert.deepEqual(lrsCalls(rec.calls, 'ado_set_priority')[0].args, {
            id: '901',
            priority: 'High'
        });
        var labelCalls = lrsCalls(rec.calls, 'ado_add_work_item_label').map(function (c) {
            return c.args.id + ':' + c.args.label;
        });
        assert.contains(labelCalls.join(','), '700:ai_questions_asked');
        assert.contains(labelCalls.join(','), '700:ai_generated');
        lrsNoJira(rec.calls);
    });

    test('ado: non-fatal priority error and subtask creation error are handled gracefully', function () {
        var callNum = 0;
        var rec = lrsRecorder({
            ado_create_work_item: function () {
                callNum += 1;
                if (callNum === 2) throw new Error('ado create failed');
                return { id: 801 };
            },
            ado_set_priority: function () {
                throw new Error('priority rejected');
            }
        });
        var mod = loadRootQuestions(rec, false);
        var created = mod.processQuestionTickets([
            { summary: 'Q1', description: 'D1', priority: 'High' },
            { summary: 'Q2', description: 'D2', priority: 'Low' }
        ], '700', lrsLoadTrackers(rec.mocks).createTracker(null, { trackerProvider: 'ado' }), null);

        assert.equal(created.length, 2);
        assert.equal(created[0].key, '801');
        assert.contains(created[1].error, 'ado create failed');
        lrsNoJira(rec.calls);
    });

    test('jira: empty questions skips creation; non-empty uses jira_create_ticket_with_json and handles assignForReview failure', function () {
        var rec = lrsRecorder({
            jira_create_ticket_with_json: function () {
                return JSON.stringify({ key: 'PROJ-101' });
            }
        });
        var mod = loadRootQuestions(rec, false);

        // Empty questions
        assert.deepEqual(mod.processQuestionTickets([], 'PROJ-100'), []);

        // Direct processQuestionTickets with default Jira tracker
        var created = mod.processQuestionTickets([
            { summary: 'Jira Q1', description: 'Jira D1', priority: 'Medium' },
            { summary: 'Jira Q2', description: 'Jira D2' }
        ], 'PROJ-100');
        assert.equal(created.length, 2);
        assert.equal(created[0].key, 'PROJ-101');
        assert.equal(lrsCalls(rec.calls, 'jira_create_ticket_with_json').length, 2);
        assert.deepEqual(lrsCalls(rec.calls, 'jira_create_ticket_with_json')[0].args.fieldsJson.priority, { name: 'Medium' });
        assert.equal(lrsCalls(rec.calls, 'jira_create_ticket_with_json')[1].args.fieldsJson.priority, undefined);

        // assignForReview failure propagation
        var recFail = lrsRecorder({
            jira_assign_ticket_to: function () {
                throw new Error('assign failed');
            }
        });
        var modFail = loadRootQuestions(recFail, true);
        var failRes = modFail.action({
            ticket: { key: 'PROJ-100' },
            initiator: 'user-1',
            response: '[]',
            customParams: {}
        });
        assert.equal(failRes.success, false);
        assert.contains(failRes.error, 'assign failed');

        // Top-level action catch block when params is invalid
        var topErr = modFail.action(null);
        assert.equal(topErr.success, false);
        assert.ok(topErr.error);

        // Helper coverage
        assert.deepEqual(mod.resolveCustomParams(null), {});
        assert.equal(mod.normalizeCreatedKey({ key: 'PROJ-5' }), 'PROJ-5');
        assert.equal(mod.normalizeCreatedKey('PROJ-6'), 'PROJ-6');
    });
});

// ── 4. restoreDescription.js (root) ──────────────────────────────────────────

suite('gh-1162 — root restoreDescription.js', function () {

    function loadRestore(rec, withConfigLoader, customConfig, extraGlobals) {
        var trackersMod = lrsLoadTrackers(rec.mocks);
        var reqMap = {
            './js/common/trackers.js': trackersMod
        };
        if (withConfigLoader !== false) {
            reqMap['./js/configLoader.js'] = customConfig
                ? { loadProjectConfig: function () { return customConfig; } }
                : makeDefaultConfigLoaderMock();
        }
        var globals = Object.assign({}, rec.mocks, extraGlobals || {});
        return loadModule('restoreDescription.js', makeRequire(reqMap), globals);
    }

    test('ado & github: returns clear unsupported error and calls zero jira_* tools', function () {
        var rec = lrsRecorder();
        var mod = loadRestore(rec, true);

        var adoRes = mod.action({
            ticket: { key: '123' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(adoRes.success, false);
        assert.contains(adoRes.error, 'not supported on the "ado" tracker provider');
        lrsNoJira(rec.calls);

        var ghRes = mod.action({
            ticketKey: 'owner/repo#5',
            customParams: { trackerProvider: 'github' }
        });
        assert.equal(ghRes.success, false);
        assert.contains(ghRes.error, 'not supported on the "github" tracker provider');
        lrsNoJira(rec.calls);
    });

    test('jira: fetches changelog, merges golden description with unique current lines before separator, and updates via tracker.updateDescription', function () {
        var golden = 'Long original specification line 1\nLong original specification line 2\n----\nFooter section';
        var accidental = 'Long original specification line 1\nNewly added unique line';
        var changelogPayload = {
            values: [
                {
                    created: '2026-01-01T00:00:00Z',
                    author: { displayName: 'Alice' },
                    items: [
                        { field: 'status', fromString: 'Open', toString: 'In Progress' },
                        { field: 'description', fromString: 'Short initial', toString: golden }
                    ]
                },
                {
                    created: '2026-01-02T00:00:00Z',
                    author: null,
                    items: [
                        { field: 'description', fromString: golden, toString: accidental }
                    ]
                }
            ]
        };

        var rec = lrsRecorder({
            jira_execute_request: function () {
                return JSON.stringify(changelogPayload);
            },
            jira_update_description: function () {
                return { updated: true };
            }
        });
        var mod = loadRestore(rec, true, { jira: { baseUrl: 'https://my-jira.example.com/' } });
        var res = mod.action({ ticketKey: 'PROJ-42' });

        assert.equal(res.success, true);
        assert.equal(res.ticketKey, 'PROJ-42');
        assert.equal(res.uniqueLinesAdded, 1);
        assert.deepEqual(res.uniqueLines, ['Newly added unique line']);
        assert.contains(res.updateResult ? JSON.stringify(res.updateResult) : '', 'updated');
        assert.equal(
            lrsCalls(rec.calls, 'jira_execute_request')[0].args,
            'https://my-jira.example.com/rest/api/3/issue/PROJ-42/changelog?maxResults=100'
        );
        var updatedDesc = lrsCalls(rec.calls, 'jira_update_description')[0].args.description;
        assert.contains(updatedDesc, 'Newly added unique line\n\n----\nFooter section');
    });

    test('jira: handles changelog without separator, no unique lines, legacy jira_update_ticket fallback, and error states', function () {
        // 1. Changelog fetch failure / invalid JSON
        var recEmpty = lrsRecorder({
            jira_execute_request: function () { return 'invalid-json'; }
        });
        var modEmpty = loadRestore(recEmpty, false);
        assert.deepEqual(modEmpty.action(null), {
            success: false,
            error: 'Could not fetch changelog'
        });

        // 2. No description changes in changelog
        var recNoDesc = lrsRecorder({
            jira_execute_request: function () {
                return { values: [{ created: '2026-01-01', items: [{ field: 'summary' }, null] }, {}] };
            }
        });
        var modNoDesc = loadRestore(recNoDesc, false);
        assert.deepEqual(modNoDesc.action({}), {
            success: false,
            error: 'No description changes found in changelog'
        });

        // 3. Merge without '----' separator + legacy jira_update_ticket fallback (when jira_update_description is undefined)
        var recLegacy = lrsRecorder({
            jira_execute_request: function () {
                return {
                    values: [{
                        created: '2026-01-01',
                        items: [{
                            field: 'description',
                            fromString: 'Golden body without horizontal rule line 1\nGolden line 2',
                            toString: 'Short override\nBrand new line'
                        }]
                    }]
                };
            },
            jira_update_ticket: function (key, body) {
                return { legacyKey: key, desc: body.fields.description };
            }
        });
        delete recLegacy.mocks.jira_update_description;
        var modLegacy = loadRestore(recLegacy, false, null, {
            java: { lang: { System: { getenv: function () { return 'https://env-jira.example.com/'; } } } }
        });
        var resLegacy = modLegacy.action({ ticket: { key: 'PROJ-77' } });
        assert.equal(resLegacy.success, true);
        assert.equal(resLegacy.ticketKey, 'PROJ-77');
        assert.equal(
            lrsCalls(recLegacy.calls, 'jira_execute_request')[0].args,
            'https://env-jira.example.com/rest/api/3/issue/PROJ-77/changelog?maxResults=100'
        );
        assert.contains(resLegacy.updateResult.desc, 'Brand new line');

        // 4. Direct helper edge cases
        assert.equal(modLegacy.mergeDescriptions('Golden only', []), 'Golden only');
        assert.deepEqual(modLegacy.extractDescriptionChanges(null), []);
        delete recLegacy.mocks.jira_update_ticket;
        var fallbackOnlyMod = loadRestore(recLegacy, false);
        var calledTrackerUpdate = false;
        fallbackOnlyMod.updateRestoredDescription('PROJ-1', 'text', {
            updateDescription: function () { calledTrackerUpdate = true; return 'ok'; }
        });
        assert.equal(calledTrackerUpdate, true);
    });
});
