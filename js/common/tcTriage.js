/**
 * tcTriage.js — the gh-1329 mechanical triage engine for linked-TC failures
 * on bugs.
 *
 * Live pathology: any red linked TC was *defined* as "the fix did not work"
 * and bounced the bug to development (postStoryTestAutomationResults.js →
 * handleBugWithProductFailure). A red TC has four causes with different
 * owners — product regression, stale/misencoding test, environment shift,
 * flake — and only the first one belongs to the fix. Because the pipeline
 * could not attribute, one loop reproduced deterministically:
 * fix merged → sibling TC red → bug bounced → correct fix re-done → red again.
 *
 * The engine is the ticket's triage table, mechanical all the way:
 *
 *   Scoping    the bug's verdict is gated only by its OWN oracle TC
 *              (role "verifies: <BUG>"). Sibling/regression-guard failures
 *              route to test maintenance and never bounce the bug.
 *
 *   Fresh TCs  a TC that has never passed is unvalidated: its first run is
 *              validation, and a fresh TC cannot bounce the bug by
 *              construction — red first runs go to the TC-rework/review flow
 *              (does the TC encode the AC?).
 *
 *   Own oracle rework first, bounce only when the rework leg confirms the
 *              product genuinely violates the AC — bounded by the existing
 *              maxReworkRounds (escalation at the cap, no new counter).
 *              gh-1354: a VALIDATED own-oracle red takes the mechanical
 *              table first (retry → fingerprint lookup → differential, the
 *              same guard-grade triage), and hands to the AC-gated path only
 *              when attribution says product-side (differential green, or an
 *              AC verdict already in hand on the unattributed state) — the
 *              AC-gated bounce is the own oracle's LAST step, not its entry.
 *              An environment shift (same build, changed env fingerprint)
 *              lands in maintenance without any AC verdict, and
 *              null-verdict rework laps escalate at maxReworkRounds instead
 *              of reworking forever.
 *
 *   Guards     mechanical, no agent judgment in the main path, in order:
 *                1. retry once on the same build (flake filter; green →
 *                   nothing happened);
 *                2. fingerprint lookup vs the last green run — same build
 *                   SHA: changed env → environment shift; both fingerprints
 *                   equal → flaky; a missing fingerprint half proves
 *                   nothing (evidence, never a default — the case falls
 *                   through to the differential rerun request),
 *                   both proven by lookup, zero further reruns;
 *                3. build changed → differential rerun on the lastGreenSha
 *                   build (scripted CI varies ONLY the build):
 *                   red there too → failure predates the change →
 *                   maintenance; green there → a commit in the range broke a
 *                   pinned behavior → EARNED bounce (bounded, escalation at
 *                   the cap); unavailable → request the rerun, bug parked.
 *
 *   Persistence nothing is dropped: every test-side verdict carries a
 *              ledgerEntry payload for the rolling TC-maintenance ledger
 *              (tcMaintenanceLedger.js); only ACTION_NONE (transient flake,
 *              green on retry) records nothing.
 *
 * Pure module — no dmtools globals, GraalJS-clean (var + plain functions,
 * JSON-safe data). Callers own all tracker/git side effects.
 */
'use strict';

// TC roles (gh-1329 §1). Absent metadata defaults to OWN — the legacy-safe
// reading: an unmarked TC keeps today's bounded bounce path instead of
// silently demoting every legacy TC to a non-gating guard.
var ROLE_OWN = 'own-oracle';
var ROLE_GUARD = 'regression-guard';
// A guard that verifies ANOTHER bug: its failures (even differential-green
// ones) belong to that bug's pipeline — within this run they route to
// maintenance and never bounce the bug being triaged.
var ROLE_SIBLING = 'sibling-guard';

var DEFAULT_MAX_REWORK_ROUNDS = 2;

// Verdict actions.
var ACTION_NONE = 'none';                        // retry green on the same build — nothing happened
var ACTION_REWORK = 'rework';                    // TC-rework leg owns it; bug unchanged
var ACTION_MAINTENANCE = 'maintenance';          // test-side finding; bug unchanged
var ACTION_DIFFERENTIAL = 'differential-rerun';  // scripted rerun on the last-green build; bug unchanged
var ACTION_BOUNCE = 'bounce';                    // earned bounce; bug → development
var ACTION_ESCALATE = 'escalate';                // bounce cap reached; owner escalation; bug unchanged

// ── role resolution ──────────────────────────────────────────────────────────

