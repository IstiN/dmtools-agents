/**
 * tcAlternation.js — the gh-1331 cross-lap TC alternation detector and
 * bounce suppression (the follow-up to the gh-1329 triage).
 *
 * Live pathology (the R6 audit): two automated TCs pin INCOMPATIBLE
 * expectations (a stale regression guard, or two generated TCs encoding
 * contradictory readings of the ACs). Under the gh-1329 per-event triage
 * every bounce is individually "earned" while the system ping-pongs forever:
 * each TC's consecutive-red streak stays at 1 (its own green separates its
 * reds), so the bounce cap NEVER triggers for the alternation pattern. No
 * component kept cross-lap history — this module is that memory's reader.
 *
 *   Detection   the run registry's per-TC run window (tcRunRegistry.runsOf —
 *               the last K runs with their build SHAs, bookkeeping beside
 *               lastGreenSha) is grouped BY BUILD: for a pair of TCs each
 *               build classifies as a trade (exactly one member red — the
 *               partner green or simply not run yet), a stable green (both
 *               green — ends the episode), both-red (neutral) or unknown.
 *               Walking builds newest-first, the last two trades holding
 *               DIFFERENT members is the alternation signature: the same
 *               pair trading red/green across >=2 builds without a stable
 *               green → the pair is `contradictory-or-flaky`.
 *
 *   Suppression three mechanical anchors stop the re-bounce loop, each
 *               evidence-based, none guessing:
 *                 contradictory-pair      — the TC belongs to an open
 *                                           contradictory-or-flaky pair;
 *                 prior-bounce-same-range — the registry's bounce anchor
 *                                           (lastBounceRange) names the same
 *                                           lastGreenSha range: the bounce
 *                                           already happened and did not fix
 *                                           the guard;
 *                 open-ledger-item        — an open maintenance-ledger
 *                                           finding for the TC (a recorded
 *                                           bounce/escalation, a dev-filed
 *                                           test_suspected claim, or a
 *                                           finding this module itself
 *                                           suppressed) anchored to
 *                                           the same SHA range.
 *               A suppressed earned bounce converts to a test-side
 *               maintenance route (ledger entry refreshed, bug untouched) —
 *               at most ONE bounce per contradictory pair, then suppression.
 *
 *   Exit        genuinely contradictory guards are a REQUIREMENT decision,
 *               not a code fix: buildConflictComment presents both pinned
 *               behaviors + their AC references to the owner — async, one
 *               escalation per pair (the pair record lives in the registry
 *               payload and is never re-marked while it stands). Resolution
 *               is mechanical: once both members pass on the SAME build
 *               (reconcileConflicts) the record clears and normal triage
 *               re-enables; a fresh trade flip detects and escalates again.
 *
 * Pure module — no dmtools globals; callers own every tracker write.
 * GraalJS-clean (var + plain functions, JSON-safe data); requires hoisted
 * (gh-823).
 */
'use strict';

var tcRunRegistry = require('./tcRunRegistry.js');
var tcMaintenanceLedger = require('./tcMaintenanceLedger.js');

// The marked-pair state (the registry payload carries the records).
var PAIR_STATE_CONFLICT = 'contradictory-or-flaky';

// The verdict the pair conflict suppresses into (mirrors tcTriage's
// ACTION_MAINTENANCE — kept local so this module stays dependency-light).
var ACTION_MAINTENANCE = 'maintenance';

// suppression kind → the verdict reason (the ledger finding + digest label).
var SUPPRESSION_REASON_TABLE = {
    'contradictory-pair': 'suppressed-contradictory-pair',
    'open-ledger-item': 'suppressed-open-ledger-item',
    'prior-bounce-same-range': 'suppressed-prior-bounce-same-range'
};

// ── pair keys ────────────────────────────────────────────────────────────────

function pairKeyOf(a, b) {
    return [String(a), String(b)].sort().join('|');
}

function membersOfPairKey(key) {
    return String(key).split('|');
}

function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
}

// ── detection: the trade signature over build-grouped run histories ─────────

function presentSha(sha) {
    return sha !== undefined && sha !== null && String(sha) !== '';
}

