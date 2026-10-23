/**
 * Unit tests for js/common/guestValidationPath.js (gh-113).
 *
 * The guest validation path — the pure half of the guest-PR dead-zone
 * fixes:
 *   - realCheckTally: the head's REAL check-run census (bookkeeping
 *     stubs — the merge bot's 'merge / …' checks — and CANCELLED
 *     entries are never verdicts). A guest head carrying ONLY stubs
 *     tallies zero real checks, which is what lets the merge lane
 *     treat the rollup as zero-failing (the smProvider ROLLUP label
 *     deliberately reads 'pending' for the same head — that label
 *     arms validate-fresh; this tally is the merge-side policy).
 *   - mergeableZeroFailing / recoverableZeroRed: the two policy bars
 *     (merge needs red==0 AND real-pending==0; park recovery needs
 *     red==0 only — an in-flight run owns the verdict but is not red).
 *   - newestArmEvent / isManualArm: the external-validation-arm
 *     policy — the ai_validating label on a guest PR is an external
 *     arm only when a NON-machine actor added it.
 *   - blockedGuestEntry: the tick dead-zone shape — a guest PR,
 *     approved and/or armed, CLEAN, with NO concluded check verdict
 *     (none | pending rollup) — the population that can neither merge
 *     nor validate.
 *   - mergeDeadZoneCary: the cross-tick carry — per-PR first-seen
 *     timestamps survive via the factory-state snapshot; a PR that
 *     stopped being blocked drops out of the carry.
 *
 * R5 discipline: every collection path below carries a 2+ item case.
 *
 * Pure functions, no tool globals — loadModule with makeRequire({}).
 */

var mod = loadModule('js/common/guestValidationPath.js',
    makeRequire({
        './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
    }), {});

