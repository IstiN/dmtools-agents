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

const { STATUSES } = require('./config.js');
const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;

    // Load project config to get issue types (default: "Test Case" / "Bug")
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const testCaseType = projectConfig.jira.issueTypes.TEST_CASE || 'Test Case';
    const bugType = projectConfig.jira.issueTypes.BUG || 'Bug';

    // Helper: remove SM label so the check re-runs on the next SM cycle
    function releaseLock() {
        if (ticketKey && removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('Released SM label — will re-check next cycle');
            } catch (e) {
                console.warn('Failed to remove SM label:', e);
            }
        }
    }

    function findDirectLinkedTCs() {
        try {
            const ticket = jira_get_ticket({ key: ticketKey });
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
            return tcs;
        } catch (e) {
            console.warn('Failed to read direct issue links for', ticketKey, ':', e);
            return [];
        }
    }

    function findAllLinkedTCs() {
        try {
            return jira_search_by_jql({
                jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "' + testCaseType + '"',
                maxResults: 100
            }) || [];
        } catch (e) {
            console.warn('Failed to fetch linked Test Cases via JQL:', e);
            return [];
        }
    }

    function findLinkedBugs(tcKey) {
        try {
            return jira_search_by_jql({
                jql: 'issue in linkedIssues("' + tcKey + '") AND issuetype = "' + bugType + '"',
                maxResults: 50
            }) || [];
        } catch (e) {
            console.warn('Failed to fetch linked Bugs for', tcKey, ':', e);
            return [];
        }
    }

    function isBlockingTC(tc) {
        var status = tc.fields && tc.fields.status && tc.fields.status.name;

        // Passed / intentionally skipped / no longer applicable are always non-blocking.
        if (status === STATUSES.PASSED || status === STATUSES.SKIPPED || status === STATUSES.IRRELEVANT) {
            return false;
        }

        // A TC that is already tracked as "Bug To Fix" is non-blocking when it
        // has its own linked Bug(s) other than the current Bug. Those Bugs will
        // be fixed through the normal bug-fix pipeline; waiting for them here
        // creates deadlocks (e.g. TS-1356 was stuck because parent-Story
        // regression TCs TS-501/TS-252 were Bug To Fix).
        if (status === STATUSES.BUG_TO_FIX) {
            var linkedBugs = findLinkedBugs(tc.key);
            var hasOtherBug = linkedBugs.some(function(bug) {
                return bug.key !== ticketKey;
            });
            if (hasOtherBug) {
                console.log('TC', tc.key, 'is Bug To Fix but already tracked by another Bug — treating as non-blocking');
                return false;
            }
        }

        return true;
    }

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Bug done check for', ticketKey, '===');

        // Step 1: Prefer directly linked Test Cases so a bug is only held up by
        // its own acceptance tests, not by every Test Case connected to a parent Story.
        var allTCs = findDirectLinkedTCs();
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
            console.log('Not all Test Cases passed — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', totalTCs, blockingCount, blockingTCs: blockingTCs.map(function(tc) { return tc.key; }), ticketKey };
        }

        // Step 3: All blocking Test Cases are resolved — move Bug to Done
        console.log('All', totalTCs, 'linked Test Case(s) resolved — moving', ticketKey, 'to Done');

        jira_move_to_status({
            key: ticketKey,
            statusName: STATUSES.DONE
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Bug Complete — All Linked Test Cases Resolved\n\n' +
                'All *' + totalTCs + '* linked Test Case(s) are either *Passed*, *Skipped*, *Irrelevant*, ' +
                'or already tracked by another Bug.\n\n' +
                'The bug has been automatically moved to *Done*.'
        });

        console.log('✅ Bug', ticketKey, 'moved to Done');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

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
