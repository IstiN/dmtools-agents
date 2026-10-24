function d2Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

/**
 * Unit tests for js/createQuestionsAndAssignForReview.js
 *
 * Verifies:
 * 1. When questions.json has entries, subtasks are created as before.
 * 2. When questions.json is empty ([]), and outputs/response.md explains why,
 *    that explanation is posted as a Jira comment.
 * 3. When questions.json is empty AND outputs/response.md is missing/empty,
 *    a fallback warning comment is posted instead of silently skipping.
 */

function makeOutputFiles(fileReadImpl) {
    return loadModule('js/common/outputFiles.js', makeRequire({}), {
        file_read: fileReadImpl
    });
}

function loadCreateQuestionsModule(fileMap, extraGlobals, requireOverrides) {
    var comments = [];
    var labels = [];
    var moves = [];
    var removedLabels = [];
    var createdTickets = [];
    var assigns = [];
    var autoStarts = [];

    var globals = {
        file_read: function (opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        },
        jira_post_comment: function (args) { comments.push(args); },
        jira_add_label: function (args) { labels.push(args); },
        jira_move_to_status: function (args) { moves.push(args); },
        jira_remove_label: function (args) { removedLabels.push(args); },
        jira_assign_ticket_to: function (args) { assigns.push(args); },
        jira_create_ticket_with_json: function (args) {
            createdTickets.push(args);
            return JSON.stringify({ key: 'BICE-' + (900 + createdTickets.length) });
        }
    };
    Object.assign(globals, extraGlobals || {});

    // gh-1245: description files are read through the shared outputFiles
    // module, so its file_read mock must see the same overrides as the module.
    var outputFiles = makeOutputFiles(globals.file_read);

    var requireMap = {
        './common/jiraHelpers.js': {
            extractTicketKey: function (result) {
                try { return JSON.parse(result).key; } catch (e) { return null; }
            }
        },
        './common/aiResponseParser.js': {
            buildSummary: function (summary, index) {
                return summary || ('Follow-up question #' + (index + 1));
            }
        },
        './config.js': configModule,
        './configLoader.js': configLoaderModule,
        './common/scm.js': { createScm: function () { return {}; } },
        './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function (opts) { autoStarts.push(opts); return false; } },
        './common/tokenUsageComment.js': { postTokenUsageComments: function () { }, postTokenUsageCommentsSafe: function () { } },
        './common/outputFiles.js': outputFiles,
        './common/lazyTracker.js': loadModule('js/common/lazyTracker.js'),
        './common/trackers.js': d2Trackers(globals)
    };
    Object.assign(requireMap, requireOverrides || {});

    var mod = loadModule(
        'js/createQuestionsAndAssignForReview.js',
        makeRequire(requireMap),
        globals
    );

    return {
        mod: mod,
        comments: comments,
        labels: labels,
        moves: moves,
        removedLabels: removedLabels,
        createdTickets: createdTickets,
        assigns: assigns,
        autoStarts: autoStarts
    };
}

suite('createQuestionsAndAssignForReview — module export', function () {
    test('module.exports is guarded with typeof for direct execution (postJSAction) compatibility', function () {
        var code = file_read({ path: 'js/createQuestionsAndAssignForReview.js' });
        var hasGuard = code.indexOf('typeof module') !== -1 || code.indexOf('module.exports') === -1;
        assert.equal(hasGuard, true, 'module.exports usage (if any) should be guarded');
    });
});

suite('createQuestionsAndAssignForReview — with questions', function () {
    test('creates a subtask per entry in questions.json', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': JSON.stringify([
                { summary: 'Clarify X', priority: 'High', description: 'outputs/questions/question-1.md' }
            ]),
            'outputs/questions/question-1.md': 'h2. Background\n\nWhat about X?'
        });

        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            initiator: '712020:abc',
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(loaded.createdTickets.length, 1, 'one subtask created');
        assert.equal(loaded.createdTickets[0].fieldsJson.summary.indexOf('[Q]'), 0, 'summary prefixed with [Q]');
    });
});

suite('createQuestionsAndAssignForReview — no questions, with response.md', function () {
    test('posts response.md content as explanation comment', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': '[]',
            'outputs/response.md': 'Investigated the codebase and Confluence specs — every acceptance ' +
                'criterion is already covered by existing Cosmo tests. No gaps found.'
        });

        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(loaded.createdTickets.length, 0, 'no subtasks created');
        assert.equal(loaded.comments.length, 1, 'exactly one explanation comment posted');
        assert.ok(
            loaded.comments[0].comment.indexOf('No clarifying questions needed') !== -1,
            'comment header indicates explanation'
        );
        assert.ok(
            loaded.comments[0].comment.indexOf('Investigated the codebase') !== -1,
            'comment includes response.md content'
        );
    });
});

