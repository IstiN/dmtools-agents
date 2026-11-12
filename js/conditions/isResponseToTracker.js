/**
 * Prompt condition: true only when the agent JSON declares
 * customParams.responseTarget = "tracker" — outputs/response.md is posted
 * raw to the tracker, so Jira wiki markup is the right output format.
 * Counterpart of isResponseToScm.js; an unset target selects neither prompt.
 * No require: condition scripts stay self-contained.
 */

/** First declared customParams.responseTarget across job-level and top-level params. */
function declaredTarget(params) {
    var sources = [params && params.jobParams, params];
    for (var i = 0; i < sources.length; i++) {
        var cp = sources[i] && sources[i].customParams;
        if (cp && cp.responseTarget) return String(cp.responseTarget);
    }
    return '';
}

function action(params) {
    return /^\s*tracker\s*$/i.test(declaredTarget(params));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, declaredTarget: declaredTarget };
}
