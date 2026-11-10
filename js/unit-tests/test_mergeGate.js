/* Unit tests for js/common/mergeGate.js — the gh-1417
 * classification-independent merge gate: after the gh-1353/gh-1370
 * backstop (stage 1), ANY unresolved review thread (any author, machine
 * notices excluded) holds the merge behind a deduped per-head
 * dmtools:merge-hold marker, with a clock-injected needs-human
 * escalation valve. */
/* global loadModule, assert, test, suite, makeRequire */

var mcpParseModule = loadModule('js/common/mcpParse.js', makeRequire({}), {});

// ── memoized module-closure builders (test_mergeVerdictGate pattern) ────────

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
    // One mergeBackstop instance per injected-global set (gh-1416): the
    // gate's githubBridgeIo is the SUPERSET VIEW of the backstop's, and
    // the typeof guards read the eval context — the instance the gate
    // delegates to must see the SAME injected globals the gate sees.
    // Reference-equality pairs, NOT object property keys — every globals
    // object stringifies to "[object Object]" and would bind the first
    // fixture's mocks forever.
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
function mConfigLoaderStub(mergeGateConfig) {
    return { loadProjectConfig: function () {
        return mergeGateConfig ? { mergeGate: mergeGateConfig } : null;
    } };
}
function mMergeGate(globals, configLoaderStub) {
    // Per-global-set load: the gate must SEE the fixture's own bridge
    // mocks (one engine-global set per fixture — memoizing across
    // fixtures would bind the first fixture's reads forever).
    return loadModule('js/common/mergeGate.js', makeRequire({
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': mReviewVerdicts(),
        './machineAuthor.js': mMachineAuthor(),
        './machineNotice.js': mMachineNotice(),
        '../configLoader.js': configLoaderStub || mConfigLoaderStub(null),
        './mergeBackstop.js': mMergeBackstop(globals || null),
        './mergeVerdictGate.js': mMergeVerdictGate(globals || null)
    }), globals || {});
}

// ── fixture builders ─────────────────────────────────────────────────────────

var BOT = 'merge-bot';
var HEAD = '0c2732dfeedface0deadbeefcafe0123456789ab';
var HEAD2 = 'aa11bb22feedface0deadbeefcafe0123456789ab';
var NOW = '2026-11-10T12:00:00Z';

// A GraphQL reviewThread node payload (the shape github_get_pr_review_threads
// serves; threadRowsOf normalizes it).
function threadNode(id, opts) {
    var o = opts || {};
    return {
        id: id || 'thread-1',
        isResolved: o.resolved === true,
        path: o.path || 'src/x.js',
        line: (o.line === undefined) ? 10 : o.line,
        comments: { nodes: [{
            databaseId: o.databaseId || 1001,
            author: { login: (o.author === undefined) ? 'human-reviewer' : o.author },
            body: (o.body === undefined) ? 'Please fix this' : o.body
        }] }
    };
}

function threadsPayload(nodes) {
    return JSON.stringify({ data: { repository: { pullRequest:
        { reviewThreads: { nodes: nodes } } } } });
}

// An open human thread (the default reviewer).
function humanThread(opts) {
    return threadNode('t-human', opts);
}

// An open machine-owned thread (the allowlisted identity, a ⚠️ marker body).
function machineThread(opts) {
    var o = opts || {};
    o.author = BOT;
    o.body = o.body || '⚠️ IMPORTANT: unused import';
    return threadNode('t-machine', o);
}

// The machine's own bookkeeping thread (the gh-808 notice marker body).
function noticeThread(opts) {
    var o = opts || {};
    o.author = BOT;
    o.body = '🧵 Unresolved review threads — rework armed.';
    return threadNode('t-notice', o);
}

// A CI-bot informational thread ([bot] author — gh-808 bot exclusion).
function botThread() {
    return threadNode('t-bot', { author: 'github-actions[bot]', body: 'CI passed' });
}

// The dmtools:merge-hold comment body (the real builder — what the gate posts).
function holdComment(census, head, at, escalated, heldSince, hours) {
    return { body: mMergeGate(null).buildHoldMarker(
        census, head, at, escalated === true, heldSince || null, hours || 24),
        user: { login: BOT + '[bot]' } };
}

