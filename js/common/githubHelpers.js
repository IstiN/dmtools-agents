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
            // Try to get GraphQL node IDs for resolve.
            // github_get_pr_review_threads returns a raw GraphQL JSON string — must be parsed.
            // Match by first-comment databaseId (robust against ordering differences).
            const reviewThreadByCommentId = {};  // databaseId (int) → GraphQL node ID string
            try {
                const raw = github_get_pr_review_threads({
                    workspace: workspace,
                    repository: repository,
                    pullRequestId: prIdStr
                });
                let nodes = [];
                if (typeof raw === 'string') {
                    const parsed = JSON.parse(raw);
                    nodes = (parsed.data &&
                             parsed.data.repository &&
                             parsed.data.repository.pullRequest &&
                             parsed.data.repository.pullRequest.reviewThreads &&
                             parsed.data.repository.pullRequest.reviewThreads.nodes) || [];
                } else if (Array.isArray(raw)) {
                    nodes = raw;
                } else if (raw && raw.data) {
                    nodes = (raw.data.repository &&
                             raw.data.repository.pullRequest &&
                             raw.data.repository.pullRequest.reviewThreads &&
                             raw.data.repository.pullRequest.reviewThreads.nodes) || [];
                }
                nodes.forEach(function(rt) {
                    if (rt.id && rt.comments && rt.comments.nodes && rt.comments.nodes.length > 0) {
                        const dbId = rt.comments.nodes[0].databaseId;
                        if (dbId) reviewThreadByCommentId[dbId] = rt.id;
                    }
                });
                console.log('Got', nodes.length, 'review threads for GraphQL IDs');
            } catch (e) {
                console.warn('github_get_pr_review_threads failed (resolve IDs unavailable):', e.message || e);
            }

            let section = '## Review Threads (Inline Comments)\n\n';

            conversations.forEach(function(thread, idx) {
                const rootComment = thread.rootComment || thread;
                const replies = Array.isArray(thread.replies) ? thread.replies : [];

                const rootCommentId = rootComment.id || rootComment.databaseId || null;
                // Match by root-comment databaseId — robust against ordering differences
                const graphqlThreadId = rootCommentId ? (reviewThreadByCommentId[rootCommentId] || null) : null;

                // Only inline review comments (with a file path) can be replied to via
                // github_reply_to_pr_thread. PR-level review comments without a path
                // will fail with 422 "in_reply_to invalid" — omit rootCommentId for those.
                rawThreads.push({
                    index: idx + 1,
                    rootCommentId: thread.path ? rootCommentId : null,  // int → github_reply_to_pr_thread.inReplyToId
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
 * Detect merge conflicts between the current branch and origin/{baseBranch}.
 * Attempts `git merge --no-commit --no-ff`; if conflicts are found, writes
 * `merge_conflicts.md` to the input folder and leaves the working directory
 * in the conflicted merge state so the rework agent can resolve them.
 *
 * `checkoutPRBranch` already runs `git fetch origin --prune`, so the remote
 * base branch ref is up to date before this is called.
 *
 * @param {string} baseBranch  - base branch name (e.g. "main")
 * @param {string} inputFolder - input/{ticketKey} path
 * @returns {string[]} list of conflicting file paths (empty when clean)
 */
function detectMergeConflicts(baseBranch, inputFolder) {
    try {
        console.log('Checking for merge conflicts with origin/' + baseBranch + '...');

        // Unshallow first so git merge has full history for a correct merge base.
        // GitHub Actions checks out with --depth=1 by default; without this,
        // 'git merge --no-commit' may report clean even when real conflicts exist.
        try {
            cli_execute_command({ command: 'git fetch --unshallow' });
            console.log('Unshallowed repository for full merge base detection');
        } catch (e) {
            // Already a complete repo — harmless, continue
        }

        // Attempt the merge without committing
        cli_execute_command({ command: 'git merge origin/' + baseBranch + ' --no-commit --no-ff' });

        // If we reach here the merge is clean — staged but not committed
        console.log('No merge conflicts — base branch changes staged');
        return [];

    } catch (mergeError) {
        // git merge exits non-zero when there are unresolved conflicts
        try {
            var statusRaw = cleanCommandOutput(
                cli_execute_command({ command: 'git status --short' }) || ''
            );

            // Lines prefixed UU, AA, DD, AU, UA, DU, UD are conflict markers
            var conflictLines = statusRaw.split('\n').filter(function(line) {
                return /^(UU|AA|DD|AU|UA|DU|UD) /.test(line.trim());
            });

            if (conflictLines.length === 0) {
                // Not a conflict error — abort and move on
                try { cli_execute_command({ command: 'git merge --abort' }); } catch (e) {}
                console.warn('Merge failed (non-conflict reason):', mergeError.message || mergeError);
                return [];
            }

            var conflictFiles = conflictLines.map(function(l) {
                return l.trim().substring(3).trim();
            });
            console.warn('⚠️ Merge conflicts in ' + conflictFiles.length + ' file(s):', conflictFiles.join(', '));

            var md = '# ⚠️ Merge Conflicts — Resolve Before Rework\n\n';
            md += 'This branch has conflicts with `' + baseBranch + '`. ';
            md += conflictFiles.length + ' file(s) contain conflict markers:\n\n';
            conflictFiles.forEach(function(f) { md += '- `' + f + '`\n'; });
            md += '\n## Resolution Steps\n\n';
            md += '1. Open each conflicting file and resolve the `<<<<<<<` / `=======` / `>>>>>>>` markers\n';
            md += '2. Stage each resolved file: `git add <file>`\n';
            md += '3. Once all conflicts are resolved, proceed with fixes from `pr_discussions.md`\n\n';
            md += '**Do NOT run `git commit` or `git merge --abort`** — the commit and push are handled automatically.\n';

            file_write({ path: inputFolder + '/merge_conflicts.md', content: md });
            console.log('✅ Wrote merge_conflicts.md');

            // Leave the working directory in the conflicted merge state so the agent can resolve it
            return conflictFiles;

        } catch (statusError) {
            console.warn('Could not determine merge state after conflict:', statusError);
            try { cli_execute_command({ command: 'git merge --abort' }); } catch (e) {}
            return [];
        }
    }
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

/**
 * Detect failed CI checks for the PR head commit.
 * Uses github_get_commit_check_runs to find failures, then fetches job logs
 * via github_get_job_logs (job ID extracted from details_url).
 * Writes ci_failures.md to the input folder when failures are found.
 *
 * @param {string} owner       - GitHub owner/organization
 * @param {string} repo        - GitHub repository name
 * @param {string} headSha     - PR head commit SHA (prDetails.head.sha)
 * @param {string} inputFolder - input/{ticketKey} path
 * @returns {{ name: string, conclusion: string }[]} failed checks (empty when all pass)
 */
function detectFailedChecks(owner, repo, headSha, inputFolder) {
    try {
        if (!headSha) {
            console.warn('detectFailedChecks: no headSha provided, skipping');
            return [];
        }

        console.log('Checking CI status for commit:', headSha.substring(0, 8) + '...');

        var checkRuns = github_get_commit_check_runs({
            workspace: owner,
            repository: repo,
            commitSha: headSha
        });

        if (!checkRuns || !checkRuns.length) {
            console.log('No CI checks found for commit');
            return [];
        }

        console.log('Total check runs:', checkRuns.length);

        var failedChecks = checkRuns.filter(function(c) {
            return c.conclusion === 'failure' || c.conclusion === 'timed_out';
        });

        if (failedChecks.length === 0) {
            console.log('✅ All CI checks passed');
            return [];
        }

        console.warn('⚠️ ' + failedChecks.length + ' CI check(s) failed:', failedChecks.map(function(c) { return c.name; }).join(', '));

        var md = '# ⚠️ Failed CI Checks — Fix Before Completing Rework\n\n';
        md += failedChecks.length + ' check(s) failed on commit `' + headSha.substring(0, 8) + '`:\n\n';

        failedChecks.forEach(function(check) {
            md += '## ❌ ' + check.name + '\n\n';
            md += '- **Conclusion**: ' + check.conclusion + '\n';
            if (check.details_url) {
                md += '- **Details**: ' + check.details_url + '\n';
            }
            md += '\n';

            // GitHub Actions details_url format: .../actions/runs/{runId}/jobs/{jobId}
            var jobIdMatch = check.details_url && check.details_url.match(/\/jobs\/(\d+)/);
            if (jobIdMatch) {
                try {
                    var logs = github_get_job_logs({
                        workspace: owner,
                        repository: repo,
                        jobId: jobIdMatch[1]
                    });
                    if (logs) {
                        // Trim to last 150 lines to keep the file readable
                        var lines = logs.split('\n');
                        var snippet = lines.slice(-150).join('\n');
                        md += '**Error log (last 150 lines)**:\n\n```\n' + snippet + '\n```\n\n';
                    }
                } catch (e) {
                    console.warn('Could not fetch logs for job', jobIdMatch[1], ':', e.message || e);
                }
            }
        });

        md += '---\n\n## Resolution\n\n';
        md += '1. Read the error log(s) above to identify the root cause\n';
        md += '2. Fix the underlying code issue(s)\n';
        md += '3. CI will re-run automatically after the push — all checks must pass\n';

        file_write({ path: inputFolder + '/ci_failures.md', content: md });
        console.log('✅ Wrote ci_failures.md (' + failedChecks.length + ' failed check(s))');

        return failedChecks.map(function(c) { return { name: c.name, conclusion: c.conclusion }; });

    } catch (e) {
        console.warn('detectFailedChecks failed (non-fatal):', e.message || e);
        return [];
    }
}

module.exports = {
    cleanCommandOutput: cleanCommandOutput,
    getGitHubRepoInfo: getGitHubRepoInfo,
    findPRForTicket: findPRForTicket,
    getPRDetails: getPRDetails,
    checkoutPRBranch: checkoutPRBranch,
    getPRDiff: getPRDiff,
    fetchDiscussionsAndRawData: fetchDiscussionsAndRawData,
    writePRContext: writePRContext,
    detectMergeConflicts: detectMergeConflicts,
    detectFailedChecks: detectFailedChecks
};
