/**
 * Unit tests: js/common/reworkConsumption.js — fail-closed agent:rework
 * consumption bookkeeping + the consumed-without-work sweep decision
 * (gh-840).
 *
 * Live forensics being replayed: dmtools-agents PR #826 (gh-825),
 * 2026-10-10 ~10:00Z — agent:rework armed (twice) and later CONSUMED with
 * no rework-leg run, no push (head unchanged), 4/6 review threads still
 * unresolved, no closing comment. Result: 4h+ hang; nothing re-armed.
 *
 * Coverage:
 *   - the consume-audit marker: build/round-trip, path whitelist, forge
 *     resistance (only machine-authored comments parse);
 *   - the restore marker (sweep bookkeeping, gh-821-style durability);
 *   - shouldRestoreArm — the pure sweep decision:
 *       AC1  consumed-without-work, quiet past the stale window → restore;
 *       AC2  a real close (head advanced past the consumed head / nothing
 *            left to own) → no restore;
 *       AC3  no consumption evidence (human-thread-only PRs) → no restore;
 *       grace window, label present, rework in flight → no restore.
 *
 * Uses: test(), suite(), assert — pure module, no dmtools globals.
 */
/* global suite, test, assert, loadModule, makeRequire */

suite('reworkConsumption — consume-audit marker (gh-840 audit log)', function () {
    var rc = loadModule('js/common/reworkConsumption.js', makeRequire({}), {});

    test('buildConsumeAuditComment embeds path + head in the structured marker + one short line', function () {
        var body = rc.buildConsumeAuditComment('dispatch', 'aaaabbbbccccddddeeeeffff0000111122223333');
        assert.ok(body.indexOf(rc.CONSUME_MARKER_PREFIX) === 0, 'marker prefix opens the comment');
        assert.contains(body, '"path":"dispatch"');
        assert.contains(body, '"head":"aaaabbbbccccddddeeeeffff0000111122223333"');
        assert.contains(body, 'agent:rework consumed');
        assert.contains(body, 'gh-840');
        // one SHORT line rendered for humans — the ticket contract
        var visible = body.split('\n').filter(function (l) { return l.trim(); });
        assert.ok(visible.length <= 3, 'audit is one short line + marker, got ' + visible.length);
    });

    test('buildConsumeAuditComment rejects unknown paths and missing head', function () {
        assert.notOk(rc.buildConsumeAuditComment('sneaky', 'abc1234'), 'unknown path → no comment');
        assert.notOk(rc.buildConsumeAuditComment('dispatch', ''), 'no head → no comment');
        assert.ok(rc.buildConsumeAuditComment('cross-anchor', 'abc1234'), 'cross-anchor is a legal path');
    });

    test('parseConsumeMarkers round-trips and orders oldest-first', function () {
        var h = 'aaaabbbbccccddddeeeeffff0000111122223333';
        var c1 = rc.buildConsumeAuditComment('dispatch', h, '2026-10-10T09:00:00.000Z');
        var c2 = rc.buildConsumeAuditComment('cross-anchor', h, '2026-10-10T10:00:00.000Z');
        // backdate c1 by editing the payload timestamp is not possible via
        // the builder — feed explicit payloads through the raw parser
        var markers = rc.parseConsumeMarkers([
            { body: c2, user: { login: 'ai-teammate' }, created_at: '2026-10-10T10:00:00Z' },
            { body: c1, user: { login: 'ai-teammate' }, created_at: '2026-10-10T09:00:00Z' },
            { body: 'free-form: consumed agent:rework (path: dispatch)' }, // marker-less → invisible
            { body: 'LGTM' }
        ], { authorLogins: ['ai-teammate'] });
        assert.equal(markers.length, 2, 'only marked machine comments parse');
        assert.equal(markers[0].path, 'dispatch', 'oldest first');
        assert.equal(markers[1].path, 'cross-anchor');
        assert.equal(markers[0].head, h, 'head rides the marker');
    });

    test('parseConsumeMarkers honors the machine-author allowlist (forge resistance)', function () {
        var body = rc.buildConsumeAuditComment('dispatch', 'abc1234');
        var forged = rc.parseConsumeMarkers(
            [{ body: body, user: { login: 'random-human' } }],
            { authorLogins: ['ai-teammate'] });
        assert.equal(forged.length, 0, 'a marker from a non-machine identity is invisible');
        var trusted = rc.parseConsumeMarkers(
            [{ body: body, user: { login: 'AI-Teammate' } }],
            { authorLogins: ['ai-teammate'] });
        assert.equal(trusted.length, 1, 'allowlist match is case-insensitive');
        var noList = rc.parseConsumeMarkers([{ body: body }], {});
        assert.equal(noList.length, 1, 'no allowlist = shape-agnostic parse (pure-parser parity)');
    });

    test('parseRestoreMarkers reads sweep bookkeeping markers', function () {
        var body = rc.buildRestoreMarkerComment('abc1234', 'restored');
        var ms = rc.parseRestoreMarkers(
            [{ body: body, user: { login: 'ai-teammate' } }],
            { authorLogins: ['ai-teammate'] });
        assert.equal(ms.length, 1);
        assert.equal(ms[0].head, 'abc1234');
    });
});

