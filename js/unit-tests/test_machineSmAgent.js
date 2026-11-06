/**
 * Unit tests for machineSmAgent.js — the machine-loop watchdog decision core.
 *
 * The decision core (decideActions, issueFromRunTitle, checkConclusion) is
 * pure; these tests pin the reconciler contract: dead-letter re-fires,
 * rework round cap, review/merge/update-branch routing, concurrency skips.
 */
/* global suite, test, assert, loadModule, makeRequire */

// gh-1352: the disposition-loop modules (reviewPolicy, reviewDispositions,
// reviewDebtLedger, polishLap) join the agent's require map — every
// loadModule('js/machineSmAgent.js') site shares one map factory so the
// gh-823 pack-require rule stays satisfied in every suite.
function rvShared() {
    if (!rvShared.mod) rvShared.mod = loadModule('js/common/reviewVerdicts.js',
        makeRequire({ './machineAuthor.js': maShared() }), {});
    return rvShared.mod;
}

// gh-1366: the failure-analyzer module (the agent's require map member).
function faShared() {
    if (!faShared.mod) {
        faShared.mod = loadModule('js/common/failureAnalyzer.js', makeRequire({
            './legFailureReport.js': lfrModule(),
            './reviewVerdicts.js': rvShared()
        }), {});
    }
    return faShared.mod;
}

// gh-1366: commentMarkup (the park diagnostic's flavor bag).
function cmShared() {
    if (!cmShared.mod) {
        cmShared.mod = loadModule('js/common/commentMarkup.js', makeRequire({
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js', makeRequire({}), {})
        }), {});
    }
    return cmShared.mod;
}

function lfrModule() {
    if (!lfrModule.mod) lfrModule.mod = loadModule('js/common/legFailureReport.js', makeRequire({}), {});
    return lfrModule.mod;
}

function maShared() {
    if (!maShared.mod) maShared.mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    return maShared.mod;
}

// The polish-lap module under test (marker round-trip in the loop suites).
function plShared() {
    if (!plShared.mod) plShared.mod = loadModule('js/common/polishLap.js',
        makeRequire({
            './reviewVerdicts.js': rvShared(),
            './machineAuthor.js': maShared(),
            './reviewPolicy.js': loadModule('js/common/reviewPolicy.js',
                makeRequire({ './reviewVerdicts.js': rvShared() }), {})
        }), {});
    return plShared.mod;
}

function agentModuleMap(projectConfig, holder) {
    var policy = loadModule('js/common/reviewPolicy.js',
        makeRequire({ './reviewVerdicts.js': rvShared() }), {});
    return {
        './config.js': configModule,
        './configLoader.js': { loadProjectConfig: function () { return projectConfig || {}; } },
        './common/smProvider.js': { createSmProvider: function () { return holder ? holder.provider : {}; } },
        './common/reviewVerdicts.js': rvShared(),
        './common/machineAuthor.js': maShared(),
        './common/reworkLoopGuard.js': loadModule('js/common/reworkLoopGuard.js',
            makeRequire({ './machineAuthor.js': maShared(), './reviewVerdicts.js': rvShared() }), {}),
        './common/reviewPolicy.js': policy,
        './common/reviewDispositions.js': loadModule('js/common/reviewDispositions.js',
            makeRequire({ './reviewVerdicts.js': rvShared(), './reviewPolicy.js': policy }), {}),
        './common/reviewDebtLedger.js': loadModule('js/common/reviewDebtLedger.js',
            makeRequire({
                './reviewVerdicts.js': rvShared(),
                './findingRegistry.js': loadModule('js/common/findingRegistry.js',
                    makeRequire({ './reviewVerdicts.js': rvShared() }), {}),
                './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({}))
            }), {}),
        './common/polishLap.js': loadModule('js/common/polishLap.js',
            makeRequire({
                './reviewVerdicts.js': rvShared(),
                './machineAuthor.js': maShared(),
                './reviewPolicy.js': policy
            }), {}),
        './common/failureAnalyzer.js': faShared(),
        './common/commentMarkup.js': cmShared(),
        './common/mergeObjects.js': loadModule('js/common/mergeObjects.js', makeRequire({}), {})
    };
}

suite('machineSm decision core', function () {

    var agent = loadModule('js/machineSmAgent.js', makeRequire(agentModuleMap({}, null)), {
        cli_execute_command: function () { return '{}'; }
    });

    function st(labels, pr, active) {
        return {
            issue: { number: 1, labels: labels, assignees: [] },
            pr: pr === undefined ? null : pr,
            activeRunForIssue: !!active
        };
    }

    // ── guard states ─────────────────────────────────────────────────────────

    test('needs-human is terminal — no action', function () {
        var acts = agent.decideActions(st(['needs-human'], null), {});
        assert.equal(acts.length, 1);
        assert.equal(acts[0].type, 'skip');
    });

    test('blocked is the freeze switch — the reconciler skips the item entirely (fa #939)', function () {
        // No dead-letter re-fire, no branch update, no merge, no close —
        // whatever the state says, a blocked item gets a single skip.
        var dead = agent.decideActions(st(['blocked', 'agent:dev'], null), {});
        assert.equal(dead.length, 1);
        assert.equal(dead[0].type, 'skip');
        assert.contains(dead[0].reason, 'blocked');

        var greenApproved = { number: 7, state: 'OPEN', checkConclusion: 'green',
                              mergeState: 'CLEAN', mergeable: true };
        var mergeable = agent.decideActions(st(['blocked', 'pr_approved', 'ai_validating'], greenApproved), {});
        assert.equal(mergeable.length, 1, 'a blocked approved green PR must NOT be merged');
        assert.equal(mergeable[0].type, 'skip');

        var merged = agent.decideActions(st(['blocked', 'ai_developed'],
            { number: 9, state: 'MERGED' }), {});
        assert.equal(merged.length, 1, 'a blocked issue is not even auto-closed');
        assert.equal(merged[0].type, 'skip');

        // Control: the same approved-green state without the label merges.
        var live = agent.decideActions(st(['pr_approved', 'ai_validating'], greenApproved), {});
        assert.ok(live.some(function (a) { return a.type === 'merge'; }),
            'removing the label re-exposes the item to the normal loop');
    });

    test('active run for the issue skips reconciliation', function () {
        var acts = agent.decideActions(st(['agent:dev'], null, true), {});
        assert.equal(acts[0].type, 'skip');
    });

    // ── no PR ────────────────────────────────────────────────────────────────

    test('ai_developed without a PR re-fires rework (dead dev run)', function () {
        var acts = agent.decideActions(st(['ai_developed'], null), {});
        assert.equal(acts[0].type, 'dispatch');
        assert.equal(acts[0].leg, 'rework');
    });

    test('agent:dev without a PR re-fires dev (dead letter)', function () {
        var acts = agent.decideActions(st(['agent:dev'], null), {});
        assert.equal(acts[0].leg, 'dev');
    });

    test('stale agent:rework with no PR re-fires rework', function () {
        var acts = agent.decideActions(st(['agent:rework'], null), {});
        assert.equal(acts[0].leg, 'rework');
    });

    // ── merged / closed ──────────────────────────────────────────────────────

    test('merged PR triggers the close-issue safety net', function () {
        var acts = agent.decideActions(st(['ai_developed'], { number: 9, state: 'MERGED' }), {});
        assert.equal(acts[0].type, 'closeIssue');
    });

    test('closed-unmerged PR is a plain skip', function () {
        var acts = agent.decideActions(st(['ai_developed'], { number: 9, state: 'CLOSED' }), {});
        assert.equal(acts[0].type, 'skip');
    });

    // ── red CI ───────────────────────────────────────────────────────────────

    function redPr() {
        return { number: 7, state: 'OPEN', checkConclusion: 'red',
                 mergeState: 'BLOCKED', mergeable: false };
    }

    test('red CI dispatches rework', function () {
        var acts = agent.decideActions(st(['ai_developed'], redPr()), {});
        assert.equal(acts[0].type, 'dispatch');
        assert.equal(acts[0].leg, 'rework');
    });

    test('red CI with stale agent:rework still re-fires (dead-letter fix, #116)', function () {
        var acts = agent.decideActions(st(['ai_developed', 'agent:rework'], redPr()), {});
        assert.equal(acts[0].leg, 'rework');
    });

    test('red CI after maxReworkRoundscap escalates to needs-human', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'rework-round-1', 'rework-round-2'], redPr()),
            { maxReworkRounds: 2 });
        assert.equal(acts[0].type, 'label');
        assert.equal(acts[0].label, 'needs-human');
    });

    test('pending checks wait for the next tick', function () {
        var acts = agent.decideActions(
            st(['ai_developed'], { number: 7, state: 'OPEN', checkConclusion: 'pending' }), {});
        assert.equal(acts[0].type, 'skip');
    });

    // ── green paths ──────────────────────────────────────────────────────────

    function greenPr(mergeState, mergeable) {
        return { number: 7, state: 'OPEN', checkConclusion: 'green',
                 mergeState: mergeState || 'CLEAN', mergeable: mergeable !== false };
    }

    test('green + ai_developed dispatches review', function () {
        var acts = agent.decideActions(st(['ai_developed'], greenPr()), {});
        assert.equal(acts[0].leg, 'review');
    });

    test('green + reviewed-not-approved + stale agent:rework re-fires rework', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'agent:rework'], greenPr()), {});
        assert.equal(acts[0].leg, 'rework');
    });

    test('approved + BEHIND updates the branch instead of merging', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'], greenPr('BEHIND')), {});
        assert.equal(acts[0].type, 'updateBranch');
    });

    test('approved + CLEAN merges (squash parity with merge-trigger)', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'], greenPr('CLEAN')), {});
        assert.equal(acts[0].type, 'merge');
    });

    test('approved + mergeable null mergeState falls back to mergeable=true', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'],
               greenPr('UNKNOWN', true)), {});
        assert.equal(acts[0].type, 'merge');
    });

    test('approved + BLOCKED runs the disposition loop in-tick (gh-828 -> gh-1352)', function () {
        // The unresolved-thread conversation gate: the rework arm is
        // withheld on APPROVE+blocking=0 (gh-807), so the machine must
        // resolve its own non-blocking threads or the PR strands BLOCKED.
        // gh-1352: the leg is the disposition loop (polish lap when the
        // census is polish-only, else triage with dispositions).
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'],
               greenPr('BLOCKED', false)), {});
        assert.equal(acts.length, 1);
        assert.equal(acts[0].type, 'dispositionLoop');
        assert.equal(acts[0].allowPolish, true);
    });

    test('gh-1352: approved + CLEAN merges FIRST, then triages without a polish lap', function () {
        // Merge parity owns a clean head; the disposition loop follows as
        // post-merge hygiene and must never dispatch a polish lap there
        // (a merged head cannot take the lap's commit).
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'],
               greenPr('CLEAN', true)), {});
        assert.equal(acts.length, 2);
        assert.equal(acts[0].type, 'merge');
        assert.equal(acts[1].type, 'dispositionLoop');
        assert.equal(acts[1].allowPolish, false);
    });

    test('approved + UNKNOWN merge state still skips', function () {
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'],
               greenPr('UNKNOWN', false)), {});
        assert.equal(acts[0].type, 'skip');
    });

    // ── CRAP-ratchet branch coverage (gh-1185): the three remaining skip
    //    leaves of the decision core, pinned so the extracted helpers keep
    //    100% branch coverage (CRAP <= 8 needs ~full coverage at CC 7). ──

    test('no PR and no machine leg label → plain skip (nothing to re-fire)', function () {
        var acts = agent.decideActions(st([], null), {});
        assert.equal(acts.length, 1);
        assert.equal(acts[0].type, 'skip');
        assert.equal(acts[0].reason, 'no PR and no machine leg to (re)fire');
    });

    test('reviewed but not approved and NO agent:rework label → waiting skip', function () {
        var greenPr = { number: 7, state: 'OPEN', checkConclusion: 'green',
                        mergeState: 'CLEAN', mergeable: true };
        var acts = agent.decideActions(st(['ai_pr_reviewed'], greenPr), {});
        assert.equal(acts.length, 1);
        assert.equal(acts[0].type, 'skip');
        assert.equal(acts[0].reason, 'reviewed, verdict not approve — awaiting rework labeling');
    });

    test('green PR with no machine-leg labels at all → steady state', function () {
        var greenPr = { number: 7, state: 'OPEN', checkConclusion: 'green',
                        mergeState: 'CLEAN', mergeable: true };
        var acts = agent.decideActions(st([], greenPr), {});
        assert.equal(acts.length, 1);
        assert.equal(acts[0].type, 'skip');
        assert.equal(acts[0].reason, 'steady state');
    });

    // ── helpers ──────────────────────────────────────────────────────────────

    test('issueFromRunTitle parses gh-N from run titles', function () {
        assert.equal(agent.issueFromRunTitle('🔧 rework · gh-125: Machine comments'), 125);
        assert.equal(agent.issueFromRunTitle('⚒️ dev · gh-3: no digits elsewhere'), 3);
        assert.equal(agent.issueFromRunTitle('no issue here'), null);
    });

});

