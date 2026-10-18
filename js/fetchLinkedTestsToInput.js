/**
 * Fetch Linked Test Cases To Input
 * Fetches linked Test Case tickets (with their comments/failure details) for
 * the current bug ticket and writes them to input/{KEY}/linked_tests.md.
 *
 * Used by: preCliDevelopmentSetup.js (before CLI bug development agent runs)
 *
 * WHY: When a bug is created from a failing automated test, the bug fix agent
 * needs to understand the EXACT test assertions and what the test expects.
 * This prevents "already fixed" false-positives where the code change is
 * present but the test still fails because the fix doesn't match test assumptions.
 * It also surfaces prior fix attempts visible in the test case comments.
 */


// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
// Shared pure query/parse/markdown helpers (gh-1038) — no tracker/file side effects.
var linkedIssuesReport = require('./common/linkedIssuesReport.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}

function action(params) {
    try {
        var ctx = linkedIssuesReport.resolveInputContext(params);
        var folder = ctx.folder;
        var ticketKey = ctx.ticketKey;
        initTracker(null, (params.jobParams && params.jobParams.customParams) || ctx.actualParams.customParams || {});

        console.log('Fetching linked test cases for', ticketKey, '...');

        var linkedTests = [];
        try {
            // JQL text: provider-specific query (WIQL on ado)
            linkedTests = getTracker().searchIssues(linkedIssuesReport.buildLinkedQuery(ticketKey, 'issuetype = "Test Case"'), { maxResults: 10, fields: ['key', 'summary', 'status', 'description', 'labels'] });
        } catch (e) {
            console.warn('Could not fetch linked test cases (skipping):', e);
            return;
        }

        if (!linkedTests || linkedTests.length === 0) {
            console.log('No linked test cases found for', ticketKey);
            return;
        }

        console.log('Found', linkedTests.length, 'linked test case(s) — fetching details...');

        var lines = [];
        lines.push('# Linked Test Cases\n');
        lines.push('> **IMPORTANT**: These test cases are linked to this bug (they failed and triggered this bug report).');
        lines.push('> Read the test steps and failure comments carefully.');
        lines.push('> Your fix MUST make these tests pass — "already fixed" is only valid if the test can actually pass with the current code.\n');

        for (var i = 0; i < linkedTests.length; i++) {
            var tc = linkedTests[i];
            var f = tc.fields || {};
            var status = (f.status && f.status.name) || 'Unknown';

            lines.push('---\n');
            lines.push('## ' + tc.key + ': ' + (f.summary || '(no summary)'));
            lines.push('**Status**: ' + status + '\n');

            if (f.description) {
                lines.push('**Test Case Description**:\n' + f.description + '\n');
            }

            // Fetch full ticket to get comments (test run history, failure details, prior attempts)
            try {
                var tcDetails = getTracker().getIssue(tc.key);
                var tcFields = tcDetails && tcDetails.fields || {};
                var commentBlock = tcFields.comment;
                var comments = commentBlock && commentBlock.comments || [];

                if (comments.length > 0) {
                    // Include up to last 5 comments (most recent test run results)
                    lines = lines.concat(linkedIssuesReport.buildRecentCommentLines(comments, '**Test Run Comments'));
                }
            } catch (ce) {
                console.warn('Could not fetch comments for', tc.key, ':', ce);
            }
        }

        var content = lines.join('\n');

        try {
            file_write(folder + '/linked_tests.md', content);
            console.log('✅ Written linked_tests.md for', ticketKey, '(' + linkedTests.length + ' test(s))');
        } catch (we) {
            console.warn('Could not write linked_tests.md:', we);
        }

    } catch (error) {
        console.error('Error in fetchLinkedTestsToInput:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
