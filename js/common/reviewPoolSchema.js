/**
 * reviewPoolSchema.js — the gh-1406 reviewer-pool SCHEMA: the pure input
 * validation layer for the pool's data shapes — §2 skill files, §3
 * tuning, §6 rounds, the tier vocabulary. No io, no dmtools globals:
 * everything here validates plain JSON and returns/throws.
 *
 * Two error families:
 *   - ReviewPolicyValidationError — the reviewPolicy tuning keys
 *     (reviewers / promptAppend / rounds): thrown at policy resolution
 *     (gh-1406 §3 "strictness preserved").
 *   - ReviewSkillValidationError — the skill FILES themselves (factory
 *     instructions/review/*.json + repo .dmtools/review/*.json): thrown
 *     at pool load (§2 "extend, never replace").
 *
 * The validators are deliberately small, single-purpose functions: the
 * repo's quality gate is the per-function CRAP ratchet
 * (complexity² × (1 − coverage)³ + complexity, threshold 8 — see
 * .github/workflows/quality.yml), so js/common/* modules are CRAP-split
 * by convention. reviewPolicy.js re-exports the policy-side validators
 * and the tier vocabulary; reviewPool.js re-exports the skill-file API —
 * the public surfaces of both modules are unchanged by this split.
 *
 * Pure module — JSON-safe data only. Requires hoisted (gh-823); this
 * module has none. Keep it GraalJS-clean (var + plain functions).
 */
'use strict';

// ── the vocabulary (§2 table + §3 tunables + §6 flags) ───────────────────────

// The severity tiers (the gh-1351 census vocabulary; reviewPolicy re-exports).
var TIERS = ['BLOCKING', 'IMPORTANT', 'SUGGESTION', 'NIT'];

// gh-1406 §2/§3: the reviewer-pool tuning keys — a `reviewPolicy.reviewers.<name>`
// entry (or a same-name repo skill file) may TUNE exactly these; the contract
// fields (name, lens, roleLine, mayRaise, filterWeight, isFiltered)
// are factory invariants, never repo-re-definable.
var POL_TUNABLE_FIELDS = ['isEnabled', 'rounds', 'triggerPaths', 'options', 'model'];

// gh-1406 §6: the rounds flags. `["all"]` is exclusive — it cannot combine.
var POL_ROUND_FLAGS = ['first', 'hunks', 'all'];

// The universal skill-file field set (§2 table). `options` is the
// pass-through bucket — unknown per-reviewer knobs belong there, unknown
// TOP-LEVEL fields are typo protection (warned, never silently dropped).
var KNOWN_FIELDS = ['name', 'lens', 'roleLine', 'mayRaise', 'filterWeight',
    'isFiltered', 'rounds', 'triggerPaths', 'options',
    'model', 'isEnabled'];

// Fields REMOVED from the schema (the owner's 2026-11-12 revision: merge
// gating is pool policy, not a per-reviewer flag). A stale file carrying one
// gets a pointed migration warning instead of the generic unknown-field note.
var REMOVED_FIELD_HINTS = {
    isRequired: 'merge gating moved to reviewPolicy.required (the pool-wide reviewer list)'
};
var KNOWN_FIELD_SET = keySetOf(KNOWN_FIELDS);

// §2 defaults — the safe general behavior. `roleLine` is derived, not
// defaulted (see deriveRoleLine).
var DEFAULT_FILTER_WEIGHT = 'normal';
var DEFAULT_ROUNDS = ['all'];

// ── the two error families ───────────────────────────────────────────────────

var POLICY_ERROR_NAME = 'ReviewPolicyValidationError';
var SKILL_ERROR_NAME = 'ReviewSkillValidationError';

function policyError(message) {
    var e = new Error(message);
    e.name = POLICY_ERROR_NAME;
    return e;
}

function skillError(message) {
    var e = new Error(message);
    e.name = SKILL_ERROR_NAME;
    return e;
}

function isReviewSkillError(e) {
    return !!e && e.name === SKILL_ERROR_NAME;
}

// ── shared predicates ────────────────────────────────────────────────────────

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}

