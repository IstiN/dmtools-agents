/**
 * Unit tests for js/common/reviewPoolMerge.js — the gh-1406 §5 pool duties
 * at the filter merge point: cross-reviewer dedup (severity escalates
 * only), weighted retention (high-weight candidates need stated reasons),
 * drop visibility with reviewer attribution, and the fail-open
 * availability packet.
 *
 * Pure module — loaded with an empty require map (reviewPolicy is pure).
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
    makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {});
var reviewPolicy = loadModule('js/common/reviewPolicy.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var mod = loadModule('js/common/reviewPoolMerge.js',
    makeRequire({ './reviewPolicy.js': reviewPolicy }), {});

var BASE_LIST = {
    reviewer: 'base',
    filterWeight: 'normal',
    candidates: [
        { id: 0, path: 'src/auth.ts', line: 40, severity: 'BLOCKING', claim: 'SQL injection: user input interpolated into the query' },
        { id: 1, path: 'src/util.ts', line: 12, severity: 'SUGGESTION', claim: 'Extract the duplicated validation into a helper' }
    ]
};

var SECURITY_LIST = {
    reviewer: 'security',
    filterWeight: 'normal',
    candidates: [
        { id: 0, path: 'src/auth.ts', line: 40, severity: 'IMPORTANT', claim: 'SQL injection: user input interpolated into the query' },
        { id: 1, path: 'src/auth.ts', line: 88, severity: 'BLOCKING', claim: 'Hard-coded PAT token logged on the error path' }
    ]
};

suite('reviewPoolMerge — cross-reviewer dedup (§5)', function() {

    test('the same defect from two reviewers merges into ONE identity', function() {
        var r = mod.mergeCandidateLists([BASE_LIST, SECURITY_LIST]);
        assert.equal(r.merged.length, 3, '2 + 2 candidates with one shared defect → 3 identities');
        var merged = r.merged[0];
        assert.equal(merged.path, 'src/auth.ts');
        assert.equal(merged.line, 40);
        assert.deepEqual(merged.reviewers, ['base', 'security']);
        assert.ok(r.notes.join('\n').indexOf('cross-reviewer match') !== -1);
    });

    test('severity may only escalate: the merged candidate carries the most severe source', function() {
        var r = mod.mergeCandidateLists([BASE_LIST, SECURITY_LIST]);
        assert.equal(r.merged[0].severity, 'BLOCKING', 'base BLOCKING + security IMPORTANT → BLOCKING');
        var lowFirst = mod.mergeCandidateLists([
            { reviewer: 'a', candidates: [{ id: 0, path: 'p', line: 1, severity: 'NIT', claim: 'same claim text' }] },
            { reviewer: 'b', candidates: [{ id: 0, path: 'p', line: 1, severity: 'BLOCKING', claim: 'same claim text' }] }
        ]);
        assert.equal(lowFirst.merged[0].severity, 'BLOCKING', 'escalation is order-independent');
        assert.ok(lowFirst.notes.join('\n').indexOf('NIT → BLOCKING') !== -1,
            'the escalation is noted with the before → after tiers');
    });

    test('a reviewer re-raising its own identity is deduped (first wins, noted)', function() {
        var r = mod.mergeCandidateLists([
            BASE_LIST,
            { reviewer: 'base', candidates: [{ id: 9, path: 'src/auth.ts', line: 40, severity: 'NIT', claim: 'SQL injection: user input interpolated into the query' }] }
        ]);
        assert.equal(r.merged.length, 2);
        assert.deepEqual(r.merged[0].reviewers, ['base']);
        assert.ok(r.notes.join('\n').indexOf('duplicate candidate from base') !== -1);
    });

    test('identity is path + line + normalized claim: different lines never merge', function() {
        var r = mod.mergeCandidateLists([
            BASE_LIST,
            { reviewer: 'security', candidates: [{ id: 0, path: 'src/auth.ts', line: 41, severity: 'BLOCKING', claim: 'SQL injection: user input interpolated into the query' }] }
        ]);
        assert.equal(r.merged.length, 3, 'line differs → separate identities');
    });

    test('claim normalization: whitespace + case differences still merge', function() {
        var r = mod.mergeCandidateLists([
            BASE_LIST,
            { reviewer: 'security', candidates: [{ id: 0, path: 'src/auth.ts', line: 40, severity: 'IMPORTANT', claim: 'SQL  Injection:  USER input interpolated into the query' }] }
        ]);
        assert.equal(r.merged.length, 2);
    });

    test('multi-item pool (3 reviewers) with two shared defects dedups both', function() {
        var legal = { reviewer: 'legal', candidates: [
            { id: 0, path: 'src/auth.ts', line: 40, severity: 'SUGGESTION', claim: 'SQL injection: user input interpolated into the query' },
            { id: 1, path: 'docs/terms.md', line: 3, severity: 'IMPORTANT', claim: 'Consent wording contradicts the privacy spec' }
        ] };
        var r = mod.mergeCandidateLists([BASE_LIST, SECURITY_LIST, legal]);
        assert.equal(r.merged.length, 4, '6 candidates, 2 shared defects → 4 identities');
        var shared = r.merged[0];
        assert.deepEqual(shared.reviewers, ['base', 'security', 'legal']);
        assert.equal(shared.severity, 'BLOCKING');
        // Merged ids are the filter's join keys — dense and 0-based.
        for (var i = 0; i < r.merged.length; i++) assert.equal(r.merged[i].id, i);
    });

    test('empty and missing candidate lists degrade to an empty merge, no crash', function() {
        assert.deepEqual(mod.mergeCandidateLists([]).merged, []);
        assert.deepEqual(mod.mergeCandidateLists(null).merged, []);
        var r = mod.mergeCandidateLists([{ reviewer: 'x' }, { reviewer: 'y', candidates: [] }]);
        assert.deepEqual(r.merged, []);
    });

    test('highWeight rides the merge from the list metadata', function() {
        var r = mod.mergeCandidateLists([
            { reviewer: 'sec', filterWeight: 'high', candidates: [{ id: 0, path: 'p', line: 1, severity: 'BLOCKING', claim: 'x' }] },
            { reviewer: 'base', candidates: [{ id: 0, path: 'p', line: 1, severity: 'BLOCKING', claim: 'x' }] }
        ]);
        assert.equal(r.merged[0].highWeight, true, 'one high-weight source marks the merged identity');
    });
});

suite('reviewPoolMerge — weighted retention (§5)', function() {

    var HIGH = { reviewer: 'security', filterWeight: 'high', candidates: [
        { id: 0, path: 'src/auth.ts', line: 88, severity: 'BLOCKING', claim: 'Hard-coded PAT token logged on the error path' }
    ] };

    test('a high-weight drop without a reason is refused (fail-open to keep) and noted', function() {
        var merged = mod.mergeCandidateLists([HIGH]).merged;
        var r = mod.applyWeightedRetention(merged, [{ id: 0, decision: 'drop' }]);
        assert.deepEqual(r.verdicts, [{ id: 0, decision: 'keep' }]);
        assert.equal(r.refused.length, 1);
        assert.ok(r.notes.join('\n').indexOf('weighted retention') !== -1);
        assert.ok(r.notes.join('\n').indexOf('security') !== -1, 'the note names the high-weight source');
    });

    test('a high-weight demote without a reason is refused too', function() {
        var merged = mod.mergeCandidateLists([HIGH]).merged;
        var r = mod.applyWeightedRetention(merged, [{ id: 0, decision: 'demote', tier: 'NIT' }]);
        assert.deepEqual(r.verdicts, [{ id: 0, decision: 'keep' }]);
        assert.equal(r.refused[0].decision, 'demote');
    });

    test('a high-weight drop WITH a stated reason passes (the packet surfaces it)', function() {
        var merged = mod.mergeCandidateLists([HIGH]).merged;
        var r = mod.applyWeightedRetention(merged, [{ id: 0, decision: 'drop', reason: 'contradicted by the upstream guard' }]);
        assert.deepEqual(r.verdicts, [{ id: 0, decision: 'drop', reason: 'contradicted by the upstream guard' }]);
        assert.deepEqual(r.refused, []);
        var outcomes = mod.highWeightOutcomesOf(merged, [{ id: 0, decision: 'drop', reason: 'contradicted by the upstream guard' }]);
        assert.equal(outcomes.length, 1);
        assert.deepEqual(outcomes[0].reviewers, ['security']);
        assert.equal(outcomes[0].reason, 'contradicted by the upstream guard');
    });

    test('normal-weight candidates keep the gh-1403 semantics (no pool veto)', function() {
        var merged = mod.mergeCandidateLists([BASE_LIST]).merged;
        var r = mod.applyWeightedRetention(merged, [{ id: 0, decision: 'drop' }]);
        assert.deepEqual(r.verdicts, [{ id: 0, decision: 'drop' }], 'reasonless drops of normal-weight candidates pass through — reviewFilter owns that gate');
        assert.deepEqual(r.refused, []);
    });

    test('keeps pass untouched; unknown ids pass through (the filter notes them)', function() {
        var merged = mod.mergeCandidateLists([HIGH]).merged;
        var r = mod.applyWeightedRetention(merged, [
            { id: 0, decision: 'keep' },
            { id: 7, decision: 'drop', reason: 'x' }
        ]);
        assert.equal(r.verdicts.length, 2);
        assert.deepEqual(r.refused, []);
    });
});

suite('reviewPoolMerge — the packet (§4 availability + §5 visibility)', function() {

    test('availability: arrived and unavailable reviewers get their lines', function() {
        var lines = mod.availabilityPacketLines(['base', 'security'], ['legal'], 'first');
        assert.equal(lines.length, 2);
        assert.ok(lines[0].indexOf('candidates from base, security') !== -1);
        assert.ok(lines[1].indexOf('legal unavailable this round') !== -1);
        assert.ok(lines[1].indexOf('fail-open') !== -1);
        assert.ok(lines[1].indexOf('required reviewers gate the merge') !== -1);
    });

    test('dropped pool candidates stay visible with reviewer attribution', function() {
        var line = mod.droppedPoolCandidateLine({
            path: 'src/auth.ts', line: 88,
            claim: 'Hard-coded PAT token logged on the error path',
            reviewers: ['base', 'security'],
            reason: 'contradicted by the upstream guard at src/auth.ts:40'
        });
        assert.ok(line.indexOf('- `src/auth.ts:88`') === 0);
        assert.ok(line.indexOf('[base, security]') !== -1);
        assert.ok(line.indexOf('filter drop') !== -1);
        var noLine = mod.droppedPoolCandidateLine({ path: 'p', claim: 'c', reviewers: ['a'], reason: 'r' });
        assert.ok(noLine.indexOf('`p` —') !== -1, 'no line renders the bare path (never path:undefined)');
    });

    test('buildPoolPacket composes availability + census + weighted outcomes + drops', function() {
        var merged = mod.mergeCandidateLists([BASE_LIST, SECURITY_LIST]).merged;
        var lines = mod.buildPoolPacket({
            arrived: ['base', 'security'],
            unavailable: [],
            roundName: 'rework',
            merged: merged,
            highWeightOutcomes: [{ id: 1, decision: 'demote', reviewers: ['security'], path: 'src/auth.ts', line: 88, reason: 'token is masked upstream' }],
            dropped: [{ id: 1, reason: 'style-level — no gate covers it' }]
        });
        var text = lines.join('\n');
        assert.ok(text.indexOf('Pool census: 3 candidate(s)') !== -1);
        assert.ok(text.indexOf('sources: base, security') !== -1);
        assert.ok(text.indexOf('Weighted retention: demote of high-weight candidate #1') !== -1);
        assert.ok(text.indexOf('🧯 filter drop [base]') !== -1, 'dropped line attributes the merged identity');
    });

    test('a single-reviewer clean round says nothing (no packet noise)', function() {
        var lines = mod.buildPoolPacket({
            arrived: ['base'], unavailable: [], merged: [], highWeightOutcomes: [], dropped: []
        });
        assert.deepEqual(lines, ['👥 Reviewer pool (review): candidates from base.']);
    });

    test('keep verdicts and normal-weight drops never surface as weighted outcomes', function() {
        var merged = mod.mergeCandidateLists([
            { reviewer: 'security', filterWeight: 'high',
                candidates: [{ id: 1, path: 'a.js', line: 2, claim: 'x' }] },
            { reviewer: 'base',
                candidates: [{ id: 2, path: 'b.js', line: 3, claim: 'y' }] }
        ]).merged;
        var out = mod.highWeightOutcomesOf(merged, [
            { id: 0, decision: 'keep', reason: 'kept with a stated reason' },
            { id: 1, decision: 'drop', reason: 'normal-weight drops are the filter\u2019s own business' },
            { id: 0, decision: 'drop', reason: 'superseded by the referenced fix' }
        ]);
        assert.equal(out.length, 1, 'only the high-weight drop surfaces');
        assert.equal(out[0].id, 0, 'the merged identity id (index-based) surfaces');
        assert.deepEqual(out[0].reviewers, ['security']);
        assert.equal(out[0].reason, 'superseded by the referenced fix');
    });

    test('dropped pool candidate lines truncate very long claims (digest discipline)', function() {
        var long = new Array(201).join('x');
        var line = mod.droppedPoolCandidateLine({
            path: 'a.js', line: 2, claim: long, reviewers: ['security'], reason: 'noise'
        });
        assert.ok(line.indexOf('a.js:2') !== -1, line);
        assert.ok(line.indexOf(long) === -1, 'the 200-char claim is truncated');
        assert.ok(line.length < 400, 'line stays digest-sized: ' + line.length);
        assert.ok(line.indexOf('noise') !== -1);
    });
});
