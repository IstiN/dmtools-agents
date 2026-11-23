/**
 * Pre-CLI Development Setup — Dynamic Repository variant
 *
 * Used by: story_development_dynamic_repo.json (preCliJSAction)
 *
 * Thin wrapper: resolveRepoFromTicket + .dmtools-target-workingdir marker +
 * preCliDevelopmentSetup run inside ONE GraalJS hook via the shared
 * js/common/dynamicRepoSetup.js (params mutations do not survive across hooks).
 */

var dynamicRepoSetup = require('./common/dynamicRepoSetup.js');
var setupDev        = require('./preCliDevelopmentSetup.js');

function action(params) {
    return dynamicRepoSetup.action(params, setupDev.action, 'preCliDevelopmentSetupDynamicRepo');
}

if (typeof module !== 'undefined') {
    module.exports = { action: action };
}
