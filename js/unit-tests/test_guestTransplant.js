/**
 * Unit tests for js/common/guestTransplant.js (gh-1140).
 *
 * Guest fork-PR transplant — the pure half of the `po_accept` rule:
 *   - resolveGuestTransplantConfig: the knob is INERT unless the project
 *     configures smGuestTransplant (REG-guest113: the gh-113 manual-arm
 *     lane must behave unchanged on repos without the label configured).
 *   - transplantSequence: the one decision core behind the
 *     `transplant_guest_pr` localAction — eligibility (AC1), machine-
 *     actor refusal (AC5), double-arm no-op (AC5), closed-source skip
 *     (AC5), same-repo no-op (E3), arm-time SHA pinning (E1), orphan
 *     branch completion (E5), conflict/no-ref parks (AC4), the #633
 *     head-change park reset (AC4).
 *   - carryDecision / diffFingerprint: verdict carry iff the transplanted
 *     diff is byte-identical to the reviewed source diff (AC6).
 *   - validateGateWiring / guestValidationDispatchPlan: the Security
 *     Gate phase — every secret-consuming job transitively `needs` a
 *     gate job, gate jobs serialize ahead of secret jobs (AC3, UT-gate).
 *   - command builders: the whole gh-API transport surface, byte-pinned
 *     (the SM never dispatches CI on a fork ref — nothing here targets
 *     a fork-owned ref, by construction).
 *
 * R5 discipline: every collection path carries a 2+ item case.
 *
 * Pure functions, no tool globals — loadModule with makeRequire({}).
 */

var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
var mod = loadModule('js/common/guestTransplant.js',
    makeRequire({ './machineAuthor.js': machineAuthor }), {});

var SHA_A = 'aaa00000000000000000000000000000000000aa';
var SHA_B = 'bbb00000000000000000000000000000000000bb';
var SHA_C = 'ccc00000000000000000000000000000000000cc';

function baseCfg(overrides) {
    var cfg = mod.resolveGuestTransplantConfig({}, { smGuestTransplant: {} });
    if (overrides) {
        for (var k in overrides) cfg[k] = overrides[k];
    }
    return cfg;
}

function baseSource(overrides) {
    var s = {
        prNumber: 42,
        title: 'Fix the widget',
        author: 'extcontributor',
        labels: ['po_accept'],
        headRepo: 'extcontributor/widget-fork',
        draft: false,
        state: 'OPEN'
    };
    if (overrides) {
        for (var k in overrides) s[k] = overrides[k];
    }
    return s;
}

function baseInput(overrides) {
    var input = {
        cfg: baseCfg(),
        base: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
        source: baseSource(),
        headSha: SHA_A,
        armEvent: { login: 'productowner' },
        machineLogins: ['ai-bot[bot]'],
        marker: null,
        branchExists: false,
        openTransplantPr: null
    };
    if (overrides) {
        for (var k in overrides) input[k] = overrides[k];
    }
    return input;
}

function stepsOf(op, seq) {
    var out = [];
    (seq.steps || []).forEach(function (s) { if (s.op === op) out.push(s); });
    return out;
}

suite('guestTransplant: config resolution (inert by default, REG-guest113)', function () {

    test('no smGuestTransplant section — the knob resolves to null (rule inert)', function () {
        assert.equal(mod.resolveGuestTransplantConfig({}, {}), null);
        assert.equal(mod.resolveGuestTransplantConfig({}, null), null);
        assert.equal(mod.resolveGuestTransplantConfig(null, null), null);
    });

    test('explicit enabled:false keeps the rule inert', function () {
        assert.equal(mod.resolveGuestTransplantConfig(
            {}, { smGuestTransplant: { enabled: false, label: 'po_accept' } }), null);
    });

    test('configured section normalizes with the shipped defaults', function () {
        var cfg = mod.resolveGuestTransplantConfig({}, { smGuestTransplant: {} });
        assert.notEqual(cfg, null);
        assert.equal(cfg.label, 'po_accept', 'shipped label default');
        assert.equal(cfg.parkedLabel, 'blocked');
        assert.equal(cfg.branchPrefix, 'ai/guest-');
        assert.equal(cfg.baseBranch, 'main');
        assert.deepEqual(cfg.carryLabels, ['ai_pr_reviewed', 'pr_approved'], 'AC6 carry labels');
        assert.equal(cfg.titleMaxLen, 80);
        assert.deepEqual(cfg.gate.gateJobs, ['security-gate']);
        assert.deepEqual(cfg.gate.secretJobs, ['validate']);
    });

    test('every knob is overridable; a custom label wins over the default', function () {
        var cfg = mod.resolveGuestTransplantConfig({}, {
            smGuestTransplant: {
                label: 'guest_accept',
                parkedLabel: 'guest_parked',
                branchPrefix: 'ai/xfer-',
                baseBranch: 'develop',
                carryLabels: ['pr_approved'],
                titleMaxLen: 40,
                gate: { gateJobs: ['sec-scan', 'secret-scan'], secretJobs: ['ci-validate'] }
            }
        });
        assert.equal(cfg.label, 'guest_accept');
        assert.equal(cfg.parkedLabel, 'guest_parked');
        assert.equal(cfg.branchPrefix, 'ai/xfer-');
        assert.equal(cfg.baseBranch, 'develop');
        assert.deepEqual(cfg.carryLabels, ['pr_approved']);
        assert.equal(cfg.titleMaxLen, 40);
        assert.deepEqual(cfg.gate.gateJobs, ['sec-scan', 'secret-scan']);
        assert.deepEqual(cfg.gate.secretJobs, ['ci-validate']);
    });

    test('jobParams section wins when the project config carries none (sm-style priority)', function () {
        var cfg = mod.resolveGuestTransplantConfig(
            { smGuestTransplant: { label: 'from_jobparams' } }, {});
        assert.equal(cfg.label, 'from_jobparams');
    });

    test('the PROJECT config section wins when jobParams carries one too (thread 7: pinned precedence)', function () {
        var cfg = mod.resolveGuestTransplantConfig(
            { smGuestTransplant: { label: 'from_jobparams' } },
            { smGuestTransplant: { label: 'from_project' } });
        assert.equal(cfg.label, 'from_project',
            'project config overrides jobParams — resolveMachineSmConfig precedence');
    });
});