var GUARD_ROLE_WORDS = { 'regression guard': 1, 'regression-guard': 1, 'guard': 1, 'sibling': 1, 'prevention': 1 };
var OWN_ROLE_WORDS = { 'own': 1, 'own-oracle': 1, 'own oracle': 1, 'oracle': 1, 'verifies': 1, 'verification': 1, 'verifies-bug': 1 };

function normalizedWord(value) {
    return String(value || '').toLowerCase().trim();
}

function roleWordOf(entry) {
    var raw = entry && (entry.role !== undefined ? entry.role : entry.tcRole);
    return normalizedWord(typeof raw === 'string' ? raw : '');
}

function bugKeyEqual(a, b) {
    return normalizedWord(a) !== '' && normalizedWord(a) === normalizedWord(b);
}

/**
 * Resolves a TC's role from its metadata (result entry or linked-TC entry).
 * Order: explicit role word → verifies-key comparison → regressionGuard
 * boolean → default OWN. A guard whose verifies key names ANOTHER bug is a
 * SIBLING of this run.
 */
function explicitRoleWord(entry) {
    var word = roleWordOf(entry);
    if (GUARD_ROLE_WORDS[word]) return ROLE_GUARD;
    if (OWN_ROLE_WORDS[word]) return ROLE_OWN;
    return null;
}

function roleFromVerifies(entry, bugKey) {
    var verifies = typeof entry.verifies === 'string' ? entry.verifies : '';
    if (normalizedWord(verifies) === '') return null;
    if (!bugKeyEqual(verifies, bugKey)) return ROLE_SIBLING;
    return explicitRoleWord(entry) === ROLE_GUARD ? ROLE_GUARD : ROLE_OWN;
}

function resolveTcRole(entry, bugKey) {
    if (!entry) return ROLE_OWN;
    var byVerifies = roleFromVerifies(entry, bugKey);
    if (byVerifies) return byVerifies;
    var byWord = explicitRoleWord(entry);
    if (byWord) return byWord;
    if (entry.regressionGuard === true) return ROLE_GUARD;
    return ROLE_OWN;
}

// ── fingerprint helpers ──────────────────────────────────────────────────────

function present(value) {
    return value !== undefined && value !== null && String(value) !== '';
}

function positiveIntOr(value, fallback) {
    var n = parseInt(value, 10);
    return n > 0 ? n : fallback;
}

function nonNegativeIntOr(value, fallback) {
    var n = parseInt(value, 10);
    return isNaN(n) || n < 0 ? fallback : n;
}

/**
 * True when the current run ran the SAME build as the recorded last-green
 * run (fingerprint lookup — evidence, never a default).
 */
function sameBuild(current, lastGreen) {
    return !!(current && lastGreen &&
        present(current.sha) && present(lastGreen.sha) &&
        String(current.sha) === String(lastGreen.sha));
}

function envChanged(current, lastGreen) {
    return !!(current && lastGreen &&
        present(current.envFingerprint) && present(lastGreen.envFingerprint) &&
        String(current.envFingerprint) !== String(lastGreen.envFingerprint));
}

/**
 * A missing env fingerprint half on either side never proves sameness —
 * the comparison is evidence, not a default (gh-1329 review: an agent that
 * omitted envFingerprint must not have its red silently reclassified as
 * flaky).
 */
function fingerprintsUnproven(current, lastGreen) {
    return !(present(current.envFingerprint) && present(lastGreen.envFingerprint));
}

// ── verdict construction ─────────────────────────────────────────────────────

// Evidence carried onto every verdict: sha/env from the failing run and
// lastGreen* from the registry record are always present (null when
// absent); the optional input fields appear only when supplied.
var EVIDENCE_FIELD_TABLE = [
    { key: 'sha', source: 'current' },
    { key: 'envFingerprint', source: 'current' },
    { key: 'lastGreenSha', source: 'lastGreen', sourceKey: 'sha' },
    { key: 'lastGreenEnvFingerprint', source: 'lastGreen', sourceKey: 'envFingerprint' },
    { key: 'differential', optional: true },
    { key: 'acVerdict', optional: true },
    { key: 'errorClass', optional: true },
    { key: 'testPath', optional: true },
    { key: 'failedDescriptionFile', optional: true },
    { key: 'failureSummary', optional: true }
];

function evidenceSource(input, source) {
    return source ? (input[source] || {}) : input;
}

function pickEvidence(input) {
    var evidence = {};
    EVIDENCE_FIELD_TABLE.forEach(function(spec) {
        var src = evidenceSource(input, spec.source);
        var raw = src[spec.sourceKey || spec.key];
        if (present(raw)) {
            evidence[spec.key] = String(raw);
        } else if (!spec.optional) {
            evidence[spec.key] = null;
        }
    });
    if (input.retryGreen) evidence.retryGreen = true;
    return evidence;
}

