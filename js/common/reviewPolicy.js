/**
 * reviewPolicy.js — the gh-1351 `reviewPolicy` config (epic gh-1328 §1,
 * §3-verdict, §4.6): preset tables, the resolution chain
 * (projectConfig.reviewPolicy → workflow jobParams → built-in `default`),
 * hard validation at leg start, the machine approval recomputation from the
 * severity census + resolved policy, the legacy-knob audit and the density
 * control.
 *
 * Doctrine (epic gh-1328, owner directive 2026-11-02):
 *  - The review verdict is a MACHINE decision computed from the severity
 *    census + the resolved policy. The model's `recommendation` token is
 *    advisory: an APPROVE riding open 🚨/⚠️ threads is recomputed to
 *    REQUEST_CHANGES; a REQUEST_CHANGES over a rework-tier-clean census is
 *    recomputed to APPROVE (suggestion-only cycles must converge).
 *  - Missing config → the built-in `default` preset, silently. Malformed
 *    config (unknown tier, bad enum, unknown bounds key) → a hard
 *    ReviewPolicyValidationError at leg start — looseness must be explicit,
 *    never a parse accident.
 *  - Non-configurable invariants: every thread reaches a terminal
 *    disposition; a deferral needs its ledger item (gh-1352); human threads
 *    are never machine-resolved (gh-744). What IS configurable per repo:
 *    every tier incl. BLOCKING may be weakened by explicit config — the
 *    config IS the owner's standing approval.
 *  - Legacy knobs (`allowApproveWithSuggestions`,
 *    `importantBlocksApproval`, `maxReviewThreadsBeforeForceApprove`) are
 *    derived from / rejected alongside the policy; a conflict is logged and
 *    the policy wins.
 *
 * Pure module — no dmtools globals; JSON-safe data only. Keep it
 * GraalJS-clean (var + plain functions). The identity block passes through
 * untouched: gh-1332 (findingRegistry.resolveIdentityPolicy) owns those
 * knobs.
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');

// The 4-tier severity enum (gh-1351: NIT joins BLOCKING/IMPORTANT/SUGGESTION).
var TIERS = ['BLOCKING', 'IMPORTANT', 'SUGGESTION', 'NIT'];

// The per-tier lap + fix enums (epic §4.2 schema).
var ROUND_VALUES = ['rework', 'polish', 'none'];
var FIX_VALUES = ['mandatory', 'opportunistic', 'never'];

// gh-1403: the finding-verification stage — `none` (default, the review leg
// is the only gate) or `filter` (a fresh-context ReviewFilter pass verifies
// each rework/polish-tier candidate before it costs a lap; the ByteDance
// BitsAI-CR pattern). Majority voting may later land as `filter` with N
// passes — the enum stays two-valued until that trial data exists.
var VERIFICATION_VALUES = ['none', 'filter'];

// The known presets (epic §4.2).
var PRESETS = ['default', 'fix-everything', 'relaxed', 'investigation'];

// The epic's per-preset tier tables. `fix-everything` upgrades NIT to the
// polish lap with mandatory fix ("nits always fixed"); `relaxed` makes
// suggestions optional (round none — no lap, triage closes); `investigation`
// is pure signal: every tier round none + fix never (triage closes
// everything incl. 🚨 — the owner standing-approval doctrine).
var PRESET_TABLES = {
    'default': {
        BLOCKING: { round: 'rework', fix: 'mandatory' },
        IMPORTANT: { round: 'rework', fix: 'mandatory' },
        SUGGESTION: { round: 'polish', fix: 'mandatory' },
        NIT: { round: 'none', fix: 'opportunistic' }
    },
    'fix-everything': {
        BLOCKING: { round: 'rework', fix: 'mandatory' },
        IMPORTANT: { round: 'rework', fix: 'mandatory' },
        SUGGESTION: { round: 'polish', fix: 'mandatory' },
        NIT: { round: 'polish', fix: 'mandatory' }
    },
    'relaxed': {
        BLOCKING: { round: 'rework', fix: 'mandatory' },
        IMPORTANT: { round: 'rework', fix: 'mandatory' },
        SUGGESTION: { round: 'none', fix: 'opportunistic' },
        NIT: { round: 'none', fix: 'opportunistic' }
    },
    'investigation': {
        BLOCKING: { round: 'none', fix: 'never' },
        IMPORTANT: { round: 'none', fix: 'never' },
        SUGGESTION: { round: 'none', fix: 'never' },
        NIT: { round: 'none', fix: 'never' }
    }
};

// The epic's default bounds (epic §4.2 example). The density keys feed the
// §4.6 formula: allowed = clamp(round(base + k*sqrt(additions/unit)), min, max).
var DEFAULT_BOUNDS = {
    polishMaxThreads: 6,
    polishMaxChangedLines: 80,
    opportunisticMaxThreads: 8,
    opportunisticSameFilesOnly: true,
    densityBase: 2,
    densityK: 3,
    densityUnit: 200,
    densityMin: 2,
    densityMax: 8,
    sweepBatch: 10,
    sweepMaxAgeDays: 30
};

// Bounds key → expected value type ('number' | 'boolean'). Unknown keys are a
// hard validation error — looseness must be explicit.
var BOUNDS_TYPES = {
    polishMaxThreads: 'number',
    polishMaxChangedLines: 'number',
    opportunisticMaxThreads: 'number',
    opportunisticSameFilesOnly: 'boolean',
    densityBase: 'number',
    densityK: 'number',
    densityUnit: 'number',
    densityMin: 'number',
    densityMax: 'number',
    sweepBatch: 'number',
    sweepMaxAgeDays: 'number'
};

// Tier → the normalized census key the verdict record carries
// (normalizeIssueCounts spells them plural: suggestions, nits).
var CENSUS_KEY_BY_TIER = {
    BLOCKING: 'blocking',
    IMPORTANT: 'important',
    SUGGESTION: 'suggestions',
    NIT: 'nits'
};

// Tier → the emoji the review instructions stamp on threads (the policy
// table render reads the same vocabulary).
var TIER_EMOJI = {
    BLOCKING: '\uD83D\uDEA8',
    IMPORTANT: '\u26A0\uFE0F',
    SUGGESTION: '\uD83D\uDCA1',
    NIT: '\uD83E\uDEB6'
};

var ERROR_NAME = 'ReviewPolicyValidationError';

function policyError(message) {
    var e = new Error(message);
    e.name = ERROR_NAME;
    return e;
}

function isReviewPolicyError(e) {
    return !!e && e.name === ERROR_NAME;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The epic schema spells the fix value 'oportunistic'; both spellings are the
// same enum value (canonicalized to the standard spelling).
function canonicalFixValue(value) {
    var v = String(value);
    if (v === 'oportunistic') return 'opportunistic';
    return v;
}

function hasKey(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function unknownKeysOf(raw, known) {
    var unknown = [];
    for (var k in raw) {
        if (hasKey(raw, k) && !hasKey(known, k)) unknown.push(k);
    }
    return unknown;
}

function numericBound(key, value) {
    var n = typeof value === 'number' ? value : Number(value);
    if (isNaN(n) || !isFinite(n)) {
        throw policyError('reviewPolicy.bounds.' + key + ' must be a number, got: ' + JSON.stringify(value));
    }
    if (n <= 0) {
        throw policyError('reviewPolicy.bounds.' + key + ' must be a positive number, got: ' + n);
    }
    return n;
}

/**
 * Validates + normalizes the bounds block. Unknown keys, wrong types and
 * non-positive numbers are hard validation errors.
 */
