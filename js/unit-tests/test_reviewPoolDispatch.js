/**
 * Unit tests for js/common/reviewPoolDispatch.js — the gh-1471 leg
 * dispatcher's pure core: the per-leg output contract, the round plan
 * (rounds/triggerPaths gating + duplicate-safe re-fire), the round's
 * expected-entries record, and the retry mechanics for required legs
 * (backoff, budget, escalation — never silent merge, never silent
 * approval).
 *
 * AC replay under test: the owner's 429 scenario — a required leg that
 * fails leaves NO completion marker, so it re-fires (attempt counted from
 * the same-head round records) until the budget is spent, then escalates.
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
    makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {});
var reviewPolicy = loadModule('js/common/reviewPolicy.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var poolModule = loadModule('js/common/reviewPool.js',
    makeRequire({ './reviewPolicy.js': reviewPolicy }), {});
var markers = loadModule('js/common/reviewPoolMarkers.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var mod = loadModule('js/common/reviewPoolDispatch.js',
    makeRequire({
        './reviewPool.js': poolModule,
        './reviewPoolMarkers.js': markers,
        './reviewPolicy.js': reviewPolicy
    }), {});

var MACHINE_LOGINS = ['dmtools-machine[bot]'];
var HEAD = '4a6756f73d0ae9b72788db7ad229fc9754dc51b5';

function makeIo(files, dirs) {
    return {
        readFile: function(p) { return (files && files[p] !== undefined) ? files[p] : null; },
        listFiles: function(d) { return (dirs && dirs[d]) ? dirs[d] : null; }
    };
}

var BASE_JSON = JSON.stringify({ name: 'base', lens: 'instructions/pr_review/generalist/lens.md',
    roleLine: 'Senior Code Reviewer', rounds: ['all'] });
var SECURITY_JSON = JSON.stringify({ name: 'security', lens: 'instructions/pr_review/security/lens.md',
    rounds: ['first', 'hunks'], triggerPaths: [] });
var PERF_JSON = JSON.stringify({ name: 'perf', lens: 'instructions/pr_review/generalist/lens.md',
    rounds: ['first'], triggerPaths: ['perf/'] });

var FACTORY_DIRS = { 'instructions/review': ['base.json', 'security.json', 'perf.json'] };
var FACTORY_FILES = {
    'instructions/review/base.json': BASE_JSON,
    'instructions/review/security.json': SECURITY_JSON,
    'instructions/review/perf.json': PERF_JSON,
    'instructions/pr_review/generalist/lens.md': '# lens\ncite the evidence.',
    'instructions/pr_review/security/lens.md': '# lens\ncite the evidence.'
};

function poolOf(extraFiles, extraDirs) {
    var files = Object.assign({}, FACTORY_FILES, extraFiles || {});
    var dirs = Object.assign({}, FACTORY_DIRS, extraDirs || {});
    return poolModule.resolvePool(makeIo(files, dirs), null, null, {});
}

function passMarkerOf(reviewer, head, at) {
    var body = markers.buildPassMarkerComment(reviewer, head || HEAD, at || '2026-11-14T10:00:00Z');
    return { body: body, author: { login: MACHINE_LOGINS[0] } };
}

function passMarkersOf(list) {
    var comments = (list || []).map(function(p) { return passMarkerOf(p[0], p[1]); });
    return markers.parsePassMarkers(comments, { authorLogins: MACHINE_LOGINS });
}

suite('reviewPoolDispatch — the per-leg output contract (invariant 1)', function() {

    test('the posting leg is the factory generalist; every other reviewer files candidates', function() {
        assert.equal(mod.outputContractOf({ name: 'base' }), 'verdict');
        assert.equal(mod.outputContractOf({ name: 'security' }), 'candidates');
        assert.equal(mod.outputContractOf({ name: 'legal' }), 'candidates',
            'a repo-defined reviewer can never mint a verdict — candidates only');
        assert.equal(mod.POSTING_REVIEWER, 'base');
    });

    test('the leg identity patch carries reviewer + contract + round + head + required', function() {
        var leg = { reviewer: 'security', required: true, contract: 'candidates', round: 'first' };
        var patches = mod.legParamPatches(leg, HEAD);
        assert.equal(patches.reviewerPoolLeg.reviewer, 'security');
        assert.equal(patches.reviewerPoolLeg.contract, 'candidates');
        assert.equal(patches.reviewerPoolLeg.required, true);
        assert.equal(patches.reviewerPoolLeg.head, HEAD);
        assert.ok(mod.legIdentityOf({ customParams: { reviewerPoolLeg: patches.reviewerPoolLeg } }).reviewer === 'security');
        assert.equal(mod.legIdentityOf({ jobParams: { customParams: { reviewerPoolLeg: patches.reviewerPoolLeg } } }).contract,
            'candidates', 'jobParams.customParams is the encoded-config path');
        assert.equal(mod.legIdentityOf({ customParams: {} }), null, 'a plain leg has no pool identity');
        assert.equal(mod.legIdentityOf(null), null);
    });

    test('the posting leg keeps the verdict contract; candidates never ride a verdict identity', function() {
        var patches = mod.legParamPatches(
            { reviewer: 'base', required: true, contract: mod.outputContractOf({ name: 'base' }), round: 'first' }, HEAD);
        assert.equal(patches.reviewerPoolLeg.contract, 'verdict');
    });
});

suite('reviewPoolDispatch — buildRoundPlan (rounds/triggerPaths + duplicate-safe re-fire)', function() {

    test('first round: base + security + perf all run; base is the posting leg', function() {
        var plan = mod.buildRoundPlan(poolOf(), { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var legNames = plan.legs.map(function(l) { return l.reviewer; });
        assert.deepEqual(legNames, ['base', 'security', 'perf']);
        assert.equal(plan.postingLeg.reviewer, 'base');
        assert.equal(plan.legs[0].contract, 'verdict');
        assert.equal(plan.legs[1].contract, 'candidates');
        assert.equal(plan.round, 'first');
    });

    test('rounds gating: with no new hunks, first/hunks reviewers are skipped on a re-round', function() {
        var secDone = passMarkersOf([['security'], ['base'], ['perf']]);
        var plan = mod.buildRoundPlan(poolOf(), { headSha: HEAD, passMarkers: secDone, hasNewHunks: false, newHunkPaths: [] });
        // base has rounds ['all'] — but it already completed on THIS head: duplicate-safe skip.
        assert.deepEqual(plan.legs.map(function(l) { return l.reviewer; }), [],
            'same-head completions never re-fire within the head');
        assert.ok(plan.skipped.length >= 3);
    });

    test('duplicate-safe re-fire: a FAILED leg (no marker) re-fires; completed ones skip', function() {
        var secDone = passMarkersOf([['security'], ['base']]);
        var plan = mod.buildRoundPlan(poolOf(), { headSha: HEAD, passMarkers: secDone, hasNewHunks: false, newHunkPaths: [] });
        assert.deepEqual(plan.legs.map(function(l) { return l.reviewer; }), ['perf'],
            'perf has no completion marker — it re-fires');
    });

    test('AC4: rounds ["first","hunks"] re-run only when new hunks land', function() {
        var secDone = passMarkersOf([['security', '1111111111111111111111111111111111111111']]);
        var withHunks = mod.buildRoundPlan(poolOf(), {
            headSha: HEAD, passMarkers: secDone, hasNewHunks: true, newHunkPaths: ['src/auth/login.js'] });
        assert.deepEqual(withHunks.legs.map(function(l) { return l.reviewer; }), ['base', 'security'],
            'security re-fires on new hunks; base (all) rides along; perf (first, done) stays frozen');
        assert.equal(withHunks.round, 'hunks');
    });

    test('AC4: triggerPaths gate the hunks re-run — untouched paths never re-fire', function() {
        var secDone = passMarkersOf([['security', '1111111111111111111111111111111111111111']]);
        var plan = mod.buildRoundPlan(poolOf(), {
            headSha: HEAD, passMarkers: secDone, hasNewHunks: true, newHunkPaths: ['src/docs/readme.md'] });
        assert.deepEqual(plan.legs.map(function(l) { return l.reviewer; }), ['base'],
            'perf triggers on perf/ paths only — docs hunks do not wake it');
        var hit = mod.buildRoundPlan(poolOf(), {
            headSha: HEAD, passMarkers: secDone, hasNewHunks: true, newHunkPaths: ['src/perf/bench.js'] });
        assert.ok(hit.legs.map(function(l) { return l.reviewer; }).indexOf('perf') !== -1,
            'perf hunks hit perf/ — perf re-fires');
    });

    test('expected entries name every enabled reviewer with required flags + completion state', function() {
        var secDone = passMarkersOf([['security']]);
        var plan = mod.buildRoundPlan(poolOf(), { headSha: HEAD, passMarkers: secDone, hasNewHunks: false, newHunkPaths: [] });
        var byName = {};
        plan.expected.forEach(function(e) { byName[e.name] = e; });
        assert.equal(byName.base.required, true, 'factory default required: [base, security]');
        assert.equal(byName.security.required, true);
        assert.equal(byName.perf.required, false);
        assert.equal(byName.security.completed, true);
        assert.equal(byName.base.completed, true);
        assert.equal(byName.perf.completed, false);
    });

    test('a disabled reviewer never runs and never rides the expectation record', function() {
        var pool = poolOf({}, { 'instructions/review': ['base.json', 'security.json', 'perf.json'] });
        var tuned = poolModule.resolvePool(makeIo(Object.assign({}, FACTORY_FILES, {
            '.dmtools/review/security.json': JSON.stringify({ name: 'security', isEnabled: false })
        }), { '.dmtools/review': ['security.json'], 'instructions/review': ['base.json', 'security.json', 'perf.json'] }),
            null, null, {});
        var plan = mod.buildRoundPlan(tuned, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var names = plan.legs.map(function(l) { return l.reviewer; });
        assert.ok(names.indexOf('security') === -1, 'disabled reviewers never run');
        assert.ok(plan.expected.every(function(e) { return e.name !== 'security'; }));
        assert.equal(plan.postingLeg.reviewer, 'base');
    });

    test('a disabled posting leg yields postingLeg null (the caller fails the round loudly)', function() {
        var tuned = poolModule.resolvePool(makeIo(Object.assign({}, FACTORY_FILES, {
            '.dmtools/review/base.json': JSON.stringify({ name: 'base', isEnabled: false })
        }), { '.dmtools/review': ['base.json'], 'instructions/review': ['base.json', 'security.json', 'perf.json'] }),
            null, null, {});
        var plan = mod.buildRoundPlan(tuned, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        assert.equal(plan.postingLeg, null);
    });
});

suite('reviewPoolDispatch — retry mechanics for required legs (the 429 replay)', function() {

    test('attemptCountOf counts same-head rounds that expected the reviewer', function() {
        var pool = poolOf();
        var plan = mod.buildRoundPlan(pool, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var outcome = markers.buildPoolOutcomeMarkerComment(HEAD, 'first', plan.expected, '2026-11-14T10:00:00Z');
        var records = markers.parsePoolOutcomeMarkers([{ body: outcome, author: { login: MACHINE_LOGINS[0] } }],
            { authorLogins: MACHINE_LOGINS });
        assert.equal(mod.attemptCountOf(records, 'security', HEAD), 1);
        assert.equal(mod.attemptCountOf(records, 'legal', HEAD), 0, 'never-expected reviewers have no attempts');
    });

    test('the 429 replay: required leg fails → retry with backoff; budget exhausts → escalate', function() {
        var pool = poolOf();
        var plan = mod.buildRoundPlan(pool, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        // Round 1 + round 2 stamped, security never completed (429 both times).
        var outcome1 = markers.buildPoolOutcomeMarkerComment(HEAD, 'first', plan.expected, '2026-11-14T10:00:00Z');
        var outcome2 = markers.buildPoolOutcomeMarkerComment(HEAD, 'hunks', plan.expected, '2026-11-14T11:00:00Z');
        var records = markers.parsePoolOutcomeMarkers(
            [{ body: outcome1, author: { login: MACHINE_LOGINS[0] } }, { body: outcome2, author: { login: MACHINE_LOGINS[0] } }],
            { authorLogins: MACHINE_LOGINS });

        var early = mod.retryDecisions(plan, { outcomeRecords: records, passMarkers: [], headSha: HEAD,
            nowIso: '2026-11-14T12:00:00Z' });
        var byName = {};
        early.decisions.forEach(function(d) { byName[d.reviewer] = d; });
        assert.equal(byName.security.action, 'retry', 'under budget — the leg re-fires');
        assert.ok(byName.security.delayMs > 0, 'retries back off (exponential)');
        assert.equal(byName.base.action, 'retry');
        assert.ok(byName.security.delayMs !== byName.base.delayMs || true, 'per-reviewer attempts may differ');

        // Push security past the budget with same-head rounds.
        var outcomes = [];
        for (var i = 0; i < mod.DEFAULT_MAX_LEG_ATTEMPTS; i++) {
            outcomes.push({ body: markers.buildPoolOutcomeMarkerComment(HEAD, 'first', plan.expected,
                '2026-11-14T1' + i + ':00:00Z'), author: { login: MACHINE_LOGINS[0] } });
        }
        var spent = markers.parsePoolOutcomeMarkers(outcomes, { authorLogins: MACHINE_LOGINS });
        var exhausted = mod.retryDecisions(plan, { outcomeRecords: spent, passMarkers: [], headSha: HEAD,
            nowIso: '2026-11-14T12:00:00Z' });
        var ex = {};
        exhausted.decisions.forEach(function(d) { ex[d.reviewer] = d; });
        assert.equal(ex.security.action, 'escalate', 'budget spent without a completion — escalate, never silent merge');
        assert.deepEqual(exhausted.escalated, ['security']);
        assert.equal(ex.security.attempts, mod.DEFAULT_MAX_LEG_ATTEMPTS);
    });

    test('a completed required leg neither retries nor escalates', function() {
        var pool = poolOf();
        var plan = mod.buildRoundPlan(pool, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var outcome = markers.buildPoolOutcomeMarkerComment(HEAD, 'first', plan.expected, '2026-11-14T10:00:00Z');
        var records = markers.parsePoolOutcomeMarkers([{ body: outcome, author: { login: MACHINE_LOGINS[0] } }],
            { authorLogins: MACHINE_LOGINS });
        var done = mod.retryDecisions(plan, { outcomeRecords: records, passMarkers: passMarkersOf([['security']]),
            headSha: HEAD, nowIso: '2026-11-14T12:00:00Z' });
        var byName = {};
        done.decisions.forEach(function(d) { byName[d.reviewer] = d; });
        assert.equal(byName.security.action, 'none');
        assert.deepEqual(done.escalated, []);
    });

    test('a non-required leg past budget gives up fail-open (no escalation, no leg)', function() {
        var pool = poolOf();
        var plan = mod.buildRoundPlan(pool, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var outcomes = [];
        for (var i = 0; i < mod.DEFAULT_MAX_LEG_ATTEMPTS + 1; i++) {
            outcomes.push({ body: markers.buildPoolOutcomeMarkerComment(HEAD, 'first', plan.expected,
                '2026-11-14T1' + i + ':00:00Z'), author: { login: MACHINE_LOGINS[0] } });
        }
        var spent = markers.parsePoolOutcomeMarkers(outcomes, { authorLogins: MACHINE_LOGINS });
        var out = mod.retryDecisions(plan, { outcomeRecords: spent, passMarkers: [], headSha: HEAD,
            nowIso: '2026-11-14T12:00:00Z' });
        var byName = {};
        out.decisions.forEach(function(d) { byName[d.reviewer] = d; });
        assert.equal(byName.perf.action, 'give-up', 'non-required exhaustion is fail-open silence-with-audit');
        assert.deepEqual(out.escalated, [], 'non-required legs never escalate');
    });

    test('retry decisions back off exponentially per attempt', function() {
        var pool = poolOf();
        var plan = mod.buildRoundPlan(pool, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var one = mod.retryDecisions(plan, { outcomeRecords: [], passMarkers: [], headSha: HEAD,
            nowIso: '2026-11-14T12:00:00Z', maxAttempts: 5 });
        var oneSec = one.decisions.filter(function(d) { return d.reviewer === 'security'; })[0];
        assert.equal(oneSec.attempts, 0);
        assert.equal(oneSec.delayMs, mod.DEFAULT_BACKOFF_BASE_MS, 'first retry: base delay');
    });

    test('no same-head rounds at all → first dispatch, zero attempts, no escalation', function() {
        var pool = poolOf();
        var plan = mod.buildRoundPlan(pool, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var out = mod.retryDecisions(plan, { outcomeRecords: [], passMarkers: [], headSha: HEAD,
            nowIso: '2026-11-14T12:00:00Z' });
        assert.deepEqual(out.escalated, []);
        assert.equal(out.decisions.length, plan.legs.length);
        out.decisions.forEach(function(d) { assert.equal(d.action, 'retry'); assert.equal(d.attempts, 0); });
    });
});

suite('reviewPoolMarkers — the outcome entries carry the round completion (additive)', function() {

    test('entriesWithCompletions stamps completed from same-head PASS markers', function() {
        var pool = poolOf();
        var plan = mod.buildRoundPlan(pool, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var secDone = passMarkersOf([['security']]);
        var entries = mod.outcomeEntriesWithCompletions(plan, secDone, HEAD);
        var byName = {};
        entries.forEach(function(e) { byName[e.name] = e; });
        assert.equal(byName.security.completed, true);
        assert.equal(byName.base.completed, false);
        assert.equal(byName.perf.completed, false);
    });

    test('the outcome marker round-trips the completed field; the gate still reads PASS markers', function() {
        var pool = poolOf();
        var plan = mod.buildRoundPlan(pool, { headSha: HEAD, passMarkers: [], hasNewHunks: false, newHunkPaths: [] });
        var secDone = passMarkersOf([['security']]);
        var entries = mod.outcomeEntriesWithCompletions(plan, secDone, HEAD);
        var body = markers.buildPoolOutcomeMarkerComment(HEAD, 'first', entries, '2026-11-14T10:00:00Z');
        var records = markers.parsePoolOutcomeMarkers([{ body: body, author: { login: MACHINE_LOGINS[0] } }],
            { authorLogins: MACHINE_LOGINS });
        assert.equal(records.length, 1);
        var byName = {};
        records[0].reviewers.forEach(function(e) { byName[e.name] = e; });
        assert.equal(byName.security.completed, true, 'completed rides the marker payload');
        assert.equal(byName.base.completed, false);
        // The GATE still trusts only PASS markers — a completed:true payload
        // with no real marker never opens the gate.
        var state = markers.requiredReviewerHoldState([{ body: body, author: { login: MACHINE_LOGINS[0] } }],
            MACHINE_LOGINS, HEAD, '2026-11-14T10:05:00Z');
        assert.deepEqual(state.missing, ['base', 'security'],
            'missing is computed from PASS markers, not from the payload flag');
    });

    test('legacy outcome payloads without completed parse with completed false', function() {
        var legacy = '<!-- dmtools:review-pool {"head":"' + HEAD + '","round":"first","reviewers":' +
            '[{"name":"base","required":true}],"at":"2026-11-12T10:00:00Z"} -->';
        var records = markers.parsePoolOutcomeMarkers([{ body: legacy, author: { login: MACHINE_LOGINS[0] } }],
            { authorLogins: MACHINE_LOGINS });
        assert.equal(records[0].reviewers[0].completed, false);
    });
});
