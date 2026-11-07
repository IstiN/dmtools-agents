/**
 * Unit tests: js/common/mergeStateReconcile.js (gh-140) + the consumers —
 * the SM check-tracker blind-spot closure.
 *
 * Live gh-1392 (2026-11-06/07): the tracked verdict check went green while a
 * SEPARATE repo workflow (docs-freshness) failed on the same head — GitHub's
 * real mergeStateStatus read UNSTABLE, the merge lanes refused it, and every
 * re-derivation lane that keys on the tracked verdict said green: the PR
 * froze with no rework lap. The reconcile downgrades the effective verdict
 * to 'red' (the bounded red-head flow reacts within one tick), registers the
 * untracked failing names, and the re-review armers gate on the TRACKED
 * verdict so an untracked red never freezes them.
 *
 * Layers tested here:
 *   1. mergeStateReconcile — the pure decision module
 *   2. smProvider prStatus — the per-PR reconcile wiring (REST rollup shape)
 *   3. factoryState — the state-JSON card registration (AC3)
 *   4. githubSource — the trackedChecks guard + needsStatus wiring
 */
/* global loadModule, assert, test, suite, makeRequire */

var mrReal = function () {
    if (!mrReal.mod) mrReal.mod = loadModule('js/common/mergeStateReconcile.js', makeRequire({}), {});
    return mrReal.mod;
};

// The real smProvider: needs its load-time requires (gh-823) — reviewVerdicts,
// validationLiveness, and (gh-140) mergeStateReconcile.
var spReal = function () {
    if (!spReal.mod) {
        spReal.mod = loadModule('js/common/smProvider.js', makeRequire({
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js',
                makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
            './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {}),
            './mergeStateReconcile.js': mrReal()
        }), {});
    }
    return spReal.mod;
};

function machineAuthorReal() {
    if (!machineAuthorReal.mod) {
        machineAuthorReal.mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    }
    return machineAuthorReal.mod;
}

var fsReal = function () {
    if (!fsReal.mod) {
        fsReal.mod = loadModule('js/factoryState.js', makeRequire({
            './common/machineAuthor.js': machineAuthorReal(),
            './common/reworkLatch.js': loadModule('js/common/reworkLatch.js',
                makeRequire({ './legRunVocab.js': loadModule('js/common/legRunVocab.js', makeRequire({}), {}) }), {}),
            './common/mergeStateReconcile.js': mrReal()
        }), {});
    }
    return fsReal.mod;
};

// REST check-run rollup entry (the spelling github_get_commit_check_runs
// produces after _ghNormalizeCheckRun: lowercase conclusions normalized to
// upper, name kept).
function cr(name, conclusion, completedAt, id) {
    return {
        name: name,
        conclusion: conclusion ? String(conclusion).toUpperCase() : null,
        status: conclusion ? 'COMPLETED' : 'IN_PROGRESS',
        completed_at: completedAt || null,
        id: id || 0
    };
}

suite('mergeStateReconcile — normalizeMergeStateStatus', function () {
    test('uppercases and trims the reported value', function () {
        assert.equal(mrReal().normalizeMergeStateStatus('unstable'), 'UNSTABLE');
        assert.equal(mrReal().normalizeMergeStateStatus(' UNSTABLE '), 'UNSTABLE');
        assert.equal(mrReal().normalizeMergeStateStatus('Failed'), 'FAILED');
    });

    test('absent reports stay null — never a fabricated verdict', function () {
        assert.equal(mrReal().normalizeMergeStateStatus(null), null);
        assert.equal(mrReal().normalizeMergeStateStatus(undefined), null);
        assert.equal(mrReal().normalizeMergeStateStatus(''), null);
        assert.equal(mrReal().normalizeMergeStateStatus('   '), null);
    });
});

