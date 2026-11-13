/**
 * Unit tests for js/common/reviewPoolPost.js — the gh-1471 post-action
 * aggregation core, IN-JOB shape: the round state rides
 * roundCtx.inJob ({completed, unavailable, candidates}) from the pre-cli
 * runner's candidates FILES; the posting leg stamps the specialists' PASS
 * markers itself (single writer — the gh-1406 merge gate reads them
 * unchanged), ONE pool-outcome marker, and the required-reviewer hold.
 * No polling, no markers-as-transport, no dispatch.
 */
'use strict';

// loadModule/makeRequire/assert are the harness globals (see testRunner.js).

function real(name, map) {
    return loadModule('js/common/' + name, makeRequire(map || {}), {});
}

var machineAuthor = real('machineAuthor.js');
var verdicts = real('reviewVerdicts.js', { './machineAuthor.js': machineAuthor });
var markers = real('reviewPoolMarkers.js', { './reviewVerdicts.js': verdicts });
var candidatesModule = real('reviewPoolCandidates.js', {
    './reviewVerdicts.js': verdicts,
    './reviewPolicy.js': real('reviewPolicy.js', { './reviewVerdicts.js': verdicts })
});
var aggregate = real('reviewPoolAggregate.js', {
    './reviewFilter.js': real('reviewFilter.js', {
        './reviewPolicy.js': real('reviewPolicy.js', { './reviewVerdicts.js': verdicts }),
        './reviewVerdicts.js': verdicts,
        './reviewSpecClaims.js': real('reviewSpecClaims.js', {
            './findingRegistry.js': real('findingRegistry.js', {
                './machineAuthor.js': machineAuthor, './reviewVerdicts.js': verdicts
            }),
            './reviewVerdicts.js': verdicts
        })
    }),
    './reviewPoolMerge.js': real('reviewPoolMerge.js', {
        './reviewPolicy.js': real('reviewPolicy.js', { './reviewVerdicts.js': verdicts })
    }),
    './reviewVerdicts.js': verdicts
});
var poolModule = real('reviewPool.js', {
    './reviewPolicy.js': real('reviewPolicy.js', { './reviewVerdicts.js': verdicts }),
    './reviewPoolSchema.js': real('reviewPoolSchema.js')
});
var reviewFilter = real('reviewFilter.js', {
    './reviewPolicy.js': real('reviewPolicy.js', { './reviewVerdicts.js': verdicts }),
    './reviewVerdicts.js': verdicts,
    './reviewSpecClaims.js': real('reviewSpecClaims.js', {
        './findingRegistry.js': real('findingRegistry.js', {
            './machineAuthor.js': machineAuthor, './reviewVerdicts.js': verdicts
        }),
        './reviewVerdicts.js': verdicts
    })
});
var inJob = real('reviewPoolInJob.js', { './reviewPoolCandidates.js': candidatesModule });
var mod = real('reviewPoolPost.js', {
    './reviewPoolCandidates.js': candidatesModule,
    './reviewPoolMarkers.js': markers,
    './reviewPoolAggregate.js': aggregate,
    './reviewPool.js': poolModule,
    './reviewVerdicts.js': verdicts,
    './reviewPoolInJob.js': inJob
});

var HEAD = 'ccccdddd0000ccccdddd0000ccccdddd0000cccc';
var NOW = '2026-11-13T07:00:00Z';

function skillOf(name, overrides) {
    return Object.assign({
        name: name,
        lens: 'instructions/pr_review/' + name + '/lens.md',
        roleLine: 'Reviewer — ' + name,
        mayRaise: ['BLOCKING', 'IMPORTANT', 'SUGGESTION', 'NIT'],
        filterWeight: 'normal',
        isFiltered: true,
        rounds: ['first', 'hunks'],
        triggerPaths: [],
        options: {},
        model: null,
        isEnabled: true
    }, overrides || {});
}

function poolOf(reviewers, policyOpts) {
    var policy = real('reviewPolicy.js', { './reviewVerdicts.js': verdicts })
        .resolveReviewPolicy(Object.assign({
            machineAuthor: 'ai-teammate',
            repository: { owner: 'acme', repo: 'widget' }
        }, policyOpts || {}), {});
    return { reviewers: reviewers, policy: policy, warnings: [], appends: {} };
}

