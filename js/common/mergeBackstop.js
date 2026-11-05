/**
 * mergeBackstop.js — the merge backstop (gh-1353, epic gh-1328
 * §4-merge backstop, part 4/4).
 *
 * Before a squash-merge of a `pr_approved` + green PR, the merge paths
 * (js/mergeTrigger.js and js/sm/mergeBot.js — the machine-SM merge funnel)
 * count unresolved MACHINE-OWNED review threads with severity >= IMPORTANT
 * (>=⚠️; 🚨 included — the #1332 registry / live thread severity markers
 * via reviewVerdicts.threadSeverity). When the count is positive:
 *
 *   1. ONE digest issue per PR files — title `[debt] <PR title>`, body:
 *      the review-debt-ledger machine marker (so the part-3 maintenance
 *      ledger dedups: appendDebtFinding's gh-1332 identity — file +
 *      normalized claim + severity class — makes a repeated finding
 *      refresh its entry instead of duplicating), plus per-thread severity,
 *      path:line, one-line summary, thread permalink and review-run
 *      reference. An already-open digest issue whose ledger marker carries
 *      this PR number is REUSED — the pick is deterministic (gh-1371
 *      round 2: the LOWEST issue number among the marker-matching digests),
 *      so replays converge on one digest even after a race. The race
 *      itself is best-effort: a digest a concurrent merge funnel files
 *      between our probe and our create is adopted post-create, OURS is
 *      abandoned OPEN (out.digestDuplicate, echoed into the PR ledger
 *      stamp for the part-3 sweep to retire) — "one digest per PR
 *      survives replays" is the convergent invariant, not a hard
 *      guarantee;
 *   2. each counted thread resolves with the canonical machine-parsed tag
 *      `defered: #<digest-issue>` (reviewDispositions.TAGS — the epic's
 *      deferral spelling; the tag round-trips parseDispositionTag);
 *   3. the merge proceeds. Human-authored threads are never resolved
 *      (gh-744) and never digested as resolved — they are listed in the
 *      digest as `open (human)` and the merge follows the current branch
 *      -protection state (the epic's final owner action, not this part).
 *
 * The backstop is a RECORD, not a gate — it never blocks a merge on the
 * threads themselves ("never silently merge with open >=⚠️ machine threads
 * and no digest; never block the merge on them either"):
 *
 *   - a threads/comments READ that throws throws through (fail-closed
 *     read — blindness was the #1319 pathology: a broken read must never
 *     classify as "no threads"; the caller defers the merge to the next
 *     tick), but a MISSING threads primitive (no bridge tool) merely skips
 *     the backstop — a capability miss, not a blind merge;
 *   - a digest-FILING failure throws through (the caller defers the merge —
 *     the "never silently merge without a digest" invariant owns it);
 *   - per-thread resolve/ack failures are counted, never thrown, never
 *     abort the rest (gh-828 round 3: resolve FIRST, ack only on success);
 *     a resolve-failed thread stays open but digested;
 *   - the PR-side ledger stamp is soft (the digest issue body carries the
 *     same ledger payload); the search-probe primitive is optional (a
 *     missing one degrades ONE-per-PR dedup across replays — logged).
 *
 * Requires the machine identity allowlist (machineAuthor — jobParams
 * machineAuthor → per-repo .dmtools/config.js knob): unconfigured = the
 * empty list = NOTHING counts as machine-owned = the clean replay (no
 * digest, merge as today). The threshold is an invariant (>=IMPORTANT),
 * not a knob — the gates live in parts 2-3.
 *
 * IO contract: runBackstop(io, owner, name, input) — `io` maps the raw
 * github bridge primitives (or test mocks): getThreads (github_get_pr_
 * review_threads), getComments (github_get_pr_comments), createComment,
 * searchIssues, createIssue (github_create_issue — owner/repo schema),
 * resolveThread (github_resolve_pr_thread — the full
 * workspace/repository/pullRequestId/threadId schema), replyToThread
 * (github_reply_to_pr_thread). The merge paths call runBackstopForPr
 * instead (githubBridgeIo() enumerates the engine's bridge tools). Payload
 * normalization rides mcpParse; thread rows ride reviewThreadInventory.
 *
 * Pure module — no dmtools globals (the io is injected). GraalJS-clean
 * (var + plain functions, JSON-safe data). Requires hoisted (gh-823).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');
var findingRegistry = require('./findingRegistry.js');
var reviewDebtLedger = require('./reviewDebtLedger.js');
var reviewDispositions = require('./reviewDispositions.js');
var machineAuthor = require('./machineAuthor.js');
var threadInventory = require('./reviewThreadInventory.js');
var mcpParse = require('./mcpParse.js');
var configLoader = require('../configLoader.js');

/* global github_get_pr_review_threads, github_get_pr_comments,
   github_create_comment, github_search_issues, github_create_issue,
   github_resolve_pr_thread, github_reply_to_pr_thread */

