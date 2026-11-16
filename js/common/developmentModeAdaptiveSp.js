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
// What stays from the pre-leg era: the plan-protocol contract itself
// (js/common/developmentModePlan.js — the appendix text is materialized for
// adaptive legs too, for on-demand escalation reads; its cliPrompts entry
// stays gated to explicit plan mode so an adaptive leg's base prompt carries
// only the SP block). The signal extractor + its calibration harness are
// deleted outright — SP replaced them everywhere (owner decision).
//
// The decision record is one JSON line in the leg's outputs (the established
// per-leg outputs convention, like response.md/concerns.md): the agent writes
// only what it holds at decision time — sp/threshold/mode/reason, outcome
// finalized at completion. model and legs_spent are NOT agent-written: the
// harness emits the model in its per-leg usage line and the leg count is
// derived offline by counting those lines.

var developmentMode = require('./developmentMode.js');

var SP_APPENDIX_ENTRY_ID = 'developmentModeAdaptiveSp';
var SP_APPENDIX_FILE_PATH = '.dmtools/development-mode-sp-appendix.md';
var SP_APPENDIX_PROMPT_PATH = './' + SP_APPENDIX_FILE_PATH;
var SP_APPENDIX_CONDITION_PATH = 'agents/js/conditions/isDevelopmentModeAdaptiveSp.js';
var SP_APPENDIX_EXCLUDE_COMMENT =
    '# Development-mode SP appendix — runtime materialization, never committed';

var DEFAULT_SP_THRESHOLD = 3;
var SP_THRESHOLD_MIN = 1;
var SP_THRESHOLD_MAX = 13;

var PLAN_APPENDIX_RUNTIME_PATH = '.dmtools/development-mode-plan-appendix.md';
var SCOPE_ESTIMATE_RELATIVE_PATH = 'outputs/<KEY>/scope_estimate.json';
var VALID_ESTIMATE_MODES = ['plan', 'default'];

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ── shadowMode (gh-1437 carry-over) ─────────────────────────────────────────
// Strict boolean true enables it; absent/null/false keep it off; wrong-typed
// reads as false (strict boolean true is the shadow test). A
// shadow adaptive leg NEVER materializes: shadow means "log the intent, act
// nothing" — the SP block would change the prompt, and that is an action.

function isShadowMode(customParams) {
    var config = isPlainObject(customParams) && isPlainObject(customParams.developmentModeConfig)
        ? customParams.developmentModeConfig.adaptive
        : null;
    return !!(isPlainObject(config) && config.shadowMode === true);
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
    if (!hasRequiredEstimateFields(record)) return null;
    return estimateRecordWithoutExtras(record);
}

// The strict half of the parse: sp and mode are load-bearing (the label
// decision reads mode; the threshold comparison reads sp) — any violation
// here voids the whole record.
function hasRequiredEstimateFields(record) {
    return isPlainObject(record)
        && isIntegerInRange(record.sp, 1, Number.MAX_SAFE_INTEGER)
        && VALID_ESTIMATE_MODES.indexOf(record.mode) !== -1;
}

// The lenient half: optional fields ride along only when well-typed.
function estimateRecordWithoutExtras(record) {
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
        '- Story points, fibonacci scale: 1 / 2 / 3 / 5 / 8 / 13 / 21 / ... — the scale is',
        '  open-ended: if the work feels bigger than the top value you named, keep going.',
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
    var resolution = resolveSpAppendix(customParams);
    if (!resolution.active) {
        return { ok: false, active: false, path: null, overridden: false, error: null, warnings: resolution.warnings, logLines: resolution.logLines };
    }
    if (resolution.error) {
        return { ok: false, active: true, path: SP_APPENDIX_FILE_PATH, overridden: false, error: resolution.error, warnings: resolution.warnings, logLines: [] };
    }
    var written = writeSpAppendix(resolution.threshold, io);
    return {
        ok: written.ok,
        active: true,
        path: written.path,
        overridden: false,
        error: written.error,
        warnings: resolution.warnings,
        logLines: written.ok ? resolution.logLines : []
    };
}

/**
 * Resolve the SP appendix WITHOUT writing: mode/shadow gating, threshold
 * resolution, text build. Lets the preCli caller validate BOTH appendices
 * before committing either write — a failed plan resolution must not leave
 * an orphan SP file behind (the old fail-fast invariant, gh-1503).
 * @returns {{active: boolean, threshold: number|null, text: string|null,
 *            error: string|null, warnings: string[], logLines: string[]}}
 */
function resolveSpAppendix(customParams) {
    var mode = developmentMode.resolveDevelopmentMode(customParams).mode;
    if (mode !== 'adaptive') {
        return { active: false, threshold: null, text: null, error: null, warnings: [], logLines: [] };
    }
    if (isShadowMode(customParams)) {
        return {
            active: false, threshold: null, text: null, error: null, warnings: [],
            logLines: ['📝 developmentMode=adaptive: SP routing would be active but shadow mode — nothing materialized']
        };
    }
    var resolved = resolveSpThreshold(customParams);
    return {
        active: true,
        threshold: resolved.threshold,
        text: spAppendixText(resolved.threshold),
        error: null,
        warnings: resolved.warning ? [resolved.warning] : [],
        logLines: ['📝 developmentMode=adaptive: SP routing active (threshold ' +
            resolved.threshold + ') → ' + SP_APPENDIX_FILE_PATH]
    };
}