suite('mergeStateReconcile — isUnstableMergeState', function () {
    test('the failing spellings: UNSTABLE (REST) and FAILED (legacy GraphQL)', function () {
        assert.equal(mrReal().isUnstableMergeState('UNSTABLE'), true);
        assert.equal(mrReal().isUnstableMergeState('unstable'), true);
        assert.equal(mrReal().isUnstableMergeState('FAILED'), true);
    });

    test('clean/blocked/unreported states never count as check failures', function () {
        ['CLEAN', 'BLOCKED', 'UNKNOWN', 'BEHIND', 'DIRTY', 'HAS_HOOKS', null, ''].forEach(function (s) {
            assert.equal(mrReal().isUnstableMergeState(s), false, 'state ' + s + ' must not be unstable');
        });
    });
});

suite('mergeStateReconcile — isReconcilableVerdict', function () {
    test('only a fold that saw NO failure may be overridden', function () {
        assert.equal(mrReal().isReconcilableVerdict('green'), true);
        assert.equal(mrReal().isReconcilableVerdict('GREEN'), true);
        assert.equal(mrReal().isReconcilableVerdict('none'), true);
        assert.equal(mrReal().isReconcilableVerdict('red'), false);
        assert.equal(mrReal().isReconcilableVerdict('pending'), false);
        assert.equal(mrReal().isReconcilableVerdict(null), false);
    });
});

suite('mergeStateReconcile — failingCheckNames', function () {
    test('empty rollup → no names', function () {
        assert.deepEqual(mrReal().failingCheckNames([], null), []);
        assert.deepEqual(mrReal().failingCheckNames(null, null), []);
    });

    test('a latest FAILURE counts, success/pending never do', function () {
        var rollup = [cr('Quality / check', 'success'), cr('docs-freshness', 'failure')];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), ['docs-freshness']);
        assert.deepEqual(mrReal().failingCheckNames(
            [cr('a', 'success'), cr('b', null)], null), []);
    });

    test('TIMED_OUT counts as a failure, CANCELED/SKIPPED do not', function () {
        assert.deepEqual(mrReal().failingCheckNames(
            [cr('job', 'timed_out'), cr('x', 'cancelled'), cr('y', 'skipped')], null),
            ['job']);
    });

    test('multi-item: several failing checks, first-failure order preserved', function () {
        var rollup = [
            cr('Quality / check', 'success'),
            cr('docs-freshness', 'failure'),
            cr('zombie-sweep', 'success'),
            cr('crap-gate', 'failure')
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null),
            ['docs-freshness', 'crap-gate']);
    });

    test('latest-per-context: an older FAILURE under a newer SUCCESS is NOT a failure', function () {
        var rollup = [
            cr('docs-freshness', 'failure', '2026-11-06T09:00:00Z', 1),
            cr('docs-freshness', 'success', '2026-11-06T10:00:00Z', 2)
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), []);
    });

    test('latest-per-context: a newer FAILURE replaces an older success', function () {
        var rollup = [
            cr('docs-freshness', 'success', '2026-11-06T09:00:00Z', 1),
            cr('docs-freshness', 'failure', '2026-11-06T10:00:00Z', 2)
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), ['docs-freshness']);
    });

    test('the machine bookeeping stamps fold out of the census', function () {
        var rollup = [
            cr('kicker / wake', 'failure'),
            cr('Wake-up probe', 'failure'),
            cr('merge / gate', 'failure'),
            cr('docs-freshness', 'failure')
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), ['docs-freshness']);
    });

    test('custom bookeeping prefixes are honored (smProvider passes its canonical list)', function () {
        var rollup = [cr('kicker / wake', 'failure'), cr('real', 'failure')];
        assert.deepEqual(mrReal().failingCheckNames(rollup, ['kicker /']), ['real']);
    });

    test('GraphQL commit-status spelling (context/state) counts too', function () {
        var rollup = [
            { context: 'docs-freshness', state: 'failure' },
            { name: 'Quality / check', conclusion: 'success' }
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), ['docs-freshness']);
    });
});

// ── latestConclusions census mechanics (rework gh-140: branch pins) ─────────
// The freshness comparison (completed_at → started_at → id → position) is
// the CRAP-heavy core of the census — every tie-break and fallback spelling
// is pinned here through the public API so the extracted helpers keep the
// exact semantics.