// The backstop threshold (epic §4: "severity >= IMPORTANT" / ">=⚠️") —
// an invariant, not a knob: BLOCKING and IMPORTANT count, everything
// below is the triage path's business.
var MIN_SEVERITY_CLASS = 'IMPORTANT';

// The one-line summary cap of a digest row (the ledger claim keeps its own
// 500-char evidence truncate — this is the RENDER cap).
var SUMMARY_MAX = 160;

// The readable severity labels of the digest table rows — EVERY tier of
// the findingRegistry class set (gh-1371: unmarked/NIT human threads used
// to render an unlabeled severity in the human table). An unknown class
// still falls back to its raw string.
var SEVERITY_LABELS = { BLOCKING: '🚨 BLOCKING', IMPORTANT: '⚠️ IMPORTANT',
    SUGGESTION: '💡 SUGGESTION' };

// The io keys githubTools normalizes (a non-function slot = capability miss).
var IO_KEYS = ['getThreads', 'getComments', 'createComment', 'searchIssues',
    'createIssue', 'resolveThread', 'replyToThread'];

// ── machine identity ─────────────────────────────────────────────────────────

/**
 * The machine logins for the caller's deployment: the gh-728 resolution
 * chain — jobParams.machineAuthor first, the per-repo config knob second.
 * A config load failure falls back to jobParams only (never throws);
 * unconfigured = the empty list (every guard keyed on it fails closed).
 */
function machineLoginsOf(jobParams) {
    var config = null;
    try {
        config = configLoader.loadProjectConfig(jobParams || {});
    } catch (eConfig) {
        config = null;
    }
    return machineAuthor.machineAuthorLogins(
        machineAuthor.resolveMachineAuthor(jobParams, config));
}

// ── thread rows + the counter ────────────────────────────────────────────────

/**
 * Normalizes a github_get_pr_review_threads payload (JSON string | node
 * array | GraphQL envelope | {nodes}) into the canonical review-thread rows.
 */
function threadRowsOf(raw) {
    var rows = [];
    threadInventory.parseGraphQLNodes(raw).forEach(function (node) {
        if (node) rows.push(threadInventory.threadRowOf(node));
    });
    return rows;
}

// The severity class of one thread body (the findingRegistry classes —
// threadSeverity's lowercase enum normalized up).
function severityClassOfThread(body) {
    return findingRegistry.severityClassOf(
        String(reviewVerdicts.threadSeverity(body)).toUpperCase());
}

// The backstop threshold (invariant): BLOCKING and IMPORTANT count.
function severityAtLeastImportant(severityClass) {
    return findingRegistry.severityRank(severityClass) >=
        findingRegistry.severityRank(MIN_SEVERITY_CLASS);
}

// One digest/ledger row from a normalized thread row + its severity class.
function digestRowOf(row, severityClass) {
    return {
        threadId: row.threadId || null,
        rootCommentId: row.rootCommentId || null,
        author: row.author || '',
        severity: severityClass,
        path: row.path || null,
        line: row.line || null,
        claim: row.body || ''
    };
}

/**
 * The counter (epic §4): walks unresolved review threads and splits
 * machine-owned >=IMPORTANT threads (counted — digested + resolved) from
 * everything else. Human-authored open threads (any severity) land in
 * `human` — never resolved, listed `open (human)`. Machine threads below
 * ⚠️ stay the triage path's business (belowSeverity). A counted thread
 * without a resolve id is still counted (it digests) but flagged
 * (noThreadId — the resolve loop skips it). An empty allowlist counts
 * nothing (gh-744 fail closed).
 */
function classifyThreads(threads, logins) {
    var out = { counted: [], human: [],
        counts: { total: 0, resolved: 0, machine: 0, belowSeverity: 0, noThreadId: 0 } };
    (Array.isArray(threads) ? threads : []).forEach(function (row) {
        var t = row || {};
        out.counts.total++;
        if (t.resolved === true) { out.counts.resolved++; return; }
        var severityClass = severityClassOfThread(t.body);
        if (!machineAuthor.loginMatchesList(t.author, logins)) {
            out.human.push(digestRowOf(t, severityClass));
            return;
        }
        out.counts.machine++;
        if (!severityAtLeastImportant(severityClass)) { out.counts.belowSeverity++; return; }
        out.counted.push(digestRowOf(t, severityClass));
        if (!t.threadId) out.counts.noThreadId++;
    });
    return out;
}

