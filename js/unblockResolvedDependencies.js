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
const trackersModule = require('./common/trackers.js');

function isResolved(blocker, terminalStatuses) {
    // Deleted ticket — no inwardIssue object at all
    if (!blocker) return true;

    var statusName = blocker.fields && blocker.fields.status && blocker.fields.status.name;
    if (!statusName) return false;

    return terminalStatuses.indexOf(statusName) !== -1;
}

// ── pure parse/build/decide helpers (CRAP gate: each ≤ 8) ───────────────────

// Ticket key from the dmtools params shape.
function ticketKeyOf(params) {
    return params.ticket && params.ticket.key;
}

// Inward blockers of the current ticket: links of type Blocks carrying an inwardIssue.
function blockersOf(links) {
    var blockers = [];
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        // inwardIssue means: current ticket is blocked by the inwardIssue
        if (link.inwardIssue && link.type && link.type.name === 'Blocks') {
            blockers.push(link.inwardIssue);
        }
    }
    return blockers;
}

function issuelinksOf(ticket) {
    return (ticket && ticket.fields && ticket.fields.issuelinks) || [];
}

// Terminal statuses that count a blocker as resolved ('Closed' kept as a
// literal for backward compatibility — not part of STATUSES/config).
function terminalStatusesOf(jiraConfig) {
    return [
        jiraConfig.statuses.DONE,
        jiraConfig.statuses.MERGED,
        jiraConfig.statuses.PASSED,
        jiraConfig.statuses.IRRELEVANT,
        'Closed'
    ].filter(Boolean);
}

// Split blockers into resolved (logged) and unresolved {key,status} entries.
function classifyBlockers(blockers, terminalStatuses) {
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
    return unresolved;
}

function emptyToNull(list) {
    return list.length > 0 ? list : null;
}

function unresolvedKeysText(unresolved) {
    return unresolved.map(function(u) { return u.key; }).join(', ');
}

function moveFailed(error) {
    return { success: false, action: 'move_failed', error: error.toString() };
}

// '- KEY (STATUS)' lines describing the resolved blockers.
function resolvedKeysText(blockers) {
    return blockers.map(function(b) {
        return b.key + ' (' + (b.fields && b.fields.status && b.fields.status.name || '?') + ')';
    }).join(', ');
}

function unblockComment(blockers) {
    var resolvedKeys = resolvedKeysText(blockers);
    return 'h3. ✅ Auto-unblocked — All Dependencies Resolved\n\n' +
            'All *' + blockers.length + '* blocker(s) are now in a terminal status:\n' +
            resolvedKeys.split(', ').map(function(k) { return '- ' + k; }).join('\n') + '\n\n' +
            'Automatically moved back to *Backlog* for re-processing.';
}

// Config + tracker + ticket fetch + blocker classification for one check run.
function checkBlockers(params, ticketKey) {
    var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
    var tracker = trackersModule.createTracker(projectConfig, (params.jobParams && params.jobParams.customParams) || {});

    console.log('=== Unblock resolved dependencies check for', ticketKey, '===');

    var ticket;
    try {
        ticket = tracker.getIssue(ticketKey, ['issuelinks']);
    } catch (e) {
        console.warn('Failed to fetch ticket details:', e.message || e);
        return { error: { success: false, action: 'fetch_failed', error: e.toString() } };
    }

    var blockers = blockersOf(issuelinksOf(ticket));
    console.log('Found', blockers.length, 'blocker(s) for', ticketKey);

    return {
        tracker: tracker,
        backlogStatus: projectConfig.jira.statuses.BACKLOG,
        blockers: blockers,
        unresolved: blockers.length === 0 ? null : emptyToNull(classifyBlockers(blockers, terminalStatusesOf(projectConfig.jira)))
    };
}

// No blockers at all: move + comment share one try — a comment failure
// surfaces as move_failed exactly as before.
function unblockWithoutBlockers(check, ticketKey) {
    console.log('No active blockers found — moving', ticketKey, 'to Backlog');
    try {
        check.tracker.moveToStatus(ticketKey, check.backlogStatus);
        check.tracker.postComment(ticketKey, 'h3. ✅ Auto-unblocked — No Active Blockers\n\n' +
                'This ticket was in *Blocked* status but no active "is blocked by" dependencies were found.\n\n' +
                'Automatically moved back to *Backlog* for re-processing.');
        console.log('✅ Moved', ticketKey, 'to Backlog (no blockers)');
        return { success: true, action: 'moved_to_backlog_no_blockers', ticketKey: ticketKey };
    } catch (e) {
        console.warn('Failed to move ticket to Backlog:', e.message || e);
        return moveFailed(e);
    }
}

// All blockers resolved: move first (failure aborts), then comment and token
// usage postings — each failure-tolerant, never blocking the unblock.
function unblockAllResolved(check, ticketKey, params) {
    console.log('All', check.blockers.length, 'blocker(s) resolved — moving', ticketKey, 'to Backlog');
    try {
        check.tracker.moveToStatus(ticketKey, check.backlogStatus);
    } catch (e) {
        console.warn('Failed to move ticket to Backlog:', e.message || e);
        return moveFailed(e);
    }

    try {
        check.tracker.postComment(ticketKey, unblockComment(check.blockers));
        console.log('✅ Posted unblock comment to Jira');
    } catch (e) {
        console.warn('Failed to post comment:', e.message || e);
    }

    console.log('✅ Moved', ticketKey, 'to Backlog');

    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run.
    try {
        tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }

    return { success: true, action: 'moved_to_backlog', blockersResolved: check.blockers.length, ticketKey: ticketKey };
}

function action(params) {
    var ticketKey = ticketKeyOf(params);
    if (!ticketKey) {
        console.error('No ticket key provided');
        return { success: false, action: 'missing_ticket' };
    }

    var check = checkBlockers(params, ticketKey);
    if (check.error) {
        return check.error;
    }

    if (check.unresolved) {
        console.log('Still blocked by', check.unresolved.length, 'unresolved ticket(s):', unresolvedKeysText(check.unresolved));
        return { success: true, action: 'still_blocked', unresolved: check.unresolved, ticketKey: ticketKey };
    }

    if (check.blockers.length === 0) {
        return unblockWithoutBlockers(check, ticketKey);
    }
    return unblockAllResolved(check, ticketKey, params);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