function verdict(input, action, reason, withLedgerEntry) {
    var redRounds = nonNegativeIntOr(input.redRounds, 0);
    var v = {
        tcKey: String(input.tcKey || ''),
        role: (input.role === ROLE_GUARD || input.role === ROLE_SIBLING) ? input.role : ROLE_OWN,
        action: action,
        reason: reason,
        redRounds: redRounds,
        maxReworkRounds: positiveIntOr(input.maxReworkRounds, DEFAULT_MAX_REWORK_ROUNDS),
        evidence: pickEvidence(input)
    };
    if (withLedgerEntry !== false) {
        v.ledgerEntry = {
            id: null, // stamped by the ledger module (its identity scheme)
            tcKey: v.tcKey,
            role: v.role,
            verdict: action,
            reason: reason,
            evidence: v.evidence
        };
    }
    return v;
}

function bounceCapReached(input) {
    return nonNegativeIntOr(input.redRounds, 0) >= positiveIntOr(input.maxReworkRounds, DEFAULT_MAX_REWORK_ROUNDS);
}

// ── the mechanical table ─────────────────────────────────────────────────────

/**
 * Validated-TC triage (§4) — the mechanical table runs for EVERY validated
 * TC, guards AND the bug's own oracle alike (gh-1354: pre-gh-1354 a
 * validated own-oracle red bypassed the whole table and entered the AC-gated
 * path directly, so an environment shift could only ever rework and
 * null-verdict laps grew unbounded). No agent judgment in the main path.
 * A SIBLING (a guard verifying another bug) can never turn its mechanical
 * outcomes into THIS bug's bounce/escalation: those belong to the sibling's
 * owner, so they convert to owner-notified maintenance with the evidence
 * intact.
 */
function triageValidatedTc(input) {
    // 1. flake filter: a same-build retry that went green means nothing happened.
    if (input.retryGreen) {
        return verdict(input, ACTION_NONE, 'retry-green-on-same-build', false);
    }
    // 2.+3. fingerprint lookup vs the last green run, then the differential.
    if (sameBuild(input.current, input.lastGreen)) {
        return triageSameBuild(input);
    }
    return triageBuildChanged(input);
}

/**
 * Same-build red: a proven environment shift is maintenance; flaky requires
 * BOTH fingerprints (missing evidence never defaults to flaky — the
 * differential rerun must attribute it instead). Mechanical evidence beats
 * an AC claim: the environment-shift and flaky verdicts stand regardless of
 * any acVerdict in the input (gh-1354 F1 — the environment-shift reason is
 * reachable without an AC verdict, so the rework leg can express the third
 * category: the TC is right, the product is right, the world moved).
 */
function triageSameBuild(input) {
    if (envChanged(input.current, input.lastGreen)) {
        return verdict(input, ACTION_MAINTENANCE, 'environment-shift');
    }
    if (fingerprintsUnproven(input.current, input.lastGreen)) {
        return triageUnattributed(input);
    }
    return verdict(input, ACTION_MAINTENANCE, 'flaky-same-build');
}

/**
 * Build changed — the differential rerun attributes it (varies only the
 * build): red there too → failure predates the change → maintenance; green
 * there → product-side attribution → the role-aware green route
 * (escalation-bounded bounce; own oracle hands to the AC-gated final
 * bounce); unavailable → request the rerun, bug parked.
 */
function triageBuildChanged(input) {
    if (input.differential === 'red') {
        return verdict(input, ACTION_MAINTENANCE, 'failure-predates-change');
    }
    if (input.differential === 'green') {
        return triageDifferentialGreen(input);
    }
    return triageUnattributed(input);
}

/**
 * Product-side attribution (the differential passed on the last-green
 * build): a sibling's regression belongs to its owner (maintenance); an
 * own-oracle hands to the AC-gated final bounce — the AC verdict decides
 * bounce vs maintenance vs bounded rework (gh-1354); a guard earns the
 * direct bounce (bounded, escalation at the cap).
 */
function triageDifferentialGreen(input) {
    if (input.role === ROLE_SIBLING) {
        return verdict(input, ACTION_MAINTENANCE, 'sibling-regression-owner-notified');
    }
    if (input.role === ROLE_OWN) {
        return triageAcGated(input);
    }
    if (bounceCapReached(input)) {
        return verdict(input, ACTION_ESCALATE, 'bounce-cap-reached');
    }
    return verdict(input, ACTION_BOUNCE, 'regression-from-change-range');
}

