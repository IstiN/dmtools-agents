/**
 * Fetch Epics To Input Pre-CLI Action
 * Fetches existing epics and writes them to the input folder before CLI agent runs.
 * Receives params.inputFolderPath from DMTools after input folder creation.
 */

/**
 * Pre-CLI action: fetch existing epics into input folder
 *
 * @param {Object} params - Parameters from DMTools
 * @param {string} params.inputFolderPath - Path to the input folder for this run
 */
function action(params) {
    try {
        const folder = params.inputFolderPath;
        var ticketKey = folder ? folder.split('/').pop() : '';
        var project = ticketKey ? ticketKey.split('-')[0] : '';
        console.log('Fetching existing epics for project ' + project + '...');

        try {
            var rawEpics = jira_search_by_jql({
                jql: 'project = ' + project + ' AND issuetype = Epic ORDER BY created DESC',
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
            // Wrap in object: file_write bridge auto-parses strings starting with '[' as ArrayList.
            file_write(folder + '/existing_epics.json', '{"epics":' + JSON.stringify(epics, null, 2) + '}');
            console.log('Wrote existing_epics.json to ' + folder);
        } catch (fetchError) {
            console.error('Failed to fetch epics, continuing without file:', fetchError);
        }

        try {
            var rawStories = jira_search_by_jql({
                jql: 'project = ' + project + ' AND issuetype = Story ORDER BY created DESC',
                fields: ['key', 'summary', 'description', 'status', 'priority', 'diagrams', 'parent', 'Acceptance Criterias', 'Solution', 'Diagrams']
            });
            var stories = [];
            for (var j = 0; j < rawStories.length; j++) {
                var s = rawStories[j];
                var sf = s.fields || {};
                stories.push({
                    key: s.key || '',
                    summary: sf.summary || '',
                    description: sf.description || '',
                    status: sf.status ? sf.status.name : '',
                    priority: sf.priority ? sf.priority.name : '',
                    diagrams: sf['Diagrams'] || sf.diagrams || null,
                    acceptanceCriterias: sf['Acceptance Criterias'] || null,
                    solution: sf['Solution'] || null,
                    parent: sf.parent ? sf.parent.key : null
                });
            }
            console.log('Found ' + stories.length + ' stories');
            // Wrap in object: same bridge reason as epics.
            file_write(folder + '/existing_stories.json', '{"stories":' + JSON.stringify(stories, null, 2) + '}');
            console.log('Wrote existing_stories.json to ' + folder);
        } catch (fetchError) {
            console.error('Failed to fetch stories, continuing without file:', fetchError);
        }
    } catch (error) {
        console.error('Error in fetchEpicsToInput:', error);
    }
}
