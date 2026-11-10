/* Unit tests for js/retryMergeGithubPR.js — the GitHub-issues machine
 * loop's merge leg, focused on the gh-1416 verdict-freshness gate at the
 * squash-merge instant (plus the surrounding pass/hold/fail-open shapes). */
/* global loadModule, assert, test, suite, makeRequire */

var mcpParseModule = loadModule('js/common/mcpParse.js', makeRequire({}), {});

var BOT = 'merge-bot';
var HEAD = '0c2732dfeedface0deadbeefcafe0123456789ab';

// The verdict-marker comment builder (the real one — the body a review leg posts).
function verdictComment(verdict, head, login) {
    var rv = loadModule('js/common/reviewVerdicts.js', makeRequire({
        './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
    }), {});
    return {
        body: rv.buildVerdictComment({
            head: head, verdict: verdict, blocking: 0, important: 1,
            suggestions: 0, at: '2026-11-09T15:42:44Z', source: 'pr_review.json'
        }),
        user: { login: login || BOT + '[bot]' }
    };
}

// The retry lane resolves the repo through the scm provider (or the
// explicit config.repository); both are stubbed here. detail = the get_pr
// payload (REST shape).
function loadLane(mods, opts) {
    opts = opts || {};
    var calls = { merges: [], removed: [], added: [], comments: [], closed: [],
        commentReads: [], branchUpdates: [] };
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
    // The gate module shares the lane's bridge mocks (one engine-global set
    // in production) and the stubbed configLoader closure of the backstop.
    var backstop = loadModule('js/common/mergeBackstop.js', makeRequire({
        './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({
            './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
        }), {}),
        './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({
                './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
            }), {})
        }), {}),
        './reviewDebtLedger.js': loadModule('js/common/reviewDebtLedger.js', makeRequire({
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({
                './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
            }), {}),
            './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
                './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({
                    './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
                }), {})
            }), {}),
            './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({}), {})
        }), {}),
        './reviewDispositions.js': loadModule('js/common/reviewDispositions.js', makeRequire({
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({
                './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
            }), {}),
            './reviewPolicy.js': loadModule('js/common/reviewPolicy.js', makeRequire({
                './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({
                    './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
                }), {})
            }), {})
        }), {}),
        './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
        './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js', makeRequire({
            './machineNotice.js': loadModule('js/common/machineNotice.js', makeRequire({}), {})
        }), {}),
        './mcpParse.js': mcpParseModule,
        '../configLoader.js': { loadProjectConfig: function () { return null; } }
    }), {});
    var gate = loadModule('js/common/mergeVerdictGate.js', makeRequire({
        './mcpParse.js': mcpParseModule,
        './reviewVerdicts.js': backstop && loadModule('js/common/reviewVerdicts.js', makeRequire({
            './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
        }), {}),
        './mergeBackstop.js': backstop
    }), {
        github_get_pr_comments: globals.github_get_pr_comments,
        github_create_comment: globals.github_create_comment
    });
    var lane = loadModule('js/retryMergeGithubPR.js', makeRequire({
        './common/scm.js': scmStub,
        './configLoader.js': { loadProjectConfig: function () { return null; } },
        './common/mcpParse.js': mcpParseModule,
        './common/mergeVerdictGate.js': gate
    }), globals);
    return { lane: lane, calls: calls, globals: globals };
}

function runLane(opts, extraParams) {
    var loaded = loadLane(modsFor(opts), opts);
    var params = Object.assign({
        ticket: { key: 'gh-33', prNumber: 12 },
        jobParams: Object.assign({ machineAuthor: BOT }, (opts && opts.jobParams) || {})
    }, extraParams || {});
    var result = loaded.lane.action(params);
    return { result: result, calls: loaded.calls };
}

// detail payload shared by every scenario: mergeable CLEAN with a head sha.
function prDetail(over) {
    var d = { number: 12, state: 'open', mergeable: true, mergeable_state: 'clean',
        head: { sha: HEAD } };
    for (var k in (over || {})) d[k] = over[k];
    return d;
}

function modsFor(opts) { return opts; }

function holdsPosted(calls) {
    return calls.comments.filter(function (c) {
        return String(c.body || '').indexOf('dmtools:merge-hold') !== -1;
    });
}

suite('retryMergeGithubPR: verdict gate at the merge instant (gh-1416)', function () {

    test('REQUEST_CHANGES record on the current head -> merge deferred, lock released, hold marker posted', function () {
        var r = runLane({ comments: [verdictComment('REQUEST_CHANGES', HEAD)],
            prDetail: prDetail() });
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
        assert.equal(second.result, false, 'still held');
        assert.equal(holdsPosted(second.calls).length, 1, 'never a new comment per tick');
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
        var loaded = loadLane({ comments: [verdictComment('REQUEST_CHANGES', HEAD)],
            prDetail: prDetail() });
        var result = loaded.lane.action({
            ticket: { key: 'gh-33', prNumber: 12 },
            jobParams: {} // no machineAuthor
        });
        assert.equal(result, true, 'empty allowlist = nothing trusted = fail-open');
        assert.equal(loaded.calls.merges.length, 1);
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
        assert.ok(r.calls.added.some(function (x) { return x.label === 'agent:rework'; }));
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
