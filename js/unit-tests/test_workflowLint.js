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
 *   R3 assigned-only — gh-1076: the stub's issues trigger fires on
 *      `assigned` ONLY. The `labeled` trigger re-fired the workflow on
 *      the factory's own consequence labels (live #1074: 3 runs for one
 *      assign); label-driven pickup is the SM tick's workflow_dispatch
 *      lane, so no labeled branch may survive anywhere in the stub.
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

// ── extractIssueTypes: pure-logic fixtures ───────────────────────────────────

suite('workflowLint.extractIssueTypes', function () {

    test('flow list form under issues:', function () {
        var yml = [
            'name: AI Teammate',
            'on:',
            '  issues:',
            '    types: [assigned, labeled]',
            '  workflow_dispatch:',
            'jobs: {}'
        ].join('\n');
        assert.deepEqual(lint.extractIssueTypes(yml), ['assigned', 'labeled']);
    });

    test('assigned-only flow list (the gh-1076 stub shape)', function () {
        var yml = 'on:\n  issues:\n    types: [assigned]\n  workflow_dispatch:\npermissions: {}';
        assert.deepEqual(lint.extractIssueTypes(yml), ['assigned']);
    });

    test('block list form is parsed', function () {
        var yml = [
            'on:',
            '  issues:',
            '    types:',
            '      - assigned',
            '      - labeled',
            '  workflow_dispatch:'
        ].join('\n');
        assert.deepEqual(lint.extractIssueTypes(yml), ['assigned', 'labeled']);
    });

    test('no issues trigger yields null', function () {
        var yml = 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs: {}';
        assert.equal(lint.extractIssueTypes(yml), null);
    });

    test('issues trigger without a types key yields null', function () {
        var yml = 'on:\n  issues:\n  workflow_dispatch:\njobs: {}';
        assert.equal(lint.extractIssueTypes(yml), null);
    });

    test('flow-list on: form yields null (no per-trigger options)', function () {
        assert.equal(lint.extractIssueTypes('on: [issues, workflow_dispatch]\njobs: {}'), null);
    });

    test('types under a different trigger never leak into the result', function () {
        var yml = [
            'on:',
            '  schedule:',
            '    - cron: "*/5 * * * *"',
            '  issues:',
            '    types: [assigned]'
        ].join('\n');
        assert.deepEqual(lint.extractIssueTypes(yml), ['assigned']);
    });

    test('commented-out types lines are skipped', function () {
        var yml = [
            'on:',
            '  issues:',
            '    # types: [assigned, labeled]',
            '    types: [assigned]',
            '  workflow_dispatch:'
        ].join('\n');
        assert.deepEqual(lint.extractIssueTypes(yml), ['assigned']);
    });

    test('a flow-form on: line is skipped — a later block-form on: still yields types', function () {
        var yml = [
            'on: [push]',
            'on:',
            '  issues:',
            '    types: [assigned]',
            'jobs: {}'
        ].join('\n');
        assert.deepEqual(lint.extractIssueTypes(yml), ['assigned']);
    });

    test('block list items tolerate blanks and trailing comments', function () {
        var yml = [
            'on:',
            '  issues:',
            '    types:',
            '      - assigned # instant fire',
            '',
            '      - labeled',
            '  workflow_dispatch:'
        ].join('\n');
        assert.deepEqual(lint.extractIssueTypes(yml), ['assigned', 'labeled']);
    });

    test('a column-0 comment inside the on: block does not end the types scan', function () {
        var yml = [
            'on:',
            '  issues:',
            '    types: [assigned]',
            '# a column-0 comment between triggers',
            '  workflow_dispatch:'
        ].join('\n');
        assert.deepEqual(lint.extractIssueTypes(yml), ['assigned']);
    });
});

