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
function mMergeBackstop(globals) {
    // One mergeBackstop instance per injected-global set (gh-1416): the
    // gate's githubBridgeIo is the SUBSET VIEW of the backstop's, and the
    // typeof guards read the eval context — so the instance the gate
    // delegates to must see the SAME bridge mocks the lane injected, or
    // its guards map null and every gate scenario silently skips.
    // Reference-equality pairs, NOT object property keys — every globals
    // object stringifies to "[object Object]" and would bind the first
    // fixture's comment read forever.
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
function mTwoStageGate(globals) {
    // gh-1417: the lane's SECOND gate require (./common/mergeGate.js — the
    // two-stage engine). Same per-call load + full global set as the other
    // lanes' test loaders (mergeTrigger/test_mergeBot): the gate delegates
    // stage 1 to the SAME backstop instance the verdict gate rides (one
    // per injected-global set, see mMergeBackstop).
    return loadModule('js/common/mergeGate.js', makeRequire({
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': mReviewVerdicts(),
        './machineAuthor.js': mMachineAuthor(),
        './machineNotice.js': loadModule('js/common/machineNotice.js', makeRequire({}), {}),
        '../configLoader.js': { loadProjectConfig: function () { return null; } },
        './mergeBackstop.js': mMergeBackstop(globals || null),
        './mergeVerdictGate.js': mGate(globals || null)
    }), globals || {});
}

function mGate(globals) {
    // Per-call load: the gate must SEE the lane's own bridge mocks (one
    // engine-global set per fixture — memoizing would bind the first
    // fixture's comment read forever).
    return loadModule('js/common/mergeVerdictGate.js', makeRequire({
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': mReviewVerdicts(),
        './mergeBackstop.js': mMergeBackstop(globals || null)
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
        commentReads: [], branchUpdates: [], threads: [] };
    var globals = laneGlobals(opts, calls);
    var scmStub = {
        createScm: function () {
            return laneScm(opts, calls);
        }
    };
    var lane = loadModule('js/retryMergeGithubPR.js', makeRequire({
        './common/scm.js': scmStub,
        './configLoader.js': { loadProjectConfig: function () { return null; } },
        './common/mcpParse.js': mcpParseModule,
        './common/mergeVerdictGate.js': opts.gateModule || mGate({
            github_get_pr_comments: globals.github_get_pr_comments,
            github_create_comment: globals.github_create_comment
        }),
        './common/mergeGate.js': mTwoStageGate(globals)
    }), globals);
    return { lane: lane, calls: calls };
}

// The bridge-primitive globals (the payload shaping of the lane's comment
// read): which comments are served, whether the read primitive is absent,
// and whether it throws. Every call lands in `calls`.
function laneGlobals(opts, calls) {
    return {
        github_remove_label: function (a) { calls.removed.push(a); return '{}'; },
        github_add_labels: function (a) { calls.added.push(a); return '{}'; },
        github_create_comment: function (a) { calls.comments.push(a); return '{}'; },
        github_get_issue: opts.getIssueThrows ? function () {
            throw new Error(opts.getIssueThrows);
        } : function () {
            return JSON.stringify({ number: 33, state: opts.getIssueState || 'closed' });
        },
        github_close_issue: function (a) { calls.closed.push(a); return '{}'; },
        github_get_pr_comments: opts.noCommentsPrimitive ? undefined : function (a) {
            calls.commentReads.push(a);
            if (opts.getCommentsThrows) throw new Error(opts.getCommentsThrows);
            return JSON.stringify(opts.comments || []);
        },
        // gh-1417: the two-stage merge gate reads the threads census on
        // every merge attempt — the gate-neutral scenarios serve the EMPTY
        // production payload (census 0 → merge proceeds). The undeclared
        // global here is the test-runner network guard (it throws), not a
        // missing capability, so the gate's skip path never sees these
        // fixtures. opts.threadsByNumber injects open threads for the
        // lane's own hold wiring test.
        github_get_pr_review_threads: function (a) {
            calls.threads.push(a);
            return JSON.stringify({ data: { repository: { pullRequest:
                { reviewThreads: { nodes: (opts.threadsByNumber || {})[a.pullRequestId] || [] } } } } });
        }
    };
}

// The scm provider stub (the lane's PR-source wiring): the open/merged PR
// lists, the PR detail payload, and the merge/branch-update recorders.
function laneScm(opts, calls) {
    return {
        getRemoteRepoInfo: function () {
            return opts.remoteRepoNull ? null : { owner: 'o', repo: 'n' };
        },
        listPrs: function (state) {
            if (state === 'merged' && opts.mergedPrs) return opts.mergedPrs;
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
            'never a new comment per tick (the existing marker is reused in place)');
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

    // gh-1417 AC3 lane coverage: stage 2 rides the SAME two-stage engine —
    // an open (human-authored) review thread holds THIS lane's merge too,
    // marker deduped per head, and the lane defers (the SM retries).
    test('gh-1417: an open review thread holds the lane merge (stage 2)', function () {
        var r = runLane({
            comments: [],
            prDetail: prDetail(),
            threadsByNumber: { 12: [{ id: 'PRT_H1', isResolved: false,
                comments: { nodes: [{ databaseId: 9100,
                    author: { login: 'human-reviewer' }, body: 'a human finding' }] } }] }
        });
        assert.equal(r.result, false, 'the lane defers — the merge is held');
        assert.equal(r.calls.merges.length, 0, 'no merge while a thread is open');
        var holds = holdsPosted(r.calls);
        assert.equal(holds.length, 1, 'exactly ONE hold marker on the PR');
        assert.contains(holds[0].body, '"reason":"open-threads"');
        assert.contains(holds[0].body, '"human":1');
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

// ── verdictGateHoldsMerge: the extracted merge-instant wiring (gh-1416
// rework: the helper the action delegates to — directly unit-testable
// without driving the whole lane, mergeTrigger's verdictGateBeforeMerge
// shape) ─────────────────────────────────────────────────────────────────────

suite('retryMergeGithubPR: verdictGateHoldsMerge helper (gh-1416 rework)', function () {

    test('held: REQUEST_CHANGES on the current head -> true, hold marker posted', function () {
        var loaded = loadLane({ comments: [verdictComment('REQUEST_CHANGES', HEAD)] });
        var held = loaded.lane.verdictGateHoldsMerge(
            { machineAuthor: BOT }, 'o', 'n', 12, prDetail());
        assert.equal(held, true, 'the caller defers the merge');
        assert.equal(holdsPosted(loaded.calls).length, 1,
            'the hold marker posts through the shared bridge primitives');
        assert.equal(loaded.calls.merges.length, 0, 'the helper only probes — it never merges');
    });

    test('not held: APPROVE on the current head -> false, no comment', function () {
        var loaded = loadLane({ comments: [verdictComment('APPROVE', HEAD)] });
        var held = loaded.lane.verdictGateHoldsMerge(
            { machineAuthor: BOT }, 'o', 'n', 12, prDetail());
        assert.equal(held, false);
        assert.equal(holdsPosted(loaded.calls).length, 0);
    });

    test('fail-open: a gate-level throw is absorbed -> false', function () {
        var loaded = loadLane({ gateModule: {
            githubBridgeIo: function () { return {}; },
            runGateForPr: function () { throw new Error('gate boom'); }
        } });
        var held = loaded.lane.verdictGateHoldsMerge(
            { machineAuthor: BOT }, 'o', 'n', 12, prDetail());
        assert.equal(held, false, 'a wiring-level fault proceeds as today');
    });

    test('the action still defers through the helper (held lane shape intact)', function () {
        var r = runLane({ comments: [verdictComment('REQUEST_CHANGES', HEAD)], prDetail: prDetail() });
        assert.equal(r.result, false, 'held — the SM retries next cycle');
        assert.equal(r.calls.merges.length, 0);
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

    test('already-merged PR -> cleanup: labels dropped, issue closed, no merge, no gate consult', function () {
        var loaded = loadLane({
            openPrs: [],
            mergedPrs: [{ number: 12, body: 'Closes #33', head: { ref: 'ai/gh-33' } }],
            comments: [verdictComment('REQUEST_CHANGES', HEAD)]
        });
        var result = loaded.lane.action({
            ticket: { key: 'gh-33' }, // resolved via the branch match on the merged list
            jobParams: { machineAuthor: BOT }
        });
        assert.equal(result, true, 'the merged-PR cleanup is a handled outcome');
        assert.equal(loaded.calls.merges.length, 0, 'nothing to merge');
        assert.equal(loaded.calls.commentReads.length, 0, 'the gate runs at the MERGE instant only');
        assert.ok(loaded.calls.removed.some(function (x) { return x.label === 'pr_approved'; }),
            'the approval is consumed by the cleanup');
        assert.equal(loaded.calls.closed.length, 1, 'the issue is closed by the cleanup');
        assert.ok(loaded.calls.comments.some(function (c) {
            return String(c.body || '').indexOf('Merged via #12') !== -1;
        }), 'the merged note is posted');
    });

    test('missing ticket issue number -> early false', function () {
        var loaded = loadLane({});
        assert.equal(loaded.lane.action({ ticket: { key: 'nope' }, jobParams: {} }), false);
    });

    test('unresolvable repo (no remote, no explicit config) -> early false', function () {
        var loaded = loadLane({ remoteRepoNull: true });
        var result = loaded.lane.action({
            ticket: { key: 'gh-33', prNumber: 12 }, jobParams: { machineAuthor: BOT }
        });
        assert.equal(result, false, 'no owner/repo — nothing to operate on');
        assert.equal(loaded.calls.merges.length, 0);
        assert.equal(loaded.calls.commentReads.length, 0, 'the gate never consults without a repo');
    });

    test('no open or merged PR found -> false, lock released', function () {
        var loaded = loadLane({ openPrs: [], mergedPrs: [] });
        var result = loaded.lane.action({
            ticket: { key: 'gh-40' }, // no PR links gh-40 (branch/body/merged all miss)
            jobParams: { machineAuthor: BOT }
        });
        assert.equal(result, false, 'nothing to merge — the SM retries');
        assert.equal(loaded.calls.merges.length, 0);
        assert.equal(loaded.calls.closed.length, 0);
    });

    test('mergeable false with a clean mergeState -> conflicts path (rework flip)', function () {
        var r = runLane({ comments: [],
            prDetail: prDetail({ mergeable: false, mergeable_state: 'clean' }) });
        assert.equal(r.result, false);
        assert.ok(r.calls.added.some(function (x) {
            return (x.labels || []).indexOf('agent:rework') !== -1;
        }), 'mergeable false is a conflict shape even when the state string is clean');
    });

    test('mergeStateStatus fallback shape drives the decision (GraphQL-only payload)', function () {
        var detail = { number: 12, state: 'open', mergeable: true,
            mergeStateStatus: 'CLEAN', head: { sha: HEAD } };
        var r = runLane({ comments: [verdictComment('APPROVE', HEAD)], prDetail: detail });
        assert.equal(r.result, true, 'mergeStateStatus (no mergeable_state) reaches the merge');
        assert.equal(r.calls.merges.length, 1);
    });

    test('post-merge: an open linked issue is closed by the safety net', function () {
        var r = runLane({ comments: [verdictComment('APPROVE', HEAD)], prDetail: prDetail(),
            getIssueState: 'open' });
        assert.equal(r.result, true);
        assert.ok(r.calls.closed.length >= 1, 'the open issue is closed after the merge');
    });

    test('post-merge: a failing issue read is non-fatal (safety-net catch)', function () {
        var r = runLane({ comments: [verdictComment('APPROVE', HEAD)], prDetail: prDetail(),
            getIssueThrows: 'get issue boom' });
        assert.equal(r.result, true, 'the safety-net fault never fails the merged outcome');
        assert.equal(r.calls.merges.length, 1);
    });
});
