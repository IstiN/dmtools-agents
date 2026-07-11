/**
 * Shared GitHub helpers for PR setup actions: GitHub-only REST/GraphQL calls
 * (PR conversations, review threads, check-runs, job logs). Pure git-CLI
 * operations shared with GitLab (checkoutPRBranch, getPRDiff,
 * detectMergeConflicts, writePRContext) live in ./gitOps.js and are
 * re-exported here for backward compatibility.
 *
 * Writes the following files to input/{ticketKey}/ (via gitOps.writePRContext):
 *   pr_info.md            — PR metadata
 *   pr_diff.txt           — git diff context, truncated when large
 *   pr_discussions.md     — human-readable review threads + comments
 *   pr_discussions_raw.json — structured threads with IDs for reply/resolve
 */

const prHelper = require('./pullRequest.js');
const gitOps = require('./gitOps.js');

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
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/?#\s]+)/);
        if (!match) {
            console.error('Could not parse GitHub URL from:', remoteUrl);
            return null;
        }
        const owner = match[1];
        const repo = match[2].replace(/\.git$/, '');
        console.log('GitHub repo:', owner + '/' + repo);
        return { owner: owner, repo: repo };
    } catch (e) {
        console.error('Failed to get GitHub repo info:', e);
        return null;
    }
}

function _isScm(x) {
    return x !== null && typeof x === 'object' && typeof x.listPrs === 'function';
}


