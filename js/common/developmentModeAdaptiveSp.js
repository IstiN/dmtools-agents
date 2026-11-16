// ── gh-1503: adaptive mode selection — in-leg story-point estimate ──────────
//
// gh-1437 routed adaptive legs pre-leg: a deterministic rule over ticket text
// (js/common/developmentModeAdaptive.js) decided plan-vs-default before the
// agent launched. Calibration against closed-issue replays pinned a precision
// ceiling for text signals (~0.61): verbose-small tickets inflate, under-
// specified tickets are invisible, and text cannot separate design-bearing
// work from mechanical sweeps — the exact distinction where planning helps.
//
// gh-1503 moves the decision AFTER the survey, into the agent that read the
// code. The adaptive leg carries a scope-estimate appendix (this module's
// runtime file) that instructs it to estimate the work in story points, write
// outputs/<KEY>/scope_estimate.json, and self-select: sp >= threshold
// (config: developmentModeConfig.adaptive.planThresholdSp, default 3 —
// calibrated by a paired direct/plan run: crossover at SP 3) → follow the
// plan protocol (the plan appendix file, materialized alongside); below it →
// direct execution, no plan artifacts.
//
// What stays from gh-1437: the plan-protocol contract itself
// (js/common/developmentModePlan.js — the appendix text is materialized for
// adaptive legs too, for on-demand escalation reads; its cliPrompts entry
// stays gated to explicit plan mode so an adaptive leg's base prompt carries
// only the SP block). The signal extractor + calibration harness stay for
// legacy consumers; THIS repo's adaptive routing no longer uses them.
//
// The decision record is one JSON line in the leg's outputs (the established
// per-leg outputs convention, like response.md/concerns.md): the agent writes
// only what it holds at decision time — sp/threshold/mode/reason, outcome
// finalized at completion. model and legs_spent are NOT agent-written: the
// harness emits the model in its per-leg usage line and the leg count is
// derived offline by counting those lines.

var developmentModeAdaptive = require('./developmentModeAdaptive.js');

var SP_APPENDIX_ENTRY_ID = 'developmentModeAdaptiveSp';
var SP_APPENDIX_FILE_PATH = '.dmtools/development-mode-sp-appendix.md';
var SP_APPENDIX_PROMPT_PATH = './' + SP_APPENDIX_FILE_PATH;
var SP_APPENDIX_CONDITION_PATH = 'agents/js/conditions/isDevelopmentModeAdaptiveSp.js';

var DEFAULT_SP_THRESHOLD = 3;
var SP_THRESHOLD_MIN = 1;
var SP_THRESHOLD_MAX = 13;

var PLAN_APPENDIX_RUNTIME_PATH = '.dmtools/development-mode-plan-appendix.md';
var SCOPE_ESTIMATE_RELATIVE_PATH = 'outputs/<KEY>/scope_estimate.json';
var VALID_ESTIMATE_MODES = ['plan', 'default'];

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ── Threshold resolution ────────────────────────────────────────────────────
// developmentModeConfig.adaptive.planThresholdSp: absent ⇒ default (silent —
// absence is the supported steady state, same philosophy as the gh-1435 knob).
// Present-but-invalid (wrong type, non-integer, out of 1..13) ⇒ warn + default.
// Nothing throws; the leg never fails because of this field.

function isIntegerInRange(value, min, max) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value
        && value >= min && value <= max;
}

/**
 * Resolve the SP routing threshold from customParams.
 * @returns {{threshold: number, warning: string|null}} warning is null for the
 * silent paths (absent key, valid value) and a one-line log message otherwise.
 */
function resolveSpThreshold(customParams) {
    var config = isPlainObject(customParams) && isPlainObject(customParams.developmentModeConfig)
        ? customParams.developmentModeConfig.adaptive
        : null;
    if (!isPlainObject(config) || !('planThresholdSp' in config)) {
        return { threshold: DEFAULT_SP_THRESHOLD, warning: null };
    }
    var raw = config.planThresholdSp;
    if (isIntegerInRange(raw, SP_THRESHOLD_MIN, SP_THRESHOLD_MAX)) {
        return { threshold: raw, warning: null };
    }
    var shown = raw === null ? 'null' : (typeof raw === 'string' ? '"' + raw + '"' : String(raw));
    return {
        threshold: DEFAULT_SP_THRESHOLD,
        warning: 'developmentModeConfig.adaptive.planThresholdSp invalid (' + shown +
            ') — using the default ' + DEFAULT_SP_THRESHOLD
    };
}

// ── Decision-record parsing ─────────────────────────────────────────────────
// Strict where it matters (sp, mode), lenient where it cannot hurt (reason,
// outcome, threshold). Any violation ⇒ null — consumers fail safe to
// "no record" (no label, no routing consequence), never throw.

function parseScopeEstimateRecord(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    var record;
    try {
        record = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!isPlainObject(record)) return null;
    if (!isIntegerInRange(record.sp, 1, SP_THRESHOLD_MAX)) return null;
    if (VALID_ESTIMATE_MODES.indexOf(record.mode) === -1) return null;
    var parsed = { sp: record.sp, mode: record.mode };
    if (isIntegerInRange(record.threshold, SP_THRESHOLD_MIN, SP_THRESHOLD_MAX)) {
        parsed.threshold = record.threshold;
    }
    if (typeof record.reason === 'string' && record.reason.trim()) {
        parsed.reason = record.reason;
    }
    if (record.outcome === 'completed' || record.outcome === 'blocked') {
        parsed.outcome = record.outcome;
    }
    return parsed;
}

