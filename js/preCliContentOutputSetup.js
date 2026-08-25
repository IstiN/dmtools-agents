/**
 * Pre-CLI Content Output Setup — shared pre-action for content-generating
 * agents (story_description, story_acceptance_criteria, …).
 *
 * Chains:
 *   1. fetchQuestionsToInput.js — fetch question subtasks into input folder
 *   2. fetchConfluenceOutputContext.js — when contentOutput targets Confluence,
 *      snapshot the existing page + inline comments into the input folder
 *      (no-op otherwise, so behavior without contentOutput is unchanged)
 */

var fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
var fetchConfluenceOutputContext = require('./fetchConfluenceOutputContext.js');

function action(params) {
    try {
        var jobParams = params.jobParams || params;
        var actualParams = params.inputFolderPath ? params : jobParams;

        fetchQuestionsToInput.action(actualParams);

        try {
            fetchConfluenceOutputContext.action(actualParams);
        } catch (e) {
            console.warn('fetchConfluenceOutputContext failed (non-fatal):', e);
        }
    } catch (error) {
        console.error('Error in preCliContentOutputSetup:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