function plainHoldComment(head, at) {
    return holdComment({ total: 2, human: 2, machine: 0 }, head, at);
}

function escalatedHoldComment(head, at) {
    return holdComment({ total: 2, human: 2, machine: 0 }, head, at, true, at, 24);
}

// io bag over scripted providers: opts.threads / opts.comments = the served
// payloads; opts.threadsThrows / opts.noThreads / opts.noComments /
// opts.noCreateComment / opts.noAddLabels / opts.createCommentThrows /
// opts.addLabelsThrows shape the failure modes. Every call lands in `calls`.
function gateIo(opts, calls) {
    opts = opts || {};
    calls = calls || { threadsReads: [], commentReads: [], commentsPosted: [], labelsAdded: [] };
    return {
        io: {
            getThreads: opts.noThreads ? null : function (a) {
                calls.threadsReads.push(a);
                if (opts.threadsThrows) throw new Error(opts.threadsThrows);
                return (opts.threads === undefined) ? threadsPayload([]) : opts.threads;
            },
            getComments: opts.noComments ? null : function (a) {
                calls.commentReads.push(a);
                if (opts.commentsThrows) throw new Error(opts.commentsThrows);
                return JSON.stringify(opts.comments || []);
            },
            createComment: opts.noCreateComment ? null : function (c) {
                calls.commentsPosted.push(c);
                if (opts.createCommentThrows) throw new Error(opts.createCommentThrows);
                return '{}';
            },
            addLabels: opts.noAddLabels ? null : function (l) {
                calls.labelsAdded.push(l);
                if (opts.addLabelsThrows) throw new Error(opts.addLabelsThrows);
                return '{}';
            }
        },
        calls: calls
    };
}

function run(opts, input) {
    var g = gateIo(opts);
    var out = mMergeGate().runGate(g.io, 'o', 'n', input || {
        prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: NOW
    });
    return { out: out, calls: g.calls };
}

// ── census (pure) ────────────────────────────────────────────────────────────

suite('mergeGate: census (pure)', function () {

    test('resolved and notice-body threads never count; every other author counts and splits', function () {
        var rows = mMergeBackstop().threadRowsOf(threadsPayload([
            humanThread({ resolved: true }),
            humanThread(),
            machineThread(),
            noticeThread(),
            botThread()
        ]));
        var c = mMergeGate().censusOf(rows, [BOT]);
        assert.equal(c.total, 3, 'ANY author gates — [bot]-authored threads still count (gh-1025 App identities)');
        assert.equal(c.human, 2, 'github-actions[bot] is not in the allowlist -> human');
        assert.equal(c.machine, 1);
        assert.equal(c.notices, 1, 'only the notice-marker body is excluded');
        assert.equal(c.resolved, 1);
    });

    test('empty allowlist: every open non-notice thread reads human (the hold survives)', function () {
        var rows = mMergeBackstop().threadRowsOf(threadsPayload([
            machineThread(), humanThread()]));
        var c = mMergeGate().censusOf(rows, []);
        assert.equal(c.total, 2);
        assert.equal(c.human, 2);
        assert.equal(c.machine, 0);
    });

    test('multi-item census: 2 human + 1 machine in one census counts each class', function () {
        var rows = mMergeBackstop().threadRowsOf(threadsPayload([
            humanThread(), humanThread({ path: 'src/y.js', line: 20 }), machineThread()]));
        var c = mMergeGate().censusOf(rows, [BOT]);
        assert.equal(c.total, 3);
        assert.equal(c.human, 2);
        assert.equal(c.machine, 1);
    });

    test('censusHolds: machine survivors always gate; humans gate unless delegated', function () {
        var holds = mMergeGate().censusHolds;
        assert.equal(holds({ total: 0, human: 0, machine: 0 }, true), false);
        assert.equal(holds({ total: 1, human: 1, machine: 0 }, true), true);
        assert.equal(holds({ total: 1, human: 1, machine: 0 }, false), false, 'delegated humans do not hold');
        assert.equal(holds({ total: 1, human: 0, machine: 1 }, false), true, 'machines hold even delegated');
    });
});

