/**
 * tcRunRegistry.js — gh-1329 per-TC run bookkeeping.
 *
 * Infra prerequisite ("Per-TC run bookkeeping … written where automation
 * results are already processed"): every TC that passes a run is recorded
 * with its **lastGreenSha** and **environment fingerprint** — that green is
 * what turns a fresh TC into a *validated guard* (a fresh TC cannot bounce
 * the bug by construction) and what later makes guard-failure attribution a
 * measurement: the triage engine (tcTriage.js) compares the failing run's
 * SHA + env fingerprint against this record and only a build change can
 * escalate to a differential rerun / earned bounce.
 *
 *   Greens     validated=true + lastGreenSha + lastGreenEnvFingerprint +
 *              lastGreenAt; a new green refreshes the fingerprint and
 *              RESETS the consecutive-red streak (a green between reds
 *              means the fix worked — the loop counter is a streak, not a
 *              lifetime total; "no new counter" — this is the run
 *              bookkeeping the design already calls for).
 *
 *   Reds       redRounds++ per red run for the TC (independent per TC),
 *              with lastRedAt + lastVerdict — the bounce-cap input for
 *              tcTriage (repeated attributed failures hit maxReworkRounds →
 *              escalation, never an infinite loop).
 *
 *   Storage    one machine-parseable marker comment per update on the bug
 *              ticket — the house `dmtools:` marker pattern (same family as
 *              the gh-1332 finding registry). The newest machine-authored
 *              marker wins. FAILS CLOSED: no configured machine identity →
 *              nothing is trusted.
 *
 * Pure module — no dmtools globals; callers fetch comments and post the
 * built marker. GraalJS-clean (var + plain functions, JSON-safe data).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');

var MARKER_PREFIX = '<!-- dmtools:tc-run-registry ';
var MARKER_SUFFIX = ' -->';
var REGISTRY_VERSION = 1;

// ── shape ────────────────────────────────────────────────────────────────────

function emptyRegistry() {
    return { v: REGISTRY_VERSION, at: new Date().toISOString(), tcs: {}, pairs: {} };
}

function deepCopyRegistry(r) {
    return JSON.parse(JSON.stringify(r || emptyRegistry()));
}

function entryOf(r, tcKey) {
    return (r && r.tcs && r.tcs[tcKey]) ? r.tcs[tcKey] : null;
}

/** The bookkeeping record for one TC, or null when it has none. */
function stateOf(r, tcKey) {
    return entryOf(r, tcKey);
}

function isKnown(r, tcKey) {
    return !!entryOf(r, tcKey);
}

/**
 * A TC's validation state for triage: true once the TC has passed at least
 * one run (a validated guard / validated own oracle). Fresh TCs are not
 * validated — their first run is validation.
 */
function isValidated(r, tcKey) {
    var e = entryOf(r, tcKey);
    return !!(e && e.validated === true);
}

/** The consecutive-red streak for a TC (0 when none). */
function redRoundsOf(r, tcKey) {
    var e = entryOf(r, tcKey);
    return (e && e.redRounds) || 0;
}

// ── gh-1331: the cross-lap history (bookeeping beside lastGreenSha) ──────────

/**
 * The per-TC run window (gh-1331): the last K runs with their build SHAs —
 * the cross-lap memory the alternation detector (tcAlternation.js) reads.
 * A bounded window: the detector needs a few laps, not a lifetime log.
 */
var RUN_HISTORY_LIMIT = 6;

function appendRun(state, s, sha, at) {
    var runs = (state.runs || []).slice();
    runs.push({ s: s, sha: sha || null, at: at });
    while (runs.length > RUN_HISTORY_LIMIT) runs.shift();
    state.runs = runs;
}

/** The run-history window of a TC (the gh-1331 cross-lap memory), [] when none. */
function runsOf(r, tcKey) {
    var e = entryOf(r, tcKey);
    return (e && e.runs) || [];
}

// Entry fields a new state carries over from the previous one.
// gh-1331: the run window + the bounce anchor (lastBounce*) carry too.
var CARRIED_ENTRY_FIELDS = ['role', 'lastGreenSha', 'lastGreenEnvFingerprint', 'lastGreenAt', 'lastRedAt', 'lastVerdict',
    'lastBounceAt', 'lastBounceRange', 'lastBounceKind'];

/** The carried-over entry state (prev counters kept, stamps cleared per route). */
function carriedEntryState(prevEntry) {
    var prev = prevEntry || {};
    var state = {
        validated: prev.validated === true,
        greens: prev.greens || 0,
        redRounds: prev.redRounds || 0,
        runs: (prev.runs || []).slice()
    };
    CARRIED_ENTRY_FIELDS.forEach(function(k) {
        state[k] = prev[k] || null;
    });
    return state;
}

// The evidence fields a green run overrides on the carried state.
var GREEN_OVERRIDE_FIELDS = [['role', 'role'], ['lastGreenSha', 'sha'], ['lastGreenEnvFingerprint', 'envFingerprint']];

function applyGreenEvidence(state, evidence, at) {
    GREEN_OVERRIDE_FIELDS.forEach(function(pair) {
        state[pair[0]] = evidence[pair[1]] || state[pair[0]];
    });
    state.validated = true;
    state.lastGreenAt = at;
    state.greens = state.greens + 1;
    state.redRounds = 0;
}

