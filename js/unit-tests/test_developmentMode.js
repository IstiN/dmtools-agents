/**
 * Unit tests for gh-1435 — the `developmentMode` config knob: config surface
 * + safe fallback (zero behavior change).
 *
 * Layers covered (mirrors the ticket test plan):
 *  UT  — js/common/developmentMode.js resolver table (AC1–AC5): raw
 *        customParams → resolved mode + warning count + warning content.
 *  IT  — the story dev leg's real config-reading path
 *        (developTicketAndCreatePR.initDevelopmentContext) driven with
 *        fixture workflow params (with / without the field, junk values).
 *  REG — every workflow config in this repo's root walked through the
 *        resolver: resolved 'default', zero warnings, zero new log lines
 *        (golden: none of the existing configs sets the field).
 */

// ── helpers ──────────────────────────────────────────────────────────────────

// Swaps console.log/warn around fn() and returns { logs, warns } — the same
// capture pattern test_autoStart.js uses for its warn-contract assertions.
function captureConsole(fn) {
    var captured = { logs: [], warns: [] };
    var origLog = console.log;
    var origWarn = console.warn;
    console.log = function (msg) { captured.logs.push(String(msg)); };
    console.warn = function (msg) { captured.warns.push(String(msg)); };
    try {
        fn();
    } finally {
        console.log = origLog;
        console.warn = origWarn;
    }
    return captured;
}

var developmentMode = loadModule('js/common/developmentMode.js');

// ── UT: resolver table (AC1–AC5) ─────────────────────────────────────────────

suite('gh-1435 UT resolver — raw config table (AC1–AC5)', function () {
    // [label, customParams, expectedMode, expectedWarningCount, expectedPresent]
    var CASES = [
        ['AC1: no developmentMode key', {}, 'default', 0, false],
        ['AC1: null customParams object', null, 'default', 0, false],
        ['AC1: undefined value (key present)', { developmentMode: undefined }, 'default', 0, false],
        ['AC2: "plan"', { developmentMode: 'plan' }, 'plan', 0, true],
        ['AC2: "adaptive"', { developmentMode: 'adaptive' }, 'adaptive', 0, true],
        ['AC2: explicit "default"', { developmentMode: 'default' }, 'default', 0, true],
        ['AC3: "adaptive?" (unknown string)', { developmentMode: 'adaptive?' }, 'default', 1, true],
        ['AC3: 123 (number)', { developmentMode: 123 }, 'default', 1, true],
        ['AC3: "" (empty string)', { developmentMode: '' }, 'default', 1, true],
        ['AC3: null', { developmentMode: null }, 'default', 1, true],
        ['AC3: true (boolean)', { developmentMode: true }, 'default', 1, true],
        ['AC3: object value', { developmentMode: { mode: 'plan' } }, 'default', 1, true],
        ['AC3: array value', { developmentMode: ['plan'] }, 'default', 1, true],
        ['AC5: "PLAN" (uppercase)', { developmentMode: 'PLAN' }, 'default', 1, true],
        ['AC5: "Adaptive" (mixed case)', { developmentMode: 'Adaptive' }, 'default', 1, true],
        ['AC5: " plan" (leading whitespace is not normalized)', { developmentMode: ' plan' }, 'default', 1, true],
        ['AC5: "plan " (trailing whitespace is not normalized)', { developmentMode: 'plan ' }, 'default', 1, true]
    ];

    CASES.forEach(function (c) {
        test(c[0] + ' → mode ' + c[2] + ', ' + c[3] + ' warning(s)', function () {
            var resolved = developmentMode.resolveDevelopmentMode(c[1]);
            assert.equal(resolved.mode, c[2], 'resolved mode');
            assert.equal(resolved.warnings.length, c[3], 'warning count');
            assert.equal(resolved.present, c[4], 'present flag');
        });
    });
});

