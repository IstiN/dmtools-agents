/**
 * Unit tests for js/common/reviewPoolPost.js — the gh-1471 post-action
 * orchestration logic (pure decisions over injected io): the specialist
 * leg's completion flow (candidates marker + PASS marker — NEVER a review,
 * a label or a status change: invariant 1), the posting leg's round
 * aggregation (bounded wait → merge → filter merge point → packet → one
 * pool-outcome marker → the required-reviewer hold), and the posting leg's
 * own PASS stamp.
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
    makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {});
var reviewPolicy = loadModule('js/common/reviewPolicy.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var poolModule = loadModule('js/common/reviewPool.js',
    makeRequire({ './reviewPolicy.js': reviewPolicy }), {});
var markers = loadModule('js/common/reviewPoolMarkers.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var candidatesModule = loadModule('js/common/reviewPoolCandidates.js',
    makeRequire({
        './reviewVerdicts.js': reviewVerdicts,
        './reviewPolicy.js': reviewPolicy
    }), {});
var dispatch = loadModule('js/common/reviewPoolDispatch.js',
    makeRequire({
        './reviewPool.js': poolModule,
        './reviewPoolMarkers.js': markers,
        './reviewVerdicts.js': reviewVerdicts
    }), {});
var mergeModule = loadModule('js/common/reviewPoolMerge.js',
    makeRequire({ './reviewPolicy.js': reviewPolicy }), {});
var filterModule = loadModule('js/common/reviewFilter.js',
    makeRequire({
        './reviewPolicy.js': reviewPolicy,
        './reviewVerdicts.js': reviewVerdicts,
        './reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js',
            makeRequire({ './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({}), {}) }), {})
    }), {});
var aggregate = loadModule('js/common/reviewPoolAggregate.js',
    makeRequire({
        './reviewPoolMerge.js': mergeModule,
        './reviewFilter.js': filterModule,
        './reviewVerdicts.js': reviewVerdicts
    }), {});
var mod = loadModule('js/common/reviewPoolPost.js',
    makeRequire({
        './reviewPoolCandidates.js': candidatesModule,
        './reviewPoolDispatch.js': dispatch,
        './reviewPoolMarkers.js': markers,
        './reviewPoolAggregate.js': aggregate,
        './reviewPool.js': poolModule,
        './reviewVerdicts.js': reviewVerdicts
    }), {});

var MACHINE_LOGINS = ['dmtools-machine[bot]'];
var HEAD = '4a6756f73d0ae9b72788db7ad229fc9754dc51b5';

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeIo(files, dirs) {
    return {
        readFile: function(p) { return (files && files[p] !== undefined) ? files[p] : null; },
        listFiles: function(d) { return (dirs && dirs[d]) ? dirs[d] : null; }
    };
}

var BASE_JSON = JSON.stringify({ name: 'base', lens: 'instructions/pr_review/generalist/lens.md', rounds: ['all'] });
var SECURITY_JSON = JSON.stringify({ name: 'security', lens: 'instructions/pr_review/security/lens.md',
    rounds: ['first', 'hunks'], triggerPaths: [] });

function poolOf() {
    return poolModule.resolvePool(makeIo({
        'instructions/review/base.json': BASE_JSON,
        'instructions/review/security.json': SECURITY_JSON,
        'instructions/pr_review/generalist/lens.md': '# lens\ncite the evidence.',
        'instructions/pr_review/security/lens.md': '# lens\ncite the evidence.'
    }, { 'instructions/review': ['base.json', 'security.json'] }), null, null, {});
}

function commentOf(body, author) {
    return { body: body, author: { login: author || MACHINE_LOGINS[0] } };
}

function parseComments(bodies) {
    return (bodies || []).map(function(b) {
        return typeof b === 'string' ? commentOf(b) : b;
    });
}

var SECURITY_CANDIDATES = { reviewer: 'security', candidates: [
    { id: 1, path: 'src/auth/UserService.js', line: 45, severity: 'BLOCKING',
        claim: 'raw user input is concatenated into the query string.' }
]};

// ── specialist leg flow (invariant 1) ────────────────────────────────────────

suite('reviewPoolPost — specialist legs (invariant 1: never post, never label)', function() {

    function specialistIo(opts) {
        var o = opts || {};
        var posted = [];
        return {
            io: { posted: posted },
            readCandidatesFile: function() { return o.candidatesFile === undefined ? null : o.candidatesFile; },
            headSha: function() { return HEAD; },
            nowIso: function() { return '2026-11-14T12:00:00Z'; },
            logins: MACHINE_LOGINS,
            postComment: function(text) { posted.push(text); return true; }
        };
    }

    test('specialistLegOf: only a candidates-contract identity is a specialist leg', function() {
        var patches = dispatch.legParamPatches({ reviewer: 'security', contract: 'candidates', required: true, round: 'first' }, HEAD);
        assert.ok(mod.specialistLegOf({ customParams: { reviewerPoolLeg: patches.reviewerPoolLeg } }));
        var basePatches = dispatch.legParamPatches({ reviewer: 'base', contract: 'verdict', required: true, round: 'first' }, HEAD);
        assert.equal(mod.specialistLegOf({ customParams: { reviewerPoolLeg: basePatches.reviewerPoolLeg } }), null,
            'the posting leg is never a specialist');
        assert.equal(mod.specialistLegOf({ customParams: {} }), null);
    });

    test('a completing specialist stamps candidates + PASS markers and nothing else', function() {
        var io = specialistIo({ candidatesFile: JSON.stringify(SECURITY_CANDIDATES) });
        var identity = dispatch.legParamPatches({ reviewer: 'security', contract: 'candidates', required: true, round: 'first' }, HEAD).reviewerPoolLeg;
        var out = mod.runSpecialistPost(identity, io);
        assert.equal(out.success, true);
        assert.equal(out.candidates, 1);
        assert.equal(io.io.posted.length, 2, 'exactly two comments: the candidates marker + the PASS marker');
        var all = io.io.posted.join('\n');
        assert.ok(all.indexOf('dmtools:review-candidates') !== -1);
        assert.ok(all.indexOf('dmtools:review-pass') !== -1);
        assert.ok(all.indexOf('recommendation') === -1, 'no verdict anywhere');
        // machine-parseable both ways:
        var records = candidatesModule.parseCandidatesMarkers(parseComments(io.io.posted), { authorLogins: MACHINE_LOGINS });
        assert.equal(records.length, 1);
        var passes = markers.parsePassMarkers(parseComments(io.io.posted), { authorLogins: MACHINE_LOGINS });
        assert.equal(passes.length, 1);
        assert.equal(passes[0].reviewer, 'security');
    });

    test('an unreadable candidates file still completes the pass (PASS without candidates)', function() {
        var io = specialistIo({ candidatesFile: null });
        var identity = dispatch.legParamPatches({ reviewer: 'security', contract: 'candidates', required: true, round: 'first' }, HEAD).reviewerPoolLeg;
        var out = mod.runSpecialistPost(identity, io);
        assert.equal(out.success, true);
        assert.equal(out.candidates, 0);
        assert.equal(io.io.posted.length, 1, 'only the PASS marker — availability stays fail-open');
    });

    test('a failed marker post is fail-soft: the result reports it, nothing throws', function() {
        var io = specialistIo({ candidatesFile: JSON.stringify(SECURITY_CANDIDATES) });
        io.postComment = function() { throw new Error('429'); };
        var identity = dispatch.legParamPatches({ reviewer: 'security', contract: 'candidates', required: true, round: 'first' }, HEAD).reviewerPoolLeg;
        var out = mod.runSpecialistPost(identity, io);
        assert.equal(out.success, true);
        assert.equal(out.postFailures, 2);
    });
});

// ── the posting leg's round aggregation ──────────────────────────────────────

function baseReviewData() {
    return {
        recommendation: 'APPROVE',
        issueCounts: { blocking: 0, important: 0, suggestions: 0, nits: 0, digest: 1 },
        inlineComments: [
            { path: 'src/auth/UserService.js', line: 45, severity: 'BLOCKING',
                comment: 'outputs/pr_review_comments/sql.md' }
        ],
        generalComment: 'outputs/pr_review_general.md'
    };
}

suite('reviewPoolPost — poolRoundStep (the aggregation point)', function() {

    function roundIo(opts) {
        var o = opts || {};
        var posted = [];
        var comments = (o.comments || []).slice();
        return {
            posted: posted,
            comments: comments,
            readComments: function() { return comments.slice(); },
            logins: MACHINE_LOGINS,
            nowIso: function() { return '2026-11-14T12:00:00Z'; },
            sleepMs: 0,
            sleep: function() {},
            resolveClaim: function(entry) {
                return entry.comment ? 'raw user input is concatenated into the query string.' : entry.body;
            },
            policy: reviewPolicy.defaultPolicy(),
            weightsByName: { security: 'normal' },
            runFilterRound: o.runFilterRound || null,
            stampDemotionFiles: function() {},
            recomputeCensus: function(reviewData, dropped) { return { dropped: dropped }; },
            appendToGeneralComment: function(section) { o.sections = (o.sections || []).concat(section); return true; },
            postComment: function(text) { posted.push(text); return true; }
        };
    }

    function candidatesComment() {
        return candidatesModule.buildCandidatesMarkerComment('security', HEAD, SECURITY_CANDIDATES.candidates, '2026-11-14T11:00:00Z');
    }

    test('arrived specialist candidates merge into the review; one outcome marker is stamped', function() {
        var reviewData = baseReviewData();
        var io = roundIo({ comments: [commentOf(candidatesComment())] });
        var out = mod.poolRoundStep(reviewData, poolOf(), {
            headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: []
        }, io);
        assert.equal(out.round, 'first');
        assert.deepEqual(out.arrived, ['security']);
        assert.equal(out.mergedCount, 1, 'the sql finding merges (base+security) — one census');
        assert.equal(reviewData.inlineComments.length, 1);
        assert.ok(reviewData.inlineComments[0].__poolReviewers.indexOf('security') !== -1,
            'the posted thread carries the reviewer attribution');
        assert.ok(io.posted.length >= 1, 'the pool-outcome marker is stamped');
        var outcomes = markers.parsePoolOutcomeMarkers(parseComments(io.posted), { authorLogins: MACHINE_LOGINS });
        assert.equal(outcomes.length, 1);
        var byName = {};
        outcomes[0].reviewers.forEach(function(e) { byName[e.name] = e; });
        assert.equal(byName.security.completed, false, 'security has no PASS marker yet at aggregation time');
    });

    test('AC3: a missing non-required reviewer fails the round open — packet notes it, round completes', function() {
        var reviewData = baseReviewData();
        var io = roundIo({ comments: [] });
        var out = mod.poolRoundStep(reviewData, poolOf(), {
            headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: []
        }, io);
        assert.deepEqual(out.arrived, []);
        assert.deepEqual(out.unavailable, ['security']);
        assert.ok((out.packet.join('\n')).indexOf('security unavailable this round') !== -1);
        assert.deepEqual(out.heldRequired, ['security'],
            'a required specialist that never showed up stamps the required-reviewer hold');
    });

    test('completed specialists never hold; the posting leg never holds on itself', function() {
        // security completed (PASS on this head) and base is the posting leg
        // (its PASS stamp lands moments later in the action) — nobody holds.
        var pass = markers.buildPassMarkerComment('security', HEAD, '2026-11-14T11:30:00Z');
        var reviewData = baseReviewData();
        var io = roundIo({ comments: [commentOf(pass)] });
        var out = mod.poolRoundStep(reviewData, poolOf(), {
            headSha: HEAD, passMarkers: markers.parsePassMarkers([commentOf(pass)], { authorLogins: MACHINE_LOGINS }),
            hasNewHunks: false, newHunkPaths: []
        }, io);
        assert.equal(out.heldRequired, null, 'no hold when every required specialist completed');
    });

    test('a specialist that arrived but has no PASS yet never holds (mid-flight guard)', function() {
        var reviewData = baseReviewData();
        var io = roundIo({ comments: [commentOf(candidatesComment())] });
        var out = mod.poolRoundStep(reviewData, poolOf(), {
            headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: []
        }, io);
        assert.equal(out.heldRequired, null,
            'candidates arrived — the leg is mid-flight, its completion is imminent');
    });

    test('the hold is deduped — an existing same-head required-reviewer hold never re-posts', function() {
        var plan = dispatch.buildRoundPlan(poolOf(), { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var hold = markers.buildRequiredReviewerHoldMarker(['security'], HEAD, '2026-11-14T10:00:00Z', false, null);
        var reviewData = baseReviewData();
        var io = roundIo({ comments: [commentOf(candidatesComment()), commentOf(hold)] });
        var out = mod.poolRoundStep(reviewData, poolOf(), {
            headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: []
        }, io);
        var holds = io.posted.filter(function(b) { return b.indexOf('merge-hold') !== -1; });
        assert.equal(holds.length, 0, 'the existing hold stands — no second hold comment');
        assert.equal(out.existingHold, true, 'the pre-existing same-head hold is reported, not re-stamped');
    });

    test('the filter merge point runs the pool-shaped candidates through the round', function() {
        var reviewData = baseReviewData();
        var ran = null;
        var io = roundIo({
            comments: [candidatesComment()],
            runFilterRound: function(candidates) {
                ran = candidates;
                return { verdicts: [] };
            }
        });
        io.policy = reviewPolicy.defaultPolicy(); // verification none → filter skipped in this test's default
        io.verification = 'filter';
        mod.poolRoundStep(reviewData, poolOf(), { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] }, io);
        assert.ok(ran && ran.length >= 1, 'the merged census feeds the filter round');
        assert.equal(ran.filter(function(c) { return c.reviewers !== undefined; }).length, 0,
            'the finder identity never reaches the filter');
    });

    test('no wait when every expected specialist already arrived', function() {
        var reviewData = baseReviewData();
        var sleeps = 0;
        var io = roundIo({ comments: [commentOf(candidatesComment())] });
        io.sleep = function() { sleeps++; };
        mod.poolRoundStep(reviewData, poolOf(), { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] }, io);
        assert.equal(sleeps, 0);
    });

    test('the bounded wait polls until the late specialist arrives', function() {
        var reviewData = baseReviewData();
        var polls = 0;
        var comments = [];
        var io = roundIo({ comments: comments });
        io.waitSeconds = 60;
        io.pollSeconds = 30;
        io.readComments = function() {
            polls++;
            if (polls >= 2) comments.push(commentOf(candidatesComment()));
            return comments.slice();
        };
        var out = mod.poolRoundStep(reviewData, poolOf(), { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] }, io);
        assert.deepEqual(out.arrived, ['security'], 'the late arrival joined the round');
        assert.ok(polls >= 2);
    });

    test('the wait times out fail-open: the round completes with the packet naming the absence', function() {
        var reviewData = baseReviewData();
        var polls = 0;
        var io = roundIo({ comments: [] });
        io.waitSeconds = 30;
        io.pollSeconds = 30;
        io.readComments = function() { polls++; return []; };
        var out = mod.poolRoundStep(reviewData, poolOf(), { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] }, io);
        assert.deepEqual(out.arrived, []);
        assert.ok(polls <= 3, 'the wait is bounded (two poll reads + the final marker read)');
        assert.ok((out.packet.join('\n')).indexOf('unavailable this round') !== -1);
    });
});

suite('reviewPoolPost — stampPostingLegCompletion', function() {

    test('the posting leg stamps its own PASS marker on the head', function() {
        var posted = [];
        mod.stampPostingLegCompletion({
            headSha: function() { return HEAD; },
            nowIso: function() { return '2026-11-14T12:00:00Z'; },
            postComment: function(text) { posted.push(text); return true; }
        });
        var passes = markers.parsePassMarkers(parseComments(posted), { authorLogins: MACHINE_LOGINS });
        assert.equal(passes.length, 1);
        assert.equal(passes[0].reviewer, 'base');
        assert.equal(markers.hasCompletedOnHead(passes, 'base', HEAD.substring(0, 7)), true);
    });

    test('a failed PASS post is fail-soft', function() {
        var out = mod.stampPostingLegCompletion({
            headSha: function() { return HEAD; },
            nowIso: function() { return '2026-11-14T12:00:00Z'; },
            postComment: function() { throw new Error('network'); }
        });
        assert.equal(out.stamped, false);
        assert.equal(out.success, true);
    });
});
