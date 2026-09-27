/**
 * Unit tests for the 'Run agent' watchdog wiring in
 * .github/workflows/factory-teammate.yml.
 *
 * RCA (owner 2026-09-27, live on epam/dmtools-dart PR #266): three
 * consecutive PR-anchored teammate legs (runs 36327525813 / 36333172145 /
 * 36340752735) went ZOMBIE — guard green, 'Run agent' job in_progress for
 * 60-90 min, the fa session brain-dead (its trace silent from the first
 * minute; only dmtools timerAutoCommitAndSave ticks kept landing in
 * run-output.txt), zero pushes, manual cancel each time. A healthy fa
 * session streams every turn/tool call into FA_LOG_FILE, so a quiet trace
 * mid-run is unambiguous. The watchdog fails the leg fast and writes a
 * diagnosable marker into run-output instead of silence.
 *
 * Uses: file_read(), suite(), test(), assert
 */

suite('factory-teammate.yml — Run agent watchdog (zombie-leg RCA 2026-09-27)', function () {

    var wf = file_read({ path: '.github/workflows/factory-teammate.yml' });

    test('the fa-provider Run agent step has a step-level timeout below the job cap', function () {
        var step = wf.indexOf('Run agent (fa provider via runner env overrides)');
        assert.ok(step !== -1, 'fa-provider step present');
        var rest = wf.slice(step);
        var m = rest.match(/timeout-minutes:\s*(\d+)/);
        assert.ok(m, 'step has its own timeout-minutes');
        assert.ok(parseInt(m[1], 10) < 120 && parseInt(m[1], 10) >= 60,
            'step timeout must sit between a real-fix session (40-80 min, gh-623) and the job cap (120): got ' + m[1]);
    });

    test('a fa-trace staleness watchdog runs alongside dmtools and kills it on staleness', function () {
        assert.ok(wf.indexOf('FA_TRACE_STALE_MINUTES:-10}') !== -1 ||
            wf.indexOf('FA_TRACE_STALE_MINUTES:-10') !== -1,
            'watchdog polls FA_LOG_FILE mtime against a stale limit (default 10 min)');
        assert.ok(wf.indexOf('FA-TRACE-STALE-WATCHDOG') !== -1,
            'marker block lands in run-output so post-actions/artifacts carry the diagnosis');
        assert.ok(wf.indexOf('tee -a "${RUN_OUTPUT}"') !== -1,
            'marker is APPENDED to run-output (tee without -a would truncate it)');
        assert.ok(wf.indexOf('pkill -f "dmtools run"') !== -1,
            'watchdog kills dmtools — its death non-zeros the step so the red path re-queues');
        assert.ok(wf.indexOf('pkill -f "fa --session"') !== -1,
            'orphaned fa provider child is killed too');
        assert.ok(wf.indexOf("trap 'kill \"${WATCHDOG_PID}\"") !== -1,
            'watchdog is reaped when the step ends normally');
        // The watchdog must start AFTER FA_LOG_FILE exists (the step creates
        // and touches it before the dmtools invocation).
        var watchdog = wf.indexOf('WATCHDOG_PID=$!');
        var dmtools = wf.indexOf('dmtools run "${RUNNER}"');
        var touch = wf.lastIndexOf('touch "${FA_LOG_FILE}"', watchdog);
        assert.ok(watchdog !== -1 && dmtools !== -1 && watchdog < dmtools,
            'watchdog starts before dmtools and after the log file exists');
    });
});
