/**
 * Shared GitHub helpers for PR setup actions.
 * Used by preparePRForReview.js and preCliReworkSetup.js.
 *
 * Writes the following files to input/{ticketKey}/:
 *   pr_info.md            — PR metadata
 *   pr_diff.txt           — full git diff
 *   pr_discussions.md     — human-readable review threads + comments
 *   pr_discussions_raw.json — structured threads with IDs for reply/resolve
 */

const { GIT_CONFIG } = require('../config.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function getGitHubRepoInfo() {
    try {
        const remoteUrl = cleanCommandOutput(
            cli_execute_command({ command: 'git config --get remote.origin.url' }) || ''
        );
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        if (!match) {
            console.error('Could not parse GitHub URL from:', remoteUrl);
            return null;
        }
        const owner = match[1];
        const repo = match[2].replace('.git', '');
        console.log('GitHub repo:', owner + '/' + repo);
        return { owner: owner, repo: repo };
    } catch (e) {
        console.error('Failed to get GitHub repo info:', e);
        return null;
    }
}

function findPRForTicket(workspace, repository, ticketKey) {
    try {
        console.log('Searching for PR related to', ticketKey);

        const openPRs = github_list_prs({ workspace: workspace, repository: repository, state: 'open' });
        console.log('Found', openPRs.length, 'open PRs');

        const match = function(pr) {
            return (pr.title && pr.title.indexOf(ticketKey) !== -1) ||
                   (pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1);
        };

        const openMatch = openPRs.filter(match);
        if (openMatch.length > 0) {
            console.log('Found open PR #' + openMatch[0].number + ':', openMatch[0].title);
            return openMatch[0];
        }

        console.warn('No open PR found for ticket', ticketKey);
        return null;
    } catch (e) {
        console.error('Failed to find PR for ticket:', e);
        return null;
    }
}

function getPRDetails(workspace, repository, pullRequestId) {
    try {
        const pr = github_get_pr({
            workspace: workspace,
            repository: repository,
            pullRequestId: String(pullRequestId)
        });
        console.log('Fetched PR details:', pr.title);
        return pr;
    } catch (e) {
        console.error('Failed to get PR details:', e);
        return null;
    }
}

function checkoutPRBranch(branchName) {
    console.log('Checking out PR branch:', branchName);

    cli_execute_command({ command: 'git config user.name "' + GIT_CONFIG.AUTHOR_NAME + '"' });
    cli_execute_command({ command: 'git config user.email "' + GIT_CONFIG.AUTHOR_EMAIL + '"' });
    cli_execute_command({ command: 'git fetch origin --prune' });

    const localBranch = cleanCommandOutput(
        cli_execute_command({ command: 'git branch --list "' + branchName + '"' }) || ''
    );

    if (localBranch.trim()) {
        cli_execute_command({ command: 'git checkout ' + branchName });
        cli_execute_command({ command: 'git pull origin ' + branchName });
    } else {
        const remoteBranch = cleanCommandOutput(
            cli_execute_command({ command: 'git ls-remote --heads origin ' + branchName }) || ''
        );
        if (remoteBranch.trim()) {
            cli_execute_command({ command: 'git checkout -b ' + branchName + ' origin/' + branchName });
        } else {
            throw new Error('Branch not found locally or remotely: ' + branchName);
        }
    }

    console.log('✅ Checked out branch:', branchName);
}

function getPRDiff(baseBranch, headBranch) {
    try {
        console.log('Generating diff between', baseBranch, 'and', headBranch);
        const diff = cli_execute_command({ command: 'git diff ' + baseBranch + '...' + headBranch }) || '';
        console.log('Diff size:', diff.length, 'chars');
        return cleanCommandOutput(diff);
    } catch (e) {
        console.error('Failed to get PR diff:', e);
        return '';
    }
}

