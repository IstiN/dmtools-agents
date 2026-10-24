/**
 * Pure helpers for js/checkBugTestsPassed.js (gh-1043 CRAP split).
 *
 * Every function here is side-effect free: label decisions, issue-list
 * filtering and comment string building extracted from action() so the
 * orchestration function shrinks below the CRAP threshold. Comment strings
 * must stay byte-identical to the originals — they are posted verbatim to
 * the tracker.
 */

var prLookup = require('./common/prLookup.js');

/**
 * Anti-cycle route decision once blocking Test Cases are found on a
 * finalized Bug: null (not finalized — keep waiting), 'rework' (first
 * attempt) or 'blocked' (one rework already attempted — human triage).
 */
function decidePostFixRoute(labels, finalizedLabel) {
    labels = labels || [];
    if (labels.indexOf(finalizedLabel) === -1) return null;
    return labels.indexOf('sm_bug_rework_attempted') !== -1 ? 'blocked' : 'rework';
}

/**
 * A Bug To Fix TC is non-blocking when it is already tracked by at least one
 * linked Bug other than the current one that is not Done — those Bugs go
 * through the bug-fix pipeline; waiting here would deadlock (TS-1356).
 */
function decideOtherActiveBug(linkedBugs, currentBugKey, doneStatus) {
    return (linkedBugs || []).some(function(bug) {
        var bugStatus = bug.fields && bug.fields.status && bug.fields.status.name;
        return bug.key !== currentBugKey && bugStatus !== doneStatus;
    });
}

/**
 * One '- KEY (status)' line per blocking TC, joined for the tracker comment.
 */
function buildBlockingList(blockingTCs) {
    return (blockingTCs || []).map(function(tc) {
        return '- ' + tc.key + ' (' + (tc.fields && tc.fields.status && tc.fields.status.name || 'unknown') + ')';
    }).join('\n');
}

function buildBlockedAfterReworkComment(blockingTCs) {
    return 'h3. 🚫 Test PR Finalized But Acceptance Tests Still Blocking After Rework\n\n' +
        'The test-automation PR was merged and finalized, and one rework was already attempted, but the following linked Test Case(s) are still not *Passed*:\n' +
        buildBlockingList(blockingTCs) + '\n\n' +
        'Moving the Bug to *Blocked* for manual triage instead of cycling indefinitely.';
}

function buildReworkComment(blockingTCs) {
    return 'h3. 🔄 Test PR Merged But Acceptance Tests Still Blocking\n\n' +
        'The test-automation PR was merged and finalized, but the following linked Test Case(s) are still not *Passed*:\n' +
        buildBlockingList(blockingTCs) + '\n\n' +
        'Moving the Bug to *In Rework* for one more fix attempt. If it still fails, it will be moved to *Blocked*.';
}

function buildBugDoneComment(totalTCs) {
    return 'h3. ✅ Bug Complete — All Linked Test Cases Resolved\n\n' +
        'All *' + totalTCs + '* linked Test Case(s) are either *Passed*, *Skipped*, *Irrelevant*, ' +
        'or already tracked by another Bug.\n\n' +
        'The bug has been automatically moved to *Done*.';
}

// gh-1249: the match itself lives in js/common/prLookup.js (one shared
// copy; null-safe so the scan stays total — a null entry is a non-match,
// never an abort via the action's catch).

/**
 * First open PR whose title or head branch mentions the ticket key, or null.
 * Same scan order as the original Array.find.
 */
function findOpenTestPr(prList, ticketKey) {
    var list = prList || [];
    for (var i = 0; i < list.length; i++) {
        if (prLookup.prMentionsTicket(list[i], ticketKey)) return list[i];
    }
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        decidePostFixRoute: decidePostFixRoute,
        decideOtherActiveBug: decideOtherActiveBug,
        buildBlockingList: buildBlockingList,
        buildBlockedAfterReworkComment: buildBlockedAfterReworkComment,
        buildReworkComment: buildReworkComment,
        buildBugDoneComment: buildBugDoneComment,
        prMentionsTicket: prLookup.prMentionsTicket,
        findOpenTestPr: findOpenTestPr
    };
}
