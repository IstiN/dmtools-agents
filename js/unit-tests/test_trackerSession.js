/**
 * Unit tests for js/common/trackerSession.js — the single home for the lazy
 * tracker-holder boilerplate every action script used to copy-paste
 * (gh-1249 rework: the verbatim 4-liner formed 50-token clone windows across
 * unrelated action scripts and tripped the quality-gate duplication ratchet).
 */

var assert = globalThis.assert;

// Real trackers layer, mocked tool globals — the same shape every consumer
// test uses, so the session delegates to the canonical holder semantics.
function trackersWithMocks(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

function loadTrackerSession(mocks) {
    return loadModule('js/common/trackerSession.js',
        makeRequire({ './trackers.js': trackersWithMocks(mocks) }), {});
}

suite('trackerSession', function () {
    test('re-exports the holder functions of one shared createTrackerHolder() instance', function () {
        var session = loadTrackerSession({});
        assert.equal(typeof session.initTracker, 'function');
        assert.equal(typeof session.getTracker, 'function');
        assert.equal(typeof session.trackersModule.createTrackerHolder, 'function');
        assert.equal(session.trackerHolder.initTracker, session.initTracker);
        assert.equal(session.trackerHolder.getTracker, session.getTracker);
    });

    test('re-init discards the cached tracker instance (documented holder behavior)', function () {
        var creates = 0;
        var session = loadTrackerSession({});
        // gh-1244 contract: initTracker(config, customParams) resets the ctx;
        // the next getTracker() builds a fresh tracker from the new config.
        session.initTracker({ jira: {} }, {});
        var first = session.getTracker();
        session.initTracker({ jira: {} }, {});
        var second = session.getTracker();
        assert.equal(typeof first.moveToStatus, 'function');
        assert.equal(typeof second.moveToStatus, 'function');
        assert.notEqual(first, second, 're-init must not reuse the cached instance');
    });

    test('initTracker/getTracker round-trip against a mocked jira tool layer', function () {
        var moves = [];
        var session = loadTrackerSession({
            jira_move_to_status: function(a) { moves.push(a); }
        });
        session.initTracker({ jira: { statuses: { DONE: 'Done' } } }, {});
        session.getTracker().moveToStatus('TS-1', 'DONE');
        assert.deepEqual(moves, [{ key: 'TS-1', statusName: 'DONE' }]);
    });

    test('two independently loaded sessions do not share holder state', function () {
        var a = loadTrackerSession({});
        var b = loadTrackerSession({});
        assert.notEqual(a.trackerHolder, b.trackerHolder);
    });
});
