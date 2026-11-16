/**
 * Condition script for conditional cliPrompts sections:
 * Returns true when the development leg should carry the scope-estimate
 * appendix (gh-1503): mode "adaptive" (gh-1435 resolver contract, case-
 * sensitive lowercase only) AND the appendix has been materialized at the
 * runtime path by the leg's preCli setup (js/common/developmentModeAdaptiveSp.js).
 * The existence check keeps a degraded materialization from leaking the
 * runtime path into the assembled prompt — the leg fails in preCli instead.
 *
 * Adaptive shadowMode guard: strict `=== true` — anything else (absent, null,
 * wrong-typed) is non-shadow. Shadow legs never carry the appendix (gh-1437
 * guard carried over). Stale-file hygiene: a stale runtime file cannot leak
 * into a non-adaptive prompt — this condition is mode-gated, so only an
 * adaptive leg ever reads the path, and every adaptive preCli run overwrites
 * it with fresh text before the prompt assembles.
 *
 * gh-1503 note: the plan appendix on adaptive legs is an ESCALATION READ
 * target (the SP block points the agent at the file when it self-selects
 * plan), NOT a prompt entry — isDevelopmentModePlan.js no longer admits
 * adaptive legs.
 *
 * Self-contained (no require) on purpose — the established pattern for
 * condition scripts (see isDevelopmentModePlan.js / isCodeGraphAvailable.js).
 */

/** The materialized appendix path — must match js/common/developmentModeAdaptiveSp.js. */
function appendixRuntimePath() {
    return '.dmtools/development-mode-sp-appendix.md';
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
function resolvedModeIsAdaptive(customParams) {
    return !!customParams && customParams.developmentMode === 'adaptive';
}

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
    if (!resolvedModeIsAdaptive(customParams)) {
        return false;
    }
    if (adaptiveShadowMode(customParams)) {
        return false;
    }
    return appendixFileReadable(appendixRuntimePath());
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        appendixRuntimePath: appendixRuntimePath,
        resolveCustomParams: resolveCustomParams,
        adaptiveShadowMode: adaptiveShadowMode
    };
}