suite('machineSm resolveSuggestionThreads (gh-828)', function () {

    var rvReal = function () {
        if (!rvReal.mod) rvReal.mod = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {});
        return rvReal.mod;
    };

    // gh-823: every require of the agent must resolve in the map.
    var agent = loadModule('js/machineSmAgent.js', makeRequire(agentModuleMap({}, null)), {
        cli_execute_command: function () { return '{}'; }
    });

    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';
    var RECORD = { head: HEAD, verdict: 'APPROVE', blocking: 0, important: 1, suggestions: 4,
                   at: '2026-10-10T05:47:30.000Z', source: 'pr_review.json' };

    function providerWith(threads, opts) {
        opts = opts || {};
        return {
            calls: { replies: [], resolves: [], posts: [] },
            verdictRecords: function () { return [RECORD]; },
            reviewThreadList: function () { return threads; },
            replyToThread: function (pr, thread, text) {
                this.calls.replies.push({ pr: pr, threadId: thread.threadId, text: text });
            },
            resolveThread: function (pr, thread) {
                this.calls.resolves.push({ pr: pr, threadId: thread.threadId });
            },
            // gh-1352: the review debt ledger primitives (a reachable
            // ledger) — suggestion threads (fix: mandatory under the
            // default policy) defer INTO it instead of closing bare.
            prCommentList: function () { return opts.prComments || []; },
            postPrComment: function (pr, body) {
                this.calls.posts.push({ pr: pr, body: body });
            }
        };
    }
    function sug(i) {
        return { threadId: 'RT_' + i, rootCommentId: 100 + i, resolved: false,
                 author: 'ai-teammate', body: '💡 SUGGESTION: polish ' + i };
    }

    test('AC1 replay (#1457–#1470), gh-1352 semantics: 4 suggestion threads → 4 resolves with deferred dispositions in one tick', function () {
        var p = providerWith([sug(1), sug(2), sug(3), sug(4)]);
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 4);
        assert.equal(out.deferred, 4, 'default policy: suggestion fix is mandatory — the threads defer to the review debt ledger');
        assert.equal(p.calls.replies.length, 4, 'one ack reply per resolved thread');
        assert.contains(p.calls.replies[0].text, 'triage closure (gh-1352)');
        assert.contains(p.calls.replies[0].text, 'deferred: ');
        assert.contains(p.calls.replies[0].text, 'review debt ledger');
        assert.equal(p.calls.resolves.length, 4);
        assert.equal(p.calls.posts.length, 4, 'one ledger marker+digest comment per deferral');
        assert.contains(p.calls.posts[0].body, 'dmtools:review-debt-ledger');
        assert.contains(p.calls.posts[0].body, 'batched');
    });

    test('gh-1352: WITHOUT ledger primitives the mandatory-fix tiers skip (needsFixOrDefer), never close unfixed', function () {
        var bare = {
            calls: { replies: [], resolves: [], posts: [] },
            verdictRecords: function () { return [RECORD]; },
            reviewThreadList: function () { return [sug(1)]; },
            replyToThread: function (pr, thread, text) { this.calls.replies.push(text); },
            resolveThread: function (pr, thread) { this.calls.resolves.push(thread.threadId); }
        };
        var out = agent.resolveSuggestionThreads(bare, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 0);
        assert.equal(out.needsFixOrDefer, 1);
        assert.equal(bare.calls.resolves.length, 0);
    });

    // The BLOCKING review replay (gh-1352 rework lap): the REAL provider
    // drives the deferral loop — prCommentList memoizes per tick (kind
    // prVerdicts), postPrComment is a mutation of that read stream. The
    // skipped invalidate-after-mutation made deferral 2 re-read the stale
    // pre-tick memo, rebuild its marker from the base ledger and win the
    // last-write-wins race: the durable ledger held 1 finding, not 2.
    test('gh-1352 BLOCKING replay: two deferrals in one tick BOTH land in the final ledger marker (memoized provider)', function () {
        var comments = [
            { user: { login: 'ai-teammate' }, body: '<!-- dmtools:review-verdict ' + JSON.stringify({
                head: HEAD, verdict: 'APPROVE', blocking: 0, important: 1, suggestions: 2,
                at: '2026-11-04T00:00:00.000Z', source: 'pr_review.json'
            }) + ' -->' }
        ];
        var replies = [];
        var resolves = [];
        var smMod = loadModule('js/common/smProvider.js',
            makeRequire({
                './reviewVerdicts.js': rvReal(),
                './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {})
            }),
            {
                github_get_pr_comments: function () { return JSON.stringify(comments); },
                github_create_comment: function (args) {
                    comments.push({ user: { login: 'ai-teammate' }, body: args.text });
                    return { id: String(comments.length) };
                },
                github_get_pr_review_threads: function () {
                    return { data: { repository: { pullRequest: { reviewThreads: { nodes: [
                        { id: 'RT_1', isResolved: false, path: 'a.js', line: 1,
                          comments: { nodes: [{ databaseId: 101, author: { login: 'ai-teammate' },
                                               body: '💡 SUGGESTION: polish one' }] } },
                        { id: 'RT_2', isResolved: false, path: 'b.js', line: 2,
                          comments: { nodes: [{ databaseId: 102, author: { login: 'ai-teammate' },
                                               body: '💡 SUGGESTION: polish two' }] } }
                    ] } } } } };
                },
                github_reply_to_pr_thread: function (args) { replies.push(args); return { ok: true }; },
                github_resolve_pr_thread: function (args) { resolves.push(args); return { ok: true }; }
            });
        smMod._cache.entries = {}; // fresh per-tick cache holder
        var provider = smMod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
        var out = agent.resolveSuggestionThreads(provider, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 2, 'both threads resolve');
        assert.equal(out.deferred, 2, 'both deferrals stamp a finding id');
        assert.equal(resolves.length, 2);
        // The durable ledger is the LAST posted marker (the marker family is
        // last-write-wins): it must carry BOTH findings, not just the newest.
        var markers = comments.filter(function (c) {
            return c.body.indexOf('dmtools:review-debt-ledger') !== -1;
        });
        assert.equal(markers.length, 2, 'one ledger marker per deferral');
        var rdl = loadModule('js/common/reviewDebtLedger.js', makeRequire({
            './reviewVerdicts.js': rvReal(),
            './findingRegistry.js': loadModule('js/common/findingRegistry.js',
                makeRequire({ './reviewVerdicts.js': rvReal() }), {}),
            './ledgerCore.js': loadModule('js/common/ledgerCore.js', makeRequire({}))
        }), {});
        var finalLedger = rdl.latestDebtLedger(markers, { authorLogins: ['ai-teammate'] });
        assert.ok(finalLedger, 'the final marker parses as the live ledger');
        assert.equal(finalLedger.findings.length, 2,
            'the durable ledger holds BOTH deferrals — a stale memo dropped finding 1 before the fix');
        assert.deepEqual(finalLedger.findings.map(function (f) { return f.originThread; }),
            ['RT_1', 'RT_2'], 'both thread ids are pinned in the final ledger');
    });

    test('gh-1352: a nit thread closes as wontfix (fix opportunistic — no ledger needed)', function () {
        var p = providerWith([
            { threadId: 'RT_N', rootCommentId: 200, resolved: false, author: 'ai-teammate',
              body: '🪶 NIT: tighten the wording' }]);
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 1);
        assert.equal(out.wontfix, 1);
        assert.contains(p.calls.replies[0].text, 'wontfix: ');
        assert.equal(p.calls.posts.length, 0, 'no ledger write for a fix-optional tier');
    });

    test('gh-1352: a failed ledger append leaves the mandatory-fix thread open (fail closed)', function () {
        var p = providerWith([sug(1)]);
        p.postPrComment = function () { throw new Error('graphql down'); };
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 0);
        assert.equal(out.needsFixOrDefer, 1);
        assert.equal(p.calls.resolves.length, 0, 'the thread is never closed without its ledger finding');
    });

    test('gh-1352: an important (lap-gated) thread is not triage-closable at all', function () {
        var p = providerWith([
            { threadId: 'RT_I', rootCommentId: 300, resolved: false, author: 'ai-teammate',
              body: '⚠️ IMPORTANT: validate the token' }]);
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 0);
        assert.equal(out.needsFixOrDefer, 1);
        assert.equal(p.calls.resolves.length, 0);
    });

    test('AC2: a blocking-marked thread is NOT resolved; the others are', function () {
        var p = providerWith([sug(1),
            { threadId: 'RT_9', rootCommentId: 109, resolved: false, author: 'ai-teammate',
              body: '🚨 BLOCKING: data loss on retry' }]);
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 1);
        assert.ok(p.calls.resolves.every(function (c) { return c.threadId !== 'RT_9'; }),
            'the blocking thread keeps the rework arm');
    });

    test('AC3: human-authored threads are never resolved', function () {
        var p = providerWith([sug(1),
            { threadId: 'RT_H', rootCommentId: 110, resolved: false,
              author: 'repo-owner', body: '💡 SUGGESTION: please rename' }]);
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 1);
        assert.ok(p.calls.resolves.every(function (c) { return c.threadId !== 'RT_H'; }));
    });

    test('fail closed: no machine logins configured → nothing resolves', function () {
        var p = providerWith([sug(1)]);
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD, { machineLogins: [] });
        assert.equal(out.resolved, 0);
        assert.equal(p.calls.resolves.length, 0);
    });

    test('fail closed: no head sha → nothing resolves', function () {
        var p = providerWith([sug(1)]);
        var out = agent.resolveSuggestionThreads(p, 1457, null, { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 0);
    });

    test('fail closed: verdict record on another head (stale approval) → nothing resolves', function () {
        var p = providerWith([sug(1)]);
        var out = agent.resolveSuggestionThreads(p, 1457, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 0);
        assert.equal(p.calls.resolves.length, 0);
    });

    test('idempotent: already-resolved threads are skipped', function () {
        var t = sug(1);
        t.resolved = true;
        var p = providerWith([t]);
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 0);
        assert.equal(p.calls.resolves.length, 0);
    });

    test('provider without the thread primitives (gitlab) is a logged no-op', function () {
        var bare = { verdictRecords: function () { return [RECORD]; } };
        var out = agent.resolveSuggestionThreads(bare, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 0);
    });

    test('a resolve failure does not abort the remaining threads (gh-1352: deferred path)', function () {
        var p = providerWith([sug(1), sug(2)]);
        p.resolveThread = function (pr, thread) {
            if (thread.threadId === 'RT_1') throw new Error('boom');
            this.calls.resolves.push({ pr: pr, threadId: thread.threadId });
        };
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 1);
        assert.equal(p.calls.resolves.length, 1);
    });

    test('a resolve failure leaves no ack behind (resolve-first idempotency; gh-1352 deferred path)', function () {
        // The ack must be posted only AFTER a successful resolve: with
        // reply-first, a persistent resolve failure re-selects the thread
        // next tick and spams one duplicate ack per tick, unbounded.
        var p = providerWith([sug(1), sug(2)]);
        p.resolveThread = function (pr, thread) {
            if (thread.threadId === 'RT_1') throw new Error('graphql down');
            this.calls.resolves.push({ pr: pr, threadId: thread.threadId });
        };
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 1);
        assert.equal(p.calls.replies.length, 1, 'only the RESOLVED thread gets an ack');
        assert.equal(p.calls.replies[0].threadId, 'RT_2');
        assert.equal(p.calls.resolves.length, 1);
    });

    test('a failed ack reply after a successful resolve is logged, not fatal (gh-1185; gh-1352 deferred path)', function () {
        // Resolve-first order: the resolve is counted even when the
        // cosmetic ack reply throws — the thread stays resolved and the
        // next tick's re-selection filters it out.
        var p = providerWith([sug(1), sug(2)]);
        p.replyToThread = function () { throw new Error('comment API down'); };
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 2, 'both resolves are credited despite the ack failures');
        assert.equal(p.calls.resolves.length, 2);
    });

    test('the verdict gate passes the machine-author allowlist to verdictRecords (gh-828 review round 2)', function () {
        // The marker format is public — a forged APPROVE from any
        // comment-capable identity must not unlock auto-resolution. The leg
        // threads cfg.machineLogins through as the parse allowlist.
        var p = providerWith([sug(1)]);
        var seenOpts = null;
        var orig = p.verdictRecords;
        p.verdictRecords = function (pr, opts) { seenOpts = opts; return orig.call(p, pr); };
        agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate', 'github-actions[bot]'] });
        assert.ok(seenOpts && Array.isArray(seenOpts.authorLogins),
            'verdictRecords receives the authorLogins option');
        assert.deepEqual(seenOpts.authorLogins, ['ai-teammate', 'github-actions[bot]']);
    });
});

