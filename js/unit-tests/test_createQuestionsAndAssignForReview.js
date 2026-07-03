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
        file_read: function(opts) {
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
        file_read: function(opts) {
            var path = opts && (opts.path || opts);
            return fileMap[path] !== undefined ? fileMap[path] : null;
        },
        jira_post_comment: function(args) { comments.push(args); },
        jira_add_label: function(args) { labels.push(args); },
        jira_move_to_status: function(args) { moves.push(args); },
        jira_remove_label: function(args) { removedLabels.push(args); },
        jira_assign_ticket_to: function() {},
        jira_create_ticket_with_json: function(args) {
            createdTickets.push(args);
            return JSON.stringify({ key: 'BICE-' + (900 + createdTickets.length) });
        }
    };
    for (var k in (extraGlobals || {})) { globals[k] = extraGlobals[k]; }

    var mod = loadModule(
        'js/createQuestionsAndAssignForReview.js',
        makeRequire({
            './common/jiraHelpers.js': { extractTicketKey: function(result) {
                try { return JSON.parse(result).key; } catch (e) { return null; }
            }},
            './common/aiResponseParser.js': { buildSummary: function(summary, index) {
                return summary || ('Follow-up question #' + (index + 1));
            }},
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/scm.js': { createScm: function() { return {}; } },
            './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; } },
            './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
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

suite('createQuestionsAndAssignForReview — module export', function() {
    test('module.exports is guarded with typeof for direct execution (postJSAction) compatibility', function() {
        var code = file_read({ path: 'js/createQuestionsAndAssignForReview.js' });
        var hasGuard = code.indexOf('typeof module') !== -1 || code.indexOf('module.exports') === -1;
        assert.equal(hasGuard, true, 'module.exports usage (if any) should be guarded');
    });
});

suite('createQuestionsAndAssignForReview — with questions', function() {
    test('creates a subtask per entry in questions.json', function() {
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

suite('createQuestionsAndAssignForReview — no questions, with response.md', function() {
    test('posts response.md content as explanation comment', function() {
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

suite('createQuestionsAndAssignForReview — no questions, no response.md', function() {
    test('posts a fallback warning comment instead of silently skipping', function() {
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
