/**
 * Post Story Test Automation Results Action
 * 1. Reads outputs/story_test_automation_result.json
 * 2. Commits/pushes testing/ folder on test/{STORY_KEY} branch
 * 3. Creates PR to main
 * 4. Per linked Test Case:
 *    - status → In Review - Passed / In Review - Failed
 *    - failed TC: attach outputs/failed_description_{TC_KEY}.md and set Failed Reason field
 * 5. Moves Story → In Testing
 * 6. Triggers pr_story_test_automation_review
 *
 * gh-1008 CRAP split: tracker/git/marker/wiki helpers live in
 * js/postStoryTestAutomationShared.js; action() is a thin orchestrator.
 * gh-1080 CRAP split: the remaining action() phases (context build, result
 * validation, branch publish, finalization) are top-level step helpers —
 * tracker/git/file calls and their order are unchanged.
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var autoStart = require('./common/autoStart.js');
const { GIT_CONFIG, LABELS, JIRA_FIELDS } = require('./config.js');
var outputFiles = require('./common/outputFiles.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');
var shared = require('./postStoryTestAutomationShared.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = shared.createTrackerHolder(trackersModule);
function initTracker(config, customParams) {
    trackerHolder.initTracker(config, customParams);
}
function getTracker() {
    return trackerHolder.getTracker();
}

var gitOps = shared.createGitOps(prHelper);
var runInRepo = shared.runInRepo;

var RESUME_MARKER = 'outputs/.story-test-resume-attempted';

function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function readFile(path) {
    return outputFiles.readOutputFile(path, {});
}

function readOutputFile(relativePath, workingDir, ticketKey) {
    return outputFiles.readOutputFile(relativePath, {
        workingDir: workingDir,
        ticketKey: ticketKey
    });
}

function readResultJson(workingDir, storyKey) {
    try {
        const raw = readOutputFile('story_test_automation_result.json', workingDir, storyKey);
        if (!raw) {
            console.warn('outputs/story_test_automation_result.json is empty or missing');
            return null;
        }
        const rawString = String(raw);
        try {
            const parsed = JSON.parse(rawString);
            console.log('Story test result overall:', parsed.overall);
            return parsed;
        } catch (parseErr) {
            console.error('Failed to parse story_test_automation_result.json:', parseErr);
            console.error('Raw content preview (first 1000 chars):', rawString.substring(0, 1000));
            console.error('Raw content preview around error:', rawString.substring(Math.max(0, parseErr.pos - 100), parseErr.pos + 100));
            return null;
        }
    } catch (e) {
        console.error('Failed to read story_test_automation_result.json:', e);
        return null;
    }
}

function readLinkedTestCases(storyKey, testCaseType) {
    try {
        var raw = readFile('input/' + storyKey + '/linked_test_cases.json');
        if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.testCases)) {
                console.log('Loaded', parsed.testCases.length, 'linked Test Case(s) from input folder');
                return parsed.testCases;
            }
        }
    } catch (e) {
        console.warn('Could not read linked_test_cases.json, falling back to JQL:', e);
    }

    try {
        var jql = 'issue in linkedIssues("' + storyKey + '") AND issuetype = "' + testCaseType + '"';
        // JQL text: provider-specific query (WIQL on ado)
        var results = getTracker().searchIssues(jql, { maxResults: 100, fields: ['key'] });
        return Array.isArray(results) ? results : [];
    } catch (e) {
        console.warn('Failed to fetch linked Test Cases from Jira:', e);
        return [];
    }
}

function getMissingTestCaseKeys(result, linkedTestCases) {
    var resultKeys = {};
    if (result && Array.isArray(result.results)) {
        result.results.forEach(function(r) {
            if (r.testCaseKey) resultKeys[r.testCaseKey] = true;
        });
    }
    return linkedTestCases
        .map(function(tc) { return tc.key; })
        .filter(function(key) { return key && !resultKeys[key]; });
}

function buildResumePrompt(storyKey, linkedTestCases, result, missingKeys) {
    var checkedKeys = [];
    if (result && Array.isArray(result.results)) {
        checkedKeys = result.results.map(function(r) { return r.testCaseKey; }).filter(Boolean);
    }

    var resultSchema = JSON.stringify({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "required": ["storyKey", "overall", "summary", "results"],
        "properties": {
            "storyKey": { "type": "string", "const": storyKey },
            "overall": { "type": "string", "enum": ["passed", "failed", "in_progress"] },
            "summary": { "type": "string" },
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["testCaseKey", "status"],
                    "properties": {
                        "testCaseKey": { "type": "string", "pattern": "^TS-[0-9]+$" },
                        "status": { "type": "string", "enum": ["passed", "failed", "skipped", "irrelevant"] },
                        "testPath": { "type": "string" },
                        "failedDescriptionFile": { "type": "string" },
                        "failureSummary": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            }
        },
        "additionalProperties": false
    }, null, 2);

    return 'RESUME TASK: The previous story test automation run did not verify all linked Test Cases.\n\n' +
        'Story: ' + storyKey + '\n' +
        'Linked Test Cases (' + linkedTestCases.length + '): ' + linkedTestCases.map(function(tc) { return tc.key; }).join(', ') + '\n' +
        'Already checked (' + checkedKeys.length + '): ' + (checkedKeys.join(', ') || 'none') + '\n' +
        'Still missing (' + missingKeys.length + '): ' + missingKeys.join(', ') + '\n\n' +
        'Instructions:\n' +
        '- Continue the same story test automation task in the same repository.\n' +
        '- For every missing Test Case, run/verify the corresponding automated test.\n' +
        '- Create or update outputs/story_test_automation_result.json with a top-level object that matches the JSON Schema below.\n' +
        '- Append a result entry for each missing Test Case:\n' +
        '  { "testCaseKey": "TS-XXX", "status": "passed" | "failed" | "skipped" | "irrelevant", "testPath": "testing/tests/TS-XXX/...", "failedDescriptionFile": "outputs/failed_description_TS-XXX.md", "failureSummary": "..." }\n' +
        '- If the result JSON file is missing, create it from scratch using the existing outputs/response.md and testing/tests/ files as evidence.\n' +
        '- If a test fails, write a failed description file and reference it in the result entry.\n' +
        '- Do NOT push changes; the post-action will commit and push after you finish.\n' +
        '- Do NOT move the Story to another status.\n' +
        '- Update outputs/response.md with a short summary of what was verified.\n' +
        '- Validate that outputs/story_test_automation_result.json is parseable JSON that conforms to the schema before stopping.\n\n' +
        'Required JSON schema for outputs/story_test_automation_result.json:\n' + resultSchema + '\n';
}

function attemptResumeIfOutputsIncomplete(storyKey, result, linkedTestCases, workingDir) {
    var missingKeys = getMissingTestCaseKeys(result, linkedTestCases);
    if (missingKeys.length === 0) {
        return { attempted: false, reason: 'complete' };
    }

    var attempt = shared.readAttemptMarker(RESUME_MARKER);
    var maxAttempts = 2;
    if (attempt >= maxAttempts) {
        console.warn('Story test resume attempts exhausted (' + attempt + '/' + maxAttempts + '). Missing TCs:', missingKeys.join(', '));
        return { attempted: false, reason: 'attempts-exhausted', missingKeys: missingKeys };
    }

    attempt += 1;
    shared.writeAttemptMarker(RESUME_MARKER, attempt);

    var prompt = buildResumePrompt(storyKey, linkedTestCases, result, missingKeys);

    var promptPath = 'outputs/.story-test-resume-prompt.md';
    try {
        file_write({ path: promptPath, content: prompt });
    } catch (e) {
        console.error('Failed to write story test resume prompt:', e);
        return { attempted: false, reason: 'write-failed', missingKeys: missingKeys };
    }

    // `--continue` alone resumes the most recent session in this directory; pairing it
    // with `--resume` is rejected by the Copilot CLI as mutually exclusive, which made
    // this recovery run fail deterministically before ever reaching the agent.
    var command = 'bash agents/scripts/run-agent.sh --continue ' + promptPath;
    console.log('Story test output incomplete — resuming agent for missing TCs (attempt ' + attempt + '/' + maxAttempts + '):', missingKeys.join(', '));
    try {
        var output = runInRepo(command, workingDir);
        console.log('Resume run output:', String(output || '').substring(0, 500));
    } catch (e) {
        console.warn('Story test resume run failed:', e);
    }

    return { attempted: true, attempt: attempt, missingKeys: missingKeys };
}

function readJiraComment(params, workingDir, storyKey) {
    var jiraComment = readOutputFile('tracker_comment.md', workingDir, storyKey);
    if (jiraComment) return jiraComment;

    jiraComment = readOutputFile('comment.md', workingDir, storyKey);
    if (jiraComment) return jiraComment;

    jiraComment = readOutputFile('jira_comment.md', workingDir, storyKey);
    if (jiraComment) return jiraComment;

    return shared.markdownToJiraWiki(params.response || readOutputFile('response.md', workingDir, storyKey) || '');
}

function createPullRequest(title, branchName, baseBranch, workingDir, scm, ticketKey) {
    console.log('Creating Pull Request...');
    return prHelper.createPullRequest({
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        scm: scm,
        // gh-737: merge bot links approved issues via 'Closes #N' — emit it
        // by construction on every story test-automation PR.
        ticketKey: ticketKey,
        bodyFileCandidates: ['outputs/pr_body.md', 'outputs/response.md'],
        defaultBody: 'Automated story test automation changes.',
        runCommand: runInRepo,
        readFile: readFile
    });
}

function getFailedReasonField(config) {
    return (config.jira && config.jira.fields && config.jira.fields.failedReason)
        || JIRA_FIELDS.FAILED_REASON
        || 'Failed Reason';
}

function attachFailedDescription(tcKey, filePath) {
    try {
        if (!filePath) return null;
        var name = filePath.split('/').pop();
        getTracker().attachFile(tcKey, name, filePath, 'text/markdown');
        console.log('✅ Attached failed description to', tcKey, ':', name);
        return name;
    } catch (e) {
        console.warn('Failed to attach failed description to', tcKey, ':', e);
        return null;
    }
}

function updateFailedReasonField(tcKey, attachmentName, failureSummary, fieldName) {
    try {
        var value = 'h3. Failure Summary\n\n' + (failureSummary || 'See attached file for full failure details.') + '\n\n';
        if (attachmentName) {
            value += '*Attachment*: [^' + attachmentName + ']\n';
        }
        getTracker().updateField(tcKey, fieldName, value);
        console.log('✅ Updated Failed Reason field for', tcKey);
    } catch (e) {
        console.warn('Failed to update Failed Reason field for', tcKey, ':', e);
    }
}

function updateTestCaseStatus(tcKey, status, workingDir, storyKey, config) {
    try {
        var stageKey = status === 'passed' ? 'IN_REVIEW_PASSED' : 'IN_REVIEW_FAILED';
        var targetStatus = status === 'passed' ? config.jira.statuses.IN_REVIEW_PASSED : config.jira.statuses.IN_REVIEW_FAILED;
        // gh-916: In Review - Passed/Failed can be tag-only (restricted ADO workflows) — stage-label fallback.
        var moveResult = getTracker().moveToStatusOrMark(tcKey, targetStatus, stageKey);
        if (moveResult.moved || moveResult.marked) {
            console.log('✅ Moved', tcKey, 'to', targetStatus);
        }

        if (status === 'failed') {
            var result = readResultJson(workingDir, storyKey);
            var resultItem = null;
            if (result && result.results) {
                resultItem = result.results.find(function(r) { return r.testCaseKey === tcKey; });
            }
            var filePath = resultItem && resultItem.failedDescriptionFile
                ? resultItem.failedDescriptionFile
                : 'outputs/failed_description_' + tcKey + '.md';
            var attachmentName = attachFailedDescription(tcKey, filePath);
            updateFailedReasonField(tcKey, attachmentName, resultItem ? resultItem.failureSummary : '', getFailedReasonField(config));
        }
    } catch (e) {
        console.warn('Failed to update Test Case', tcKey, ':', e);
    }
}

function finalizeTestCaseStatus(tcKey, status, jiraConfig) {
    try {
        var stageKey = status === 'passed' ? 'PASSED' : 'FAILED';
        var targetStatus = status === 'passed' ? jiraConfig.statuses.PASSED : jiraConfig.statuses.FAILED;
        // gh-916: Passed/Failed can be tag-only (restricted ADO workflows) — stage-label fallback.
        var moveResult = getTracker().moveToStatusOrMark(tcKey, targetStatus, stageKey);
        if (moveResult.moved || moveResult.marked) {
            console.log('✅ Finalized', tcKey, 'to', targetStatus, '(no code changes)');
        }
    } catch (e) {
        console.warn('Failed to finalize Test Case', tcKey, ':', e);
    }
}

function moveSkippedTcToStatus(tcKey, skippedStatus) {
    try {
        // gh-916: Skipped can be tag-only (restricted ADO workflows) — stage-label fallback.
        var moveResult = getTracker().moveToStatusOrMark(tcKey, skippedStatus, 'SKIPPED');
        if (moveResult.moved || moveResult.marked) {
            console.log('✅ Moved', tcKey, 'to', skippedStatus, '(skipped)');
        }
    } catch (e) {
        console.warn('Failed to move skipped Test Case', tcKey, ':', e);
    }
}

function getTestCaseDirectory(tcKey, testFilesPath) {
    var basePath = (testFilesPath || 'testing/').replace(/\/$/, '');
    return basePath + '/tests/' + tcKey;
}

function deleteTestCaseCode(tcKey, testFilesPath, workingDir) {
    try {
        var dir = getTestCaseDirectory(tcKey, testFilesPath);
        console.log('Deleting test code for', tcKey, '—', dir);
        runInRepo('git rm -r --ignore-unmatch -- ' + dir, workingDir);
    } catch (e) {
        console.warn('Failed to delete test code for', tcKey, ':', e);
    }
}

function moveIrrelevantTcToStatus(tcKey, irrelevantStatus, testFilesPath, workingDir) {
    try {
        // gh-916: Irrelevant can be tag-only (restricted ADO workflows) — stage-label fallback.
        var moveResult = getTracker().moveToStatusOrMark(tcKey, irrelevantStatus, 'IRRELEVANT');
        if (moveResult.moved || moveResult.marked) {
            console.log('✅ Moved', tcKey, 'to', irrelevantStatus, '(irrelevant)');
        }
    } catch (e) {
        console.warn('Failed to move irrelevant Test Case', tcKey, ':', e);
    }
    deleteTestCaseCode(tcKey, testFilesPath, workingDir);
}

function autoStartStoryTestReview(storyKey, config, customParams, noCodeChanges) {
    if (noCodeChanges) {
        console.log('ℹ️ autoStartReview: skipped — no test code changes to review');
        return false;
    }
    if (!customParams || !customParams.autoStartReview || !customParams.autoStartReviewConfigFile) {
        return false;
    }
    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: storyKey,
            customParams: customParams,
            config: config,
            configFile: customParams.autoStartReviewConfigFile,
            label: 'pr_story_test_automation_review',
            stripKeys: ['removeLabel', 'autoStartReview', 'autoStartReviewConfigFile']
        });
    } catch (e) {
        console.warn('⚠️ autoStartReview trigger failed:', e.message || e);
        return false;
    }
}

function removeAutomationLabels(storyKey, params) {
    const wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : 'story_test_automation_wip';
    shared.removeLabelSafely(getTracker, storyKey, wipLabel);

    const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
    if (smTriggerLabel) {
        if (shared.removeLabelSafely(getTracker, storyKey, smTriggerLabel)) {
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        }
    }

    // Clean up stale finalization labels from a previous test-automation cycle so the
    // new bulk PR can go through review/merge again.
    [LABELS.PR_APPROVED, LABELS.TEST_PR_MERGED, LABELS.TEST_PR_FINALIZED, LABELS.TEST_PR_REWORK_NEEDED].forEach(function(staleLabel) {
        if (shared.removeLabelSafely(getTracker, storyKey, staleLabel)) {
            console.log('✅ Removed stale label:', staleLabel);
        }
    });
}

// ── action() step helpers (gh-1008 + gh-1080 CRAP split) ─────────────────────

/**
 * Pure parameter parse: ticket identity and the customParams-derived knobs.
 */