suite('createQuestionsAndAssignForReview — no questions, no response.md', function () {
    test('posts a fallback warning comment instead of silently skipping', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': '[]'
            // no outputs/response.md entry — missing
        });

        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(loaded.comments.length, 1, 'exactly one fallback comment posted');
        assert.ok(
            loaded.comments[0].comment.indexOf('no explanation provided') !== -1 ||
            loaded.comments[0].comment.indexOf('No clarifying questions raised') !== -1,
            'fallback comment warns about missing explanation'
        );
    });
});

suite('createQuestionsAndAssignForReview — fatal CLI/provider error', function () {
    test('does not move the ticket forward or touch labels when currentCliHasFatalError is true', function () {
        // No outputs/questions.json at all — a fatal CLI error means the agent never ran.
        var loaded = loadCreateQuestionsModule({});

        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            initiator: '712020:abc',
            jobParams: { customParams: {} },
            currentCliHasFatalError: true,
            currentCliErrorMessage: '502: Failed to connect to upstream server'
        });

        assert.equal(result.success, false, 'a fatal CLI error must not be reported as success');
        assert.equal(loaded.createdTickets.length, 0, 'no question subtasks created');
        assert.equal(loaded.labels.length, 0, 'ai_questions_asked/ai_generated labels not added');
        assert.equal(loaded.moves.length, 0, 'ticket not moved to PO Review');
        assert.equal(loaded.removedLabels.length, 0, 'WIP label not touched');
        assert.equal(loaded.comments.length, 1, 'exactly one comment posted');
        assert.ok(
            loaded.comments[0].comment.indexOf('502: Failed to connect to upstream server') !== -1,
            'comment surfaces the actual CLI/provider error message'
        );
        assert.ok(
            loaded.comments[0].comment.indexOf('NOT moved to PO Review') !== -1,
            'comment makes clear the ticket was left untouched'
        );
    });

    test('treats currentCliHasFatalError as false when absent (backwards compatible)', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': '[]',
            'outputs/response.md': 'No gaps found.'
        });

        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });

        assert.equal(result.success, true);
        assert.equal(loaded.moves.length, 1, 'ticket still moved to PO Review on the normal no-questions path');
    });
});

suite('createQuestionsAndAssignForReview — failed ticket creation throws', function () {
    test('throws when jira_create_ticket_with_json fails for all questions', function () {
        var loaded = loadCreateQuestionsModule(
            {
                'outputs/questions.json': JSON.stringify([
                    { summary: 'Question 1', priority: 'High' },
                    { summary: 'Question 2', priority: 'Medium' }
                ])
            },
            {
                jira_create_ticket_with_json: function () {
                    throw new Error('{"errors":{"issuetype":"Specify a valid issue type"}}');
                }
            }
        );

        var threw = false;
        var thrownMessage = '';
        try {
            loaded.mod.action({
                ticket: { key: 'TR-1' },
                metadata: { contextId: 'story_questions' },
                initiator: '712020:abc',
                jobParams: { customParams: {} }
            });
        } catch (err) {
            threw = true;
            thrownMessage = err.message || String(err);
        }

        assert.equal(threw, true, 'action() must throw when ticket creation fails');
        assert.ok(
            thrownMessage.indexOf('Failed to create') !== -1,
            'error message must mention failure count, got: ' + thrownMessage
        );
        assert.ok(
            thrownMessage.indexOf('2 of 2') !== -1,
            'error message must include correct failure count, got: ' + thrownMessage
        );
        assert.ok(
            thrownMessage.indexOf('TR-1') !== -1,
            'error message must include parent ticket key, got: ' + thrownMessage
        );
    });

    test('throws when jira_create_ticket_with_json fails for some (but not all) questions', function () {
        var callCount = 0;
        var loaded = loadCreateQuestionsModule(
            {
                'outputs/questions.json': JSON.stringify([
                    { summary: 'Question 1', priority: 'High' },
                    { summary: 'Question 2', priority: 'Medium' },
                    { summary: 'Question 3', priority: 'Low' }
                ])
            },
            {
                jira_create_ticket_with_json: function (args) {
                    callCount++;
                    if (callCount === 2) {
                        throw new Error('{"errors":{"issuetype":"Specify a valid issue type"}}');
                    }
                    return JSON.stringify({ key: 'TR-' + (900 + callCount) });
                }
            }
        );

        var threw = false;
        var thrownMessage = '';
        try {
            loaded.mod.action({
                ticket: { key: 'TR-1' },
                metadata: { contextId: 'story_questions' },
                initiator: '712020:abc',
                jobParams: { customParams: {} }
            });
        } catch (err) {
            threw = true;
            thrownMessage = err.message || String(err);
        }

        assert.equal(threw, true, 'action() must throw even when only some tickets fail');
        assert.ok(
            thrownMessage.indexOf('1 of 3') !== -1,
            'error message must reflect partial failure count, got: ' + thrownMessage
        );
    });
});

