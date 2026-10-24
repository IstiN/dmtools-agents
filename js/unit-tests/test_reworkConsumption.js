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
 *       AC2  a real close (nothing left to own — all machine threads
 *            resolved) → no restore;
 *       AC3  no consumption evidence (human-thread-only PRs) → no restore;
 *       a head move with the same open machine threads is a refresh,
 *       not a close → restore (silentUpdateBranch pushes merge commits
 *       without a leg — gh-840 rework review, IMPORTANT);
 *       grace window, label present, rework in flight → no restore.
 *
 * Uses: test(), suite(), assert — pure module, no dmtools globals.
 */
/* global suite, test, assert, loadModule, makeRequire */

suite('reworkConsumption — consume-audit marker (gh-840 audit log)', function () {
    var rc = loadModule('js/common/reworkConsumption.js', makeRequire({
        './machineAuthor.js': machineAuthorReal(),
        './reviewVerdicts.js': reviewVerdictsReal()
    }), {});

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
    var rc = loadModule('js/common/reworkConsumption.js', makeRequire({
        './machineAuthor.js': machineAuthorReal(),
        './reviewVerdicts.js': reviewVerdictsReal()
    }), {});

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

    test('IMPORTANT — a head move with the same open machine threads is a refresh, not a close → restore', function () {
        // gh-840 rework review round 2: silentUpdateBranch's silent refresh
        // merges advance the head WITHOUT a leg and WITHOUT resolving
        // threads. The old 'head-advanced' skip treated any head move as
        // the AC2 close proof — one post-consumption refresh suppressed
        // the sweep forever (the #826 hang, one step removed). The close
        // proof is thread ownership, not head position: a healthy close
        // resolves the machine threads ('no-unresolved-threads' above);
        // with machine threads still open on ANY head the work is not done
        // and the sweep restores.
        var d = rc.shouldRestoreArm(base());
        assert.ok(d.restore, 'open machine threads on the advanced head → work remains');
        assert.equal(d.reason, 'restore');
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

suite('reworkConsumption: [bot]-suffixed machine authors are trusted (gh-1025)', function () {
    var rc = loadModule('js/common/reworkConsumption.js', makeRequire({
        './machineAuthor.js': machineAuthorReal(),
        './reviewVerdicts.js': reviewVerdictsReal()
    }), {});

    test('consume/restore markers authored by dmtools-factory-bot[bot] parse under the bare knob entry', function () {
        var body = rc.buildConsumeAuditComment('dispatch', 'abc1234');
        var markers = rc.parseConsumeMarkers(
            [{ body: body, user: { login: 'dmtools-factory-bot[bot]' } }],
            { authorLogins: ['dmtools-factory-bot'] });
        assert.equal(markers.length, 1, 'App-authored consume markers must be visible to the gh-840 sweep');
    });

    test('a forged [bot] marker from a different bot stays invisible', function () {
        var body = rc.buildConsumeAuditComment('dispatch', 'abc1234');
        var markers = rc.parseConsumeMarkers(
            [{ body: body, user: { login: 'dependabot[bot]' } }],
            { authorLogins: ['dmtools-factory-bot'] });
        assert.equal(markers.length, 0);
    });
});

// ── gh-1195 CRAP ratchet: marker ordering characterization ───────────────────
// Pins the newest-first ordering contract of parseMarkers — timestamp order
// with payload order as the tiebreak, and NaN timestamps sinking to the front
// (the branches that left parseMarkers at CRAP 20) — before the comparator is
// extracted into a named helper.
suite('reworkConsumption.parseMarkers — ordering contract (gh-1195 characterization)', function () {
    var rc = loadModule('js/common/reworkConsumption.js', makeRequire({
        './machineAuthor.js': machineAuthorReal(),
        './reviewVerdicts.js': reviewVerdictsReal()
    }), {});
    var h = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function consumeBody(at) {
        var payload = { path: 'dispatch', head: h, at: at };
        return rc.CONSUME_MARKER_PREFIX + JSON.stringify(payload) + ' -->';
    }

    test('equal timestamps fall back to payload order (the comparator tiebreak)', function () {
        var markers = rc.parseConsumeMarkers([
            { body: consumeBody('2026-10-10T10:00:00.000Z'), user: { login: 'ai-teammate' } },
            { body: consumeBody('2026-10-10T10:00:00.000Z'), user: { login: 'ai-teammate' } },
            { body: consumeBody('2026-10-10T09:00:00.000Z'), user: { login: 'ai-teammate' } }
        ]);
        assert.equal(markers.length, 3);
        assert.equal(markers[0].at, '2026-10-10T09:00:00.000Z', 'oldest timestamp first');
        assert.equal(markers[1].order, 0, 'same tick → payload order wins (comment 0)');
        assert.equal(markers[2].order, 1, 'same tick → payload order wins (comment 1)');
    });

    test('unparsable timestamps sort oldest (NaN sink) and never crash the comparator', function () {
        var markers = rc.parseConsumeMarkers([
            { body: consumeBody('not-a-date'), user: { login: 'ai-teammate' } },
            { body: consumeBody('2026-10-10T10:00:00.000Z'), user: { login: 'ai-teammate' } }
        ]);
        assert.equal(markers.length, 2);
        assert.equal(markers[0].at, 'not-a-date', 'NaN atMs sinks to the front');
        assert.equal(markers[1].at, '2026-10-10T10:00:00.000Z');
    });

    test('a non-array comments argument yields an empty marker list', function () {
        assert.deepEqual(rc.parseConsumeMarkers(null, {}), []);
        assert.deepEqual(rc.parseRestoreMarkers('nope', {}), []);
    });
});

// ── gh-1195 CRAP split: named helper contracts ────────────────────────────────
// Direct unit coverage for the helpers extracted from parseMarkers /
// shouldRestoreArm — every branch stays covered under its own name so the
// per-function ratchet sees CRAP ≤ CC for each.
suite('reworkConsumption — extracted parse/decision helpers (gh-1195)', function () {
    var rc = loadModule('js/common/reworkConsumption.js', makeRequire({
        './machineAuthor.js': machineAuthorReal(),
        './reviewVerdicts.js': reviewVerdictsReal()
    }), {});

    suite('trustedAuthorLogins', function () {
        test('a non-empty authorLogins array is the allowlist; everything else disables the filter', function () {
            var allow = ['ai-teammate'];
            assert.equal(rc.trustedAuthorLogins({ authorLogins: allow }), allow);
            assert.equal(rc.trustedAuthorLogins({ authorLogins: [] }), null, 'empty → filter off');
            assert.equal(rc.trustedAuthorLogins({ authorLogins: 'ai-teammate' }), null, 'not an array → filter off');
            assert.equal(rc.trustedAuthorLogins({}), null, 'no key → filter off');
            assert.equal(rc.trustedAuthorLogins(null), null, 'no opts → filter off');
        });
    });

    suite('isTrustedMarkerAuthor', function () {
        test('no allowlist trusts every comment', function () {
            assert.equal(rc.isTrustedMarkerAuthor({ body: 'x', user: { login: 'anyone' } }, null), true);
        });

        test('the allowlist matches case-insensitively with one [bot] suffix normalized', function () {
            var allow = ['dmtools-factory-bot'];
            assert.equal(rc.isTrustedMarkerAuthor({ user: { login: 'DMTools-Factory-Bot[bot]' } }, allow), true,
                'App-authored [bot] spelling matches the bare knob entry');
            assert.equal(rc.isTrustedMarkerAuthor({ user: { login: 'ai-teammate' } }, allow), false,
                'a different author is not trusted');
            assert.equal(rc.isTrustedMarkerAuthor({ user: { login: 'dmtools-factory-bot[spoof]' } }, allow), false,
                'anything but one trailing [bot] stays unmatched');
            assert.equal(rc.isTrustedMarkerAuthor({}, allow), false, 'an authorless comment is not trusted');
        });
    });

    suite('collectMarkerRecords', function () {
        test('skips untrusted comments and unparsable bodies, stamps atMs + payload order', function () {
            var h = 'aaaabbbbccccddddeeeeffff0000111122223333';
            var marker = rc.buildConsumeAuditComment('dispatch', h, '2026-10-10T09:00:00.000Z');
            var records = rc.collectMarkerRecords([
                { body: marker, user: { login: 'intruder' } },              // untrusted → skipped
                { body: 'just talk', user: { login: 'ai-teammate' } },      // no marker → skipped
                { body: marker, user: { login: 'ai-teammate' } }            // kept, order 2
            ], rc.CONSUME_MARKER_PREFIX, ['ai-teammate']);
            assert.equal(records.length, 1);
            assert.equal(records[0].order, 2, 'the payload index is stamped for the tiebreak');
            assert.equal(records[0].atMs, Date.parse('2026-10-10T09:00:00.000Z'));
        });
    });

    suite('compareMarkerRecords', function () {
        test('orders by timestamp, NaN sinks, ties fall back to payload order', function () {
            assert.equal(rc.compareMarkerRecords({ atMs: 100, order: 0 }, { atMs: 200, order: 0 }), -1);
            assert.equal(rc.compareMarkerRecords({ atMs: 200, order: 0 }, { atMs: 100, order: 0 }), 1);
            assert.equal(rc.compareMarkerRecords({ atMs: NaN, order: 5 }, { atMs: 100, order: 0 }), -1,
                'NaN atMs sorts as -1 → oldest');
            assert.equal(rc.compareMarkerRecords({ atMs: 100, order: 3 }, { atMs: 100, order: 7 }), -4,
                'same tick → payload order (stable Array.prototype.sort contract)');
            assert.equal(rc.compareMarkerRecords({ atMs: 100 }, { atMs: 100 }), 0,
                'missing order defaults to 0 on both sides');
        });
    });

    suite('msOrNull / quietSinceOf / restoreStaleMs', function () {
        test('msOrNull passes numbers through, nulls everything else', function () {
            assert.equal(rc.msOrNull(1000), 1000);
            assert.equal(rc.msOrNull(NaN), null, 'NaN is a number typeof but unparsable');
            assert.equal(rc.msOrNull('1000'), null, 'a string timestamp is not trusted');
            assert.equal(rc.msOrNull(null), null);
            assert.equal(rc.msOrNull(undefined), null);
        });

        test('quietSinceOf prefers the newest evidence, tolerating single-source states', function () {
            assert.equal(rc.quietSinceOf(100, 300), 300, 'both present → the later marker');
            assert.equal(rc.quietSinceOf(300, 100), 300);
            assert.equal(rc.quietSinceOf(null, 300), 300, 'consume-only state');
            assert.equal(rc.quietSinceOf(100, null), 100, 'restore-only state');
        });

        test('restoreStaleMs honors a positive staleMs knob and falls back to the default', function () {
            assert.equal(rc.restoreStaleMs({ staleMs: 60000 }), 60000);
            assert.equal(rc.restoreStaleMs({ staleMs: 0 }), rc.DEFAULT_RESTORE_STALE_MS, 'zero is not a bound');
            assert.equal(rc.restoreStaleMs({ staleMs: -5 }), rc.DEFAULT_RESTORE_STALE_MS);
            assert.equal(rc.restoreStaleMs({}), rc.DEFAULT_RESTORE_STALE_MS);
        });
    });

    suite('restoreBlockReason', function () {
        test('the arm-state guards in their historical priority order', function () {
            assert.equal(rc.restoreBlockReason({ hasReworkLabel: true, reworkInFlight: true, unresolvedMachineThreads: 0 }),
                'arm-present', 'the label wins over everything');
            assert.equal(rc.restoreBlockReason({ reworkInFlight: true }), 'rework-in-flight');
            assert.equal(rc.restoreBlockReason({ unresolvedMachineThreads: 0 }), 'no-unresolved-threads');
            assert.equal(rc.restoreBlockReason({ unresolvedMachineThreads: '2' }), null,
                'a numeric string passes the census check (Number() coercion)');
            assert.equal(rc.restoreBlockReason({ unresolvedMachineThreads: 3 }), null,
                'open machine threads → the evidence gate may run');
        });
    });
});
