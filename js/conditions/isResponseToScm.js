/**
 * Condition script for conditional cliPrompts sections:
 * Returns true when the agent's outputs/response.md is posted to the pull request (PR body / PR comment).
 *
 * Keyed on customParams.responseTarget declared in the agent JSON config:
 *   "scm"     — response.md becomes PR/MR body or comment (GitHub-Flavored Markdown)
 *   "tracker" — response.md is posted raw to the tracker (tracker markup)
 *
 * Self-contained (no require) — the established pattern for condition scripts.
 */

function resolveCustomParams(params) {
    if (params && params.jobParams && params.jobParams.customParams) {
        return params.jobParams.customParams;
    }
    return (params && params.customParams) || {};
}

function responseTarget(params) {
    var target = resolveCustomParams(params).responseTarget;
    return typeof target === 'string' ? target.trim().toLowerCase() : '';
}

function action(params) {
    return responseTarget(params) === 'scm';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, responseTarget: responseTarget };
}
