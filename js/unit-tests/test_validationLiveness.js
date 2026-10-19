/**
 * Unit tests for js/common/validationLiveness.js — the arm-must-mean-a-
 * live-run state machine (gh-821).
 *
 * Bug (fa PR #1443, 2026-10-09): the dispatched validation run concluded
 * CANCELLED while the ai_validating arm stayed on; the stale-arm sweeper
 * had no liveness vocabulary beyond verdict/no-verdict, so the arm kept
 * holding the serial merge-window mutex with NO live run behind it and
 * four validated PRs deferred ~2h until a manual dispatch.
 *
 * Coverage (ticket test plan L1 — the liveness state machine):
 *   running          — in-flight, or concluded inside the check-visibility
 *                      grace (fresh cancellations are NOT zombies — gh-755
 *                      and the rerun-cancelled-checks remedy own them)
 *   green / red      — verdict paths, unchanged consumption
 *   zombie-cancelled — concluded CANCELLED past every grace
 *   zombie-no-run    — no dispatched run on the head at all (lost dispatch)
 *   fail-safe        — degraded/absent probes classify 'running' (a missed
 *                      recovery retries next tick; never a wrongful churn)
 *   zombie marks     — the marker-comment carrier: per-head counts for the
 *                      crash-loop cap (3 in a row ⇒ park) and the newest
 *                      marker timestamp for the 1/head/hour rate bound
 *
 * Pure module — no tool globals; loadModule with no mocks.
 */

var assert = globalThis.assert;

var live = loadModule('js/common/validationLiveness.js', makeRequire({}), {});

var HEAD = '23dacd10deadbeefcafe0123456789abcdef0123';
var OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
var HOUR_MS = 60 * 60 * 1000;

// ── classify: the liveness state machine ─────────────────────────────────────

suite('validationLiveness classify — running', function () {
    test('an active run is running (AC3 — the healthy flow holds the mutex)', function () {
        assert.equal(live.classify({ active: true, newest: { status: 'in_progress', head_sha: HEAD } }),
            'running');
        assert.equal(live.classify({ active: true, newest: { status: 'queued', head_sha: HEAD } }),
            'running');
    });

    test('a FRESH cancellation (inside the 15-min visibility grace) is still running, never a zombie', function () {
        // hasActiveDispatchedRun counts a completed run active for 15 min
        // after its conclusion — a fresh cancel sits in the gh-755 /
        // rerun-cancelled-checks race window and must not re-dispatch.
        var t = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        assert.equal(
            live.classify({ active: true, newest: { status: 'completed', conclusion: 'cancelled',
                head_sha: HEAD, created_at: t, updated_at: t } }),
            'running');
    });

    test('degraded shapes fail safe: no probe at all → running (arm stays, retry next tick)', function () {
        assert.equal(live.classify(null), 'running');
        assert.equal(live.classify({ active: false, newest: { status: 'queued', head_sha: HEAD } }),
            'running');
        assert.equal(live.classify({ active: false, newest: { status: 'completed', conclusion: null, head_sha: HEAD } }),
            'running');
    });

    test('a truthy probe with NO facets reads as zombie-no-run (deliberate gh-821 bias)', function () {
        // The realistic degraded shape from probeDispatchedState is
        // { active: false, newest: null } — every helper fails CLOSED — and
        // that IS the lost-dispatch zombie. A wedged arm is the worse failure
        // mode; a wrongful re-dispatch is bounded (1/head/hour).
        assert.equal(live.classify({}), 'zombie-no-run');
    });
});

suite('validationLiveness classify — verdicts (unchanged paths)', function () {
    test('newest concluded success → green (the sweep latches)', function () {
        assert.equal(
            live.classify({ active: false, verdict: 'success',
                newest: { status: 'completed', conclusion: 'success', head_sha: HEAD } }),
            'green');
    });

    test('newest concluded failure → red (the standard fail path owns it)', function () {
        assert.equal(
            live.classify({ active: false, verdict: 'failure',
                newest: { status: 'completed', conclusion: 'failure', head_sha: HEAD } }),
            'red');
        assert.equal(
            live.classify({ active: false,
                newest: { status: 'completed', conclusion: 'timed_out', head_sha: HEAD } }),
            'red');
    });
});

