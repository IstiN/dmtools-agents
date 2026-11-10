/* Unit tests for js/common/postMergeSweep.js — the gh-1420 post-merge
 * sweep: every merged PR with unresolved machine-authored review threads
 * gets the digest treatment (the gh-1353 ledger identity — pre-merge
 * digests and this sweep converge ONE entry per finding), unresolved human
 * threads list in the same digest as `open (human)`, machine threads
 * resolve with the canonical `defered:` disposition, and re-runs are
 * idempotent (the convergent one-digest-per-PR invariant). The scripted
 * payload mirrors PR #1410: an unresolved machine IMPORTANT thread on a
 * MERGED PR that the merge-time machinery missed. */
/* global loadModule, assert, test, suite, makeRequire */

var mcpParseModule = loadModule('js/common/mcpParse.js', makeRequire({}), {});

// ── memoized module-closure builders (test_mergeGate pattern) ────────────────

var _m = {};
function mMachineAuthor() {
    if (!_m.ma) _m.ma = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    return _m.ma;
}
function mReviewVerdicts() {
    if (!_m.rv) {
        _m.rv = loadModule('js/common/reviewVerdicts.js', makeRequire({
            './machineAuthor.js': mMachineAuthor()
        }), {});
    }
    return _m.rv;
}
function mMachineNotice() {
    if (!_m.mn) _m.mn = loadModule('js/common/machineNotice.js', makeRequire({}), {});
    return _m.mn;
}
function mFindingRegistry() {
    if (!_m.fr) {
        _m.fr = loadModule('js/common/findingRegistry.js', makeRequire({
            './reviewVerdicts.js': mReviewVerdicts()
        }), {});
    }
    return _m.fr;
}
function mLedgerCore() {
    if (!_m.lc) _m.lc = loadModule('js/common/ledgerCore.js', makeRequire({}), {});
    return _m.lc;
}
function mReviewDebtLedger() {
    if (!_m.rdl) {
        _m.rdl = loadModule('js/common/reviewDebtLedger.js', makeRequire({
            './reviewVerdicts.js': mReviewVerdicts(),
            './findingRegistry.js': mFindingRegistry(),
            './ledgerCore.js': mLedgerCore()
        }), {});
    }
    return _m.rdl;
}
function mReviewPolicy() {
    if (!_m.rp) {
        _m.rp = loadModule('js/common/reviewPolicy.js', makeRequire({
            './reviewVerdicts.js': mReviewVerdicts()
        }), {});
    }
    return _m.rp;
}
function mReviewDispositions() {
    if (!_m.rd) {
        _m.rd = loadModule('js/common/reviewDispositions.js', makeRequire({
            './reviewVerdicts.js': mReviewVerdicts(),
            './reviewPolicy.js': mReviewPolicy()
        }), {});
    }
    return _m.rd;
}
function mMergeBackstop() {
    if (!_m.mb) {
        _m.mb = loadModule('js/common/mergeBackstop.js', makeRequire({
            './reviewVerdicts.js': mReviewVerdicts(),
            './findingRegistry.js': mFindingRegistry(),
            './reviewDebtLedger.js': mReviewDebtLedger(),
            './reviewDispositions.js': mReviewDispositions(),
            './reviewPolicy.js': mReviewPolicy(),
            './machineAuthor.js': mMachineAuthor(),
            './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js',
                makeRequire({ './machineNotice.js': mMachineNotice() }), {}),
            './mcpParse.js': mcpParseModule,
            '../configLoader.js': { loadProjectConfig: function () { return null; } }
        }), {});
    }
    return _m.mb;
}
function mPostMergeSweep() {
    if (!_m.ps) {
        _m.ps = loadModule('js/common/postMergeSweep.js', makeRequire({
            './reviewVerdicts.js': mReviewVerdicts(),
            './machineAuthor.js': mMachineAuthor(),
            './machineNotice.js': mMachineNotice(),
            './findingRegistry.js': mFindingRegistry(),
            './reviewDebtLedger.js': mReviewDebtLedger(),
            './reviewDispositions.js': mReviewDispositions(),
            './mergeBackstop.js': mMergeBackstop()
        }), {});
    }
    return _m.ps;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

var BOT = 'merge-bot';
var NOW = '2026-11-12T09:00:00Z';

// A provider thread row (the smProvider.reviewThreadList shape).
function threadRow(id, opts) {
    var r = {
        threadId: id,
        rootCommentId: 9000 + id.length,
        resolved: false,
        author: BOT + '[bot]',
        body: '⚠️ severity: IMPORTANT — nothing validates the merge state token',
        path: 'js/sm/mergeState.js',
        line: 42
    };
    for (var k in (opts || {})) r[k] = opts[k];
    return r;
}

// The PR #1410-shaped payload: ONE unresolved machine-authored IMPORTANT
// thread on a MERGED PR (the gh-1420 test case).
function pr1410Provider(calls, over) {
    var o = over || {};
    return {
        reviewThreadList: function (prNumber) {
            calls.threadReads.push(prNumber);
            if (o.threadsThrow) throw new Error('503');
            return o.threads || [threadRow('PRT_1')];
        },
        prCommentList: function (prNumber) {
            calls.commentReads.push(prNumber);
            if (o.commentsThrow) throw new Error('503');
            return o.comments || [];
        },
        postPrComment: function (prNumber, body) {
            calls.commentsPosted.push({ prNumber: prNumber, body: body });
            return {};
        },
        resolveThread: function (prNumber, thread) {
            if ((o.resolveFailIds || []).indexOf(String(thread.threadId)) !== -1) {
                throw new Error('422 ' + thread.threadId);
            }
            calls.resolves.push({ prNumber: prNumber, threadId: thread.threadId });
            (o.threads || [threadRow('PRT_1')]).forEach(function (t) {
                if (String(t.threadId) === String(thread.threadId)) t.resolved = true;
            });
            return {};
        },
        replyToThread: function (prNumber, thread, text) {
            calls.replies.push({ prNumber: prNumber, threadId: thread.threadId, text: text });
            return {};
        }
    };
}


// The posted comment bodies shaped back as the provider serves them
// (comment OBJECTS — parseMarkerComments reads item.body).
function postedComments(calls) {
    return calls.commentsPosted.map(function (c) {
        return { body: c.body, user: { login: BOT + '[bot]' } };
    });
}

function cfgOf(over) {
    var c = { machineLogins: [BOT, BOT + '[bot]'], owner: 'o', name: 'n', nowIso: NOW };
    for (var k in (over || {})) c[k] = over[k];
    return c;
}

// A pre-existing debt-ledger marker comment (the pre-merge digest the
// convergence invariant must NOT duplicate).
function ledgerCommentBody(findings) {
    var rdl = mReviewDebtLedger();
    var ledger = rdl.emptyLedger();
    (findings || []).forEach(function (f) {
        ledger = rdl.appendDebtFinding(ledger, f);
    });
    return rdl.buildDebtMarker(ledger) + '\n' + rdl.buildDebtDigest(ledger);
}

// ── sweepRowsOf (the classification split) ───────────────────────────────────

suite('postMergeSweep: sweepRowsOf (classification split)', function () {
    var ps = mPostMergeSweep();

    test('unresolved machine vs human split (severity-agnostic — no filter misses debt)', function () {
        var split = ps.sweepRowsOf([
            threadRow('PRT_1'),
            threadRow('PRT_H', { author: 'human-dev', body: 'a human question' }),
            threadRow('PRT_NIT', { body: '🪶 severity: NIT — a nit' }),
            threadRow('PRT_R', { resolved: true }),
            threadRow('PRT_BLOCK', { body: '🚨 severity: BLOCKING — production crash' })
        ], [BOT, BOT + '[bot]']);
        assert.deepEqual(split.machine.map(function (r) { return r.threadId; }),
            ['PRT_1', 'PRT_NIT', 'PRT_BLOCK'],
            'IMPORTANT + NIT + BLOCKING all sweep — post-merge there is no rework arm to keep them');
        assert.deepEqual(split.human.map(function (r) { return r.threadId; }), ['PRT_H']);
    });

    test('machine notices never sweep (the gh-808 doctrine)', function () {
        var notice = threadRow('PRT_NOTICE', {
            body: '<!-- dmtools:machine-notice {"kind":"test"} --> bookkeeping'
        });
        var split = ps.sweepRowsOf([notice], [BOT]);
        assert.equal(split.machine.length, 0);
        assert.equal(split.human.length, 0);
    });

    test('an empty allowlist reads every thread human — surfaced, never lost', function () {
        var split = ps.sweepRowsOf([threadRow('PRT_1')], []);
        assert.equal(split.machine.length, 0);
        assert.equal(split.human.length, 1, 'the misclassification moves the BUCKET, not the visibility');
    });
});

// ── buildSweepComment (the digest) ───────────────────────────────────────────

suite('postMergeSweep: buildSweepComment', function () {
    var ps = mPostMergeSweep();

    test('the comment carries the sweep marker + the ledger marker + the human table', function () {
        var ledger = mReviewDebtLedger().emptyLedger();
        ledger = mReviewDebtLedger().appendDebtFinding(ledger, {
            threadId: 'PRT_1', path: 'js/sm/mergeState.js', claim: 'nothing validates',
            severityClass: 'IMPORTANT', originPr: 1410, at: NOW
        });
        var body = ps.buildSweepComment({
            prNumber: 1410, ledger: ledger,
            machine: 1, human: 1, at: NOW,
            humanRows: [{ severity: 'IMPORTANT', path: 'a.js', line: 3, claim: 'a human question',
                rootCommentId: 9001 }]
        });
        assert.contains(body, '<!-- dmtools:post-merge-sweep ');
        assert.contains(body, '"pr":1410');
        assert.contains(body, '<!-- dmtools:review-debt-ledger ');
        assert.contains(body, 'open (human)', 'the human thread lists in the SAME digest');
        assert.contains(body, 'gh-1420');
    });
});

// ── runSweep (the gh-1420 sweep on the merged-PR path) ───────────────────────

suite('postMergeSweep: runSweep (the gh-1420 sweep)', function () {
    test('the PR #1410-shaped payload: ONE digest entry, defered resolution, ONE comment', function () {
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        var out = ps.runSweep(pr1410Provider(calls), 1410, cfgOf());
        assert.equal(out.machine, 1);
        assert.equal(out.digested, 1, 'the unresolved machine thread digests');
        assert.equal(out.ledgerFindings, 1, 'ONE ledger finding');
        assert.equal(out.resolved, 1, 'the thread resolves (terminal, gh-1352 post-merge hygiene)');
        assert.equal(calls.replies.length, 1);
        assert.contains(calls.replies[0].text, 'deferred:',
            'the ack carries the canonical machine-parsed disposition');
        assert.equal(calls.commentsPosted.length, 1, 'the digest comment posted');
        assert.contains(calls.commentsPosted[0].body, '<!-- dmtools:post-merge-sweep ');
    });

    test('AC3 idempotency: a re-run creates NO second entry and NO second comment', function () {
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        ps.runSweep(pr1410Provider(calls), 1410, cfgOf());
        // Re-run: the first run's comment is now on the PR and its thread
        // is RESOLVED (the resolve flipped the live GitHub state) — the
        // sweep converges: nothing new, nothing posted.
        var comments = postedComments(calls);
        var out2 = ps.runSweep(pr1410Provider(calls, {
            comments: comments, threads: [threadRow('PRT_1', { resolved: true })]
        }), 1410, cfgOf());
        assert.equal(out2.clean, true, 'the resolved thread leaves nothing to sweep');
        assert.equal(calls.commentsPosted.length, 1, 'the convergent one-digest-per-PR invariant');
        assert.equal(calls.resolves.length, 1, 'no re-resolution of a terminal thread');
    });

    test('a re-run with the thread STILL open (resolve failure): digest deduped, retry resolves', function () {
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        var out = ps.runSweep(pr1410Provider(calls, { resolveFailIds: ['PRT_1'] }), 1410, cfgOf());
        assert.equal(out.resolveFailures, 1, 'failures are counted, never thrown');
        assert.equal(calls.commentsPosted.length, 1, 'the digest posts even on a failed resolution');
        // Re-run with a working resolve: the digest comment dedupes per PR,
        // the resolution retries (maximum progress per tick).
        var comments = postedComments(calls);
        var out2 = ps.runSweep(pr1410Provider(calls, { comments: comments }), 1410, cfgOf());
        assert.equal(out2.digestDeduped, true, 'one digest comment per PR');
        assert.equal(out2.resolved, 1, 'the retry resolves');
        assert.equal(calls.commentsPosted.length, 1);
    });

    test('AC3 convergence: a pre-merge backstop digest and the sweep land ONE entry', function () {
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        var pre = ledgerCommentBody([{
            threadId: 'PRT_1', path: 'js/sm/mergeState.js',
            claim: '⚠️ severity: IMPORTANT — nothing validates the merge state token',
            severityClass: 'IMPORTANT', originPr: 1410, at: '2026-11-09T15:44:00Z'
        }]);
        var out = ps.runSweep(pr1410Provider(calls, { comments: [pre] }), 1410, cfgOf());
        assert.equal(out.ledgerFindings, 1,
            'the gh-1353 identity (file+claim+severity) refreshes the pre-merge entry — never duplicates');
    });

    test('human-only residue lists open (human) in the same digest, never resolves', function () {
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        var out = ps.runSweep(pr1410Provider(calls, {
            threads: [threadRow('PRT_H', { author: 'human-dev', body: 'a human question' })]
        }), 1410, cfgOf());
        assert.equal(out.machine, 0);
        assert.equal(out.human, 1);
        assert.equal(calls.resolves.length, 0, 'human threads are never machine-resolved (gh-744)');
        assert.equal(calls.commentsPosted.length, 1);
        assert.contains(calls.commentsPosted[0].body, 'open (human)');
    });

    test('human-only re-run dedupes the digest comment (one per PR)', function () {
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        var humanOnly = { threads: [threadRow('PRT_H', { author: 'human-dev', body: 'q' })] };
        ps.runSweep(pr1410Provider(calls, humanOnly), 1410, cfgOf());
        var comments = postedComments(calls);
        var out2 = ps.runSweep(pr1410Provider(calls, {
            threads: humanOnly.threads, comments: comments
        }), 1410, cfgOf());
        assert.equal(out2.digestDeduped, true);
        assert.equal(calls.commentsPosted.length, 1);
    });

    test('a clean merged PR (no open threads) stays silent', function () {
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        var out = ps.runSweep(pr1410Provider(calls, {
            threads: [threadRow('PRT_1', { resolved: true })]
        }), 1410, cfgOf());
        assert.equal(out.clean, true);
        assert.equal(calls.commentsPosted.length, 0);
        assert.equal(calls.commentReads.length, 0, 'not even a comment read is spent');
    });

    test('a broken comments read fails soft — the sweep never throws through the close path', function () {
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        var out = ps.runSweep(pr1410Provider(calls, { commentsThrow: true }), 1410, cfgOf());
        assert.equal(out.commentsUnreadable, true);
        assert.equal(calls.commentsPosted.length, 0);
        assert.equal(calls.resolves.length, 0, 'no ledger base → no resolution (never close unfixed work)');
    });

    test('a provider without the thread primitives skips (capability miss)', function () {
        var ps = mPostMergeSweep();
        var out = ps.runSweep({ prCommentList: function () { return []; } }, 1410, cfgOf());
        assert.equal(out.skipped, 'no-primitives');
    });

    test('a ledger WITHOUT its digest comment still marks digestDeduped when the sweep marker rides', function () {
        // The dedup keys on the SWEEP marker family — a PR whose ledger
        // stamp exists but carries no sweep marker still gets the sweep
        // digest (the debt summary is sweep-owned, the ledger is payload).
        var calls = { threadReads: [], commentReads: [], commentsPosted: [], resolves: [], replies: [] };
        var ps = mPostMergeSweep();
        var ledgerOnly = ledgerCommentBody([{
            threadId: 'PRT_1', path: 'js/sm/mergeState.js',
            claim: '⚠️ severity: IMPORTANT — nothing validates the merge state token',
            severityClass: 'IMPORTANT', originPr: 1410, at: '2026-11-09T15:44:00Z'
        }]);
        var out = ps.runSweep(pr1410Provider(calls, { comments: [ledgerOnly] }), 1410, cfgOf());
        assert.equal(out.digestPosted, true, 'no sweep marker on the PR → the digest posts');
    });
});

// ── the machineSmAgent wiring (decision + executor) lives in
// test_machineSmAgent.js — the agent's require map (agentModuleMap) owns
// the postMergeSweep instance there. This file stays the sweep module's
// pure suite.
