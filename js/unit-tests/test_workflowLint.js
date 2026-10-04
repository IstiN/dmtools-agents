/**
 * Unit tests: js/workflowLint.js + the workflow-trigger contract.
 *
 * Guards the gh-676 incident class: while .github/workflows/ai-teammate.yml
 * was unparseable (#669 merge residue — duplicate permission keys, fixed in
 * #671), GitHub kept a stale push-event registration. Every machine-sm
 * state-publish push to `factory-data` then spawned an instant-fail
 * event=push run with zero jobs ("the phantom", ~2 failed runs / 30m).
 *
 * Invariants:
 *   R1 triggers — the AI Teammate stub (and its per-repo template) declare
 *      EXACTLY issues + workflow_dispatch. A push trigger here would launch
 *      teammate runs on every state push; a dropped trigger silently kills
 *      the machine loop.
 *   R2 duplicate keys — no .github/workflows/*.yml may contain duplicate
 *      mapping keys (YAML hard error → unparseable stretch → phantom
 *      registrations). This is the #671 root-cause class.
 */
'use strict';

/* global loadModule, assert, test, suite, file_read, file_list */

var lint = loadModule('js/workflowLint.js');

// ── extractTriggers: pure-logic fixtures ─────────────────────────────────────

suite('workflowLint.extractTriggers', function () {

    test('block form with two triggers, nested types do not leak in', function () {
        var yml = [
            'name: AI Teammate',
            'on:',
            '  issues:',
            '    types: [assigned, labeled]',
            '  workflow_dispatch:',
            '    inputs:',
            '      issue:',
            '        type: string',
            'permissions:',
            '  contents: write'
        ].join('\n');
        assert.deepEqual(lint.extractTriggers(yml), ['issues', 'workflow_dispatch']);
    });

    test('file without an on: block yields no triggers', function () {
        assert.deepEqual(lint.extractTriggers('name: x\njobs:\n  a:\n    runs-on: ubuntu'), []);
    });

    test('flow list form on: [push, workflow_dispatch] is parsed', function () {
        assert.deepEqual(lint.extractTriggers('on: [push, workflow_dispatch]\njobs: {}'),
            ['push', 'workflow_dispatch']);
    });

    test('on: block ends at the next top-level key — jobs content is ignored', function () {
        var yml = [
            'on:',
            '  schedule:',
            '    - cron: "*/10 * * * *"',
            '  workflow_dispatch:',
            'jobs:',
            '  sm:',
            '    steps:',
            '      - run: echo push'
        ].join('\n');
        assert.deepEqual(lint.extractTriggers(yml), ['schedule', 'workflow_dispatch']);
    });

    test('a nested "on:" below the top level is not the trigger block', function () {
        var yml = [
            'jobs:',
            '  a:',
            '    steps:',
            '      - run: |',
            '          echo "on:" is text',
            'name: x'
        ].join('\n');
        assert.deepEqual(lint.extractTriggers(yml), []);
    });

    test('commented-out on: lines are skipped', function () {
        var yml = [
            '# on:',
            '#   push:',
            'name: x'
        ].join('\n');
        assert.deepEqual(lint.extractTriggers(yml), []);
    });

    test('quoted trigger keys are unquoted', function () {
        var yml = 'on:\n  "issues":\n  workflow_dispatch:\njobs: {}';
        assert.deepEqual(lint.extractTriggers(yml), ['issues', 'workflow_dispatch']);
    });
});

// ── findDuplicateKeys: pure-logic fixtures ───────────────────────────────────