suite('validationLiveness classify — zombies (gh-821)', function () {
    test('a STALE cancellation (past every grace) is zombie-cancelled', function () {
        // The #1443 shape: the run died cancelled 2h ago; active=false.
        var t = new Date(Date.now() - 2 * HOUR_MS).toISOString();
        assert.equal(
            live.classify({ active: false, newest: { status: 'completed', conclusion: 'cancelled',
                head_sha: HEAD, created_at: t, updated_at: t } }),
            'zombie-cancelled');
    });

    test('no dispatched run on the head at all is zombie-no-run (lost dispatch)', function () {
        assert.equal(live.classify({ active: false, newest: null }), 'zombie-no-run');
    });

    test('green/red NEVER classify as zombie regardless of age', function () {
        assert.equal(
            live.classify({ active: false,
                newest: { status: 'completed', conclusion: 'success', head_sha: HEAD } }),
            'green');
        assert.equal(
            live.classify({ active: false,
                newest: { status: 'completed', conclusion: 'failure', head_sha: HEAD } }),
            'red');
    });
});

// ── zombie marks: the durable per-head bookkeeping ──────────────────────────

suite('validationLiveness zombie markers', function () {
    test('zombieMarkerLine round-trips through the marker regex and zombieMarks', function () {
        var line = live.zombieMarkerLine(2, HEAD, 3, '2026-10-09T14:00:00.000Z');
        assert.ok(line.indexOf('zombie re-dispatch') !== -1, 'the marker names the operation');
        var marks = live.zombieMarks([line]);
        assert.equal(marks[HEAD].count, 2, 'the count is parseable back');
        assert.equal(marks[HEAD].lastAtMs, Date.parse('2026-10-09T14:00:00.000Z'),
            'the timestamp is parseable back');
    });

    test('count takes the MAX N and lastAtMs the NEWEST stamp across comments (per head)', function () {
        var bodies = [
            live.zombieMarkerLine(1, HEAD, 3, '2026-10-09T14:00:00.000Z'),
            'unrelated chatter 🔄 zombie re-dispatch not-a-marker',
            live.zombieMarkerLine(2, HEAD, 3, '2026-10-09T15:00:00.000Z')
        ];
        var marks = live.zombieMarks(bodies);
        assert.equal(marks[HEAD].count, 2);
        assert.equal(marks[HEAD].lastAtMs, Date.parse('2026-10-09T15:00:00.000Z'));
    });

    test('markers for OTHER heads are ignored — a head move resets the count by construction', function () {
        var bodies = [
            live.zombieMarkerLine(3, OTHER, 3, '2026-10-09T14:00:00.000Z')
        ];
        var marks = live.zombieMarks(bodies);
        assert.equal(marks[OTHER].count, 3, 'the other head keeps its count');
        assert.equal(marks[HEAD], undefined, 'THIS head has none — fresh count');
    });

    test('empty/garbage input degrades to an empty map (no wedges)', function () {
        assert.deepEqual(live.zombieMarks([]), {});
        assert.deepEqual(live.zombieMarks(null), {});
        assert.deepEqual(live.zombieMarks(['', 'no markers here']), {});
    });

    test('an unparsable timestamp degrades to lastAtMs null but keeps the count', function () {
        var line = '🔄 zombie re-dispatch ' + HEAD + ' — zombie 1/3 at not-a-date';
        var marks = live.zombieMarks([line]);
        assert.equal(marks[HEAD].count, 1, 'the crash-loop cap reads the count');
        assert.equal(marks[HEAD].lastAtMs, null, 'the rate bound cannot fire — bounded churn, not a wedge');
    });
});