suite('gh-1435 UT — invalid-value warnings name the offending value', function () {
    test('AC3/AC5: one warning, quotes the raw value, names the fallback', function () {
        [
            ['adaptive?', '"adaptive?"'],
            [123, '123'],
            ['', '""'],
            [null, 'null'],
            ['PLAN', '"PLAN"']
        ].forEach(function (entry) {
            var resolved = developmentMode.resolveDevelopmentMode({ developmentMode: entry[0] });
            assert.equal(resolved.warnings.length, 1, 'exactly one warning for ' + JSON.stringify(entry[0]));
            assert.contains(resolved.warnings[0], entry[1], 'warning names the offending value');
            assert.contains(resolved.warnings[0], 'default', 'warning names the fallback');
        });
    });

    test('I1 safety: exotic values never throw the resolver', function () {
        [
            { developmentMode: { deeply: { nested: ['x', 2] } } },
            { developmentMode: [1, [2, [3]]] },
            { developmentMode: 0 },
            { developmentMode: false }
        ].forEach(function (cp) {
            var resolved = developmentMode.resolveDevelopmentMode(cp);
            assert.equal(resolved.mode, 'default', 'always resolves default');
            assert.equal(resolved.warnings.length, 1, 'exactly one warning');
        });
    });
});

// ── UT: developmentModeConfig parsed permissively (AC4) ──────────────────────

suite('gh-1435 UT — developmentModeConfig parsed permissively (AC4)', function () {
    test('absent / null / {} → zero warnings (silent steady state)', function () {
        assert.equal(developmentMode.validateDevelopmentModeConfig({}).length, 0, 'absent key');
        assert.equal(developmentMode.validateDevelopmentModeConfig({ developmentModeConfig: null }).length, 0, 'null reads as unset');
        assert.equal(developmentMode.validateDevelopmentModeConfig({ developmentModeConfig: {} }).length, 0, 'empty object');
    });

    test('known slice keys (plan/adaptive/spawn) with object values → zero warnings', function () {
        var warnings = developmentMode.validateDevelopmentModeConfig({
            developmentModeConfig: {
                plan: { maxPlanningSteps: 5 },
                adaptive: { mode: 'balanced' },
                spawn: { maxAgents: 2 }
            }
        });
        assert.equal(warnings.length, 0, 'epic-spec slice keys with object values are accepted');
    });

    test('unknown keys ignored with ONE aggregated warning naming them', function () {
        var warnings = developmentMode.validateDevelopmentModeConfig({
            developmentModeConfig: { whatever: { a: 1 }, anotherThing: 2 }
        });
        assert.equal(warnings.length, 1, 'one aggregated warning');
        assert.contains(warnings[0], 'whatever', 'names the first unknown key');
        assert.contains(warnings[0], 'anotherThing', 'names the second unknown key');
    });

    test('wrong-typed slice value logged-and-ignored, names the key path', function () {
        [
            { plan: 'not-an-object' },
            { adaptive: 42 },
            { spawn: ['a'] }
        ].forEach(function (sliceBlock) {
            var warnings = developmentMode.validateDevelopmentModeConfig({ developmentModeConfig: sliceBlock });
            assert.equal(warnings.length, 1, 'one warning for ' + JSON.stringify(sliceBlock));
            var key = Object.keys(sliceBlock)[0];
            assert.contains(warnings[0], 'developmentModeConfig.' + key, 'names the key path');
        });
    });

    test('non-object container itself → one warning naming the value', function () {
        [
            ['junk', '"junk"'],
            [42, '42'],
            [true, 'true'],
            [['x'], '"x"']
        ].forEach(function (entry) {
            var warnings = developmentMode.validateDevelopmentModeConfig({ developmentModeConfig: entry[0] });
            assert.equal(warnings.length, 1, 'one warning for container ' + JSON.stringify(entry[0]));
            assert.contains(warnings[0], entry[1], 'names the offending container value');
        });
    });

    test('combined: invalid mode + junk config → mode default, two warnings total', function () {
        var applied = developmentMode.applyDevelopmentMode({
            developmentMode: 'adaptive?',
            developmentModeConfig: { nope: 1 }
        });
        assert.equal(applied.mode, 'default', 'invalid mode falls back');
        assert.equal(applied.warnings.length, 2, 'one mode warning + one config warning');
    });
});

