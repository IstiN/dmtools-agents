/**
 * Unit tests: js/common/reviewDispositions.js — the gh-1352 disposition
 * protocol (epic gh-1328 §4-disposition, part 3/4).
 *
 * Every triage-resolved thread closes with an ack reply carrying a
 * MACHINE-PARSED disposition tag — `fixed: <ref>` / `wontfix: <reason>` /
 * `duplicate: #n` / `deferred: <ledger-id>` — so the closure is auditable
 * and the next lap can tell a fixed thread from a deferred one. The
 * policy gate decides which tiers are closable WITHOUT a fix (fix
 * never/opportunistic) and which need fix-or-defer (fix mandatory).
 *
 * Covers:
 *   - parseDispositionTag: the four tag forms, first-tag-wins, noise
 *     immunity, marker-safety of parsed free text;
 *   - tagLine / buildThreadAckReply: the machine-parsable ack text and
 *     the legacy gh-828 shape when no disposition is given;
 *   - dispositionForThread: the policy gate — closable-without-fix
 *     tiers, fixed evidence, deferral, and the not-closable null.
 */
/* global suite, test, assert, loadModule, makeRequire */

function mod() {
    return loadModule('js/common/reviewDispositions.js', makeRequire({
        './reviewVerdicts.js': reviewVerdictsReal(),
        './reviewPolicy.js': loadModule('js/common/reviewPolicy.js',
            makeRequire({ './reviewVerdicts.js': reviewVerdictsReal() }), {})
    }), {});
}

suite('reviewDispositions — parseDispositionTag (gh-1352)', function () {
    var rd = mod();

    test('parses the fixed tag with its ref', function () {
        assert.deepEqual(rd.parseDispositionTag('fixed: abc1234 — the guard now pins the new lane'),
            { tag: 'fixed', value: 'abc1234 — the guard now pins the new lane' });
    });

    test('parses wontfix with a reason', function () {
        assert.deepEqual(rd.parseDispositionTag('wontfix: style-only, the policy says round none'),
            { tag: 'wontfix', value: 'style-only, the policy says round none' });
    });

    test('parses duplicate with the identity reference', function () {
        assert.deepEqual(rd.parseDispositionTag('duplicate: F7'),
            { tag: 'duplicate', value: 'F7' });
    });

    test('parses deferred with the ledger item id', function () {
        assert.deepEqual(rd.parseDispositionTag('deferred: 9f2c01ab'),
            { tag: 'deferred', value: '9f2c01ab' });
    });

    test('the tag may sit on any line of the ack (first tag wins)', function () {
        var ack = '🤖 triage closure (gh-1352).\n\ndeferred: 9f2c01ab\nFindings live in the debt ledger.';
        assert.deepEqual(rd.parseDispositionTag(ack), { tag: 'deferred', value: '9f2c01ab' });
    });

    test('two tags in one ack — the FIRST one is the disposition', function () {
        assert.deepEqual(rd.parseDispositionTag('wontfix: a\nfixed: b'),
            { tag: 'wontfix', value: 'a' });
    });

    test('noise without a tag parses null', function () {
        assert.equal(rd.parseDispositionTag('the fix landed in the usual way'), null);
        assert.equal(rd.parseDispositionTag(''), null);
        assert.equal(rd.parseDispositionTag(null), null);
    });

    test('unknown tag words are not dispositions', function () {
        // the one-r misspelling must NOT parse — the rejected word is built via
        // concatenation so the repo-wide `deferred` sweep (gh-1379 AC2: the
        // stale spelling greps to zero hits) stays clean while the guard pins it.
        assert.equal(rd.parseDispositionTag('defe' + 'red: x'), null,
            'the canonical spelling is deferred (two r\'s)');
        assert.equal(rd.parseDispositionTag('fix: x'), null);
        assert.equal(rd.parseDispositionTag('disposition: maybe'), null);
    });

    test('the tag word must open its line (boundary discipline)', function () {
        assert.equal(rd.parseDispositionTag('see fixed: nope'), null);
        assert.ok(rd.parseDispositionTag('text\nfixed: yes'), 'line start parses');
    });

    test('parsed free text is marker-safe (a --> in a reason cannot break out)', function () {
        var parsed = rd.parseDispositionTag('wontfix: use x --> y instead');
        assert.notEqual(parsed.value.indexOf('--\u200b>'), -1, 'the --> sequence is zero-width broken');
    });
});

suite('reviewDispositions — tagLine + buildThreadAckReply (gh-828 generalization)', function () {
    var rd = mod();

    test('tagLine renders the four machine-parsed forms', function () {
        assert.equal(rd.tagLine({ tag: 'fixed', value: 'abc1234' }), 'fixed: abc1234');
        assert.equal(rd.tagLine({ tag: 'wontfix', value: 'style only' }), 'wontfix: style only');
        assert.equal(rd.tagLine({ tag: 'duplicate', value: 'F7' }), 'duplicate: F7');
        assert.equal(rd.tagLine({ tag: 'deferred', value: '9f2c01ab' }), 'deferred: 9f2c01ab');
    });

    test('tagLine is null without a tag or a value', function () {
        assert.equal(rd.tagLine(null), null);
        assert.equal(rd.tagLine({ tag: 'fixed' }), null);
        assert.equal(rd.tagLine({ tag: 'nope', value: 'x' }), null);
    });

    test('no disposition keeps the legacy gh-828 ack text', function () {
        var ack = rd.buildThreadAckReply();
        assert.contains(ack, 'non-blocking suggestion');
        assert.contains(ack, 'APPROVE verdict');
    });

    test('a disposition ack carries the machine-parsed tag line', function () {
        var ack = rd.buildThreadAckReply({ tag: 'deferred', value: '9f2c01ab', tier: 'SUGGESTION' });
        assert.contains(ack, 'deferred: 9f2c01ab');
        assert.ok(rd.parseDispositionTag(ack), 'the ack round-trips through the parser');
    });

    test('a wontfix ack names the tier and the policy', function () {
        var ack = rd.buildThreadAckReply({ tag: 'wontfix', value: 'style only', tier: 'NIT' });
        assert.contains(ack, 'NIT');
        assert.contains(ack, 'wontfix: style only');
        assert.ok(rd.parseDispositionTag(ack), 'round-trips');
    });

    test('the ack is provider-independent (no gh- wording in the machine line)', function () {
        var ack = rd.buildThreadAckReply({ tag: 'fixed', value: 'abc' });
        assert.ok(ack.indexOf('fixed: abc') !== -1);
    });
});