suite('machineSm cfg knobs — gh-828 review round 4 (override priority)', function () {

    var rvReal = function () {
        if (!rvReal.mod) rvReal.mod = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {});
        return rvReal.mod;
    };
    var maReal = function () {
        if (!maReal.mod) maReal.mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
        return maReal.mod;
    };

    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';
    var RECORD = { head: HEAD, verdict: 'APPROVE', blocking: 0, important: 1, suggestions: 7,
                   at: '2026-10-10T05:47:30.000Z', source: 'pr_review.json' };

    function loadAgent(projectConfig) {
        // The provider is created inside action() — the mock closes over a
        // holder each test fills with its recording provider.
        var holder = { provider: null };
        var agent = loadModule('js/machineSmAgent.js',
            makeRequire(agentModuleMap(projectConfig, holder)), {
                cli_execute_command: function () { return '{}'; }
            });
        return { agent: agent, holder: holder };
    }

    function providerRecording(resolved) {
        var threads = [];
        for (var i = 1; i <= 7; i++) {
            threads.push({ threadId: 'RT_' + i, rootCommentId: 100 + i, resolved: false,
                           author: 'ai-teammate', body: '💡 SUGGESTION: polish ' + i });
        }
        return {
            activeMachineRuns: function () { return []; },
            listMachineIssues: function () {
                return [{ number: 828, title: 'gh-828', labels: ['ai_developed', 'ai_pr_reviewed', 'pr_approved'],
                           assignees: [] }];
            },
            findPr: function () { return { number: 828, state: 'OPEN' }; },
            prStatus: function () {
                return { number: 828, state: 'OPEN', checkConclusion: 'green',
                         mergeState: 'BLOCKED', mergeable: false, headSha: HEAD };
            },
            verdictRecords: function () { return [RECORD]; },
            reviewThreadList: function () { return threads; },
            replyToThread: function () {},
            resolveThread: function (pr, thread) { resolved.push(thread.threadId); },
            // gh-1352: the review debt ledger primitives — the deferral
            // path (mandatory-fix tiers under the default policy) needs a
            // reachable ledger, else the threads skip as needsFixOrDefer.
            prCommentList: function () { return []; },
            postPrComment: function () {}
        };
    }

    function run(agent, jobParams) {
        var params = { jobParams: jobParams };
        params.jobParams.repo = 'o/r';
        return agent.action(params);
    }

    test('maxResolveThreads honors the .dmtools/config.js machineSm override BEFORE jobParams', function () {
        // Every other machineSm knob resolves override before p — this one
        // silently ignored a project-config cap and always read jobParams.
        var resolved = [];
        var loaded = loadAgent({ machineSm: { maxResolveThreads: 5 } });
        loaded.holder.provider = providerRecording(resolved);
        var out = run(loaded.agent, { machineAuthor: 'ai-teammate', maxResolveThreads: 9 });
        assert.equal(out.failures, 0);
        assert.equal(resolved.length, 5, 'the override cap (5) wins over jobParams (9)');
    });

    test('maxResolveThreads falls back to jobParams when no override is set', function () {
        var resolved = [];
        var loaded = loadAgent({});
        loaded.holder.provider = providerRecording(resolved);
        var out = run(loaded.agent, { machineAuthor: 'ai-teammate', maxResolveThreads: 3 });
        assert.equal(out.failures, 0);
        assert.equal(resolved.length, 3, 'the jobParams cap applies without an override');
    });

    test('maxResolveThreads defaults to the module cap when neither override nor jobParams set it', function () {
        var resolved = [];
        var loaded = loadAgent({});
        loaded.holder.provider = providerRecording(resolved);
        var out = run(loaded.agent, { machineAuthor: 'ai-teammate' });
        assert.equal(out.failures, 0);
        assert.equal(resolved.length, 7, 'all 7 eligible threads resolve under the default cap of 20');
    });
});

suite('machineSm: merged slot-holder releases the concurrency slot (gh-952)', function () {
    // Live fa 2026-10-17 (gh-952): PR #1661 was merged by the OWNER via
    // bypass while the machine's validation run for it was still active.
    // The run outlived its issue's lifecycle — and activeMachineRuns kept
    // counting it, so the global concurrency gate (maxConcurrentRuns=1)
    // saw a busy machine on EVERY tick: '⏳ idle — active machine run(s)
    // for issue(s) 1661'. Four+ SM ticks never reconciled anything, the
    // approved queue starved, arms nobody. A run whose issue's linked PR
    // is MERGED can never be consumed by the loop — the slot must release.

    var rvReal = function () {
        if (!rvReal.mod) rvReal.mod = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {});
        return rvReal.mod;
    };
    var maReal = function () {
        if (!maReal.mod) maReal.mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
        return maReal.mod;
    };

    function loadAgent() {
        var holder = { provider: null };
        var agent = loadModule('js/machineSmAgent.js',
            makeRequire(agentModuleMap({}, holder)), {
                cli_execute_command: function () { return '{}'; }
            });
        return { agent: agent, holder: holder };
    }

    function providerWith(activeIssues, prStateByIssue, recorded) {
        return {
            activeMachineRuns: function () { return activeIssues; },
            listMachineIssues: function () {
                return [
                    { number: 1661, title: 'gh-1661', labels: ['ai_developed'], assignees: [] },
                    { number: 2001, title: 'gh-2001', labels: ['agent:dev'], assignees: [] }
                ];
            },
            findPr: function (n) {
                if (prStateByIssue[n]) return { number: 1661, state: prStateByIssue[n] };
                return null;
            },
            prStatus: function () { return null; },
            dispatchLeg: function (issue, leg) { recorded.dispatched.push({ issue: issue, leg: leg }); },
            closeIssue: function (issue) { recorded.closed.push(issue); },
            merge: function () {},
            updateBranch: function () {},
            addIssueLabel: function () {}
        };
    }

    function run(agent) {
        return agent.action({ jobParams: { repo: 'o/r', machineAuthor: 'ai-teammate' } });
    }

    test('gh-952 RED: an active run whose linked PR is MERGED does not idle the machine', function () {
        var recorded = { dispatched: [], closed: [] };
        var loaded = loadAgent();
        loaded.holder.provider = providerWith([1661], { 1661: 'MERGED' }, recorded);
        var out = run(loaded.agent);

        assert.equal(out.idle, undefined, 'the orphaned run must not hold the slot');
        assert.equal(recorded.dispatched.length, 1, 'the dev leg dispatches the same tick');
        assert.equal(recorded.dispatched[0].issue, 2001, 'the live issue gets its leg');
        assert.deepEqual(recorded.closed, [1661], 'the merged-PR issue still closes (Fixes #N safety net)');
    });

    test('an active run for an issue with an OPEN linked PR still holds the slot', function () {
        var recorded = { dispatched: [], closed: [] };
        var loaded = loadAgent();
        loaded.holder.provider = providerWith([2001], { 2001: 'OPEN' }, recorded);
        var out = run(loaded.agent);

        assert.equal(out.idle, true, 'the concurrency contract stands for live runs');
        assert.equal(out.waitingFor.join(','), '2001');
        assert.equal(recorded.dispatched.length, 0, 'nothing dispatches while the machine is busy');
    });

    test('a mixed set releases only the orphaned runs', function () {
        var recorded = { dispatched: [], closed: [] };
        var loaded = loadAgent();
        loaded.holder.provider = providerWith([1661, 2001], { 1661: 'MERGED', 2001: 'OPEN' }, recorded);
        var out = run(loaded.agent);

        assert.equal(out.idle, true, 'one live run at cap 1 still gates the tick');
        assert.deepEqual(out.waitingFor, [2001], 'the gate waits on the LIVE run only — the orphan is invisible');
    });
});

suite('machineSm action branches (gh-980 characterization)', function () {
    var rvReal = function () {
        if (!rvReal.mod) rvReal.mod = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {});
        return rvReal.mod;
    };
    var maReal = function () {
        if (!maReal.mod) maReal.mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
        return maReal.mod;
    };

    function loadAgent(projectConfig, opts) {
        opts = opts || {};
        var holder = { provider: null };
        var smProviderMock = opts.providerError
            ? { createSmProvider: function () { throw opts.providerError; } }
            : { createSmProvider: function () { return holder.provider; } };
        var map = agentModuleMap(projectConfig, holder);
        if (opts.providerError) map['./common/smProvider.js'] = smProviderMock;
        var agent = loadModule('js/machineSmAgent.js', makeRequire(map), {
            cli_execute_command: function () { return '{}'; }
        });
        return { agent: agent, holder: holder };
    }

    // opts-key defaulting without per-use ternaries (CRAP: this helper is
    // measured by the quality gate like any other function).
    function def(opts, key, dflt) {
        return opts[key] !== undefined ? opts[key] : dflt;
    }

    function providerWith(opts) {
        opts = opts || {};
        var calls = [];
        return {
            calls: calls,
            activeMachineRuns: function () { return def(opts, 'activeIssues', []); },
            listMachineIssues: function () { return def(opts, 'issues', []); },
            findPr: function (n) {
                if (opts.findPrError) { throw opts.findPrError; }
                return (opts.prs && opts.prs[n]) || null;
            },
            prStatus: function (n) {
                calls.push({ tool: 'prStatus', number: n });
                return opts.prStatus ? opts.prStatus(n) : null;
            },
            dispatchLeg: function (issue, leg) {
                calls.push({ tool: 'dispatchLeg', issue: issue, leg: leg });
                if (opts.dispatchError) { throw opts.dispatchError; }
            },
            addIssueLabel: function (n, label) { calls.push({ tool: 'addIssueLabel', number: n, label: label }); },
            updateBranch: function () { calls.push({ tool: 'updateBranch' }); },
            merge: function (n) { calls.push({ tool: 'merge', number: n }); },
            closeIssue: function (n) { calls.push({ tool: 'closeIssue', number: n }); }
        };
    }

    function run(agent, jobParams) {
        return agent.action({ jobParams: jobParams });
    }

    test('no repository configured → success:false, Missing repo', function () {
        var loaded = loadAgent({});
        var out = run(loaded.agent, { machineAuthor: 'ai-teammate' });
        assert.equal(out.success, false);
        assert.equal(out.error, 'Missing repo');
    });

    test('repository from jobParams.repo "owner/name" is accepted', function () {
        var loaded = loadAgent({});
        loaded.holder.provider = providerWith({ issues: [] });
        var out = run(loaded.agent, { repo: 'o/r', machineAuthor: 'ai-teammate' });
        assert.equal(out.success, true);
        assert.deepEqual(out, { success: true, acted: 0, dispatched: 0, skipped: 0, failures: 0 });
    });

    test('projectConfig.repository wins over jobParams.repo', function () {
        var loaded = loadAgent({ repository: { owner: 'cfg', repo: 'repo' } });
        loaded.holder.provider = providerWith({ issues: [] });
        var out = run(loaded.agent, { repo: 'o/r', machineAuthor: 'ai-teammate' });
        assert.equal(out.success, true);
    });

    test('provider creation failure → success:false carrying the provider error', function () {
        var loaded = loadAgent({}, { providerError: new Error('no forge') });
        var out = run(loaded.agent, { repo: 'o/r' });
        assert.equal(out.success, false);
        assert.contains(out.error, 'no forge');
    });

    test('dryRun plans the action without executing any provider write', function () {
        var loaded = loadAgent({});
        var p = providerWith({ issues: [{ number: 5, title: 'gh-5', labels: ['agent:dev'], assignees: [] }] });
        loaded.holder.provider = p;
        var out = run(loaded.agent, { repo: 'o/r', dryRun: true });
        assert.equal(out.acted, 1, 'the planned action counts as acted');
        assert.equal(out.dispatched, 1);
        assert.equal(p.calls.length, 0, 'dry run performs no provider writes');
    });

    test('a failing leg is counted as a failure and flips success', function () {
        var loaded = loadAgent({});
        var p = providerWith({
            issues: [{ number: 5, title: 'gh-5', labels: ['agent:dev'], assignees: [] }],
            dispatchError: new Error('boom')
        });
        loaded.holder.provider = p;
        var out = run(loaded.agent, { repo: 'o/r' });
        assert.equal(out.failures, 1);
        assert.equal(out.success, false);
    });

    test('OPEN prRef gets a prStatus probe; a MERGED PR closes the issue without one', function () {
        var loaded = loadAgent({});
        var p = providerWith({
            issues: [
                { number: 5, title: 'gh-5', labels: ['ai_developed', 'ai_pr_reviewed', 'pr_approved'], assignees: [] },
                { number: 9, title: 'gh-9', labels: ['ai_developed'], assignees: [] }
            ],
            prs: { 5: { number: 50, state: 'OPEN' }, 9: { number: 90, state: 'MERGED' } },
            prStatus: function () {
                return { number: 50, state: 'OPEN', checkConclusion: 'green',
                         mergeState: 'CLEAN', mergeable: true, headSha: 'abc' };
            }
        });
        loaded.holder.provider = p;
        var out = run(loaded.agent, { repo: 'o/r' });
        assert.equal(out.failures, 0);
        assert.deepEqual(p.calls.filter(function (c) { return c.tool === 'merge'; }),
            [{ tool: 'merge', number: 50 }]);
        assert.deepEqual(p.calls.filter(function (c) { return c.tool === 'closeIssue'; }),
            [{ tool: 'closeIssue', number: 9 }]);
        assert.deepEqual(p.calls.filter(function (c) { return c.tool === 'prStatus'; }),
            [{ tool: 'prStatus', number: 50 }], 'only the OPEN PR is probed');
    });

    test('orphan-slot probe failure keeps the run in the concurrency count (fail closed)', function () {
        var loaded = loadAgent({});
        loaded.holder.provider = providerWith({ activeIssues: [7], findPrError: new Error('probe down') });
        var out = run(loaded.agent, { repo: 'o/r', machineAuthor: 'ai-teammate' });
        assert.equal(out.idle, true, 'the probe error must not release the slot');
        assert.deepEqual(out.waitingFor, [7]);
    });
});