/**
 * Fetch PR discussions and raw thread data for reply/resolve.
 *
 * Primary: github_get_pr_conversations
 *   - thread content via rootComment.body
 *   - rootComment.id → inReplyToId for github_reply_to_pr_thread
 *
 * Secondary: github_get_pr_review_threads
 *   - thread.id (GraphQL node ID) → threadId for github_resolve_pr_thread
 *   Matched to conversations by index.
 *
 * Returns { markdown, rawThreads } — either field may be null if no data found.
 */
function fetchDiscussionsAndRawData(workspace, repository, pullRequestId) {
    const prIdStr = String(pullRequestId);
    const sections = [];
    const rawThreads = [];

    // Inline review threads
    try {
        const conversations = github_get_pr_conversations({
            workspace: workspace,
            repository: repository,
            pullRequestId: prIdStr
        });

        if (conversations && conversations.length > 0) {
            // Try to get GraphQL node IDs for resolve
            let reviewThreads = [];
            try {
                reviewThreads = github_get_pr_review_threads({
                    workspace: workspace,
                    repository: repository,
                    pullRequestId: prIdStr
                }) || [];
                console.log('Got', reviewThreads.length, 'review threads for GraphQL IDs');
            } catch (e) {
                console.warn('github_get_pr_review_threads failed (resolve IDs unavailable):', e.message || e);
            }

            let section = '## Review Threads (Inline Comments)\n\n';

            conversations.forEach(function(thread, idx) {
                const rootComment = thread.rootComment || thread;
                const replies = Array.isArray(thread.replies) ? thread.replies : [];

                const rootCommentId = rootComment.id || rootComment.databaseId || null;
                const graphqlThreadId = (reviewThreads[idx] && reviewThreads[idx].id)
                    ? reviewThreads[idx].id : null;

                rawThreads.push({
                    index: idx + 1,
                    rootCommentId: rootCommentId,  // int → github_reply_to_pr_thread.inReplyToId
                    threadId: graphqlThreadId,      // GraphQL node ID → github_resolve_pr_thread.threadId
                    path: thread.path || null,
                    line: thread.line || thread.original_line || null,
                    resolved: thread.resolved === true || thread.isResolved === true,
                    body: (rootComment.body || '').trim()
                });

                section += '### Thread ' + (idx + 1);
                if (thread.path) {
                    section += ' — `' + thread.path + '`';
                    if (thread.line || thread.original_line) {
                        section += ' line ' + (thread.line || thread.original_line);
                    }
                }
                section += '\n\n';

                const author = rootComment.user ? rootComment.user.login :
                               (rootComment.author ? rootComment.author.login : 'unknown');
                const date = rootComment.created_at ? rootComment.created_at.substring(0, 10) : '';
                const body = (rootComment.body || '').trim();

                if (body) {
                    section += '**' + author + '** (' + date + '):\n' + body + '\n\n';
                } else {
                    section += '_[No comment body]_\n\n';
                }

                replies.forEach(function(reply) {
                    const rAuthor = reply.user ? reply.user.login : 'unknown';
                    const rDate = reply.created_at ? reply.created_at.substring(0, 10) : '';
                    section += '> **' + rAuthor + '** (' + rDate + '): ' + (reply.body || '').trim() + '\n\n';
                });

                if (thread.resolved === true || thread.isResolved === true) {
                    section += '_✅ Thread resolved_\n\n';
                }
                section += '---\n\n';
            });

            sections.push(section);
            console.log('Discussions: ' + conversations.length + ' threads,',
                rawThreads.filter(function(t) { return t.rootCommentId; }).length + ' reply IDs,',
                rawThreads.filter(function(t) { return t.threadId; }).length + ' resolve IDs');
        }
    } catch (e) {
        console.warn('github_get_pr_conversations failed:', e.message || e);
    }

    // General PR comments
    try {
        const comments = github_get_pr_comments({
            workspace: workspace,
            repository: repository,
            pullRequestId: prIdStr
        });

        if (comments && comments.length > 0) {
            let section = '## General PR Comments\n\n';
            comments.forEach(function(comment) {
                const author = (comment.user && comment.user.login) ? comment.user.login : 'unknown';
                const date = comment.created_at ? comment.created_at.substring(0, 10) : '';
                section += '**' + author + '** (' + date + '):\n\n';
                section += (comment.body || '').trim() + '\n\n---\n\n';
            });
            sections.push(section);
        }
    } catch (e) {
        console.warn('github_get_pr_comments failed:', e.message || e);
    }

    const markdown = sections.length > 0
        ? '# PR Discussion History\n\n' +
          '_Previous review discussions for PR #' + pullRequestId + '._\n\n' +
          sections.join('\n')
        : null;

    const raw = rawThreads.length > 0 ? { threads: rawThreads } : null;

    return { markdown: markdown, rawThreads: raw };
}

