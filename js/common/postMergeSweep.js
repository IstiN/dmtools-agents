/**
 * postMergeSweep.js — the gh-1420 post-merge sweep for unresolved review
 * threads on MERGED PRs.
 *
 * Live pathology (PR #1410): an open machine-authored IMPORTANT review
 * thread stayed unresolved DAYS after the merge. Root cause (recorded per
 * gh-1420 AC4 — three independent misses, all in the sweep machinery that
 * existed before this module):
 *
 *   1. Author-allowlist blindness: the sweep's thread selection keys on
 *      the machineAuthor allowlist (reviewVerdicts.threadSkipReason —
 *      "not in the list → human → skip"). The deployment's empty/broken
 *      allowlist classified the machine thread human and it was never
 *      resolved nor digested.
 *   2. Verdict-gate blindness: the disposition path's gate requires an
 *      effective APPROVE record for the current head
 *      (reviewVerdicts.selectResolvableThreads). PR #1410's head carried a
 *      REQUEST_CHANGES verdict at merge (the gh-1416 pathology) — the
 *      gate failed CLOSED and swept nothing, post-merge included.
 *   3. Trigger-scope gap: the disposition loop only ever ran for OPEN PRs
 *      (machineSmAgent's BLOCKED branch / the SM's own CLEAN+merge path).
 *      For a PR merged by any other funnel, the linked issue flips to
 *      MERGED and decideClosedPrActions planned ONLY closeIssue — no
 *      sweep action existed on the closed-PR path.
 *
 * This module fixes all three on the closed-PR path (the machineSmAgent
 * `mergedThreadSweep` action rides the close tick):
 *
 *   - NO verdict gate: a merged PR's head may hold REQUEST_CHANGES — that
 *     is exactly the residue this sweep exists to surface. The sweep is a
 *     debt-recording pass, not a resolution gate.
 *   - NO severity filter: every unresolved machine-authored thread digests
 *     (BLOCKING included — post-merge there is no rework arm to "keep"
 *     a blocking thread for; the delta vs the triage path is deliberate).
 *   - The allowlist still decides the BUCKET (machine → ledger finding +
 *     `defered:` resolution; human → listed `open (human)`), per the
 *     gh-744 doctrine: misclassification moves the treatment, never the
 *     visibility — an empty allowlist surfaces everything as human.
 *
 * Digest treatment (gh-1353 convergence): machine threads append into the
 * review debt ledger with the gh-1332 identity (file + normalized claim +
 * severity class) — a pre-merge backstop digest and this sweep CONVERGE on
 * ONE entry per finding (occurrences refresh, never duplicate). Machine
 * threads resolve (gh-1352 post-merge hygiene parity: resolve FIRST, ack
 * only on success) with the canonical `deferred: <findingId>` disposition;
 * human threads are never machine-resolved (gh-744) — they list in the
 * SAME digest comment as `open (human)`.
 *
 * Idempotency (the convergent one-digest-per-PR invariant): the digest
 * comment carries the dmtools:post-merge-sweep marker family, deduped per
 * PR (a merged PR's head is frozen — per-PR IS per-head). A re-run whose
 * threads reached terminal resolution is a clean no-op; a re-run with
 * still-open threads retries the resolutions but never grows a second
 * digest comment.
 *
 * Fail-soft by design: the sweep rides the issue-close tick, so a fault
 * (a broken comments read, a missing primitive) is named on the outcome
 * and NEVER throws through the close path — the next tick re-sweeps while
 * the issue is still open. A failed close does not wedge either: the
 * ledger identity makes every re-run converge.
 *
 * Executor contract: runSweep(provider, prNumber, cfg) — provider is the
 * SCM-agnostic smProvider surface (reviewThreadList / prCommentList /
 * postPrComment / resolveThread / replyToThread), cfg = { machineLogins,
 * owner?, name?, nowIso? }. Pure module — no dmtools globals. GraalJS-
 * clean (var + plain functions, JSON-safe data). Requires hoisted (gh-823).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');
var machineAuthor = require('./machineAuthor.js');
var machineNotice = require('./machineNotice.js');
var findingRegistry = require('./findingRegistry.js');
var reviewDebtLedger = require('./reviewDebtLedger.js');
var reviewDispositions = require('./reviewDispositions.js');
var mergeBackstop = require('./mergeBackstop.js');

// The machine marker: one line, JSON payload, invisible in the rendered PR
// (the reviewVerdicts marker-family shape).
var MARKER_PREFIX = '<!-- dmtools:post-merge-sweep ';
var MARKER_SUFFIX = ' -->';

// ── the classification split ─────────────────────────────────────────────────

/**
 * The unresolved, non-notice thread rows split by author class. Resolved
 * threads and machine notices (the gh-808 doctrine — the machine's own
 * bookkeeping never becomes debt) never sweep; everything else lands in
 * the machine bucket (the machineAuthor allowlist) or the human bucket —
 * an EMPTY allowlist reads every thread human (surfaced, never lost).
 */
