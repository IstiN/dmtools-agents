/**
 * Machine-notice classification for PR discussion collection (gh-808).
 *
 * The harness posts STATUS/ARMING notices to its own PRs through the machine
 * login — arming notices, park/park-clear notices, validation and re-run
 * reports, merge-conflict reports, rework/review result summaries, human
 * escalations. Those notices are NOT review feedback: feeding them into the
 * rework input as threads with reply targeting made the rework agent spend
 * its replies on boilerplate answers to the machine itself (live: fa PR
 * #1428 round 2 — 9 of 13 replies were boilerplate).
 *
 * This module is the SINGLE SOURCE OF TRUTH for recognizing those notices.
 * The discrimination cannot be authorship-based: in this harness the reviewer
 * identity IS the machine login (the review agent posts inline comments with
 * the same credentials that post the notices), so classification keys on the
 * exact marker each poster writes at the START of its comment body — anchored
 * prefix match, never fuzzy text matching. A reviewer comment that merely
 * QUOTES a notice (blockquote, mid-body mention) therefore never matches.
 *
 * Comment bodies rendered through commentMarkup start with a markdown heading
 * (`### ✅ Rework Completed`), so a leading heading prefix is stripped before
 * the marker comparison.
 *
 * Consumption: js/common/scm.js (GitHub provider fetchDiscussions) and
 * js/common/githubHelpers.js (string-arg fetchDiscussionsAndRawData) drop
 * matching conversations from rawThreads and the discussions markdown, so
 * pr_discussions_raw.json contains zero machine-notice entries (gh-808 AC1)
 * while real review threads pass through with their ids intact (AC2).
 */

// Exact body-start markers of every PR-level notice the harness posts, with
// the poster that owns each. Keep in sync with the posters — when the armer
// wording changes, the marker changes here with it.
var MACHINE_NOTICE_MARKERS = [
    // js/smAgent.js — arm_rework notice
    '🧵 Unresolved review threads — rework armed.',
    // js/smAgent.js — validation park + park-clear notices
    '🅿️ Validation red — PR parked',
    '🅿️→▶ validation_failed cleared',
    // js/smAgent.js — rerun_cancelled_checks notice
    '🔁 Cancelled required checks re-run',
    // js/smAgent.js — conflict_rework report
    '⚠️ Merge conflict with main',
    // js/smAgent.js — fail_validation reports (all wording variants)
    '⚠️ Validation CI went red on the head',
    // js/smAgent.js — guest-PR park notice + human escalation (#701 style)
    '🛑 validation_failed',
    '🛑 @',
    // js/pushReworkChanges.js — rework completion comments (h3 headings)
    '✅ Rework Completed',
    '⚠️ Rework Completed',
    '✅ Rework Analysis Completed',
    // js/pushReworkChanges.js — rework failure reports
    '❌ Rework CLI Failed',
    '❌ Rework Push Skipped',
    '❌ Rework Push Failed',
    '❌ Rework Quality Gate Failed',
    '❌ Rework Workflow Error',
    // js/pushReworkChanges.js — re-review skip notices (token guard)
    '✅ Rework finished.',
    '⚠️ Rework finished with',
    // js/pushReworkChanges.js — fix summary + gate warnings + untargeted replies
    '🔧 Rework Complete —',
    '⚠️ Non-blocking gate warnings',
    '✅ Addressed',
    // js/postPRReviewComments.js — review summary (h2 heading)
    '🔍 Automated PR Review Completed',
    // js/postTestReworkResults.js / js/storyTestAutomationRework.js — test rework summaries
    '🔧 Test Rework Complete —',
    '🔧 Story Test Rework Complete —'
];

// Bot accounts whose PR threads are informational by platform convention
// (CI status, dependency updates) — shared by both collection paths so the
// heuristic lives in exactly one place.
var BOT_AUTHORS = ['github-actions[bot]', 'dependabot[bot]', 'renovate[bot]', 'codecov[bot]'];

/**
 * Strip leading whitespace and one markdown heading prefix ("### ") so
 * comments rendered through commentMarkup match their bare markers.
 */
function stripLeadingHeading(text) {
    var s = String(text || '').replace(/^\s+/, '');
    var m = /^#+\s*/.exec(s);
    return m ? s.substring(m[0].length) : s;
}

/**
 * True when the comment BODY starts with one of the harness notice markers.
 * Anchored at the body start (after heading strip) — a reviewer comment that
 * quotes a notice anywhere else in its body is NOT a notice.
 *
 * @param {string|null} body raw comment body
 * @returns {boolean}
 */
function isMachineNoticeBody(body) {
    var s = stripLeadingHeading(body);
    if (!s) return false;
    for (var i = 0; i < MACHINE_NOTICE_MARKERS.length; i++) {
        if (s.indexOf(MACHINE_NOTICE_MARKERS[i]) === 0) return true;
    }
    return false;
}

/**
 * Convenience wrapper: accepts a raw body string or a comment object
 * ({ body: ... }); everything else (null/undefined) is not a notice.
 *
 * @param {string|Object|null} comment body string or comment-like object
 * @returns {boolean}
 */
function isMachineNotice(comment) {
    if (!comment) return false;
    if (typeof comment === 'string') return isMachineNoticeBody(comment);
    return isMachineNoticeBody(comment.body);
}

/**
 * Platform-convention bot accounts ([bot] suffix) — informational threads,
 * never actionable review feedback.
 *
 * @param {string|null} login comment author login
 * @returns {boolean}
 */
function isBotAuthor(login) {
    var l = String(login || '');
    if (!l) return false;
    if (BOT_AUTHORS.indexOf(l) !== -1) return true;
    return l.indexOf('[bot]') !== -1;
}

module.exports = {
    MACHINE_NOTICE_MARKERS: MACHINE_NOTICE_MARKERS,
    BOT_AUTHORS: BOT_AUTHORS,
    stripLeadingHeading: stripLeadingHeading,
    isMachineNoticeBody: isMachineNoticeBody,
    isMachineNotice: isMachineNotice,
    isBotAuthor: isBotAuthor
};
