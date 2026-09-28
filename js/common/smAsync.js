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
 *     `function(args) {...}` — it is fn.toString()-serialized for the
 *     workers, so it must not capture ANY outer variable; everything it
 *     needs travels through args.
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
    if (items.length > 1 && typeof runAsync === 'function') {
        var jobs = [];
        for (var i = 0; i < items.length; i++) {
            jobs.push(runAsync(workerSource, toArgs(items[i], i)));
        }
        return runAsync.all(jobs).wait();
    }
    // Sequential fallback (Java/GraalJS, unit-test harness, single-item
    // lists): DIRECT eval so the worker source runs in the CURRENT scope
    // chain — it can see this module's `require` (workers resolve
    // ./common/smProvider.js against the main script directory) and any
    // testRunner-injected mock globals shadowing the forge tools.
    var fn = eval('(' + workerSource + ')');
    return items.map(function (it, i) { return fn(toArgs(it, i)); });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { map: map };
}