// ── UT: applyDevelopmentMode logging contract ────────────────────────────────

suite('gh-1435 UT — applyDevelopmentMode logging contract', function () {
    test('AC1: absent field → zero output (log byte-identical to pre-change engine)', function () {
        var captured = captureConsole(function () {
            var applied = developmentMode.applyDevelopmentMode({});
            assert.equal(applied.mode, 'default');
            assert.equal(applied.warnings.length, 0);
            assert.notOk(applied.present);
        });
        assert.equal(captured.warns.length, 0, 'no warnings');
        assert.equal(captured.logs.length, 0, 'no log lines at all');
    });

    test('AC2: "plan" → observability line developmentMode=plan, no warnings', function () {
        var captured = captureConsole(function () {
            developmentMode.applyDevelopmentMode({ developmentMode: 'plan' });
        });
        assert.equal(captured.warns.length, 0, 'valid mode never warns');
        var modeLines = captured.logs.filter(function (l) { return l.indexOf('developmentMode=') === 0; });
        assert.equal(modeLines.length, 1, 'exactly one observability line');
        assert.equal(modeLines[0], 'developmentMode=plan', 'line format is developmentMode=<resolved>');
    });

    test('AC3: invalid → exactly one warn naming the value + developmentMode=default line', function () {
        var captured = captureConsole(function () {
            developmentMode.applyDevelopmentMode({ developmentMode: 'adaptive?' });
        });
        assert.equal(captured.warns.length, 1, 'exactly one warning');
        assert.contains(captured.warns[0], 'adaptive?', 'warning names the value');
        var modeLines = captured.logs.filter(function (l) { return l.indexOf('developmentMode=') === 0; });
        assert.equal(modeLines.length, 1, 'resolved mode still logged');
        assert.equal(modeLines[0], 'developmentMode=default', 'resolved fallback visible');
    });

    test('AC4: config junk only (no mode key) → warnings but NO developmentMode= line', function () {
        var captured = captureConsole(function () {
            developmentMode.applyDevelopmentMode({ developmentModeConfig: { nope: 1 } });
        });
        assert.equal(captured.warns.length, 1, 'config warning logged');
        assert.equal(captured.logs.filter(function (l) { return l.indexOf('developmentMode=') === 0; }).length, 0,
            'mode key absent → no observability line (AC1 golden log discipline)');
    });
});

// ── IT: real config-reading path (initDevelopmentContext) ────────────────────

// Real tracker layer loaded WITH the same tool mocks as the script under test
// (mirrors test_developTicketAndCreatePR.js's loaders — mocks shadow globals
// only inside the module they are passed to).
function trackersWith(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

function trackerSlotWith(mocks) {
    return loadModule(
        'js/common/trackerSlot.js',
        makeRequire({ './trackers.js': trackersWith(mocks) }),
        mocks || {}
    );
}

// Fixed minimal project config — the leg's config-reading path is exercised
// through the REAL configLoader module (createScm / resolveBranchName /
// formatTemplate stay real) without reading this repo's own .dmtools/config.js.
var legConfigLoader = Object.assign({}, configLoaderModule, {
    loadProjectConfig: function () {
        return { git: { baseBranch: 'main', branchPrefix: { development: 'ai/' } } };
    }
});

// Default dmtools-global mocks for the leg module. Callers merge their own
// mocks on top — the overrides win, mirroring makeRequire's shadowing rule.
function legBaseMocks() {
    return {
        cli_execute_command: function () { return ''; },
        jira_post_comment: function () { },
        jira_move_to_status: function () { },
        jira_remove_label: function () { }
    };
}

// Static require map for the leg module. The REAL developmentMode module is
// wired here — the IT path must exercise the actual resolver. trackers /
// trackerSlot stay mockable per-test via legRequireOverrides(_m).
function legRequireMap() {
    return {
        './common/toolchainSummary.js': { withToolchainLine: function (t) { return t; } },
        './common/jiraHelpers.js': { extractTicketKey: function (key) { return key; } },
        './common/pullRequest.js': { cleanCommandOutput: function (output) { return (output || '').trim(); } },
        './common/submodules.js': {},
        './common/feedbackLoop.js': {
            runQualityGates: function () { return { success: true }; },
            runPolicyGates: function () { return { success: true }; },
            runPostPublishGates: function () { return { success: true }; },
            resumeAgent: function () { return { attempted: false }; },
            resumeOnceForMissingResponse: function () { return { attempted: false }; }
        },
        './common/autoStart.js': { triggerSmIfIdle: function () { } },
        './common/outputFiles.js': { readOutputFile: function () { return null; }, hasOutputFile: function () { return false; } },
        './common/needsInput.js': loadModule('js/common/needsInput.js'),
        './cacheToReleases.js': {},
        './common/gitStaging.js': loadModule('js/common/gitStaging.js'),
        './common/quotaCircuitBreaker.js': loadModule('js/common/quotaCircuitBreaker.js'),
        // REAL developmentMode module — the IT path must exercise the actual resolver.
        './common/developmentMode.js': loadModule('js/common/developmentMode.js'),
        './configLoader.js': legConfigLoader,
        './config.js': configModule,
        './common/tokenUsageComment.js': { postTokenUsageComments: function () { } },
        './common/commentMarkup.js': loadModule('js/common/commentMarkup.js',
            makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }))
    };
}