/** Two SHAs name the same build (both present, equal as strings). */
function sameSha(a, b) {
    return presentSha(a) && presentSha(b) && String(a) === String(b);
}

/** The last observed status of a TC on a build ('green'|'red'|null). */
function lastStatusAt(runs, sha) {
    var status = null;
    (runs || []).forEach(function(run) {
        if (run && sameSha(run.sha, sha) && (run.s === 'green' || run.s === 'red')) {
            status = run.s;
        }
    });
    return status;
}

function lastIndexOfSha(runs, sha) {
    var idx = -1;
    (runs || []).forEach(function(run, i) {
        if (run && sameSha(run.sha, sha)) idx = i;
    });
    return idx;
}

/**
 * The build timeline of a pair: every build SHA either member ran on,
 * newest first (by the most recent run mentioning it). Builds without a SHA
 * never classify — sha-less reds cannot fabricate trades.
 */
function buildTimeline(runsA, runsB) {
    var both = (runsA || []).concat(runsB || []);
    var seen = {};
    var shas = [];
    both.forEach(function(run) {
        if (!run || !presentSha(run.sha)) return;
        var sha = String(run.sha);
        if (seen[sha]) return;
        seen[sha] = true;
        shas.push({
            sha: sha,
            recency: Math.max(lastIndexOfSha(runsA, sha), lastIndexOfSha(runsB, sha))
        });
    });
    shas.sort(function(a, b) { return b.recency - a.recency; });
    return shas;
}

/**
 * The per-build classification of a pair (gh-1331 review: the classifier is
 * its own unit — the walk only reads it):
 *   'trade-A' | 'trade-B' — exactly one member red (the partner green or
 *                           simply not run yet);
 *   'stable-green'        — both green: the episode ends;
 *   null                  — neutral (both red, or nothing observed).
 */
function classifyBuild(aStatus, bStatus, keyA, keyB) {
    if (aStatus === 'green' && bStatus === 'green') return 'stable-green';
    if (aStatus === 'red' && bStatus !== 'red') return 'trade-A';
    if (bStatus === 'red' && aStatus !== 'red') return 'trade-B';
    return null;
}

/** The red member named by a trade classification. */
function tradeRedOf(classification, keyA, keyB) {
    return classification === 'trade-A' ? keyA : keyB;
}

/**
 * The newest-first trade walk over the pair's builds: stops at a stable
 * green (both members green on one build — the episode ended). Both-red
 * builds are neutral: neither a trade nor a chain break.
 */
function tradeWalk(runsA, runsB, keyA, keyB) {
    var trades = [];
    var timeline = buildTimeline(runsA, runsB);
    for (var i = 0; i < timeline.length; i++) {
        var classification = classifyBuild(
            lastStatusAt(runsA, timeline[i].sha), lastStatusAt(runsB, timeline[i].sha), keyA, keyB);
        if (classification === 'stable-green') break;
        if (classification) trades.push({ sha: timeline[i].sha, red: tradeRedOf(classification, keyA, keyB) });
    }
    return trades;
}

/** The sorted (a, b) form of a pair — the pair record's stable member order. */
function orderedPairOf(keyA, keyB) {
    var a = String(keyA) <= String(keyB) ? keyA : keyB;
    return { a: a, b: a === keyA ? keyB : keyA };
}

/**
 * The alternation signature for ONE pair, or null. The walk goes newest
 * first and stops at a stable green (both members green on one build — the
 * episode ended). The last two trades holding DIFFERENT members is the
 * signature: the pair trades red/green without a stable green.
 */
function detectAlternation(registry, keyA, keyB) {
    var runsA = tcRunRegistry.runsOf(registry, keyA);
    var runsB = tcRunRegistry.runsOf(registry, keyB);
    if (!runsA.length || !runsB.length) return null;
    var trades = tradeWalk(runsA, runsB, keyA, keyB);
    if (trades.length < 2) return null;
    if (trades[0].red === trades[1].red) return null;
    var pair = orderedPairOf(keyA, keyB);
    return {
        state: PAIR_STATE_CONFLICT,
        pairKey: pairKeyOf(keyA, keyB),
        a: pair.a,
        b: pair.b,
        holderNow: trades[0].red,
        holderPrev: trades[1].red,
        trades: trades
    };
}