suite('validationLiveness stale-cancel markers (gh-846)', function () {
    test('staleCancelMarkerLine round-trips through the marker regex', function () {
        var line = live.staleCancelMarkerLine(HEAD, '2026-10-10T18:39:00.000Z');
        assert.ok(line.indexOf('stale-cancel') !== -1, 'the marker names the operation');
        var re = new RegExp(live.STALE_CANCEL_MARKER_RE.source);
        var m = re.exec(line);
        assert.ok(m, 'parseable by the marker regex');
        assert.equal(m[1], HEAD, 'the head sha is parseable back');
        assert.equal(m[2], '2026-10-10T18:39:00.000Z', 'the timestamp is parseable back');
    });

    test('a stale-cancel line never parses as a zombie or red-head marker', function () {
        // gh-755 parity: the bookkeeping must not feed verdict machinery.
        var line = live.staleCancelMarkerLine(HEAD, '2026-10-10T18:39:00.000Z');
        assert.deepEqual(live.zombieMarks([line]), {}, 'not a zombie re-dispatch count');
    });
});

suite('validationLiveness ghost-guard markers (gh-848)', function () {
    test('defer + clean marker lines round-trip through the marks parser, keyed by head', function () {
        var defer = live.ghostGuardDeferMarkerLine(HEAD, 7101, '2026-10-10T21:40:05.000Z');
        var clean = live.ghostGuardCleanMarkerLine(HEAD, 2, '2026-10-10T21:41:12.000Z');
        assert.ok(defer.indexOf('ghost-guard defer') !== -1, 'the defer names the operation');
        assert.ok(clean.indexOf('ghost-guard clean') !== -1, 'the clean names the operation');
        var marks = live.ghostGuardMarks([defer + '\n' + clean]);
        assert.ok(marks.deferred[HEAD] !== undefined, 'the defer is keyed by head');
        assert.ok(marks.cleaned[HEAD] !== undefined, 'the clean is keyed by head');
        assert.equal(marks.deferred[OTHER], undefined, 'other heads untouched');
        assert.equal(marks.cleaned[OTHER], undefined);
    });

    test('the newest timestamp wins per head; heads stay separate', function () {
        var d1 = live.ghostGuardDeferMarkerLine(HEAD, 7101, '2026-10-10T21:40:05.000Z');
        var d2 = live.ghostGuardDeferMarkerLine(HEAD, 7101, '2026-10-10T21:45:09.000Z');
        var d3 = live.ghostGuardDeferMarkerLine(OTHER, 7201, '2026-10-10T21:42:00.000Z');
        var marks = live.ghostGuardMarks([d1, 'noise', d2, d3]);
        assert.equal(marks.deferred[HEAD], Date.parse('2026-10-10T21:45:09.000Z'),
            'newest marker wins for the head');
        assert.equal(marks.deferred[OTHER], Date.parse('2026-10-10T21:42:00.000Z'));
    });

    test('ghost-guard lines never parse as zombie or stale-cancel markers (gh-755 parity)', function () {
        var defer = live.ghostGuardDeferMarkerLine(HEAD, 7101, '2026-10-10T21:40:05.000Z');
        var clean = live.ghostGuardCleanMarkerLine(HEAD, 1, '2026-10-10T21:41:12.000Z');
        assert.deepEqual(live.zombieMarks([defer, clean]), {}, 'not a zombie re-dispatch count');
        var re = new RegExp(live.STALE_CANCEL_MARKER_RE.source);
        assert.ok(!re.exec(defer) && !re.exec(clean), 'not a stale-cancel marker');
    });

    test('unparsable timestamps degrade to absent entries (the poster re-posts rather than swallow)', function () {
        var marks = live.ghostGuardMarks(
            ['⏸ ghost-guard defer ' + HEAD + ' — run 7101 still queued at garbage']);
        assert.deepEqual(marks.deferred, {}, 'no epoch ms — dedupe cannot fire');
        assert.deepEqual(marks.cleaned, {});
    });
});

