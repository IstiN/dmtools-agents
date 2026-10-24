/**
 * Lazily-created tracker handle for post-actions that must build the tracker
 * only after config resolution but then use it from many helpers
 * (gh-1245 — one shared implementation of the initTracker/getTracker pair that
 * several root scripts used to carry inline).
 *
 * Usage:
 *   var lazy = require('./common/lazyTracker.js').createLazyTracker(trackersModule);
 *   lazy.initTracker(config, customParams);   // per action() run
 *   var tracker = lazy.getTracker();          // created on first use
 */

function createLazyTracker(trackersModule) {
    var ctx = { config: null, customParams: {} };
    var inst = null;
    return {
        initTracker: function(config, customParams) {
            ctx = { config: config || null, customParams: customParams || {} };
            inst = null;
        },
        getTracker: function() {
            if (!inst) inst = trackersModule.createTracker(ctx.config, ctx.customParams);
            return inst;
        }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createLazyTracker: createLazyTracker };
}