suite('createQuestionsAndAssignForReview — status transition outcome is reported honestly (agents#856)', function () {
    function run(extraGlobals, customParams) {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': '[]',
            'outputs/response.md': 'No gaps found.'
        }, extraGlobals);
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: customParams || {} }
        });
        return { result: result, loaded: loaded };
    }
    var reject = { jira_move_to_status: function () { throw new Error('State not allowed'); } };

    test('success keeps the exact previous message', function () {
        var r = run({});
        assert.equal(r.result.stageStatus, 'moved');
        assert.contains(r.result.message, 'moved to PO Review');
    });

    test('default: a rejected move is no longer reported as "moved"', function () {
        var r = run(reject);
        assert.equal(r.result.success, true, 'the job itself still succeeds, as before');
        assert.equal(r.result.stageStatus, 'failed');
        assert.contains(r.result.message, 'NOT moved to PO Review');
        assert.ok(!r.loaded.labels.some(function (l) { return String(l.label).indexOf('stage_') === 0; }), 'default mode adds no stage marker label');
    });

    test('stageFallback=label: the stage is marked and the message says so', function () {
        var r = run(reject, { stageFallback: 'label' });
        assert.equal(r.result.stageStatus, 'marked');
        assert.contains(r.result.message, 'marked stage PO Review');
        assert.ok(r.loaded.labels.some(function (l) { return l.label === 'stage_po_review'; }), JSON.stringify(r.loaded.labels));
    });
});

suite('createQuestionsAndAssignForReview — question subtasks on Azure DevOps (agents#870)', function () {

    function runAdo(extraGlobals, jiraQuestions) {
        var calls = { created: [], links: [], labels: [], priority: [], jira: [] };
        var globals = Object.assign({
            ado_create_work_item: function (a) { calls.created.push(a); return JSON.stringify({ id: 5001, key: '5001' }); },
            ado_link_work_items: function (a) { calls.links.push(a); return '{}'; },
            ado_add_work_item_label: function (a) { calls.labels.push(a); },
            ado_set_priority: function (a) { calls.priority.push(a); },
            ado_add_work_item_comment: function () {},
            ado_move_to_state: function () {},
            ado_remove_work_item_label: function () {},
            jira_create_ticket_with_json: function (a) { calls.jira.push(a); return JSON.stringify({ key: 'X-1' }); }
        }, extraGlobals || {});
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': JSON.stringify([{ summary: 'Confirm container security posture', priority: 'High', description: 'outputs/q1.md' }]),
            'outputs/q1.md': 'Is the rootfs read-only?'
        }, globals);
        var result = loaded.mod.action({
            ticket: { key: '1839749' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        return { result: result, calls: calls, loaded: loaded };
    }

    test('creates a Task, links it to the parent, labels it and sets the priority — no Jira-shaped fieldsJson', function () {
        var r = runAdo();
        assert.equal(r.result.success, true, JSON.stringify(r.result));
        assert.equal(r.calls.created.length, 1, 'one work item created');
        assert.equal(r.calls.created[0].workItemType, 'Task', 'the child type of a PBI/Bug');
        assert.contains(r.calls.created[0].title, '[Q] Confirm container security posture');
        assert.equal(r.calls.links.length, 1);
        assert.equal(r.calls.links[0].targetId, '1839749', 'linked under the parent story');
        assert.equal(r.calls.links[0].relationship, 'parent');
        assert.ok(r.calls.labels.some(function (l) { return l.label === 'q'; }), 'question label added: ' + JSON.stringify(r.calls.labels));
        assert.equal(r.calls.priority.length, 1);
        assert.equal(r.calls.jira.length, 0, 'the Jira creation path is never used on ADO');
        assert.equal(r.result.createdQuestions[0].success, true);
    });

    test('a failing priority never fails the question (non-fatal)', function () {
        var r = runAdo({ ado_set_priority: function () { throw new Error('priority field is read-only'); } });
        assert.equal(r.result.success, true, JSON.stringify(r.result));
        assert.equal(r.result.createdQuestions[0].success, true);
    });

    test('Jira path is byte-identical: still createTicketWithFields, never the ADO tools', function () {
        var jira = [];
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': JSON.stringify([{ summary: 'Q1', priority: 'High' }])
        }, {
            jira_create_ticket_with_json: function (a) { jira.push(a); return JSON.stringify({ key: 'BICE-1' }); },
            ado_create_work_item: function () { throw new Error('ADO must not be used on a Jira run'); }
        });
        var result = loaded.mod.action({ ticket: { key: 'BICE-829' }, metadata: { contextId: 'story_questions' }, jobParams: { customParams: {} } });
        assert.equal(result.success, true);
        assert.equal(jira.length, 1);
    });
});