function validateBounds(raw) {
    var unknown = unknownKeysOf(raw, BOUNDS_TYPES);
    if (unknown.length > 0) {
        throw policyError('reviewPolicy.bounds has unknown key(s): ' + unknown.join(', ') +
            ' — known keys: ' + Object.keys(BOUNDS_TYPES).join(', '));
    }
    var out = {};
    for (var key in raw) {
        if (!hasKey(raw, key)) continue;
        if (BOUNDS_TYPES[key] === 'boolean') {
            if (typeof raw[key] !== 'boolean') {
                throw policyError('reviewPolicy.bounds.' + key + ' must be a boolean, got: ' + JSON.stringify(raw[key]));
            }
            out[key] = raw[key];
            continue;
        }
        out[key] = numericBound(key, raw[key]);
    }
    return out;
}

/**
 * Validates + normalizes one severity entry: both the lap enum (round) and
 * the fix enum are required, unknown values are hard errors.
 */
function validateSeverityEntry(tier, raw) {
    if (!isPlainObject(raw)) {
        throw policyError('reviewPolicy.severities.' + tier + ' must be an object with round and fix');
    }
    if (!raw.round) {
        throw policyError('reviewPolicy.severities.' + tier + ' is missing the round key (' + ROUND_VALUES.join('|') + ')');
    }
    if (!raw.fix) {
        throw policyError('reviewPolicy.severities.' + tier + ' is missing the fix key (' + FIX_VALUES.join('|') + ')');
    }
    if (ROUND_VALUES.indexOf(raw.round) === -1) {
        throw policyError('reviewPolicy.severities.' + tier + '.round has an invalid value: ' +
            JSON.stringify(raw.round) + ' — expected one of ' + ROUND_VALUES.join('|'));
    }
    var fix = canonicalFixValue(raw.fix);
    if (FIX_VALUES.indexOf(fix) === -1) {
        throw policyError('reviewPolicy.severities.' + tier + '.fix has an invalid value: ' +
            JSON.stringify(raw.fix) + ' — expected one of ' + FIX_VALUES.join('|'));
    }
    return { round: raw.round, fix: fix };
}

