/**
 * Unblock Resolved Dependencies — postJSAction for unblock_resolved_dependencies agent.
 *
 * Runs on every SM cycle for each ticket in "Blocked" status.
 * - Reads issuelinks to find all "is blocked by" dependencies (inwardIssue with Blocks link type).
 * - If all blockers are in a terminal status (Done, Merged, Passed, Closed, Irrelevant)
 *   or the blocker was deleted (inwardIssue === null), moves the ticket to Backlog.
 * - Otherwise leaves the ticket in Blocked.
 */

const configLoader = require('./configLoader.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');

function isResolved(blocker, terminalStatuses) {
    // Deleted ticket — no inwardIssue object at all
    if (!blocker) return true;

    var statusName = blocker.fields && blocker.fields.status && blocker.fields.status.name;
    if (!statusName) return false;

    return terminalStatuses.indexOf(statusName) !== -1;
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    if (!ticketKey) {
        console.error('No ticket key provided');
        return { success: false, action: 'missing_ticket' };
    }

    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = projectConfig.jira;
    var terminalStatuses = [
        jiraConfig.statuses.DONE,
        jiraConfig.statuses.MERGED,
        jiraConfig.statuses.PASSED,
        jiraConfig.statuses.IRRELEVANT
    ].filter(Boolean);

    console.log('=== Unblock resolved dependencies check for', ticketKey, '===');

    var ticket;
    try {
        ticket = jira_get_ticket({ key: ticketKey, fields: ['issuelinks'] });
    } catch (e) {
        console.warn('Failed to fetch ticket details:', e.message || e);
        return { success: false, action: 'fetch_failed', error: e.toString() };
    }

    var links = (ticket && ticket.fields && ticket.fields.issuelinks) || [];

    // Find all inward blockers (tickets that block the current one)
    var blockers = [];
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        // inwardIssue means: current ticket is blocked by the inwardIssue
        if (link.inwardIssue && link.type && link.type.name === 'Blocks') {
            blockers.push(link.inwardIssue);
        }
    }

    console.log('Found', blockers.length, 'blocker(s) for', ticketKey);

    // If no blockers exist, the ticket shouldn't be in Blocked status
    if (blockers.length === 0) {
        console.log('No active blockers found — moving', ticketKey, 'to Backlog');
        try {
            jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.BACKLOG });
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ✅ Auto-unblocked — No Active Blockers\n\n' +
                    'This ticket was in *Blocked* status but no active "is blocked by" dependencies were found.\n\n' +
                    'Automatically moved back to *Backlog* for re-processing.'
            });
            console.log('✅ Moved', ticketKey, 'to Backlog (no blockers)');
            return { success: true, action: 'moved_to_backlog_no_blockers', ticketKey };
        } catch (e) {
            console.warn('Failed to move ticket to Backlog:', e.message || e);
            return { success: false, action: 'move_failed', error: e.toString() };
        }
    }

    // Check if all blockers are resolved
    var unresolved = [];
    for (var j = 0; j < blockers.length; j++) {
        var b = blockers[j];
        var bKey = b.key || '?';
        var bStatus = b.fields && b.fields.status && b.fields.status.name || 'Unknown';
        if (isResolved(b, terminalStatuses)) {
            console.log('  Blocker', bKey, 'is resolved (', bStatus, ')');
        } else {
            console.log('  Blocker', bKey, 'is NOT resolved (', bStatus, ')');
            unresolved.push({ key: bKey, status: bStatus });
        }
    }

    if (unresolved.length > 0) {
        console.log('Still blocked by', unresolved.length, 'unresolved ticket(s):', unresolved.map(function(u) { return u.key; }).join(', '));
        return { success: true, action: 'still_blocked', unresolved: unresolved, ticketKey };
    }

    // All blockers resolved → move to Backlog
    console.log('All', blockers.length, 'blocker(s) resolved — moving', ticketKey, 'to Backlog');
    try {
        jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.BACKLOG });
    } catch (e) {
        console.warn('Failed to move ticket to Backlog:', e.message || e);
        return { success: false, action: 'move_failed', error: e.toString() };
    }

    var resolvedKeys = blockers.map(function(b) {
        return b.key + ' (' + (b.fields && b.fields.status && b.fields.status.name || '?') + ')';
    }).join(', ');

    try {
        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Auto-unblocked — All Dependencies Resolved\n\n' +
                'All *' + blockers.length + '* blocker(s) are now in a terminal status:\n' +
                resolvedKeys.split(', ').map(function(k) { return '- ' + k; }).join('\n') + '\n\n' +
                'Automatically moved back to *Backlog* for re-processing.'
        });
        console.log('✅ Posted unblock comment to Jira');
    } catch (e) {
        console.warn('Failed to post comment:', e.message || e);
    }

    console.log('✅ Moved', ticketKey, 'to Backlog');

    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run.
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }

    return { success: true, action: 'moved_to_backlog', blockersResolved: blockers.length, ticketKey };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
