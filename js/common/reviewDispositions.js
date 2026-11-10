/**
 * reviewDispositions.js — the gh-1352 disposition protocol (epic
 * gh-1328 §4-disposition, part 3/4): every triage-resolved review thread
 * closes with an ack reply carrying a MACHINE-PARSED disposition tag, and
 * the policy decides which tiers the machine may close without a fix.
 *
 *   fixed: <ref>      — a lap (rework / polish / opportunistic pickup)
 *                       addressed the finding; <ref> cites the fixing
 *                       commit / lap.
 *   wontfix: <reason> — the tier's policy fix value is never/opportunistic:
 *                       closable without a fix (the epic's "nits …
 *                       triage-resolve with ack").
 *   duplicate: #n     — the finding identity already exists (the gh-1332
 *                       registry's F<n> or another thread).
 *   deferred: <id>    — deferred to the review-side debt ledger (the ONLY
 *                       deferred path — per-finding deferral is banned);
 *                       <id> is the ledger finding identity the consumer
 *                       appended.
 *
 * The policy gate (epic §4): only tiers whose `fix` is `never` or
 * `oportunistic` are closable WITHOUT a fix; `mandatory` tiers need
 * fix-or-defer. Lap-gated (round `rework`) tiers are never triage-closable
 * at all — the rework lap owns them (the triage path only runs on heads
 * whose lap-gated census is clean, so this is also defense in depth).
 *
 * Pure module — no dmtools globals. GraalJS-clean (var + plain functions,
 * JSON-safe data). Requires hoisted (gh-823).
 */
'use strict';

var reviewVerdicts = require('./reviewVerdicts.js');
var reviewPolicy = require('./reviewPolicy.js');

// The four machine-parsed dispositions. The canonical spelling is `deferred`
// (two r's) — the only form the parser admits.
var TAGS = ['fixed', 'wontfix', 'duplicate', 'deferred'];

// The ack tag line: opens its line (boundary-disciplined so reviewer prose
// mentioning "fixed: never" mid-sentence is not a disposition), tag word,
// colon, value. The value runs to the end of the line.
var TAG_LINE_RE = /(?:^|\n)[ \t]*(fixed|wontfix|duplicate|deferred)[ \t]*:[ \t]*([^\n]*)/i;

// The default wontfix reason — never empty (a reasonless closure is the
// gh-1332 invariant-3 sin in miniature).
var DEFAULT_WONTFIX_REASON = 'non-mandatory per reviewPolicy (no fix required for this tier)';

function canonicalTag(word) {
    var w = String(word || '').toLowerCase();
    return TAGS.indexOf(w) !== -1 ? w : null;
}

/**
 * Parses ONE disposition tag from an ack text, or null. First tag wins;
 * the tag word must open its line; unknown/absent values parse as absent
 * (a tag without a value carries no machine information).
 * The parsed value is marker-safe — reviewer/agent free text is data, and
 * a `-->` inside a reason must never break a dmtools: marker open on the
 * same comment.
 */
function parseDispositionTag(text) {
    var m = TAG_LINE_RE.exec(String(text || ''));
    if (!m) return null;
    var tag = canonicalTag(m[1]);
    if (!tag) return null;
    var value = reviewVerdicts.markerSafe(String(m[2] || '').trim());
    if (!value) return null;
    return { tag: tag, value: value };
}

/**
 * The machine-parsed tag line for a disposition, or null when the
 * disposition is not renderable (absent, unknown tag, empty value).
 */
function tagLine(disposition) {
    if (!disposition) return null;
    var tag = canonicalTag(disposition.tag);
    var value = String((disposition && disposition.value) || '').trim();
    if (!tag || !value) return null;
    return tag + ': ' + value;
}

/**
 * The ack reply posted into a resolved thread — the gh-828 generalization.
 * Without a disposition this is the exact legacy gh-828 wording (the
 * APPROVE-verdict bare closure). With one, the ack names the tier the
 * policy applied and carries the machine-parsed tag line
 * (parseDispositionTag round-trips it).
 */
