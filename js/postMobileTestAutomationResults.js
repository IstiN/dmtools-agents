/**
 * Post Mobile Test Automation Results (generic postJSAction)
 *
 * Designed for story/bug trigger tickets that run mobile automated tests.
 * Handles git operations on the test automation repo, creates the automation PR,
 * labels and updates the feature PR, and posts results to Jira.
 *
 * Steps:
 * 1. If mandatory output files are missing, attempt one resume run via run-agent.sh --continue --resume
 * 2. Read outputs/test_automation_result.json
 * 3. Commit + push test files in the automation repo (src/tests/)
 * 4. Create or find PR in the test automation repository
 * 5. Find the feature PR in the main app repository (by trigger ticket key)
 * 6. Add configurable pass/fail labels to the feature PR/MR
 * 7. Append test summary to the feature PR/MR as a comment
 * 8. Post Jira comment on the trigger ticket
 * 9. Move trigger ticket status (Passed / Failed / Blocked)
 * 10. Remove WIP and SM trigger labels
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
const { LABELS } = require('./config.js');
var prHelper = require('./common/pullRequest.js');
var outputFiles = require('./common/outputFiles.js');

/** Marker file path to prevent infinite resume loops. */
var RESUME_MARKER = 'outputs/.missing-output-resume-attempted';

function createScmCompat(config, owner, repo) {
    var scopedConfig = Object.assign({}, config || {});
    if (owner && repo) {
        scopedConfig.repository = { owner: owner, repo: repo };
    }
    try {
        return configLoader.createScm(scopedConfig);
    } catch (e) {
        console.warn('SCM abstraction unavailable, falling back to GitHub globals:', e.message || e);
        return {
            listPrs: function(state) {
                var raw = github_list_prs({ workspace: owner, repository: repo, state: state });
                var parsed = parseMcpResult(raw);
                return Array.isArray(parsed) ? parsed : (parsed && parsed.data ? parsed.data : []);
            },
            addLabel: function(prNumber, label) {
                return github_add_pr_label({ workspace: owner, repository: repo, pullRequestId: String(prNumber), label: label });
            },
            removeLabel: function(prNumber, label) {
                return github_remove_pr_label({ workspace: owner, repository: repo, pullRequestId: String(prNumber), label: label });
            },
            addComment: function(prNumber, text) {
                return github_add_pr_comment({ workspace: owner, repository: repo, pullRequestId: String(prNumber), text: text });
            }
        };
    }
}

/**
 * If mandatory output files are missing and a resume has not already been attempted,
 * run `run-agent.sh --continue --resume` with a targeted recovery prompt so the agent
 * writes outputs/test_automation_result.json, outputs/response.md, outputs/pr_body.md,
 * and outputs/pr_feature_update.md without rewriting the already-committed flows.
 *
 * Returns true if a resume was executed (caller should re-check outputs afterwards).
 * Returns false if outputs already exist, or a resume was already attempted.
 */
