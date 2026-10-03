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

function fetchHistoricalDoneBugs(ticketKey) {
    try {
        return jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = Bug AND status in (Done) ORDER BY updated DESC',
            fields: ['key', 'summary', 'description', 'status', 'updated'],
            maxResults: 10
        }) || [];
    } catch (e) {
        console.warn('Could not fetch historical Done bugs:', e);
        return [];
    }
}

function writeHistoricalDoneBugs(inputFolder, ticketKey) {
    var doneBugs = fetchHistoricalDoneBugs(ticketKey);
    if (!doneBugs || doneBugs.length === 0) {
        return 0;
    }

    var lines = [];
    lines.push('# Historical Done Bugs');
    lines.push('');
    lines.push('These linked Done bugs are recurrence context only. Do not treat them as open duplicate matches.');
    lines.push('If the Test Case is currently Failed and no non-Done bug matches, create a new bug and mention these prior attempts.');
    lines.push('');

    doneBugs.forEach(function(bug) {
        var fields = bug.fields || {};
        var status = fields.status ? fields.status.name : '';
        lines.push('---');
        lines.push('## ' + bug.key + ': ' + (fields.summary || ''));
        if (status) lines.push('**Status**: ' + status);
        if (fields.updated) lines.push('**Updated**: ' + fields.updated);
        if (fields.description) {
            lines.push('');
            lines.push('**Description**:');
            lines.push(String(fields.description).substring(0, 1200));
        }
        lines.push('');
    });

    file_write(inputFolder + '/historical_done_bugs.md', lines.join('\n'));
    console.log('Wrote historical_done_bugs.md with ' + doneBugs.length + ' Done bug(s)');
    return doneBugs.length;
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

        var historicalDoneCount = writeHistoricalDoneBugs(inputFolder, ticketKey);

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
                    (historicalDoneCount > 0
                        ? 'Also loaded ' + historicalDoneCount + ' linked Done bug(s) as recurrence history only.\n\n'
                        : '') +
                    '_Result will be posted shortly._'
            });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        return {
            success: true,
            ticketKey: ticketKey,
            bugsLoaded: bugs.length,
            historicalDoneBugsLoaded: historicalDoneCount
        };

    } catch (error) {
        console.error('❌ Error in prepareBugCreationContext:', error);
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        fetchHistoricalDoneBugs: fetchHistoricalDoneBugs,
        writeHistoricalDoneBugs: writeHistoricalDoneBugs
    };
}