suite('workflowLint shared block scanner (extractTriggers + extractIssueTypes)', function () {

    test('column-0 comments inside the on: block never hide later triggers', function () {
        // YAML: comments are transparent — a column-0 comment between
        // children does not close the on: mapping, so the trigger scan
        // must not stop at it (a commented-out trigger line is a comment,
        // NOT a trigger — but a real trigger below it still counts).
        var yml = [
            'on:',
            '  issues:',
            '# column-0 comment between children',
            '  workflow_dispatch:',
            'jobs: {}'
        ].join('\n');
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

// ── repo contract: gh-1029 — labeled events must not self-retrigger ─────────
//
// Live 2026-10-18 (issue #1027): the leg labels `status:In Development` at
// 08:31:14Z → the issues `labeled` trigger fires a second run that parks in
// the same concurrency group and burns a runner spin on a guaranteed no-op.
// `on:` cannot filter by label name, so the gate must live in the job `if:`:
// a labeled event proceeds ONLY when the added label is an arming label
// (agent:*, pr_approved). Lifecycle labels (status:*, ai_developed, ...)
// must never allocate a runner.

var ARMING_LABELS = ['agent:dev', 'agent:develop', 'agent:review', 'agent:rework', 'pr_approved'];

// Collect every folded job-level `if: >-` block (4-space indent under a
// job) as a scalar (folded scalar semantics: lines joined with ' ').
function foldedIfBlocks(yml) {
    var blocks = [];
    var lines = yml.split('\n');
    for (var i = 0; i < lines.length; i++) {
        if (!/^ {4}if: >-\s*$/.test(lines[i])) continue;
        var parts = [];
        for (var j = i + 1; j < lines.length; j++) {
            if (/^\s*$/.test(lines[j])) continue;
            if (!/^ {5,}/.test(lines[j])) break;
            parts.push(lines[j].replace(/^\s+/, ''));
        }
        blocks.push(parts.join(' '));
    }
    return blocks;
}

// The folded `if: >-` gate this contract guards. gh-1065: the stub now
// carries TWO such gates — the dedup probe job mirrors the arming gate —
// so target the CALL gate: the one that also gates on the dedup probe
// output (the template has only the call gate, so the marker check falls
// back to the first block there).
function extractJobIf(yml) {
    var blocks = foldedIfBlocks(yml);
    for (var k = 0; k < blocks.length; k++) {
        if (blocks[k].indexOf('needs.dedup.outputs.proceed') !== -1) return blocks[k];
    }
    return blocks.length ? blocks[0] : '';
}

// Every label comparison (`github.event.label.name == '...'`) in the gate.
function gateLabelNames(ifExpr) {
    var found = [];
    var re = /github\.event\.label\.name\s*==\s*'([^']+)'/g;
    var m;
    while ((m = re.exec(ifExpr)) !== null) found.push(m[1]);
    return found;
}

function assertLabelGate(yml, label) {
    var ifExpr = extractJobIf(yml);
    assert.ok(ifExpr, label + ': no folded job-level `if: >-` gate found — the ' +
        'labeled-event gate must live at job level so no-op runs never allocate a runner');

    test(label + ': labeled path admits ONLY the arming labels', function () {
        assert.deepEqual(gateLabelNames(ifExpr).slice().sort(), ARMING_LABELS.slice().sort(),
            label + ': `github.event.label.name` gate drifted. Arming set must be exactly ' +
            JSON.stringify(ARMING_LABELS) + ' — a lifecycle label (status:*, ai_developed, ...) ' +
            'here re-triggers a no-op run per leg (gh-1029). Found: ' +
            JSON.stringify(gateLabelNames(ifExpr)));
    });

    test(label + ': gate distinguishes the assigned action from the labeled action', function () {
        assert.ok(ifExpr.indexOf("github.event.action == 'assigned'") !== -1,
            label + ': gate must key the assignee check to action == assigned');
        assert.ok(ifExpr.indexOf("github.event.action == 'labeled'") !== -1,
            label + ': gate must key the label check to action == labeled, otherwise a ' +
            'labeled event from ANY label write matches the assignee-only branch');
    });

    test(label + ': workflow_dispatch entry path is preserved', function () {
        assert.ok(ifExpr.indexOf("github.event_name == 'workflow_dispatch'") !== -1,
            label + ': dropping the dispatch path silently kills the SM reconciler loop');
    });
}

suite('workflow contract — template labeled-event gate (gh-1029)', function () {

    // gh-1076 removed the `labeled` trigger from the dmtools-agents stub
    // (see the gh-1076 suite below) — the stub no longer carries a labeled
    // gate branch to guard. The consumer-repo TEMPLATE keeps the labeled
    // fast path (its event-path dedup is the deferred gh-1065 follow-up),
    // so while it does, this gh-1029 contract guards it: lifecycle labels
    // must never allocate a runner, the labeled path admits ONLY the
    // arming labels.
    assertLabelGate(TEMPLATE, 'workflows/ai-teammate.yml.template');
});

// ── repo contract: gh-1076 — the stub fires on assigned ONLY ────────────────
//
// Live 2026-10-19 (#1074): ONE owner assign spawned THREE runs — the
// `assigned` event plus two `labeled` events from the factory bot's OWN
// consequence labels (status:* as the dev leg started). gh-1065 dedup
// made the duplicates self-skip, but every labeled event still started a
// run: it occupied the concurrency group, spammed the run list and cost
// a probe. GitHub cannot filter label names in `on:`, and a job-level
// `if:` still starts and LISTS the run (the owner's explicit complaint),
// so the labeled trigger is gone entirely — the stub's `issues` trigger
// fires on `assigned` ONLY. Arming-label (agent:*) pickup continues
// through the SM tick's workflow_dispatch path (gh-1028 dedup), which is
// already the governed lane. AC4 stays: `assigned` fires instantly and
// manual workflow_dispatch is untouched.

suite('workflow contract — ai-teammate assigned-only triggers (gh-1076)', function () {

    test('stub issues trigger fires on assigned ONLY (AC1)', function () {
        assert.deepEqual(lint.extractIssueTypes(STUB), ['assigned'],
            'stub on.issues.types drifted — gh-1076: the labeled trigger re-fired the ' +
            'workflow on the factory\'s own consequence labels (live #1074: 3 runs for ' +
            'one assign). Arming-label pickup is the SM tick\'s dispatch lane. Found: ' +
            JSON.stringify(lint.extractIssueTypes(STUB)));
    });

    test('stub gates carry NO labeled branch — a labeled event cannot reach a job (AC2/AC3)', function () {
        var blocks = foldedIfBlocks(STUB);
        assert.ok(blocks.length >= 2, 'expected the dedup + teammate folded gates');
        for (var i = 0; i < blocks.length; i++) {
            assert.ok(blocks[i].indexOf("github.event.action == 'labeled'") === -1 &&
                blocks[i].indexOf('github.event.label.name') === -1,
                'stub gate ' + (i + 1) + ' still keys the labeled action — gh-1076 made it ' +
                'unreachable; the byte-level guarantee AC3 wants is that no labeled branch ' +
                'exists anywhere in the stub gates. Gate: ' + blocks[i]);
        }
    });

    test('stub assigned gate still requires the ai-teammate assignee', function () {
        var ifExpr = extractJobIf(STUB);
        assert.ok(ifExpr.indexOf("github.event.action == 'assigned'") !== -1,
            'stub gate must key the assignee check to action == assigned');
        assert.ok(ifExpr.indexOf("contains(github.event.issue.assignees.*.login, 'ai-teammate')") !== -1,
            'stub assigned gate must require the ai-teammate assignee — a bare assigned ' +
            'event on any issue would otherwise allocate a runner');
    });

    test('stub keeps the workflow_dispatch entry path (AC4)', function () {
        assert.ok(extractJobIf(STUB).indexOf("github.event_name == 'workflow_dispatch'") !== -1,
            'dropping the dispatch path silently kills the SM reconciler loop');
    });
});

// ── repo contract: gh-1075 — the stub run-name carries the pr anchor ────────
//
// gh-1075 review round 2 (IMPORTANT): the SM's pull-keyed leg probe
// (branchLegGuard.hasActiveLegRunForPull) suppresses a second rework arm
// on the same fork PR via the whole-token 'pr-<N>' run-title anchor. The
// TEMPLATE run-name always rendered it, but the self-host stub (this
// file) echoed inputs.issue only — so on the live-incident repo (fa
// pr-1591's home) the gate was blind exactly where it matters. The stub
// now renders ' · pr-<N>' right after the issue slot, and this contract
// keeps the two run-name dialects from drifting apart again (the way
// this file guards the trigger/dedup invariants). The anchor sits
// BEFORE the trailing leg token ON PURPOSE: stubTailLegOf (the
// 'teammate:' family of legOfRunName, js/common/teammateEventDedup.js)
// parses the leg at the END of the title — appending after the leg
// would blind the gh-1065 completed-owner leg precision.

// The stub's single-line double-quoted run-name value ('' when absent).
function stubRunNameOf(yml) {
    var m = /^\s*run-name:\s*"(.*)"\s*$/m.exec(yml);
    return m ? m[1] : '';
}

suite('workflow contract — stub run-name carries the gh-1075 pr anchor', function () {

    test('the stub run-name renders · pr-<N> whenever inputs.pr is set', function () {
        var rn = stubRunNameOf(STUB);
        assert.ok(rn.indexOf('github.event.inputs.pr') !== -1,
            'stub run-name never reads inputs.pr — a PR-anchored fork leg (gh-1075 always ' +
            'backfills inputs.pr) would run untitled and the SM pull-keyed leg probe would ' +
            'never suppress the second rework arm (live fa pr-1591 incident class)');
        assert.ok(rn.indexOf('pr-{0}') !== -1,
            'stub run-name must render the whole-token pr anchor (format(...pr-{0}...)) — ' +
            'titleHasPrToken (js/common/branchLegGuard.js) keys on it');
        assert.ok(rn.indexOf("(github.event.inputs.pr || '') != ''") !== -1,
            'the pr anchor must be guarded — github.event.inputs is null on issues events, ' +
            'and an unguarded render would print a stray pr- token on ordinary issue runs ' +
            '(the template run-name documents the same null != \'\' trap)');
    });

    test('the leg token stays TRAILING — stubTailLegOf must keep parsing it', function () {
        var rn = stubRunNameOf(STUB);
        var lastExpr = rn.lastIndexOf('${');
        assert.ok(lastExpr !== -1 && rn.indexOf('github.event.inputs.leg', lastExpr) !== -1,
            'the LAST ${{ }} expression of the stub run-name must derive the LEG — ' +
            'stubTailLegOf (/\\s(dev|review|rework)$/) parses the title tail, and the ' +
            'gh-1065 completed-owner leg rule depends on it');
        assert.ok(rn.indexOf('github.event.inputs.pr') < lastExpr,
            'the pr anchor sits BEFORE the leg token — appending it after the leg would ' +
            'blind legOfRunName exactly when the gh-1075 fork gate needs both');
    });

    test('a rendered fork-leg title keeps legOfRunName AND the pr anchor working end-to-end', function () {
        var dedup = loadModule('js/common/teammateEventDedup.js');
        var guard = loadModule('js/common/branchLegGuard.js');
        // The rendered shapes the new run-name produces:
        var forkTitle = 'teammate: workflow_dispatch # · pr-1591 rework';
        var issueTitle = 'teammate: assigned #1040 rework';
        assert.equal(dedup.legOfRunName(forkTitle), 'rework',
            'legOfRunName still resolves the leg on a pr-anchored fork title');
        assert.equal(dedup.legOfRunName(issueTitle), 'rework',
            'legOfRunName still resolves the leg on an ordinary issue title');
        assert.ok(guard.titleHasPrToken(forkTitle, 1591),
            'titleHasPrToken sees the anchor on the rendered fork title');
        assert.ok(!guard.titleHasPrToken(forkTitle, 2000),
            'a different PR number does not match');
    });
});