/** Shape gate: the policy must be a plain object with known keys only. */
function validatePolicyShape(raw) {
    if (!isPlainObject(raw)) {
        throw policyError('reviewPolicy must be an object { preset, severities, bounds, identity, verification }, got: ' + JSON.stringify(raw));
    }
    var unknown = unknownKeysOf(raw, { preset: 1, severities: 1, bounds: 1, identity: 1, verification: 1 });
    if (unknown.length > 0) {
        throw policyError('reviewPolicy has unknown key(s): ' + unknown.join(', ') +
            ' — known keys: preset, severities, bounds, identity, verification');
    }
}

/**
 * gh-1403: the verification value — `none` (default) or `filter`. An absent
 * value rides `none` silently (owners opt in); a present-but-invalid value
 * is a hard validation error, exactly like the other policy enums.
 */
function resolveVerification(raw) {
    if (!hasKey(raw, 'verification') || raw.verification === undefined || raw.verification === null) {
        return 'none';
    }
    if (typeof raw.verification !== 'string' || VERIFICATION_VALUES.indexOf(raw.verification) === -1) {
        throw policyError('reviewPolicy.verification has an invalid value: ' + JSON.stringify(raw.verification) +
            ' — expected one of ' + VERIFICATION_VALUES.join(' | '));
    }
    return raw.verification;
}

/** The preset name of a shaped policy — an absent/null preset rides `default`. */
function resolvePresetOf(raw) {
    var preset = hasKey(raw, 'preset') && raw.preset !== undefined && raw.preset !== null
        ? raw.preset : 'default';
    if (PRESETS.indexOf(preset) === -1) {
        throw policyError('reviewPolicy.preset has an invalid value: ' + JSON.stringify(preset) +
            ' — expected one of ' + PRESETS.join(' | '));
    }
    return preset;
}

/**
 * The severity table: the preset's tier table first, then the raw
 * severities block overrides only the tiers it names.
 */
function severityTableFor(preset, rawSeverities) {
    var severities = {};
    var table = PRESET_TABLES[preset];
    for (var t = 0; t < TIERS.length; t++) {
        severities[TIERS[t]] = {
            round: table[TIERS[t]].round,
            fix: table[TIERS[t]].fix
        };
    }
    if (rawSeverities === undefined || rawSeverities === null) return severities;
    if (!isPlainObject(rawSeverities)) {
        throw policyError('reviewPolicy.severities must be an object keyed by tier (' + TIERS.join(', ') + ')');
    }
    var unknownTiers = unknownKeysOf(rawSeverities, CENSUS_KEY_BY_TIER);
    if (unknownTiers.length > 0) {
        throw policyError('reviewPolicy.severities has unknown tier(s): ' + unknownTiers.join(', ') +
            ' — known tiers: ' + TIERS.join(', '));
    }
    for (var tier in rawSeverities) {
        if (hasKey(rawSeverities, tier)) severities[tier] = validateSeverityEntry(tier, rawSeverities[tier]);
    }
    return severities;
}

