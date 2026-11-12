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
 * SCHEMA lives in reviewPoolSchema.js (the §2 field table, §3 tuning keys,
 * §6 rounds — both modules re-export their half of the API; the public
 * surfaces of reviewPool.js and reviewPolicy.js are unchanged). This
 * module is the pool RESOLUTION layer: factory/repo dir loading, same-name
 * tuning merge, policy tuning, promptAppend resolution, rounds gating.
 *
 * The invariants this module enforces mechanically (§ "The invariants"):
 *   - extend, never replace: a same-name repo file / policy tuning block may
 *     only carry the tunable fields (reviewPoolSchema POL_TUNABLE_FIELDS);
 *   - defaults are the safe general behavior (§2 table): a minimal file
 *     {"name","lens"} defines a FULL reviewer — mayRaise all tiers,
 *     filterWeight normal, isFiltered true, rounds ["all"],
 *     triggerPaths [], options {}, model null, isEnabled true;
 *   - rounds semantics (§6): ["first"] / ["hunks"] / ["first","hunks"] /
 *     ["all"] (exclusive) — `first` counts COMPLETED passes (the PASS
 *     marker), `hunks` fires on new hunks hitting triggerPaths;
 *   - the merge gate (§7, the 2026-11-12 revision): merge gating is POOL
 *     POLICY — reviewPolicy.required names the gating reviewers (repo-owned,
 *     factory default ['base','security']); every reviewer leg stamps a
 *     head-carried PASS marker; the round stamps ONE pool-outcome marker
 *     naming the enabled reviewers and their required flags; required
 *     reviewers without a same-head PASS marker hold the merge (never
 *     silent merge, never
 *     silent approval — gh-957 doctrine).
 *
 * Marker family (the `dmtools:` head-carried shapes) — see
 * reviewPoolMarkers.js; both are trusted only from machine identities
 * (the machineAuthor allowlist — an unconfigured/empty allowlist trusts
 * NOTHING, so a forged PASS marker can never satisfy the gate).
 *
 * Pure module — no dmtools globals (file io injected). Requires hoisted
 * (gh-823 pack-require rule). Keep it GraalJS-clean (var + plain functions,
 * JSON-safe data only).
 */
'use strict';

var reviewPolicy = require('./reviewPolicy.js');
var poolSchema = require('./reviewPoolSchema.js');

// The skill-file error factory rides the schema module (one shared
// ReviewSkillValidationError family for the whole pool).
var skillError = poolSchema.skillError;
var hasKey = poolSchema.hasKey;

// The skill-file directories (§2).
var FACTORY_DIR = 'instructions/review';
var REPO_DIR = '.dmtools/review';

// The sentinel name for pool-wide prompt appends (§3: appends after the
// base contract files, before the lens — a `base` key targets every
// reviewer's prompt assembly).
var BASE_APPEND_KEY = 'base';

// The marker family (§7) — parsed/stamped by reviewPoolMarkers.js; the
// prefixes stay recorded here as the pool's marker-grammar anchor.
var PASS_MARKER_PREFIX = '<!-- dmtools:review-pass ';
var POOL_MARKER_PREFIX = '<!-- dmtools:review-pool ';
var MARKER_SUFFIX = ' -->';

// The required-reviewer hold rides the shared dmtools:merge-hold family
// (one marker grammar; the reason field separates the dedup budgets).
var HOLD_REASON = 'required-reviewer';

// §8 check 3: the citation-discipline hint a lens must contain when the
// skill file EXPLICITLY declares BLOCKING in mayRaise (the check warns —
// the validator script surfaces it; the loader collects it as a warning).
// Either spelling counts: the verb lenses teach ("cite the file:line") or
// the noun ("the citation discipline").
var CITATION_HINT_FRAGMENTS = ['cite', 'citation'];

// ── io primitives (failure-soft; every call is the caller's discretion) ──────

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

function hasJsonSuffix(name) {
    return !!name && name.indexOf('.json', name.length - 5) !== -1;
}

function jsonFileNamesOf(entries) {
    var files = [];
    for (var i = 0; i < entries.length; i++) {
        var name = entryNameOf(entries[i]);
        if (hasJsonSuffix(name)) files.push(name);
    }
    return files.sort();
}

function listJsonFiles(io, dir) {
    if (!io || typeof io.listFiles !== 'function') return [];
    var entries;
    try {
        entries = io.listFiles(dir);
    } catch (eList) {
        return [];
    }
    return Array.isArray(entries) ? jsonFileNamesOf(entries) : [];
}

