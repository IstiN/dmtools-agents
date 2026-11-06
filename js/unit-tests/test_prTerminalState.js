/**
 * Unit tests for js/common/prTerminalState.js (gh-1369).
 *
 * The terminal-PR guard: a merged or closed PR is terminal — no machine leg
 * can change it, so every writer of machine rework state (the arm_rework
 * action, the restore sweep, the verdict reconcile) must exit BEFORE
 * stamping labels/comments. Live pathology: PR #1368 was merged with 6 open
 * review threads; the rework-arming watcher stamped agent:rework on the
 * merged PR and armed a rework leg against shipped code.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadModuleUnderTest() {
    return loadModule('js/common/prTerminalState.js', makeRequire({}));
}

suite('prTerminalState.normalizePrState', function() {

    test('uppercases the REST state string', function() {
        var m = loadModuleUnderTest();
        assert.equal(m.normalizePrState('open'), 'OPEN');
        assert.equal(m.normalizePrState('closed'), 'CLOSED');
        assert.equal(m.normalizePrState('MERGED'), 'MERGED');
    });

    test('non-string / empty / null input normalizes to null (no fabrication)', function() {
        var m = loadModuleUnderTest();
        assert.equal(m.normalizePrState(null), null);
        assert.equal(m.normalizePrState(undefined), null);
        assert.equal(m.normalizePrState(''), null);
        assert.equal(m.normalizePrState(42), null);
        assert.equal(m.normalizePrState({}), null);
    });
});

suite('prTerminalState.isTerminalPrState (gh-1369)', function() {

    test('a merged PR is terminal — the merged flag alone decides', function() {
        var m = loadModuleUnderTest();
        assert.equal(m.isTerminalPrState('open', true), true,
            'merged:true with a stale open state is still terminal');
        assert.equal(m.isTerminalPrState(null, true), true,
            'merged:true without a readable state is still terminal');
    });

    test('REST shapes of a merged PR are terminal (state closed + merged true)', function() {
        var m = loadModuleUnderTest();
        assert.equal(m.isTerminalPrState('closed', true), true);
    });

    test('a closed (not merged) PR is terminal — nothing to rework', function() {
        var m = loadModuleUnderTest();
        assert.equal(m.isTerminalPrState('closed', false), true);
    });

    test('state string comparison is case-insensitive (REST lowercases)', function() {
        var m = loadModuleUnderTest();
        assert.equal(m.isTerminalPrState('CLOSED', false), true);
        assert.equal(m.isTerminalPrState('CLOSED', undefined), true,
            'the merged flag is optional — a CLOSED state alone is terminal');
        assert.equal(m.isTerminalPrState('MERGED', false), true,
            'a MERGED state string is terminal even without the flag');
    });

    test('an OPEN PR is not terminal — arming works as before (gh-1369 AC3)', function() {
        var m = loadModuleUnderTest();
        assert.equal(m.isTerminalPrState('open', false), false);
        assert.equal(m.isTerminalPrState('OPEN', null), false);
    });

    test('unknown state fails OPEN (not terminal) — a broken probe keeps the legacy arm semantics', function() {
        var m = loadModuleUnderTest();
        assert.equal(m.isTerminalPrState(null, null), false);
        assert.equal(m.isTerminalPrState(undefined, undefined), false);
        assert.equal(m.isTerminalPrState('', false), false);
        assert.equal(m.isTerminalPrState('unknown', false), false);
    });
});
