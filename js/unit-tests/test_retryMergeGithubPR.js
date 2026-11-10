/* Unit tests for js/retryMergeGithubPR.js — the GitHub-issues machine
 * loop's merge leg, focused on the gh-1416 verdict-freshness gate at the
 * squash-merge instant (plus the surrounding pass/hold/fail-open shapes). */
/* global loadModule, assert, test, suite, makeRequire */

var mcpParseModule = loadModule('js/common/mcpParse.js', makeRequire({}), {});

var BOT = 'merge-bot';
var HEAD = '0c2732dfeedface0deadbeefcafe0123456789ab';

// ── memoized module-closure builders (test_mergeTrigger pattern) ────────────

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
function mThreadInventory() {
    if (!_m.ti) {
        _m.ti = loadModule('js/common/reviewThreadInventory.js', makeRequire({
            './machineNotice.js': loadModule('js/common/machineNotice.js', makeRequire({}), {})
        }), {});
    }
    return _m.ti;
}
function mMergeBackstop() {
    if (!_m.mb) {
        _m.mb = loadModule('js/common/mergeBackstop.js', makeRequire({
            './reviewVerdicts.js': mReviewVerdicts(),
            './findingRegistry.js': mFindingRegistry(),
            './reviewDebtLedger.js': mReviewDebtLedger(),
            './reviewDispositions.js': mReviewDispositions(),
            './machineAuthor.js': mMachineAuthor(),
            './reviewThreadInventory.js': mThreadInventory(),
            './mcpParse.js': mcpParseModule,
            '../configLoader.js': { loadProjectConfig: function () { return null; } }
        }), {});
    }
    return _m.mb;
}
function mGate(globals) {
    // Per-call load: the gate must SEE the lane's own bridge mocks (one
    // engine-global set per fixture — memoizing would bind the first
    // fixture's comment read forever).
    return loadModule('js/common/mergeVerdictGate.js', makeRequire({
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': mReviewVerdicts(),
        './mergeBackstop.js': mMergeBackstop()
    }), globals || {});
}

// ── fixtures ─────────────────────────────────────────────────────────────────

// The verdict-marker comment (the real builder — the body a review leg posts).
function verdictComment(verdict, head, login) {
    return {
        body: mReviewVerdicts().buildVerdictComment({
            head: head, verdict: verdict, blocking: 0, important: 1,
            suggestions: 0, at: '2026-11-09T15:42:44Z', source: 'pr_review.json'
        }),
        user: { login: login || BOT + '[bot]' }
    };
}

// detail payload shared by every scenario: mergeable CLEAN with a head sha.
function prDetail(over) {
    var d = { number: 12, state: 'open', mergeable: true, mergeable_state: 'clean',
        head: { sha: HEAD } };
    for (var k in (over || {})) d[k] = over[k];
    return d;
}

// The retry lane resolves the repo through the scm provider (or the
// explicit config.repository); both are stubbed here. The gate module
// shares the lane's bridge mocks (one engine-global set in production).
function loadLane(opts) {
    opts = opts || {};
    var calls = { merges: [], removed: [], added: [], comments: [], closed: [],
        commentReads: [], branchUpdates: [] };
    var globals = {
        github_remove_label: function (a) { calls.removed.push(a); return '{}'; },
        github_add_labels: function (a) { calls.added.push(a); return '{}'; },
        github_create_comment: function (a) { calls.comments.push(a); return '{}'; },
        github_get_issue: function () { return JSON.stringify({ number: 33, state: 'closed' }); },
        github_close_issue: function (a) { calls.closed.push(a); return '{}'; },
        github_get_pr_comments: opts.noCommentsPrimitive ? undefined : function (a) {
            calls.commentReads.push(a);
            if (opts.getCommentsThrows) throw new Error(opts.getCommentsThrows);
            return JSON.stringify(opts.comments || []);
        }
    };
    var scmStub = {
        createScm: function () {
            return {
                getRemoteRepoInfo: function () { return { owner: 'o', repo: 'n' }; },
                listPrs: function (state) {
                    return (opts.openPrs || [{ number: 12, body: 'Closes #33', head: { ref: 'ai/gh-33' } }]);
                },
                getPr: function (prId) { return opts.prDetail || null; },
                mergePr: function (prId, owner, repo, method) {
                    calls.merges.push({ prId: prId, owner: owner, repo: repo, method: method });
                    if (opts.mergeThrows) throw new Error(opts.mergeThrows);
                    return { merged: true };
                },
                updateBranch: function () { calls.branchUpdates.push(1); }
            };
        }
    };
    var lane = loadModule('js/retryMergeGithubPR.js', makeRequire({
        './common/scm.js': scmStub,
        './configLoader.js': { loadProjectConfig: function () { return null; } },
        './common/mcpParse.js': mcpParseModule,
        './common/mergeVerdictGate.js': mGate({
            github_get_pr_comments: globals.github_get_pr_comments,
            github_create_comment: globals.github_create_comment
        })
    }), globals);
    return { lane: lane, calls: calls };
}