// ── review-run reference (the digest's provenance line) ─────────────────────

function shortSha(sha) {
    var s = String(sha || '');
    return s ? s.substring(0, 7) : '?';
}

/**
 * The review run that raised the counted threads: the newest machine
 * verdict record on the merge head (source + time + verdict + head), or
 * the explicit unknown when no record exists there.
 */
function reviewRunRefOf(prComments, headSha, logins) {
    var effective = reviewVerdicts.latestVerdictForHead(
        reviewVerdicts.parseVerdictRecords(prComments || [],
            { authorLogins: logins || [] }),
        headSha);
    if (!effective) return 'unknown review run (no verdict record on head ' + shortSha(headSha) + ')';
    var r = effective.record;
    return r.source + ' @ ' + (r.at || '?') + ' — ' + r.verdict + ' on head ' + shortSha(r.head);
}

// ── the ledger append (part 3 identity dedup) ────────────────────────────────

// The thread permalink: the root comment's REST discussion anchor, or the PR.
function threadUrlOf(row, ctx) {
    if (!ctx || !ctx.owner || !ctx.name || !ctx.prNumber) return null;
    var base = 'https://github.com/' + ctx.owner + '/' + ctx.name + '/pull/' + ctx.prNumber;
    return (row && row.rootCommentId) ? base + '#discussion_r' + row.rootCommentId : base;
}

/**
 * Appends every counted thread into the review debt ledger (deep-copied —
 * the input is never mutated). The ledger core dedups by the gh-1332
 * identity: the same finding counted again refreshes its entry
 * (occurrences++, newest thread pointer) instead of duplicating.
 */
function appendCountedToLedger(prev, counted, ctx) {
    var ledger = prev || reviewDebtLedger.emptyLedger();
    (Array.isArray(counted) ? counted : []).forEach(function (t) {
        ledger = reviewDebtLedger.appendDebtFinding(ledger, {
            threadId: t.threadId,
            path: t.path || '',
            claim: t.claim || '',
            severityClass: t.severity,
            originPr: ctx && ctx.prNumber,
            threadUrl: threadUrlOf(t, ctx),
            at: ctx && ctx.nowIso
        });
    });
    return ledger;
}

// ── the digest issue ─────────────────────────────────────────────────────────

// One markdown-table-safe line: severity-line stripped, whitespace
// collapsed, capped, pipes escaped.
function oneLine(text) {
    var s = reviewVerdicts.stripLeadingSeverityLine(String(text || ''))
        .replace(/\s+/g, ' ').trim();
    if (s.length > SUMMARY_MAX) s = s.substring(0, SUMMARY_MAX) + '…';
    return s.replace(/\|/g, '\\|');
}

function severityLabel(severityClass) {
    return SEVERITY_LABELS[severityClass] || severityClass;
}

function pathLineOf(row) {
    return '`' + ((row && row.path) || '?') + ((row && row.line) ? ':' + row.line : '') + '`';
}

function tableOf(rows) {
    return rows.map(function (r) { return '| ' + r.join(' | ') + ' |'; });
}

function countedTableRows(counted, ctx, reviewRunRef) {
    var rows = [['severity', 'path:line', 'summary', 'thread', 'review run'],
        ['---', '---', '---', '---', '---']];
    (Array.isArray(counted) ? counted : []).forEach(function (t) {
        var url = threadUrlOf(t, ctx);
        rows.push([severityLabel(t.severity), pathLineOf(t), oneLine(t.claim),
            url ? ('[thread](' + url + ')') : '(no permalink)',
            oneLine(reviewRunRef || 'unknown review run')]);
    });
    return tableOf(rows);
}

function humanTableRows(human, ctx) {
    var rows = [['severity', 'path:line', 'summary', 'thread', 'status'],
        ['---', '---', '---', '---', '---']];
    (Array.isArray(human) ? human : []).forEach(function (t) {
        var url = threadUrlOf(t, ctx);
        rows.push([severityLabel(t.severity) || '?', pathLineOf(t), oneLine(t.claim),
            url ? ('[thread](' + url + ')') : '(no permalink)', 'open (human)']);
    });
    return tableOf(rows);
}