suite('createQuestionsAndAssignForReview — priority map, answer field, initiator (gh-1038)', function () {

    function run(fileMap, customParams, extra) {
        var loaded = loadCreateQuestionsModule(fileMap, (extra || {}).globals);
        var params = {
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: customParams || {} }
        };
        if (!(extra && extra.noInitiator)) params.initiator = '712020:abc';
        return { result: loaded.mod.action(params), loaded: loaded };
    }

    test('customParams.priorityMap renames the priority on the created subtask', function () {
        var r = run({
            'outputs/questions.json': JSON.stringify([{ summary: 'Clarify X', priority: 'High' }])
        }, { priorityMap: { High: 'Critical' } });
        assert.equal(r.result.success, true);
        assert.equal(r.loaded.createdTickets[0].fieldsJson.priority.name, 'Critical');
    });

    test('an unmapped priority passes through unchanged', function () {
        var r = run({
            'outputs/questions.json': JSON.stringify([{ summary: 'Clarify X', priority: 'Medium' }])
        }, { priorityMap: { High: 'Critical' } });
        assert.equal(r.loaded.createdTickets[0].fieldsJson.priority.name, 'Medium');
    });

    test('entry.answer is written into the configured answer field', function () {
        var r = run({
            'outputs/questions.json': JSON.stringify([{ summary: 'Clarify X', answer: 'Already covered by AC-2' }])
        });
        assert.equal(r.loaded.createdTickets[0].fieldsJson.Answer, 'Already covered by AC-2');
        assert.equal(r.loaded.createdTickets[0].fieldsJson.priority, undefined, 'no priority → no priority field');
    });

    test('no initiator id → assign is skipped, job still succeeds', function () {
        var r = run({
            'outputs/questions.json': '[]',
            'outputs/response.md': 'No gaps found.'
        }, {}, { noInitiator: true });
        assert.equal(r.result.success, true);
        assert.equal(r.loaded.assigns.length, 0, 'assignTo not called without an initiator');
        assert.equal(r.loaded.moves.length, 1, 'ticket still moved to PO Review');
    });

    test('initiator id → ticket assigned to the initiator', function () {
        var r = run({
            'outputs/questions.json': '[]',
            'outputs/response.md': 'No gaps found.'
        });
        assert.equal(r.loaded.assigns.length, 1);
        assert.equal(r.loaded.assigns[0].accountId, '712020:abc');
        assert.equal(r.loaded.assigns[0].key, 'BICE-829');
    });
});

suite('createQuestionsAndAssignForReview — autoStart question answering (gh-1038)', function () {

    function run(customParams, questions) {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': JSON.stringify(questions || [{ summary: 'Q1' }, { summary: 'Q2' }])
        });
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            initiator: '712020:abc',
            jobParams: { customParams: customParams || {} }
        });
        return { result: result, loaded: loaded };
    }

    test('true + config file triggers the answer workflow for each created question', function () {
        var r = run({ autoStartQuestionAnswer: true, autoStartQuestionAnswerConfigFile: 'story_answer.json' });
        assert.equal(r.result.success, true);
        assert.equal(r.loaded.autoStarts.length, 2);
        assert.equal(r.loaded.autoStarts[0].ticketKey, 'BICE-901');
        assert.equal(r.loaded.autoStarts[1].ticketKey, 'BICE-902');
        assert.equal(r.loaded.autoStarts[0].configFile, 'story_answer.json');
        assert.deepEqual(r.loaded.autoStarts[0].stripKeys, ['autoStartQuestionAnswer', 'autoStartQuestionAnswerConfigFile']);
    });

    test("the string 'true' is accepted as well", function () {
        var r = run({ autoStartQuestionAnswer: 'true', autoStartQuestionAnswerConfigFile: 'story_answer.json' });
        assert.equal(r.loaded.autoStarts.length, 2);
    });

    test('true without a config file → no trigger', function () {
        var r = run({ autoStartQuestionAnswer: true });
        assert.equal(r.result.success, true);
        assert.equal(r.loaded.autoStarts.length, 0);
    });

    test('disabled → no trigger', function () {
        var r = run({ autoStartQuestionAnswer: false, autoStartQuestionAnswerConfigFile: 'story_answer.json' });
        assert.equal(r.loaded.autoStarts.length, 0);
    });
});

