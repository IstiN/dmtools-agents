/**
 * Shared action skeleton for the test-automation post-actions
 * (triggerBugTestAutomation, triggerStoryTestAutomation).
 *
 * gh-1250: both actions used to carry byte-identical copies of the gh-1229
 * header block (configOf/customParamsOf + triggerWorkflowOrAskSm), the
 * success/error reporting tail, and the try/catch wrapper; this module is
 * the single parameterized copy. The per-workflow differences (customParams
 * flag names, config-file key, stripKeys, log noun) live in VARIANTS, keyed
 * by the workflow label; the remaining differences arrive as hooks on
 * runTriggerAction's opts. Log output is byte-identical to the previous
 * inline flow.
 */

var autoStart = require('./autoStart.js');
var tokenUsageComment = require('./tokenUsageComment.js');

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

/**
 * The shared action skeleton: resolve ticket/config/customParams, log the
 * header, trigger the workflow (or ask the SM), run the per-action
 * beforeHeader/afterTrigger hooks, post token-usage comments (never failing
 * the action on them), and report the structured result. Behavior and log
 * output are byte-identical to the previous inline flow in each action.
 *
 * @param {Object} opts
 * @param {Object} opts.params - the action params.
 * @param {string} opts.label - workflow label; selects the VARIANTS entry.
 * @param {string} opts.keyName - result property name ('bugKey'/'storyKey').
 * @param {string} opts.errorPrefix - console.error prefix on action failure.
 * @param {Function} opts.logHeader - logs the '=== Triggering ... ===' line.
 * @param {Function} [opts.beforeHeader] - runs after params resolve, before
 *     logHeader; its return value is handed to afterTrigger/tokenUsageOptions.
 * @param {Function} opts.afterTrigger - per-action post-trigger step.
 * @param {Function} opts.tokenUsageOptions - builds the
 *     postTokenUsageComments options from (params, beforeHeader context).
 * @returns {Object} structured action result.
 */
function runTriggerAction(opts) {
    try {
        var params = opts.params;
        var ticketKey = params.ticket.key;
        var config = configOf(params);
        var customParams = customParamsOf(params);
        var context = opts.beforeHeader ? opts.beforeHeader(config, customParams) : null;

        opts.logHeader(ticketKey);

        var triggered = triggerWorkflowOrAskSm({
            ticketKey: ticketKey,
            config: config,
            customParams: customParams,
            label: opts.label
        });

        opts.afterTrigger(ticketKey, config, customParams, context);

        tokenUsageComment.postTokenUsageCommentsSafely(ticketKey, opts.tokenUsageOptions(params, context));

        var result = { success: true, triggered: triggered };
        result[opts.keyName] = ticketKey;
        return result;
    } catch (error) {
        console.error(opts.errorPrefix, error);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        configOf: configOf,
        customParamsOf: customParamsOf,
        triggerWorkflowOrAskSm: triggerWorkflowOrAskSm,
        runTriggerAction: runTriggerAction
    };
}