function digestHeadline(count, prNumber) {
    return '🧵 Merge backstop (gh-1353) — ' + count + ' unresolved machine-owned review thread' +
        (count === 1 ? '' : 's') + ' with severity >= IMPORTANT (⚠️/🚨) open on PR #' + prNumber +
        ' at merge time. This issue is the gh-1328 §4 backstop record: each thread below was' +
        ' resolved with a `defered` tag pointing here, and the merge proceeded — the backstop' +
        ' is a record, not a gate.';
}

var DIGEST_FOOTER = 'Deferred findings are identity-deduped in the review debt ledger above' +
    ' (the machine marker — a repeated finding refreshes its existing entry). The batched' +
    ' review-debt sweep owns the fixes. Human-authored threads stay open and are never' +
    ' machine-resolved (gh-744).';

/**
 * The digest issue for one PR: { title, body }. The body opens with the
 * review-debt-ledger machine marker (the part-3 ledger payload — the
 * maintenance ledger dedups digest findings by identity), then renders the
 * per-thread table (severity, path:line, one-line summary, permalink,
 * review-run reference) and the `open (human)` section.
 */
function buildDigestIssue(parts) {
    var p = parts || {};
    var counted = Array.isArray(p.counted) ? p.counted : [];
    var human = Array.isArray(p.human) ? p.human : [];
    var ledger = p.ledger || reviewDebtLedger.emptyLedger();
    var ctx = { owner: p.owner, name: p.name, prNumber: p.prNumber };
    var titleText = oneLine(p.prTitle) || ('PR #' + p.prNumber);
    var lines = [
        reviewDebtLedger.buildDebtMarker(ledger),
        '',
        digestHeadline(counted.length, p.prNumber),
        '',
        'PR: ' + titleText,
        '',
        '## Deferred machine threads (each resolved `defered: #<this issue>` at merge time)'
    ].concat(countedTableRows(counted, ctx, p.reviewRunRef));
    if (human.length) {
        lines = lines.concat(['',
            '## Open human threads — never machine-resolved (gh-744)'],
            humanTableRows(human, ctx));
    }
    lines = lines.concat(['', DIGEST_FOOTER]);
    return { title: '[debt] ' + titleText, body: lines.join('\n') };
}

// ── the deferral ack ─────────────────────────────────────────────────────────

/**
 * The ack reply posted into a resolved counted thread: the tag line is the
 * canonical machine-parsed disposition (`defered: #<digest-issue>` —
 * reviewDispositions.tagLine renders it; parseDispositionTag round-trips).
 */
function deferredAck(digestNumber) {
    return '🤖 merge backstop (gh-1353) — machine-owned >=IMPORTANT review thread deferred at' +
        ' merge time; the finding lives in digest #' + digestNumber + ' and the review debt' +
        ' ledger (the batched sweep owns the fix).\n' +
        reviewDispositions.tagLine({ tag: 'defered', value: '#' + digestNumber }) + '\n';
}

// ── the one-digest-per-PR probe ──────────────────────────────────────────────

function buildDebtSearchQuery(owner, name) {
    return 'repo:' + owner + '/' + name + ' is:issue is:open in:title "[debt]"';
}

// Does this issue's body carry a debt-ledger marker finding for prNumber?
function digestCarriesPr(issue, prNumber) {
    var marker = reviewVerdicts.extractMarkerJson(issue && issue.body,
        reviewDebtLedger.MARKER_PREFIX, reviewDebtLedger.MARKER_SUFFIX);
    var findings = (marker && Array.isArray(marker.findings)) ? marker.findings : [];
    for (var i = 0; i < findings.length; i++) {
        if (findings[i] && String(findings[i].originPr) === String(prNumber)) return true;
    }
    return false;
}

// The raw issue list of a search payload — an array rides through, the
// {items}/{issues} envelopes flatten, anything else is no matches.
function digestIssueList(issuesPayload) {
    if (Array.isArray(issuesPayload)) return issuesPayload;
    return (issuesPayload && (issuesPayload.items || issuesPayload.issues)) || [];
}

// The gh-1371 race-dedup exclusion: one KNOWN number is skipped — the
// post-create probe looks for a CONCURRENT funnel's digest, never the
// PR's own just-filed duplicate.
function isExcludedDigestIssue(issue, excludeNumber) {
    return excludeNumber !== undefined && excludeNumber !== null &&
        String(issue && issue.number) === String(excludeNumber);
}

