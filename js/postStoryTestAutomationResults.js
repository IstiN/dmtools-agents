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
// gh-1329: attribute linked-TC failures before bouncing a bug.
var tcTriage = require('./common/tcTriage.js');
var tcMaintenanceLedger = require('./common/tcMaintenanceLedger.js');
var tcRunRegistry = require('./common/tcRunRegistry.js');
// gh-1331: cross-lap alternation detection + earned-bounce suppression.
var tcAlternation = require('./common/tcAlternation.js');
// gh-1329 review: the shared "load bug bookkeeping" helper (one getIssue,
// one machine-author resolution) for both legs that read the markers.
var bugBookkeeping = require('./common/bugBookkeeping.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerOps = shared.createTrackerHolder(trackersModule);
var initTracker = trackerOps.initTracker;
var getTracker = trackerOps.getTracker;

var gitOps = shared.createGitOps(prHelper);
var runInRepo = shared.runInRepo;
var outputReaders = shared.makeOutputFileReaders(outputFiles);
var readFile = outputReaders.readFile;
var readOutputFile = outputReaders.readOutputFile;

var RESUME_MARKER = 'outputs/.story-test-resume-attempted';

function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
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
                        "failureSummary": { "type": "string" },
                        "errorClass": { "type": "string", "enum": ["element-not-found", "assertion", "timeout", "navigation", "crash", "unknown"] },
                        "envFingerprint": { "type": "string" },
                        "retryStatus": { "type": "string", "enum": ["green", "red"] },
                        "differential": { "type": "string", "enum": ["green", "red", "unavailable"] },
                        "acVerdict": { "type": "string", "enum": ["violated", "intact"] },
                        "role": { "type": "string" },
                        "verifies": { "type": "string" }
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
    // gh-737: merge bot links approved issues via 'Closes #N' — emitted by
    // construction on every story test-automation PR; the defaultBody
    // fallback is posted verbatim.
    return shared.createTestPullRequest(prHelper, runInRepo, readFile, {
        defaultBody: 'Automated story test automation changes.',
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        scm: scm,
        ticketKey: ticketKey
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
    return shared.triggerAutoStartReviewWorkflow(autoStart, storyKey, customParams, config, 'pr_story_test_automation_review');
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

        // For a Bug, failed TCs are triaged before any bounce (gh-1329):
        // roles, fingerprints and the differential rerun attribute each
        // failure; only an earned bounce returns the bug to development.
        var bugResult = handleBugWithProductFailure(params, result, ctx);
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

/**
 * Bug with a test-side triage route: stage the TC as In Review - Failed with
 * the failure evidence attached, but do NOT finalize it as Failed — the
 * final status reads as a product failure, and these routes are test-side
 * (maintenance / rework / differential rerun) with the bug unchanged.
 */
function stageRoutedBugTestCases(routedVerdicts, workingDir, storyKey, config) {
    routedVerdicts.forEach(function(v) {
        updateTestCaseStatus(v.tcKey, 'failed', workingDir, storyKey, config);
    });
}

/** Moves the Bug back to Ready For Development (the earned-bounce move). */
function moveBugToDevelopment(storyKey, statuses) {
    var bugReturnStatus = statuses.READY_FOR_DEVELOPMENT;
    try {
        getTracker().moveToStatus(storyKey, bugReturnStatus);
        console.log('✅ Moved Bug', storyKey, 'back to', bugReturnStatus);
    } catch (moveErr) {
        console.warn('Failed to move Bug', storyKey, 'to', bugReturnStatus, ':', moveErr);
    }
}

/** The per-TC failure list lines (legacy comment shape). */
function failureListLines(failedResults) {
    return failedResults.map(function(r) {
        return '* ' + r.testCaseKey + (r.failureSummary ? ' — ' + r.failureSummary : '');
    }).join('\n');
}

/**
 * The bounce comment: ONE TC list (gh-1329 review — the legacy list and the
 * tcTriage bounce list rendered the same header + list twice back-to-back).
 * The verdict-attributed list carries the failure summaries and the earned
 * evidence per bounced TC; the legacy list remains the no-verdict fallback.
 */
function bugReturnComment(failedResults, bouncedVerdicts) {
    var comment = 'h3. ⚠️ Bug Fix Did Not Pass Automated Tests\n';
    if (bouncedVerdicts && bouncedVerdicts.length) {
        comment += tcTriage.buildBounceComment(bouncedVerdicts) + '\n\n';
    } else {
        comment += 'The following Test Cases failed with a product regression:\n' +
            failureListLines(failedResults) + '\n\n';
    }
    comment += 'The Bug is being returned to *Ready For Development* for a corrected fix.';
    return comment;
}

/** Moves the Bug back to Ready For Development and posts the failure summary. */
function returnBugToDevelopment(storyKey, failedResults, statuses, bouncedVerdicts) {
    moveBugToDevelopment(storyKey, statuses);
    try {
        getTracker().postComment(storyKey, bugReturnComment(failedResults, bouncedVerdicts || []));
    } catch (e) {
        console.warn('Failed to post bug return comment:', e);
    }
}

// ── gh-1329: failure attribution before any bounce ───────────────────────────

/**
 * The build SHA a result entry declares (entry sha wins, then the
 * result-level buildSha), or null when neither carries one.
 */
function declaredBuildSha(result, entry) {
    if (entry && entry.sha) return String(entry.sha);
    if (result && result.buildSha) return String(result.buildSha);
    return null;
}

/** The checked-out test branch HEAD — resolved at most once per run. */
function repoHeadSha(workingDir) {
    try {
        var out = runInRepo('git rev-parse HEAD', workingDir) || '';
        var sha = cleanCommandOutput(String(out)).split('\n')[0].trim();
        return sha || null;
    } catch (e) {
        return null;
    }
}

function currentBuildSha(result, entry, workingDir) {
    return declaredBuildSha(result, entry) || repoHeadSha(workingDir);
}

/** One entry's build SHA: entry/result still win over the run-level HEAD. */
function entryBuildSha(entry, result, runBuildSha) {
    return declaredBuildSha(result, entry) || runBuildSha;
}

function maxReworkRoundsOf(customParams) {
    var n = parseInt(customParams && customParams.maxReworkRounds, 10);
    return n > 0 ? n : tcTriage.DEFAULT_MAX_REWORK_ROUNDS;
}

/** The scripted differential rerun outcome ('green'|'red'|'unavailable'|null). */
function normalizeDifferential(raw) {
    var v = String(raw || '').toLowerCase().trim();
    if (v === 'green' || v === 'red' || v === 'unavailable') return v;
    return null;
}

/** The TC-rework leg's AC re-check verdict ('violated'|'intact'|null). */
function normalizeAcVerdict(raw) {
    var v = String(raw || '').toLowerCase().trim();
    if (v === 'violated' || v === 'intact') return v;
    return null;
}

/**
 * Role metadata for one result entry — the LINKED TC's own metadata wins
 * (gh-1329 review: the TC ticket is the durable record; the result file is
 * per-run and agent-copied). A missing linked entry falls back to the
 * result entry; any role disagreement leaves a warning trace.
 */
function linkedRoleFieldsOf(linkedEntry) {
    var fields = linkedEntry && linkedEntry.fields;
    if (fields && (fields.role || fields.verifies)) return fields;
    return null;
}

function linkedRoleSourceOf(linkedEntry) {
    if (!linkedEntry) return null;
    if (linkedEntry.role || linkedEntry.verifies || linkedEntry.regressionGuard !== undefined) return linkedEntry;
    return linkedRoleFieldsOf(linkedEntry);
}

function linkedRoleAwareEntry(entry, linked) {
    var base = entry || {};
    return {
        role: linked.role !== undefined ? linked.role : base.role,
        tcRole: linked.tcRole !== undefined ? linked.tcRole : base.tcRole,
        verifies: linked.verifies !== undefined ? linked.verifies : base.verifies,
        regressionGuard: linked.regressionGuard !== undefined ? linked.regressionGuard : base.regressionGuard
    };
}

/** A mis-scoped oracle must leave a trace, not silently demote the gate. */
function warnOnRoleDisagreement(entry, linked, bugKey) {
    var entryRole = tcTriage.resolveTcRole(entry, bugKey);
    var linkedRole = tcTriage.resolveTcRole(linked, bugKey);
    if (entryRole === linkedRole) return;
    console.warn('gh-1329: role scoping disagreement for a linked TC — result entry says "' + entryRole +
        '" (verifies: ' + (entry && entry.verifies ? entry.verifies : 'n/a') +
        '), the linked TC metadata says "' + linkedRole +
        '" (verifies: ' + (linked && linked.verifies ? linked.verifies : 'n/a') +
        ') — the linked TC metadata wins');
}

function entryRoleMeta(entry, linkedEntry, bugKey) {
    var linked = linkedRoleSourceOf(linkedEntry);
    if (!linked) return entry || {};
    warnOnRoleDisagreement(entry, linked, bugKey);
    return linkedRoleAwareEntry(entry, linked);
}

/** The gh-1329 result-schema triage fields (their absence stalls attribution). */
var TRIAGE_SCHEMA_FIELDS = ['acVerdict', 'retryStatus', 'errorClass'];

function entryCarriesTriageFields(entry) {
    return TRIAGE_SCHEMA_FIELDS.some(function(f) {
        return entry[f] !== undefined && entry[f] !== null && entry[f] !== '';
    });
}

/**
 * The linked-TC map for the run (readLinkedTestCases, keyed by TC key).
 */
function linkedTestCaseMap(ctx) {
    var linkedMap = {};
    readLinkedTestCases(ctx.storyKey, ctx.testCaseType).forEach(function(tc) {
        if (tc && tc.key) linkedMap[tc.key] = tc;
    });
    return linkedMap;
}

function newTriageOutcome(bookkeeping) {
    return {
        bounced: [], routed: [], escalated: [], transient: [],
        schemaGapTestCases: [],
        newConflicts: [],
        registry: bookkeeping.registry, ledger: bookkeeping.ledger
    };
}

/** The registry's last-green record for a TC, or null while unvalidated. */
function lastGreenOf(registry, tcKey) {
    var state = tcRunRegistry.stateOf(registry, tcKey);
    return (state && state.validated) ? {
        sha: state.lastGreenSha,
        envFingerprint: state.lastGreenEnvFingerprint
    } : null;
}

/** The triage-engine input for one result entry. */
function triageInputForEntry(entry, vars) {
    var tcKey = entry.testCaseKey;
    return {
        tcKey: tcKey,
        role: vars.role,
        validated: tcRunRegistry.isValidated(vars.outcome.registry, tcKey),
        current: {
            sha: entryBuildSha(entry, vars.result, vars.runBuildSha),
            envFingerprint: entry.envFingerprint || null
        },
        lastGreen: lastGreenOf(vars.outcome.registry, tcKey),
        retryGreen: entry.retryStatus === 'green' || entry.retryGreen === true,
        differential: normalizeDifferential(entry.differential),
        acVerdict: normalizeAcVerdict(entry.acVerdict),
        redRounds: tcRunRegistry.redRoundsOf(vars.outcome.registry, tcKey),
        maxReworkRounds: vars.maxRework,
        errorClass: entry.errorClass,
        testPath: entry.testPath,
        failedDescriptionFile: entry.failedDescriptionFile,
        failureSummary: entry.failureSummary
    };
}

function routeVerdict(outcome, entry, verdict) {
    if (verdict.action === tcTriage.ACTION_BOUNCE) outcome.bounced.push({ entry: entry, verdict: verdict });
    else if (verdict.action === tcTriage.ACTION_ESCALATE) outcome.escalated.push(verdict);
    else if (verdict.action === tcTriage.ACTION_NONE) outcome.transient.push(verdict);
    else outcome.routed.push(verdict);
}

/** The triage of one failed entry: ledger, registry streak, route bucket. */
function triageFailedEntry(outcome, entry, vars) {
    var verdict = tcTriage.triageFailure(triageInputForEntry(entry, vars));
    if (vars.role === tcTriage.ROLE_OWN && !entryCarriesTriageFields(entry)) {
        outcome.schemaGapTestCases.push(vars.tcKey);
    }
    if (verdict.action !== tcTriage.ACTION_NONE) {
        // A transient flake (retry green) is "nothing happened" — it
        // never counts toward the bounce streak. The failing build sha
        // rides along: the gh-1331 run history groups laps by build.
        outcome.registry = tcRunRegistry.recordFailure(outcome.registry, vars.tcKey, {
            at: vars.at, verdict: verdict.action, role: vars.role, sha: verdict.evidence.sha
        });
    }
    verdict = gateBounceForAlternation(outcome, verdict, vars);
    if (verdict.ledgerEntry) {
        outcome.ledger = tcMaintenanceLedger.appendFinding(
            outcome.ledger, tcMaintenanceLedger.findingFromVerdict(verdict, { at: vars.at }));
    }
    routeVerdict(outcome, entry, verdict);
}

/** The run entry of one TC (the last entry wins), or null. */
function runEntryOf(result, tcKey) {
    var entry = null;
    (result.results || []).forEach(function(e) {
        if (e && e.testCaseKey === tcKey) entry = e;
    });
    return entry;
}

/** The AC reference of one TC — the linked TC metadata wins over the run entry. */
function verifiesOf(linked, entry) {
    return linked.verifies || (entry && entry.verifies) || null;
}

/** The registry's recorded last-green build of one TC, or null. */
function lastGreenShaOf(registry, tcKey) {
    var state = tcRunRegistry.stateOf(registry, tcKey);
    return state ? state.lastGreenSha : null;
}

/**
 * The member-evidence snapshot for a pair-conflict record: the AC reference
 * (verifies) from the linked TC metadata, the script + failure summary from
 * the run entry, the recorded last-green build from the registry. The
 * free-text cap is applied by recordConflicts (marker hygiene).
 */
function pairConflictMetaFor(vars, tcKey) {
    var linked = linkedRoleSourceOf(vars.linkedMap[tcKey]) || {};
    var entry = runEntryOf(vars.result, tcKey);
    return {
        verifies: verifiesOf(linked, entry),
        testPath: (entry && entry.testPath) || null,
        failureSummary: (entry && entry.failureSummary) || null,
        lastGreenSha: lastGreenShaOf(vars.outcome.registry, tcKey)
    };
}

/**
 * The member-evidence snapshot resolver for a pair-conflict record.
 */
function pairConflictMetaResolver(vars) {
    return function(tcKey) {
        return pairConflictMetaFor(vars, tcKey);
    };
}

/**
 * gh-1331: the earned-bounce gate. Detection runs FIRST (a fresh trade flip
 * marks the pair even when another anchor would have suppressed this lap —
 * the escalation must not wait for the anchor to expire), then the
 * suppression anchors decide (pair conflict → prior bounce on the same range
 * → open ledger item). A suppressed bounce converts to a test-side
 * maintenance route (bug untouched, ledger refreshed); an unsuppressed bounce
 * stamps the registry's bounce anchor for the laps that follow.
 */
function gateBounceForAlternation(outcome, verdict, vars) {
    if (verdict.action === tcTriage.ACTION_BOUNCE) {
        var detections = tcAlternation.scanAlternations(outcome.registry, verdict.tcKey);
        if (detections.length) {
            var recorded = tcAlternation.recordConflicts(
                outcome.registry, detections, vars.at, pairConflictMetaResolver(vars));
            outcome.registry = recorded.registry;
            outcome.newConflicts = outcome.newConflicts.concat(recorded.added);
        }
        var suppression = tcAlternation.bounceSuppression(
            outcome.registry, outcome.ledger, verdict.tcKey,
            verdict.evidence.lastGreenSha, verdict.evidence.sha);
        outcome.registry = tcRunRegistry.recordBounce(outcome.registry, verdict.tcKey, {
            at: vars.at,
            lastGreenSha: verdict.evidence.lastGreenSha,
            kind: suppression ? 'suppressed' : 'earned'
        });
        if (suppression) {
            console.log('gh-1331: bounce for ' + verdict.tcKey + ' suppressed (' + suppression.kind + ')');
            return tcAlternation.suppressedVerdict(verdict, suppression);
        }
        return verdict;
    }
    if (verdict.action === tcTriage.ACTION_ESCALATE) {
        // the cap escalation is a loop-stop too — anchor its range so later
        // laps cannot re-bounce the same unresolved range behind the owner's back
        outcome.registry = tcRunRegistry.recordBounce(outcome.registry, verdict.tcKey, {
            at: vars.at, lastGreenSha: verdict.evidence.lastGreenSha, kind: 'escalated'
        });
    }
    return verdict;
}

function recordPassedEntry(outcome, entry, vars) {
    outcome.registry = tcRunRegistry.recordGreen(outcome.registry, entry.testCaseKey, {
        sha: entryBuildSha(entry, vars.result, vars.runBuildSha),
        envFingerprint: entry.envFingerprint || null,
        role: vars.role,
        at: vars.at
    });
}

function applyEntryToOutcome(outcome, entry, vars) {
    if (!entry || !entry.testCaseKey) return;
    var role = tcTriage.resolveTcRole(
        entryRoleMeta(entry, vars.linkedMap[entry.testCaseKey], vars.bugKey), vars.bugKey);
    if (entry.status === 'failed') {
        triageFailedEntry(outcome, entry, Object.assign({}, vars, { role: role, tcKey: entry.testCaseKey }));
        return;
    }
    if (entry.status === 'passed') {
        recordPassedEntry(outcome, entry, Object.assign({}, vars, { role: role }));
    }
}

/**
 * The gh-1329 result-schema hint: failed own-oracle entries carrying NONE
 * of the triage fields cannot be attributed — without the hint a stalled
 * bug is indistinguishable from "product didn't regress" while the real
 * cause is "the agent didn't follow the schema".
 */
function schemaGapHintSection(triage) {
    var tcs = triage.schemaGapTestCases || [];
    if (!tcs.length) return null;
    return '⚠️ *gh-1329 triage metadata missing* — the failed TC result entries carried none of ' +
        'acVerdict / retryStatus / errorClass (' + tcs.join(', ') + '). The automation agent likely ignored ' +
        'the result schema, so the failures could not be attributed; a failing own-oracle TC routes to rework ' +
        'and the bug stays in the TC-verification lane until a schema-compliant run lands.';
}

/**
 * Triage for every failed TC of a bug run (gh-1329): mechanical, evidence-
 * producing, and bounce-gated. Greens validate guards into the run
 * registry. Nothing is dropped: every verdict except a same-build retry
 * green lands in the maintenance ledger. The build SHA is resolved once
 * per run (entry overrides still win).
 */
function triageBugFailures(params, result, ctx, bookkeeping) {
    var at = new Date().toISOString();
    var outcome = newTriageOutcome(bookkeeping);
    var vars = triageVarsFor(result, ctx, at, outcome);
    (result.results || []).forEach(function(entry) {
        applyEntryToOutcome(outcome, entry, vars);
    });
    crossLapScan(outcome, vars);
    outcome.registryChanged = JSON.stringify(outcome.registry) !== JSON.stringify(bookkeeping.registry);
    outcome.ledgerChanged = JSON.stringify(outcome.ledger) !== JSON.stringify(bookkeeping.ledger);
    outcome.schemaGapHint = schemaGapHintSection(outcome);
    if (outcome.schemaGapHint) console.warn(outcome.schemaGapHint);
    return outcome;
}

/** The shared triage vars for one bug lap (triage and bookkeeping read the same map). */
function triageVarsFor(result, ctx, at, outcome) {
    return {
        outcome: outcome,
        result: result,
        bugKey: ctx.storyKey,
        linkedMap: linkedTestCaseMap(ctx),
        maxRework: maxReworkRoundsOf(ctx.customParams || {}),
        runBuildSha: currentBuildSha(result, null, ctx.workingDir),
        at: at
    };
}

/**
 * gh-1331: the lap's cross-lap bookkeeping — a stable green resolves marked
 * pairs (resolution re-enables normal triage), then the full-lap scan marks
 * any fresh trade flip — the escalation surface rides the digest even when
 * no bounce was pending this lap.
 */
function crossLapScan(outcome, vars) {
    outcome.registry = tcAlternation.reconcileConflicts(outcome.registry);
    var lapDetections = tcAlternation.scanAlternations(outcome.registry);
    if (!lapDetections.length) return;
    var marked = tcAlternation.recordConflicts(
        outcome.registry, lapDetections, vars.at, pairConflictMetaResolver(vars));
    outcome.registry = marked.registry;
    outcome.newConflicts = outcome.newConflicts.concat(marked.added);
}

/**
 * gh-1331 (rework): the cross-lap bookkeeping for an ALL-GREEN bug lap.
 * The canonical pair-resolution lap has no failed TC — the failed-lap triage
 * gate never sees it — so the greens, the pair reconciliation and the
 * marker posting happen HERE: a pair record that never clears would keep
 * its `contradictory-pair` suppression anchor standing forever, silently
 * routing the members' future genuine regressions to maintenance.
 */
function bookeepGreenBugRun(params, result, ctx) {
    var at = new Date().toISOString();
    var bookkeeping = bugBookkeeping.loadBugBookkeeping(getTracker(), ctx.storyKey, params, ctx.config);
    var outcome = newTriageOutcome(bookkeeping);
    var vars = triageVarsFor(result, ctx, at, outcome);
    (result.results || []).forEach(function(entry) {
        applyEntryToOutcome(outcome, entry, vars);
    });
    crossLapScan(outcome, vars);
    postMarkerIfChanged(ctx.storyKey,
        JSON.stringify(outcome.registry) !== JSON.stringify(bookkeeping.registry),
        tcRunRegistry.buildRegistryMarker(outcome.registry), 'TC run registry');
    postConflictEscalationsQuietly(ctx.storyKey, outcome.newConflicts);
}

/** Best-effort comment post (an escalation surface — never fails the run). */
function postCommentSafely(storyKey, comment, label) {
    if (!comment) return;
    try {
        getTracker().postComment(storyKey, comment);
        console.log('✅ Posted', label, 'to', storyKey);
    } catch (e) {
        console.warn('Failed to post', label, '(non-fatal):', e);
    }
}

/** The gh-1331 pair escalations of a lap — one comment per pair (records never re-escalate). */
function postConflictEscalationsQuietly(storyKey, newConflicts) {
    (newConflicts || []).forEach(function(record) {
        postCommentSafely(storyKey, tcAlternation.buildConflictComment(record), 'gh-1331 pair escalation');
    });
}

/** Posts a machine marker comment when its payload is not already current. */
function postMarkerIfChanged(storyKey, changed, marker, label) {
    if (!changed || !marker) return;
    try {
        getTracker().postComment(storyKey, marker);
        console.log('✅ Posted', label, 'marker to', storyKey);
    } catch (e) {
        console.warn('Failed to post', label, 'marker (non-fatal):', e);
    }
}

/**
 * AC: failing scripts are always persisted — commit + push the testing tree
 * onto the test branch (NO PR: the evidence must survive a red result; the
 * sweep/re-fix legs consume the branch). Best effort: a persistence failure
 * never re-routes the triage verdicts.
 */
function persistBugTestScripts(ctx) {
    try {
        runInRepo('git config user.name "' + ctx.config.git.authorName + '"', ctx.workingDir);
        runInRepo('git config user.email "' + ctx.config.git.authorEmail + '"', ctx.workingDir);
        var rawBranch = runInRepo('git branch --show-current', ctx.workingDir) || '';
        var branchName = cleanCommandOutput(rawBranch);
        if (!branchName) {
            console.warn('No current branch — failing test scripts not persisted');
            return;
        }
        const commitMessage = configLoader.formatTemplate(
            ctx.config.formats.commitMessage.testAutomation,
            { ticketKey: ctx.storyKey, ticketSummary: ctx.storySummary });
        var gitResult = gitOps.performGitOperations(branchName, commitMessage, ctx.workingDir, ctx.testFilesPath);
        console.log('✅ Persisted failing test scripts on', branchName, '—', JSON.stringify(gitResult).substring(0, 200));
    } catch (e) {
        console.warn('Failed to persist failing test scripts (non-fatal):', e);
    }
}

/**
 * Bug with failed linked TCs — attribute before bouncing (gh-1329):
 *   - the bug's verdict is gated only by its own oracle TC;
 *   - fresh TCs route to rework (a fresh TC cannot bounce by construction);
 *   - validated TCs (guards AND own oracles — gh-1354) go through the
 *     mechanical triage table first (retry filter, fingerprint lookup,
 *     differential rerun); an own-oracle hands to the AC re-check only when
 *     attribution says product-side, and its null-verdict laps escalate at
 *     the cap instead of reworking forever;
 *   - only an earned bounce (own-oracle AC violated / differential-green
 *     regression) returns the bug to development — bounded, escalation at
 *     the cap;
 *   - everything test-side lands in the maintenance ledger; failing scripts
 *     are always persisted; routed/escalated findings are staged and
 *     digested on EVERY route (mixed bounce+route runs included).
 * Returns the action result when this path handled the run, null otherwise
 * (stories, bugs without failures, and blocked_by_human runs fall through).
 */
function handleBugWithProductFailure(params, result, ctx) {
    if (!isBookkeepableBugRun(params, result, ctx)) {
        return null;
    }
    if (failedResultsOf(result).length === 0) {
        // gh-1331 rework: the all-green lap never triages (nothing failed),
        // but it is exactly the pair-resolution lap — the cross-lap
        // bookkeeping (greens + reconcileConflicts + markers) runs HERE, or
        // a marked pair could never clear and its stale contradictory-pair
        // anchor would suppress the members' future genuine regressions
        // forever.
        bookeepGreenBugRun(params, result, ctx);
        return null;
    }

    console.log('Bug', ctx.storyKey, 'has', failedResultsOf(result).length, 'failed TC(s) — triaging before any bounce');

    // gh-1345 deployment guard: triage is fail-closed against the machine
    // author allowlist — an empty allowlist reads fresh bookkeeping forever
    // (no earned bounce / escalation / differential dispatch can trigger).
    var allowlistWarning = bugBookkeeping.triageAllowlistWarning(params, ctx.config);
    if (allowlistWarning) console.warn(allowlistWarning);
    var bookkeeping = bugBookkeeping.loadBugBookkeeping(getTracker(), ctx.storyKey, params, ctx.config);
    var triage = triageBugFailures(params, result, ctx, bookkeeping);

    persistBugTestScripts(ctx);
    postMarkerIfChanged(ctx.storyKey, triage.registryChanged, tcRunRegistry.buildRegistryMarker(triage.registry), 'TC run registry');
    postMarkerIfChanged(ctx.storyKey, triage.ledgerChanged, tcMaintenanceLedger.buildLedgerMarker(triage.ledger), 'TC maintenance ledger');

    if (triage.bounced.length > 0) {
        return bouncePathResult(triage, params, ctx);
    }
    return routePathResult(triage, params, ctx);
}

/** The bug ticket's issue type ('Story' when the run carries no type). */
function bugIssueTypeOf(params) {
    return ((params.ticket && params.ticket.fields &&
        params.ticket.fields.issuetype && params.ticket.fields.issuetype.name) || 'Story');
}

function failedResultsOf(result) {
    return (result.results || []).filter(function(r) {
        return r.status === 'failed';
    });
}

/**
 * The bug-run gate for the gh-1331 cross-lap bookkeeping: bugs only, and
 * never the blocked_by_human lane (missing setup is environment/ops
 * territory — the blocked gate owns it downstream). EVERY bookkeeping-worthy
 * bug lap qualifies — failed laps triage (the failed-count check rides the
 * dispatch in handleBugWithProductFailure), all-green laps reconcile.
 */
function isBookkeepableBugRun(params, result, ctx) {
    if (bugIssueTypeOf(params) !== ctx.jiraConfig.issueTypes.BUG) return false;
    return (result.overall || '').toLowerCase() !== 'blocked_by_human';
}

/**
 * Routed AND escalated findings get the same human surface on every route.
 */
function routedAndEscalated(triage) {
    return triage.routed.concat(triage.escalated);
}

/**
 * gh-1345: a parked differential rerun request is dispatcher work — the
 * scripted SM job (tcDifferentialDispatcher) picks the bug up by this label
 * on the next tick, runs the TC on the last-green build and resolves the
 * request. Best effort: a tracker hiccup only warns.
 */
function parkDifferentialLabelQuietly(storyKey) {
    try {
        getTracker().addLabel(storyKey, tcMaintenanceLedger.PARK_LABEL);
        console.log('✅ Parked differential request — labeled', storyKey, 'with', tcMaintenanceLedger.PARK_LABEL);
    } catch (e) {
        console.warn('Failed to add the differential park label (non-fatal):', e);
    }
}

function differentialRequested(triage) {
    return (triage.routed || []).some(function(v) {
        return v.action === tcTriage.ACTION_DIFFERENTIAL;
    });
}

function digestSections(triage) {
    // gh-1331: a fresh contradictory pair escalates FIRST — the owner surface
    // leads the digest, one comment per pair (records never re-escalate).
    var sections = (triage.newConflicts || []).map(function(record) {
        return tcAlternation.buildConflictComment(record);
    });
    if (triage.routed.length > 0) sections.push(tcTriage.buildTriageComment(triage.routed));
    if (triage.escalated.length > 0) sections.push(tcTriage.buildEscalationComment(triage.escalated));
    if (triage.schemaGapHint) sections.push(triage.schemaGapHint);
    if (sections.length > 0) sections.push(tcMaintenanceLedger.buildDigestComment(triage.ledger));
    return sections;
}

/**
 * The triage digest: posted on EVERY route (mixed bounce+route runs
 * included) so every attributed finding gets the same human surface.
 */
function postTriageDigest(triage, ctx) {
    var sections = digestSections(triage);
    if (sections.length === 0) {
        console.log('All failed TCs resolved as transient (retry green) — nothing routed');
        return;
    }
    try {
        getTracker().postComment(ctx.storyKey, sections.join('\n\n'));
        console.log('✅ Posted triage digest for', ctx.storyKey);
    } catch (e) {
        console.warn('Failed to post triage digest (non-fatal):', e);
    }
}

/**
 * The earned-bounce route: finalize the bounced TCs as Failed, return the
 * bug to development with the attribution evidence, and STILL stage +
 * digest the routed/escalated findings of the same run.
 */
function bouncePathResult(triage, params, ctx) {
    var bouncedEntries = triage.bounced.map(function(b) { return b.entry; });
    var bouncedVerdicts = triage.bounced.map(function(b) { return b.verdict; });
    finalizeFailedBugTestCases(bouncedEntries, ctx.workingDir, ctx.storyKey, ctx.config, ctx.jiraConfig);
    returnBugToDevelopment(ctx.storyKey, bouncedEntries, ctx.statuses, bouncedVerdicts);
    stageRoutedBugTestCases(routedAndEscalated(triage), ctx.workingDir, ctx.storyKey, ctx.config);
    postTriageDigest(triage, ctx);
    removeAutomationLabels(ctx.storyKey, params);
    if (differentialRequested(triage)) parkDifferentialLabelQuietly(ctx.storyKey);
    return {
        success: true,
        status: 'failed',
        storyKey: ctx.storyKey,
        failedTestCases: bouncedEntries.map(function(r) { return r.testCaseKey; }),
        escalatedTestCases: triage.escalated.map(function(v) { return v.tcKey; })
    };
}

/**
 * Test-side routes: the bug state is unchanged. Stage the TCs (In
 * Review - Failed + attached evidence) and surface the async digest.
 */
function routePathResult(triage, params, ctx) {
    stageRoutedBugTestCases(routedAndEscalated(triage), ctx.workingDir, ctx.storyKey, ctx.config);
    postTriageDigest(triage, ctx);
    if (differentialRequested(triage)) parkDifferentialLabelQuietly(ctx.storyKey);
    removeAutomationLabels(ctx.storyKey, params);
    return {
        success: true,
        status: 'test_maintenance',
        storyKey: ctx.storyKey,
        maintenanceTestCases: triage.routed.map(function(v) { return v.tcKey; }),
        escalatedTestCases: triage.escalated.map(function(v) { return v.tcKey; })
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
