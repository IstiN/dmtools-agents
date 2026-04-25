/**
 * Post Mobile Test Automation Results (generic postJSAction)
 *
 * Designed for story/bug trigger tickets that run mobile automated tests.
 * Handles git operations on the test automation repo, creates the automation PR,
 * labels and updates the feature PR, and posts results to Jira.
 *
 * Steps:
 * 1. Read outputs/test_automation_result.json
 * 2. Commit + push test files in the automation repo (src/tests/)
 * 3. Create or find PR in the test automation repository
 * 4. Find the feature PR in the main app repository (by trigger ticket key)
 * 5. Add configurable pass/fail labels to the feature PR (via dmtools github_add_pr_label)
 * 6. Append test summary to the feature PR description (via gh pr edit)
 * 7. Post Jira comment on the trigger ticket
 * 8. Move trigger ticket status (Passed / Failed / Blocked)
 * 9. Remove WIP and SM trigger labels
 *
 * Configuration (via customParams):
 *   targetRepository.workingDir   — path to test automation repo (required)
 *   targetRepository.baseBranch   — base branch (default: main)
 *   featurePR.owner               — GitHub owner for the feature repo (required)
 *   featurePR.repo                — GitHub repo name for the feature repo (required)
 *   labels.testsPassed            — label to add on pass (default: tests_passed)
 *   labels.testsFailed            — label to add on fail (default: tests_failed)
 *   testFilesGlob                 — git add path for test files (default: src/tests/)
 *   removeLabel                   — SM trigger label to remove after completion
 */

var configLoader = require('./configLoader.js');
const { STATUSES, LABELS } = require('./config.js');

