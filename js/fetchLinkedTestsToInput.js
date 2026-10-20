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

function fetchLinkedTests(ticketKey) {
    try {
        var query = linkedIssuesReport.buildLinkedQuery(ticketKey, 'issuetype = "Test Case"', getTracker().provider(), { issueType: 'Test Case' });
        return getTracker().searchIssues(query, { maxResults: 10, fields: ['key', 'summary', 'status', 'description', 'labels'] });
    } catch (e) {
        console.warn('Could not fetch linked test cases (skipping):', e);
        return null;
    }
}

function appendTestComments(tcKey, lines) {
    try {
        var tcDetails = getTracker().getIssue(tcKey);
        var tcFields = (tcDetails && tcDetails.fields) || {};
        var comments = (tcFields.comment && tcFields.comment.comments) || [];
        if (comments.length > 0) {
            return lines.concat(linkedIssuesReport.buildRecentCommentLines(comments, '**Test Run Comments'));
        }
    } catch (ce) {
        console.warn('Could not fetch comments for', tcKey, ':', ce);
    }
    return lines;
}

function buildTestBlockLines(tc) {
    var f = tc.fields || {};
    var status = (f.status && f.status.name) || 'Unknown';
    var lines = [
        '---\n',
        '## ' + tc.key + ': ' + (f.summary || '(no summary)'),
        '**Status**: ' + status + '\n'
    ];
    if (f.description) {
        lines.push('**Test Case Description**:\n' + f.description + '\n');
    }
    return appendTestComments(tc.key, lines);
}

function writeLinkedTestsFile(folder, ticketKey, linkedTests) {
    var lines = [
        '# Linked Test Cases\n',
        '> **IMPORTANT**: These test cases are linked to this bug (they failed and triggered this bug report).',
        '> Read the test steps and failure comments carefully.',
        '> Your fix MUST make these tests pass — "already fixed" is only valid if the test can actually pass with the current code.\n'
    ];
    for (var i = 0; i < linkedTests.length; i++) {
        lines = lines.concat(buildTestBlockLines(linkedTests[i]));
    }
    try {
        file_write(folder + '/linked_tests.md', lines.join('\n'));
        console.log('✅ Written linked_tests.md for', ticketKey, '(' + linkedTests.length + ' test(s))');
    } catch (we) {
        console.warn('Could not write linked_tests.md:', we);
    }
}

function action(params) {
    try {
        var ctx = linkedIssuesReport.resolveInputContext(params);
        initTracker(null, (params.jobParams && params.jobParams.customParams) || ctx.actualParams.customParams || {});

        console.log('Fetching linked test cases for', ctx.ticketKey, '...');
        var linkedTests = fetchLinkedTests(ctx.ticketKey);
        if (!linkedTests || linkedTests.length === 0) {
            if (linkedTests) console.log('No linked test cases found for', ctx.ticketKey);
            return;
        }

        console.log('Found', linkedTests.length, 'linked test case(s) — fetching details...');
        writeLinkedTestsFile(ctx.folder, ctx.ticketKey, linkedTests);
    } catch (error) {
        console.error('Error in fetchLinkedTestsToInput:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
