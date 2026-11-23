/**
 * Dynamic-Repository setup chaining (gh-823-safe shared helper)
 *
 * Each dmtools JS hook is a separate GraalJS invocation, so a
 * targetRepository resolved in preJSAction does NOT survive to
 * preCliJSAction.  The dynamic-repo agents therefore resolve the repo and run
 * the setup action inside ONE hook; this helper is that single call so the
 * development and story-test-automation wrappers do not duplicate it.
 *
 * Steps:
 *   1. resolveRepoFromTicket.action(params)  → params.customParams.targetRepository
 *   2. write the resolved workingDir to .dmtools-target-workingdir so CLI
 *      shell scripts (e.g. create_test_commit.sh) can find the dependency
 *      dir without re-implementing the [repo] parsing; skipped in dryRun,
 *      non-fatal on failure.
 *   3. run the supplied setup action with the resolved targetRepository.
 *
 * Returns false when the resolver aborts, otherwise the setup result.
 */

var resolveRepo = require('../resolveRepoFromTicket.js');
var branchSetup = require('./branchSetup.js');

function workingDirFromDynamicParams(params) {
    var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
    var targetRepo = customParams.targetRepository || {};
    return targetRepo.workingDir || '';
}

function writeResolvedWorkingDirFile(params, caller) {
    if (branchSetup.isDryRunParams(params)) return;
    var workingDir = workingDirFromDynamicParams(params);
    if (!workingDir) return;
    try {
        file_write({ path: '.dmtools-target-workingdir', content: workingDir });
        console.log(caller + ': wrote workingDir to .dmtools-target-workingdir:', workingDir);
    } catch (e) {
        console.warn(caller + ': could not write .dmtools-target-workingdir (non-fatal):', e);
    }
}

function action(params, setupAction, caller) {
    var label = caller || 'dynamicRepoSetup';
    var resolved = resolveRepo.action(params);
    if (resolved === false) {
        console.warn(label + ': resolveRepoFromTicket returned false — aborting');
        return false;
    }
    writeResolvedWorkingDirFile(params, label);
    return setupAction(params);
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
