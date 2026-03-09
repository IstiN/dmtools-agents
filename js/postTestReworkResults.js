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

    // Guard: refuse to push directly to main — rework must be on test/ branch
    if (branchName === 'main' || branchName === 'master') {
        throw new Error('Refusing to commit rework directly to "' + branchName + '". Expected test/' + ticketKey + ' branch. preCliJSAction may have failed to checkout the correct branch.');
    }

    console.log('Current branch:', branchName);

    // Stage only testing/ folder
    cli_execute_command({ command: 'git add testing/' });

    const statusOutput = cleanCommandOutput(
        cli_execute_command({ command: 'git status --porcelain' }) || ''
    );

    var localSha = '';
    if (statusOutput.trim()) {
        const result = passed ? 'fix' : 'update';
        cli_execute_command({
            command: 'git commit -m "' + ticketKey + ' test rework: ' + result + ' test after review"'
        });
        console.log('✅ Committed rework changes');
    } else {
        console.warn('No changes to commit in testing/ — pushing existing commits only');
    }

    // Get local HEAD SHA to verify push actually succeeded
    localSha = cleanCommandOutput(
        cli_execute_command({ command: 'git rev-parse HEAD' }) || ''
    ).substring(0, 40);

    try {
        cli_execute_command({ command: 'git push -u origin ' + branchName });
    } catch (e) {
        console.log('Normal push failed, force pushing...');
        cli_execute_command({ command: 'git push -u origin ' + branchName + ' --force' });
    }

    // Verify push succeeded by checking remote SHA matches local HEAD
    const remoteCheck = cleanCommandOutput(
        cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || ''
    );
    if (!remoteCheck.trim()) throw new Error('Branch not found on remote after push');

    const remoteSha = remoteCheck.split(/\s+/)[0] || '';
    if (localSha && remoteSha && !remoteSha.startsWith(localSha.substring(0, 10))) {
        throw new Error('Push rejected: local HEAD ' + localSha.substring(0, 10) + ' does not match remote ' + remoteSha.substring(0, 10) + '. Branch protection may have blocked the push.');
    }

    console.log('✅ Pushed to remote branch:', branchName);
    return branchName;
}

function createPRIfMissing(owner, repo, branchName, ticketKey) {
    try {
        const openPRs = github_list_prs({ workspace: owner, repository: repo, state: 'open' });
        const existing = openPRs.filter(function(pr) {
            return pr.head && pr.head.ref === branchName;
        });
        if (existing.length > 0) {
            console.log('PR already exists: #' + existing[0].number);
            return existing[0];
        }

        console.log('No open PR found — creating one via gh api...');
        var ticket;
        try { ticket = jira_get_ticket({ key: ticketKey }); } catch (e) { ticket = null; }
        const summary = ticket && ticket.fields ? (ticket.fields.summary || ticketKey) : ticketKey;
        const prTitle = ticketKey + ' ' + summary;

        const prData = JSON.stringify({
            title: prTitle,
            body: 'Auto-created PR after test rework.\n\nTicket: ' + ticketKey,
            head: branchName,
            base: 'main'
        });
        file_write({ path: 'pr_post_rework_' + ticketKey + '.json', content: prData });

        const createOutput = cli_execute_command({
            command: 'gh api repos/' + owner + '/' + repo + '/pulls --input pr_post_rework_' + ticketKey + '.json'
        }) || '';

        var prJson;
        try { prJson = JSON.parse(createOutput); } catch (e) { prJson = null; }
        if (prJson && prJson.number) {
            console.log('✅ Created PR #' + prJson.number + ' for', branchName);
            return prJson;
        }
        console.warn('Could not create PR:', createOutput.substring(0, 200));
        return null;
    } catch (e) {
        console.warn('createPRIfMissing error:', e);
        return null;
    }
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

function action(params) {
    const actualParams = params.ticket ? params : (params.jobParams || params);
    const ticketKey = actualParams.ticket.key;
    const customParams = (actualParams.customParams) ||
        (params.jobParams && params.jobParams.customParams) ||
        (params.customParams);
    const removeLabel = customParams && customParams.removeLabel;
    const wipLabel = actualParams.metadata && actualParams.metadata.contextId
        ? actualParams.metadata.contextId + '_wip'
        : 'pr_test_automation_rework_wip';

    function releaseLock() {
        try { jira_remove_label({ key: ticketKey, label: wipLabel }); } catch (e) {}
        if (removeLabel) {
            try {
                jira_remove_label({ key: ticketKey, label: removeLabel });
                console.log('✅ Removed SM label:', removeLabel);
            } catch (e) {}
        }
    }

    try {
        const fixSummary = actualParams.response || '_(No fix summary)_';

        console.log('=== Processing test rework results for', ticketKey, '===');

        // Step 1: Read new test result
        const result = readResultJson();
        if (!result || !result.status) {
            const errMsg = !result
                ? 'Could not read outputs/test_automation_result.json — file missing or empty.'
                : 'outputs/test_automation_result.json is missing required "status" field (got: ' + JSON.stringify(result) + '). The agent must write { "status": "passed" | "failed", ... }.';
            console.error(errMsg);
            try {
                jira_post_comment({
                    key: ticketKey,
                    comment: 'h3. ⚠️ Rework Error\n\n' + errMsg + '\n\nCheck CI logs for the agent output.'
                });
            } catch (e) {}
            releaseLock();
            return { success: false, error: errMsg };
        }

        const testStatus = result.status.toLowerCase();
        const passed = testStatus === 'passed';
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
            releaseLock();
            return { success: false, error: e.toString() };
        }

        // Step 3: Ensure PR exists; create if missing (e.g. preCliJSAction failed to create it)
        const repoInfo = getGitHubRepoInfo();
        var pr = repoInfo ? findTestPRForTicket(repoInfo.owner, repoInfo.repo, ticketKey) : null;
        if (!pr && repoInfo && branchName) {
            pr = createPRIfMissing(repoInfo.owner, repoInfo.repo, branchName, ticketKey);
        }

        if (pr && repoInfo) {
            postThreadReplies(repoInfo.owner, repoInfo.repo, pr.number);

            // Post PR comment with fix summary + new test result (GitHub Markdown from pr_body.md)
            try {
                const statusEmoji = passed ? '✅' : '❌';
                const prBodyContent = readFile('outputs/pr_body.md') || fixSummary;
                const prComment = '## 🔧 Test Rework Complete — ' + ticketKey + '\n\n' +
                    '**Re-run result**: ' + statusEmoji + ' ' + testStatus.toUpperCase() + '\n\n' +
                    '---\n\n' + prBodyContent;
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

        // Step 4: Move ticket to In Review - Passed or In Review - Failed
        // Bug creation/linking is handled by the bug_creation agent when TC reaches Failed status
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
            comment += '*Re-run result*: ' + statusEmoji + ' *' + testStatus.toUpperCase() + '*\n';
            comment += '*Branch*: {code}' + branchName + '{code}\n';
            if (pr) comment += '*Pull Request*: ' + pr.html_url + '\n';
            comment += '\n' + fixSummary;
            jira_post_comment({ key: ticketKey, comment: comment });
        } catch (e) {
            console.warn('Failed to post Jira comment:', e);
        }

        // Step 7 & 8: Remove WIP label + SM idempotency label
        releaseLock();

        console.log('✅ Test rework complete — re-run:', testStatus, '→', targetStatus);

        return {
            success: true,
            testStatus: testStatus,
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
        releaseLock();
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
