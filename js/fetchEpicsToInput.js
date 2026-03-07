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
/**
 * Find a field value by partial key name (handles "Display Name (customfieldXXX)" keys).
 */
function findField(fields, nameSubstring) {
    for (var key in fields) {
        if (key.indexOf(nameSubstring) !== -1) {
            return fields[key];
        }
    }
    return null;
}

function action(params) {
    try {
        const folder = params.inputFolderPath;
        var ticketKey = folder ? folder.split('/').pop() : '';
        var project = ticketKey ? ticketKey.split('-')[0] : '';
        console.log('Fetching existing epics for project ' + project + '...');

        try {
            var rawEpics = jira_search_by_jql({
                jql: 'project = ' + project + ' AND issuetype = Epic ORDER BY created DESC',
                fields: ['key', 'summary', 'description', 'priority', 'parent']
            });
            var epics = [];
            for (var i = 0; i < rawEpics.length; i++) {
                try {
                    var issue = jira_get_ticket(rawEpics[i].key);
                    var f = issue.fields || {};
                    epics.push({
                        key: issue.key || '',
                        summary: f.summary || '',
                        description: f.description || '',
                        priority: f.priority ? f.priority.name : '',
                        diagrams: f['Diagrams (customfield_10296)'] || f.Diagrams || null,
                        parent: f.parent ? f.parent.key : null
                    });
                } catch (e) {
                    console.error('Failed to fetch epic ' + rawEpics[i].key + ':', e);
                }
            }
            console.log('Found ' + epics.length + ' epics');
            file_write(folder + '/existing_epics.json', '{"epics":' + JSON.stringify(epics, null, 2) + '}');
            console.log('Wrote existing_epics.json to ' + folder);
        } catch (fetchError) {
            console.error('Failed to fetch epics, continuing without file:', fetchError);
        }

        try {
            var rawStories = jira_search_by_jql({
                jql: 'project = ' + project + ' AND issuetype = Story ORDER BY created DESC',
                fields: ['key', 'summary', 'status', 'priority', 'parent']
            });
            var stories = [];
            for (var j = 0; j < rawStories.length; j++) {
                try {
                    var s = jira_get_ticket(rawStories[j].key);
                    var sf = s.fields || {};
                    stories.push({
                        key: s.key || '',
                        summary: sf.summary || '',
                        description: sf.description || '',
                        status: sf.status ? sf.status.name : '',
                        priority: sf.priority ? sf.priority.name : '',
                        diagrams: findField(sf, 'Diagrams') || null,
                        acceptanceCriterias: findField(sf, 'Acceptance Criterias') || null,
                        solution: findField(sf, 'Solution') || null,
                        parent: sf.parent ? sf.parent.key : null
                    });
                } catch (e) {
                    console.error('Failed to fetch story ' + rawStories[j].key + ':', e);
                }
            }
            console.log('Found ' + stories.length + ' stories');
            file_write(folder + '/existing_stories.json', '{"stories":' + JSON.stringify(stories, null, 2) + '}');
            console.log('Wrote existing_stories.json to ' + folder);
        } catch (fetchError) {
            console.error('Failed to fetch stories, continuing without file:', fetchError);
        }
    } catch (error) {
        console.error('Error in fetchEpicsToInput:', error);
    }
}
