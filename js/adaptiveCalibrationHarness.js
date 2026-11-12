// ── gh-1437: adaptive calibration harness — replay the rule over the sample ──
//
// The mechanical part of the owner-approved calibration method (gh-1437):
// replay the `developmentMode=adaptive` threshold rule over an expert-
// labeled issue sample and emit the DECISION TABLE the owner reviews —
// per issue: signals, would-decide, expert label, agree/disagree. There is
// deliberately no hard numeric precision/recall bar: disagreement cases
// drive config-only threshold tweaks, which re-run the replay.
//
// Labels are expert-approximate by design (the corpus is the dmtools-agents
// local issue history; better ground truth does not exist for this repo) —
// this harness only implements the mechanical replay, never the labeling.
//
// The engine logic is the SAME code the legs run — the pure extractor and
// decision from js/common/developmentModeAdaptive.js — so a replay here is
// faithful to production routing.
//
// Usage (Node-only dev tool, like js/agentDocGenerator.js — it is not
// referenced by any agent config and never enters the dmtools pack):
//
//   node js/adaptiveCalibrationHarness.js <sample.json> [options]
//
//   --out <path>                     decision-table artifact path
//                                    (default: adaptive-decision-table.md)
//   --planIfModulesAtLeast <n>       override the modules threshold
//   --planIfAcceptanceBulletsAtLeast <n>   override the bullets threshold
//   --planIfBodyTokensAtLeast <n>    override the token threshold
//
// Sample format (<sample.json>):
//
//   { "issues": [
//       { "key": "gh-101", "title": "...", "body": "...", "label": "plan" },
//       { "key": "gh-102", "title": "...", "body": "...", "label": "default" }
//   ] }
//
// `label` is the expert verdict: exactly "plan" or "default" (anything else
// is flagged invalid and excluded from the stats). Missing title/body read
// as empty; a missing key renders as "(issue #N)".

var fs = require('fs');
var developmentModeAdaptive = require('./common/developmentModeAdaptive.js');

var DEFAULT_OUT = 'adaptive-decision-table.md';
var VALID_LABELS = ['plan', 'default'];
var THRESHOLD_FLAGS = {
    '--planIfModulesAtLeast': 'planIfModulesAtLeast',
    '--planIfAcceptanceBulletsAtLeast': 'planIfAcceptanceBulletsAtLeast',
    '--planIfBodyTokensAtLeast': 'planIfBodyTokensAtLeast'
};

var USAGE = [
    'Usage: node js/adaptiveCalibrationHarness.js <sample.json> [options]',
    '',
    'Replays the developmentMode=adaptive routing rule over an expert-labeled',
    'issue sample and writes the decision table the owner reviews.',
    '',
    'Options:',
    '  --out <path>                           artifact path (default ' + DEFAULT_OUT + ')',
    '  --planIfModulesAtLeast <n>             modules threshold override',
    '  --planIfAcceptanceBulletsAtLeast <n>   acceptance-bullets threshold override',
    '  --planIfBodyTokensAtLeast <n>          body-tokens threshold override'
].join('\n');

// ── CLI parsing (fail-fast — a typoed threshold must not silently run) ───────

function isNonNegativeIntegerText(text) {
    return /^[0-9]+$/.test(String(text));
}

/**
 * @returns {{sample: string|null, out: string, thresholdOverrides: Object, error: string|null}}
 */
function parseCliArgs(argv) {
    var args = { sample: null, out: DEFAULT_OUT, thresholdOverrides: {}, error: null };
    var positionals = [];
    for (var i = 0; i < argv.length; i++) {
        var token = String(argv[i]);
        if (token.indexOf('--') === 0) {
            var flag = token;
            var value = argv[i + 1];
            if (flag === '--out') {
                if (value === undefined || String(value).indexOf('--') === 0) {
                    args.error = 'option ' + flag + ' expects a path value';
                    return args;
                }
                args.out = String(value);
                i++;
                continue;
            }
            var key = THRESHOLD_FLAGS[flag];
            if (!key) {
                args.error = 'unknown option ' + flag;
                return args;
            }
            if (value === undefined || !isNonNegativeIntegerText(value)) {
                args.error = 'option ' + flag + ' expects a non-negative integer, got ' +
                    (value === undefined ? '(missing)' : String(value));
                return args;
            }
            args.thresholdOverrides[key] = parseInt(value, 10);
            i++;
            continue;
        }
        positionals.push(token);
    }
    if (positionals.length > 1) {
        args.error = 'unexpected extra argument: ' + positionals[1] + ' — pass exactly one sample path';
        return args;
    }
    args.sample = positionals.length === 1 ? positionals[0] : null;
    return args;
}

