/**
 * Pre-CLI Development Setup — Dynamic Repository variant
 *
 * Chains resolveRepoFromTicket + preCliDevelopmentSetup in a single GraalJS
 * execution so that the resolved targetRepository (repo, baseBranch, workingDir)
 * is visible to the setup action before it performs git checkout.
 *
 * Used by: story_development_dynamic_repo.json (preCliJSAction)
 *
 * Why chaining instead of separate preJSAction + preCliJSAction?
 * In dmtools each JS hook is a separate GraalJS invocation; params mutations made
 * in preJSAction do NOT survive to preCliJSAction.  Running both in one call
 * guarantees the resolved targetRepository is in scope for configLoader.
 */

var resolveRepo = require('./resolveRepoFromTicket.js');
var setupDev    = require('./preCliDevelopmentSetup.js');

function action(params) {
    // 1. Resolve target repo from ticket and mutate params in-place
    var resolved = resolveRepo.action(params);
    if (resolved === false) {
        console.warn('preCliDevelopmentSetupDynamicRepo: resolveRepoFromTicket returned false — aborting');
        return false;
    }

    // 2. Write resolved workingDir to a file so that CLI shell scripts
    //    (e.g. create_test_commit.sh) can discover the correct dependency dir
    //    without duplicating the [repo] parsing logic.
    try {
        var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
        var targetRepo = customParams.targetRepository || {};
        var workingDir = targetRepo.workingDir || '';
        if (workingDir) {
            file_write({ path: '.dmtools-target-workingdir', content: workingDir });
            console.log('preCliDevelopmentSetupDynamicRepo: wrote workingDir to .dmtools-target-workingdir:', workingDir);
        }
    } catch (e) {
        console.warn('preCliDevelopmentSetupDynamicRepo: could not write .dmtools-target-workingdir (non-fatal):', e);
    }

    // 3. Run standard pre-CLI development setup with the resolved targetRepository
    return setupDev.action(params);
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