// ── knobs ────────────────────────────────────────────────────────────────────

suite('mergeGate: per-repo knobs', function () {

    test('defaults: strict hold + 24h escalation valve', function () {
        var s = mMergeGate().mergeGateSettingsOf({});
        assert.equal(s.holdOnHumanThreads, true);
        assert.equal(s.humanHoldHours, 24);
    });

    test('config.mergeGate overrides; jobParams.mergeGate overrides the config', function () {
        var viaConfig = mMergeGate(null, mConfigLoaderStub({ humanHoldHours: 48 }))
            .mergeGateSettingsOf({});
        assert.equal(viaConfig.humanHoldHours, 48);
        var viaJob = mMergeGate(null, mConfigLoaderStub({ humanHoldHours: 48 }))
            .mergeGateSettingsOf({ mergeGate: { humanHoldHours: 2 } });
        assert.equal(viaJob.humanHoldHours, 2);
    });

    test('junk values fall back to defaults; the false spellings delegate humans', function () {
        var junk = mMergeGate().mergeGateSettingsOf({ mergeGate: { humanHoldHours: 'abc', holdOnHumanThreads: 'false' } });
        assert.equal(junk.humanHoldHours, 24);
        assert.equal(junk.holdOnHumanThreads, false);
        var negative = mMergeGate().mergeGateSettingsOf({ mergeGate: { humanHoldHours: -5 } });
        assert.equal(negative.humanHoldHours, 24);
    });

    test('a broken config load never throws — defaults stand', function () {
        var gate = loadModule('js/common/mergeGate.js', makeRequire({
            './mcpParse.js': mcpParseModule,
            './reviewVerdicts.js': mReviewVerdicts(),
            './machineAuthor.js': mMachineAuthor(),
            './machineNotice.js': mMachineNotice(),
            '../configLoader.js': { loadProjectConfig: function () { throw new Error('cfg boom'); } },
            './mergeBackstop.js': mMergeBackstop(null),
            './mergeVerdictGate.js': mMergeVerdictGate(null)
        }), {});
        var s = gate.mergeGateSettingsOf({});
        assert.equal(s.holdOnHumanThreads, true);
        assert.equal(s.humanHoldHours, 24);
    });
});

// ── runGate: the hold decision ───────────────────────────────────────────────

