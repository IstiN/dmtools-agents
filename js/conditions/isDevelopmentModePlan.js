/**
 * Condition script for conditional cliPrompts sections:
 * Returns true when the development leg should carry the plan-mode appendix:
 * mode "plan" (gh-1435 resolver contract, case-sensitive lowercase only) AND
 * the appendix has been materialized at the runtime path by the leg's preCli
 * setup (js/common/developmentModePlan.js). The existence check keeps a
 * degraded materialization from leaking the runtime path into the assembled
 * prompt — the leg fails in preCli instead.
 *
 * gh-1503: adaptive legs no longer route through this entry. Adaptive mode is
 * an in-leg SP decision — the adaptive leg carries the scope-estimate appendix
 * (isDevelopmentModeAdaptiveSp.js) and, when it escalates, reads the plan
 * appendix FILE that the adaptive preCli step materializes for exactly that
 * purpose. The former gh-1437 signal-routed adaptive→plan admission is gone.
 *
 * Adaptive shadow legs NEVER carry the appendix: shadowMode is an adaptive
 * concept and adaptive is excluded above regardless.
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
    var customParams = resolveCustomParams(params);
    if (resolvedModeIsPlan(customParams)) {
        return appendixFileReadable(appendixRuntimePath());
    }
    // gh-1503: adaptive legs NEVER carry the plan prompt entry. Their
    // escalation path is the SP appendix (isDevelopmentModeAdaptiveSp.js),
    // which points the agent at the plan appendix FILE for an on-demand
    // read when it self-selects plan — the file is materialized by the
    // adaptive preCli step, but the prompt carries only the SP block.
    return false;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        appendixRuntimePath: appendixRuntimePath,
        resolveCustomParams: resolveCustomParams
    };
}