function attemptResumeIfOutputsMissing(ticketKey, workingDir) {
    var resultJson = readOutputFile('test_automation_result.json', workingDir, ticketKey);
    if (resultJson) {
        return false; // outputs present — no resume needed
    }

    // Guard against infinite loops
    var alreadyAttempted = readOutputFile(RESUME_MARKER, workingDir, ticketKey);
    if (alreadyAttempted) {
        console.warn('⚠️  Resume already attempted once — skipping second resume to avoid infinite loop');
        return false;
    }

    console.log('⚠️  Mandatory output files missing. Attempting resume run to write outputs…');

    // Write marker first so the resumed run cannot trigger another resume
    try {
        file_write(RESUME_MARKER, new Date().toISOString() + '\n');
    } catch (e) {
        console.warn('Could not write resume marker:', e);
    }

    var recoveryPrompt =
        'RESUME TASK: The previous automation run ended before writing the mandatory output files.\n\n' +
        'DO NOT rewrite or delete existing flows. Inspect git changes, app_info.md, and any Maestro run logs first.\n' +
        'If the generated suite has NOT been executed and app_info.md provides APP_PATH/MAESTRO_DEVICE,\n' +
        'run the generated suite once on the available simulator before writing results. Use the suite file\n' +
        'under src/flows/suites/ when present. Only mark flows as "written" when there is a real blocker\n' +
        'that prevents simulator execution, and explain that blocker in the summary.\n\n' +
        'Then write the four output files:\n\n' +
        '1. /Users/vagrant/git/outputs/test_automation_result.json\n' +
        '   Schema: { "status":"passed"|"failed", "passed":N, "failed":N, "skipped":N, "summary":"…",\n' +
        '     "results":[{ "ticket":"PROJ-XXXX", "status":"passed"|"failed"|"written"|"skipped",\n' +
        '       "title":"…", "file":"src/flows/…" }] }\n' +
        '   Mark any flow that was WRITTEN but not run as "status":"written" only when simulator execution was impossible.\n\n' +
        '2. /Users/vagrant/git/outputs/response.md\n' +
        '   Jira-flavoured markdown (h3 header, Jira table with || pipes) summarising per-TC results.\n\n' +
        '3. /Users/vagrant/git/outputs/pr_body.md\n' +
        '   GitHub-flavoured markdown version of response.md (| tables, **bold**).\n\n' +
        '4. /Users/vagrant/git/outputs/pr_feature_update.md\n' +
        '   Compact summary for the feature PR (same format as pr_body.md but shorter).\n\n' +
        'After writing all four files, verify they exist:\n' +
        '```bash\n' +
        'ls -la /Users/vagrant/git/outputs/\n' +
        'cat /Users/vagrant/git/outputs/test_automation_result.json\n' +
        '```\n\n' +
        'Do NOT log out or install the app unless app_info.md explicitly requires it.\n' +
        'Ticket: ' + ticketKey + '\n';

    var promptFile = 'outputs/.resume-prompt.md';
    try {
        file_write(promptFile, recoveryPrompt);
    } catch (e) {
        console.error('Failed to write resume prompt file:', e);
        return false;
    }

    try {
        var resumeResult = cli_execute_command({
            command: 'bash agents/scripts/run-agent.sh --continue --resume ' + promptFile
        });
        console.log('Resume run output:', (resumeResult || '').substring(0, 500));
        return true;
    } catch (e) {
        console.error('Resume run failed:', e);
        return false;
    }
}

function parseMcpResult(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

function readFile(path) {
    return outputFiles.readOutputFile(path, {});
}

/** Read an output file from normalized paths (root outputs, ticket subdir, and workingDir variants). */
function readOutputFile(relativePath, workingDir, ticketKey) {
    return outputFiles.readOutputFile(relativePath, {
        workingDir: workingDir,
        ticketKey: ticketKey
    });
}

function readResultJson(workingDir, ticketKey) {
    var raw = readOutputFile('test_automation_result.json', workingDir, ticketKey);
    if (!raw) {
        console.warn('test_automation_result.json not found in outputs/ or ' + (workingDir || 'no') + '/outputs/');
        return null;
    }
    try {
        var parsed = JSON.parse(raw);
        parsed = normalizeResult(parsed);
        console.log('✅ Read test result — status:', parsed.status);
        return parsed;
    } catch (e) {
        console.error('Failed to parse test_automation_result.json:', e);
        return null;
    }
}

function asNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    var n = parseInt(value, 10);
    return isNaN(n) ? null : n;
}

function firstNumber(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
        var value = asNumber(obj && obj[keys[i]]);
        if (value !== null) return value;
    }
    return null;
}

function getResultCounts(result) {
    var passed = firstNumber(result, ['passed', 'passedCount', 'passed_count', 'passedTests', 'passed_tests']);
    var failed = firstNumber(result, ['failed', 'failedCount', 'failed_count', 'failedTests', 'failed_tests']);
    var skipped = firstNumber(result, ['skipped', 'skippedCount', 'skipped_count', 'skippedTests', 'skipped_tests']);

    if (result && result.results && Array.isArray(result.results)) {
        var resultPassed = 0;
        var resultFailed = 0;
        var resultSkipped = 0;
        for (var i = 0; i < result.results.length; i++) {
            var status = String(result.results[i].status || '').toLowerCase();
            if (status === 'passed') resultPassed += 1;
            else if (status === 'skipped') resultSkipped += 1;
            else if (status === 'failed' || status === 'error') resultFailed += 1;
        }
        if (passed === null) passed = resultPassed;
        if (failed === null) failed = resultFailed;
        if (skipped === null) skipped = resultSkipped;
    }

    return {
        passed: passed === null ? 0 : passed,
        failed: failed === null ? 0 : failed,
        skipped: skipped === null ? 0 : skipped
    };
}

