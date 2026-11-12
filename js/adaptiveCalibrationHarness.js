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

function isFlagToken(token) {
    return String(token).indexOf('--') === 0;
}

function isUnusableFlagValue(value) {
    return value === undefined || String(value).indexOf('--') === 0;
}

function applyOutFlag(args, value) {
    if (isUnusableFlagValue(value)) {
        args.error = 'option --out expects a path value';
        return 0;
    }
    args.out = String(value);
    return 1;
}

function thresholdValueError(flag, value) {
    return 'option ' + flag + ' expects a non-negative integer, got ' +
        (value === undefined ? '(missing)' : String(value));
}

function isValidThresholdValue(value) {
    return value !== undefined && isNonNegativeIntegerText(value);
}

function applyThresholdValue(args, key, flag, value) {
    if (!isValidThresholdValue(value)) {
        args.error = thresholdValueError(flag, value);
        return 0;
    }
    args.thresholdOverrides[key] = parseInt(value, 10);
    return 1;
}

function applyThresholdFlag(args, flag, value) {
    var key = THRESHOLD_FLAGS[flag];
    if (!key) {
        args.error = 'unknown option ' + flag;
        return 0;
    }
    return applyThresholdValue(args, key, flag, value);
}

function applyFlagArg(args, flag, value) {
    if (flag === '--out') return applyOutFlag(args, value);
    return applyThresholdFlag(args, flag, value);
}

function parseOneArg(args, token, value, positionals) {
    if (isFlagToken(token)) return applyFlagArg(args, token, value);
    positionals.push(token);
    return 0;
}

function nextParseStep(args, argv, i, positionals) {
    if (args.error) return 0;
    return parseOneArg(args, String(argv[i]), argv[i + 1], positionals);
}

function extraPositionalError(positionals) {
    if (positionals.length > 1) {
        return 'unexpected extra argument: ' + positionals[1] + ' — pass exactly one sample path';
    }
    return null;
}

function samplePathOf(positionals) {
    if (positionals.length === 1) return positionals[0];
    return null;
}

function finalizePositionals(args, positionals) {
    if (args.error) return;
    args.error = extraPositionalError(positionals);
    args.sample = samplePathOf(positionals);
}

/**
 * @returns {{sample: string|null, out: string, thresholdOverrides: Object, error: string|null}}
 */
function parseCliArgs(argv) {
    var args = { sample: null, out: DEFAULT_OUT, thresholdOverrides: {}, error: null };
    var positionals = [];
    for (var i = 0; i < argv.length; i++) {
        i += nextParseStep(args, argv, i, positionals);
    }
    finalizePositionals(args, positionals);
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

function isAbsent(value) {
    return value === undefined || value === null;
}

function normalizedIssue(issue) {
    return issue || {};
}

function isBlankKey(key) {
    return isAbsent(key) || String(key).trim() === '';
}

function issueKeyLabel(issue, index) {
    if (isBlankKey(issue.key)) return '(issue #' + (index + 1) + ')';
    return String(issue.key);
}

function validOrRenderedLabel(expert) {
    if (isValidLabel(expert)) return expert;
    return String(expert);
}

function expertLabelOf(expert) {
    return isAbsent(expert) ? '(none)' : validOrRenderedLabel(expert);
}

function agreementOf(decision, expert) {
    if (!isValidLabel(expert)) return null;
    return decision.mode === expert;
}

function decisionRowFor(issue, index, thresholds) {
    var signals = developmentModeAdaptive.extractSignals(issue.title, issue.body);
    var decision = developmentModeAdaptive.decideAdaptiveMode(signals, thresholds);
    var expert = issue.label;
    return {
        key: issueKeyLabel(issue, index),
        signals: signals,
        would: decision.mode,
        expert: expertLabelOf(expert),
        agree: agreementOf(decision, expert)
    };
}

/**
 * One decision row per sample issue: extracted signals, the would-decision
 * the CURRENT thresholds produce, the expert label and the agreement verdict
 * (null when the label is invalid — the row is excluded from the stats).
 */
function buildDecisionRows(issues, thresholds) {
    var list = Array.isArray(issues) ? issues : [];
    return list.map(function (issue, i) {
        return decisionRowFor(normalizedIssue(issue), i, thresholds);
    });
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

function invalidRow(row) {
    return row.agree === null;
}

function tallyExpertSide(summary, row) {
    if (row.expert === 'plan') summary.expertPlan++;
    else summary.expertDefault++;
}

function tallyWouldPlan(summary, row) {
    summary.wouldPlan++;
    if (row.expert === 'plan') summary.tp++;
    else summary.fp++;
}

function tallyNotPlan(summary, row) {
    if (row.expert === 'default') summary.tn++;
    else summary.fn++;
}

function tallyConfusion(summary, row) {
    if (row.would === 'plan') tallyWouldPlan(summary, row);
    else tallyNotPlan(summary, row);
}

function tallyValidRow(summary, row) {
    tallyExpertSide(summary, row);
    tallyConfusion(summary, row);
    if (row.agree) summary.agreeCount++;
}

function rateOrNull(numerator, denominator) {
    if (numerator + denominator > 0) return round2(numerator / (numerator + denominator));
    return null;
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
        if (invalidRow(row)) {
            summary.invalidLabels++;
            return;
        }
        summary.valid++;
        tallyValidRow(summary, row);
    });
    summary.precision = rateOrNull(summary.tp, summary.fp);
    summary.recall = rateOrNull(summary.tp, summary.fn);
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
