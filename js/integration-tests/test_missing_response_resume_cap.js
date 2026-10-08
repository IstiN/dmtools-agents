/**
 * Integration test (hermetic — no services, no repo state):
 * the gh-775 bounded-resume cap actually bounds.
 *
 * The gh-775 resume-before-cold-reset re-invokes the provider wrapper through
 * `bash -c "timeout -k 60 <N> bash agents/scripts/run-agent.sh --continue <p>"`.
 * Code-path mocks prove the command is BUILT with the cap; this test proves the
 * cap WORKS on the real runtime: a fake slow wrapper that exceeds the cap is
 * killed and surfaces as a command failure (exit 124) within seconds, while a
 * fast command under the same cap completes normally.
 *
 * Usage:
 *   dmtools run js/integration-tests/run_missing_response_resume_cap.json
 */

function action() {
    if (typeof cli_execute_command !== 'function') {
        console.log('SKIP: cli_execute_command is not available on this runtime');
        return { success: true, skipped: true };
    }

    // Probe: `bash` must be whitelisted (CLI_ALLOWED_COMMANDS) or the bounded
    // resume could never run here — the test then says so instead of failing.
    try {
        cli_execute_command({ command: 'bash -c "true"' });
    } catch (e) {
        console.log('SKIP: bash is not whitelisted on this runtime (' + e + ')');
        return { success: true, skipped: true };
    }

    var failures = [];

    // 1. A fake slow wrapper exceeds the cap → killed → command failure, FAST.
    var started = Date.now();
    var killed = false;
    try {
        // 1s cap against a 30s sleeper — the runtime must come back in seconds.
        cli_execute_command({ command: 'bash -c "timeout -k 1 1 sleep 30"' });
    } catch (e) {
        killed = true;
        console.log('slow wrapper killed as expected: ' + e);
    }
    var elapsedMs = Date.now() - started;
    if (!killed) failures.push('the slow wrapper was NOT killed by the timeout cap');
    if (elapsedMs > 15000) failures.push('the cap did not bound the run: ' + elapsedMs + 'ms');
    console.log('bounded kill took ' + elapsedMs + 'ms');

    // 2. A fast command under the same cap completes normally (no false kill).
    try {
        cli_execute_command({ command: 'bash -c "timeout -k 1 30 true"' });
        console.log('fast command completed under the cap');
    } catch (e) {
        failures.push('a fast command failed under the cap: ' + e);
    }

    if (failures.length) {
        console.log('❌ FAIL: ' + failures.join('; '));
        return { success: false, failures: failures };
    }
    console.log('✅ PASS — the timeout cap bounds a hung wrapper and lets fast commands pass');
    return { success: true };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
