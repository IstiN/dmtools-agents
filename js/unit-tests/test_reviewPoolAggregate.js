/**
 * Unit tests for js/common/reviewPoolAggregate.js — the gh-1471 aggregation
 * point's pure core: the posting leg's own findings join the specialist
 * candidates at the §5 merge (one census), the merged census rebuilds the
 * inline list (base provenance preserved, attribution synthesized), and the
 * gh-1403 filter verdicts go through the pool duties (weighted retention,
 * reviewer-attributed drops) BEFORE they touch the review.
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
    makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {});
var reviewPolicy = loadModule('js/common/reviewPolicy.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var mergeModule = loadModule('js/common/reviewPoolMerge.js',
    makeRequire({ './reviewPolicy.js': reviewPolicy }), {});
var filterModule = loadModule('js/common/reviewFilter.js',
    makeRequire({
        './reviewPolicy.js': reviewPolicy,
        './reviewVerdicts.js': reviewVerdicts,
        './reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js',
            makeRequire({ './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({}), {}) }), {})
    }), {});
var mod = loadModule('js/common/reviewPoolAggregate.js',
    makeRequire({
        './reviewPoolMerge.js': mergeModule,
        './reviewFilter.js': filterModule,
        './reviewPolicy.js': reviewPolicy
    }), {});

var DEFAULT_POLICY = reviewPolicy.defaultPolicy();

function inlineEntry(i, path, line, severity, comment, body) {
    var e = { path: path, line: line, severity: severity };
    if (comment) e.comment = comment;
    if (body) e.body = body;
    return e;
}

// Base review: two file-referenced findings + one inline-body finding +
// one claim-less entry (unresolvable comment file — never merges, never filters).
function baseReview() {
    return {
        recommendation: 'REQUEST_CHANGES',
        issueCounts: { blocking: 1, important: 1, suggestions: 1, nits: 0, digest: 2 },
        inlineComments: [
            inlineEntry(0, 'src/auth/UserService.js', 45, 'BLOCKING', 'outputs/pr_review_comments/sql.md'),
            inlineEntry(1, 'src/utils/config.js', 12, 'IMPORTANT', 'outputs/pr_review_comments/secret.md'),
            inlineEntry(2, 'src/api/routes.js', 88, 'SUGGESTION', null, 'Duplicated validation logic in the route handler.'),
            inlineEntry(3, 'src/lost/file.js', 7, 'NIT', 'outputs/pr_review_comments/missing-file.md')
        ]
    };
}

function claimResolver(entry) {
    var files = {
        'outputs/pr_review_comments/sql.md': '🚨 **BLOCKING: SQL injection**\nRaw user input is concatenated into the query string.',
        'outputs/pr_review_comments/secret.md': '⚠️ **IMPORTANT: Secret leakage**\nThe secret is read without masking and can reach the logs.',
        'outputs/pr_review_comments/missing-file.md': null
    };
    return files[entry.comment] !== undefined ? files[entry.comment] : entry.body;
}

var SECURITY_LIST = {
    reviewer: 'security',
    candidates: [
        { id: 1, path: 'src/auth/UserService.js', line: 45, severity: 'BLOCKING',
            claim: 'raw user input is concatenated into the query string.' },
        { id: 2, path: 'src/perf/cache.js', line: 210, severity: 'IMPORTANT',
            claim: 'unbounded cache grows without eviction' }
    ]
};

suite('reviewPoolAggregate — baseCandidatesFromReview (the posting leg joins its own census)', function() {

    test('claim-bearing base findings become candidates with provenance; claim-less ones do not', function() {
        var base = mod.baseCandidatesFromReview(baseReview(), claimResolver);
        assert.equal(base.reviewer, 'base');
        assert.equal(base.candidates.length, 3, 'the unresolvable comment file never merges');
        assert.equal(base.candidates[0].path, 'src/auth/UserService.js');
        assert.equal(base.candidates[0]._baseIndex, 0);
        assert.ok(base.candidates[0].claim.indexOf('query string') !== -1);
        assert.equal(base.candidates[0].claim.indexOf('BLOCKING'), -1,
            'the severity header strips — the claim is the substance, the tier rides the field');
        assert.equal(base.candidates[2]._baseIndex, 2);
    });

    test('an empty review yields an empty base list (no throw)', function() {
        var base = mod.baseCandidatesFromReview(null, claimResolver);
        assert.equal(base.candidates.length, 0);
    });
});

suite('reviewPoolAggregate — mergePoolCensus (one census across reviewers, §5)', function() {

    test('a base finding and the security finding on the same identity merge; severity escalates only', function() {
        var reviewData = baseReview();
        var round = { lists: [SECURITY_LIST], arrived: ['base', 'security'], unavailable: [], roundName: 'first' };
        var out = mod.mergePoolCensus(reviewData, round, claimResolver);
        assert.equal(out.merged.length, 4, 'sql (merged), secret, routes, cache');
        var sql = out.merged.filter(function(m) { return m.path === 'src/auth/UserService.js'; })[0];
        assert.deepEqual(sql.reviewers.sort(), ['base', 'security'], 'cross-reviewer match recorded');
        assert.equal(sql.severity, 'BLOCKING');
    });

    test('high-weight reviewer candidates carry the highWeight flag into the merge', function() {
        var round = {
            lists: [Object.assign({ filterWeight: 'high' }, SECURITY_LIST)],
            arrived: ['security'], unavailable: [], roundName: 'first'
        };
        var out = mod.mergePoolCensus(null, round, claimResolver);
        assert.equal(out.merged.length, 2);
        assert.equal(out.merged[0].highWeight, true);
    });

    test('no lists at all → empty merged census with notes (fail-open)', function() {
        var out = mod.mergePoolCensus(null, { lists: [], arrived: [], unavailable: ['security'], roundName: 'first' }, claimResolver);
        assert.deepEqual(out.merged, []);
    });
});

suite('reviewPoolAggregate — buildInlineFromMerged (the merged census becomes the inline list)', function() {

    function mergedOf(reviewData, round) {
        return mod.mergePoolCensus(reviewData, round, claimResolver).merged;
    }

    test('base-provenanced entries reuse the ORIGINAL entry (comment-file refs survive); specialist entries synthesize', function() {
        var reviewData = baseReview();
        var merged = mergedOf(reviewData, { lists: [SECURITY_LIST], arrived: ['base', 'security'], unavailable: [], roundName: 'first' });
        var built = mod.buildInlineFromMerged(merged, reviewData.inlineComments);
        // merged order: sql(base#0 merged), secret(base#1), routes(base#2), cache(security)
        // + the untouched claim-less tail.
        assert.equal(built.entries.length, 5);
        assert.equal(built.entries[0].comment, 'outputs/pr_review_comments/sql.md',
            'the original comment-file reference survives the merge');
        assert.equal(built.entries[0].severity, 'BLOCKING');
        assert.equal(built.entries[3].path, 'src/perf/cache.js');
        assert.ok(built.entries[3].body.indexOf('unbounded cache') !== -1);
        assert.ok(built.entries[3].body.indexOf('security') !== -1, 'synthesized entries carry reviewer attribution');
        assert.equal(built.entries[3].comment, undefined);
    });

    test('severity escalation on a base entry is stamped with provenance', function() {
        var reviewData = baseReview();
        var secEscalating = { reviewer: 'security', candidates: [
            { id: 1, path: 'src/api/routes.js', line: 88, severity: 'IMPORTANT',
                claim: 'duplicated validation logic in the route handler.' }
        ]};
        var merged = mergedOf(reviewData, { lists: [secEscalating], arrived: ['base', 'security'], unavailable: [], roundName: 'first' });
        var built = mod.buildInlineFromMerged(merged, reviewData.inlineComments);
        var routes = built.entries.filter(function(e) { return e.path === 'src/api/routes.js'; })[0];
        assert.equal(routes.severity, 'IMPORTANT', 'escalated from SUGGESTION');
        assert.ok((routes.body || '').indexOf('escalated') !== -1 || (routes.__poolEscalated !== undefined),
            'the escalation is visible on the entry');
        assert.deepEqual(routes.__poolReviewers.sort(), ['base', 'security']);
    });

    test('unconsumed base entries ride at the end — never dropped by the merge', function() {
        var reviewData = baseReview();
        var merged = mergedOf(reviewData, { lists: [SECURITY_LIST], arrived: ['base', 'security'], unavailable: [], roundName: 'first' });
        var built = mod.buildInlineFromMerged(merged, reviewData.inlineComments);
        assert.equal(built.entries.length, 5, 'four merged entries + the untouched claim-less tail');
        assert.equal(built.entries[3].path, 'src/perf/cache.js', 'merged entries come first, in merged order');
        assert.equal(built.entries[4].comment, 'outputs/pr_review_comments/missing-file.md',
            'the claim-less base entry is the untouched tail');
    });

    test('claim-less base entries survive verbatim at the tail', function() {
        var reviewData = baseReview();
        var merged = mergedOf(reviewData, { lists: [], arrived: [], unavailable: [], roundName: 'first' });
        var built = mod.buildInlineFromMerged(merged, reviewData.inlineComments);
        assert.equal(built.entries.length, 4);
        assert.equal(built.entries[3].comment, 'outputs/pr_review_comments/missing-file.md',
            'the unresolvable entry rides untouched');
    });
});

suite('reviewPoolAggregate — filterCandidatesFromMerged (the gh-1403 input, pool-shaped)', function() {

    test('filterable tiers only; ids are the merged ids; claims are already resolved', function() {
        var reviewData = baseReview();
        var round = { lists: [SECURITY_LIST], arrived: ['base', 'security'], unavailable: [], roundName: 'first' };
        var merged = mod.mergePoolCensus(reviewData, round, claimResolver).merged;
        var candidates = mod.filterCandidatesFromMerged(merged, DEFAULT_POLICY);
        // default preset: NIT round none — the claim-less entry is out anyway;
        // filterable = BLOCKING + IMPORTANT + SUGGESTION merged entries.
        assert.equal(candidates.length, 4);
        candidates.forEach(function(c) {
            assert.ok(typeof c.id === 'number');
            assert.ok(c.claim && c.claim.length > 0);
            assert.equal(c.reviewers, undefined, 'the finder identity never enters the filter input');
        });
    });
});

suite('reviewPoolAggregate — applyPoolVerdicts (weighted retention + attributed drops)', function() {

    function roundOf(list) {
        return { lists: [list], arrived: ['base', 'security'], unavailable: [], roundName: 'first' };
    }

    test('a drop removes the entry and the drop record names the reviewers', function() {
        var reviewData = baseReview();
        var merged = mod.mergePoolCensus(reviewData, roundOf(SECURITY_LIST), claimResolver).merged;
        mod.applyMergedInline(reviewData, merged);
        var candidates = mod.filterCandidatesFromMerged(merged, DEFAULT_POLICY);
        var cacheId = merged.filter(function(m) { return m.path === 'src/perf/cache.js'; })[0].id;
        var verdicts = [{ id: cacheId, decision: 'drop', reason: 'claim contradicted by the LRU bound at src/perf/cache.js:190' }];
        var out = mod.applyPoolVerdicts(reviewData, merged, candidates, verdicts);
        assert.ok(out.result.changed);
        assert.equal(out.result.dropped.length, 1);
        assert.deepEqual(out.result.dropped[0].reviewers, ['security'], 'drop visibility is reviewer-attributed');
        var stillThere = reviewData.inlineComments.filter(function(e) { return e.path === 'src/perf/cache.js'; });
        assert.equal(stillThere.length, 0, 'the dropped candidate is out of the inline list');
    });

    test('weighted retention: a reasonless HIGH-WEIGHT drop is refused to keep (silence is never precision)', function() {
        var reviewData = baseReview();
        var highWeight = Object.assign({ filterWeight: 'high' }, SECURITY_LIST);
        var merged = mod.mergePoolCensus(reviewData, roundOf(highWeight), claimResolver).merged;
        mod.applyMergedInline(reviewData, merged);
        var candidates = mod.filterCandidatesFromMerged(merged, DEFAULT_POLICY);
        var cacheId = merged.filter(function(m) { return m.path === 'src/perf/cache.js'; })[0].id;
        var verdicts = [{ id: cacheId, decision: 'drop' }];
        var out = mod.applyPoolVerdicts(reviewData, merged, candidates, verdicts);
        assert.equal(out.retention.refused.length, 1, 'the refusal is recorded');
        var stillThere = reviewData.inlineComments.filter(function(e) { return e.path === 'src/perf/cache.js'; });
        assert.equal(stillThere.length, 1, 'the high-weight candidate rides as keep');
    });

    test('a demote downgrades the severity and stamps the provenance note (pool parity with gh-1403)', function() {
        var reviewData = baseReview();
        var merged = mod.mergePoolCensus(reviewData, roundOf(SECURITY_LIST), claimResolver).merged;
        mod.applyMergedInline(reviewData, merged);
        var candidates = mod.filterCandidatesFromMerged(merged, DEFAULT_POLICY);
        var cacheId = merged.filter(function(m) { return m.path === 'src/perf/cache.js'; })[0].id;
        var verdicts = [{ id: cacheId, decision: 'demote', tier: 'SUGGESTION', reason: 'real but cosmetic' }];
        var out = mod.applyPoolVerdicts(reviewData, merged, candidates, verdicts);
        var cache = reviewData.inlineComments.filter(function(e) { return e.path === 'src/perf/cache.js'; })[0];
        assert.equal(cache.severity, 'SUGGESTION');
        assert.ok(out.result.applied.filter(function(a) { return a.decision === 'demote'; }).length === 1);
    });

    test('an empty verdict list applies nothing (round posts as merged)', function() {
        var reviewData = baseReview();
        var merged = mod.mergePoolCensus(reviewData, roundOf(SECURITY_LIST), claimResolver).merged;
        mod.applyMergedInline(reviewData, merged);
        var candidates = mod.filterCandidatesFromMerged(merged, DEFAULT_POLICY);
        var out = mod.applyPoolVerdicts(reviewData, merged, candidates, []);
        assert.equal(out.result.changed, false);
        assert.equal(reviewData.inlineComments.length, 5);
    });
});

suite('reviewPoolAggregate — poolPacketOf (availability + census + drop visibility)', function() {

    test('the packet names arrivals, absences, the census sources and attributed drops', function() {
        var reviewData = baseReview();
        var round = { lists: [SECURITY_LIST], arrived: ['security'], unavailable: ['legal'], roundName: 'first' };
        var merged = mod.mergePoolCensus(reviewData, round, claimResolver).merged;
        mod.applyMergedInline(reviewData, merged);
        var candidates = mod.filterCandidatesFromMerged(merged, DEFAULT_POLICY);
        var cacheId = merged.filter(function(m) { return m.path === 'src/perf/cache.js'; })[0].id;
        var out = mod.applyPoolVerdicts(reviewData, merged, candidates,
            [{ id: cacheId, decision: 'drop', reason: 'not a real finding' }]);
        var lines = mod.poolPacketOf({
            arrived: round.arrived, unavailable: round.unavailable, roundName: round.roundName,
            merged: merged, applied: out.result.applied, dropped: out.result.dropped
        });
        var text = lines.join('\n');
        assert.ok(text.indexOf('security') !== -1);
        assert.ok(text.indexOf('legal unavailable this round') !== -1, 'AC3: the packet notes the missing reviewer');
        assert.ok(text.indexOf('Pool census') !== -1);
        assert.ok(text.indexOf('filter drop [security]') !== -1, 'drops carry the reviewer attribution');
    });

    test('a clean single-source round with no drops renders only the availability line', function() {
        var lines = mod.poolPacketOf({
            arrived: ['base'], unavailable: [], roundName: 'first',
            merged: [], applied: [], dropped: []
        });
        assert.equal(lines.length, 1);
        assert.ok(lines[0].indexOf('candidates from base') !== -1);
        assert.deepEqual(mod.poolPacketOf({
            arrived: [], unavailable: [], roundName: 'first', merged: [], applied: [], dropped: []
        }), [], 'a no-pool round says nothing');
    });
});

suite('reviewPoolAggregate — escalationBodyOf (the escalation note shapes)', function() {
    var merged = { severity: 'BLOCKING', reviewers: ['base', 'security'], claim: 'x', path: 'p', line: 1 };

    test('an inline body grows the escalation tail (trailing whitespace trimmed)', function() {
        var body = mod.escalationBodyOf({ severity: 'IMPORTANT', body: 'Watch this.  ' }, merged);
        assert.ok(body.indexOf('Watch this.') === 0);
        assert.ok(body.indexOf('Pool merge: severity escalated') !== -1);
        assert.ok(body.indexOf('base, security') !== -1, 'the tail names the matching reviewers');
    });

    test('a body-as-comment-file path is NEVER appended (the exact path shape survives)', function() {
        var body = mod.escalationBodyOf({ severity: 'IMPORTANT', body: 'outputs/pr_review_comments/sql.md' }, merged);
        assert.equal(body, 'outputs/pr_review_comments/sql.md');
    });

    test('an empty body returns just the note (no leading newline)', function() {
        var body = mod.escalationBodyOf({ severity: 'IMPORTANT', body: '   ' }, merged);
        assert.ok(body.indexOf('Pool merge') !== -1);
        assert.equal(body.indexOf('\n'), -1, 'the bare note has no tail separator');
    });
});

suite('reviewPoolAggregate — inlineClaimOf (severity-head stripping)', function() {
    test('the machine severity line strips, prose survives', function() {
        var claim = mod.inlineClaimOf(
            { body: '🚨 severity: BLOCKING\nThe SQL is injectable.' }, null);
        assert.equal(claim, 'The SQL is injectable.');
    });

    test('the caller resolver wins over the raw body', function() {
        var claim = mod.inlineClaimOf({ body: 'raw' }, function() { return '🚨 severity: BLOCKING\nresolved'; });
        assert.equal(claim, 'resolved');
    });

    test('an unresolvable claim (empty body) returns null', function() {
        assert.equal(mod.inlineClaimOf({ body: '   ' }, null), null);
        assert.equal(mod.inlineClaimOf({}, null), null);
    });
});

suite('reviewPoolAggregate — inlineEntryFromMerged (synthesized attribution)', function() {
    test('a specialist-only candidate synthesizes the claim + reviewer attribution', function() {
        var list = mod.buildInlineFromMerged([{ id: 0, path: 'src/x.js', line: 3,
            severity: 'BLOCKING', claim: 'Unsafe concat.', reviewers: ['security'] }], []);
        assert.equal(list.entries[0].body.indexOf('Unsafe concat.'), 0);
        assert.ok(list.entries[0].body.indexOf('Raised by security') !== -1);
        assert.equal(list.entries[0].severity, 'BLOCKING');
    });
});
