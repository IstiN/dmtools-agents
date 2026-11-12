// ── gh-1437: developmentMode=adaptive — signal-driven plan/default routing ───
//
// When the resolved development mode is "adaptive" (the gh-1435 knob), the
// dev leg does not hand-pick plan mode: the ENGINE decides plan-vs-default
// from measurable ticket signals, with thresholds that are configurable,
// calibrated offline (js/adaptiveCalibrationHarness.js) and verified in
// shadow mode before ever acting.
//
// Decision rule (v1, adaptive-only — owner-approved, 2026-11-10):
//   plan  if  modules             >= planIfModulesAtLeast             (default 2)
//         OR acceptanceBullets    >= planIfAcceptanceBulletsAtLeast   (default 5)
//         OR bodyTokens           >= planIfBodyTokensAtLeast          (default 800)
//   else default
//
// Config surface (params.customParams.developmentModeConfig.adaptive):
//   { "planIfModulesAtLeast": 2, "planIfAcceptanceBulletsAtLeast": 5,
//     "planIfBodyTokensAtLeast": 800, "shadowMode": false }
// Resolved permissively (same philosophy as the plan appendixFile): absent /
// null values read as defaults, wrong-typed values yield ONE warning and the
// default — never a throw. The gh-1435 aggregated validator already warns on
// a non-object adaptive slice at applyDevelopmentMode time, so this module
// stays silent for a garbled block (no duplicate warnings).
//
// Mode semantics (owner, 2026-11-10): "plan" ignores this rule entirely
// (always plan); the rule exists only for "adaptive". "default" never sees
// this code path (invariant P1 from gh-1436 stays: zero IO, zero output).
//
// Signal extraction is a PURE function over ticket title+body — same text
// ⇒ same decision (invariant A1, golden-tested). bodyTokens is the chars/4
// backstop estimate; no tokenizer dependency is added (non-goal).
//
// shadowMode: true → compute + LOG the decision ("adaptive: would plan
// (signals: modules=3) but shadow mode") WITHOUT acting — the rollout safe
// mode. Shadow legs additionally clean stale appendix state so their prompt
// stays byte-identical to a default-mode leg.
//
// Invariant A2: adaptive never spawns sub-agents — this module never reads
// developmentModeConfig.spawn (that wiring is a later sub-issue, off by
// default).
//
// The routing carrier is the SAME runtime appendix path the plan mode uses
// (.dmtools/development-mode-plan-appendix.md): a routed-to-plan leg
// materializes it (reusing the plan module's override machinery verbatim),
// a routed-to-default / shadow leg removes any stale copy, so after the
// preCli setup the file's existence IS the decision record. The conditional
// cliPrompts entry in the dev leg configs therefore needs NO new entry for
// adaptive — the condition script (js/conditions/isDevelopmentModePlan.js)
// grew adaptive arms instead.

var developmentMode = require('./developmentMode.js');
var developmentModePlan = require('./developmentModePlan.js');

var DEFAULT_ADAPTIVE_THRESHOLDS = {
    planIfModulesAtLeast: 2,
    planIfAcceptanceBulletsAtLeast: 5,
    planIfBodyTokensAtLeast: 800
};
var ADAPTIVE_THRESHOLD_KEYS = [
    'planIfModulesAtLeast',
    'planIfAcceptanceBulletsAtLeast',
    'planIfBodyTokensAtLeast'
];

// Line-shape classifiers. Kept anchored and documented — the calibration
// harness replays EXACTLY these rules over the labeled sample, so any change
// here must re-run the calibration replay.

// Markdown ATX heading ("## Title"); requires the space after the hashes,
// like markdown itself does.
var ATX_HEADING_RE = /^[ \t]*#{1,6}[ \t]+/;

