/**
 * Shared trigger helper for the test-automation post-actions
 * (triggerBugTestAutomation, triggerStoryTestAutomation).
 *
 * gh-1250: both actions used to carry byte-identical copies of the gh-1229
 * header block (configOf/customParamsOf + triggerWorkflowOrAskSm); this module
 * is the single parameterized copy. The per-workflow differences (customParams
 * flag names, config-file key, stripKeys, log noun) live in VARIANTS, keyed by
 * the workflow label. Log output is byte-identical to the previous inline flow.
 */

var autoStart = require('./autoStart.js');

/** Config: jobParams wins (Teammate path), then top-level, then {}. */
function configOf(params) {
    return params.jobParams && params.jobParams.config
        ? params.jobParams.config
        : (params.config || {});
}

/** Custom params: jobParams wins (Teammate path), then top-level, then {}. */
function customParamsOf(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/**
 * Per-workflow differences, keyed by the workflow label passed to autoStart.
 * flagName/configFileKey are customParams keys; stripKeys are the keys
 * autoStart strips from customParams; noun is 'Bug' or 'Story' in log lines.
 */
var VARIANTS = {
    bug_test_automation: {
        flagName: 'autoStartBugTestAutomation',
        configFileKey: 'autoStartBugTestAutomationConfigFile',
        stripKeys: [
            'removeLabel',
            'autoStartBugTestAutomation',
            'autoStartBugTestAutomationConfigFile'
        ],
        noun: 'Bug'
    },
    story_test_automation: {
        flagName: 'autoStartStoryTestAutomation',
        configFileKey: 'autoStartStoryTestAutomationConfigFile',
        stripKeys: [
            'removeLabel',
            'autoStartStoryTestAutomation',
            'autoStartStoryTestAutomationConfigFile'
        ],
        noun: 'Story'
    }
};

/**
 * Trigger the configured test-automation workflow via autoStart when fully
 * configured; otherwise ask the SM to re-evaluate. Returns whether the
 * workflow fired.
 *
 * @param {Object} opts
 * @param {string} opts.ticketKey - ticket to trigger the workflow for.
 * @param {Object} opts.config - project config for the SM fallback call.
 * @param {Object} opts.customParams - job custom params.
 * @param {string} opts.label - workflow label; selects the VARIANTS entry.
 * @returns {boolean} whether the workflow fired.
 */
function triggerWorkflowOrAskSm(opts) {
    var ticketKey = opts.ticketKey;
    var config = opts.config;
    var customParams = opts.customParams;
    var variant = VARIANTS[opts.label];
    var triggered = false;
    if (customParams[variant.flagName] && customParams[variant.configFileKey]) {
        triggered = autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: ticketKey,
            customParams: customParams,
            config: config,
            configFile: customParams[variant.configFileKey],
            label: opts.label,
            stripKeys: variant.stripKeys
        });
    }

    if (!triggered) {
        console.log(variant.noun + ' test automation not triggered via autoStart; asking SM to re-evaluate.');
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
    } else {
        console.log('✅ Triggered ' + opts.label + ' for', ticketKey);
    }
    return triggered;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        configOf: configOf,
        customParamsOf: customParamsOf,
        triggerWorkflowOrAskSm: triggerWorkflowOrAskSm
    };
}