suite('guestTransplant: predicates and sanitizers', function () {

    test('isCrossRepoHead: cross-repo true, same-repo/null/garbage false (fail closed)', function () {
        assert.equal(mod.isCrossRepoHead('extcontributor/widget-fork', 'acme', 'widget'), true);
        assert.equal(mod.isCrossRepoHead('acme/widget', 'acme', 'widget'), false, 'same repo');
        assert.equal(mod.isCrossRepoHead(null, 'acme', 'widget'), false, 'deleted fork');
        assert.equal(mod.isCrossRepoHead('', 'acme', 'widget'), false);
        assert.equal(mod.isCrossRepoHead('noslash', 'acme', 'widget'), false);
        assert.equal(mod.isCrossRepoHead('a/b/c', 'acme', 'widget'), false);
    });

    test('sanitizeGuestTitle strips newline smuggling and caps length (threat model)', function () {
        assert.equal(mod.sanitizeGuestTitle('Fix the widget', 80), 'Fix the widget');
        assert.equal(mod.sanitizeGuestTitle('evil\nrm -rf /\npayload', 80), 'evil rm -rf / payload',
            'newlines collapse — no command smuggling');
        assert.equal(mod.sanitizeGuestTitle('x'.repeat(200), 80).length, 80, 'length cap');
        assert.equal(mod.sanitizeGuestTitle('  spaced\ttitle  ', 80), 'spaced title');
        assert.equal(mod.sanitizeGuestTitle('', 80), '');
        assert.equal(mod.sanitizeGuestTitle(null, 80), '');
    });

    test('sanitizeCoAuthor neutralizes control chars and angle brackets', function () {
        assert.equal(mod.sanitizeCoAuthor('Ada Lovelace', 'ada'),
            'Ada Lovelace <ada@users.noreply.github.com>');
        assert.equal(mod.sanitizeCoAuthor('Bad <name>\r\ninjected', 'ada'),
            'Bad name injected <ada@users.noreply.github.com>');
        assert.equal(mod.sanitizeCoAuthor('', 'ada'),
            'guest <ada@users.noreply.github.com>', 'empty name falls back');
        assert.equal(mod.sanitizeCoAuthor('Ada', 'ada[bot]'),
            'Ada <ada[bot]@users.noreply.github.com>');
    });

    test('sanitizeCoAuthor truncates a 60+ char name; an empty login falls back to guest', function () {
        var longName = 'N'.repeat(80);
        var co = mod.sanitizeCoAuthor(longName, 'extc');
        assert.ok(co.indexOf('N'.repeat(60) + ' <extc@') === 0,
            'the name is truncated to 60 chars, the login survives');
        assert.equal(mod.sanitizeCoAuthor('Guest Author', ''),
            'Guest Author <guest@users.noreply.github.com>', 'empty login falls back');
        assert.equal(mod.sanitizeCoAuthor('Guest Author', null),
            'Guest Author <guest@users.noreply.github.com>', 'null login falls back too');
    });

    test('guestPrTitle: prefix + sanitized source title, capped as a whole', function () {
        assert.equal(mod.guestPrTitle(baseCfg(), 42, 'Fix the widget'), '[guest #42] Fix the widget');
        assert.equal(mod.guestPrTitle(baseCfg(), 7, 'a'.repeat(200)).length, 80);
        assert.equal(mod.guestPrTitle(baseCfg(), 7, ''), '[guest #7] guest change', 'empty title fallback');
    });

    test('transplantBranchName / parseGuestBranch roundtrip, garbage tolerated', function () {
        assert.equal(mod.transplantBranchName('ai/guest-', 42), 'ai/guest-42');
        assert.equal(mod.parseGuestBranch('ai/guest-42', 'ai/guest-'), 42);
        assert.equal(mod.parseGuestBranch('ai/gh-42', 'ai/guest-'), null);
        assert.equal(mod.parseGuestBranch('ai/guest-x', 'ai/guest-'), null);
        assert.equal(mod.parseGuestBranch('', 'ai/guest-'), null);
    });
});

