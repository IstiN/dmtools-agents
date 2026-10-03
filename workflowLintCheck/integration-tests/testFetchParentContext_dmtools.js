/**
 * Integration test for fetchParentContextToInput.js via dmtools jsrunner.
 *
 * Uses REAL dmtools runtime globals (jira_get_ticket, file_write, etc.)
 * and REAL Jira API credentials from dmtools.env.
 *
 * Usage:
 *   dmtools run js/integration-tests/run_fetchParentContext_test.json
 *
 * Or with a different ticket:
 *   dmtools run js/integration-tests/run_fetchParentContext_test.json \
 *     --ticketKey TS-575
 */

var fetchParentContextToInput = require('js/fetchParentContextToInput.js');

function action(params) {
    var jobParams = params.jobParams || params;
    var ticketKey = jobParams.ticketKey || 'TS-1331';
    var inputFolder = jobParams.inputFolderPath || ('outputs/input/' + ticketKey);

    console.log('\n========================================');
    console.log('Integration Test: fetchParentContextToInput.js (dmtools jsrunner)');
    console.log('Ticket: ' + ticketKey);
    console.log('Input folder: ' + inputFolder);
    console.log('========================================\n');

    // 1. Fetch the ticket using real jira_get_ticket
    console.log('1. Fetching ticket ' + ticketKey + '...');
    var ticket = jira_get_ticket({ key: ticketKey, fields: ['summary','status','parent','issuetype','subtasks'] });
    if (!ticket || !ticket.fields) {
        console.error('ERROR: Could not fetch ticket ' + ticketKey);
        return false;
    }

    console.log('   Summary: ' + (ticket.fields.summary || 'N/A'));
    console.log('   Type: ' + (ticket.fields.issuetype && ticket.fields.issuetype.name || 'N/A'));
    console.log('   Status: ' + (ticket.fields.status && ticket.fields.status.name || 'N/A'));
    if (ticket.fields.parent) {
        console.log('   Parent: ' + ticket.fields.parent.key);
    }
    console.log('');

    // 2. Call the actual function under test
    console.log('2. Running fetchParentContextToInput.action()...\n');
    fetchParentContextToInput.action({
        inputFolderPath: inputFolder,
        ticket: ticket,
        jobParams: jobParams
    });

    // 3. Read back what was written using real file_read
    console.log('\n========================================');
    console.log('3. Generated files:');
    console.log('========================================\n');

    var files = ['parent-' + (ticket.fields.parent && ticket.fields.parent.key || 'UNKNOWN') + '.md',
                 'parent_context_ba.md',
                 'parent_context_sa.md',
                 'parent_context_vd.md'];

    var foundAny = false;
    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        var filePath = inputFolder + '/' + file;
        try {
            var content = file_read({ path: filePath });
            if (content && content.length > 0) {
                foundAny = true;
                console.log('   ✅ ' + file + ' (' + content.length + ' bytes)');
                // Preview first 20 lines
                var lines = content.split('\n').slice(0, 20);
                console.log('      --- preview ---');
                for (var j = 0; j < lines.length; j++) {
                    console.log('      ' + lines[j].substring(0, 120));
                }
                var allLines = content.split('\n');
                if (allLines.length > 20) {
                    console.log('      ... (' + (allLines.length - 20) + ' more lines)');
                }
                console.log('');
            }
        } catch (e) {
            // File doesn't exist — expected for contexts with no matching tickets
        }
    }

    if (!foundAny) {
        console.log('   (no files generated)');
    }

    console.log('========================================');
    console.log('Test complete. Check ' + inputFolder + ' for full output.');
    console.log('========================================');

    return true;
}