/**
 * Write PR context files to input folder.
 * Writes: pr_info.md, pr_diff.txt, pr_discussions.md, pr_discussions_raw.json
 *
 * @param {string}      inputFolder  - input/{ticketKey} path
 * @param {Object}      prDetails    - PR object from github_get_pr
 * @param {string}      diff         - git diff text
 * @param {string|null} markdown     - discussions markdown (from fetchDiscussionsAndRawData)
 * @param {Object|null} rawThreads   - raw threads with IDs (from fetchDiscussionsAndRawData)
 */
function writePRContext(inputFolder, prDetails, diff, markdown, rawThreads) {
    // pr_info.md
    let prInfo = '# Pull Request Information\n\n';
    prInfo += '- **PR #**: ' + prDetails.number + '\n';
    prInfo += '- **URL**: ' + prDetails.html_url + '\n';
    prInfo += '- **Title**: ' + prDetails.title + '\n';
    prInfo += '- **Author**: ' + (prDetails.user ? prDetails.user.login : 'unknown') + '\n';
    prInfo += '- **Branch**: `' + (prDetails.head ? prDetails.head.ref : 'unknown') +
              '` → `' + (prDetails.base ? prDetails.base.ref : 'unknown') + '`\n';
    prInfo += '- **State**: ' + prDetails.state + '\n';
    prInfo += '- **Files Changed**: ' + (prDetails.changed_files || 0) + '\n';
    prInfo += '- **Additions**: +' + (prDetails.additions || 0) + '\n';
    prInfo += '- **Deletions**: -' + (prDetails.deletions || 0) + '\n';
    prInfo += '- **Created**: ' + (prDetails.created_at || '') + '\n';
    prInfo += '- **Updated**: ' + (prDetails.updated_at || '') + '\n';
    if (prDetails.body) {
        prInfo += '\n## PR Description\n\n' + prDetails.body + '\n';
    }
    file_write({ path: inputFolder + '/pr_info.md', content: prInfo });

    // pr_diff.txt
    file_write({ path: inputFolder + '/pr_diff.txt', content: diff || 'No diff available' });

    // pr_discussions.md
    if (markdown) {
        file_write({ path: inputFolder + '/pr_discussions.md', content: markdown });
        console.log('✅ Written pr_discussions.md');
    }

    // pr_discussions_raw.json
    if (rawThreads) {
        file_write({
            path: inputFolder + '/pr_discussions_raw.json',
            content: JSON.stringify(rawThreads, null, 2)
        });
        console.log('✅ Written pr_discussions_raw.json (' + rawThreads.threads.length + ' threads)');
    }

    console.log('✅ PR context written to', inputFolder);
}

module.exports = {
    cleanCommandOutput: cleanCommandOutput,
    getGitHubRepoInfo: getGitHubRepoInfo,
    findPRForTicket: findPRForTicket,
    getPRDetails: getPRDetails,
    checkoutPRBranch: checkoutPRBranch,
    getPRDiff: getPRDiff,
    fetchDiscussionsAndRawData: fetchDiscussionsAndRawData,
    writePRContext: writePRContext
};