function parseResultParams(params) {
    var source = params.jobParams || params;
    var customParams = source.customParams || {};
    return {
        storyKey: params.ticket.key,
        storySummary: params.ticket.fields ? params.ticket.fields.summary : params.ticket.key,
        customParams: customParams,
        testFilesPath: customParams.testFilesGlob || 'testing/'
    };
}

function resolveResultStatuses(jiraConfig, customParams) {
    // Legacy override channel: customParams.customStatuses still wins over .dmtools/config.js statuses
    return Object.assign({}, jiraConfig.statuses, customParams.customStatuses || {});
}

/**
 * Everything the action steps need, resolved in the original order:
 * project config → tracker init → SCM → output-file comment read.
 */
function buildResultContext(params) {
    var parsed = parseResultParams(params);
    var config = configLoader.loadProjectConfig(params.jobParams || params);
    var jiraConfig = config.jira;
    initTracker(config, parsed.customParams);
    var scm = configLoader.createScm(config);
    var workingDir = config.workingDir || null;
    var testCaseType = (jiraConfig.issueTypes && jiraConfig.issueTypes.TEST_CASE) || 'Test Case';
    return {
        storyKey: parsed.storyKey,
        storySummary: parsed.storySummary,
        customParams: parsed.customParams,
        testFilesPath: parsed.testFilesPath,
        config: config,
        jiraConfig: jiraConfig,
        statuses: resolveResultStatuses(jiraConfig, parsed.customParams),
        scm: scm,
        workingDir: workingDir,
        testCaseType: testCaseType,
        jiraComment: readJiraComment(params, workingDir, parsed.storyKey)
    };
}