suite('mergeStateReconcile — latestConclusions census mechanics', function () {
    test('nameless entries never enter the census (null/undefined/empty name)', function () {
        var rollup = [null, undefined, {}, { name: '', conclusion: 'failure' }];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), []);
    });

    test('camelCase completedAt rides the same freshness comparison', function () {
        var rollup = [
            { name: 'x', conclusion: 'FAILURE', completed_at: '2026-11-06T09:00:00Z', id: 1 },
            { name: 'x', conclusion: 'SUCCESS', completedAt: '2026-11-06T10:00:00Z', id: 2 }
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), [],
            'the camelCase-timestamped run is newest — an older FAILURE is not a failure');
    });

    test('started_at (snake) and startedAt (camel) break ties when completions are absent', function () {
        var rollup = [
            { name: 'x', conclusion: 'FAILURE', started_at: '2026-11-06T09:00:00Z', id: 2 },
            { name: 'x', conclusion: 'SUCCESS', startedAt: '2026-11-06T10:00:00Z', id: 1 }
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), [],
            'the newer startedAt run wins — newest-per-context');
    });

    test('no timestamps at all → the greater id decides', function () {
        var rollup = [
            { name: 'x', conclusion: 'FAILURE', id: 1 },
            { name: 'x', conclusion: 'SUCCESS', id: 2 }
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), []);
    });

    test('same time AND same id → the later arrival position wins', function () {
        var rollup = [
            { name: 'y', conclusion: 'SUCCESS', id: 3 },
            { name: 'y', conclusion: 'FAILURE', id: 3 }
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), ['y'],
            'same freshness — the last-seen conclusion is the latest');
    });

    test('databaseId (GraphQL spelling) counts as the run id', function () {
        var rollup = [
            { name: 'w', conclusion: 'FAILURE', completed_at: '2026-11-06T09:00:00Z', id: 5 },
            { name: 'w', conclusion: 'SUCCESS', completed_at: '2026-11-06T09:00:00Z', databaseId: 9 }
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), [],
            'same completion time — the greater databaseId is the newer run');
    });

    test('same time, same databaseId → position decides (absent id degrades to 0)', function () {
        var rollup = [
            { name: 'v', conclusion: 'SUCCESS', completed_at: '2026-11-06T09:00:00Z' },
            { name: 'v', conclusion: 'FAILURE', completed_at: '2026-11-06T09:00:00Z' }
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), ['v']);
    });

    test('unparsable timestamps degrade to 0 — the greater id still decides', function () {
        var rollup = [
            { name: 'u', conclusion: 'FAILURE', completed_at: 'not-a-date', id: 1 },
            { name: 'u', conclusion: 'SUCCESS', completed_at: 'also-garbage', id: 2 }
        ];
        assert.deepEqual(mrReal().failingCheckNames(rollup, null), [],
            'both t=0 — the id tie-break picks the SUCCESS run');
    });

    test('an empty bookeeping prefix list falls back to the canonical stamps', function () {
        var rollup = [cr('kicker / wake', 'failure'), cr('real', 'failure')];
        assert.deepEqual(mrReal().failingCheckNames(rollup, []), ['real'],
            '[] degrades to DEFAULT_BOOKKEEPING_PREFIXES, not to "no folding"');
    });

    test('reconcileDecision with no input at all → null (never reconciles)', function () {
        assert.equal(mrReal().reconcileDecision(), null);
    });

    test('no checkConclusion on the input → the fold label is empty → no reconcile', function () {
        assert.equal(mrReal().reconcileDecision({ rawMergeState: 'UNSTABLE', rollup: [] }), null);
    });
});