suite('createQuestionsAndAssignForReview — extracted pure helpers (gh-1038)', function () {

    function helpers() {
        return loadCreateQuestionsModule({}).mod;
    }

    test('buildWipLabel: contextId suffix or null', function () {
        var h = helpers();
        assert.equal(h.buildWipLabel({ contextId: 'story_questions' }), 'story_questions_wip');
        assert.equal(h.buildWipLabel({}), null);
        assert.equal(h.buildWipLabel(undefined), null);
    });

    test('resolveAgentId: explicit id or the story_questions default', function () {
        var h = helpers();
        assert.equal(h.resolveAgentId({ agentId: 'custom_agent' }), 'custom_agent');
        assert.equal(h.resolveAgentId({}), 'story_questions');
        assert.equal(h.resolveAgentId(undefined), 'story_questions');
    });

    test('resolveActionCustomParams: jobParams.customParams wins over params.customParams', function () {
        var h = helpers();
        assert.deepEqual(h.resolveActionCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(h.resolveActionCustomParams({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(h.resolveActionCustomParams({}), {});
    });

    test('resolvePriorityMap: customParams > jobParamPatch > projectConfig > null', function () {
        var h = helpers();
        var projectConfig = {
            jobParamPatches: { story_questions: { customParams: { priorityMap: { fromPatch: 1 } } } },
            priorityMap: { fromConfig: 2 }
        };
        assert.deepEqual(h.resolvePriorityMap({ priorityMap: { fromParams: 3 } }, projectConfig, 'story_questions'), { fromParams: 3 });
        assert.deepEqual(h.resolvePriorityMap({}, projectConfig, 'story_questions'), { fromPatch: 1 });
        assert.deepEqual(h.resolvePriorityMap({}, { priorityMap: { fromConfig: 2 } }, 'story_questions'), { fromConfig: 2 });
        assert.equal(h.resolvePriorityMap({}, {}, 'story_questions'), null);
        assert.equal(h.resolvePriorityMap({}, { jobParamPatches: {} }, 'unknown_agent'), null);
    });

    test('shouldAutoStartQuestionAnswer: true or the string true', function () {
        var h = helpers();
        assert.equal(h.shouldAutoStartQuestionAnswer({ autoStartQuestionAnswer: true }), true);
        assert.equal(h.shouldAutoStartQuestionAnswer({ autoStartQuestionAnswer: 'true' }), true);
        assert.equal(h.shouldAutoStartQuestionAnswer({ autoStartQuestionAnswer: 'false' }), false);
        assert.equal(h.shouldAutoStartQuestionAnswer({ autoStartQuestionAnswer: false }), false);
        assert.equal(h.shouldAutoStartQuestionAnswer({}), false);
    });

    test('buildActionMessage: moved / marked / failed wording', function () {
        var h = helpers();
        assert.equal(h.buildActionMessage('BICE-1', 'moved', 2), 'Ticket BICE-1 moved to PO Review, created 2 question subtask(s)');
        assert.contains(h.buildActionMessage('BICE-1', 'marked', 0), 'marked stage PO Review (transition rejected)');
        assert.contains(h.buildActionMessage('BICE-1', 'failed', 1), 'NOT moved to PO Review (transition failed)');
    });

    test('buildCreatedTicketReport: [Q] prefix, key and success flag', function () {
        var h = helpers();
        assert.deepEqual(h.buildCreatedTicketReport({ summary: 'Clarify X', priority: 'High' }, 'BICE-901'),
            { summary: '[Q] Clarify X', priority: 'High', key: 'BICE-901', success: true });
        assert.deepEqual(h.buildCreatedTicketReport({ summary: 'Clarify X' }, null),
            { summary: '[Q] Clarify X', priority: undefined, key: null, success: false });
        assert.deepEqual(h.buildCreatedTicketReport({}, 'BICE-902'),
            { summary: '', priority: undefined, key: 'BICE-902', success: true });
    });

    test('buildCliFailureResult: surfaces the error and never reports success', function () {
        var h = helpers();
        assert.deepEqual(h.buildCliFailureResult('502 bad gateway'), {
            success: false,
            error: 'CLI/provider failure: 502 bad gateway',
            createdQuestions: []
        });
    });

    test('isAccountIdUnsupportedError: matches the accountId marker only', function () {
        var h = helpers();
        assert.equal(h.isAccountIdUnsupportedError(new Error('accountId not found')), true);
        assert.equal(h.isAccountIdUnsupportedError(new Error('user does not exist')), false);
        assert.equal(h.isAccountIdUnsupportedError('plain accountId failure'), true);
        assert.equal(h.isAccountIdUnsupportedError(null), false);
    });
});

// ── gh-1191: branch characterization for readQuestionsJson / readDescriptionFile /
// the action() non-fatal warning paths — each failure mode must stay non-fatal
// exactly as before the CRAP refactor.

suite('createQuestionsAndAssignForReview — questions.json formats (gh-1191 characterization)', function () {

    test('wrapped {"questions":[...]} format: the inner array is used and a warning is logged', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': '{"questions":[{"summary":"Wrapped Q"},{"summary":"Wrapped Q2"}]}'
        });
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });
        assert.equal(result.success, true);
        assert.equal(loaded.createdTickets.length, 2, 'both wrapped questions are created');
        assert.contains(loaded.createdTickets[0].fieldsJson.summary, '[Q] Wrapped Q');
    });

    test('a JSON string that is not an array degrades to no questions (no crash)', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': '{"not":"a question array"}'
        });
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });
        assert.equal(result.success, true);
        assert.equal(loaded.createdTickets.length, 0);
        assert.equal(loaded.comments.length, 1, 'the no-questions explanation path still runs');
    });

    test('invalid JSON in questions.json degrades to no questions (no crash)', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': '{definitely not json'
        });
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });
        assert.equal(result.success, true);
        assert.equal(loaded.createdTickets.length, 0);
    });

    test('wrapped format with a non-array questions member degrades to no questions', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': '{"questions":"nope"}'
        });
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });
        assert.equal(result.success, true);
        assert.equal(loaded.createdTickets.length, 0);
    });
});

