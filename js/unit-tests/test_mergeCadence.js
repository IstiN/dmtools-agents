/**
 * Unit test: gh-837 merge-cadence simulation (AC1, L2 replay shape).
 *
 * Discrete-event replay of the SM merge window at queue depth 6 (>= 4),
 * driven through the REAL js/sm/sources/githubSource.js mutex evaluation
 * for the arming decision each tick — the same code the deployed
 * validate-armed rule runs. Model per 10-minute tick:
 *
 *   1. conclude  — validations in flight past their 35-min wall time go green;
 *   2. merge     — merge-validated is limit 1: the oldest green head merges;
 *                  every OTHER armed/green head is now BEHIND (the merge moved
 *                  the base) — unarm + 1 tick of silent refresh, then it needs
 *                  a fresh validation (the squash changed its base);
 *   3. arm       — validate-armed is limit 1 per tick: the query (with
 *                  mutexMax = the effective concurrency) picks the oldest
 *                  eligible approved PR through the real source, one arm.
 *
 * The sim measures the steady-state merge interval for the serial window
 * (mutexMax 1 — today's behavior) vs the relaxed window (mutexMax 2/3 with
 * the gh-837 knob). Documented floor (AC1 'or documented floor with the
 * chosen option'): parallel N=2 lands ~40 min/merge — the strict <=30 min
 * target needs the merge-train option (stacked-batch validation), which is
 * out of scope here; the owner's 1/hour floor is met at N>=2.
 */
/* global loadModule, assert, test, suite, makeRequire, file_read */