suite('validationLiveness knobs', function () {
    test('defaults: cap 3, window 1h (gh-821: 3 in a row ⇒ park, 1/head/hour)', function () {
        assert.equal(live.zombieCapOf({}), 3);
        assert.equal(live.zombieCapOf(undefined), 3);
        assert.equal(live.zombieWindowMsOf({}), HOUR_MS);
        assert.equal(live.zombieWindowMsOf(undefined), HOUR_MS);
    });

    test('deployment overrides (number or numeric string)', function () {
        assert.equal(live.zombieCapOf({ zombieRedispatchCap: 5 }), 5);
        assert.equal(live.zombieCapOf({ zombieRedispatchCap: '4' }), 4);
        assert.equal(live.zombieWindowMsOf({ zombieRedispatchMinMs: 1800000 }), 1800000);
        assert.equal(live.zombieWindowMsOf({ zombieRedispatchMinMs: '0' }), 0, '0 disables the bound');
        assert.equal(live.zombieWindowMsOf({ zombieRedispatchMinMs: -5 }), HOUR_MS, 'garbage → default');
    });
});

suite('validationLiveness ACTIVE_RUN_STATES (gh-821 round-2 review)', function () {
    // The exported constant is the SINGLE SOURCE OF TRUTH for the "a run is
    // materially in flight" vocabulary: smAgent's hasActiveDispatchedRun and
    // hasActiveHeadRun consume it (gh-821 round-2 review — an unused exported
    // parity constant invited drift exactly where parity is the point). This
    // pin freezes the contract: GitHub's four non-concluded run states.
    test('the vocabulary is exactly GitHub\'s four in-flight run states', function () {
        assert.deepEqual(live.ACTIVE_RUN_STATES, ['queued', 'in_progress', 'waiting', 'pending']);
    });

    test('no concluded state leaks into the active vocabulary', function () {
        assert.equal(live.ACTIVE_RUN_STATES.indexOf('completed'), -1,
            'completed is a conclusion carrier, never "in flight"');
        assert.equal(live.ACTIVE_RUN_STATES.indexOf('cancelled'), -1);
        assert.equal(live.ACTIVE_RUN_STATES.indexOf('success'), -1);
    });
});

suite('validationLiveness silent-update failure markers (gh-1000 bookkeeping)', function () {
    var MARK = '⚠️ silent-update failure — attempt ';

    test('no markers → zero count, no timestamp', function () {
        var out = live.silentUpdateFailureCount(['ordinary comment', { body: 'nothing here' }, null]);
        assert.deepEqual(out, { count: 0, newest: null });
        assert.deepEqual(live.silentUpdateFailureCount(null), { count: 0, newest: null });
    });

    test('strings, bodies and texts all scan; highest attempt + newest ISO win', function () {
        var out = live.silentUpdateFailureCount([
            MARK + '1 at 2026-10-17T19:00:00Z',
            { body: MARK + '3 at 2026-10-17T19:20:00Z trailing' },
            { text: MARK + '2 at 2026-10-17T19:10:00Z' }
        ]);
        assert.deepEqual(out, { count: 3, newest: '2026-10-17T19:20:00Z' });
    });

    test('two markers in one body both count', function () {
        var body = MARK + '1 at 2026-10-17T19:00:00Z\n' + MARK + '2 at 2026-10-17T19:05:00Z';
        var out = live.silentUpdateFailureCount([{ body: body }]);
        assert.deepEqual(out, { count: 2, newest: '2026-10-17T19:05:00Z' });
    });

    test('attemptsLeft: 3 max, clamps at 0, garbage counts as 0', function () {
        assert.equal(live.silentUpdateAttemptsLeft(0), 3);
        assert.equal(live.silentUpdateAttemptsLeft(2), 1);
        assert.equal(live.silentUpdateAttemptsLeft(3), 0);
        assert.equal(live.silentUpdateAttemptsLeft(9), 0);
        assert.equal(live.silentUpdateAttemptsLeft('junk'), 3);
    });

    test('failureLine renders the exact marker the counter scans (round-trip)', function () {
        var line = live.silentUpdateFailureLine(2, '2026-10-17T19:10:00Z');
        var out = live.silentUpdateFailureCount([line]);
        assert.deepEqual(out, { count: 2, newest: '2026-10-17T19:10:00Z' });
    });
});

