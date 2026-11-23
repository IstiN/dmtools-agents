/**
 * Post-Action Story Test Automation — Dynamic Repository variant
 *
 * Chains resolveRepoFromTicket + postStoryTestAutomationResults in a single
 * GraalJS execution so that the resolved targetRepository (repo, baseBranch,
 * workingDir, owner) is visible when configLoader.loadProjectConfig() is
 * called inside postStoryTestAutomationResults.
 *
 * Used by: story_test_automation_dynamic_repo.json (postJSAction)
 *
 * Why a wrapper instead of direct postJSAction?
 * Each dmtools JS hook (preJSAction, preCliJSAction, postJSAction) is a separate
 * GraalJS invocation; params mutations made in one hook do NOT survive to the next.
 * Running resolveRepo + results processing in the same call keeps targetRepository in scope.
 */

var resolveRepo = require('./resolveRepoFromTicket.js');
var postResults = require('./postStoryTestAutomationResults.js');

function action(params) {
    // 1. Re-resolve target repo from ticket summary into params
    resolveRepo.action(params);

    // 2. Run standard post-action (commit + push + PR) with resolved config
    return postResults.action(params);
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