/**
 * Reads the structured result, resuming the agent when linked Test Cases are
 * missing. Returns { result } on success or { failure } (already announced on
 * the tracker) when the run cannot proceed.
 */
function loadValidatedResult(ctx, params) {
    // Step 1: Read structured result and ensure all linked Test Cases were checked
    var linkedTestCases = readLinkedTestCases(ctx.storyKey, ctx.testCaseType);

    var result = readResultJson(ctx.workingDir, ctx.storyKey);
    if (linkedTestCases.length > 0) {
        var resumeInfo = attemptResumeIfOutputsIncomplete(ctx.storyKey, result, linkedTestCases, ctx.workingDir);
        if (resumeInfo.attempted) {
            result = readResultJson(ctx.workingDir, ctx.storyKey);
        }
    }

    if (!result) {
        var commentMsg = 'h3. ⚠️ Story Test Automation Error\n\nCLI exited without producing result JSON. The Story will stay in Ready For Testing so SM can retry.';
        getTracker().postComment(ctx.storyKey, commentMsg);
        removeAutomationLabels(ctx.storyKey, params);
        return { failure: { success: false, error: 'No story test result JSON found' } };
    }

    var stillMissingKeys = getMissingTestCaseKeys(result, linkedTestCases);
    if (stillMissingKeys.length > 0) {
        console.warn('Linked Test Cases still missing from result after resume:', stillMissingKeys.join(', '));
        var missingComment = 'h3. ⚠️ Story Test Automation Incomplete\n\n' +
            'The automation could not verify all linked Test Cases. Missing results for:\n\n' +
            stillMissingKeys.map(function(k) { return '* ' + k; }).join('\n') + '\n\n' +
            'The Story will stay in Ready For Testing so SM can retry.';
        getTracker().postComment(ctx.storyKey, missingComment);
        removeAutomationLabels(ctx.storyKey, params);
        return { failure: { success: false, error: 'Missing Test Case results: ' + stillMissingKeys.join(', ') } };
    }

    return { result: result };
}

