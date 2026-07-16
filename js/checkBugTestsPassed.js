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

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;

    // Load project config to get issue types (default: "Test Case" / "Bug")
    const projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    const jiraConfig = projectConfig.jira;
    const testCaseType = jiraConfig.issueTypes.TEST_CASE || 'Test Case';
    const bugType = jiraConfig.issueTypes.BUG || 'Bug';

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

    function getTicket() {
        try {
            return jira_get_ticket({ key: ticketKey }) || {};
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
        if (status === jiraConfig.statuses.PASSED || status === jiraConfig.statuses.SKIPPED || status === jiraConfig.statuses.IRRELEVANT) {
            return false;
        }

        // A TC that is already tracked as "Bug To Fix" is non-blocking when it
        // has its own linked Bug(s) other than the current Bug. Those Bugs will
        // be fixed through the normal bug-fix pipeline; waiting for them here
        // creates deadlocks (e.g. TS-1356 was stuck because parent-Story
        // regression TCs TS-501/TS-252 were Bug To Fix). We count *any* other
        // linked Bug (even Done) so stale TCs that were already addressed do not
        // hold the current Bug hostage.
        if (status === jiraConfig.statuses.BUG_TO_FIX) {
            var linkedBugs = findLinkedBugs(tc.key);
            var hasOtherBug = linkedBugs.some(function(bug) {
                var bugStatus = bug.fields && bug.fields.status && bug.fields.status.name;
                return bug.key !== ticketKey && bugStatus !== STATUSES.DONE;
            });
            if (hasOtherBug) {
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
            const isFinalized = labels.indexOf(LABELS.TEST_PR_FINALIZED) !== -1;
            if (isFinalized) {
                // Anti-cycle guard: do not bounce a finalized Bug back to In Rework
                // more than once for the same blockers. After one rework attempt,
                // move to Blocked so a human triages persistent blockers instead of
                // burning CI minutes in an infinite loop.
                var reworkAttempted = labels.indexOf('sm_bug_rework_attempted') !== -1;
                if (reworkAttempted) {
                    console.log('Test PR finalized and one rework already attempted — moving', ticketKey, 'to Blocked for triage');
                    jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.BLOCKED });
                    jira_post_comment({
                        key: ticketKey,
                        comment: 'h3. 🚫 Test PR Finalized But Acceptance Tests Still Blocking After Rework\n\n' +
                            'The test-automation PR was merged and finalized, and one rework was already attempted, but the following linked Test Case(s) are still not *Passed*:\n' +
                            blockingTCs.map(function(tc) { return '- ' + tc.key + ' (' + (tc.fields && tc.fields.status && tc.fields.status.name || 'unknown') + ')'; }).join('\n') + '\n\n' +
                            'Moving the Bug to *Blocked* for manual triage instead of cycling indefinitely.'
                    });
                    releaseLock();
                    return { success: true, action: 'moved_to_blocked', totalTCs, blockingCount, blockingTCs: blockingTCs.map(function(tc) { return tc.key; }), ticketKey };
                }

                console.log('Test PR finalized but', blockingCount, 'linked Test Case(s) still block — moving', ticketKey, 'to In Rework (one attempt)');
                jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.IN_REWORK });
                jira_add_label({ key: ticketKey, label: 'sm_bug_rework_attempted' });
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. 🔄 Test PR Merged But Acceptance Tests Still Blocking\n\n' +
                        'The test-automation PR was merged and finalized, but the following linked Test Case(s) are still not *Passed*:\n' +
                        blockingTCs.map(function(tc) { return '- ' + tc.key + ' (' + (tc.fields && tc.fields.status && tc.fields.status.name || 'unknown') + ')'; }).join('\n') + '\n\n' +
                        'Moving the Bug to *In Rework* for one more fix attempt. If it still fails, it will be moved to *Blocked*.'
                });
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
            openTestPR = prList.find(function(pr) {
                var titleMatch = pr.title && pr.title.indexOf(ticketKey) !== -1;
                var branchMatch = pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1;
                return titleMatch || branchMatch;
            });
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

        jira_move_to_status({
            key: ticketKey,
            statusName: jiraConfig.statuses.DONE
        });

        // Clean up anti-cycle label on successful completion.
        try {
            jira_remove_label({ key: ticketKey, label: 'sm_bug_rework_attempted' });
        } catch (e) {
            console.warn('Could not remove sm_bug_rework_attempted label:', e);
        }

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