function buildThreadAckReply(disposition) {
    if (!disposition) {
        return '\uD83E\uDD16 non-blocking suggestion \u2014 resolved per APPROVE verdict. ' +
            'The machine resolves its own non-blocking threads in-tick so the ' +
            'conversation gate cannot hold an approved PR.';
    }
    var line = tagLine(disposition);
    var tier = disposition.tier ? String(disposition.tier) : 'unclassified';
    var lead = '\uD83E\uDD16 triage closure \u2014 ' + tier +
        ' thread resolved per the APPROVE verdict and the review policy';
    if (disposition.tag === 'deferred') {
        lead += '; the finding lives in the review debt ledger (batched sweep PR)';
    } else if (disposition.tag === 'wontfix') {
        lead += '; the policy does not require a fix for this tier';
    }
    return lead + '.\n\n' + line + '\n';
}

/**
 * The disposition the triage path closes ONE thread with, under the
 * resolved policy, or null when the thread is not triage-closable.
 *
 * thread: { threadId, body, ... } (reviewThreadList shape).
 * policy: a resolved reviewPolicy (reviewPolicy.defaultPolicy() shape).
 * opts:
 *   fixedThreadIds — { threadId: '<ref>' } — threads a lap addressed but
 *                    left unresolved (resolve failure); they close as
 *                    `fixed: <ref>`.
 *   allowDefer     — the review-side ledger accepts a new finding here;
 *                    mandatory-fix tiers then close as `deferred` (the
 *                    executor appends the finding and stamps its id).
 *
 * Decision order (pinned):
 *   1. lap-gated tier (round `rework`) → null — the rework lap owns it;
 *   2. fixed evidence → `fixed: <ref>`;
 *   3. fix never/opportunistic (and unclassified threads — the gh-828
 *      non-blocking parity) → `wontfix: <reason>`;
 *   4. fix mandatory + deferral available → `deferred` (defer: true — the
 *      executor fills the ledger id);
 *   5. otherwise → null (needs fix-or-defer; the caller counts the skip).
 */
// The thread's policy tier: the severity class of its body and the
// resolved policy's entry for it (null = unclassified — the gh-828
// non-blocking parity).
function tierEntryOf(thread, policy) {
    var tierKey = String(reviewVerdicts.threadSeverity((thread || {}).body) || 'none').toUpperCase();
    return {
        tierKey: tierKey,
        entry: (policy || reviewPolicy.defaultPolicy()).severities[tierKey] || null
    };
}

// The `fixed:` evidence for a thread id — the lap-addressed map entry, or
// null when the lap left no evidence for it.
function fixedRefOf(opts, threadId) {
    return opts.fixedThreadIds ? opts.fixedThreadIds[String(threadId)] : null;
}

// The policy gate: an unclassified thread or a tier whose fix is never/
// opportunistic is closable WITHOUT a fix (the epic's "nits …
// triage-resolve with ack").
function closableWithoutFix(entry) {
    return !entry ||
        entry.fix === 'never' || entry.fix === 'oportunistic' || entry.fix === 'opportunistic';
}

// The wontfix value — never empty (a reasonless closure is the gh-1332
// invariant-3 sin in miniature).
function wontfixValue(entry) {
    return DEFAULT_WONTFIX_REASON + ' (round ' + (entry ? entry.round : 'none') + ')';
}

function dispositionForThread(thread, policy, opts) {
    var t = thread || {};
    var o = opts || {};
    var tier = tierEntryOf(t, policy);

    if (tier.entry && tier.entry.round === 'rework') return null;

    var fixed = fixedRefOf(o, t.threadId);
    if (fixed) {
        return { tag: 'fixed', value: String(fixed), defer: false, tier: tier.tierKey };
    }

    if (closableWithoutFix(tier.entry)) {
        return {
            tag: 'wontfix',
            value: wontfixValue(tier.entry),
            defer: false,
            tier: tier.tierKey
        };
    }

    if (o.allowDefer) {
        return { tag: 'deferred', value: null, defer: true, tier: tier.tierKey };
    }
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TAGS: TAGS,
        DEFAULT_WONTFIX_REASON: DEFAULT_WONTFIX_REASON,
        parseDispositionTag: parseDispositionTag,
        tagLine: tagLine,
        buildThreadAckReply: buildThreadAckReply,
        dispositionForThread: dispositionForThread
    };
}
