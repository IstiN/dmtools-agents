/**
 * Post Test Rework Results Action (postJSAction for pr_test_automation_rework)
 * After cursor agent fixes test issues and re-runs the test:
 * 1. Reads outputs/test_automation_result.json (new test result after fixes)
 * 2. Stages testing/ folder, commits, force-pushes to existing PR branch
 * 3. Replies to and resolves PR review threads (from outputs/review_replies.json)
 * 4. Posts PR comment with fix summary
 * 5. If test passed  → moves to In Review - Passed
 * 6. If test failed  → moves to In Review - Failed (bug may have changed)
 * 7. Posts Jira comment, removes WIP label
 */

const { GIT_CONFIG, STATUSES, ISSUE_TYPES, LABELS } = require('./config.js');

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
        console.warn('Could not read file ' + path + ':', e);
        return null;
    }
}

function readResultJson() {
    try {
        const raw = readFile('outputs/test_automation_result.json');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to parse test_automation_result.json:', e);
        return null;
    }
}

function getGitHubRepoInfo() {
    try {
        const remoteUrl = cleanCommandOutput(
            cli_execute_command({ command: 'git config --get remote.origin.url' }) || ''
        );
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        if (!match) return null;
        return { owner: match[1], repo: match[2].replace('.git', '') };
    } catch (e) {
        return null;
    }
}

function findTestPRForTicket(workspace, repository, ticketKey) {
    try {
        const branchName = 'test/' + ticketKey;
        const openPRs = github_list_prs({ workspace: workspace, repository: repository, state: 'open' });
        const match = openPRs.filter(function(pr) {
            return pr.head && pr.head.ref && pr.head.ref === branchName;
        });
        if (match.length > 0) return match[0];
        console.warn('No open test PR found for branch', branchName);
        return null;
    } catch (e) {
        console.error('Failed to find PR:', e);
        return null;
    }
}

function commitAndPush(ticketKey, passed) {
    const branchName = cleanCommandOutput(
        cli_execute_command({ command: 'git branch --show-current' }) || ''
    );
    if (!branchName) throw new Error('Could not determine current git branch');

    console.log('Current branch:', branchName);

    // Stage only testing/ folder
    cli_execute_command({ command: 'git add testing/' });

    const statusOutput = cleanCommandOutput(
        cli_execute_command({ command: 'git status --porcelain' }) || ''
    );

    if (statusOutput.trim()) {
        const result = passed ? 'fix' : 'update';
        cli_execute_command({
            command: 'git commit -m "' + ticketKey + ' test rework: ' + result + ' test after review"'
        });
        console.log('✅ Committed rework changes');
    } else {
        console.warn('No changes to commit in testing/ — pushing existing commits only');
    }

    try {
        cli_execute_command({ command: 'git push -u origin ' + branchName });
    } catch (e) {
        console.log('Normal push failed, force pushing...');
        cli_execute_command({ command: 'git push -u origin ' + branchName + ' --force' });
    }

    const remoteCheck = cleanCommandOutput(
        cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || ''
    );
    if (!remoteCheck.trim()) throw new Error('Branch not found on remote after push');

    console.log('✅ Pushed to remote branch:', branchName);
    return branchName;
}

function postThreadReplies(workspace, repository, pullRequestId) {
    const repliesJson = readFile('outputs/review_replies.json');
    if (!repliesJson) {
        console.warn('outputs/review_replies.json not found — skipping thread replies');
        return 0;
    }

    let data;
    try {
        data = JSON.parse(repliesJson);
    } catch (e) {
        console.warn('Failed to parse review_replies.json:', e);
        return 0;
    }

    const replies = (data && data.replies) ? data.replies : [];
    if (replies.length === 0) return 0;

    let posted = 0;
    replies.forEach(function(item) {
        try {
            github_reply_to_pr_thread({
                workspace: workspace,
                repository: repository,
                pullRequestId: String(pullRequestId),
                inReplyToId: String(item.inReplyToId),
                text: item.reply || '✅ Addressed.'
            });
            posted++;
        } catch (e) {
            console.warn('Failed to reply to comment #' + item.inReplyToId + ':', e);
        }

        if (item.threadId) {
            try {
                github_resolve_pr_thread({
                    workspace: workspace,
                    repository: repository,
                    pullRequestId: String(pullRequestId),
                    threadId: item.threadId
                });
            } catch (e) {
                console.warn('Failed to resolve thread', item.threadId + ':', e);
            }
        }
    });

    console.log('Posted ' + posted + '/' + replies.length + ' thread replies');
    return posted;
}

function createOrUpdateBug(projectKey, bug) {
    try {
        const description = bug.description ? (readFile(bug.description) || bug.summary) : bug.summary;
        const result = jira_create_ticket({
            project: projectKey,
            summary: bug.summary,
            description: description,
            issuetype: ISSUE_TYPES.BUG,
            priority: bug.priority || 'Medium'
        });
        const bugKey = result && result.key ? result.key : null;
        if (bugKey) console.log('✅ Created bug:', bugKey);
        return bugKey;
    } catch (e) {
        console.error('Failed to create bug:', e);
        return null;
    }
}

