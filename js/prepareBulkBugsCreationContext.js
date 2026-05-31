/**
 * Prepare Bulk Bugs Creation Context (preCliJSAction for bulk_bugs_creation agent)
 *
 * Fetches all failed Test Cases (without sm_bug_creation_triggered label) and
 * all non-Done bugs, then writes them to input files for the AI to process in batch.
 *
 * Writes:
 *   input/failed_tcs.json  — array of failed TC objects
 *   input/open_bugs.json   — array of non-Done bug objects
 *   input/context.md       — summary for the AI
 *
 * The SM passes one ticket as the "trigger" but this action ignores it and
 * fetches ALL eligible failed TCs up to batchSize.
 */

function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var inputFolder = actualParams.inputFolderPath;

        var customParams = actualParams.customParams || {};
        var projectKey = (actualParams.jira && actualParams.jira.project)
            || (params.ticket && params.ticket.key && params.ticket.key.split('-')[0])
            || 'TS';
        var batchSize = customParams.batchSize || 50;

        var openBugsJql = (customParams.openBugsJql || 'project = {jiraProject} AND issuetype in (Bug) AND status not in (Done)')
            .replace('{jiraProject}', projectKey);

        var failedTCsJql = (customParams.failedTCsJql ||
            'project = {jiraProject} AND issuetype = "Test Case" AND status = Failed AND (labels is EMPTY OR labels NOT IN (sm_bug_creation_triggered)) ORDER BY created ASC')
            .replace('{jiraProject}', projectKey);

        console.log('=== Preparing bulk bugs creation context ===');
        console.log('Project:', projectKey, '| batchSize:', batchSize);

        // Fetch failed TCs
        console.log('Fetching failed TCs with JQL:', failedTCsJql);
        var failedTCs = [];
        try {
            var tcResults = jira_search_by_jql({
                jql: failedTCsJql,
                fields: ['key', 'summary', 'description', 'comment', 'status', 'labels', 'parent'],
                maxResults: batchSize
            });
            failedTCs = tcResults || [];
        } catch (e) {
            console.error('Failed to fetch failed TCs:', e);
        }

        console.log('Found ' + failedTCs.length + ' failed TC(s) to process');

        if (failedTCs.length === 0) {
            file_write(inputFolder + '/no_failed_tcs.md', 'No failed Test Cases to process. Exiting.');
            console.log('No failed TCs — wrote no_failed_tcs.md');
            return;
        }

        // Build TC list for AI
        var tcList = failedTCs.map(function(tc) {
            var fields = tc.fields || {};
            var comments = fields.comment && fields.comment.comments;
            var lastComment = comments && comments.length > 0
                ? comments[comments.length - 1].body
                : '';
            return {
                key: tc.key,
                summary: fields.summary || '',
                description: fields.description || '',
                lastComment: lastComment,
                parent: fields.parent ? fields.parent.key + ' — ' + (fields.parent.fields && fields.parent.fields.summary || '') : ''
            };
        });

        file_write(inputFolder + '/failed_tcs.json', JSON.stringify(tcList, null, 2));
        console.log('Wrote input/failed_tcs.json with ' + tcList.length + ' TCs');

        // Fetch non-Done bugs
        console.log('Fetching non-Done bugs with JQL:', openBugsJql);
        var bugs = [];
        try {
            var bugResults = jira_search_by_jql({
                jql: openBugsJql,
                fields: ['key', 'summary', 'description', 'status', 'priority'],
                maxResults: 300
            });
            bugs = bugResults || [];
        } catch (e) {
            console.error('Failed to fetch open bugs:', e);
        }

        console.log('Found ' + bugs.length + ' non-Done bug(s)');

        var bugList = bugs.map(function(bug) {
            var fields = bug.fields || {};
            return {
                key: bug.key,
                summary: fields.summary || '',
                description: (fields.description || '').substring(0, 500),
                status: fields.status ? fields.status.name : '',
                priority: fields.priority ? fields.priority.name : ''
            };
        });

        if (bugList.length === 0) {
            file_write(inputFolder + '/open_bugs.json', '[]');
            console.log('No non-Done bugs found — wrote empty open_bugs.json');
        } else {
            file_write(inputFolder + '/open_bugs.json', JSON.stringify(bugList, null, 2));
            console.log('Wrote input/open_bugs.json with ' + bugList.length + ' bugs');
        }

        // Write context summary for the AI
        var contextMd = '# Bulk Bug Creation Context\n\n' +
            '- **Project**: ' + projectKey + '\n' +
            '- **Failed TCs to process**: ' + tcList.length + '\n' +
            '- **Non-Done bugs for dedup check**: ' + bugList.length + '\n\n' +
            'Read `input/failed_tcs.json` and `input/open_bugs.json`, then follow the prompt instructions.\n';
        file_write(inputFolder + '/context.md', contextMd);
        console.log('=== Context preparation complete ===');

    } catch (e) {
        console.error('prepareBulkBugsCreationContext failed:', e);
        throw e;
    }
}
