/* Unit tests for js/common/mergeNote.js — the gh-1420 merge-decision
 * observability layer: the funnel-side dmtools:merge-note summary marker
 * (merged with residue — deduped per head, silent on pure-clean merges),
 * the greppable MERGE-DECISION structured log line (v2) every merge funnel
 * emits per decision, and the ::warning:: Actions annotation on holds. */
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
function mThreadInventory() {
    if (!_m.ti) {
        _m.ti = loadModule('js/common/reviewThreadInventory.js', makeRequire({
            './machineNotice.js': mMachineNotice()
        }), {});
    }
    return _m.ti;
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
function mMergeBackstop(globals) {
    // Per-global-set load (gh-1416): the typeof guards read the eval
    // context — reference-equality keyed instances, never property keys.
    var key = globals || null;
    if (!_m.mb) _m.mb = [];
    for (var i = 0; i < _m.mb.length; i++) {
        if (_m.mb[i].key === key) return _m.mb[i].mod;
    }
    var inst = loadModule('js/common/mergeBackstop.js', makeRequire({
        './reviewVerdicts.js': mReviewVerdicts(),
        './findingRegistry.js': mFindingRegistry(),
        './reviewDebtLedger.js': mReviewDebtLedger(),
        './reviewDispositions.js': mReviewDispositions(),
        './reviewPolicy.js': mReviewPolicy(),
        './machineAuthor.js': mMachineAuthor(),
        './reviewThreadInventory.js': mThreadInventory(),
        './mcpParse.js': mcpParseModule,
        '../configLoader.js': { loadProjectConfig: function () { return null; } }
    }), globals || {});
    _m.mb.push({ key: key, mod: inst });
    return inst;
}
function mMergeVerdictGate(globals) {
    return loadModule('js/common/mergeVerdictGate.js', makeRequire({
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': mReviewVerdicts(),
        './mergeBackstop.js': mMergeBackstop(globals || null)
    }), globals || {});
}
function mMergeNote(globals) {
    return loadModule('js/common/mergeNote.js', makeRequire({
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': mReviewVerdicts(),
        './mergeBackstop.js': mMergeBackstop(globals || null),
        './mergeVerdictGate.js': mMergeVerdictGate(globals || null)
    }), globals || {});
}

// ── fixtures ─────────────────────────────────────────────────────────────────

var BOT = 'merge-bot';
var HEAD = '0c2732dfeedface0deadbeefcafe0123456789ab';
var NOW = '2026-11-10T12:00:00Z';

// A backstop outcome shaped like mergeBackstop.emptyOutcome after a run
// that deferred one >=IMPORTANT thread, acked one below-threshold thread
// and left one human thread open (the "merged with residue" shape).
function residueBackstop() {
    return {
        prNumber: 1410,
        skipped: null,
        counted: [{ threadId: 't1', severity: 'IMPORTANT' }],
        ackThreads: [{ threadId: 't2', severity: 'SUGGESTION' }],
        holdThreads: [],
        human: [{ threadId: 't3', severity: 'IMPORTANT' }],
        counts: { total: 3, resolved: 0, machine: 2, belowSeverity: 1, noThreadId: 0,
            machineByTier: {}, allowedDeferrable: 2 },
        resolved: 1,
        ackResolved: 1,
        digest: 501,
        human2: undefined
    };
}

function pureCleanBackstop() {
    return {
        prNumber: 1410, skipped: null, counted: [], ackThreads: [], holdThreads: [],
        human: [], counts: { total: 0, resolved: 0, machine: 0 }, resolved: 0, ackResolved: 0
    };
}

function commentsPayload(bodies) {
    return JSON.stringify((bodies || []).map(function (b, i) {
        return { databaseId: 100 + i, body: b, user: { login: BOT + '[bot]' } };
    }));
}

// ── the structured decision line ─────────────────────────────────────────────

suite('mergeNote: mergeDecisionLine (the greppable v2 format)', function () {
    var mn = mMergeNote(null);

    test('the merged shape renders every field in order', function () {
        var line = mn.mergeDecisionLine({
            prNumber: 1410, headSha: HEAD, action: 'merged',
            machineThreads: 2, humanThreads: 1, allowlist: 3, verdict: 'APPROVE'
        });
        assert.equal(line, 'MERGE-DECISION pr=1410 head=0c2732d action=merged' +
            ' machineThreads=2 humanThreads=1 allowlist=3 verdict=APPROVE');
    });

    test('held and deferred actions render their canonical words', function () {
        assert.contains(mn.mergeDecisionLine({ prNumber: 1, headSha: HEAD, action: 'held' }), 'action=held');
        assert.contains(mn.mergeDecisionLine({ prNumber: 1, headSha: HEAD, action: 'defered' }),
            'action=defered');
    });

    test('the head renders as the 7-char short sha, missing reads none', function () {
        var line = mn.mergeDecisionLine({ prNumber: 1, headSha: HEAD, action: 'merged' });
        assert.contains(line, 'head=0c2732d');
        assert.contains(mn.mergeDecisionLine({ prNumber: 1, headSha: null, action: 'merged' }),
            'head=none');
    });

    test('no verdict record reads verdict=none', function () {
        var line = mn.mergeDecisionLine({ prNumber: 1, headSha: HEAD, action: 'defered' });
        assert.contains(line, 'verdict=none');
    });

    test('the misclassification detector rides the line: allowlist=0 is greppable', function () {
        var line = mn.mergeDecisionLine({ prNumber: 1410, headSha: HEAD, action: 'merged',
            machineThreads: 0, humanThreads: 1, allowlist: 0, verdict: 'REQUEST_CHANGES' });
        assert.contains(line, 'allowlist=0');
        assert.contains(line, 'verdict=REQUEST_CHANGES');
    });

    test('missing counts render as zeros (never undefined)', function () {
        var line = mn.mergeDecisionLine({ prNumber: 1, headSha: HEAD, action: 'held' });
        assert.contains(line, 'machineThreads=0');
        assert.contains(line, 'humanThreads=0');
        assert.contains(line, 'allowlist=0');
    });
});

// ── the residue payload ──────────────────────────────────────────────────────

suite('mergeNote: residueCountsOf (backstop outcome → residue)', function () {
    var mn = mMergeNote(null);

    test('the residue shape: open at merge = counted + acked + held + human', function () {
        var r = mn.residueCountsOf(residueBackstop());
        assert.equal(r.openThreadsAtMerge, 3);
        assert.equal(r.autoResolved, 2, 'the >=IMPORTANT deferral + the below-threshold ack');
        assert.equal(r.machine, 2);
        assert.equal(r.human, 1);
    });

    test('a null/skipped outcome reads as zero residue', function () {
        assert.equal(mn.residueCountsOf(null).openThreadsAtMerge, 0);
        var skipped = mn.residueCountsOf({ skipped: 'no-thread-primitive' });
        assert.equal(skipped.openThreadsAtMerge, 0);
        assert.equal(skipped.autoResolved, 0);
    });

    test('a pure-clean outcome is silent fuel (zero residue)', function () {
        var r = mn.residueCountsOf(pureCleanBackstop());
        assert.equal(r.openThreadsAtMerge, 0);
        assert.equal(r.autoResolved, 0);
        assert.equal(r.human, 0);
    });
});

// ── the marker ───────────────────────────────────────────────────────────────

suite('mergeNote: buildMergeNoteMarker (machine-parseable)', function () {
    var mn = mMergeNote(null);

    test('the marker is the dmtools:merge-note family with a JSON payload', function () {
        var m = mn.buildMergeNoteMarker(mn.residueCountsOf(residueBackstop()), HEAD, NOW);
        assert.contains(m, '<!-- dmtools:merge-note ');
        assert.contains(m, ' -->');
        var json = m.substring(m.indexOf('{'), m.lastIndexOf('}') + 1);
        var payload = JSON.parse(json);
        assert.equal(payload.openThreadsAtMerge, 3);
        assert.equal(payload.autoResolved, 2);
        assert.equal(payload.machine, 2);
        assert.equal(payload.human, 1);
        assert.equal(payload.head, HEAD);
        assert.equal(payload.at, NOW);
    });

    test('a --> inside a rendered value cannot break the marker out', function () {
        var m = mn.buildMergeNoteMarker(
            { openThreadsAtMerge: 1, autoResolved: 0, machine: 1, human: 0 }, HEAD, NOW);
        assert.equal(m.indexOf('-->', m.indexOf('{')), m.lastIndexOf('-->'),
            'exactly the closing suffix after the payload');
    });
});

// ── runMergeNote (the stamp) ─────────────────────────────────────────────────

suite('mergeNote: runMergeNote (silent / dedup per head / post)', function () {
    function ioOf(calls, comments) {
        return {
            getComments: function (a) {
                calls.commentReads.push(a);
                if (calls.commentsThrow) throw new Error('503');
                return commentsPayload(comments || []);
            },
            createComment: function (a) { calls.commentsPosted.push(a); return '{}'; }
        };
    }

    test('pure-clean merge: no comment, no read — silent (AC1)', function () {
        var calls = { commentReads: [], commentsPosted: [] };
        var out = mMergeNote(null).runMergeNote(ioOf(calls), 'o', 'n', {
            prNumber: 12, headSha: HEAD, nowIso: NOW, backstop: pureCleanBackstop()
        });
        assert.equal(out.silent, true, 'nothing counted → nothing posted');
        assert.equal(calls.commentReads.length, 0, 'not even a read — pure-clean stays silent');
        assert.equal(calls.commentsPosted.length, 0);
    });

    test('residue merge: ONE machine-parseable marker posted', function () {
        var calls = { commentReads: [], commentsPosted: [] };
        var out = mMergeNote(null).runMergeNote(ioOf(calls), 'o', 'n', {
            prNumber: 1410, headSha: HEAD, nowIso: NOW, backstop: residueBackstop()
        });
        assert.equal(out.posted, true);
        assert.equal(calls.commentsPosted.length, 1);
        assert.contains(calls.commentsPosted[0].body, 'dmtools:merge-note');
        assert.contains(calls.commentsPosted[0].body, '"openThreadsAtMerge":3');
        assert.contains(calls.commentsPosted[0].body, '"autoResolved":2');
    });

    test('replay: the same head dedupes — never a second comment (refresh invariant)', function () {
        var calls = { commentReads: [], commentsPosted: [] };
        var note = mMergeNote(null);
        note.runMergeNote(ioOf(calls), 'o', 'n', {
            prNumber: 1410, headSha: HEAD, nowIso: NOW, backstop: residueBackstop()
        });
        // The posted marker is now on the PR — the replay reads it.
        var comments = calls.commentsPosted.map(function (c) { return c.body; });
        var out2 = note.runMergeNote(ioOf(calls, comments), 'o', 'n', {
            prNumber: 1410, headSha: HEAD, nowIso: NOW, backstop: residueBackstop()
        });
        assert.equal(out2.deduped, true, 'same head → deduped');
        assert.equal(calls.commentsPosted.length, 1, 'one comment per head');
    });

    test('a moved head gets its own fresh note (one per head, gh-848 parity)', function () {
        var calls = { commentReads: [], commentsPosted: [] };
        var note = mMergeNote(null);
        note.runMergeNote(ioOf(calls), 'o', 'n', {
            prNumber: 1410, headSha: HEAD, nowIso: NOW, backstop: residueBackstop()
        });
        var comments = calls.commentsPosted.map(function (c) { return c.body; });
        var out2 = note.runMergeNote(ioOf(calls, comments), 'o', 'n', {
            prNumber: 1410, headSha: 'aa11bb22feedface0deadbeefcafe0123456789ab', nowIso: NOW,
            backstop: residueBackstop()
        });
        assert.equal(out2.posted, true, 'a different head posts its own marker');
        assert.equal(calls.commentsPosted.length, 2);
    });

    test('a broken comments read skips the marker (soft — the merge already happened)', function () {
        var calls = { commentReads: [], commentsPosted: [], commentsThrow: true };
        var out = mMergeNote(null).runMergeNote(ioOf(calls), 'o', 'n', {
            prNumber: 1410, headSha: HEAD, nowIso: NOW, backstop: residueBackstop()
        });
        assert.equal(out.commentsUnreadable, true);
        assert.equal(out.posted, false);
        assert.equal(calls.commentsPosted.length, 0, 'posting without the dedup read risks spam — skipped');
    });

    test('a failed post never throws (observability, not a gate)', function () {
        var calls = { commentReads: [], commentsPosted: [] };
        var io = ioOf(calls, []);
        io.createComment = function () { throw new Error('422'); };
        var out = mMergeNote(null).runMergeNote(io, 'o', 'n', {
            prNumber: 1410, headSha: HEAD, nowIso: NOW, backstop: residueBackstop()
        });
        assert.equal(out.postFailed, true);
    });
});

// ── emitDecision (the shared say/logger seam) ────────────────────────────────

suite('mergeNote: emitDecision (say seam + ::warning:: on holds)', function () {
    var mn = mMergeNote(null);
    var PR = { number: 1410, headRefOid: HEAD };

    test('says the structured line and returns it', function () {
        var said = [];
        var line = mn.emitDecision(function (l) { said.push(l); }, {
            prNumber: 1410, pr: PR, job: { machineAuthor: BOT + ',github-actions[bot]' },
            action: 'merged', backstop: residueBackstop(), verdict: 'APPROVE'
        });
        assert.equal(said.length, 1);
        assert.equal(line, said[0]);
        assert.contains(line, 'MERGE-DECISION pr=1410');
        assert.contains(line, 'action=merged');
        assert.contains(line, 'machineThreads=2', 'the residue machine count rides the merged line');
        assert.contains(line, 'humanThreads=1');
        assert.contains(line, 'allowlist=2', 'the allowlist resolves from jobParams');
    });

    test('a held decision warns (::warning:: annotation on its own line)', function () {
        var said = [];
        mn.emitDecision(function (l) { said.push(l); }, {
            prNumber: 12, pr: PR, job: { machineAuthor: BOT },
            action: 'held', machineThreads: 0, humanThreads: 2, verdict: 'none'
        });
        assert.equal(said.length, 2, 'the decision line + the warning');
        assert.contains(said[0], 'action=held');
        assert.equal(said[0].indexOf('::warning::'), -1, 'the decision line never embeds the annotation');
        assert.equal(said[1].indexOf('::warning::'), 0, 'the annotation opens its own line');
    });

    test('a deferred verdict hold warns too (it stamps a merge-hold marker)', function () {
        var said = [];
        mn.emitDecision(function (l) { said.push(l); }, {
            prNumber: 12, pr: PR, job: { machineAuthor: BOT },
            action: 'defered', verdict: 'REQUEST_CHANGES', warn: true
        });
        assert.equal(said.length, 2);
        assert.contains(said[0], 'verdict=REQUEST_CHANGES');
        assert.contains(said[1], '::warning::');
    });

    test('merged/defered without a hold never warn', function () {
        var said = [];
        mn.emitDecision(function (l) { said.push(l); }, {
            prNumber: 12, pr: PR, job: { machineAuthor: BOT },
            action: 'merged', backstop: pureCleanBackstop(), verdict: 'APPROVE'
        });
        mn.emitDecision(function (l) { said.push(l); }, {
            prNumber: 12, pr: PR, job: { machineAuthor: BOT },
            action: 'defered', verdict: 'none'
        });
        assert.equal(said.length, 2);
        said.forEach(function (l) {
            assert.equal(l.indexOf('::warning::'), -1, 'no warning on non-holds');
        });
    });

    test('a null say is absorbed (the line is still returned — pure seam)', function () {
        var line = mn.emitDecision(null, { prNumber: 12, pr: PR, job: null, action: 'held' });
        assert.contains(line, 'MERGE-DECISION pr=12');
    });
});

// ── the funnel wiring ────────────────────────────────────────────────────────

suite('mergeNote: runMergeNoteForPr (the one-call funnel wiring)', function () {
    var PR = { number: 1410, title: 'feat: x', headRefOid: HEAD };

    function ioOf(calls, comments) {
        return {
            getComments: function (a) {
                calls.commentReads.push(a);
                return commentsPayload(comments || []);
            },
            createComment: function (a) { calls.commentsPosted.push(a); return '{}'; }
        };
    }

    test('posts the marker for a residue backstop outcome, says the outcome line', function () {
        var calls = { commentReads: [], commentsPosted: [] };
        var said = [];
        var out = mMergeNote(null).runMergeNoteForPr(ioOf(calls), 'o', 'n',
            { machineAuthor: BOT }, 1410, PR, residueBackstop(),
            function (l) { said.push(l); });
        assert.equal(out.posted, true);
        assert.equal(calls.commentsPosted.length, 1);
        assert.ok(said.length >= 1, 'the outcome line is said via the seam');
        assert.contains(said[said.length - 1], 'merge note on PR #1410');
    });

    test('a clean backstop outcome stays silent — no line, no comment', function () {
        var calls = { commentReads: [], commentsPosted: [] };
        var said = [];
        var out = mMergeNote(null).runMergeNoteForPr(ioOf(calls), 'o', 'n',
            { machineAuthor: BOT }, 1410, PR, pureCleanBackstop(),
            function (l) { said.push(l); });
        assert.equal(out.silent, true);
        assert.equal(said.length, 0);
        assert.equal(calls.commentsPosted.length, 0);
    });

    test('a null/skipped backstop outcome (capability miss) stays silent too', function () {
        var calls = { commentReads: [], commentsPosted: [] };
        var out = mMergeNote(null).runMergeNoteForPr(ioOf(calls), 'o', 'n',
            { machineAuthor: BOT }, 1410, PR, { skipped: 'no-thread-primitive' },
            function () {});
        assert.equal(out.silent, true);
        assert.equal(calls.commentsPosted.length, 0);
    });
});