function readTextSoft(io, path) {
    try {
        return io.readFile(path);
    } catch (eRead) {
        return null;
    }
}

function isEmptyText(text) {
    return text === null || text === undefined || !String(text).trim();
}

function readJson(io, path) {
    var text = readTextSoft(io, path);
    if (isEmptyText(text)) return null;
    try {
        return JSON.parse(text);
    } catch (eParse) {
        throw skillError(path + ' is not valid JSON: ' + String(eParse.message || eParse));
    }
}

// ── the factory dir (§2: full skill definitions; duplicates are errors) ──────

/** The skills of ONE factory dir, keyed by name; duplicates are a hard error. */
function loadFactoryDir(io, dir, warnings) {
    var skills = {};
    var files = listJsonFiles(io, dir);
    for (var i = 0; i < files.length; i++) {
        var path = dir + '/' + files[i];
        var raw = readJson(io, path);
        if (!raw) continue;
        var parsed = poolSchema.validateSkillDefinition(raw, path);
        for (var w = 0; w < parsed.warnings.length; w++) warnings.push(parsed.warnings[w]);
        if (hasKey(skills, parsed.skill.name)) {
            throw skillError('duplicate reviewer name "' + parsed.skill.name + '" in the factory pool (' + dir + ')');
        }
        skills[parsed.skill.name] = parsed.skill;
    }
    return skills;
}

/**
 * All factory dirs, keyed by name, in definition order. Across dirs the
 * FIRST definition of a name wins (one pool, no silent double entries).
 */
function loadFactoryDirs(io, factoryDirs, warnings) {
    var skills = {};
    var names = [];
    for (var d = 0; d < factoryDirs.length; d++) {
        var dirSkills = loadFactoryDir(io, factoryDirs[d], warnings);
        for (var name in dirSkills) {
            if (!hasKey(dirSkills, name)) continue;
            if (hasKey(skills, name)) continue;
            skills[name] = dirSkills[name];
            names.push(name);
        }
    }
    return { skills: skills, names: names };
}

// ── the repo dir (§2: same-name TUNES a factory reviewer; new names define) ──

function repoEntryNameOf(raw) {
    return poolSchema.isPlainObject(raw) && poolSchema.isNonEmptyString(raw.name) ? raw.name : '';
}

/**
 * A same-name repo file tuning a factory reviewer. A name that is ALREADY
 * repo-defined is a duplicate (a repo reviewer is defined once) — §8
 * check 4.
 */
function tuneFactoryEntry(raw, name, path, factorySkills, warnings, repoDefined) {
    if (repoDefined && repoDefined.indexOf(name) !== -1) {
        throw skillError('duplicate reviewer name "' + name + '" (' + path + ') — a repo reviewer is defined once; ' +
            'same-name files may only TUNE factory reviewers');
    }
    var tuning = poolSchema.validateRepoTuning(raw, factorySkills[name], path);
    for (var w = 0; w < tuning.warnings.length; w++) warnings.push(tuning.warnings[w]);
    factorySkills[name] = poolSchema.applyTuning(factorySkills[name], tuning.tuning);
}

/** A repo file defining a NEW reviewer (full skill definition, §2). */
function defineRepoEntry(raw, path, factorySkills, warnings, repoDefined) {
    var defined = poolSchema.validateSkillDefinition(raw, path);
    for (var w2 = 0; w2 < defined.warnings.length; w2++) warnings.push(defined.warnings[w2]);
    if (hasKey(factorySkills, defined.skill.name)) {
        throw skillError('duplicate reviewer name "' + defined.skill.name + '" (' + path + ')');
    }
    factorySkills[defined.skill.name] = defined.skill;
    if (repoDefined) repoDefined.push(defined.skill.name);
}

function loadRepoEntry(io, path, factorySkills, warnings, repoDefined) {
    var raw = readJson(io, path);
    if (!raw) return;
    var name = repoEntryNameOf(raw);
    if (name && hasKey(factorySkills, name)) {
        tuneFactoryEntry(raw, name, path, factorySkills, warnings, repoDefined);
        return;
    }
    defineRepoEntry(raw, path, factorySkills, warnings, repoDefined);
}

/**
 * The repo dir: same-name files TUNE factory reviewers (tunable fields
 * only), new names define repo reviewers (full skill definition).
 */
