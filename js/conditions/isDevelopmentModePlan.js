/**
 * Condition script for conditional cliPrompts sections:
 * Returns true when the development leg runs in PLAN mode
 * (params.customParams.developmentMode resolves to "plan" — the gh-1435
 * resolver's contract, case-sensitive lowercase only) AND the plan-mode
 * appendix has been materialized at the runtime path by the leg's preCli
 * setup (js/common/developmentModePlan.js). The existence check keeps a
 * degraded materialization from leaking the runtime path into the assembled
 * prompt — the leg fails in preCli instead.
 *
 * Used in agent JSON configs:
 *   {
 *     "id": "developmentModePlan",
 *     "prompt": "./.dmtools/development-mode-plan-appendix.md",
 *     "condition": "agents/js/conditions/isDevelopmentModePlan.js"
 *   }
 *
 * Self-contained (no require) on purpose — the established pattern for
 * condition scripts (see isCodeGraphAvailable.js).
 */

/** The materialized appendix path — must match js/common/developmentModePlan.js. */
function appendixRuntimePath() {
    return '.dmtools/development-mode-plan-appendix.md';
}

function resolveCustomParams(params) {
    if (params && params.jobParams && params.jobParams.customParams) {
        return params.jobParams.customParams;
    }
    if (params && params.customParams) {
        return params.customParams;
    }
    return {};
}

/** The gh-1435 resolver contract: valid modes are lowercase "plan"/"adaptive"/"default". */
function resolvedModeIsPlan(customParams) {
    return !!customParams && customParams.developmentMode === 'plan';
}

function appendixFileReadable(path) {
    try {
        var content = file_read({ path: path });
        return typeof content === 'string' && content.length > 0;
    } catch (e) {
        return false;
    }
}

function action(params) {
    if (!resolvedModeIsPlan(resolveCustomParams(params))) {
        return false;
    }
    return appendixFileReadable(appendixRuntimePath());
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        appendixRuntimePath: appendixRuntimePath,
        resolveCustomParams: resolveCustomParams
    };
}
