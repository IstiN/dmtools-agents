/**
 * Condition script for conditional cliPrompts sections:
 * Returns true when the development leg should carry the scope-estimate
 * appendix (gh-1503). Deliberately ONE self-contained function — the
 * established pattern for condition scripts (see isCodeGraphAvailable.js) is
 * no require, and keeping the whole decision in one body also keeps this file
 * structurally distinct from its plan-mode sibling (duplication gate).
 *
 * Admission chain, strictest guard first:
 * 1) mode "adaptive" — the gh-1435 resolver contract, case-sensitive
 *    lowercase only; anything else (plan/default/absent) exits false. The
 *    plan appendix on adaptive legs is an ESCALATION READ target (the adaptive
 *    block points the agent at the file when it self-selects plan), not a
 *    prompt entry — isDevelopmentModePlan.js no longer admits adaptive legs.
 * 2) shadowMode guard: a leg with adaptive.shadowMode strictly `=== true`
 *    never carries the appendix (gh-1437 guard carried over); anything else
 *    (absent, null, wrong-typed) is non-shadow and proceeds. Stale-file
 *    hygiene: a stale runtime file
 *    cannot leak into a non-adaptive prompt — admission is mode-gated, so
 *    only an adaptive leg ever reads the path, and every adaptive preCli run
 *    overwrites it with fresh text before the prompt assembles.
 * 3) the appendix must have been materialized at the runtime path by the
 *    leg's preCli setup (js/common/developmentModeAdaptive.js). The
 *    existence check keeps a degraded materialization from leaking the
 *    runtime path into the assembled prompt — the leg fails in preCli
 *    instead.
 */
function action(params) {
    var cp = params && (params.jobParams && params.jobParams.customParams || params.customParams) || {};
    if (!activeNonShadowAdaptiveLeg(cp)) {
        return false;
    }
    return adaptiveAppendixMaterialized();
}

// Guards 1+2 in one predicate (gh-1435 contract: lowercase "adaptive" only;
// gh-1437 shadow guard: strict `=== true` excludes, anything else proceeds).
function activeNonShadowAdaptiveLeg(cp) {
    if (cp.developmentMode !== 'adaptive') {
        return false;
    }
    var adaptiveCfg = cp.developmentModeConfig && cp.developmentModeConfig.adaptive;
    return !(adaptiveCfg && adaptiveCfg.shadowMode === true);
}

// Guard 3: the appendix must have been materialized by the leg's preCli setup.
function adaptiveAppendixMaterialized() {
    try {
        var content = file_read({ path: '.dmtools/development-mode-adaptive-appendix.md' });
        return typeof content === 'string' && content.length > 0;
    } catch (e) {
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action
    };
}