suite('guestTransplant: marker build/parse (snapshot semantics, E1/E5)', function () {

    test('armed marker builds and parses back; newest wins on a comment feed', function () {
        var c = mod.transplantMarkerComment({
            state: 'armed', source: 42, head: SHA_A, branch: 'ai/guest-42'
        });
        assert.ok(c.indexOf('guest-transplant') !== -1);
        var parsed = mod.parseTransplantMarker([{ body: 'noise' }, { body: c }]);
        assert.notEqual(parsed, null);
        assert.equal(parsed.state, 'armed');
        assert.equal(parsed.source, 42);
        assert.equal(parsed.head, SHA_A);
        assert.equal(parsed.branch, 'ai/guest-42');
    });

    test('parked marker carries the reason; transplanted marker carries both PRs', function () {
        var parked = mod.parseTransplantMarker([{ body: mod.transplantMarkerComment({
            state: 'parked', source: 42, head: SHA_A, branch: 'ai/guest-42', reason: 'conflict'
        }) }]);
        assert.equal(parked.state, 'parked');
        assert.equal(parked.reason, 'conflict');

        var done = mod.parseTransplantMarker([{ body: mod.transplantMarkerComment({
            state: 'transplanted', source: 42, head: SHA_A, branch: 'ai/guest-42',
            transplant: 99, merged: SHA_B
        }) }]);
        assert.equal(done.state, 'transplanted');
        assert.equal(done.transplant, 99);
        assert.equal(done.merged, SHA_B);
    });

    test('no marker anywhere — null (fail closed)', function () {
        assert.equal(mod.parseTransplantMarker([]), null);
        assert.equal(mod.parseTransplantMarker(null), null);
        assert.equal(mod.parseTransplantMarker([{ body: 'plain talk' }]), null);
    });

    test('a marker comment WITHOUT a state is skipped; a later valid marker still wins', function () {
        var stateless = '<!-- guest-transplant source="42" head="nope" --> half a marker';
        var valid = mod.transplantMarkerComment({
            state: 'armed', source: 43, head: SHA_B, branch: 'ai/guest-43'
        });
        var parsed = mod.parseTransplantMarker([{ body: stateless }, { body: valid }]);
        assert.notEqual(parsed, null, 'the valid marker is found');
        assert.equal(parsed.state, 'armed');
        assert.equal(parsed.source, 43);
        assert.equal(parsed.head, SHA_B);
        var onlyStateless = mod.parseTransplantMarker([{ body: stateless }]);
        assert.equal(onlyStateless, null, 'a stateless marker parses to null (fail closed)');
    });

    test('resolveTransplantSha: the RECORDED arm sha wins over a moved head (E1, no TOCTOU)', function () {
        var marker = { state: 'armed', head: SHA_B };
        var r = mod.resolveTransplantSha(marker, SHA_C);
        assert.equal(r.sha, SHA_B, 'recorded-at-arm-time sha');
        assert.equal(r.drifted, true, 'force-push between arm and tick is visible');

        var r2 = mod.resolveTransplantSha(marker, SHA_B);
        assert.equal(r2.drifted, false);

        var r3 = mod.resolveTransplantSha(null, SHA_A);
        assert.equal(r3.sha, SHA_A);
        assert.equal(r3.drifted, false);

        assert.equal(mod.resolveTransplantSha(null, null), null, 'no sha — no transplant');
        assert.equal(mod.resolveTransplantSha({ state: 'armed' }, null), null);
    });
});

suite('guestTransplant: transplantSequence — eligibility and refusals (UT-plan)', function () {

    test('AC5: machine-actor arm is refused — audit only, zero steps', function () {
        var seq = mod.transplantSequence(baseInput({ armEvent: { login: 'ai-bot[bot]' } }));
        assert.equal(seq.decision, 'refuse');
        assert.equal(seq.steps.length, 0, 'no action');
        assert.ok(seq.audit.indexOf('machine') !== -1);
    });

    test('security: an UNVERIFIABLE actor (no labeled event) refuses too — the label is the voucher', function () {
        var seq = mod.transplantSequence(baseInput({ armEvent: null }));
        assert.equal(seq.decision, 'refuse');
        assert.equal(seq.steps.length, 0);
    });

    test('AC5: a source closed by hand before the tick is skipped', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ state: 'CLOSED' })
        }));
        assert.equal(seq.decision, 'skip');
        assert.equal(seq.reason, 'source-closed');
        assert.equal(seq.steps.length, 0);
    });

    test('E3: a SAME-repo PR with the label is a no-op + audit (transplant is cross-repo only)', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ headRepo: 'acme/widget' })
        }));
        assert.equal(seq.decision, 'skip');
        assert.equal(seq.reason, 'same-repo');
        assert.equal(seq.steps.length, 0);
    });

    test('deleted fork (headRepo null) reads same-repo — fail closed', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ headRepo: null })
        }));
        assert.equal(seq.decision, 'skip');
        assert.equal(seq.reason, 'same-repo');
    });

    test('AC5: a second arm while a transplant is open is a no-op (snapshot semantics)', function () {
        var seq = mod.transplantSequence(baseInput({
            openTransplantPr: { number: 99 }
        }));
        assert.equal(seq.decision, 'noop');
        assert.equal(seq.reason, 'already-transplanted');
        assert.equal(seq.steps.length, 0);
    });

    test('a transplanted marker on a still-open source skips too', function () {
        var seq = mod.transplantSequence(baseInput({
            marker: { state: 'transplanted', source: 42, head: SHA_A }
        }));
        assert.equal(seq.decision, 'noop');
        assert.equal(seq.reason, 'already-transplanted');
    });

    test('the rule label must actually be present — not-armed sources never act', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ labels: [] })
        }));
        assert.equal(seq.decision, 'skip');
        assert.equal(seq.reason, 'not-armed');
    });
});