/**
 * The already-open digest issue whose ledger marker carries prNumber, or
 * null. The machine marker decides — a human-made `[debt]` issue without
 * our marker is never reused. excludeNumber (gh-1371) skips one known
 * number — the post-create race dedup looks for a CONCURRENT funnel's
 * digest, never the PR's own just-filed duplicate. Among multiple matches
 * the pick is DETERMINISTIC (gh-1371 round 2: the LOWEST issue number) —
 * GitHub issue-search ordering is best-match and opaque, so a "first hit"
 * could flip between replays and point new `defered:` acks at the
 * abandoned duplicate; every replay now converges on the same issue.
 */
function findExistingDigest(issuesPayload, prNumber, excludeNumber) {
    var best = null;
    digestIssueList(issuesPayload).forEach(function (issue) {
        if (isExcludedDigestIssue(issue, excludeNumber)) return;
        if (!digestCarriesPr(issue, prNumber)) return;
        if (!best || Number(issue.number) < Number(best.number)) {
            best = { number: issue.number, title: (issue && issue.title) || '', reused: true };
        }
    });
    return best;
}

// ── the github io adapters (injected bridge — capability-gated) ──────────────

// A non-function io slot is a capability miss (no bridge tool): normalized
// to null so the callers' gates can skip the degraded path. Normalized into
// a COPY (gh-1371): the injected io bag is the caller's object — writing
// the null slots back onto it would mutate the caller's state.
function normalizedIo(io) {
    var src = io || {};
    var b = {};
    IO_KEYS.forEach(function (k) {
        b[k] = (typeof src[k] === 'function') ? src[k] : null;
    });
    return b;
}

function threadsTool(b, owner, name) {
    if (!b.getThreads) return null;
    return function (prNumber) {
        return mcpParse.parseMcp(b.getThreads({
            workspace: owner, repository: name, pullRequestId: String(prNumber)
        }));
    };
}

function commentsTool(b, owner, name) {
    if (!b.getComments) return null;
    return function (prNumber) {
        return mcpParse.payloadList(mcpParse.parseMcp(b.getComments({
            workspace: owner, repository: name, pullRequestId: String(prNumber)
        })));
    };
}

function postCommentTool(b, owner, name) {
    if (!b.createComment) return null;
    return function (prNumber, body) {
        b.createComment({ workspace: owner, repository: name, number: prNumber, body: body });
    };
}

function searchTool(b, owner, name) {
    if (!b.searchIssues) return null;
    return function (query) {
        return mcpParse.parseMcp(b.searchIssues({ workspace: owner, repository: name, query: query }));
    };
}

function createIssueTool(b, owner, name) {
    if (!b.createIssue) return null;
    return function (title, body) {
        return mcpParse.parseMcp(b.createIssue({ owner: owner, repo: name, title: title, body: body }));
    };
}

function resolveThreadTool(b, owner, name) {
    if (!b.resolveThread) return null;
    return function (prNumber, thread) {
        b.resolveThread({ workspace: owner, repository: name,
            pullRequestId: String(prNumber), threadId: String(thread.threadId) });
    };
}

function replyTool(b, owner, name) {
    if (!b.replyToThread) return null;
    return function (prNumber, thread, text) {
        // The ack rides the root comment's REST reply endpoint; a thread
        // without an anchor degrades to a PR-level comment (smProvider parity).
        if (thread && thread.rootCommentId) {
            b.replyToThread({ workspace: owner, repository: name, pullRequestId: String(prNumber),
                inReplyToId: String(thread.rootCommentId), text: text });
            return;
        }
        b.createComment({ workspace: owner, repository: name, number: prNumber, body: text });
    };
}

function githubTools(owner, name, io) {
    var b = normalizedIo(io);
    return {
        listThreads: threadsTool(b, owner, name),
        prComments: commentsTool(b, owner, name),
        postPrComment: postCommentTool(b, owner, name),
        searchDebtIssues: searchTool(b, owner, name),
        createIssue: createIssueTool(b, owner, name),
        resolveThread: resolveThreadTool(b, owner, name),
        replyToThread: replyTool(b, owner, name)
    };
}

// ── the orchestration ────────────────────────────────────────────────────────

function emptyOutcome(prNumber) {
    return {
        prNumber: prNumber,
        skipped: null,
        counted: [],
        human: [],
        counts: null,
        digest: null,
        digestReused: false,
        digestDuplicate: null,
        digestProbeUnavailable: false,
        resolved: 0,
        resolveFailures: 0,
        ackFailures: 0,
        ledgerFindings: 0,
        ledgerStampPosted: false
    };
}