suite('mergeStateReconcile — reconcileDecision (the AC matrix)', function () {
    test('AC1: green tracked fold + UNSTABLE report + untracked failing check → red, names registered', function () {
        var rollup = [cr('Quality / check', 'success'), cr('docs-freshness', 'failure')];
        var d = mrReal().reconcileDecision({
            checkConclusion: 'green', rawMergeState: 'UNSTABLE', rollup: rollup
        });
        assert.ok(d, 'the reconcile must fire');
        assert.equal(d.verdict, 'red');
        assert.equal(d.trackedVerdict, 'green');
        assert.deepEqual(d.untrackedFailingChecks, ['docs-freshness']);
        assert.equal(d.rawMergeState, 'UNSTABLE');
        assert.ok(d.reason.indexOf('docs-freshness') !== -1, 'reason names the failing check');
        assert.ok(d.reason.indexOf('UNSTABLE') !== -1);
    });

    test('AC2: fully green (CLEAN report) never reconciles', function () {
        var rollup = [cr('Quality / check', 'success')];
        assert.equal(mrReal().reconcileDecision({
            checkConclusion: 'green', rawMergeState: 'CLEAN', rollup: rollup
        }), null);
    });

    test('AC2: a BLOCKED report with a green fold is the conversation gate, not a check failure', function () {
        assert.equal(mrReal().reconcileDecision({
            checkConclusion: 'green', rawMergeState: 'BLOCKED',
            rollup: [cr('Quality / check', 'success')]
        }), null);
    });

    test('AC2: no reported merge state → no reconcile (the REST coarse fallback is never fabricated here)', function () {
        assert.equal(mrReal().reconcileDecision({
            checkConclusion: 'green', rawMergeState: null,
            rollup: [cr('docs-freshness', 'failure')]
        }), null);
    });

    test('a fold that already reads red/pending owns the verdict — no reconcile', function () {
        var rollup = [cr('docs-freshness', 'failure')];
        assert.equal(mrReal().reconcileDecision({
            checkConclusion: 'red', rawMergeState: 'UNSTABLE', rollup: rollup
        }), null);
        assert.equal(mrReal().reconcileDecision({
            checkConclusion: 'pending', rawMergeState: 'UNSTABLE', rollup: rollup
        }), null);
    });

    test("'none' verdict (no rollup) + UNSTABLE reconciles with an EMPTY census", function () {
        // The failing context is invisible to the check-runs API entirely
        // (commit-status spelling) — the mergeStateStatus is the registration.
        var d = mrReal().reconcileDecision({
            checkConclusion: 'none', rawMergeState: 'FAILED', rollup: []
        });
        assert.ok(d, 'the reconcile must fire');
        assert.equal(d.verdict, 'red');
        assert.equal(d.trackedVerdict, 'none');
        assert.deepEqual(d.untrackedFailingChecks, []);
        assert.ok(d.reason.indexOf('not in the check-runs rollup') !== -1);
    });

    test('FAILED spelling triggers the same downgrade', function () {
        var d = mrReal().reconcileDecision({
            checkConclusion: 'green', rawMergeState: 'failed',
            rollup: [cr('Quality / check', 'success')]
        });
        assert.ok(d);
        assert.equal(d.rawMergeState, 'FAILED');
    });

    test('only bookeeping failures → reconcile fires but the census is empty (all stamps folded out)', function () {
        var d = mrReal().reconcileDecision({
            checkConclusion: 'green', rawMergeState: 'UNSTABLE',
            rollup: [cr('kicker / wake', 'failure')]
        });
        assert.ok(d);
        assert.deepEqual(d.untrackedFailingChecks, []);
    });
});

// ── smProvider prStatus wiring (the per-PR reconcile job) ────────────────────

