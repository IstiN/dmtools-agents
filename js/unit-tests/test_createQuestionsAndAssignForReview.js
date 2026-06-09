/**
 * Unit tests for js/createQuestionsAndAssignForReview.js
 */

function loadCreateQuestionsAction(mocks) {
    var defaults = {
        file_read: function() { return null; },
        jira_create_ticket_with_json: function() { return { key: 'PROJ-2' }; },
        jira_add_label: function() {},
        jira_assign_ticket_to: function() {},
        jira_move_to_status: function() {},
        jira_remove_label: function() {}
    };

    return loadModule(
        'js/createQuestionsAndAssignForReview.js',
        makeRequire({
            './common/jiraHelpers.js': {
                extractTicketKey: function(result) {
                    return result && result.key ? result.key : null;
                }
            },
            './common/aiResponseParser.js': {
                buildSummary: function(summary) {
                    return summary || '';
                }
            },
            './configLoader.js': {
                loadProjectConfig: function() {
                    return {
                        jira: {
                            issueTypes: { SUBTASK: 'Sub-task' },
                            questions: { answerField: 'Answer' },
                            statuses: { PO_REVIEW: 'PO REVIEW' }
                        },
                        labels: {
                            QUESTION: 'q',
                            AI_QUESTIONS_ASKED: 'ai_questions_asked',
                            AI_GENERATED: 'ai_generated'
                        }
                    };
                }
            },
            './common/scm.js': {
                createScm: function() { return {}; }
            },
            './common/autoStart.js': {
                triggerConfiguredWorkflowForTicket: function() {}
            }
        }),
        Object.assign({}, defaults, mocks || {})
    );
}

suite('createQuestionsAndAssignForReview', function() {
    test('sends priority as a string in jira_create_ticket_with_json', function() {
        var createCalls = [];
        var module = loadCreateQuestionsAction({
            file_read: function(pathOrOpts) {
                var path = typeof pathOrOpts === 'string' ? pathOrOpts : pathOrOpts.path;
                if (path === 'outputs/questions.json') {
                    return JSON.stringify([
                        {
                            summary: 'Clarify acceptance criteria',
                            priority: 'High',
                            description: 'outputs/questions/question-1.md'
                        }
                    ]);
                }
                if (path === 'outputs/questions/question-1.md') {
                    return 'Question details';
                }
                return null;
            },
            jira_create_ticket_with_json: function(args) {
                createCalls.push(args);
                return { key: 'PROJ-22' };
            }
        });

        var result = module.action({
            ticket: { key: 'PROJ-1' },
            initiator: 'acc-1',
            jobParams: {
                customParams: {
                    priorityMap: {
                        High: 'Medium'
                    }
                }
            }
        });

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(createCalls.length, 1, 'one question ticket created');
        assert.equal(createCalls[0].fieldsJson.priority, 'Medium', 'priority is mapped and sent as string');
    });
});