// Mock-dependent require overrides — shadow the static map per test.
function legRequireOverrides(_m) {
    return {
        './common/trackers.js': trackersWith(_m),
        './common/trackerSlot.js': trackerSlotWith(_m)
    };
}

// The mock/require tables live in the named helpers above: crap4js counts
// lambda bodies toward the enclosing function, so keeping them inline left
// loadLegModule at CC 3 / CRAP 8.5 — over the repo's CRAP ratchet (8).
function loadLegModule(mocks) {
    var _m = Object.assign(legBaseMocks(), mocks || {});
    var legRequires = Object.assign({}, legRequireMap(), legRequireOverrides(_m));
    return loadModule('js/developTicketAndCreatePR.js', makeRequire(legRequires), _m);
}

function legParams(customParams, shape) {
    var ticket = { key: 'PROJ-1', fields: { summary: 'it', description: '', labels: [] } };
    if (shape === 'standalone') {
        // JSRunner execution: ticket + customParams nested in jobParams.
        return { jobParams: Object.assign({ ticket: ticket }, { customParams: customParams }) };
    }
    // Teammate execution: jobParams and ticket are sibling top-level keys.
    return { ticket: ticket, metadata: { contextId: 'story_development' }, jobParams: { customParams: customParams } };
}

suite('gh-1435 IT — dev leg config-reading path (initDevelopmentContext)', function () {
    test('AC2: teammate-shaped params with "plan" → ctx.developmentMode.mode=plan, logged', function () {
        var mod = loadLegModule();
        var captured = captureConsole(function () {
            var ctx = mod.initDevelopmentContext(legParams({ developmentMode: 'plan' }));
            assert.equal(ctx.developmentMode.mode, 'plan', 'resolved mode on the leg context');
            assert.equal(ctx.developmentMode.warnings.length, 0, 'no warnings');
        });
        assert.ok(captured.logs.indexOf('developmentMode=plan') !== -1,
            'observability line in the leg log — got: ' + JSON.stringify(captured.logs));
    });

    test('AC2: standalone JSRunner-shaped params resolve identically', function () {
        var mod = loadLegModule();
        var ctx = mod.initDevelopmentContext(legParams({ developmentMode: 'adaptive' }, 'standalone'));
        assert.equal(ctx.developmentMode.mode, 'adaptive');
    });

    test('AC3: junk value through the leg path → default + one warning, nothing throws', function () {
        var mod = loadLegModule();
        var captured = captureConsole(function () {
            var ctx = mod.initDevelopmentContext(legParams({ developmentMode: 123 }));
            assert.equal(ctx.developmentMode.mode, 'default');
            assert.equal(ctx.developmentMode.warnings.length, 1);
        });
        assert.equal(captured.warns.length, 1, 'warning on the run log only');
        assert.contains(captured.warns[0], '123');
    });

    test('AC1: no field → default, zero warnings, no developmentMode log line', function () {
        var mod = loadLegModule();
        var captured = captureConsole(function () {
            var ctx = mod.initDevelopmentContext(legParams({ removeLabel: 'x' }));
            assert.equal(ctx.developmentMode.mode, 'default');
            assert.equal(ctx.developmentMode.warnings.length, 0);
        });
        assert.equal(captured.warns.length, 0, 'silent');
        assert.equal(captured.logs.filter(function (l) { return l.indexOf('developmentMode=') === 0; }).length, 0,
            'no observability line when the field is absent');
    });

    test('AC4: junk developmentModeConfig through the leg path → warning, leg proceeds', function () {
        var mod = loadLegModule();
        var captured = captureConsole(function () {
            var ctx = mod.initDevelopmentContext(legParams({
                developmentMode: 'adaptive',
                developmentModeConfig: { totallyUnknown: { x: 1 }, plan: 'wrong-type' }
            }));
            assert.equal(ctx.developmentMode.mode, 'adaptive', 'mode still resolves');
            assert.equal(ctx.developmentMode.warnings.length, 2, 'unknown-key warning + wrong-type warning');
        });
        assert.equal(captured.warns.length, 2, 'warnings on the run log only');
    });

    test('I2 inertness: the field changes NOTHING else on the leg context', function () {
        var mod = loadLegModule();
        var without = mod.initDevelopmentContext(legParams({ removeLabel: 'x' }));
        var withAdaptive = mod.initDevelopmentContext(legParams({ removeLabel: 'x', developmentMode: 'adaptive' }));
        // Strip exactly what the knob itself adds — ctx.developmentMode on
        // BOTH runs plus the mirrored raw key on the params. Every OTHER ctx
        // field must be identical: the mode reaches no behavior path.
        delete without.developmentMode;
        delete withAdaptive.developmentMode;
        delete withAdaptive.customParams.developmentMode;
        delete withAdaptive.jobParams.customParams.developmentMode;
        assert.deepEqual(withAdaptive, without,
            'ctx identical modulo the developmentMode key — the mode reaches no behavior path');
    });
});

