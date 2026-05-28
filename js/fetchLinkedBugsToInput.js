/**
 * Fetch Linked Bugs To Input
 * Fetches linked bugs (with their comments) for the current ticket
 * and writes them to input/{KEY}/linked_bugs.md.
 *
 * Used by: preCliTestAutomationSetup.js (before CLI test automation runs)
 *
 * WHY: When a bug is fixed and the test re-runs, the test agent needs to know
 * HOW the bug was fixed (e.g., a heartbeat probe with a timing delay) so the
 * test properly accounts for implementation details like async delays.
 * Without this context, the test may assert too early and fail again,
 * creating a new bug → infinite loop.
 */

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var folder = actualParams.inputFolderPath;
        var ticketKey = folder.split('/').pop();

        console.log('Fetching linked bugs for', ticketKey, '...');

        var linkedBugs = [];
        try {
            linkedBugs = jira_search_by_jql({
                jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = Bug',
                fields: ['key', 'summary', 'status', 'description', 'Solution', 'labels'],
                maxResults: 10
            });
        } catch (e) {
            console.warn('Could not fetch linked bugs (skipping):', e);
            return;
        }

        if (!linkedBugs || linkedBugs.length === 0) {
            console.log('No linked bugs found for', ticketKey);
            return;
        }

        console.log('Found', linkedBugs.length, 'linked bug(s) — fetching details...');

        var lines = [];
        lines.push('# Linked Bugs\n');
        lines.push('> **CRITICAL FOR TEST IMPLEMENTATION**: These bugs are linked to this test case.');
        lines.push('> The test MUST account for any implementation details in the fix (timing delays, async behavior, retry intervals, etc.)');
        lines.push('> Read the Solution and AI Fix Comments carefully before writing or updating the test.\n');

        for (var i = 0; i < linkedBugs.length; i++) {
            var bug = linkedBugs[i];
            var f = bug.fields || {};
            var status = (f.status && f.status.name) || 'Unknown';

            lines.push('---\n');
            lines.push('## ' + bug.key + ': ' + (f.summary || '(no summary)'));
            lines.push('**Status**: ' + status + '\n');

            if (f.description) {
                lines.push('**Description**:\n' + f.description + '\n');
            }

            if (f.Solution) {
                lines.push('**Solution / Root Cause Analysis**:\n' + f.Solution + '\n');
            }

            // Fetch full ticket to get comments (especially the AI fix comment)
            try {
                var bugDetails = jira_get_ticket({ key: bug.key });
                var bugFields = bugDetails && bugDetails.fields || {};
                var commentBlock = bugFields.comment;
                var comments = commentBlock && commentBlock.comments || [];

                if (comments.length > 0) {
                    // Include up to last 5 comments (most recent fix attempts)
                    var startIdx = Math.max(0, comments.length - 5);
                    lines.push('**Comments (' + (comments.length - startIdx) + ' most recent)**:\n');
                    for (var j = startIdx; j < comments.length; j++) {
                        var c = comments[j];
                        var author = (c.author && c.author.displayName) || 'Unknown';
                        var body = (c.body || '').substring(0, 2000);
                        lines.push('**[' + author + ']**:');
                        lines.push(body);
                        lines.push('');
                    }
                }
            } catch (ce) {
                console.warn('Could not fetch comments for', bug.key, ':', ce);
            }
        }

        var content = lines.join('\n');

        try {
            file_write(folder + '/linked_bugs.md', content);
            console.log('✅ Written linked_bugs.md for', ticketKey, '(' + linkedBugs.length + ' bug(s))');
        } catch (we) {
            console.warn('Could not write linked_bugs.md:', we);
        }

    } catch (error) {
        console.error('Error in fetchLinkedBugsToInput:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
