/**
 * Check Story Tests Passed — postJSAction for story_done_check agent.
 *
 * Runs on every SM cycle for each Story in "In Testing".
 * - If all linked Test Cases are "Passed" → moves the Story to "Done".
 * - If any linked Test Case is still in an in-flight review/automation status
 *   (In Review - Passed/Failed, In Development, etc.) → releases the lock and
 *   waits for the review/merge/automation agents to finish.
 * - If any linked Test Case is "Failed" and has no linked non-Done bug → waits
 *   for bulk_bugs_creation to create/link the bug.
 * - If any linked Test Case has a linked non-Done bug → moves the Story to
 *   "Bug To Fix" so the bug-fix pipeline can run.
 * - Otherwise all non-passed Test Cases are ready for re-test (bugs Done or no
 *   bugs) → moves the Story back to "Ready For Testing" to trigger a re-run.
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
var trackerHelper = require('./common/tracker.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const trackerConfig = projectConfig.tracker;
    const testCaseType = trackerConfig.issueTypes.TEST_CASE || 'Test Case';
    const bugType = trackerConfig.issueTypes.BUG || 'Bug';

    function releaseLock() {
        if (ticketKey && removeLabel) {
            try {
                trackerHelper.removeLabel(ticketKey, removeLabel);
                console.log('Released SM label — will re-check next cycle');
            } catch (e) {
                console.warn('Failed to remove SM label:', e);
            }
        }
    }

    function findLinkedTCs() {
        try {
            return tracker_search({
                jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "' + testCaseType + '"',
                fields: ['key', 'status'],
                maxResults: 100
            }) || [];
        } catch (e) {
            console.warn('Failed to fetch linked Test Cases:', e);
            return [];
        }
    }

    function findLinkedBugs(tcKey) {
        try {
            return tracker_search({
                jql: 'issue in linkedIssues("' + tcKey + '") AND issuetype = "' + bugType + '"',
                fields: ['key', 'status'],
                maxResults: 50
            }) || [];
        } catch (e) {
            console.warn('Failed to fetch linked bugs for', tcKey, e);
            return [];
        }
    }

    function findPendingBugKey(tcKey) {
        var bugs = findLinkedBugs(tcKey);
        for (var i = 0; i < bugs.length; i++) {
            var status = bugs[i].fields && bugs[i].fields.status && bugs[i].fields.status.name;
            if (status !== trackerConfig.statuses.DONE) {
                return bugs[i].key;
            }
        }
        return null;
    }

    function isInFlightStatus(status) {
        return status === trackerConfig.statuses.IN_REVIEW_PASSED ||
            status === trackerConfig.statuses.IN_REVIEW_FAILED ||
            status === trackerConfig.statuses.IN_DEVELOPMENT ||
            status === trackerConfig.statuses.READY_FOR_DEVELOPMENT;
    }

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Story done check for', ticketKey, '===');

        const allTCs = findLinkedTCs();
        const totalTCs = allTCs.length;
        console.log('Linked Test Cases:', totalTCs);

        if (totalTCs === 0) {
            console.log('No linked Test Cases found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_test_cases', ticketKey };
        }

        const inFlightTCs = [];
        const pendingBugTCs = [];
        const waitingForBugsTCs = [];
        const readyForRetestTCs = [];

        allTCs.forEach(function(tc) {
            var status = tc.fields && tc.fields.status && tc.fields.status.name;

            if (status === trackerConfig.statuses.PASSED || status === trackerConfig.statuses.SKIPPED || status === trackerConfig.statuses.IRRELEVANT) {
                return;
            }

            if (isInFlightStatus(status)) {
                inFlightTCs.push(tc.key);
                return;
            }

            var pendingBugKey = findPendingBugKey(tc.key);
            if (pendingBugKey) {
                pendingBugTCs.push({ key: tc.key, status: status, bugKey: pendingBugKey });
                return;
            }

            if (status === trackerConfig.statuses.FAILED) {
                waitingForBugsTCs.push(tc.key);
            } else {
                readyForRetestTCs.push(tc.key);
            }
        });

        // Step 1: All Test Cases passed
        if (inFlightTCs.length === 0 && pendingBugTCs.length === 0 && waitingForBugsTCs.length === 0 && readyForRetestTCs.length === 0) {
            console.log('All', totalTCs, 'Test Case(s) passed — moving', ticketKey, 'to Done');

            tracker_move_to_status({
                key: ticketKey,
                statusName: trackerConfig.statuses.DONE
            });

            tracker_post_comment({
                key: ticketKey,
                comment: 'h3. ✅ Story Complete — All Test Cases Passed\n\n' +
                    'All *' + totalTCs + '* linked Test Case(s) are in *Passed* status.\n\n' +
                    'The story has been automatically moved to *Done*.'
            });

            console.log('✅ Story', ticketKey, 'moved to Done');

            try {
                tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
            } catch (e) {
                console.warn('Failed to post token usage comments:', e);
            }

            return { success: true, action: 'moved_to_done', totalTCs, ticketKey };
        }

        // Step 2: Some TCs are still being reviewed/developed — wait for those agents
        if (inFlightTCs.length > 0) {
            console.log(inFlightTCs.length, 'TC(s) still in review/automation — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting_in_flight', totalTCs, inFlightTCs, ticketKey };
        }

        // Step 3: Some TCs have open bugs → Story must wait in Bug To Fix
        if (pendingBugTCs.length > 0) {
            var bugList = pendingBugTCs.map(function(item) {
                return '*' + item.bugKey + '* (from ' + item.key + ')';
            }).join('\n');

            console.log('Found', pendingBugTCs.length, 'TC(s) with pending bugs — moving Story to Bug To Fix');

            tracker_move_to_status({
                key: ticketKey,
                statusName: trackerConfig.statuses.BUG_TO_FIX
            });

            tracker_post_comment({
                key: ticketKey,
                comment: 'h3. 🐛 Story Moved to Bug To Fix\n\n' +
                    'The following linked Test Cases have open bugs:\n\n' + bugList + '\n\n' +
                    'The Story has been moved to *Bug To Fix*. It will return to *Ready For Testing* once all linked bugs are *Done*.'
            });

            console.log('✅ Story', ticketKey, 'moved to Bug To Fix');
            releaseLock();

            try {
                tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
            } catch (e) {
                console.warn('Failed to post token usage comments:', e);
            }

            return { success: true, action: 'moved_to_bug_to_fix', pendingBugTCs: pendingBugTCs.length, ticketKey };
        }

        // Step 4: Some Failed TCs still have no linked bug — wait for bulk_bugs_creation
        if (waitingForBugsTCs.length > 0) {
            console.log('Failed TCs without linked bugs — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting_for_bugs', totalTCs, waitingForBugsTCs, ticketKey };
        }

        // Step 5: All remaining non-passed TCs are ready for re-test → back to Ready For Testing
        console.log('All non-passed TCs are ready for re-test — moving Story to Ready For Testing');

        tracker_move_to_status({
            key: ticketKey,
            statusName: trackerConfig.statuses.READY_FOR_TESTING
        });

        tracker_post_comment({
            key: ticketKey,
            comment: 'h3. 🔄 Story Ready for Re-test\n\n' +
                'All linked bugs are resolved. The Story has been moved back to *Ready For Testing* to re-run the linked Test Cases.'
        });

        console.log('✅ Story', ticketKey, 'moved to Ready For Testing');
        releaseLock();

        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return { success: true, action: 'moved_to_ready_for_testing', readyForRetestTCs: readyForRetestTCs.length, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkStoryTestsPassed:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