/**
 * The unattributed state: the mechanical table has no evidence to decide
 * (missing fingerprint half, or the build changed with no differential
 * outcome yet). An own-oracle AC verdict already in hand IS product-side
 * attribution — the AC-gated path decides (gh-1354). A null verdict is
 * bounded (gh-1354 F2: at the cap the laps escalate instead of reworking or
 * re-parking forever); otherwise the scripted differential rerun is
 * requested and the bug parks.
 */
function triageUnattributed(input) {
    if (input.role === ROLE_OWN) {
        if (input.acVerdict === 'violated' || input.acVerdict === 'intact') {
            return triageAcGated(input);
        }
        if (bounceCapReached(input)) {
            return verdict(input, ACTION_ESCALATE, 'null-ac-verdict-cap-reached');
        }
    }
    return verdict(input, ACTION_DIFFERENTIAL, 'rerun-requested-on-last-green-build');
}

/**
 * The scripted dispatcher's continuation (gh-1345): a parked differential
 * request has RUN on the last-green build — the outcome decides. Red there
 * → the failure predates the change → maintenance; green → the role-aware
 * green route (sibling-aware, own-oracle AC handoff, escalation at the
 * cap). Anything else — the dispatcher's own `unavailable` stall leaking
 * into the continuation, a null, a typo — RE-REQUESTS the rerun and never
 * decides on incomplete evidence (gh-1354: the pre-gh-1354 code treated any
 * non-'red' outcome as green and could bounce on an `unavailable`). This is
 * the honest mechanical continuation of a parked request: re-running
 * triageFailure with the parked evidence would loop (the same-build/unproven
 * case re-requests the differential instead of consuming the outcome).
 */
function triageDifferentialOutcome(input) {
    var resolved = Object.assign({}, input || {}, { validated: true });
    if (resolved.differential === 'red') {
        return verdict(resolved, ACTION_MAINTENANCE, 'failure-predates-change');
    }
    if (resolved.differential === 'green') {
        return triageDifferentialGreen(resolved);
    }
    return verdict(resolved, ACTION_DIFFERENTIAL, 'rerun-requested-on-last-green-build');
}

/**
 * AC-gated path (§2 + §3) — fresh TCs, and the bug's own oracle once the
 * mechanical table has attributed product-side (gh-1354: via the
 * differential-green handoff or an AC verdict already in hand on the
 * unattributed state). Bounce only when the rework leg confirms the product
 * violates the AC; bounded.
 */
function triageAcGated(input) {
    if (input.acVerdict === 'violated') {
        if (bounceCapReached(input)) {
            return verdict(input, ACTION_ESCALATE, 'bounce-cap-reached');
        }
        return verdict(input, ACTION_BOUNCE, 'acceptance-criteria-violated');
    }
    if (input.acVerdict === 'intact') {
        return verdict(input, ACTION_MAINTENANCE, 'tc-misencodes-ac');
    }
    // No AC verdict yet — route to the rework/review leg. A fresh TC's first
    // run is validation; an exhausted rework budget sweeps the TC instead of
    // looping (and a fresh TC can never bounce by construction).
    if (!input.validated && bounceCapReached(input)) {
        return verdict(input, ACTION_MAINTENANCE, 'unfixable-in-rework');
    }
    if (!input.validated) {
        return verdict(input, ACTION_REWORK, 'fresh-tc-first-run-validation');
    }
    // gh-1354 F2: a VALIDATED own-oracle with a persistent null verdict used
    // to return REWORK at any redRounds — the streak grew unchecked. The
    // null-verdict rework laps are bounded like every other loop: at the cap
    // the owner escalates instead of another rework round.
    if (bounceCapReached(input)) {
        return verdict(input, ACTION_ESCALATE, 'null-ac-verdict-cap-reached');
    }
    return verdict(input, ACTION_REWORK, 'own-oracle-ac-recheck');
}

/**
 * The whole triage for one failed TC run.
 *
 * input: {
 *   tcKey, role ('own-oracle' | 'regression-guard'), validated (has a
 *   last-green record), current: { sha, envFingerprint }, lastGreen:
 *   { sha, envFingerprint } | null, retryGreen (same-build retry passed),
 *   differential ('green'|'red'|'unavailable'|null — scripted rerun outcome
 *   on the lastGreenSha build), acVerdict ('violated'|'intact'|null — the
 *   rework leg's re-check), redRounds (consecutive red rounds for the TC),
 *   maxReworkRounds, errorClass, testPath, failedDescriptionFile,
 *   failureSummary
 * }
 *
 * gh-1354: every VALIDATED TC goes through the mechanical table first
 * (retry filter → fingerprint lookup → differential), guards and own
 * oracles alike — the AC-gated path is the own-oracle's FINAL bounce (after
 * product-side attribution), not its entry point. Fresh TCs stay
 * AC-gated from the start (a fresh TC can never bounce by construction).
 */
