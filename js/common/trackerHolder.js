/**
 * Shared lazy tracker holder for the pre-CLI / review actions (gh-1247).
 *
 * Why this exists (gh-1247): ~20 action scripts each carried an identical
 * module-level lazy-singleton block (`_trackerCtx` / `_trackerInst` /
 * `initTracker` / `getTracker`), which the duplication gate flagged as one
 * 23-file clone group. The canonical implementation lives here ONCE; each
 * action creates its own holder via `create(trackersModule)` and keeps a
 * thin local delegate so call sites (`initTracker(config, customParams)`,
 * `getTracker()`) are unchanged.
 *
 * Design constraints:
 * - ZERO requires on purpose: the trackers module is injected by the caller
 *   (same convention as branchSetup.js), so unit tests can load this module
 *   without a require map.
 * - GraalJS-safe: `var` + plain functions only.
 *
 * Semantics (pinned by js/unit-tests/test_trackerHolder.js):
 * - `initTracker(config, customParams)` stores the context and DROPS the
 *   cached tracker, so the next `getTracker()` re-creates against the new
 *   context. Both arguments default to null.
 * - `getTracker()` creates the tracker lazily via
 *   `trackersModule.createTracker(config, customParams)` and caches it:
 *   repeated calls return the SAME instance until the next initTracker.
 * - Each `create()` holder owns private state — holders never share
 *   instances.
 */
function createTrackerHolder(trackersModule) {
    var ctx = { config: null, customParams: {} };
    var inst = null;

    function initTracker(config, customParams) {
        ctx = { config: config || null, customParams: customParams || {} };
        inst = null;
    }

    function getTracker() {
        if (!inst) inst = trackersModule.createTracker(ctx.config, ctx.customParams);
        return inst;
    }

    return { initTracker: initTracker, getTracker: getTracker };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { create: createTrackerHolder };
}