/** The bounds block: the epic defaults first, then validated overrides. */
function boundsOrDefault(raw) {
    var bounds = {};
    for (var b in DEFAULT_BOUNDS) {
        if (hasKey(DEFAULT_BOUNDS, b)) bounds[b] = DEFAULT_BOUNDS[b];
    }
    if (raw.bounds === undefined || raw.bounds === null) return bounds;
    if (!isPlainObject(raw.bounds)) {
        throw policyError('reviewPolicy.bounds must be an object');
    }
    var rawBounds = validateBounds(raw.bounds);
    for (var bk in rawBounds) {
        if (hasKey(rawBounds, bk)) bounds[bk] = rawBounds[bk];
    }
    return bounds;
}

/**
 * Validates + normalizes a RAW reviewPolicy value (whatever stood in
 * projectConfig.reviewPolicy or jobParams.reviewPolicy). Unknown tiers,
 * bad enums, unknown preset/bounds keys and non-object shapes are hard
 * ReviewPolicyValidationErrors; a partial config rides the default preset
 * table for everything it does not name.
 */
function validateReviewPolicy(raw, source) {
    validatePolicyShape(raw);
    var preset = resolvePresetOf(raw);
    if (raw.identity !== undefined && raw.identity !== null && !isPlainObject(raw.identity)) {
        throw policyError('reviewPolicy.identity must be an object (gh-1332 knobs)');
    }
    return {
        preset: preset,
        source: source || 'built-in default',
        verification: resolveVerification(raw),
        severities: severityTableFor(preset, raw.severities),
        bounds: boundsOrDefault(raw),
        identity: raw.identity || {}
    };
}

/** The built-in default preset as a fresh policy object. */
function defaultPolicy() {
    return validateReviewPolicy({}, 'built-in default');
}

/** A named preset as a fresh policy object (source: built-in preset). */
function presetPolicy(name) {
    if (PRESETS.indexOf(name) === -1) {
        throw policyError('unknown preset: ' + name + ' — expected one of ' + PRESETS.join(' | '));
    }
    return validateReviewPolicy({ preset: name }, 'built-in preset');
}

/**
 * Parses a possibly-JSON-string policy value (workflow jobParams carry
 * strings; dmtools CLI overrides parse JSON arrays/objects, but a raw
 * string survives some paths).
 */
function parseMaybeJson(value, source) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        throw policyError('reviewPolicy (' + source + ') is not valid JSON: ' + String(value).substring(0, 120));
    }
}

/**
 * The resolution chain (epic §4.2): projectConfig.reviewPolicy → workflow
 * jobParams → built-in `default`. Missing → default, silent. Malformed →
 * a hard ReviewPolicyValidationError (the caller fails the leg with the
 * message).
 */
function resolveReviewPolicy(config, jobParams) {
    var fromConfig = config ? config.reviewPolicy : undefined;
    if (fromConfig !== undefined && fromConfig !== null) {
        return validateReviewPolicy(fromConfig, 'projectConfig.reviewPolicy');
    }
    var fromParams = jobParams ? jobParams.reviewPolicy : undefined;
    if (fromParams !== undefined && fromParams !== null) {
        return validateReviewPolicy(parseMaybeJson(fromParams, 'jobParams.reviewPolicy'), 'jobParams.reviewPolicy');
    }
    return defaultPolicy();
}

/**
 * The census count of the FIRST (severity-ordered) tier whose policy round
 * is `rework` — the approval-gating census. { count, tier } with count 0 /
 * tier null when no rework-tier thread is open.
 */
function gatingCensusCount(census, policy) {
    var p = policy || defaultPolicy();
    var counts = census || {};
    for (var i = 0; i < TIERS.length; i++) {
        var tier = TIERS[i];
        var sev = p.severities[tier];
        if (!sev || sev.round !== 'rework') continue;
        var n = reviewVerdicts.censusCount(counts[CENSUS_KEY_BY_TIER[tier]]);
        if (n > 0) return { count: n, tier: tier };
    }
    return { count: 0, tier: null };
}

/**
 * The verdict gate (gh-1351): do any approval-gating threads remain? Under
 * the default policy that is exactly "any 🚨 BLOCKING or ⚠️ IMPORTANT open";
 * an explicit config may weaken any tier incl. BLOCKING (owner
 * standing-approval doctrine), which this read honors.
 */