function findPRForTicket(scmOrWorkspace, repositoryOrTicketKey, ticketKeyOpt) {
    var openPRs, ticketKey;
    try {
        if (_isScm(scmOrWorkspace)) {
            ticketKey = repositoryOrTicketKey;
            console.log('Searching for PR related to', ticketKey);
            openPRs = scmOrWorkspace.listPrs('open');
        } else {
            ticketKey = ticketKeyOpt;
            console.log('Searching for PR related to', ticketKey);
            openPRs = github_list_prs({ workspace: scmOrWorkspace, repository: repositoryOrTicketKey, state: 'open' });
        }
        console.log('Found', openPRs.length, 'open PRs');

        var match = function(pr) {
            return (pr.title && pr.title.indexOf(ticketKey) !== -1) ||
                   (pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1);
        };

        var openMatch = openPRs.filter(match);
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

function getPRDetails(scmOrWorkspace, repositoryOrPrId, pullRequestIdOpt) {
    try {
        var pr;
        if (_isScm(scmOrWorkspace)) {
            pr = scmOrWorkspace.getPr(repositoryOrPrId);
        } else {
            pr = github_get_pr({
                workspace: scmOrWorkspace,
                repository: repositoryOrPrId,
                pullRequestId: String(pullRequestIdOpt)
            });
        }
        console.log('Fetched PR details:', pr.title);
        return pr;
    } catch (e) {
        console.error('Failed to get PR details:', e);
        return null;
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
function fetchDiscussionsAndRawData(scmOrWorkspace, repositoryOrPrId, pullRequestIdOpt) {
    // SCM-object path: delegate to provider
    if (_isScm(scmOrWorkspace)) {
        return scmOrWorkspace.fetchDiscussions(repositoryOrPrId);
    }
    // String-arg path: original direct implementation (backward compat — tests use this form)
    var workspace = scmOrWorkspace;
    var repository = repositoryOrPrId;
    var pullRequestId = pullRequestIdOpt;
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
            const reviewThreadByCommentId = {};
            const reviewThreadResolvedById = {};
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
                        if (dbId) {
                            reviewThreadByCommentId[dbId] = rt.id;
                            reviewThreadResolvedById[dbId] = rt.isResolved === true;
                        }
                    }
                });
                console.log('Got', nodes.length, 'review threads for GraphQL IDs');
            } catch (e) {
                console.warn('github_get_pr_review_threads failed (resolve IDs unavailable):', e.message || e);
            }

            let section = '## Review Threads (Inline Comments)\n\n';

            // Bot authors whose inline review threads are informational (test results, CI status),
            // not actionable code-review feedback that requires a code fix.
            var BOT_AUTHORS = ['github-actions[bot]', 'dependabot[bot]', 'renovate[bot]', 'codecov[bot]'];

            conversations.forEach(function(thread, idx) {
                const rootComment = thread.rootComment || thread;
                const replies = Array.isArray(thread.replies) ? thread.replies : [];

                const rootCommentId = rootComment.id || rootComment.databaseId || null;
                const graphqlThreadId = rootCommentId ? (reviewThreadByCommentId[rootCommentId] || null) : null;
                const isResolvedByGraphQL = rootCommentId ? (reviewThreadResolvedById[rootCommentId] === true) : false;
                const isResolved = thread.resolved === true || thread.isResolved === true || isResolvedByGraphQL;

                // Detect bot-authored threads — treat as informational, not actionable
                var threadAuthor = rootComment.user ? rootComment.user.login :
                                   (rootComment.author ? rootComment.author.login : '');
                var isBot = BOT_AUTHORS.indexOf(threadAuthor) !== -1 ||
                            (threadAuthor && threadAuthor.indexOf('[bot]') !== -1);

                rawThreads.push({
                    index: idx + 1,
                    rootCommentId: thread.path ? rootCommentId : null,
                    threadId: graphqlThreadId,
                    path: thread.path || null,
                    line: thread.line || thread.original_line || null,
                    resolved: isResolved,
                    bot: isBot,
                    body: (rootComment.body || '').trim()
                });

                if (isResolved || isBot) return;

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

                section += '---\n\n';
            });

            const resolvedCount = rawThreads.filter(function(t) { return t.resolved; }).length;
            const botCount = rawThreads.filter(function(t) { return !t.resolved && t.bot; }).length;
            const openCount = conversations.length - resolvedCount - botCount;

            if (resolvedCount > 0 || botCount > 0) {
                var infoLines = [];
                if (resolvedCount > 0) infoLines.push(resolvedCount + ' resolved thread(s) excluded');
                if (botCount > 0) infoLines.push(botCount + ' bot-generated thread(s) excluded (informational only)');
                section = '> ℹ️ **' + infoLines.join('; ') + '.**\n\n' + section;
            }

            sections.push(section);
            console.log('Discussions: ' + conversations.length + ' threads (' + openCount + ' open, ' + resolvedCount + ' resolved, ' + botCount + ' bot),',
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
 * Detect failed CI checks for the PR head commit.
 * Uses github_get_commit_check_runs to find failures, then fetches job logs.
 * Writes ci_failures.md to the input folder when failures are found.
 *
 * Dual-mode: accepts either an SCM object or (owner, repo, headSha, inputFolder) strings.
 */
function detectFailedChecks(scmOrOwner, repoOrHeadSha, headShaOrInputFolder, inputFolderOpt) {
    var scm = null;
    var owner, repo, headSha, inputFolder;

    if (_isScm(scmOrOwner)) {
        scm = scmOrOwner;
        headSha = repoOrHeadSha;
        inputFolder = headShaOrInputFolder;
    } else {
        owner = scmOrOwner;
        repo = repoOrHeadSha;
        headSha = headShaOrInputFolder;
        inputFolder = inputFolderOpt;
    }

    try {
        if (!headSha) {
            console.warn('detectFailedChecks: no headSha provided, skipping');
            return [];
        }

        console.log('Checking CI status for commit:', headSha.substring(0, 8) + '...');

        var rawResult;
        if (scm) {
            rawResult = scm.getCommitCheckRuns(headSha);
            if (rawResult === null) {
                return [];
            }
        } else {
            rawResult = github_get_commit_check_runs({
                workspace: owner,
                repository: repo,
                commitSha: headSha
            });
        }

        if (typeof rawResult === 'string') {
            try { rawResult = JSON.parse(rawResult); } catch (e) {}
        }

        var checkRuns = Array.isArray(rawResult) ? rawResult
            : (rawResult && rawResult.check_runs ? rawResult.check_runs : []);

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

            var jobIdMatch = check.details_url && check.details_url.match(/\/jobs?\/(\d+)/);
            if (jobIdMatch) {
                try {
                    var rawLogs;
                    if (scm) {
                        rawLogs = scm.getJobLogs(jobIdMatch[1]);
                    } else {
                        rawLogs = github_get_job_logs({
                            workspace: owner,
                            repository: repo,
                            jobId: jobIdMatch[1]
                        });
                    }
                    var logs = rawLogs;
                    if (typeof rawLogs === 'string') {
                        try {
                            var parsed = JSON.parse(rawLogs);
                            if (parsed && parsed.result) logs = parsed.result;
                        } catch (e) { /* use as-is */ }
                    }
                    if (logs) {
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
    buildOriginFetchCommand: prHelper.buildOriginFetchCommand,
    getGitHubRepoInfo: getGitHubRepoInfo,
    _isScm: _isScm,
    findPRForTicket: findPRForTicket,
    getPRDetails: getPRDetails,
    fetchDiscussionsAndRawData: fetchDiscussionsAndRawData,
    detectFailedChecks: detectFailedChecks,

    // Re-exported from ./gitOps.js for backward compatibility — these are
    // plain git-CLI operations, not GitHub-specific. New code should prefer
    // requiring ./gitOps.js directly.
    checkoutPRBranch: gitOps.checkoutPRBranch,
    getPRDiff: gitOps.getPRDiff,
    trimLargeTextForInput: gitOps.trimLargeTextForInput,
    writePRContext: gitOps.writePRContext,
    detectMergeConflicts: gitOps.detectMergeConflicts
};

