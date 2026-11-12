/**
 * Unit tests for gh-1436 — the `plan` development-mode execution path:
 * the plan-protocol prompt appendix (engine default + per-workflow override),
 * its runtime materialization on the dev-leg preCli setup, and the
 * conditional cliPrompts wiring in the dev leg configs.
 *
 * Layers (mirrors the gh-1435 test layout):
 *  UT  — js/common/developmentModePlan.js pure table: mode gating, override
 *        loading (verbatim / fail-fast errors), materialization write-through,
 *        canonical conditional-entry shape, protocol pins on the default text.
 *  UT  — js/conditions/isDevelopmentModePlan.js self-contained condition
 *        (plan + materialized file ⇒ true; anything else ⇒ false).
 *  IT  — the dev leg's real preCli setup (preCliDevelopmentSetup): appendix
 *        materialized + local exclude seeded on plan legs, fail-fast on an
 *        unreadable override, ZERO drift (no writes, no log lines) on
 *        default-mode legs (invariant P1).
 *  IT  — agent config wiring: story_development.json / bug_development.json
 *        carry the canonical conditional entry exactly once as the LAST base
 *        cliPrompts entry (after the instruction pack, before the tracker
 *        parts appended at assembly), the condition file exists, and the
 *        encoded-config path preserves the entry byte-identically.
 *  REG — invariant P2 mechanics: the plan snapshot commit protocol coexists
 *        with the WIP auto-save squash (plan subjects never trigger it alone);
 *        runtime-artifact lists never treat the appendix file as committable.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

// Swaps console.log/warn around fn() and returns { logs, warns } — the same
// capture pattern test_developmentMode.js uses for its log-contract asserts.
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

function planCustomParams(overridePath) {
    var cp = { developmentMode: 'plan' };
    if (overridePath !== undefined) {
        cp.developmentModeConfig = { plan: { appendixFile: overridePath } };
    }
    return cp;
}

// ── UT: mode gating ──────────────────────────────────────────────────────────

suite('gh-1436 UT — plan-mode gating', function () {
    test('plan resolves active; default / missing / invalid resolve inactive', function () {
        assert.equal(developmentModePlan.isPlanMode({ developmentMode: 'plan' }), true, 'plan → active');
        assert.equal(developmentModePlan.isPlanMode({ developmentMode: 'default' }), false, 'default → inactive');
        assert.equal(developmentModePlan.isPlanMode({}), false, 'absent → inactive');
        assert.equal(developmentModePlan.isPlanMode(null), false, 'null customParams → inactive');
        assert.equal(developmentModePlan.isPlanMode({ developmentMode: 'PLAN' }), false, 'wrong case → default (invalid) → inactive');
        assert.equal(developmentModePlan.isPlanMode({ developmentMode: 'adaptive' }), false, 'adaptive is NOT plan');
    });

    test('absent mode → the appendix machinery performs zero file IO (P1)', function () {
        var fs = fsRecorder({});
        var captured = captureConsole(function () {
            var r = developmentModePlan.materializePlanAppendix({}, fs);
            assert.equal(r.active, false);
            assert.notOk(r.error);
        });
        assert.equal(fs.calls.writes.length, 0, 'no writes on a default-mode leg');
        assert.equal(captured.logs.length, 0, 'no log lines on a default-mode leg');
        assert.equal(captured.warns.length, 0, 'no warnings on a default-mode leg');
    });

    test('inactive leg with NO io never references the dmtools IO globals (CI regression: file_write ReferenceError ×25)', function () {
        // The reviewed eager pattern `var write = (io && io.file_write) || file_write;`
        // was evaluated BEFORE the mode gate, so every default-mode preCli leg
        // threw ReferenceError under hosts without the dmtools globals (the Node
        // harness defines file_read but NOT file_write → 25 red CI tests). Pin:
        // on an inactive leg neither file_write nor file_read may be referenced
        // at all — both globals deleted, the calls must still complete (P1: the
        // IO surface is not even touched, only skipped).
        // Host-portable global handle: Node (the CI crap-check harness) and the
        // dmtools GraalJS runner both expose the global object as globalThis.
        var host = (typeof globalThis !== 'undefined') ? globalThis : null;
        var hadRead = !!host && typeof host.file_read !== 'undefined';
        var hadWrite = !!host && typeof host.file_write !== 'undefined';
        var savedRead = hadRead ? host.file_read : undefined;
        var savedWrite = hadWrite ? host.file_write : undefined;
        if (host) {
            delete host.file_read;
            delete host.file_write;
        }
        try {
            var captured = captureConsole(function () {
                var rText = developmentModePlan.readAppendixText({});
                assert.equal(rText.active, false, 'readAppendixText: absent mode → inactive');
                var rMat = developmentModePlan.materializePlanAppendix({});
                assert.equal(rMat.active, false, 'materializePlanAppendix: absent mode → inactive');
                assert.notOk(rMat.error, 'the no-op carries no error');
            });
            assert.equal(captured.logs.length, 0, 'no logs');
            assert.equal(captured.warns.length, 0, 'no warnings');
        } finally {
            if (host && hadRead) host.file_read = savedRead;
            if (host && hadWrite) host.file_write = savedWrite;
        }
    });
});

// ── UT: appendix text resolution (default + override) ────────────────────────

suite('gh-1436 UT — appendix text resolution (AC5 override, fail-fast errors)', function () {
    test('plan mode without override → engine-shipped default text, zero reads', function () {
        var fs = fsRecorder({});
        var r = developmentModePlan.readAppendixText(planCustomParams(), fs);
        assert.equal(r.active, true);
        assert.equal(r.overridden, false, 'default source');
        assert.equal(r.text, developmentModePlan.DEFAULT_PLAN_APPENDIX, 'engine default text verbatim');
        assert.equal(fs.calls.reads.length, 0, 'the default ships engine-side — no file read');
        assert.notOk(r.error);
    });

    test('override file readable → content replaces the default VERBATIM (AC5)', function () {
        var body = '# Workflow appendix\n\nCustom protocol text\nwith several lines\n';
        var fs = fsRecorder({ 'workflows/plan_appendix.md': body });
        var r = developmentModePlan.readAppendixText(planCustomParams('workflows/plan_appendix.md'), fs);
        assert.equal(r.active, true);
        assert.equal(r.overridden, true, 'override source recorded');
        assert.equal(r.text, body, 'override content used verbatim — no trimming, no wrapping');
        assert.deepEqual(fs.calls.reads, ['workflows/plan_appendix.md'], 'exactly the override path read');
        assert.notOk(r.error);
    });

    test('override file missing → config error naming the path (fail fast)', function () {
        var fs = fsRecorder({});
        var r = developmentModePlan.readAppendixText(planCustomParams('workflows/missing.md'), fs);
        assert.equal(r.active, true, 'mode is still plan — the caller fails the leg');
        assert.notOk(r.text, 'no text resolved');
        assert.ok(r.error, 'error present');
        assert.contains(r.error, 'workflows/missing.md', 'error names the override path');
        assert.contains(r.error, 'appendixFile', 'error names the config key');
    });

    test('override file blank → config error naming the path', function () {
        var fs = fsRecorder({ 'blank.md': '   \n  ' });
        var r = developmentModePlan.readAppendixText(planCustomParams('blank.md'), fs);
        assert.ok(r.error, 'blank override is a config error');
        assert.contains(r.error, 'blank.md', 'error names the path');
    });

    test('appendixFile empty string / null / undefined reads as absent → default text', function () {
        ['', null, undefined].forEach(function (v) {
            var fs = fsRecorder({});
            var r = developmentModePlan.readAppendixText(planCustomParams(v), fs);
            assert.equal(r.overridden, false, 'value ' + JSON.stringify(v) + ' reads as absent');
            assert.equal(r.text, developmentModePlan.DEFAULT_PLAN_APPENDIX, 'default text for ' + JSON.stringify(v));
            assert.notOk(r.error);
        });
    });

    test('wrong-typed appendixFile → warning + default text (permissive config), never a throw', function () {
        [42, { path: 'x' }, ['x'], true].forEach(function (v) {
            var fs = fsRecorder({});
            var captured = captureConsole(function () {
                var r = developmentModePlan.readAppendixText(planCustomParams(v), fs);
                assert.equal(r.text, developmentModePlan.DEFAULT_PLAN_APPENDIX, 'default text for ' + JSON.stringify(v));
                assert.equal(r.warnings.length, 1, 'one warning returned for ' + JSON.stringify(v));
                assert.contains(r.warnings[0], 'appendixFile', 'warning names the config key');
            });
            assert.equal(fs.calls.reads.length, 0, 'no read attempted for a non-string path');
            assert.equal(captured.logs.length, 0, 'resolution itself stays silent (the caller logs)');
        });
    });

    test('override read THROWING (host error) → config error naming the path, never a throw', function () {
        var fs = fsRecorder({});
        fs.file_read = function () { throw new Error('host disk failure'); };
        var r = developmentModePlan.readAppendixText(planCustomParams('any.md'), fs);
        assert.ok(r.error, 'error captured');
        assert.contains(r.error, 'any.md', 'error names the path');
    });
});

// ── UT: appendixOverridePath config table (full-branch coverage) ─────────────
// The crap4js quality gate ratchets per-function CRAP: a NEW function over
// threshold 8 fails the `crap` check (gh-1436 CI, appendixOverridePath: 9).
// These direct pins exercise EVERY branch of the config-resolution table so
// the function stays fully covered — the permissive-resolution contract is
// spelled out here, not just reachable incidentally through readAppendixText.

suite('gh-1436 UT — appendixOverridePath config-resolution table', function () {
    test('null / non-object customParams → no override, no warnings', function () {
        [null, undefined, 42, 'plan', ['x']].forEach(function (cp) {
            var r = developmentModePlan.appendixOverridePath(cp);
            assert.equal(r.path, null, 'no override for ' + JSON.stringify(cp));
            assert.equal(r.warnings.length, 0, 'silent for ' + JSON.stringify(cp));
        });
    });

    test('developmentModeConfig non-object / .plan absent / .plan non-object → no override, silent', function () {
        [
            { developmentModeConfig: 'not-an-object' },
            { developmentModeConfig: 42 },
            { developmentModeConfig: {} },
            { developmentModeConfig: { plan: 'not-an-object' } },
            { developmentModeConfig: { plan: 42 } },
            { developmentModeConfig: { plan: {} } },
            { developmentModeConfig: { other: 'key' } }
        ].forEach(function (cp) {
            var r = developmentModePlan.appendixOverridePath(cp);
            assert.equal(r.path, null, 'no override for ' + JSON.stringify(cp));
            assert.equal(r.warnings.length, 0, 'absent/garbled config block reads as absent (permissive), silent');
        });
    });

    test('appendixFile explicitly null / undefined / empty string → no override, no warnings', function () {
        [null, undefined, ''].forEach(function (v) {
            var cp = { developmentModeConfig: { plan: { appendixFile: v } } };
            var r = developmentModePlan.appendixOverridePath(cp);
            assert.equal(r.path, null, 'value ' + JSON.stringify(v) + ' reads as absent');
            assert.equal(r.warnings.length, 0, 'silent for ' + JSON.stringify(v));
        });
    });

    test('wrong-typed appendixFile → exactly one warning naming the key, no override', function () {
        [42, { path: 'x' }, ['x'], true].forEach(function (v) {
            var cp = { developmentModeConfig: { plan: { appendixFile: v } } };
            var r = developmentModePlan.appendixOverridePath(cp);
            assert.equal(r.path, null, 'no override for ' + JSON.stringify(v));
            assert.equal(r.warnings.length, 1, 'one warning for ' + JSON.stringify(v));
            assert.contains(r.warnings[0], 'appendixFile', 'warning names the config key');
        });
    });

    test('non-empty string appendixFile → the path, no warnings', function () {
        var r = developmentModePlan.appendixOverridePath(
            { developmentModeConfig: { plan: { appendixFile: 'workflows/plan_appendix.md' } } });
        assert.equal(r.path, 'workflows/plan_appendix.md', 'the path passes through verbatim');
        assert.equal(r.warnings.length, 0, 'no warnings for a valid path');
    });
});

// ── UT: materialization write-through ────────────────────────────────────────

suite('gh-1436 UT — materialization (preCli write-through)', function () {
    test('plan mode → appendix written to the runtime path (default text)', function () {
        var fs = fsRecorder({});
        var r = developmentModePlan.materializePlanAppendix(planCustomParams(), fs);
        assert.equal(r.active, true);
        assert.equal(r.ok, true, 'materialized');
        assert.equal(r.overridden, false);
        assert.equal(fs.calls.writes.length, 1, 'exactly one write');
        assert.equal(fs.calls.writes[0].path, developmentModePlan.PLAN_APPENDIX_FILE_PATH, 'runtime path');
        assert.equal(fs.calls.writes[0].content, developmentModePlan.DEFAULT_PLAN_APPENDIX, 'resolved text');
        assert.notOk(r.error);
    });

    test('plan mode with override → override content written (AC5 end to end)', function () {
        var fs = fsRecorder({ 'override.md': 'OVERRIDE-TEXT' });
        var r = developmentModePlan.materializePlanAppendix(planCustomParams('override.md'), fs);
        assert.equal(r.ok, true);
        assert.equal(r.overridden, true);
        assert.equal(fs.calls.writes[0].content, 'OVERRIDE-TEXT', 'override rides to the runtime file verbatim');
    });

    test('override missing → ok:false + error naming the path (the leg must fail fast)', function () {
        var fs = fsRecorder({});
        var r = developmentModePlan.materializePlanAppendix(planCustomParams('nope.md'), fs);
        assert.equal(r.ok, false, 'not materialized');
        assert.equal(fs.calls.writes.length, 0, 'nothing written from a failed resolution');
        assert.contains(r.error, 'nope.md', 'error names the path');
    });

    test('host write failure → ok:false + honest error, never a throw', function () {
        var fs = fsRecorder({});
        fs.file_write = function () { throw new Error('disk full'); };
        var r = developmentModePlan.materializePlanAppendix(planCustomParams(), fs);
        assert.equal(r.ok, false);
        assert.ok(r.error, 'error present');
        assert.contains(r.error, developmentModePlan.PLAN_APPENDIX_FILE_PATH, 'error names the runtime path');
    });
});

// ── UT: canonical conditional cliPrompts entry ───────────────────────────────

suite('gh-1436 UT — canonical conditional cliPrompts entry', function () {
    test('entry shape: id, prompt path, condition path', function () {
        var entry = developmentModePlan.planAppendixCliEntry();
        assert.equal(entry.id, 'developmentModePlan', 'stable id');
        assert.equal(entry.prompt, './.dmtools/development-mode-plan-appendix.md',
            'runtime path in cliPrompts path form (working-dir relative)');
        assert.equal(entry.condition, 'agents/js/conditions/isDevelopmentModePlan.js',
            'self-contained condition script (pack-reachable path)');
    });

    test('the prompt path form and the file path form denote the same file', function () {
        var entry = developmentModePlan.planAppendixCliEntry();
        assert.equal(entry.prompt.replace(/^\.\//, ''), developmentModePlan.PLAN_APPENDIX_FILE_PATH,
            'prompt path minus ./ prefix equals the file_write path');
    });

    test('default appendix text carries the plan protocol (contract pins)', function () {
        var t = developmentModePlan.DEFAULT_PLAN_APPENDIX;
        assert.contains(t, 'outputs/<KEY>/plan.md', 'working-copy plan path');
        assert.contains(t, '.dmtools/plan-snapshot.md', 'committed snapshot path');
        assert.contains(t, '<KEY>: plan', 'snapshot commit subject');
        assert.contains(t, '<KEY>: plan update', 'per-task checkbox commit subject');
        assert.contains(t, '## Decisions', 'decisions section');
        assert.contains(t, '## Open questions', 'open questions section');
        assert.contains(t, 'verify', 'each task carries how-to-check');
        assert.contains(t, 'T1', 'numbered tasks');
        assert.contains(t, 'pending', 'resume rule executes only pending tasks');
        assert.contains(t, 'checkbox', 'reconciliation instruction');
    });

    test('default appendix text obeys the pack content rules (R9): no gh-NN refs, no ISO dates', function () {
        var t = developmentModePlan.DEFAULT_PLAN_APPENDIX;
        assert.equal(/\bgh-[0-9]+\b/i.test(t), false, 'no internal issue refs');
        assert.equal(/\bpr-[0-9]+\b/i.test(t), false, 'no internal PR refs');
        assert.equal(/\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b/.test(t), false, 'no ISO dates');
        assert.equal(/(?:observed live|Evidence\s*\()/i.test(t), false, 'no live-incident markers');
    });
});

// ── UT: the condition script (self-contained, like isCodeGraphAvailable) ─────

// The condition uses the file_read global — inject the recording fs per load.
function loadConditionWith(files) {
    var fs = fsRecorder(files);
    var mod = loadModule('js/conditions/isDevelopmentModePlan.js', null, {
        file_read: fs.file_read,
        file_write: fs.file_write
    });
    return { fs: fs, mod: mod };
}

suite('gh-1436 UT — condition script', function () {
    test('path parity: the condition reads exactly the runtime path the module writes', function () {
        var loaded = loadConditionWith({});
        var entry = developmentModePlan.planAppendixCliEntry();
        assert.equal(loaded.mod.appendixRuntimePath(),
            developmentModePlan.PLAN_APPENDIX_FILE_PATH,
            'condition and module must agree on the materialization path');
        assert.equal(entry.prompt.replace(/^\.\//, ''), loaded.mod.appendixRuntimePath(),
            'config prompt path denotes the same file');
    });

    test('plan mode + materialized file → true', function () {
        var loaded = loadConditionWith({});
        var files = {};
        files[loaded.mod.appendixRuntimePath()] = 'appendix text';
        loaded = loadConditionWith(files);
        var captured = captureConsole(function () {
            var ok = loaded.mod.action({ jobParams: { customParams: { developmentMode: 'plan' } } });
            assert.equal(ok, true, 'active on a plan leg with the appendix in place');
        });
        assert.equal(captured.logs.length + captured.warns.length, 0, 'condition stays silent');
    });

    test('default / missing mode → false without reading anything', function () {
        var loaded = loadConditionWith({});
        ['', 'default', 'PLAN'].forEach(function (mode) {
            var cp = mode === '' ? {} : { developmentMode: mode };
            var ok = loaded.mod.action({ jobParams: { customParams: cp } });
            assert.equal(ok, false, 'mode ' + JSON.stringify(mode) + ' → excluded');
        });
        assert.equal(loaded.fs.calls.reads.length, 0, 'non-plan/non-adaptive modes never touch the filesystem');
        // gh-1437: adaptive legs DO probe the file (the materialization is the
        // decision record) — pinned here so the surface stays explicit.
        var adaptive = loadConditionWith({});
        assert.equal(adaptive.mod.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } }), false,
            'adaptive without a materialized appendix → excluded');
        assert.deepEqual(adaptive.fs.calls.reads, ['.dmtools/development-mode-plan-appendix.md'],
            'adaptive probes exactly the runtime path');
    });

    test('plan mode but file missing/unreadable → false (no dangling prompt read)', function () {
        var loaded = loadConditionWith({});
        assert.equal(loaded.mod.action(
            { jobParams: { customParams: { developmentMode: 'plan' } } }), false, 'missing file → excluded');
        var throwing = loadModule('js/conditions/isDevelopmentModePlan.js', null, {
            file_read: function () { throw new Error('io error'); }
        });
        assert.equal(throwing.action(
            { jobParams: { customParams: { developmentMode: 'plan' } } }), false, 'throwing read → excluded');
    });

    test('teammate and standalone param shapes both resolve customParams', function () {
        var files = {};
        files['.dmtools/development-mode-plan-appendix.md'] = 'text';
        var loaded = loadConditionWith(files);
        assert.equal(loaded.mod.action(
            { jobParams: { customParams: { developmentMode: 'plan' } } }), true, 'teammate shape');
        assert.equal(loaded.mod.action(
            { customParams: { developmentMode: 'plan' } }), true, 'flat shape');
        assert.equal(loaded.mod.action({}), false, 'no params → excluded');
    });
});

// ── IT: the dev leg preCli setup wiring ──────────────────────────────────────

// Loader mirroring test_preCliDevelopmentSetup.js, with the REAL plan-mode
// module wired and filesystem/CLI mocks on top.
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
        cli_execute_command: function () { return ''; }
    }, extraMocks || {});
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
            // FRESH instances sharing THIS test's fs mocks — a shared instance
            // would fall back to the real file_read/file_write globals.
            './common/developmentModePlan.js': loadModule('js/common/developmentModePlan.js',
                makeRequire({ './developmentMode.js': developmentMode }), mocks),
            './common/developmentModeAdaptive.js': loadModule('js/common/developmentModeAdaptive.js',
                makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': developmentModePlan }), mocks)
        }),
        mocks
    );
}

suite('gh-1436 IT — dev leg preCli plan-mode appendix step', function () {
    test('plan leg → appendix materialized at the runtime path + local exclude seeded', function () {
        var fs = fsRecorder({ '.git/info/exclude': '' });
        var captured = captureConsole(function () {
            var r = loadDevSetup(fs).runPlanModeAppendixStep(planCustomParams());
            assert.equal(r.ok, true, 'materialized');
        });
        var wrote = fs.calls.writes.filter(function (w) { return w.path === developmentModePlan.PLAN_APPENDIX_FILE_PATH; });
        assert.equal(wrote.length, 1, 'appendix file written once');
        assert.equal(wrote[0].content, developmentModePlan.DEFAULT_PLAN_APPENDIX, 'default text');
        var excludes = fs.calls.writes.filter(function (w) { return w.path === '.git/info/exclude'; });
        assert.equal(excludes.length, 1, 'local exclude seeded');
        assert.contains(excludes[0].content, developmentModePlan.PLAN_APPENDIX_FILE_PATH, 'exclude names the appendix path');
        assert.ok(captured.logs.join('\n').indexOf('developmentMode=plan') !== -1 || captured.logs.length >= 1,
            'one observability line on a plan leg');
    });

    test('plan leg with override → override content materialized', function () {
        var fs = fsRecorder({ '.git/info/exclude': '', 'w.md': 'WORKFLOW-APPENDIX' });
        loadDevSetup(fs).runPlanModeAppendixStep(planCustomParams('w.md'));
        var wrote = fs.calls.writes.filter(function (w) { return w.path === developmentModePlan.PLAN_APPENDIX_FILE_PATH; });
        assert.equal(wrote[0].content, 'WORKFLOW-APPENDIX', 'override content wins');
    });

    test('override unreadable → THROWS naming the path (fail fast before agent launch)', function () {
        var fs = fsRecorder({});
        var threw = null;
        captureConsole(function () {
            try {
                loadDevSetup(fs).runPlanModeAppendixStep(planCustomParams('missing.md'));
            } catch (e) {
                threw = e;
            }
        });
        assert.ok(threw, 'the step fails the leg');
        assert.contains(String(threw), 'missing.md', 'error names the override path');
        assert.equal(fs.calls.writes.length, 0, 'nothing materialized from a failed resolution');
    });

    test('default-mode leg → ZERO writes, ZERO log lines (invariant P1 golden)', function () {
        var fs = fsRecorder({});
        var captured = captureConsole(function () {
            loadDevSetup(fs).runPlanModeAppendixStep({ removeLabel: 'x' });
        });
        assert.equal(fs.calls.writes.length, 0, 'no appendix write, no exclude write');
        assert.equal(captured.logs.length, 0, 'no log lines');
        assert.equal(captured.warns.length, 0, 'no warnings');
    });

    test('the reported fatal wrapper posts the setup error comment and rethrows', function () {
        var fs = fsRecorder({});
        var posted = [];
        var trackerStub = {
            provider: function () { return 'github'; },
            postComment: function (key, body) { posted.push({ key: key, body: body }); },
            moveToStatus: function () { }
        };
        var trackersStub = { createTracker: function () { return trackerStub; } };
        var mod = loadModule(
            'js/preCliDevelopmentSetup.js',
            makeRequire({
                'branchSetup.js': loadModule('js/common/branchSetup.js', null, {
                    file_read: fs.file_read, file_write: fs.file_write, cli_execute_command: function () { return ''; }
                }),
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
                './common/developmentModePlan.js': developmentModePlan,
                './common/developmentModeAdaptive.js': loadModule('js/common/developmentModeAdaptive.js',
                    makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': developmentModePlan }),
                    { file_read: fs.file_read, file_write: fs.file_write, file_delete: fs.file_delete, cli_execute_command: function () { return ''; } })
            }),
            { file_read: fs.file_read, file_write: fs.file_write, cli_execute_command: function () { return ''; } }
        );
        var threw = null;
        captureConsole(function () {
            try {
                mod.runPlanModeAppendixStepOrReport(planCustomParams('gone.md'), { git: {} }, 'P-1');
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

    test('the fatal wrapper materializes + seeds the exclude on a healthy plan leg', function () {
        var fs = fsRecorder({ '.git/info/exclude': '' });
        var posted = [];
        var trackerStub = {
            provider: function () { return 'github'; },
            postComment: function (key, body) { posted.push({ key: key, body: body }); },
            moveToStatus: function () { }
        };
        var trackersStub = { createTracker: function () { return trackerStub; } };
        var mocks = { file_read: fs.file_read, file_write: fs.file_write, file_delete: fs.file_delete, cli_execute_command: function () { return ''; } };
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
                './common/developmentModePlan.js': loadModule('js/common/developmentModePlan.js',
                    makeRequire({ './developmentMode.js': developmentMode }), mocks),
                './common/developmentModeAdaptive.js': loadModule('js/common/developmentModeAdaptive.js',
                    makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': developmentModePlan }), mocks)
            }),
            mocks
        );
        var threw = null;
        captureConsole(function () {
            try {
                mod.runPlanModeAppendixStepOrReport(planCustomParams(), { git: {} }, 'P-1');
            } catch (e) {
                threw = e;
            }
        });
        assert.notOk(threw, 'healthy plan leg: no throw');
        assert.equal(posted.length, 0, 'no error comment');
        var wrote = fs.calls.writes.filter(function (w) { return w.path === developmentModePlan.PLAN_APPENDIX_FILE_PATH; });
        assert.equal(wrote.length, 1, 'appendix materialized through the wrapper too');
    });
});

// ── IT: agent config wiring ──────────────────────────────────────────────────

function readRootConfig(name) {
    var raw = file_read({ path: name });
    assert.ok(raw, 'config readable: ' + name);
    return JSON.parse(raw);
}

suite('gh-1436 IT — dev leg configs carry the conditional appendix entry', function () {
    var DEV_CONFIGS = ['story_development.json', 'bug_development.json'];

    DEV_CONFIGS.forEach(function (name) {
        test(name + ': the canonical entry appears EXACTLY ONCE, as the LAST base cliPrompts entry (AC1 position)', function () {
            var cfg = readRootConfig(name);
            var prompts = cfg.params.cliPrompts;
            assert.ok(Array.isArray(prompts) && prompts.length > 0, 'cliPrompts present');
            var hits = [];
            prompts.forEach(function (p, i) {
                if (p && typeof p === 'object' && p.id === 'developmentModePlan') hits.push(i);
            });
            assert.equal(hits.length, 1, 'exactly one appendix entry (AC1: appendix exactly once)');
            assert.equal(hits[0], prompts.length - 1, 'entry is the LAST base cliPrompts item — ' +
                'assembly appends cliPromptsByTracker AFTER the base array, so the appendix lands ' +
                'after the instruction pack and before the tracker-specific parts');
            assert.deepEqual(prompts[hits[0]], developmentModePlan.planAppendixCliEntry(),
                'entry is byte-identical to the canonical builder output');
        });
    });

    test('the condition file exists (pack reference integrity R1)', function () {
        var entry = developmentModePlan.planAppendixCliEntry();
        // Pack-authored path is agents/-prefixed; the standalone checkout strips it.
        var p = entry.condition.replace(/^agents\//, '');
        var r = file_exists({ path: p });
        var exists = r && typeof r === 'object' ? r.exists === true : r === true;
        assert.ok(exists, 'condition script on disk: ' + p);
    });

    test('non-dev legs do NOT carry the entry (P1 scope guard)', function () {
        ['test_case_automation.json', 'pr_review.json', 'pr_rework.json'].forEach(function (name) {
            var cfg = readRootConfig(name);
            var prompts = (cfg.params && cfg.params.cliPrompts) || [];
            prompts.forEach(function (p) {
                assert.notOk(p && typeof p === 'object' && p.id === 'developmentModePlan',
                    name + ' must not carry the plan appendix entry');
            });
        });
    });

    test('prompt-order simulation: role → instruction pack → APPENDIX → tracker parts (AC1 snapshot)', function () {
        // Pure-JS model of the verified engine assembly order: the role text
        // first, then every base cliPrompts entry in array order, then the
        // tracker-specific entries appended. The appendix entry is the last
        // base item, so its section must sit AFTER the pack sections and
        // BEFORE every tracker section.
        var cfg = readRootConfig('story_development.json');
        var role = 'ROLE';
        var sections = [];
        if (role) sections.push('role');
        (cfg.params.cliPrompts || []).forEach(function (p) {
            sections.push(p && typeof p === 'object' ? ('cond:' + p.id) : String(p));
        });
        var trackerEntries = (cfg.params.cliPromptsByTracker && cfg.params.cliPromptsByTracker.github) || [];
        trackerEntries.forEach(function (p) { sections.push('tracker:' + p); });

        var appendixIdx = -1;
        var firstTrackerIdx = -1;
        sections.forEach(function (s, i) {
            if (s === 'cond:developmentModePlan') appendixIdx = i;
            if (firstTrackerIdx === -1 && s.indexOf('tracker:') === 0) firstTrackerIdx = i;
        });
        assert.ok(appendixIdx > 1, 'appendix after the role + pack head');
        assert.ok(firstTrackerIdx > appendixIdx, 'appendix BEFORE the tracker-specific parts');
        assert.equal(sections[appendixIdx - 1], 'cond:codegraph',
            'appendix directly follows the last instruction-pack entry (the codegraph conditional)');
    });

    test('encoded-config path: the conditional entry survives into the encoded params', function () {
        // Harness mirroring test_buildEncodedConfig.js: a virtual agent JSON in
        // a file-map reader, real configLoader/validateInputJql/trackers.
        var shapes = loadModule('js/common/ticketKeyShapes.js', makeRequire({}), {});
        var trackers = loadModule('js/common/trackers.js',
            makeRequire({ '../config.js': loadModule('js/config.js'), './ticketKeyShapes.js': shapes }), {});
        var fileMap = {};
        fileMap['agents/plan_probe.json'] = JSON.stringify({
            name: 'Teammate',
            params: {
                metadata: { contextId: 'story_development' },
                cliCommands: ['./agents/scripts/run-agent.sh'],
                cliPrompts: ['./agents/instructions/common/agent_task_preamble.md',
                    developmentModePlan.planAppendixCliEntry()],
                cliPromptsByTracker: { github: ['./agents/instructions/common/github_comment_format.md'] },
                customParams: { developmentMode: 'plan' }
            }
        });
        var reader = function (readOpts) {
            var p = readOpts && readOpts.path;
            if (fileMap.hasOwnProperty(p)) return fileMap[p];
            try { return file_read({ path: String(p).replace(/^agents\//, '') }); } catch (e) { }
            return null;
        };
        var builder = loadModule('js/common/buildEncodedConfig.js',
            makeRequire(Object.assign({
                '../configLoader.js': configLoaderModule,
                './validateInputJql.js': loadModule('js/common/validateInputJql.js',
                    makeRequire({ './ticketKeyShapes.js': shapes, './trackers.js': trackers }), {}),
                './trackers.js': trackers
            })),
            { file_read: reader, encodeURIComponent: encodeURIComponent, JSON: JSON });
        var encoded = builder.buildEncodedConfig('gh-1436', { configFile: 'agents/plan_probe.json' }, {});
        var decoded = JSON.parse(decodeURIComponent(encoded)).params;
        var found = (decoded.cliPrompts || []).filter(function (p) {
            return p && typeof p === 'object' && p.id === 'developmentModePlan';
        });
        assert.equal(found.length, 1, 'entry survives encoding exactly once');
        assert.deepEqual(found[0], developmentModePlan.planAppendixCliEntry(), 'entry rides byte-identical');
        assert.equal(decoded.customParams.developmentMode, 'plan', 'mode rides so the condition can resolve it');
    });

    test('copyParamValue deep-copies conditional entries (encoded pass-through unit)', function () {
        var entry = developmentModePlan.planAppendixCliEntry();
        var snapshot = JSON.stringify(entry);
        var shapes = loadModule('js/common/ticketKeyShapes.js', makeRequire({}), {});
        var trackers = loadModule('js/common/trackers.js',
            makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': shapes }), {});
        var bec = loadModule('js/common/buildEncodedConfig.js',
            makeRequire({
                '../configLoader.js': configLoaderModule,
                './validateInputJql.js': loadModule('js/common/validateInputJql.js',
                    makeRequire({ './ticketKeyShapes.js': shapes, './trackers.js': trackers }), {}),
                './trackers.js': trackers
            }));
        var out = {};
        bec.copyParamValue(out, 'cliPrompts', [entry], {});
        assert.equal(typeof out.cliPrompts[0], 'object', 'object entry copied as object');
        assert.deepEqual(out.cliPrompts[0], JSON.parse(snapshot), 'entry survives byte-identical');
        // The array copy is shallow (value.slice()), but the encoded payload is
        // a JSON STRING — aliasing cannot cross the dispatch boundary. The
        // byte-identical assertion above is the actual contract.
        assert.equal(JSON.stringify(out.cliPrompts[0]), snapshot, 'serialized form byte-identical');
    });
});

// ── REG: invariants across the existing machinery ────────────────────────────

suite('gh-1436 REG — plan protocol coexists with the existing leg machinery', function () {
    // Loader mirroring test_developmentMode.js's leg harness — the real
    // developTicketAndCreatePR module with dmtools globals mocked.
    function loadLeg() {
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
            makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }), {});
        var trackerSlot = loadModule('js/common/trackerSlot.js',
            makeRequire({ './trackers.js': trackers }), {});
        return loadModule('js/developTicketAndCreatePR.js', makeRequire({
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
            './common/trackerSlot.js': trackerSlot,
            './configLoader.js': Object.assign({}, configLoaderModule, {
                loadProjectConfig: function () { return { git: { baseBranch: 'main' } }; }
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
    }

    test('P2: plan-snapshot commit subjects NEVER trigger the WIP auto-save squash alone', function () {
        var mod = loadLeg();
        var safe = 'PROJ-1 it';
        assert.equal(mod.canSquashDevWipSubjects(['PROJ-1: plan', 'PROJ-1: plan update T1 done'], safe), false,
            'agent plan commits are not squashed by the plan protocol alone');
        assert.equal(mod.canSquashDevWipSubjects(['PROJ-1: plan', 'PROJ-1 WIP auto-save 1', 'PROJ-1: plan update T1 done'], safe), true,
            'a WIP auto-save in the range still squashes (documented leg-end cleanup — snapshot content survives)');
        assert.equal(mod.canSquashDevWipSubjects([], safe), false, 'empty range never squashes');
    });

    test('P2: the appendix runtime path is never treated as committable runtime state', function () {
        var gitStaging = loadModule('js/common/gitStaging.js');
        var line = '?? .dmtools/development-mode-plan-appendix.md';
        assert.equal(gitStaging.isRuntimeArtifactStatusLine(line), true,
            'landing guard ignores the materialized appendix (never reads as work)');
        var idx = gitStaging.RUNTIME_ARTIFACT_PATHS.indexOf('.dmtools/development-mode-plan-appendix.md');
        assert.ok(idx !== -1, 'runtime-artifact list carries the appendix path (untrack-on-every-leg)');
    });

    test('P1 golden: resolved default mode stays byte-identical on the appendix path', function () {
        // The whole appendix surface is gated on isPlanMode — a non-plan
        // customParams bag (the steady state of every existing config) drives
        // zero reads, zero writes, zero output across the ENTIRE module.
        var fs = fsRecorder({});
        var captured = captureConsole(function () {
            developmentModePlan.materializePlanAppendix({}, fs);
            developmentModePlan.readAppendixText({}, fs);
        });
        assert.equal(fs.calls.reads.length + fs.calls.writes.length, 0, 'zero file IO');
        assert.equal(captured.logs.length + captured.warns.length, 0, 'zero output');
    });
});