suite('mergeGate: runGate hold decision', function () {

    test('open human thread -> hold + machine-parseable marker', function () {
        var r = run({ threads: threadsPayload([humanThread()]) });
        assert.equal(r.out.held, true);
        assert.equal(r.out.total, 1);
        assert.equal(r.out.human, 1);
        assert.equal(r.out.machine, 0);
        assert.equal(r.out.holdPosted, true);
        assert.equal(r.calls.commentsPosted.length, 1, 'exactly one hold comment');
        assert.equal(r.calls.commentsPosted[0].number, 12);
        assert.equal(r.calls.commentsPosted[0].workspace, 'o');
        assert.equal(r.calls.commentsPosted[0].repository, 'n');
    });

    test('the marker payload is machine-parseable: reason open-threads + total/human/machine/head', function () {
        var r = run({ threads: threadsPayload([humanThread(), machineThread()]) });
        var body = r.calls.commentsPosted[0].body;
        var payload = mReviewVerdicts().extractMarkerJson(body,
            '<!-- dmtools:merge-hold ', ' -->');
        assert.ok(payload, 'the marker parses');
        assert.equal(payload.reason, 'open-threads');
        assert.equal(payload.total, 2);
        assert.equal(payload.human, 1);
        assert.equal(payload.machine, 1);
        assert.equal(payload.head, HEAD);
        assert.equal(payload.escalated, false);
    });

    test('after the thread resolves -> merges (no comment)', function () {
        var r = run({ threads: threadsPayload([humanThread({ resolved: true })]) });
        assert.equal(r.out.held, false);
        assert.equal(r.out.total, 0);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('notice-only threads -> no hold (gh-808: machine bookkeeping never deadlocks a PR)', function () {
        var r = run({ threads: threadsPayload([noticeThread()]) });
        assert.equal(r.out.held, false, 'notice bodies are excluded');
        assert.equal(r.out.total, 0);
        assert.equal(r.out.notices, 1);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('a [bot]-authored non-notice thread still holds (any author gates)', function () {
        var r = run({ threads: threadsPayload([botThread()]) });
        assert.equal(r.out.held, true, 'a [bot] login is how App identities report — excluding them would re-create the gh-1417 nothing-gates bug');
        assert.equal(r.out.human, 1);
        assert.equal(r.calls.commentsPosted.length, 1);
    });

    test('empty census -> merge proceeds, one proceed line', function () {
        var r = run({});
        assert.equal(r.out.held, false);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('machine survivor thread -> hold (any author gates)', function () {
        var r = run({ threads: threadsPayload([machineThread()]) });
        assert.equal(r.out.held, true);
        assert.equal(r.out.machine, 1);
        assert.equal(r.calls.commentsPosted.length, 1);
    });

    test('holdOnHumanThreads=false -> a human thread does not hold', function () {
        var r = run({ threads: threadsPayload([humanThread()]) },
            { prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: NOW,
              holdOnHumanThreads: false });
        assert.equal(r.out.held, false, 'delegated humans never hold');
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('holdOnHumanThreads=false -> machine paths still hold', function () {
        var r = run({ threads: threadsPayload([machineThread()]) },
            { prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: NOW,
              holdOnHumanThreads: false });
        assert.equal(r.out.held, true);
        assert.equal(r.calls.commentsPosted.length, 1);
    });

    test('threads read throws -> the gate THROWS (fail-closed, never blind-merges)', function () {
        var g = gateIo({ threadsThrows: '503 census boom' });
        var threw = null;
        try {
            mMergeGate().runGate(g.io, 'o', 'n',
                { prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: NOW });
        } catch (e) { threw = e; }
        assert.ok(threw, 'a broken census must throw — hold, never "no threads"');
    });

    test('comments read throws -> the gate THROWS (fail-closed: no dedup-blind posting)', function () {
        var g = gateIo({ threads: threadsPayload([humanThread()]), commentsThrows: '503 boom' });
        var threw = null;
        try {
            mMergeGate().runGate(g.io, 'o', 'n',
                { prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: NOW });
        } catch (e) { threw = e; }
        assert.ok(threw, 'a broken dedup read must defer the merge');
        assert.equal(g.calls.commentsPosted.length, 0);
    });

    test('no threads primitive -> capability miss, merge proceeds (the backstop skip shape)', function () {
        var r = run({ noThreads: true, threads: threadsPayload([humanThread()]) });
        assert.equal(r.out.held, false);
        assert.equal(r.out.threadsSkipped, true);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('no comments primitive -> still holds, marker skipped (the defer stands)', function () {
        var r = run({ threads: threadsPayload([humanThread()]), noComments: true });
        assert.equal(r.out.held, true);
        assert.equal(r.out.commentsSkipped, true);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('no create-comment primitive -> still holds, marker skipped', function () {
        var r = run({ threads: threadsPayload([humanThread()]), noCreateComment: true });
        assert.equal(r.out.held, true);
        assert.equal(r.out.markerSkipped, true);
    });

    test('create-comment throws -> still holds, fail-open on the marker', function () {
        var r = run({ threads: threadsPayload([humanThread()]), createCommentThrows: '422' });
        assert.equal(r.out.held, true);
        assert.equal(r.out.holdPostFailed, true);
    });

    test('headless PR payload -> holds, marker skipped (no dedup key)', function () {
        var r = run({ threads: threadsPayload([humanThread()]) },
            { prNumber: 12, headSha: null, logins: [BOT], nowIso: NOW });
        assert.equal(r.out.held, true);
        assert.equal(r.out.markerSkipped, true);
        assert.equal(r.calls.commentsPosted.length, 0);
    });
});

// ── runGate: dedup per head (refresh-in-place) ───────────────────────────────

suite('mergeGate: dedup per head (comment-reduction)', function () {

    test('repeated ticks on the same head reuse the marker — ZERO comment growth', function () {
        var opts = { threads: threadsPayload([humanThread(), humanThread({ path: 'b.js', line: 3 })]) };
        var first = run(opts);
        assert.equal(first.out.holdPosted, true);
        var second = run({ threads: opts.threads,
            comments: [first.calls.commentsPosted[0]] });
        assert.equal(second.out.held, true);
        assert.equal(second.out.holdDeduped, true);
        assert.equal(second.calls.commentsPosted.length, 0, 'refresh-in-place: no new comment');
        var third = run({ threads: opts.threads,
            comments: [first.calls.commentsPosted[0]] });
        assert.equal(third.out.holdDeduped, true);
        assert.equal(third.calls.commentsPosted.length, 0, 'still zero growth');
    });

    test('a moved head gets its own fresh marker (one per head)', function () {
        var oldMarker = plainHoldComment(HEAD2, '2026-11-09T12:00:00Z');
        var r = run({ threads: threadsPayload([humanThread()]), comments: [oldMarker] });
        assert.equal(r.out.holdPosted, true, 'the new head is a fresh marker budget');
        assert.equal(r.calls.commentsPosted.length, 1);
        assert.equal(r.out.holdDeduped, false);
    });

    test('verdict-reason hold markers never dedup the open-threads budget', function () {
        var verdictHold = { body: mMergeVerdictGate().buildHoldMarker(
            { verdict: 'REQUEST_CHANGES', source: 'pr_review.json' }, HEAD, NOW),
            user: { login: BOT + '[bot]' } };
        var r = run({ threads: threadsPayload([humanThread()]), comments: [verdictHold] });
        assert.equal(r.out.holdPosted, true, 'a verdict hold is a separate marker budget');
        assert.equal(r.calls.commentsPosted.length, 1);
    });

    test('short-sha head on the payload matches the full-sha marker (sameHead prefix rule)', function () {
        var marker = plainHoldComment(HEAD, NOW);
        var r = run({ threads: threadsPayload([humanThread()]), comments: [marker] },
            { prNumber: 12, headSha: HEAD.substring(0, 7), logins: [BOT], nowIso: NOW });
        assert.equal(r.out.holdDeduped, true);
        assert.equal(r.calls.commentsPosted.length, 0);
    });
});

// ── runGate: the escalation valve (clock-injected) ───────────────────────────

suite('mergeGate: humanHoldHours escalation (clock-injected)', function () {

    test('hold older than humanHoldHours with the human thread still open -> escalated', function () {
        var heldAt = '2026-11-09T10:00:00Z'; // 26h before NOW
        var r = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, heldAt)] });
        assert.equal(r.out.held, true);
        assert.equal(r.out.holdDeduped, true);
        assert.equal(r.out.escalated, true);
        assert.equal(r.out.escalationPosted, true, 'the escalated marker names the state');
        assert.equal(r.out.labelPosted, true);
        assert.equal(r.calls.labelsAdded.length, 1);
        assert.equal(r.calls.labelsAdded[0].labels[0], 'needs-human');
    });

    test('the escalated marker names the escalated state (escalated:true + heldSince)', function () {
        var heldAt = '2026-11-09T10:00:00Z';
        var r = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, heldAt)] });
        var payload = mReviewVerdicts().extractMarkerJson(r.calls.commentsPosted[0].body,
            '<!-- dmtools:merge-hold ', ' -->');
        assert.equal(payload.escalated, true);
        assert.equal(payload.heldSince, heldAt);
        assert.equal(payload.reason, 'open-threads');
        assert.ok(r.calls.commentsPosted[0].body.indexOf('ESCALATED') !== -1,
            'the human note names the escalation');
    });

    test('hold younger than humanHoldHours -> not escalated, no label', function () {
        var heldAt = '2026-11-10T11:00:00Z'; // 1h before NOW
        var r = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, heldAt)] });
        assert.equal(r.out.escalated, false);
        assert.equal(r.out.labelPosted, false);
        assert.equal(r.calls.labelsAdded.length, 0);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('custom humanHoldHours=2: a 3h-old hold escalates, a 1h-old one does not', function () {
        var input = { prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: NOW, humanHoldHours: 2 };
        var due = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, '2026-11-10T09:00:00Z')] }, input);
        assert.equal(due.out.escalated, true);
        var notDue = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, '2026-11-10T11:00:00Z')] }, input);
        assert.equal(notDue.out.escalated, false);
    });

    test('humanHoldHours=0: the very next hold tick escalates', function () {
        var r = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, '2026-11-10T09:00:00Z')] },
            { prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: NOW, humanHoldHours: 0 });
        assert.equal(r.out.escalated, true);
    });

    test('repeated escalation-state ticks dedup — zero comment growth, no label spam', function () {
        var heldAt = '2026-11-09T10:00:00Z';
        var comments = [plainHoldComment(HEAD, heldAt), escalatedHoldComment(HEAD, heldAt)];
        var r = run({ threads: threadsPayload([humanThread()]), comments: comments });
        assert.equal(r.out.escalated, true);
        assert.equal(r.out.escalationDeduped, true);
        assert.equal(r.calls.commentsPosted.length, 0, 'no new comment');
        assert.equal(r.calls.labelsAdded.length, 0, 'no repeated label');
    });

    test('escalation clears when the thread resolves (no hold at all)', function () {
        var r = run({ threads: threadsPayload([humanThread({ resolved: true })]),
            comments: [plainHoldComment(HEAD, '2026-11-08T10:00:00Z')] });
        assert.equal(r.out.held, false);
        assert.equal(r.out.escalated, false);
        assert.equal(r.calls.labelsAdded.length, 0);
    });

    test('escalation clears when a new head lands (fresh hold budget, clock restarted)', function () {
        var r = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, '2026-11-08T10:00:00Z')] },
            { prNumber: 12, headSha: HEAD2, logins: [BOT], nowIso: NOW });
        assert.equal(r.out.held, true);
        assert.equal(r.out.escalated, false, 'the new head restarts the hold clock');
        assert.equal(r.out.holdPosted, true);
        assert.equal(r.calls.labelsAdded.length, 0);
    });

    test('escalation never fires on a machine-only hold (stage 1 owns machine failures)', function () {
        var r = run({ threads: threadsPayload([machineThread()]),
            comments: [plainHoldComment(HEAD, '2026-11-01T10:00:00Z')] });
        assert.equal(r.out.held, true);
        assert.equal(r.out.escalated, false);
        assert.equal(r.calls.labelsAdded.length, 0);
        assert.equal(r.out.holdDeduped, true, 'the standing marker is reused in place');
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('escalation never fires while human threads are delegated', function () {
        var r = run({ threads: threadsPayload([machineThread(), humanThread()]),
            comments: [plainHoldComment(HEAD, '2026-11-01T10:00:00Z')] },
            { prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: NOW,
              holdOnHumanThreads: false });
        assert.equal(r.out.held, true);
        assert.equal(r.out.escalated, false);
        assert.equal(r.calls.labelsAdded.length, 0);
        assert.equal(r.out.holdDeduped, true);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('an age-less hold (unparseable at) reads as DUE — the FIFO cannot stall forever', function () {
        var r = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, 'not-a-timestamp')] });
        assert.equal(r.out.escalated, true);
    });

    test('label add failure is soft — the escalation state stands', function () {
        var r = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, '2026-11-09T10:00:00Z')],
            addLabelsThrows: '403' });
        assert.equal(r.out.escalated, true);
        assert.equal(r.out.escalationPosted, true);
        assert.equal(r.out.labelFailed, true);
    });

    test('no add-labels primitive is soft — no throw', function () {
        var r = run({ threads: threadsPayload([humanThread()]),
            comments: [plainHoldComment(HEAD, '2026-11-09T10:00:00Z')],
            noAddLabels: true });
        assert.equal(r.out.escalated, true);
        assert.equal(r.out.labelPosted, false);
    });
});

