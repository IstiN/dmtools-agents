/**
 * publishParams.js — the shared param-resolution core of the factory
 * *_publish.js JSRunner entries (gh-1248 dedup): mark_job_done_publish,
 * review_verdict_publish and token_usage_publish ran byte-identical copies
 * of the envValue/makePicker prologue.
 *
 * Resolution order (unchanged): customParams > env > sh-step defaults.
 * envMap is the test seam (name → value); production passes nothing and
 * reads the process env through the guarded java bridge.
 *
 * GraalJS-clean (var + plain functions).
 */

/**
 * Env reader for the fallback path. The dmtools JS runtimes do not
 * guarantee a java bridge (GraalJS has one; QuickJS does not), so every
 * access is guarded and missing env simply yields '' — the caller's
 * defaults take over.
 */
function envValue(name) {
    try {
        if (typeof java !== 'undefined' && java && java.lang &&
            java.lang.System && typeof java.lang.System.getenv === 'function') {
            var v = java.lang.System.getenv(name);
            return (v === null || v === undefined) ? '' : String(v);
        }
    } catch (e) { /* no env bridge on this runtime */ }
    return '';
}

/**
 * The pick closure factory: customParams > env > default, '' for anything
 * still unset. Callers build their own params object from the returned
 * picker, keeping each publish entry's key list local.
 */
function makePicker(params, envMap) {
    var custom = (params && params.jobParams && params.jobParams.customParams) || {};
    function env(name) {
        if (envMap && Object.prototype.hasOwnProperty.call(envMap, name)) return envMap[name];
        return envValue(name);
    }
    return function pick(key, envName, dflt) {
        var v = custom[key];
        if (v === undefined || v === null || v === '') v = env(envName);
        if (v === undefined || v === null || v === '') v = dflt;
        return v === undefined || v === null ? '' : String(v);
    };
}

module.exports = {
    envValue: envValue,
    makePicker: makePicker
};
