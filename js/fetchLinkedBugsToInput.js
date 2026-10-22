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

var trackersModule = require('./common/trackers.js');
// Shared pure query/parse/markdown helpers (gh-1038) — no tracker/file side effects.
var linkedIssuesReport = require('./common/linkedIssuesReport.js');
var configLoader = null;
try { configLoader = require('./configLoader.js'); } catch (e) {}

function fetchLinkedBugs(tracker, ticketKey) {
    try {
        var query = linkedIssuesReport.buildLinkedQuery(ticketKey, 'issuetype = Bug AND status not in (Done)', tracker.provider(), { issueType: 'Bug', statusNotIn: ['Done'] });
        return tracker.searchIssues(query, {
            fields: ['key', 'summary', 'status', 'description', 'Solution', 'labels'],
            maxResults: 10
        });
    } catch (e) {
        console.warn('Could not fetch linked bugs (skipping):', e);
        return null;
    }
}

function appendBugComments(tracker, bugKey, lines) {
    try {
        var bugDetails = tracker.getIssue(bugKey);
        var bugFields = (bugDetails && bugDetails.fields) || {};
        var comments = (bugFields.comment && bugFields.comment.comments) || [];
        if (comments.length > 0) {
            return lines.concat(linkedIssuesReport.buildRecentCommentLines(comments, '**Comments'));
        }
    } catch (ce) {
        console.warn('Could not fetch comments for', bugKey, ':', ce);
    }
    return lines;
}

function buildBugBlockLines(tracker, bug) {
    var f = bug.fields || {};
    var status = (f.status && f.status.name) || 'Unknown';
    var lines = [
        '---\n',
        '## ' + bug.key + ': ' + (f.summary || '(no summary)'),
        '**Status**: ' + status + '\n'
    ];
    if (f.description) {
        lines.push('**Description**:\n' + f.description + '\n');
    }
    if (f.Solution) {
        lines.push('**Solution / Root Cause Analysis**:\n' + f.Solution + '\n');
    }
    return appendBugComments(tracker, bug.key, lines);
}

function writeLinkedBugsFile(tracker, folder, ticketKey, linkedBugs) {
    var lines = [
        '# Linked Bugs\n',
        '> **CRITICAL FOR TEST IMPLEMENTATION**: These bugs are linked to this test case.',
        '> The test MUST account for any implementation details in the fix (timing delays, async behavior, retry intervals, etc.)',
        '> Read the Solution and AI Fix Comments carefully before writing or updating the test.\n'
    ];
    for (var i = 0; i < linkedBugs.length; i++) {
        lines = lines.concat(buildBugBlockLines(tracker, linkedBugs[i]));
    }
    try {
        file_write(folder + '/linked_bugs.md', lines.join('\n'));
        console.log('✅ Written linked_bugs.md for', ticketKey, '(' + linkedBugs.length + ' bug(s))');
    } catch (we) {
        console.warn('Could not write linked_bugs.md:', we);
    }
}

function action(params) {
    try {
        var ctx = linkedIssuesReport.resolveInputContext(params);
        var projectConfig = null;
        try { projectConfig = configLoader ? configLoader.loadProjectConfig(params.jobParams || ctx.actualParams) : null; } catch (e) {}
        var tracker = trackersModule.createTracker(projectConfig, ctx.actualParams.customParams || (params.jobParams && params.jobParams.customParams) || {});

        console.log('Fetching linked bugs for', ctx.ticketKey, '...');
        var linkedBugs = fetchLinkedBugs(tracker, ctx.ticketKey);
        if (!linkedBugs || linkedBugs.length === 0) {
            if (linkedBugs) console.log('No linked bugs found for', ctx.ticketKey);
            return;
        }

        console.log('Found', linkedBugs.length, 'linked bug(s) — fetching details...');
        writeLinkedBugsFile(tracker, ctx.folder, ctx.ticketKey, linkedBugs);
    } catch (error) {
        console.error('Error in fetchLinkedBugsToInput:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