function sweepRowsOf(rows, logins) {
    var split = { machine: [], human: [] };
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
        var t = row || {};
        if (t.resolved === true) return;
        if (machineNotice.isMachineNoticeBody(t.body)) return;
        if (machineAuthor.loginMatchesList(t.author, logins || [])) split.machine.push(t);
        else split.human.push(t);
    });
    return split;
}

// The severity class of one thread body (the findingRegistry class set —
// the gh-1332 identity's severity key; mergeBackstop's same derivation).
function severityClassOfThread(body) {
    return findingRegistry.severityClassOf(
        String(reviewVerdicts.threadSeverity(body)).toUpperCase());
}

// One ledger-append row from a provider thread row (the digestRowOf shape
// mergeBackstop.appendThreadsToLedger consumes — the gh-1353 identity).
function digestRowOf(t) {
    return {
        threadId: t.threadId || null,
        rootCommentId: t.rootCommentId || null,
        author: t.author || '',
        severity: severityClassOfThread(t.body),
        path: t.path || null,
        line: t.line || null,
        claim: t.body || ''
    };
}

// ── the digest comment ───────────────────────────────────────────────────────

// The sweep marker record (dedup key: the PR number — a merged PR's head
// is frozen, so per-PR IS per-head).
function sweepRecordFromPayload(parsed) {
    if (!parsed || parsed.pr === undefined || parsed.pr === null) return null;
    return {
        pr: String(parsed.pr),
        machine: parsed.machine,
        human: parsed.human,
        at: String(parsed.at || '')
    };
}

// The sweep markers already on the PR, oldest-first (ANY author — the dedup
// exists to prevent comment spam, not to gate trust).
function existingSweeps(comments) {
    return reviewVerdicts.parseMarkerComments(comments || [], {},
        MARKER_PREFIX, MARKER_SUFFIX, sweepRecordFromPayload, false);
}

function hasSweepForPr(sweeps, prNumber) {
    for (var i = 0; i < sweeps.length; i++) {
        if (String(sweeps[i].pr) === String(prNumber)) return true;
    }
    return false;
}

/**
 * The digest comment body: the sweep marker (dedup family), the headline,
 * the review-debt-ledger machine marker + async digest (the gh-1353
 * payload — the maintenance ledger dedups by identity), the human table
 * (`open (human)` — never machine-resolved, gh-744) and the footer.
 */