/**
 * Creates the PR for freshly pushed test code, or returns a failure result
 * (already announced on the tracker) when creation failed.
 */
function createPrOrFail(ctx, params, branchName) {
    const prTitle = configLoader.formatTemplate(ctx.config.formats.prTitle.testAutomation, {ticketKey: ctx.storyKey, ticketSummary: ctx.storySummary});
    const prResult = createPullRequest(prTitle, branchName, ctx.config.git.baseBranch, ctx.workingDir, ctx.scm, ctx.storyKey);
    const prUrl = prResult.prUrl;
    if (!prResult.success || !prUrl) {
        console.error('PR creation failed');
        getTracker().postComment(ctx.storyKey, 'h3. ⚠️ PR Creation Failed\n\nTest code was pushed to branch {code}' + branchName + '{code} but the Pull Request could not be created.');
        removeAutomationLabels(ctx.storyKey, params);
        return { failure: { success: false, error: 'PR creation failed' } };
    }
    return { prUrl: prUrl };
}

/**
 * Branches the three git outcomes into: PR created / no code changes / failure.
 */
function handleGitOutcome(ctx, params, branchName, gitResult) {
    if (gitResult.success && !gitResult.noNewCommit) {
        return createPrOrFail(ctx, params, branchName);
    }

    if (gitResult.noNewCommit) {
        noCodeChangesLog();
        return { prUrl: null, noCodeChanges: true };
    }

    console.warn('Git operations failed:', gitResult.error);
    getTracker().postComment(ctx.storyKey, 'h3. ⚠️ Git Operations Failed\n\n' + gitResult.error);
    removeAutomationLabels(ctx.storyKey, params);
    return { failure: { success: false, error: 'Git operations failed: ' + gitResult.error } };
}

