/**
 * Fetch Parent Context To Input
 *
 * For a given story ticket, finds the parent ticket and then looks for child
 * sub-tasks whose summary starts with one of the known context prefixes:
 *   [BA]  — Business Analysis: acceptance criteria, business rules, user flows
 *   [SA]  — Solution Architecture: technical design, data model, API contracts
 *   [VD]  — Visual Design: UI mockups, component specs, design notes
 *
 * Each found child is written to the input folder as a separate markdown file:
 *   parent_context_ba.md   — Business Analysis context
 *   parent_context_sa.md   — Solution Architecture context
 *   parent_context_vd.md   — Visual Design context
 *
 * If the ticket has no parent, or no relevant children exist, the function
 * silently skips without error.
 *
 * Called from: preCliDevelopmentSetup.js, preparePRForReview.js,
 *              preCliReworkSetup.js (MAPC project)
 */

var CONTEXT_TYPES = [
    { prefix: '[BA]', file: 'parent_context_ba.md', label: 'Business Analysis',
      description: 'Business Analysis defines the acceptance criteria (ACs), business rules, and user flows for the story. Use this as the authoritative source of truth for what must be implemented and tested.' },
    { prefix: '[SA]', file: 'parent_context_sa.md', label: 'Solution Architecture',
      description: 'Solution Architecture describes the technical design, data model, API contracts, and architectural decisions for the story. Follow this design when implementing.' },
    { prefix: '[VD]', file: 'parent_context_vd.md', label: 'Visual Design',
      description: 'Visual Design contains UI mockups, component specifications, and design notes. Use this to align the implementation with the expected look and feel.' }
];

/**
 * Main action: fetch parent context children and write to input folder.
 *
 * @param {Object} params - Standard pre-CLI params (inputFolderPath, ticket, jobParams)
 */
function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var folder = actualParams.inputFolderPath;
        var ticket = actualParams.ticket || (params.jobParams && params.jobParams.ticket);
        var ticketKey = folder ? folder.split('/').pop() : (ticket && ticket.key);

        if (!ticketKey) {
            console.warn('fetchParentContextToInput: cannot determine ticketKey — skipping');
            return;
        }

        // Resolve ticket object (may already be loaded by the caller)
        var ticketFields = null;
        if (ticket && ticket.fields) {
            ticketFields = ticket.fields;
        } else {
            try {
                var fetched = jira_get_ticket({ key: ticketKey });
                ticketFields = fetched && fetched.fields;
            } catch (e) {
                console.warn('fetchParentContextToInput: could not fetch ticket ' + ticketKey + ' — skipping', e);
                return;
            }
        }

        // Get parent key
        var parentKey = ticketFields && ticketFields.parent && ticketFields.parent.key;
        if (!parentKey) {
            console.log('fetchParentContextToInput: ticket ' + ticketKey + ' has no parent — skipping context enrichment');
            return;
        }

        console.log('fetchParentContextToInput: found parent ' + parentKey + ', searching for [BA]/[SA]/[VD] children...');

        // Search for sibling context tickets under the same parent
        var contextChildren = [];
        try {
            contextChildren = jira_search_by_jql({
                jql: 'parent = ' + parentKey + ' AND (summary ~ "\\[BA\\]" OR summary ~ "\\[SA\\]" OR summary ~ "\\[VD\\]") ORDER BY created ASC',
                fields: ['key', 'summary', 'description', 'status']
            }) || [];
        } catch (e) {
            console.warn('fetchParentContextToInput: JQL search failed — skipping', e);
            return;
        }

        console.log('fetchParentContextToInput: found ' + contextChildren.length + ' context children');
        if (contextChildren.length === 0) return;

        // Match each child to a context type and write file
        for (var i = 0; i < contextChildren.length; i++) {
            var child = contextChildren[i];
            var summary = (child.fields && child.fields.summary) || '';

            for (var j = 0; j < CONTEXT_TYPES.length; j++) {
                var ctx = CONTEXT_TYPES[j];
                if (summary.toUpperCase().indexOf(ctx.prefix.toUpperCase()) === -1) continue;

                // Fetch full ticket content
                var fullContent = child.fields && child.fields.description;
                if (!fullContent) {
                    try {
                        var full = jira_get_ticket({ key: child.key });
                        fullContent = full && full.fields && full.fields.description;
                    } catch (e) {
                        console.warn('fetchParentContextToInput: could not fetch full content for ' + child.key, e);
                    }
                }

                var md = '# ' + ctx.label + ' — ' + summary + '\n\n';
                md += '> **' + ctx.label + '** (' + child.key + '): ' + ctx.description + '\n\n';
                md += '**Ticket:** ' + child.key + '\n';
                md += '**Status:** ' + (child.fields && child.fields.status && child.fields.status.name || 'Unknown') + '\n\n';
                md += '---\n\n';
                md += (fullContent || '_No description provided._') + '\n';

                var filePath = folder + '/' + ctx.file;
                try {
                    file_write(filePath, md);
                    console.log('✅ fetchParentContextToInput: wrote ' + ctx.file + ' (' + child.key + ')');
                } catch (writeErr) {
                    console.warn('fetchParentContextToInput: failed to write ' + filePath, writeErr);
                }
                break; // matched, no need to check other prefixes
            }
        }

    } catch (error) {
        console.warn('fetchParentContextToInput: unexpected error (non-fatal):', error);
    }
}

module.exports = { action: action };
