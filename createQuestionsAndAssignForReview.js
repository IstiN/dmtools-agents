/**
 * Create Questions and Assign For Review Action
 * Creates subtasks based on AI-generated questions and assigns parent ticket for review
 */

var jiraHelpers = require('./common/jiraHelpers.js');
var aiResponseParser = require('./common/aiResponseParser.js');
var trackersModule = require('./js/common/trackers.js');
var configLoader = null;
try { configLoader = require('./js/configLoader.js'); } catch (e) { /* unit tests may omit configLoader */ }

function resolveCustomParams(params) {
    return (params && params.jobParams && params.jobParams.customParams) ||
        (params && params.customParams) || {};
}

function resolveProjectConfig(params) {
    if (!configLoader || typeof configLoader.loadProjectConfig !== 'function') {
        return null;
    }
    return configLoader.loadProjectConfig((params && params.jobParams) || params);
}

function resolveAdoWorkItemType(projectConfig) {
    var jiraCfg = projectConfig && projectConfig.jira;
    return (jiraCfg && jiraCfg.questions && jiraCfg.questions.workItemType) || 'Task';
}

function resolveQuestionLabel(projectConfig) {
    return (projectConfig && projectConfig.labels && projectConfig.labels.QUESTION) || 'question';
}

function buildJiraQuestionFields(summary, description, parentKey, priority) {
    var fieldsJson = {
        summary: summary,
        description: description,
        issuetype: { name: 'Subtask' },
        parent: { key: parentKey }
    };
    if (priority) {
        fieldsJson.priority = { name: priority };
    }
    return fieldsJson;
}

function normalizeCreatedKey(result) {
    if (typeof result === 'string' && result) {
        return result;
    }
    return jiraHelpers.extractTicketKey(result);
}

function createAdoQuestionTicket(tracker, projectKey, summary, description, parentKey, priority, projectConfig) {
    var adoType = resolveAdoWorkItemType(projectConfig);
    var questionLabel = resolveQuestionLabel(projectConfig);
    var result = tracker.createTicketWithParent(projectKey, adoType, summary, description, parentKey, {
        labels: [questionLabel]
    });
    var createdKey = normalizeCreatedKey(result);
    if (createdKey && priority) {
        try {
            tracker.setPriority(createdKey, priority);
        } catch (priorityError) {
            console.warn('Could not set priority on question ' + createdKey + ' (non-fatal):', priorityError);
        }
    }
    return createdKey;
}

function createOneQuestionSubtask(question, index, parentKey, projectKey, activeTracker, projectConfig) {
    var summary = aiResponseParser.buildSummary(question.summary, index);
    var description = aiResponseParser.buildDescription(question);
    try {
        var createdKey;
        if (activeTracker.provider() === 'ado') {
            createdKey = createAdoQuestionTicket(
                activeTracker, projectKey, summary, description, parentKey, question.priority, projectConfig
            );
        } else {
            var fieldsJson = buildJiraQuestionFields(summary, description, parentKey, question.priority);
            createdKey = normalizeCreatedKey(activeTracker.createTicketWithFields(projectKey, fieldsJson));
        }
        console.log('Created question subtask ' + (createdKey || '(unknown key)') +
            ' with priority ' + (question.priority || 'default') + ' for summary "' + summary + '"');
        return {
            summary: summary,
            priority: question.priority,
            key: createdKey
        };
    } catch (error) {
        console.error('Failed to create question subtask for summary "' + summary + '":', error);
        return {
            summary: summary,
            priority: question.priority,
            error: error.toString()
        };
    }
}

function processQuestionTickets(response, parentKey, tracker, projectConfig) {
    var questions = aiResponseParser.parseQuestionsResponse(response);
    if (questions.length === 0) {
        console.log('No follow-up questions detected, skipping ticket creation.');
        return [];
    }

    var activeTracker = tracker || trackersModule.createTracker(projectConfig || null, {});
    var projectKey = String(parentKey).split('-')[0];
    var createdTickets = [];

    questions.forEach(function (question, index) {
        createdTickets.push(
            createOneQuestionSubtask(question, index, parentKey, projectKey, activeTracker, projectConfig)
        );
    });

    return createdTickets;
}

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var initiatorId = params.initiator;
        var customParams = resolveCustomParams(params);
        var projectConfig = resolveProjectConfig(params);
        var tracker = trackersModule.createTracker(projectConfig, customParams);

        console.log('Processing ticket:', ticketKey);
        var createdQuestionTickets = processQuestionTickets(params.response, ticketKey, tracker, projectConfig);

        // Add AI-generated label
        tracker.addLabel(ticketKey, 'ai_questions_asked');

        // Use common assignForReview function for post-processing
        var assignResult = jiraHelpers.assignForReview(ticketKey, initiatorId, null, null, tracker);
        if (!assignResult.success) {
            return assignResult;
        }

        return {
            success: true,
            message: 'Ticket ' + ticketKey + ' assigned, moved to In Review, created ' +
                createdQuestionTickets.length + ' question subtasks',
            createdQuestions: createdQuestionTickets
        };
    } catch (error) {
        console.error('❌ Error:', error);
        return {
            success: false,
            error: error.toString()
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        processQuestionTickets: processQuestionTickets,
        resolveCustomParams: resolveCustomParams,
        resolveProjectConfig: resolveProjectConfig,
        resolveAdoWorkItemType: resolveAdoWorkItemType,
        resolveQuestionLabel: resolveQuestionLabel,
        buildJiraQuestionFields: buildJiraQuestionFields,
        normalizeCreatedKey: normalizeCreatedKey
    };
}
