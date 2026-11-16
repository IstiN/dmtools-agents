/**
 * Unit tests for gh-1503 — SP-based adaptive mode selection: the in-leg
 * story-point estimate replaces the gh-1437 pre-leg signal routing.
 *
 * Layers:
 *  UT  — js/common/developmentModeAdaptive.js pure table: threshold
 *        resolution (absent → default silently, invalid → warn + default),
 *        decision-record parsing (strict on sp/mode, fail-safe null),
 *        appendix text pins (threshold interpolation, escalation hand-off,
 *        record contract), materialization write-through + inactive zero-IO,
 *        canonical conditional-entry shape.
 *  IT  — (T2) preCli wiring: adaptive materializes the adaptive appendix, stale
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
var branchSetupShared = loadModule('js/common/branchSetup.js');
var developmentModeAdaptive = loadModule('js/common/developmentModeAdaptive.js',
    makeRequire({ './developmentMode.js': developmentMode }));

// Filesystem recording mocks — every test asserts on the recorded calls, so a
// real file can never be touched (network-guard discipline for file IO).
function fsRecorder(files) {
    var calls = { reads: [], writes: [], deletes: [] };
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
    var del = function (opts) {
        calls.deletes.push(String(opts && opts.path));
        return { deleted: true };
    };
    return { calls: calls, file_read: read, file_write: write, file_delete: del };
}

function adaptiveCustomParams(threshold) {
    var cp = { developmentMode: 'adaptive' };
    if (threshold !== undefined) {
        cp.developmentModeConfig = { adaptive: { planThreshold: threshold } };
    }
    return cp;
}

// ── UT: threshold resolution ─────────────────────────────────────────────────

suite('gh-1503 UT — SP threshold resolution', function () {
    test('absent key → default silently (absence is the steady state)', function () {
        var r = developmentModeAdaptive.resolvePlanThreshold({ developmentMode: 'adaptive' });
        assert.equal(r.threshold, 3, 'default threshold is 3 (paired-run crossover)');
        assert.equal(r.warning, null, 'absence warns nothing');
        assert.equal(developmentModeAdaptive.resolvePlanThreshold(null).warning, null, 'null customParams → silent default');
        assert.equal(developmentModeAdaptive.resolvePlanThreshold({}).threshold, 3, 'empty customParams → default');
        var noKey = developmentModeAdaptive.resolvePlanThreshold({
            developmentMode: 'adaptive',
            developmentModeConfig: { adaptive: {} }
        });
        assert.equal(noKey.threshold, 3, 'adaptive block without the key → default');
        assert.equal(noKey.warning, null, 'adaptive block without the key → silent');
    });

    test('valid integers pass through, including the boundaries', function () {
        assert.equal(developmentModeAdaptive.resolvePlanThreshold(adaptiveCustomParams(5)).threshold, 5, 'valid value honored');
        assert.equal(developmentModeAdaptive.resolvePlanThreshold(adaptiveCustomParams(5)).warning, null, 'valid value warns nothing');
        assert.equal(developmentModeAdaptive.resolvePlanThreshold(adaptiveCustomParams(1)).threshold, 1, 'min boundary honored');
        assert.equal(developmentModeAdaptive.resolvePlanThreshold(adaptiveCustomParams(13)).threshold, 13, 'max boundary honored');
    });

    test('invalid values → default + one warning naming the value', function () {
        var cases = [null, '5', 3.5, 0, -2, 14, true];
        cases.forEach(function (raw) {
            var r = developmentModeAdaptive.resolvePlanThreshold(adaptiveCustomParams(raw));
            assert.equal(r.threshold, 3, 'invalid ' + JSON.stringify(raw) + ' → default');
            assert.ok(r.warning && r.warning.indexOf('planThreshold') !== -1,
                'invalid ' + JSON.stringify(raw) + ' → warning names the key');
        });
    });

    test('a wrong-typed adaptive config block reads as absent (permissive)', function () {
        var r = developmentModeAdaptive.resolvePlanThreshold({
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
        var r = developmentModeAdaptive.parseScopeEstimateRecord(full);
        assert.equal(r.sp, 5, 'sp');
        assert.equal(r.threshold, 3, 'threshold');
        assert.equal(r.mode, 'plan', 'mode');
        assert.equal(r.reason, 'undocumented integration', 'reason');
        assert.equal(r.outcome, 'completed', 'outcome');
    });

    test('minimal record (sp + mode only) parses; optional fields stay absent', function () {
        var r = developmentModeAdaptive.parseScopeEstimateRecord(JSON.stringify({ sp: 2, mode: 'default' }));
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
            assert.equal(developmentModeAdaptive.parseScopeEstimateRecord(text), null,
                'fail-safe null for: ' + JSON.stringify(text));
        });
    });

    test('open-ended scale: sp beyond the threshold range still parses (the estimate may exceed 13)', function () {
        var r = developmentModeAdaptive.parseScopeEstimateRecord(JSON.stringify({ sp: 21, mode: 'plan' }));
        assert.ok(r && r.sp === 21, 'sp 21 is a legal estimate');
        var big = developmentModeAdaptive.parseScopeEstimateRecord(JSON.stringify({ sp: 40, mode: 'default' }));
        assert.ok(big && big.sp === 40, 'the scale keeps going above the last named value');
    });

    test('unknown extra fields are ignored, not rejected', function () {
        var r = developmentModeAdaptive.parseScopeEstimateRecord(
            JSON.stringify({ sp: 3, mode: 'default', extra: 'future-proof' }));
        assert.ok(r && r.sp === 3, 'forward-compatible parse');
    });
});

// ── UT: appendix text pins ───────────────────────────────────────────────────

suite('gh-1503 UT — adaptive appendix text', function () {
    var text = developmentModeAdaptive.spAppendixText(3);

    test('interpolates the threshold into the decision rule', function () {
        assert.ok(text.indexOf('(threshold: 3 SP)') !== -1, 'threshold appears in the decide header');
        assert.ok(developmentModeAdaptive.spAppendixText(5).indexOf('(threshold: 5 SP)') !== -1,
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

suite('gh-1503 UT — adaptive appendix materialization', function () {
    test('adaptive leg → writes the appendix, logs the threshold, zero warnings', function () {
        var fs = fsRecorder();
        var r = developmentModeAdaptive.materializeAdaptiveAppendix(adaptiveCustomParams(), { file_write: fs.file_write });
        assert.equal(r.active, true, 'active for adaptive');
        assert.equal(r.ok, true, 'write succeeds');
        assert.equal(r.path, '.dmtools/development-mode-adaptive-appendix.md', 'runtime path');
        assert.equal(fs.calls.writes.length, 1, 'exactly one write');
        assert.ok(fs.calls.writes[0].content.indexOf('(threshold: 3 SP)') !== -1, 'default threshold rendered');
        assert.ok(r.logLines.length === 1 && r.logLines[0].indexOf('threshold 3') !== -1, 'log line names the threshold');
        assert.deepEqual(r.warnings, [], 'silent for a valid/absent config');
    });

    test('invalid threshold → warning flushed + the default text written', function () {
        var fs = fsRecorder();
        var r = developmentModeAdaptive.materializeAdaptiveAppendix(adaptiveCustomParams('9'), { file_write: fs.file_write });
        assert.equal(r.ok, true, 'still materializes');
        assert.equal(r.warnings.length, 1, 'one warning');
        assert.ok(fs.calls.writes[0].content.indexOf('(threshold: 3 SP)') !== -1, 'default threshold in the file');
    });

    test('non-adaptive modes → inactive, zero IO, zero output', function () {
        ['default', 'plan', undefined].forEach(function (mode) {
            var fs = fsRecorder();
            var captured = captureConsole(function () {
                var r = developmentModeAdaptive.materializeAdaptiveAppendix(
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
        var r = developmentModeAdaptive.materializeAdaptiveAppendix({
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
        var r = developmentModeAdaptive.materializeAdaptiveAppendix(adaptiveCustomParams(), throwingIo);
        assert.equal(r.ok, false, 'write failure surfaces');
        assert.equal(r.active, true, 'adaptive is active even when the write failed');
        assert.ok(r.error && r.error.indexOf('development-mode-adaptive-appendix.md') !== -1, 'error names the path');
    });
});

// ── UT: canonical cliPrompts entry ───────────────────────────────────────────

suite('gh-1503 UT — SP conditional entry shape', function () {
    test('entry matches the canonical conditional shape', function () {
        var entry = developmentModeAdaptive.adaptiveAppendixCliEntry();
        assert.deepEqual(entry, {
            id: 'developmentModeAdaptive',
            prompt: './.dmtools/development-mode-adaptive-appendix.md',
            condition: 'agents/js/conditions/isDevelopmentModeAdaptive.js'
        });
    });
});

// ── IT: the condition script (self-contained, mirrors isDevelopmentModePlan) ─

function loadSpConditionWith(files) {
    var fs = fsRecorder(files);
    var mod = loadModule('js/conditions/isDevelopmentModeAdaptive.js', null, {
        file_read: fs.file_read,
        file_write: fs.file_write
    });
    return { fs: fs, mod: mod };
}

suite('gh-1503 IT — adaptive condition script', function () {
    test('path parity: the condition reads exactly the runtime path the module writes', function () {
        // The condition inlines its runtime path (self-contained single-function
        // design), so parity is proven behaviorally: a file at the module's
        // runtime path admits, the same file under any other name does not.
        var files = {};
        files[developmentModeAdaptive.ADAPTIVE_APPENDIX_FILE_PATH] = 'sp appendix text';
        var loaded = loadSpConditionWith(files);
        var cp = { developmentMode: 'adaptive' };
        assert.equal(loaded.mod.action({ customParams: cp }), true,
            'the module-written path is the one the condition reads');
        var entry = developmentModeAdaptive.adaptiveAppendixCliEntry();
        assert.equal(entry.prompt.replace(/^\.\//, ''), developmentModeAdaptive.ADAPTIVE_APPENDIX_FILE_PATH,
            'config prompt path denotes the same file');
    });

    test('adaptive leg + materialized adaptive appendix → true', function () {
        var files = {};
        files['.dmtools/development-mode-adaptive-appendix.md'] = 'sp appendix text';
        var loaded = loadSpConditionWith(files);
        assert.equal(loaded.mod.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } }), true,
            'active on an adaptive leg with the appendix in place');
    });

    test('shadowMode → false even with the file in place (second line of defense)', function () {
        var files = {};
        files['.dmtools/development-mode-adaptive-appendix.md'] = 'sp appendix text';
        var loaded = loadSpConditionWith(files);
        assert.equal(loaded.mod.action({
            jobParams: { customParams: {
                developmentMode: 'adaptive',
                developmentModeConfig: { adaptive: { shadowMode: true } }
            } }
        }), false, 'shadow leg never carries the adaptive block');
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
        var throwing = loadModule('js/conditions/isDevelopmentModeAdaptive.js', null, {
            file_read: function () { throw new Error('io error'); }
        });
        assert.equal(throwing.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } }), false,
            'throwing read → excluded');
    });

    test('teammate and standalone param shapes both resolve customParams', function () {
        var files = {};
        files['.dmtools/development-mode-adaptive-appendix.md'] = 'text';
        var loaded = loadSpConditionWith(files);
        assert.equal(loaded.mod.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } }), true,
            'teammate shape');
        assert.equal(loaded.mod.action({ customParams: { developmentMode: 'adaptive' } }), true,
            'flat shape');
        assert.equal(loaded.mod.action({}), false, 'no params → excluded');
    });
});


// ── Moved from the retired signal-routing suite (the dispatcher ITs now pin
// the in-leg SP behavior; the signal extractor itself is deleted). ──────────

// ── IT: the dev leg preCli dispatcher wiring ─────────────────────────────────

// Loader mirroring test_developmentModePlan.js's IT harness — the REAL setup
// module with the REAL development-mode modules and fs/CLI mocks on top.
var devSetupCommandsReal = loadModule('js/common/setupCommands.js');
var devCommentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var legFailureReportModule = loadModule('js/common/legFailureReport.js');
var legStartSignalReal = loadModule('js/common/legStartSignal.js');
var trackersModuleReal = loadModule(
    'js/common/trackers.js',
    makeRequire({ 'branchSetup.js': loadModule('js/common/branchSetup.js'),
        '../config.js': loadModule('js/config.js'),
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }),
    {}
);
var PR_HELPER_REAL = loadModule('js/common/pullRequest.js',
    makeRequire({ './mergeState.js': loadModule('js/common/mergeState.js') }));

function loadDevSetup(fs, extraMocks) {
    var mocks = Object.assign({
        file_read: fs.file_read,
        file_write: fs.file_write,
        file_delete: fs.file_delete,
        cli_execute_command: function () { return ''; }
    }, extraMocks || {});
    // FRESH instances sharing THIS test's fs mocks — a shared instance would
    // fall back to the real file_read/file_write/file_delete globals.
    var planReal = loadModule('js/common/developmentModePlan.js',
        makeRequire({ './developmentMode.js': developmentMode }), mocks);
    var spReal = loadModule('js/common/developmentModeAdaptive.js',
        makeRequire({
            './developmentMode.js': developmentMode,
            './developmentModePlan.js': planReal,
            './branchSetup.js': loadModule('js/common/branchSetup.js', null, mocks)
        }), mocks);
    return loadModule(
        'js/preCliDevelopmentSetup.js',
        makeRequire({
            'branchSetup.js': loadModule('js/common/branchSetup.js', null, mocks),
            'gitStaging.js': loadModule('js/common/gitStaging.js'),
            './configLoader.js': { resolveBranchName: function () { return 'ai/P-1'; }, resolvePRTargetBranch: function () { return 'main'; } },
            './common/pullRequest.js': PR_HELPER_REAL,
            './config.js': { GIT_CONFIG: {}, STATUSES: {}, resolveStatuses: function () { return {}; } },
            './fetchQuestionsToInput.js': {},
            './fetchLinkedTestsToInput.js': {},
            './fetchParentContextToInput.js': {},
            './restoreFromReleases.js': {},
            './common/setupCommands.js': devSetupCommandsReal,
            './common/commentMarkup.js': devCommentMarkupModule,
            './common/legFailureReport.js': legFailureReportModule,
            './common/legStartSignal.js': legStartSignalReal,
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function () { } },
            './common/trackers.js': trackersModuleReal,
            './common/developmentMode.js': developmentMode,
            './common/developmentModePlan.js': planReal,
            './common/developmentModeAdaptive.js': spReal
        }),
        mocks
    );
}

function adaptiveTicket(title, body) {
    return { key: 'P-1', fields: { summary: title, description: body } };
}
// ── AC1 fixtures — ticket shapes used by the dispatcher ITs ──────────────────
var FIX_TYPO_TITLE = 'Fix typo in README';
var FIX_TYPO_BODY = "Change 'recieve' to 'receive' in the installation section.";
var FIX_MODULES_TITLE = 'Add export pipeline';
var FIX_MODULES_BODY = [
    'Delivery plan:',
    '1. CSV exporter',
    '2. PDF renderer',
    '3. Digest builder'
].join('\n');

suite('gh-1437 IT — dev leg preCli development-mode appendix dispatcher', function () {
    var APPENDIX_PATH = developmentModePlan.PLAN_APPENDIX_FILE_PATH;

    test('adaptive leg → adaptive appendix + plan escalation read materialized + excludes seeded', function () {
        var fs = fsRecorder({ '.git/info/exclude': '' });
        var captured = captureConsole(function () {
            var r = loadDevSetup(fs).runDevelopmentModeAppendixStep(
                { developmentMode: 'adaptive' }, adaptiveTicket(FIX_MODULES_TITLE, FIX_MODULES_BODY));
            assert.equal(r.active, true, 'adaptive materializes the adaptive appendix');
            assert.equal(r.ok, true, 'adaptive appendix written');
        });
        var wrote = fs.calls.writes.filter(function (w) { return w.path === APPENDIX_PATH; });
        assert.equal(wrote.length, 1, 'plan appendix written once (escalation read)');
        assert.equal(wrote[0].content, developmentModePlan.DEFAULT_PLAN_APPENDIX, 'engine default plan text');
        var spWrites = fs.calls.writes.filter(function (w) { return w.path === '.dmtools/development-mode-adaptive-appendix.md'; });
        assert.equal(spWrites.length, 1, 'adaptive appendix written once');
        assert.contains(spWrites[0].content, '(threshold: 3 SP)', 'default threshold rendered into the adaptive block');
        var excludes = fs.calls.writes.filter(function (w) { return w.path === '.git/info/exclude'; });
        assert.equal(excludes.length, 2, 'local exclude seeded for BOTH runtime files');
        assert.contains(excludes[0].content + excludes[1].content, APPENDIX_PATH, 'exclude names the plan path');
        assert.contains(excludes[0].content + excludes[1].content, '.dmtools/development-mode-adaptive-appendix.md',
            'exclude names the SP path');
        var logs = captured.logs.join('\n');
        assert.contains(logs, 'adaptive: adaptive routing active (threshold 3)', 'adaptive routing line flushed');
        assert.contains(logs, 'plan appendix materialized for escalation reads', 'escalation-read line flushed');
    });

    test('adaptive leg with a small ticket → the SAME materialization (ticket text no longer routes)', function () {
        var fs = fsRecorder({ '.git/info/exclude': '' });
        var captured = captureConsole(function () {
            var r = loadDevSetup(fs).runDevelopmentModeAppendixStep(
                { developmentMode: 'adaptive' }, adaptiveTicket(FIX_TYPO_TITLE, FIX_TYPO_BODY));
            assert.equal(r.active, true, 'in-leg decision: preCli materializes regardless of ticket size');
            assert.equal(r.ok, true, 'adaptive appendix written for the small ticket too');
        });
        assert.equal(fs.calls.writes.filter(function (w) { return w.path === '.dmtools/development-mode-adaptive-appendix.md'; }).length, 1,
            'adaptive appendix written');
        assert.contains(captured.logs.join('\n'), 'adaptive: adaptive routing active (threshold 3)',
            'the routing decision now belongs to the agent, not the signals');
    });

    test('shadow adaptive leg → zero writes, the would-act line is the log (gh-1437 carry-over)', function () {
        var fs = fsRecorder({});
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { shadowMode: true } } };
        var captured = captureConsole(function () {
            loadDevSetup(fs).runDevelopmentModeAppendixStep(cp, adaptiveTicket(FIX_MODULES_TITLE, FIX_MODULES_BODY));
        });
        assert.equal(fs.calls.writes.length, 0, 'shadow never materializes');
        assert.contains(captured.logs.join('\n'),
            'adaptive routing would be active but shadow mode',
            'the log shows the would-act state');
    });

    test('gh-1503: tracker-shaped tickets no longer decide anything pre-leg — Jira and ADO shapes materialize identically', function () {
        // The signal extractor read tracker-specific fields (gh-1442 parity);
        // the in-leg adaptive decision reads the TICKET like the agent does — preCli
        // is tracker-shape-blind now.
        var jira = adaptiveTicket('T', '## Acceptance criteria\n- a\n- b\n- c\n- d\n- e\n- f');
        var ado = { key: 'P-1', fields: { 'System.Title': 'Add export pipeline', 'System.Description': '1. CSV exporter\n2. PDF renderer\n3. Digest builder' } };
        [jira, ado].forEach(function (ticket, i) {
            var fs = fsRecorder({ '.git/info/exclude': '' });
            var captured = captureConsole(function () {
                loadDevSetup(fs).runDevelopmentModeAppendixStep({ developmentMode: 'adaptive' }, ticket);
            });
            assert.equal(fs.calls.writes.filter(function (w) { return w.path === '.dmtools/development-mode-adaptive-appendix.md'; }).length, 1,
                'shape ' + i + ': adaptive appendix materialized');
            assert.contains(captured.logs.join('\n'), 'adaptive: adaptive routing active (threshold 3)',
                'shape ' + i + ': same routing line');
        });
    });

    test('adaptive + unreadable appendix override → THROWS naming the path (fail fast)', function () {
        var fs = fsRecorder({});
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { plan: { appendixFile: 'missing.md' } } };
        var threw = null;
        captureConsole(function () {
            try {
                loadDevSetup(fs).runDevelopmentModeAppendixStep(cp, adaptiveTicket(FIX_MODULES_TITLE, FIX_MODULES_BODY));
            } catch (e) {
                threw = e;
            }
        });
        assert.ok(threw, 'the step fails the leg');
        assert.contains(String(threw), 'missing.md', 'error names the override path');
        assert.equal(fs.calls.writes.length, 0, 'nothing materialized from a failed resolution');
    });

    test('plan leg through the dispatcher behaves exactly like the plan step (REG)', function () {
        var fs = fsRecorder({ '.git/info/exclude': '' });
        var captured = captureConsole(function () {
            var r = loadDevSetup(fs).runDevelopmentModeAppendixStep({ developmentMode: 'plan' }, adaptiveTicket('T', 'x'));
            assert.equal(r.ok, true);
            assert.equal(r.active, true);
        });
        var wrote = fs.calls.writes.filter(function (w) { return w.path === APPENDIX_PATH; });
        assert.equal(wrote.length, 1, 'appendix materialized on the plan path');
        var excludes = fs.calls.writes.filter(function (w) { return w.path === '.git/info/exclude'; });
        assert.equal(excludes.length, 1, 'exclude seeded on the plan path');
        assert.equal(fs.calls.deletes.length, 0, 'no cleanup on a plan leg');
        assert.contains(captured.logs.join('\n'), 'developmentMode=plan', 'the gh-1436 plan log line, unchanged');
    });

    test('default leg through the dispatcher → ZERO IO, ZERO output (P1 golden)', function () {
        var fs = fsRecorder({});
        var captured = captureConsole(function () {
            loadDevSetup(fs).runDevelopmentModeAppendixStep({ removeLabel: 'x' }, adaptiveTicket('T', 'x'));
        });
        assert.equal(fs.calls.reads.length + fs.calls.writes.length + fs.calls.deletes.length, 0, 'zero file IO');
        assert.equal(captured.logs.length + captured.warns.length, 0, 'zero output');
    });

    test('the dispatcher wrapper posts the setup error and rethrows on an adaptive failure', function () {
        var fs = fsRecorder({});
        var posted = [];
        var trackerStub = {
            provider: function () { return 'github'; },
            postComment: function (key, body) { posted.push({ key: key, body: body }); },
            moveToStatus: function () { }
        };
        var trackersStub = { createTracker: function () { return trackerStub; }, ticketSummaryOf: function (t) { return (t && t.fields && t.fields.summary) || ''; }, ticketDescriptionOf: function (t) { return (t && t.fields && t.fields.description) || ''; } };
        var mocks = {
            file_read: fs.file_read, file_write: fs.file_write, file_delete: fs.file_delete,
            cli_execute_command: function () { return ''; }
        };
        var planReal = loadModule('js/common/developmentModePlan.js',
            makeRequire({ './developmentMode.js': developmentMode }), mocks);
        var spReal = loadModule('js/common/developmentModeAdaptive.js',
            makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': planReal, './branchSetup.js': loadModule('js/common/branchSetup.js', null, mocks) }), mocks);
        var mod = loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({
                'branchSetup.js': loadModule('js/common/branchSetup.js', null, mocks),
                'gitStaging.js': loadModule('js/common/gitStaging.js'),
                './configLoader.js': { resolveBranchName: function () { return 'ai/P-1'; }, resolvePRTargetBranch: function () { return 'main'; } },
                './common/pullRequest.js': PR_HELPER_REAL,
                './config.js': { GIT_CONFIG: {}, STATUSES: {}, resolveStatuses: function () { return {}; } },
                './fetchQuestionsToInput.js': {},
                './fetchLinkedTestsToInput.js': {},
                './fetchParentContextToInput.js': {},
                './restoreFromReleases.js': {},
                './common/setupCommands.js': devSetupCommandsReal,
                './common/commentMarkup.js': devCommentMarkupModule,
                './common/legFailureReport.js': legFailureReportModule,
                './common/legStartSignal.js': legStartSignalReal,
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function () { } },
                './common/trackers.js': trackersStub,
                './common/developmentMode.js': developmentMode,
                './common/developmentModePlan.js': planReal,
                './common/developmentModeAdaptive.js': spReal
            }),
            mocks
        );
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { plan: { appendixFile: 'gone.md' } } };
        var threw = null;
        captureConsole(function () {
            try {
                mod.runDevelopmentModeAppendixStepOrReport(cp, { git: {} }, 'P-1', adaptiveTicket(FIX_MODULES_TITLE, FIX_MODULES_BODY));
            } catch (e) {
                threw = e;
            }
        });
        assert.ok(threw, 'wrapper rethrows (red leg)');
        assert.contains(String(threw), 'gone.md', 'names the path');
        assert.equal(posted.length, 1, 'one setup-error comment posted');
        assert.contains(posted[0].body, 'Plan Mode Setup', 'comment names the failing stage');
        assert.contains(posted[0].body, 'gone.md', 'comment carries the path');
    });

    test('the wrapper materializes + seeds the exclude on a healthy adaptive leg', function () {
        var fs = fsRecorder({ '.git/info/exclude': '' });
        var posted = [];
        var trackerStub = {
            provider: function () { return 'github'; },
            postComment: function (key, body) { posted.push({ key: key, body: body }); },
            moveToStatus: function () { }
        };
        var trackersStub = { createTracker: function () { return trackerStub; }, ticketSummaryOf: function (t) { return (t && t.fields && t.fields.summary) || ''; }, ticketDescriptionOf: function (t) { return (t && t.fields && t.fields.description) || ''; } };
        var mocks = {
            file_read: fs.file_read, file_write: fs.file_write, file_delete: fs.file_delete,
            cli_execute_command: function () { return ''; }
        };
        var planReal = loadModule('js/common/developmentModePlan.js',
            makeRequire({ './developmentMode.js': developmentMode }), mocks);
        var spReal = loadModule('js/common/developmentModeAdaptive.js',
            makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': planReal, './branchSetup.js': loadModule('js/common/branchSetup.js', null, mocks) }), mocks);
        var mod = loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({
                'branchSetup.js': loadModule('js/common/branchSetup.js', null, mocks),
                'gitStaging.js': loadModule('js/common/gitStaging.js'),
                './configLoader.js': { resolveBranchName: function () { return 'ai/P-1'; }, resolvePRTargetBranch: function () { return 'main'; } },
                './common/pullRequest.js': PR_HELPER_REAL,
                './config.js': { GIT_CONFIG: {}, STATUSES: {}, resolveStatuses: function () { return {}; } },
                './fetchQuestionsToInput.js': {},
                './fetchLinkedTestsToInput.js': {},
                './fetchParentContextToInput.js': {},
                './restoreFromReleases.js': {},
                './common/setupCommands.js': devSetupCommandsReal,
                './common/commentMarkup.js': devCommentMarkupModule,
                './common/legFailureReport.js': legFailureReportModule,
                './common/legStartSignal.js': legStartSignalReal,
                './common/baseBranchMarker.js': { writeBaseBranchMarker: function () { } },
                './common/trackers.js': trackersStub,
                './common/developmentMode.js': developmentMode,
                './common/developmentModePlan.js': planReal,
                './common/developmentModeAdaptive.js': spReal
            }),
            mocks
        );
        var threw = null;
        captureConsole(function () {
            try {
                mod.runDevelopmentModeAppendixStepOrReport(
                    { developmentMode: 'adaptive' }, { git: {} }, 'P-1', adaptiveTicket(FIX_MODULES_TITLE, FIX_MODULES_BODY));
            } catch (e) {
                threw = e;
            }
        });
        assert.notOk(threw, 'healthy adaptive leg: no throw');
        assert.equal(posted.length, 0, 'no error comment');
        var wrote = fs.calls.writes.filter(function (w) { return w.path === APPENDIX_PATH; });
        assert.equal(wrote.length, 1, 'appendix materialized through the wrapper');
    });
});

suite('gh-1503 REG — mode semantics preserved (resolver surface)', function () {
    test('the resolved mode surface stays "adaptive" on adaptive legs (routing is preCli-local)', function () {
        var resolved = developmentMode.resolveDevelopmentMode({ developmentMode: 'adaptive' });
        assert.equal(resolved.mode, 'adaptive', 'resolver untouched by this issue');
        var noopFeedback = {
            runQualityGates: function () { return { success: true }; },
            runPolicyGates: function () { return { success: true }; },
            runPostPublishGates: function () { return { success: true }; },
            resumeAgent: function () { return { attempted: false }; },
            resumeOnceForMissingResponse: function () { return { attempted: false }; }
        };
        var cm = loadModule('js/common/commentMarkup.js',
            makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
        var trackers = loadModule('js/common/trackers.js',
            makeRequire({ '../config.js': loadModule('js/config.js'), './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {});
        var trackerSlot = loadModule('js/common/trackerSlot.js',
            makeRequire({ './trackers.js': trackers }), {});
        var leg = loadModule('js/developTicketAndCreatePR.js', makeRequire({
            './common/toolchainSummary.js': { withToolchainLine: function (t) { return t; } },
            './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
            './common/pullRequest.js': { cleanCommandOutput: function (o) { return (o || '').trim(); } },
            './common/submodules.js': {},
            './common/feedbackLoop.js': noopFeedback,
            './common/autoStart.js': { triggerSmIfIdle: function () { } },
            './common/outputFiles.js': { readOutputFile: function () { return null; }, hasOutputFile: function () { return false; } },
            './common/needsInput.js': loadModule('js/common/needsInput.js'),
            './cacheToReleases.js': {},
            './common/gitStaging.js': loadModule('js/common/gitStaging.js'),
            './common/quotaCircuitBreaker.js': loadModule('js/common/quotaCircuitBreaker.js'),
            './common/developmentMode.js': developmentMode,
            './common/developmentModePlan.js': developmentModePlan,
            './common/developmentModeAdaptive.js': developmentModeAdaptive,
            './common/trackerSlot.js': trackerSlot,
            './configLoader.js': Object.assign({}, configLoaderModule, {
                loadProjectConfig: function () {
                    return { git: { baseBranch: 'main', branchPrefix: { development: 'ai/' } } };
                }
            }),
            './config.js': configModule,
            './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
            './common/commentMarkup.js': cm
        }), {
            cli_execute_command: function () { return ''; },
            jira_post_comment: function () { },
            jira_move_to_status: function () { },
            jira_remove_label: function () { }
        });
        var ctx = leg.initDevelopmentContext({
            jobParams: {
                customParams: { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { shadowMode: true } } },
                inputFolderPath: 'input/P-1'
            },
            ticket: { key: 'P-1', fields: { summary: 'S', description: 'D' } }
        });
        assert.equal(ctx.developmentMode.mode, 'adaptive', 'ctx carries the resolved CONFIG mode, not the routing outcome');
    });
});
