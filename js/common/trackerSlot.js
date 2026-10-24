/**
 * Shared lazy tracker slot (gh-1250) — single-instance facade over
 * trackersModule.createTrackerHolder() (gh-124x).
 *
 * A dozen action scripts used to carry an identical copy of this boilerplate:
 *
 *   var trackersModule = require('./common/trackers.js');
 *   var _trackerCtx = { config: null, customParams: {} };
 *   var _trackerInst = null;
 *   function initTracker(config, customParams) { ... }
 *   function getTracker() { ... }
 *
 * One engine run executes one action() at a time and every action()
 * re-initializes the slot before first use, so a single shared slot is
 * behavior-identical to the per-file copies.
 *
 * gh-1250 rework: main grew the same lazy-holder mechanism inside
 * common/trackers.js (createTrackerHolder) in parallel with this module.
 * The trackers.js holder is now the single canonical implementation —
 * this module keeps its public contract (a module-level shared slot) but
 * delegates init/get to one holder instance, so the two mechanisms can
 * no longer drift and the dedup scan sees one copy.
 *
 * IMPORTANT: this module runs inside the DMTools GraalJS bridge — keep
 * requires load-time (gh-823) and data structures JSON-safe.
 */

// gh-823: load-time require — hoisted requires resolve file-relative and
// dmtools compile discovers them for the pack closure.
var trackersModule = require('./trackers.js');

// The one shared slot for the engine run: holder semantics (lazy
// createTracker from the init context, cached instance, reset on re-init)
// live in common/trackers.js.
var holder = trackersModule.createTrackerHolder();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initTracker: holder.initTracker,
        getTracker: holder.getTracker
    };
}
