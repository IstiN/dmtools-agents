/**
 * Unit tests for machineSmAgent.js — the machine-loop watchdog decision core.
 *
 * The decision core (decideActions, issueFromRunTitle, checkConclusion) is
 * pure; these tests pin the reconciler contract: dead-letter re-fires,
 * rework round cap, review/merge/update-branch routing, concurrency skips.
 */
/* global suite, test, assert, loadModule, makeRequire */

suite('machineSm decision core', function () {

    var agent = loadModule('js/machineSmAgent.js', makeRequire({
        './configLoader.js': { loadProjectConfig: function () { return {}; } },
        './common/smProvider.js': { createSmProvider: function () { return {}; } },
        './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
        './common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
    }), {
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

    test('approved + BLOCKED resolves suggestion threads in-tick (gh-828)', function () {
        // The unresolved-thread conversation gate: the rework arm is
        // withheld on APPROVE+blocking=0 (gh-807), so the machine must
        // resolve its own non-blocking threads or the PR strands BLOCKED.
        var acts = agent.decideActions(
            st(['ai_developed', 'ai_pr_reviewed', 'pr_approved'],
               greenPr('BLOCKED', false)), {});
        assert.equal(acts.length, 1);
        assert.equal(acts[0].type, 'resolveSuggestionThreads');
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
    var agent = loadModule('js/machineSmAgent.js', makeRequire({
        './configLoader.js': { loadProjectConfig: function () { return {}; } },
        './common/smProvider.js': { createSmProvider: function () { return {}; } },
        './common/reviewVerdicts.js': rvReal(),
        './common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
    }), {
        cli_execute_command: function () { return '{}'; }
    });

    var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';
    var RECORD = { head: HEAD, verdict: 'APPROVE', blocking: 0, important: 1, suggestions: 4,
                   at: '2026-10-10T05:47:30.000Z', source: 'pr_review.json' };

    function providerWith(threads, opts) {
        opts = opts || {};
        return {
            calls: { replies: [], resolves: [] },
            verdictRecords: function () { return [RECORD]; },
            reviewThreadList: function () { return threads; },
            replyToThread: function (pr, thread, text) {
                this.calls.replies.push({ pr: pr, threadId: thread.threadId, text: text });
            },
            resolveThread: function (pr, thread) {
                this.calls.resolves.push({ pr: pr, threadId: thread.threadId });
            }
        };
    }
    function sug(i) {
        return { threadId: 'RT_' + i, rootCommentId: 100 + i, resolved: false,
                 author: 'ai-teammate', body: '💡 SUGGESTION: polish ' + i };
    }

    test('AC1 replay (#1457–#1470): 4 suggestion threads → 4 ack replies + 4 resolves in one tick', function () {
        var p = providerWith([sug(1), sug(2), sug(3), sug(4)]);
        var out = agent.resolveSuggestionThreads(p, 1457, HEAD,
            { machineLogins: ['ai-teammate'] });
        assert.equal(out.resolved, 4);
        assert.equal(p.calls.replies.length, 4, 'one ack reply per resolved thread');
        assert.contains(p.calls.replies[0].text, 'non-blocking suggestion');
        assert.contains(p.calls.replies[0].text, 'resolved per APPROVE verdict');
        assert.equal(p.calls.resolves.length, 4);
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

    test('a resolve failure does not abort the remaining threads', function () {
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

    test('a resolve failure leaves no ack behind (resolve-first idempotency, gh-828 review round 3)', function () {
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

    test('a failed ack reply after a successful resolve is logged, not fatal (gh-1185 branch coverage)', function () {
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
        var agent = loadModule('js/machineSmAgent.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function () { return projectConfig; } },
            './common/smProvider.js': { createSmProvider: function () { return holder.provider; } },
            './common/reviewVerdicts.js': rvReal(),
            './common/machineAuthor.js': maReal()
        }), {
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
            resolveThread: function (pr, thread) { resolved.push(thread.threadId); }
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
        var agent = loadModule('js/machineSmAgent.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function () { return {}; } },
            './common/smProvider.js': { createSmProvider: function () { return holder.provider; } },
            './common/reviewVerdicts.js': rvReal(),
            './common/machineAuthor.js': maReal()
        }), {
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
        var agent = loadModule('js/machineSmAgent.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function () { return projectConfig; } },
            './common/smProvider.js': smProviderMock,
            './common/reviewVerdicts.js': rvReal(),
            './common/machineAuthor.js': maReal()
        }), {
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

    var agent = loadModule('js/machineSmAgent.js', makeRequire({
        './configLoader.js': { loadProjectConfig: function () { return {}; } },
        './common/smProvider.js': { createSmProvider: function () { return {}; } },
        './common/reviewVerdicts.js': rvReal(),
        './common/machineAuthor.js': maReal()
    }), {
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
        return loadModule('js/machineSmAgent.js', makeRequire({
            './configLoader.js': { loadProjectConfig: function () { return {}; } },
            './common/smProvider.js': { createSmProvider: function () { return {}; } },
            './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({}), {}),
            './common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {})
        }), {
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
            replyToThread: function (n, t, ack) { replies.push({ id: t.threadId, ack: ack }); }
        };
        var agent = loadExecAgent();
        var out = agent.executeAction(provider,
            { type: 'resolveSuggestionThreads', prNumber: 5, headSha: EXEC_HEAD },
            { number: 5 }, execCfg());
        assert.equal(out.resolved, 2, 'both non-blocking machine threads resolved');
        assert.deepEqual(resolved, ['RT_1', 'RT_2']);
        assert.equal(replies.length, 2, 'an ack reply follows each resolve');
        assert.ok(replies[0].ack.indexOf('gh-828') !== -1, 'the ack carries the gh-828 wording');
    });

    test('resolveSuggestionThreads: a failing resolve skips the ack for that thread only', function () {
        var replies = [];
        var provider = {
            verdictRecords: function () { return [approveRecord()]; },
            reviewThreadList: function () { return [suggestionThread('RT_1'), suggestionThread('RT_2')]; },
            resolveThread: function (n, t) { if (t.threadId === 'RT_1') throw new Error('graphql down'); },
            replyToThread: function (n, t, ack) { replies.push(t.threadId); }
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
            replyToThread: function () { throw new Error('reply down'); }
        };
        var agent = loadExecAgent();
        var out = agent.executeAction(provider,
            { type: 'resolveSuggestionThreads', prNumber: 5, headSha: EXEC_HEAD },
            { number: 5 }, execCfg());
        assert.equal(out.resolved, 1, 'the resolve is still credited when the ack fails');
    });

});
