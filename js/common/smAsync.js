/**
 * SM async fan-out — parallel read fan-out for the SM rule engine.
 *
 * The Dart JS runtime (quickjs_runtime) exposes `runAsync(fn, args)`: the
 * closure-free function SOURCE is dispatched to a pool of pre-wired worker
 * engines (all snake_case tool wrappers + require against the main script's
 * directory snapshot + params). `runAsync` exists ONLY when the job's
 * jobParams.parallelWorkers >= 2 — otherwise `typeof runAsync` is
 * 'undefined' and this module transparently falls back to sequential
 * in-process evaluation (Java/GraalJS parity, and the unit-test harness).
 *
 * Contract:
 *   map(items, workerSource, toArgs) → ordered results array
 *
 *   - workerSource is a STRING literal of a closure-free
 *     `function(args) {...}`. The Dart runtime's runAsync takes a FUNCTION
 *     (it re-serializes via fn.toString() for the workers), so map evals
 *     the string once and hands runAsync the function object. The string
 *     form also guarantees closure-freeness at the call site — a real
 *     function could accidentally capture an outer variable and silently
 *     serialize incomplete source. Everything the worker needs travels
 *     through args.
 *   - toArgs(item, index) builds that one JSON-able args value per item.
 *   - Results are ORDER-PRESERVING: runAsync.all(jobs).wait() resolves in
 *     dispatch order; the fallback maps sequentially.
 *   - ONE worker failure propagates: wait() throws on a worker-side throw;
 *     the fallback surfaces the throw from map() directly.
 *
 * Rule-engine safety: this is READ fan-out only. Callers use it for
 * independent read probes (list/search/enrich); action execution
 * (labels/comments/dispatches/merges) stays sequential on the main engine.
 */
'use strict';

function map(items, workerSource, toArgs) {
    // One eval for both paths: runAsync needs the FUNCTION object (it
    // re-serializes the source for the worker engines); the fallback
    // calls it in-process.
    var fn = eval('(' + workerSource + ')');
    if (items.length > 1 && typeof runAsync === 'function') {
        var jobs = [];
        for (var i = 0; i < items.length; i++) {
            jobs.push(runAsync(fn, toArgs(items[i], i)));
        }
        return runAsync.all(jobs).wait();
    }
    // Sequential fallback (Java/GraalJS, unit-test harness, single-item
    // lists): the evaled worker source runs in the CURRENT scope chain —
    // it can see this module's `require` (workers resolve
    // ./common/smProvider.js against the main script directory) and any
    // testRunner-injected mock globals shadowing the forge tools.
    return items.map(function (it, i) { return fn(toArgs(it, i)); });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { map: map };
}
