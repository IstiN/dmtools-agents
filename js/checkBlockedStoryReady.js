/**
 * Check Blocked Story Ready — postJSAction for blocked_story_check agent.
 *
 * Runs on every SM cycle for each Story in "Blocked" status.
 * - Finds Jira "Blocks" links where another ticket blocks this Story.
 * - If all blocker tickets are in "Done" -> moves the Story to configured targetStatus.
 * - Otherwise leaves the Story blocked so it can be checked again next cycle.
 */

const { STATUSES } = require('./config.js');

function quoteJqlValue(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function findBlockerKeys(ticket) {
    const links = ticket && ticket.fields && ticket.fields.issuelinks;
    if (!links || !Array.isArray(links)) return [];

    const keys = [];
    links.forEach(function(link) {
        const type = link.type || {};
        const typeName = String(type.name || '').toLowerCase();
        const inwardName = String(type.inward || '').toLowerCase();
        const isBlocksLink = typeName === 'blocks' || inwardName.indexOf('blocked') !== -1;

        if (isBlocksLink && link.inwardIssue && link.inwardIssue.key) {
            keys.push(link.inwardIssue.key);
        }
    });

    return keys;
}

function action(params) {
    const ticketKey = params.ticket && params.ticket.key;
    const customParams = params.jobParams && params.jobParams.customParams;
    const targetStatus = (customParams && customParams.targetStatus) || STATUSES.BACKLOG;

    try {
        if (!ticketKey) throw new Error('params.ticket.key is missing');
        console.log('=== Blocked Story ready check for', ticketKey, '===');

        const blockerKeys = findBlockerKeys(params.ticket);
        const totalBlockers = blockerKeys.length;
        console.log('Blocker tickets:', totalBlockers, totalBlockers ? '(' + blockerKeys.join(', ') + ')' : '');

        if (totalBlockers === 0) {
            console.log('No blocker links found — leaving Story blocked');
            return { success: true, action: 'no_blocker_links', ticketKey: ticketKey };
        }

        const notDoneTickets = jira_search_by_jql({
            jql: 'issue in (' + blockerKeys.map(quoteJqlValue).join(', ') + ') AND status != "' + STATUSES.DONE + '"',
            maxResults: 50
        }) || [];

        const notDoneCount = notDoneTickets.length;
        console.log('Blocker tickets not yet Done:', notDoneCount, '/', totalBlockers);

        if (notDoneCount > 0) {
            const waitingFor = notDoneTickets.map(function(ticket) { return ticket.key; }).join(', ');
            console.log('Story remains blocked — waiting for:', waitingFor);
            return {
                success: true,
                action: 'waiting',
                total: totalBlockers,
                notDone: notDoneCount,
                waitingFor: waitingFor,
                ticketKey: ticketKey
            };
        }

        console.log('All', totalBlockers, 'blocker ticket(s) are Done — moving', ticketKey, 'to', targetStatus);

        jira_move_to_status({
            key: ticketKey,
            statusName: targetStatus
        });

        jira_post_comment({
            key: ticketKey,
            comment: 'h3. ✅ Story Unblocked\n\n' +
                'All *' + totalBlockers + '* blocker ticket(s) are now in *Done* status.\n\n' +
                'This Story has been automatically moved from *Blocked* to *' + targetStatus + '*.'
        });

        console.log('✅ Story', ticketKey, 'moved to', targetStatus);
        return {
            success: true,
            action: 'moved_to_target_status',
            targetStatus: targetStatus,
            totalBlockers: totalBlockers,
            ticketKey: ticketKey
        };

    } catch (error) {
        console.error('❌ Error in checkBlockedStoryReady:', error);
        return { success: false, error: error.toString(), ticketKey: ticketKey };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, findBlockerKeys };
}