// ── outcome lines ────────────────────────────────────────────────────────────

suite('mergeGate: outcome lines', function () {

    test('held line names the counts, the defer and the marker state', function () {
        var lines = mMergeGate().outcomeLines({
            prNumber: 12, held: true, total: 2, human: 2, machine: 0, holdPosted: true });
        assert.equal(lines.length, 1);
        assert.ok(lines[0].indexOf('#12') !== -1);
        assert.ok(lines[0].indexOf('merge deferred') !== -1);
        assert.ok(lines[0].indexOf('hold marker posted') !== -1);
    });

    test('proceed line names the census; the capability miss names itself', function () {
        var proceed = mMergeGate().outcomeLines(
            { prNumber: 12, held: false, total: 0, human: 0, machine: 0 });
        assert.ok(proceed[0].indexOf('merge proceeds') !== -1);
        var skipped = mMergeGate().outcomeLines(
            { prNumber: 12, held: false, threadsSkipped: true });
        assert.ok(skipped[0].indexOf('capability miss') !== -1);
    });

    test('escalated held line names needs-human', function () {
        var lines = mMergeGate().outcomeLines(
            { prNumber: 12, held: true, escalated: true, total: 1, human: 1,
              machine: 0, escalationPosted: true });
        assert.ok(lines[0].indexOf('ESCALATED') !== -1);
    });
});