function candidateRecord(reviewer, head, findings) {
    return {
        reviewer: reviewer,
        head: head,
        candidates: findings || [],
        count: (findings || []).length,
        truncated: false,
        at: NOW
    };
}

function postingReviewData() {
    return {
        recommendation: 'REQUEST_CHANGES',
        generalComment: 'outputs/pr_review_general.md',
        resolvedThreadIds: [],
        inlineComments: [{
            path: 'src/auth.js', line: 10, severity: 'BLOCKING',
            body: 'No rate limit on the login endpoint.'
        }],
        issueCounts: { blocking: 1, important: 0, suggestions: 0, nits: 0, digest: 0 }
    };
}

function makeIo(opts) {
    opts = opts || {};
    var posted = [];
    var generalSections = [];
    var filterCalls = [];
    return {
        posted: posted,
        generalSections: generalSections,
        filterCalls: filterCalls,
        io: {
            readComments: function() { return opts.comments || []; },
            logins: ['ai-teammate'],
            nowIso: function() { return NOW; },
            postComment: function(text) { posted.push(text); },
            resolveClaim: function() { return { verdict: 'keep', reason: '' }; },
            policy: opts.policy || null,
            weightsByName: opts.weightsByName || {},
            verification: opts.verification || 'none',
            runFilterRound: opts.verification === 'filter' ? function(candidates) {
                filterCalls.push(candidates);
                return { verdicts: (opts.filterVerdicts || candidates.map(function(c) {
                    return { id: c.__idx, decision: 'keep', reason: 'verified' };
                })) };
            } : null,
            stampDemotionFiles: function() {},
            recomputeCensus: function(rd, dropped) {
                return reviewFilter.recomputeCensus(rd, dropped);
            },
            appendToGeneralComment: function(section) { generalSections.push(section); }
        }
    };
}


test('buildInJobPlan: specialists only (the posting reviewer never plans as a leg)', function() {
    var pool = poolOf([skillOf('base'), skillOf('security')]);
    var plan = mod.buildInJobPlan(pool, { headSha: HEAD, hasNewHunks: false, newHunkPaths: [] });
    assert.equal(plan.round, 'first');
    assert.deepEqual(plan.legs.map(function(l) { return l.reviewer; }), ['security']);
    assert.ok(plan.legs[0].contract === 'candidates');
});

test('buildInJobPlan: the required flag comes from the pool policy', function() {
    var pool = poolOf(
        [skillOf('security', { isRequired: true }), skillOf('polish')],
        { reviewPolicy: { required: ['security'] } }
    );
    var plan = mod.buildInJobPlan(pool, { headSha: HEAD, hasNewHunks: false, newHunkPaths: [] });
    var byName = {};
    plan.legs.forEach(function(l) { byName[l.reviewer] = l.required === true; });
    assert.equal(byName.security, true, 'the policy-required reviewer is required');
    assert.equal(byName.polish, false, 'the unlisted reviewer is not required');
});

test('poolRoundStep: the in-job candidates merge into ONE census with attribution', function() {
    var pool = poolOf([skillOf('base'), skillOf('security')]);
    var reviewData = postingReviewData();
    var t = makeIo({
        weightsByName: { base: 'normal', security: 'normal' }
    });
    var roundCtx = {
        headSha: HEAD, hasNewHunks: false, newHunkPaths: [],
        inJob: {
            completed: ['security'], unavailable: [],
            candidates: [candidateRecord('security', HEAD, [{
                severity: 'IMPORTANT', path: 'src/crypto.js', line: 22,
                body: 'Hard-coded IV.', claim: 'Hard-coded IV.'
            }])]
        }
    };
    var round = mod.poolRoundStep(reviewData, pool, roundCtx, t.io);

    assert.deepEqual(round.arrived, ['security']);
    assert.deepEqual(round.unavailable, []);
    assert.ok(round.mergedCount >= 1, 'the specialist candidate merged into the census');
    assert.equal(reviewData.inlineComments.length, 2, 'base + merged security thread');
    var secThread = reviewData.inlineComments.filter(function(c) { return c.path === 'src/crypto.js'; })[0];
    assert.ok(secThread, 'the security candidate became a thread');
    assert.ok(secThread.body.indexOf('Raised by security.') !== -1, 'the attribution rides the body');

    // The stamps: the specialist PASS (per completed) + ONE pool-outcome marker.
    var passes = markers.parsePassMarkers(t.posted.map(function(b) {
        return { body: b, user: { login: 'ai-teammate' } };
    }), { authorLogins: ['ai-teammate'] });
    assert.equal(passes.filter(function(p) { return p.reviewer === 'security'; }).length, 1,
        'the posting leg stamped the completed specialist PASS on the round head');
    var outcomes = markers.parsePoolOutcomeMarkers(t.posted.map(function(b) {
        return { body: b, user: { login: 'ai-teammate' } };
    }), { authorLogins: ['ai-teammate'] });
    assert.equal(outcomes.length, 1, 'exactly one pool-outcome marker');
    assert.equal(outcomes[0].head, HEAD);
});