// ── gh-1070: fork-aware silent-update routing ────────────────────────────────
// Live fa PR #1591 (YuryBY fork): silent-update pushed against the BASE repo
// for a fork head 3× and flagged silent-update-degraded, then the gh-757
// guest park waited on the human author. GitHub already grants the base
// token a push to the fork's PR branch when maintainer edits are allowed
// (probe: maintainer_can_modify). Pure dispatch — three paths (UT-1), the
// fork push URL (UT-2), zero same-repo drift (AC4).

suite('validationLiveness fork-aware silent-update routing (gh-1070)', function () {

    test('UT-1: probe routing — editable fork / non-editable fork / same-repo → three distinct paths', function () {
        // editable fork → the machine refreshes the fork head itself (AC1)
        assert.deepEqual(
            live.forkSilentUpdateRoute('forko/forkr', 'epam', 'base', true),
            { route: 'fork', forkFull: 'forko/forkr' });
        // non-editable fork → guest park, NO silent-update attempt (AC2)
        assert.deepEqual(
            live.forkSilentUpdateRoute('forko/forkr', 'epam', 'base', false),
            { route: 'park', forkFull: 'forko/forkr' });
        // same-repo → the untouched base-repush path (AC4)
        assert.deepEqual(
            live.forkSilentUpdateRoute('epam/base', 'epam', 'base', false),
            { route: 'base', forkFull: null });
    });

    test('UT-1: an UNKNOWN probe on a fork fails closed to the park path (never an unprobed attempt)', function () {
        assert.equal(
            live.forkSilentUpdateRoute('forko/forkr', 'epam', 'base', null).route, 'park');
        assert.equal(
            live.forkSilentUpdateRoute('forko/forkr', 'epam', 'base', undefined).route, 'park');
    });

    test('forkHeadFull: only a well-formed FOREIGN full name resolves to a fork', function () {
        assert.equal(live.forkHeadFull('forko/forkr', 'epam', 'base'), 'forko/forkr');
        assert.equal(live.forkHeadFull('epam/base', 'epam', 'base'), null, 'same-repo is not a fork');
        assert.equal(live.forkHeadFull('', 'epam', 'base'), null, 'missing headRepo (legacy payload) is not a fork');
        assert.equal(live.forkHeadFull(null, 'epam', 'base'), null, 'deleted fork (null head.repo) is not a fork');
        assert.equal(live.forkHeadFull('noslash', 'epam', 'base'), null, 'a repo name without owner is malformed');
        // a same-repo verdict never consults the probe: false MUST NOT
        // reroute a base head into the park path (AC4)
        assert.equal(live.forkSilentUpdateRoute(null, 'epam', 'base', false).route, 'base');
    });

    test('forkHeadFull: the same-repo comparison is CASE-INSENSITIVE (config vs API casing drift)', function () {
        // The base side comes from config (effectiveRepoInfo.owner/repo),
        // headRepoFull from the API's head.repo.full_name — GitHub repo
        // names are case-insensitive, so a casing drift between the two
        // must NOT classify a same-repo PR as a fork (a false guest park
        // when maintainer_can_modify=false, the silent misroute class
        // gh-1059 eliminated).
        assert.equal(live.forkHeadFull('IstiN/dmtools-agents', 'istin', 'dmtools-agents'), null,
            'casing drift on the SAME repo is not a fork');
        assert.equal(live.forkSilentUpdateRoute('IstiN/dmtools-agents', 'istin', 'dmtools-agents', false).route,
            'base', 'route base — NEVER the park path for a same-repo head');
        assert.equal(live.forkSilentUpdateRoute('IstiN/dmtools-agents', 'istin', 'dmtools-agents', true).route,
            'base', 'route base — even an editable probe does not reroute a same-repo head');
        assert.equal(live.forkHeadFull('ISTIN/DMTOOLS-AGENTS', 'istin', 'dmtools-agents'), null,
            'all-caps drift is still the same repo');
        // a GENUINE fork still resolves, preserving its own casing for the push URL
        assert.equal(live.forkHeadFull('Forko/ForkR', 'epam', 'base'), 'Forko/ForkR',
            'a real fork keeps its canonical casing');
        assert.equal(live.forkSilentUpdateRoute('Forko/ForkR', 'EPAM', 'BASE', true).forkFull,
            'Forko/ForkR', 'the fork push target carries the fork\'s own casing');
    });

    test('UT-2: the fork push URL is built from head.repo.full_name and never targets the base', function () {
        var url = live.forkPushTokenUrl('forko/forkr');
        assert.equal(url,
            'https://x-access-token:${GH_TOKEN}@github.com/forko/forkr.git');
        assert.notOk(url.indexOf('epam/base') !== -1, 'the base repo is never the push target');
        assert.ok(url.indexOf('${GH_TOKEN}') !== -1, 'the token rides the child env, never the source');
    });
});

