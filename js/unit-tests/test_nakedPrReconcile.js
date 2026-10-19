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
        head: { ref: ref }, body: body || '' };
}

function nakedDeps(issues, sink, dry) {
    return {
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
        var body = nakedMod().buildAuditComment(5, 7, 'agent:review');
        assert.ok(body.indexOf('<!-- dmtools:naked-pr-rearm {"pr":5,"issue":7,"label":"agent:review"} -->') === 0);
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
});
