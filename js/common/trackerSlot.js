/**
 * Shared lazy tracker slot (gh-1250).
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
 * IMPORTANT: this module runs inside the DMTools GraalJS bridge — keep
 * requires load-time (gh-823) and data structures JSON-safe.
 */

// gh-823: load-time require — hoisted requires resolve file-relative and
// dmtools compile discovers them for the pack closure.
var trackersModule = require('./trackers.js');

var _ctx = { config: null, customParams: {} };
var _inst = null;

/** (Re)initialize the slot: the next getTracker() builds a fresh tracker. */
function initTracker(config, customParams) {
    _ctx = { config: config || null, customParams: customParams || {} };
    _inst = null;
}

/** The lazily created tracker for the current slot context. */
function getTracker() {
    if (!_inst) _inst = trackersModule.createTracker(_ctx.config, _ctx.customParams);
    return _inst;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initTracker: initTracker,
        getTracker: getTracker
    };
}
