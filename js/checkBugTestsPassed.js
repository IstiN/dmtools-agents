/**
 * Check Bug Tests Passed — postJSAction for bug_done_check agent.
 *
 * Runs on every SM cycle for each Bug in "In Testing".
 * - Looks at *directly* linked Test Cases only (avoids blocking a bug on
 *   unrelated Test Cases that happen to be connected through a parent Story
 *   or other transitive links).
 * - If all directly linked Test Cases are in "Passed" status → moves the Bug to Done.
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

    // Load project config to get testCaseIssueType (default: "Test Case")
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const testCaseType = projectConfig.jira.issueTypes.TEST_CASE || 'Test Case';

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

    function hasNotPassedTC(tcList) {
        return tcList.some(function(tc) {
            var status = tc.fields && tc.fields.status && tc.fields.status.name;
            return status !== STATUSES.PASSED && status !== STATUSES.SKIPPED && status !== STATUSES.IRRELEVANT;
        });
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

        // Step 2: Check whether any linked Test Case is not yet Passed.
        // Skipped and Irrelevant Test Cases are intentionally non-blocking
        // (same as checkStoryTestsPassed).
        const notPassedTCs = allTCs.filter(function(tc) {
            var status = tc.fields && tc.fields.status && tc.fields.status.name;
            return status !== STATUSES.PASSED && status !== STATUSES.SKIPPED && status !== STATUSES.IRRELEVANT;
        });
        const notPassedCount = notPassedTCs.length;

        console.log('Test Cases not yet Passed:', notPassedCount, '/', totalTCs);

        if (notPassedCount > 0) {
            console.log('Not all Test Cases passed — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', totalTCs, notPassedCount, ticketKey };
        }

        // Step 3: All Test Cases are Passed — move Bug to Done
        console.log('All', totalTCs, 'Test Case(s) passed — moving', ticketKey, 'to Done');

        jira_move_to_status({
            key: ticketKey,
            statusName: STATUSES.DONE
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Bug Complete — All Test Cases Passed\n\n' +
                'All *' + totalTCs + '* linked Test Case(s) are in *Passed* status.\n\n' +
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
