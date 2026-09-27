/**
 * Unit tests for the poisoned-session quarantine in
 * .github/workflows/factory-teammate.yml.
 *
 * RCA (owner, dmd PR-266, 2026-09-27 — correcting the initial Bitrise-pool
 * theory): each cancelled leg's persist step (always()) SAVED the frozen
 * fa session and the next leg's restore step re-loaded it — three
 * consecutive zombie legs resumed the same poisoned state until the
 * fa-sess/<anchor> branch was deleted by hand. A fresh-session control leg
 * succeeded. The quarantine must therefore (a) trigger only when the leg
 * failed/cancelled AND the trace went silent (a failed leg with an active
 * trace keeps its session — it is the next round's context), (b) move the
 * local store aside so the persist step saves nothing, and (c) DELETE the
 * fa-sess/<anchor> branch — otherwise the next leg restores the poison
 * despite (b).
 *
 * Uses: file_read(), suite(), test(), assert
 */

suite('factory-teammate.yml — poisoned fa session quarantine (owner RCA 2026-09-27)', function () {

    var wf = file_read({ path: '.github/workflows/factory-teammate.yml' });
    var q = wf.indexOf('Quarantine poisoned fa session');
    assert.ok(q !== -1, 'quarantine step present');

    test('the Run agent step exposes an id the quarantine can gate on', function () {
        assert.ok(wf.indexOf('Run agent (fa provider via runner env overrides)\n        id: run_agent') !== -1,
            "Run agent carries id: run_agent (steps.run_agent.outcome must be addressable)");
    });

    test('quarantine gates on failure/cancelled of the agent step only', function () {
        assert.ok(wf.indexOf("if: always() && (steps.run_agent.outcome == 'failure' || steps.run_agent.outcome == 'cancelled')") !== -1,
            'fires only when the agent leg itself failed or was cancelled — not on later post-action failures');
    });

    test('a silent trace is the poison marker, with a tunable limit defaulting to 5 min', function () {
        assert.ok(wf.indexOf('FA_TRACE_QUARANTINE_SILENCE_MINUTES:-5') !== -1,
            'silence limit env var with a 5-minute default (healthy fa writes every few seconds)');
        assert.ok(wf.indexOf('age_min=$(( ( $(date +%s) - mtime ) / 60 ))') !== -1,
            'trace mtime age is computed in minutes');
        assert.ok(wf.indexOf('fa trace was active ${age_min} min ago (< ${silence_limit})') !== -1,
            'an ACTIVE trace keeps the session for the retry');
        assert.ok(wf.indexOf('no fa trace — cannot judge session health; leaving the session in place') !== -1,
            'a missing trace is conservative: no quarantine without evidence');
    });

    test('quarantine moves the local store aside AND deletes the fa-sess branch', function () {
        assert.ok(wf.indexOf('mv "${SESS_DIR}" "${QUAR_DIR}"') !== -1,
            'local session store moved out of .dmtools/fa-sessions — the persist step below then early-exits');
        assert.ok(wf.indexOf('git push origin --delete "${FA_SESS_BRANCH}"') !== -1,
            'the fa-sess/<anchor> branch is deleted — without this the next leg restores the poison anyway');
        assert.ok(wf.indexOf('FA-SESSION-QUARANTINE:') !== -1,
            'marker appended to run-output for the SM red-path diagnostics');
    });

    test('the quarantined store ships with the trace artifact', function () {
        assert.ok(wf.indexOf('.dmtools/fa-sessions-quarantine/**') !== -1,
            'artifact upload includes the quarantined session for forensics');
    });

    test('quarantine runs before the trace upload and the persist step', function () {
        var upload = wf.indexOf('Upload the full fa session trace');
        var persist = wf.indexOf('Persist fa session to its git branch');
        assert.ok(q < upload && upload < persist,
            'order: quarantine → artifact upload → persist (persist must find the store already gone)');
    });
});