suite('guestTransplant: transplantSequence — the happy path (AC1)', function () {

    test('fresh arm: marker → ref at main → API merge → machine PR → carry probe → close+comment', function () {
        var seq = mod.transplantSequence(baseInput({}));
        assert.equal(seq.decision, 'transplant');

        var ops = seq.steps.map(function (s) { return s.op; });
        assert.deepEqual(ops, [
            'comment', 'create_ref', 'merge', 'open_pr', 'carry_decision',
            'transplant_comment', 'close_pr'
        ]);

        var marker = stepsOf('comment', seq)[0];
        assert.equal(marker.prNumber, 42);
        assert.ok(marker.text.indexOf(SHA_A) !== -1, 'marker records the arm-time sha');
        assert.ok(marker.text.indexOf('ai/guest-42') !== -1);

        var openPr = stepsOf('open_pr', seq)[0];
        assert.equal(openPr.branch, 'ai/guest-42');
        assert.equal(openPr.baseBranch, 'main');
        assert.equal(openPr.title, '[guest #42] Fix the widget', 'AC1 title shape');
        assert.ok(openPr.body.indexOf('acme/widget#42') !== -1, 'body links the source');
        assert.ok(openPr.body.indexOf('Co-authored-by:') !== -1, 'AC1 co-author trailer');
        assert.ok(openPr.body.indexOf('extcontributor@users.noreply.github.com') !== -1,
            'the machine PR credits the guest PR author');

        assert.equal(stepsOf('close_pr', seq)[0].prNumber, 42, 'AC1: the source closes');
    });

    test('E1: a force-pushed source transplants the RECORDED sha, and the marker step is not re-posted', function () {
        var seq = mod.transplantSequence(baseInput({
            headSha: SHA_C,
            marker: { state: 'armed', source: 42, head: SHA_B, branch: 'ai/guest-42' }
        }));
        assert.equal(seq.decision, 'transplant');
        assert.equal(stepsOf('comment', seq).length, 0, 'marker already recorded — no duplicate');
        var merge = stepsOf('merge', seq)[0];
        assert.equal(merge.headSha, SHA_B, 'the arm-time sha, not the moved head');
    });

    test('AC6: carry labels attach to the new PR only on the identical-diff branch (decision function)', function () {
        var same = 'diff --git a/f.js b/f.js\nindex aa..bb 100644\n--- a/f.js\n+++ b/f.js\n@@ -1 +1 @@\n-x\n+y\n';
        var carry = mod.carryDecision(same, same, baseCfg());
        assert.equal(carry.carry, true);
        assert.deepEqual(carry.labels, ['ai_pr_reviewed', 'pr_approved']);

        var drifted = mod.carryDecision(same, same.replace('+y', '+changed'), baseCfg());
        assert.equal(drifted.carry, false);
        assert.deepEqual(drifted.labels, [], 'label-free fresh pipeline');
        assert.equal(drifted.reason, 'diff-drifted');
    });

    test('AC6: degraded diff reads fail CLOSED to a fresh pipeline, never a carry', function () {
        assert.equal(mod.carryDecision(null, 'x', baseCfg()).carry, false);
        assert.equal(mod.carryDecision('x', null, baseCfg()).carry, false);
        assert.equal(mod.carryDecision('', 'x', baseCfg()).carry, false);
        assert.equal(mod.carryDecision(null, 'x', baseCfg()).reason, 'source-diff-unavailable');
    });

    test('AC6: multi-file identical diffs carry; a one-file subset does not (2+ item case)', function () {
        var two = 'diff --git a/f.js b/f.js\n@@ -1 +1 @@\n-a\n+b\n' +
                  'diff --git a/g.js b/g.js\n@@ -1 +1 @@\n-c\n+d\n';
        assert.equal(mod.carryDecision(two, two, baseCfg()).carry, true);
        assert.equal(mod.carryDecision(two, two.split('diff --git a/g.js b/g.js')[0]).carry, false,
            'a partial diff is a drift');
    });

    test('diffFingerprint normalizes CRLF and trailing-newline variance only', function () {
        var d = 'a\r\nb';
        assert.equal(mod.diffFingerprint(d), 'a\nb\n');
        assert.equal(mod.diffFingerprint('a\nb\n\n'), 'a\nb\n');
        assert.equal(mod.diffFingerprint(null), null);
        assert.equal(mod.diffFingerprint(''), null);
        assert.equal(mod.diffFingerprint({ junk: true }), null, 'non-text payloads are unusable');
    });
});

suite('guestTransplant: parks and resets (AC4)', function () {

    test('conflict 409 at merge time parks the source with the distinct reason and NO branch/PR steps', function () {
        var steps = mod.parkSteps('conflict', {
            cfg: baseCfg(), source: baseSource(), headSha: SHA_A, mergedSha: null
        });
        var ops = steps.map(function (s) { return s.op; });
        assert.deepEqual(ops, ['add_label', 'comment']);
        assert.equal(steps[0].label, 'blocked');
        assert.ok(steps[1].text.indexOf('conflict') !== -1, 'distinct-reason comment');
        assert.ok(steps[1].text.indexOf('parked-head: ' + SHA_A) !== -1, '#633 reset marker');
    });

    test('no-ref park names its own reason (deleted branch before the tick)', function () {
        var steps = mod.parkSteps('no-ref', {
            cfg: baseCfg(), source: baseSource(), headSha: null, mergedSha: null
        });
        assert.ok(steps[1].text.indexOf('no-ref') !== -1 || steps[1].text.indexOf('no ref') !== -1,
            'distinct reason');
        assert.ok(steps[1].text.indexOf('parked-head:') === -1, 'no sha to pin');
    });

    test('AC4: a parked source with a NEW human head re-arms — label off, transplant proceeds', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ labels: ['po_accept', 'blocked'] }),
            marker: { state: 'parked', source: 42, head: SHA_A, branch: 'ai/guest-42', reason: 'conflict' },
            headSha: SHA_B
        }));
        assert.equal(seq.decision, 'transplant');
        var unl = stepsOf('remove_label', seq);
        assert.equal(unl.length, 1);
        assert.equal(unl[0].label, 'blocked');
        assert.equal(stepsOf('create_ref', seq).length, 1, 'the transplant itself proceeds');
    });

    test('AC4: a parked source with an UNCHANGED head stays parked', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ labels: ['po_accept', 'blocked'] }),
            marker: { state: 'parked', source: 42, head: SHA_A, branch: 'ai/guest-42', reason: 'conflict' },
            headSha: SHA_A
        }));
        assert.equal(seq.decision, 'noop');
        assert.equal(seq.reason, 'parked-head-unchanged');
        assert.equal(seq.steps.length, 0);
    });

    test('a `blocked` label WITHOUT our park marker is a human hold — never touched', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ labels: ['po_accept', 'blocked'] }),
            headSha: SHA_B
        }));
        assert.equal(seq.decision, 'skip');
        assert.equal(seq.reason, 'human-blocked');
        assert.equal(seq.steps.length, 0);
    });

    test('a no-sha armed source parks with the no-ref reason (AC4 fallback)', function () {
        var seq = mod.transplantSequence(baseInput({ headSha: null }));
        assert.equal(seq.decision, 'park');
        assert.equal(seq.reason, 'no-ref');
        var ops = seq.steps.map(function (s) { return s.op; });
        assert.deepEqual(ops, ['add_label', 'comment']);
    });
});

