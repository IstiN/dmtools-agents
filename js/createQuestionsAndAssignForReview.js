/**
 * Create Questions and Assign For Review Post-Action
 * Reads AI-generated outputs/questions.json, creates question subtasks in Jira,
 * labels the parent ticket, and assigns it for review.
 *
 * questions.json format:
 * [
 *   {
 *     "summary": "Clarify requirements",          // [Q] prefix added automatically if missing
 *     "priority": "High",
 *     "description": "outputs/questions/question-1.md",
 *     "answer": "..."                              // optional, pre-filled answer
 *   }
 * ]
 */

const { extractTicketKey } = require('./common/jiraHelpers.js');
const { buildSummary } = require('./common/aiResponseParser.js');
const configLoader = require('./configLoader.js');

/**
 * Ensure summary starts with [Q] prefix
 */
function ensureQPrefix(summary) {
    if (!summary || summary.indexOf('[Q]') === 0) {
        return summary;
    }
    return '[Q] ' + summary;
}

/**
 * Read and parse outputs/questions.json
 * @returns {Array} Array of question entries, or empty array on error
 */
function readQuestionsJson() {
    try {
        var raw = file_read('outputs/questions.json');
        if (!raw || raw.trim() === '') {
            console.warn('outputs/questions.json is empty');
            return [];
        }
        var parsed = JSON.parse(raw);
        // Handle both plain array [...] and wrapped {"questions": [...]} formats
        if (!Array.isArray(parsed)) {
            if (parsed && Array.isArray(parsed.questions)) {
                console.warn('outputs/questions.json was wrapped in {"questions":[...]} — using inner array. Agent should write a plain JSON array.');
                return parsed.questions;
            }
            console.warn('outputs/questions.json is not an array');
            return [];
        }
        return parsed;
    } catch (error) {
        console.error('Failed to read/parse outputs/questions.json:', error);
        return [];
    }
}

/**
 * Read a description file, falling back to the entry summary
 */
function readDescriptionFile(filePath, fallbackSummary) {
    if (!filePath) {
        return fallbackSummary || '';
    }
    try {
        var content = file_read(filePath);
        if (content && content.trim() !== '') {
            return content;
        }
    } catch (error) {
        console.warn('Could not read description file ' + filePath + ':', error);
    }
    return fallbackSummary || '';
}

/**
 * Create a single question subtask in Jira
 * @param {Object} entry - Entry from questions.json
 * @param {string} parentKey - Parent story ticket key
 * @param {string} projectKey - Jira project key
 * @param {Object} jiraConfig - Resolved jira config (issueTypes, labels, questions)
 * @returns {string|null} Created ticket key or null on failure
 */
function createQuestion(entry, parentKey, projectKey, jiraConfig) {
    var summary = ensureQPrefix(buildSummary(entry.summary, 0));
    var description = readDescriptionFile(entry.description, entry.summary);
    var questionIssueType = jiraConfig.issueTypes.SUBTASK;
    var questionLabel = jiraConfig.labels.QUESTION;
    var answerField = jiraConfig.questions.answerField;

    var fieldsJson = {
        summary: summary,
        description: description,
        issuetype: { name: questionIssueType },
        parent: { key: parentKey },
        labels: [questionLabel]
    };

    if (entry.priority) {
        fieldsJson.priority = { name: entry.priority };
    }

    if (entry.answer) {
        fieldsJson[answerField] = entry.answer;
    }

    try {
        var result = jira_create_ticket_with_json({
            project: projectKey,
            fieldsJson: fieldsJson
        });
        var key = extractTicketKey(result);
        console.log('Created question subtask ' + (key || '(unknown key)') + ': ' + summary);
        return key;
    } catch (error) {
        console.error('Failed to create question subtask "' + summary + '":', error);
        return null;
    }
}

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var projectKey = ticketKey.split('-')[0];
        var initiatorId = params.initiator;
        var wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;

        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var jiraConfig = projectConfig.jira;
        var labels = projectConfig.labels;

        console.log('Processing question creation for:', ticketKey);

        // 1. Read questions.json
        var questions = readQuestionsJson();
        console.log('Found ' + questions.length + ' entries in questions.json');

        if (questions.length === 0) {
            console.log('No questions to create — skipping ticket creation.');
        }

        // 2. Create question subtasks
        var createdTickets = [];
        questions.forEach(function(entry) {
            var key = createQuestion(entry, ticketKey, projectKey, Object.assign({}, jiraConfig, { labels: labels }));
            createdTickets.push({
                summary: ensureQPrefix(entry.summary || ''),
                priority: entry.priority,
                key: key,
                success: !!key
            });
        });

        // 3. Add ai_questions_asked label to parent ticket
        try {
            jira_add_label({
                key: ticketKey,
                label: labels.AI_QUESTIONS_ASKED
            });
        } catch (labelError) {
            console.warn('Failed to add ' + labels.AI_QUESTIONS_ASKED + ' label:', labelError);
        }

        // 4. Add ai_generated label
        try {
            jira_add_label({
                key: ticketKey,
                label: labels.AI_GENERATED
            });
        } catch (labelError) {
            console.warn('Failed to add ' + labels.AI_GENERATED + ' label:', labelError);
        }

        // 5. Assign to initiator
        try {
            jira_assign_ticket_to({
                key: ticketKey,
                accountId: initiatorId
            });
            console.log('Assigned ' + ticketKey + ' to initiator');
        } catch (assignError) {
            console.warn('Failed to assign ticket:', assignError);
        }

        // 6. Move parent story to PO Review
        try {
            jira_move_to_status({
                key: ticketKey,
                statusName: jiraConfig.statuses.PO_REVIEW
            });
            console.log('Moved ' + ticketKey + ' to PO Review');
        } catch (statusError) {
            console.warn('Failed to move ' + ticketKey + ' to PO Review:', statusError);
        }

        // 7. Remove WIP label if present
        if (wipLabel) {
            try {
                jira_remove_label({
                    key: ticketKey,
                    label: wipLabel
                });
                console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
            } catch (wipError) {
                console.warn('Failed to remove WIP label:', wipError);
            }
        }

        return {
            success: true,
            message: 'Ticket ' + ticketKey + ' moved to PO Review, created ' + createdTickets.length + ' question subtask(s)',
            createdQuestions: createdTickets
        };

    } catch (error) {
        console.error('Error in createQuestionsAndAssignForReview:', error);
        return {
            success: false,
            error: error.toString()
        };
    }
}
