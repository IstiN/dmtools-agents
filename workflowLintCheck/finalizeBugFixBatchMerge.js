/**
 * Finalize Bug-fix Batch Merge
 *
 * Runs after the batch Epic's PR has been merged.
 * Moves all linked bug-fix batch bugs to Done, then moves the Epic to Done.
 */

var batchContext = require('./prepareBugFixBatchContext.js');
const { STATUSES, resolveStatuses } = require('./config.js');

function transitionTicket(key, statusName) {
    try {
        jira_move_to_status({ key: key, statusName: statusName });
        console.log('Moved ' + key + ' to ' + statusName);
        return true;
    } catch (e) {
        console.warn('Failed to move ' + key + ' to ' + statusName + ':', e);
        return false;
    }
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var epicFolder = actualParams.inputFolderPath;
        var epicKey = epicFolder.split('/').pop();
        var epic = actualParams.ticket || { key: epicKey, fields: {} };

        var customParams = actualParams.customParams || {};
        var statuses = resolveStatuses(customParams);

        var bugs = batchContext.findBugsInEpic(epicKey);
        console.log('Finalizing batch merge for', epicKey, '(' + bugs.length + ' linked bug(s))');

        var movedBugs = [];
        for (var i = 0; i < bugs.length; i++) {
            var bugKey = bugs[i].key;
            if (transitionTicket(bugKey, statuses.DONE)) {
                movedBugs.push(bugKey);
            }
        }

        transitionTicket(epicKey, statuses.DONE);

        try {
            var bugList = movedBugs.length > 0
                ? movedBugs.join(', ')
                : '(none)';
            jira_post_comment({
                key: epicKey,
                comment: 'h3. *Bug-fix Batch Finalized*\n\n' +
                    'The batch PR has been merged. The following linked bugs have been moved to *Done*:\n' +
                    bugList
            });
        } catch (e) {
            console.warn('Failed to post finalization comment on Epic (non-fatal):', e);
        }

        return { success: true, movedBugs: movedBugs };

    } catch (error) {
        console.error('Error in finalizeBugFixBatchMerge:', error);
        throw error;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
