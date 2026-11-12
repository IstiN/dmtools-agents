/**
 * reviewPool.js — the gh-1406 reviewer pool: base + configurable specialist
 * reviewers as JSON skill files.
 *
 * A reviewer is a JSON file (§2). Two locations, loaded and MERGED by name:
 *   - factory: instructions/review/<name>.json (ships with dmtools-agents;
 *     base + security)
 *   - repo:    .dmtools/review/<name>.json (repo-defined reviewers; a
 *     same-name file may only TUNE isEnabled/rounds/triggerPaths/options/
 *     model — the reviewer's contract fields are factory invariants,
 *     "extend, never replace")
 * Run-time tuning comes from the gh-1406 reviewPolicy keys (§3,
 * reviewPolicy.reviewers / reviewPolicy.promptAppend — shape-validated by
 * reviewPolicy.js, resolved here against the skill files).
 *
 * The invariants this module enforces mechanically (§ "The invariants"):
 *   - extend, never replace: a same-name repo file / policy tuning block may
 *     only carry the tunable fields (POOL_TUNABLE_FIELDS);
 *   - defaults are the safe general behavior (§2 table): a minimal file
 *     {"name","lens"} defines a FULL reviewer — mayRaise all tiers,
 *     filterWeight normal, isFiltered true, isRequired false, rounds ["all"],
 *     triggerPaths [], options {}, model null, isEnabled true;
 *   - rounds semantics (§6): ["first"] / ["hunks"] / ["first","hunks"] /
 *     ["all"] (exclusive) — `first` counts COMPLETED passes (the PASS
 *     marker), `hunks` fires on new hunks hitting triggerPaths;
 *   - the merge gate (§7): every reviewer leg stamps a head-carried PASS
 *     marker; the round stamps ONE pool-outcome marker naming the enabled
 *     reviewers and their required flags; required reviewers without a
 *     same-head PASS marker hold the merge (never silent merge, never
 *     silent approval — gh-957 doctrine).
 *
 * Marker family (the `dmtools:` head-carried shapes):
 *   <!-- dmtools:review-pass {"reviewer":"security","head":"<sha>","at":"..."} -->
 *   <!-- dmtools:review-pool {"head":"<sha>","round":"first",
 *        "reviewers":[{"name":"base","required":true,"completed":true}],"at":"..."} -->
 * Both are trusted only from machine identities (the machineAuthor
 * allowlist — an unconfigured/empty allowlist trusts NOTHING, so a forged
 * PASS marker can never satisfy the gate; the same rule as the verdict
 * records).
 *
 * Pure module — no dmtools globals (file io injected). Requires hoisted
 * (gh-823 pack-require rule). Keep it GraalJS-clean (var + plain functions,
 * JSON-safe data only).
 */
'use strict';

var reviewPolicy = require('./reviewPolicy.js');

// The skill-file directories (§2).
var FACTORY_DIR = 'instructions/review';
var REPO_DIR = '.dmtools/review';

// The sentinel name for pool-wide prompt appends (§3: appends after the
// base contract files, before the lens — a `base` key targets every
// reviewer's prompt assembly).
var BASE_APPEND_KEY = 'base';

// The marker family (§7).
var PASS_MARKER_PREFIX = '<!-- dmtools:review-pass ';
var POOL_MARKER_PREFIX = '<!-- dmtools:review-pool ';
var MARKER_SUFFIX = ' -->';

// The required-reviewer hold rides the shared dmtools:merge-hold family
// (one marker grammar; the reason field separates the dedup budgets).
var HOLD_REASON = 'required-reviewer';

// §2 defaults — the safe general behavior. `roleLine` is derived, not
// defaulted (see deriveRoleLine).
var DEFAULT_FILTER_WEIGHT = 'normal';
var DEFAULT_ROUNDS = ['all'];

// §8 check 3: the citation-discipline hint a lens must contain when the
// skill file EXPLICITLY declares BLOCKING in mayRaise (the check warns —
// the validator script surfaces it; the loader collects it as a warning).
// Either spelling counts: the verb lenses teach ("cite the file:line") or
// the noun ("the citation discipline").
var CITATION_HINT_FRAGMENTS = ['cite', 'citation'];

var ERROR_NAME = 'ReviewSkillValidationError';

function skillError(message) {
    var e = new Error(message);
    e.name = ERROR_NAME;
    return e;
}

function isReviewSkillError(e) {
    return !!e && e.name === ERROR_NAME;
}

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

