/**
 * Bug-Fix Batch Coordinator — postJSAction for bug_fix_batch_coordinator.
 *
 * Runs as a local (no-AI) SM step for each Story in "Bug To Fix" status.
 *
 * Goal: group the Story's still-relevant open bugs into a single Epic container
 * so they can be fixed, reviewed and merged together instead of one at a time.
 *
 * What it does:
 *   1. Finds linked Bugs that are NOT Done and NOT already in a batch
 *      (label bug_fix_batch).
 *   2. Keeps only bugs that still block at least one failing Test Case
 *      (status Failed or Bug To Fix).
 *   3. Looks for an existing open batch Epic for this Story;
 *      if none exists, creates one.
 *   4. Links the selected Bugs to the Epic, labels them bug_fix_batch,
 *      and moves the Epic to Ready For Development.
 *   5. Removes the SM trigger label so the coordinator can re-run next cycle
 *      and add any newly created bugs to the same (or a new) batch.
 *
 * Bugs with the bug_fix_batch label are intentionally excluded from the
 * individual bug_development rule, so the batch agent owns them.
 */

const { STATUSES, ISSUE_TYPES, LABELS } = require('./config.js');
const { extractTicketKey } = require('./common/jiraHelpers.js');

var BUG_FIX_BATCH_LABEL = LABELS.BUG_FIX_BATCH || 'bug_fix_batch';
var BATCH_STATUS = STATUSES.READY_FOR_DEVELOPMENT || 'Ready For Development';
var DONE_STATUS = STATUSES.DONE || 'Done';

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var customParams = (params.jobParams && params.jobParams.customParams) || {};
    var removeLabel = customParams.removeLabel;
    var batchSize = customParams.batchSize || 5;

    function releaseLock() {
        if (ticketKey && removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('Released SM lock label', removeLabel, 'from', ticketKey);
            } catch (e) {
                console.warn('Failed to remove SM lock label:', e);
            }
        }
    }

    function extractIssues(result) {
        if (!result) return [];
        if (Array.isArray(result)) return result;
        if (typeof result === 'string') {
            try {
                return extractIssues(JSON.parse(result));
            } catch (e) {
                return [];
            }
        }
        if (Array.isArray(result.issues)) return result.issues;
        if (Array.isArray(result.results)) return result.results;
        if (Array.isArray(result.data)) return result.data;
        return [];
    }

    function searchIssues(jql, fields, maxResults) {
        try {
            var result = jira_search_by_jql({
                jql: jql,
                fields: fields || ['key', 'status', 'summary', 'labels'],
                maxResults: maxResults || 50
            });
            return extractIssues(result);
        } catch (e) {
            console.warn('JQL search failed:', jql, e);
            return [];
        }
    }

    function getProjectKey() {
        return (ticketKey && ticketKey.split('-')[0]) || 'TS';
    }

    function findCandidateBugs(storyKey) {
        // Only group bugs that have not been individually picked up yet.
        // In Development / In Progress bugs are left for the single-bug pipeline.
        var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = Bug ' +
            'AND status in ("' + (STATUSES.BACKLOG || 'Backlog') + '", "' + (STATUSES.TODO || 'To Do') + '", "' + (STATUSES.READY_FOR_DEVELOPMENT || 'Ready For Development') + '") ' +
            'AND (labels is EMPTY OR labels NOT IN ("' + BUG_FIX_BATCH_LABEL + '")) ' +
            'ORDER BY created ASC';
        return searchIssues(jql, ['key', 'status', 'summary', 'labels']);
    }

    function findExistingBatchEpic(storyKey) {
        var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = Epic ' +
            'AND labels in ("' + BUG_FIX_BATCH_LABEL + '") ' +
            'AND status != "' + DONE_STATUS + '" ' +
            'ORDER BY created ASC';
        var epics = searchIssues(jql, ['key', 'status', 'summary', 'labels'], 1);
        return epics.length > 0 ? epics[0] : null;
    }

    function bugStillRelevant(bugKey) {
        var jql = 'issue in linkedIssues("' + bugKey + '") AND issuetype = "Test Case" ' +
            'AND status in ("' + (STATUSES.FAILED || 'Failed') + '", "' + (STATUSES.BUG_TO_FIX || 'Bug To Fix') + '")';
        var tcs = searchIssues(jql, ['key', 'status'], 1);
        return tcs.length > 0;
    }

    function createBatchEpic(storyKey, projectKey, bugs) {
        var summary = 'Bug-fix batch for ' + storyKey + ' (' + bugs.length + ' bug' + (bugs.length === 1 ? '' : 's') + ')';
        var description = 'h3. 🐛 Bug-fix batch container\n\n' +
            'This Epic groups open bugs linked to *' + storyKey + '* that block failing Test Cases. ' +
            'They will be fixed, reviewed and merged in a single cycle.\n\n' +
            'h4. Linked bugs\n\n' +
            bugs.map(function(b) { return '* ' + b.key + ' — ' + (b.fields && b.fields.summary || ''); }).join('\n') + '\n\n' +
            '_Bugs are excluded from individual bug_development while they are in this batch._';

        var fieldsJson = {
            summary: summary,
            description: description,
            issuetype: { name: ISSUE_TYPES.EPIC || 'Epic' },
            labels: [BUG_FIX_BATCH_LABEL]
        };

        var result = jira_create_ticket_with_json({
            project: projectKey,
            fieldsJson: fieldsJson
        });
        var epicKey = extractTicketKey(result);
        if (!epicKey) {
            throw new Error('Epic was created but key could not be extracted from result: ' + JSON.stringify(result));
        }
        console.log('Created batch Epic:', epicKey);

        // Relate the batch Epic to the parent Story so it is visible on both sides.
        try {
            jira_link_issues({
                sourceKey: epicKey,
                anotherKey: storyKey,
                relationship: 'Relates'
            });
            console.log('Linked Epic', epicKey, 'to Story', storyKey);
        } catch (e) {
            console.warn('Failed to link Epic to Story:', e);
        }

        return epicKey;
    }

    function linkBugToEpic(bugKey, epicKey) {
        jira_link_issues({
            sourceKey: epicKey,
            anotherKey: bugKey,
            relationship: 'Relates'
        });
        console.log('Linked bug', bugKey, 'to Epic', epicKey);
    }

    function labelBugAsBatched(bugKey) {
        jira_add_label({
            key: bugKey,
            label: BUG_FIX_BATCH_LABEL
        });
        console.log('Added label', BUG_FIX_BATCH_LABEL, 'to', bugKey);
    }

    function moveEpicToReady(epicKey) {
        jira_move_to_status({
            key: epicKey,
            statusName: BATCH_STATUS
        });
        console.log('Moved Epic', epicKey, 'to', BATCH_STATUS);
    }

    function postComments(storyKey, epicKey, bugs, isNew) {
        var bugList = bugs.map(function(b) { return '* ' + b.key; }).join('\n');
        var epicComment = 'h3. ' + (isNew ? '📦 New Bug-fix Batch Created' : '📦 Bugs Added to Existing Batch') + '\n\n' +
            'Container: *' + epicKey + '*\n' +
            'Linked bugs from *' + storyKey + '*:\n' + bugList + '\n\n' +
            'These bugs are now labeled *' + BUG_FIX_BATCH_LABEL + '* and will be handled as a single batch.';
        try {
            jira_post_comment({ key: epicKey, comment: epicComment });
        } catch (e) {
            console.warn('Failed to comment on Epic:', e);
        }

        var storyComment = 'h3. 📦 Bug-fix Batch ' + (isNew ? 'Created' : 'Updated') + '\n\n' +
            'Container: *' + epicKey + '*\n' +
            'Bugs added to batch:\n' + bugList + '\n\n' +
            'The Epic has been moved to *' + BATCH_STATUS + '*.';
        try {
            jira_post_comment({ key: storyKey, comment: storyComment });
        } catch (e) {
            console.warn('Failed to comment on Story:', e);
        }
    }

    try {
        if (!ticketKey) {
            throw new Error('params.ticket.key is missing');
        }
        console.log('=== Bug-fix batch coordinator for Story', ticketKey, '===');

        var candidateBugs = findCandidateBugs(ticketKey);
        console.log('Found', candidateBugs.length, 'candidate bug(s) not yet batched');

        if (candidateBugs.length === 0) {
            console.log('No unbatched open bugs — nothing to do');
            releaseLock();
            return { success: true, action: 'no_candidates', ticketKey: ticketKey };
        }

        var relevantBugs = [];
        for (var i = 0; i < candidateBugs.length; i++) {
            var bug = candidateBugs[i];
            if (bugStillRelevant(bug.key)) {
                relevantBugs.push(bug);
            } else {
                console.log('Skipping', bug.key, '- no linked failing Test Case');
            }
        }

        // Respect batch size so the PR stays reviewable.
        if (relevantBugs.length > batchSize) {
            console.log('Limiting batch to first', batchSize, 'of', relevantBugs.length, 'relevant bugs');
            relevantBugs = relevantBugs.slice(0, batchSize);
        }

        if (relevantBugs.length === 0) {
            console.log('No relevant bugs to batch — nothing to do');
            releaseLock();
            return { success: true, action: 'no_relevant_bugs', ticketKey: ticketKey };
        }

        console.log('Selected', relevantBugs.length, 'bug(s) for batch:', relevantBugs.map(function(b){return b.key;}).join(', '));

        var existingEpic = findExistingBatchEpic(ticketKey);
        var epicKey = existingEpic ? existingEpic.key : null;
        var isNew = false;

        if (!epicKey) {
            epicKey = createBatchEpic(ticketKey, getProjectKey(), relevantBugs);
            isNew = true;
        } else {
            console.log('Using existing batch Epic:', epicKey);
        }

        for (var j = 0; j < relevantBugs.length; j++) {
            var bugKey = relevantBugs[j].key;
            try {
                linkBugToEpic(bugKey, epicKey);
            } catch (e) {
                console.warn('Failed to link bug', bugKey, 'to Epic', epicKey, ':', e);
                // Continue with the rest; don't fail the whole batch for one link error.
            }
            try {
                labelBugAsBatched(bugKey);
            } catch (e) {
                console.warn('Failed to label bug', bugKey, ':', e);
            }
        }

        try {
            moveEpicToReady(epicKey);
        } catch (e) {
            console.warn('Failed to move Epic to Ready For Development:', e);
        }

        postComments(ticketKey, epicKey, relevantBugs, isNew);
        releaseLock();

        console.log('✅ Bug-fix batch coordinator complete for', ticketKey, '-> Epic', epicKey);
        return {
            success: true,
            action: isNew ? 'batch_created' : 'batch_updated',
            storyKey: ticketKey,
            epicKey: epicKey,
            batchedBugs: relevantBugs.map(function(b){ return b.key; })
        };

    } catch (error) {
        console.error('❌ Error in createBugFixBatchEpic:', error);
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
