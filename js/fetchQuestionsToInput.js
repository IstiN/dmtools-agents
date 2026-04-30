/**
 * Fetch Questions To Input Pre-CLI Action
 * Fetches existing question subtasks for the current story ticket and writes
 * them to the input folder before the CLI agent runs.
 * Receives params.inputFolderPath from DMTools after input folder creation.
 *
 * Configurable via .dmtools/config.js:
 *   jira.questions.fetchJql   — JQL to find question subtasks ({ticketKey} placeholder)
 *   jira.questions.answerField — Jira custom field name for the answer (default: 'Answer')
 */

var configLoader = require('./configLoader.js');

function getAnswerValue(fields, answerField) {
    if (!fields || !answerField) {
        return null;
    }

    var exact = fields[answerField];
    if (exact) {
        return exact;
    }

    var lower = fields[answerField.toLowerCase()];
    if (lower) {
        return lower;
    }

    if (answerField.indexOf('customfield_') === 0) {
        var suffix = '(' + answerField + ')';
        for (var key in fields) {
            if (!Object.prototype.hasOwnProperty.call(fields, key)) {
                continue;
            }
            if (key === answerField || key.toLowerCase() === answerField.toLowerCase()) {
                return fields[key];
            }
            if (key.slice(-suffix.length) === suffix) {
                return fields[key];
            }
        }
    }

    return null;
}

/**
 * Pre-CLI action: fetch question subtasks into input folder
 *
 * @param {Object} params - Parameters from DMTools
 * @param {string} params.inputFolderPath - Path to the input folder for this run
 */
function action(params) {
    try {
        var folder = params.inputFolderPath;
        // Ticket key is always the last segment of the input folder path.
        var ticketKey = folder.split('/').pop();
        console.log('Fetching question subtasks for ' + ticketKey + '...');

        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var questionsConfig = projectConfig.jira.questions;
        var jql = questionsConfig.fetchJql.replace('{ticketKey}', ticketKey);
        var answerField = questionsConfig.answerField;

        try {
            var rawQuestions = jira_search_by_jql({
                jql: jql,
                fields: ['key', 'summary', 'description', 'status', 'priority', answerField]
            });
            var questions = [];
            for (var i = 0; i < rawQuestions.length; i++) {
                var issue = rawQuestions[i];
                var f = issue.fields || {};
                questions.push({
                    key: issue.key || '',
                    summary: f.summary || '',
                    description: f.description || '',
                    status: f.status ? f.status.name : '',
                    priority: f.priority ? f.priority.name : '',
                    answer: getAnswerValue(f, answerField)
                });
            }
            console.log('Found ' + questions.length + ' question subtasks');
            // Wrap in object: file_write bridge auto-parses strings starting with '[' as ArrayList.
            file_write(folder + '/existing_questions.json', '{"questions":' + JSON.stringify(questions, null, 2) + '}');
            console.log('Wrote existing_questions.json to ' + folder);
        } catch (fetchError) {
            console.error('Failed to fetch questions, continuing without file:', fetchError);
        }
    } catch (error) {
        console.error('Error in fetchQuestionsToInput:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, getAnswerValue };
}