// ── gh-1074: failure-surface stderr tail ─────────────────────────────────────
// Live fa PR #1591: the fork silent-update push failed 3× and the run log
// preserved only the BEGINNING of stderr ("Cloning into '…' / Updating
// files: N%") — cli_execute_command's exception embeds the output head,
// while git writes the decisive rejection ("remote: error: …",
// "! [remote rejected] HEAD:branch (reason)") at the END. The silent-update
// chain now tees its stderr to a side file; these helpers turn the capture
// into the failure surface: the propagated error (UT-1), the one-line
// rejection reason on the marker comment (UT-2/AC2), and the same secrets
// hygiene the command line gets (UT-3/AC3).

suite('validationLiveness silent-update stderr tail (gh-1074)', function () {

    function longStderr(lines) {
        var out = [];
        for (var i = 1; i <= lines; i++) out.push('Updating files: ' + i + '%');
        out.push("remote: error: GH006: Protected branch update failed for refs/heads/ai/gh-1591");
        out.push('To https://github.com/YuryBY/dmtools-dart.git');
        out.push(' ! [remote rejected] HEAD:ai/gh-1591 (protected branch hook declined)');
        out.push("error: failed to push some refs to 'https://github.com/YuryBY/dmtools-dart.git'");
        return out.join('\n') + '\n';
    }

    test('UT-1: silentUpdateStderrTail keeps the LAST ~20 lines of a long stderr, not the head', function () {
        var tail = live.silentUpdateStderrTail(longStderr(60));
        var tailLines = tail.split('\n');
        assert.equal(tailLines.length, 20, 'bounded to the last 20 lines');
        assert.ok(tail.indexOf('Updating files: 1%') === -1, 'the head progress is dropped');
        assert.ok(tail.indexOf('Updating files: 41%') === -1, 'lines older than the window are dropped');
        assert.ok(tail.indexOf('[remote rejected] HEAD:ai/gh-1591 (protected branch hook declined)') !== -1,
            'the decisive rejection at the END is preserved');
        assert.ok(tail.indexOf('Updating files: 60%') !== -1, 'the window boundary line is preserved');
    });

    test('silentUpdateStderrTail: short stderr passes through whole; CRLR line-endings normalize; empty → empty', function () {
        assert.equal(live.silentUpdateStderrTail('only\nthree\nlines\n'), 'only\nthree\nlines');
        assert.equal(live.silentUpdateStderrTail('a\r\nb\r\nc'), 'a\nb\nc');
        assert.equal(live.silentUpdateStderrTail(''), '');
        assert.equal(live.silentUpdateStderrTail(null), '');
        assert.equal(live.silentUpdateStderrTail('x\ny', 1), 'y', 'maxLines overrides the default');
    });

    test('UT-2: silentUpdateRejectionReason extracts the [remote rejected] … (reason) fragment', function () {
        var reason = live.silentUpdateRejectionReason(live.silentUpdateStderrTail(longStderr(60)));
        assert.ok(reason.indexOf('[remote rejected]') !== -1, 'the rejection fragment is found');
        assert.ok(reason.indexOf('(protected branch hook declined)') !== -1, 'the reason parenthetical is kept');
        assert.ok(reason.indexOf('\n') === -1, 'one line');
    });

    test('UT-2: the remote: error line is the fallback when no [remote rejected] fragment exists', function () {
        var reason = live.silentUpdateRejectionReason('Cloning into x\nremote: error: hook declined the push\n');
        assert.ok(reason.indexOf('remote: error: hook declined the push') !== -1);
        assert.equal(live.silentUpdateRejectionReason('Cloning into x\nUpdating files: 10%\n'), null,
            'a progress-only tail carries no reason');
        assert.equal(live.silentUpdateRejectionReason(null), null);
        assert.equal(live.silentUpdateRejectionReason(''), null);
    });

    test('UT-3: redactSilentUpdateSecrets scrubs the token URL git echoes and token-shaped strings', function () {
        // the token-shaped strings are assembled from split literals: the
        // dev sandbox redacts contiguous token patterns in file writes
        // (the repo's TOK convention — see smAgent's split-literal note)
        var TOK = 'ghp_' + 'Nhz2Q1rN8ZsZv9mR2tK7wX4yP5bH3cD6fG8hJ9k';
        var PAT = 'github' + '_pat_' + '11ABCDEFGH0klmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQR';
        var scrubbed = live.redactSilentUpdateSecrets(
            'To https://x-access-' + 'token:' + TOK + '@github.com/o/r.git\n' +
            'fatal: token ' + TOK + ' leaked in hook output\n' +
            'and a fine-grained ' + PAT + ' too\n');
        assert.ok(scrubbed.indexOf(TOK) === -1, 'the raw token is gone');
        assert.ok(scrubbed.indexOf(PAT) === -1, 'the fine-grained PAT is gone');
        assert.ok(scrubbed.indexOf('x-access-token:[REDACTED]@') !== -1,
            'the token URL collapses to the redacted credential form');
        assert.ok(scrubbed.indexOf('ghp_') === -1, 'the ghp_ token shape is redacted');
        var clean = live.redactSilentUpdateSecrets('remote: error: declined\n');
        assert.equal(clean, 'remote: error: declined\n', 'clean text passes through untouched');
    });

    test('AC2: silentUpdateFailureLine appends the one-line reason and still round-trips through the counter', function () {
        var line = live.silentUpdateFailureLine(2, '2026-10-19T05:51:00Z',
            '[remote rejected] HEAD:ai/gh-1591 (protected branch hook declined)');
        assert.ok(line.indexOf('⚠️ silent-update failure — attempt 2 at 2026-10-19T05:51:00Z') === 0,
            'the marker prefix is unchanged');
        assert.ok(line.indexOf('[remote rejected] HEAD:ai/gh-1591 (protected branch hook declined)') !== -1,
            'the reason rides the same marker line');
        var out = live.silentUpdateFailureCount([line]);
        assert.deepEqual(out, { count: 2, newest: '2026-10-19T05:51:00Z' },
            'the counting regex still parses the extended marker');
        // absent reason → byte-identical to the pre-gh-1074 marker
        assert.equal(live.silentUpdateFailureLine(1, '2026-10-17T19:14:00Z'),
            '⚠️ silent-update failure — attempt 1 at 2026-10-17T19:14:00Z');
        // a multi-line / oversized reason collapses to one bounded line
        var noisy = live.silentUpdateFailureLine(1, '2026-10-19T05:51:00Z', 'line one\nline two');
        assert.ok(noisy.indexOf('\n') === -1, 'the marker stays a single line');
    });
});