// The universal skill-file field set (§2 table). `options` is the
// pass-through bucket — unknown per-reviewer knobs belong there, unknown
// TOP-LEVEL fields are typo protection (warned, never silently dropped).
var KNOWN_FIELDS = ['name', 'lens', 'roleLine', 'mayRaise', 'filterWeight',
    'isFiltered', 'isRequired', 'rounds', 'triggerPaths', 'options',
    'model', 'isEnabled'];
var KNOWN_FIELD_SET = keySetOf(KNOWN_FIELDS);

// ── skill-file validation (§2, §8 checks 1–3) ───────────────────────────────

function validateMayRaise(raw, source) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw skillError(source + ': mayRaise must be a non-empty array of tiers (' +
            reviewPolicy.TIERS.join(', ') + ')');
    }
    for (var i = 0; i < raw.length; i++) {
        var tier = String(raw[i] || '').trim().toUpperCase();
        if (reviewPolicy.TIERS.indexOf(tier) === -1) {
            throw skillError(source + ': mayRaise has an unknown tier ' + JSON.stringify(raw[i]) +
                ' — known tiers: ' + reviewPolicy.TIERS.join(', '));
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
    var warnings = [];
    var unknown = unknownKeysOf(raw, KNOWN_FIELD_SET);
    if (unknown.length > 0) {
        warnings.push(source + ': unknown field(s) ' + unknown.join(', ') +
            ' — known fields: ' + KNOWN_FIELDS.join(', ') +
            ' (options is the per-reviewer pass-through bucket)');
    }
    if (!isNonEmptyString(raw.name)) {
        throw skillError(source + ': "name" is required (non-empty string)');
    }
    if (!isNonEmptyString(raw.lens)) {
        throw skillError(source + ': "lens" is required (the instruction markdown path)');
    }
    if (raw.roleLine !== undefined && raw.roleLine !== null && !isNonEmptyString(raw.roleLine)) {
        throw skillError(source + ': roleLine must be a non-empty string');
    }
    var rounds = raw.rounds === undefined || raw.rounds === null
        ? DEFAULT_ROUNDS.slice()
        : reviewPolicy.validateRounds(raw.rounds, source + ': rounds');
    var skill = {
        name: raw.name,
        lens: raw.lens,
        roleLine: raw.roleLine || deriveRoleLine(raw.name),
        mayRaise: (raw.mayRaise === undefined || raw.mayRaise === null)
            ? reviewPolicy.TIERS.slice()
            : validateMayRaise(raw.mayRaise, source),
        filterWeight: raw.filterWeight === undefined || raw.filterWeight === null
            ? DEFAULT_FILTER_WEIGHT : validateFilterWeight(raw.filterWeight, source),
        isFiltered: (raw.isFiltered === undefined || raw.isFiltered === null)
            ? true : validateBoolField(raw.isFiltered, 'isFiltered', source),
        isRequired: (raw.isRequired === undefined || raw.isRequired === null)
            ? false : validateBoolField(raw.isRequired, 'isRequired', source),
        rounds: rounds,
        triggerPaths: (raw.triggerPaths === undefined || raw.triggerPaths === null)
            ? [] : validateStringArray(raw.triggerPaths, source + ': triggerPaths'),
        options: (raw.options === undefined || raw.options === null)
            ? {} : validateOptions(raw.options, source),
        model: (raw.model === undefined || raw.model === null) ? null : raw.model,
        isEnabled: (raw.isEnabled === undefined || raw.isEnabled === null)
            ? true : validateBoolField(raw.isEnabled, 'isEnabled', source)
    };
    if (typeof skill.model !== 'string' && skill.model !== null) {
        throw skillError(source + ': model must be a string or null');
    }
    return { skill: skill, warnings: warnings };
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

function validateStringArray(value, where) {
    if (!Array.isArray(value)) {
        throw skillError(where + ' must be an array of strings, got: ' + JSON.stringify(value));
    }
    for (var i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string' || !value[i].trim()) {
            throw skillError(where + '[' + i + '] must be a non-empty string');
        }
    }
    return value.slice();
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
    var warnings = [];
    var allowed = keySetOf(reviewPolicy.POOL_TUNABLE_FIELDS.concat(['name']));
    var unknown = unknownKeysOf(raw, allowed);
    if (unknown.length > 0) {
        throw skillError(source + ': a same-name file for the factory reviewer ' + factorySkill.name +
            ' may only TUNE ' + reviewPolicy.POOL_TUNABLE_FIELDS.join(', ') +
            ' — re-defining ' + unknown.join(', ') + ' is rejected (extend, never replace: ' +
            'contract fields are factory invariants)');
    }
    if (raw.name !== undefined && String(raw.name) !== String(factorySkill.name)) {
        throw skillError(source + ': name ' + JSON.stringify(raw.name) +
            ' does not match the factory reviewer it tunes (' + factorySkill.name + ')');
    }
    var tuning = {};
    for (var i = 0; i < reviewPolicy.POOL_TUNABLE_FIELDS.length; i++) {
        var field = reviewPolicy.POOL_TUNABLE_FIELDS[i];
        if (!hasKey(raw, field) || raw[field] === undefined || raw[field] === null) continue;
        if (field === 'isEnabled') tuning[field] = validateBoolField(raw[field], field, source);
        else if (field === 'rounds') tuning[field] = reviewPolicy.validateRounds(raw[field], source + ': rounds');
        else if (field === 'triggerPaths') tuning[field] = validateStringArray(raw[field], source + ': triggerPaths');
        else if (field === 'options') tuning[field] = validateOptions(raw[field], source);
        else if (field === 'model') {
            if (raw[field] !== null && typeof raw[field] !== 'string') {
                throw skillError(source + ': model must be a string or null');
            }
            tuning[field] = raw[field];
        }
    }
    return { tuning: tuning, warnings: warnings };
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

// ── pool resolution (§2 loading + §3 tuning) ─────────────────────────────────

/**
 * The io bag: { readFile(path) -> text|null, listFiles(dir) -> entries|null }.
 * Entry names ride entryNameOf (file_list entries may be strings or
 * {name}/{path} objects). Every io call is failure-soft at the CALLER's
 * discretion — resolvePool treats a failed dir listing as "no skills here".
 */
function entryNameOf(entry) {
    if (entry === null || entry === undefined) return '';
    if (typeof entry === 'string') return entry;
    return String(entry.name || entry.path || '');
}

function listJsonFiles(io, dir) {
    if (!io || typeof io.listFiles !== 'function') return [];
    var entries;
    try {
        entries = io.listFiles(dir);
    } catch (e) {
        return [];
    }
    if (!Array.isArray(entries)) return [];
    var files = [];
    for (var i = 0; i < entries.length; i++) {
        var name = entryNameOf(entries[i]);
        if (name && name.indexOf('.json', name.length - 5) !== -1) files.push(name);
    }
    return files.sort();
}

function readJson(io, path, warnings, soft) {
    var text = null;
    try {
        text = io.readFile(path);
    } catch (e) {
        text = null;
    }
    if (text === null || text === undefined || !String(text).trim()) {
        if (soft && warnings) warnings.push(path + ': unreadable or empty — skipped');
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw skillError(path + ' is not valid JSON: ' + String(e.message || e));
    }
}

/** The skills of ONE factory dir, keyed by name; duplicates are a hard error. */
function loadFactoryDir(io, dir, warnings) {
    var skills = {};
    var files = listJsonFiles(io, dir);
    for (var i = 0; i < files.length; i++) {
        var path = dir + '/' + files[i];
        var raw = readJson(io, path, warnings, false);
        if (!raw) continue;
        var parsed = validateSkillDefinition(raw, path);
        for (var w = 0; w < parsed.warnings.length; w++) warnings.push(parsed.warnings[w]);
        if (hasKey(skills, parsed.skill.name)) {
            throw skillError('duplicate reviewer name "' + parsed.skill.name + '" in the factory pool (' + dir + ')');
        }
        skills[parsed.skill.name] = parsed.skill;
    }
    return skills;
}

/**
 * The repo dir: same-name files TUNE factory reviewers (tunable fields
 * only), new names define repo reviewers (full skill definition).
 */
function loadRepoDir(io, dir, factorySkills, warnings, repoDefined) {
    var files = listJsonFiles(io, dir);
    for (var i = 0; i < files.length; i++) {
        var path = dir + '/' + files[i];
        var raw = readJson(io, path, warnings, false);
        if (!raw) continue;
        var name = isPlainObject(raw) && isNonEmptyString(raw.name) ? raw.name : '';
        if (name && hasKey(factorySkills, name)) {
            var tuning = validateRepoTuning(raw, factorySkills[name], path);
            for (var w = 0; w < tuning.warnings.length; w++) warnings.push(tuning.warnings[w]);
            factorySkills[name] = applyTuning(factorySkills[name], tuning.tuning);
        } else {
            var defined = validateSkillDefinition(raw, path);
            for (var w2 = 0; w2 < defined.warnings.length; w2++) warnings.push(defined.warnings[w2]);
            if (hasKey(factorySkills, defined.skill.name)) {
                throw skillError('duplicate reviewer name "' + defined.skill.name + '" (' + path + ')');
            }
            factorySkills[defined.skill.name] = defined.skill;
            if (repoDefined) repoDefined.push(defined.skill.name);
        }
    }
}

/** The §8 check 3 lens-citation warning for skills that explicitly allow 🚨. */
function citationHintWarning(skill, lensText) {
    if (skill.mayRaise.indexOf('BLOCKING') === -1) return null;
    if (!lensText) return null; // unreadable lens → the lens-existence check owns it
    var lens = String(lensText).toLowerCase();
    for (var i = 0; i < CITATION_HINT_FRAGMENTS.length; i++) {
        if (lens.indexOf(CITATION_HINT_FRAGMENTS[i]) !== -1) return null;
    }
    return skill.name + ': mayRaise explicitly includes BLOCKING but the lens lacks a citation-discipline hint — ' +
        '🚨 claims stay evidence-bound: state what evidence (file:line / doc URL) raises a finding to BLOCKING';
}

/**
 * The lens-content warnings for one skill: the lens file must exist and be
 * non-empty (§8 check 3 — warned here, the validator script gates hard);
 * the explicit-BLOCKING citation hint rides the same read.
 */
function lensWarnings(io, skill, warnings) {
    var text = null;
    try {
        text = io.readFile(skill.lens);
    } catch (eLens) {
        text = null;
    }
    if (text === null || text === undefined || !String(text).trim()) {
        warnings.push(skill.name + ': lens file missing or empty: ' + skill.lens);
        return;
    }
    var citation = citationHintWarning(skill, text);
    if (citation) warnings.push(citation);
}

/**
 * The pool resolution (§2 + §3): factory skills → repo dir (tune/new) →
 * reviewPolicy.reviewers tuning → promptAppend resolution. config/jobParams
 * resolve the policy exactly like the review legs do
 * (reviewPolicy.resolveReviewPolicy). A policy key naming an unknown
 * reviewer is a hard error at resolution time (§8 check 7 parity — the
 * misconfiguration must fail the leg at start, never silently no-op).
 *
 * Returns { policy, reviewers (resolved array in definition order),
 * appends ({name|base: [paths]}), warnings, factoryNames, repoNames }.
 */
function resolvePool(io, config, jobParams, opts) {
    var options = opts || {};
    var factoryDirs = options.factoryDirs || [FACTORY_DIR];
    var repoDir = options.repoDir || REPO_DIR;
    var warnings = [];
    var factoryNames = [];
    var repoNames = [];
    var skills = {};
    for (var d = 0; d < factoryDirs.length; d++) {
        var dirSkills = loadFactoryDir(io, factoryDirs[d], warnings);
        for (var name in dirSkills) {
            if (!hasKey(dirSkills, name)) continue;
            if (!hasKey(skills, name)) {
                skills[name] = dirSkills[name];
                factoryNames.push(name);
            }
        }
    }
    loadRepoDir(io, repoDir, skills, warnings, repoNames);

    var policy = reviewPolicy.resolveReviewPolicy(config, jobParams);
    // The policy tuning: every key must resolve to a defined reviewer (§8
    // check 7); every value is already shape-validated by reviewPolicy.js.
    for (var tuneName in policy.reviewers) {
        if (!hasKey(policy.reviewers, tuneName)) continue;
        if (!hasKey(skills, tuneName)) {
            throw skillError('reviewPolicy.reviewers names the unknown reviewer "' + tuneName +
                '" — defined reviewers: ' + Object.keys(skills).join(', '));
        }
        skills[tuneName] = applyTuning(skills[tuneName], policy.reviewers[tuneName]);
    }
    // promptAppend: targets resolve to reviewers or 'base'; files must exist
    // (missing → warning — legs fail open; the validator script gates hard).
    var appends = {};
    for (var target in policy.promptAppend) {
        if (!hasKey(policy.promptAppend, target)) continue;
        if (target !== BASE_APPEND_KEY && !hasKey(skills, target)) {
            throw skillError('reviewPolicy.promptAppend names the unknown reviewer "' + target +
                '" — defined reviewers: ' + Object.keys(skills).join(', ') + ' (or "' + BASE_APPEND_KEY + '")');
        }
        var paths = policy.promptAppend[target];
        var resolved = [];
        for (var p = 0; p < paths.length; p++) {
            var text = null;
            try {
                text = io.readFile(paths[p]);
            } catch (eAppend) {
                text = null;
            }
            if (text === null || text === undefined || !String(text).trim()) {
                warnings.push('promptAppend[' + target + ']: file missing or empty: ' + paths[p]);
                continue;
            }
            resolved.push(paths[p]);
        }
        appends[target] = resolved;
    }
    // Lens warnings per defined reviewer (§8 check 3 parity).
    var order = factoryNames.concat(repoNames);
    for (var r = 0; r < order.length; r++) {
        lensWarnings(io, skills[order[r]], warnings);
    }
    var reviewers = [];
    for (var f = 0; f < order.length; f++) reviewers.push(skills[order[f]]);
    return {
        policy: policy,
        reviewers: reviewers,
        appends: appends,
        warnings: warnings,
        factoryNames: factoryNames,
        repoNames: repoNames
    };
}

/** The enabled reviewers of a resolved pool (§2 isEnabled). */
function enabledReviewers(pool) {
    var list = (pool && pool.reviewers) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].isEnabled !== false) out.push(list[i]);
    }
    return out;
}