/** The unordered TC pairs of a registry (optionally only pairs covering onlyForTc). */
function tcPairsOf(registry, onlyForTc) {
    var keys = Object.keys((registry && registry.tcs) || {}).sort();
    var pairs = [];
    for (var i = 0; i < keys.length; i++) {
        for (var j = i + 1; j < keys.length; j++) {
            if (onlyForTc && keys[i] !== onlyForTc && keys[j] !== onlyForTc) continue;
            pairs.push([keys[i], keys[j]]);
        }
    }
    return pairs;
}

/**
 * Scans every unordered pair of known TCs (optionally only the pairs
 * covering onlyForTc) for the alternation signature.
 */
function scanAlternations(registry, onlyForTc) {
    var found = [];
    tcPairsOf(registry, onlyForTc).forEach(function(pair) {
        var detection = detectAlternation(registry, pair[0], pair[1]);
        if (detection) found.push(detection);
    });
    return found;
}

// ── pair records: mark once, escalate once ───────────────────────────────────

/**
 * The marker-hygiene cap for the persistent member snapshots (gh-1331
 * review): the pair record lives in the registry marker payload, so the
 * agent-authored failureSummary gets the SAME cap the ledger notes have —
 * the record carries pointers, not essays.
 */
function cappedSnapshotNote(text) {
    return text ? tcMaintenanceLedger.truncate(String(text)) : null;
}

/** The member-evidence snapshot: the identity fields stay, free text is capped. */
function snapshotMemberMeta(meta) {
    if (!meta) return null;
    var m = deepCopy(meta);
    m.failureSummary = cappedSnapshotNote(m.failureSummary);
    return m;
}

/**
 * The conflict record for ONE detection: both pinned behaviors + their AC
 * references snapshotted (the escalation renders from the snapshot).
 */
function buildConflictRecord(detection, stamp, metaOf) {
    var record = {
        state: PAIR_STATE_CONFLICT,
        pairKey: detection.pairKey,
        a: detection.a,
        b: detection.b,
        holderNow: detection.holderNow || null,
        holderPrev: detection.holderPrev || null,
        detectedAt: stamp,
        trades: detection.trades || [],
        members: {}
    };
    [detection.a, detection.b].forEach(function(tcKey) {
        record.members[tcKey] = snapshotMemberMeta(metaOf && metaOf(tcKey));
    });
    return record;
}

/**
 * Marks the detected pairs in the registry payload (never mutating the
 * input). An already-recorded pair is NOT re-marked — one escalation per
 * pair. metaOf(tcKey) snapshots each member's pinned behavior + AC reference
 * into the record. Returns { registry, added } — added carries ONLY the
 * newly marked records.
 */
function recordConflicts(registry, detections, at, metaOf) {
    var r = deepCopy(registry || tcRunRegistry.emptyRegistry());
    if (!r.pairs || typeof r.pairs !== 'object') r.pairs = {};
    var stamp = at || new Date().toISOString();
    var added = [];
    (detections || []).forEach(function(detection) {
        if (r.pairs[detection.pairKey]) return;
        var record = buildConflictRecord(detection, stamp, metaOf);
        r.pairs[detection.pairKey] = record;
        added.push(record);
    });
    return { registry: r, added: added };
}

/** The open conflict records of a registry as [{ key, record }] (ordered). */
function openPairRecords(registry) {
    var pairs = (registry && registry.pairs) || {};
    var open = [];
    for (var key in pairs) {
        if (!pairs.hasOwnProperty(key)) continue;
        var record = pairs[key];
        if (record && record.state === PAIR_STATE_CONFLICT) open.push({ key: key, record: record });
    }
    return open;
}

/** The open conflict record covering a TC, or null. */
function openConflictFor(registry, tcKey) {
    var open = openPairRecords(registry);
    for (var i = 0; i < open.length; i++) {
        if (membersOfPairKey(open[i].key).indexOf(String(tcKey)) !== -1) {
            return { pairKey: open[i].key, record: open[i].record };
        }
    }
    return null;
}