suite('guestValidationPath: realCheckTally (gh-113)', function () {

    test('empty rollup — zero real checks', function () {
        var t = mod.realCheckTally([], null);
        assert.equal(t.red, 0);
        assert.equal(t.pending, 0);
        assert.equal(t.real, 0);
    });

    test('merge-bot stub checks only — bookkeeping, never a verdict (the live #1634 shape)', function () {
        // 12 skipped merge stubs: the observed guest head. The smProvider
        // ROLLUP label reads 'pending' here (no verdict yet — arms
        // validate-fresh); the guest tally must read ZERO real checks.
        var runs = [];
        for (var i = 0; i < 12; i++) {
            runs.push({ name: 'merge / ' + (10 + i), status: 'COMPLETED', conclusion: 'SKIPPED' });
        }
        var t = mod.realCheckTally(runs, null);
        assert.equal(t.real, 0, 'stubs are not real checks');
        assert.equal(t.red, 0);
        assert.equal(t.pending, 0);
        assert.equal(t.bokept, 12);
    });

    test('real green + stub mix — real counts, stubs do not (2+ items)', function () {
        var t = mod.realCheckTally([
            { name: 'quality', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'merge / 17', status: 'COMPLETED', conclusion: 'SKIPPED' },
            { name: 'kicker / sm-liveness', status: 'COMPLETED', conclusion: 'SUCCESS' }
        ], null);
        assert.equal(t.real, 1, 'only the real check counts');
        assert.equal(t.red, 0);
        assert.equal(t.pending, 0);
    });

    test('real red verdict (FAILURE, TIMED_OUT) reddens the tally', function () {
        var t = mod.realCheckTally([
            { name: 'quality', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' },
            { name: 'agents-gate', status: 'COMPLETED', conclusion: 'TIMED_OUT' }
        ], null);
        assert.equal(t.real, 3);
        assert.equal(t.red, 2);
    });

    test('real pending: no-conclusion and queued/in_progress statuses pend the tally', function () {
        var t = mod.realCheckTally([
            { name: 'quality', status: 'IN_PROGRESS', conclusion: null },
            { name: 'gate', status: 'QUEUED', conclusion: '' },
            { name: 'sm-validation', status: 'PENDING', conclusion: null }
        ], null);
        assert.equal(t.pending, 3);
        assert.equal(t.red, 0);
    });

    test('CANCELLED is never a verdict — even next to green (gh-755)', function () {
        var t = mod.realCheckTally([
            { name: 'quality', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'sm-validation', status: 'COMPLETED', conclusion: 'CANCELLED' }
        ], null);
        assert.equal(t.red, 0);
        assert.equal(t.pending, 0);
        assert.equal(t.canceled, 1);
    });

    test('lowercase REST spellings normalize (conclusions arrive lowercase)', function () {
        var t = mod.realCheckTally([
            { name: 'quality', status: 'completed', conclusion: 'failure' },
            { name: 'merge / 3', status: 'completed', conclusion: 'skipped' }
        ], null);
        assert.equal(t.red, 1);
        assert.equal(t.pending, 0);
        assert.equal(t.real, 1);
    });

    test('degraded input and garbage entries fail closed, never crash', function () {
        var t = mod.realCheckTally(null, null);
        assert.equal(t.real, 0, 'null rollup — the zero tally');
        assert.equal(t.red, 0);
        var g = mod.realCheckTally([null, {}], null);
        assert.equal(g.pending, 2, 'an unreadable entry carries no verdict — it pends');
        assert.equal(g.real, 2, '…but it is not bookkeeping either');
    });

    test('custom prefix list overrides the defaults (deployment knob parity)', function () {
        var t = mod.realCheckTally([
            { name: 'merge / 1', status: 'COMPLETED', conclusion: 'SKIPPED' }
        ], ['merge /']);
        assert.equal(t.bokept, 1);
        assert.equal(t.real, 0);
    });

    test('context spelling (StatusContext) reads like name (CheckRun)', function () {
        var t = mod.realCheckTally([
            { context: 'quality', state: 'success' },
            { context: 'gate', state: 'failure' }
        ], null);
        assert.equal(t.real, 2);
        assert.equal(t.red, 1);
    });
});

suite('guestValidationPath: policy bars (gh-113)', function () {

    test('mergeableZeroFailing: stub-only head merges, red and real-pending do not', function () {
        assert.equal(mod.mergeableZeroFailing(mod.realCheckTally([
            { name: 'merge / 1', status: 'COMPLETED', conclusion: 'SKIPPED' }
        ], null)), true, 'stub-only (the live guest shape) is zero-failing');
        assert.equal(mod.mergeableZeroFailing(mod.realCheckTally([
            { name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }
        ], null)), false, 'real red blocks');
        assert.equal(mod.mergeableZeroFailing(mod.realCheckTally([
            { name: 'quality', status: 'IN_PROGRESS', conclusion: null }
        ], null)), false, 'a real in-flight check owns the verdict — never merge ahead of it');
        assert.equal(mod.mergeableZeroFailing(null), false, 'degraded probe fails closed');
    });

    test('recoverableZeroRed: decided-head bar — real-pending allowed, red and undecided not (fa#923 parity)', function () {
        assert.equal(mod.recoverableZeroRed(mod.realCheckTally([
            { name: 'quality', status: 'IN_PROGRESS', conclusion: null }
        ], null)), true, 'in-flight is not red — a stale park may clear');
        assert.equal(mod.recoverableZeroRed(mod.realCheckTally([
            { name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }
        ], null)), false);
        // fa#923: the park is set ON the punished head — a head with NO
        // check runs at all (or stub-only bookkeeping) is UNDECIDED, not
        // "the red dissolved". Clearing on real === 0 would un-park every
        // stale human head the sticky park protects.
        assert.equal(mod.recoverableZeroRed(mod.realCheckTally([], null)), false,
            'an empty rollup is undecided — the park holds (fa#923)');
        assert.equal(mod.recoverableZeroRed(mod.realCheckTally([
            { name: 'merge / 1', status: 'COMPLETED', conclusion: 'SKIPPED' }
        ], null)), false, 'stub-only is undecided — the park holds (fa#923)');
        assert.equal(mod.recoverableZeroRed(null), false, 'degraded probe keeps the park');
    });
});

suite('guestValidationPath: external validation arm (gh-113)', function () {

    var LABELED = function (login, ts, label) {
        return { event: 'labeled', label: { name: label || 'ai_validating' },
                 actor: { login: login }, created_at: ts };
    };

    test('newestArmEvent: the LAST ai_validating event wins (chronological feed)', function () {
        var arm = mod.newestArmEvent([
            LABELED('alice', '2026-10-19T20:00:00Z'),
            { event: 'unlabeled', label: { name: 'ai_validating' }, actor: { login: 'alice' } },
            LABELED('bob', '2026-10-19T22:10:00Z'),
            LABELED('alice', '2026-10-19T21:00:00Z', 'pr_approved')
        ]);
        assert.ok(arm, 'arm event found');
        assert.equal(arm.login, 'bob');
        assert.equal(arm.createdAt, '2026-10-19T22:10:00Z');
    });

    test('newestArmEvent: other labels and non-labeled events never match', function () {
        assert.equal(mod.newestArmEvent([
            LABELED('alice', '2026-10-19T21:00:00Z', 'pr_approved'),
            { event: 'closed', actor: { login: 'alice' } }
        ]), null);
        assert.equal(mod.newestArmEvent(null), null);
        assert.equal(mod.newestArmEvent([]), null);
    });

    test('newestArmEvent: string label spelling tolerated', function () {
        var arm = mod.newestArmEvent([
            { event: 'labeled', label: 'ai_validating', actor: { login: 'carol' } }
        ]);
        assert.ok(arm && arm.login === 'carol');
    });

    test('newestArmEvent: a label event with no actor/createdAt degrades to nulls', function () {
        var arm = mod.newestArmEvent([
            { event: 'labeled', label: { name: 'ai_validating' } }
        ]);
        assert.ok(arm, 'the arm event is still found');
        assert.equal(arm.login, null, 'no actor — no login proof');
        assert.equal(arm.createdAt, null);
        assert.equal(mod.isManualArm(arm, 'ai-teammate'), false,
            'an arm with no login is no proof — the gate fails closed');
    });

    test('isManualArm: a human actor arms; a machine login does not (gh-1025 bot suffix)', function () {
        assert.equal(mod.isManualArm({ login: 'yury-by' }, 'ai-teammate'), true);
        assert.equal(mod.isManualArm({ login: 'ai-teammate' }, 'ai-teammate'), false);
        // The App spelling with the [bot] suffix is still the machine.
        assert.equal(mod.isManualArm({ login: 'dmtools-factory-bot[bot]' }, 'dmtools-factory-bot'), false);
        // Comma-separated list: ANY entry counts as the machine.
        assert.equal(mod.isManualArm({ login: 'github-actions[bot]' }, 'ai-teammate,github-actions[bot]'), false);
        assert.equal(mod.isManualArm(null, 'ai-teammate'), false, 'no arm event — fail closed');
    });

    test('isManualArm: no machineAuthor configured — every actor is external', function () {
        // A deployment without the knob has no machine identity at all:
        // there is nobody the arm could have come FROM but a human.
        assert.equal(mod.isManualArm({ login: 'yury-by' }, null), true);
    });
});

suite('guestValidationPath: dead-zone scan shape (gh-113 AC3)', function () {

    var item = function (n, labels, author) {
        return { prNumber: n, labels: labels, author: author || 'yury-by' };
    };
    var pr = function (mergeState, checkConclusion) {
        return { mergeState: mergeState, checkConclusion: checkConclusion };
    };

    test('the blocked shape: guest + (pr_approved|ai_validating) + CLEAN + none/pending', function () {
        var e1 = mod.blockedGuestEntry(item(1634, ['pr_approved', 'ai_validating']), pr('CLEAN', 'pending'), true);
        var e2 = mod.blockedGuestEntry(item(1615, ['pr_approved', 'ai_validating']), pr('CLEAN', 'none'), true);
        assert.ok(e1 && e1.prNumber === 1634, 'stub-pending guest is blocked');
        assert.ok(e2 && e2.prNumber === 1615, 'check-less guest is blocked');
        assert.equal(e1.checkConclusion, 'pending');
    });

    test('not blocked: machine-authored, unapproved+unarmed, red, pending-rollup-elsewhere, BEHIND', function () {
        var isGuest = true;
        assert.equal(mod.blockedGuestEntry(
            item(1, ['pr_approved', 'ai_validating']), pr('CLEAN', 'pending'), false), null,
            'machine PRs have the auto path');
        assert.equal(mod.blockedGuestEntry(
            item(2, ['agent:rework']), pr('CLEAN', 'pending'), isGuest), null,
            'no approval and no arm — not merge-gate population');
        assert.equal(mod.blockedGuestEntry(
            item(3, ['pr_approved', 'ai_validating']), pr('CLEAN', 'red'), isGuest), null,
            'red has a verdict — fail-validation owns it');
        assert.equal(mod.blockedGuestEntry(
            item(4, ['pr_approved', 'ai_validating']), pr('CLEAN', 'green'), isGuest), null,
            'green has a verdict — merge-validated owns it');
        assert.equal(mod.blockedGuestEntry(
            item(5, ['pr_approved', 'ai_validating']), pr('BEHIND', 'pending'), isGuest), null,
            'behind=0 is part of the shape');
        assert.equal(mod.blockedGuestEntry(
            item(6, ['pr_approved', 'ai_validating']), null, isGuest), null,
            'status probe failed — never counted (fail closed)');
    });

    test('counting guards: garbage items never crash the scan; one label alone arms', function () {
        var isGuest = true;
        assert.equal(mod.blockedGuestEntry(null, pr('CLEAN', 'pending'), isGuest), null,
            'no item — nothing to count');
        assert.equal(mod.blockedGuestEntry({ labels: ['ai_validating'] }, pr('CLEAN', 'none'), isGuest), null,
            'no prNumber — uncountable');
        var e = mod.blockedGuestEntry(item(7, ['ai_validating']), pr('CLEAN', 'none'), isGuest);
        assert.ok(e && e.prNumber === 7, 'ai_validating alone arms (approved OR armed)');
        assert.deepEqual(e.labels, ['ai_validating'], 'the entry carries the labels it was read from');
        assert.equal(mod.blockedGuestEntry(item(8, undefined), pr('CLEAN', 'none'), isGuest), null,
            'no labels at all — unapproved and unarmed');
    });

    test('isArmedGuestItem pre-filters machine and unlabelled guest PRs before prStatus (gh-1181)', function () {
        var mixed = [
            { item: item(101, ['pr_approved', 'ai_validating'], 'ai-teammate'), isGuest: false, status: pr('CLEAN', 'pending') },
            { item: item(102, ['agent:review'], 'yury-by'), isGuest: true, status: pr('CLEAN', 'pending') },
            { item: item(103, [], 'yury-by'), isGuest: true, status: pr('CLEAN', 'none') },
            { item: item(104, ['pr_approved'], 'yury-by'), isGuest: true, status: pr('CLEAN', 'pending') },
            { item: item(105, ['ai_validating'], 'yury-by'), isGuest: true, status: pr('CLEAN', 'green') }
        ];
        var probedPrNumbers = [];
        var filteredBlocked = [];
        var unfilteredBlocked = [];

        for (var i = 0; i < mixed.length; i++) {
            var m = mixed[i];
            var unfilt = mod.blockedGuestEntry(m.item, m.status, m.isGuest);
            if (unfilt) unfilteredBlocked.push(unfilt);

            if (mod.isArmedGuestItem(m.item, m.isGuest)) {
                probedPrNumbers.push(m.item.prNumber);
                var filt = mod.blockedGuestEntry(m.item, m.status, m.isGuest);
                if (filt) filteredBlocked.push(filt);
            }
        }

        assert.deepEqual(probedPrNumbers, [104, 105],
            'prStatus is called ONLY for guest-armed PRs (pr_approved or ai_validating)');
        assert.deepEqual(filteredBlocked, unfilteredBlocked,
            'guest_prs_blocked_no_validation_path gives identical results before and after pre-filtering');
        assert.equal(filteredBlocked.length, 1);
        assert.equal(filteredBlocked[0].prNumber, 104);
    });

    test('scanRepoGuestDeadZone calls prStatus only for armed guest PRs and tolerates degraded inputs (gh-1181)', function () {
        var probed = [];
        var blocked = [];
        var provider = {
            listOpenPrs: function () {
                return [
                    null,
                    { number: 201, labels: [{ name: 'pr_approved' }], user: { login: 'ai-teammate' } },
                    { number: 202, labels: ['agent:review'], author: 'yury-by' },
                    { prNumber: 203, labels: [{ name: 'pr_approved' }], user: { login: 'yury-by' } },
                    { number: 204, labels: [{ name: 'ai_validating' }], user: { login: 'yury-by' } },
                    { number: 205 }
                ];
            },
            prStatus: function (n) {
                probed.push(n);
                if (n === 204) throw new Error('rate limit');
                return pr('CLEAN', 'pending');
            }
        };
        var stats = mod.scanRepoGuestDeadZone(provider, { owner: 'isti', repo: 'harness' }, 'ai-teammate', blocked);
        assert.equal(stats.totalOpen, 6);
        assert.equal(stats.probedCount, 2);
        assert.deepEqual(probed, [203, 204], 'prStatus called only for the 2 armed guest PRs');
        assert.equal(blocked.length, 1);
        assert.equal(blocked[0].prNumber, 203);

        // Also tolerate non-array listOpenPrs return
        var emptyStats = mod.scanRepoGuestDeadZone(
            { listOpenPrs: function () { return null; }, prStatus: function () { return null; } },
            { owner: 'isti', repo: 'harness' }, 'ai-teammate', []);
        assert.equal(emptyStats.totalOpen, 0);
        assert.equal(emptyStats.probedCount, 0);
    });
});

suite('guestValidationPath: cross-tick carry (gh-113 AC3)', function () {

    test('first sight stamps now; a known PR keeps its ORIGINAL first-seen', function () {
        var prev = { blocked: [{ prNumber: 1634 }], blockedAt: { '1634': '2026-10-19T20:00:00Z' } };
        var cur = { blocked: [{ prNumber: 1634 }, { prNumber: 1591 }], scannedAt: '2026-10-19T23:00:00Z' };
        var cary = mod.mergeDeadZoneCary(prev, cur);
        assert.equal(cary.blockedAt['1634'], '2026-10-19T20:00:00Z', 'age never resets');
        assert.equal(cary.blockedAt['1591'], '2026-10-19T23:00:00Z', 'new guest stamped at this scan');
        assert.equal(cary.blocked.length, 2);
    });

    test('a guest that stopped being blocked drops out of the carry', function () {
        var prev = { blocked: [{ prNumber: 1634 }, { prNumber: 1615 }],
                     blockedAt: { '1634': '2026-10-19T20:00:00Z', '1615': '2026-10-19T21:00:00Z' } };
        var cary = mod.mergeDeadZoneCary(prev, { blocked: [{ prNumber: 1615 }], scannedAt: '2026-10-19T23:00:00Z' });
        assert.equal(cary.blockedAt['1634'], undefined, 'merged/unblocked guests leave the carry');
        assert.equal(cary.blockedAt['1615'], '2026-10-19T21:00:00Z');
    });

    test('no previous snapshot — fresh carry; garbage prev tolerated', function () {
        var cary = mod.mergeDeadZoneCary(null, { blocked: [{ prNumber: 7 }], scannedAt: '2026-10-19T23:00:00Z' });
        assert.equal(cary.blockedAt['7'], '2026-10-19T23:00:00Z');
        assert.equal(mod.mergeDeadZoneCary({ blocked: 'garbage' }, null).blocked.length, 0);
    });

    test('every degraded shape degrades to a fresh carry, never a crash', function () {
        // blockedAt of the wrong type is not trusted — stamps start over.
        var cary = mod.mergeDeadZoneCary(
            { blockedAt: 'garbage' },
            { blocked: [{ prNumber: 9 }], scannedAt: '2026-10-19T23:00:00Z' });
        assert.equal(cary.blockedAt['9'], '2026-10-19T23:00:00Z');
        // No scannedAt on the current scan — the carry stamps now itself.
        var unstamped = mod.mergeDeadZoneCary(null, { blocked: [{ prNumber: 10 }] });
        assert.equal(typeof unstamped.blockedAt['10'], 'string', 'stamped with the scan time');
        assert.ok(unstamped.blockedAt['10'].indexOf('T') !== -1, 'an ISO timestamp');
        // Malformed entries drop out; the readable ones stay.
        var mixed = mod.mergeDeadZoneCary(null, {
            blocked: [null, {}, { prNumber: 11 }], scannedAt: '2026-10-19T23:00:00Z'
        });
        assert.equal(mixed.blocked.length, 1);
        assert.equal(mixed.blockedAt['11'], '2026-10-19T23:00:00Z');
    });
});