suite('guestTransplant: orphan branch recovery (E5)', function () {

    test('branch exists + armed marker + no transplant PR → complete: merge, open PR, carry, close', function () {
        var seq = mod.transplantSequence(baseInput({
            marker: { state: 'armed', source: 42, head: SHA_A, branch: 'ai/guest-42' },
            branchExists: true
        }));
        assert.equal(seq.decision, 'complete-orphan');
        var ops = seq.steps.map(function (s) { return s.op; });
        assert.deepEqual(ops, ['merge', 'open_pr', 'carry_decision', 'transplant_comment', 'close_pr'],
            'no create_ref, no duplicate marker');
        assert.equal(stepsOf('merge', seq)[0].headSha, SHA_A);
    });

    test('branch exists with NO marker and no PR → GC it (unrecoverable orphan)', function () {
        var seq = mod.transplantSequence(baseInput({ branchExists: true }));
        assert.equal(seq.decision, 'gc-orphan');
        assert.deepEqual(seq.steps.map(function (s) { return s.op; }), ['delete_ref']);
        assert.equal(seq.steps[0].branch, 'ai/guest-42');
    });
});

suite('guestTransplant: branch GC sweep (AC7)', function () {

    test('a transplant PR in ANY closed state deletes its branch; an OPEN one is left alone', function () {
        var steps = mod.gcSteps([
            { branch: 'ai/guest-1', prState: 'MERGED' },
            { branch: 'ai/guest-2', prState: 'CLOSED' },
            { branch: 'ai/guest-3', prState: 'OPEN' }
        ]);
        assert.deepEqual(steps.map(function (s) { return s.branch; }), ['ai/guest-1', 'ai/guest-2'],
            'merged AND closed both GC; open survives');
    });

    test('a guest branch with NO PR and no marker is a dead orphan — GC; with an armed marker it completes', function () {
        var steps = mod.gcSteps([
            { branch: 'ai/guest-4', prState: null, marker: null },
            { branch: 'ai/guest-5', prState: null, marker: { state: 'armed', source: 5, head: SHA_A } }
        ]);
        assert.equal(steps[0].op, 'delete_ref');
        assert.equal(steps[1].op, 'complete_orphan');
        assert.equal(steps[1].branch, 'ai/guest-5');
        assert.equal(steps[1].headSha, SHA_A);
    });

    test('garbage sweep input degrades to no steps', function () {
        assert.deepEqual(mod.gcSteps(null), []);
        assert.deepEqual(mod.gcSteps([]), []);
        assert.deepEqual(mod.gcSteps([{ branch: null }]), []);
    });
});

suite('guestTransplant: Security Gate wiring (AC3, UT-gate)', function () {

    var GATE = { gateJobs: ['security-gate'], secretJobs: ['validate', 'deploy'] };

    test('a wired graph passes: every secret job transitively needs the gate job', function () {
        var jobs = [
            { id: 'security-gate', needs: [] },
            { id: 'build', needs: ['security-gate'] },
            { id: 'validate', needs: ['build'] },
            { id: 'deploy', needs: ['security-gate'] }
        ];
        var res = mod.validateGateWiring(jobs, GATE);
        assert.equal(res.ok, true);
        assert.deepEqual(res.violations, []);
    });

    test('a secret job NOT reaching the gate is a violation — direct and transitive shapes (2+)', function () {
        var jobs = [
            { id: 'security-gate', needs: [] },
            { id: 'validate', needs: [] },
            { id: 'deploy', needs: ['validate'] }
        ];
        var res = mod.validateGateWiring(jobs, GATE);
        assert.equal(res.ok, false);
        assert.equal(res.violations.length, 2, 'validate directly and deploy transitively both lack the gate');
        assert.ok(res.violations[0].indexOf('validate') !== -1);
        assert.ok(res.violations[1].indexOf('deploy') !== -1);
    });

    test('a missing gate job or secret job fails the manifest', function () {
        var res = mod.validateGateWiring([{ id: 'validate', needs: [] }], GATE);
        assert.equal(res.ok, false);
        assert.ok(res.violations.join(' ').indexOf('security-gate') !== -1, 'gate job absent');
    });

    test('degenerate inputs fail closed', function () {
        assert.equal(mod.validateGateWiring(null, GATE).ok, false);
        assert.equal(mod.validateGateWiring([], GATE).ok, false);
        assert.equal(mod.validateGateWiring([{ id: 'security-gate', needs: [] }], null).ok, false);
    });

    test('transitivelyNeeds terminates on a needs-cycle (the seen-set guard)', function () {
        var cyclic = { a: { id: 'a', needs: ['b'] }, b: { id: 'b', needs: ['a'] } };
        assert.equal(mod.transitivelyNeeds('a', { z: true }, cyclic, {}), false,
            'a cycle that never reaches the target is false — and terminates');
        assert.equal(mod.transitivelyNeeds('b', { a: true }, cyclic, {}), true,
            'the walk closes through the cycle onto the target');
        assert.equal(mod.transitivelyNeeds('a', { a: true }, cyclic, {}), true,
            'the job itself being a gate job short-circuits');
    });

    test('the serialized dispatch plan puts EVERY gate job ahead of EVERY secret job (byte-scan)', function () {
        var jobs = [
            { id: 'validate', needs: ['build'] },
            { id: 'build', needs: ['security-gate'] },
            { id: 'security-gate', needs: [] },
            { id: 'secret-scan', needs: [] },
            { id: 'deploy', needs: ['security-gate'] }
        ];
        var gate = { gateJobs: ['security-gate', 'secret-scan'], secretJobs: ['validate', 'deploy'] };
        var plan = mod.guestValidationDispatchPlan(jobs, gate, 'ai-teammate.yml');
        assert.equal(plan.ok, true);
        var firstSecret = plan.plan.indexOf('validate');
        var secondSecret = plan.plan.indexOf('deploy');
        var lastGate = Math.max(plan.plan.indexOf('security-gate'), plan.plan.indexOf('secret-scan'));
        assert.ok(lastGate !== -1);
        assert.ok(lastGate < firstSecret && lastGate < secondSecret,
            'plan: ' + plan.plan);
        assert.ok(plan.plan.indexOf('ai-teammate.yml') === 0, 'the plan names the workflow');
    });

    test('an unwired graph produces no plan (ok:false, plan null)', function () {
        var plan = mod.guestValidationDispatchPlan(
            [{ id: 'security-gate', needs: [] }, { id: 'validate', needs: [] }],
            GATE, 'ai-teammate.yml');
        assert.equal(plan.ok, false);
        assert.equal(plan.plan, null);
    });
});