function runLane(opts, jobParams) {
    var loaded = loadLane(opts);
    var result = loaded.lane.action({
        ticket: { key: 'gh-33', prNumber: 12 },
        // Undefined jobParams keeps the default (machineAuthor set);
        // an explicit object REPLACES it (the unconfigured shape).
        jobParams: jobParams === undefined ? { machineAuthor: BOT } : jobParams
    });
    return { result: result, calls: loaded.calls };
}

function holdsPosted(calls) {
    return calls.comments.filter(function (c) {
        return String(c.body || '').indexOf('dmtools:merge-hold') !== -1;
    });
}

suite('retryMergeGithubPR: verdict gate at the merge instant (gh-1416)', function () {

    test('REQUEST_CHANGES record on the current head -> merge deferred, lock released, hold marker posted', function () {
        var r = runLane({ comments: [verdictComment('REQUEST_CHANGES', HEAD)], prDetail: prDetail() });
        assert.equal(r.result, false, 'held — the SM retries next cycle');
        assert.equal(r.calls.merges.length, 0, 'no squash-merge on a blocking verdict');
        var holds = holdsPosted(r.calls);
        assert.equal(holds.length, 1, 'exactly ONE hold marker on the PR');
        assert.equal(holds[0].number, 12);
        assert.contains(holds[0].body, '"head":"' + HEAD + '"');
        assert.deepEqual(r.calls.removed.map(function (x) { return x.label; }), [],
            'pr_approved stays — the deferral is not a rework flip (the SM owns the lap)');
    });

    test('hold marker is deduped per head: the replay adds NO second comment', function () {
        var opts = { comments: [verdictComment('REQUEST_CHANGES', HEAD)], prDetail: prDetail() };
        var first = runLane(opts);
        assert.equal(holdsPosted(first.calls).length, 1);
        opts.comments.push({ body: holdsPosted(first.calls)[0].body,
            user: { login: BOT + '[bot]' } });
        var second = runLane(opts);
        assert.equal(second.result, false, 'still held — the verdict stands');
        assert.equal(holdsPosted(second.calls).length, 0,
            'never a new comment per tick (refreshed in place)');
    });

    test('APPROVE record on the current head -> merges', function () {
        var r = runLane({ comments: [verdictComment('APPROVE', HEAD)], prDetail: prDetail() });
        assert.equal(r.result, true);
        assert.equal(r.calls.merges.length, 1);
        assert.equal(r.calls.merges[0].method, 'squash');
        assert.equal(holdsPosted(r.calls).length, 0);
        assert.ok(r.calls.removed.some(function (x) { return x.label === 'pr_approved'; }),
            'the approval is consumed after the merge');
    });

    test('no verdict records -> merges (fail-open, asserted)', function () {
        var r = runLane({ comments: [], prDetail: prDetail() });
        assert.equal(r.result, true);
        assert.equal(r.calls.merges.length, 1);
    });

    test('stale-head record only -> merges (fail-open, asserted)', function () {
        var r = runLane({ comments: [verdictComment('REQUEST_CHANGES', '1111111feedface')],
            prDetail: prDetail() });
        assert.equal(r.result, true, 'a verdict for an OLDER head never holds the current one');
        assert.equal(r.calls.merges.length, 1);
        assert.equal(holdsPosted(r.calls).length, 0);
    });

    test('unreadable/garbage markers -> merges, fail-open', function () {
        var r = runLane({ comments: [
            { body: '<!-- dmtools:review-verdict {broken -->', user: { login: BOT + '[bot]' } },
            { body: 'REQUEST_CHANGES prose, no marker', user: { login: BOT + '[bot]' } }
        ], prDetail: prDetail() });
        assert.equal(r.result, true);
        assert.equal(r.calls.merges.length, 1);
    });

    test('unreadable comment read -> merges, fail-open (logged)', function () {
        var r = runLane({ comments: [], getCommentsThrows: '500 boom', prDetail: prDetail() });
        assert.equal(r.result, true, 'a broken read must not hold the merge');
        assert.equal(r.calls.merges.length, 1);
        assert.equal(holdsPosted(r.calls).length, 0);
    });

    test('unconfigured machineAuthor -> no trusted records, merges as today', function () {
        var r = runLane({ comments: [verdictComment('REQUEST_CHANGES', HEAD)], prDetail: prDetail() },
            {}); // no machineAuthor in jobParams
        assert.equal(r.result, true, 'empty allowlist = nothing trusted = fail-open');
        assert.equal(r.calls.merges.length, 1);
    });

    test('unlinked-PR path (no prNumber): the merge stays gated too', function () {
        var loaded = loadLane({
            comments: [verdictComment('REQUEST_CHANGES', HEAD)],
            prDetail: prDetail(),
            openPrs: [{ number: 12, body: 'Closes #33', head: { ref: 'ai/gh-33' } }]
        });
        var result = loaded.lane.action({
            ticket: { key: 'gh-33' }, // resolved via the branch match
            jobParams: { machineAuthor: BOT }
        });
        assert.equal(result, false, 'the branch-matched PR is held the same way');
        assert.equal(loaded.calls.merges.length, 0);
        assert.equal(holdsPosted(loaded.calls).length, 1);
    });
});

