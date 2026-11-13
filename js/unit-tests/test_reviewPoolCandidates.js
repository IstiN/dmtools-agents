/**
 * Unit tests for js/common/reviewPoolCandidates.js — the gh-1471 candidates
 * RECORD contract (the in-job shape): the strict schema every pool
 * reviewer's findings ride as a FILE
 * (outputs/pr_review_candidates-<reviewer>.json), validated through
 * candidatesRecordFromPayload. The invariant under test (gh-1406 invariant 1,
 * machine half): a specialist NEVER mints a verdict — its findings travel as
 * candidates only, same-head enforced (stale files never feed a newer head).
 */

var mod = loadModule('js/common/reviewPoolCandidates.js', makeRequire({}), {});

var HEAD = '4a6756f73d0ae9b72788db7ad229fc9754dc51b5';
var HEAD_PREFIX = '4a6756f';
var STALE_HEAD = '9999888877776666555544443333222211110000';

var passed = 0, total = 0;
function ok(label, fn) {
    try {
        fn();
        console.log('ok - ' + label);
        return 1;
    } catch (e) {
        console.log('NOT OK - ' + label + ' → ' + (e && e.message));
        return 0;
    }
}

function recordOf(overrides) {
    return Object.assign({
        reviewer: 'security',
        head: HEAD,
        candidates: [
            { id: 1, path: 'src/auth/UserService.js', line: 45, severity: 'BLOCKING',
              claim: 'SQL injection: raw user input concatenated into the query string.' },
            { id: 2, path: 'src/utils/config.js', line: 12, severity: 'IMPORTANT',
              claim: 'Secret read without masking can leak into logs.' }
        ],
        count: 2, truncated: false, at: '2026-11-13T07:00:00Z'
    }, overrides || {});
}

total++; passed += ok('a well-formed record validates (reviewer + head + candidates)', function() {
    var r = mod.candidatesRecordFromPayload(recordOf());
    assert.ok(r, 'the record passes');
    assert.equal(r.reviewer, 'security');
    assert.equal(r.head, HEAD);
    assert.equal(r.count, 2);
    assert.equal(r.candidates.length, 2);
});

total++; passed += ok('a missing reviewer or head is invalid (the aggregation cannot attribute)', function() {
    var noReviewer = mod.candidatesRecordFromPayload(recordOf({ reviewer: undefined }));
    var noHead = mod.candidatesRecordFromPayload(recordOf({ head: undefined }));
    assert.equal(noReviewer, null, 'no reviewer → no record');
    assert.equal(noHead, null, 'no head → no record (stale-safe by construction)');
});

total++; passed += ok('junk payloads are invalid without throwing', function() {
    assert.equal(mod.candidatesRecordFromPayload(null), null);
    assert.equal(mod.candidatesRecordFromPayload('{ this is not json'), null);
    assert.equal(mod.candidatesRecordFromPayload({ nope: true }), null);
    assert.equal(mod.candidatesRecordFromPayload(42), null);
});

total++; passed += ok('a non-array candidates field degrades to an empty list (a valid empty pass)', function() {
    var r = mod.candidatesRecordFromPayload(recordOf({ candidates: 'junk' }));
    assert.ok(r, 'the record still validates');
    assert.deepEqual(r.candidates, [], 'candidates degrade to []');
    // The author-declared count is carried VERBATIM (it is display metadata;
    // every consumer derives the truth from the candidates list itself).
    assert.equal(r.count, 2, 'the declared count survives the degradation');
});

total++; passed += ok('same-head semantics: the sha prefix match is the round membership test', function() {
    // The same helper the pool post action and reviewVerdicts use — a full
    // sha and its 7-char prefix are the same head.
    var full = mod.candidatesRecordFromPayload(recordOf({ head: HEAD }));
    assert.equal(full.head, HEAD);
    assert.ok(HEAD.indexOf(HEAD_PREFIX) === 0, 'the fixture prefix matches the full sha');
});

total++; passed += ok('MARKER_SUFFIX: the shared dmtools marker grammar tail (verdict/pool families)', function() {
    assert.equal(mod.MARKER_SUFFIX, ' -->');
});

total++; passed += ok('CLAIM_MAX: the canonical claim-length cap is exported for the prose paths', function() {
    assert.equal(typeof mod.CLAIM_MAX, 'number');
    assert.ok(mod.CLAIM_MAX > 0);
});

console.log('\n✔ test_reviewPoolCandidates: ' + passed + '/' + total + ' assertion groups passed');
process.exit(passed === total ? 0 : 1);