suite('guestTransplant: transport command builders (byte-pinned; no fork ref is ever targeted)', function () {

    test('ref create + API merge target the BASE repo and the transplant branch only', function () {
        assert.equal(
            mod.buildCreateRefCommand('acme', 'widget', 'ai/guest-42', SHA_A),
            'gh api repos/acme/widget/git/refs -X POST -f ref=refs/heads/ai/guest-42 -f sha=' + SHA_A);
        assert.equal(
            mod.buildApiMergeCommand('acme', 'widget', 'ai/guest-42', SHA_A),
            'gh api repos/acme/widget/merges -X POST -f base=ai/guest-42 -f head=' + SHA_A,
            'merges API: base=transplant branch (cut at main), head=the recorded source sha');
    });

    test('PR creation rides a temp payload file; the payload carries title/head/base/body', function () {
        assert.equal(
            mod.buildCreateGuestPrCommand('acme', 'widget', '/tmp/gt-1.json'),
            'gh api repos/acme/widget/pulls -X POST --input /tmp/gt-1.json');
        var payload = JSON.parse(mod.buildGuestPrPayload({
            owner: 'acme', repo: 'widget', branch: 'ai/guest-42', baseBranch: 'main',
            title: '[guest #42] Fix the widget', body: 'body text'
        }));
        assert.equal(payload.title, '[guest #42] Fix the widget');
        assert.equal(payload.head, 'ai/guest-42');
        assert.equal(payload.base, 'main');
        assert.equal(payload.body, 'body text');
    });

    test('guestPrBody names the fork source, the head sha, the gate jobs and the co-author trailer', function () {
        var body = mod.guestPrBody({
            sourceFull: 'extc/fork', sourcePrNumber: 42, sourceTitle: 'Fix the widget',
            sourceAuthor: 'extcontributor', sourceLogin: 'extc', headSha: SHA_A,
            gateJobs: ['security-gate', 'secret-scan']
        });
        assert.ok(body.indexOf('extc/fork#42') !== -1, 'body names source repo#number');
        assert.ok(body.indexOf('Fix the widget') !== -1);
        assert.ok(body.indexOf(SHA_A) !== -1, 'body names the transplanted head');
        assert.ok(body.indexOf('https://github.com/extc/fork/pull/42') !== -1, 'body links the source');
        assert.ok(body.indexOf('security-gate, secret-scan') !== -1, 'the gate manifest travels into the body');
        assert.ok(body.indexOf('Co-authored-by: extcontributor <extc@') !== -1, 'co-author trailer');
    });

    test('guestPrBody: carried verdicts list EVERY label; degenerate opts degrade to the defaults', function () {
        var carried = mod.guestPrBody({
            sourcePrNumber: 7, carriedLabels: ['pr_approved', 'ai_pr_reviewed']
        });
        assert.ok(carried.indexOf('Carried review verdicts: pr_approved, ai_pr_reviewed') !== -1,
            '2+ carried labels join into one line');
        var fresh = mod.guestPrBody(null);
        assert.ok(fresh.indexOf('owner/repo#undefined') !== -1, 'degenerate source degrades');
        assert.ok(fresh.indexOf('`unknown`') !== -1, 'no head sha reads unknown');
        assert.ok(fresh.indexOf('security-gate') !== -1, 'gate jobs default');
        assert.ok(fresh.indexOf('Fresh review + validation') !== -1, 'no carry — fresh pipeline line');
    });

    test('close, delete-ref, main-head probe, branch list and PR-by-head are base-repo commands', function () {
        assert.equal(mod.buildClosePrCommand('acme', 'widget', 42),
            'gh api repos/acme/widget/pulls/42 -X PATCH -f state=closed');
        assert.equal(mod.buildDeleteRefCommand('acme', 'widget', 'ai/guest-42'),
            'gh api repos/acme/widget/git/refs/heads/ai/guest-42 -X DELETE');
        assert.equal(mod.buildMainHeadCommand('acme', 'widget', 'main'),
            'gh api repos/acme/widget/branches/main --jq .commit.sha');
        assert.equal(mod.buildListBranchesCommand('acme', 'widget'),
            'gh api repos/acme/widget/branches --paginate --jq .[].name');
        assert.equal(mod.buildFindPrByHeadCommand('acme', 'widget', 'ai/guest-42'),
            'gh api "repos/acme/widget/pulls?head=acme:ai/guest-42&state=all"');
        assert.equal(mod.buildListLabelEventsCommand('acme', 'widget', 42),
            'gh api repos/acme/widget/issues/42/events --paginate');
    });

    test('parseLabelEvents returns the NEWEST labeled event for the arm label only', function () {
        var raw = JSON.stringify([
            { event: 'labeled', label: { name: 'other' }, actor: { login: 'x' }, created_at: '2026-01-01' },
            { event: 'labeled', label: { name: 'po_accept' }, actor: { login: 'human1' }, created_at: '2026-01-02' },
            { event: 'unlabeled', label: { name: 'po_accept' }, actor: { login: 'human1' }, created_at: '2026-01-03' },
            { event: 'labeled', label: { name: 'po_accept' }, actor: { login: 'human2' }, created_at: '2026-01-04' }
        ]);
        var ev = mod.parseLabelEvents(raw, 'po_accept');
        assert.equal(ev.login, 'human2', 'chronological feed — last match wins');
        assert.equal(ev.createdAt, '2026-01-04');
        assert.equal(mod.parseLabelEvents(raw, 'never'), null);
        assert.equal(mod.parseLabelEvents('not json', 'po_accept'), null);
        assert.equal(mod.parseLabelEvents(null, 'po_accept'), null);
    });

    test('classifyArmActor: machine logins refuse, humans pass, missing proof is unverified', function () {
        var logins = ['ai-bot[bot]', 'merge-bot'];
        assert.equal(mod.classifyArmActor({ login: 'ai-bot' }, logins), 'machine',
            '[bot]-suffix normalized');
        assert.equal(mod.classifyArmActor({ login: 'productowner' }, logins), 'human');
        assert.equal(mod.classifyArmActor(null, logins), 'unverified');
        assert.equal(mod.classifyArmActor({ login: '' }, logins), 'unverified');
    });

    test('parseLabelEvents also accepts an ALREADY-parsed event array (no double-parse)', function () {
        var feed = [{ event: 'labeled', label: 'po_accept', actor: { login: 'human3' } }];
        var ev = mod.parseLabelEvents(feed, 'po_accept');
        assert.equal(ev.login, 'human3', 'plain string label spelling parses too');
    });

    test('classifyArmActor: an EMPTY machine-login allowlist is UNVERIFIED — the arm gate fails closed', function () {
        assert.equal(mod.classifyArmActor({ login: 'whoever' }, []), 'unverified',
            'no allowlist to check against — the one gate that arms foreign code never reads an actor as human');
        assert.equal(mod.classifyArmActor({ login: 'whoever' }, ''), 'unverified',
            'a blank knob reads the same as an empty list');
        assert.equal(mod.classifyArmActor({ login: 'whoever' }, null), 'unverified',
            'an absent knob refuses too');
    });
});

