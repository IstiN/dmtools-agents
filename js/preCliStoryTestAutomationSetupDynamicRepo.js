/**
 * Pre-CLI Story Test Automation Setup — Dynamic Repository variant
 *
 * Chains resolveRepoFromTicket + preCliStoryTestAutomationSetup in a single
 * GraalJS execution so that the resolved targetRepository (repo, baseBranch,
 * workingDir) is visible to the setup action before it performs git checkout.
 *
 * Used by: story_test_automation_dynamic_repo.json (preCliJSAction)
 *
 * Why chaining instead of separate preJSAction + preCliJSAction?
 * In dmtools each JS hook is a separate GraalJS invocation; params mutations made
 * in preJSAction do NOT survive to preCliJSAction.  Running both in one call
 * guarantees the resolved targetRepository is in scope for configLoader.
 */

var resolveRepo = require('./resolveRepoFromTicket.js');
var setupTestAutomation = require('./preCliStoryTestAutomationSetup.js');
var branchSetup = require('./common/branchSetup.js');

function workingDirFromDynamicParams(params) {
    var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
    var targetRepo = customParams.targetRepository || {};
    return targetRepo.workingDir || '';
}

function writeResolvedWorkingDirFile(params) {
    if (branchSetup.isDryRunParams(params)) return;
    try {
        var workingDir = workingDirFromDynamicParams(params);
        if (workingDir) {
            file_write({ path: '.dmtools-target-workingdir', content: workingDir });
            console.log('preCliStoryTestAutomationSetupDynamicRepo: wrote workingDir to .dmtools-target-workingdir:', workingDir);
        }
    } catch (e) {
        console.warn('preCliStoryTestAutomationSetupDynamicRepo: could not write .dmtools-target-workingdir (non-fatal):', e);
    }
}

function action(params) {
    // 1. Resolve target repo from ticket and mutate params in-place
    var resolved = resolveRepo.action(params);
    if (resolved === false) {
        console.warn('preCliStoryTestAutomationSetupDynamicRepo: resolveRepoFromTicket returned false — aborting');
        return false;
    }

    // 2. Write resolved workingDir to a file so that CLI shell scripts can
    //    discover the correct dependency dir without duplicating the
    //    [repo] parsing logic.
    writeResolvedWorkingDirFile(params);

    // 3. Run standard pre-CLI story test automation setup with the resolved targetRepository
    return setupTestAutomation.action(params);
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