suite('gh-140 — smProvider prStatus reconcile', function () {
    // The github_* tools are file globals for the provider (loadModule
    // preamble) — every providerWith() call evals a FRESH smProvider copy
    // with its own mock tools (same pattern as test_smProvider.js).
    function providerWith(prBody, checkRuns) {
        var mod = loadModule('js/common/smProvider.js', makeRequire({
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js',
                makeRequire({ './machineAuthor.js': machineAuthorReal() }), {}),
            './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {}),
            './mergeStateReconcile.js': mrReal()
        }), {
            github_get_pr: function () { return prBody; },
            github_get_commit_check_runs: function () {
                return { total_count: (checkRuns || []).length, check_runs: checkRuns || [] };
            }
        });
        return mod.createSmProvider({
            scm: { provider: 'github' },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
    }

    test('live gh-1392 shape: green rollup + failing commit-status + UNSTABLE → red, census empty (invisible to the check-runs API)', function () {
        // The docs-freshness failure is a commit STATUS — github_get_commit_check_runs
        // never sees it: the rollup carries only the green Quality run, so the
        // pre-gh-140 fold read 'green' while GitHub reported UNSTABLE.
        var p = providerWith(
            { state: 'OPEN', mergeable: true, mergeable_state: 'unstable', head: { sha: 'abc123' } },
            [cr('Quality / check', 'success')]);
        var st = p.prStatus(7);
        assert.equal(st.checkConclusion, 'red', 'the effective verdict downgrades');
        assert.equal(st.trackedVerdict, 'green', 'the pre-reconcile fold rides for the re-review armers');
        assert.deepEqual(st.untrackedFailingChecks, [],
            'the failing context is not in the rollup — the mergeStateStatus is the registration');
        assert.equal(st.mergeStateStatus, 'UNSTABLE');
    });

    test('a failure IN the rollup is no blind spot — the fold already red, no reconcile keys', function () {
        var p = providerWith(
            { state: 'OPEN', mergeable: true, mergeable_state: 'unstable', head: { sha: 'abc123' } },
            [cr('Quality / check', 'success'), cr('docs-freshness', 'failure')]);
        var st = p.prStatus(7);
        assert.equal(st.checkConclusion, 'red', 'the whole-rollup fold reads the visible failure');
        assert.equal(st.trackedVerdict, 'red');
        assert.equal(st.untrackedFailingChecks, undefined, 'no reconcile — nothing to reconcile');
        assert.equal(st.mergeStateStatus, undefined);
    });

    test('AC2: a fully green PR carries NO reconcile keys (payload shape unchanged)', function () {
        var p = providerWith(
            { state: 'OPEN', mergeable: true, mergeable_state: 'clean', head: { sha: 'abc123' } },
            [cr('Quality / check', 'success')]);
        var st = p.prStatus(7);
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.trackedVerdict, 'green');
        assert.equal(st.untrackedFailingChecks, undefined);
        assert.equal(st.mergeStateStatus, undefined);
    });

    test('BLOCKED + green fold → stays green (the conversation gate owns it)', function () {
        var p = providerWith(
            { state: 'OPEN', mergeable: true, mergeable_state: 'blocked', head: { sha: 'abc123' } },
            [cr('Quality / check', 'success')]);
        var st = p.prStatus(7);
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.untrackedFailingChecks, undefined);
    });

    test('a tracked red stays red with no reconcile keys (the fold owns it)', function () {
        var p = providerWith(
            { state: 'OPEN', mergeable: true, mergeable_state: 'unstable', head: { sha: 'abc123' } },
            [cr('Quality / check', 'failure'), cr('docs-freshness', 'failure')]);
        var st = p.prStatus(7);
        assert.equal(st.checkConclusion, 'red');
        assert.equal(st.trackedVerdict, 'red');
        assert.equal(st.untrackedFailingChecks, undefined, 'no reconcile — the red is IN the tracked set');
        assert.equal(st.mergeStateStatus, undefined);
    });

    test('REST coarse fallback: no reported state on the body → no reconcile', function () {
        // The body carries neither mergeStateStatus nor mergeable_state —
        // _ghRestMergeState would fabricate CLEAN from mergeable:true, but
        // the reconcile reads the RAW report only.
        var p = providerWith(
            { state: 'OPEN', mergeable: true, head: { sha: 'abc123' } },
            [cr('Quality / check', 'success')]);
        var st = p.prStatus(7);
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.mergeStateStatus, undefined);
    });
});

// ── factoryState — the card registration (AC3) ──────────────────────────────

