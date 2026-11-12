/**
 * Condition script for conditional cliPrompts sections:
 * Returns true when the development leg should carry the plan-mode appendix:
 * - mode "plan" (gh-1435 resolver contract, case-sensitive lowercase only),
 *   or mode "adaptive" routed to plan by the gh-1437 threshold decision —
 * AND the appendix has been materialized at the runtime path by the leg's
 * preCli setup (js/common/developmentModePlan.js materializes for plan legs,
 * js/common/developmentModeAdaptive.js for adaptive legs routed to plan).
 * The existence check keeps a degraded materialization from leaking the
 * runtime path into the assembled prompt — the leg fails in preCli instead.
 *
 * Adaptive shadow legs NEVER carry the appendix: the shadowMode guard
 * short-circuits before any IO, so even a stale materialized file from a
 * previous leg cannot leak into a shadow leg's prompt (the preCli step also
 * removes stale state; this guard is the second line of defense).
 *
 * Contract note: for adaptive legs the file's post-setup existence IS the
 * decision record — the preCli materialization/cleanup is its single writer.
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

/**
 * Adaptive shadowMode guard (gh-1437): strict `=== true` — anything else
 * (absent, null, wrong-typed) is non-shadow, mirroring the resolver's
 * permissive read in js/common/developmentModeAdaptive.js.
 */
function adaptiveShadowMode(customParams) {
    var config = customParams && customParams.developmentModeConfig;
    var adaptive = config && typeof config === 'object' ? config.adaptive : null;
    return !!(adaptive && typeof adaptive === 'object' && adaptive.shadowMode === true);
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
    if (!!customParams && customParams.developmentMode === 'adaptive') {
        if (adaptiveShadowMode(customParams)) {
            return false;
        }
        return appendixFileReadable(appendixRuntimePath());
    }
    return false;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        appendixRuntimePath: appendixRuntimePath,
        resolveCustomParams: resolveCustomParams,
        adaptiveShadowMode: adaptiveShadowMode
    };
}
