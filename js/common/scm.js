/**
 * SCM (Source Control Management) abstraction layer.
 *
 * Factory: createScm(config) -> provider
 * Default provider: 'github'
 *
 * Configure globally via .dmtools/config.js:
 *   module.exports = {
 *     scm: { provider: 'ado' },
 *     repository: { owner: 'MyOrg', repo: 'my-repo' }
 *   }
 *
 * Per-agent override via JSON customParams:
 *   { "customParams": { "scmProvider": "ado", "targetRepository": { "owner": "MyOrg", "repo": "my-repo" } } }
 */

function _parseJson(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
}

function _createGithubProvider(workspace, repository) {
    return {
        listPrs: function(state) {
            return github_list_prs({ workspace: workspace, repository: repository, state: state });
        },
        getPr: function(prId) {
            return github_get_pr({ workspace: workspace, repository: repository, pullRequestId: String(prId) });
        },
        getPrComments: function(prId) {
            return github_get_pr_comments({ workspace: workspace, repository: repository, pullRequestId: String(prId) });
        },
        addComment: function(prId, text) {
            return github_add_pr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
        },
        replyToThread: function(prId, thread, text) {
            if (thread.rootCommentId) {
                return github_reply_to_pr_thread({
                    workspace: workspace, repository: repository,
                    pullRequestId: String(prId), inReplyToId: thread.rootCommentId, text: text
                });
            }
            return github_add_pr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
        },
        resolveThread: function(prId, thread) {
            if (thread.threadId) {
                return github_resolve_pr_thread({ threadId: thread.threadId });
            }
            console.warn('SCM GitHub: No threadId to resolve');
        },
        addInlineComment: function(prId, filePath, line, text, startLine, side) {
            var opts = {
                workspace: workspace, repository: repository,
                pullRequestId: String(prId), path: filePath,
                line: String(line), text: text
            };
            if (startLine) opts.startLine = String(startLine);
            if (side) opts.side = side;
            return github_add_inline_comment(opts);
        },
        mergePr: function(prId, mergeMethod, commitTitle, commitMessage) {
            return github_merge_pr({
                workspace: workspace, repository: repository,
                pullRequestId: String(prId), mergeMethod: mergeMethod,
                commitTitle: commitTitle, commitMessage: commitMessage
            });
        },
        addLabel: function(prId, label) {
            return github_add_pr_label({ workspace: workspace, repository: repository, pullRequestId: String(prId), label: label });
        },
        removeLabel: function(prId, label, labelId) {
            return github_remove_pr_label({ workspace: workspace, repository: repository, pullRequestId: String(prId), label: label });
        },
        getPrDiff: function(prId) {
            return github_get_pr_diff({ workspace: workspace, repository: repository, pullRequestID: String(prId) });
        },
        getCommitCheckRuns: function(sha) {
            return github_get_commit_check_runs({ workspace: workspace, repository: repository, commitSha: sha });
        },
        getJobLogs: function(jobId) {
            return github_get_job_logs({ workspace: workspace, repository: repository, jobId: String(jobId) });
        },
        listWorkflowRuns: function(status, workflowId, limit) {
            return github_list_workflow_runs(workspace, repository, status, workflowId, limit || 50);
        },
        triggerWorkflow: function(owner, repo, workflowFile, payload, ref) {
            return github_trigger_workflow(owner, repo, workflowFile, payload, ref);
        },
        fetchDiscussions: function(prId) {
            var prIdStr = String(prId);
            var sections = [];
            var rawThreads = [];

            try {
                var conversations = github_get_pr_conversations({
                    workspace: workspace, repository: repository, pullRequestId: prIdStr
                });
                if (conversations && conversations.length > 0) {
                    var reviewThreadByCommentId = {};
                    var reviewThreadResolvedById = {};
                    try {
                        var raw = github_get_pr_review_threads({
                            workspace: workspace, repository: repository, pullRequestId: prIdStr
                        });
                        var nodes = [];
                        if (typeof raw === 'string') {
                            var parsed = JSON.parse(raw);
                            nodes = (parsed.data && parsed.data.repository &&
                                     parsed.data.repository.pullRequest &&
                                     parsed.data.repository.pullRequest.reviewThreads &&
                                     parsed.data.repository.pullRequest.reviewThreads.nodes) || [];
                        } else if (Array.isArray(raw)) {
                            nodes = raw;
                        } else if (raw && raw.data) {
                            nodes = (raw.data.repository && raw.data.repository.pullRequest &&
                                     raw.data.repository.pullRequest.reviewThreads &&
                                     raw.data.repository.pullRequest.reviewThreads.nodes) || [];
                        }
                        nodes.forEach(function(rt) {
                            if (rt.id && rt.comments && rt.comments.nodes && rt.comments.nodes.length > 0) {
                                var dbId = rt.comments.nodes[0].databaseId;
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

                    var section = '## Review Threads (Inline Comments)\n\n';
                    conversations.forEach(function(thread, idx) {
                        var rootComment = thread.rootComment || thread;
                        var replies = Array.isArray(thread.replies) ? thread.replies : [];
                        var rootCommentId = rootComment.id || rootComment.databaseId || null;
                        var graphqlThreadId = rootCommentId ? (reviewThreadByCommentId[rootCommentId] || null) : null;
                        var isResolvedByGraphQL = rootCommentId ? (reviewThreadResolvedById[rootCommentId] === true) : false;
                        var isResolved = thread.resolved === true || thread.isResolved === true || isResolvedByGraphQL;

                        rawThreads.push({
                            index: idx + 1,
                            rootCommentId: thread.path ? rootCommentId : null,
                            threadId: graphqlThreadId,
                            path: thread.path || null,
                            line: thread.line || thread.original_line || null,
                            resolved: isResolved,
                            body: (rootComment.body || '').trim()
                        });

                        if (isResolved) return;

                        section += '### Thread ' + (idx + 1);
                        if (thread.path) {
                            section += ' — `' + thread.path + '`';
                            if (thread.line || thread.original_line) {
                                section += ' line ' + (thread.line || thread.original_line);
                            }
                        }
                        section += '\n\n';

                        var author = rootComment.user ? rootComment.user.login :
                                     (rootComment.author ? rootComment.author.login : 'unknown');
                        var date = rootComment.created_at ? rootComment.created_at.substring(0, 10) : '';
                        var body = (rootComment.body || '').trim();
                        if (body) {
                            section += '**' + author + '** (' + date + '):\n' + body + '\n\n';
                        } else {
                            section += '_[No comment body]_\n\n';
                        }
                        replies.forEach(function(reply) {
                            var rAuthor = reply.user ? reply.user.login : 'unknown';
                            var rDate = reply.created_at ? reply.created_at.substring(0, 10) : '';
                            section += '> **' + rAuthor + '** (' + rDate + '): ' + (reply.body || '').trim() + '\n\n';
                        });
                        section += '---\n\n';
                    });

                    var resolvedCount = rawThreads.filter(function(t) { return t.resolved; }).length;
                    var openCount = conversations.length - resolvedCount;
                    if (resolvedCount > 0) {
                        section = '> ℹ️ **' + resolvedCount + ' thread(s) already resolved and excluded from this review.**\n\n' + section;
                    }
                    sections.push(section);
                    console.log('Discussions: ' + conversations.length + ' threads (' + openCount + ' open, ' + resolvedCount + ' resolved),',
                        rawThreads.filter(function(t) { return t.rootCommentId; }).length + ' reply IDs,',
                        rawThreads.filter(function(t) { return t.threadId; }).length + ' resolve IDs');
                }
            } catch (e) {
                console.warn('github_get_pr_conversations failed:', e.message || e);
            }

            try {
                var comments = github_get_pr_comments({
                    workspace: workspace, repository: repository, pullRequestId: prIdStr
                });
                if (comments && comments.length > 0) {
                    var commentsSection = '## General PR Comments\n\n';
                    comments.forEach(function(comment) {
                        var author = (comment.user && comment.user.login) ? comment.user.login : 'unknown';
                        var date = comment.created_at ? comment.created_at.substring(0, 10) : '';
                        commentsSection += '**' + author + '** (' + date + '):\n\n';
                        commentsSection += (comment.body || '').trim() + '\n\n---\n\n';
                    });
                    sections.push(commentsSection);
                }
            } catch (e) {
                console.warn('github_get_pr_comments failed:', e.message || e);
            }

            var markdown = sections.length > 0
                ? '# PR Discussion History\n\n_Previous review discussions for PR #' + prId + '._\n\n' + sections.join('\n')
                : null;
            return { markdown: markdown, rawThreads: rawThreads.length > 0 ? { threads: rawThreads } : null };
        },
        getRemoteRepoInfo: function() {
            try {
                var rawUrl = cli_execute_command({ command: 'git config --get remote.origin.url' }) || '';
                var lines = rawUrl.split('\n').filter(function(l) { return l.trim(); });
                var remoteUrl = lines.join('').trim();
                var match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
                if (!match) return null;
                return { owner: match[1], repo: match[2].replace('.git', '') };
            } catch (e) { return null; }
        }
    };
}

function _createAdoProvider(repository) {
    return {
        listPrs: function(state) {
            var result = ado_list_prs({ repository: repository, status: state === 'open' ? 'active' : state });
            var parsed = _parseJson(result);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && parsed.value) return parsed.value;
            return parsed || [];
        },
        getPr: function(prId) {
            return _parseJson(ado_get_pr({ repository: repository, pullRequestId: String(prId) }));
        },
        getPrComments: function(prId) {
            var parsed = _parseJson(ado_get_pr_comments({ repository: repository, pullRequestId: String(prId) }));
            return (parsed && parsed.value) ? parsed.value : (parsed || []);
        },
        addComment: function(prId, text) {
            return ado_add_pr_comment({ repository: repository, pullRequestId: String(prId), text: text });
        },
        replyToThread: function(prId, thread, text) {
            if (thread.threadId) {
                return ado_reply_to_pr_thread({
                    repository: repository, pullRequestId: String(prId),
                    threadId: String(thread.threadId), text: text
                });
            }
            return ado_add_pr_comment({ repository: repository, pullRequestId: String(prId), text: text });
        },
        resolveThread: function(prId, thread) {
            if (thread.threadId) {
                return ado_resolve_pr_thread({
                    repository: repository, pullRequestId: String(prId), threadId: String(thread.threadId)
                });
            }
            console.warn('SCM ADO: No threadId to resolve for ADO thread');
        },
        addInlineComment: function(prId, filePath, line, text, startLine, side) {
            var opts = {
                repository: repository, pullRequestId: String(prId),
                filePath: filePath, line: String(line), text: text
            };
            if (startLine) opts.startLine = String(startLine);
            if (side) opts.side = side;
            return ado_add_inline_comment(opts);
        },
        mergePr: function(prId, mergeMethod, commitTitle, commitMessage) {
            return ado_merge_pr({ repository: repository, pullRequestId: String(prId) });
        },
        addLabel: function(prId, label) {
            return ado_add_pr_label({ repository: repository, pullRequestId: String(prId), label: label });
        },
        removeLabel: function(prId, label, labelId) {
            return ado_remove_pr_label({ repository: repository, pullRequestId: String(prId), labelId: labelId || label });
        },
        getPrDiff: function(prId) {
            return ado_get_pr_diff({ repository: repository, pullRequestId: String(prId) });
        },
        getCommitCheckRuns: function(sha) {
            console.warn('SCM ADO: getCommitCheckRuns not supported for ADO');
            return null;
        },
        getJobLogs: function(jobId) {
            console.warn('SCM ADO: getJobLogs not supported for ADO');
            return null;
        },
        listWorkflowRuns: function(status, workflowId, limit) {
            console.warn('SCM ADO: listWorkflowRuns not supported for ADO');
            return null;
        },
        triggerWorkflow: function(owner, repo, workflowFile, payload, ref) {
            console.warn('SCM ADO: triggerWorkflow not supported for ADO — skipping');
        },
        fetchDiscussions: function(prId) {
            var result = ado_get_pr_comments({ repository: repository, pullRequestId: String(prId) });
            var parsed = _parseJson(result);
            var threads = (parsed && parsed.value) ? parsed.value : [];
            var rawThreads = [];
            var sections = [];
            var section = '## Review Threads\n\n';
            var hasContent = false;

            threads.forEach(function(thread) {
                if (thread.isDeleted === true) return;
                var resolved = thread.status === 'fixed' || thread.status === 'closed' ||
                               thread.status === 'resolved' || thread.status === 'wontFix' ||
                               thread.status === 'byDesign';
                var path = (thread.threadContext && thread.threadContext.filePath) || null;
                var line = (thread.threadContext && thread.threadContext.rightFileStart &&
                            thread.threadContext.rightFileStart.line) || null;
                var rootComment = thread.comments && thread.comments[0];
                var body = (rootComment && rootComment.content) || '';
                var threadId = String(thread.id);

                rawThreads.push({
                    index: rawThreads.length + 1,
                    rootCommentId: threadId,
                    threadId: threadId,
                    path: path,
                    line: line,
                    resolved: resolved,
                    body: body.trim()
                });

                if (!resolved) {
                    hasContent = true;
                    section += '### Thread ' + rawThreads.length;
                    if (path) {
                        section += ' — `' + path + '`';
                        if (line) section += ' line ' + line;
                    }
                    section += '\n\n';
                    var author = (rootComment && rootComment.author && rootComment.author.displayName) || 'unknown';
                    var date = (rootComment && rootComment.publishedDate) ? rootComment.publishedDate.substring(0, 10) : '';
                    if (body) {
                        section += '**' + author + '** (' + date + '):\n' + body.trim() + '\n\n';
                    } else {
                        section += '_[No comment body]_\n\n';
                    }
                    section += '---\n\n';
                }
            });

            if (hasContent) {
                var resolvedCount = rawThreads.filter(function(t) { return t.resolved; }).length;
                if (resolvedCount > 0) {
                    section = '> ℹ️ **' + resolvedCount + ' thread(s) already resolved and excluded from this review.**\n\n' + section;
                }
                sections.push(section);
            }
            var markdown = sections.length > 0
                ? '# PR Discussion History\n\n_Previous review discussions for PR #' + prId + '._\n\n' + sections.join('\n')
                : null;
            return { markdown: markdown, rawThreads: rawThreads.length > 0 ? { threads: rawThreads } : null };
        },
        getRemoteRepoInfo: function() {
            try {
                var rawUrl = cli_execute_command({ command: 'git config --get remote.origin.url' }) || '';
                var lines = rawUrl.split('\n').filter(function(l) { return l.trim(); });
                var remoteUrl = lines.join('').trim();
                var match = remoteUrl.match(/dev\.azure\.com[/:]([^/]+)\/([^/]+)\/_git\/([^/]+)/);
                if (match) return { owner: match[1], repo: match[3] };
                match = remoteUrl.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)/);
                if (match) return { owner: match[1], repo: match[3] };
                return null;
            } catch (e) { return null; }
        }
    };
}

function createScm(config) {
    var provider = (config && config.scm && config.scm.provider) || 'github';
    var repo = (config && config.repository && config.repository.repo) || '';
    var owner = (config && config.repository && config.repository.owner) || '';
    if (provider === 'ado') {
        return _createAdoProvider(repo);
    }
    return _createGithubProvider(owner, repo);
}

module.exports = {
    createScm: createScm,
    _createGithubProvider: _createGithubProvider,
    _createAdoProvider: _createAdoProvider
};
