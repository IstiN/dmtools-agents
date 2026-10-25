/**
 * Unit tests for the lazy tracker holder (gh-1244 semantics, gh-1261 consolidation).
 *
 * gh-1261: js/common/trackerHolder.js (gh-1247's require-free twin factory) was
 * folded into the canonical js/common/trackers.js::createTrackerHolder() — exactly
 * ONE implementation remains, and these tests pin its behavior:
 * - `initTracker(config, customParams)` stores the context and DROPS the
 *   cached tracker, so the next `getTracker()` re-creates against the new
 *   context. Both arguments default to null.
 * - `getTracker()` creates the tracker lazily via
 *   createTracker(config, customParams) and caches it: repeated calls return
 *   the SAME instance until the next initTracker.
 * - Each createTrackerHolder() holder owns private state — holders never
 *   share instances.
 *
 * The injected-module fake of the old trackerHolder.js test is gone with the
 * module; observability now goes through the tracker's provider() (which
 * resolves from the init context: customParams.trackerProvider wins over
 * config.tracker.provider, default 'jira').
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function loadTrackersWithHolder(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            'config': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

function newHolder() {
    return loadTrackersWithHolder().createTrackerHolder();
}

suite('trackerHolder', function() {

    test('getTracker lazily creates ONE tracker and caches it', function() {
        var holder = newHolder();

        var cfg = { tracker: { provider: 'github' }, repository: { owner: 'o', repo: 'r' } };
        holder.initTracker(cfg, {});

        var t1 = holder.getTracker();
        var t2 = holder.getTracker();

        assert.equal(t1, t2, 'same cached instance returned');
        assert.equal(t1.provider(), 'github', 'tracker created from the init config');
    });

    test('initTracker resets the cached instance — next getTracker re-creates', function() {
        var holder = newHolder();

        holder.initTracker({ tracker: { provider: 'github' }, repository: { owner: 'o', repo: 'r' } }, {});
        var first = holder.getTracker();

        holder.initTracker({ tracker: { provider: 'ado' } }, undefined);
        var second = holder.getTracker();
        var again = holder.getTracker();

        assert.notEqual(first, second, 'fresh instance after re-init');
        assert.equal(second, again, 'new instance cached too');
        assert.equal(second.provider(), 'ado', 'new config used');
        assert.equal(first.provider(), 'github', 'old instance untouched');
    });

    test('initTracker passes customParams through — they win over the config provider', function() {
        var holder = newHolder();

        holder.initTracker({ tracker: { provider: 'jira' } }, { trackerProvider: 'ado' });

        assert.equal(holder.getTracker().provider(), 'ado', 'customParams flow into createTracker');
    });

    test('initTracker defaults config and customParams to null', function() {
        var holder = newHolder();

        holder.initTracker();
        var t = holder.getTracker();

        assert.ok(t, 'a tracker is still created without any init context');
        assert.equal(t.provider(), 'jira', 'provider falls back to the jira default');
    });

    test('two holders are independent — no shared state', function() {
        var holderA = newHolder();
        var holderB = newHolder();

        holderA.initTracker({ tracker: { provider: 'github' }, repository: { owner: 'o', repo: 'r' } }, {});
        holderB.initTracker({ tracker: { provider: 'ado' } }, {});

        assert.equal(holderA.getTracker().provider(), 'github');
        assert.equal(holderB.getTracker().provider(), 'ado');
        assert.notEqual(holderA.getTracker(), holderB.getTracker(), 'holders never share instances');
        assert.equal(holderA.getTracker().provider(), 'github', 'A unchanged after B was used');
    });
});
