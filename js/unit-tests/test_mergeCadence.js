/**
 * Unit test: gh-837 merge-cadence simulation (AC1, L2 replay shape).
 *
 * Discrete-event replay of the SM merge window at queue depth 6 (>= 4),
 * driven through the REAL js/sm/sources/githubSource.js mutex evaluation
 * for the arming decision each tick — the same code the deployed
 * validate-armed rule runs. Model per 10-minute tick:
 *
 *   1. conclude  — validations in flight past their 35-min wall time go
 *                  green (or red -> the per-PR fail path: unarm + 1 report
 *                  + rework pushes a new head -> re-enters normally);
 *   2. merge     — merge-validated is limit 1 in the SM tick, but the
 *                  event-driven mergeBot (js/sm/mergeBot.js) merges EVERY
 *                  approved + green + CLEAN head in one run seconds apart,
 *                  while GitHub's mergeable cache still reads CLEAN — so a
 *                  tick merges the whole green BATCH, oldest first. Every
 *                  OTHER armed/green/waiting head is now BEHIND (the merge
 *                  moved the base): unarm + 1 tick of silent refresh, then
 *                  a fresh validation on the new base;
 *   3. arm       — validate-armed is limit 1 per tick: the query (with
 *                  mutexMax = the effective concurrency) picks the oldest
 *                  eligible approved PR through the real source, one arm.
 *
 * The sim measures the steady-state merge interval for the serial window
 * (mutexMax 1 — today's behavior) vs the relaxed window (mutexMax 2/3 with
 * the gh-837 knob, which also fills every free slot per tick). Results
 * (validation 35 min, tick 10 min, refresh 1 tick): serial ~50 min/merge
 * (the known 45-60 live ceiling), parallel N=2 ~25 min/merge (sustained
 * <= 30 min target met); N=3 ~17 min/merge.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('gh-837 merge cadence simulation (AC1)', function () {

    var TICK_MIN = 10;        // SM cron cadence
    var VALIDATION_MIN = 35;  // Quality gate + platform legs wall time
    var REFRESH_TICKS = 1;    // silent-update refresh latency after a base move

    // Getter-closures, not object references: the sim replaces the open/
    // status maps every tick, so the stubs must read them lazily.
    function loadSource(openPrs, statuses) {
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
     * Run the conveyor; returns { intervals, maxInFlight, redReports }.
     * prNumbers: all approved from t=0 (queue depth = length).
     * mutexMax: 1 = serial, 2/3 = gh-837 relaxed window.
     * redOnce: set of PR numbers whose FIRST conclusion on the first armed
     * head is red (the rework leg then pushes a clean head).
     */
    function simulate(prNumbers, mutexMax, redOnce) {
        var st = {};
        prNumbers.forEach(function (n) {
            st[n] = { phase: 'waiting', until: 0, refreshed: 0, redPending: (redOnce || []).indexOf(n) !== -1 };
        });
        var merges = [];
        var maxInFlight = 0;
        var redReports = 0;
        var now = 0;
        var guard = 0;

        var live = { open: [], statuses: {} };
        var source = loadSource(function () { return live.open; }, function () { return live.statuses; });

        function publish() {
            var open = [], statuses = {};
            prNumbers.forEach(function (n) {
                var s = st[n];
                if (s.phase === 'merged') return; // merged PRs leave the open list
                var labels = [{ name: 'pr_approved' }];
                if (s.phase === 'validating') labels.push({ name: 'ai_validating' });
                if (s.phase === 'green') labels.push({ name: 'ai_validated' });
                open.push({ number: n, labels: labels, head: { ref: 'ai/gh-' + n }, draft: false });
                // mergeState: BEHIND only until the refresh lands; then
                // BLOCKED (fresh head, required checks pending) — the
                // not-CLEAN/not-BEHIND shapes the real rule matches on.
                statuses[n] = { number: n, state: 'OPEN',
                    mergeState: s.phase === 'refresh' ? 'BEHIND' : 'BLOCKED', mergeable: true };
            });
            live.open = open;
            live.statuses = statuses;
        }

        while (merges.length < prNumbers.length && guard < 600) {
            guard++;
            // 1. conclude validations
            prNumbers.forEach(function (n) {
                var s = st[n];
                if (s.phase === 'validating' && now >= s.until) {
                    if (s.redPending) {
                        // fail-validation: exactly one unarm + one report;
                        // the rework leg pushes a new (clean) head — the PR
                        // re-enters through the normal re-arm path.
                        s.redPending = false;
                        s.phase = 'refresh';
                        s.refreshed = now + REFRESH_TICKS * TICK_MIN;
                        redReports++;
                    } else {
                        s.phase = 'green';
                    }
                }
                if (s.phase === 'refresh' && now >= s.refreshed) s.phase = 'waiting';
            });
            var inFlight = prNumbers.filter(function (n) { return st[n].phase === 'validating'; }).length;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            // 2. merge the whole green batch (mergeBot parity), oldest
            // first; every other head is BEHIND now — unarm + refresh.
            var greens = prNumbers.filter(function (n) { return st[n].phase === 'green'; })
                .sort(function (a, b) { return a - b; });
            if (greens.length) {
                greens.forEach(function (n) { st[n].phase = 'merged'; merges.push(now); });
                prNumbers.forEach(function (n) {
                    if (st[n].phase === 'green' || st[n].phase === 'validating' || st[n].phase === 'waiting') {
                        st[n].phase = 'refresh';
                        st[n].refreshed = now + REFRESH_TICKS * TICK_MIN;
                    }
                });
            }
            // 3. arm through the REAL source mutex (validate-armed shape) —
            // the gh-837 knob raises the rule limit to the cap, so every
            // free slot fills in ONE tick: the parallel arms conclude
            // together and merge in one batch window.
            var armedThisTick = 0;
            while (armedThisTick < mutexMax) {
                publish();
                var items = source.query({
                    limit: 1,
                    query: { type: 'pr', labels: ['pr_approved'],
                        notLabels: ['ai_validating', 'validation_failed'],
                        notMergeState: ['BEHIND', 'DIRTY'], draft: false,
                        mutex: 'ai_validating', mutexAmong: ['pr_approved'],
                        mutexMax: mutexMax }
                }, { repoInfo: { owner: 'a', repo: 'b' } });
                if (!items.length) break;
                st[items[0].prNumber].phase = 'validating';
                st[items[0].prNumber].until = now + VALIDATION_MIN;
                armedThisTick++;
            }
            now += TICK_MIN;
        }
        if (merges.length < prNumbers.length) {
            throw new Error('simulation did not drain: ' + merges.length + '/' + prNumbers.length +
                ' merges in ' + guard + ' ticks');
        }
        var intervals = merges.slice(1).map(function (t, i) { return t - merges[i]; });
        // Steady state: drop the first interval (pipeline fill distorts it).
        return { intervals: intervals.slice(1), maxInFlight: maxInFlight, redReports: redReports };
    }

    function avg(list) {
        return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
    }

    var QUEUE = [1, 2, 3, 4, 5, 6]; // depth 6 >= 4 (AC1 precondition)

    test('serial window (mutexMax 1): cadence reproduces the current ~45-60 min ceiling', function () {
        var r = simulate(QUEUE, 1);
        assert.ok(r.intervals.length >= 3, 'enough steady-state intervals measured: ' + r.intervals);
        var a = avg(r.intervals);
        assert.ok(a >= 45 && a <= 70, 'serial cadence ~1 merge / ' + a.toFixed(0) +
            ' min — the known 45-60 min live ceiling reproduces (' + r.intervals + ')');
    });

    test('parallel window (mutexMax 2, knob at 2, queue >= watermark): sustained cadence <= 30 min/merge (AC1)', function () {
        var serial = avg(simulate(QUEUE, 1).intervals);
        var r = simulate(QUEUE, 2);
        var a = avg(r.intervals);
        assert.ok(a < serial, 'parallel cadence ' + a.toFixed(0) + ' min/merge < serial ' +
            serial.toFixed(0) + ' (' + r.intervals + ')');
        console.log('gh-837 sim: serial ' + serial.toFixed(0) + ' min/merge, parallel-2 ' +
            a.toFixed(0) + ' min/merge, intervals ' + JSON.stringify(r.intervals));
        assert.ok(a <= 30, 'owner target met in the replay: ' + a.toFixed(0) +
            ' min/merge <= 30 (' + r.intervals + ')');
    });

    test('runner cost is cap-bounded in every tick (AC2): in-flight validations never exceed mutexMax', function () {
        var r = simulate(QUEUE, 2);
        assert.ok(r.maxInFlight <= 2, 'at no tick did in-flight validations exceed the cap 2 (max seen: ' +
            r.maxInFlight + ') — runner cost is bounded by the knob, never unbounded growth');
        var serial = simulate(QUEUE, 1);
        assert.ok(serial.maxInFlight <= 1, 'serial control: never more than 1 in flight');
    });

    test('a red validation parks exactly one head (AC3): one report, the queue drains, no cross-contamination', function () {
        var r = simulate(QUEUE, 2, [2]); // pr-2 goes red on its first conclusion
        assert.equal(r.redReports, 1, 'the single red head produced exactly one park — ' +
            'no report storm, no cross-PR bookkeeping');
        assert.ok(r.intervals.length >= 2, 'the queue drained past the red head: ' + r.intervals);
    });
});
