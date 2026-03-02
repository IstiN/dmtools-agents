/**
 * Develop Bug and Create PR Post-Action
 * postJSAction for bug_development agent.
 *
 * Three possible outcomes determined by outputs written by the CLI agent:
 *
 *   outputs/blocked.json      → Bug cannot be fixed (needs human / credentials / etc.)
 *                               → Post Jira comment, move to Blocked, remove labels
 *
 *   outputs/already_fixed.json → Bug was fixed in a prior commit, no new code changes
 *                               → Post Jira comment with commit ref, move to Ready For Testing
 *
 *   (neither file)             → Normal fix — code changes made
 *                               → Delegate to developTicketAndCreatePR: commit, push, create PR, move to In Review
 */

const { STATUSES, LABELS } = require('./config.js');
const developTicket = require('./developTicketAndCreatePR.js');

function readJson(path) {
    try {
        const raw = file_read({ path: path });
        return (raw && raw.trim()) ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function removeLabels(ticketKey, params) {
    const wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip' : null;
    if (wipLabel) {
        try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
    }

    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;
    if (removeLabel) {
        try {
            jira_remove_label({ key: ticketKey, label: removeLabel });
            console.log('✅ Removed SM label:', removeLabel);
        } catch (e) {}
    }
}

function action(params) {
    try {
        const actualParams = params.ticket ? params : (params.jobParams || params);
        const ticketKey = actualParams.ticket.key;

        console.log('=== Bug development post-action for', ticketKey, '===');

        // ── Path 1: Blocked ──────────────────────────────────────────────────
        const blocked = readJson('outputs/blocked.json');
        if (blocked) {
            console.log('outputs/blocked.json found — bug cannot be fixed automatically');

            let comment = 'h3. 🚫 Bug Cannot Be Fixed Automatically\n\n';
            comment += '*Reason*: ' + (blocked.reason || '(see details below)') + '\n\n';
            if (blocked.tried && blocked.tried.length > 0) {
                comment += '*Attempted*:\n';
                blocked.tried.forEach(function(t) { comment += '- ' + t + '\n'; });
                comment += '\n';
            }
            if (blocked.needs) {
                comment += '*Needs from human*: ' + blocked.needs + '\n';
            }

            try { jira_post_comment({ key: ticketKey, comment: comment }); } catch (e) {}

            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.BLOCKED });
                console.log('✅ Moved', ticketKey, 'to Blocked');
            } catch (e) {
                console.warn('Failed to move to Blocked:', e);
            }

            removeLabels(ticketKey, params);
            return { success: true, path: 'blocked', ticketKey };
        }

        // ── Path 2: Already Fixed ────────────────────────────────────────────
        const alreadyFixed = readJson('outputs/already_fixed.json');
        if (alreadyFixed) {
            console.log('outputs/already_fixed.json found — bug already resolved in codebase');

            let comment = 'h3. ✅ Bug Already Fixed\n\n';
            if (alreadyFixed.rca) {
                comment += '*Root Cause*: ' + alreadyFixed.rca + '\n\n';
            }
            if (alreadyFixed.commit) {
                comment += '*Fixed in commit*: {code}' + alreadyFixed.commit + '{code}\n\n';
            }
            if (alreadyFixed.description) {
                comment += alreadyFixed.description + '\n\n';
            }
            comment += 'No new PR required — fix is already in the codebase. Moved to *Merged* so the Solution field and RCA are generated before test cases.';

            try { jira_post_comment({ key: ticketKey, comment: comment }); } catch (e) {}

            try {
                jira_move_to_status({ key: ticketKey, statusName: STATUSES.MERGED });
                console.log('✅ Moved', ticketKey, 'to Merged');
            } catch (e) {
                console.warn('Failed to move to Merged:', e);
            }

            try { jira_add_label({ key: ticketKey, label: LABELS.AI_DEVELOPED }); } catch (e) {}

            removeLabels(ticketKey, params);
            return { success: true, path: 'already_fixed', ticketKey };
        }

        // ── Path 3: Normal Fix — code changes present ────────────────────────
        console.log('No special outputs found — proceeding with normal PR creation');
        const result = developTicket.action(params);

        // Remove SM idempotency label after PR creation
        // (developTicketAndCreatePR doesn't know about SM labels)
        if (result.success) {
            const customParams = params.jobParams && params.jobParams.customParams;
            const removeLabel = customParams && customParams.removeLabel;
            if (removeLabel) {
                try {
                    jira_remove_label({ key: ticketKey, label: removeLabel });
                    console.log('✅ Removed SM label:', removeLabel);
                } catch (e) {}
            }
        }

        return result;

    } catch (error) {
        console.error('❌ Error in developBugAndCreatePR:', error);
        try {
            const key = (params.ticket || (params.jobParams && params.jobParams.ticket) || {}).key;
            if (key) {
                jira_post_comment({
                    key: key,
                    comment: 'h3. ❌ Bug Development Error\n\n{code}' + error.toString() + '{code}'
                });
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
