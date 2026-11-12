/**
 * Unit tests for gh-1437 — the adaptive calibration harness
 * (js/adaptiveCalibrationHarness.js): the mechanical part of the owner-
 * approved calibration method. It replays the adaptive decision rule over
 * an expert-labeled issue sample and emits the decision-table artifact
 * (per issue: signals, would-decide, expert label, agree/disagree) the
 * owner reviews; disagreement cases drive config-only threshold tweaks,
 * which re-run the replay.
 *
 * Layers:
 *  UT  — pure core: CLI parsing (fail-fast on unknown flags / bad values),
 *        threshold resolution over the engine defaults, decision rows,
 *        summary math (agreement / precision / recall, invalid labels
 *        excluded), deterministic markdown rendering (golden pin).
 *  IT  — main() end to end over a mocked fs: sample read → artifact write,
 *        plus the error paths (missing sample → usage exit 1, unreadable /
 *        malformed sample → exit 2).
 *
 * The harness is a Node-only dev tool (like js/agentDocGenerator.js): it is
 * not referenced by any agent config, so it never enters the dmtools pack.
 * All engine logic it uses comes from js/common/developmentModeAdaptive.js
 * (the SAME extractor and decision the legs run) — covered in
 * test_developmentModeAdaptive.js.
 */

function makeMockFs(initialFiles) {
    var files = Object.assign({}, initialFiles);
    var calls = { read: [], write: [] };
    return {
        calls: calls,
        files: files,
        fs: {
            readFileSync: function (p, enc) {
                calls.read.push(String(p));
                if (files[String(p)] !== undefined) return files[String(p)];
                throw new Error('ENOENT: ' + p);
            },
            writeFileSync: function (p, content) {
                calls.write.push({ path: String(p), content: String(content) });
                files[String(p)] = String(content);
                return true;
            },
            existsSync: function (p) { return files[String(p)] !== undefined; }
        }
    };
}

function loadHarnessWith(mockFs) {
    var adaptive = loadModule('js/common/developmentMode.js');
    var plan = loadModule('js/common/developmentModePlan.js',
        makeRequire({ './developmentMode.js': adaptive }));
    var adaptiveCore = loadModule('js/common/developmentModeAdaptive.js',
        makeRequire({ './developmentMode.js': adaptive, './developmentModePlan.js': plan }));
    return loadModule('js/adaptiveCalibrationHarness.js',
        makeRequire({
            'fs': mockFs,
            './common/developmentModeAdaptive.js': adaptiveCore
        }));
}

// ── fixtures ─────────────────────────────────────────────────────────────────

var SAMPLE_JSON = JSON.stringify({
    issues: [
        { key: 'gh-101', title: 'Fix typo in README', body: "Change 'recieve' to 'receive'.", label: 'default' },
        {
            key: 'gh-102', title: 'Add export pipeline',
            body: '## Scope\n1. CSV exporter\n2. PDF renderer\n3. Email digest builder',
            label: 'plan'
        },
        {
            key: 'gh-103', title: 'Settings copy tweak',
            body: '## Acceptance criteria\n- name editable\n- avatar croppable',
            label: 'plan'
        },
        { key: 'gh-104', title: 'Mystery ticket', body: 'unclear', label: 'maybe' }
    ]
});

// gh-101: modules 0 / bullets 0 / tokens 12 (floor(49/4)) → would default, expert default → agree
// gh-102: modules 3 → would plan, expert plan → agree
// gh-103: bullets 2 → would default, expert plan → DISAGREEMENT
// gh-104: invalid label → excluded from stats, listed separately

// ── UT: CLI parsing ──────────────────────────────────────────────────────────