function latestRunOf(registry, tcKey) {
    var runs = tcRunRegistry.runsOf(registry, tcKey);
    return runs.length ? runs[runs.length - 1] : null;
}

/** Whether a pair's members' LATEST runs are green on the SAME build. */
function isStableGreenPair(registry, members) {
    var runA = latestRunOf(registry, members[0]);
    var runB = latestRunOf(registry, members[1]);
    return !!runA && !!runB && runA.s === 'green' && runB.s === 'green' &&
        sameSha(runA.sha, runB.sha);
}

/**
 * The mechanical resolution: a pair record clears once BOTH members' latest
 * runs are green on the SAME build (a stable green — the contradiction is
 * over, normal triage re-enables). Returns the NEW registry.
 */
function reconcileConflicts(registry) {
    var r = deepCopy(registry || tcRunRegistry.emptyRegistry());
    if (!r.pairs || typeof r.pairs !== 'object') r.pairs = {};
    openPairRecords(r).forEach(function(entry) {
        if (isStableGreenPair(r, membersOfPairKey(entry.key))) delete r.pairs[entry.key];
    });
    return r;
}

// ── bounce suppression: the three anchors ────────────────────────────────────

/**
 * Whether a ledger finding anchors the same SHA range as the failing run.
 * A finding's lastGreenSha IS the range anchor (invariant across laps until
 * the TC goes green again); without one, the finding's own build sha anchors
 * the range it was observed on (a dev test_suspected claim carries it).
 * A missing half proves nothing — evidence, never a default.
 */
function anchorsMatch(finding, rangeSha, buildSha) {
    if (!finding) return false;
    if (presentSha(finding.lastGreenSha)) {
        return presentSha(rangeSha) && sameSha(finding.lastGreenSha, rangeSha);
    }
    if (presentSha(finding.sha)) {
        return sameSha(finding.sha, buildSha) || sameSha(finding.sha, rangeSha);
    }
    return false;
}

/**
 * Whether a ledger finding OWNS the failure — only owners anchor the range:
 * a recorded bounce/escalation, or a dev-filed test_suspected claim. Plain
 * maintenance findings (flaky, stale-guard sweeps) never do — a flaked guard
 * must still earn its genuine bounce later. gh-1331 review: a finding this
 * module itself suppressed still owns the failure — suppressedVerdict
 * rewrote its verdict to maintenance (reason `suppressed-*`), and the anchor
 * must not disarm itself after its first use.
 */
function findingOwnsFailure(finding) {
    if (finding.verdict === 'bounce' || finding.verdict === 'escalate') return true;
    if (finding.source === tcMaintenanceLedger.SOURCE_DEV) return true;
    return String(finding.reason || '').indexOf('suppressed-') === 0;
}

function openLedgerAnchor(ledger, tcKey, rangeSha, buildSha) {
    var open = tcMaintenanceLedger.openFindings(ledger);
    for (var i = 0; i < open.length; i++) {
        var finding = open[i];
        if (!finding || String(finding.tcKey) !== String(tcKey)) continue;
        if (!findingOwnsFailure(finding)) continue;
        if (!anchorsMatch(finding, rangeSha, buildSha)) continue;
        return {
            kind: 'open-ledger-item',
            findingId: finding.id,
            reason: finding.verdict || null,
            source: finding.source || null
        };
    }
    return null;
}

/** The registry's bounce anchor for the same SHA range, or null. */
function priorBounceAnchor(registry, tcKey, rangeSha) {
    if (!presentSha(rangeSha)) return null;
    var state = tcRunRegistry.stateOf(registry, tcKey);
    if (state && sameSha(state.lastBounceRange, rangeSha)) {
        return { kind: 'prior-bounce-same-range', at: state.lastBounceAt || null };
    }
    return null;
}