suite('workflowLint.findDuplicateKeys', function () {

    test('duplicate key inside one mapping is reported with the second line number', function () {
        var yml = [
            'permissions:',
            '  issues: write',
            '  contents: write',
            '  issues: write'
        ].join('\n');
        var dups = lint.findDuplicateKeys(yml);
        assert.equal(dups.length, 1);
        assert.equal(dups[0].key, 'issues');
        assert.equal(dups[0].line, 4);
    });

    test('the exact #671 shape — two duplicated permission keys, both reported', function () {
        var yml = [
            'permissions:',
            '  contents: write',
            '  issues: write',
            '  pull-requests: write',
            '  issues: write',
            '  pull-requests: write'
        ].join('\n');
        var dups = lint.findDuplicateKeys(yml);
        assert.equal(dups.length, 2);
        assert.deepEqual(dups.map(function (d) { return d.key; }), ['issues', 'pull-requests']);
    });

    test('same key in different sibling mappings is fine (two jobs with runs-on)', function () {
        var yml = [
            'jobs:',
            '  a:',
            '    runs-on: ubuntu-latest',
            '  b:',
            '    runs-on: ubuntu-latest'
        ].join('\n');
        assert.deepEqual(lint.findDuplicateKeys(yml), []);
    });

    test('same key in different list items is fine (two steps with name/uses)', function () {
        var yml = [
            'jobs:',
            '  a:',
            '    steps:',
            '      - name: one',
            '        uses: actions/checkout@v4',
            '      - name: two',
            '        uses: actions/checkout@v4'
        ].join('\n');
        assert.deepEqual(lint.findDuplicateKeys(yml), []);
    });

    test('block-scalar content (run: |) never produces keys', function () {
        var yml = [
            'jobs:',
            '  a:',
            '    steps:',
            '      - run: |',
            '          env: stuffing',
            '          fake_key: nope',
            '      - run: echo done'
        ].join('\n');
        assert.deepEqual(lint.findDuplicateKeys(yml), []);
    });

    test('folded scalar (run-name: >-) content never produces keys', function () {
        var yml = [
            'run-name: >-',
            "  tick {0}: schedule || ''",
            'on:',
            '  workflow_dispatch:',
            'jobs: {}'
        ].join('\n');
        assert.deepEqual(lint.findDuplicateKeys(yml), []);
    });

    test('a dedent below the scalar indent ends the scalar', function () {
        var yml = [
            'jobs:',
            '  a:',
            '    steps:',
            '      - run: |',
            '          key: inside-scalar',
            '    runs-on: ubuntu-latest',
            '    runs-on: ubuntu-latest'
        ].join('\n');
        var dups = lint.findDuplicateKeys(yml);
        assert.equal(dups.length, 1);
        assert.equal(dups[0].key, 'runs-on');
    });

    test('duplicate keys nested one level deep are still caught', function () {
        var yml = [
            'jobs:',
            '  a:',
            '    concurrency:',
            '      group: g',
            '      group: g'
        ].join('\n');
        assert.equal(lint.findDuplicateKeys(yml).length, 1);
    });

    test('comments and blank lines do not corrupt tracking', function () {
        var yml = [
            'permissions:',
            '  # the ceiling grant',
            '',
            '  contents: write',
            '  contents: write'
        ].join('\n');
        assert.equal(lint.findDuplicateKeys(yml).length, 1);
    });

    test('repeated list-item keys (cron entries) are not duplicates', function () {
        var yml = [
            'on:',
            '  schedule:',
            '    - cron: "13,43 * * * *"',
            '    - cron: "0 * * * *"',
            '  workflow_dispatch:'
        ].join('\n');
        assert.deepEqual(lint.findDuplicateKeys(yml), []);
    });

    test('a clean multi-job workflow yields no duplicates', function () {
        var yml = [
            'name: Quality',
            'on:',
            '  push:',
            '    branches: [main]',
            '  workflow_dispatch:',
            'permissions:',
            '  contents: read',
            'jobs:',
            '  crap:',
            '    runs-on: ubuntu-24.04',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '      - uses: actions/setup-node@v4',
            '        with:',
            '          node-version: 20',
            '  gate:',
            '    runs-on: ubuntu-24.04',
            '    needs: crap',
            '    steps:',
            '      - run: echo ok'
        ].join('\n');
        assert.deepEqual(lint.findDuplicateKeys(yml), []);
    });
});

// ── repo contract: the AI Teammate stub and its template ─────────────────────

var STUB = file_read({ path: '.github/workflows/ai-teammate.yml' });
var TEMPLATE = file_read({ path: 'workflows/ai-teammate.yml.template' });

function assertTriggerSet(yml, label) {
    var triggers = lint.extractTriggers(yml).slice().sort();
    assert.deepEqual(triggers, ['issues', 'workflow_dispatch'],
        label + ': trigger set drifted — the stub must fire on issues + workflow_dispatch ONLY. ' +
        'Adding a push trigger launches teammate runs on every factory-data state push; ' +
        'dropping one silently kills the machine loop. Found: ' + JSON.stringify(triggers));
}

suite('workflow contract — ai-teammate stub (gh-676)', function () {

    test('stub declares exactly issues + workflow_dispatch (no push)', function () {
        assertTriggerSet(STUB, '.github/workflows/ai-teammate.yml');
    });

    test('stub trigger block is parseable — no duplicate keys (the #671/gh-676 root cause)', function () {
        var dups = lint.findDuplicateKeys(STUB);
        assert.deepEqual(dups, [],
            'duplicate YAML keys make the stub unparseable — dispatches 422 and a phantom ' +
            'push registration persists: ' + JSON.stringify(dups));
    });

    test('template declares exactly issues + workflow_dispatch (no push)', function () {
        assertTriggerSet(TEMPLATE, 'workflows/ai-teammate.yml.template');
    });

    test('template has no duplicate keys', function () {
        assert.deepEqual(lint.findDuplicateKeys(TEMPLATE), [],
            'target repos copy this file — ship it parseable');
    });
});

// ── repo contract: every committed workflow is parseable-shaped ──────────────

suite('workflow contract — all .github/workflows/*.yml', function () {

    if (typeof file_list === 'function') {
        var entries = file_list('.github/workflows');
        if (typeof entries === 'string') entries = JSON.parse(entries);
        var files = ((entries && entries.entries) || [])
            .map(String)
            .filter(function (e) { return e.slice(-4) === '.yml'; })
            .sort();

        test('workflow inventory is non-empty (scan actually runs)', function () {
            assert.ok(files.length >= 10, 'expected the full workflow set, found: ' + files.length);
        });

        test('no workflow contains duplicate YAML keys (' + files.length + ' files)', function () {
            var bad = [];
            for (var i = 0; i < files.length; i++) {
                var dups = lint.findDuplicateKeys(file_read({ path: files[i] }));
                for (var j = 0; j < dups.length; j++) {
                    bad.push(files[i].slice(files[i].lastIndexOf('/') + 1) +
                        ' line ' + dups[j].line + ': ' + dups[j].key);
                }
            }
            assert.deepEqual(bad, [],
                'duplicate YAML keys = unparseable workflow = dead triggers + phantom ' +
                'registrations (gh-676): ' + bad.join('; '));
        });
    } else {
        console.log('  ⏭ file_list unavailable (node harness) — directory-wide duplicate scan skipped');
    }
});
