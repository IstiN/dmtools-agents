/**
 * Intake Pre-Action
 * 1. Checks for WIP label (returns false to stop processing if found)
 * 2. Fetches existing JD epics and writes them into the input folder
 *    (file_write creates parent dirs, so this runs before dmtools creates input/<KEY>/)
 */

function action(params) {
    try {
        var ticket = params.ticket;
        var metadata = params.metadata;
        var ticketKey = ticket.key;

        // --- WIP label check ---
        if (metadata && metadata.contextId) {
            var wipLabel = metadata.contextId + '_wip';
            var labels = ticket.fields && ticket.fields.labels ? ticket.fields.labels : [];

            if (labels.includes(wipLabel)) {
                console.log('Ticket ' + ticketKey + ' has WIP label "' + wipLabel + '" - skipping');
                try {
                    jira_post_comment({
                        key: ticketKey,
                        comment: 'h3. *Processing Skipped*\n\n' +
                            'This ticket has the *' + wipLabel + '* label indicating work is in progress.\n' +
                            'Processing will be skipped until the label is removed.\n\n' +
                            '_Remove the label to allow automated processing._'
                    });
                } catch (e) {
                    console.warn('Failed to post skip comment:', e);
                }
                return false;
            }
        } else {
            console.log('No contextId in metadata, skipping WIP check');
        }

        // --- Fetch existing JD epics into input folder ---
        // file_write creates parent directories automatically,
        // so this works even before dmtools creates input/<KEY>/
        var inputFolder = 'input/' + ticketKey;
        console.log('Fetching existing JD epics for ' + ticketKey + '...');

        try {
            var rawEpics = jira_search_by_jql({
                jql: 'project = JD AND issuetype = Epic ORDER BY created DESC',
                fields: ['key', 'summary', 'description', 'priority', 'diagrams', 'parent']
            });
            var epics = [];
            for (var i = 0; i < rawEpics.length; i++) {
                var issue = rawEpics[i];
                var f = issue.fields || {};
                epics.push({
                    key: issue.key || '',
                    summary: f.summary || '',
                    description: f.description || '',
                    priority: f.priority ? f.priority.name : '',
                    diagrams: f.diagrams || null,
                    parent: f.parent ? f.parent.key : null
                });
            }
            console.log('Found ' + epics.length + ' epics');
            file_write(inputFolder + '/existing_epics.json', '{"epics":' + JSON.stringify(epics, null, 2) + '}');
            console.log('Wrote existing_epics.json to ' + inputFolder);
        } catch (fetchError) {
            console.error('Failed to fetch epics, continuing without file:', fetchError);
        }

        try {
            var rawStories = jira_search_by_jql({
                jql: 'project = JD AND issuetype = Story ORDER BY created DESC',
                fields: ['key', 'summary', 'status', 'priority', 'diagrams', 'parent']
            });
            var stories = [];
            for (var j = 0; j < rawStories.length; j++) {
                var s = rawStories[j];
                var sf = s.fields || {};
                stories.push({
                    key: s.key || '',
                    summary: sf.summary || '',
                    status: sf.status ? sf.status.name : '',
                    priority: sf.priority ? sf.priority.name : '',
                    diagrams: sf.diagrams || null,
                    parent: sf.parent ? sf.parent.key : null
                });
            }
            console.log('Found ' + stories.length + ' stories');
            file_write(inputFolder + '/existing_stories.json', '{"stories":' + JSON.stringify(stories, null, 2) + '}');
            console.log('Wrote existing_stories.json to ' + inputFolder);
        } catch (fetchError) {
            console.error('Failed to fetch stories, continuing without file:', fetchError);
        }

        return true;

    } catch (error) {
        console.error('Error in intakePreAction:', error);
        return true; // don't block on unexpected error
    }
}