function buildSweepComment(parts) {
    var p = parts || {};
    var ledger = p.ledger || reviewDebtLedger.emptyLedger();
    var ctx = { owner: p.owner, name: p.name, prNumber: p.prNumber };
    var marker = MARKER_PREFIX + JSON.stringify({
        pr: p.prNumber, machine: p.machine || 0, human: p.human || 0, at: p.at || ''
    }, reviewVerdicts.markerSafeReplacer) + MARKER_SUFFIX;
    var lines = [
        marker,
        '',
        '\uD83E\uDDF9 Post-merge sweep (gh-1420) — merged PR #' + p.prNumber + ' carried' +
            ' unresolved review thread(s): ' + (p.machine || 0) + ' machine-authored' +
            ' (digested below and resolved `deferred:` — the batched review-debt sweep owns' +
            ' the fixes), ' + (p.human || 0) + ' human (never machine-resolved, gh-744).',
        reviewDebtLedger.buildDebtMarker(ledger),
        '',
        reviewDebtLedger.buildDebtDigest(ledger)
    ];
    if (Array.isArray(p.humanRows) && p.humanRows.length) {
        lines = lines.concat(['',
            '## Open human threads — never machine-resolved (gh-744)'],
            mergeBackstop.humanTableRows(p.humanRows, ctx));
    }
    lines = lines.concat(['',
        'Findings ride the gh-1353 ledger identity (file + normalized claim + severity) —',
        'a pre-merge digest and this sweep converge on ONE entry per finding; re-runs',
        'refresh, never duplicate. No action is required right now.']);
    return lines.join('\n');
}

// ── the resolution loop (gh-1352 post-merge hygiene parity) ──────────────────

// The stamped finding id of one resolved thread (the ledger append names
// its finding by originThread — the deferThreadToLedger pattern).
function stampedFindingId(ledger, threadId) {
    var id = null;
    (Array.isArray(ledger && ledger.findings) ? ledger.findings : []).forEach(function (f) {
        if (f && String(f.originThread) === String(threadId)) id = f.id;
    });
    return id;
}

/**
 * ONE machine-thread resolution attempt (gh-828 round 3: resolve FIRST,
 * ack only on success). Returns the failure stage, or null on full
 * success: 'noId' | 'resolve' | 'ack'. The ack carries the canonical
 * machine-parsed `deferred: <findingId>` disposition
 * (reviewDispositions.tagLine — parseDispositionTag round-trips).
 */
function resolveOneMachineThread(provider, prNumber, row, ackText) {
    if (!row.threadId || typeof provider.resolveThread !== 'function') return 'noId';
    try {
        provider.resolveThread(prNumber, row);
    } catch (eResolve) {
        return 'resolve';
    }
    if (typeof provider.replyToThread !== 'function') return 'ack';
    try {
        provider.replyToThread(prNumber, row, ackText);
    } catch (eAck) {
        return 'ack';
    }
    return null;
}

// The sweep ack reply posted into a resolved machine thread (the canonical
// disposition tag + the human-readable why).
function sweepAck(ackText) {
    return '\uD83E\uDD9A post-merge sweep (gh-1420) — this thread was left unresolved on the' +
        ' merged PR; the finding lives in the review debt ledger (the batched sweep owns' +
        ' the fix).\n' + ackText + '\n';
}

// Resolve FIRST, ack only on success (gh-828 round 3); failures are counted
// and never abort the loop — every thread attempts on every sweep.
function resolveMachineThreads(provider, prNumber, ledger, machineRows, out) {
    (Array.isArray(machineRows) ? machineRows : []).forEach(function (t) {
        var stage = resolveOneMachineThread(provider, prNumber, t,
            sweepAck(reviewDispositions.tagLine({ tag: 'deferred',
                value: stampedFindingId(ledger, t.threadId) })));
        if (stage === 'noId') { out.noThreadId++; out.resolveFailures++; }
        else if (stage === 'resolve') out.resolveFailures++;
        else if (stage === 'ack') out.ackFailures++;
        else { out.resolved++; out.ackReplied++; }
    });
}

// ── the sweep ────────────────────────────────────────────────────────────────