function hasKey(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function unknownKeysOf(raw, knownSet) {
    var unknown = [];
    for (var k in raw) {
        if (hasKey(raw, k) && !hasKey(knownSet, k)) unknown.push(k);
    }
    return unknown;
}

function keySetOf(list) {
    var set = {};
    for (var i = 0; i < list.length; i++) set[list[i]] = 1;
    return set;
}

// §2: the derived persona line — placed first in the assembled prompt.
function deriveRoleLine(name) {
    return 'Specialized Code Reviewer \u2014 ' + String(name || '');
}

// ── the reviewPolicy tuning keys (§3 + §6 — ReviewPolicyValidationError) ─────

/**
 * One rounds value: an array of valid flags; `["all"]` is exclusive (§6/§8 —
 * "all" cannot combine with first/hunks). An empty array is a hard error —
 * "never runs" must be stated as isEnabled:false, never as a silent empty
 * rounds list.
 */
function validateRounds(value, where) {
    if (!Array.isArray(value)) {
        throw policyError(where + ' must be an array of round flags (' + POL_ROUND_FLAGS.join('|') + '), got: ' + JSON.stringify(value));
    }
    if (value.length === 0) {
        throw policyError(where + ' must not be empty — disable the reviewer with isEnabled:false instead');
    }
    for (var i = 0; i < value.length; i++) {
        var flag = value[i];
        if (typeof flag !== 'string' || POL_ROUND_FLAGS.indexOf(flag) === -1) {
            throw policyError(where + ' has an invalid round flag: ' + JSON.stringify(flag) +
                ' — expected one of ' + POL_ROUND_FLAGS.join(' | '));
        }
    }
    if (value.indexOf('all') !== -1 && value.length > 1) {
        throw policyError(where + ' combines "all" with other flags — "all" is exclusive');
    }
    return value.slice();
}

function validateStringArray(value, where) {
    if (!Array.isArray(value)) {
        throw policyError(where + ' must be an array of strings, got: ' + JSON.stringify(value));
    }
    for (var i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string' || !value[i].trim()) {
            throw policyError(where + '[' + i + '] must be a non-empty string, got: ' + JSON.stringify(value[i]));
        }
    }
    return value.slice();
}

function reviewerTunedModelOf(name, value) {
    if (value !== null && typeof value !== 'string') {
        throw policyError('reviewPolicy.reviewers.' + name + '.model must be a string or null');
    }
    return value;
}

function reviewerTunedOptionsOf(name, value) {
    if (!isPlainObject(value)) {
        throw policyError('reviewPolicy.reviewers.' + name + '.options must be an object');
    }
    return value;
}

/**
 * One tunable field of one tuning entry, type-gated (§3). Unknown keys never
 * reach this — validateReviewerTuning rejects them before the loop.
 */
function reviewerTunedFieldOf(name, key, value) {
    if (key === 'isEnabled') {
        if (typeof value !== 'boolean') {
            throw policyError('reviewPolicy.reviewers.' + name + '.isEnabled must be a boolean, got: ' + JSON.stringify(value));
        }
        return value;
    }
    if (key === 'rounds') return validateRounds(value, 'reviewPolicy.reviewers.' + name + '.rounds');
    if (key === 'triggerPaths') return validateStringArray(value, 'reviewPolicy.reviewers.' + name + '.triggerPaths');
    if (key === 'options') return reviewerTunedOptionsOf(name, value);
    if (key === 'model') return reviewerTunedModelOf(name, value);
    return undefined;
}

/**
 * One tuning entry (reviewPolicy.reviewers.<name>): only the tunable fields,
 * each with its type gate. Unknown keys are a hard error — typo protection
 * (gh-1406 §3 "strictness preserved").
 */
function validateReviewerTuning(name, raw) {
    if (!isPlainObject(raw)) {
        throw policyError('reviewPolicy.reviewers.' + name + ' must be an object of tunable fields (' + POL_TUNABLE_FIELDS.join(', ') + ')');
    }
    var unknown = unknownKeysOf(raw, keySetOf(POL_TUNABLE_FIELDS));
    if (unknown.length > 0) {
        var hints = [];
        for (var u = 0; u < unknown.length; u++) {
            if (REMOVED_FIELD_HINTS[unknown[u]]) hints.push(unknown[u] + ': ' + REMOVED_FIELD_HINTS[unknown[u]]);
        }
        throw policyError('reviewPolicy.reviewers.' + name + ' has unknown key(s): ' + unknown.join(', ') +
            ' — only ' + POL_TUNABLE_FIELDS.join(', ') + ' are tunable; contract fields (lens, mayRaise, filterWeight, isFiltered, roleLine) are factory invariants' +
            (hints.length > 0 ? ' — ' + hints.join('; ') : ''));
    }
    var out = {};
    for (var i = 0; i < POL_TUNABLE_FIELDS.length; i++) {
        var field = POL_TUNABLE_FIELDS[i];
        if (!hasKey(raw, field)) continue;
        out[field] = reviewerTunedFieldOf(name, field, raw[field]);
    }
    return out;
}

