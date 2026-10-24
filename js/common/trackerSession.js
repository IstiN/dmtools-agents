/**
 * js/common/trackerSession.js
 *
 * Single home for the lazy tracker-session boilerplate every JSRunner
 * post-action used to copy-paste (gh-1249 rework, quality-gate duplication
 * ratchet): the four-line `trackersModule / createTrackerHolder /
 * initTracker / getTracker` prolog appeared verbatim in dozens of action
 * scripts and formed 50-token clone windows across unrelated files, so a
 * dedup edit on one side surfaced as a duplication REGRESSION on the other.
 *
 * Consumers replace the boilerplate with:
 *
 *   var trackerSession = require('./common/trackerSession.js');
 *   var initTracker = trackerSession.initTracker;
 *   var getTracker = trackerSession.getTracker;
 *
 * `trackersModule`/`trackerHolder` are re-exported for the few scripts that
 * need the holder itself (e.g. to pass it around or inspect state).
 *
 * The holder stays lazy exactly as createTrackerHolder() documents (gh-1244):
 * the tracker is created on first getTracker() and discarded on re-init.
 */

var trackersModule = require('./trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();

module.exports = {
    trackersModule: trackersModule,
    trackerHolder: trackerHolder,
    initTracker: trackerHolder.initTracker,
    getTracker: trackerHolder.getTracker
};