function loadRepoDir(io, dir, factorySkills, warnings, repoDefined) {
    var files = listJsonFiles(io, dir);
    for (var i = 0; i < files.length; i++) {
        loadRepoEntry(io, dir + '/' + files[i], factorySkills, warnings, repoDefined);
    }
}

// ── lens warnings (§8 check 3 parity) ────────────────────────────────────────

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
    var text = readTextSoft(io, skill.lens);
    if (isEmptyText(text)) {
        warnings.push(skill.name + ': lens file missing or empty: ' + skill.lens);
        return;
    }
    var citation = citationHintWarning(skill, text);
    if (citation) warnings.push(citation);
}

function poolLensWarnings(io, skills, order, warnings) {
    for (var r = 0; r < order.length; r++) {
        lensWarnings(io, skills[order[r]], warnings);
    }
}

// ── policy tuning (§3: reviewPolicy.reviewers + promptAppend) ────────────────

/**
 * The reviewPolicy.reviewers tuning: every key must resolve to a defined
 * reviewer (§8 check 7); every value is already shape-validated by
 * reviewPolicy.js. A policy key naming an unknown reviewer is a hard error
 * at resolution time (the misconfiguration must fail the leg at start,
 * never silently no-op).
 */
function applyPolicyTuning(policy, skills) {
    for (var tuneName in policy.reviewers) {
        if (!hasKey(policy.reviewers, tuneName)) continue;
        if (!hasKey(skills, tuneName)) {
            throw skillError('reviewPolicy.reviewers names the unknown reviewer "' + tuneName +
                '" — defined reviewers: ' + Object.keys(skills).join(', '));
        }
        skills[tuneName] = poolSchema.applyTuning(skills[tuneName], policy.reviewers[tuneName]);
    }
}

function appendFileReadable(io, path) {
    var text = readTextSoft(io, path);
    return text !== null && text !== undefined && !!String(text).trim();
}

/** One promptAppend target: readable files resolve, missing ones warn (§3). */
function resolveAppendPaths(io, target, paths, warnings) {
    var resolved = [];
    for (var p = 0; p < paths.length; p++) {
        if (appendFileReadable(io, paths[p])) resolved.push(paths[p]);
        else warnings.push('promptAppend[' + target + ']: file missing or empty: ' + paths[p]);
    }
    return resolved;
}

/**
 * promptAppend: targets resolve to reviewers or 'base'; files must exist
 * (missing → warning — legs fail open; the validator script gates hard).
 */
function resolvedAppendsOf(io, policy, skills, warnings) {
    var appends = {};
    for (var target in policy.promptAppend) {
        if (!hasKey(policy.promptAppend, target)) continue;
        if (target !== BASE_APPEND_KEY && !hasKey(skills, target)) {
            throw skillError('reviewPolicy.promptAppend names the unknown reviewer "' + target +
                '" — defined reviewers: ' + Object.keys(skills).join(', ') + ' (or "' + BASE_APPEND_KEY + '")');
        }
        appends[target] = resolveAppendPaths(io, target, policy.promptAppend[target], warnings);
    }
    return appends;
}

// ── the pool resolution (§2 + §3) ────────────────────────────────────────────

/**
 * The pool resolution (§2 + §3): factory skills → repo dir (tune/new) →
 * reviewPolicy.reviewers tuning → promptAppend resolution. config/jobParams
 * resolve the policy exactly like the review legs do
 * (reviewPolicy.resolveReviewPolicy).
 *
 * Returns { policy, reviewers (resolved array in definition order),
 * appends ({name|base: [paths]}), warnings, factoryNames, repoNames }.
 */