function normalizeResult(result) {
    result = result || {};
    if (!result.status) {
        var counts = getResultCounts(result);
        var passRate = String(result.passRate || result.pass_rate || '').trim();
        if (counts.failed > 0) {
            result.status = 'failed';
        } else if (counts.passed > 0 || passRate === '100%' || passRate === '100') {
            result.status = 'passed';
        } else if (result.results && Array.isArray(result.results) && result.results.length > 0) {
            result.status = 'failed';
        }
    }
    return result;
}

/** Run a command inside the automation repo directory. */
function runInRepo(command, workingDir) {
    return cli_execute_command({ command: command, workingDirectory: workingDir });
}

/** Sanitize text for use in shell command arguments such as git commit messages.
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

        runInRepo('git commit -m "' + prHelper.sanitizeCommitMessage(commitMessage) + '"', workingDir);

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
function createAutomationPR(title, branchName, baseBranch, workingDir, scm) {
    var result = prHelper.createPullRequest({
        title: title,
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        scm: scm,
        runCommand: runInRepo,
        readFile: function(path) { return readOutputFile(path, workingDir, null); },
        writeFile: file_write,
        bodyFileCandidates: ['outputs/pr_body.md', 'outputs/response.md'],
        defaultBody: 'Automated test flows'
    });
    if (result.success) console.log('✅ Automation PR:', result.prUrl || '(URL not found)');
    return result;
}

/**
 * Find the feature PR/MR in the main app repo by trigger ticket key.
 */