function noCodeChangesLog() {
    console.log('ℹ️ No test code changes — skipping PR review, moving Story directly');
}

/**
 * Step 2-4: configure the git author, read the current branch, then
 * commit + push + create PR. Returns { prUrl, noCodeChanges } or { failure }.
 */
function publishBranchAndPr(ctx, params) {
    // Step 2: Configure git author
    try {
        runInRepo('git config user.name "' + ctx.config.git.authorName + '"', ctx.workingDir);
        runInRepo('git config user.email "' + ctx.config.git.authorEmail + '"', ctx.workingDir);
    } catch (e) {
        console.warn('Failed to configure git author:', e);
    }

    // Step 3: Read current branch
    var rawBranch = runInRepo('git branch --show-current', ctx.workingDir) || '';
    const branchName = cleanCommandOutput(rawBranch);
    console.log('Cleaned branch name:', JSON.stringify(branchName));

    if (!branchName) {
        return { prUrl: null, noCodeChanges: false };
    }

    const commitMessage = configLoader.formatTemplate(ctx.config.formats.commitMessage.testAutomation, {ticketKey: ctx.storyKey, ticketSummary: ctx.storySummary});
    const gitResult = gitOps.performGitOperations(branchName, commitMessage, ctx.workingDir, ctx.testFilesPath);

    // Step 4: Commit + push + create PR
    return handleGitOutcome(ctx, params, branchName, gitResult);
}

