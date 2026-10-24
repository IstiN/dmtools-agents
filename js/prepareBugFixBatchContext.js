/**
 * Pre-CLI Bug-fix Batch Context Action
 *
 * Runs before the bug_fix_batch_development CLI agent.
 * 1. Finds all bugs linked to the Epic that carry the bug_fix_batch label.
 * 2. Creates/fetches per-bug input folders (questions, linked tests, parent context).
 * 3. Writes a batch_bugs.md index in the Epic input folder describing the
 *    scope, file layout, and paths to the standard bug-fix instructions.
 * 4. Moves the Epic to In Development.
 */

var configLoader = require('./configLoader.js');
var fetchQuestionsToInput = require('./fetchQuestionsToInput.js');
var fetchLinkedTestsToInput = require('./fetchLinkedTestsToInput.js');
const { LABELS, STATUSES, resolveStatuses } = require('./config.js');
var trackersModule = require('./common/trackers.js');
var bugFixBatchCtx = require('./common/bugFixBatchContext.js');

function ensureInputFolder(bugFolder) {
    try {
        // file_write will create parent directories, but an explicit mkdir keeps
        // the action deterministic and easy to inspect in tests.
        bugFixBatchCtx.runCmd({ command: 'bash -c "mkdir -p ' + bugFolder + '"' });
    } catch (e) {
        console.warn('Could not create input folder ' + bugFolder + ' (non-fatal):', e);
    }
}

function fetchBugContext(bug, jobParams) {
    var bugKey = bug.key;
    var bugFolder = 'input/' + bugKey;
    ensureInputFolder(bugFolder);

    console.log('Fetching context for bug', bugKey, '...');

    var childParams = {
        inputFolderPath: bugFolder,
        jobParams: jobParams,
        ticket: bug
    };

    try {
        fetchQuestionsToInput.action(childParams);
    } catch (e) {
        console.warn('Failed to fetch questions for ' + bugKey + ' (non-fatal):', e);
    }

    try {
        fetchLinkedTestsToInput.action(childParams);
    } catch (e) {
        console.warn('Failed to fetch linked tests for ' + bugKey + ' (non-fatal):', e);
    }
}

function _loadBatchConfig() {
    return configLoader.loadProjectConfig({});
}

function _resolveBatchTracker(tracker, config) {
    if (tracker) return tracker;
    return trackersModule.createTracker(config || _loadBatchConfig(), {});
}

function findBugsInEpic(epicKey, tracker, config) {
    tracker = _resolveBatchTracker(tracker, config);
    var jqlParts = [
        'issue in linkedIssues("' + epicKey + '")',
        'AND issuetype = Bug',
        'AND labels = ' + LABELS.BUG_FIX_BATCH
    ];
    var jql = jqlParts.join(' ');
    console.log('Searching batch bugs with JQL:', jql);

    var results = [];
    try {
        // JQL text: provider-specific query (WIQL on ado)
        results = tracker.searchIssues(jql, {
            fields: ['key', 'summary', 'status', 'description', 'labels', 'issuetype']
        }) || [];
    } catch (e) {
        console.warn('Failed to search bugs for Epic ' + epicKey + ':', e);
    }

    return results.filter(function(issue) {
        var typeName = '';
        try {
            typeName = issue.fields.issuetype.name;
        } catch (e) {
            typeName = '';
        }
        return typeName === 'Bug';
    });
}

function renderBugList(bugs) {
    if (!bugs || bugs.length === 0) {
        return '_No bug-fix batch bugs found for this Epic._\n';
    }

    var lines = [];
    for (var i = 0; i < bugs.length; i++) {
        var bug = bugs[i];
        var f = bug.fields || {};
        var status = (f.status && f.status.name) || 'Unknown';
        lines.push((i + 1) + '. **' + bug.key + '** — ' + (f.summary || '(no summary)') + '  ');
        lines.push('   - Status: ' + status);
        lines.push('   - Input folder: `input/' + bug.key + '/`');
        lines.push('   - Bug instructions: apply `agents/instructions/bug_fix_development/` to this bug');
        lines.push('');
    }
    return lines.join('\n');
}