function hasBlockingOrImportant(census, policy) {
    return gatingCensusCount(census, policy).count > 0;
}

/**
 * The machine approval recomputation (epic §1 plumbing): the advisory token
 * in, the EFFECTIVE verdict out.
 *   - BLOCK passes through: a security/data-loss call is model-classified,
 *     the census cross-check keeps its census honest.
 *   - Any rework-tier thread open → REQUEST_CHANGES, whatever the token said.
 *   - Otherwise (only 💡/🪶 or clean) → APPROVE, whatever the token said —
 *     a suggestion-only cycle must converge.
 * `recomputed` flags a token the machine overrode (for the audit log).
 */
function machineApprovalDecision(rawRecommendation, census, policy) {
    var raw = String(rawRecommendation || '').toUpperCase();
    if (raw === 'BLOCK') {
        return { approved: false, verdict: 'BLOCK', reason: 'model BLOCK (security/data-loss) stands', recomputed: false };
    }
    var gating = gatingCensusCount(census, policy);
    if (gating.count > 0) {
        return {
            approved: false,
            verdict: 'REQUEST_CHANGES',
            reason: TIER_EMOJI[gating.tier] + ' ' + gating.tier + ' open (' + gating.count + ') — gates approval per reviewPolicy',
            recomputed: raw !== 'REQUEST_CHANGES'
        };
    }
    return {
        approved: true,
        verdict: 'APPROVE',
        reason: 'no rework-tier threads open (only polish/none tiers) — converges per reviewPolicy',
        recomputed: raw !== 'APPROVE'
    };
}

/**
 * The legacy-knob audit (epic §1 "Legacy knobs reconcile"): each knob is
 * derived from the resolved policy; an explicit value that disagrees is
 * logged as a conflict and the policy wins. Returns { lines, derived } —
 * the caller logs the lines verbatim.
 */
function derivedKnobsOf(p) {
    return {
        allowApproveWithSuggestions: true,
        importantBlocksApproval: p.severities.IMPORTANT.round === 'rework',
        maxReviewThreadsBeforeForceApprove: p.bounds.densityMax
    };
}

/** allowApproveWithSuggestions=false is a policy conflict — one audit line. */
function auditAllowApproveWithSuggestionsKnob(customParams, p) {
    if (!customParams || customParams.allowApproveWithSuggestions !== false) return null;
    return 'reviewPolicy: legacy allowApproveWithSuggestions=false conflicts with the resolved policy (' +
        p.preset + ') — policy wins: only rework-tier (' + TIER_EMOJI.BLOCKING + '/' + TIER_EMOJI.IMPORTANT +
        ') findings gate approval';
}

/** An explicit importantBlocksApproval that disagrees — one audit line. */
function auditImportantBlocksApprovalKnob(customParams, derived) {
    if (!customParams || typeof customParams.importantBlocksApproval !== 'boolean' ||
        customParams.importantBlocksApproval === derived.importantBlocksApproval) return null;
    return 'reviewPolicy: legacy importantBlocksApproval=' + customParams.importantBlocksApproval +
        ' conflicts with the resolved policy — policy wins: IMPORTANT ' +
        (derived.importantBlocksApproval ? 'gates' : 'does not gate') + ' approval';
}

/** The thread-limit force-approve knob is rejected alongside the policy. */
function auditMaxReviewThreadsKnob(customParams, p) {
    if (!customParams || !(customParams.maxReviewThreadsBeforeForceApprove > 0)) return null;
    return 'reviewPolicy: legacy maxReviewThreadsBeforeForceApprove=' +
        customParams.maxReviewThreadsBeforeForceApprove + ' is rejected alongside the policy — thread budgets are ' +
        'policy bounds (densityMax=' + p.bounds.densityMax + ', polishMaxThreads=' + p.bounds.polishMaxThreads + ')';
}

function legacyKnobAudit(customParams, policy) {
    var p = policy || defaultPolicy();
    var derived = derivedKnobsOf(p);
    var lines = [];
    var first = auditAllowApproveWithSuggestionsKnob(customParams, p);
    if (first) lines.push(first);
    var second = auditImportantBlocksApprovalKnob(customParams, derived);
    if (second) lines.push(second);
    var third = auditMaxReviewThreadsKnob(customParams, p);
    if (third) lines.push(third);
    return { lines: lines, derived: derived };
}

