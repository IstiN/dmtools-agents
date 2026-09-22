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

function makeOutputFiles(fileMap) {
    return loadModule('js/common/outputFiles.js', makeRequire({}), {
        file_read: function (opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        }
    });
}

function loadCreateQuestionsModule(fileMap, extraGlobals) {
    var outputFiles = makeOutputFiles(fileMap);
    var comments = [];
    var labels = [];
    var moves = [];
    var removedLabels = [];
    var createdTickets = [];

    var globals = {
        file_read: function (opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        },
        jira_post_comment: function (args) { comments.push(args); },
        jira_add_label: function (args) { labels.push(args); },
        jira_move_to_status: function (args) { moves.push(args); },
        jira_remove_label: function (args) { removedLabels.push(args); },
        jira_assign_ticket_to: function () { },
        jira_create_ticket_with_json: function (args) {
            createdTickets.push(args);
            return JSON.stringify({ key: 'BICE-' + (900 + createdTickets.length) });
        }
    };
    for (var k in (extraGlobals || {})) { globals[k] = extraGlobals[k]; }

    var mod = loadModule(
        'js/createQuestionsAndAssignForReview.js',
        makeRequire({
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
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function () { return false; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/outputFiles.js': outputFiles
        }),
        globals
    );

    return {
        mod: mod,
        comments: comments,
        labels: labels,
        moves: moves,
        removedLabels: removedLabels,
        createdTickets: createdTickets
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