function writeBatchBugsMarkdown(epicFolder, epic, bugs) {
    var epicFields = epic.fields || {};
    var summary = epicFields.summary || '';
    var description = epicFields.description || '';

    var lines = [];
    lines.push('# Bug-fix Batch — ' + epic.key);
    lines.push('');
    lines.push('## Epic');
    lines.push('');
    lines.push('- **Key:** ' + epic.key);
    lines.push('- **Summary:** ' + summary);
    lines.push('- **Status:** ' + ((epicFields.status && epicFields.status.name) || 'Unknown'));
    lines.push('');
    if (description) {
        lines.push('### Epic Description');
        lines.push('');
        lines.push(description);
        lines.push('');
    }

    lines.push('## Linked Bugs (' + bugs.length + ')');
    lines.push('');
    lines.push('The following bugs are grouped into this batch. Fix all of them in a');
    lines.push('single branch/PR. For each bug, read its dedicated input folder and apply');
    lines.push('the standard bug-fix development instructions.');
    lines.push('');
    lines.push(renderBugList(bugs));

    lines.push('## Input Layout');
    lines.push('');
    lines.push('- This file: `' + epicFolder + '/batch_bugs.md`');
    lines.push('- Per-bug context: `input/<BUG-KEY>/`');
    lines.push('  - `existing_questions.json` — answered clarification questions');
    lines.push('  - `linked_tests.md` — failing test cases that triggered the bug');
    lines.push('  - `parent-<PARENT>.md` / `parent_context_*.md` — BA/SA/VD context');
    lines.push('- Shared bug-fix instructions: `agents/instructions/bug_fix_development/`');
    lines.push('- Batch scope / Epic-level instructions: `agents/instructions/bug_fix_batch_development/batch_scope.md`');
    lines.push('');

    lines.push('## Workflow Reminder');
    lines.push('');
    lines.push('1. Read this file first.');
    lines.push('2. For each bug, read `input/<BUG-KEY>/` context and follow');
    lines.push('   `agents/instructions/bug_fix_development/scope.md`.');
    lines.push('3. Implement all fixes in the same branch.');
    lines.push('4. Create **one** PR for the Epic; link it to the Epic.');
    lines.push('5. Move the Epic and every linked bug to **In Review** and add `ai_developed`.');
    lines.push('');

    var content = lines.join('\n');
    file_write(epicFolder + '/batch_bugs.md', content);
    console.log('Wrote batch_bugs.md for', epic.key, '(' + bugs.length + ' bug(s))');
}

// ── Extracted action-step helpers (gh-1228 CRAP split): each step keeps the
// exact non-fatal guard of the inline code it replaced.

/** Pre-CLI params carry the input folder at the top level; jobs nest them under jobParams. */
function resolveBatchParams(params) {
    return bugFixBatchCtx.resolveBatchParams(params);
}

/** Re-fetch the epic when the ticket payload carries no fields; a failed fetch degrades to key-only. */
function resolveBatchEpic(tracker, epicKey, epic) {
    return bugFixBatchCtx.resolveBatchEpic(tracker, epicKey, epic);
}

/** Fetch per-bug input folders for every batch bug (questions + linked tests). */
function fetchBatchBugContexts(bugs, jobParams) {
    for (var i = 0; i < bugs.length; i++) {
        fetchBugContext(bugs[i], jobParams);
    }
}

/** Move the epic to In Development; a failed transition is logged, not fatal. */
function moveEpicToInDevelopment(tracker, epicKey, statuses) {
    try {
        tracker.moveToStatus(epicKey, statuses.IN_DEVELOPMENT);
        console.log('Moved Epic ' + epicKey + ' to ' + statuses.IN_DEVELOPMENT);
    } catch (e) {
        console.warn('Failed to move Epic to In Development (non-fatal):', e);
    }
}

function action(params) {
    try {
        var ctx = bugFixBatchCtx.resolveBatchActionContext(params);

        var customParams = ctx.actualParams.customParams || {};
        var statuses = resolveStatuses(customParams);

        var bugs = findBugsInEpic(ctx.epicKey, ctx.tracker);
        console.log('Found', bugs.length, 'bug(s) in batch Epic', ctx.epicKey);

        fetchBatchBugContexts(bugs, ctx.actualParams.jobParams || ctx.actualParams);

        writeBatchBugsMarkdown(ctx.epicFolder, ctx.epic, bugs);

        moveEpicToInDevelopment(ctx.tracker, ctx.epicKey, statuses);

    } catch (error) {
        console.error('Error in prepareBugFixBatchContext:', error);
        throw error;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, findBugsInEpic, writeBatchBugsMarkdown, resolveBatchParams, resolveBatchEpic, fetchBatchBugContexts, moveEpicToInDevelopment };
}
