/**
 * Fetch Questions To Input Pre-CLI Action
 * Fetches existing question subtasks for the current story ticket and writes
 * them to the input folder before the CLI agent runs.
 * Receives params.inputFolderPath from DMTools after input folder creation.
 */

/**
 * Pre-CLI action: fetch question subtasks into input folder
 *
 * @param {Object} params - Parameters from DMTools
 * @param {string} params.inputFolderPath - Path to the input folder for this run
 */
function action(params) {
    try {
        var folder = params.inputFolderPath;
        // Ticket key is always the last segment of the input folder path.
        var ticketKey = folder.split('/').pop();
        console.log('Fetching question subtasks for ' + ticketKey + '...');

        try {
            var rawQuestions = jira_search_by_jql({
                jql: 'parent = ' + ticketKey + ' AND issuetype = Subtask ORDER BY created ASC',
                fields: ['key', 'summary', 'description', 'status', 'priority', 'Answer']
            });
            var questions = [];
            for (var i = 0; i < rawQuestions.length; i++) {
                var issue = rawQuestions[i];
                var f = issue.fields || {};
                console.log('f: ' + f);
                console.log('f s : ' + JSON.stringify(f, null, 2));
                questions.push({
                    key: issue.key || '',
                    summary: f.summary || '',
                    description: f.description || '',
                    status: f.status ? f.status.name : '',
                    priority: f.priority ? f.priority.name : '',
                    answer: f.Answer || f.answer || null
                });
            }
            console.log('Found ' + questions.length + ' question subtasks');
            // Wrap in object: file_write bridge auto-parses strings starting with '[' as ArrayList.
            file_write(folder + '/existing_questions.json', '{"questions":' + JSON.stringify(questions, null, 2) + '}');
            console.log('Wrote existing_questions.json to ' + folder);
        } catch (fetchError) {
            console.error('Failed to fetch questions, continuing without file:', fetchError);
        }
    } catch (error) {
        console.error('Error in fetchQuestionsToInput:', error);
    }
}