/** One resolved skill by name, or null. */
function findSkill(pool, name) {
    var list = (pool && pool.reviewers) || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].name === name) return list[i];
    }
    return null;
}

/** The required reviewers of a resolved pool (§7). */
function requiredReviewers(pool) {
    return enabledReviewers(pool).filter(function(s) { return s.isRequired === true; });
}

// ── rounds gating (§6) ───────────────────────────────────────────────────────

/**
 * Do the new hunks hit this reviewer's triggerPaths? An EMPTY triggerPaths
 * list imposes no path limitation (security ships [] — every hunks re-run
 * fires). Otherwise: substring match against the new hunks' file paths.
 */
function triggerPathsHit(triggerPaths, hunkPaths) {
    var triggers = Array.isArray(triggerPaths) ? triggerPaths : [];
    var paths = Array.isArray(hunkPaths) ? hunkPaths : [];
    if (triggers.length === 0) return true;
    for (var t = 0; t < triggers.length; t++) {
        for (var p = 0; p < paths.length; p++) {
            if (String(paths[p]).indexOf(triggers[t]) !== -1) return true;
        }
    }
    return false;
}

/**
 * The §6 rounds decision for one reviewer this round. state:
 *   firstDone     — the reviewer's FIRST full pass already completed (a
 *                   PASS marker exists — completions, not attempts);
 *   hasNewHunks   — new hunks exist since the last reviewed head;
 *   hunksHitTrigger — triggerPathsHit(triggerPaths, newHunkPaths).
 */