suite('guestTransplant: close comment (AC1 names both SHAs)', function () {

    test('the transplant comment names the source head and the merge result plus the new PR', function () {
        var text = mod.buildTransplantComment({
            sourcePrNumber: 42, sourceSha: SHA_A, mergedSha: SHA_B,
            transplantPrNumber: 99, carriedLabels: ['pr_approved']
        });
        assert.ok(text.indexOf(SHA_A) !== -1);
        assert.ok(text.indexOf(SHA_B) !== -1);
        assert.ok(text.indexOf('#99') !== -1);
        assert.ok(text.indexOf('pr_approved') !== -1);
    });

    test('a fresh (uncarried) transplant says so explicitly', function () {
        var text = mod.buildTransplantComment({
            sourcePrNumber: 42, sourceSha: SHA_A, mergedSha: SHA_B,
            transplantPrNumber: 99, carriedLabels: []
        });
        assert.ok(text.indexOf('fresh') !== -1);
    });
});

// ── Rework round 2 (pr-1142 review threads) ──────────────────────────────
// Thread 1 — the GC sweep's complete_orphan re-entry (completionRentry).
// Thread 2 — resume of a transplant interrupted after open_pr.
// Thread 3 — the empty-allowlist arm gate fails closed.
// Thread 4/5/6 — the pure decisions behind the GC sweep + conflict flag.
suite('guestTransplant: rework round 2 — E5 completion re-entry (thread 1)', function () {

    test('BLOCKING: the sweep re-entry completes an armed-marker orphan despite the null synthetic head', function () {
        // The EXACT sweep re-entry shape (sweepClosedGuestBranches): a
        // synthetic ticket with headRepo null, machineLogins [] and the
        // live armed marker — before the fix this read skip/same-repo.
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ headRepo: null }),
            armEvent: null,
            machineLogins: [],
            marker: { state: 'armed', source: 42, head: SHA_A, branch: 'ai/guest-42' },
            branchExists: true,
            completionRentry: true
        }));
        assert.equal(seq.decision, 'complete-orphan',
            'marker-driven completion bypasses the E3 same-repo refusal');
        assert.deepEqual(seq.steps.map(function (s) { return s.op; }),
            ['merge', 'open_pr', 'carry_decision', 'transplant_comment', 'close_pr']);
        assert.equal(seq.steps[0].headSha, SHA_A, 'the RECORDED arm-time sha merges (E1)');
    });

    test('a re-entry whose marker reached transplanted is still a terminal no-op', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ headRepo: null }),
            armEvent: null,
            machineLogins: [],
            marker: { state: 'transplanted', source: 42, head: SHA_A, branch: 'ai/guest-42' },
            branchExists: true,
            completionRentry: true
        }));
        assert.equal(seq.decision, 'noop');
        assert.equal(seq.reason, 'already-transplanted');
        assert.equal(seq.steps.length, 0);
    });

    test('WITHOUT completionRentry the main path still refuses a null head (E3 untouched)', function () {
        var seq = mod.transplantSequence(baseInput({
            source: baseSource({ headRepo: null }),
            armEvent: { login: 'productowner' },
            branchExists: true
        }));
        assert.equal(seq.decision, 'skip');
        assert.equal(seq.reason, 'same-repo');
    });
});