suite('machineSm pure helpers (gh-980)', function () {
    var rvReal = function () {
        if (!rvReal.mod) rvReal.mod = loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {});
        return rvReal.mod;
    };
    var maReal = function () {
        if (!maReal.mod) maReal.mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
        return maReal.mod;
    };

    var agent = loadModule('js/machineSmAgent.js', makeRequire(agentModuleMap({}, null)), {
        cli_execute_command: function () { return '{}'; }
    });

    test('resolveMachineSmConfig applies the documented defaults', function () {
        var cfg = agent.resolveMachineSmConfig({}, {});
        assert.equal(cfg.dryRun, false);
        assert.equal(cfg.maxConcurrentRuns, 1);
        assert.equal(cfg.maxReworkRounds, 2);
        assert.equal(cfg.workflowFile, 'ai-teammate.yml');
        assert.equal(cfg.branchPrefix, 'ai/gh-');
        assert.equal(cfg.agentHandle, 'ai-teammate');
        assert.equal(cfg.issueLimit, 50);
        assert.contains(cfg.closeComment, 'closing the loop');
        assert.equal(cfg.maxResolveThreads, rvReal().DEFAULT_RESOLVE_THREADS_CAP);
        assert.ok(Array.isArray(cfg.machineLogins), 'machine logins resolve to a list');
    });

    test('resolveMachineSmConfig: the project override wins over jobParams for every knob it sets', function () {
        var cfg = agent.resolveMachineSmConfig(
            { dryRun: false, maxConcurrentRuns: 3, workflowFile: 'job.yml',
              issueLimit: 9, maxResolveThreads: 4, machineAuthor: 'job-login' },
            { machineSm: { dryRun: true, maxConcurrentRuns: 2, workflowFile: 'ovr.yml',
                           maxResolveThreads: 6, machineAuthor: 'ovr-login' } });
        assert.equal(cfg.dryRun, true, 'override beats an explicit falsy jobParams value');
        assert.equal(cfg.maxConcurrentRuns, 2);
        assert.equal(cfg.workflowFile, 'ovr.yml');
        assert.equal(cfg.maxResolveThreads, 6);
        assert.equal(cfg.issueLimit, 9, 'jobParams fills knobs the override lacks');
        // machineAuthor keeps its own documented chain: jobParams before config
        assert.deepEqual(cfg.machineLogins, ['job-login']);
    });

    test('resolveRepoCfg precedence: project repository > jobParams.repository > jobParams.repo > null', function () {
        assert.deepEqual(agent.resolveRepoCfg({ repository: { owner: 'a', repo: 'b' } }, { repo: 'c/d' }),
            { owner: 'a', repo: 'b' });
        assert.deepEqual(agent.resolveRepoCfg({}, { repository: { owner: 'e', repo: 'f' }, repo: 'c/d' }),
            { owner: 'e', repo: 'f' });
        assert.deepEqual(agent.resolveRepoCfg({}, { repo: 'c/d' }), { owner: 'c', repo: 'd' });
        assert.equal(agent.resolveRepoCfg({}, {}), null);
        assert.equal(agent.resolveRepoCfg({ repository: { owner: 'only-owner' } }, {}), null,
            'a partial project repository does not count');
    });

    test('probeOrphanRun classifies unknown / merged / live / probe-error', function () {
        var provider = {
            findPr: function (n) {
                if (n === 1) return { number: 11, state: 'MERGED' };
                if (n === 2) return { number: 12, state: 'OPEN' };
                if (n === 3) throw new Error('down');
                return null;
            }
        };
        assert.deepEqual(agent.probeOrphanRun(provider, 'unknown', 'ai/gh-'), { kind: 'unknown' });
        assert.deepEqual(agent.probeOrphanRun(provider, 1, 'ai/gh-'), { kind: 'merged', prNumber: 11 });
        assert.deepEqual(agent.probeOrphanRun(provider, 2, 'ai/gh-'), { kind: 'live' });
        assert.deepEqual(agent.probeOrphanRun(provider, 4, 'ai/gh-'), { kind: 'live' }, 'no linked PR is a live run');
        assert.deepEqual(agent.probeOrphanRun(provider, 3, 'ai/gh-'), { kind: 'error' });
    });

    test('filterLiveActiveIssues drops only merged orphans and keeps everything else', function () {
        var provider = {
            findPr: function (n) {
                if (n === 1) return { number: 11, state: 'MERGED' };
                if (n === 3) throw new Error('down');
                return { number: 10 + n, state: 'OPEN' };
            }
        };
        assert.deepEqual(agent.filterLiveActiveIssues(provider, ['unknown', 1, 2, 3], 'ai/gh-'),
            ['unknown', 2, 3], 'orphan released; unknown, live and probe-error runs kept');
    });
});

// ---------------------------------------------------------------------------
// gh-1242: executeAction — every switch arm incl. the gh-828 resolution leg
// ---------------------------------------------------------------------------

suite('machineSm executeAction', function () {

    var EXEC_HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

    function loadExecAgent() {
        return loadModule('js/machineSmAgent.js', makeRequire(agentModuleMap({}, null)), {
            cli_execute_command: function () { return '{}'; }
        });
    }

    function approveRecord() {
        return { head: EXEC_HEAD, verdict: 'APPROVE', blocking: 0, important: 1, suggestions: 1,
                 at: '2026-10-10T05:47:30.000Z', source: 'pr_review.json' };
    }

    function suggestionThread(id) {
        return { threadId: id, rootCommentId: 1, resolved: false,
                 author: 'ai-teammate', body: '💡 SUGGESTION: rename for clarity' };
    }

    function execCfg(over) {
        return Object.assign({ workflowFile: 'ai-teammate.yml', closeComment: 'done',
                               machineLogins: ['ai-teammate'] }, over || {});
    }

    test('dispatch / label / updateBranch / merge / closeIssue delegate to the provider primitives', function () {
        var calls = [];
        var provider = {
            dispatchLeg: function (n, leg, reason, wf) { calls.push(['dispatchLeg', n, leg, reason, wf]); return 'd'; },
            addIssueLabel: function (n, label) { calls.push(['addIssueLabel', n, label]); return 'l'; },
            updateBranch: function (n) { calls.push(['updateBranch', n]); return 'u'; },
            merge: function (n) { calls.push(['merge', n]); return 'm'; },
            closeIssue: function (n, comment) { calls.push(['closeIssue', n, comment]); return 'c'; }
        };
        var agent = loadExecAgent();
        var issue = { number: 42 };

        agent.executeAction(provider, { type: 'dispatch', leg: 'dev', reason: 'r', prNumber: 1 }, issue, execCfg());
        agent.executeAction(provider, { type: 'label', label: 'ai_dev' }, issue, execCfg());
        agent.executeAction(provider, { type: 'updateBranch', prNumber: 2 }, issue, execCfg());
        agent.executeAction(provider, { type: 'merge', prNumber: 3 }, issue, execCfg());
        agent.executeAction(provider, { type: 'closeIssue' }, issue, execCfg());

        assert.deepEqual(calls, [
            ['dispatchLeg', 42, 'dev', 'r', 'ai-teammate.yml'],
            ['addIssueLabel', 42, 'ai_dev'],
            ['updateBranch', 2],
            ['merge', 3],
            ['closeIssue', 42, 'done']
        ]);
    });

    test('unknown action type → null, provider untouched', function () {
        var agent = loadExecAgent();
        var provider = {
            dispatchLeg: function () { throw new Error('must not be called'); }
        };
        assert.equal(agent.executeAction(provider, { type: 'wat' }, { number: 1 }, execCfg()), null);
    });

    test('resolveSuggestionThreads: APPROVE gate resolves + acks every selected machine thread', function () {
        var resolved = [];
        var replies = [];
        var provider = {
            verdictRecords: function (n, opts) {
                assert.equal(n, 5);
                assert.deepEqual(opts.authorLogins, ['ai-teammate']);
                return [approveRecord()];
            },
            reviewThreadList: function (n) {
                return [suggestionThread('RT_1'), suggestionThread('RT_2')];
            },
            resolveThread: function (n, t) { resolved.push(t.threadId); },
            replyToThread: function (n, t, ack) { replies.push({ id: t.threadId, ack: ack }); },
            prCommentList: function () { return []; },
            postPrComment: function () {}
        };
        var agent = loadExecAgent();
        var out = agent.executeAction(provider,
            { type: 'resolveSuggestionThreads', prNumber: 5, headSha: EXEC_HEAD },
            { number: 5 }, execCfg());
        assert.equal(out.resolved, 2, 'both non-blocking machine threads resolved');
        assert.deepEqual(resolved, ['RT_1', 'RT_2']);
        assert.equal(replies.length, 2, 'an ack reply follows each resolve');
        assert.ok(replies[0].ack.indexOf('triage closure (gh-1352)') !== -1,
            'the ack carries the gh-1352 triage wording');
        assert.ok(replies[0].ack.indexOf('deferred: ') !== -1,
            'default policy: suggestion fix is mandatory — the ack defers to the ledger');
    });

    test('resolveSuggestionThreads: a failing resolve skips the ack for that thread only', function () {
        var replies = [];
        var provider = {
            verdictRecords: function () { return [approveRecord()]; },
            reviewThreadList: function () { return [suggestionThread('RT_1'), suggestionThread('RT_2')]; },
            resolveThread: function (n, t) { if (t.threadId === 'RT_1') throw new Error('graphql down'); },
            replyToThread: function (n, t, ack) { replies.push(t.threadId); },
            prCommentList: function () { return []; },
            postPrComment: function () {}
        };
        var agent = loadExecAgent();
        var out = agent.executeAction(provider,
            { type: 'resolveSuggestionThreads', prNumber: 5, headSha: EXEC_HEAD },
            { number: 5 }, execCfg());
        assert.equal(out.resolved, 1, 'only the second thread resolved');
        assert.deepEqual(replies, ['RT_2'], 'no ack for the thread whose resolve failed');
    });

    test('resolveSuggestionThreads: a failing ack after a successful resolve is non-fatal', function () {
        var provider = {
            verdictRecords: function () { return [approveRecord()]; },
            reviewThreadList: function () { return [suggestionThread('RT_1')]; },
            resolveThread: function () {},
            replyToThread: function () { throw new Error('reply down'); },
            prCommentList: function () { return []; },
            postPrComment: function () {}
        };
        var agent = loadExecAgent();
        var out = agent.executeAction(provider,
            { type: 'resolveSuggestionThreads', prNumber: 5, headSha: EXEC_HEAD },
            { number: 5 }, execCfg());
        assert.equal(out.resolved, 1, 'the resolve is still credited when the ack fails');
    });

});


// -------------------------------------------------------------------------
// gh-1352: the disposition loop — the polish gate + the triage hand-off
// -------------------------------------------------------------------------