suite('gh-140 — factoryState card reconcile', function () {
    function run(id, name, sha, conclusion, createdAt, path, event) {
        return {
            id: id, name: name, head_sha: sha,
            status: conclusion ? 'completed' : 'in_progress',
            conclusion: conclusion || null,
            created_at: createdAt || '2026-11-06T09:00:00Z',
            html_url: 'https://ci/runs/' + id,
            path: path || ('.github/workflows/' + name + '.yml'),
            event: event || 'push'
        };
    }

    test('AC3: a success cite on an UNSTABLE head registers the untracked failing runs', function () {
        var mod = fsReal();
        var checks = { verdict: 'success', tier: 'tracked', runId: 42, at: '2026-11-06T09:00:00Z' };
        var pr = { head: { sha: 'abc123' }, mergeStateStatus: 'UNSTABLE' };
        var runs = [
            run(42, 'Quality', 'abc123', 'success'),
            run(99, 'docs-freshness', 'abc123', 'failure', '2026-11-06T10:00:00Z')
        ];
        var out = mod.reconcileCardChecks(pr, checks, runs, 'quality.yml');
        assert.equal(out.verdict, 'success', 'the cite itself is kept');
        assert.equal(out.mergeStateStatus, 'UNSTABLE');
        assert.equal(out.untrackedFailing.length, 1);
        assert.equal(out.untrackedFailing[0].name, 'docs-freshness');
        assert.equal(out.untrackedFailing[0].conclusion, 'failure');
        assert.ok(out.untrackedFailing[0].url, 'the failed-run link rides for the audit');
    });

    test('AC2: a CLEAN head returns the checks record untouched', function () {
        var mod = fsReal();
        var checks = { verdict: 'success', tier: 'tracked', runId: 42 };
        var pr = { head: { sha: 'abc123' }, mergeable_state: 'clean' };
        var out = mod.reconcileCardChecks(pr, checks, [run(42, 'Quality', 'abc123', 'success')], 'quality.yml');
        assert.equal(out, checks, 'same object — byte-identical card');
    });

    test('AC2: a red cite is never reconciled (the red owns the card)', function () {
        var mod = fsReal();
        var checks = { verdict: 'failure', tier: 'tracked', runId: 42 };
        var pr = { head: { sha: 'abc123' }, mergeStateStatus: 'UNSTABLE' };
        assert.equal(mod.reconcileCardChecks(pr, checks,
            [run(42, 'Quality', 'abc123', 'failure')], 'quality.yml'), checks);
    });

    test('BLOCKED on a success cite → untouched (the conversation gate, not a check failure)', function () {
        var mod = fsReal();
        var checks = { verdict: 'success', runId: 42 };
        var pr = { head: { sha: 'abc123' }, mergeStateStatus: 'BLOCKED' };
        assert.equal(mod.reconcileCardChecks(pr, checks, [], 'quality.yml'), checks);
    });

    test('failingUntrackedRuns: cite run, side-run legs, non-terminal and other-sha runs excluded (2+ kept)', function () {
        var mod = fsReal();
        var runs = [
            run(42, 'Quality', 'abc123', 'success'),                    // the cite itself
            run(99, 'docs-freshness', 'abc123', 'failure'),             // kept
            run(100, 'crap-gate', 'abc123', 'timed_out'),               // kept
            run(101, 'review-leg', 'abc123', 'failure', null, '.github/workflows/review.yml', 'workflow_dispatch'), // side-run leg — excluded
            run(102, 'pending-run', 'abc123', null),                    // not terminal — excluded
            run(103, 'other-head', 'def456', 'failure')                 // another sha — excluded
        ];
        var out = mod.failingUntrackedRuns(runs, 'abc123', 42, 'quality.yml');
        assert.equal(out.length, 2);
        assert.deepEqual(out.map(function (r) { return r.name; }), ['docs-freshness', 'crap-gate']);
    });

    test('a null checks record passes through untouched (nothing to decorate)', function () {
        var mod = fsReal();
        var pr = { head: { sha: 'abc123' }, mergeStateStatus: 'UNSTABLE' };
        assert.equal(mod.reconcileCardChecks(pr, null,
            [run(99, 'docs-freshness', 'abc123', 'failure')], 'quality.yml'), null);
    });

    test('the cite can ride checks.conclusion (green spelling) — the reconcile still fires', function () {
        var mod = fsReal();
        var checks = { conclusion: 'green', runId: 42 };
        var pr = { head: { sha: 'abc123' }, mergeStateStatus: 'UNSTABLE' };
        var out = mod.reconcileCardChecks(pr, checks,
            [run(99, 'docs-freshness', 'abc123', 'failure')], 'quality.yml');
        assert.equal(out.mergeStateStatus, 'UNSTABLE');
        assert.equal(out.untrackedFailing.length, 1);
    });

    test('no verdict/conclusion on the checks record → no reconcile (empty cite label)', function () {
        var mod = fsReal();
        var checks = { runId: 42 };
        var pr = { head: { sha: 'abc123' }, mergeStateStatus: 'UNSTABLE' };
        assert.equal(mod.reconcileCardChecks(pr, checks,
            [run(99, 'docs-freshness', 'abc123', 'failure')], 'quality.yml'), checks);
    });

    test('failingUntrackedRuns: a null runs list yields an empty census', function () {
        var mod = fsReal();
        assert.deepEqual(mod.failingUntrackedRuns(null, 'abc123', 42, 'quality.yml'), []);
    });

    test('a completed non-failure run on the head is excluded (success is not a failure)', function () {
        var mod = fsReal();
        var runs = [
            run(42, 'Quality', 'abc123', 'success'),
            run(105, 'lint-gate', 'abc123', 'success'),                 // terminal green on the head — kept out
            run(99, 'docs-freshness', 'abc123', 'failure')              // kept
        ];
        var out = mod.failingUntrackedRuns(runs, 'abc123', 42, 'quality.yml');
        assert.deepEqual(out.map(function (r) { return r.name; }), ['docs-freshness']);
    });

    test('a completed run with no conclusion yet is excluded', function () {
        var mod = fsReal();
        var bare = { id: 106, name: 'ghost-run', head_sha: 'abc123', status: 'completed', conclusion: null };
        var runs = [bare, run(99, 'docs-freshness', 'abc123', 'failure')];
        var out = mod.failingUntrackedRuns(runs, 'abc123', 42, 'quality.yml');
        assert.deepEqual(out.map(function (r) { return r.name; }), ['docs-freshness']);
    });

    test('the census record degrades missing fields to null (bare workflow-run shape)', function () {
        var mod = fsReal();
        var bare = { id: 107, head_sha: 'abc123', status: 'completed', conclusion: 'failure' };
        var out = mod.failingUntrackedRuns([bare], 'abc123', null, 'quality.yml');
        assert.equal(out.length, 1, 'no citeRunId → nothing to exclude');
        assert.deepEqual(out[0], {
            name: null, workflow: null, conclusion: 'failure', at: null, url: null
        });
    });
});

