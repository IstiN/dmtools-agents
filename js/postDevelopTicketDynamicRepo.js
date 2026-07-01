/**
 * Post-Action Development — Dynamic Repository variant
 *
 * Chains resolveRepoFromTicket + developTicketAndCreatePR in a single GraalJS
 * execution so that the resolved targetRepository (repo, baseBranch, workingDir,
 * owner) is visible when configLoader.loadProjectConfig() is called inside
 * developTicketAndCreatePR.
 *
 * Used by: story_development_dynamic_repo.json (postJSAction)
 *
 * Why a wrapper instead of direct postJSAction?
 * Each dmtools JS hook (preJSAction, preCliJSAction, postJSAction) is a separate
 * GraalJS invocation; params mutations made in one hook do NOT survive to the next.
 * Running resolveRepo + developAndPR in the same call keeps targetRepository in scope.
 */

var resolveRepo = require('./resolveRepoFromTicket.js');
var developAndPR = require('./developTicketAndCreatePR.js');

function action(params) {
    // 1. Re-resolve target repo from ticket summary into params
    resolveRepo.action(params);

    // 2. Run standard post-action (git push + MR creation) with resolved config
    return developAndPR.action(params);
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