suite('gh-1437 harness UT — parseCliArgs', function () {
    test('sample path positional + defaults', function () {
        var args = harness.parseCliArgs(['sample.json']);
        assert.equal(args.error, null, 'no parse error');
        assert.equal(args.sample, 'sample.json');
        assert.equal(args.out, 'adaptive-decision-table.md', 'default artifact path');
        assert.deepEqual(args.thresholdOverrides, {}, 'no overrides by default');
    });

    test('--out override rides through', function () {
        var args = harness.parseCliArgs(['sample.json', '--out', 'reports/table.md']);
        assert.equal(args.out, 'reports/table.md');
        assert.equal(args.error, null);
    });

    test('threshold overrides ride through as integers', function () {
        var args = harness.parseCliArgs(['sample.json',
            '--planIfModulesAtLeast', '3',
            '--planIfAcceptanceBulletsAtLeast', '7',
            '--planIfBodyTokensAtLeast', '1200']);
        assert.deepEqual(args.thresholdOverrides, {
            planIfModulesAtLeast: 3,
            planIfAcceptanceBulletsAtLeast: 7,
            planIfBodyTokensAtLeast: 1200
        });
        assert.equal(args.error, null);
    });

    test('missing sample path → flagged for the usage exit', function () {
        var args = harness.parseCliArgs([]);
        assert.equal(args.sample, null, 'no sample');
        assert.equal(args.error, null, 'not a parse error — the usage path');
    });

    test('unknown flag → parse error (a typoed threshold must not silently use defaults)', function () {
        var args = harness.parseCliArgs(['sample.json', '--planIfModulesAtLeast2', '3']);
        assert.ok(args.error, 'error present');
        assert.contains(args.error, '--planIfModulesAtLeast2', 'error names the offending flag');
    });

    test('flag missing its value → parse error', function () {
        var args = harness.parseCliArgs(['sample.json', '--out']);
        assert.ok(args.error, 'error present');
        assert.contains(args.error, '--out', 'error names the flag');
    });

    test('non-integer / negative threshold value → parse error', function () {
        [['abc', 'not a number'], ['2.5', 'fractional'], ['-1', 'negative']].forEach(function (c) {
            var args = harness.parseCliArgs(['sample.json', '--planIfModulesAtLeast', c[0]]);
            assert.ok(args.error, 'error for ' + c[1]);
            assert.contains(args.error, 'planIfModulesAtLeast', 'error names the flag');
        });
    });

    test('a second positional → parse error', function () {
        var args = harness.parseCliArgs(['sample.json', 'another.json']);
        assert.ok(args.error, 'error present');
        assert.contains(args.error, 'another.json', 'error names the extra positional');
    });
});

// ── UT: threshold resolution + decision rows ─────────────────────────────────

suite('gh-1437 harness UT — thresholds + decision rows', function () {
    test('no overrides → engine defaults (2 / 5 / 800)', function () {
        var t = harness.resolveRunThresholds({});
        assert.deepEqual(t, { planIfModulesAtLeast: 2, planIfAcceptanceBulletsAtLeast: 5, planIfBodyTokensAtLeast: 800 });
    });

    test('overrides merge over the defaults (partial override keeps the rest)', function () {
        var t = harness.resolveRunThresholds({ planIfModulesAtLeast: 4 });
        assert.equal(t.planIfModulesAtLeast, 4, 'overridden');
        assert.equal(t.planIfAcceptanceBulletsAtLeast, 5, 'default kept');
        assert.equal(t.planIfBodyTokensAtLeast, 800, 'default kept');
    });

    test('decision rows carry signals, would-decide, expert label and agreement', function () {
        var rows = harness.buildDecisionRows([
            { key: 'a', title: 'T', body: '1. one\n2. two', label: 'plan' },
            { key: 'b', title: 'T', body: 'typo fix', label: 'default' },
            { key: 'c', title: 'T', body: '- x', label: 'weird' }
        ], harness.resolveRunThresholds({}));
        assert.equal(rows.length, 3, 'one row per issue');
        assert.equal(rows[0].key, 'a');
        assert.deepEqual(rows[0].signals, { modules: 2, acceptanceBullets: 0, bodyTokens: 3 });
        assert.equal(rows[0].would, 'plan');
        assert.equal(rows[0].expert, 'plan');
        assert.equal(rows[0].agree, true);
        assert.equal(rows[1].would, 'default');
        assert.equal(rows[1].agree, true);
        assert.equal(rows[2].agree, null, 'invalid label → not an agreement verdict');
        assert.equal(rows[2].expert, 'weird', 'the raw label is still shown');
    });

    test('missing key/title/body degrade permissively (never throw)', function () {
        var rows = harness.buildDecisionRows([{}, { title: 'only title', label: 'default' }], harness.resolveRunThresholds({}));
        assert.equal(rows[0].key, '(issue #1)', 'synthetic key for a key-less entry');
        assert.deepEqual(rows[0].signals, { modules: 0, acceptanceBullets: 0, bodyTokens: 0 });
        assert.equal(rows[1].key, '(issue #2)');
    });
});

// ── UT: summary math ─────────────────────────────────────────────────────────