// The ledger base for the append — fails closed on a broken read: stamping
// a partial ledger would clobber the marker family's newest-wins state.
// Takes the ALREADY-READ comments (gh-1371: one pr-comments read per
// counted run — the ledger base and the digest share it).
function ledgerBaseOf(comments, logins) {
    return reviewDebtLedger.latestDebtLedger(comments || [],
        { authorLogins: logins || [] }) || reviewDebtLedger.emptyLedger();
}

// The PR-side ledger stamp (marker + async digest, part 3's defer pattern).
// Soft: the digest issue body carries the same ledger payload. Posted AFTER
// the digest filing (gh-1371 round 2) so the race outcome is known and the
// abandoned duplicate can be echoed for the sweep.
function stampLedger(t, prNumber, ledger, out) {
    if (typeof t.postPrComment !== 'function') return;
    try {
        t.postPrComment(prNumber,
            reviewDebtLedger.buildDebtMarker(ledger) + '\n' +
            reviewDebtLedger.buildDebtDigest(ledger) +
            duplicateStampNote(out && out.digestDuplicate));
        out.ledgerStampPosted = true;
    } catch (eStamp) { /* soft — the digest issue carries the marker */ }
}

// The race-dedup echo (gh-1371 round 2): when a concurrent funnel's digest
// won, the duplicate we filed stays OPEN (there is no close/update io
// primitive to retire it) — the stamp carries its number so the part-3
// sweep can see it and close it later. A clean filing echoes nothing.
function duplicateStampNote(duplicateNumber) {
    if (!duplicateNumber) return '';
    return '\n♻️ race dedup: a concurrent merge funnel filed the digest first —' +
        ' duplicate issue #' + duplicateNumber + ' was abandoned OPEN and is safe' +
        ' to close by the review-debt sweep (this ledger is the surviving record).';
}

// The probe: an already-open digest for this PR, or null. Optional
// primitive — a missing one degrades one-per-PR dedup (logged), never fails.
// excludeNumber (gh-1371) skips one known number (the post-create race
// dedup skips our own just-filed issue).
function probeExistingDigest(t, owner, name, input, out, excludeNumber) {
    if (typeof t.searchDebtIssues !== 'function') {
        out.digestProbeUnavailable = true;
        return null;
    }
    if (!owner || !name) return null;
    return findExistingDigest(
        t.searchDebtIssues(buildDebtSearchQuery(owner, name)),
        input.prNumber, excludeNumber);
}

// One `number` slot value → a usable positive digest issue number, or
// null. BOTH shapes gate on > 0 (gh-1371 round 2: the string branch used
// to accept '0' and '-3', contradicting the documented positive contract
// the numeric branch already enforced). Extracted so digestNumberOf stays
// under the CRAP ratchet ceiling (CI crap — findExistingDigest round).
function usableDigestNumber(n) {
    var parsed = (typeof n === 'number') ? n : Number(String(n));
    return (isFinite(parsed) && parsed > 0) ? parsed : null;
}

// The usable digest issue number off a bridge payload — null unless the
// payload carries a positive issue number (a bridge error body has none,
// gh-1371: `created.number` used to read undefined and the threads were
// resolved against a nonexistent digest).
function digestNumberOf(payload) {
    return usableDigestNumber(payload && payload.number);
}

// Files the digest (or reuses the probed one); a createIssue throw — or a
// create response WITHOUT a usable issue number — throws through: the merge
// defers rather than pointing `defered:` tags at a nonexistent digest
// (gh-1371). The search-then-create probe is racy across the two merge
// funnels (gh-1371 — the backstop rides BOTH mergeTrigger and mergeBot): a
// concurrent funnel can file its own digest between our probe and our
// create. Dedup runs POST-create too — the concurrent digest wins, ours is
// abandoned (digestDuplicate), and the tags converge on ONE digest.
function fileDigest(t, comments, owner, name, input, out, ledger) {
    var probed = probeExistingDigest(t, owner, name, input, out);
    if (probed) {
        out.digest = probed.number;
        out.digestReused = true;
        return probed;
    }
    var issue = buildDigestIssue({
        owner: owner, name: name, prNumber: input.prNumber,
        prTitle: input.prTitle, counted: out.counted, human: out.human,
        reviewRunRef: reviewRunRefOf(comments, input.headSha, input.logins),
        ledger: ledger
    });
    var created = digestNumberOf(t.createIssue(issue.title, issue.body));
    if (!created) {
        throw new Error('mergeBackstop: digest filing returned no issue number' +
            ' — never resolve threads against a nonexistent digest');
    }
    var raced = probeExistingDigest(t, owner, name, input, out, created);
    var racedNumber = raced && digestNumberOf(raced);
    if (racedNumber) {
        out.digest = racedNumber;
        out.digestReused = true;
        out.digestDuplicate = created;
        return raced;
    }
    out.digest = created;
    return { number: created };
}