suite('guestTransplant: rework round 2 — resume after open_pr (thread 2)', function () {

    test('an OPEN machine PR beside an ARMED marker resumes the interrupted tail on the existing PR', function () {
        var seq = mod.transplantSequence(baseInput({
            marker: { state: 'armed', source: 42, head: SHA_A, branch: 'ai/guest-42' },
            branchExists: true,
            openTransplantPr: { number: 99 }
        }));
        assert.equal(seq.decision, 'transplant');
        assert.equal(seq.reason, 'resume-after-open-pr');
        assert.equal(seq.resumePrNumber, 99, 'the wiring seeds the carry probe with the existing PR');
        assert.deepEqual(seq.steps.map(function (s) { return s.op; }),
            ['carry_decision', 'transplant_comment', 'close_pr'],
            'no second merge, no second PR, no duplicate marker');
        assert.equal(stepsOf('close_pr', seq)[0].prNumber, 42, 'the SOURCE still closes');
    });

    test('an OPEN machine PR with NO readable marker stays the conservative no-op (fail closed)', function () {
        var seq = mod.transplantSequence(baseInput({
            openTransplantPr: { number: 99 }
        }));
        assert.equal(seq.decision, 'noop');
        assert.equal(seq.reason, 'already-transplanted');
        assert.equal(seq.resumePrNumber, undefined);
    });

    test('an OPEN machine PR beside a PARKED marker also stays a no-op', function () {
        var seq = mod.transplantSequence(baseInput({
            marker: { state: 'parked', source: 42, head: SHA_A, branch: 'ai/guest-42', reason: 'conflict' },
            openTransplantPr: { number: 99 }
        }));
        assert.equal(seq.decision, 'noop');
        assert.equal(seq.reason, 'already-transplanted');
    });
});

suite('guestTransplant: rework round 2 — fail-closed arm gate (thread 3)', function () {

    test('an unconfigured machineAuthor allowlist REFUSES the arm end-to-end (no auto foreign code)', function () {
        var seq = mod.transplantSequence(baseInput({ machineLogins: [] }));
        assert.equal(seq.decision, 'refuse');
        assert.equal(seq.reason, 'actor-unverified');
        assert.equal(seq.steps.length, 0, 'audit only, no action');
    });

    test('a blank machineLogins knob refuses too', function () {
        var seq = mod.transplantSequence(baseInput({ machineLogins: '' }));
        assert.equal(seq.decision, 'refuse');
        assert.equal(seq.reason, 'actor-unverified');
    });
});

suite('guestTransplant: rework round 2 — GC sweep pure decisions (threads 5/6)', function () {

    test('prStateFromFindList: ANY OPEN entry on the head keeps the branch alive', function () {
        assert.equal(mod.prStateFromFindList(
            [{ state: 'CLOSED' }, { state: 'OPEN' }]), 'OPEN',
            'a closed list[0] beside a live OPEN machine PR must not GC the branch');
        assert.equal(mod.prStateFromFindList([{ state: 'open' }]), 'OPEN', 'case normalized');
    });

    test('prStateFromFindList: all-closed heads fall back to the newest-first first entry', function () {
        assert.equal(mod.prStateFromFindList([{ state: 'MERGED' }, { state: 'CLOSED' }]), 'MERGED');
        assert.equal(mod.prStateFromFindList([{ state: 'CLOSED' }]), 'CLOSED');
    });

    test('prStateFromFindList: no usable entry reads null — the orphan probe runs (fail closed)', function () {
        assert.equal(mod.prStateFromFindList([]), null);
        assert.equal(mod.prStateFromFindList(null), null);
        assert.equal(mod.prStateFromFindList('not a list'), null);
        assert.equal(mod.prStateFromFindList([{}]), null, 'an entry without a state is skipped');
        assert.equal(mod.prStateFromFindList([{ junk: 1 }, { state: 'CLOSED' }]), 'CLOSED',
            'state-less entries do not shadow the first real state');
    });

    test('gcActionableCap / gcScanBudget: the actionable window and the gh-1027 over-scan bound', function () {
        assert.equal(mod.gcActionableCap(undefined), 10, 'shipped default');
        assert.equal(mod.gcActionableCap(0), 10, 'invalid degrades to the default');
        assert.equal(mod.gcActionableCap(-3), 10);
        assert.equal(mod.gcActionableCap(25), 25);
        assert.equal(mod.gcScanBudget(undefined), 25, 'cap + 15 overscan');
        assert.equal(mod.gcScanBudget(25), 40);
    });
});

suite('guestTransplant: rework round 2 — typed merge-conflict marker (thread 4)', function () {

    test('only merge-shaped error messages carry the conflict marker', function () {
        assert.equal(mod.isMergeConflictError(new Error('gh: Merge conflict (HTTP 409)')), true);
        assert.equal(mod.isMergeConflictError(new Error('merge conflict detected')), true,
            'case-insensitive on the body spelling');
        assert.equal(mod.isMergeConflictError(new Error('HTTP 409 Conflict')), true,
            'a bare 409 from the merge transport counts');
        assert.equal(mod.isMergeConflictError(new Error('HTTP 500 server error')), false,
            'an unrelated transport failure never reads as a conflict');
        assert.equal(mod.isMergeConflictError(new Error('boom')), false);
        assert.equal(mod.isMergeConflictError(null), false);
        assert.equal(mod.isMergeConflictError(undefined), false);
        assert.equal(mod.isMergeConflictError('conflict as a string'), true,
            'non-Error throws are read the same way');
    });
});
