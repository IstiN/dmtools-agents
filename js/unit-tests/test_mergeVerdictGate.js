/* Unit tests for js/common/mergeVerdictGate.js — the gh-1416 merge-instant
 * verdict-freshness probe: a REQUEST_CHANGES/BLOCK machine verdict on the
 * CURRENT head defers the squash-merge and stamps a deduped merge-hold
 * marker; every other shape fails open (merge as today). */
/* global loadModule, assert, test, suite, makeRequire */

var mcpParseModule = loadModule('js/common/mcpParse.js', makeRequire({}), {});

// The gate module delegates the shared merge-path derivations (headShaOf,
// shortSha) and the gh-728 machine-logins chain to mergeBackstop — the
// wiring's require needs the module's full dependency closure, with the
// configLoader stubbed (the real one probes .dmtools/config).
var _bsMods = {};
function bsMachineAuthor() {
    if (!_bsMods.ma) _bsMods.ma = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    return _bsMods.ma;
}
function bsReviewVerdicts() {
    if (!_bsMods.rv) {
        _bsMods.rv = loadModule('js/common/reviewVerdicts.js', makeRequire({
            './machineAuthor.js': bsMachineAuthor()
        }), {});
    }
    return _bsMods.rv;
}
function bsFindingRegistry() {
    if (!_bsMods.fr) {
        _bsMods.fr = loadModule('js/common/findingRegistry.js', makeRequire({
            './reviewVerdicts.js': bsReviewVerdicts()
        }), {});
    }
    return _bsMods.fr;
}
function bsLedgerCore() {
    if (!_bsMods.lc) _bsMods.lc = loadModule('js/common/ledgerCore.js', makeRequire({}), {});
    return _bsMods.lc;
}
function bsReviewDebtLedger() {
    if (!_bsMods.rdl) {
        _bsMods.rdl = loadModule('js/common/reviewDebtLedger.js', makeRequire({
            './reviewVerdicts.js': bsReviewVerdicts(),
            './findingRegistry.js': bsFindingRegistry(),
            './ledgerCore.js': bsLedgerCore()
        }), {});
    }
    return _bsMods.rdl;
}
function bsReviewPolicy() {
    if (!_bsMods.rp) {
        _bsMods.rp = loadModule('js/common/reviewPolicy.js', makeRequire({
            './reviewVerdicts.js': bsReviewVerdicts()
        }), {});
    }
    return _bsMods.rp;
}
function bsReviewDispositions() {
    if (!_bsMods.rd) {
        _bsMods.rd = loadModule('js/common/reviewDispositions.js', makeRequire({
            './reviewVerdicts.js': bsReviewVerdicts(),
            './reviewPolicy.js': bsReviewPolicy()
        }), {});
    }
    return _bsMods.rd;
}
function bsThreadInventory() {
    if (!_bsMods.ti) {
        _bsMods.ti = loadModule('js/common/reviewThreadInventory.js', makeRequire({
            './machineNotice.js': loadModule('js/common/machineNotice.js', makeRequire({}), {})
        }), {});
    }
    return _bsMods.ti;
}
function bsMergeBackstop() {
    if (!_bsMods.mb) {
        _bsMods.mb = loadModule('js/common/mergeBackstop.js', makeRequire({
            './reviewVerdicts.js': bsReviewVerdicts(),
            './findingRegistry.js': bsFindingRegistry(),
            './reviewDebtLedger.js': bsReviewDebtLedger(),
            './reviewDispositions.js': bsReviewDispositions(),
            './machineAuthor.js': bsMachineAuthor(),
            './reviewThreadInventory.js': bsThreadInventory(),
            './mcpParse.js': mcpParseModule,
            '../configLoader.js': { loadProjectConfig: function () { return null; } }
        }), {});
    }
    return _bsMods.mb;
}

function loadGate(mods) {
    return loadModule('js/common/mergeVerdictGate.js', makeRequire({
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': bsReviewVerdicts(),
        './mergeBackstop.js': bsMergeBackstop()
    }), mods || {});
}

// The gate module with a require-level override — the paranoia parse-catch
// test injects a reviewVerdicts stub whose parser throws (the real one
// never does, so the catch arm is otherwise unreachable in a suite).
function loadGateWithRequire(requireOverrides) {
    var base = {
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': bsReviewVerdicts(),
        './mergeBackstop.js': bsMergeBackstop()
    };
    var over = requireOverrides || {};
    for (var k in over) base[k] = over[k];
    return loadModule('js/common/mergeVerdictGate.js', makeRequire(base), {});
}

