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
    return { v: REGISTRY_VERSION, at: new Date().toISOString(), tcs: {} };
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

/**
 * Records a green run for a TC: validates it, stores lastGreenSha + env
 * fingerprint, resets the red streak. Returns the NEW registry (never
 * mutates the input).
 */
function recordGreen(prev, tcKey, evidence) {
    var at = (evidence && evidence.at) || new Date().toISOString();
    var r = deepCopyRegistry(prev);
    r.at = at;
    var prevEntry = entryOf(r, tcKey) || {};
    r.tcs[tcKey] = {
        role: (evidence && evidence.role) || prevEntry.role || null,
        validated: true,
        lastGreenSha: (evidence && evidence.sha) || prevEntry.lastGreenSha || null,
        lastGreenEnvFingerprint: (evidence && evidence.envFingerprint) || prevEntry.lastGreenEnvFingerprint || null,
        lastGreenAt: at,
        greens: (prevEntry.greens || 0) + 1,
        redRounds: 0,
        lastRedAt: prevEntry.lastRedAt || null,
        lastVerdict: prevEntry.lastVerdict || null
    };
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
    var prevEntry = entryOf(r, tcKey) || {};
    r.tcs[tcKey] = {
        role: (info && info.role) || prevEntry.role || null,
        validated: prevEntry.validated === true,
        lastGreenSha: prevEntry.lastGreenSha || null,
        lastGreenEnvFingerprint: prevEntry.lastGreenEnvFingerprint || null,
        lastGreenAt: prevEntry.lastGreenAt || null,
        greens: prevEntry.greens || 0,
        redRounds: (prevEntry.redRounds || 0) + 1,
        lastRedAt: at,
        lastVerdict: (info && info.verdict) || null
    };
    return r;
}

// ── marker persistence (the house dmtools: marker pattern) ───────────────────

// Marker-hostile sequences: an embedded `-->` would terminate the HTML
// comment and an embedded `<!--` would shadow the prefix search. A
// zero-width space breaks both while staying invisible (same hazard
// handling as the gh-1332 registry).
function markerSafe(text) {
    return String(text || '')
        .replace(/-->/g, '--\u200b>')
        .replace(/<!--/g, '<!\u200b--');
}

function markerSafeReplacer(key, value) {
    return typeof value === 'string' ? markerSafe(value) : value;
}

function registryPayload(r) {
    return {
        v: r.v || REGISTRY_VERSION,
        at: r.at || new Date().toISOString(),
        tcs: r.tcs || {}
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
    return MARKER_PREFIX + JSON.stringify(registryPayload(r), markerSafeReplacer) + MARKER_SUFFIX + '\n' + registryNote(r);
}

function registryFromPayload(parsed) {
    if (!parsed || !parsed.tcs || typeof parsed.tcs !== 'object') return null;
    return {
        v: parseInt(parsed.v, 10) || REGISTRY_VERSION,
        at: String(parsed.at || ''),
        tcs: parsed.tcs
    };
}

// The atMs-based records order is the reviewVerdicts marker-convention one.
var registryTimestampComparator = reviewVerdicts.markerRecordComparator;

/**
 * Parses ALL registry records from a ticket comments payload. FAILS CLOSED:
 * no configured machine-identity allowlist trusts nothing (the
 * machineAuthor doctrine — the registry gates bug verdicts).
 * Returns records oldest-first.
 */
function parseRegistryComments(comments, opts) {
    if (!opts || !Array.isArray(opts.authorLogins) || opts.authorLogins.length === 0) return [];
    var records = reviewVerdicts.collectAllowedRecords(comments, opts, function(item) {
        var r = registryFromPayload(reviewVerdicts.extractMarkerJson(
            item && item.body, MARKER_PREFIX, MARKER_SUFFIX));
        return r ? { registry: r, at: r.at } : null;
    });
    records.forEach(function(rec) {
        rec.atMs = Date.parse(rec.at);
    });
    records.sort(registryTimestampComparator);
    return records;
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
        recordGreen: recordGreen,
        recordFailure: recordFailure,
        buildRegistryMarker: buildRegistryMarker,
        parseRegistryComments: parseRegistryComments,
        latestRegistry: latestRegistry
    };
}
