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
var branchSetupShared = loadModule('js/common/branchSetup.js');
var developmentModeAdaptiveSp = loadModule('js/common/developmentModeAdaptiveSp.js',
    makeRequire({
        './developmentModeAdaptive.js': developmentModeAdaptive
    }));

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

    test('open-ended scale: sp beyond the threshold range still parses (the estimate may exceed 13)', function () {
        var r = developmentModeAdaptiveSp.parseScopeEstimateRecord(JSON.stringify({ sp: 21, mode: 'plan' }));
        assert.ok(r && r.sp === 21, 'sp 21 is a legal estimate');
        var big = developmentModeAdaptiveSp.parseScopeEstimateRecord(JSON.stringify({ sp: 40, mode: 'default' }));
        assert.ok(big && big.sp === 40, 'the scale keeps going above the last named value');
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

    test('scale is open-ended in the agent-facing text', function () {
        assert.contains(text, '21 / ...', 'the scale continues past 13');
        assert.contains(text, 'open-ended', 'no ceiling implied');
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

    test('shadow adaptive leg → inactive, zero IO, the would-act line returned (gh-1437 carry-over)', function () {
        var fs = fsRecorder();
        var r = developmentModeAdaptiveSp.materializeSpAppendix({
            developmentMode: 'adaptive',
            developmentModeConfig: { adaptive: { shadowMode: true } }
        }, { file_write: fs.file_write });
        assert.equal(r.active, false, 'shadow never materializes (acting = changing the prompt)');
        assert.equal(r.ok, false, 'nothing materialized');
        assert.deepEqual(fs.calls.writes, [], 'zero writes in shadow');
        assert.ok(r.logLines.join('\n').indexOf('shadow mode') !== -1, 'the would-act line rides back to the caller');
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

// ── IT: the condition script (self-contained, mirrors isDevelopmentModePlan) ─

function loadSpConditionWith(files) {
    var fs = fsRecorder(files);
    var mod = loadModule('js/conditions/isDevelopmentModeAdaptiveSp.js', null, {
        file_read: fs.file_read,
        file_write: fs.file_write
    });
    return { fs: fs, mod: mod };
}

suite('gh-1503 IT — SP condition script', function () {
    test('path parity: the condition reads exactly the runtime path the module writes', function () {
        var loaded = loadSpConditionWith({});
        assert.equal(loaded.mod.appendixRuntimePath(),
            developmentModeAdaptiveSp.SP_APPENDIX_FILE_PATH,
            'condition and module must agree on the materialization path');
        var entry = developmentModeAdaptiveSp.spAppendixCliEntry();
        assert.equal(entry.prompt.replace(/^\.\//, ''), loaded.mod.appendixRuntimePath(),
            'config prompt path denotes the same file');
    });

    test('adaptive leg + materialized SP appendix → true', function () {
        var files = {};
        files['.dmtools/development-mode-sp-appendix.md'] = 'sp appendix text';
        var loaded = loadSpConditionWith(files);
        assert.equal(loaded.mod.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } }), true,
            'active on an adaptive leg with the appendix in place');
    });

    test('shadowMode → false even with the file in place (second line of defense)', function () {
        var files = {};
        files['.dmtools/development-mode-sp-appendix.md'] = 'sp appendix text';
        var loaded = loadSpConditionWith(files);
        assert.equal(loaded.mod.action({
            jobParams: { customParams: {
                developmentMode: 'adaptive',
                developmentModeConfig: { adaptive: { shadowMode: true } }
            } }
        }), false, 'shadow leg never carries the SP block');
    });

    test('plan / default / missing modes → false without reading anything', function () {
        var loaded = loadSpConditionWith({});
        ['', 'default', 'plan', 'PLAN', 'ADAPTIVE'].forEach(function (mode) {
            var cp = mode === '' ? {} : { developmentMode: mode };
            assert.equal(loaded.mod.action({ jobParams: { customParams: cp } }), false,
                'mode ' + JSON.stringify(mode) + ' → excluded');
        });
        assert.equal(loaded.fs.calls.reads.length, 0, 'non-adaptive modes never touch the filesystem');
    });

    test('adaptive but file missing / unreadable → false (no dangling prompt read)', function () {
        var loaded = loadSpConditionWith({});
        assert.equal(loaded.mod.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } }), false,
            'missing file → excluded');
        var throwing = loadModule('js/conditions/isDevelopmentModeAdaptiveSp.js', null, {
            file_read: function () { throw new Error('io error'); }
        });
        assert.equal(throwing.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } }), false,
            'throwing read → excluded');
    });

    test('teammate and standalone param shapes both resolve customParams', function () {
        var files = {};
        files['.dmtools/development-mode-sp-appendix.md'] = 'text';
        var loaded = loadSpConditionWith(files);
        assert.equal(loaded.mod.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } }), true,
            'teammate shape');
        assert.equal(loaded.mod.action({ customParams: { developmentMode: 'adaptive' } }), true,
            'flat shape');
        assert.equal(loaded.mod.action({}), false, 'no params → excluded');
    });
});
