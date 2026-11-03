/**
 * Unit tests for js/common/tcRoleStamp.js — the gh-1345 mechanical TC role
 * stamping (the TC-generator leg's post-action parser + planner).
 *
 * Contract (instructions/test_cases/test_case_creation_rules.md):
 *   - the bug's acceptance oracle states `Verifies: <BUG-KEY>` on its first
 *     description line;
 *   - a prevention test states `Regression guard: <scope>`;
 *   - the stamp is mechanical: TCs that already carry a marker keep it
 *     (agent prose respected); among unmarked linked TCs exactly ONE becomes
 *     the oracle — the lowest key (the mandatory regression test is rule-listed
 *     first, the generator creates in order); every other unmarked TC is a
 *     regression guard protecting the bug's pinned behavior.
 */

var stamp = loadModule('js/common/tcRoleStamp.js', makeRequire({}));

suite('tcRoleStamp: parseRoleMarker', function() {

    test('Verifies marker on the first line parses with its key', function() {
        var m = stamp.parseRoleMarker('Verifies: BUG-1\n\nh4. Objective\nDo the thing');
        assert.ok(m);
        assert.equal(m.kind, 'verifies');
        assert.equal(m.key, 'BUG-1');
    });

    test('Regression guard marker parses with its scope', function() {
        var m = stamp.parseRoleMarker('Regression guard: checkout totals rounding\nh4. Objective\nguard the totals');
        assert.ok(m);
        assert.equal(m.kind, 'guard');
        assert.equal(m.scope, 'checkout totals rounding');
    });

    test('markers are recognized case-insensitively but keys keep their case', function() {
        var m = stamp.parseRoleMarker('verifies: BUG-2');
        assert.ok(m);
        assert.equal(m.kind, 'verifies');
        assert.equal(m.key, 'BUG-2');
    });

    test('leading blank lines do not hide the marker', function() {
        var m = stamp.parseRoleMarker('\n\nRegression guard: flake net');
        assert.ok(m);
        assert.equal(m.kind, 'guard');
        assert.equal(m.scope, 'flake net');
    });

    test('a marker below other prose is NOT a role marker (first-line contract)', function() {
        assert.equal(stamp.parseRoleMarker('h4. Objective\nVerifies: BUG-1'), null);
    });

    test('an unmarked description parses to null', function() {
        assert.equal(stamp.parseRoleMarker('h4. Objective\nCheck the thing'), null);
        assert.equal(stamp.parseRoleMarker(''), null);
        assert.equal(stamp.parseRoleMarker(null), null);
    });

    test('the legacy guidance words in the body do not parse as markers', function() {
        assert.equal(stamp.parseRoleMarker('h4. Objective\nThis verifies: the bug'), null);
    });
});

suite('tcRoleStamp: stampPlan — one oracle, the rest guards', function() {

    test('a single unmarked TC becomes the bug oracle (Verifies: <BUG-KEY>)', function() {
        var plan = stamp.stampPlan(
            [{ key: 'TS-5', fields: { description: 'h4. Objective\nthing' } }],
            'BUG-1', 'Checkout total wrong');
        assert.equal(plan.length, 1);
        assert.equal(plan[0].tcKey, 'TS-5');
        assert.equal(plan[0].marker, 'Verifies: BUG-1');
    });

    test('two unmarked TCs split oracle + guard (lowest key is the oracle)', function() {
        var plan = stamp.stampPlan([
            { key: 'TS-5', fields: { description: 'regression of the bug' } },
            { key: 'TS-6', fields: { description: 'prevention of the root cause' } }
        ], 'BUG-1', 'Checkout total wrong');
        assert.equal(plan.length, 2);
        assert.equal(plan[0].tcKey, 'TS-5');
        assert.equal(plan[0].marker, 'Verifies: BUG-1');
        assert.equal(plan[1].tcKey, 'TS-6');
        assert.equal(plan[1].marker, 'Regression guard: Checkout total wrong');
    });

    test('numeric key order decides the oracle, not list order', function() {
        var plan = stamp.stampPlan([
            { key: 'TS-9', fields: { description: 'a' } },
            { key: 'TS-10', fields: { description: 'b' } }
        ], 'BUG-1', 'Scope');
        assert.equal(plan[0].tcKey, 'TS-9');
        assert.equal(plan[0].marker, 'Verifies: BUG-1');
        assert.equal(plan[1].tcKey, 'TS-10');
        assert.equal(plan[1].marker, 'Regression guard: Scope');
    });

    test('an already-marked oracle leaves every unmarked TC a guard', function() {
        var plan = stamp.stampPlan([
            { key: 'TS-5', fields: { description: 'Verifies: BUG-1\nbody' } },
            { key: 'TS-6', fields: { description: 'unmarked' } },
            { key: 'TS-7', fields: { description: 'unmarked too' } }
        ], 'BUG-1', 'Scope');
        assert.equal(plan.length, 2);
        assert.deepEqual(plan.map(function(p) { return p.tcKey; }), ['TS-6', 'TS-7']);
        plan.forEach(function(p) {
            assert.equal(p.marker, 'Regression guard: Scope');
        });
    });

    test('a marked TC is never re-stamped (idempotency)', function() {
        var plan = stamp.stampPlan([
            { key: 'TS-5', fields: { description: 'Verifies: BUG-1\nbody' } },
            { key: 'TS-6', fields: { description: 'Regression guard: pinned behavior\nbody' } }
        ], 'BUG-1', 'Scope');
        assert.deepEqual(plan, []);
    });

    test('a guard-only marker set still elects the lowest unmarked TC as oracle', function() {
        var plan = stamp.stampPlan([
            { key: 'TS-5', fields: { description: 'Regression guard: pinned behavior\nbody' } },
            { key: 'TS-6', fields: { description: 'unmarked' } }
        ], 'BUG-1', 'Scope');
        assert.equal(plan.length, 1);
        assert.equal(plan[0].tcKey, 'TS-6');
        assert.equal(plan[0].marker, 'Verifies: BUG-1');
    });

    test('an oracle marking a DIFFERENT bug does not count as this bug oracle', function() {
        var plan = stamp.stampPlan([
            { key: 'TS-5', fields: { description: 'Verifies: BUG-2\nbody' } },
            { key: 'TS-6', fields: { description: 'unmarked' } }
        ], 'BUG-1', 'Scope');
        assert.equal(plan.length, 2);
        assert.equal(plan[0].tcKey, 'TS-5');
        assert.equal(plan[0].marker, 'Verifies: BUG-1');
        assert.equal(plan[1].tcKey, 'TS-6');
        assert.equal(plan[1].marker, 'Regression guard: Scope');
    });

    test('empty input produces an empty plan', function() {
        assert.deepEqual(stamp.stampPlan([], 'BUG-1', 'Scope'), []);
        assert.deepEqual(stamp.stampPlan(null, 'BUG-1', 'Scope'), []);
    });

    test('a missing bug summary falls back to the bug key as the guard scope', function() {
        var plan = stamp.stampPlan([
            { key: 'TS-5', fields: { description: 'a' } },
            { key: 'TS-6', fields: { description: 'b' } }
        ], 'BUG-1', null);
        assert.equal(plan[1].marker, 'Regression guard: BUG-1');
    });
});