/**
 * The §4.6 density cap for 💡/🪶 threads:
 *   allowed = clamp(round(base + k*sqrt(additions/unit)), min, max)
 * Calibrated 2026-11-02: 20→3 · 50→4 · 200→5 · 800→8. Missing additions
 * ride the floor (fail closed to the minimum).
 */
function allowedSuggestionThreads(additions, bounds) {
    var b = bounds || DEFAULT_BOUNDS;
    var raw = b.densityBase + b.densityK * Math.sqrt((additions || 0) / b.densityUnit);
    var rounded = Math.round(raw);
    if (rounded < b.densityMin) return b.densityMin;
    if (rounded > b.densityMax) return b.densityMax;
    return rounded;
}

/**
 * The machine-side density audit (epic §4.6 "machine side audits, warn
 * only"): the POSTED 💡/🪶 thread census vs the allowed cap for the diff
 * size. Digest lines are the overflow channel, not posted threads — they
 * never overflow. 🚨/⚠️ threads are never capped and never counted here.
 * Warn-only by contract: the worst outcome is a warning line.
 */
function densityAudit(census, additions, bounds) {
    var counts = census || {};
    var posted = reviewVerdicts.censusCount(counts.suggestions) + reviewVerdicts.censusCount(counts.nits);
    var allowed = allowedSuggestionThreads(additions, bounds);
    if (posted <= allowed) {
        return { allowed: allowed, posted: posted, overflow: false, warning: null };
    }
    return {
        allowed: allowed,
        posted: posted,
        overflow: true,
        warning: 'density audit (gh-1351): ' + posted + ' 💡/🪶 threads posted on a ~' +
            (additions || 0) + '-line diff — the policy cap allows ' + allowed +
            '; rank findings, post top-K as threads, overflow becomes a ranked digest list in the general comment'
    };
}

/**
 * The policy table stamp for review/rework run contexts (epic §1 plumbing):
 * the resolved table + the resolution source + the machine-enforcement
 * doctrine, so every leg (and the agent reading its input folder) sees the
 * SAME policy the machine enforces.
 */
function policyTableMarkdown(policy) {
    var p = policy || defaultPolicy();
    var lines = ['## Review policy', ''];
    lines.push('Preset: `' + p.preset + '` — resolved from: ' + p.source +
        ' (resolution chain: projectConfig.reviewPolicy → workflow jobParams → built-in default).');
    lines.push('');
    return lines.concat(policyTableBody(p)).join('\n');
}

/**
 * Table body without the title — the review summary comment renders its own
 * heading, so it stamps just the table + bounds + enforcement doctrine.
 */
function policyTableBody(p) {
    var lines = [];
    lines.push('| Severity | Round | Fix | Gates approval |');
    lines.push('|---|---|---|---|');
    for (var i = 0; i < TIERS.length; i++) {
        var tier = TIERS[i];
        var sev = p.severities[tier];
        lines.push('| ' + TIER_EMOJI[tier] + ' ' + tier + ' | ' + sev.round + ' | ' + sev.fix + ' | ' +
            (sev.round === 'rework' ? 'YES' : 'no') + ' |');
    }
    lines.push('');
    lines.push('Verification: `' + p.verification + '` — ' + verificationPhrase(p.verification) + '.');
    lines.push('');
    lines.push('Bounds: polishMaxThreads=' + p.bounds.polishMaxThreads +
        ' · polishMaxChangedLines=' + p.bounds.polishMaxChangedLines +
        ' · opportunisticMaxThreads=' + p.bounds.opportunisticMaxThreads +
        ' · opportunisticSameFilesOnly=' + p.bounds.opportunisticSameFilesOnly +
        ' · densityMin=' + p.bounds.densityMin +
        ' · densityMax=' + p.bounds.densityMax +
        ' · sweepBatch=' + p.bounds.sweepBatch +
        ' · sweepMaxAgeDays=' + p.bounds.sweepMaxAgeDays);
    lines.push('');
    lines.push('Density cap (' + TIER_EMOJI.SUGGESTION + '/' + TIER_EMOJI.NIT + ' threads only; ' +
        TIER_EMOJI.BLOCKING + '/' + TIER_EMOJI.IMPORTANT + ' never capped): ' +
        'allowed = clamp(round(' + p.bounds.densityBase + ' + ' + p.bounds.densityK +
        '*sqrt(additions/' + p.bounds.densityUnit + ')), ' + p.bounds.densityMin + ', ' + p.bounds.densityMax + ').');
    lines.push('Rank your findings and post the top-K as threads; the overflow becomes a ranked digest list in the general comment. ' +
        'The census counts posted threads + digest lines.');
    lines.push('');
    lines.push('Machine enforcement: the approval is recomputed from the severity census + this policy — ' +
        'the model verdict is advisory. Any ' + TIER_EMOJI.BLOCKING + ' or ' + TIER_EMOJI.IMPORTANT +
        ' open → REQUEST_CHANGES; only ' + TIER_EMOJI.SUGGESTION + '/' + TIER_EMOJI.NIT + ' → APPROVE.');
    return lines.join('\n');
}

