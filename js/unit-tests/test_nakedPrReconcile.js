/**
 * Unit tests for js/common/nakedPrReconcile.js (gh-1097).
 *
 * Uses: loadModule(), assert, test(), suite()
 */

function nakedMod() {
    return loadModule('js/common/nakedPrReconcile.js');
}

function nakedPr(n, labels, ref, body) {
    return { number: n, labels: labels.map(function (l) { return { name: l }; }),
        head: { ref: ref, sha: 'h' + n }, body: body || '' };
}

function nakedDeps(issues, sink, dry, comments) {
    return {
        prComments: function (n) { return (comments || {})[n] || []; },
        bodyLinker: function (b) { var m = /closes #(\d+)/i.exec(b || ''); return m ? +m[1] : null; },
        issueLabels: function (n) { return issues[n] || null; },
        isMachine: function (pr) { return pr.head.ref.indexOf('ai/') === 0; },
        addLabel: function (n, l) { sink.labels.push([n, l]); },
        comment: function (n, b) { sink.comments.push([n, b]); },
        log: function (m) { sink.logs.push(m); },
        dry: dry === true
    };
}

suite('nakedPrReconcile predicates (gh-1097 UT-1..3)', function () {
    test('isNakedPr: no lifecycle labels → naked; any lifecycle → not', function () {
        var m = nakedMod();
        assert.equal(m.isNakedPr([]), true);
        assert.equal(m.isNakedPr(['crap:improved']), true);
        assert.equal(m.isNakedPr(['agent:review']), false);
        assert.equal(m.isNakedPr(['x'], ['x']), false);
    });

    test('excluded: blocked/needs-human/validation_failed on PR or issue, human PR', function () {
        var m = nakedMod();
        var machine = { machine: true };
        assert.equal(m.excluded([], ['agent:review'], machine), false);
        assert.equal(m.excluded(['blocked'], [], machine), true);
        assert.equal(m.excluded([], ['needs-human'], machine), true);
        assert.equal(m.excluded(['validation_failed'], [], machine), true);
        assert.equal(m.excluded([], [], { machine: false }), true);
        assert.equal(m.excluded([], [], null), true);
    });

    test('rearmLabelFor mapping table', function () {
        var m = nakedMod();
        assert.equal(m.rearmLabelFor(['agent:review']), 'agent:review');
        assert.equal(m.rearmLabelFor(['status:In Review']), 'agent:review');
        assert.equal(m.rearmLabelFor(['agent:rework']), 'agent:rework');
        assert.equal(m.rearmLabelFor(['status:In Rework']), 'agent:rework');
        assert.equal(m.rearmLabelFor(['status:Done']), null);
        assert.equal(m.rearmLabelFor(null), null);
    });

    test('audit comment carries the stable hidden marker', function () {
        var m = nakedMod();
        var body = m.buildAuditComment(5, 7, 'agent:review', 'abc');
        assert.ok(body.indexOf('<!-- dmtools:naked-pr-rearm {"pr":5,"issue":7,"label":"agent:review","head":"abc"} -->') === 0);
        assert.equal(m.markerHead({ body: body }), 'abc');
        assert.equal(m.markerHead({ body: '<!-- dmtools:naked-pr-rearm {bad} -->' }), null);
        assert.equal(m.markerHead(null), null);
        assert.equal(m.alreadyRearmed([{ body: body }], null), false);
    });

    test('linkedIssueOf: ai/gh-N branch first, then closing keyword', function () {
        var m = nakedMod();
        var linker = nakedDeps({}, {}).bodyLinker;
        assert.equal(m.linkedIssueOf(nakedPr(1, [], 'ai/gh-42'), linker), 42);
        assert.equal(m.linkedIssueOf(nakedPr(1, [], 'feat', 'Closes #9'), linker), 9);
        assert.equal(m.linkedIssueOf({ number: 1, labels: [] }, linker), null);
    });
});

suite('nakedPrReconcile.sweep (gh-1097)', function () {
    var issues = { 1: ['status:In Review'], 2: ['agent:review', 'needs-human'], 3: ['agent:rework'], 4: ['status:Done'] };
    var prs = [
        nakedPr(10, [], 'ai/gh-1'),             // UT-1 armed agent:review
        nakedPr(11, [], 'ai/gh-2'),             // UT-2 needs-human untouched
        nakedPr(12, ['agent:review'], 'ai/gh-1'), // UT-3 labeled untouched
        nakedPr(13, [], 'feature/x', 'Closes #3'), // human-authored excluded
        nakedPr(14, [], 'ai/gh-4'),             // issue not in flow
        nakedPr(15, [], 'ai/gh-99'),            // issue unreadable
        nakedPr(16, [], 'feature/y')            // no linked issue
    ];

    test('only the naked in-flow machine PR is re-armed, one comment', function () {
        var sink = { labels: [], comments: [], logs: [] };
        var plans = nakedMod().sweep(prs, nakedDeps(issues, sink));
        assert.equal(plans.length, 1);
        assert.deepEqual(sink.labels, [[10, 'agent:review']]);
        assert.equal(sink.comments.length, 1);
        assert.equal(sink.comments[0][0], 10);
    });

    test('dry run plans and logs but writes nothing; empty input is a no-op', function () {
        var sink = { labels: [], comments: [], logs: [] };
        var m = nakedMod();
        assert.equal(m.sweep(prs, nakedDeps(issues, sink, true)).length, 1);
        assert.equal(sink.labels.length + sink.comments.length, 0);
        assert.ok(sink.logs[0].indexOf('[DRY]') !== -1);
        assert.equal(m.sweep(null, nakedDeps(issues, sink)).length, 0);
    });

    test('same head already re-armed → untouched; new head → re-armed', function () {
        var m = nakedMod();
        var sink = { labels: [], comments: [], logs: [] };
        var same = { 10: [{ body: m.buildAuditComment(10, 1, 'agent:review', 'h10') }] };
        assert.equal(m.sweep(prs, nakedDeps(issues, sink, false, same)).length, 0);
        assert.equal(sink.labels.length, 0);
        assert.ok(sink.logs[0].indexOf('already re-armed on head h10') !== -1);
        var old = { 10: [{ body: m.buildAuditComment(10, 1, 'agent:review', 'old') }] };
        assert.equal(m.sweep(prs, nakedDeps(issues, sink, false, old)).length, 1);
        assert.deepEqual(sink.labels, [[10, 'agent:review']]);
    });
});

// ── gh-1387 comment-reduction (L2): consume-explained re-arm short tail ────
suite('consume-explained re-arm (gh-1387 L2)', function () {
    var HEAD = '85b6e8d4a2cedad6f9fa8a184d24793d01c129c4';
    function consumeBody(head, path) {
        return '<!-- dmtools:rework-consume ' + JSON.stringify({ path: path || 'cross-anchor', head: head, at: '2026-11-06T07:14:17.465Z' }) +
            ' -->\n🏷️ agent:rework consumed';
    }

    test('consumeMarkerHead parses the head out of gh-840 markers only', function () {
        var m = nakedMod();
        assert.equal(m.consumeMarkerHead({ body: consumeBody(HEAD) }), HEAD);
        assert.equal(m.consumeMarkerHead({ body: '<!-- dmtools:naked-pr-rearm {"head":"' + HEAD + '"} -->' }), null);
        assert.equal(m.consumeMarkerHead({ body: 'no marker' }), null);
        assert.equal(m.consumeMarkerHead({ body: '<!-- dmtools:rework-consume {broken' }), null);
    });

    test('isConsumeExplained: same-head consume marker explains the nakedness', function () {
        var m = nakedMod();
        assert.equal(m.isConsumeExplained([{ body: consumeBody(HEAD) }], HEAD), true);
        assert.equal(m.isConsumeExplained([{ body: consumeBody('4d6053bfd33f56f0471fec8d4210e56a561d4d39') }], HEAD), false,
            'different head is NOT this strip story');
        assert.equal(m.isConsumeExplained([], HEAD), false);
        assert.equal(m.isConsumeExplained([{ body: consumeBody(HEAD) }], null), false);
    });

    test('buildAuditComment: marker identical in both variants; tail differs', function () {
        var m = nakedMod();
        var full = m.buildAuditComment(1387, 1369, 'agent:review', HEAD, false);
        var short = m.buildAuditComment(1387, 1369, 'agent:review', HEAD, true);
        var markerOf = function (b) { return b.split('-->')[0]; };
        assert.equal(markerOf(full), markerOf(short), 'dedup anchor + parser payload byte-identical');
        assert.ok(full.indexOf('Naked-PR reconciliation (gh-1097)') !== -1);
        assert.ok(short.indexOf('Naked-PR reconciliation') === -1, 'no repeated consumption story');
        assert.ok(short.indexOf('gh-840') !== -1 && short.indexOf('re-armed `agent:review`') !== -1);
        var legacy = m.buildAuditComment(1387, 1369, 'agent:review', HEAD);
        assert.equal(legacy, full, '4-arg call keeps the legacy full tail');
    });

    test('applyPlan posts the SHORT body when the comments carry a same-head consume marker', function () {
        var m = nakedMod();
        var sink = { labels: [], comments: [], logs: [] };
        var deps = nakedDeps({ 1369: ['agent:review'] }, sink, false, {
            10: [{ body: consumeBody('h10') }]
        });
        m.sweep([{ number: 10, labels: [], head: { ref: 'ai/gh-1369', sha: 'h10' }, body: 'closes #1369' }], deps);
        assert.equal(sink.comments.length, 1);
        assert.ok(sink.comments[0][1].indexOf('gh-840') !== -1, 'short explained tail used');
        assert.ok(sink.comments[0][1].indexOf('Naked-PR reconciliation') === -1);
    });

    test('applyPlan keeps the full body without a same-head consume marker (direct applyPlan, partial deps)', function () {
        var m = nakedMod();
        var sink = { labels: [], comments: [], logs: [] };
        var deps = nakedDeps({ 1369: ['agent:review'] }, sink, false, {
            10: [{ body: consumeBody('4d6053bfd33f56f0471fec8d4210e56a561d4d39') }]
        });
        m.sweep([{ number: 10, labels: [], head: { ref: 'ai/gh-1369', sha: 'h10' }, body: 'closes #1369' }], deps);
        assert.equal(sink.comments.length, 1);
        assert.ok(sink.comments[0][1].indexOf('Naked-PR reconciliation (gh-1097)') !== -1, 'full tail kept');
        var sink2 = { labels: [], comments: [], logs: [] };
        var partial = nakedDeps({ 1369: ['agent:review'] }, sink2, false);
        delete partial.prComments;
        m.applyPlan({ pr: 10, issue: 1369, label: 'agent:review', head: 'h10' }, partial);
        assert.deepEqual(sink2.labels, [[10, 'agent:review']]);
        assert.ok(sink2.comments[0][1].indexOf('Naked-PR reconciliation (gh-1097)') !== -1,
            'no prComments dep → fail open to the full tail');
    });

    // gh-1392 review thread 4: sweep → notYetRearmed already fetches the PR
    // comments for the same-head dedup, then applyPlan fetched the identical
    // list again for isConsumeExplained — two identical API reads per
    // re-armed PR. The already-read list must be shared (one fetch per plan).
    test('sweep shares ONE prComments fetch per applied plan', function () {
        var m = nakedMod();
        var sink = { labels: [], comments: [], logs: [] };
        var deps = nakedDeps({ 1369: ['agent:review'] }, sink, false, {
            10: [{ body: consumeBody('h10') }]
        });
        var fetches = 0;
        var orig = deps.prComments;
        deps.prComments = function (n) { fetches++; return orig(n); };
        m.sweep([{ number: 10, labels: [], head: { ref: 'ai/gh-1369', sha: 'h10' }, body: 'closes #1369' }], deps);
        assert.equal(sink.comments.length, 1, 'plan still applied');
        assert.ok(sink.comments[0][1].indexOf('gh-840') !== -1, 'explained tail still derived from the same list');
        assert.equal(fetches, 1,
            'two identical API reads per re-arm is the finding — the dedup read and the explained-tail read must share one fetch');
    });
});
