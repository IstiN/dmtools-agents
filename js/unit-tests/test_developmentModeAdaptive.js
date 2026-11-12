/**
 * Unit tests for gh-1437 — the `adaptive` development-mode routing: signal
 * extraction, the threshold decision rule, the routing log contract, the
 * appendix materialization/cleanup orchestration, the extended condition
 * script arms, and the dev-leg preCli wiring. Plus the calibration harness
 * decision-table core (see test_adaptiveCalibrationHarness.js for the
 * harness CLI itself).
 *
 * Layers (mirrors the gh-1435/gh-1436 test layout):
 *  UT  — js/common/developmentModeAdaptive.js pure table: signal extraction
 *        (AC1 fixtures + rule pins + determinism invariant A1), permissive
 *        adaptive config resolution, threshold boundary table (AC2), the
 *        pinned routing/shadow log lines, the evaluation composition.
 *  UT  — materialization orchestration (fs-recorder): shadow never writes,
 *        routed plan materializes through the plan module's machinery,
 *        routed default / shadow cleans stale appendix state.
 *  UT  — js/conditions/isDevelopmentModePlan.js adaptive arms: non-shadow +
 *        materialized ⇒ true, shadow ⇒ false (zero reads), missing file ⇒
 *        false. Plan/default arms unchanged (gh-1436 pins).
 *  IT  — the dev leg's real preCli setup: the dispatcher routes plan legs
 *        through the unchanged plan path, adaptive legs through the decision,
 *        default legs through zero IO / zero output.
 *  REG — mode semantics: `plan` ignores the adaptive rule entirely (always
 *        plans, even with an adaptive block present); the resolved mode
 *        surface (developTicketAndCreatePR ctx) is untouched by routing;
 *        invariant A2 — nothing in the adaptive path reads spawn config.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

// Swaps console.log/warn/error around fn() and returns { logs, warns, errors }
// — the same capture pattern test_developmentModePlan.js uses.
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
        return true;
    };
    return { calls: calls, file_read: read, file_write: write, file_delete: del };
}

// ── AC1 fixtures — the three ticket shapes named by the ticket ───────────────

var FIX_TYPO_TITLE = 'Fix typo in README';
var FIX_TYPO_BODY = "Change 'recieve' to 'receive' in the installation section.";

var FIX_MODULES_TITLE = 'Add export pipeline';
var FIX_MODULES_BODY = [
    '## Scope',
    'Deliver three modules:',
    '1. CSV exporter with streaming writes',
    '2. PDF renderer with embedded fonts',
    '3. Email digest builder',
    'Each module ships with unit tests.'
].join('\n');

var FIX_AC6_TITLE = 'Settings page rework';
var FIX_AC6_BODY = [
    'Rework the settings page.',
    '',
    '## Acceptance criteria (testable)',
    '- User can change the display name',
    '- User can upload an avatar',
    '- Avatar is cropped to a circle',
    '- Changes persist after reload',
    '- Validation errors show inline',
    '- Loading state blocks double submits',
    '',
    '## Out of scope',
    '- Mobile layout'
].join('\n');

// ── UT: signal extraction (AC1) ──────────────────────────────────────────────

suite('gh-1437 UT — signal extraction fixtures (AC1)', function () {
    test('typo-fix 1-liner → zero signals, token estimate from chars/4', function () {
        var s = developmentModeAdaptive.extractSignals(FIX_TYPO_TITLE, FIX_TYPO_BODY);
        assert.deepEqual(s, { modules: 0, acceptanceBullets: 0, bodyTokens: 19 });
    });

    test('3-module ticket (numbered deliverables) → modules 3', function () {
        var s = developmentModeAdaptive.extractSignals(FIX_MODULES_TITLE, FIX_MODULES_BODY);
        assert.deepEqual(s, { modules: 3, acceptanceBullets: 0, bodyTokens: 46 });
    });

    test('6-bullet AC ticket → acceptanceBullets 6, modules 0', function () {
        var s = developmentModeAdaptive.extractSignals(FIX_AC6_TITLE, FIX_AC6_BODY);
        assert.deepEqual(s, { modules: 0, acceptanceBullets: 6, bodyTokens: 77 });
    });

    test('A1 golden: same ticket text ⇒ identical signals (deterministic, pure)', function () {
        var a = developmentModeAdaptive.extractSignals(FIX_AC6_TITLE, FIX_AC6_BODY);
        var b = developmentModeAdaptive.extractSignals(FIX_AC6_TITLE, FIX_AC6_BODY);
        assert.deepEqual(a, b, 'two invocations agree');
        // And no hidden state: interleaving a different ticket does not change
        // the next extraction of the same text.
        developmentModeAdaptive.extractSignals(FIX_TYPO_TITLE, FIX_TYPO_BODY);
        var c = developmentModeAdaptive.extractSignals(FIX_AC6_TITLE, FIX_AC6_BODY);
        assert.deepEqual(a, c, 'signals survive interleaved calls');
    });

    test('empty / null inputs → zero signals (never throws)', function () {
        assert.deepEqual(developmentModeAdaptive.extractSignals('', ''), { modules: 0, acceptanceBullets: 0, bodyTokens: 0 });
        assert.deepEqual(developmentModeAdaptive.extractSignals(null, null), { modules: 0, acceptanceBullets: 0, bodyTokens: 0 });
        assert.deepEqual(developmentModeAdaptive.extractSignals(undefined, undefined), { modules: 0, acceptanceBullets: 0, bodyTokens: 0 });
    });
});

suite('gh-1437 UT — extraction rule pins (modules)', function () {
    test('numbered list items outside AC sections count toward modules', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['Intro.', '1. First deliverable', '2. Second deliverable', '10. Tenth with parens'].join('\n'));
        assert.equal(s.modules, 3, '1. / 2. / 10. items all count');
    });

    test('numbered items with paren form count too', function () {
        var s = developmentModeAdaptive.extractSignals('T', '1) One thing\n2) Another thing');
        assert.equal(s.modules, 2, '1) / 2) paren form');
    });

    test('"module N" mentions raise the module estimate (number after)', function () {
        assert.equal(developmentModeAdaptive.extractSignals('T', 'Module 3 handles retries').modules, 3, '"Module 3"');
        assert.equal(developmentModeAdaptive.extractSignals('T', 'see modules #4 and the docs').modules, 4, '"modules #4"');
        assert.equal(developmentModeAdaptive.extractSignals('T', 'module: 5 is the scheduler').modules, 5, '"module: 5"');
    });

    test('"N-module" / "N modules" mentions raise the estimate (number before)', function () {
        assert.equal(developmentModeAdaptive.extractSignals('T', 'this is a 3-module change').modules, 3, '"3-module"');
        assert.equal(developmentModeAdaptive.extractSignals('T', 'ships as 2 modules').modules, 2, '"2 modules"');
    });

    test('module estimates take the MAX across numbered items / module-N / bullet groups', function () {
        // 2 numbered items + a "3-module" mention → the strongest estimate wins.
        var s = developmentModeAdaptive.extractSignals('T', '1. First\n2. Second\nA 3-module change.');
        assert.equal(s.modules, 3, 'max(2, 3) = 3');
    });

    test('word-number module mentions do NOT match (deterministic digits only)', function () {
        var s = developmentModeAdaptive.extractSignals('T', 'Deliver three modules: a parser and a writer.');
        assert.equal(s.modules, 0, '"three modules" carries no digit');
    });

    test('bullet groups outside AC sections count 1 each (group, not per bullet)', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['Deliverables:', '- Exporter service', '- Importer CLI', '- Docs page'].join('\n'));
        assert.equal(s.modules, 1, 'one contiguous group of 3 bullets = 1');
    });

    test('a blank line does NOT split a bullet group (markdown lazy list)', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['- a', '', '- b'].join('\n'));
        assert.equal(s.modules, 1, 'blank-separated bullets stay one group');
    });

    test('a prose line DOES split bullet groups', function () {
        var withoutProse = developmentModeAdaptive.extractSignals('T', ['- a', '- b', '- c', '- d'].join('\n'));
        assert.equal(withoutProse.modules, 1, 'contiguous 4-bullet list → one group');
        var withProse = developmentModeAdaptive.extractSignals('T', ['- a', '- b', 'Some prose between lists.', '- c', '- d'].join('\n'));
        assert.equal(withProse.modules, 2, 'prose splits into two groups of two');
    });

    test('a single stray bullet is not a group (≥2 bullets required)', function () {
        var s = developmentModeAdaptive.extractSignals('T', 'Notes:\n- just one note');
        assert.equal(s.modules, 0, 'single bullet → no group');
    });

    test('2+ item case: two bullet groups of two bullets each → modules 2', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['- a', '- b', 'Middle prose.', '- c', '- d'].join('\n'));
        assert.equal(s.modules, 2, 'two groups, each ≥2 bullets');
    });

    test('numbered items inside an AC section do NOT count toward modules', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['## Acceptance criteria', '1. Works offline', '2. Syncs on reconnect'].join('\n'));
        assert.equal(s.modules, 0, 'AC-section items are acceptance signal, not module signal');
    });
});

suite('gh-1437 UT — extraction rule pins (acceptance bullets)', function () {
    test('numbered items under an Acceptance heading count as acceptance items', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['## Acceptance criteria', '1. Works offline', '2. Syncs on reconnect'].join('\n'));
        assert.equal(s.acceptanceBullets, 2, 'list items under AC sections (numbered form counts too)');
    });

    test('AC section variants: "### AC" heading', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['### AC', '- first', '- second'].join('\n'));
        assert.equal(s.acceptanceBullets, 2, 'bare AC heading opens the section');
    });

    test('AC section variants: bold label line "**Acceptance criteria:**"', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['**Acceptance criteria:**', '- first', '- second'].join('\n'));
        assert.equal(s.acceptanceBullets, 2, 'bold bare label opens the section');
    });

    test('AC section variants: plain label line "Acceptance criteria:"', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['Acceptance criteria:', '- first', '- second'].join('\n'));
        assert.equal(s.acceptanceBullets, 2, 'plain bare label opens the section');
    });

    test('the AC section closes at the next heading', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['## Acceptance criteria', '- a', '## Test plan', '- not an acceptance item'].join('\n'));
        assert.equal(s.acceptanceBullets, 1, 'only the bullet before the next heading counts');
    });

    test('prose lines inside the AC section are not counted', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['## Acceptance criteria', 'All of these must hold:', '- a', '- b'].join('\n'));
        assert.equal(s.acceptanceBullets, 2, 'prose sentence skipped, bullets counted');
    });

    test('"ac" does not match inside larger words (word-boundary discipline)', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['## Backup restore', '- a', '- b', '- c'].join('\n'));
        assert.equal(s.acceptanceBullets, 0, '"Backup" is not an AC heading');
        var s2 = developmentModeAdaptive.extractSignals('T', ['## Trace capture', '- a'].join('\n'));
        assert.equal(s2.acceptanceBullets, 0, '"Trace capture" is not an AC heading');
    });

    test('indented bullets count (nested AC lists)', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['## Acceptance criteria', '  - indented', '\t- tabbed'].join('\n'));
        assert.equal(s.acceptanceBullets, 2, 'any indentation depth');
    });

    test('malformed bullets ("-item" without space) are not counted', function () {
        var s = developmentModeAdaptive.extractSignals('T', ['## Acceptance criteria', '-not a bullet'].join('\n'));
        assert.equal(s.acceptanceBullets, 0, 'markdown requires the space after the marker');
    });
});

// ── UT: adaptive config resolution (permissive) ──────────────────────────────

suite('gh-1437 UT — adaptive config resolution', function () {
    test('absent block → defaults (2 / 5 / 800), shadowMode false, zero warnings', function () {
        [{}, null, undefined, { developmentModeConfig: null }, { developmentModeConfig: {} },
         { developmentModeConfig: { plan: {} } }].forEach(function (cp) {
            var r = developmentModeAdaptive.resolveAdaptiveConfig(cp);
            assert.deepEqual(r.thresholds, { planIfModulesAtLeast: 2, planIfAcceptanceBulletsAtLeast: 5, planIfBodyTokensAtLeast: 800 },
                'defaults for ' + JSON.stringify(cp));
            assert.equal(r.shadowMode, false, 'shadow off by default for ' + JSON.stringify(cp));
            assert.equal(r.warnings.length, 0, 'silent for ' + JSON.stringify(cp));
        });
    });

    test('empty adaptive block → defaults silently', function () {
        var r = developmentModeAdaptive.resolveAdaptiveConfig({ developmentModeConfig: { adaptive: {} } });
        assert.deepEqual(r.thresholds, { planIfModulesAtLeast: 2, planIfAcceptanceBulletsAtLeast: 5, planIfBodyTokensAtLeast: 800 });
        assert.equal(r.shadowMode, false);
        assert.equal(r.warnings.length, 0);
    });

    test('per-key overrides ride through', function () {
        var r = developmentModeAdaptive.resolveAdaptiveConfig({
            developmentModeConfig: { adaptive: { planIfModulesAtLeast: 3, planIfAcceptanceBulletsAtLeast: 7, planIfBodyTokensAtLeast: 1200 } }
        });
        assert.deepEqual(r.thresholds, { planIfModulesAtLeast: 3, planIfAcceptanceBulletsAtLeast: 7, planIfBodyTokensAtLeast: 1200 });
        assert.equal(r.warnings.length, 0);
    });

    test('zero is a legal threshold (always-plan tuning)', function () {
        var r = developmentModeAdaptive.resolveAdaptiveConfig({
            developmentModeConfig: { adaptive: { planIfBodyTokensAtLeast: 0 } }
        });
        assert.equal(r.thresholds.planIfBodyTokensAtLeast, 0, '0 passes through');
        assert.equal(r.warnings.length, 0);
    });

    test('wrong-typed threshold → ONE warning naming the key, default used', function () {
        ['3', 2.5, -1, '', true, [2]].forEach(function (v) {
            var r = developmentModeAdaptive.resolveAdaptiveConfig({
                developmentModeConfig: { adaptive: { planIfModulesAtLeast: v } }
            });
            assert.equal(r.thresholds.planIfModulesAtLeast, 2, 'default for ' + JSON.stringify(v));
            assert.equal(r.warnings.length, 1, 'one warning for ' + JSON.stringify(v));
            assert.contains(r.warnings[0], 'planIfModulesAtLeast', 'warning names the key');
            assert.contains(r.warnings[0], 'developmentModeConfig.adaptive', 'warning names the config path');
        });
    });

    test('null/undefined threshold reads as absent (no warning)', function () {
        [null, undefined].forEach(function (v) {
            var r = developmentModeAdaptive.resolveAdaptiveConfig({
                developmentModeConfig: { adaptive: { planIfBodyTokensAtLeast: v } }
            });
            assert.equal(r.thresholds.planIfBodyTokensAtLeast, 800, 'absent → default for ' + JSON.stringify(v));
            assert.equal(r.warnings.length, 0, 'silent for ' + JSON.stringify(v));
        });
    });

    test('shadowMode: true enables shadow; false/absent keep it off', function () {
        assert.equal(developmentModeAdaptive.resolveAdaptiveConfig(
            { developmentModeConfig: { adaptive: { shadowMode: true } } }).shadowMode, true, 'true → shadow on');
        assert.equal(developmentModeAdaptive.resolveAdaptiveConfig(
            { developmentModeConfig: { adaptive: { shadowMode: false } } }).shadowMode, false, 'false → shadow off');
        assert.equal(developmentModeAdaptive.resolveAdaptiveConfig(
            { developmentModeConfig: { adaptive: {} } }).shadowMode, false, 'absent → shadow off');
        assert.equal(developmentModeAdaptive.resolveAdaptiveConfig(
            { developmentModeConfig: { adaptive: { shadowMode: null } } }).shadowMode, false, 'null reads as unset');
    });

    test('wrong-typed shadowMode → ONE warning, treated as false', function () {
        ['yes', 1, { on: true }].forEach(function (v) {
            var r = developmentModeAdaptive.resolveAdaptiveConfig({
                developmentModeConfig: { adaptive: { shadowMode: v } }
            });
            assert.equal(r.shadowMode, false, 'non-boolean reads as off for ' + JSON.stringify(v));
            assert.equal(r.warnings.length, 1, 'one warning for ' + JSON.stringify(v));
            assert.contains(r.warnings[0], 'shadowMode', 'warning names the key');
        });
    });

    test('non-object adaptive block → defaults silently (the gh-1435 validator already warns at apply time)', function () {
        var r = developmentModeAdaptive.resolveAdaptiveConfig({ developmentModeConfig: { adaptive: 'balanced' } });
        assert.deepEqual(r.thresholds, { planIfModulesAtLeast: 2, planIfAcceptanceBulletsAtLeast: 5, planIfBodyTokensAtLeast: 800 });
        assert.equal(r.shadowMode, false);
        assert.equal(r.warnings.length, 0, 'no duplicate warning from the resolver');
    });
});

// ── UT: decision function (AC2 — boundary table) ─────────────────────────────

suite('gh-1437 UT — decision boundary table (AC2)', function () {
    var D = { planIfModulesAtLeast: 2, planIfAcceptanceBulletsAtLeast: 5, planIfBodyTokensAtLeast: 800 };

    // [label, signals, expectedMode, expectedTrigger]
    var CASES = [
        ['modules just under (1)', { modules: 1, acceptanceBullets: 0, bodyTokens: 0 }, 'default', null],
        ['modules == threshold (2)', { modules: 2, acceptanceBullets: 0, bodyTokens: 0 }, 'plan', 'modules'],
        ['modules just over (3)', { modules: 3, acceptanceBullets: 0, bodyTokens: 0 }, 'plan', 'modules'],
        ['bullets just under (4)', { modules: 0, acceptanceBullets: 4, bodyTokens: 0 }, 'default', null],
        ['bullets == threshold (5)', { modules: 0, acceptanceBullets: 5, bodyTokens: 0 }, 'plan', 'acceptanceBullets'],
        ['bullets just over (6)', { modules: 0, acceptanceBullets: 6, bodyTokens: 0 }, 'plan', 'acceptanceBullets'],
        ['tokens just under (799)', { modules: 0, acceptanceBullets: 0, bodyTokens: 799 }, 'default', null],
        ['tokens == threshold (800)', { modules: 0, acceptanceBullets: 0, bodyTokens: 800 }, 'plan', 'bodyTokens'],
        ['tokens just over (801)', { modules: 0, acceptanceBullets: 0, bodyTokens: 801 }, 'plan', 'bodyTokens'],
        ['OR combination: bullets trip when modules under', { modules: 1, acceptanceBullets: 6, bodyTokens: 10 }, 'plan', 'acceptanceBullets'],
        ['OR combination: tokens trip when others under', { modules: 1, acceptanceBullets: 2, bodyTokens: 900 }, 'plan', 'bodyTokens'],
        ['all under → default', { modules: 1, acceptanceBullets: 4, bodyTokens: 799 }, 'default', null],
        ['all over → rule order wins (modules)', { modules: 3, acceptanceBullets: 9, bodyTokens: 2000 }, 'plan', 'modules']
    ];

    CASES.forEach(function (c) {
        test(c[0] + ' → ' + c[2] + (c[3] ? ' via ' + c[3] : ''), function () {
            var d = developmentModeAdaptive.decideAdaptiveMode(c[1], D);
            assert.equal(d.mode, c[2], 'decided mode');
            assert.equal(d.trigger, c[3], 'trigger signal');
        });
    });

    test('custom thresholds move the boundaries (config-only tuning)', function () {
        var t = { planIfModulesAtLeast: 4, planIfAcceptanceBulletsAtLeast: 2, planIfBodyTokensAtLeast: 100 };
        assert.equal(developmentModeAdaptive.decideAdaptiveMode({ modules: 3, acceptanceBullets: 0, bodyTokens: 0 }, t).mode, 'default',
            'modules 3 under a threshold of 4 → default');
        assert.equal(developmentModeAdaptive.decideAdaptiveMode({ modules: 3, acceptanceBullets: 2, bodyTokens: 0 }, t).trigger, 'acceptanceBullets',
            'bullets 2 meets the lowered threshold');
    });

    test('threshold 0 trips on the empty ticket (always-plan tuning)', function () {
        var t = { planIfModulesAtLeast: 0, planIfAcceptanceBulletsAtLeast: 5, planIfBodyTokensAtLeast: 800 };
        var d = developmentModeAdaptive.decideAdaptiveMode({ modules: 0, acceptanceBullets: 0, bodyTokens: 0 }, t);
        assert.equal(d.mode, 'plan', '0 >= 0');
        assert.equal(d.trigger, 'modules');
    });
});

// ── UT: routing log lines (the ticket's pinned log contract) ─────────────────

suite('gh-1437 UT — routing log lines', function () {
    var D = { planIfModulesAtLeast: 2, planIfAcceptanceBulletsAtLeast: 5, planIfBodyTokensAtLeast: 800 };

    test('shadow would-plan lines quote exactly the triggering signal (ticket format)', function () {
        assert.equal(
            developmentModeAdaptive.routingLogLine({ mode: 'plan', trigger: 'modules' }, { modules: 3, acceptanceBullets: 0, bodyTokens: 412 }, true),
            'adaptive: would plan (signals: modules=3) but shadow mode');
        assert.equal(
            developmentModeAdaptive.routingLogLine({ mode: 'plan', trigger: 'acceptanceBullets' }, { modules: 0, acceptanceBullets: 6, bodyTokens: 10 }, true),
            'adaptive: would plan (signals: acceptanceBullets=6) but shadow mode');
        assert.equal(
            developmentModeAdaptive.routingLogLine({ mode: 'plan', trigger: 'bodyTokens' }, { modules: 0, acceptanceBullets: 0, bodyTokens: 812 }, true),
            'adaptive: would plan (signals: bodyTokens=812) but shadow mode');
    });

    test('shadow would-default line carries the full signal triple', function () {
        assert.equal(
            developmentModeAdaptive.routingLogLine({ mode: 'default', trigger: null }, { modules: 1, acceptanceBullets: 2, bodyTokens: 96 }, true),
            'adaptive: would default (signals: modules=1, acceptanceBullets=2, bodyTokens=96) but shadow mode');
    });

    test('non-shadow routing lines mirror the shadow wording', function () {
        assert.equal(
            developmentModeAdaptive.routingLogLine({ mode: 'plan', trigger: 'modules' }, { modules: 3, acceptanceBullets: 0, bodyTokens: 412 }, false),
            'adaptive: routing to plan (signals: modules=3)');
        assert.equal(
            developmentModeAdaptive.routingLogLine({ mode: 'default', trigger: null }, { modules: 1, acceptanceBullets: 2, bodyTokens: 96 }, false),
            'adaptive: routing to default (signals: modules=1, acceptanceBullets=2, bodyTokens=96)');
    });
});

// ── UT: evaluation composition (mode gating + integration) ───────────────────

suite('gh-1437 UT — evaluateAdaptiveMode', function () {
    test('non-adaptive modes resolve inactive with zero output', function () {
        [{}, { developmentMode: 'default' }, { developmentMode: 'plan' }, { developmentMode: 'ADAPTIVE' }].forEach(function (cp) {
            var e = developmentModeAdaptive.evaluateAdaptiveMode(cp, FIX_MODULES_TITLE + '\n' + FIX_MODULES_BODY);
            assert.equal(e.active, false, 'inactive for ' + JSON.stringify(cp));
            assert.equal(e.logLines.length, 0, 'zero log lines for ' + JSON.stringify(cp));
            assert.equal(e.warnings.length, 0, 'zero warnings for ' + JSON.stringify(cp));
        });
    });

    test('adaptive leg evaluates signals + decision + one log line', function () {
        var cp = { developmentMode: 'adaptive' };
        var e = developmentModeAdaptive.evaluateAdaptiveMode(cp, FIX_MODULES_TITLE + '\n' + FIX_MODULES_BODY);
        assert.equal(e.active, true);
        assert.equal(e.shadowMode, false);
        assert.deepEqual(e.signals, { modules: 3, acceptanceBullets: 0, bodyTokens: 46 });
        assert.deepEqual(e.thresholds, { planIfModulesAtLeast: 2, planIfAcceptanceBulletsAtLeast: 5, planIfBodyTokensAtLeast: 800 });
        assert.deepEqual(e.decision, { mode: 'plan', trigger: 'modules' });
        assert.deepEqual(e.logLines, ['adaptive: routing to plan (signals: modules=3)']);
        assert.equal(e.warnings.length, 0);
    });

    test('shadow mode flips the log line, not the decision', function () {
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { shadowMode: true } } };
        var e = developmentModeAdaptive.evaluateAdaptiveMode(cp, FIX_MODULES_TITLE + '\n' + FIX_MODULES_BODY);
        assert.equal(e.active, true);
        assert.equal(e.shadowMode, true);
        assert.deepEqual(e.decision, { mode: 'plan', trigger: 'modules' }, 'the decision itself is unchanged');
        assert.deepEqual(e.logLines, ['adaptive: would plan (signals: modules=3) but shadow mode']);
    });

    test('config warnings surface through the evaluation', function () {
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { planIfModulesAtLeast: 'two' } } };
        var e = developmentModeAdaptive.evaluateAdaptiveMode(cp, '');
        assert.equal(e.warnings.length, 1, 'config warning carried');
        assert.contains(e.warnings[0], 'planIfModulesAtLeast');
    });
});

// ── UT: materialization orchestration ────────────────────────────────────────

suite('gh-1437 UT — materializeAdaptiveAppendix (fs recorder)', function () {
    var BIG_TICKET_TEXT = FIX_MODULES_TITLE + '\n' + FIX_MODULES_BODY;
    var SMALL_TICKET_TEXT = FIX_TYPO_TITLE + '\n' + FIX_TYPO_BODY;
    var APPENDIX_PATH = developmentModePlan.PLAN_APPENDIX_FILE_PATH;

    test('non-adaptive mode → inactive no-op, zero IO (P1-style gate)', function () {
        var fs = fsRecorder({});
        var r = developmentModeAdaptive.materializeAdaptiveAppendix({ developmentMode: 'default' }, BIG_TICKET_TEXT, fs);
        assert.equal(r.active, false);
        assert.equal(r.ok, false, 'nothing materialized');
        assert.notOk(r.error);
        assert.equal(fs.calls.reads.length + fs.calls.writes.length + fs.calls.deletes.length, 0, 'zero file IO');
    });

    test('routed plan → appendix materialized with the engine default text', function () {
        var fs = fsRecorder({});
        var r = developmentModeAdaptive.materializeAdaptiveAppendix({ developmentMode: 'adaptive' }, BIG_TICKET_TEXT, fs);
        assert.equal(r.active, true);
        assert.equal(r.routed, 'plan');
        assert.equal(r.shadow, false);
        assert.equal(r.materialized, true);
        assert.equal(r.ok, true);
        assert.equal(r.path, APPENDIX_PATH);
        assert.equal(r.overridden, false);
        assert.equal(fs.calls.writes.length, 1, 'exactly one write');
        assert.equal(fs.calls.writes[0].path, APPENDIX_PATH, 'the runtime appendix path');
        assert.equal(fs.calls.writes[0].content, developmentModePlan.DEFAULT_PLAN_APPENDIX, 'engine default text');
        assert.equal(fs.calls.deletes.length, 0, 'no cleanup on a materializing leg');
        assert.deepEqual(r.logLines, [
            'adaptive: routing to plan (signals: modules=3)',
            '📝 developmentMode=adaptive: engine default appendix materialized → ' + APPENDIX_PATH
        ]);
    });

    test('routed plan with an appendix override → override content written', function () {
        var fs = fsRecorder({ 'w.md': 'WORKFLOW-APPENDIX' });
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { plan: { appendixFile: 'w.md' } } };
        var r = developmentModeAdaptive.materializeAdaptiveAppendix(cp, BIG_TICKET_TEXT, fs);
        assert.equal(r.materialized, true);
        assert.equal(r.overridden, true);
        assert.equal(fs.calls.writes[0].content, 'WORKFLOW-APPENDIX', 'override text verbatim');
        assert.contains(r.logLines[1], 'override appendix materialized');
    });

    test('routed plan with an unreadable override → error names the path, nothing written', function () {
        var fs = fsRecorder({});
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { plan: { appendixFile: 'gone.md' } } };
        var r = developmentModeAdaptive.materializeAdaptiveAppendix(cp, BIG_TICKET_TEXT, fs);
        assert.equal(r.ok, false);
        assert.equal(r.materialized, false);
        assert.ok(r.error, 'error present');
        assert.contains(r.error, 'gone.md', 'error names the override path');
        assert.equal(fs.calls.writes.length, 0, 'nothing written from a failed resolution');
        assert.deepEqual(r.logLines, ['adaptive: routing to plan (signals: modules=3)'],
            'the routing decision is still logged; no materialization line');
    });

    test('routed default → no write, stale appendix cleaned, routing line logged', function () {
        var fs = fsRecorder({});
        var r = developmentModeAdaptive.materializeAdaptiveAppendix({ developmentMode: 'adaptive' }, SMALL_TICKET_TEXT, fs);
        assert.equal(r.active, true);
        assert.equal(r.routed, 'default');
        assert.equal(r.materialized, false);
        assert.equal(r.ok, true, 'a clean routing-to-default step is a success');
        assert.equal(fs.calls.writes.length, 0, 'no appendix written');
        assert.deepEqual(fs.calls.deletes, [APPENDIX_PATH], 'stale appendix path cleaned');
        assert.deepEqual(r.logLines, ['adaptive: routing to default (signals: modules=0, acceptanceBullets=0, bodyTokens=19)']);
    });

    test('shadow (would plan) → NO write, stale cleanup still runs, would-line logged', function () {
        var fs = fsRecorder({});
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { shadowMode: true } } };
        var r = developmentModeAdaptive.materializeAdaptiveAppendix(cp, BIG_TICKET_TEXT, fs);
        assert.equal(r.active, true);
        assert.equal(r.shadow, true);
        assert.equal(r.routed, 'plan', 'the computed decision is still reported');
        assert.equal(r.materialized, false, 'shadow never acts');
        assert.equal(r.ok, true);
        assert.equal(fs.calls.writes.length, 0, 'zero writes in shadow mode');
        assert.deepEqual(fs.calls.deletes, [APPENDIX_PATH], 'stale state cleaned so the leg stays default-identical');
        assert.deepEqual(r.logLines, ['adaptive: would plan (signals: modules=3) but shadow mode']);
    });

    test('shadow (would default) → no writes, would-default line logged', function () {
        var fs = fsRecorder({});
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { shadowMode: true } } };
        var r = developmentModeAdaptive.materializeAdaptiveAppendix(cp, SMALL_TICKET_TEXT, fs);
        assert.equal(r.materialized, false);
        assert.deepEqual(r.logLines,
            ['adaptive: would default (signals: modules=0, acceptanceBullets=0, bodyTokens=19) but shadow mode']);
    });

    test('stale-appendix delete failure is non-fatal (warned, leg continues)', function () {
        var fs = fsRecorder({});
        fs.file_delete = function () { throw new Error('readonly fs'); };
        var captured = captureConsole(function () {
            var r = developmentModeAdaptive.materializeAdaptiveAppendix({ developmentMode: 'adaptive' }, SMALL_TICKET_TEXT, fs);
            assert.equal(r.ok, true, 'cleanup failure does not fail the step');
            assert.notOk(r.error);
        });
        assert.equal(captured.warns.length, 1, 'one honest warning');
        assert.contains(captured.warns[0], APPENDIX_PATH, 'warning names the path');
    });

    test('appendix write failure → ok:false + honest error, never a throw', function () {
        var fs = fsRecorder({});
        fs.file_write = function () { throw new Error('disk full'); };
        var r = developmentModeAdaptive.materializeAdaptiveAppendix({ developmentMode: 'adaptive' }, BIG_TICKET_TEXT, fs);
        assert.equal(r.ok, false);
        assert.ok(r.error, 'error present');
        assert.contains(r.error, APPENDIX_PATH, 'error names the runtime path');
    });
});

// ── UT: condition script — adaptive arms ─────────────────────────────────────

function loadConditionWith(files, mocks) {
    var fs = fsRecorder(files);
    var injected = {};
    injected.file_read = fs.file_read;
    injected.file_write = fs.file_write;
    if (mocks) Object.assign(injected, mocks);
    var mod = loadModule('js/conditions/isDevelopmentModePlan.js', null, injected);
    return { fs: fs, mod: mod };
}

suite('gh-1437 UT — condition script adaptive arms', function () {
    var APPENDIX = '.dmtools/development-mode-plan-appendix.md';

    test('adaptive + non-shadow + materialized appendix → true', function () {
        var files = {};
        files[APPENDIX] = 'appendix text';
        var loaded = loadConditionWith(files);
        assert.equal(loaded.mod.action(
            { jobParams: { customParams: { developmentMode: 'adaptive' } } }), true,
            'routed-to-plan adaptive leg carries the appendix');
    });

    test('adaptive + non-shadow + no appendix → false (one read attempted)', function () {
        var loaded = loadConditionWith({});
        var ok = loaded.mod.action({ jobParams: { customParams: { developmentMode: 'adaptive' } } });
        assert.equal(ok, false, 'nothing materialized → excluded');
        assert.deepEqual(loaded.fs.calls.reads, [APPENDIX], 'readability probed');
    });

    test('adaptive + shadowMode → false with ZERO reads (stale file cannot leak)', function () {
        var files = {};
        files[APPENDIX] = 'STALE appendix from a previous plan leg';
        var loaded = loadConditionWith(files);
        var ok = loaded.mod.action({
            jobParams: { customParams: { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { shadowMode: true } } } }
        });
        assert.equal(ok, false, 'shadow legs never carry the appendix');
        assert.equal(loaded.fs.calls.reads.length, 0, 'the shadow guard short-circuits before any IO');
    });

    test('plan / default / missing / wrong-case modes keep the gh-1436 arms', function () {
        var files = {};
        files[APPENDIX] = 'appendix text';
        var loaded = loadConditionWith(files);
        assert.equal(loaded.mod.action(
            { jobParams: { customParams: { developmentMode: 'plan' } } }), true, 'plan unchanged');
        ['', 'default', 'PLAN'].forEach(function (mode) {
            var cp = mode === '' ? {} : { developmentMode: mode };
            assert.equal(loaded.mod.action({ jobParams: { customParams: cp } }), false,
                'mode ' + JSON.stringify(mode) + ' → excluded');
        });
    });

    test('adaptive with a wrong-typed shadowMode is treated as non-shadow', function () {
        var files = {};
        files[APPENDIX] = 'appendix text';
        var loaded = loadConditionWith(files);
        assert.equal(loaded.mod.action({
            jobParams: { customParams: { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { shadowMode: 'yes' } } } }
        }), true, 'strict === true is the shadow test; anything else is non-shadow');
    });
});

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
    // fall back to the real file_read/file_write/file_delete globals (the
    // gh-1436 loader discipline; the appendix materialization must never
    // touch the real filesystem from a test).
    var planReal = loadModule('js/common/developmentModePlan.js',
        makeRequire({ './developmentMode.js': developmentMode }), mocks);
    var adaptiveReal = loadModule('js/common/developmentModeAdaptive.js',
        makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': planReal }), mocks);
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
            './common/developmentModePlan.js': developmentModePlan,
            './common/developmentModeAdaptive.js': adaptiveReal
        }),
        mocks
    );
}

function adaptiveTicket(title, body) {
    return { key: 'P-1', fields: { summary: title, description: body } };
}

suite('gh-1437 IT — dev leg preCli development-mode appendix dispatcher', function () {
    var APPENDIX_PATH = developmentModePlan.PLAN_APPENDIX_FILE_PATH;

    test('adaptive leg with a big ticket → appendix materialized + exclude seeded + routing lines', function () {
        var fs = fsRecorder({ '.git/info/exclude': '' });
        var captured = captureConsole(function () {
            var r = loadDevSetup(fs).runDevelopmentModeAppendixStep(
                { developmentMode: 'adaptive' }, adaptiveTicket(FIX_MODULES_TITLE, FIX_MODULES_BODY));
            assert.equal(r.materialized, true, 'appendix materialized for the routed-plan leg');
        });
        var wrote = fs.calls.writes.filter(function (w) { return w.path === APPENDIX_PATH; });
        assert.equal(wrote.length, 1, 'appendix written once');
        assert.equal(wrote[0].content, developmentModePlan.DEFAULT_PLAN_APPENDIX, 'engine default text');
        var excludes = fs.calls.writes.filter(function (w) { return w.path === '.git/info/exclude'; });
        assert.equal(excludes.length, 1, 'local exclude seeded');
        assert.contains(excludes[0].content, APPENDIX_PATH, 'exclude names the appendix path');
        var logs = captured.logs.join('\n');
        assert.contains(logs, 'adaptive: routing to plan (signals: modules=3)', 'routing line flushed');
        assert.contains(logs, 'appendix materialized', 'materialization line flushed');
    });

    test('adaptive leg with a small ticket → no appendix, no exclude, routing-to-default line', function () {
        var fs = fsRecorder({});
        var captured = captureConsole(function () {
            var r = loadDevSetup(fs).runDevelopmentModeAppendixStep(
                { developmentMode: 'adaptive' }, adaptiveTicket(FIX_TYPO_TITLE, FIX_TYPO_BODY));
            assert.equal(r.materialized, false);
            assert.equal(r.routed, 'default');
        });
        assert.equal(fs.calls.writes.length, 0, 'no appendix, no exclude write');
        var logs = captured.logs.join('\n');
        assert.contains(logs, 'adaptive: routing to default', 'routing line flushed');
        assert.equal(logs.indexOf('materialized'), -1, 'no materialization line');
    });

    test('shadow adaptive leg → zero writes, the would-decision line is the log', function () {
        var fs = fsRecorder({});
        var cp = { developmentMode: 'adaptive', developmentModeConfig: { adaptive: { shadowMode: true } } };
        var captured = captureConsole(function () {
            loadDevSetup(fs).runDevelopmentModeAppendixStep(cp, adaptiveTicket(FIX_MODULES_TITLE, FIX_MODULES_BODY));
        });
        assert.equal(fs.calls.writes.length, 0, 'shadow never materializes');
        assert.contains(captured.logs.join('\n'),
            'adaptive: would plan (signals: modules=3) but shadow mode',
            'the log shows the would-decision (AC3)');
    });

    test('adaptive leg carries the ticket text through to the decision (fields.summary/description)', function () {
        var fs = fsRecorder({ '.git/info/exclude': '' });
        var captured = captureConsole(function () {
            loadDevSetup(fs).runDevelopmentModeAppendixStep(
                { developmentMode: 'adaptive' },
                { key: 'P-1', fields: { summary: 'T', description: '## Acceptance criteria\n' + new Array(7).join('x') } });
        });
        // 6 bullets → routed to plan regardless of the tiny token count.
        var sixBullets = ['## Acceptance criteria', '- a', '- b', '- c', '- d', '- e', '- f'].join('\n');
        fs = fsRecorder({ '.git/info/exclude': '' });
        captured = captureConsole(function () {
            loadDevSetup(fs).runDevelopmentModeAppendixStep(
                { developmentMode: 'adaptive' }, adaptiveTicket('T', sixBullets));
            var wrote = fs.calls.writes.filter(function (w) { return w.path === APPENDIX_PATH; });
            assert.equal(wrote.length, 1, '6-bullet ticket routes to plan');
        });
        assert.contains(captured.logs.join('\n'), 'adaptive: routing to plan (signals: acceptanceBullets=6)');
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
        var trackersStub = { createTracker: function () { return trackerStub; } };
        var mocks = {
            file_read: fs.file_read, file_write: fs.file_write, file_delete: fs.file_delete,
            cli_execute_command: function () { return ''; }
        };
        var adaptiveReal = loadModule('js/common/developmentModeAdaptive.js',
            makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': developmentModePlan }), mocks);
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
                './common/developmentModePlan.js': developmentModePlan,
                './common/developmentModeAdaptive.js': adaptiveReal
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
        var trackersStub = { createTracker: function () { return trackerStub; } };
        var mocks = {
            file_read: fs.file_read, file_write: fs.file_write, file_delete: fs.file_delete,
            cli_execute_command: function () { return ''; }
        };
        var adaptiveReal = loadModule('js/common/developmentModeAdaptive.js',
            makeRequire({ './developmentMode.js': developmentMode, './developmentModePlan.js': developmentModePlan }), mocks);
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
                './common/developmentModePlan.js': developmentModePlan,
                './common/developmentModeAdaptive.js': adaptiveReal
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

// ── REG: invariants across the existing machinery ────────────────────────────

suite('gh-1437 REG — plan/default modes unaffected; mode semantics preserved', function () {
    test('plan mode IGNORES the adaptive rule: shadowMode in the adaptive slice changes nothing', function () {
        var fs = fsRecorder({});
        var cp = {
            developmentMode: 'plan',
            developmentModeConfig: { adaptive: { shadowMode: true, planIfModulesAtLeast: 100 } }
        };
        var r = developmentModePlan.materializePlanAppendix(cp, fs);
        assert.equal(r.ok, true, 'plan leg materializes as always');
        assert.equal(fs.calls.writes.length, 1, 'the appendix is written despite the adaptive block');
        assert.equal(fs.calls.deletes.length, 0, 'no adaptive cleanup on a plan leg');
    });

    test('A2: the adaptive path never consults developmentModeConfig.spawn', function () {
        var fs = fsRecorder({});
        var cp = {
            developmentMode: 'adaptive',
            developmentModeConfig: { spawn: { enabled: true, maxAgents: 4 } }
        };
        var r = developmentModeAdaptive.materializeAdaptiveAppendix(cp, FIX_TYPO_TITLE + '\n' + FIX_TYPO_BODY, fs);
        assert.equal(r.routed, 'default', 'routing decided from ticket signals only');
        assert.notOk(r.error);
    });

    test('the resolved mode surface stays "adaptive" on adaptive legs (routing is preCli-local)', function () {
        // developTicketAndCreatePR.initDevelopmentContext resolves + logs the
        // CONFIG value; the adaptive routing decision never rewrites it.
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
