/**
 * Pre-CLI Content Output Setup — shared pre-action for content-generating
 * agents (story_description, story_acceptance_criteria, the generic
 * wiki_publisher base agent, …).
 *
 * InputContextBundle chain (gh-1112 AC3) — every step is fault-isolated:
 * a throw in one enrichment is caught and logged as non-fatal so the
 * remaining steps still execute and the CLI starts with the base ticket
 * context:
 *
 *   1. fetchQuestionsToInput.js — question subtasks into the input folder
 *   2. fetchParentContextToInput.js — parent story + [BA]/[SA]/[VD] context
 *      (clean no-op when parentContextFetch is not configured — E1)
 *   3. fetchConfluenceOutputContext.js — when contentOutput targets the wiki
 *      ('confluence' or 'wiki'), snapshot the existing page + inline comments
 *      into the input folder (no-op otherwise)
 */

var fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
var fetchParentContextToInput = require('./fetchParentContextToInput.js');
var fetchConfluenceOutputContext = require('./fetchConfluenceOutputContext.js');

function runStep(name, step, params) {
    try {
        step(params);
    } catch (e) {
        console.warn(name + ' failed (non-fatal):', e);
    }
}

function action(params) {
    try {
        var jobParams = params.jobParams || params;
        var actualParams = params.inputFolderPath ? params : jobParams;

        // fetchQuestionsToInput chains parent-context enrichment for its other
        // callers; this script owns that step explicitly, so the built-in call
        // is suppressed to keep a single parent-context JQL per run (gh-1112).
        var questionsParams = Object.assign({}, actualParams, { skipParentContext: true });
        runStep('fetchQuestionsToInput', fetchQuestionsToInput.action, questionsParams);
        runStep('fetchParentContextToInput', fetchParentContextToInput.action, actualParams);
        runStep('fetchConfluenceOutputContext', fetchConfluenceOutputContext.action, actualParams);
    } catch (error) {
        console.error('Error in preCliContentOutputSetup:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