function roundsDecide(rounds, state) {
    var list = Array.isArray(rounds) ? rounds : [];
    var s = state || {};
    for (var i = 0; i < list.length; i++) {
        var flag = list[i];
        if (flag === 'all') return true;
        if (flag === 'first' && !s.firstDone) return true;
        if (flag === 'hunks' && s.hasNewHunks && s.hunksHitTrigger) return true;
    }
    return false;
}

/**
 * Should this reviewer's leg run in the round the state describes?
 * isEnabled:false reviewers never run (§2 — the disablement is stated in
 * the review summary every round).
 */
function reviewerShouldRun(skill, state) {
    if (!skill || skill.isEnabled === false) return false;
    return roundsDecide(skill.rounds, state);
}

/**
 * The one-line pool summary for logs / the run-context stamp: the resolved
 * pool's reviewers with their pool-relevant flags.
 */
function poolSummaryLine(pool) {
    var reviewers = (pool && pool.reviewers) || [];
    if (reviewers.length === 0) return 'reviewer pool: (empty)';
    var parts = [];
    for (var i = 0; i < reviewers.length; i++) {
        var s = reviewers[i];
        var flags = [];
        if (s.isRequired) flags.push('required');
        if (s.isEnabled === false) flags.push('disabled');
        if (s.filterWeight === 'high') flags.push('weight:high');
        flags.push(s.rounds.join('+'));
        parts.push(s.name + ' (' + flags.join(', ') + ')');
    }
    return 'reviewer pool: ' + parts.join(' · ');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        FACTORY_DIR: FACTORY_DIR,
        REPO_DIR: REPO_DIR,
        BASE_APPEND_KEY: BASE_APPEND_KEY,
        KNOWN_FIELDS: KNOWN_FIELDS,
        deriveRoleLine: deriveRoleLine,
        validateSkillDefinition: validateSkillDefinition,
        validateRepoTuning: validateRepoTuning,
        applyTuning: applyTuning,
        resolvePool: resolvePool,
        enabledReviewers: enabledReviewers,
        findSkill: findSkill,
        requiredReviewers: requiredReviewers,
        triggerPathsHit: triggerPathsHit,
        roundsDecide: roundsDecide,
        reviewerShouldRun: reviewerShouldRun,
        poolSummaryLine: poolSummaryLine,
        isReviewSkillError: isReviewSkillError
    };
}
