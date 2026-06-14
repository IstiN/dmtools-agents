/**
 * Integration smoke test for prepareBulkBugsCreationContext against the TP project.
 *
 * This test runs the real preCliJSAction and verifies that every failed Test Case
 * returned from TP includes the `failedReason` field and `attachmentNames` list.
 * It does NOT create or modify any tickets — it only reads and writes local files.
 */

suite('TP bulk bugs Failed Reason integration', function() {

    test('fetches failed TP Test Cases with failedReason and attachmentNames', function() {
        var context = loadModule(
            'js/prepareBulkBugsCreationContext.js',
            makeRequire({
                './configLoader.js': configLoaderModule,
                './config.js': configModule
            })
        );

        var inputFolder = 'outputs/integration_tp_bulk_bugs_test';
        try {
            cli_execute_command({ command: 'mkdir -p ' + inputFolder });
        } catch (e) {
            console.warn('Could not create integration folder:', e);
        }

        console.log('Running prepareBulkBugsCreationContext against TP project...');

        context.action({
            inputFolderPath: inputFolder,
            jira: { project: 'TP' },
            customParams: {
                batchSize: 5,
                failedReasonField: 'Failed Reason',
                failedTCsJql: 'project = TP AND issuetype = "Test Case" AND status = Failed AND (labels is EMPTY OR labels NOT IN (sm_bug_creation_triggered)) ORDER BY created DESC'
            }
        });

        var raw = null;
        try {
            raw = file_read({ path: inputFolder + '/failed_tcs.json' });
        } catch (e) {
            console.log('No failed_tcs.json written — likely no eligible failed TCs in TP.');
        }

        var noTcs = null;
        try {
            noTcs = file_read({ path: inputFolder + '/no_failed_tcs.md' });
        } catch (e) {}

        if (!raw && noTcs) {
            console.log('ℹ️ Smoke test skipped: no failed TP Test Cases available.');
            return;
        }

        assert.ok(raw, 'Neither failed_tcs.json nor no_failed_tcs.md was produced');

        var failedTCs = JSON.parse(raw);
        console.log('Fetched', failedTCs.length, 'failed TP Test Case(s)');

        failedTCs.forEach(function(tc) {
            assert.ok(tc.hasOwnProperty('failedReason'), 'TC ' + tc.key + ' is missing failedReason field');
            assert.ok(tc.hasOwnProperty('attachmentNames'), 'TC ' + tc.key + ' is missing attachmentNames field');
            console.log('✅', tc.key, '| failedReason length:', (tc.failedReason || '').length, '| attachments:', tc.attachmentNames.length);
        });

        console.log('✅ TP Failed Reason integration smoke test passed');
    });

});
