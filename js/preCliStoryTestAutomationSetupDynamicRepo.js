/**
 * Pre-CLI Story Test Automation Setup — Dynamic Repository variant
 *
 * Used by: story_test_automation_dynamic_repo.json (preCliJSAction)
 *
 * Thin wrapper: resolveRepoFromTicket + .dmtools-target-workingdir marker +
 * preCliStoryTestAutomationSetup run inside ONE GraalJS hook via the shared
 * js/common/dynamicRepoSetup.js (params mutations do not survive across hooks).
 */

var dynamicRepoSetup  = require('./common/dynamicRepoSetup.js');
var setupTestAutomation = require('./preCliStoryTestAutomationSetup.js');

function action(params) {
    return dynamicRepoSetup.action(params, setupTestAutomation.action, 'preCliStoryTestAutomationSetupDynamicRepo');
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