suite('createQuestionsAndAssignForReview — description file resolution (gh-1191 characterization)', function () {

    function runWith(fileMap, extraGlobals) {
        var loaded = loadCreateQuestionsModule(fileMap, extraGlobals);
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });
        return { result: result, loaded: loaded };
    }

    test('a missing description file falls back to the entry summary', function () {
        var r = runWith({
            'outputs/questions.json': JSON.stringify([{ summary: 'Summary fallback', description: 'outputs/missing.md' }])
        });
        assert.equal(r.result.success, true);
        assert.equal(r.loaded.createdTickets[0].fieldsJson.description, 'Summary fallback');
    });

    test('an empty description file falls back to the entry summary', function () {
        var r = runWith({
            'outputs/questions.json': JSON.stringify([{ summary: 'Summary fallback', description: 'outputs/empty.md' }]),
            'outputs/empty.md': '   '
        });
        assert.equal(r.loaded.createdTickets[0].fieldsJson.description, 'Summary fallback');
    });

    test('a throwing description read warns and falls back to the entry summary', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        var questionsJson = JSON.stringify([{ summary: 'Summary fallback', description: 'outputs/exploding.md' }]);
        try {
            var loaded = loadCreateQuestionsModule({}, {
                file_read: function (opts) {
                    var path = opts && (opts.path || opts);
                    if (path === 'outputs/exploding.md') throw new Error('disk on fire');
                    if (path === 'outputs/questions.json') return questionsJson;
                    return null;
                }
            });
            var result = loaded.mod.action({
                ticket: { key: 'BICE-829' },
                metadata: { contextId: 'story_questions' },
                jobParams: { customParams: {} }
            });
            assert.equal(result.success, true);
            assert.equal(loaded.createdTickets[0].fieldsJson.description, 'Summary fallback');
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('outputs/exploding.md') !== -1; }),
            'the read failure is announced');
    });

    test('a non-string description entry falls back to the entry summary (type guard)', function () {
        var r = runWith({
            'outputs/questions.json': JSON.stringify([{ summary: 'Summary fallback', description: 42 }])
        });
        assert.equal(r.loaded.createdTickets[0].fieldsJson.description, 'Summary fallback');
    });
});