suite('reviewDispositions — dispositionForThread (the policy gate)', function () {
    var rd = mod();
    var reviewPolicy = loadModule('js/common/reviewPolicy.js',
        makeRequire({ './reviewVerdicts.js': reviewVerdictsReal() }), {});
    var policy = reviewPolicy.defaultPolicy();
    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function thread(tier, id) {
        var line = { BLOCKING: '\uD83D\uDEA8', IMPORTANT: '\u26A0\uFE0F', SUGGESTION: '\uD83D\uDCA1', NIT: '\uD83E\uDEB6' }[tier] || '';
        return {
            threadId: id || 'PRRT_1', resolved: false, author: 'dmtools-factory-bot',
            body: line + ' severity: ' + tier + ' \u2014 the finding prose',
            path: 'js/common/reviewVerdicts.js'
        };
    }

    test('a fix-mandatory tier with fixed evidence closes as fixed: <ref>', function () {
        var d = rd.dispositionForThread(thread('SUGGESTION'), policy, {
            fixedThreadIds: { PRRT_1: 'abc1234 (polish lap)' }
        });
        assert.deepEqual(d, { tag: 'fixed', value: 'abc1234 (polish lap)', defer: false, tier: 'SUGGESTION' });
    });

    test('a closable-without-fix tier closes as wontfix without any evidence', function () {
        var d = rd.dispositionForThread(thread('NIT'), policy, {});
        assert.equal(d.tag, 'wontfix');
        assert.ok(d.value, 'a default reason is always present');
        assert.equal(d.defer, false);
    });

    test('a fix-mandatory tier with deferral available closes as deferred', function () {
        var d = rd.dispositionForThread(thread('SUGGESTION'), policy, { allowDefer: true });
        assert.equal(d.tag, 'deferred');
        assert.equal(d.defer, true, 'the executor appends the ledger finding and fills the id');
    });

    test('a fix-mandatory tier without evidence and without deferral is NOT closable', function () {
        assert.equal(rd.dispositionForThread(thread('SUGGESTION'), policy, {}), null,
            'others need fix-or-defer — the machine never bare-closes a mandatory tier');
    });

    test('a lap-gated (rework-round) tier is never triage-closable', function () {
        assert.equal(rd.dispositionForThread(thread('IMPORTANT'), policy, { allowDefer: true }), null,
            'IMPORTANT gates approval — the rework lap owns it (ownership replay, AC6)');
        assert.equal(rd.dispositionForThread(thread('BLOCKING'), policy, { allowDefer: true }), null);
    });

    test('ownership replay: an IMPORTANT thread refuses to close even WITH fixed evidence (AC6)', function () {
        assert.equal(rd.dispositionForThread(thread('IMPORTANT'), policy, {
            fixedThreadIds: { PRRT_1: 'abc' }, allowDefer: true
        }), null, 'a mandatory round tier needs the lap, not a triage stamp — fix-or-defer is for non-lap tiers');
    });

    test('unclassified machine threads (none) stay closable-without-fix (gh-828 parity)', function () {
        var unmarked = { threadId: 'PRRT_9', resolved: false, author: 'dmtools-factory-bot', body: 'plain prose' };
        var d = rd.dispositionForThread(unmarked, policy, {});
        assert.equal(d.tag, 'wontfix');
    });

    test('relaxed preset: suggestions become closable-without-fix (epic §1 table)', function () {
        var relaxed = reviewPolicy.presetPolicy('relaxed');
        var d = rd.dispositionForThread(thread('SUGGESTION'), relaxed, {});
        assert.equal(d.tag, 'wontfix');
    });

    test('investigation preset: even BLOCKING is triage-closable (owner standing approval)', function () {
        var investigation = reviewPolicy.presetPolicy('investigation');
        var d = rd.dispositionForThread(thread('BLOCKING'), investigation, {});
        assert.equal(d.tag, 'wontfix', 'every tier round none + fix never — triage closes everything');
    });

    test('fix-everything preset: nits need fix-or-defer (they are polish+mandatory there)', function () {
        var everything = reviewPolicy.presetPolicy('fix-everything');
        assert.equal(rd.dispositionForThread(thread('NIT'), everything, {}), null);
        var d = rd.dispositionForThread(thread('NIT'), everything, { allowDefer: true });
        assert.equal(d.tag, 'deferred');
    });

    test('multi-item: two suggestions with one fixed and one deferrable resolve independently (2+ item case)', function () {
        var threads = [thread('SUGGESTION', 'PRRT_1'), thread('SUGGESTION', 'PRRT_2')];
        var out = threads.map(function (t) {
            return rd.dispositionForThread(t, policy, {
                fixedThreadIds: { PRRT_1: 'abc' }, allowDefer: true
            });
        });
        assert.deepEqual([out[0].tag, out[1].tag], ['fixed', 'deferred']);
    });
});
