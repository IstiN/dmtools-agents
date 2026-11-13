/**
 * Unit tests for js/common/reviewPoolMarkers.js — the gh-1406 §7 marker
 * family: head-carried PASS markers, the round's pool-outcome marker, the
 * required-reviewer merge gate state (gaps + hold records).
 *
 * The trust rule under test: records parse ONLY from machine identities
 * (the machineAuthor allowlist, fail closed) — an empty allowlist trusts
 * nothing, so a forged PASS marker can never satisfy the gate.
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
    makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {});
var mod = loadModule('js/common/reviewPoolMarkers.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});

var MACHINE_LOGINS = ['dmtools-machine[bot]'];

function commentOf(body, author) {
    return { body: body, author: { login: author || MACHINE_LOGINS[0] } };
}

var HEAD = '4a6756f73d0ae9b72788db7ad229fc9754dc51b5';
var HEAD_PREFIX = '4a6756f';

suite('reviewPoolMarkers — PASS markers (§7 completions)', function() {

    test('build → parse round-trip; the marker is head-carried and reviewer-attributed', function() {
        var body = mod.buildPassMarkerComment('security', HEAD, '2026-11-12T10:00:00Z');
        assert.ok(body.indexOf('dmtools:review-pass') !== -1);
        assert.ok(body.indexOf('"reviewer":"security"') !== -1);
        assert.ok(body.indexOf(HEAD) !== -1);
        var markers = mod.parsePassMarkers([commentOf(body)], { authorLogins: MACHINE_LOGINS });
        assert.equal(markers.length, 1);
        assert.equal(markers[0].reviewer, 'security');
        assert.equal(markers[0].head, HEAD);
        assert.equal(mod.hasCompletedOnHead(markers, 'security', HEAD_PREFIX), true,
            'prefix sha equality counts (the shared >=7-char head rule)');
        assert.equal(mod.hasCompletedOnHead(markers, 'base', HEAD), false);
        assert.equal(mod.hasCompletedOnHead(markers, 'security', 'deadbeef'), false);
    });

    test('fail closed: an empty machineAuthor allowlist trusts NO PASS markers', function() {
        var body = mod.buildPassMarkerComment('security', HEAD, '2026-11-12T10:00:00Z');
        assert.deepEqual(mod.parsePassMarkers([commentOf(body, 'attacker')], { authorLogins: [] }), []);
        assert.deepEqual(mod.parsePassMarkers([commentOf(body)], {}), []);
        assert.deepEqual(mod.parsePassMarkers([commentOf(body)], null), []);
    });

    test('garbage and foreign markers never parse into records', function() {
        var junk = [
            commentOf('<!-- dmtools:review-pass {"reviewer":"security"} -->'),
            commentOf('<!-- dmtools:review-pass not json -->'),
            commentOf('<!-- dmtools:merge-hold {"reason":"open-threads","head":"' + HEAD + '"} -->')
        ];
        assert.deepEqual(mod.parsePassMarkers(junk, { authorLogins: MACHINE_LOGINS }), [],
            'headless / unparseable / foreign-family markers never become PASS records');
    });

    test('a marker without a head sha is ignored (headless records cannot gate)', function() {
        var body = '<!-- dmtools:review-pass {"reviewer":"security","at":"2026-01-01"} -->';
        assert.deepEqual(mod.parsePassMarkers([commentOf(body)], { authorLogins: MACHINE_LOGINS }), []);
    });
});

suite('reviewPoolMarkers — pool-outcome markers (§7 expectations)', function() {

    test('build → parse round-trip; entries normalize to {name, required}', function() {
        var entries = [{ name: 'base', required: true, completed: true }, { name: 'security', required: true }];
        var body = mod.buildPoolOutcomeMarkerComment(HEAD, 'first', entries, '2026-11-12T11:00:00Z');
        assert.ok(body.indexOf('dmtools:review-pool') !== -1);
        var records = mod.parsePoolOutcomeMarkers([commentOf(body)], { authorLogins: MACHINE_LOGINS });
        assert.equal(records.length, 1);
        assert.equal(records[0].round, 'first');
        assert.equal(records[0].head, HEAD);
        assert.deepEqual(records[0].reviewers, [
            { name: 'base', required: true },
            { name: 'security', required: true }
        ], 'completed is informational — the gate reads PASS markers');
    });

    test('newestPoolOutcomeForHead: head-scoped newest record wins; other heads invisible', function() {
        var oldHead = '1111111111111111111111111111111111111111';
        var b1 = mod.buildPoolOutcomeMarkerComment(oldHead, 'first', [{ name: 'base', required: true }], '2026-11-12T10:00:00Z');
        var b2 = mod.buildPoolOutcomeMarkerComment(HEAD, 'rework', [{ name: 'base', required: true }, { name: 'security', required: true }], '2026-11-12T12:00:00Z');
        var records = mod.parsePoolOutcomeMarkers([commentOf(b1), commentOf(b2)], { authorLogins: MACHINE_LOGINS });
        var newest = mod.newestPoolOutcomeForHead(records, HEAD);
        assert.equal(newest.round, 'rework');
        assert.equal(mod.newestPoolOutcomeForHead(records, '2222222222222222222222222222222222222222'), null);
    });

    test('fail closed: pool outcomes from non-machine authors are invisible', function() {
        var body = mod.buildPoolOutcomeMarkerComment(HEAD, 'first', [{ name: 'base', required: true }], '2026-11-12T11:00:00Z');
        assert.deepEqual(mod.parsePoolOutcomeMarkers([commentOf(body, 'attacker')], { authorLogins: MACHINE_LOGINS }), []);
    });
});

suite('reviewPoolMarkers — the required-reviewer gate state (§7)', function() {

    function commentsFor(outcomeEntries, passNames) {
        var list = [];
        list.push(commentOf(mod.buildPoolOutcomeMarkerComment(HEAD, 'first', outcomeEntries, '2026-11-12T11:00:00Z')));
        for (var i = 0; i < (passNames || []).length; i++) {
            list.push(commentOf(mod.buildPassMarkerComment(passNames[i], HEAD, '2026-11-12T11:05:00Z')));
        }
        return list;
    }

    test('every required reviewer with a same-head PASS marker → no gaps', function() {
        var state = mod.requiredReviewerHoldState(
            commentsFor([{ name: 'base', required: true }, { name: 'security', required: true }], ['base', 'security']),
            MACHINE_LOGINS, HEAD, '2026-11-12T12:00:00Z');
        assert.equal(state.applicable, true);
        assert.deepEqual(state.missing, []);
        assert.equal(state.hold, null);
    });

    test('the 429 scenario: base passed, security did not → the gap names security', function() {
        var state = mod.requiredReviewerHoldState(
            commentsFor([{ name: 'base', required: true }, { name: 'security', required: true }], ['base']),
            MACHINE_LOGINS, HEAD, '2026-11-12T12:00:00Z');
        assert.deepEqual(state.missing, ['security']);
    });

    test('a PASS on an OLD head does not satisfy the current head (old-head passes never count)', function() {
        var list = commentsFor([{ name: 'security', required: true }], []);
        list.push(commentOf(mod.buildPassMarkerComment('security', '1111111111111111111111111111111111111111', '2026-11-12T10:00:00Z')));
        var state = mod.requiredReviewerHoldState(list, MACHINE_LOGINS, HEAD, '2026-11-12T12:00:00Z');
        assert.deepEqual(state.missing, ['security']);
    });

    test('optional reviewers never gate: only required entries produce gaps', function() {
        var state = mod.requiredReviewerHoldState(
            commentsFor([{ name: 'base', required: true }, { name: 'legal', required: false }], ['base']),
            MACHINE_LOGINS, HEAD, '2026-11-12T12:00:00Z');
        assert.deepEqual(state.missing, []);
    });

    test('no pool outcome on this head → not applicable (legacy single-leg PRs proceed)', function() {
        var oldHead = '1111111111111111111111111111111111111111';
        var list = [commentOf(mod.buildPoolOutcomeMarkerComment(oldHead, 'first', [{ name: 'base', required: true }], '2026-11-12T10:00:00Z'))];
        var state = mod.requiredReviewerHoldState(list, MACHINE_LOGINS, HEAD, '2026-11-12T12:00:00Z');
        assert.equal(state.applicable, false);
        assert.deepEqual(state.missing, []);
        assert.deepEqual(mod.requiredReviewerHoldState([], MACHINE_LOGINS, HEAD, '2026-11-12T12:00:00Z').applicable, false);
    });

    test('forged markers from non-machine authors never create an applicable state', function() {
        var body = mod.buildPoolOutcomeMarkerComment(HEAD, 'first', [{ name: 'base', required: true }], '2026-11-12T11:00:00Z');
        var state = mod.requiredReviewerHoldState([commentOf(body, 'attacker')], MACHINE_LOGINS, HEAD, '2026-11-12T12:00:00Z');
        assert.equal(state.applicable, false);
    });

    test('hold round-trip: the required-reviewer hold parses; other reasons are invisible', function() {
        var hold = mod.buildRequiredReviewerHoldMarker(['security'], HEAD, '2026-11-12T12:00:00Z', false, null);
        assert.ok(hold.indexOf('dmtools:merge-hold') !== -1);
        assert.ok(hold.indexOf('required-reviewer') !== -1);
        var holds = mod.parseRequiredReviewerHolds([commentOf(hold)], { authorLogins: MACHINE_LOGINS });
        assert.equal(holds.length, 1);
        assert.deepEqual(holds[0].missing, ['security']);
        assert.equal(holds[0].escalated, false);
        var other = '<!-- dmtools:merge-hold {"reason":"open-threads","total":1,"head":"' + HEAD + '","at":"2026-11-12T12:00:00Z"} -->';
        assert.deepEqual(mod.parseRequiredReviewerHolds([commentOf(other)], { authorLogins: MACHINE_LOGINS }), [],
            'open-threads holds stay a separate dedup budget');
    });

    test('the state surfaces an existing same-head hold (the dedup + escalation key)', function() {
        var list = commentsFor([{ name: 'security', required: true }], []);
        list.push(commentOf(mod.buildRequiredReviewerHoldMarker(['security'], HEAD, '2026-11-12T11:30:00Z', false, null)));
        var state = mod.requiredReviewerHoldState(list, MACHINE_LOGINS, HEAD, '2026-11-12T12:00:00Z');
        assert.deepEqual(state.missing, ['security']);
        assert.ok(state.hold, 'the existing hold is found for dedup');
        assert.equal(state.hold.at, '2026-11-12T11:30:00Z');
    });

    test('escalated hold carries the escalation flag through the round-trip', function() {
        var escalated = mod.buildRequiredReviewerHoldMarker(['security'], HEAD, '2026-11-12T18:00:00Z', true, '2026-11-12T11:30:00Z');
        assert.ok(escalated.indexOf('ESCALATED') !== -1);
        var holds = mod.parseRequiredReviewerHolds([commentOf(escalated)], { authorLogins: MACHINE_LOGINS });
        assert.equal(holds[0].escalated, true);
        assert.equal(holds[0].at, '2026-11-12T18:00:00Z');
    });

    test('pool-outcome entries without a name are skipped (normalization drops anonymous rows)', function() {
        var raw = '<!-- dmtools:review-pool {"head":"' + HEAD + '","round":"first",' +
            '"reviewers":[{"required":true},{"name":"security","required":true}],"at":"2026-11-12T12:00:00Z"} -->';
        var records = mod.parsePoolOutcomeMarkers([commentOf(raw)], { authorLogins: MACHINE_LOGINS });
        assert.equal(records.length, 1, 'the nameless entry does not invalidate the record');
        assert.deepEqual(records[0].reviewers, [{ name: 'security', required: true }]);
    });
});