suite('reworkConsumption — shouldRestoreArm (gh-840 sweep decision)', function () {
    var rc = loadModule('js/common/reworkConsumption.js', makeRequire({}), {});

    var NOW = Date.parse('2026-10-10T14:00:00.000Z');
    var STALE_MS = 30 * 60 * 1000;
    var CONSUMED_AT = Date.parse('2026-10-10T10:00:00.000Z'); // the #826 consumption

    function base(overrides) {
        var s = {
            unresolvedMachineThreads: 4,       // #826: 4/6 threads still open
            hasReworkLabel: false,             // the bogus consumption took it
            reworkInFlight: false,
            consumedAtMs: CONSUMED_AT,
            restoredAtMs: null,
            headAdvancedPastConsumption: false, // no push since the consumption
            nowMs: NOW,
            staleMs: STALE_MS
        };
        if (overrides) { for (var k in overrides) s[k] = overrides[k]; }
        return s;
    }

    test('AC1 — the #826 shape: consumed, same head, machine threads open, quiet > staleMs → restore', function () {
        var d = rc.shouldRestoreArm(base());
        assert.ok(d.restore, 'restore expected: ' + d.reason);
        assert.equal(d.reason, 'restore');
    });

    test('AC1 — restored arm re-consumed without work on the same head → restore again after the window', function () {
        var d = rc.shouldRestoreArm(base({
            consumedAtMs: Date.parse('2026-10-10T13:10:00.000Z'),
            restoredAtMs: Date.parse('2026-10-10T13:05:00.000Z')
        }));
        assert.ok(d.restore, 'quiet is measured from the newest consume/restore evidence');
    });

    test('AC1 bound — inside the grace window the arm stays quiet (bounded re-arm, ≤6 ticks)', function () {
        var d = rc.shouldRestoreArm(base({
            consumedAtMs: NOW - 10 * 60 * 1000 // 10 min ago < 30 min stale
        }));
        assert.notOk(d.restore);
        assert.equal(d.reason, 'within-grace');
    });

    test('AC2 — head advanced past the consumption (a real push/close) → no restore', function () {
        var d = rc.shouldRestoreArm(base({ headAdvancedPastConsumption: true }));
        assert.notOk(d.restore, 'the rework/refresh pushed — a new head owns the state');
        assert.equal(d.reason, 'head-advanced');
    });

    test('AC2 — nothing left to own (all machine threads resolved) → no restore', function () {
        var d = rc.shouldRestoreArm(base({ unresolvedMachineThreads: 0 }));
        assert.notOk(d.restore);
        assert.equal(d.reason, 'no-unresolved-threads');
    });

    test('AC2 — label still present → no restore (nothing was consumed; the armer owns it)', function () {
        var d = rc.shouldRestoreArm(base({ hasReworkLabel: true }));
        assert.notOk(d.restore);
        assert.equal(d.reason, 'arm-present');
    });

    test('no rework in flight is honored — an active leg owns the threads', function () {
        var d = rc.shouldRestoreArm(base({ reworkInFlight: true }));
        assert.notOk(d.restore);
        assert.equal(d.reason, 'rework-in-flight');
    });

    test('AC3 — no consumption evidence (human-thread-only PRs, never consumed) → no restore', function () {
        var d = rc.shouldRestoreArm(base({ consumedAtMs: null, restoredAtMs: null }));
        assert.notOk(d.restore, 'gh-744/AC3: never touch PRs with no consumption history');
        assert.equal(d.reason, 'no-consumption-evidence');
    });

    test('consumedAtMs wins over restoredAtMs (newest evidence anchors the quiet window)', function () {
        var d = rc.shouldRestoreArm(base({
            consumedAtMs: NOW - 40 * 60 * 1000,
            restoredAtMs: NOW - 5 * 60 * 1000 // recent restore → still inside grace
        }));
        assert.notOk(d.restore);
        assert.equal(d.reason, 'within-grace');
    });

    test('bad clocks fail closed — missing now or unparsable evidence → no restore', function () {
        assert.notOk(rc.shouldRestoreArm(base({ nowMs: null })).restore, 'no clock → no restore');
        assert.notOk(rc.shouldRestoreArm(base({ consumedAtMs: NaN })).restore, 'NaN evidence → no restore');
    });

    test('staleMs honors an explicit override (6-tick bound is deployment-tunable)', function () {
        var d = rc.shouldRestoreArm(base({ staleMs: 60 * 60 * 1000 }));
        assert.ok(d.restore, 'a one-hour stale window still restores the 4h-old #826 state');
    });
});
