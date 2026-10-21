/**
 * Unit tests for js/common/smRuleLayers.js (gh-1114).
 *
 * The SM tick runs in layers: L0 hygiene → L1 freshness → L2 verdict →
 * L3 dispatch → L4 agents → L5 close. Freshness before verdicts: a head
 * this tick's L1 rules moved carries no checks yet, so an L2 verdict read
 * against the superseded head is a false verdict (live #435).
 *
 * UT-1 (gh-1114 AC6): the layer order is asserted over sm_github.json —
 * every deployed rule id must be registered in the LAYERS map (adding a
 * rule without a layer FAILS this suite) and the file order must be
 * non-decreasing by layer, with the documented in-rule order constraints
 * (#682, #637, red-yields-the-slot, gh-994) intact.
 *
 * Uses: loadModule(), makeRequire(), file_read, assert, test(), suite()
 */

var smRuleLayers = loadModule('js/common/smRuleLayers.js', makeRequire({}), {});

function deployedRules() {
    var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
    return (cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [];
}

// The order-check contract as a reusable predicate, so the negative
// control below can prove an unregistered rule FAILS it (AC6: 'adding a
// rule without a layer fails the test').
function layerOrderViolations(rules) {
    var violations = [];
    var lastIdx = -1;
    rules.forEach(function (r) {
        var idx = smRuleLayers.layerIndex(r);
        if (idx === -1) {
            violations.push(r.id + ' (or rule #' +
                (rules.indexOf(r) + 1) + ') has no layer registered in smRuleLayers');
            return;
        }
        if (idx < lastIdx) {
            violations.push(r.id + ' (layer ' + smRuleLayers.layerOf(r) +
                ') runs after a later-layer rule — the layer order is violated');
        }
        lastIdx = Math.max(lastIdx, idx);
    });
    return violations;
}

suite('smRuleLayers: gh-1114 layer map (UT-1 / AC6)', function () {

    test('every deployed sm_github.json rule id is registered with a layer', function () {
        var rules = deployedRules();
        assert.ok(rules.length >= 35, 'expected the full rule set, got ' + rules.length);
        rules.forEach(function (r) {
            assert.ok(r.id, 'every rule carries an id (rule #' + (rules.indexOf(r) + 1) + ' missing)');
            assert.ok(smRuleLayers.layerOf(r) !== null,
                r.id + ' has no layer in smRuleLayers.LAYERS — register it (AC6)');
        });
    });

    test('the deployed rule order is non-decreasing by layer (freshness before verdicts)', function () {
        var violations = layerOrderViolations(deployedRules());
        assert.deepEqual(violations, [], 'layer order violations');
    });

    test('the layer map holds exactly the documented layer membership', function () {
        assert.deepEqual(smRuleLayers.LAYER_ORDER, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
        assert.deepEqual(Object.keys(smRuleLayers.LAYERS).filter(function (id) {
            return smRuleLayers.LAYERS[id] === 'L1';
        }), ['unarm-stale-validation', 'silent-update-behind', 'park-reset'],
        'L1 freshness = unarm + the two head-movers');
        assert.deepEqual(Object.keys(smRuleLayers.LAYERS).filter(function (id) {
            return smRuleLayers.LAYERS[id] === 'L2';
        }), ['merge-validated', 'merge-validated-guest', 'fail-validation', 'rework-on-red-gate-unlatched',
            'rework-on-validation-failed', 'sweep-stale-validating'],
        'L2 verdict = the four guarded actions plus the merge window (its gh-113 guest twin)');
    });

    test('deployed order invariants: #682 rerun-first, reconcile before the merge window, #637 merge before sweep, red-yields-the-slot, gh-994 park-reset in L1', function () {
        var rules = deployedRules();
        var byId = {};
        rules.forEach(function (r) { byId[r.id] = r; });
        var pos = function (id) { return rules.indexOf(byId[id]); };

        // #682: the rerun twins stay FIRST (L0), ahead of everything.
        assert.equal(rules[0].id, 'rerun-cancelled-checks', '#682: rerun-cancelled-checks is the first rule');
        assert.equal(rules[1].id, 'rerun-any-cancelled-checks', 'its ANY-cancelled twin sits directly below (gh-755)');

        // The reconcile twins run before the merge window (L0 < L2) — the
        // same tick's merge-validated must see the reconciled labels.
        ['reconcile-rework-vs-approval', 'reconcile-issue-rework-vs-approval', 'reconcile-approval-vs-changes']
            .forEach(function (id) {
                assert.ok(pos(id) < pos('merge-validated'), id + ' runs before the merge window');
            });

        // #637: merge-validated before sweep-stale-validating.
        assert.ok(pos('merge-validated') < pos('sweep-stale-validating'),
            '#637: merge-validated still runs before sweep-stale-validating');

        // Red yields the slot (owner 2026-10-04): fail-validation before
        // validate-armed — the unarm frees the mutex for the arm rule.
        assert.ok(pos('fail-validation') < pos('validate-armed'),
            'fail-validation runs before validate-armed (red yields the slot)');

        // gh-1114: the freshness layer runs BEFORE the verdict layer — the
        // one real move the card makes (unarm-stale-validation ahead of
        // merge-validated; its query is concluded+BEHIND, merge-validated
        // needs CLEAN — disjoint sets, no merge lost).
        assert.ok(pos('unarm-stale-validation') < pos('merge-validated'),
            'freshness (unarm-stale) precedes the verdict window');
        assert.ok(pos('silent-update-behind') < pos('merge-validated'),
            'freshness (silent-update) precedes the verdict window');
        assert.ok(pos('park-reset') < pos('merge-validated'),
            'freshness (park-reset) precedes the verdict window');

        // gh-994: park-reset stays a head-change reset — L1, right after
        // silent-update-behind (relative order preserved).
        assert.equal(pos('park-reset'), pos('silent-update-behind') + 1,
            'park-reset sits directly after silent-update-behind (L1)');

        // AC13 structural half: in the dispatch layer the approved merge
        // candidate arms BEFORE fresh validations — approved PRs never
        // lose a validation slot to a fresh one in the same tick.
        assert.ok(pos('validate-armed') < pos('validate-fresh'),
            'the approved arm runs before validate-fresh (merge-first, UT-10)');
    });

    test('negative control: a rule without a registered layer FAILS the order check (AC6)', function () {
        var rules = deployedRules().map(function (r) {
            return { id: r.id };
        });
        rules.push({ id: 'some-future-rule' }); // the unregistered new rule
        var violations = layerOrderViolations(rules);
        assert.equal(violations.length, 1, 'exactly the unregistered rule is flagged');
        assert.contains(violations[0], 'some-future-rule');
        assert.contains(violations[0], 'no layer');
    });

    test('unknown rules (jira mode, custom smRules) resolve to no layer and no merge path', function () {
        assert.equal(smRuleLayers.layerIndex({ id: 'agents-some-custom-rule' }), -1);
        assert.equal(smRuleLayers.layerOf({}), null);
        assert.equal(smRuleLayers.layerOf(null), null);
        assert.equal(smRuleLayers.isMergePathRule({ localAction: 'validate_pr', query: {} }), false,
            'a validate_pr rule without the approved mutex is not merge-path');
    });
});

suite('smRuleLayers: gh-1114 verdict guard + merge-first capacity helpers', function () {

    test('isVerdictAction covers exactly the four L2 actions (UT-2..5 map)', function () {
        ['merge_pr', 'fail_validation', 'arm_rework', 'sweep_stale_validation'].forEach(function (a) {
            assert.equal(smRuleLayers.isVerdictAction({ localAction: a }), true, a + ' is a verdict action');
        });
        ['update_branch', 'validate_pr', 'unarm_validation', 'complete_validation',
            'conflict_rework', 'reconcile_verdicts', 'close_issue', 'mark_developed',
            'arm_review', 'restore_rework_arm', undefined].forEach(function (a) {
            assert.equal(smRuleLayers.isVerdictAction({ localAction: a }), false,
                a + ' is NOT a verdict action');
        });
    });

    test('isMergePathRule: the approved merge-window arms + rework-on-red-ci (merge-path rework)', function () {
        var validateArmed = deployedRules().filter(function (r) { return r.id === 'validate-armed'; })[0];
        assert.equal(smRuleLayers.isMergePathRule(validateArmed), true,
            'validate-armed is merge-path (approved validation)');
        ['revalidate-armed', 'revalidate-armed-green'].forEach(function (id) {
            var r = deployedRules().filter(function (x) { return x.id === id; })[0];
            assert.equal(smRuleLayers.isMergePathRule(r), true, id + ' is merge-path');
        });
        var redCi = deployedRules().filter(function (x) { return x.id === 'rework-on-red-ci'; })[0];
        assert.equal(smRuleLayers.isMergePathRule(redCi), true,
            'rework-on-red-ci is a merge-path leg (owner directive 2026-10-19)');

        // Fresh validations are NOT merge-path — they never spend the slot.
        ['validate-fresh', 'validate-fresh-masked-green'].forEach(function (id) {
            var r = deployedRules().filter(function (x) { return x.id === id; })[0];
            assert.equal(smRuleLayers.isMergePathRule(r), false, id + ' is not merge-path');
        });
        var manual = deployedRules().filter(function (x) { return x.id === 'rework-on-label'; })[0];
        assert.equal(smRuleLayers.isMergePathRule(manual), false,
            'manual rework is not merge-path (only rework-on-red-ci is)');
    });

    test('mergeReservedSlots parses jobParams.mergeReservedSlots (default 1, 0/false disables)', function () {
        assert.equal(smRuleLayers.mergeReservedSlots({}), 1, 'default 1');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: 2 }), 2);
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: '3' }), 3, 'string form (repo variable)');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: 0 }), 0, '0 disables');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: false }), 0, 'false disables');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: 'false' }), 0, "'false' disables");
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: 'junk' }), 0, 'junk disables, never guesses');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: 2.7 }), 2, 'floored');
        assert.equal(smRuleLayers.mergeReservedSlots(null), 1, 'no jobParams → default');
        // Edge pins (gh-1114 rework): boolean-true, non-positive and junk
        // numerics, and the explicit-undefined spellings.
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: true }), 1, 'boolean true = 1 slot');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: -2 }), 0, 'negative number is junk → 0');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: NaN }), 0, 'NaN number is junk → 0');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: '-3' }), 0, 'negative string parses → non-positive → 0');
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: '0' }), 0, "'0' parses → 0 (disabled)");
        assert.equal(smRuleLayers.mergeReservedSlots({ mergeReservedSlots: undefined }), 1, 'explicit undefined → default 1');
    });

    test('reservationFor: gh-837 parallel mode reserves the whole mutex width (UT-10)', function () {
        assert.equal(smRuleLayers.reservationFor(1, 1), 1, 'serial mode → mergeReservedSlots');
        assert.equal(smRuleLayers.reservationFor(2, 1), 2, 'serial mode → mergeReservedSlots');
        assert.equal(smRuleLayers.reservationFor(1, 2), 2, 'parallel mode → validationMutexMax');
        assert.equal(smRuleLayers.reservationFor(1, 3), 3, 'parallel mode → validationMutexMax');
        assert.equal(smRuleLayers.reservationFor(0, 1), 0, 'disabled stays disabled');
        // gh-1114 review (PR #1120 thread smRuleLayers.js:167): the kill
        // switch must kill in EVERY mode — an explicit mergeReservedSlots 0
        // is "bit-identical with the pre-gh-1114 capacity behavior", so the
        // parallel override must not resurrect the reservation.
        assert.equal(smRuleLayers.reservationFor(0, 3), 0, 'explicit disable wins in parallel mode');
        assert.equal(smRuleLayers.reservationFor(0, 2), 0, 'explicit disable wins in parallel mode (mutex 2)');
        assert.equal(smRuleLayers.reservationFor(
            smRuleLayers.mergeReservedSlots({ mergeReservedSlots: 'false' }), 3), 0,
            "string 'false' disable survives the parallel override");
    });
});