function action(params) {
    try {
        const actualParams = params.ticket ? params : (params.jobParams || params);
        const ticketKey = actualParams.ticket.key;
        const projectKey = ticketKey.split('-')[0];
        const fixSummary = actualParams.response || '_(No fix summary)_';

        console.log('=== Processing test rework results for', ticketKey, '===');

        // Step 1: Read new test result
        const result = readResultJson();
        if (!result) {
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ⚠️ Rework Error\n\nCould not read test_automation_result.json. Check logs.'
            });
            return { success: false, error: 'No test result JSON found' };
        }

        const passed = result.status === 'passed';
        console.log('Re-run result:', result.status);

        // Step 2: Configure git + commit/push testing/ only
        try {
            cli_execute_command({ command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"' });
            cli_execute_command({ command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"' });
        } catch (e) {}

        let branchName;
        try {
            branchName = commitAndPush(ticketKey, passed);
        } catch (e) {
            console.error('Git operations failed:', e);
            jira_post_comment({
                key: ticketKey,
                comment: 'h3. ❌ Rework Push Failed\n\n{code}' + e.toString() + '{code}'
            });
            return { success: false, error: e.toString() };
        }

        // Step 3: Reply to + resolve PR review threads
        const repoInfo = getGitHubRepoInfo();
        const pr = repoInfo ? findTestPRForTicket(repoInfo.owner, repoInfo.repo, ticketKey) : null;

        if (pr && repoInfo) {
            postThreadReplies(repoInfo.owner, repoInfo.repo, pr.number);

            // Post PR comment with fix summary + new test result
            try {
                const statusEmoji = passed ? '✅' : '❌';
                const prComment = '## 🔧 Test Rework Complete — ' + ticketKey + '\n\n' +
                    '**Re-run result**: ' + statusEmoji + ' ' + result.status.toUpperCase() + '\n\n' +
                    '---\n\n' + fixSummary;
                github_add_pr_comment({
                    workspace: repoInfo.owner,
                    repository: repoInfo.repo,
                    pullRequestId: String(pr.number),
                    text: prComment
                });
                console.log('✅ Posted rework summary to PR');
            } catch (e) {
                console.warn('Failed to post PR comment:', e);
            }
        } else {
            console.warn('No PR found — skipping GitHub PR comment');
        }

        // Step 4: Handle test failure — create/update bug if newly failed
        if (!passed && result.bug && result.bug.summary) {
            const bugKey = createOrUpdateBug(projectKey, result.bug);
            if (bugKey) {
                try {
                    jira_link_issues({
                        from: ticketKey,
                        to: bugKey,
                        relationship: 'is blocked by'
                    });
                } catch (e) {}
            }
        }

        // Step 5: Move ticket to In Review - Passed or In Review - Failed
        const targetStatus = passed ? STATUSES.IN_REVIEW_PASSED : STATUSES.IN_REVIEW_FAILED;
        try {
            jira_move_to_status({ key: ticketKey, statusName: targetStatus });
            console.log('✅ Moved', ticketKey, 'to', targetStatus);
        } catch (e) {
            console.warn('Failed to move ticket status:', e);
        }

        // Step 6: Post Jira comment
        try {
            const statusEmoji = passed ? '✅' : '❌';
            let comment = 'h3. 🔧 Test Rework Completed\n\n';
            comment += '*Re-run result*: ' + statusEmoji + ' *' + result.status.toUpperCase() + '*\n';
            comment += '*Branch*: {code}' + branchName + '{code}\n';
            if (pr) comment += '*Pull Request*: ' + pr.html_url + '\n';
            comment += '\n' + fixSummary;
            jira_post_comment({ key: ticketKey, comment: comment });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 7: Remove WIP label
        const wipLabel = actualParams.metadata && actualParams.metadata.contextId
            ? actualParams.metadata.contextId + '_wip'
            : 'pr_test_automation_rework_wip';
        try {
            jira_remove_label({ key: ticketKey, label: wipLabel });
        } catch (e) {}

        console.log('✅ Test rework complete — re-run:', result.status, '→', targetStatus);

        return {
            success: true,
            testStatus: result.status,
            jiraStatus: targetStatus,
            ticketKey: ticketKey
        };

    } catch (error) {
        console.error('❌ Error in postTestReworkResults:', error);
        try {
            const key = (params.ticket || (params.jobParams && params.jobParams.ticket) || {}).key;
            if (key) {
                jira_post_comment({
                    key: key,
                    comment: 'h3. ❌ Test Rework Error\n\n{code}' + error.toString() + '{code}'
                });
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