/** The thresholds this replay runs with: overrides merged over engine defaults. */
function resolveRunThresholds(thresholdOverrides) {
    var merged = {};
    Object.keys(developmentModeAdaptive.DEFAULT_ADAPTIVE_THRESHOLDS).forEach(function (key) {
        merged[key] = developmentModeAdaptive.DEFAULT_ADAPTIVE_THRESHOLDS[key];
    });
    Object.keys(thresholdOverrides || {}).forEach(function (key) {
        merged[key] = thresholdOverrides[key];
    });
    return merged;
}

// ── decision rows + summary ──────────────────────────────────────────────────

function isValidLabel(label) {
    return typeof label === 'string' && VALID_LABELS.indexOf(label) !== -1;
}

/**
 * One decision row per sample issue: extracted signals, the would-decision
 * the CURRENT thresholds produce, the expert label and the agreement verdict
 * (null when the label is invalid — the row is excluded from the stats).
 */
function buildDecisionRows(issues, thresholds) {
    var rows = [];
    var list = Array.isArray(issues) ? issues : [];
    for (var i = 0; i < list.length; i++) {
        var issue = list[i] || {};
        var key = issue.key !== undefined && issue.key !== null && String(issue.key).trim() !== ''
            ? String(issue.key)
            : '(issue #' + (i + 1) + ')';
        var signals = developmentModeAdaptive.extractSignals(issue.title, issue.body);
        var decision = developmentModeAdaptive.decideAdaptiveMode(signals, thresholds);
        var expert = issue.label;
        rows.push({
            key: key,
            signals: signals,
            would: decision.mode,
            expert: isValidLabel(expert) ? expert : String(expert === undefined || expert === null ? '(none)' : expert),
            agree: isValidLabel(expert) ? decision.mode === expert : null
        });
    }
    return rows;
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

/**
 * Agreement + confusion-matrix stats over the VALID rows. Zero denominators
 * degrade to null (rendered "n/a") — the ticket pins no numeric bar; the
 * numbers exist to inform the owner's table review, never to gate it.
 */
function computeSummary(rows) {
    var summary = {
        total: rows.length,
        valid: 0,
        invalidLabels: 0,
        expertPlan: 0,
        expertDefault: 0,
        wouldPlan: 0,
        agreeCount: 0,
        tp: 0,
        fp: 0,
        tn: 0,
        fn: 0,
        precision: null,
        recall: null
    };
    rows.forEach(function (row) {
        if (row.agree === null) {
            summary.invalidLabels++;
            return;
        }
        summary.valid++;
        if (row.expert === 'plan') summary.expertPlan++;
        else summary.expertDefault++;
        if (row.would === 'plan') {
            summary.wouldPlan++;
            if (row.expert === 'plan') summary.tp++;
            else summary.fp++;
        } else if (row.expert === 'default') {
            summary.tn++;
        } else {
            summary.fn++;
        }
        if (row.agree) summary.agreeCount++;
    });
    if (summary.tp + summary.fp > 0) summary.precision = round2(summary.tp / (summary.tp + summary.fp));
    if (summary.tp + summary.fn > 0) summary.recall = round2(summary.tp / (summary.tp + summary.fn));
    return summary;
}

// ── markdown rendering (deterministic — no timestamps) ───────────────────────

function formatRate(value) {
    return value === null ? 'n/a' : String(value);
}

function formatAgreement(summary) {
    if (summary.valid === 0) return '0/0 (n/a)';
    var pct = Math.round((100 * summary.agreeCount) / summary.valid);
    return summary.agreeCount + '/' + summary.valid + ' (' + pct + '%)';
}

function ruleLine(thresholds) {
    return 'Rule: plan if modules >= ' + thresholds.planIfModulesAtLeast +
        ' OR acceptanceBullets >= ' + thresholds.planIfAcceptanceBulletsAtLeast +
        ' OR bodyTokens >= ' + thresholds.planIfBodyTokensAtLeast + '; else default.';
}

function renderRow(row) {
    return '| ' + row.key + ' | ' + row.signals.modules + ' | ' + row.signals.acceptanceBullets +
        ' | ' + row.signals.bodyTokens + ' | ' + row.would + ' | ' + row.expert +
        ' | ' + (row.agree === null ? '—' : (row.agree ? 'yes' : '**no**')) + ' |';
}

function renderDisagreement(row) {
    return '- ' + row.key + ': would **' + row.would + '**, expert **' + row.expert + '** (' +
        developmentModeAdaptive.describeSignals(row.signals) + ')';
}

function renderInvalidLabel(row) {
    return '- ' + row.key + ': label "' + row.expert + '" is not one of: ' + VALID_LABELS.join(', ');
}

/**
 * The decision-table artifact. Sections appear only when they have content;
 * the output carries no timestamps so re-runs over the same sample and
 * thresholds stay byte-identical (diffable review artifacts).
 */
function renderDecisionTable(samplePath, thresholds, rows, summary) {
    var lines = [
        '# Adaptive calibration — decision table',
        '',
        'Replay of the `developmentMode=adaptive` routing rule over an expert-labeled sample.',
        ruleLine(thresholds),
        '',
        '- Sample: ' + samplePath + ' (' + summary.total + ' issues — expert plan ' + summary.expertPlan +
            ', expert default ' + summary.expertDefault + ', invalid labels ' + summary.invalidLabels + ')',
        '- Would-plan: ' + summary.wouldPlan + ' · agreement: ' + formatAgreement(summary) +
            ' · precision: ' + formatRate(summary.precision) + ' · recall: ' + formatRate(summary.recall),
        '',
        '| issue | modules | acceptanceBullets | bodyTokens | would-decide | expert | agree |',
        '|---|---:|---:|---:|---|---|:---:|'
    ];
    rows.forEach(function (row) {
        lines.push(renderRow(row));
    });
    var disagreements = rows.filter(function (row) { return row.agree === false; });
    if (disagreements.length > 0) {
        lines.push('');
        lines.push('## Disagreements (' + disagreements.length + ')');
        lines.push('');
        disagreements.forEach(function (row) {
            lines.push(renderDisagreement(row));
        });
    }
    var invalid = rows.filter(function (row) { return row.agree === null; });
    if (invalid.length > 0) {
        lines.push('');
        lines.push('## Invalid labels (' + invalid.length + ')');
        lines.push('');
        invalid.forEach(function (row) {
            lines.push(renderInvalidLabel(row));
        });
    }
    lines.push('');
    return lines.join('\n');
}

// ── the run (thin IO shell over the pure core) ───────────────────────────────

function readSample(samplePath) {
    var raw = fs.readFileSync(samplePath, 'utf8');
    var parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.issues)) {
        throw new Error('sample must be a JSON object with an "issues" array: ' + samplePath);
    }
    return parsed.issues;
}