/**
 * gh-1403: the one-line verification-mode phrase the policy stamps carry —
 * what the mode means for this run's findings.
 */
function verificationPhrase(verification) {
    if (verification === 'filter') {
        return 'rework/polish-tier findings are re-verified by a fresh-context filter pass ' +
            'before posting (keep | demote | drop); drops become digest lines, demotes tier downgrades';
    }
    return 'findings post exactly as the review leg raised them — no second-stage verification';
}

/**
 * The gh-1351 run-context file body (review/rework input `review_policy.md`,
 * epic §1 plumbing): the resolved policy table PLUS the agent duties the
 * machine enforces — density top-K/digest discipline and the downgrade
 * protocol. One canonical document for every leg that reads it.
 */
function policyInputContextMarkdown(policy) {
    var p = policy || defaultPolicy();
    var lines = [];
    lines.push('# Review Policy');
    lines.push('');
    lines.push('Preset: `' + p.preset + '` — resolved from: ' + p.source +
        ' (resolution chain: projectConfig.reviewPolicy → workflow jobParams → built-in default).');
    lines.push('Verification: `' + p.verification + '` — ' + verificationPhrase(p.verification) + '.');
    lines.push('Every verdict on this PR is traceable to this table.');
    lines.push('');
    lines.push(policyTableBody(p));
    lines.push('## Downgrade protocol');
    lines.push('');
    lines.push('A rework lap may downgrade a specific ' + TIER_EMOJI.IMPORTANT +
        ' IMPORTANT finding to ' + TIER_EMOJI.SUGGESTION + ' SUGGESTION **only with a written justification** ' +
        'in the census (the thread reply and the response summary: why this is not maintainability debt). ' +
        'A silent downgrade does not exist: the next review round re-raises it as ' + TIER_EMOJI.IMPORTANT +
        ' IMPORTANT and the cycle repeats. A justified downgrade lets a false-' + TIER_EMOJI.IMPORTANT +
        ' review converge to APPROVE without a code change.');
    return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TIERS: TIERS,
        ROUND_VALUES: ROUND_VALUES,
        FIX_VALUES: FIX_VALUES,
        VERIFICATION_VALUES: VERIFICATION_VALUES,
        PRESETS: PRESETS,
        DEFAULT_BOUNDS: DEFAULT_BOUNDS,
        PRESET_TABLES: PRESET_TABLES,
        CENSUS_KEY_BY_TIER: CENSUS_KEY_BY_TIER,
        TIER_EMOJI: TIER_EMOJI,
        resolveReviewPolicy: resolveReviewPolicy,
        validateReviewPolicy: validateReviewPolicy,
        resolveVerification: resolveVerification,
        verificationPhrase: verificationPhrase,
        defaultPolicy: defaultPolicy,
        presetPolicy: presetPolicy,
        gatingCensusCount: gatingCensusCount,
        hasBlockingOrImportant: hasBlockingOrImportant,
        machineApprovalDecision: machineApprovalDecision,
        legacyKnobAudit: legacyKnobAudit,
        allowedSuggestionThreads: allowedSuggestionThreads,
        densityAudit: densityAudit,
        policyTableMarkdown: policyTableMarkdown,
        policyTableBody: policyTableBody,
        policyInputContextMarkdown: policyInputContextMarkdown,
        isReviewPolicyError: isReviewPolicyError
    };
}