function resolvePool(io, config, jobParams, opts) {
    var options = opts || {};
    var warnings = [];
    var factory = loadFactoryDirs(io, options.factoryDirs || [FACTORY_DIR], warnings);
    var skills = factory.skills;
    var repoNames = [];
    loadRepoDir(io, options.repoDir || REPO_DIR, skills, warnings, repoNames);
    var policy = reviewPolicy.resolveReviewPolicy(config, jobParams);
    applyPolicyTuning(policy, skills);
    var appends = resolvedAppendsOf(io, policy, skills, warnings);
    var order = factory.names.concat(repoNames);
    poolLensWarnings(io, skills, order, warnings);
    var reviewers = [];
    for (var f = 0; f < order.length; f++) reviewers.push(skills[order[f]]);
    var probe = { reviewers: reviewers, policy: policy };
    var unresolved = unresolvedRequiredNames(probe);
    if (unresolved.length > 0) {
        if (policy.requiredIsDefault) {
            // The factory default list adapts to what actually loaded (an io
            // failure or a trimmed factory dir must keep the fail-soft
            // resolvePool contract — the gate applies to loaded reviewers).
            warnings.push('reviewPolicy.required (factory default) names reviewer(s) not loaded: ' +
                unresolved.join(', ') + ' — the merge gate applies to loaded reviewers only');
        } else {
            throw poolSchema.skillError('reviewPolicy.required names unknown reviewer(s): ' +
                unresolved.join(', ') + ' — loaded reviewers: ' + order.join(', ') +
                ' (a misspelled gate silently gates nothing)');
        }
    }
    for (var d = 0; d < disabledRequiredNames(probe).length; d++) {
        warnings.push('reviewPolicy.required names disabled reviewer "' +
            disabledRequiredNames(probe)[d] + '" — it never runs, so it cannot gate the merge');
    }
    return {
        policy: policy,
        reviewers: reviewers,
        appends: appends,
        warnings: warnings,
        factoryNames: factory.names,
        repoNames: repoNames
    };
}

// ── pool views (§2 isEnabled, §7 required) ───────────────────────────────────

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

/** The required names of a resolved pool (§7 — reviewPolicy.required). */
function requiredNamesOf(pool) {
    var req = pool && pool.policy && pool.policy.required;
    return Array.isArray(req) ? req : [];
}

/** True when the pool's reviewPolicy.required names this reviewer. */
function isRequiredReviewer(pool, name) {
    return requiredNamesOf(pool).indexOf(name) !== -1;
}

/**
 * The required reviewers of a resolved pool (§7): enabled AND named by
 * reviewPolicy.required. A required-but-disabled reviewer never runs, so it
 * can never gate (resolvePool warns instead of deadlocking the merge lane).
 */
function requiredReviewers(pool) {
    var req = requiredNamesOf(pool);
    return enabledReviewers(pool).filter(function(s) { return req.indexOf(s.name) !== -1; });
}

/**
 * §8 check 8: every reviewPolicy.required entry must name a LOADED reviewer
 * (enabled or not). Returns the list of unresolved names — resolvePool turns
 * a non-empty list into a hard error ("a misspelled gate silently gates
 * nothing"), the validator surfaces the same through this predicate.
 */
function unresolvedRequiredNames(pool) {
    var req = requiredNamesOf(pool);
    var out = [];
    for (var i = 0; i < req.length; i++) {
        if (!findSkill(pool, req[i])) out.push(req[i]);
    }
    return out;
}

/** §7 warn: required entries naming reviewers the pool loaded but disabled. */
function disabledRequiredNames(pool) {
    var req = requiredNamesOf(pool);
    var out = [];
    for (var i = 0; i < req.length; i++) {
        var s = findSkill(pool, req[i]);
        if (s && s.isEnabled === false) out.push(req[i]);
    }
    return out;
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

/** Does ONE rounds flag fire for the round the state describes? */
function roundFlagFires(flag, s) {
    if (flag === 'all') return true;
    if (flag === 'first') return !s.firstDone;
    if (flag === 'hunks') return !!s.hasNewHunks && !!s.hunksHitTrigger;
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
        if (roundFlagFires(list[i], s)) return true;
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
        if (isRequiredReviewer(pool, s.name)) flags.push('required');
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
        KNOWN_FIELDS: poolSchema.KNOWN_FIELDS,
        deriveRoleLine: poolSchema.deriveRoleLine,
        validateSkillDefinition: poolSchema.validateSkillDefinition,
        validateRepoTuning: poolSchema.validateRepoTuning,
        applyTuning: poolSchema.applyTuning,
        resolvePool: resolvePool,
        enabledReviewers: enabledReviewers,
        findSkill: findSkill,
        requiredReviewers: requiredReviewers,
        requiredNamesOf: requiredNamesOf,
        isRequiredReviewer: isRequiredReviewer,
        unresolvedRequiredNames: unresolvedRequiredNames,
        disabledRequiredNames: disabledRequiredNames,
        triggerPathsHit: triggerPathsHit,
        roundsDecide: roundsDecide,
        reviewerShouldRun: reviewerShouldRun,
        poolSummaryLine: poolSummaryLine,
        isReviewSkillError: poolSchema.isReviewSkillError
    };
}