suite('machineSm disposition loop (gh-1352)', function () {

    var agent2 = loadModule('js/machineSmAgent.js', makeRequire(agentModuleMap({}, null)), {
        cli_execute_command: function () { return '{}'; }
    });

    var HEAD2 = 'aaaabbbbccccddddeeeeffff0000111122223333';
    var pl = plShared();
    var APPROVE_POLISH_ONLY = { head: HEAD2, verdict: 'APPROVE', blocking: 0, important: 0,
                                suggestions: 3, nits: 1, at: '2026-11-04T00:00:00.000Z',
                                source: 'pr_review.json' };

    function loopProvider(threads, opts) {
        opts = opts || {};
        return {
            calls: { resolves: [], replies: [], posts: [], dispatches: [] },
            verdictRecords: function () { return [opts.record || APPROVE_POLISH_ONLY]; },
            reviewThreadList: function () { return threads; },
            replyToThread: function (pr, t, text) { this.calls.replies.push(text); },
            resolveThread: function (pr, t) { this.calls.resolves.push(t.threadId); },
            prCommentList: function () { return opts.comments || []; },
            postPrComment: function (pr, body) { this.calls.posts.push(body); },
            dispatchLeg: function (issue, leg, reason, wf) {
                this.calls.dispatches.push({ issue: issue, leg: leg, reason: reason, wf: wf });
            }
        };
    }

    function sugg(i) {
        return { threadId: 'RT_' + i, rootCommentId: 100 + i, resolved: false,
                 author: 'ai-teammate', body: '💡 SUGGESTION: polish ' + i };
    }

    test('polish-tier-only census on a fresh head dispatches the lap, stamps the marker and skips triage', function () {
        var p = loopProvider([sugg(1), sugg(2), sugg(3)]);
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.equal(out.polished, true);
        assert.equal(p.calls.dispatches.length, 1);
        assert.equal(p.calls.dispatches[0].leg, 'polish');
        assert.equal(p.calls.dispatches[0].wf, 'ai-teammate.yml');
        // gh-1352 review: the provider primitive takes the issue NUMBER
        // (executeAction dispatch parity) — an issue object would reach
        // github_trigger_workflow as "[object Object]".
        assert.equal(p.calls.dispatches[0].issue, 42, 'dispatchLeg carries the issue number');
        // gh-1352 review: the dispatch stamps the per-head lap marker —
        // the once-per-head + instability-budget memory. Without the
        // marker post the bounds are dead code (the next tick re-laps).
        assert.equal(p.calls.posts.length, 1, 'the lap marker is stamped at dispatch');
        var laps = pl.parsePolishLapMarkers(
            p.calls.posts.map(function (body) { return { body: body, user: { login: 'ai-teammate' } }; }),
            { authorLogins: ['ai-teammate'] });
        assert.equal(laps.length, 1);
        assert.equal(laps[0].head, HEAD2, 'the marker names the head');
        assert.deepEqual(laps[0].resolvedThreadIds, ['RT_1', 'RT_2', 'RT_3'],
            'the lap plan thread ids ride the marker (fixed: evidence)');
        assert.equal(p.calls.resolves.length, 0, 'the lap owns the threads — triage stays out this tick');
    });

    test('a failed lap-marker post stays home and falls open to triage (fail closed)', function () {
        var p = loopProvider([sugg(1), sugg(2)]);
        p.postPrComment = function () { throw new Error('403'); };
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out.polished, 'no marker, no lap — an unstamped lap cannot honour once-per-head');
        assert.equal(p.calls.dispatches.length, 0, 'the leg is never dispatched unstamped');
        // the triage fallback still runs — but the broken comment primitive
        // also kills deferral, so the mandatory-fix suggestion tiers stay
        // open (needs-fix-or-defer), exactly the fail-closed doctrine.
        assert.equal(p.calls.resolves.length, 0);
    });

    test('a non-string head sha cannot stamp a marker — the lap stays home, the threads triage (fail closed)', function () {
        // crap4js coverage lap: pins the dispatchPolishLap !marker guard —
        // a numeric head passes the gate (latestVerdictForHead String()-/
        // prefix-matches) but buildPolishLapMarker rejects non-strings, so
        // the unbuildable marker keeps the leg home and hands to triage.
        var NUMERIC_HEAD = 7654321;
        var p = loopProvider([sugg(1)], {
            record: { head: '7654321abcdef0123456789', verdict: 'APPROVE', blocking: 0, important: 0,
                      suggestions: 2, at: '2026-11-04T00:00:00.000Z', source: 'pr_review.json' }
        });
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: NUMERIC_HEAD, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out.polished, 'a head the marker builder rejects never dispatches unstamped');
        assert.equal(p.calls.dispatches.length, 0, 'no dispatch without the once-per-head stamp');
        assert.ok(p.calls.posts.every(function (body) { return body.indexOf('dmtools:polish-lap') === -1; }),
            'no lap-marker comment is stamped (only the triage ledger marker may post)');
        assert.equal(p.calls.resolves.length, 1, 'the threads fall open to triage with dispositions');
    });

    test('a provider without postPrComment never reaches the polish dispatch', function () {
        var p = loopProvider([sugg(1)]);
        delete p.postPrComment;
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out.polished, 'the gate needs the marker primitive');
        assert.equal(p.calls.dispatches.length, 0);
        assert.equal(p.calls.resolves.length, 0,
            'no marker primitive also means no deferral — the thread stays open (fail closed)');
    });

    test('the stamped marker is the once-per-head memory: a second tick on the same head triages', function () {
        // Round 1: dispatch stamps the marker on the PR.
        var p = loopProvider([sugg(1), sugg(2)]);
        agent2.dispositionLoop(p, 42, { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.equal(p.calls.dispatches.length, 1);
        // Round 2 (the lap ran, some threads remain open, head unchanged):
        // the posted marker is now on the comment list — no second lap.
        var p2 = loopProvider([sugg(2)], {
            comments: p.calls.posts.map(function (body) {
                return { body: body, user: { login: 'ai-teammate' } };
            })
        });
        var out2 = agent2.dispositionLoop(p2, 42, { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out2.polished, 'once per head — the memory holds across ticks');
        assert.equal(p2.calls.dispatches.length, 0);
        assert.equal(p2.calls.resolves.length, 1);
    });

    test('once-per-head: a lap marker on this head hands the threads to triage instead', function () {
        var lapComment = { body: '<!-- dmtools:polish-lap ' + JSON.stringify(
            { head: HEAD2, lapThreads: 3, overflow: 0, at: '2026-11-04T01:00:00.000Z' }) + ' -->',
            user: { login: 'ai-teammate' } };
        var p = loopProvider([sugg(1)], { comments: [lapComment] });
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out.polished);
        assert.equal(p.calls.dispatches.length, 0, 'once per head — no second lap');
        assert.equal(p.calls.resolves.length, 1, 'the threads triage with dispositions');
        assert.equal(p.calls.posts.length, 1, 'the deferral lands in the debt ledger');
    });

    test('instability budget: laps on 2 distinct heads exhaust polishing — triage resolves the rest', function () {
        function lap(head) {
            return { body: '<!-- dmtools:polish-lap ' + JSON.stringify(
                { head: head, lapThreads: 1, overflow: 0, at: '2026-11-04T01:00:00.000Z' }) + ' -->',
                user: { login: 'ai-teammate' } };
        }
        var p = loopProvider([sugg(1), sugg(2)], { comments: [lap('head1'), lap('head2')] });
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out.polished, 'the budget stops the polish cycle');
        assert.equal(p.calls.dispatches.length, 0);
        assert.equal(p.calls.resolves.length, 2);
    });

    test('a rework lap between polish laps resets the budget through the gate (the lap dispatches)', function () {
        // The documented consecutive bound, wired: polishLap markers +
        // dmtools:rework-lap markers parse from the SAME comment list and
        // merge into one history — the rework lap between the two polish
        // laps breaks consecutiveness, so a third head still dispatches.
        var rlg = loadModule('js/common/reworkLoopGuard.js', makeRequire({
            './machineAuthor.js': maShared(),
            './reviewVerdicts.js': rvShared()
        }), {});
        var comments = [
            { body: pl.buildPolishLapMarker('head1', { threads: 1, at: '2026-11-04T01:00:00.000Z' }),
              user: { login: 'ai-teammate' } },
            { body: rlg.buildLapMarker('rework-head', 1, 1, null, '2026-11-04T02:00:00.000Z'),
              user: { login: 'ai-teammate' } },
            { body: pl.buildPolishLapMarker('head2', { threads: 1, at: '2026-11-04T03:00:00.000Z' }),
              user: { login: 'ai-teammate' } }
        ];
        var p = loopProvider([sugg(1)], { comments: comments });
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(out.polished, 'the rework lap between the polish laps resets the budget — the lap dispatches');
        assert.equal(p.calls.dispatches.length, 1);
        assert.equal(p.calls.dispatches[0].leg, 'polish');
        assert.equal(p.calls.resolves.length, 0, 'the lap owns the threads this tick');
    });

    test('allowPolish:false (the post-merge hygiene pass) never dispatches a lap', function () {
        var p = loopProvider([sugg(1)]);
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: false },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out.polished);
        assert.equal(p.calls.dispatches.length, 0);
        assert.equal(p.calls.resolves.length, 1);
    });

    test('a non-polish census record hands the threads straight to triage', function () {
        var p = loopProvider([sugg(1), { threadId: 'RT_I', rootCommentId: 9, resolved: false,
                                         author: 'ai-teammate', body: '⚠️ IMPORTANT: validate' }],
            { record: { head: HEAD2, verdict: 'APPROVE', blocking: 0, important: 2,
                        suggestions: 1, at: '2026-11-04T00:00:00.000Z', source: 'pr_review.json' } });
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out.polished, 'lap-gated census open — no lap');
        assert.equal(p.calls.dispatches.length, 0);
        assert.equal(p.calls.resolves.length, 1, 'the suggestion thread defers through triage');
    });

    test('no verdict records at all → the whole loop fails closed (nothing resolves)', function () {
        var p = loopProvider([sugg(1)]);
        p.verdictRecords = function () { return []; };
        var out = agent2.dispositionLoop(p, 42,
            { prNumber: 99, headSha: HEAD2, allowPolish: true },
            { machineLogins: ['ai-teammate'], workflowFile: 'ai-teammate.yml' });
        assert.ok(!out.polished);
        assert.equal(p.calls.dispatches.length, 0);
        assert.equal(p.calls.resolves.length, 0, 'the verdict gate closes triage too');
    });

    test('resolveMachineSmConfig carries the resolved reviewPolicy (gh-1351 parity)', function () {
        var cfg = agent2.resolveMachineSmConfig({}, { reviewPolicy: { preset: 'relaxed' } });
        assert.equal(cfg.reviewPolicy.preset, 'relaxed');
        var cfg2 = agent2.resolveMachineSmConfig({ reviewPolicy: '{\"preset\":\"investigation\"}' }, {});
        assert.equal(cfg2.reviewPolicy.preset, 'investigation', 'jobParams JSON-string policy parses');
        var cfg3 = agent2.resolveMachineSmConfig({}, {});
        assert.ok(cfg3.reviewPolicy && cfg3.reviewPolicy.severities, 'the built-in default resolves');
    });
});

// -------------------------------------------------------------------------
// gh-1366: the AI failure-analyzer leg — the scripted-provider replay of the
// acceptance matrix (AC1–AC5). In-memory issue store, no external calls:
// every tick drives agent.action() against a scripted provider and the
// recorded dispatches/labels/comments ARE the assertions.
// -------------------------------------------------------------------------

var FA_MARKDOWN = {
    h: function (level, text) {
        var prefix = '';
        for (var i = 0; i < level; i++) prefix += '#';
        return prefix + ' ' + text;
    },
    bold: function (text) { return '**' + text + '**'; },
    inline: function (text) { return '`' + text + '`'; },
    code: function (text) { return '```\n' + text + '\n```'; },
    link: function (text, url) { return '[' + text + '](' + url + ')'; }
};

// One gh-1363 failure notice on a machine issue: the machine-readable
// signature line is the streak source the SM parses.
function failureNotice(lfr, workflow, step, message, author) {
    var sig = lfr.failureSignature({ workflow: workflow, step: step, message: message });
    return {
        user: { login: author || 'github-actions[bot]' },
        body: lfr.buildFailureComment({ phase: 'setup', step: step, excerpt: message, signature: sig }, FA_MARKDOWN)
    };
}

// One machine-authored analyzer verdict comment.
function verdictNotice(fa, record, author) {
    return {
        user: { login: author || 'github-actions[bot]' },
        body: fa.buildFailureVerdictComment(record)
    };
}

