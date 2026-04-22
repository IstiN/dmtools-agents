/**
 * Pre-CLI Solution Setup
 *
 * Runs before the story_solution CLI agent:
 *   1. Fetch existing question subtasks into input folder (existing_questions.json)
 *   2. Fetch [BA]/[SA]/[VD] parent context into input folder (opt-in via parentContextFetch)
 */

var fetchQuestionsToInput    = require('./fetchQuestionsToInput.js');
var fetchParentContextToInput = require('./fetchParentContextToInput.js');

function action(params) {
    try {
        var jobParams    = params.jobParams || params;
        var actualParams = params.inputFolderPath ? params : jobParams;

        // 1. Fetch question subtasks
        fetchQuestionsToInput.action(actualParams);

        // 2. Fetch [BA]/[SA]/[VD] parent context (no-op if parentContextFetch not configured)
        try {
            fetchParentContextToInput.action(actualParams);
        } catch (e) {
            console.warn('fetchParentContextToInput failed (non-fatal):', e);
        }

    } catch (error) {
        console.error('Error in preCliSolutionSetup:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
