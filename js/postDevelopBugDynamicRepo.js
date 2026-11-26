/**
 * Develop Bug and Create PR Post-Action — Dynamic Repository variant
 *
 * Chains resolveRepoFromTicket + developBugAndCreatePR in a single GraalJS
 * execution so that the resolved targetRepository (repo, baseBranch, workingDir,
 * owner) is visible when configLoader.loadProjectConfig() is called inside
 * developBugAndCreatePR.
 *
 * Used by: bug_development_dynamic_repo.json (postJSAction)
 *
 * Why a wrapper instead of direct postJSAction?
 * Each dmtools JS hook (preJSAction, preCliJSAction, postJSAction) is a separate
 * GraalJS invocation; params mutations made in one hook do NOT survive to the next.
 * Running resolveRepo + the bug post-action in the same call keeps
 * targetRepository in scope.
 */

var resolveRepo = require('./resolveRepoFromTicket.js');
var developBug = require('./developBugAndCreatePR.js');

function action(params) {
    // 1. Re-resolve target repo from ticket summary into params
    resolveRepo.action(params);

    // 2. Run standard bug post-action (git push + PR creation) with resolved config
    return developBug.action(params);
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