// ── runForPr: the two-stage wiring ───────────────────────────────────────────

suite('mergeGate: runForPr (stage 1 + stage 2, the shared helper)', function () {

    // io bag over the FULL bridge surface (the githubBridgeIo superset):
    // threads, comments, create-comment, add-labels + the backstop's
    // digest/resolve tools. The threads payload is MUTABLE — a successful
    // resolveThread marks the node resolved, so the stage-2 census (the
    // second read) sees the post-resolution reality. Every call lands in
    // `calls`.
    function bridgeIo(opts, calls) {
        calls = calls || { threadsReads: [], commentReads: [], commentsPosted: [],
            labelsAdded: [], threadResolves: [], threadReplies: [], debtIssues: [], debtSearches: [] };
        var threadsPayloadObj = (typeof opts.threads === 'string') ? JSON.parse(opts.threads) : opts.threads;
        var nodes = (!threadsPayloadObj) ? [] :
            JSON.parse(JSON.stringify(threadsPayloadObj.data.repository.pullRequest.reviewThreads.nodes));
        var g = gateIo(opts, calls);
        if (!opts.noThreads) g.io.getThreads = function (a) {
            calls.threadsReads.push(a);
            if (opts.threadsThrows) throw new Error(opts.threadsThrows);
            return JSON.stringify({ data: { repository: { pullRequest:
                { reviewThreads: { nodes: nodes } } } } });
        };
        g.io.searchIssues = function () { calls.debtSearches.push({}); return JSON.stringify({ items: [] }); };
        g.io.createIssue = function (a) {
            calls.debtIssues.push(a);
            return JSON.stringify({ number: 500 + calls.debtIssues.length });
        };
        g.io.resolveThread = function (a) {
            if ((opts.resolveFailIds || []).indexOf(String(a.threadId)) !== -1) {
                throw new Error('422 ' + a.threadId);
            }
            calls.threadResolves.push(a);
            nodes.forEach(function (n) { if (n && String(n.id) === String(a.threadId)) n.isResolved = true; });
            return '{}';
        };
        g.io.replyToThread = function (a) { calls.threadReplies.push(a); return '{}'; };
        return g;
    }

    // The merge-hold markers among the posted comments (stage 1's ledger
    // stamp and ack replies share the create-comment primitive).
    function holdMarkersPosted(calls) {
        var n = 0;
        calls.commentsPosted.forEach(function (c) {
            if (String(c.body || '').indexOf('dmtools:merge-hold') !== -1) n++;
        });
        return n;
    }

    var PR = { number: 12, title: 'feat: x', headRefOid: HEAD };

    function runForPr(bridge, jobParams) {
        var gate = mMergeGate();
        return gate.runForPr(bridge.io, 'o', 'n', jobParams || { machineAuthor: BOT }, 12, PR,
            function () {});
    }

    test('stage 1 resolves the machine thread, stage 2 holds on the remaining human thread', function () {
        var bridge = bridgeIo({ threads: threadsPayload([machineThread(), humanThread()]) });
        var out = runForPr(bridge);
        assert.equal(bridge.calls.threadResolves.length, 1, 'stage 1 resolved the machine thread');
        assert.equal(bridge.calls.debtIssues.length, 1, 'the ⚠️ IMPORTANT body rides the digest path');
        assert.equal(out.held, true, 'stage 2 holds on the human thread');
        assert.equal(out.human, 1);
        assert.equal(out.machine, 0, 'the machine thread is resolved by the time stage 2 counts');
        assert.equal(holdMarkersPosted(bridge.calls), 1, 'the open-threads marker stamped');
    });

    test('all clear: stage 1 clean + stage 2 census zero -> merge proceeds', function () {
        var bridge = bridgeIo({ threads: threadsPayload([]) });
        var out = runForPr(bridge);
        assert.equal(out.held, false);
        assert.equal(bridge.calls.commentsPosted.length, 0);
    });

    test('stage 1 resolution failure throws through — stage 2 never runs, no hold marker', function () {
        var bridge = bridgeIo({ threads: threadsPayload([machineThread({
            body: '⚠️ IMPORTANT: real gating thread', resolved: false })] ),
            resolveFailIds: ['t-machine'] });
        var threw = null;
        try { runForPr(bridge); } catch (e) { threw = e; }
        assert.ok(threw, 'the loop-throw semantics are preserved (gh-1370)');
        assert.equal(holdMarkersPosted(bridge.calls), 0, 'stage 2 never stamped');
        assert.equal(bridge.calls.labelsAdded.length, 0);
    });

    test('stage 1 skipped (no threads primitive) -> stage 2 skips too — capability miss parity', function () {
        var bridge = bridgeIo({ noThreads: true });
        var out = runForPr(bridge);
        assert.equal(out.held, false);
        assert.equal(out.threadsSkipped, true);
    });

    test('stage 2 fail-closed: the census read breaks AFTER a clean stage 1 -> the helper throws', function () {
        var bridge = bridgeIo({ threadsThrows: '503' });
        var threw = null;
        try { runForPr(bridge); } catch (e) { threw = e; }
        assert.ok(threw, 'a broken census defers the merge (the #1319 rule extended to stage 2)');
    });

    test('empty machineAuthor: stage 2 still holds on ANY open thread (AC4)', function () {
        var bridge = bridgeIo({ threads: threadsPayload([machineThread()]) });
        var out = runForPr(bridge, {}); // no machineAuthor configured
        assert.equal(out.held, true, 'the hold survives an unresolvable allowlist');
        assert.equal(out.human, 1, 'the misclassified machine thread reads human');
        assert.equal(out.machine, 0);
        assert.equal(holdMarkersPosted(bridge.calls), 1);
    });

    test('runGateForPr honors the mergeGate knobs from jobParams (knob wiring)', function () {
        var bridge = bridgeIo({ threads: threadsPayload([humanThread()]) });
        var gate = mMergeGate();
        var out = gate.runGateForPr(bridge.io, 'o', 'n',
            { machineAuthor: BOT, mergeGate: { holdOnHumanThreads: false } }, 12, PR,
            function () {});
        assert.equal(out.held, false, 'the delegated-humans knob reaches the gate');
    });
});

// ── githubBridgeIo: the superset view ────────────────────────────────────────

suite('mergeGate: githubBridgeIo superset view', function () {

    test('carries the escalation label primitive plus the backstop keys', function () {
        var io = mMergeGate({ github_add_labels: function () { return '{}'; } }).githubBridgeIo();
        assert.equal(typeof io.addLabels, 'function');
        assert.equal(typeof io.getThreads, 'function');
        assert.equal(typeof io.getComments, 'function');
        assert.equal(typeof io.createComment, 'function');
        assert.equal(typeof io.resolveThread, 'function');
    });

    test('a missing label primitive maps null (capability miss, never a stub)', function () {
        // Explicit undefined mock: the preamble shadows the runner's
        // network-guard throwers so the module truly sees no primitive
        // (the dmtools host injects the real bridge globals).
        var io = mMergeGate({ github_add_labels: undefined }).githubBridgeIo();
        assert.equal(io.addLabels, null);
    });
});
