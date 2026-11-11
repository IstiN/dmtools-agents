// ── gh-1435: developmentMode config knob — config surface + safe fallback ───
//
// Config surface (params.customParams, per leg workflow config — precedent:
// customParams.feedbackLoop):
//   "developmentMode": "default" | "plan" | "adaptive",
//   "developmentModeConfig": { plan: {...}, adaptive: {...}, spawn: {...} }
//
// Invariants pinned by gh-1435:
//   I1 (safety) — missing / null / empty / invalid value ⇒ resolved mode
//       "default" (+ one warning log line naming the offending value).
//       Nothing throws; the leg never fails because of this field.
//   I2 (inertness) — in gh-1435 the resolved mode reaches NO behavior path.
//       It is logged ("developmentMode=<resolved>") for observability only;
//       sub-issues wire plan/adaptive/spawn behavior later. Absence of the
//       key produces zero log output, so the leg's log stays byte-identical
//       to the pre-change engine (AC1 golden log diff).
//
// Validation is CASE-SENSITIVE, lowercase only ("PLAN" is invalid — pinned
// choice: silently normalizing case would mask typos). Invalid-value warnings
// go to the run log only (owner decision 2026-11-10) — never ticket comments.
//
// developmentModeConfig is parsed permissively: unknown keys are ignored with
// one aggregated warning (forward compatibility — the issue that wires a
// slice adds its key to DEVELOPMENT_MODE_CONFIG_SLICES and the warning
// stops), wrong-typed slice values are logged-and-ignored. A null/undefined
// developmentModeConfig reads as "unset" (the JSON spelling of absent) and
// stays silent — absence is the supported steady state.

var DEFAULT_DEVELOPMENT_MODE = 'default';
var VALID_DEVELOPMENT_MODES = ['default', 'plan', 'adaptive'];

// Slice keys spec'd by the epic (plan / adaptive / spawn). None is wired in
// gh-1435; a key outside this list warns as unknown so typos surface, a key
// inside must hold an object (wrong types logged-and-ignored).
var DEVELOPMENT_MODE_CONFIG_SLICES = ['plan', 'adaptive', 'spawn'];

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Human-readable rendering of a raw config value for warning lines — names
// the offending value without ever throwing on exotic input.
function describeRawValue(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return '"' + value + '"';
    if (isPlainObject(value) || Array.isArray(value)) {
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return String(value);
}

function hasOwnKey(customParams, key) {
    return !!(customParams && typeof customParams === 'object' &&
        Object.prototype.hasOwnProperty.call(customParams, key));
}

function invalidModeWarning(raw) {
    return '⚠️ developmentMode: invalid value ' + describeRawValue(raw) +
        ' — expected one of "default", "plan", "adaptive" (case-sensitive, lowercase only); using "default".';
}

/**
 * Resolve params.customParams.developmentMode (I1).
 * - Missing key / undefined value → "default" with NO warning (AC1 — absence
 *   is the supported steady state).
 * - Valid mode string → resolved as-is, no warning (AC2).
 * - Explicit null / empty / non-string / unknown or wrong-case string →
 *   "default" + exactly ONE warning naming the value (AC3/AC5).
 *
 * @returns {{mode: string, warnings: string[], present: boolean}} present is
 * true when the key exists (even if invalid) — callers log the observability
 * line only when present, so key-less runs add zero log output (AC1).
 */
function resolveDevelopmentMode(customParams) {
    if (!hasOwnKey(customParams, 'developmentMode') || customParams.developmentMode === undefined) {
        return { mode: DEFAULT_DEVELOPMENT_MODE, warnings: [], present: false };
    }
    var raw = customParams.developmentMode;
    if (typeof raw === 'string' && VALID_DEVELOPMENT_MODES.indexOf(raw) !== -1) {
        return { mode: raw, warnings: [], present: true };
    }
    return { mode: DEFAULT_DEVELOPMENT_MODE, warnings: [invalidModeWarning(raw)], present: true };
}

/**
 * Parse developmentModeConfig permissively (AC4). Returns warnings only —
 * gh-1435 consumes no config values (I2: inert); the slices are wired by
 * later sub-issues which will read the values themselves.
 *
 * @returns {string[]} zero or more warning lines
 */
function validateDevelopmentModeConfig(customParams) {
    if (!hasOwnKey(customParams, 'developmentModeConfig')) return [];
    var raw = customParams.developmentModeConfig;
    if (raw === null || raw === undefined) return [];
    if (!isPlainObject(raw)) {
        return ['⚠️ developmentModeConfig: expected an object, got ' + describeRawValue(raw) + ' — ignored.'];
    }
    var warnings = [];
    var unknownKeys = [];
    Object.keys(raw).forEach(function (key) {
        if (DEVELOPMENT_MODE_CONFIG_SLICES.indexOf(key) === -1) {
            unknownKeys.push(key);
        } else if (!isPlainObject(raw[key])) {
            warnings.push('⚠️ developmentModeConfig.' + key + ': expected an object, got ' +
                describeRawValue(raw[key]) + ' — ignored.');
        }
    });
    if (unknownKeys.length > 0) {
        warnings.push('⚠️ developmentModeConfig: unknown key(s) ignored (forward compatibility): ' +
            unknownKeys.join(', ') + '.');
    }
    return warnings;
}

/**
 * Single entry point for dev legs: resolve + validate + log. Warnings go to
 * the run log only (console.warn — never a ticket comment). The
 * observability line "developmentMode=<resolved>" is logged only when the
 * developmentMode key is present, so field-less runs keep the leg's log
 * byte-identical to the pre-change engine (AC1 golden log diff).
 *
 * @returns {{mode: string, warnings: string[], present: boolean}}
 */
function applyDevelopmentMode(customParams) {
    var resolved = resolveDevelopmentMode(customParams);
    var warnings = resolved.warnings.concat(validateDevelopmentModeConfig(customParams));
    warnings.forEach(function (w) { console.warn(w); });
    if (resolved.present) console.log('developmentMode=' + resolved.mode);
    return { mode: resolved.mode, warnings: warnings, present: resolved.present };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_DEVELOPMENT_MODE: DEFAULT_DEVELOPMENT_MODE,
        VALID_DEVELOPMENT_MODES: VALID_DEVELOPMENT_MODES,
        DEVELOPMENT_MODE_CONFIG_SLICES: DEVELOPMENT_MODE_CONFIG_SLICES,
        describeRawValue: describeRawValue,
        resolveDevelopmentMode: resolveDevelopmentMode,
        validateDevelopmentModeConfig: validateDevelopmentModeConfig,
        applyDevelopmentMode: applyDevelopmentMode
    };
}