// Resolve FIRST, ack only on success (gh-828 round 3). Per-thread failures
// are counted and never abort the rest; the digest records everyone.
function resolveCountedThreads(t, prNumber, counted, digestNumber, out) {
    (Array.isArray(counted) ? counted : []).forEach(function (thread) {
        if (!thread.threadId || typeof t.resolveThread !== 'function') {
            out.resolveFailures++;
            return;
        }
        try {
            t.resolveThread(prNumber, thread);
            out.resolved++;
        } catch (eResolve) {
            out.resolveFailures++;
            return;
        }
        if (typeof t.replyToThread !== 'function') { out.ackFailures++; return; }
        try {
            t.replyToThread(prNumber, thread, deferredAck(digestNumber));
        } catch (eAck) {
            out.ackFailures++;
        }
    });
}

/**
 * The backstop for one PR about to merge. Returns the outcome; throws only
 * on record-keeping failures (a broken threads/comments read, a digest
 * filing failure) — the caller defers THAT merge to the next tick and the
 * queue keeps moving. A clean count returns immediately (merge as today).
 *
 * io: the raw bridge primitives (or mocks) — see githubTools.
 * input: { prNumber, prTitle, headSha, logins, owner?, name?, nowIso? }.
 */
function runBackstop(io, owner, name, input) {
    var inp = input || {};
    var out = emptyOutcome(inp.prNumber);
    var t = githubTools(owner, name, io);
    if (!t.listThreads) {
        out.skipped = 'no-thread-primitive';
        return out;
    }
    // Fail-closed reads: the counted path never merges blind (the #1319
    // pathology). A throw here defers the merge to the next tick.
    var rows = threadRowsOf(t.listThreads(inp.prNumber));
    var cls = classifyThreads(rows, inp.logins);
    out.counted = cls.counted;
    out.human = cls.human;
    out.counts = cls.counts;
    if (!cls.counted.length) return out; // clean replay — merge as today
    // ONE comments read per counted run (gh-1371): the payload is shared by
    // the ledger append (its base) and the digest (its review-run
    // reference). Fail-closed: a broken read defers the merge to the next
    // tick — the #1319 pathology never reads as clean.
    var comments = t.prComments ? t.prComments(inp.prNumber) : null;
    if (!comments) {
        throw new Error('mergeBackstop: no pr-comments primitive — the ledger append cannot read its base');
    }
    var ledger = appendCountedToLedger(ledgerBaseOf(comments, inp.logins),
        cls.counted, { owner: owner, name: name, prNumber: inp.prNumber, nowIso: inp.nowIso });
    out.ledgerFindings = Array.isArray(ledger.findings) ? ledger.findings.length : 0;
    // Filing runs BEFORE the stamp (gh-1371 round 2): the stamp then knows
    // the race outcome and echoes an abandoned duplicate for the sweep.
    // Record-keeping survives a filing failure — the merge defers and the
    // next tick re-derives the same ledger (identity dedup) and stamps it.
    fileDigest(t, comments, owner, name, inp, out, ledger);
    stampLedger(t, inp.prNumber, ledger, out);
    resolveCountedThreads(t, inp.prNumber, cls.counted, out.digest, out);
    return out;
}

// ── the merge-path wiring (shared by mergeTrigger + sm/mergeBot) ─────────────

/**
 * The dmtools github-bridge globals → the io bag runBackstop consumes.
 * The ONE place that names the engine's bridge tools: each identifier is
 * typeof-guarded, so a runtime without a primitive maps null (capability
 * miss — the path skips degraded) instead of throwing a ReferenceError in
 * a harness that did not declare it. Absent = null, never a stub.
 */