test('poolRoundStep: a missing required specialist holds the merge (fail-open round)', function() {
    var pool = poolOf(
        [skillOf('security', { isRequired: true })],
        { reviewPolicy: { required: ['security'] } }
    );
    var reviewData = postingReviewData();
    var t = makeIo({ weightsByName: { security: 'normal' } });
    var round = mod.poolRoundStep(reviewData, pool, {
        headSha: HEAD, hasNewHunks: false, newHunkPaths: [],
        inJob: { completed: [], unavailable: ['security'], candidates: [] }
    }, t.io);

    assert.deepEqual(round.unavailable, ['security']);
    var holds = markers.parseRequiredReviewerHolds(t.posted.map(function(b) {
        return { body: b, user: { login: 'ai-teammate' } };
    }), { authorLogins: ['ai-teammate'] });
    assert.equal(holds.length, 1, 'the required-reviewer hold is stamped');
    assert.deepEqual(holds[0].missing, ['security']);
    assert.equal(reviewData.inlineComments.length, 1, 'the base review still posts');
});

test('poolRoundStep: no hold when the required specialist completed', function() {
    var pool = poolOf(
        [skillOf('security', { isRequired: true })],
        { reviewPolicy: { required: ['security'] } }
    );
    var reviewData = postingReviewData();
    var t = makeIo({ weightsByName: { security: 'normal' } });
    var round = mod.poolRoundStep(reviewData, pool, {
        headSha: HEAD, hasNewHunks: false, newHunkPaths: [],
        inJob: {
            completed: ['security'], unavailable: [],
            candidates: [candidateRecord('security', HEAD, [])]
        }
    }, t.io);
    assert.deepEqual(round.unavailable, []);
    var holds = markers.parseRequiredReviewerHolds(t.posted.map(function(b) {
        return { body: b, user: { login: 'ai-teammate' } };
    }), { authorLogins: ['ai-teammate'] });
    assert.equal(holds.length, 0, 'no hold: the required specialist completed');
});

test('poolRoundStep: the filter merge point runs over the MERGED census', function() {
    var pool = poolOf([skillOf('security')]);
    var reviewData = postingReviewData();
    var t = makeIo({
        verification: 'filter',
        policy: pool.policy,
        weightsByName: { security: 'normal' },
        filterVerdicts: [{ id: 1, decision: 'drop', reason: 'verified false positive' }]
    });
    mod.poolRoundStep(reviewData, pool, {
        headSha: HEAD, hasNewHunks: false, newHunkPaths: [],
        inJob: {
            completed: ['security'], unavailable: [],
            candidates: [candidateRecord('security', HEAD, [{
                severity: 'IMPORTANT', path: 'src/crypto.js', line: 22,
                body: 'Hard-coded IV.', claim: 'Hard-coded IV.'
            }])]
        }
    }, t.io);

    assert.equal(t.filterCalls.length, 1, 'the filter round ran once over the merged census');
    // gh-1403: the filter re-verifies EVERY rework/polish-tier candidate of the
    // merged census — the base BLOCKING + the security IMPORTANT (2 candidates).
    assert.equal(t.filterCalls[0].length, 2, 'both merged rework-tier candidates verified');
    assert.equal(reviewData.inlineComments.length, 1, 'the dropped candidate never threads');
});

test('expectedCandidateNamesOf reads the in-job plan legs', function() {
    var plan = { legs: [{ reviewer: 'security', contract: 'candidates' }, { reviewer: 'polish', contract: 'candidates' }] };
    assert.deepEqual(mod.expectedCandidateNamesOf(plan), ['security', 'polish']);
});