function emptyOutcome(prNumber) {
    return {
        prNumber: prNumber,
        skipped: null,
        clean: false,
        machine: 0,
        human: 0,
        digested: 0,
        ledgerFindings: 0,
        resolved: 0,
        ackReplied: 0,
        resolveFailures: 0,
        ackFailures: 0,
        noThreadId: 0,
        digestPosted: false,
        digestDeduped: false,
        commentsUnreadable: false
    };
}

/**
 * The post-merge sweep for one MERGED PR. Never throws (fail-soft — the
 * sweep rides the issue-close tick; the next open tick re-sweeps). The
 * outcome names every shape: clean (nothing open), commentsUnreadable
 * (no ledger base — nothing appends, nothing resolves), skipped
 * (capability miss), digestPosted / digestDeduped, the resolution counters.
 *
 * cfg: { machineLogins, owner?, name?, nowIso? } — machineLogins is the
 * gh-728 allowlist (empty → every thread sweeps as human).
 */
function runSweep(provider, prNumber, cfg) {
    var c = cfg || {};
    var out = emptyOutcome(prNumber);
    if (!provider || typeof provider.reviewThreadList !== 'function' ||
        typeof provider.prCommentList !== 'function' ||
        typeof provider.postPrComment !== 'function') {
        out.skipped = 'no-primitives';
        return out;
    }
    var rows = provider.reviewThreadList(prNumber);
    var split = sweepRowsOf(rows, c.machineLogins);
    out.machine = split.machine.length;
    out.human = split.human.length;
    if (!out.machine && !out.human) {
        out.clean = true; // nothing open — no read, no comment (pure-clean parity)
        return out;
    }
    // ONE comments read per sweep: the ledger base, the digest dedup and
    // (post-post) the marker families share it. Fail-soft: without the
    // base, appending would clobber the marker family's newest-wins state
    // (the #1319 pathology rule) — the thread stays open, the next tick
    // re-sweeps.
    var comments;
    try {
        comments = provider.prCommentList(prNumber);
    } catch (eRead) {
        out.commentsUnreadable = true;
        return out;
    }
    if (!comments) {
        out.commentsUnreadable = true;
        return out;
    }
    var ledger = mergeBackstop.appendThreadsToLedger(
        reviewDebtLedger.latestDebtLedger(comments, { authorLogins: c.machineLogins || [] }) ||
            reviewDebtLedger.emptyLedger(),
        split.machine.map(digestRowOf),
        { owner: c.owner, name: c.name, prNumber: prNumber, nowIso: c.nowIso });
    out.ledgerFindings = Array.isArray(ledger.findings) ? ledger.findings.length : 0;
    out.digested = split.machine.length;
    resolveMachineThreads(provider, prNumber, ledger, split.machine, out);
    // The digest comment: ONE per PR (a merged head is frozen). The dedup
    // keys on the sweep-marker family — a PR carrying only a ledger stamp
    // (the merge-time backstop's) still gets the sweep digest.
    if (hasSweepForPr(existingSweeps(comments), prNumber)) {
        out.digestDeduped = true;
        return out;
    }
    try {
        provider.postPrComment(prNumber, buildSweepComment({
            prNumber: prNumber,
            ledger: ledger,
            machine: out.machine,
            human: out.human,
            at: c.nowIso || '',
            owner: c.owner,
            name: c.name,
            humanRows: split.human.map(digestRowOf)
        }));
        out.digestPosted = true;
    } catch (ePost) {
        // soft — the debt also lives in the resolution acks; the next tick
        // re-posts (the marker family is the dedup, the ledger the payload).
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_SUFFIX: MARKER_SUFFIX,
        sweepRowsOf: sweepRowsOf,
        severityClassOfThread: severityClassOfThread,
        digestRowOf: digestRowOf,
        buildSweepComment: buildSweepComment,
        existingSweeps: existingSweeps,
        hasSweepForPr: hasSweepForPr,
        resolveOneMachineThread: resolveOneMachineThread,
        runSweep: runSweep
    };
}