function reviewersTuningKeyOf(name) {
    if (!name || typeof name !== 'string') {
        throw policyError('reviewPolicy.reviewers keys must be non-empty reviewer names');
    }
}

/**
 * The reviewers tuning block (gh-1406 §3): a map keyed by reviewer name.
 * Empty/null → {} (absence = factory defaults).
 */
function validateReviewersTuning(raw) {
    if (raw === undefined || raw === null) return {};
    if (!isPlainObject(raw)) {
        throw policyError('reviewPolicy.reviewers must be an object keyed by reviewer name');
    }
    var out = {};
    for (var name in raw) {
        if (!hasKey(raw, name)) continue;
        reviewersTuningKeyOf(name);
        out[name] = validateReviewerTuning(name, raw[name]);
    }
    return out;
}

function promptAppendKeyOf(key) {
    if (!key || typeof key !== 'string') {
        throw policyError('reviewPolicy.promptAppend keys must be non-empty reviewer names');
    }
}

/**
 * The promptAppend block (gh-1406 §3): a map keyed by reviewer name or
 * 'base' — each value an array of instruction-file paths APPENDED after the
 * lens (ADDITIVE ONLY; factory lens/contract files are never replaceable).
 */
function validatePromptAppend(raw) {
    if (raw === undefined || raw === null) return {};
    if (!isPlainObject(raw)) {
        throw policyError('reviewPolicy.promptAppend must be an object keyed by reviewer name (or "base")');
    }
    var out = {};
    for (var key in raw) {
        if (!hasKey(raw, key)) continue;
        promptAppendKeyOf(key);
        out[key] = validateStringArray(raw[key], 'reviewPolicy.promptAppend.' + key);
    }
    return out;
}

// ── the skill files (§2 + §8 checks 1–3 — ReviewSkillValidationError) ────────

function validateMayRaise(raw, source) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw skillError(source + ': mayRaise must be a non-empty array of tiers (' +
            TIERS.join(', ') + ')');
    }
    for (var i = 0; i < raw.length; i++) {
        var tier = String(raw[i] || '').trim().toUpperCase();
        if (TIERS.indexOf(tier) === -1) {
            throw skillError(source + ': mayRaise has an unknown tier ' + JSON.stringify(raw[i]) +
                ' — known tiers: ' + TIERS.join(', '));
        }
    }
    return raw.map(function(t) { return String(t).trim().toUpperCase(); });
}

function validateBoolField(value, field, source) {
    if (typeof value !== 'boolean') {
        throw skillError(source + ': ' + field + ' must be a boolean, got: ' + JSON.stringify(value) +
            ' (booleans take the is prefix)');
    }
    return value;
}

function validateFilterWeight(value, source) {
    if (value !== 'low' && value !== 'normal' && value !== 'high') {
        throw skillError(source + ': filterWeight must be low | normal | high, got: ' + JSON.stringify(value));
    }
    return value;
}

function validateOptions(value, source) {
    if (!isPlainObject(value)) {
        throw skillError(source + ': options must be an object (the per-reviewer pass-through bucket)');
    }
    return value;
}

function skillUnknownFieldWarnings(raw, source) {
    var warnings = [];
    var unknown = unknownKeysOf(raw, KNOWN_FIELD_SET);
    var removed = [];
    for (var i = unknown.length - 1; i >= 0; i--) {
        if (REMOVED_FIELD_HINTS[unknown[i]]) {
            removed.push(unknown[i] + ' (' + REMOVED_FIELD_HINTS[unknown[i]] + ')');
            unknown.splice(i, 1);
        }
    }
    if (removed.length > 0) {
        warnings.push(source + ': removed field(s) ' + removed.join(', '));
    }
    if (unknown.length > 0) {
        warnings.push(source + ': unknown field(s) ' + unknown.join(', ') +
            ' — known fields: ' + KNOWN_FIELDS.join(', ') +
            ' (options is the per-reviewer pass-through bucket)');
    }
    return warnings;
}