// ── githubSource — the trackedChecks guard (the re-review armers' gate) ─────

suite('gh-140 — githubSource trackedChecks guard', function () {
    var srcMod;

    function load(tools, listPrs, statuses) {
        var providerStub = {
            findPr: function () { return null; },
            prStatus: function (n) { return statuses[n] || null; },
            lastReview: function () { return null; },
            reviewThreads: function () { return null; },
            latestVerdictRecord: function () { return null; }
        };
        var listMock = listPrs || [];
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': { createSmProvider: function () { return providerStub; } }
        }), tools || {});
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/guestTransplant.js': loadModule('js/common/guestTransplant.js', makeRequire({
                './machineAuthor.js': machineAuthorReal()
            }), {}),
            '../../common/machineAuthor.js': machineAuthorReal(),
            '../../common/smProvider.js': {
                createSmProvider: function () { return providerStub; },
                ghPrHeadRepoFull: spReal().ghPrHeadRepoFull,
                ghPrHeadRepoFullAlias: undefined,
                ghPrMaintainerCanModify: spReal().ghPrMaintainerCanModify
            },
            '../../common/smAsync.js': smAsyncMod,
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {})
        }), tools);
    }

    function prList(numbers) {
        return (numbers || []).map(function (n) {
            return { number: n, labels: [], head: { ref: 'ai/gh-1' }, draft: false };
        });
    }

    test('trackedChecks green admits an effective-red head whose tracked verdict is green (the gh-1392 head)', function () {
        srcMod = load({ github_list_prs: function () { return prList([10]); } }, null, {
            10: { number: 10, state: 'OPEN', checkConclusion: 'red', trackedVerdict: 'green',
                  mergeState: 'UNSTABLE', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', trackedChecks: 'green', draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1, 'the re-review armer must still see the head');
    });

    test('trackedChecks green drops a tracked-red head', function () {
        srcMod = load({ github_list_prs: function () { return prList([10]); } }, null, {
            10: { number: 10, state: 'OPEN', checkConclusion: 'red', trackedVerdict: 'red',
                  mergeState: 'UNSTABLE', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', trackedChecks: 'green', draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 0);
    });

    test('no trackedVerdict field → degrades to the effective verdict (stub/back-compat semantics)', function () {
        srcMod = load({
            github_list_prs: function () { return prList([10, 11]); }
        }, null, {
            10: { number: 10, state: 'OPEN', checkConclusion: 'green', mergeState: 'CLEAN', mergeable: true },
            11: { number: 11, state: 'OPEN', checkConclusion: 'red', mergeState: 'UNSTABLE', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', trackedChecks: 'green', draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1, 'only the green item matches');
        assert.equal(items[0].key, 'pr-10');
    });

    test('a trackedChecks query fetches prStatus (needsStatus wiring) — the guard resolves', function () {
        // If trackedChecks did NOT trigger the status fetch, item.pr stays
        // null, the guard never resolves, and the rule silently never
        // matches — the gh-807 class of wiring bug.
        srcMod = load({ github_list_prs: function () { return prList([10]); } }, null, {
            10: { number: 10, state: 'OPEN', checkConclusion: 'red', trackedVerdict: 'green',
                  mergeState: 'UNSTABLE', mergeable: true }
        });
        var items = srcMod.query({
            query: { type: 'pr', trackedChecks: 'green', draft: false }
        }, { repoInfo: { owner: 'a', repo: 'b' } });
        assert.equal(items.length, 1);
        assert.ok(items[0].pr, 'item.pr must be populated for the guard');
        assert.equal(items[0].pr.trackedVerdict, 'green');
    });
});

// ── deployed rules — the two re-review armers gate on trackedChecks ─────────

suite('gh-140 — sm_github.json re-review armer gates', function () {
    function rulesById() {
        var cfg = JSON.parse(file_read({ path: 'sm_github.json' }));
        var byId = {};
        ((cfg.params && cfg.params.jobParams && cfg.params.jobParams.rules) || [])
            .forEach(function (r) { byId[r.id] = r; });
        return byId;
    }

    test('review-stale-verdict and review-threads-resolved gate on trackedChecks green', function () {
        var byId = rulesById();
        ['review-stale-verdict', 'review-threads-resolved'].forEach(function (id) {
            var r = byId[id];
            assert.ok(r, id + ' exists');
            assert.deepEqual(r.query.trackedChecks, 'green',
                id + ' gates on the TRACKED-set verdict (gh-140)');
            assert.equal(r.query.checks, undefined,
                id + ' must not keep the effective-verdict gate — an untracked red would freeze it');
            assert.ok((r.description || '').indexOf('gh-140') !== -1, id + ' documents the gh-140 gate');
        });
    });

    test('review-stale-verdict-unchecked keeps reading the EFFECTIVE verdict (none)', function () {
        // Its head shape is "no concluded checks at all" — an untracked
        // commit-status failure reds the effective verdict, and the
        // red-head flow owns the head instead of a re-review. Deliberate.
        var byId = rulesById();
        var r = byId['review-stale-verdict-unchecked'];
        assert.ok(r, 'review-stale-verdict-unchecked exists');
        assert.deepEqual(r.query.checks, 'none');
        assert.equal(r.query.trackedChecks, undefined);
    });

    test('the red-head consumers still read the effective verdict', function () {
        var byId = rulesById();
        var fail = byId['fail-validation'];
        assert.deepEqual(fail.query.checks, 'red', 'fail-validation reacts to the reconciled red');
        var arm = byId['rework-on-red-gate-unlatched'];
        assert.deepEqual(arm.query.checks, ['red'], 'the redHeadGated arm reacts to the reconciled red');
    });
});