// A heading (or bare label line) that OPENS an acceptance section: any ATX
// heading mentioning "acceptance" or a standalone "AC" word, or a bare
// bold/plain label line that IS exactly the acceptance label (colons may sit
// inside or outside the bold markers: "**Acceptance criteria:**" /
// "**Acceptance criteria**:" / "Acceptance criteria:").
var AC_HEADING_WORD_RE = /acceptance|(^|[^a-z0-9])ac([^a-z0-9]|$)/i;
var AC_BARE_LABEL_RE = /^[ \t]*(?:\*\*|__)?[ \t]*(?:acceptance(?:[ \t]+criterias?)?|ac)[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$/i;

// List-item shapes: bullets ("- ", "* ", "+ ") and ordered items ("1. ", "1) ").
var BULLET_LINE_RE = /^[ \t]*[-*+][ \t]+\S/;
var NUMBERED_LINE_RE = /^[ \t]*[0-9]+[.)][ \t]+\S/;

// "module N" mentions in either word order — "Module 3", "modules #4",
// "module: 5", "3-module", "2 modules". Digits only (deterministic).
var MODULE_NUM_AFTER_RE = /\bmodules?\b[ \t]*(?:#[ \t]*|[.,:][ \t]*)?([0-9]+)/gi;
var MODULE_NUM_BEFORE_RE = /\b([0-9]+)[ \t]*-?[ \t]*\bmodules?\b/gi;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ── signal extraction (pure, A1) ─────────────────────────────────────────────

function isAtxHeading(line) {
    return ATX_HEADING_RE.test(line);
}

function isAcceptanceSectionStart(line) {
    if (AC_BARE_LABEL_RE.test(line)) return true;
    return isAtxHeading(line) && AC_HEADING_WORD_RE.test(line.replace(ATX_HEADING_RE, ''));
}

function isBulletLine(line) {
    return BULLET_LINE_RE.test(line);
}

function isNumberedLine(line) {
    return NUMBERED_LINE_RE.test(line);
}

/** Highest "module N" mention in the text (either word order), else 0. */
function maxModuleNumber(text) {
    var max = 0;
    var m;
    MODULE_NUM_AFTER_RE.lastIndex = 0;
    while ((m = MODULE_NUM_AFTER_RE.exec(text)) !== null) {
        var n = parseInt(m[1], 10);
        if (n > max) max = n;
    }
    MODULE_NUM_BEFORE_RE.lastIndex = 0;
    while ((m = MODULE_NUM_BEFORE_RE.exec(text)) !== null) {
        var nBefore = parseInt(m[1], 10);
        if (nBefore > max) max = nBefore;
    }
    return max;
}

/**
 * Contiguous bullet groups: a maximal run of bullet lines (≥2) where blank
 * lines do NOT break the group (markdown lazy lists) but any other
 * non-bullet line does. Each group contributes 1 — the group is one
 * deliverables enumeration, not N deliverables (numbered lists carry the
 * per-item signal).
 */
function countBulletGroups(lines, bulletIndexes) {
    var groups = 0;
    var runLength = 0;
    for (var i = 0; i < bulletIndexes.length; i++) {
        if (i === 0) {
            runLength = 1;
            continue;
        }
        var sameGroup = true;
        for (var j = bulletIndexes[i - 1] + 1; j < bulletIndexes[i]; j++) {
            var between = lines[j].trim();
            if (between !== '') {
                sameGroup = false;
                break;
            }
        }
        if (sameGroup) {
            runLength++;
        } else {
            if (runLength >= 2) groups++;
            runLength = 1;
        }
    }
    if (runLength >= 2) groups++;
    return groups;
}

/**
 * The pure signal extractor (A1): ticket title + body →
 * { modules, acceptanceBullets, bodyTokens }.
 *
 * - modules: max(numbered-list items outside AC sections, highest "module N"
 *   mention anywhere, contiguous bullet groups outside AC sections) — each
 *   ingredient is an independent estimate of "how many deliverables"; the
 *   strongest estimate wins.
 * - acceptanceBullets: list items (bullets AND ordered items) under
 *   Acceptance/AC sections.
 * - bodyTokens: chars/4 backstop over title + body (floor).
 */
function emptySignalScan() {
    return { acceptanceItems: 0, numberedOutside: 0, bulletIndexesOutside: [], inAcceptance: false };
}

/** Classify one line into the scan accumulator (AC sections toggle on headings). */
function scanSignalLine(state, line, lineIndex) {
    if (isAcceptanceSectionStart(line)) {
        state.inAcceptance = true;
        return;
    }
    if (isAtxHeading(line)) {
        state.inAcceptance = false;
        return;
    }
    if (state.inAcceptance) {
        if (isBulletLine(line) || isNumberedLine(line)) state.acceptanceItems++;
        return;
    }
    if (isBulletLine(line)) {
        state.bulletIndexesOutside.push(lineIndex);
    } else if (isNumberedLine(line)) {
        state.numberedOutside++;
    }
}

function scanSignalLines(lines) {
    var state = emptySignalScan();
    lines.forEach(function (line, i) {
        scanSignalLine(state, line, i);
    });
    return state;
}

function extractSignals(title, body) {
    var fullText = String(title == null ? '' : title) + '\n' + String(body == null ? '' : body);
    var lines = fullText.split(/\r?\n/);
    var state = scanSignalLines(lines);
    var modules = Math.max(state.numberedOutside, maxModuleNumber(fullText), countBulletGroups(lines, state.bulletIndexesOutside));
    return {
        modules: modules,
        acceptanceBullets: state.acceptanceItems,
        bodyTokens: Math.floor(fullText.length / 4)
    };
}

// ── adaptive config resolution (permissive) ──────────────────────────────────

function adaptiveConfigBlock(customParams) {
    return isPlainObject(customParams) && isPlainObject(customParams.developmentModeConfig)
        ? customParams.developmentModeConfig.adaptive
        : null;
}

function isThresholdUnset(block, key) {
    return !block || !Object.prototype.hasOwnProperty.call(block, key) ||
        block[key] === null || block[key] === undefined;
}

function isNonNegativeIntegerValue(raw) {
    return typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw % 1 === 0;
}

/**
 * One threshold setting: absent/null → default (silent); a non-negative
 * integer → the value; anything else → ONE warning naming the config path
 * and the default used.
 */
function thresholdSetting(block, key, warnings) {
    var fallback = DEFAULT_ADAPTIVE_THRESHOLDS[key];
    if (isThresholdUnset(block, key)) {
        return fallback;
    }
    var raw = block[key];
    if (isNonNegativeIntegerValue(raw)) {
        return raw;
    }
    warnings.push('⚠️ developmentModeConfig.adaptive.' + key + ': expected a non-negative integer, got ' +
        developmentMode.describeRawValue(raw) + ' — using the default (' + fallback + ').');
    return fallback;
}

function resolveThresholds(block, warnings) {
    var thresholds = {};
    ADAPTIVE_THRESHOLD_KEYS.forEach(function (key) {
        thresholds[key] = thresholdSetting(block, key, warnings);
    });
    return thresholds;
}

/** shadowMode: strict boolean true enables it; absent/null/false keep it off. */
function resolveShadowMode(block, warnings) {
    if (!block || !Object.prototype.hasOwnProperty.call(block, 'shadowMode') ||
        block.shadowMode === null || block.shadowMode === undefined) {
        return false;
    }
    if (typeof block.shadowMode === 'boolean') return block.shadowMode;
    warnings.push('⚠️ developmentModeConfig.adaptive.shadowMode: expected a boolean, got ' +
        developmentMode.describeRawValue(block.shadowMode) + ' — treating as false.');
    return false;
}

/**
 * Resolve developmentModeConfig.adaptive permissively: thresholds +
 * shadowMode + warnings. A garbled block reads as defaults SILENTLY — the
 * gh-1435 aggregated validator (applyDevelopmentMode) already warns for a
 * non-object slice value, and this resolver must not duplicate the line.
 */
function resolveAdaptiveConfig(customParams) {
    var warnings = [];
    var block = adaptiveConfigBlock(customParams);
    return {
        thresholds: resolveThresholds(isPlainObject(block) ? block : null, warnings),
        shadowMode: resolveShadowMode(isPlainObject(block) ? block : null, warnings),
        warnings: warnings
    };
}

// ── decision + logging (pure) ────────────────────────────────────────────────

/**
 * The v1 decision rule, signal-ranked (decomposability first, token backstop
 * last — the weakest signal per the literature check). Returns the decided
 * mode plus the trigger that decided it (null for default).
 */
function decideAdaptiveMode(signals, thresholds) {
    if (signals.modules >= thresholds.planIfModulesAtLeast) {
        return { mode: 'plan', trigger: 'modules' };
    }
    if (signals.acceptanceBullets >= thresholds.planIfAcceptanceBulletsAtLeast) {
        return { mode: 'plan', trigger: 'acceptanceBullets' };
    }
    if (signals.bodyTokens >= thresholds.planIfBodyTokensAtLeast) {
        return { mode: 'plan', trigger: 'bodyTokens' };
    }
    return { mode: 'default', trigger: null };
}

/** "modules=1, acceptanceBullets=2, bodyTokens=96" — the fixed render order. */
function describeSignals(signals) {
    return 'modules=' + signals.modules + ', acceptanceBullets=' + signals.acceptanceBullets +
        ', bodyTokens=' + signals.bodyTokens;
}

/**
 * The routing/shadow log line — the ticket's pinned format. A plan decision
 * quotes exactly the triggering signal (matching the ticket example
 * "adaptive: would plan (signals: modules=3) but shadow mode"); a default
 * decision carries the full triple, since no single signal decided it.
 */
function routingLogLine(decision, signals, shadowMode) {
    var signalText = decision.trigger
        ? decision.trigger + '=' + signals[decision.trigger]
        : describeSignals(signals);
    var verb = shadowMode ? 'would' : 'routing to';
    var tail = shadowMode ? ' but shadow mode' : '';
    return 'adaptive: ' + verb + ' ' + decision.mode + ' (signals: ' + signalText + ')' + tail;
}

/**
 * Full evaluation for a leg: mode gate, signal extraction, threshold
 * decision, log lines. Pure — no IO, no console. Inactive (non-adaptive)
 * modes carry zero lines and zero warnings so callers can flush blindly.
 */
function evaluateAdaptiveMode(customParams, ticketText) {
    var resolvedMode = developmentMode.resolveDevelopmentMode(customParams).mode;
    if (resolvedMode !== 'adaptive') {
        return {
            active: false,
            shadowMode: false,
            signals: null,
            thresholds: null,
            decision: { mode: 'default', trigger: null },
            logLines: [],
            warnings: []
        };
    }
    var config = resolveAdaptiveConfig(customParams);
    var signals = extractSignalsFromTicketText(ticketText);
    var decision = decideAdaptiveMode(signals, config.thresholds);
    return {
        active: true,
        shadowMode: config.shadowMode,
        signals: signals,
        thresholds: config.thresholds,
        decision: decision,
        logLines: [routingLogLine(decision, signals, config.shadowMode)],
        warnings: config.warnings
    };
}

/** Ticket text shape used across callers: title + '\n' + body. */
function extractSignalsFromTicketText(ticketText) {
    var separatorIndex = String(ticketText == null ? '' : ticketText).indexOf('\n');
    var title = separatorIndex === -1 ? String(ticketText == null ? '' : ticketText) : String(ticketText).substring(0, separatorIndex);
    var body = separatorIndex === -1 ? '' : String(ticketText).substring(separatorIndex + 1);
    return extractSignals(title, body);
}

/**
 * The resolved development mode (the gh-1435 resolver's passthrough) — the
 * preCli dispatcher's gate, exported so the setup module needs no direct
 * dependency on the resolver module.
 */
function resolvedDevelopmentMode(customParams) {
    return developmentMode.resolveDevelopmentMode(customParams).mode;
}

// ── materialization orchestration (the routing carrier) ──────────────────────

/**
 * Best-effort removal of a stale materialized appendix — the hygiene that
 * keeps routed-default and shadow legs byte-identical to default-mode legs
 * even on a reused workspace. Silent on success, one honest warning on a
 * deletion failure (never fatal).
 *
 * Failure contract (gh-1437 review): dmtools file_delete NEVER throws — it
 * returns {deleted:true|false} (verified by runtime probe). So the delete
 * result is consulted, and the warning fires only when a file ACTUALLY
 * existed and survived the call: a plain {deleted:false} on an empty
 * workspace is the normal clean response and stays quiet. The catch is
 * defensive only (the platform does not throw), keeping "never fatal".
 */
function removeStaleAppendix(io) {
    var read = (io && io.file_read) || file_read;
    var remove = (io && io.file_delete) || file_delete;
    var path = developmentModePlan.PLAN_APPENDIX_FILE_PATH;
    var existed = true; // unreadable probe ⇒ assume stale so a failed delete still warns
    try {
        existed = typeof read({ path: path }) === 'string';
    } catch (e) {
        existed = true;
    }
    var result = null;
    try {
        result = remove({ path: path });
    } catch (e) {
        result = null; // defensive only — the platform does not throw
    }
    if (existed && !(result && result.deleted === true)) {
        console.warn('Could not remove the stale plan-mode appendix at "' +
            path + '": ' + developmentMode.describeRawValue(result));
    }
}

/** The shadow outcome: decision computed + logged, nothing materialized. */
function shadowOutcome(evaluation, io, result) {
    removeStaleAppendix(io);
    result.ok = true;
    return result;
}

/** The routed-default outcome: same hygiene as shadow, routing line logged. */
function routedDefaultOutcome(evaluation, io, result) {
    removeStaleAppendix(io);
    result.ok = true;
    return result;
}

/**
 * The routed-plan outcome: resolve the appendix text through the plan
 * module's machinery (engine default or the workflow's
 * developmentModeConfig.plan.appendixFile override, verbatim), write it.
 * An unreadable override is a config error: ok:false + the path named — the
 * caller fails the leg fast, exactly like a plan-mode leg.
 */
function routedPlanOutcome(evaluation, customParams, io, result) {
    var resolved = developmentModePlan.resolveAppendixSource(customParams, io);
    result.warnings = result.warnings.concat(resolved.warnings);
    if (resolved.error) {
        result.error = resolved.error;
        return result;
    }
    var written = developmentModePlan.writeResolvedAppendix(resolved, io);
    result.materialized = written.ok;
    result.path = written.path;
    result.overridden = written.overridden;
    result.ok = written.ok;
    result.error = written.error;
    if (written.ok) {
        result.logLines.push('📝 developmentMode=adaptive: ' + (written.overridden ? 'override' : 'engine default') +
            ' appendix materialized → ' + developmentModePlan.PLAN_APPENDIX_FILE_PATH);
    }
    return result;
}

/**
 * Materialize (or clean up) the appendix for an ADAPTIVE leg. Non-adaptive
 * modes are an inactive no-op with zero IO (the caller dispatches, but the
 * gate is re-checked here — the plan module pins the same discipline).
 * Never throws.
 *
 * Shape mirrors materializePlanAppendix: ok:false reads as "nothing
 * materialized" UNLESS error is set (then it is a leg failure the caller
 * reports); callers check active/routed first.
 */
function materializeAdaptiveAppendix(customParams, ticketText, io) {
    var evaluation = evaluateAdaptiveMode(customParams, ticketText);
    var result = {
        ok: false,
        active: evaluation.active,
        routed: evaluation.active ? evaluation.decision.mode : null,
        shadow: evaluation.shadowMode,
        signals: evaluation.signals,
        materialized: false,
        path: null,
        overridden: false,
        error: null,
        logLines: evaluation.logLines,
        warnings: evaluation.warnings
    };
    if (!evaluation.active) return result;
    if (evaluation.shadowMode) return shadowOutcome(evaluation, io, result);
    if (evaluation.decision.mode === 'plan') return routedPlanOutcome(evaluation, customParams, io, result);
    return routedDefaultOutcome(evaluation, io, result);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_ADAPTIVE_THRESHOLDS: DEFAULT_ADAPTIVE_THRESHOLDS,
        ADAPTIVE_THRESHOLD_KEYS: ADAPTIVE_THRESHOLD_KEYS,
        describeRawValue: developmentMode.describeRawValue,
        extractSignals: extractSignals,
        maxModuleNumber: maxModuleNumber,
        countBulletGroups: countBulletGroups,
        resolveAdaptiveConfig: resolveAdaptiveConfig,
        decideAdaptiveMode: decideAdaptiveMode,
        describeSignals: describeSignals,
        routingLogLine: routingLogLine,
        evaluateAdaptiveMode: evaluateAdaptiveMode,
        extractSignalsFromTicketText: extractSignalsFromTicketText,
        resolvedDevelopmentMode: resolvedDevelopmentMode,
        materializeAdaptiveAppendix: materializeAdaptiveAppendix
    };
}