function findFeaturePR(ticketKey, scm, owner, repo) {
    try {
        var raw = scm.listPrs('open');
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

function updateFeaturePRLabelWithScm(scm, prNumber, passed, labelPassed, labelFailed) {
    var addLabel = passed ? labelPassed : labelFailed;
    var removeLabel = passed ? labelFailed : labelPassed;

    try {
        try { scm.removeLabel(prNumber, removeLabel); } catch (_) {}
        scm.addLabel(prNumber, addLabel);
        console.log('✅ Added label "' + addLabel + '" to feature PR/MR #' + prNumber);
    } catch (e) {
        console.warn('Failed to update feature PR/MR label:', e);
    }
}

/** Post test result summary as a comment on the feature PR. */
function buildFeatureVerdictSummary(result) {
    var counts = getResultCounts(result || {});
    var status = String((result && result.status) || '').toLowerCase();
    var verdict = status === 'passed'
        ? '✅ FIX VERIFIED — Maestro suite passed'
        : status === 'blocked_by_human'
        ? '🚫 BLOCKED — test automation needs human setup'
        : '❌ FIX FAILED — Maestro suite failed';
    return '## 🤖 Maestro Test Results\n\n' +
        '**Verdict**: ' + verdict + '\n\n' +
        '| Passed | Failed | Skipped |\n' +
        '|--------|--------|---------|\n' +
        '| ' + counts.passed + ' | ' + counts.failed + ' | ' + counts.skipped + ' |\n\n';
}

function updateFeaturePRBody(owner, repo, prNumber, workingDir, result, ticketKey) {
    var summaryFile = readOutputFile('pr_feature_update.md', workingDir, ticketKey);
    if (!summaryFile) {
        // Fallback: use pr_body.md (automation PR description) which has the same test results
        summaryFile = readOutputFile('pr_body.md', workingDir, ticketKey);
        if (summaryFile) {
            console.log('No outputs/pr_feature_update.md — falling back to outputs/pr_body.md');
        }
    }
    if (!summaryFile) {
        console.log('No outputs/pr_feature_update.md or pr_body.md — skipping feature PR comment');
        return;
    }

    if (result) {
        var lower = summaryFile.toLowerCase();
        var hasVerdict = lower.indexOf('verdict') !== -1 ||
            lower.indexOf('test results') !== -1 ||
            lower.indexOf('passed') !== -1 ||
            lower.indexOf('failed') !== -1;
        if (!hasVerdict) {
            summaryFile = buildFeatureVerdictSummary(result) + summaryFile;
        }
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

function updateFeaturePRBodyWithScm(scm, prNumber, workingDir, result, ticketKey) {
    var summaryFile = readOutputFile('pr_feature_update.md', workingDir, ticketKey);
    if (!summaryFile) {
        summaryFile = readOutputFile('pr_body.md', workingDir, ticketKey);
        if (summaryFile) {
            console.log('No outputs/pr_feature_update.md — falling back to outputs/pr_body.md');
        }
    }
    if (!summaryFile) {
        console.log('No outputs/pr_feature_update.md or pr_body.md — skipping feature PR/MR comment');
        return;
    }

    if (result) {
        var lower = summaryFile.toLowerCase();
        var hasVerdict = lower.indexOf('verdict') !== -1 ||
            lower.indexOf('test results') !== -1 ||
            lower.indexOf('passed') !== -1 ||
            lower.indexOf('failed') !== -1;
        if (!hasVerdict) {
            summaryFile = buildFeatureVerdictSummary(result) + summaryFile;
        }
    }

    try {
        scm.addComment(prNumber, summaryFile);
        console.log('✅ Posted test summary as PR/MR comment on feature PR/MR #' + prNumber);
    } catch (e) {
        console.warn('Failed to post PR/MR comment:', e);
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
        var jiraConfig = config.jira;
        var automationScm = createScmCompat(config, config.repository && config.repository.owner, config.repository && config.repository.repo);
        var workingDir = config.workingDir;

        var customParams = (params.jobParams || params).customParams || {};
        var featurePRConfig = customParams.featurePR || {};
        var featureOwner = featurePRConfig.owner || '';
        var featureRepo = featurePRConfig.repo || '';
        var featureScm = (featureOwner && featureRepo) ? createScmCompat(config, featureOwner, featureRepo) : null;

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

        // Step 2b: If mandatory outputs are missing, attempt one resume run before committing.
        // This handles the case where the agent ran out of context or was interrupted
        // before writing outputs/test_automation_result.json and friends.
        var resumed = attemptResumeIfOutputsMissing(ticketKey, workingDir);
        if (resumed) {
            console.log('Resume run completed — re-checking outputs before proceeding.');
        }

        // Step 3: Commit + push + create automation PR (ALWAYS — don't lose agent's work)
        var automationPrUrl = null;
        if (branchName && workingDir) {
            var commitMessage = sanitizeForShell(ticketKey + ' test: automate ' + ticketSummary);
            var gitResult = performGitOperations(branchName, commitMessage, workingDir, testFilesPath);

            if (gitResult.success) {
                var prTitle = sanitizeForShell(ticketKey + ' ' + ticketSummary);
                var prResult = createAutomationPR(prTitle, branchName, config.git.baseBranch, workingDir, automationScm);
                automationPrUrl = prResult.prUrl;
            } else {
                console.warn('Git operations failed:', gitResult.error);
            }
        }

        // Step 4: Read structured result (fallback: workspace root → automation repo outputs)
        var result = readResultJson(workingDir, ticketKey);
        if (!result) {
            console.warn('No test_automation_result.json found — posting error to Jira but keeping git work');
            try {
                var errMsg = 'h3. ⚠️ Test Automation Error\n\nFlows may have been written but output JSON is missing. Check workflow logs.' +
                    (resumed ? '\n\n_Resume was attempted but also did not produce output files._' : '');
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
        if (featureScm && !blockedByHuman) {
            var featurePR = findFeaturePR(ticketKey, featureScm, featureOwner, featureRepo);
            if (featurePR) {
                updateFeaturePRLabelWithScm(featureScm, featurePR.number, passed, labelPassed, labelFailed);
                // Inject automation PR URL into feature update markdown if present
                if (automationPrUrl) {
                    try {
                        var featureUpdateContent = readOutputFile('pr_feature_update.md', workingDir, ticketKey) || '';
                        if (featureUpdateContent && featureUpdateContent.indexOf(automationPrUrl) === -1) {
                            file_write('outputs/pr_feature_update.md',
                                featureUpdateContent + '\n> Automation PR: ' + automationPrUrl + '\n');
                        }
                    } catch (_) {}
                }
                updateFeaturePRBodyWithScm(featureScm, featurePR.number, workingDir, result, ticketKey);
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
            try { jira_move_to_status({ key: ticketKey, statusName: jiraConfig.statuses.BLOCKED }); } catch (e) {}

            removeWipLabel(params, ticketKey);
            removeSMTriggerLabel(params, ticketKey);
            return { success: true, status: 'blocked_by_human', ticketKey: ticketKey };
        }

        // Step 8: Move ticket status
        try {
            var targetStatus = passed ? jiraConfig.statuses.PASSED : jiraConfig.statuses.FAILED;
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
