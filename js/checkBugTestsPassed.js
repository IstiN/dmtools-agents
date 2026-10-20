/**
 * Check Bug Tests Passed — postJSAction for bug_done_check agent.
 *
 * Runs on every SM cycle for each Bug in "In Testing".
 * - Looks at *directly* linked Test Cases first (avoids blocking a bug on
 *   unrelated Test Cases that happen to be connected through a parent Story
 *   or other transitive links).
 * - A Test Case in "Bug To Fix" is treated as non-blocking when it already
 *   has at least one linked Bug other than the current Bug. That bug will be
 *   handled by the bug-fix pipeline, and the current Bug must not deadlock
 *   waiting for it.
 * - Skipped and Irrelevant Test Cases are also non-blocking.
 * - If there are no direct Test Case links → falls back to the broad
 *   linkedIssues query for backward compatibility.
 * - Otherwise → removes the SM idempotency label so the SM re-triggers
 *   this check on the next cycle.
 */

const { LABELS } = require('./config.js');
const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const scmModule = require('./common/scm.js');
const trackersModule = require('./common/trackers.js');
const checkHelpers = require('./checkBugTestsPassedHelpers.js');
const linkedIssuesReport = require('./common/linkedIssuesReport.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;

    // Load project config to get issue types (default: "Test Case" / "Bug")
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const jiraConfig = projectConfig.jira;
    const tracker = trackersModule.createTracker(projectConfig, customParams || {});
    const testCaseType = jiraConfig.issueTypes.TEST_CASE || 'Test Case';
    const bugType = jiraConfig.issueTypes.BUG || 'Bug';

    // Helper: remove SM label so the check re-runs on the next SM cycle
    function releaseLock() {
        if (ticketKey && removeLabel) {
            try {
                tracker.removeLabel(ticketKey, removeLabel);
                console.log('Released SM label — will re-check next cycle');
            } catch (e) {
                console.warn('Failed to remove SM label:', e);
            }
        }
    }

    function getTicket() {
        try {
            return tracker.getIssue(ticketKey) || {};
        } catch (e) {
            console.warn('Failed to read ticket', ticketKey, ':', e);
            return {};
        }
    }

    function findDirectLinkedTCs(ticket) {
        try {
            const issueLinks = ticket && ticket.fields && ticket.fields.issuelinks;
            if (!Array.isArray(issueLinks) || issueLinks.length === 0) {
                return [];
            }
            const tcs = [];
            issueLinks.forEach(function(link) {
                var other = link.outwardIssue || link.inwardIssue;
                if (!other || !other.fields || !other.fields.issuetype) return;
                if (other.fields.issuetype.name === testCaseType) {
                    tcs.push(other);
                }
            });
            // gh-916 review: Jira returns issuelinks stubs with a reduced field set (summary/status/
            // issuetype — never labels), so in 'label' mode hasStage could not recognise a stage_<key>
            // marker on this, the preferred path, and a marked TC blocked the Bug forever. Re-fetch each
            // TC in full so labels are real; the 'none' default keeps the stubs — status-only comparison,
            // no extra reads, the exact previous behaviour.
            if (tracker.stageFallback() === 'label' && tcs.length > 0) {
                return tcs.map(function(tc) {
                    try {
                        return tracker.getIssue(tc.key) || tc;
                    } catch (e) {
                        console.warn('Could not re-fetch', tc.key, 'with full fields — falling back to the link stub:', e);
                        return tc;
                    }
                });
            }
            return tcs;
        } catch (e) {
            console.warn('Failed to read direct issue links for', ticketKey, ':', e);
            return [];
        }
    }

    function findAllLinkedTCs() {
        try {
            // JQL text: provider-specific query (WIQL on ado)
            return tracker.searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(tracker.provider(), ticketKey, 'issuetype = "' + testCaseType + '"', { issueType: testCaseType }), {
                maxResults: 100
            }) || [];
        } catch (e) {
            console.warn('Failed to fetch linked Test Cases via JQL:', e);
            return [];
        }
    }

    function findLinkedBugs(tcKey) {
        try {
            // JQL text: provider-specific query (WIQL on ado)
            return tracker.searchIssues(linkedIssuesReport.buildLinkedIssuesQuery(tracker.provider(), tcKey, 'issuetype = "' + bugType + '"', { issueType: bugType }), {
                maxResults: 50
            }) || [];
        } catch (e) {
            console.warn('Failed to fetch linked Bugs for', tcKey, ':', e);
            return [];
        }
    }

    function isBlockingTC(tc) {
        // gh-916: stage gates go through tracker.hasStage — a TC marked stage_<key> by a rejected
        // transition counts as being in the stage when jira.stageFallback is 'label'; in the default
        // 'none' mode hasStage compares the status only (the exact previous behaviour).
        var status = tc.fields && tc.fields.status && tc.fields.status.name;

        // Passed / intentionally skipped / no longer applicable are always non-blocking.
        if (tracker.hasStage(tc, 'PASSED', jiraConfig.statuses.PASSED) ||
            tracker.hasStage(tc, 'SKIPPED', jiraConfig.statuses.SKIPPED) ||
            tracker.hasStage(tc, 'IRRELEVANT', jiraConfig.statuses.IRRELEVANT)) {
            return false;
        }

        // A TC that is already tracked as "Bug To Fix" is non-blocking when it
        // has its own linked Bug(s) other than the current Bug. Those Bugs will
        // be fixed through the normal bug-fix pipeline; waiting for them here
        // creates deadlocks (e.g. TS-1356 was stuck because parent-Story
        // regression TCs TS-501/TS-252 were Bug To Fix). We count *any* other
        // linked Bug (even Done) so stale TCs that were already addressed do not
        // hold the current Bug hostage.
        if (tracker.hasStage(tc, 'BUG_TO_FIX', jiraConfig.statuses.BUG_TO_FIX)) {
            var linkedBugs = findLinkedBugs(tc.key);
            // gh-1043: pure predicate extracted (and unit-tested) in checkHelpers.
            if (checkHelpers.decideOtherActiveBug(linkedBugs, ticketKey, jiraConfig.statuses.DONE)) {
                console.log('TC', tc.key, 'is Bug To Fix but already tracked by another active Bug — treating as non-blocking');
                return false;
            }
        }

        return true;
    }

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Bug done check for', ticketKey, '===');

        const ticket = getTicket();
        const labels = (ticket && ticket.fields && ticket.fields.labels) || [];

        // Step 1: Prefer directly linked Test Cases so a bug is only held up by
        // its own acceptance tests, not by every Test Case connected to a parent Story.
        var allTCs = findDirectLinkedTCs(ticket);
        var linkSource = 'direct';

        if (allTCs.length === 0) {
            console.log('No direct Test Case links found — falling back to linkedIssues query');
            allTCs = findAllLinkedTCs();
            linkSource = 'linkedIssues';
        }

        const totalTCs = allTCs.length;
        console.log('Linked Test Cases (' + linkSource + '):', totalTCs);

        if (totalTCs === 0) {
            console.log('No linked Test Cases found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_test_cases', ticketKey };
        }

        // Step 2: Check whether any linked Test Case still blocks this Bug.
        const blockingTCs = allTCs.filter(isBlockingTC);
        const blockingCount = blockingTCs.length;

        console.log('Blocking Test Cases:', blockingCount, '/', totalTCs);

        if (blockingCount > 0) {
            // If the test-automation PR has already been merged and finalized, any still-blocking
            // Test Case means the fix did not work. Route the Bug to In Rework instead of
            // waiting forever.
            // Anti-cycle guard (gh-1043: pure route decision in checkHelpers): do not bounce a
            // finalized Bug back to In Rework more than once for the same blockers. After one
            // rework attempt, move to Blocked so a human triages persistent blockers instead of
            // burning CI minutes in an infinite loop.
            var route = checkHelpers.decidePostFixRoute(labels, LABELS.TEST_PR_FINALIZED);
            if (route === 'blocked') {
                console.log('Test PR finalized and one rework already attempted — moving', ticketKey, 'to Blocked for triage');
                tracker.moveToStatus(ticketKey, jiraConfig.statuses.BLOCKED);
                tracker.postComment(ticketKey, checkHelpers.buildBlockedAfterReworkComment(blockingTCs));
                releaseLock();
                return { success: true, action: 'moved_to_blocked', totalTCs, blockingCount, blockingTCs: blockingTCs.map(function(tc) { return tc.key; }), ticketKey };
            }

            if (route === 'rework') {
                console.log('Test PR finalized but', blockingCount, 'linked Test Case(s) still block — moving', ticketKey, 'to In Rework (one attempt)');
                tracker.moveToStatus(ticketKey, jiraConfig.statuses.IN_REWORK);
                tracker.addLabel(ticketKey, 'sm_bug_rework_attempted');
                tracker.postComment(ticketKey, checkHelpers.buildReworkComment(blockingTCs));
                releaseLock();
                return { success: true, action: 'moved_to_rework', totalTCs, blockingCount, blockingTCs: blockingTCs.map(function(tc) { return tc.key; }), ticketKey };
            }

            console.log('Not all Test Cases passed — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', totalTCs, blockingCount, blockingTCs: blockingTCs.map(function(tc) { return tc.key; }), ticketKey };
        }

        // Step 3: All blocking Test Cases are resolved.
        // Before moving the Bug to Done, ensure there is no open test-automation
        // PR for this ticket. If there is, wait for the dedicated merge rule
        // (or the new auto-merge rule) to finalize it so it does not become an
        // orphaned open PR.
        console.log('All', totalTCs, 'linked Test Case(s) resolved — checking for open test-automation PR before Done');

        var openTestPR = null;
        try {
            var scm = scmModule.createScm(projectConfig);
            var prList = scm.listPrs('open') || [];
            // gh-1043: pure filter extracted (and unit-tested) in checkHelpers.
            openTestPR = checkHelpers.findOpenTestPr(prList, ticketKey);
        } catch (e) {
            console.warn('Could not list open PRs for', ticketKey, ':', e);
        }

        if (openTestPR) {
            console.log('Open test-automation PR found:', openTestPR.number, '— keeping', ticketKey, 'in In Testing until it is merged');
            releaseLock();
            return {
                success: true,
                action: 'waiting_for_test_pr_merge',
                reason: 'open_pr',
                prNumber: openTestPR.number,
                prUrl: openTestPR.html_url,
                totalTCs,
                ticketKey
            };
        }
        console.log('No open test-automation PR found — safe to move', ticketKey, 'to Done');

        // Step 4: Move Bug to Done
        console.log('Moving', ticketKey, 'to Done');

        tracker.moveToStatus(ticketKey, jiraConfig.statuses.DONE);

        // Clean up anti-cycle label on successful completion.
        try {
            tracker.removeLabel(ticketKey, 'sm_bug_rework_attempted');
        } catch (e) {
            console.warn('Could not remove sm_bug_rework_attempted label:', e);
        }

        tracker.postComment(ticketKey, checkHelpers.buildBugDoneComment(totalTCs));

        console.log('✅ Bug', ticketKey, 'moved to Done');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        releaseLock();
        return { success: true, action: 'moved_to_done', totalTCs, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkBugTestsPassed:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
