/**
 * Prepare Bug Creation Context (preCliJSAction for bug_creation agent)
 *
 * Fetches all open bugs from the project and writes each one as a separate
 * markdown file in the input folder so the AI can detect duplicates.
 *
 * File format: Bug <KEY> - <Summary>.md
 * Content: bug description (or summary if description is empty)
 */

function sanitizeFilename(str) {
    return str.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').substring(0, 100).trim();
}

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;
        var ticketKey = inputFolder.split('/').pop();

        var customParams = actualParams.customParams || {};
        var openBugsJql = customParams.openBugsJql
            || 'project = ' + ticketKey.split('-')[0] + ' AND issuetype in (Bug) AND status not in (Done)';

        console.log('=== Preparing bug creation context for', ticketKey, '===');

        // Fetch TC ticket details for context
        var tcTicket = null;
        try {
            tcTicket = jira_get_ticket({ key: ticketKey });
        } catch (e) {
            console.warn('Could not fetch TC ticket:', e);
        }

        if (tcTicket) {
            var tcFields = tcTicket.fields || {};
            var tcContent = '# Test Case: ' + ticketKey + '\n\n';
            tcContent += '**Summary**: ' + (tcFields.summary || '') + '\n\n';
            if (tcFields.description) {
                tcContent += '**Description**:\n' + tcFields.description + '\n\n';
            }
            if (tcFields.parent) {
                tcContent += '**Parent Story**: ' + tcFields.parent.key + ' — ' + (tcFields.parent.fields && tcFields.parent.fields.summary || '') + '\n';
            }
            file_write(inputFolder + '/ticket.md', tcContent);
            console.log('Wrote ticket.md for', ticketKey);
        }

        // Fetch all open bugs
        console.log('Fetching open bugs with JQL:', openBugsJql);
        var bugs = [];
        try {
            bugs = jira_search_by_jql({
                jql: openBugsJql,
                fields: ['key', 'summary', 'description', 'status', 'priority'],
                maxResults: 200
            }) || [];
        } catch (e) {
            console.error('Failed to fetch open bugs:', e);
        }

        console.log('Found ' + bugs.length + ' open bug(s)');

        if (bugs.length === 0) {
            file_write(inputFolder + '/no_open_bugs.md', 'No open bugs found in the project. Create a new bug ticket.');
            console.log('No open bugs — wrote no_open_bugs.md');
        } else {
            bugs.forEach(function(bug) {
                try {
                    var key = bug.key;
                    var fields = bug.fields || {};
                    var summary = fields.summary || key;
                    var description = fields.description || summary;
                    var status = fields.status ? fields.status.name : '';
                    var priority = fields.priority ? fields.priority.name : '';

                    var content = '# ' + key + ': ' + summary + '\n\n';
                    if (status) content += '**Status**: ' + status + '\n';
                    if (priority) content += '**Priority**: ' + priority + '\n';
                    content += '\n## Description\n\n' + description;

                    var filename = 'Bug ' + key + ' - ' + sanitizeFilename(summary) + '.md';
                    file_write(inputFolder + '/' + filename, content);
                } catch (e) {
                    console.warn('Failed to write bug file for', bug.key, ':', e);
                }
            });
            console.log('Wrote ' + bugs.length + ' bug file(s) to', inputFolder);
        }

        // Post Jira comment
        try {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. 🔍 Bug Detection Started\n\n' +
                    'Checking ' + bugs.length + ' open bug(s) for duplicates...\n\n' +
                    '_Result will be posted shortly._'
            });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        return {
            success: true,
            ticketKey: ticketKey,
            bugsLoaded: bugs.length
        };

    } catch (error) {
        console.error('❌ Error in prepareBugCreationContext:', error);
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