suite('gh-1437 harness UT — computeSummary', function () {
    test('confusion counts + rates over a mixed sample (invalid labels excluded)', function () {
        var rows = harness.buildDecisionRows([
            { key: 'tp', title: 'T', body: '1. a\n2. b', label: 'plan' },
            { key: 'tn', title: 'T', body: 'typo', label: 'default' },
            { key: 'fn', title: 'T', body: '## Acceptance criteria\n- a\n- b\n- c', label: 'plan' },
            { key: 'fp', title: 'T', body: new Array(811).join('prose '), label: 'default' },
            { key: 'bad', title: 'T', body: 'x', label: 'maybe' }
        ], harness.resolveRunThresholds({}));
        var s = harness.computeSummary(rows);
        assert.equal(s.total, 5);
        assert.equal(s.valid, 4, 'invalid label excluded');
        assert.equal(s.invalidLabels, 1);
        assert.equal(s.expertPlan, 2);
        assert.equal(s.expertDefault, 2);
        assert.equal(s.wouldPlan, 2, 'tp + fp');
        assert.equal(s.tp, 1, 'would plan, expert plan');
        assert.equal(s.fp, 1, 'would plan, expert default');
        assert.equal(s.tn, 1, 'would default, expert default');
        assert.equal(s.fn, 1, 'would default, expert plan');
        assert.equal(s.agreeCount, 2);
        assert.equal(s.precision, 0.5, 'tp / (tp + fp)');
        assert.equal(s.recall, 0.5, 'tp / (tp + fn)');
    });

    test('zero denominators degrade to null (rendered n/a, never NaN)', function () {
        var s = harness.computeSummary(harness.buildDecisionRows([
            { key: 'a', title: 'T', body: 'typo', label: 'default' }
        ], harness.resolveRunThresholds({ planIfBodyTokensAtLeast: 100000 })));
        assert.equal(s.wouldPlan, 0);
        assert.equal(s.tp + s.fp, 0);
        assert.equal(s.precision, null, 'no would-plan predictions → precision undefined');
        assert.equal(s.recall, null, 'no expert-plan issues → recall undefined');
    });

    test('empty sample → zeros and nulls', function () {
        var s = harness.computeSummary([]);
        assert.equal(s.total, 0);
        assert.equal(s.valid, 0);
        assert.equal(s.precision, null);
        assert.equal(s.recall, null);
    });
});

// ── UT: markdown rendering (deterministic, golden) ───────────────────────────

suite('gh-1437 harness UT — renderDecisionTable', function () {
    test('golden artifact: table, disagreements and invalid-label sections', function () {
        var thresholds = harness.resolveRunThresholds({});
        var rows = harness.buildDecisionRows([
            { key: 'gh-101', title: 'Fix typo in README', body: "Change 'recieve' to 'receive'.", label: 'default' },
            { key: 'gh-102', title: 'Add export pipeline', body: '## Scope\n1. CSV exporter\n2. PDF renderer\n3. Email digest builder', label: 'plan' },
            { key: 'gh-103', title: 'Settings copy tweak', body: '## Acceptance criteria\n- name editable\n- avatar croppable', label: 'plan' },
            { key: 'gh-104', title: 'Mystery ticket', body: 'unclear', label: 'maybe' }
        ], thresholds);
        var summary = harness.computeSummary(rows);
        var md = harness.renderDecisionTable('fixtures/sample.json', thresholds, rows, summary);
        var expected = [
            '# Adaptive calibration — decision table',
            '',
            "Replay of the `developmentMode=adaptive` routing rule over an expert-labeled sample.",
            'Rule: plan if modules >= 2 OR acceptanceBullets >= 5 OR bodyTokens >= 800; else default.',
            '',
            '- Sample: fixtures/sample.json (4 issues — expert plan 2, expert default 1, invalid labels 1)',
            '- Would-plan: 1 · agreement: 2/3 (67%) · precision: 1 · recall: 0.5',
            '',
            '| issue | modules | acceptanceBullets | bodyTokens | would-decide | expert | agree |',
            '|---|---:|---:|---:|---|---|:---:|',
            '| gh-101 | 0 | 0 | 12 | default | default | yes |',
            '| gh-102 | 3 | 0 | 21 | plan | plan | yes |',
            '| gh-103 | 0 | 2 | 19 | default | plan | **no** |',
            '| gh-104 | 0 | 0 | 5 | default | maybe | — |',
            '',
            '## Disagreements (1)',
            '',
            '- gh-103: would **default**, expert **plan** (modules=0, acceptanceBullets=2, bodyTokens=19)',
            '',
            '## Invalid labels (1)',
            '',
            '- gh-104: label "maybe" is not one of: plan, default',
            ''
        ].join('\n');
        assert.equal(md, expected, 'the artifact is deterministic and review-ready');
    });

    test('no disagreements → no disagreements section; no invalid labels → no invalid section', function () {
        var thresholds = harness.resolveRunThresholds({});
        var rows = harness.buildDecisionRows([
            { key: 'a', title: 'T', body: '1. a\n2. b', label: 'plan' },
            { key: 'b', title: 'T', body: 'typo', label: 'default' }
        ], thresholds);
        var md = harness.renderDecisionTable('s.json', thresholds, rows, harness.computeSummary(rows));
        assert.equal(md.indexOf('## Disagreements'), -1, 'all agree → no section');
        assert.equal(md.indexOf('## Invalid labels'), -1, 'all labels valid → no section');
        assert.contains(md, '| a |', 'rows still render');
    });

    test('empty sample renders the header with n/a stats', function () {
        var thresholds = harness.resolveRunThresholds({});
        var rows = harness.buildDecisionRows([], thresholds);
        var md = harness.renderDecisionTable('s.json', thresholds, rows, harness.computeSummary(rows));
        assert.contains(md, 'agreement: 0/0 (n/a)', 'agreement degrades honestly');
        assert.contains(md, 'precision: n/a', 'precision degrades honestly');
        assert.contains(md, 'recall: n/a', 'recall degrades honestly');
    });

    test('rendered thresholds reflect the run configuration (config-only replays)', function () {
        var thresholds = harness.resolveRunThresholds({ planIfModulesAtLeast: 4 });
        var rows = harness.buildDecisionRows([
            { key: 'a', title: 'T', body: '1. a\n2. b\n3. c', label: 'plan' }
        ], thresholds);
        var md = harness.renderDecisionTable('s.json', thresholds, rows, harness.computeSummary(rows));
        assert.contains(md, 'Rule: plan if modules >= 4 OR acceptanceBullets >= 5 OR bodyTokens >= 800; else default.',
            'the rule line names the thresholds actually used');
        assert.contains(md, '| a | 3 | 0 | 4 | default | plan | **no** |',
            'modules 3 under a threshold of 4 → would default (the disagreement the owner reviews)');
    });
});

