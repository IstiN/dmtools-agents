/**
 * Check Bug To Fix Ready — postJSAction for bug_to_fix_check agent.
 *
 * Runs on every SM cycle for tickets in "Bug To Fix" status.
 *
 * Test Case:
 * - Finds all linked Bugs.
 * - If all linked Bugs are in "Done" → moves TC to "Backlog" (ready for re-automation).
 * - Otherwise → releases the SM idempotency label so the check re-runs next cycle.
 *
 * Story:
 * - Finds all linked Bugs AND all Bugs linked to linked Test Cases.
 * - If every linked Bug (direct or through a Test Case) is in "Done" → moves Story
 *   to "Ready For Testing" to trigger a full re-test of all linked Test Cases.
 * - Otherwise → releases the SM idempotency label so the check re-runs next cycle.
 */

const { STATUSES } = require('./config.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const ticketFields = params.ticket && params.ticket.fields;
    const issueType = (ticketFields && ticketFields.issuetype && ticketFields.issuetype.name) || 'Test Case';
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;

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

    function findLinkedBugs(entityKey) {
        var key = entityKey || ticketKey;
        return jira_search_by_jql({
            jql: 'issue in linkedIssues("' + key + '") AND issuetype = Bug',
            maxResults: 50
        }) || [];
    }

    function findNotDoneBugs(entityKey) {
        var key = entityKey || ticketKey;
        return jira_search_by_jql({
            jql: 'issue in linkedIssues("' + key + '") AND issuetype = Bug AND status != "Done"',
            maxResults: 50
        }) || [];
    }

    function findLinkedTestCases() {
        return jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "Test Case"',
            maxResults: 100
        }) || [];
    }

    function findPendingBugsInLinkedTestCases() {
        var testCases = findLinkedTestCases();
        var pending = [];
        testCases.forEach(function(tc) {
            var tcKey = tc.key;
            var notDone = findNotDoneBugs(tcKey);
            notDone.forEach(function(bug) {
                pending.push({ tcKey: tcKey, bugKey: bug.key, status: bug.fields && bug.fields.status && bug.fields.status.name });
            });
        });
        return pending;
    }

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Bug To Fix ready check for', ticketKey, '(' + issueType + ') ===');

        const linkedBugs = findLinkedBugs();
        const totalBugs = linkedBugs.length;
        console.log('Linked Bugs:', totalBugs);

        if (totalBugs === 0) {
            console.log('No linked Bugs found — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'no_linked_bugs', issueType, ticketKey };
        }

        const notDoneBugs = findNotDoneBugs();
        const notDoneCount = notDoneBugs.length;
        console.log('Linked Bugs not yet Done:', notDoneCount, '/', totalBugs);

        if (notDoneCount > 0) {
            console.log('Not all linked Bugs are Done — releasing lock, will re-check next cycle');
            releaseLock();
            return { success: true, action: 'waiting', issueType, total: totalBugs, notDone: notDoneCount, ticketKey };
        }

        if (issueType === 'Story') {
            // Also check bugs linked to linked Test Cases before allowing the Story to re-test.
            const pendingTcBugs = findPendingBugsInLinkedTestCases();
            if (pendingTcBugs.length > 0) {
                var details = pendingTcBugs.map(function(item) {
                    return '* ' + item.bugKey + ' (' + item.status + ') via Test Case ' + item.tcKey;
                }).join('\n');
                console.log('Found', pendingTcBugs.length, 'pending Bug(s) linked to linked Test Cases — keeping Story in Bug To Fix');
                console.log(details);
                releaseLock();
                return { success: true, action: 'waiting_for_tc_bugs', issueType, pendingTcBugs: pendingTcBugs, ticketKey };
            }

            // All linked Bugs are Done → move Story back to Ready For Testing for re-test
            console.log('All', totalBugs, 'linked Bug(s) are Done — moving Story', ticketKey, 'to Ready For Testing');

            jira_move_to_status({
                key: ticketKey,
                statusName: STATUSES.READY_FOR_TESTING
            });

            // Remove the story_done_check lock so it can re-run after the Story returns to In Testing
            try {
                jira_remove_label({ key: ticketKey, label: 'sm_story_done_check_triggered' });
                console.log('Removed sm_story_done_check_triggered — story_done_check will run after re-test');
            } catch (e) {
                console.warn('Failed to remove sm_story_done_check_triggered label:', e);
            }

            releaseLock();

            jira_post_comment({
                key: ticketKey,
                comment: 'h3. 🔄 Story Ready for Re-test\n\n' +
                    'All *' + totalBugs + '* linked Bug(s) are now in *Done* status.\n\n' +
                    'The Story has been automatically moved back to *Ready For Testing* to re-run all linked Test Cases.'
            });

            console.log('✅ Story', ticketKey, 'moved to Ready For Testing');
        } else {
            // All linked Bugs are Done → move TC back to Backlog
            console.log('All', totalBugs, 'linked Bug(s) are Done — moving', ticketKey, 'to Backlog');

            jira_move_to_status({
                key: ticketKey,
                statusName: STATUSES.BACKLOG
            });

            // Remove test automation label so SM can re-trigger automation
            try {
                jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' });
                console.log('Removed sm_test_automation_triggered — TC will be re-automated next SM cycle');
            } catch (e) {
                console.warn('Failed to remove sm_test_automation_triggered label:', e);
            }

            releaseLock();

            jira_post_comment({
                key: ticketKey,
                comment: 'h3. 🔄 Test Case Ready for Re-automation\n\n' +
                    'All *' + totalBugs + '* linked Bug(s) are now in *Done* status.\n\n' +
                    'This Test Case has been automatically moved back to *Backlog* to be re-automated against the fixed code.'
            });

            console.log('✅ TC', ticketKey, 'moved to Backlog');
        }

        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return { success: true, action: issueType === 'Story' ? 'moved_to_ready_for_testing' : 'moved_to_backlog', totalBugs: totalBugs, ticketKey };

    } catch (error) {
        console.error('❌ Error in checkBugToFixReady:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