// ── REG: every repo workflow config through the resolver ─────────────────────

suite('gh-1435 REG — all repo workflow configs resolve default + stay silent', function () {
    test('golden: no existing workflow config sets developmentMode → zero drift', function () {
        var listing = cli_execute_command({ command: 'git ls-files "*.json"' }) || '';
        var files = listing.split('\n').map(function (l) { return String(l).trim(); }).filter(function (l) {
            return /^[A-Za-z0-9._-]+\.json$/.test(l);
        });
        assert.ok(files.length >= 30, 'expected the full root config set, got ' + files.length + ': ' + JSON.stringify(files));

        var checked = 0;
        files.forEach(function (f) {
            var cfg;
            try { cfg = JSON.parse(file_read({ path: f })); } catch (e) { return; }
            var cp = (cfg.jobParams && cfg.jobParams.customParams) ||
                     (cfg.params && cfg.params.jobParams && cfg.params.jobParams.customParams) ||
                     (cfg.params && cfg.params.customParams);
            if (!cp) return;
            checked++;
            var captured = captureConsole(function () {
                var applied = developmentMode.applyDevelopmentMode(cp);
                assert.equal(applied.mode, 'default', f + ' must resolve default');
                assert.equal(applied.warnings.length, 0, f + ' must produce zero warnings');
                assert.notOk(applied.present, f + ' must not carry a developmentMode key');
            });
            assert.equal(captured.warns.length, 0, f + ' must stay silent');
            assert.equal(captured.logs.length, 0, f + ' must add zero log lines (byte-identical logs)');
        });
        assert.ok(checked >= 10, 'walked ' + checked + ' configs with customParams — expected the full set');
    });
});