suite('retryMergeGithubPR: lane characterization (gate-neutral shapes)', function () {

    test('not-ready mergeState -> no merge, lock released, gate not consulted', function () {
        var r = runLane({ comments: [verdictComment('REQUEST_CHANGES', HEAD)],
            prDetail: prDetail({ mergeable_state: 'blocked' }) });
        assert.equal(r.result, false);
        assert.equal(r.calls.merges.length, 0);
        assert.equal(r.calls.commentReads.length, 0, 'the gate runs at the MERGE instant only');
        assert.equal(holdsPosted(r.calls).length, 0);
    });

    test('dirty head -> back to rework, no gate consult', function () {
        var r = runLane({ comments: [], prDetail: prDetail({ mergeable: false, mergeable_state: 'dirty' }) });
        assert.equal(r.result, false);
        assert.equal(r.calls.merges.length, 0);
        assert.ok(r.calls.removed.some(function (x) { return x.label === 'pr_approved'; }));
        assert.ok(r.calls.added.some(function (x) {
            return (x.labels || []).indexOf('agent:rework') !== -1;
        }));
        assert.equal(r.calls.commentReads.length, 0);
    });

    test('BEHIND -> branch update requested, no merge, no gate consult', function () {
        var r = runLane({ comments: [], prDetail: prDetail({ mergeable_state: 'behind' }) });
        assert.equal(r.result, false);
        assert.equal(r.calls.merges.length, 0);
        assert.equal(r.calls.branchUpdates.length, 1);
        assert.equal(r.calls.commentReads.length, 0);
    });

    test('missing ticket issue number -> early false', function () {
        var loaded = loadLane({});
        assert.equal(loaded.lane.action({ ticket: { key: 'nope' }, jobParams: {} }), false);
    });
});