// The in-memory forge: issues + comments + every machine write recorded.
function scriptedProvider() {
    var store = {
        issues: {},      // number → { number, title, labels, assignees }
        comments: {},    // number → [rows]
        dispatches: [],  // [issue, leg, reason]
        labels: [],      // [issue, label]
        commentsPosted: [], // [issue, body]
        commentFetches: [], // [issue] — the SM's issue-comment reads (I/O audit)
        failNextLabelAdd: false, // scripted REST hiccup on the park label-add
        prs: {}          // number → PR object (or absent → null)
    };

    return {
        store: store,
        addIssue: function (number, labels) {
            store.issues[number] = { number: number, title: 'gh-' + number, labels: labels.slice(), assignees: ['ai-teammate'] };
            store.comments[number] = [];
            return store.issues[number];
        },
        addComments: function (number, rows) {
            store.comments[number] = store.comments[number].concat(rows);
        },
        // A human removing the park label (the AC4 resume gesture).
        removeLabel: function (number, label) {
            var issue = store.issues[number];
            var i = issue.labels.indexOf(label);
            if (i !== -1) issue.labels.splice(i, 1);
        },
        activeMachineRuns: function () { return []; },
        listMachineIssues: function (machineLabels, agentHandle, limit) {
            store.listedWithLabels = machineLabels.slice();
            var out = [];
            Object.keys(store.issues).forEach(function (n) { out.push(store.issues[n]); });
            return out.slice(0, limit || 50);
        },
        findPr: function (n) { return store.prs[n] || null; },
        prStatus: function (n) { return store.prs[n]; },
        issueComments: function (n) {
            store.commentFetches.push(n);
            return store.comments[n] || [];
        },
        dispatchLeg: function (n, leg, reason, wf) {
            store.dispatches.push([n, leg, reason, wf]);
            return 'ok';
        },
        addIssueLabel: function (n, label) {
            if (store.failNextLabelAdd) {
                store.failNextLabelAdd = false;
                throw new Error('label-add hiccup (scripted REST failure)');
            }
            store.labels.push([n, label]);
            store.issues[n].labels.push(label);
            return 'ok';
        },
        postIssueComment: function (n, body) {
            store.commentsPosted.push([n, body]);
            store.comments[n].push({ user: { login: 'ai-teammate' }, body: body });
            return 'ok';
        }
    };
}

function faJobParams(failureAnalysis) {
    var p = {
        repo: 'acme/widget',
        scm: { provider: 'github' },
        dryRun: false,
        maxConcurrentRuns: 1,
        workflowFile: 'ai-teammate.yml',
        branchPrefix: 'ai/gh-',
        agentHandle: 'ai-teammate',
        machineAuthor: 'ai-teammate,github-actions[bot]'
    };
    if (failureAnalysis !== undefined) p.failureAnalysis = failureAnalysis;
    return p;
}

// One full SM tick against the scripted provider; returns the provider so
// the assertions read the recorded writes.
function faTick(holder, jobParams, projectConfig) {
    var agent = loadModule('js/machineSmAgent.js',
        makeRequire(agentModuleMap(projectConfig || {}, holder)), {
            cli_execute_command: function () { return '{}'; }
        });
    agent.action({ jobParams: jobParams });
    return holder.provider;
}

// The legs dispatched for one issue across the whole tick history.
function legsDispatched(provider, issueNumber) {
    return provider.store.dispatches
        .filter(function (d) { return d[0] === issueNumber; })
        .map(function (d) { return d[1]; });
}

suite('machineSm failure analyzer — scripted replay (gh-1366)', function () {

    var LFR = lfrModule();
    var FA = faShared();
    var DEV_SIG = { workflow: 'ai-teammate.yml', step: 'Development Setup', message: 'npm ci failed' };

    function devFailures(n, provider, count) {
        for (var i = 0; i < count; i++) {
            provider.addComments(n, [failureNotice(LFR, DEV_SIG.workflow, DEV_SIG.step, DEV_SIG.message)]);
        }
    }

    test('AC1: below the threshold the blind retry is unchanged; the fourth failure dispatches the analyzer once', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(101, ['agent:dev']);
        devFailures(101, holder.provider, 3);

        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 101), ['dev'],
            'three identical failures: blind retry unchanged, no analyzer dispatch');

        devFailures(101, holder.provider, 1); // the fourth identical failure
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 101), ['dev', 'analyze'],
            'the fourth dispatches the analyzer once');
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 101; }).length, 0,
            'no park label below or at the crossing');
    });

    test('AC2: a transient verdict resumes retries without label/comment spam; the new streak re-triggers only after the threshold again', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(102, ['agent:dev']);
        devFailures(102, holder.provider, 4);
        holder.provider.addComments(102, [verdictNotice(FA, {
            signature: LFR.failureSignature(DEV_SIG),
            classification: 'transient',
            confidence: 0.8,
            suspected_root_cause: 'provider outage',
            evidence: ['500 from upstream'],
            suggested_fix: 're-point the install script at the live registry mirror',
            analyzedAtCount: 4
        })]);

        // 1st post-verdict failure (count 5 → effective 1) and a simulated
        // success in between (a success posts nothing — the consumed
        // prefix alone keeps the arithmetic honest).
        devFailures(102, holder.provider, 1);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 102), ['dev'], 'retries continue after the transient verdict');
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 102; }).length, 0,
            'no label on a transient verdict');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 102; }).length, 0,
            'no comment spam on a transient verdict');

        devFailures(102, holder.provider, 2); // count 7 → effective 3
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 102), ['dev', 'dev'],
            'still below the threshold again — blind retry');

        devFailures(102, holder.provider, 1); // count 8 → effective 4 — the NEW streak crosses
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 102), ['dev', 'dev', 'analyze'],
            'a NEW identical streak re-triggers analysis only after the threshold again');
    });

    test('AC3: a deterministic verdict parks — label + exactly ONE diagnostic comment, no further re-dispatch', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(103, ['agent:dev']);
        devFailures(103, holder.provider, 4);
        holder.provider.addComments(103, [verdictNotice(FA, {
            signature: LFR.failureSignature(DEV_SIG),
            classification: 'deterministic-infra',
            confidence: 0.9,
            suspected_root_cause: 'setup pins a deleted registry mirror',
            evidence: ['npm ERR! 404'],
            suggested_fix: 're-point the install script at the live registry mirror',
            analyzedAtCount: 4
        })]);

        faTick(holder, faJobParams({ afterFailures: 4 }));
        var parked = holder.provider.store.labels.filter(function (l) { return l[0] === 103 && l[1] === 'sm:leg-blocked'; });
        assert.equal(parked.length, 1, 'the issue is labeled sm:leg-blocked');
        var diags = holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 103; });
        assert.equal(diags.length, 1, 'exactly ONE diagnostic comment');
        assert.ok(diags[0][1].indexOf('npm ERR! 404') !== -1, 'the diagnostic quotes the evidence');
        assert.ok(diags[0][1].indexOf('**Suggested fix:**') !== -1, 'the diagnostic carries the suggested fix');
        assert.deepEqual(legsDispatched(holder.provider, 103), [], 'the park tick dispatches nothing');

        faTick(holder, faJobParams({ afterFailures: 4 }));
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.dispatches.filter(function (d) { return d[0] === 103; }).length, 0,
            'no further re-dispatch of a parked issue');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 103; }).length, 1,
            'still exactly ONE diagnostic comment');
    });

    test('AC4: removing the park label resumes dispatch (and never re-posts the diagnostic)', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(104, ['agent:dev']);
        devFailures(104, holder.provider, 4);
        holder.provider.addComments(104, [verdictNotice(FA, {
            signature: LFR.failureSignature(DEV_SIG),
            classification: 'deterministic-infra',
            analyzedAtCount: 4
        })]);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 104; }).length, 1, 'parked');

        holder.provider.removeLabel(104, 'sm:leg-blocked'); // the human gesture
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 104), ['dev'],
            'dispatch resumes after the label is removed');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 104; }).length, 1,
            'the diagnostic is NOT re-posted on resume');
    });

    test('AC5: a crashed analyzer leg keeps blind retries going — nothing parked, no analyzer retry storm', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(105, ['agent:dev']);
        devFailures(105, holder.provider, 4);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 105), ['analyze'], 'the analyzer is dispatched at the crossing');

        // The analyzer leg itself fails: its own failure notice carries a
        // DIFFERENT signature (the analyze step) — and no verdict lands.
        holder.provider.addComments(105, [failureNotice(LFR, 'ai-teammate.yml', 'Failure Analysis', 'cli crashed')]);
        devFailures(105, holder.provider, 1);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 105), ['analyze', 'dev'],
            'blind retry continues after the analyzer crash');
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 105; }).length, 0,
            'nothing parked');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 105; }).length, 0,
            'no diagnostic comment from a crashed analyzer');

        // The analyzer crash broke the dev streak; the dev failures after
        // the crash rebuild it from one. Three more make the REBUILT
        // streak exactly four — the analyzer re-arms ONCE.
        devFailures(105, holder.provider, 3);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 105), ['analyze', 'dev', 'analyze'],
            'the rebuilt streak re-arms the analyzer once at the fresh crossing');

        devFailures(105, holder.provider, 1);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 105), ['analyze', 'dev', 'analyze', 'dev'],
            'past the fresh crossing the loop is blind again (no crash-retry storm)');
    });

    test('AC6: different-signature failures never merge into one streak', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(106, ['agent:dev']);
        devFailures(106, holder.provider, 2);
        holder.provider.addComments(106, [failureNotice(LFR, 'ai-teammate.yml', 'Rework Push', 'tests red')]);
        devFailures(106, holder.provider, 1);

        // Five Development-Setup failures in total, but never four in a
        // row: the interleaved Rework Push failure keeps every run at 3.
        for (var i = 0; i < 2; i++) {
            faTick(holder, faJobParams({ afterFailures: 4 }));
            holder.provider.addComments(106, [failureNotice(LFR, 'ai-teammate.yml', 'Development Setup', 'npm ci failed')]);
        }
        faTick(holder, faJobParams({ afterFailures: 4 }));
        var legs = legsDispatched(holder.provider, 106);
        assert.equal(legs.indexOf('analyze'), -1,
            '5 same-signature failures in total never cross while a different signature keeps breaking the run');
        assert.ok(legs.indexOf('dev') !== -1, 'blind retries throughout');
    });

    test('AC7: missing config disables the feature silently — blind retries forever, no analyze leg in play', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(107, ['agent:dev']);
        devFailures(107, holder.provider, 6);

        faTick(holder, faJobParams(undefined));
        assert.deepEqual(legsDispatched(holder.provider, 107), ['dev'],
            'no failureAnalysis block → today\'s behavior, byte for byte');
        faTick(holder, faJobParams(undefined));
        assert.deepEqual(legsDispatched(holder.provider, 107), ['dev', 'dev'],
            'still blind at streak 7 — the counter alone never stops the loop');
        assert.equal(holder.provider.store.listedWithLabels.indexOf('sm:leg-blocked'), -1,
            'the park label is not even queried while disabled');
    });

    test('AC7: malformed config is a hard error at SM start', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(108, ['agent:dev']);
        var agent = loadModule('js/machineSmAgent.js',
            makeRequire(agentModuleMap({}, holder)), {
                cli_execute_command: function () { return '{}'; }
            });
        assert.throws(function () {
            agent.action({ jobParams: faJobParams({ afterFailures: 'four' }) });
        }, /afterFailures must be a positive integer/);
        assert.equal(holder.provider.store.dispatches.length, 0, 'the tick never ran');
    });

    test('the parked label joins the machine-issue query while the feature is enabled', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(109, ['agent:dev']);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.ok(holder.provider.store.listedWithLabels.indexOf('sm:leg-blocked') !== -1,
            'parked issues stay listed so the skip reason stays observable');
    });

    test('a provider without the issue-comment primitive degrades to today\'s behavior (fail-safe)', function () {
        var holder = { provider: scriptedProvider() };
        delete holder.provider.issueComments; // the gitlab twin shape
        holder.provider.addIssue(110, ['agent:dev']);
        devFailures(110, holder.provider, 4);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 110), ['dev'],
            'no issue-comment read → no streak → blind retry (never wedge the loop)');
    });

    test('resolveMachineSmConfig: the machineSm project override wins over jobParams for failureAnalysis', function () {
        var agent = loadModule('js/machineSmAgent.js',
            makeRequire(agentModuleMap({}, null)), {
                cli_execute_command: function () { return '{}'; }
            });
        var cfg = agent.resolveMachineSmConfig(
            { failureAnalysis: { afterFailures: 5, blockedLabel: 'job:label' } },
            { machineSm: { failureAnalysis: { afterFailures: 3 } } });
        assert.equal(cfg.failureAnalysis.afterFailures, 3, 'the override wins');
        assert.equal(cfg.failureAnalysis.blockedLabel, 'job:label', 'jobParams fills knobs the override lacks');
        var off = agent.resolveMachineSmConfig({}, {});
        assert.equal(off.failureAnalysis.enabled, false, 'absent everywhere → disabled silently');
    });

    test('the disabled feature never reads the issue comments (no per-issue REST call per tick)', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(111, ['agent:dev']);
        devFailures(111, holder.provider, 6);
        faTick(holder, faJobParams(undefined));
        assert.deepEqual(legsDispatched(holder.provider, 111), ['dev'], 'the loop stays blind');
        assert.equal(holder.provider.store.commentFetches.filter(function (n) { return n === 111; }).length, 0,
            'no issue-comment read while the feature is disabled — the byte-identical invariant covers I/O, not just decisions');
        faTick(holder, faJobParams(undefined));
        assert.equal(holder.provider.store.commentFetches.filter(function (n) { return n === 111; }).length, 0,
            'still zero on the next tick');
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.ok(holder.provider.store.commentFetches.filter(function (n) { return n === 111; }).length > 0,
            'an enabled config reads the comment history again');
    });

    test('a cleared park re-parks on a NEW episode with a different signature (label + exactly one new diagnostic)', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(112, ['agent:dev']);
        devFailures(112, holder.provider, 4);
        holder.provider.addComments(112, [verdictNotice(FA, {
            signature: LFR.failureSignature(DEV_SIG),
            classification: 'deterministic-infra',
            analyzedAtCount: 4,
            at: '2026-11-05T10:00:00.000Z'
        })]);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 112 && l[1] === 'sm:leg-blocked'; }).length, 1,
            'first episode parked');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 112; }).length, 1,
            'exactly one diagnostic');

        // The human resume gesture, then a brand-new failure mode that
        // streaks to its OWN crossing.
        holder.provider.removeLabel(112, 'sm:leg-blocked');
        var NEW_SIG = { workflow: 'ai-teammate.yml', step: 'Rework Push', message: 'push rejected: protected branch' };
        for (var i = 0; i < 4; i++) {
            holder.provider.addComments(112, [failureNotice(LFR, NEW_SIG.workflow, NEW_SIG.step, NEW_SIG.message)]);
        }
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 112), ['analyze'],
            'the new streak crosses its own threshold — the analyzer is dispatched');

        holder.provider.addComments(112, [verdictNotice(FA, {
            signature: LFR.failureSignature(NEW_SIG),
            classification: 'deterministic-infra',
            analyzedAtCount: 4,
            at: '2026-11-05T11:00:00.000Z'
        })]);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 112 && l[1] === 'sm:leg-blocked'; }).length, 2,
            'the NEW episode parks again — the first episode never suppresses it');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 112; }).length, 2,
            'exactly ONE new diagnostic for the new episode (one per episode)');
    });

    test('a cleared park re-parks when the SAME-signature failure returns after a failed human fix', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(113, ['agent:dev']);
        devFailures(113, holder.provider, 4);
        holder.provider.addComments(113, [verdictNotice(FA, {
            signature: LFR.failureSignature(DEV_SIG),
            classification: 'deterministic-infra',
            analyzedAtCount: 4,
            at: '2026-11-05T10:00:00.000Z'
        })]);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 113 && l[1] === 'sm:leg-blocked'; }).length, 1, 'parked');

        holder.provider.removeLabel(113, 'sm:leg-blocked'); // the human gesture
        // The human's fix failed: the same signature streaks on — counts
        // 5..8, effective (8 − 4) = 4 → the analyzer re-arms ONCE.
        devFailures(113, holder.provider, 4);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.deepEqual(legsDispatched(holder.provider, 113), ['analyze'],
            'the rebuilt streak re-arms the analyzer at the fresh crossing (the parked episode dispatched nothing)');

        // A FRESH verdict for the same signature — a deeper analysis
        // (analyzedAtCount 8, a NEWER analysis time than the first park).
        holder.provider.addComments(113, [verdictNotice(FA, {
            signature: LFR.failureSignature(DEV_SIG),
            classification: 'deterministic-infra',
            analyzedAtCount: 8,
            at: '2026-11-05T11:00:00.000Z'
        })]);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 113 && l[1] === 'sm:leg-blocked'; }).length, 2,
            'the fresh episode parks — the stale diagnostic never suppresses a fresher verdict');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 113; }).length, 2,
            'exactly one new diagnostic for the fresh episode');
    });

    test('a failed label-add re-enters the gate next tick — the park completes without a lying diagnostic', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(114, ['agent:dev']);
        devFailures(114, holder.provider, 4);
        holder.provider.addComments(114, [verdictNotice(FA, {
            signature: LFR.failureSignature(DEV_SIG),
            classification: 'deterministic-infra',
            analyzedAtCount: 4,
            at: '2026-11-05T10:00:00.000Z'
        })]);
        holder.provider.store.failNextLabelAdd = true; // the scripted REST hiccup
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 114 && l[1] === 'sm:leg-blocked'; }).length, 0,
            'the label-add failed');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 114; }).length, 0,
            'the label lands FIRST — no diagnostic can claim re-dispatch is stopped while it is not');

        holder.provider.store.failNextLabelAdd = false;
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 114 && l[1] === 'sm:leg-blocked'; }).length, 1,
            'the label-add is retried by the next tick');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 114; }).length, 1,
            'exactly ONE diagnostic for the episode');
    });

    test('a forged park marker from a non-machine identity never suppresses the park', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(115, ['agent:dev']);
        devFailures(115, holder.provider, 4);
        holder.provider.addComments(115, [
            // The marker format is public — a same-signature forged marker
            // with a future `at` would cover every verdict, forever.
            { user: { login: 'somehuman' }, body: '<!-- dmtools:failure-block {"signature":"' +
                LFR.failureSignature(DEV_SIG) + '","at":"2099-01-01T00:00:00.000Z"} -->' },
            verdictNotice(FA, {
                signature: LFR.failureSignature(DEV_SIG),
                classification: 'deterministic-infra',
                analyzedAtCount: 4,
                at: '2026-11-05T10:00:00.000Z'
            })
        ]);
        faTick(holder, faJobParams({ afterFailures: 4 }));
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 115 && l[1] === 'sm:leg-blocked'; }).length, 1,
            'the forged marker cannot hold the park gate — the machine parks');
        assert.equal(holder.provider.store.commentsPosted.filter(function (c) { return c[0] === 115; }).length, 1,
            'the diagnostic posts');
    });

    test('the park reason omits an absent confidence (never the literal "confidence null")', function () {
        var agent = loadModule('js/machineSmAgent.js',
            makeRequire(agentModuleMap({}, null)), {
                cli_execute_command: function () { return '{}'; }
            });
        var sig = LFR.failureSignature(DEV_SIG);
        function state(confidence) {
            return {
                issue: { labels: [] },
                failureAnalysis: {
                    available: true,
                    streakSignature: sig,
                    streakCount: 4,
                    verdicts: [{ signature: sig, classification: 'deterministic-infra',
                        confidence: confidence, suspected_root_cause: 'boom',
                        analyzedAtCount: 4, at: '2026-11-05T10:00:00.000Z' }],
                    parkMarkers: []
                }
            };
        }
        var cfg = { failureAnalysis: { enabled: true, blockedLabel: 'sm:leg-blocked' } };
        var without = agent.failureAnalysisGate(state(null), cfg);
        assert.ok(without && without.type === 'park', 'the park fires');
        assert.ok(without.reason.indexOf('confidence null') === -1,
            'a missing confidence degrades to omission in the audit reason');
        var withConfidence = agent.failureAnalysisGate(state(0.9), cfg);
        assert.ok(withConfidence.reason.indexOf('(confidence 0.9)') !== -1,
            'a present confidence still renders in the audit reason');
    });
});