/**
 * Records a green run for a TC: validates it, stores lastGreenSha + env
 * fingerprint, resets the red streak. Returns the NEW registry (never
 * mutates the input).
 */
function recordGreen(prev, tcKey, evidence) {
    var at = (evidence && evidence.at) || new Date().toISOString();
    var r = deepCopyRegistry(prev);
    r.at = at;
    var state = carriedEntryState(entryOf(r, tcKey));
    applyGreenEvidence(state, evidence || {}, at);
    appendRun(state, 'green', (evidence && evidence.sha) || null, at);
    r.tcs[tcKey] = state;
    return r;
}

/**
 * Records a red run for a TC: advances the consecutive-red streak.
 * Returns the NEW registry (never mutates the input).
 */
function recordFailure(prev, tcKey, info) {
    var at = (info && info.at) || new Date().toISOString();
    var r = deepCopyRegistry(prev);
    r.at = at;
    var state = carriedEntryState(entryOf(r, tcKey));
    state.role = (info && info.role) || state.role;
    state.lastRedAt = at;
    state.redRounds = state.redRounds + 1;
    state.lastVerdict = (info && info.verdict) || null;
    appendRun(state, 'red', (info && info.sha) || null, at);
    r.tcs[tcKey] = state;
    return r;
}

/**
 * gh-1331: records the earned-bounce anchor for a TC — the lastGreenSha
 * range the bounce was attributed against. The suppression rule keys on the
 * RANGE (invariant across laps until the guard goes green again), so a
 * bounce that did not fix the guard cannot re-fire on the same range.
 * Returns the NEW registry (never mutates the input).
 */
function recordBounce(prev, tcKey, info) {
    var resolved = info || {};
    var at = resolved.at || new Date().toISOString();
    var r = deepCopyRegistry(prev);
    r.at = at;
    var state = carriedEntryState(entryOf(r, tcKey));
    state.lastBounceAt = at;
    state.lastBounceRange = resolved.lastGreenSha || null;
    state.lastBounceKind = resolved.kind || 'earned';
    r.tcs[tcKey] = state;
    return r;
}

// ── marker persistence (the house dmtools: marker pattern) ───────────────────

// Marker hygiene (escaping) and the parse walk live in reviewVerdicts — the
// shared dmtools: marker plumbing (gh-1329 rework, gh-1251 duplication
// ratchet): this module keeps only its MARKER_PREFIX and payload adapter.

function registryPayload(r) {
    return {
        v: r.v || REGISTRY_VERSION,
        at: r.at || new Date().toISOString(),
        tcs: r.tcs || {},
        pairs: (r && r.pairs) || {}
    };
}

function validatedCount(r) {
    var n = 0;
    var tcs = (r && r.tcs) || {};
    for (var k in tcs) {
        if (tcs.hasOwnProperty(k) && tcs[k] && tcs[k].validated === true) n++;
    }
    return n;
}

function registryNote(r) {
    return '\uD83D\uDCD8 TC run registry (gh-1329) — ' + validatedCount(r) +
        ' validated TC record(s). Machine-managed last-green bookkeeping; please do not edit or reply.';
}

/**
 * Builds the registry marker comment for an update. Returns null for a
 * non-postable registry (no tcs map — a registry without tcs is not a
 * registry).
 */
function buildRegistryMarker(r) {
    if (!r || !r.tcs || typeof r.tcs !== 'object') return null;
    return MARKER_PREFIX + JSON.stringify(registryPayload(r), reviewVerdicts.markerSafeReplacer) + MARKER_SUFFIX + '\n' + registryNote(r);
}

function registryFromPayload(parsed) {
    if (!parsed || !parsed.tcs || typeof parsed.tcs !== 'object') return null;
    return {
        v: parseInt(parsed.v, 10) || REGISTRY_VERSION,
        at: String(parsed.at || ''),
        tcs: parsed.tcs,
        pairs: (parsed.pairs && typeof parsed.pairs === 'object') ? parsed.pairs : {}
    };
}

/**
 * Parses ALL registry records from a ticket comments payload. FAILS CLOSED:
 * no configured machine-identity allowlist trusts nothing (the
 * machineAuthor doctrine — the registry gates bug verdicts).
 * Returns records oldest-first.
 */
function parseRegistryComments(comments, opts) {
    return reviewVerdicts.parseMarkerComments(comments, opts, MARKER_PREFIX, MARKER_SUFFIX,
        function(parsed) {
            var r = registryFromPayload(parsed);
            return r ? { registry: r, at: r.at } : null;
        }, true);
}

/**
 * The newest trusted registry record for a ticket, or null when none exists.
 */
function latestRegistry(comments, opts) {
    var records = parseRegistryComments(comments, opts);
    return records.length ? records[records.length - 1] : null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        REGISTRY_VERSION: REGISTRY_VERSION,
        emptyRegistry: emptyRegistry,
        stateOf: stateOf,
        isKnown: isKnown,
        isValidated: isValidated,
        redRoundsOf: redRoundsOf,
        RUN_HISTORY_LIMIT: RUN_HISTORY_LIMIT,
        runsOf: runsOf,
        recordGreen: recordGreen,
        recordFailure: recordFailure,
        recordBounce: recordBounce,
        buildRegistryMarker: buildRegistryMarker,
        parseRegistryComments: parseRegistryComments,
        latestRegistry: latestRegistry
    };
}
