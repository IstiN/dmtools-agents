/**
 * Post TC Rerun Results Action (postJSAction for tc_rerun agent)
 *
 * Reads outputs/test_automation_result.json and handles the outcome:
 *
 *   passed + no git changes  → TC → Passed
 *   passed + git changes     → commit/push/PR → TC → In Review - Passed
 *   failed + no git changes  → TC → Failed + all linked Bugs → Ready For Development (bug still present)
 *   failed + git changes     → commit/push/PR → TC → In Review - Failed + all linked Bugs → Ready For Development (test code issue; existing branch re-used if present)
 */

const { GIT_CONFIG, STATUSES, LABELS } = require('./config.js');

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
        const content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        return null;
    }
}

function readResultJson() {
    try {
        const raw = readFile('outputs/test_automation_result.json');
        if (!raw) {
            console.warn('outputs/test_automation_result.json is empty or missing');
            return null;
        }
        const parsed = JSON.parse(raw);
        console.log('Re-run result status:', parsed.status);
        return parsed;
    } catch (e) {
        console.error('Failed to parse test_automation_result.json:', e);
        return null;
    }
}

function hasTestingChanges() {
    try {
        cli_execute_command({ command: 'git add testing/' });
        const status = cleanCommandOutput(
            cli_execute_command({ command: 'git status --porcelain' }) || ''
        );
        // Unstage — we only wanted to check
        cli_execute_command({ command: 'git restore --staged testing/' });
        const changed = status.trim().length > 0;
        console.log('Git changes in testing/:', changed ? 'YES' : 'NO');
        return changed;
    } catch (e) {
        console.warn('Could not check git status:', e);
        return false;
    }
}

function performGitOperations(branchName, commitMessage) {
    try {
        console.log('Staging testing/ folder...');
        cli_execute_command({ command: 'git add testing/' });

        const statusOutput = cleanCommandOutput(
            cli_execute_command({ command: 'git status --porcelain' }) || ''
        );

        if (!statusOutput || !statusOutput.trim()) {
            return { success: false, error: 'No changes to commit in testing/' };
        }

        cli_execute_command({
            command: 'git commit -m "' + commitMessage.replace(/"/g, '\\"') + '"'
        });

        const pushOutput = cli_execute_command({
            command: 'git push -u origin ' + branchName
        }) || '';

        const pushFailed = pushOutput.indexOf('remote rejected') !== -1 ||
                           pushOutput.indexOf('GH013') !== -1 ||
                           pushOutput.indexOf('error: failed to push') !== -1 ||
                           pushOutput.indexOf('push declined') !== -1;

        if (pushFailed) {
            return { success: false, error: 'Push rejected: ' + pushOutput.substring(0, 300) };
        }

        const lsOutput = cli_execute_command({
            command: 'git ls-remote --heads origin ' + branchName
        }) || '';

        if (lsOutput.indexOf('refs/heads/' + branchName) === -1) {
            return { success: false, error: 'Branch not found on remote after push' };
        }

        console.log('✅ Git operations completed');
        return { success: true, branchName: branchName };

    } catch (error) {
        console.error('Git operations failed:', error);
        return { success: false, error: error.toString() };
    }
}

function createPullRequest(title, branchName) {
    try {
        const escapedTitle = title.replace(/"/g, '\\"').replace(/\n/g, ' ');
        const prBodyFile = readFile('outputs/pr_body.md') ? 'outputs/pr_body.md' : 'outputs/response.md';

        const output = cleanCommandOutput(
            cli_execute_command({
                command: 'gh pr create --title "' + escapedTitle + '" --body-file "' + prBodyFile + '" --base ' + GIT_CONFIG.DEFAULT_BASE_BRANCH + ' --head ' + branchName
            }) || ''
        );

        let prUrl = null;
        const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
        if (urlMatch) prUrl = urlMatch[0];

        if (!prUrl) {
            try {
                const listOutput = cleanCommandOutput(
                    cli_execute_command({ command: 'gh pr list --head ' + branchName + ' --json url --jq ".[0].url"' }) || ''
                );
                if (listOutput && listOutput.startsWith('https://')) prUrl = listOutput;
            } catch (e) {}
        }

        console.log('✅ PR created:', prUrl || '(URL not found)');
        return { success: true, prUrl: prUrl };
    } catch (error) {
        console.error('Failed to create PR:', error);
        return { success: false, error: error.toString() };
    }
}

function moveLinkedBugsToReadyForDevelopment(ticketKey, comment) {
    try {
        const linkedBugs = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = Bug AND status = "' + STATUSES.IN_TESTING + '"',
            fields: ['status', 'summary'],
            maxResults: 50
        }) || [];

        console.log('Linked Bugs in In Testing:', linkedBugs.length);

        linkedBugs.forEach(function(bug) {
            try {
                jira_move_to_status({ key: bug.key, statusName: STATUSES.READY_FOR_DEVELOPMENT });
                console.log('✅ Moved linked Bug', bug.key, 'to Ready For Development');
                if (comment) {
                    try {
                        const bugComment = comment.replace(/\{BUG_KEY\}/g, bug.key);
                        jira_post_comment({ key: bug.key, comment: bugComment });
                    } catch (e) {
                        console.warn('Failed to post comment on', bug.key, ':', e);
                    }
                }
            } catch (e) {
                console.warn('Failed to move', bug.key, 'to Ready For Development:', e);
            }
        });

        return linkedBugs.length;
    } catch (e) {
        console.warn('Failed to find/move linked bugs:', e);
        return 0;
    }
}