// ── preCli step (owned here so the pinned setup module stays complexity-flat) ──
// Resolve BOTH appendices before committing either write: a failed plan
// resolution must not leave an orphan SP file behind (fail-fast carries to
// the caller — the setup step reports it like a plan-mode setup failure).
// The plan appendix on an adaptive leg is an ESCALATION READ target (the SP
// block points the agent at the file when it self-selects plan); the plan
// cliPrompts entry itself stays gated to explicit plan mode.

/**
 * The adaptive preCli step: materialize the SP appendix + the plan escalation
 * read, seed the git local excludes for both, flush warnings + log lines.
 * @param {Object} customParams the leg's customParams
 * @returns {{ok: boolean, active: boolean, path: string|null, overridden: boolean,
 *            error: string|null, warnings: string[], logLines: string[]}}
 * @throws when either appendix cannot be materialized (config-error class).
 */
function runPreCliAdaptiveAppendixStep(customParams, planModule, branchSetupMod) {
    var resolution = resolveSpAppendix(customParams);
    logResolutionEvents(resolution);
    if (!resolution.active) {
        return { ok: false, active: false, path: null, overridden: false, error: null, warnings: resolution.warnings, logLines: resolution.logLines };
    }
    // resolve-both-before-write: a failed plan override must not strand an SP file
    var planResolved = resolvePlanOverrideOrThrow(customParams, planModule);
    var spPath = commitAppendixWrite(function () { return writeSpAppendix(resolution.threshold); });
    var planPath = commitAppendixWrite(function () { return planModule.writeResolvedAppendix(planResolved); });
    seedAppendixExcludes(planModule, branchSetupMod);
    return {
        ok: true,
        active: true,
        path: spPath,
        overridden: false,
        error: null,
        warnings: resolution.warnings,
        logLines: resolution.logLines
    };
}

function logResolutionEvents(resolution) {
    (resolution.warnings || []).forEach(function (w) { console.warn(w); });
    (resolution.logLines || []).forEach(function (l) { console.log(l); });
}

// gh-1435 override semantics: an unresolvable plan appendix aborts the leg
// BEFORE any materialization (its warnings still surface first).
function resolvePlanOverrideOrThrow(customParams, planModule) {
    var planResolved = planModule.resolveAppendixSource(customParams);
    if (planResolved && planResolved.error) {
        (planResolved.warnings || []).forEach(function (w) { console.warn(w); });
        throw new Error(planResolved.error);
    }
    return planResolved;
}

// One appendix write with its fail-fast error translation (the caller turns
// the throw into the leg's setup error, naming the offending path).
function commitAppendixWrite(write) {
    var written = write();
    if (!written.ok) {
        throw new Error(written.error);
    }
    return written.path;
}

function seedAppendixExcludes(planModule, branchSetupMod) {
    branchSetupMod.ensureGitInfoExclude(
        planModule.PLAN_APPENDIX_FILE_PATH,
        planModule.PLAN_APPENDIX_EXCLUDE_COMMENT,
        'Could not exclude the plan-mode appendix from git:'
    );
    branchSetupMod.ensureGitInfoExclude(
        SP_APPENDIX_FILE_PATH,
        SP_APPENDIX_EXCLUDE_COMMENT,
        'Could not exclude the scope-estimate appendix from git:'
    );
    console.log('📝 developmentMode=adaptive: plan appendix materialized for escalation reads → ' +
        planModule.PLAN_APPENDIX_FILE_PATH);
}

// ── escalation visibility (the decision record is the durable signal; the
// label only makes escalated legs visible to humans) ────────────────────────

var DEV_PLAN_ESCALATED_LABEL = 'dev-plan-escalated';

/**
 * Stamp the informational label when the record says the leg self-selected
 * plan. Pure over its arguments — the leg action owns the tracker access and
 * the degrade-not-fail wrapper.
 * @param {Object|null} record a parseScopeEstimateRecord result
 * @param {function(string)} addLabel the tracker add-label call
 * @returns {boolean} true when the label was due
 */
function stampDevPlanEscalatedFromRecord(record, addLabel) {
    if (!record || record.mode !== 'plan') return false;
    addLabel(DEV_PLAN_ESCALATED_LABEL);
    return true;
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
        SP_APPENDIX_EXCLUDE_COMMENT: SP_APPENDIX_EXCLUDE_COMMENT,
        PLAN_APPENDIX_RUNTIME_PATH: PLAN_APPENDIX_RUNTIME_PATH,
        SCOPE_ESTIMATE_RELATIVE_PATH: SCOPE_ESTIMATE_RELATIVE_PATH,
        DEFAULT_SP_THRESHOLD: DEFAULT_SP_THRESHOLD,
        resolveSpThreshold: resolveSpThreshold,
        parseScopeEstimateRecord: parseScopeEstimateRecord,
        spAppendixText: spAppendixText,
        resolveSpAppendix: resolveSpAppendix,
        writeSpAppendix: writeSpAppendix,
        materializeSpAppendix: materializeSpAppendix,
        spAppendixCliEntry: spAppendixCliEntry,
        runPreCliAdaptiveAppendixStep: runPreCliAdaptiveAppendixStep,
        stampDevPlanEscalatedFromRecord: stampDevPlanEscalatedFromRecord,
        DEV_PLAN_ESCALATED_LABEL: DEV_PLAN_ESCALATED_LABEL
    };
}
