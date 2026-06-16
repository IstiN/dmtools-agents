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
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var autoStart = require('./common/autoStart.js');
const { GIT_CONFIG, STATUSES, LABELS, JIRA_FIELDS, resolveStatuses } = require('./config.js');
var outputFiles = require('./common/outputFiles.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

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
        var results = jira_search_by_jql({ jql: jql, maxResults: 100, fields: ['key'] });
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

function readAttempt(markerPath) {
    try {
        var raw = file_read({ path: markerPath });
        var value = parseInt(raw || '0', 10);
        return isNaN(value) ? 0 : value;
    } catch (e) {
        return 0;
    }
}

function writeAttempt(markerPath, attempt) {
    try {
        file_write({ path: markerPath, content: String(attempt) });
    } catch (e) {
        console.warn('Could not write resume attempt marker:', e);
    }
}

function attemptResumeIfOutputsIncomplete(storyKey, result, linkedTestCases, workingDir) {
    var missingKeys = getMissingTestCaseKeys(result, linkedTestCases);
    if (missingKeys.length === 0) {
        return { attempted: false, reason: 'complete' };
    }

    var attempt = readAttempt(RESUME_MARKER);
    var maxAttempts = 2;
    if (attempt >= maxAttempts) {
        console.warn('Story test resume attempts exhausted (' + attempt + '/' + maxAttempts + '). Missing TCs:', missingKeys.join(', '));
        return { attempted: false, reason: 'attempts-exhausted', missingKeys: missingKeys };
    }

    attempt += 1;
    writeAttempt(RESUME_MARKER, attempt);

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

    var prompt = 'RESUME TASK: The previous story test automation run did not verify all linked Test Cases.\n\n' +
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

    var promptPath = 'outputs/.story-test-resume-prompt.md';
    try {
        file_write({ path: promptPath, content: prompt });
    } catch (e) {
        console.error('Failed to write story test resume prompt:', e);
        return { attempted: false, reason: 'write-failed', missingKeys: missingKeys };
    }

    var command = 'bash agents/scripts/run-agent.sh --continue --resume ' + promptPath;
    console.log('Story test output incomplete — resuming agent for missing TCs (attempt ' + attempt + '/' + maxAttempts + '):', missingKeys.join(', '));
    try {
        var output = runInRepo(command, workingDir);
        console.log('Resume run output:', String(output || '').substring(0, 500));
    } catch (e) {
        console.warn('Story test resume run failed:', e);
    }

    return { attempted: true, attempt: attempt, missingKeys: missingKeys };
}

function markdownToJiraWiki(markdown) {
    if (!markdown) return '';
    var text = String(markdown);
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, function(_, language, code) {
        return '{code' + (language ? ':' + language : '') + '}\n' + code.trim() + '\n{code}';
    });
    text = text
        .replace(/^####\s+(.+)$/gm, 'h4. $1')
        .replace(/^###\s+(.+)$/gm, 'h3. $1')
        .replace(/^##\s+(.+)$/gm, 'h2. $1')
        .replace(/^#\s+(.+)$/gm, 'h1. $1')
        .replace(/^\s*-\s+/gm, '* ')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/`([^`\n]+)`/g, '{{$1}}')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '[$1|$2]');
    return text.trim();
}

function readJiraComment(params, workingDir, storyKey) {
    var jiraComment = readOutputFile('tracker_comment.md', workingDir, storyKey);
    if (jiraComment) return jiraComment;

    jiraComment = readOutputFile('comment.md', workingDir, storyKey);
    if (jiraComment) return jiraComment;

    jiraComment = readOutputFile('jira_comment.md', workingDir, storyKey);
    if (jiraComment) return jiraComment;

    return markdownToJiraWiki(params.response || readOutputFile('response.md', workingDir, storyKey) || '');
}

function runInRepo(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function fetchRemoteBranch(branchName, workingDir) {
    try {
        runInRepo('git fetch origin ' + branchName, workingDir);
        return true;
    } catch (e) {
        console.warn('Could not fetch remote branch origin/' + branchName + ':', e);
        return false;
    }
}

function revParse(ref, workingDir) {
    try {
        return cleanCommandOutput(runInRepo('git rev-parse ' + ref, workingDir) || '').trim();
    } catch (e) {
        return '';
    }
}

function findMergeBase(left, right, workingDir) {
    try {
        return cleanCommandOutput(runInRepo('git merge-base ' + left + ' ' + right, workingDir) || '').trim();
    } catch (e) {
        return '';
    }
}

function publishExistingBranch(branchName, workingDir) {
    // Ensure the local remote-tracking ref is fresh before any push decision.
    fetchRemoteBranch(branchName, workingDir);

    var localSha = revParse('HEAD', workingDir);
    var remoteSha = revParse('origin/' + branchName, workingDir);

    if (localSha && remoteSha && localSha === remoteSha) {
        console.log('Local branch already matches origin/' + branchName + '; no push needed');
        return { success: true, noNewCommit: true };
    }

    var mergeBase = (localSha && remoteSha) ? findMergeBase('HEAD', 'origin/' + branchName, workingDir) : '';

    if (mergeBase === remoteSha && mergeBase !== localSha) {
        // Local is strictly ahead of remote (fast-forward).
        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
            return { success: true, noNewCommit: true };
        } catch (e) {
            console.warn('Fast-forward push failed:', e);
        }
    } else if (mergeBase === localSha && mergeBase !== remoteSha) {
        // Remote moved ahead while we had no local changes to keep. Adopt remote state.
        console.log('Remote ' + branchName + ' is ahead of local branch; resetting to origin/' + branchName);
        runInRepo('git reset --hard origin/' + branchName, workingDir);
        return { success: true, noNewCommit: true };
    }

    // Branches diverged or no remote yet; fall back to push with refreshed lease.
    try {
        runInRepo('git push -u origin ' + branchName, workingDir);
        return { success: true, noNewCommit: true };
    } catch (pushErr) {
        console.log('Normal push failed, retrying with --force-with-lease...');
        try {
            runInRepo('git push -u origin ' + branchName + ' --force-with-lease', workingDir);
            return { success: true, noNewCommit: true };
        } catch (forcePushErr) {
            console.warn('Failed to publish existing branch:', forcePushErr);
            return { success: false, error: 'No test files were written and the synced branch could not be pushed' };
        }
    }
}

function performGitOperations(branchName, commitMessage, workingDir, testFilesPath) {
    var addPath = testFilesPath || 'testing/';
    var inspectPath = addPath.replace(/\/$/, '') || '.';
    try {
        try {
            var lsOutput = runInRepo('git status --short -- ' + inspectPath, workingDir) || '';
            console.log('Git status for ' + inspectPath + ':', cleanCommandOutput(lsOutput) || '(empty)');
        } catch (e) {
            console.warn('Could not list ' + inspectPath + ':', e);
        }

        console.log('Staging test path:', addPath);
        runInRepo('git add ' + addPath, workingDir);

        var stagedOutput = cleanCommandOutput(runInRepo('git diff --cached --stat', workingDir) || '');
        console.log('Staged changes:', stagedOutput || '(none)');

        if (!stagedOutput || !stagedOutput.trim()) {
            console.warn('No new staged changes in ' + addPath + ' (files may already exist on branch)');
            var remoteBranchCheck = cleanCommandOutput(
                runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || ''
            );
            if (!remoteBranchCheck.trim()) {
                console.log('No remote branch found, pushing current branch state...');
                try {
                    runInRepo('git push -u origin ' + branchName, workingDir);
                } catch (pushErr) {
                    console.warn('Failed to push branch:', pushErr);
                    return { success: false, error: 'No test files were written and could not push branch' };
                }
            } else {
                var publishResult = publishExistingBranch(branchName, workingDir);
                if (!publishResult.success) {
                    return publishResult;
                }
            }
            return { success: true, branchName: branchName, noNewCommit: true };
        }

        console.log('Committing...');
        runInRepo('git commit -m "' + commitMessage.replace(/"/g, '\\"') + '"', workingDir);

        console.log('Pushing to remote...');
        fetchRemoteBranch(branchName, workingDir);
        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
        } catch (e) {
            console.log('Normal push failed, retrying with --force-with-lease...');
            try {
                runInRepo('git push -u origin ' + branchName + ' --force-with-lease', workingDir);
            } catch (leaseErr) {
                console.log('Force-with-lease push failed, force pushing...');
                runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
            }
        }

        const remoteBranch = cleanCommandOutput(
            runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || ''
        );
        if (!remoteBranch.trim()) {
            throw new Error('Branch not found on remote after push');
        }

        console.log('✅ Git operations completed');
        return { success: true, branchName: branchName };

    } catch (error) {
        console.error('Git operations failed:', error);
        return { success: false, error: error.toString() };
    }
}

function createPullRequest(title, branchName, baseBranch, workingDir, scm) {
    console.log('Creating Pull Request...');
    return prHelper.createPullRequest({
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        scm: scm,
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
        jira_attach_file_to_ticket({
            ticketKey: tcKey,
            name: name,
            filePath: filePath,
            contentType: 'text/markdown'
        });
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
        jira_update_field({ key: tcKey, field: fieldName, value: value });
        console.log('✅ Updated Failed Reason field for', tcKey);
    } catch (e) {
        console.warn('Failed to update Failed Reason field for', tcKey, ':', e);
    }
}

function updateTestCaseStatus(tcKey, status, workingDir, storyKey, config) {
    try {
        var targetStatus = status === 'passed' ? STATUSES.IN_REVIEW_PASSED : STATUSES.IN_REVIEW_FAILED;
        jira_move_to_status({ key: tcKey, statusName: targetStatus });
        console.log('✅ Moved', tcKey, 'to', targetStatus);

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

function finalizeTestCaseStatus(tcKey, status) {
    try {
        var targetStatus = status === 'passed' ? STATUSES.PASSED : STATUSES.FAILED;
        jira_move_to_status({ key: tcKey, statusName: targetStatus });
        console.log('✅ Finalized', tcKey, 'to', targetStatus, '(no code changes)');
    } catch (e) {
        console.warn('Failed to finalize Test Case', tcKey, ':', e);
    }
}

function moveSkippedTcToStatus(tcKey, skippedStatus) {
    try {
        jira_move_to_status({ key: tcKey, statusName: skippedStatus });
        console.log('✅ Moved', tcKey, 'to', skippedStatus, '(skipped)');
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
        jira_move_to_status({ key: tcKey, statusName: irrelevantStatus });
        console.log('✅ Moved', tcKey, 'to', irrelevantStatus, '(irrelevant)');
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
    try {
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : 'story_test_automation_wip';
        jira_remove_label({ key: storyKey, label: wipLabel });
    } catch (e) {}

    try {
        const smTriggerLabel = params.jobParams && params.jobParams.customParams && params.jobParams.customParams.removeLabel;
        if (smTriggerLabel) {
            jira_remove_label({ key: storyKey, label: smTriggerLabel });
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        }
    } catch (e) {}
}

function action(params) {
    try {
        const storyKey = params.ticket.key;
        const storySummary = params.ticket.fields ? params.ticket.fields.summary : storyKey;
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = (params.jobParams || params).customParams || {};
        var statuses = resolveStatuses(customParams);
        var scm = configLoader.createScm(config);
        var workingDir = config.workingDir || null;
        var testFilesPath = customParams.testFilesGlob || 'testing/';
        const jiraComment = readJiraComment(params, workingDir, storyKey);

        console.log('=== Processing story test automation results for', storyKey, '===');

        // Step 1: Read structured result and ensure all linked Test Cases were checked
        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var testCaseType = (projectConfig.jira && projectConfig.jira.issueTypes && projectConfig.jira.issueTypes.TEST_CASE) || 'Test Case';
        var linkedTestCases = readLinkedTestCases(storyKey, testCaseType);

        var result = readResultJson(workingDir, storyKey);
        var resumeInfo = null;
        if (linkedTestCases.length > 0) {
            resumeInfo = attemptResumeIfOutputsIncomplete(storyKey, result, linkedTestCases, workingDir);
            if (resumeInfo.attempted) {
                result = readResultJson(workingDir, storyKey);
            }
        }

        if (!result) {
            var commentMsg = 'h3. ⚠️ Story Test Automation Error\n\nCLI exited without producing result JSON. The Story will stay in Ready For Testing so SM can retry.';
            jira_post_comment({ key: storyKey, comment: commentMsg });
            removeAutomationLabels(storyKey, params);
            return { success: false, error: 'No story test result JSON found' };
        }

        var stillMissingKeys = getMissingTestCaseKeys(result, linkedTestCases);
        if (stillMissingKeys.length > 0) {
            console.warn('Linked Test Cases still missing from result after resume:', stillMissingKeys.join(', '));
            var missingComment = 'h3. ⚠️ Story Test Automation Incomplete\n\n' +
                'The automation could not verify all linked Test Cases. Missing results for:\n\n' +
                stillMissingKeys.map(function(k) { return '* ' + k; }).join('\n') + '\n\n' +
                'The Story will stay in Ready For Testing so SM can retry.';
            jira_post_comment({ key: storyKey, comment: missingComment });
            removeAutomationLabels(storyKey, params);
            return { success: false, error: 'Missing Test Case results: ' + stillMissingKeys.join(', ') };
        }

        const overall = (result.overall || '').toLowerCase();
        const blockedByHuman = overall === 'blocked_by_human';

        // Step 2: Configure git author
        try {
            runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
            runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
        } catch (e) {
            console.warn('Failed to configure git author:', e);
        }

        // Step 3: Read current branch
        var rawBranch = runInRepo('git branch --show-current', workingDir) || '';
        const branchName = cleanCommandOutput(rawBranch);
        console.log('Cleaned branch name:', JSON.stringify(branchName));

        // Step 4: Commit + push + create PR
        let prUrl = null;
        let noCodeChanges = false;
        if (branchName) {
            const commitMessage = configLoader.formatTemplate(config.formats.commitMessage.testAutomation, {ticketKey: storyKey, ticketSummary: storySummary});
            const gitResult = performGitOperations(branchName, commitMessage, workingDir, testFilesPath);

            if (gitResult.success && !gitResult.noNewCommit) {
                const prTitle = configLoader.formatTemplate(config.formats.prTitle.testAutomation, {ticketKey: storyKey, ticketSummary: storySummary});
                const prResult = createPullRequest(prTitle, branchName, config.git.baseBranch, workingDir, scm);
                prUrl = prResult.prUrl;
                if (!prResult.success || !prUrl) {
                    console.error('PR creation failed');
                    jira_post_comment({ key: storyKey, comment: 'h3. ⚠️ PR Creation Failed\n\nTest code was pushed to branch {code}' + branchName + '{code} but the Pull Request could not be created.' });
                    removeAutomationLabels(storyKey, params);
                    return { success: false, error: 'PR creation failed' };
                }
            } else if (gitResult.noNewCommit) {
                noCodeChanges = true;
                console.log('ℹ️ No test code changes — skipping PR review, moving Story directly');
            } else {
                console.warn('Git operations failed:', gitResult.error);
                jira_post_comment({ key: storyKey, comment: 'h3. ⚠️ Git Operations Failed\n\n' + gitResult.error });
                removeAutomationLabels(storyKey, params);
                return { success: false, error: 'Git operations failed: ' + gitResult.error };
            }
        }

        // Step 5: Post Story Jira comment
        try {
            let comment = jiraComment || '';
            if (prUrl) {
                comment += '\n\n*Story Test Branch PR*: ' + prUrl;
            }
            if (noCodeChanges) {
                comment += '\n\nℹ️ _Test code unchanged from previous run._';
            }
            if (comment) {
                jira_post_comment({ key: storyKey, comment: comment });
                console.log('✅ Posted story test result comment to Jira');
            }
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 6: Handle blocked_by_human
        if (blockedByHuman) {
            var blockedComment = 'h3. 🚫 Story Test Automation Blocked — Awaiting Human Setup\n\n' +
                (result.blockedReason || 'Missing credentials or test data.') + '\n\n' +
                'Once setup is complete, move this Story back to *Ready For Testing* to trigger re-run.';
            try {
                jira_post_comment({ key: storyKey, comment: blockedComment });
                jira_move_to_status({ key: storyKey, statusName: STATUSES.BLOCKED });
                console.log('✅ Blocked — moved', storyKey, 'to', STATUSES.BLOCKED);
            } catch (e) {
                console.warn('Failed to handle blocked story:', e);
            }
            removeAutomationLabels(storyKey, params);
            return { success: true, status: 'blocked_by_human', storyKey: storyKey };
        }

        // Step 7: Update per-Test Case statuses
        if (result.results && result.results.length > 0) {
            result.results.forEach(function(item) {
                if (item.status === 'passed' || item.status === 'failed') {
                    updateTestCaseStatus(item.testCaseKey, item.status, workingDir, storyKey, config);
                    // When there are no test code changes we skip the PR/review/merge flow,
                    // so we must finalize TC statuses immediately so story_done_check can act.
                    if (noCodeChanges) {
                        finalizeTestCaseStatus(item.testCaseKey, item.status);
                    }
                } else if (item.status === 'skipped') {
                    // Skipped tests are final — no PR/review needed.
                    moveSkippedTcToStatus(item.testCaseKey, statuses.SKIPPED || 'Skipped');
                } else if (item.status === 'irrelevant') {
                    // Legacy/no-longer-applicable tests are final; delete their test code.
                    moveIrrelevantTcToStatus(item.testCaseKey, statuses.IRRELEVANT || 'Irrelevant', testFilesPath, workingDir);
                } else {
                    console.log('Skipping status update for', item.testCaseKey, '— status:', item.status);
                }
            });
        }

        // Step 8: Move Story to In Testing
        try {
            jira_move_to_status({ key: storyKey, statusName: STATUSES.IN_TESTING });
            console.log('✅ Moved Story', storyKey, 'to', STATUSES.IN_TESTING);
        } catch (e) {
            console.warn('Failed to move Story to In Testing:', e);
        }

        // Step 9: Trigger review
        if (!blockedByHuman) {
            if (!autoStartStoryTestReview(storyKey, config, customParams, noCodeChanges)) {
                autoStart.triggerSmIfIdle({ config: config, customParams: customParams });
            }
        }

        // Step 10: Labels cleanup
        removeAutomationLabels(storyKey, params);
        try {
            jira_add_label({ key: storyKey, label: LABELS.AI_TEST_AUTOMATION });
        } catch (e) {
            console.warn('Failed to add ai_test_automation label:', e);
        }

        // Step 11: Token usage comments
        try {
            tokenUsageComment.postTokenUsageComments(storyKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            status: overall,
            storyKey: storyKey,
            prUrl: prUrl
        };

    } catch (error) {
        console.error('❌ Error in postStoryTestAutomationResults:', error);
        try {
            jira_post_comment({
                key: params.ticket.key,
                comment: 'h3. ❌ Story Test Automation Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        removeAutomationLabels(params.ticket.key, params);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
