/**
 * Unit tests for gh-1503 — SP-based adaptive mode selection: the in-leg
 * story-point estimate replaces the gh-1437 pre-leg signal routing.
 *
 * Layers:
 *  UT  — js/common/developmentModeAdaptiveSp.js pure table: threshold
 *        resolution (absent → default silently, invalid → warn + default),
 *        decision-record parsing (strict on sp/mode, fail-safe null),
 *        appendix text pins (threshold interpolation, escalation hand-off,
 *        record contract), materialization write-through + inactive zero-IO,
 *        canonical conditional-entry shape.
 *  IT  — (T2) preCli wiring: adaptive materializes the SP appendix, stale
 *        state cleanup, plan appendix co-materialized for escalation reads.
 *  IT  — (T4) agent config wiring: story/bug dev configs carry the SP
 *        conditional entry + the knob value.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function captureConsole(fn) {
    var captured = { logs: [], warns: [], errors: [] };
    var origLog = console.log;
    var origWarn = console.warn;
    var origErr = console.error;
    console.log = function (msg) { captured.logs.push(String(msg)); };
    console.warn = function (msg) { captured.warns.push(String(msg)); };
    console.error = function (msg) { captured.errors.push(String(msg)); };
    try {
        fn();
    } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origErr;
    }
    return captured;
}

var developmentMode = loadModule('js/common/developmentMode.js');
var developmentModePlan = loadModule('js/common/developmentModePlan.js',
    makeRequire({ './developmentMode.js': developmentMode }));
var developmentModeAdaptive = loadModule('js/common/developmentModeAdaptive.js',
    makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': developmentModePlan }));
var developmentModeAdaptiveSp = loadModule('js/common/developmentModeAdaptiveSp.js',
    makeRequire({ './developmentModeAdaptive.js': developmentModeAdaptive }));

// Filesystem recording mocks — every test asserts on the recorded calls, so a
// real file can never be touched (network-guard discipline for file IO).
function fsRecorder(files) {
    var calls = { reads: [], writes: [] };
    var read = function (opts) {
        var p = opts && (opts.path || opts);
        calls.reads.push(String(p));
        if (files && files[String(p)] !== undefined) return files[String(p)];
        return null;
    };
    var write = function (opts) {
        calls.writes.push({ path: String(opts && opts.path), content: String(opts && opts.content) });
        return true;
    };
    return { calls: calls, file_read: read, file_write: write };
}

function adaptiveCustomParams(threshold) {
    var cp = { developmentMode: 'adaptive' };
    if (threshold !== undefined) {
        cp.developmentModeConfig = { adaptive: { planThresholdSp: threshold } };
    }
    return cp;
}

// ── UT: threshold resolution ─────────────────────────────────────────────────

suite('gh-1503 UT — SP threshold resolution', function () {
    test('absent key → default silently (absence is the steady state)', function () {
        var r = developmentModeAdaptiveSp.resolveSpThreshold({ developmentMode: 'adaptive' });
        assert.equal(r.threshold, 3, 'default threshold is 3 (paired-run crossover)');
        assert.equal(r.warning, null, 'absence warns nothing');
        assert.equal(developmentModeAdaptiveSp.resolveSpThreshold(null).warning, null, 'null customParams → silent default');
        assert.equal(developmentModeAdaptiveSp.resolveSpThreshold({}).threshold, 3, 'empty customParams → default');
        var noKey = developmentModeAdaptiveSp.resolveSpThreshold({
            developmentMode: 'adaptive',
            developmentModeConfig: { adaptive: {} }
        });
        assert.equal(noKey.threshold, 3, 'adaptive block without the key → default');
        assert.equal(noKey.warning, null, 'adaptive block without the key → silent');
    });

    test('valid integers pass through, including the boundaries', function () {
        assert.equal(developmentModeAdaptiveSp.resolveSpThreshold(adaptiveCustomParams(5)).threshold, 5, 'valid value honored');
        assert.equal(developmentModeAdaptiveSp.resolveSpThreshold(adaptiveCustomParams(5)).warning, null, 'valid value warns nothing');
        assert.equal(developmentModeAdaptiveSp.resolveSpThreshold(adaptiveCustomParams(1)).threshold, 1, 'min boundary honored');
        assert.equal(developmentModeAdaptiveSp.resolveSpThreshold(adaptiveCustomParams(13)).threshold, 13, 'max boundary honored');
    });

    test('invalid values → default + one warning naming the value', function () {
        var cases = [null, '5', 3.5, 0, -2, 14, true];
        cases.forEach(function (raw) {
            var r = developmentModeAdaptiveSp.resolveSpThreshold(adaptiveCustomParams(raw));
            assert.equal(r.threshold, 3, 'invalid ' + JSON.stringify(raw) + ' → default');
            assert.ok(r.warning && r.warning.indexOf('planThresholdSp') !== -1,
                'invalid ' + JSON.stringify(raw) + ' → warning names the key');
        });
    });

    test('a wrong-typed adaptive config block reads as absent (permissive)', function () {
        var r = developmentModeAdaptiveSp.resolveSpThreshold({
            developmentMode: 'adaptive',
            developmentModeConfig: { adaptive: 'oops' }
        });
        assert.equal(r.threshold, 3, 'garbled block → default');
        assert.equal(r.warning, null, 'garbled block is read as absent, not as an offense');
    });
});

// ── UT: decision-record parsing ──────────────────────────────────────────────

suite('gh-1503 UT — scope-estimate record parsing', function () {
    var full = JSON.stringify({ sp: 5, threshold: 3, mode: 'plan', reason: 'undocumented integration', outcome: 'completed' });

    test('full record parses with every field', function () {
        var r = developmentModeAdaptiveSp.parseScopeEstimateRecord(full);
        assert.equal(r.sp, 5, 'sp');
        assert.equal(r.threshold, 3, 'threshold');
        assert.equal(r.mode, 'plan', 'mode');
        assert.equal(r.reason, 'undocumented integration', 'reason');
        assert.equal(r.outcome, 'completed', 'outcome');
    });

    test('minimal record (sp + mode only) parses; optional fields stay absent', function () {
        var r = developmentModeAdaptiveSp.parseScopeEstimateRecord(JSON.stringify({ sp: 2, mode: 'default' }));
        assert.deepEqual(r, { sp: 2, mode: 'default' }, 'no invented fields');
    });

    test('malformed input → null, never a throw', function () {
        var bad = [
            null,
            '',
            '   ',
            'not json',
            '{"sp": 5, "mode": "plan"',           // truncated
            '[]',                                  // non-object
            '"plan"',                              // non-object
            '{"threshold": 3, "mode": "plan"}',    // sp missing
            '{"sp": "5", "mode": "plan"}',         // sp wrong type
            '{"sp": 0, "mode": "plan"}',           // sp below range
            '{"sp": 14, "mode": "plan"}',          // sp above range
            '{"sp": 5.5, "mode": "plan"}',         // sp not an integer
            '{"sp": 5}',                           // mode missing
            '{"sp": 5, "mode": "PLAN"}',           // case-sensitive modes
            '{"sp": 5, "mode": "adaptive"}'        // mode is the WORKING mode, not the knob value
        ];
        bad.forEach(function (text) {
            assert.equal(developmentModeAdaptiveSp.parseScopeEstimateRecord(text), null,
                'fail-safe null for: ' + JSON.stringify(text));
        });
    });

    test('unknown extra fields are ignored, not rejected', function () {
        var r = developmentModeAdaptiveSp.parseScopeEstimateRecord(
            JSON.stringify({ sp: 3, mode: 'default', extra: 'future-proof' }));
        assert.ok(r && r.sp === 3, 'forward-compatible parse');
    });
});

// ── UT: appendix text pins ───────────────────────────────────────────────────

suite('gh-1503 UT — SP appendix text', function () {
    var text = developmentModeAdaptiveSp.spAppendixText(3);

    test('interpolates the threshold into the decision rule', function () {
        assert.ok(text.indexOf('(threshold: 3 SP)') !== -1, 'threshold appears in the decide header');
        assert.ok(developmentModeAdaptiveSp.spAppendixText(5).indexOf('(threshold: 5 SP)') !== -1,
            'a different threshold renders differently');
    });

    test('carries the record contract', function () {
        assert.ok(text.indexOf('outputs/<KEY>/scope_estimate.json') !== -1, 'record path pinned');
        assert.ok(text.indexOf('"mode": "plan" | "default"') !== -1, 'mode vocabulary pinned');
        assert.ok(text.indexOf('"outcome"') !== -1, 'completion outcome pinned');
    });

    test('escalation hands off to the plan appendix file — never redefines it', function () {
        assert.ok(text.indexOf('.dmtools/development-mode-plan-appendix.md') !== -1, 'plan appendix referenced');
        assert.ok(text.indexOf('Never demote') !== -1, 'anti-demotion rule present');
        assert.ok(text.indexOf('outputs/<KEY>/plan.md') === -1, 'does not redefine the plan contract paths');
    });
});

// ── UT: materialization ──────────────────────────────────────────────────────

suite('gh-1503 UT — SP appendix materialization', function () {
    test('adaptive leg → writes the appendix, logs the threshold, zero warnings', function () {
        var fs = fsRecorder();
        var r = developmentModeAdaptiveSp.materializeSpAppendix(adaptiveCustomParams(), { file_write: fs.file_write });
        assert.equal(r.active, true, 'active for adaptive');
        assert.equal(r.ok, true, 'write succeeds');
        assert.equal(r.path, '.dmtools/development-mode-sp-appendix.md', 'runtime path');
        assert.equal(fs.calls.writes.length, 1, 'exactly one write');
        assert.ok(fs.calls.writes[0].content.indexOf('(threshold: 3 SP)') !== -1, 'default threshold rendered');
        assert.ok(r.logLines.length === 1 && r.logLines[0].indexOf('threshold 3') !== -1, 'log line names the threshold');
        assert.deepEqual(r.warnings, [], 'silent for a valid/absent config');
    });

    test('invalid threshold → warning flushed + the default text written', function () {
        var fs = fsRecorder();
        var r = developmentModeAdaptiveSp.materializeSpAppendix(adaptiveCustomParams('9'), { file_write: fs.file_write });
        assert.equal(r.ok, true, 'still materializes');
        assert.equal(r.warnings.length, 1, 'one warning');
        assert.ok(fs.calls.writes[0].content.indexOf('(threshold: 3 SP)') !== -1, 'default threshold in the file');
    });

    test('non-adaptive modes → inactive, zero IO, zero output', function () {
        ['default', 'plan', undefined].forEach(function (mode) {
            var fs = fsRecorder();
            var captured = captureConsole(function () {
                var r = developmentModeAdaptiveSp.materializeSpAppendix(
                    mode === undefined ? {} : { developmentMode: mode }, { file_write: fs.file_write });
                assert.equal(r.active, false, mode + ' → inactive');
                assert.equal(r.ok, false, 'inactive reads as "nothing materialized"');
                assert.deepEqual(fs.calls.writes, [], mode + ' → zero writes');
            });
            assert.deepEqual(captured.logs, [], mode + ' → zero log lines');
            assert.deepEqual(captured.warns, [], mode + ' → zero warnings');
        });
    });

    test('write failure → ok:false + an error naming the path (never throws)', function () {
        var throwingIo = { file_write: function () { throw new Error('disk full'); } };
        var r = developmentModeAdaptiveSp.materializeSpAppendix(adaptiveCustomParams(), throwingIo);
        assert.equal(r.ok, false, 'write failure surfaces');
        assert.equal(r.active, true, 'adaptive is active even when the write failed');
        assert.ok(r.error && r.error.indexOf('development-mode-sp-appendix.md') !== -1, 'error names the path');
    });
});

// ── UT: canonical cliPrompts entry ───────────────────────────────────────────

suite('gh-1503 UT — SP conditional entry shape', function () {
    test('entry matches the canonical conditional shape', function () {
        var entry = developmentModeAdaptiveSp.spAppendixCliEntry();
        assert.deepEqual(entry, {
            id: 'developmentModeAdaptiveSp',
            prompt: './.dmtools/development-mode-sp-appendix.md',
            condition: 'agents/js/conditions/isDevelopmentModeAdaptiveSp.js'
        });
    });
});
