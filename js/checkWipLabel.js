/**
 * Check WIP Label Pre-Action
 * Checks if ticket has a work-in-progress label and stops processing if found
 * Returns false to stop processing, true to continue
 */

/**
 * Pre-action function to check for WIP label
 * 
 * @param {Object} params - Parameters from Teammate job
 * @param {Object} params.ticket - Jira ticket object
 * @param {Object} params.metadata - Job metadata containing contextId
 * @returns {boolean} false to stop processing, true to continue
 */

var configLoader = require('./configLoader.js');
var gh = require('./common/githubHelpers.js');

function action(params) {
    try {
        const ticket = params.ticket;
        const metadata = params.metadata;

        console.log('=== Running checkWipLabel pre-action ===');
        console.log('Ticket key:', ticket && ticket.key ? ticket.key : '(missing)');
        console.log('Context ID:', metadata && metadata.contextId ? metadata.contextId : '(missing)');
        
        if (!ticket || !metadata || !metadata.contextId) {
            console.log('No contextId in metadata, continuing with processing');
            return true;
        }
        
        // Dynamically generate WIP label from contextId
        const wipLabel = metadata.contextId + '_wip';
        const ticketKey = ticket.key;
        
        // Get ticket labels
        const labels = ticket.fields && ticket.fields.labels ? ticket.fields.labels : [];
        console.log('Expected WIP label:', wipLabel);
        console.log('Ticket labels:', labels.length > 0 ? labels.join(', ') : '(none)');
        
        // Check if WIP label exists
        if (labels.includes(wipLabel)) {
            console.log('⏸️  Ticket ' + ticketKey + ' has WIP label "' + wipLabel + '" - skipping processing');
            
            // Post comment to ticket explaining why it was skipped
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. *Processing Skipped*\n\n' +
                            'This ticket has the *' + wipLabel + '* label indicating work is in progress.\n' +
                            'Processing will be skipped until the label is removed.\n\n' +
                            '_Remove the label to allow automated processing._'
                });
                console.log('Posted skip notification comment to ' + ticketKey);
            } catch (commentError) {
                console.warn('Failed to post skip comment:', commentError);
            }
            
            console.log('checkWipLabel result: stop processing');
            return false; // Stop processing
        }
        
        console.log('✅ Ticket ' + ticketKey + ' does not have WIP label "' + wipLabel + '" - continuing with processing');

        // Optional: verify an open PR exists for review/rework agents.
        var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
        if (customParams.checkOpenPR) {
            try {
                var config = configLoader.loadProjectConfig(params.jobParams || params);
                var scm = configLoader.createScm(config);
                var pr = gh.findPRForTicket(scm, ticketKey);
                if (!pr) {
                    console.log('⏸️  No open PR found for ' + ticketKey + ' - skipping processing');
                    try {
                        jira_post_comment({
                            key: ticketKey,
                            comment: 'h3. *Processing Skipped*\n\nNo open Pull Request found for this ticket. The review/rework agent cannot run without an existing PR.\n\n_Ticket will be processed again once a PR is available._'
                        });
                    } catch (commentError) {
                        console.warn('Failed to post skip comment:', commentError);
                    }
                    console.log('checkWipLabel result: stop processing (no open PR)');
                    return false;
                }
                console.log('✅ Found open PR #' + pr.number + ' for ' + ticketKey + ' - continuing');
            } catch (prError) {
                console.warn('Failed to check open PR (non-fatal):', prError);
            }
        }

        console.log('checkWipLabel result: continue processing');
        return true; // Continue processing
        
    } catch (error) {
        console.error('❌ Error in WIP label check:', error);
        // On error, continue processing to avoid blocking legitimate workflows
        console.warn('Continuing with processing despite error in WIP check');
        console.log('checkWipLabel result: continue processing after error');
        return true;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action };
}