// ── fixture builders ─────────────────────────────────────────────────────────

var BOT = 'merge-bot';
var HEAD = '0c2732dfeedface0deadbeefcafe0123456789ab';
var OLD_HEAD = '1111111feedface0deadbeefcafe0123456789ab';

// A canonical verdict marker comment (the real builder — the same body a
// review leg posts).
function verdictComment(verdict, head, login, over) {
    var body = bsReviewVerdicts().buildVerdictComment({
        head: head, verdict: verdict, blocking: 0, important: 1,
        suggestions: 0, at: (over && over.at) || '2026-11-09T15:42:44Z',
        source: (over && over.source) || 'pr_review.json'
    });
    return { body: body, user: { login: login || BOT + '[bot]' } };
}

// io bag over scripted providers: opts.comments = the comment list served;
// opts.getCommentsThrows / opts.noGetComments / opts.noCreateComment /
// opts.createCommentThrows shape the failure modes. Every call lands in
// `calls` for the assertions.
function gateIo(opts, calls) {
    opts = opts || {};
    calls = calls || { commentReads: [], commentsPosted: [] };
    return {
        io: {
            getComments: opts.noGetComments ? null : function (a) {
                calls.commentReads.push(a);
                if (opts.getCommentsThrows) throw new Error(opts.getCommentsThrows);
                return JSON.stringify(opts.comments || []);
            },
            createComment: opts.noCreateComment ? null : function (c) {
                calls.commentsPosted.push(c);
                if (opts.createCommentThrows) throw new Error(opts.createCommentThrows);
                return '{}';
            }
        },
        calls: calls
    };
}

function run(opts, input) {
    var g = gateIo(opts);
    var out = loadGate().runGate(g.io, 'o', 'n', input || {
        prNumber: 12, headSha: HEAD, logins: [BOT],
        nowIso: '2026-11-09T15:44:00Z'
    });
    return { out: out, calls: g.calls };
}

// ── runGate: the hold decision ───────────────────────────────────────────────