function action(params) {
    try {
        const ticketKey = params.ticket.key;
        const ticketSummary = params.ticket.fields ? params.ticket.fields.summary : ticketKey;
        const jiraComment = params.response || '';

        console.log('=== Processing TC re-run results for', ticketKey, '===');

        // Step 1: Read structured result
        const result = readResultJson();
        if (!result) {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ⚠️ TC Re-run Error\n\nCould not read test result. Check workflow logs.'
            });
            return { success: false, error: 'No test result JSON found' };
        }

        const passed = (result.status || '').toLowerCase() === 'passed';

        // Step 2: Configure git author
        try {
            cli_execute_command({ command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"' });
            cli_execute_command({ command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"' });
        } catch (e) {
            console.warn('Failed to configure git author:', e);
        }

        // Step 3: Check if the agent made any code changes in testing/
        const gitChanged = hasTestingChanges();

        // Step 4: If there are changes — commit, push, create PR
        let prUrl = null;
        if (gitChanged) {
            const branchName = cleanCommandOutput(
                cli_execute_command({ command: 'git branch --show-current' }) || ''
            );

            if (branchName) {
                const commitMessage = ticketKey + ' test: fix re-run ' + ticketSummary;
                const gitResult = performGitOperations(branchName, commitMessage);

                if (gitResult.success) {
                    const prTitle = ticketKey + ' ' + ticketSummary;
                    const prResult = createPullRequest(prTitle, branchName);
                    prUrl = prResult.prUrl;
                } else {
                    console.warn('Git operations failed:', gitResult.error);
                }
            }
        }

        // Step 5: Post Jira comment
        try {
            let comment = jiraComment || '';
            if (prUrl) {
                comment += '\n\n*Test Branch PR*: ' + prUrl;
            }
            if (!comment) {
                comment = 'h3. ' + (passed ? '✅ Re-run Passed' : '❌ Re-run Failed') + '\n\n' +
                    (result.details || result.summary || '');
            }
            jira_post_comment({ key: ticketKey, comment: comment });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 6: Transition TC and handle linked bugs
        if (passed) {
            const targetStatus = gitChanged ? STATUSES.IN_REVIEW_PASSED : STATUSES.PASSED;
            try {
                jira_move_to_status({ key: ticketKey, statusName: targetStatus });
                console.log('✅ Passed — moved', ticketKey, 'to', targetStatus);
            } catch (e) {
                console.warn('Failed to move TC to', targetStatus, ':', e);
            }
        } else {
            const targetStatus = gitChanged ? STATUSES.IN_REVIEW_FAILED : STATUSES.FAILED;
            try {
                jira_move_to_status({ key: ticketKey, statusName: targetStatus });
                console.log('✅ Failed — moved', ticketKey, 'to', targetStatus);
            } catch (e) {
                console.warn('Failed to move TC to', targetStatus, ':', e);
            }

            // Always move linked bugs to Ready For Development on failure:
            // - no git changes  = bug is still present in the app
            // - git changes     = test code couldn't be fixed automatically; PR created for review
            // preCliDevelopmentSetup will reuse the existing ai/<bug-key> branch if it exists on remote
            const bugComment = gitChanged
                ? 'h3. ⚠️ Test Re-run Failed (test code modified but still failing)\n\n' +
                  'Linked Test Case *' + ticketKey + '* was re-run. The automated agent modified the test code but the test still fails.\n\n' +
                  'A PR was created with the test changes for review.\n\n' +
                  'This bug has been moved back to *Ready For Development*. ' +
                  'If branch {code}ai/{BUG_KEY}{code} exists on remote, the agent will reuse it.'
                : 'h3. ❌ Test Re-run Failed (bug still present)\n\n' +
                  'Linked Test Case *' + ticketKey + '* was re-run and the bug was detected again.\n\n' +
                  'This bug has been moved back to *Ready For Development* for a new fix attempt.';
            const movedBugs = moveLinkedBugsToReadyForDevelopment(ticketKey, bugComment);
            console.log('Moved', movedBugs, 'linked Bug(s) to Ready For Development');
        }

        // Step 7: Remove WIP label
        const wipLabel = params.metadata && params.metadata.contextId
            ? params.metadata.contextId + '_wip'
            : null;
        if (wipLabel) {
            try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
        }

        console.log('✅ TC re-run workflow complete:', passed ? 'PASSED' : 'FAILED',
            gitChanged ? '(with code changes)' : '(no code changes)');

        return { success: true, status: result.status, gitChanged: gitChanged, prUrl: prUrl, ticketKey: ticketKey };

    } catch (error) {
        console.error('❌ Error in postTCRerunResults:', error);
        try {
            jira_post_comment({
                key: params.ticket.key,
                comment: 'h3. ❌ TC Re-run Error\n\n{code}' + error.toString() + '{code}'
            });
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