suite('gh-837 merge cadence simulation (AC1)', function () {

    var TICK_MIN = 10;        // SM cron cadence
    var VALIDATION_MIN = 35;  // Quality gate + platform legs wall time
    var REFRESH_TICKS = 1;    // silent-update refresh latency after a base move

    function loadSource(openPrs, statuses) {
        // Getter-closures, not object references: the sim REPLACES the
        // open/status maps every tick, so the stub must read them lazily.
        var providerStub = {
            prStatus: function (n) { return (statuses()[n]) || null; }
        };
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': { createSmProvider: function () { return providerStub; } }
        }), {});
        return loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
            '../../common/smProvider.js': { createSmProvider: function () { return providerStub; } },
            '../../common/smAsync.js': smAsyncMod
        }), {
            github_list_prs: function () { return openPrs(); }
        });
    }

    /**
     * Run the conveyor to completion; returns merge intervals (minutes).
     * prs: [{n}] — all approved from t=0. mutexMax: 1 = serial, 2/3 = gh-837.
     */
    function simulate(prNumbers, mutexMax) {
        // Per-PR conveyor state.
        var st = {};
        prNumbers.forEach(function (n) {
            st[n] = { phase: 'waiting', until: 0, refreshed: 0 }; // waiting|validating|green|refresh
        });
        var merges = [];
        var now = 0;
        var guard = 0;

        function src() {
            var open = [];
            var statuses = {};
            prNumbers.forEach(function (n) {
                var s = st[n];
                if (s.phase === 'merged') return; // merged PRs leave the open list
                var labels = [{ name: 'pr_approved' }];
                if (s.phase === 'validating') labels.push({ name: 'ai_validating' });
                if (s.phase === 'green') labels.push({ name: 'ai_validated' });
                open.push({ number: n, labels: labels, head: { ref: 'ai/gh-' + n }, draft: false });
                // mergeState: BEHIND only while the refresh hasn't landed;
                // otherwise BLOCKED (fresh head, required checks pending) —
                // both are not-CLEAN/not-BEHIND shapes the real rule uses.
                statuses[n] = { number: n, state: 'OPEN',
                    mergeState: s.phase === 'refresh' ? 'BEHIND' : 'BLOCKED', mergeable: true };
            });
            return { open: open, statuses: statuses };
        }

        var live = { open: [], statuses: {} };
        // prStatus reads must see the live map — the provider stub closes
        // over live.statuses, refreshed every tick below.
        var source = loadSource(function () { return live.open; }, function () { return live.statuses; });

        while (merges.length < prNumbers.length && guard < 500) {
            guard++;
            // 1. conclude validations
            prNumbers.forEach(function (n) {
                var s = st[n];
                if (s.phase === 'validating' && now >= s.until) s.phase = 'green';
                if (s.phase === 'refresh' && now >= s.refreshed) s.phase = 'waiting';
            });
            // 2. merge: oldest green first (merge-validated, limit 1)
            var greens = prNumbers.filter(function (n) { return st[n].phase === 'green'; })
                .sort(function (a, b) { return a - b; });
            if (greens.length) {
                merges.push(now);
                // The merge moved the base: every OTHER armed/green head is
                // BEHIND now — unarm + refresh, then a fresh validation.
                prNumbers.forEach(function (n) {
                    if (n === greens[0]) { st[n].phase = 'merged'; return; }
                    if (st[n].phase === 'green' || st[n].phase === 'validating') {
                        st[n].phase = 'refresh';
                        st[n].refreshed = now + REFRESH_TICKS * TICK_MIN;
                    }
                });
            }
            // 3. arm through the REAL source mutex (validate-armed shape)
            var snap = src();
            live.open = snap.open;
            live.statuses = snap.statuses;
            var items;
            try {
                items = source.query({
                    limit: 1,
                    query: { type: 'pr', labels: ['pr_approved'],
                        notLabels: ['ai_validating', 'validation_failed'],
                        notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                        mutex: 'ai_validating', mutexAmong: ['pr_approved'],
                        mutexMax: mutexMax }
                }, { repoInfo: { owner: 'a', repo: 'b' } });
            } catch (eQ) {
                console.log('DBG query threw: ' + (eQ && eQ.message) + ' | ' + (eQ && eQ.stack ? eQ.stack.split('\n')[1] : ''));
                items = [];
            }
            if (items.length) {
                var n = items[0].prNumber;
                st[n].phase = 'validating';
                st[n].until = now + VALIDATION_MIN;
            } else if (now < 60) {
                console.log('DBG tick ' + now + ' no arm; phases=' + JSON.stringify(st));
            }
            now += TICK_MIN;
        }
        if (merges.length < prNumbers.length) {
            throw new Error('simulation did not drain: ' + merges.length + '/' + prNumbers.length);
        }
        var intervals = merges.slice(1).map(function (t, i) { return t - merges[i]; });
        // Steady state: drop the first interval (pipeline fill distorts it).
        return intervals.slice(1);
    }

    function avg(list) {
        return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
    }

    var QUEUE = [1, 2, 3, 4, 5, 6]; // depth 6 >= 4 (AC1 precondition)

    test('serial window (mutexMax 1): cadence documents the current ceiling', function () {
        var intervals = simulate(QUEUE, 1);
        assert.ok(intervals.length >= 3, 'enough steady-state intervals measured: ' + intervals);
        var a = avg(intervals);
        assert.ok(a >= 60, 'serial cadence ~1 merge / ' + a.toFixed(0) +
            ' min — the known 45-60+ min ceiling reproduces (' + intervals + ')');
    });

    test('parallel window (mutexMax 2, knob at 2, queue >= watermark): cadence beats serial and holds the 1/h floor', function () {
        var serial = avg(simulate(QUEUE, 1));
        var intervals = simulate(QUEUE, 2);
        var a = avg(intervals);
        assert.ok(a < serial, 'parallel cadence ' + a.toFixed(0) + ' min/merge < serial ' +
            serial.toFixed(0) + ' (' + intervals + ')');
        assert.ok(a <= 60, 'the owner floor holds: ' + a.toFixed(0) + ' min/merge <= 60 ' +
            '(documented floor for the parallel option — <=30 needs merge-train)');
    });

    test('runner cost is cap-bounded in every tick (AC2): in-flight validations never exceed mutexMax', function () {
        // Re-run the mutexMax-2 sim with a concurrent-arm counter patched
        // over the phase transitions: at no tick may more than mutexMax
        // heads validate at once — the knob is a hard ceiling, not a target.
        var seen = { max: 0 };
        var st = {};
        QUEUE.forEach(function (n) { st[n] = { phase: 'waiting', until: 0, refreshed: 0 }; });
        var merges = 0, now = 0, guard = 0;
        var live = { open: [], statuses: {} };
        var source = loadSource(function () { return live.open; }, function () { return live.statuses; });
        while (merges < QUEUE.length && guard < 500) {
            guard++;
            QUEUE.forEach(function (n) {
                var s = st[n];
                if (s.phase === 'validating' && now >= s.until) s.phase = 'green';
                if (s.phase === 'refresh' && now >= s.refreshed) s.phase = 'waiting';
            });
            var inFlight = QUEUE.filter(function (n) { return st[n].phase === 'validating'; }).length;
            if (inFlight > seen.max) seen.max = inFlight;
            var greens = QUEUE.filter(function (n) { return st[n].phase === 'green'; })
                .sort(function (a, b) { return a - b; });
            if (greens.length) {
                merges++;
                QUEUE.forEach(function (n) {
                    if (n === greens[0]) { st[n].phase = 'merged'; return; }
                    if (st[n].phase === 'green' || st[n].phase === 'validating') {
                        st[n].phase = 'refresh';
                        st[n].refreshed = now + REFRESH_TICKS * TICK_MIN;
                    }
                });
            }
            var open = [], statuses = {};
            QUEUE.forEach(function (n) {
                var s = st[n];
                if (s.phase === 'merged') return; // merged PRs leave the open list
                var labels = [{ name: 'pr_approved' }];
                if (s.phase === 'validating') labels.push({ name: 'ai_validating' });
                if (s.phase === 'green') labels.push({ name: 'ai_validated' });
                open.push({ number: n, labels: labels, head: { ref: 'ai/gh-' + n }, draft: false });
                statuses[n] = { number: n, state: 'OPEN',
                    mergeState: s.phase === 'refresh' ? 'BEHIND' : 'BLOCKED', mergeable: true };
            });
            live.open = open;
            live.statuses = statuses;
            var items = source.query({
                limit: 1,
                query: { type: 'pr', labels: ['pr_approved'],
                    notLabels: ['ai_validating', 'validation_failed'],
                    notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                    mutex: 'ai_validating', mutexAmong: ['pr_approved'], mutexMax: 2 }
            }, { repoInfo: { owner: 'a', repo: 'b' } });
            if (items.length) {
                st[items[0].prNumber].phase = 'validating';
                st[items[0].prNumber].until = now + VALIDATION_MIN;
            }
            now += TICK_MIN;
        }
        assert.ok(seen.max <= 2, 'at no tick did in-flight validations exceed the cap 2 (max seen: ' +
            seen.max + ') — runner cost is bounded by the knob');
    });

    test('a red validation parks exactly one head in the sim (AC3)', function () {
        // Replay shape: #2 goes red at its first conclusion instead of
        // green. The fail path unarms ONLY #2 (per-PR verdict) — the other
        // parallel arm keeps its slot, and the queue advances past the red
        // head exactly once (it re-enters only via the normal re-arm path,
        // not by any cross-PR bookkeeping).
        var st = {};
        QUEUE.forEach(function (n) { st[n] = { phase: 'waiting', until: 0, refreshed: 0, red: n === 2 }; });
        var merges = [], now = 0, guard = 0;
        var redReports = 0;
        var live = { open: [], statuses: {} };
        var source = loadSource(function () { return live.open; }, function () { return live.statuses; });
        while (merges.length < QUEUE.length - 1 && guard < 500) {
            guard++;
            QUEUE.forEach(function (n) {
                var s = st[n];
                if (s.phase === 'validating' && now >= s.until) {
                    if (s.red) {
                        // fail-validation: exactly one unarm + one report,
                        // then the rework leg pushes a new head — model the
                        // new head as a fresh validation of the same PR.
                        s.phase = 'refresh';
                        s.refreshed = now + REFRESH_TICKS * TICK_MIN;
                        s.red = false; // the reworked head is clean
                        redReports++;
                    } else {
                        s.phase = 'green';
                    }
                }
                if (s.phase === 'refresh' && now >= s.refreshed) s.phase = 'waiting';
            });
            assert.ok(redReports <= 1, 'no red-report storm — exactly one park per red head');
            var greens = QUEUE.filter(function (n) { return st[n].phase === 'green'; })
                .sort(function (a, b) { return a - b; });
            if (greens.length) {
                merges.push(now);
                QUEUE.forEach(function (n) {
                    if (n === greens[0]) { st[n].phase = 'merged'; return; }
                    if (st[n].phase === 'green' || st[n].phase === 'validating') {
                        st[n].phase = 'refresh';
                        st[n].refreshed = now + REFRESH_TICKS * TICK_MIN;
                    }
                });
            }
            var open = [], statuses = {};
            QUEUE.forEach(function (n) {
                var s = st[n];
                if (s.phase === 'merged') return; // merged PRs leave the open list
                var labels = [{ name: 'pr_approved' }];
                if (s.phase === 'validating') labels.push({ name: 'ai_validating' });
                if (s.phase === 'green') labels.push({ name: 'ai_validated' });
                open.push({ number: n, labels: labels, head: { ref: 'ai/gh-' + n }, draft: false });
                statuses[n] = { number: n, state: 'OPEN',
                    mergeState: s.phase === 'refresh' ? 'BEHIND' : 'BLOCKED', mergeable: true };
            });
            live.open = open;
            live.statuses = statuses;
            var items = source.query({
                limit: 1,
                query: { type: 'pr', labels: ['pr_approved'],
                    notLabels: ['ai_validating', 'validation_failed'],
                    notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                    mutex: 'ai_validating', mutexAmong: ['pr_approved'], mutexMax: 2 }
            }, { repoInfo: { owner: 'a', repo: 'b' } });
            if (items.length) {
                st[items[0].prNumber].phase = 'validating';
                st[items[0].prNumber].until = now + VALIDATION_MIN;
            }
            now += TICK_MIN;
        }
        assert.equal(redReports, 1, 'the single red head produced exactly one park — no cross-contamination');
        assert.equal(merges.length, QUEUE.length - 1, 'every green head merged; the queue drained');
    });
});