function moveStoryToInTesting(ctx) {
    // Step 8: Move Story to In Testing
    try {
        // gh-916: IN_TESTING can be tag-only (restricted ADO workflows) — stage-label fallback.
        var inTestingMove = getTracker().moveToStatusOrMark(ctx.storyKey, ctx.jiraConfig.statuses.IN_TESTING, 'IN_TESTING');
        if (inTestingMove.moved || inTestingMove.marked) {
            console.log('✅ Moved Story', ctx.storyKey, 'to', ctx.jiraConfig.statuses.IN_TESTING);
        }
    } catch (e) {
        console.warn('Failed to move Story to In Testing:', e);
    }
}

function cleanupAndNotify(ctx, params) {
    // Step 10: Labels cleanup
    removeAutomationLabels(ctx.storyKey, params);
    try {
        getTracker().addLabel(ctx.storyKey, LABELS.AI_TEST_AUTOMATION);
    } catch (e) {
        console.warn('Failed to add ai_test_automation label:', e);
    }

    // Step 11: Token usage comments
    try {
        tokenUsageComment.postTokenUsageComments(ctx.storyKey, { initiator: params.initiator, customParams: tokenUsageComment.customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

/**
 * Steps 5-11: comment, blocked-by-human gate, per-TC statuses, story move,
 * review trigger and cleanup. Returns the action result.
 */
function finalizeResultActions(ctx, params, result, prUrl, noCodeChanges, overall) {
    // Step 5: Post Story Jira comment
    postStoryResultComment(ctx.storyKey, ctx.jiraComment, prUrl, noCodeChanges);

    // Step 6: Handle blocked_by_human
    if (overall === 'blocked_by_human') {
        return handleBlockedByHuman(ctx.storyKey, result, ctx.jiraConfig, params);
    }

    // Step 7: Update per-Test Case statuses
    applyTestCaseResults(result, noCodeChanges, ctx.workingDir, ctx.storyKey, ctx.config, ctx.jiraConfig, ctx.statuses, ctx.testFilesPath);

    moveStoryToInTesting(ctx);

    // Step 9: Trigger review
    if (!autoStartStoryTestReview(ctx.storyKey, ctx.config, ctx.customParams, noCodeChanges)) {
        autoStart.triggerSmIfIdle({ config: ctx.config, customParams: ctx.customParams });
    }

    cleanupAndNotify(ctx, params);

    return {
        success: true,
        status: overall,
        storyKey: ctx.storyKey,
        prUrl: prUrl
    };
}

function action(params) {
    try {
        var ctx = buildResultContext(params);

        console.log('=== Processing story test automation results for', ctx.storyKey, '===');

        var loaded = loadValidatedResult(ctx, params);
        if (loaded.failure) {
            return loaded.failure;
        }
        var result = loaded.result;

        const overall = (result.overall || '').toLowerCase();

        // For a Bug, a product failure means the fix did not work. Send the Bug
        // straight back to development and finalize the failing Test Cases as Failed.
        var bugResult = handleBugWithProductFailure(params, result, ctx.storyKey, ctx.jiraConfig, ctx.statuses, ctx.config, ctx.workingDir);
        if (bugResult) {
            return bugResult;
        }

        var published = publishBranchAndPr(ctx, params);
        if (published.failure) {
            return published.failure;
        }

        return finalizeResultActions(ctx, params, result, published.prUrl, published.noCodeChanges, overall);

    } catch (error) {
        console.error('❌ Error in postStoryTestAutomationResults:', error);
        try {
            getTracker().postComment(params.ticket.key, 'h3. ❌ Story Test Automation Error\n\n{code}' + error.toString() + '{code}');
        } catch (e) {}
        removeAutomationLabels(params.ticket.key, params);
        return { success: false, error: error.toString() };
    }
}

function postStoryResultComment(storyKey, jiraComment, prUrl, noCodeChanges) {
    try {
        let comment = jiraComment || '';
        if (prUrl) {
            comment += '\n\n*Story Test Branch PR*: ' + prUrl;
        }
        if (noCodeChanges) {
            comment += '\n\nℹ️ _Test code unchanged from previous run._';
        }
        if (comment) {
            getTracker().postComment(storyKey, comment);
            console.log('✅ Posted story test result comment to Jira');
        }
    } catch (e) {
        console.warn('Failed to post Jira comment:', e);
    }
}

function handleBlockedByHuman(storyKey, result, jiraConfig, params) {
    var blockedComment = 'h3. 🚫 Story Test Automation Blocked — Awaiting Human Setup\n\n' +
        (result.blockedReason || 'Missing credentials or test data.') + '\n\n' +
        'Once setup is complete, move this Story back to *Ready For Testing* to trigger re-run.';
    try {
        getTracker().postComment(storyKey, blockedComment);
        getTracker().moveToStatus(storyKey, jiraConfig.statuses.BLOCKED);
        console.log('✅ Blocked — moved', storyKey, 'to', jiraConfig.statuses.BLOCKED);
    } catch (e) {
        console.warn('Failed to handle blocked story:', e);
    }
    removeAutomationLabels(storyKey, params);
    return { success: true, status: 'blocked_by_human', storyKey: storyKey };
}

function updatePassedOrFailedTc(item, noCodeChanges, workingDir, storyKey, config, jiraConfig) {
    updateTestCaseStatus(item.testCaseKey, item.status, workingDir, storyKey, config);
    // When there are no test code changes we skip the PR/review/merge flow,
    // so we must finalize TC statuses immediately so story_done_check can act.
    if (noCodeChanges) {
        finalizeTestCaseStatus(item.testCaseKey, item.status, jiraConfig);
    }
}

function handleTestCaseOutcome(item, noCodeChanges, workingDir, storyKey, config, jiraConfig, statuses, testFilesPath) {
    if (item.status === 'passed' || item.status === 'failed') {
        updatePassedOrFailedTc(item, noCodeChanges, workingDir, storyKey, config, jiraConfig);
    } else if (item.status === 'skipped') {
        // Skipped tests are final — no PR/review needed.
        moveSkippedTcToStatus(item.testCaseKey, statuses.SKIPPED);
    } else if (item.status === 'irrelevant') {
        // Legacy/no-longer-applicable tests are final; delete their test code.
        moveIrrelevantTcToStatus(item.testCaseKey, statuses.IRRELEVANT, testFilesPath, workingDir);
    } else {
        console.log('Skipping status update for', item.testCaseKey, '— status:', item.status);
    }
}

function applyTestCaseResults(result, noCodeChanges, workingDir, storyKey, config, jiraConfig, statuses, testFilesPath) {
    if (!result.results || result.results.length === 0) return;

    result.results.forEach(function(item) {
        handleTestCaseOutcome(item, noCodeChanges, workingDir, storyKey, config, jiraConfig, statuses, testFilesPath);
    });
}

/**
 * Bug with a real product failure: the fix did not work — finalize the
 * failing Test Cases as Failed (stage + final status).
 */
function finalizeFailedBugTestCases(failedResults, workingDir, storyKey, config, jiraConfig) {
    failedResults.forEach(function(item) {
        updateTestCaseStatus(item.testCaseKey, 'failed', workingDir, storyKey, config);
        finalizeTestCaseStatus(item.testCaseKey, 'failed', jiraConfig);
    });
}

/** Moves the Bug back to Ready For Development and posts the failure summary. */
function returnBugToDevelopment(storyKey, failedResults, statuses) {
    var bugReturnStatus = statuses.READY_FOR_DEVELOPMENT;
    try {
        getTracker().moveToStatus(storyKey, bugReturnStatus);
        console.log('✅ Moved Bug', storyKey, 'back to', bugReturnStatus);
    } catch (moveErr) {
        console.warn('Failed to move Bug', storyKey, 'to', bugReturnStatus, ':', moveErr);
    }

    try {
        var failureList = failedResults.map(function(r) { return '* ' + r.testCaseKey + (r.failureSummary ? ' — ' + r.failureSummary : ''); }).join('\n');
        getTracker().postComment(storyKey, 'h3. ⚠️ Bug Fix Did Not Pass Automated Tests\n\nThe following Test Cases failed with a product regression:\n' + failureList + '\n\nThe Bug is being returned to *Ready For Development* for a corrected fix.');
    } catch (e) {
        console.warn('Failed to post bug return comment:', e);
    }
}

/**
 * Bug with a real product failure: the fix did not work — send the Bug
 * straight back to development and finalize the failing Test Cases as Failed.
 * Returns the action result when this path handled the run, null otherwise.
 */
function handleBugWithProductFailure(params, result, storyKey, jiraConfig, statuses, config, workingDir) {
    var issueType = (params.ticket && params.ticket.fields &&
        params.ticket.fields.issuetype && params.ticket.fields.issuetype.name) || 'Story';
    var failedResults = (result.results || []).filter(function(r) {
        return r.status === 'failed';
    });
    if (issueType !== jiraConfig.issueTypes.BUG || failedResults.length === 0) {
        return null;
    }

    console.log('Bug', storyKey, 'has', failedResults.length, 'product failure(s) — returning to development');
    finalizeFailedBugTestCases(failedResults, workingDir, storyKey, config, jiraConfig);
    returnBugToDevelopment(storyKey, failedResults, statuses);

    removeAutomationLabels(storyKey, params);
    return {
        success: true,
        status: 'failed',
        storyKey: storyKey,
        failedTestCases: failedResults.map(function(r) { return r.testCaseKey; })
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