suite('createQuestionsAndAssignForReview — non-fatal tracker failures (gh-1191 characterization)', function () {

    function runWith(fileMap, extraGlobals) {
        var loaded = loadCreateQuestionsModule(fileMap, extraGlobals);
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            initiator: '712020:abc',
            jobParams: { customParams: {} }
        });
        return { result: result, loaded: loaded };
    }

    test('a throwing no-questions explanation comment stays non-fatal', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var r = runWith({
                'outputs/questions.json': '[]',
                'outputs/response.md': 'Everything is clear.'
            }, {
                jira_post_comment: function () { throw new Error('jira comment API down'); }
            });
            assert.equal(r.result.success, true, 'the explanation failure does not fail the job');
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('no-questions explanation comment') !== -1; }));
    });

    test('a throwing fallback warning comment (no response.md) stays non-fatal', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var r = runWith({
                'outputs/questions.json': '[]'
            }, {
                jira_post_comment: function () { throw new Error('jira comment API down'); }
            });
            assert.equal(r.result.success, true, 'the fallback-warning failure does not fail the job');
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('fallback no-questions warning comment') !== -1; }));
    });

    test('failing labels (both) stay non-fatal and the job still completes', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var r = runWith({
                'outputs/questions.json': '[]',
                'outputs/response.md': 'Clear.'
            }, {
                jira_add_label: function () { throw new Error('label quota exceeded'); }
            });
            assert.equal(r.result.success, true);
            assert.equal(r.loaded.moves.length, 1, 'the PO Review move still happens');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.filter(function (w) { return w.indexOf('Failed to add') !== -1; }).length, 2,
            'both label failures are warned individually');
    });

    test('a non-accountId assign failure is warned as a plain failure', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var r = runWith({
                'outputs/questions.json': '[]',
                'outputs/response.md': 'Clear.'
            }, {
                jira_assign_ticket_to: function () { throw new Error('user does not exist'); }
            });
            assert.equal(r.result.success, true);
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('Failed to assign ticket') !== -1; }));
    });

    test('an accountId assign failure is silently skipped with a dedicated warning', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var r = runWith({
                'outputs/questions.json': '[]',
                'outputs/response.md': 'Clear.'
            }, {
                jira_assign_ticket_to: function () { throw new Error('accountId not found on this instance'); }
            });
            assert.equal(r.result.success, true);
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('accountId not supported') !== -1; }),
            'the Server/DC accountId note is logged');
        assert.ok(!warns.some(function (w) { return w.indexOf('Failed to assign ticket') !== -1; }),
            'the generic failure warn is NOT used for the accountId case');
    });

    test('a failing WIP-label removal stays non-fatal', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var r = runWith({
                'outputs/questions.json': '[]',
                'outputs/response.md': 'Clear.'
            }, {
                jira_remove_label: function () { throw new Error('label locked by workflow'); }
            });
            assert.equal(r.result.success, true);
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('Failed to remove WIP label') !== -1; }));
    });

    test('a throwing autoStart trigger stays non-fatal and the remaining questions still trigger', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var loaded = loadCreateQuestionsModule({
                'outputs/questions.json': JSON.stringify([{ summary: 'Q1' }, { summary: 'Q2' }])
            }, {}, {
                './common/autoStart.js': {
                    triggerConfiguredWorkflowForTicket: function (opts) {
                        if (opts.ticketKey === 'BICE-901') throw new Error('workflow trigger 403');
                        return false;
                    }
                }
            });
            var result = loaded.mod.action({
                ticket: { key: 'BICE-829' },
                metadata: { contextId: 'story_questions' },
                jobParams: { customParams: { autoStartQuestionAnswer: true, autoStartQuestionAnswerConfigFile: 'story_answer.json' } }
            });
            assert.equal(result.success, true, 'the autoStart failure does not fail the job');
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warns.some(function (w) { return w.indexOf('autoStartQuestionAnswer trigger failed') !== -1; }));
    });
});

suite('createQuestionsAndAssignForReview — created key extraction (gh-1191 characterization)', function () {

    test('a JSON-object create result is parsed via extractTicketKey', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': JSON.stringify([{ summary: 'Q1' }])
        }, {
            jira_create_ticket_with_json: function () { return JSON.stringify({ key: 'BICE-778', id: '1' }); }
        });
        var result = loaded.mod.action({
            ticket: { key: 'BICE-829' },
            metadata: { contextId: 'story_questions' },
            jobParams: { customParams: {} }
        });
        assert.equal(result.createdQuestions[0].key, 'BICE-778');
    });

    test('an unparseable create result makes the question fail and action throws', function () {
        // The tracker layer (jiraCreateWithFields) already runs extractTicketKey on the raw
        // result, so a non-JSON string reaches createQuestion as null → key null → success
        // false → failedCount > 0 → action throws.
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': JSON.stringify([{ summary: 'Q1' }])
        }, {
            jira_create_ticket_with_json: function () { return '<<<not json>>>'; }
        });
        var threw = false;
        var message = '';
        try {
            loaded.mod.action({
                ticket: { key: 'BICE-829' },
                metadata: { contextId: 'story_questions' },
                jobParams: { customParams: {} }
            });
        } catch (e) {
            threw = true;
            message = e.message || String(e);
        }
        assert.equal(threw, true);
        assert.contains(message, 'Failed to create 1 of 1');
    });

    test('a throwing create reports the question as failed (null key)', function () {
        var loaded = loadCreateQuestionsModule({
            'outputs/questions.json': JSON.stringify([{ summary: 'Q1' }])
        }, {
            jira_create_ticket_with_json: function () { throw new Error('boom'); }
        });
        var threw = false;
        try {
            loaded.mod.action({
                ticket: { key: 'BICE-829' },
                metadata: { contextId: 'story_questions' },
                jobParams: { customParams: {} }
            });
        } catch (e) {
            threw = true;
        }
        assert.equal(threw, true, 'a failed question still fails the job (failedCount > 0)');
    });
});