/**
 * The suppression decision for a pending earned bounce of one TC:
 *   rangeSha — the verdict's lastGreenSha (the change-range base);
 *   buildSha — the failing run's build.
 * Returns { kind, ... } when the bounce must be suppressed, null when the
 * bounce is earned. No range and no build → no anchor matches (fail-open
 * for the FIRST bounce, which is the attribution the registry then records).
 */
function bounceSuppression(registry, ledger, tcKey, rangeSha, buildSha) {
    var conflict = openConflictFor(registry, tcKey);
    if (conflict) {
        return { kind: 'contradictory-pair', pairKey: conflict.pairKey };
    }
    var prior = priorBounceAnchor(registry, tcKey, rangeSha);
    if (prior) return prior;
    if (presentSha(rangeSha) || presentSha(buildSha)) {
        return openLedgerAnchor(ledger, tcKey, rangeSha, buildSha);
    }
    return null;
}

// ── the verdict conversion + the owner escalation ────────────────────────────

/**
 * Converts an earned-bounce verdict into its suppressed test-side route:
 * the action becomes maintenance (the bug is NOT re-bounced) with a named
 * reason; the ledger entry records the suppression; the attribution evidence
 * is kept intact.
 */
function suppressedVerdict(verdict, suppression) {
    var reason = SUPPRESSION_REASON_TABLE[(suppression && suppression.kind)] || 'suppressed-unknown-anchor';
    var v = deepCopy(verdict || {});
    v.action = ACTION_MAINTENANCE;
    v.reason = reason;
    v.suppression = suppression || null;
    if (v.ledgerEntry) {
        v.ledgerEntry.verdict = ACTION_MAINTENANCE;
        v.ledgerEntry.reason = reason;
    }
    return v;
}

/** One member's pinned-behavior line of the escalation comment. */
function conflictMemberLine(record, tcKey) {
    var meta = (record.members && record.members[tcKey]) || {};
    var parts = ['- *' + tcKey + '*'];
    if (meta.lastGreenSha) parts.push('last green build `' + meta.lastGreenSha + '`');
    if (meta.testPath) parts.push('script `' + meta.testPath + '`');
    if (meta.verifies) parts.push('verifies: ' + meta.verifies + ' (AC reference)');
    if (meta.failureSummary) parts.push('latest failure: ' + meta.failureSummary);
    return parts.length > 1 ? parts.join(' — ') : parts[0];
}

/**
 * The spec-conflict exit: the async owner escalation for one pair record.
 * Presents BOTH pinned behaviors + their AC references, names the
 * suppression, and states the mechanical resolution — a human decision is
 * asked for ONCE per pair, never blocking.
 */
function buildConflictComment(record) {
    var resolved = record || {};
    var members = membersOfPairKey(resolved.pairKey);
    var lines = ['⚠️ *Cross-lap TC alternation detected (gh-1331)* — the pair *' + members[0] + ' / ' + members[1] + '* ' +
        'trades red/green across builds without a stable green and is marked `contradictory-or-flaky`.'];
    lines.push('');
    lines.push('Pinned behaviors (each last held green on its recorded build):');
    members.forEach(function(tcKey) {
        lines.push(conflictMemberLine(resolved, tcKey));
    });
    lines.push('');
    lines.push('What happens now: earned bounces for this pair are *suppressed* (at most ONE bounce per ' +
        'contradictory pair) and the findings live in the TC maintenance ledger. This is a requirements decision, ' +
        'not a code fix — an owner should arbitrate which pinned behavior matches the acceptance criteria.');
    lines.push('');
    lines.push('Resolution: once both Test Cases pass on the same build, normal triage re-enables automatically; ' +
        'a sweep PR fixing or removing one of the two scripts also clears the conflict.');
    return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PAIR_STATE_CONFLICT: PAIR_STATE_CONFLICT,
        pairKeyOf: pairKeyOf,
        detectAlternation: detectAlternation,
        scanAlternations: scanAlternations,
        recordConflicts: recordConflicts,
        openConflictFor: openConflictFor,
        reconcileConflicts: reconcileConflicts,
        bounceSuppression: bounceSuppression,
        suppressedVerdict: suppressedVerdict,
        buildConflictComment: buildConflictComment
    };
}