/**
 * One replay: read the sample, decide, write the artifact. Returns the
 * process exit code (0 on success). Throws propagate to main() — the caller
 * maps read/parse failures to exit 2.
 */
function runReplay(args) {
    var issues = readSample(args.sample);
    var thresholds = resolveRunThresholds(args.thresholdOverrides);
    var rows = buildDecisionRows(issues, thresholds);
    var summary = computeSummary(rows);
    var artifact = renderDecisionTable(args.sample, thresholds, rows, summary);
    fs.writeFileSync(args.out, artifact);
    console.log('adaptive calibration: ' + rows.length + ' issue(s) replayed · agreement ' +
        formatAgreement(summary) + ' · would-plan ' + summary.wouldPlan + ' → ' + args.out);
    return 0;
}

/**
 * Entry point (Node): returns the exit code — 0 replay written, 1 usage,
 * 2 parse/sample error. `args` are the READY arguments (no node/script
 * prefix) — the CLI guard passes process.argv.slice(2), tests pass arrays.
 */
function main(args) {
    var parsed = parseCliArgs(Array.isArray(args) ? args : []);
    if (parsed.error) {
        console.error('adaptiveCalibrationHarness: ' + parsed.error);
        console.log(USAGE);
        return 2;
    }
    if (!parsed.sample) {
        console.log(USAGE);
        return 1;
    }
    try {
        return runReplay(parsed);
    } catch (e) {
        console.error('adaptiveCalibrationHarness: could not replay ' + parsed.sample + ': ' + e);
        return 2;
    }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    process.exit(main(process.argv.slice(2)));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        USAGE: USAGE,
        DEFAULT_OUT: DEFAULT_OUT,
        VALID_LABELS: VALID_LABELS,
        parseCliArgs: parseCliArgs,
        resolveRunThresholds: resolveRunThresholds,
        buildDecisionRows: buildDecisionRows,
        computeSummary: computeSummary,
        renderDecisionTable: renderDecisionTable,
        runReplay: runReplay,
        main: main
    };
}