/** The required identity of one skill file: name + lens + roleLine (§2). */
function skillIdentityOf(raw, source) {
    if (!isNonEmptyString(raw.name)) {
        throw skillError(source + ': "name" is required (non-empty string)');
    }
    if (!isNonEmptyString(raw.lens)) {
        throw skillError(source + ': "lens" is required (the instruction markdown path)');
    }
    if (raw.roleLine !== undefined && raw.roleLine !== null && !isNonEmptyString(raw.roleLine)) {
        throw skillError(source + ': roleLine must be a non-empty string');
    }
    return {
        name: raw.name,
        lens: raw.lens,
        roleLine: raw.roleLine || deriveRoleLine(raw.name)
    };
}

function defaultedMayRaise(raw, source) {
    return (raw.mayRaise === undefined || raw.mayRaise === null)
        ? TIERS.slice()
        : validateMayRaise(raw.mayRaise, source);
}

function defaultedFilterWeight(raw, source) {
    return (raw.filterWeight === undefined || raw.filterWeight === null)
        ? DEFAULT_FILTER_WEIGHT : validateFilterWeight(raw.filterWeight, source);
}

function defaultedBool(value, dflt, field, source) {
    return (value === undefined || value === null) ? dflt : validateBoolField(value, field, source);
}

function defaultedRounds(raw, source) {
    return (raw.rounds === undefined || raw.rounds === null)
        ? DEFAULT_ROUNDS.slice()
        : validateRounds(raw.rounds, source + ': rounds');
}

function defaultedTriggerPaths(raw, source) {
    return (raw.triggerPaths === undefined || raw.triggerPaths === null)
        ? [] : validateStringArray(raw.triggerPaths, source + ': triggerPaths');
}

function defaultedOptions(raw, source) {
    return (raw.options === undefined || raw.options === null)
        ? {} : validateOptions(raw.options, source);
}

function defaultedModel(raw, source) {
    var model = (raw.model === undefined || raw.model === null) ? null : raw.model;
    if (typeof model !== 'string' && model !== null) {
        throw skillError(source + ': model must be a string or null');
    }
    return model;
}

/**
 * Validates + normalizes ONE full skill definition (a factory file, or a
 * repo file defining a NEW reviewer). Required: name + lens; everything
 * else defaults (§2). Unknown top-level fields are WARNED (typo
 * protection), never silently dropped. Returns { skill, warnings }.
 */
function validateSkillDefinition(raw, source) {
    if (!isPlainObject(raw)) {
        throw skillError(source + ' must be a JSON object');
    }
    var identity = skillIdentityOf(raw, source);
    var skill = {
        name: identity.name,
        lens: identity.lens,
        roleLine: identity.roleLine,
        mayRaise: defaultedMayRaise(raw, source),
        filterWeight: defaultedFilterWeight(raw, source),
        isFiltered: defaultedBool(raw.isFiltered, true, 'isFiltered', source),
        rounds: defaultedRounds(raw, source),
        triggerPaths: defaultedTriggerPaths(raw, source),
        options: defaultedOptions(raw, source),
        model: defaultedModel(raw, source),
        isEnabled: defaultedBool(raw.isEnabled, true, 'isEnabled', source)
    };
    return { skill: skill, warnings: skillUnknownFieldWarnings(raw, source) };
}

function hasTunableField(raw, field) {
    return hasKey(raw, field) && raw[field] !== undefined && raw[field] !== null;
}

function repoTunedModelOf(value, source) {
    if (value !== null && typeof value !== 'string') {
        throw skillError(source + ': model must be a string or null');
    }
    return value;
}

/** One tunable field of a same-name repo file, type-gated (§8 check 5). */
function repoTuningFieldOf(field, value, source) {
    if (field === 'isEnabled') return validateBoolField(value, field, source);
    if (field === 'rounds') return validateRounds(value, source + ': rounds');
    if (field === 'triggerPaths') return validateStringArray(value, source + ': triggerPaths');
    if (field === 'options') return validateOptions(value, source);
    if (field === 'model') return repoTunedModelOf(value, source);
    return value;
}

function repoTuningOf(raw, source) {
    var tuning = {};
    for (var i = 0; i < POL_TUNABLE_FIELDS.length; i++) {
        var field = POL_TUNABLE_FIELDS[i];
        if (!hasTunableField(raw, field)) continue;
        tuning[field] = repoTuningFieldOf(field, raw[field], source);
    }
    return tuning;
}

