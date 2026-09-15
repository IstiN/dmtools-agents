/**
 * recoverStuckDevelopment.js
 *
 * Local-execution recovery for Story/Bug tickets stuck in the "actively being
 * developed" status (statuses.IN_DEVELOPMENT).
 *
 * preCliDevelopmentSetup.js / preCliReworkSetup.js (opt-in via
 * config.jira.markReworkInDevelopment) move the ticket to statuses.IN_DEVELOPMENT
 * before the CLI agent starts coding or reworking. If the job crashes/times out/gets
 * interrupted after that transition but before the postJSAction
 * (developTicketAndCreatePR.js / developBugAndCreatePR.js / pushReworkChanges.js) runs,
 * the ticket is left stuck with no SM rule able to pick it up again.
 *
 * This is an opt-in agent: it is NOT wired into the default agents/sm.json rule set,
 * since not every project uses a distinct "actively being developed" status. Projects
 * that need it should add a rule for it in their own .dmtools/config.js smRules
 * (see .dmtools/config.js in this repo for an example).
 *
 * This handler:
 *  1. Looks for an open PR matching the ticket key.
 *  2. If an open PR exists → move to statuses.IN_REVIEW so pr_review picks it up
 *     (the branch/PR already reflects whatever work was pushed).
 *  3. If no open PR exists → move back to statuses.READY_FOR_DEVELOPMENT and remove the
 *     sm_story_development_triggered / sm_bug_development_triggered / sm_story_rework_triggered
 *     labels so the normal development or rework flow re-triggers from scratch.
 */

var configLoader = require('./configLoader.js');
const { resolveStatuses } = require('./config.js');

function findPRForTicket(scm, ticketKey) {
    try {
        var prList = scm.listPrs('open');
        var matched = (Array.isArray(prList) ? prList : []).find(function(pr) {
            var titleMatch = pr.title && pr.title.indexOf(ticketKey) !== -1;
            var branchMatch = pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1;
            return titleMatch || branchMatch;
        });
        return matched || null;
    } catch (e) {
        console.error('Failed to list PRs:', e);
        return null;
    }
}

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var config = configLoader.loadProjectConfig(params.jobParams || params || {});
    var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams;
    var statuses = resolveStatuses(customParams, config.jira && config.jira.statuses);

    if (!ticketKey) {
        console.error('No ticket key found');
        return { success: false, error: 'missing ticket key' };
    }

    console.log('Recovering stuck Story/Bug development:', ticketKey);

    var scm = configLoader.createScm(config);
    var pr = findPRForTicket(scm, ticketKey);

    var removableLabels = ['sm_story_development_triggered', 'sm_bug_development_triggered', 'sm_story_rework_triggered'];

    if (!pr) {
        console.log('No open PR found for', ticketKey, '— moving back to', statuses.READY_FOR_DEVELOPMENT);
        try {
            jira_move_to_status({ key: ticketKey, statusName: statuses.READY_FOR_DEVELOPMENT });
            console.log('✅ Moved', ticketKey, 'to', statuses.READY_FOR_DEVELOPMENT);
        } catch (e) {
            console.error('Failed to move to ' + statuses.READY_FOR_DEVELOPMENT + ':', e);
        }
        removableLabels.forEach(function(label) {
            try { jira_remove_label({ key: ticketKey, label: label }); } catch (e) {}
        });
        jira_post_comment({
            key: ticketKey,
            comment: '🔄 *Recovery*: Ticket was stuck in "' + statuses.IN_DEVELOPMENT + '" with no open PR. Moved back to ' + statuses.READY_FOR_DEVELOPMENT + ' for re-automation.'
        });
        return { success: true, action: 'moved_to_ready_for_development', ticketKey: ticketKey };
    }

    console.log('Found open PR #' + pr.number + ': ' + pr.title + ' — moving ticket to', statuses.IN_REVIEW);
    try {
        jira_move_to_status({ key: ticketKey, statusName: statuses.IN_REVIEW });
        console.log('✅ Moved', ticketKey, 'to', statuses.IN_REVIEW);
    } catch (e) {
        console.error('Failed to move to ' + statuses.IN_REVIEW + ':', e);
    }
    removableLabels.forEach(function(label) {
        try { jira_remove_label({ key: ticketKey, label: label }); } catch (e) {}
    });
    jira_post_comment({
        key: ticketKey,
        comment: '🔄 *Recovery*: Ticket was stuck in "' + statuses.IN_DEVELOPMENT + '" with open PR #' + pr.number + '. Moved to ' + statuses.IN_REVIEW + ' for code review.'
    });

    return { success: true, action: 'moved_to_review', ticketKey: ticketKey, prNumber: pr.number };
}

module.exports = { action };