// ── The scope-estimate appendix (engine default text) ───────────────────────
// Self-contained for the direct branch; the escalation branch hands off to the
// plan appendix file (materialized alongside) so the plan contract has a
// single source of truth. gh-1436's plan contract owns outputs/<KEY>/plan.md
// + .dmtools/plan-snapshot.md; this block never redefines them.

function spAppendixText(threshold) {
    return [
        '# Scope estimate & working mode (adaptive dev leg)',
        '',
        'Before your FIRST code edit: survey the ticket and the relevant code, then',
        'estimate the work in story points and fix your working mode for this leg.',
        '',
        '## Estimate',
        '- Story points, fibonacci scale: 1 / 2 / 3 / 5 / 8 / 13.',
        '- Estimate EFFORT, RISK and UNCERTAINTY — not file count. A sweeping mechanical',
        '  rename is low; a small change into undocumented behavior is high.',
        '- Structural surprises belong in a higher estimate: data/schema migrations,',
        '  changes touching a second repository, unknown integration surfaces.',
        '- Uncertainty resolves UP: when torn between two values, take the larger.',
        '',
        '## Record',
        'Write exactly one JSON object to `' + SCOPE_ESTIMATE_RELATIVE_PATH + '`',
        '(<KEY> = the ticket key):',
        '',
        '    {"sp": <int>, "threshold": <int>, "mode": "plan" | "default", "reason": "<one short sentence>"}',
        '',
        '## Decide (threshold: ' + threshold + ' SP)',
        '- sp >= threshold → work BY A PLAN for the rest of this leg: read',
        '  `' + PLAN_APPENDIX_RUNTIME_PATH + '` now and follow its protocol (numbered',
        '  tasks with what+verify, the committed snapshot, per-task checkpoints).',
        '  Never demote back to direct mode within the same leg.',
        '- sp < threshold → implement directly; no plan artifacts.',
        '- Scope grows mid-work and a re-estimate reaches the threshold → raise it:',
        '  write plan.md, follow the plan protocol from that point, update the',
        '  record\'s "mode" to "plan" (and "sp" to the new estimate).',
        '',
        '## Complete honestly',
        'Before writing `outputs/<KEY>/response.md`, set the record\'s final',
        '"outcome": "completed" | "blocked". A plan-mode leg reports completion only',
        'when its plan tasks are done — or honestly marked blocked/deferred in plan.md.'
    ].join('\n') + '\n';
}

// ── Materialization ─────────────────────────────────────────────────────────
// Shape mirrors materializePlanAppendix exactly: {ok, active, path, overridden,
// error, warnings}. Inactive (non-adaptive) modes are a zero-IO no-op; a write
// failure is ok:false + an honest error naming the path (the preCli caller
// turns it into the leg's fail-fast setup error). `overridden` is always false
// — the SP appendix is engine text only (the threshold is interpolated, the
// workflow tunes it via planThresholdSp, not by shipping prose).

function writeSpAppendix(threshold, io) {
    var write = (io && io.file_write) || file_write;
    try {
        write({ path: SP_APPENDIX_FILE_PATH, content: spAppendixText(threshold) });
    } catch (e) {
        return {
            ok: false,
            path: SP_APPENDIX_FILE_PATH,
            overridden: false,
            error: 'developmentMode=adaptive: could not write the scope-estimate appendix to "' +
                SP_APPENDIX_FILE_PATH + '": ' + e
        };
    }
    return { ok: true, path: SP_APPENDIX_FILE_PATH, overridden: false, error: null };
}

/**
 * Materialize the scope-estimate appendix for adaptive legs.
 * @returns {{ok: boolean, active: boolean, path: string|null, overridden: boolean,
 *            error: string|null, warnings: string[], logLines: string[]}}
 */
function materializeSpAppendix(customParams, io) {
    var mode = developmentModeAdaptive.resolvedDevelopmentMode(customParams);
    if (mode !== 'adaptive') {
        return { ok: false, active: false, path: null, overridden: false, error: null, warnings: [], logLines: [] };
    }
    var resolved = resolveSpThreshold(customParams);
    var warnings = resolved.warning ? [resolved.warning] : [];
    var written = writeSpAppendix(resolved.threshold, io);
    var logLines = written.ok
        ? ['📝 developmentMode=adaptive: SP routing active (threshold ' +
            resolved.threshold + ') → ' + written.path]
        : [];
    return {
        ok: written.ok,
        active: true,
        path: written.path,
        overridden: false,
        error: written.error,
        warnings: warnings,
        logLines: logLines
    };
}

/** The conditional cliPrompts entry for adaptive legs (see the condition script). */
function spAppendixCliEntry() {
    return {
        id: SP_APPENDIX_ENTRY_ID,
        prompt: SP_APPENDIX_PROMPT_PATH,
        condition: SP_APPENDIX_CONDITION_PATH
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SP_APPENDIX_ENTRY_ID: SP_APPENDIX_ENTRY_ID,
        SP_APPENDIX_FILE_PATH: SP_APPENDIX_FILE_PATH,
        SP_APPENDIX_PROMPT_PATH: SP_APPENDIX_PROMPT_PATH,
        SP_APPENDIX_CONDITION_PATH: SP_APPENDIX_CONDITION_PATH,
        PLAN_APPENDIX_RUNTIME_PATH: PLAN_APPENDIX_RUNTIME_PATH,
        SCOPE_ESTIMATE_RELATIVE_PATH: SCOPE_ESTIMATE_RELATIVE_PATH,
        DEFAULT_SP_THRESHOLD: DEFAULT_SP_THRESHOLD,
        resolveSpThreshold: resolveSpThreshold,
        parseScopeEstimateRecord: parseScopeEstimateRecord,
        spAppendixText: spAppendixText,
        materializeSpAppendix: materializeSpAppendix,
        spAppendixCliEntry: spAppendixCliEntry
    };
}
