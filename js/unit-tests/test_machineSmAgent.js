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
        './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({}), {}),
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

    // ── helpers ──────────────────────────────────────────────────────────────

    test('issueFromRunTitle parses gh-N from run titles', function () {
        assert.equal(agent.issueFromRunTitle('🔧 rework · gh-125: Machine comments'), 125);
        assert.equal(agent.issueFromRunTitle('⚒️ dev · gh-3: no digits elsewhere'), 3);
        assert.equal(agent.issueFromRunTitle('no issue here'), null);
    });

});

suite('machineSm resolveSuggestionThreads (gh-828)', function () {

    var rvReal = function () {
        if (!rvReal.mod) rvReal.mod = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});
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
        if (!rvReal.mod) rvReal.mod = loadModule('js/common/reviewVerdicts.js', makeRequire({}), {});
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