suite('tcRoleStamp: stampedDescription', function() {

    test('the marker becomes the FIRST line of the description', function() {
        var d = stamp.stampedDescription('h4. Objective\nthing', 'Verifies: BUG-1');
        assert.equal(d, 'Verifies: BUG-1\n\nh4. Objective\nthing');
    });

    test('an empty description gets the marker plus a body placeholder', function() {
        var d = stamp.stampedDescription('', 'Verifies: BUG-1');
        assert.equal(d, 'Verifies: BUG-1\n\n');
        assert.equal(stamp.stampedDescription(null, 'Verifies: BUG-1'), 'Verifies: BUG-1\n\n');
    });

    test('stamping twice never duplicates the marker', function() {
        var once = stamp.stampedDescription('body', 'Verifies: BUG-1');
        var twice = stamp.stampedDescription(once, 'Verifies: BUG-1');
        assert.equal(twice, once);
    });
});

suite('tcRoleStamp: roleFieldsFromDescription — the automation leg reads the stamp', function() {

    test('a Verifies stamp resolves to the explicit verifies role fields', function() {
        var f = stamp.roleFieldsFromDescription('Verifies: BUG-1\nbody', 'BUG-1');
        assert.equal(f.role, 'verifies');
        assert.equal(f.verifies, 'BUG-1');
    });

    test('a Regression guard stamp resolves to the guard role fields', function() {
        var f = stamp.roleFieldsFromDescription('Regression guard: totals\nbody', 'BUG-1');
        assert.equal(f.role, 'regression guard');
        assert.equal(f.regressionGuard, true);
    });

    test('a Verifies stamp naming ANOTHER bug carries that key (sibling detection)', function() {
        var f = stamp.roleFieldsFromDescription('Verifies: BUG-2\nbody', 'BUG-1');
        assert.equal(f.role, 'verifies');
        assert.equal(f.verifies, 'BUG-2');
    });

    test('an unmarked description yields no role fields (legacy own-oracle fallback)', function() {
        assert.deepEqual(stamp.roleFieldsFromDescription('h4. Objective\nthing', 'BUG-1'), {});
        assert.deepEqual(stamp.roleFieldsFromDescription(null, 'BUG-1'), {});
    });

    test('annotateWithRoles stamps role fields onto every linked entry (multi-item)', function() {
        var annotated = stamp.annotateWithRoles([
            { key: 'TS-5', fields: { description: 'Verifies: BUG-1\nbody' } },
            { key: 'TS-6', fields: { description: 'Regression guard: totals\nbody' } },
            { key: 'TS-7', fields: { description: 'plain' } }
        ], 'BUG-1');
        assert.equal(annotated.length, 3);
        assert.equal(annotated[0].role, 'verifies');
        assert.equal(annotated[0].verifies, 'BUG-1');
        assert.equal(annotated[1].role, 'regression guard');
        assert.equal(annotated[1].regressionGuard, true);
        assert.equal(annotated[2].role, undefined);
        assert.equal(annotated[2].description, 'plain');
    });

    test('annotateWithRoles tolerates missing entries and empty lists', function() {
        assert.deepEqual(stamp.annotateWithRoles([], 'BUG-1'), []);
        assert.deepEqual(stamp.annotateWithRoles(null, 'BUG-1'), []);
        var annotated = stamp.annotateWithRoles([null, { key: 'TS-5' }], 'BUG-1');
        assert.equal(annotated.length, 2);
        assert.equal(annotated[0], null);
    });
});