function triageFailure(input) {
    var resolved = input || {};
    var role = resolved.role === ROLE_GUARD || resolved.role === ROLE_SIBLING ? resolved.role : ROLE_OWN;
    var normalized = Object.assign({}, resolved, { role: role });
    if (normalized.validated) {
        return triageValidatedTc(normalized);
    }
    return triageAcGated(normalized);
}

// ── rendering (the async, owner-facing surface — never a blocking ask) ──────

function evidenceNote(v) {
    var parts = [];
    var e = v.evidence || {};
    if (e.lastGreenSha) parts.push('last green build ' + e.lastGreenSha);
    if (e.sha && e.sha !== e.lastGreenSha) parts.push('failing build ' + e.sha);
    if (e.differential) parts.push('differential rerun on the last-green build: ' + e.differential);
    if (e.errorClass) parts.push('error class: ' + e.errorClass);
    return parts.length ? ' (' + parts.join('; ') + ')' : '';
}

/**
 * The bounce comment: names the earned evidence per bounced TC (why this
 * bounce is attributed to the fix).
 */
function buildBounceComment(bouncedVerdicts) {
    var lines = ['The following Test Cases failed with a product regression:'];
    (bouncedVerdicts || []).forEach(function(v) {
        var summary = v.evidence && v.evidence.failureSummary ? ' — ' + v.evidence.failureSummary : '';
        lines.push('* ' + v.tcKey + summary + evidenceNote(v));
    });
    lines.push('');
    lines.push('Attribution (gh-1329): each listed TC passed on its last-green build and the same script ' +
        'fails on the current one — the Differential rerun isolated the change range, so this bounce is ' +
        'attributed to the fix, not to the test or the environment.');
    return lines.join('\n');
}

/**
 * The triage comment for test-side routes: informational digest of what was
 * routed where. The bug state is unchanged and nothing is asked of anyone.
 */
function buildTriageComment(routedVerdicts) {
    var lines = ['ℹ️ *Linked-TC failure triage (gh-1329)* — the bug state is unchanged; test-side findings were routed:'];
    (routedVerdicts || []).forEach(function(v) {
        lines.push('* ' + v.tcKey + ' — ' + v.reason.replace(/-/g, ' ') + ' → ' +
            (v.action === ACTION_DIFFERENTIAL ? 'differential rerun requested' : 'TC maintenance ledger') +
            evidenceNote(v));
    });
    lines.push('');
    lines.push('Findings are queued in the TC maintenance ledger and fixed in batched sweep PRs — no action is required right now.');
    return lines.join('\n');
}

/**
 * The owner escalation at the bounce cap: says what was observed, that the
 * loop stopped itself, and what a human needs to look at. Async by design.
 */
function buildEscalationComment(escalatedVerdicts) {
    var lines = ['🚨 *Bounce cap reached (gh-1329) — owner escalation*'];
    (escalatedVerdicts || []).forEach(function(v) {
        lines.push('* ' + v.tcKey + ' — repeated attributed failures (' + v.redRounds + '/' + v.maxReworkRounds +
            ' rounds)' + evidenceNote(v));
    });
    lines.push('');
    lines.push('The automated bounce loop stopped (no infinite re-fix laps). A human should arbitrate the ' +
        'change range vs the test expectation; the evidence lives in the TC maintenance ledger.');
    return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ROLE_OWN: ROLE_OWN,
        ROLE_GUARD: ROLE_GUARD,
        ROLE_SIBLING: ROLE_SIBLING,
        DEFAULT_MAX_REWORK_ROUNDS: DEFAULT_MAX_REWORK_ROUNDS,
        ACTION_NONE: ACTION_NONE,
        ACTION_REWORK: ACTION_REWORK,
        ACTION_MAINTENANCE: ACTION_MAINTENANCE,
        ACTION_DIFFERENTIAL: ACTION_DIFFERENTIAL,
        ACTION_BOUNCE: ACTION_BOUNCE,
        ACTION_ESCALATE: ACTION_ESCALATE,
        resolveTcRole: resolveTcRole,
        triageFailure: triageFailure,
        triageDifferentialOutcome: triageDifferentialOutcome,
        buildBounceComment: buildBounceComment,
        buildTriageComment: buildTriageComment,
        buildEscalationComment: buildEscalationComment
    };
}
