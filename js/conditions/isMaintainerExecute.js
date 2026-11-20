/**
 * Condition script for conditional cliPrompts sections:
 * Returns true when this maintainer leg runs the EXECUTE phase
 * (customParams.maintainerPhase === 'execute', case-sensitive lowercase).
 *
 * The default phase is "plan" (analysis + fix plan, zero source changes,
 * stops for owner approval). Execute legs carry the execute appendix and
 * run the full development runtime (PR pipeline, WIP timer, branch setup).
 *
 * Self-contained (no require) on purpose — the established pattern for
 * condition scripts (see isDevelopmentModePlan.js / isCodeGraphAvailable.js).
 */

function resolveCustomParams(params) {
    if (params && params.jobParams && params.jobParams.customParams) {
        return params.jobParams.customParams;
    }
    if (params && params.customParams) {
        return params.customParams;
    }
    return {};
}

function action(params) {
    var customParams = resolveCustomParams(params);
    return !!customParams && customParams.maintainerPhase === 'execute';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveCustomParams: resolveCustomParams
    };
}