// ── gh-1191: the extracted question-build/decide helpers, pinned directly ────

suite('createQuestionsAndAssignForReview — extracted question helpers (gh-1191)', function () {

    function helpers() {
        return loadCreateQuestionsModule({}).mod;
    }

    test('bootstrapCustomParams: jobParams.customParams or an empty object (never params.customParams)', function () {
        var h = helpers();
        assert.deepEqual(h.bootstrapCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(h.bootstrapCustomParams({ jobParams: {}, customParams: { b: 2 } }), {}, 'falls to {} — deliberately not params.customParams');
        assert.deepEqual(h.bootstrapCustomParams({ customParams: { b: 2 } }), {}, 'no jobParams at all');
        assert.deepEqual(h.bootstrapCustomParams({}), {});
    });

    test('resolveQuestionPriority: mapped or original name', function () {
        var h = helpers();
        assert.equal(h.resolveQuestionPriority({ High: 'Critical' }, 'High'), 'Critical');
        assert.equal(h.resolveQuestionPriority({ High: 'Critical' }, 'Medium'), 'Medium');
        assert.equal(h.resolveQuestionPriority(null, 'Medium'), 'Medium');
        assert.equal(h.resolveQuestionPriority(undefined, 'Low'), 'Low');
        assert.equal(h.resolveQuestionPriority({}, 'Low'), 'Low');
    });

    test('buildQuestionFieldsJson: shape, priority mapping, answer field', function () {
        var h = helpers();
        var jiraConfig = {
            issueTypes: { SUBTASK: 'Subtask' },
            labels: { QUESTION: 'q' },
            questions: { answerField: 'Answer' }
        };
        var full = h.buildQuestionFieldsJson(
            { summary: 'Q', priority: 'High', answer: 'a' },
            '[Q] Q', 'desc', 'BICE-1', jiraConfig, { High: 'Critical' }
        );
        assert.deepEqual(full, {
            summary: '[Q] Q',
            description: 'desc',
            issuetype: { name: 'Subtask' },
            parent: { key: 'BICE-1' },
            labels: ['q'],
            priority: { name: 'Critical' },
            Answer: 'a'
        });
        var minimal = h.buildQuestionFieldsJson({}, '[Q] Q', 'desc', 'BICE-1', jiraConfig, null);
        assert.equal(minimal.priority, undefined, 'no priority → no priority field');
        assert.equal(minimal.Answer, undefined, 'no answer → no answer field');
        assert.equal(minimal.labels[0], 'q');
    });

    test('buildQuestionFieldsJson: a broken config throws before any tracker call', function () {
        var h = helpers();
        var threw = false;
        try {
            // labels missing entirely → the eager jiraConfig.labels.QUESTION read throws
            h.buildQuestionFieldsJson({}, 's', 'd', 'BICE-1', { issueTypes: { SUBTASK: 'Subtask' }, questions: { answerField: 'Answer' } }, null);
        } catch (e) {
            threw = true;
        }
        assert.equal(threw, true, 'missing labels container throws (eager config reads preserved)');
    });

    test('resolveAdoQuestionType: configured workItemType or the Task default', function () {
        var h = helpers();
        assert.equal(h.resolveAdoQuestionType({ questions: { workItemType: 'Question' } }), 'Question');
        assert.equal(h.resolveAdoQuestionType({ questions: {} }), 'Task');
        assert.equal(h.resolveAdoQuestionType({}), 'Task');
    });

    test('normalizeCreatedKey: string passthrough, extractTicketKey fallback', function () {
        var h = helpers();
        assert.equal(h.normalizeCreatedKey('5001'), '5001', 'a string id is the key');
        // the string branch short-circuits BEFORE extraction — any non-empty string
        // passes through verbatim (same as the pre-refactor ternary).
        assert.equal(h.normalizeCreatedKey('{"key":"BICE-9"}'), '{"key":"BICE-9"}');
        assert.equal(h.normalizeCreatedKey('{{{'), '{{{', 'even a garbage string is a string');
        assert.equal(h.normalizeCreatedKey(null), null, 'null → extractTicketKey → null');
        assert.equal(h.normalizeCreatedKey(''), null, 'empty string is not a key → extractTicketKey → null');
    });

    test('assertAllQuestionsCreated: silent on success, throws with the count on failure', function () {
        var h = helpers();
        h.assertAllQuestionsCreated([{ success: true }, { success: true }], 'BICE-1');
        var message = '';
        try {
            h.assertAllQuestionsCreated([{ success: true }, { success: false }, { success: false }], 'BICE-1');
        } catch (e) {
            message = e.message;
        }
        assert.contains(message, 'Failed to create 2 of 3');
        assert.contains(message, 'BICE-1');
    });
});