suite('mergeVerdictGate: runGate hold decision', function () {

    test('REQUEST_CHANGES record on the current head -> merge deferred, hold marker posted', function () {
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', HEAD)] });
        assert.equal(r.out.held, true);
        assert.equal(r.out.verdict, 'REQUEST_CHANGES');
        assert.equal(r.out.head, HEAD);
        assert.equal(r.out.holdPosted, true);
        assert.equal(r.calls.commentsPosted.length, 1, 'exactly one hold comment');
        assert.equal(r.calls.commentsPosted[0].number, 12);
        assert.equal(r.calls.commentsPosted[0].workspace, 'o');
        assert.equal(r.calls.commentsPosted[0].repository, 'n');
    });

    test('BLOCK record on the current head -> merge deferred', function () {
        var r = run({ comments: [verdictComment('BLOCK', HEAD)] });
        assert.equal(r.out.held, true);
        assert.equal(r.out.verdict, 'BLOCK');
        assert.equal(r.calls.commentsPosted.length, 1);
    });

    test('APPROVE record on the current head -> merges (no hold comment)', function () {
        var r = run({ comments: [verdictComment('APPROVE', HEAD)] });
        assert.equal(r.out.held, false);
        assert.equal(r.out.verdict, 'APPROVE');
        assert.equal(r.calls.commentsPosted.length, 0, 'no hold marker for an approval');
    });

    test('no records at all -> merges, fail-open (asserted)', function () {
        var r = run({ comments: [{ body: 'looks good to me', user: { login: 'human' } }] });
        assert.equal(r.out.held, false);
        assert.equal(r.out.verdict, null);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('empty comment list -> merges, fail-open (asserted)', function () {
        var r = run({ comments: [] });
        assert.equal(r.out.held, false);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('stale-head record only -> merges, fail-open (asserted)', function () {
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', OLD_HEAD)] });
        assert.equal(r.out.held, false, 'a verdict for an OLDER head never holds the current one');
        assert.equal(r.out.verdict, null);
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('head moved after the review: newer-head record wins nothing for the old head', function () {
        // REQUEST_CHANGES on the OLD head, APPROVE on the CURRENT head -> merges.
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', OLD_HEAD),
                                 verdictComment('APPROVE', HEAD)] });
        assert.equal(r.out.held, false);
        assert.equal(r.out.verdict, 'APPROVE');
    });

    test('verdict conflict on the current head: newest wins (REQUEST_CHANGES after APPROVE holds)', function () {
        var r = run({ comments: [verdictComment('APPROVE', HEAD, null, { at: '2026-11-09T15:40:00Z' }),
                                 verdictComment('REQUEST_CHANGES', HEAD, null, { at: '2026-11-09T15:42:44Z' })] });
        assert.equal(r.out.held, true);
        assert.equal(r.out.verdict, 'REQUEST_CHANGES');
    });

    test('short-sha head on the PR payload matches the full-sha record (sameHead prefix rule)', function () {
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', HEAD)] },
            { prNumber: 12, headSha: HEAD.substring(0, 7), logins: [BOT],
              nowIso: '2026-11-09T15:44:00Z' });
        assert.equal(r.out.held, true, 'the >=7-char prefix of the record sha is the same head');
        assert.equal(r.out.holdPosted, true);
        assert.contains(r.calls.commentsPosted[0].body, HEAD.substring(0, 7));
    });

    test('unreadable/garbage markers are treated as absent (fail-open): broken JSON, no head, foreign verdict', function () {
        var comments = [
            { body: '<!-- dmtools:review-verdict {broken json -->', user: { login: BOT + '[bot]' } },
            { body: '<!-- dmtools:review-verdict {"verdict":"REQUEST_CHANGES"} -->', user: { login: BOT + '[bot]' } },
            { body: '<!-- dmtools:review-verdict {"head":"' + HEAD + '","verdict":"MAYBE"} -->', user: { login: BOT + '[bot]' } },
            { body: 'REQUEST_CHANGES without any marker at all', user: { login: BOT + '[bot]' } }
        ];
        var r = run({ comments: comments });
        assert.equal(r.out.held, false, 'a marker that does not parse does not exist for the gate');
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('machine-identity gate: a foreign-authored verdict marker is invisible', function () {
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', HEAD, 'someone-else')] });
        assert.equal(r.out.held, false, 'a forged REQUEST_CHANGES from a non-machine login never holds');
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('unconfigured machineAuthor trusts nothing (fail closed on trust, fail open on merge)', function () {
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', HEAD)] },
            { prNumber: 12, headSha: HEAD, logins: [], nowIso: '2026-11-09T15:44:00Z' });
        assert.equal(r.out.held, false, 'empty allowlist = no trusted records = merge as today');
        assert.equal(r.calls.commentsPosted.length, 0);
        assert.equal(r.calls.commentReads.length, 0,
            'no configured identity = the comment read is skipped entirely (no API pressure)');
    });
});

// ── runGate: the hold marker (deduped per head, refreshed in place) ──────────

suite('mergeVerdictGate: hold marker dedup', function () {

    test('second probe with the hold already on the PR adds NO comment (deduped per head)', function () {
        var opts = { comments: [verdictComment('REQUEST_CHANGES', HEAD)] };
        var first = run(opts);
        assert.equal(first.out.holdPosted, true);
        // The posted marker is now on the PR (the same comment list the next
        // tick reads) — replay the probe.
        opts.comments.push({ body: first.calls.commentsPosted[0].body,
            user: { login: BOT + '[bot]' } });
        var second = run(opts);
        assert.equal(second.out.held, true, 'still held — the verdict stands');
        assert.equal(second.out.holdPosted, false, 'no new comment on the replay');
        assert.equal(second.out.holdDeduped, true, 'the existing same-head hold is reused');
        assert.equal(second.calls.commentsPosted.length, 0, 'never a new comment per tick');
    });

    test('a hold for an OLDER head does not dedupe: the moved head gets its own marker', function () {
        var existingHold = loadGate().buildHoldMarker(
            { verdict: 'REQUEST_CHANGES', source: 'pr_review.json' }, OLD_HEAD, '2026-11-09T15:00:00Z');
        var r = run({ comments: [
            { body: existingHold, user: { login: BOT + '[bot]' } },
            verdictComment('REQUEST_CHANGES', HEAD)
        ] });
        assert.equal(r.out.held, true);
        assert.equal(r.out.holdPosted, true, 'a fresh head gets its own hold (<= 1 per head)');
        assert.equal(r.out.holdDeduped, false);
    });

    test('hold marker payload: machine-parseable, reason/verdict/head round-trip', function () {
        var body = loadGate().buildHoldMarker(
            { verdict: 'REQUEST_CHANGES', source: 'pr_review.json' }, HEAD, '2026-11-09T15:44:00Z');
        assert.contains(body, 'dmtools:merge-hold');
        var parsed = bsReviewVerdicts().extractMarkerJson(
            body, loadGate().MARKER_PREFIX, loadGate().MARKER_SUFFIX);
        assert.equal(parsed.reason, 'verdict');
        assert.equal(parsed.verdict, 'REQUEST_CHANGES');
        assert.equal(parsed.head, HEAD);
        assert.equal(parsed.at, '2026-11-09T15:44:00Z');
        assert.ok(body.indexOf('Please do not edit') === -1, 'no misleading contract wording');
        assert.ok(body.length < 600, 'the marker comment stays small: ' + body.length);
    });

    test('hold marker post failure is soft: the defer stands, no throw', function () {
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', HEAD)],
            createCommentThrows: '403' });
        assert.equal(r.out.held, true, 'the merge is still deferred');
        assert.equal(r.out.holdPostFailed, true);
        assert.equal(r.out.holdPosted, false);
    });

    test('no create-comment primitive: the defer stands, marker skipped (capability miss)', function () {
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', HEAD)], noCreateComment: true });
        assert.equal(r.out.held, true);
        assert.equal(r.out.holdPosted, false);
        assert.equal(r.out.holdPostFailed, false, 'a missing primitive is not a post failure');
    });
});

// ── runGate: fail-open on read faults and capability misses ─────────────────

suite('mergeVerdictGate: fail-open shapes', function () {

    test('unreadable comment read -> fail-open, logged via commentsUnreadable', function () {
        var r = run({ comments: [], getCommentsThrows: '500 boom' });
        assert.equal(r.out.held, false, 'a broken read must not hold the merge (fail-open)');
        assert.equal(r.out.commentsUnreadable, true, 'the failure is surfaced for the caller log');
        assert.equal(r.calls.commentsPosted.length, 0);
    });

    test('no get-comments primitive -> fail-open (capability miss)', function () {
        var r = run({ noGetComments: true });
        assert.equal(r.out.held, false);
        assert.equal(r.out.commentsUnreadable, false);
    });

    test('no head sha on the PR payload -> nothing to consult, fail-open', function () {
        var r = run({ comments: [verdictComment('REQUEST_CHANGES', HEAD)] },
            { prNumber: 12, headSha: null, logins: [BOT], nowIso: '2026-11-09T15:44:00Z' });
        assert.equal(r.out.held, false);
        assert.equal(r.calls.commentReads.length, 0, 'no comment read without a head to match');
    });

    test('comment payload envelopes normalize (comments / items / bare array)', function () {
        var mk = function (envelope) {
            return function (a) { return JSON.stringify(envelope); };
        };
        var comment = verdictComment('REQUEST_CHANGES', HEAD);
        var held = loadGate().runGate(
            { getComments: mk({ comments: [comment] }), createComment: function () { return '{}'; } },
            'o', 'n', { prNumber: 1, headSha: HEAD, logins: [BOT], nowIso: 'x' });
        assert.equal(held.held, true, '{comments:[]} envelope');
        var held2 = loadGate().runGate(
            { getComments: mk({ items: [comment] }), createComment: function () { return '{}'; } },
            'o', 'n', { prNumber: 1, headSha: HEAD, logins: [BOT], nowIso: 'x' });
        assert.equal(held2.held, true, '{items:[]} envelope');
        var held3 = loadGate().runGate(
            { getComments: mk([comment]), createComment: function () { return '{}'; } },
            'o', 'n', { prNumber: 1, headSha: HEAD, logins: [BOT], nowIso: 'x' });
        assert.equal(held3.held, true, 'bare array');
    });
});

// ── runGate decomposition (gh-1416 rework: CRAP ratchet + honest labels) ────

suite('mergeVerdictGate: runGate decomposition and honest skip reasons', function () {

    test('a throwing verdict parser is absorbed: the paranoia catch fails open, logged', function () {
        // The real parser never throws — inject one that does (require-level
        // stub) so the paranoia catch arm is exercised: garbage markers are
        // "absent" at the parser level, a THROWING parser is still fail-open.
        var throwing = { parseVerdictRecords: function () { throw new Error('parser boom'); } };
        var mod = loadGateWithRequire({ './reviewVerdicts.js': throwing });
        var posted = [];
        var out = mod.runGate({
            getComments: function () {
                return JSON.stringify([{ body: 'x', user: { login: BOT + '[bot]' } }]);
            },
            createComment: function (c) { posted.push(c); return '{}'; }
        }, 'o', 'n', { prNumber: 12, headSha: HEAD, logins: [BOT], nowIso: 't' });
        assert.equal(out.held, false, 'the merge proceeds as today (fail-open)');
        assert.equal(out.commentsUnreadable, true, 'the paranoia catch surfaces the fault');
        assert.equal(posted.length, 0, 'no hold marker from a broken parse');
    });

    test('runGate with no input object at all: the {} fallback holds (fail-open)', function () {
        var out = loadGate().runGate({ getComments: null, createComment: null }, 'o', 'n');
        assert.equal(out.held, false);
        assert.equal(out.head, null, 'no head on the defaulted input — nothing to consult');
    });

    test('effectiveVerdictOf: the read->parse->resolve walk returns the newest same-head record', function () {
        var mod = loadGate();
        var out = { head: HEAD, commentsSkipped: false, commentsUnreadable: false };
        var found = mod.effectiveVerdictOf(
            { getComments: function () { return JSON.stringify([verdictComment('REQUEST_CHANGES', HEAD)]); } },
            'o', 'n', { prNumber: 12, logins: [BOT] }, out);
        assert.equal(found.record.verdict, 'REQUEST_CHANGES', 'the walk resolves the newest record');
        assert.equal(found.record.head, HEAD);
        assert.equal(out.commentsSkipped, false, 'a real read is not a capability miss');
        assert.equal(out.commentsUnreadable, false);
    });

    test('effectiveVerdictOf: no get-comments primitive -> null + commentsSkipped (capability miss)', function () {
        var mod = loadGate();
        var out = { head: HEAD, commentsSkipped: false, commentsUnreadable: false };
        var found = mod.effectiveVerdictOf({ getComments: null }, 'o', 'n',
            { prNumber: 12, logins: [BOT] }, out);
        assert.equal(found, null, 'the walk fails open');
        assert.equal(out.commentsSkipped, true, 'the skip reason is recorded — not mislabeled');
        assert.equal(out.commentsUnreadable, false, 'a capability miss is not a read failure');
    });

    test('effectiveVerdictOf: a broken comment read -> null + commentsUnreadable', function () {
        var mod = loadGate();
        var out = { head: HEAD, commentsSkipped: false, commentsUnreadable: false };
        var found = mod.effectiveVerdictOf(
            { getComments: function () { throw new Error('500 boom'); } },
            'o', 'n', { prNumber: 12, logins: [BOT] }, out);
        assert.equal(found, null, 'the walk fails open');
        assert.equal(out.commentsUnreadable, true, 'a broken read stays a read failure');
        assert.equal(out.commentsSkipped, false);
    });

    test('capability miss is named as such — never mislabeled "no verdict records"', function () {
        // Digest finding (PR #1422 review): a missing get-comments primitive
        // used to say "no verdict records for head … — fail-open", a label
        // that lies about which fail-open shape fired.
        var r = run({ noGetComments: true });
        assert.equal(r.out.held, false);
        assert.equal(r.out.commentsSkipped, true, 'the capability miss is surfaced on the outcome');
        var lines = loadGate().outcomeLines(r.out);
        assert.contains(lines[0], 'capability miss');
        assert.notContains(lines[0], 'no verdict records', 'the mislabel must not come back');
    });

    test('the deduped-hold line does not overstate: the marker is REUSED, not refreshed', function () {
        // Digest finding (PR #1422 review): there is no comment-update
        // primitive on the bridge — a same-head hold is reused as-is, its
        // payload/at never actually refresh.
        var lines = loadGate().outcomeLines({ prNumber: 12, held: true,
            verdict: 'REQUEST_CHANGES', head: HEAD, holdDeduped: true });
        assert.contains(lines[0], 'dedup');
        assert.notContains(lines[0], 'refreshed', 'no update primitive exists — the payload never refreshes');
        assert.contains(lines[0], 'reused');
    });
});

// ── outcome lines (the caller say() payload) ────────────────────────────────

suite('mergeVerdictGate: outcome lines', function () {

    test('held line names the verdict, the head and the dedup state', function () {
        var posted = loadGate().outcomeLines({ prNumber: 12, held: true,
            verdict: 'REQUEST_CHANGES', head: HEAD, holdPosted: true });
        assert.equal(posted.length, 1);
        assert.contains(posted[0], 'REQUEST_CHANGES');
        assert.contains(posted[0], HEAD.substring(0, 7));
        assert.contains(posted[0], 'gh-1416');

        var deduped = loadGate().outcomeLines({ prNumber: 12, held: true,
            verdict: 'BLOCK', head: HEAD, holdDeduped: true });
        assert.contains(deduped[0], 'dedup');

        var failed = loadGate().outcomeLines({ prNumber: 12, held: true,
            verdict: 'BLOCK', head: HEAD, holdPostFailed: true });
        assert.contains(failed[0], 'fail');
    });

    test('proceed lines name the fail-open reason; clean APPROVE states the verdict', function () {
        var approve = loadGate().outcomeLines({ prNumber: 12, held: false,
            verdict: 'APPROVE', head: HEAD });
        assert.equal(approve.length, 1);
        assert.contains(approve[0], 'APPROVE');

        var noRecords = loadGate().outcomeLines({ prNumber: 12, held: false,
            verdict: null, head: HEAD });
        assert.contains(noRecords[0], 'no verdict records');

        var unreadable = loadGate().outcomeLines({ prNumber: 12, held: false,
            verdict: null, head: HEAD, commentsUnreadable: true });
        assert.contains(unreadable[0], 'unreadable');

        var noHead = loadGate().outcomeLines({ prNumber: 12, held: false,
            verdict: null, head: null });
        assert.contains(noHead[0], 'no head');

        assert.deepEqual(loadGate().outcomeLines(null), [], 'null outcome says nothing');
    });
});

// ── runGateForPr: the wiring (payload shapes + machine logins chain) ────────

suite('mergeVerdictGate: runGateForPr wiring', function () {

    test('GraphQL headRefOid shape drives the head; job machineAuthor feeds the allowlist', function () {
        var g = gateIo({ comments: [verdictComment('REQUEST_CHANGES', HEAD)] });
        var lines = [];
        var out = loadGate().runGateForPr(g.io, 'o', 'n',
            { machineAuthor: BOT }, 12, { headRefOid: HEAD }, function (l) { lines.push(l); });
        assert.equal(out.held, true);
        assert.equal(lines.length, 1, 'one say() line per probe');
        assert.contains(lines[0], 'REQUEST_CHANGES');
    });

    test('REST head.sha shape drives the head', function () {
        var g = gateIo({ comments: [verdictComment('REQUEST_CHANGES', HEAD)] });
        var out = loadGate().runGateForPr(g.io, 'o', 'n',
            { machineAuthor: BOT }, 12, { head: { sha: HEAD } }, function () {});
        assert.equal(out.held, true);
    });

    test('unconfigured job + config -> no trusted records, merge proceeds', function () {
        var g = gateIo({ comments: [verdictComment('REQUEST_CHANGES', HEAD)] });
        var out = loadGate().runGateForPr(g.io, 'o', 'n',
            {}, 12, { headRefOid: HEAD }, function () {});
        assert.equal(out.held, false, 'no machineAuthor = empty allowlist = fail-open');
    });

    test('githubBridgeIo maps only the two primitives, typeof-guarded', function () {
        var io = loadGate({
            github_get_pr_comments: function () { return '[]'; },
            github_create_comment: function () { return '{}'; }
        }).githubBridgeIo();
        assert.equal(typeof io.getComments, 'function');
        assert.equal(typeof io.createComment, 'function');

        // Explicit undefined mocks: the preamble shadows the runner's
        // network-guard throwers so the module truly sees no primitive.
        var missing = loadGate({
            github_get_pr_comments: undefined,
            github_create_comment: undefined
        }).githubBridgeIo();
        assert.equal(missing.getComments, null, 'absent primitive maps null (capability miss)');
        assert.equal(missing.createComment, null);
    });

    test('end-to-end io probe: githubBridgeIo over mocked globals holds the merge', function () {
        var mod = loadGate({
            github_get_pr_comments: function (a) {
                return JSON.stringify([verdictComment('REQUEST_CHANGES', HEAD)]);
            },
            github_create_comment: function (c) { return '{}'; }
        });
        var out = mod.runGateForPr(mod.githubBridgeIo(), 'o', 'n',
            { machineAuthor: BOT }, 12, { headRefOid: HEAD },
            function (l) { console.log(l); });
        assert.equal(out.held, true);
        assert.equal(out.holdPosted, true);
    });
});