/**
 * A same-name REPO skill file: only the tunable fields (plus a matching
 * `name`) — anything else re-defines a factory reviewer's contract and is
 * a hard error (§2 invariant "extend, never replace"; §8 check 5).
 * Returns { tuning, warnings } — tuning carries ONLY the present tunable
 * fields, merged over the factory skill by the caller.
 */
function validateRepoTuning(raw, factorySkill, source) {
    if (!isPlainObject(raw)) {
        throw skillError(source + ' must be a JSON object (tuning for the factory reviewer ' +
            factorySkill.name + ')');
    }
    var unknown = unknownKeysOf(raw, keySetOf(POL_TUNABLE_FIELDS.concat(['name'])));
    if (unknown.length > 0) {
        var hints = [];
        for (var u = 0; u < unknown.length; u++) {
            if (REMOVED_FIELD_HINTS[unknown[u]]) hints.push(unknown[u] + ': ' + REMOVED_FIELD_HINTS[unknown[u]]);
        }
        throw skillError(source + ': a same-name file for the factory reviewer ' + factorySkill.name +
            ' may only TUNE ' + POL_TUNABLE_FIELDS.join(', ') +
            ' — found ' + unknown.join(', ') + ' (extend, never replace: factory reviewers are not re-definable)' +
            (hints.length > 0 ? ' — ' + hints.join('; ') : ''));
    }
    if (raw.name !== undefined && String(raw.name) !== String(factorySkill.name)) {
        throw skillError(source + ': name ' + JSON.stringify(raw.name) +
            ' does not match the factory reviewer it tunes (' + factorySkill.name + ')');
    }
    return { tuning: repoTuningOf(raw, source), warnings: [] };
}

/** Merges one tuning object over a resolved skill (tunable fields only). */
function applyTuning(skill, tuning) {
    var out = {};
    for (var k in skill) {
        if (hasKey(skill, k)) out[k] = skill[k];
    }
    for (var f in tuning) {
        if (hasKey(tuning, f)) out[f] = tuning[f];
    }
    return out;
}

// §7 (the 2026-11-12 revision): the merge-gate reviewer list — pool policy,
// not a per-reviewer flag. Factory default mirrors the shipped factory
// reviewers; a repo owns the list (`required: []` gates nothing).
var DEFAULT_REQUIRED = ['base', 'security'];

/**
 * reviewPolicy.required: an optional array of non-empty, unique reviewer
 * names (resolved against the loaded pool by reviewPool.resolvePool —
 * an entry naming no reviewer is a hard error there: a misspelled gate
 * silently gates nothing). Absent → the factory default list.
 */
function validateRequiredList(raw, source) {
    var where = (source || 'reviewPolicy') + '.required';
    if (raw === undefined || raw === null) return DEFAULT_REQUIRED.slice();
    if (!Array.isArray(raw)) {
        throw skillError(where + ' must be an array of reviewer names, got: ' + JSON.stringify(raw));
    }
    var seen = {};
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var name = raw[i];
        if (!isNonEmptyString(name)) {
            throw skillError(where + '[' + i + '] must be a non-empty reviewer name, got: ' + JSON.stringify(name));
        }
        if (seen[name]) {
            throw skillError(where + ' lists reviewer "' + name + '" more than once');
        }
        seen[name] = 1;
        out.push(name);
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TIERS: TIERS,
        POL_TUNABLE_FIELDS: POL_TUNABLE_FIELDS,
        POL_ROUND_FLAGS: POL_ROUND_FLAGS,
        KNOWN_FIELDS: KNOWN_FIELDS,
        DEFAULT_REQUIRED: DEFAULT_REQUIRED,
        validateRequiredList: validateRequiredList,
        DEFAULT_FILTER_WEIGHT: DEFAULT_FILTER_WEIGHT,
        DEFAULT_ROUNDS: DEFAULT_ROUNDS,
        deriveRoleLine: deriveRoleLine,
        validateRounds: validateRounds,
        validateStringArray: validateStringArray,
        validateReviewerTuning: validateReviewerTuning,
        validateReviewersTuning: validateReviewersTuning,
        validatePromptAppend: validatePromptAppend,
        validateMayRaise: validateMayRaise,
        validateSkillDefinition: validateSkillDefinition,
        validateRepoTuning: validateRepoTuning,
        applyTuning: applyTuning,
        hasKey: hasKey,
        isPlainObject: isPlainObject,
        isNonEmptyString: isNonEmptyString,
        skillError: skillError,
        isReviewSkillError: isReviewSkillError
    };
}