function parseMcpResult(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function readFile(path) {
    try {
        var content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        console.warn('Could not read file ' + path + ':', e);
        return null;
    }
}

/** Read a file from outputs/, falling back to {workingDir}/outputs/ if not found at workspace root. */
function readOutputFile(relativePath, workingDir) {
    var content = readFile(relativePath);
    if (content) return content;
    if (workingDir) {
        content = readFile(workingDir + '/' + relativePath);
        if (content) {
            console.log('Read from fallback path:', workingDir + '/' + relativePath);
            return content;
        }
    }
    return null;
}

function readResultJson(workingDir) {
    var raw = readOutputFile('outputs/test_automation_result.json', workingDir);
    if (!raw) {
        console.warn('test_automation_result.json not found in outputs/ or ' + (workingDir || 'no') + '/outputs/');
        return null;
    }
    try {
        var parsed = JSON.parse(raw);
        console.log('✅ Read test result — status:', parsed.status);
        return parsed;
    } catch (e) {
        console.error('Failed to parse test_automation_result.json:', e);
        return null;
    }
}

/** Run a command inside the automation repo directory. */
function runInRepo(command, workingDir) {
    return cli_execute_command({ command: command, workingDirectory: workingDir });
}

/** Sanitize text for use in shell commands (git commit -m, gh pr create --title).
 *  CliCommandExecutor rejects commands containing shell metacharacters: ; \n \r ` $() ${} && || | > <
 *  Jira titles often contain -> (arrows), <angle brackets>, etc.  */
function sanitizeForShell(text) {
    return (text || '')
        .replace(/->/g, '→').replace(/<-/g, '←')
        .replace(/[<>|&;$`]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Commit + push test files in the automation repo. */
function performGitOperations(branchName, commitMessage, workingDir, testFilesPath) {
    var addPath = testFilesPath || 'src/tests/';
    try {
        runInRepo('git add ' + addPath, workingDir);

        var stagedOutput = cleanCommandOutput(
            runInRepo('git diff --cached --stat', workingDir) || ''
        );
        console.log('Staged changes:', stagedOutput || '(none)');

        if (!stagedOutput || !stagedOutput.trim()) {
            console.warn('No new staged changes in', addPath);
            // Ensure branch exists on remote so PR can be created/found
            var remoteBranchCheck = cleanCommandOutput(
                runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || ''
            );
            if (!remoteBranchCheck.trim()) {
                runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
            }
            return { success: true, branchName: branchName, noNewCommit: true };
        }

        runInRepo('git commit -m "' + commitMessage.replace(/"/g, '\\"') + '"', workingDir);

        try {
            runInRepo('git push -u origin ' + branchName, workingDir);
        } catch (e) {
            runInRepo('git push -u origin ' + branchName + ' --force', workingDir);
        }

        console.log('✅ Git operations completed');
        return { success: true, branchName: branchName };

    } catch (error) {
        console.error('Git operations failed:', error);
        return { success: false, error: error.toString() };
    }
}

/** Create PR in the automation repo (or find existing). */
function createAutomationPR(title, branchName, baseBranch, workingDir) {
    try {
        var escapedTitle = title.replace(/"/g, '\\"').replace(/\n/g, ' ');
        var prBody = readOutputFile('outputs/pr_body.md', workingDir)
                  || readOutputFile('outputs/response.md', workingDir)
                  || 'Automated test flows';
        // Write body to a temp file in the automation repo dir to avoid path issues
        var bodyTempPath = workingDir + '/pr_body_tmp.md';
        file_write(bodyTempPath, prBody);

        var output = cleanCommandOutput(
            runInRepo(
                'gh pr create --title "' + escapedTitle + '" --body-file pr_body_tmp.md --base ' + baseBranch + ' --head ' + branchName,
                workingDir
            ) || ''
        );

        // Clean up temp file
        try { runInRepo('git checkout -- pr_body_tmp.md', workingDir); } catch (_) {}

        var prUrl = null;
        var urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
        if (urlMatch) prUrl = urlMatch[0];

        if (!prUrl) {
            var listOutput = cleanCommandOutput(
                runInRepo('gh pr list --head ' + branchName + ' --json url --jq ".[0].url"', workingDir) || ''
            );
            if (listOutput && listOutput.startsWith('https://')) prUrl = listOutput;
        }

        console.log('✅ Automation PR:', prUrl || '(URL not found)');
        return { success: true, prUrl: prUrl };

    } catch (error) {
        console.error('Failed to create automation PR:', error);
        return { success: false, error: error.toString() };
    }
}

/**
 * Find the feature PR in the main app repo by trigger ticket key.
 * Uses dmtools github_list_prs — filters by title or head branch containing ticketKey.
 */
function findFeaturePR(ticketKey, owner, repo) {
    try {
        var raw = github_list_prs({ workspace: owner, repository: repo, state: 'open' });
        var parsed = parseMcpResult(raw);
        var prs = Array.isArray(parsed) ? parsed : (parsed && parsed.data ? parsed.data : []);

        if (!prs || prs.length === 0) {
            console.log('No open PRs found in', owner + '/' + repo);
            return null;
        }

        for (var i = 0; i < prs.length; i++) {
            var pr = prs[i];
            var prTitle = pr.title || '';
            var prBranch = (pr.head && pr.head.ref) || '';
            if (prTitle.indexOf(ticketKey) !== -1 || prBranch.indexOf(ticketKey) !== -1) {
                console.log('✅ Found feature PR #' + pr.number + ': ' + prTitle + ' (' + prBranch + ')');
                return pr;
            }
        }

        console.log('No feature PR found matching', ticketKey, 'in', owner + '/' + repo);
        return null;
    } catch (e) {
        console.warn('Failed to find feature PR:', e);
        return null;
    }
}

/** Add the appropriate result label to the feature PR, removing the opposite one. */
function updateFeaturePRLabel(owner, repo, prNumber, passed, labelPassed, labelFailed) {
    var addLabel = passed ? labelPassed : labelFailed;
    var removeLabel = passed ? labelFailed : labelPassed;

    try {
        try {
            github_remove_pr_label({ workspace: owner, repository: repo, pullRequestId: String(prNumber), label: removeLabel });
        } catch (_) {}

        github_add_pr_label({ workspace: owner, repository: repo, pullRequestId: String(prNumber), label: addLabel });
        console.log('✅ Added label "' + addLabel + '" to feature PR #' + prNumber);
    } catch (e) {
        console.warn('Failed to update feature PR label:', e);
    }
}

/** Post test result summary as a comment on the feature PR. */
function updateFeaturePRBody(owner, repo, prNumber, workingDir) {
    var summaryFile = readOutputFile('outputs/pr_feature_update.md', workingDir);
    if (!summaryFile) {
        // Fallback: use pr_body.md (automation PR description) which has the same test results
        summaryFile = readOutputFile('outputs/pr_body.md', workingDir);
        if (summaryFile) {
            console.log('No outputs/pr_feature_update.md — falling back to outputs/pr_body.md');
        }
    }
    if (!summaryFile) {
        console.log('No outputs/pr_feature_update.md or pr_body.md — skipping feature PR comment');
        return;
    }

    try {
        github_add_pr_comment({
            workspace: owner,
            repository: repo,
            pullRequestId: String(prNumber),
            text: summaryFile
        });
        console.log('✅ Posted test summary as PR comment on feature PR #' + prNumber);
    } catch (e) {
        console.warn('Failed to post PR comment:', e);
    }
}

/** Build a Jira-formatted comment with per-TC table. */
function buildJiraComment(result, automationPrUrl) {
    var status = (result.status || '').toLowerCase();
    var header = status === 'passed'
        ? 'h3. ✅ Mobile Test Automation — All Tests Passed'
        : status === 'blocked_by_human'
        ? 'h3. 🚫 Mobile Test Automation — Blocked'
        : 'h3. ❌ Mobile Test Automation — Tests Failed';

    var lines = [header, '', '*Summary*: ' + (result.summary || result.status) + '\n'];

    var results = result.results || [];
    if (results.length > 0) {
        lines.push('||Test Case||Title||Status||');
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            var icon = r.status === 'passed' ? '✅' : '❌';
            var notes = r.error ? ' — ' + r.error.substring(0, 200) : '';
            lines.push('|' + r.ticket + '|' + (r.title || '') + '|' + icon + ' ' + r.status + notes + '|');
        }
    }

    if (automationPrUrl) {
        lines.push('', '*Automation PR*: ' + automationPrUrl);
    }

    return lines.join('\n');
}

function removeWipLabel(params, ticketKey) {
    var wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip'
        : 'mobile_test_automation_wip';
    try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
}

function removeSMTriggerLabel(params, ticketKey) {
    if (!ticketKey) return;
    var customParams = (params.jobParams || params).customParams || {};
    var smTriggerLabel = customParams.removeLabel;
    if (smTriggerLabel) {
        try {
            jira_remove_label({ key: ticketKey, label: smTriggerLabel });
            console.log('✅ Removed SM trigger label:', smTriggerLabel);
        } catch (e) {}
    }
}

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var ticketSummary = params.ticket.fields ? params.ticket.fields.summary : ticketKey;
        var jiraComment = params.response || '';
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var workingDir = config.workingDir;

        var customParams = (params.jobParams || params).customParams || {};
        var featurePRConfig = customParams.featurePR || {};
        var featureOwner = featurePRConfig.owner || '';
        var featureRepo = featurePRConfig.repo || '';

        var labelsConfig = customParams.labels || {};
        var labelPassed = labelsConfig.testsPassed || 'tests_passed';
        var labelFailed = labelsConfig.testsFailed || 'tests_failed';
        var testFilesPath = customParams.testFilesGlob || 'src/tests/';

        console.log('=== Processing mobile test automation results for', ticketKey, '===');

        // Step 1: Configure git author in automation repo
        if (workingDir) {
            try {
                runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
                runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
            } catch (e) {
                console.warn('Failed to configure git author:', e);
            }
        }

        // Step 2: Get current branch in automation repo
        var branchName = null;
        if (workingDir) {
            var rawBranch = runInRepo('git branch --show-current', workingDir) || '';
            branchName = cleanCommandOutput(rawBranch);
            console.log('Automation repo branch:', JSON.stringify(branchName));
        }

        // Step 3: Commit + push + create automation PR (ALWAYS — don't lose agent's work)
        var automationPrUrl = null;
        if (branchName && workingDir) {
            var commitMessage = sanitizeForShell(ticketKey + ' test: automate ' + ticketSummary);
            var gitResult = performGitOperations(branchName, commitMessage, workingDir, testFilesPath);

            if (gitResult.success) {
                var prTitle = sanitizeForShell(ticketKey + ' ' + ticketSummary);
                var prResult = createAutomationPR(prTitle, branchName, config.git.baseBranch, workingDir);
                automationPrUrl = prResult.prUrl;
            } else {
                console.warn('Git operations failed:', gitResult.error);
            }
        }

        // Step 4: Read structured result (fallback: workspace root → automation repo outputs)
        var result = readResultJson(workingDir);
        if (!result) {
            console.warn('No test_automation_result.json found — posting error to Jira but keeping git work');
            try {
                var errMsg = 'h3. ⚠️ Test Automation Error\n\nFlows may have been written but output JSON is missing. Check workflow logs.';
                if (automationPrUrl) errMsg += '\n\n*Automation PR*: ' + automationPrUrl;
                jira_post_comment({ key: ticketKey, comment: errMsg });
            } catch (e) { console.warn('Failed to post error Jira comment:', e); }
            return { success: false, error: 'No test result JSON found', automationPrUrl: automationPrUrl };
        }

        var status = (result.status || '').toLowerCase();
        var blockedByHuman = status === 'blocked_by_human';

        // Check for a11y structural warnings — log but do NOT override test status.
        // A11y warnings are informational; Maestro tests that pass → tests_passed label.
        var hasA11yWarnings = false;
        if (result.results && Array.isArray(result.results)) {
            for (var i = 0; i < result.results.length; i++) {
                var tc = result.results[i];
                if (tc.a11y_warnings && Array.isArray(tc.a11y_warnings) && tc.a11y_warnings.length > 0) {
                    hasA11yWarnings = true;
                    break;
                }
            }
        }
        // Top-level a11y_warnings array
        if (!hasA11yWarnings && result.a11y_warnings && Array.isArray(result.a11y_warnings) && result.a11y_warnings.length > 0) {
            hasA11yWarnings = true;
        }

        var passed = status === 'passed';
        if (hasA11yWarnings && status === 'passed') {
            console.log('⚠️ Maestro tests passed with a11y structural warnings (informational — not overriding status)');
        }

        // Step 5: Find feature PR and update it
        if (featureOwner && featureRepo && !blockedByHuman) {
            var featurePR = findFeaturePR(ticketKey, featureOwner, featureRepo);
            if (featurePR) {
                updateFeaturePRLabel(featureOwner, featureRepo, featurePR.number, passed, labelPassed, labelFailed);
                // Inject automation PR URL into feature update markdown if present
                if (automationPrUrl) {
                    try {
                        var featureUpdateContent = readOutputFile('outputs/pr_feature_update.md', workingDir) || '';
                        if (featureUpdateContent && featureUpdateContent.indexOf(automationPrUrl) === -1) {
                            file_write('outputs/pr_feature_update.md',
                                featureUpdateContent + '\n> Automation PR: ' + automationPrUrl + '\n');
                        }
                    } catch (_) {}
                }
                updateFeaturePRBody(featureOwner, featureRepo, featurePR.number, workingDir);
            }
        }

        // Step 6: Post Jira comment
        try {
            var comment = jiraComment || buildJiraComment(result, automationPrUrl);
            if (automationPrUrl && comment.indexOf(automationPrUrl) === -1) {
                comment += '\n\n*Automation PR*: ' + automationPrUrl;
            }
            jira_post_comment({ key: ticketKey, comment: comment });
            console.log('✅ Posted Jira comment');
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 7: Handle blocked_by_human
        if (blockedByHuman) {
            var blockedComment = 'h3. 🚫 Test Automation Blocked — Awaiting Human Setup\n\n';
            if (result.blocked_reason) blockedComment += result.blocked_reason + '\n\n';
            if (result.missing && result.missing.length > 0) {
                blockedComment += 'h4. Required setup:\n\n';
                result.missing.forEach(function(item) {
                    blockedComment += '* *' + (item.name || '?') + '*';
                    if (item.description) blockedComment += ': ' + item.description;
                    blockedComment += '\n';
                });
            }
            blockedComment += '\nOnce setup is complete, move this ticket back to *Backlog* to trigger re-run.';
            try { jira_post_comment({ key: ticketKey, comment: blockedComment }); } catch (e) {}
            try { jira_move_to_status({ key: ticketKey, statusName: STATUSES.BLOCKED }); } catch (e) {}

            removeWipLabel(params, ticketKey);
            removeSMTriggerLabel(params, ticketKey);
            return { success: true, status: 'blocked_by_human', ticketKey: ticketKey };
        }

        // Step 8: Move ticket status
        try {
            var targetStatus = passed ? STATUSES.PASSED : STATUSES.FAILED;
            jira_move_to_status({ key: ticketKey, statusName: targetStatus });
            console.log('✅ Moved', ticketKey, 'to', targetStatus);
        } catch (e) {
            console.warn('Failed to move ticket status:', e);
        }

        // Step 9: Add AI label
        try {
            jira_add_label({ key: ticketKey, label: LABELS.AI_TEST_AUTOMATION });
        } catch (e) {
            console.warn('Failed to add AI label:', e);
        }

        removeWipLabel(params, ticketKey);
        removeSMTriggerLabel(params, ticketKey);

        console.log('✅ Mobile test automation workflow complete:', passed ? 'PASSED' : 'FAILED');

        return {
            success: true,
            status: result.status,
            ticketKey: ticketKey,
            automationPrUrl: automationPrUrl
        };

    } catch (error) {
        console.error('❌ Error in postMobileTestAutomationResults:', error);
        try {
            jira_post_comment({
                key: params.ticket.key,
                comment: 'h3. ❌ Test Automation Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        removeSMTriggerLabel(params, params.ticket && params.ticket.key);
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
