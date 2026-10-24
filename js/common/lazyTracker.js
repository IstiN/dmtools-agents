/**
 * Lazily-created tracker handle for post-actions that must build the tracker
 * only after config resolution but then use it from many helpers
 * (gh-1245 — one shared implementation of the lazy tracker pattern that
 * several root scripts used to carry inline).
 *
 * Usage:
 *   var lazy = require('./common/lazyTracker.js').createLazyTracker(trackersModule);
 *   lazy.initTracker(config, customParams);   // per action() run
 *   var tracker = lazy.getTracker();          // created on first use
 */

function createLazyTracker(trackersModule) {
    var state = { config: null, customParams: {}, tracker: null };
    return {
        initTracker: function(config, customParams) {
            state.config = config || null;
            state.customParams = customParams || {};
            state.tracker = null;
        },
        getTracker: function() {
            if (!state.tracker) {
                state.tracker = trackersModule.createTracker(state.config, state.customParams);
            }
            return state.tracker;
        }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createLazyTracker: createLazyTracker };
}