function githubBridgeIo() {
    return {
        getThreads: (typeof github_get_pr_review_threads === 'function') ? github_get_pr_review_threads : null,
        getComments: (typeof github_get_pr_comments === 'function') ? github_get_pr_comments : null,
        createComment: (typeof github_create_comment === 'function') ? github_create_comment : null,
        searchIssues: (typeof github_search_issues === 'function') ? github_search_issues : null,
        createIssue: (typeof github_create_issue === 'function') ? github_create_issue : null,
        resolveThread: (typeof github_resolve_pr_thread === 'function') ? github_resolve_pr_thread : null,
        replyToThread: (typeof github_reply_to_pr_thread === 'function') ? github_reply_to_pr_thread : null
    };
}

// PR title across payload shapes (GraphQL and REST both carry `title`).
function prTitleOf(pr) {
    return (pr && pr.title) || '';
}

// Head sha across payload shapes (the ONE derivation, shared with the
// merge paths — gh-1371: mergeBot's local copy delegates here): GraphQL
// `headRefOid`, REST `head.sha`, older bridges a bare `head` string. A
// non-string (an object head, a junk payload) reads as null — the digest
// renders it as unknown instead of `[object Object]`.
function headShaOf(pr) {
    if (!pr) return null;
    var sha = pr.headRefOid || (pr.head && (pr.head.sha || pr.head));
    return (typeof sha === 'string' && sha) ? sha : null;
}

/**
 * The one-call wiring for a merge path about to squash-merge an approved
 * green PR (gh-1353): builds the input from the PR payload + jobParams,
 * runs the backstop and says the outcome lines verbatim. Throws only on
 * record-keeping failures (a broken threads/comments read, a digest
 * filing failure) — the CALLER defers THAT merge (never merges
 * undigested); per-thread resolve/ack failures never throw (the digest
 * records everyone).
 *
 *   bridges — the io bag (githubBridgeIo() in production; test mocks).
 *   job     — the caller's jobParams (machineAuthor allowlist lives there).
 *   pr      — the parsed get_pr payload (either shape).
 */
function runBackstopForPr(bridges, owner, name, job, prNumber, pr, say) {
    var out = runBackstop(bridges, owner, name, {
        prNumber: prNumber,
        prTitle: prTitleOf(pr),
        headSha: headShaOf(pr),
        logins: machineLoginsOf(job),
        nowIso: (new Date()).toISOString()
    });
    outcomeLines(out).forEach(function (line) { if (say) say(line); });
    return out;
}

// ── caller-facing log lines ──────────────────────────────────────────────────

/**
 * One observable line per replay shape — the callers say() these verbatim.
 */
function outcomeLines(out) {
    if (!out) return [];
    if (out.skipped) {
        return ['⏭️ merge backstop skipped on PR #' + out.prNumber + ' (' + out.skipped + ')'];
    }
    if (!out.counted.length) {
        return ['🧵 merge backstop on PR #' + out.prNumber + ': no unresolved machine-owned >=IMPORTANT threads' +
            ' (' + out.human.length + ' open human thread(s) stay per gh-744) — merge as today'];
    }
    return ['🧵 merge backstop on PR #' + out.prNumber + ': ' + out.counted.length +
        ' machine-owned >=IMPORTANT thread(s) deferred to ' +
        (out.digestReused ? 'existing digest' : 'digest') + ' #' + out.digest +
        ' — resolved ' + out.resolved + ', resolve failures ' + out.resolveFailures +
        ', ack failures ' + out.ackFailures + '; ' + out.human.length +
        ' open human thread(s) listed open (human)' +
        (out.digestDuplicate ? (' (duplicate digest #' + out.digestDuplicate +
            ' abandoned — a concurrent merge funnel filed first)') : '') +
        (out.digestProbeUnavailable ? ' (digest probe unavailable — dedup degraded)' : '')];
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MIN_SEVERITY_CLASS: MIN_SEVERITY_CLASS,
        SUMMARY_MAX: SUMMARY_MAX,
        machineLoginsOf: machineLoginsOf,
        threadRowsOf: threadRowsOf,
        classifyThreads: classifyThreads,
        reviewRunRefOf: reviewRunRefOf,
        appendCountedToLedger: appendCountedToLedger,
        buildDigestIssue: buildDigestIssue,
        deferredAck: deferredAck,
        buildDebtSearchQuery: buildDebtSearchQuery,
        findExistingDigest: findExistingDigest,
        digestNumberOf: digestNumberOf,
        githubTools: githubTools,
        githubBridgeIo: githubBridgeIo,
        headShaOf: headShaOf,
        runBackstop: runBackstop,
        runBackstopForPr: runBackstopForPr,
        outcomeLines: outcomeLines
    };
}