// ── IT: main() end to end over a mocked fs ───────────────────────────────────

suite('gh-1437 harness IT — main() over a mocked fs', function () {
    test('sample read → decision table written to the --out path, exit 0', function () {
        var mock = makeMockFs({ 'sample.json': SAMPLE_JSON });
        var h = loadHarnessWith(mock.fs);
        var code = h.main(['sample.json', '--out', 'outputs/adaptive-decision-table.md']);
        assert.equal(code, 0, 'exit 0');
        assert.deepEqual(mock.calls.read, ['sample.json'], 'exactly the sample read');
        assert.equal(mock.calls.write.length, 1, 'exactly the artifact written');
        assert.equal(mock.calls.write[0].path, 'outputs/adaptive-decision-table.md');
        assert.contains(mock.calls.write[0].content, '# Adaptive calibration — decision table');
        assert.contains(mock.calls.write[0].content, '- gh-103: would **default**, expert **plan**', 'disagreement surfaced');
    });

    test('missing sample path → usage on stdout, exit 1', function () {
        var mock = makeMockFs({});
        var h = loadHarnessWith(mock.fs);
        var logs = [];
        var orig = console.log;
        console.log = function (m) { logs.push(String(m)); };
        try {
            var code = h.main([]);
        } finally {
            console.log = orig;
        }
        assert.equal(code, 1, 'usage exit code');
        assert.equal(mock.calls.write.length, 0, 'nothing written');
        assert.ok(logs.join('\n').indexOf('adaptiveCalibrationHarness.js') !== -1, 'usage names the script');
    });

    test('unreadable sample → error exit 2, nothing written', function () {
        var mock = makeMockFs({});
        var h = loadHarnessWith(mock.fs);
        var code = h.main(['missing.json']);
        assert.equal(code, 2);
        assert.equal(mock.calls.write.length, 0);
    });

    test('malformed sample JSON → error exit 2', function () {
        var mock = makeMockFs({ 'bad.json': '{ not json' });
        var h = loadHarnessWith(mock.fs);
        var code = h.main(['bad.json']);
        assert.equal(code, 2);
        assert.equal(mock.calls.write.length, 0);
    });

    test('sample without an issues array → error exit 2', function () {
        var mock = makeMockFs({ 'wrong.json': '{"tickets": []}' });
        var h = loadHarnessWith(mock.fs);
        var code = h.main(['wrong.json']);
        assert.equal(code, 2);
        assert.equal(mock.calls.write.length, 0);
    });

    test('unknown flag → parse error exit 2 (typo protection)', function () {
        var mock = makeMockFs({ 'sample.json': SAMPLE_JSON });
        var h = loadHarnessWith(mock.fs);
        var code = h.main(['sample.json', '--planIfModulesAtLeest', '3']);
        assert.equal(code, 2);
        assert.equal(mock.calls.write.length, 0);
    });
});