// -------------------------------------------------------------------------
// gh-1380 — the deterministic transient pre-classifier, scripted SM replay.
// Known provider signatures (429 / rate-limit / 5xx / timeout / conn
// refused) are classified by PURE LOGIC at the threshold crossing: the SM
// stamps the transient verdict itself (zero AI calls), the retry rides
// through (or waits out the `backoff` window), and the AI analyzer leg is
// dispatched ONLY for unrecognized signatures. Same in-memory forge as the
// gh-1366 replay above.
// -------------------------------------------------------------------------

suite('machineSm transient pre-classifier — scripted replay (gh-1380)', function () {

    var LFR = lfrModule();
    var FA = faShared();
    var RATE_PATTERNS = ['\\b429\\b', 'rate limit'];
    var STORM_SIG = { workflow: 'ai-teammate.yml', step: 'Development Setup', message: '429: Rate limit reached' };
    var GIT_SIG = { workflow: 'ai-teammate.yml', step: 'Checkout tracked artifacts', message: 'git state dirty: HEAD detached' };

    function stormFailures(n, provider, count) {
        for (var i = 0; i < count; i++) {
            provider.addComments(n, [failureNotice(LFR, STORM_SIG.workflow, STORM_SIG.step, STORM_SIG.message)]);
        }
    }

    function gitStateFailures(n, provider, count) {
        for (var i = 0; i < count; i++) {
            provider.addComments(n, [failureNotice(LFR, GIT_SIG.workflow, GIT_SIG.step, GIT_SIG.message)]);
        }
    }

    // The SM's own pre-classifier verdict stamps posted for one issue.
    function preClassifierStamps(provider, n) {
        return provider.store.commentsPosted.filter(function (c) {
            return c[0] === n && c[1].indexOf('<!-- dmtools:failure-verdict ') === 0;
        });
    }

    function parseStamp(body) {
        var parsed = FA.parseFailureVerdicts([{ user: { login: 'ai-teammate' }, body: body }],
            { authorLogins: ['ai-teammate'] });
        assert.equal(parsed.length, 1, 'the SM stamp parses under the machine-identity gate');
        return parsed[0];
    }

    function freshAgent() {
        return loadModule('js/machineSmAgent.js',
            makeRequire(agentModuleMap({}, { provider: scriptedProvider() })), {
                cli_execute_command: function () { return '{}'; }
            });
    }

    test('AC1: four identical 429 failures pre-classify transient — the retry rides through, NO analyzer leg, the counter resets', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(201, ['agent:dev']);
        stormFailures(201, holder.provider, 4);

        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS }));
        assert.deepEqual(legsDispatched(holder.provider, 201), ['dev'],
            'the retry dispatch rides through — zero AI: no analyzer leg dispatched');
        var stamps = preClassifierStamps(holder.provider, 201);
        assert.equal(stamps.length, 1, 'exactly one pre-classifier verdict stamp');
        var verdict = parseStamp(stamps[0][1]);
        assert.equal(verdict.classification, 'transient');
        assert.equal(verdict.source, FA.TRANSIENT_SOURCE);
        assert.equal(verdict.analyzedAtCount, 4, 'the stamp consumes the streak prefix — the counter resets');
        assert.equal(holder.provider.store.labels.filter(function (l) { return l[0] === 201; }).length, 0,
            'a transient classification never parks');

        // A success posts nothing (the gh-1366 AC2 convention) — the
        // consumed prefix alone keeps the arithmetic honest: the next tick
        // is blind retry, no stamp, no analyzer.
        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS }));
        assert.deepEqual(legsDispatched(holder.provider, 201), ['dev', 'dev'],
            'retries continue below the new threshold — no re-stamp, no analyzer');

        // Four MORE identical failures rebuild the streak (8 − 4 = 4): the
        // pre-classifier stamps the fresh crossing — still zero analyzer
        // dispatches for a known-transient signature.
        stormFailures(201, holder.provider, 4);
        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS }));
        assert.deepEqual(legsDispatched(holder.provider, 201), ['dev', 'dev', 'dev'],
            'the analyzer never fires for a known-transient signature');
        var stamps2 = preClassifierStamps(holder.provider, 201);
        assert.equal(stamps2.length, 2, 'the new crossing stamps again');
        assert.equal(parseStamp(stamps2[1][1]).analyzedAtCount, 8, 'the fresh crossing consumes the deeper streak');
    });

    test('backoff > 1 multiplies the retry interval — the SM absorbs ticks before the retry resumes', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(202, ['agent:dev']);
        stormFailures(202, holder.provider, 4);

        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, backoff: 3 }));
        assert.deepEqual(legsDispatched(holder.provider, 202), [],
            'the classification tick IS backoff tick 1 — no dispatch yet');
        assert.equal(preClassifierStamps(holder.provider, 202).length, 1, 'the stamp opens the window');

        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, backoff: 3 }));
        assert.deepEqual(legsDispatched(holder.provider, 202), [], 'tick 2 of 3 absorbed');
        assert.equal(preClassifierStamps(holder.provider, 202).length, 2, 'each absorbed tick re-stamps its count');

        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, backoff: 3 }));
        assert.deepEqual(legsDispatched(holder.provider, 202), ['dev'],
            'tick 3 of 3 — the window is served, the retry resumes');
        assert.equal(preClassifierStamps(holder.provider, 202).length, 2, 'no extra stamp on the resume tick');

        // The retry leg fails again (the 5th failure): the stamp no longer
        // matches the streak depth — the window cannot gate a live episode.
        stormFailures(202, holder.provider, 1);
        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, backoff: 3 }));
        assert.deepEqual(legsDispatched(holder.provider, 202), ['dev', 'dev'],
            'normal cadence resumes after the window');
    });

    test('AC2: an unknown-signature streak dispatches the AI analyzer exactly as today', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(203, ['agent:dev']);
        gitStateFailures(203, holder.provider, 4);

        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS }));
        assert.deepEqual(legsDispatched(holder.provider, 203), ['analyze'],
            'no pattern match → the AI analyzer leg dispatches (gh-136 semantics verbatim)');
        assert.equal(preClassifierStamps(holder.provider, 203).length, 0,
            'no pre-classifier stamp for the unrecognized signature');
    });

    test('AC3: an empty or missing pattern list routes every failure to the AI analyzer (today preserved)', function () {
        var variants = [undefined, []];
        for (var v = 0; v < variants.length; v++) {
            var holder = { provider: scriptedProvider() };
            holder.provider.addIssue(204, ['agent:dev']);
            stormFailures(204, holder.provider, 4);
            var cfg = { afterFailures: 4 };
            if (variants[v] !== undefined) cfg.transientPatterns = variants[v];
            faTick(holder, faJobParams(cfg));
            assert.deepEqual(legsDispatched(holder.provider, 204), ['analyze'],
                'no configured patterns → the 429 storm still routes to the analyzer');
            assert.equal(preClassifierStamps(holder.provider, 204).length, 0,
                'and no pre-classifier stamp exists');
        }
    });

    test('AC5: patterns are config data — a deployment pattern classifies without any code change', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(205, ['agent:dev']);
        gitStateFailures(205, holder.provider, 4);

        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: ['git state dirty'] }));
        assert.deepEqual(legsDispatched(holder.provider, 205), ['dev'],
            'the deployment\'s own pattern pre-classifies the streak');
        assert.equal(preClassifierStamps(holder.provider, 205).length, 1);
        assert.equal(parseStamp(preClassifierStamps(holder.provider, 205)[0][1]).classification, 'transient');
    });

    test('analyzerEnabled: false — the pre-classifier + backoff run, the AI analyzer leg never dispatches (no AI anywhere)', function () {
        var matched = { provider: scriptedProvider() };
        matched.provider.addIssue(206, ['agent:dev']);
        stormFailures(206, matched.provider, 4);
        faTick(matched, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, analyzerEnabled: false }));
        assert.deepEqual(legsDispatched(matched.provider, 206), ['dev'],
            'a matched transient stamps + rides through');
        assert.equal(preClassifierStamps(matched.provider, 206).length, 1, 'the deterministic classification still stamps');

        var unmatched = { provider: scriptedProvider() };
        unmatched.provider.addIssue(207, ['agent:dev']);
        gitStateFailures(207, unmatched.provider, 4);
        faTick(unmatched, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, analyzerEnabled: false }));
        assert.deepEqual(legsDispatched(unmatched.provider, 207), ['dev'],
            'an unmatched failure blind-retries — the analyzer diversion is off');
        assert.equal(preClassifierStamps(unmatched.provider, 207).length, 0);
    });

    test('gateBlindRedispatch (surgical): the pre-classifier classifies at the crossing; the analyzer divert stays verbatim', function () {
        var agent = freshAgent();
        var rateSig = LFR.failureSignature(STORM_SIG);
        var gitSig = LFR.failureSignature(GIT_SIG);
        function stateWithSig(sig, count) {
            return {
                issue: { labels: [] },
                failureAnalysis: {
                    available: true, streakSignature: sig, streakCount: count,
                    verdicts: [], parkMarkers: []
                }
            };
        }
        var dispatchActions = [{ type: 'dispatch', leg: 'dev', reason: 'r' }];
        var cfg = { failureAnalysis: { enabled: true, afterFailures: 4, backoff: 1,
            transientPatterns: RATE_PATTERNS, analyzerEnabled: true } };

        var stamped = agent.gateBlindRedispatch(dispatchActions, stateWithSig(rateSig, 4), cfg);
        assert.deepEqual(stamped.map(function (a) { return a.type; }), ['transientVerdict', 'dispatch'],
            'the stamp lands before the riding retry dispatch');
        assert.equal(stamped[1].leg, 'dev', 'the retry leg is untouched');

        var backedOff = agent.gateBlindRedispatch(dispatchActions, stateWithSig(rateSig, 4),
            { machineLogins: ['ai-teammate'],
              failureAnalysis: { enabled: true, afterFailures: 4, backoff: 3,
                transientPatterns: RATE_PATTERNS, analyzerEnabled: true } });
        assert.deepEqual(backedOff.map(function (a) { return a.type; }), ['transientVerdict'],
            'backoff > 1 absorbs the classification tick — no dispatch at all (trusted stamps)');
        assert.equal(backedOff[0].verdict.ticksSoFar, 1, 'the classification tick is backoff tick 1');

        var diverted = agent.gateBlindRedispatch(dispatchActions, stateWithSig(gitSig, 4), cfg);
        assert.deepEqual(diverted.map(function (a) { return a.type; }), ['dispatch']);
        assert.equal(diverted[0].leg, 'analyze', 'the unknown signature still diverts to the analyzer (gh-136 verbatim)');
        assert.equal(diverted[0].type, 'dispatch', 'the divert replaces the dispatch in place');

        var noAi = agent.gateBlindRedispatch(dispatchActions, stateWithSig(gitSig, 4),
            { failureAnalysis: { enabled: true, afterFailures: 4, transientPatterns: RATE_PATTERNS, analyzerEnabled: false } });
        assert.deepEqual(noAi, dispatchActions, 'analyzer off + unmatched → untouched blind retry (no AI anywhere)');

        var escalationOnly = [{ type: 'label', label: 'needs-human', reason: 'rounds exhausted' }];
        assert.deepEqual(
            agent.gateBlindRedispatch(escalationOnly, stateWithSig(rateSig, 4), cfg), escalationOnly,
            'no dispatch to classify or divert → escalations ride untouched');
    });

    test('gateTransientBackoff (surgical): a pending window absorbs the dispatch into the tick stamp; other actions ride', function () {
        var agent = freshAgent();
        var sig = LFR.failureSignature(STORM_SIG);
        function stateWith(stampVerdict, streak) {
            return {
                issue: { labels: [] },
                failureAnalysis: {
                    available: true, streakSignature: sig, streakCount: streak,
                    verdicts: stampVerdict ? [stampVerdict] : [], parkMarkers: []
                }
            };
        }
        var stamp1 = {
            signature: sig, classification: 'transient', source: FA.TRANSIENT_SOURCE,
            analyzedAtCount: 4, backoffTicks: 3, ticksSoFar: 1, at: '2026-11-06T10:00:00.000Z'
        };
        var cfg = { failureAnalysis: { enabled: true, backoff: 3, transientPatterns: RATE_PATTERNS } };
        var actions = [{ type: 'dispatch', leg: 'dev', reason: 'r' }, { type: 'label', label: 'x', reason: 'y' }];

        var gated = agent.gateTransientBackoff(actions, stateWith(stamp1, 4), cfg);
        assert.equal(gated.length, 2, 'same action count — the dispatch is replaced, not dropped');
        assert.equal(gated[0].type, 'transientVerdict', 'the dispatch is absorbed into the tick stamp');
        assert.equal(gated[0].verdict.ticksSoFar, 2, 'the absorbed tick advances the window counter');
        assert.equal(gated[0].verdict.analyzedAtCount, 4, 'the consumed prefix stays stable mid-window');
        assert.equal(gated[1].type, 'label', 'non-dispatch actions ride untouched');

        assert.deepEqual(agent.gateTransientBackoff(actions, stateWith(stamp1, 5), cfg), actions,
            'a new failure since the stamp closes the window — actions unchanged');
        assert.deepEqual(agent.gateTransientBackoff(actions, stateWith(null, 4), cfg), actions,
            'no stamp → no window');
        assert.deepEqual(
            agent.gateTransientBackoff(actions, stateWith(stamp1, 4),
                { failureAnalysis: { enabled: false } }), actions,
            'feature off → no gating');
        assert.deepEqual(
            agent.gateTransientBackoff(actions,
                { issue: { labels: [] } }, cfg), actions,
            'unavailable failure-analysis state (the gitlab twin shape) → no gating');
        assert.deepEqual(
            agent.gateTransientBackoff([{ type: 'label', label: 'needs-human', reason: 'r' }],
                stateWith(stamp1, 4), cfg),
            [{ type: 'label', label: 'needs-human', reason: 'r' }],
            'a pending window with no dispatch to absorb gates nothing');
    });

    test('the pre-classifier stamps never pollute the gh-1363 signature history (the streak math stays clean)', function () {
        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(208, ['agent:dev']);
        stormFailures(208, holder.provider, 4);
        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, backoff: 3 }));
        faTick(holder, faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, backoff: 3 }));
        var stampBodies = preClassifierStamps(holder.provider, 208).map(function (c) { return c[1]; });
        assert.ok(stampBodies.length >= 2, 'the replay posted stamps');
        assert.deepEqual(LFR.parseSignatureLines(stampBodies), [],
            'the stamp comments carry no failure-signature line');
        var bodies = holder.provider.store.comments[208].map(function (c) { return c.body; });
        var streak = FA.failureStreak(bodies);
        assert.equal(streak.count, 4, 'the streak is exactly the failure notices — the stamps are invisible to it');
        assert.equal(streak.signature, LFR.failureSignature(STORM_SIG));
    });

    test('no machineAuthor (untrusted stamps) + backoff > 1 NEVER wedges the loop — the crossing stamps AND the retry dispatches', function () {
        // The reviewer trace: with an empty machine-identity allowlist the
        // gh-807 fail-closed parse trusts NOTHING, so an absorbed dispatch
        // could never resume — the crossing would re-fire every tick with
        // zero retries ever dispatching. The guard: absorb ONLY when the
        // stamp can be trusted back; otherwise the backoff = 1 shape rides
        // (wasteful-but-live — classification lands, retries continue).
        var jobParams = faJobParams({ afterFailures: 4, transientPatterns: RATE_PATTERNS, backoff: 3 });
        delete jobParams.machineAuthor; // machineLogins resolves to []

        var holder = { provider: scriptedProvider() };
        holder.provider.addIssue(209, ['agent:dev']);
        stormFailures(209, holder.provider, 4);

        faTick(holder, jobParams);
        assert.deepEqual(legsDispatched(holder.provider, 209), ['dev'],
            'the dispatch is NOT absorbed — the retry leg resumes (never wedge)');
        assert.equal(preClassifierStamps(holder.provider, 209).length, 1,
            'the classification stamp still lands (the audit trail stays honest)');
        var stamp = parseStamp(preClassifierStamps(holder.provider, 209)[0][1]);
        assert.equal(stamp.classification, 'transient');
        assert.equal(stamp.analyzedAtCount, 4, 'the consumed prefix is still stamped');

        // The retry leg fails again (the 5th identical failure): the loop
        // is blind at the deeper streak — no re-stamp storm, no wedge.
        stormFailures(209, holder.provider, 1);
        faTick(holder, jobParams);
        assert.deepEqual(legsDispatched(holder.provider, 209), ['dev', 'dev'],
            'past the crossing the loop stays blind — retries always continue');
        assert.equal(preClassifierStamps(holder.provider, 209).length, 1,
            'no stamp flood while the streak sits past the consumed depth');
    });

    test('gateBlindRedispatch (surgical): without machine logins the crossing degrades to the backoff = 1 shape (stamp rides BEFORE the dispatch)', function () {
        var agent = freshAgent();
        var rateSig = LFR.failureSignature(STORM_SIG);
        function stateWithSig(count) {
            return {
                issue: { labels: [] },
                failureAnalysis: {
                    available: true, streakSignature: rateSig, streakCount: count,
                    verdicts: [], parkMarkers: []
                }
            };
        }
        var actions = [{ type: 'label', label: 'agent:dev', reason: 'r' }, { type: 'dispatch', leg: 'dev', reason: 'r' }];
        var cfg = { machineLogins: [], failureAnalysis: { enabled: true, afterFailures: 4, backoff: 3,
            transientPatterns: RATE_PATTERNS, analyzerEnabled: true } };

        var degraded = agent.gateBlindRedispatch(actions, stateWithSig(4), cfg);
        assert.deepEqual(degraded.map(function (a) { return a.type; }), ['label', 'transientVerdict', 'dispatch'],
            'the stamp is INSERTED before the riding dispatch — nothing absorbed');
        assert.equal(degraded[2].leg, 'dev', 'the retry dispatch rides through untouched');
        assert.equal(degraded[1].verdict.backoffTicks, undefined,
            'the untrusted stamp carries NO backoff window (the backoff = 1 shape)');

        var trusted = agent.gateBlindRedispatch(actions, stateWithSig(4),
            { machineLogins: ['ai-teammate'], failureAnalysis: cfg.failureAnalysis });
        assert.deepEqual(trusted.map(function (a) { return a.type; }), ['label', 'transientVerdict'],
            'same action count — the stamp REPLACES the dispatch');
        assert.equal(trusted[1].verdict.backoffTicks, 3, 'the trusted stamp opens the window');
        assert.ok(trusted.indexOf(actions[1]) === -1, 'the dispatch is absorbed into the window');
    });
});
