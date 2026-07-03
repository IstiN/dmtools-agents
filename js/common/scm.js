/**
 * SCM (Source Control Management) abstraction layer.
 *
 * Factory: createScm(config) -> provider
 * Default provider: 'github'
 *
 * Configure globally via .dmtools/config.js:
 *   module.exports = {
 *     scm: { provider: 'ado' }, // 'github' | 'gitlab' | 'ado'
 *     repository: { owner: 'MyOrg', repo: 'my-repo' }
 *   }
 *
 * Per-agent override via JSON customParams:
 *   { "customParams": { "scmProvider": "gitlab", "targetRepository": { "owner": "MyOrg", "repo": "my-repo" } } }
 */

function _parseJson(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
}

function _toArray(raw) {
    var parsed = _parseJson(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && parsed.value) return parsed.value;
    if (parsed && parsed.workflow_runs) return parsed.workflow_runs;
    if (parsed && parsed.runs) return parsed.runs;
    return parsed ? [parsed] : [];
}

function _readFileMaybe(path) {
    try {
        var raw = file_read({ path: path });
        if (raw && raw.trim()) return raw;
    } catch (e) {
        try {
            raw = file_read(path);
            if (raw && raw.trim()) return raw;
        } catch (ignored) {}
    }
    return null;
}

function _cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function _looksLikeJavaObjectString(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.$]+@[0-9a-f]+$/.test(value.trim());
}

function _isUsableDiff(value) {
    return typeof value === 'string' && value.indexOf('diff --git') !== -1 && !_looksLikeJavaObjectString(value);
}

function _extractDiffFromToolResult(raw) {
    if (typeof raw !== 'string') {
        return raw;
    }
    // Some DMTools versions wrap the diff in a JSON envelope like {"result": "diff ..."}
    // or serialize an IBody lambda as {"arg$1": "diff ..."}. Unwrap those first.
    var trimmed = raw.trim();
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
        try {
            var parsed = JSON.parse(raw);
            var candidates = [parsed.result, parsed['arg$1'], parsed.body, parsed.diff];
            for (var i = 0; i < candidates.length; i++) {
                var candidate = candidates[i];
                if (typeof candidate === 'string' && _isUsableDiff(candidate)) {
                    return candidate;
                }
            }
        } catch (e) {
            // Not valid JSON — fall through to raw diff check
        }
    }
    if (_isUsableDiff(raw)) {
        return raw;
    }
    return raw;
}

function _runGitDiff(baseRef, headRef, workingDir) {
    var variants = [
        'git diff ' + baseRef + '...' + headRef,
        'git diff origin/' + baseRef + '...' + headRef,
        'git diff origin/' + baseRef + '...origin/' + headRef
    ];
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    for (var i = 0; i < variants.length; i++) {
        try {
            var raw = cli_execute_command(Object.assign({}, cmdOpts, { command: variants[i] })) || '';
            var cleaned = _cleanCommandOutput(raw);
            if (_isUsableDiff(cleaned)) {
                console.log('Generated local git diff using: ' + variants[i] + ' (' + cleaned.length + ' chars)');
                return cleaned;
            }
        } catch (e) {
            console.warn('Git diff variant failed (' + variants[i] + '):', e.message || e);
        }
    }
    return '';
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
                    pullRequestId: String(prId), inReplyToId: String(thread.rootCommentId), text: text
                });
            }
            return github_add_pr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
        },
        resolveThread: function(prId, thread) {
            if (thread.threadId) {
                return github_resolve_pr_thread({
                    workspace: workspace, repository: repository,
                    pullRequestId: String(prId), threadId: thread.threadId
                });
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
        getPrDiff: function(prId, workingDir) {
            var prIdStr = String(prId);

            // Primary: DMTools v1.7.210+ exposes a tool that returns the raw diff text.
            if (typeof github_get_pr_diff_text !== 'undefined') {
                try {
                    var textRaw = github_get_pr_diff_text({ workspace: workspace, repository: repository, pullRequestID: prIdStr });
                    var textDiff = _extractDiffFromToolResult(textRaw);
                    if (_isUsableDiff(textDiff)) {
                        return textDiff;
                    }
                } catch (e) {
                    console.warn('github_get_pr_diff_text failed:', e.message || e);
                }
            }

            // Legacy fallback: the old tool returns diff statistics (an object) in most builds.
            var raw = '';
            try {
                raw = github_get_pr_diff({ workspace: workspace, repository: repository, pullRequestID: prIdStr });
            } catch (e) {
                console.warn('github_get_pr_diff failed:', e.message || e);
            }

            var extracted = _extractDiffFromToolResult(raw);
            if (_isUsableDiff(extracted)) {
                return extracted;
            }

            // Final fallback: generate the diff locally from the checked-out branch.
            console.log('GitHub PR diff MCP returned no usable diff; falling back to local git diff');
            try {
                var pr = github_get_pr({ workspace: workspace, repository: repository, pullRequestId: prIdStr });
                if (!pr) throw new Error('github_get_pr returned empty PR details');
                var baseRef = pr.base && pr.base.ref ? pr.base.ref : null;
                var headRef = pr.head && pr.head.ref ? pr.head.ref : null;
                if (!baseRef || !headRef) throw new Error('PR missing base or head ref');
                var localDiff = _runGitDiff(baseRef, headRef, workingDir);
                if (_isUsableDiff(localDiff)) {
                    return localDiff;
                }
            } catch (e2) {
                console.warn('Local git diff fallback failed:', e2.message || e2);
            }

            return raw || '';
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
        updateBranch: function(prId, owner, repo) {
            return cli_execute_command({
                command: 'gh api repos/' + (owner || workspace) + '/' + (repo || repository) + '/pulls/' + prId + '/update-branch -X PUT'
            });
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
                var remoteUrl = rawUrl.split('\n')
                    .map(function(l) { return l.trim(); })
                    .filter(function(l) { return l.indexOf('github.com') !== -1 || l.indexOf('dev.azure.com') !== -1 || l.indexOf('ssh.dev.azure.com') !== -1; })[0] || '';
                var match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/?#\s]+)/);
                if (!match) return null;
                return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
            } catch (e) { return null; }
        }
    };
}

function _normalizeGitLabState(state) {
    if (state === 'open') return 'opened';
    if (state === 'active') return 'opened';
    return state || 'opened';
}

function _normalizeGitLabPipelineStatus(status) {
    if (!status) return null;
    var s = String(status).toLowerCase();
    if (s === 'failure' || s === 'failed') return 'failed';
    if (s === 'success' || s === 'succeeded') return 'success';
    if (s === 'in_progress') return 'running';
    if (s === 'queued' || s === 'pending') return 'pending';
    if (s === 'waiting') return 'manual';
    return status;
}

function _normalizeGitLabMr(mr) {
    if (!mr) return mr;
    var sourceBranch = mr.source_branch || (mr.head && mr.head.ref) || '';
    var targetBranch = mr.target_branch || (mr.base && mr.base.ref) || '';
    var id = mr.iid || mr.number || mr.id;
    var htmlUrl = mr.web_url || mr.html_url || null;
    var labels = mr.labels || [];
    return Object.assign({}, mr, {
        number: id,
        html_url: htmlUrl,
        state: mr.state,
        merged_at: mr.merged_at || null,
        mergeable: !(mr.has_conflicts === true),
        mergeable_state: mr.detailed_merge_status || mr.merge_status || null,
        head: Object.assign({}, mr.head || {}, { ref: sourceBranch, sha: mr.sha || (mr.diff_refs && mr.diff_refs.head_sha) }),
        base: Object.assign({}, mr.base || {}, { ref: targetBranch, sha: mr.diff_refs && mr.diff_refs.base_sha }),
        labels: labels
    });
}

function _createGitLabProvider(workspace, repository) {
    return {
        listPrs: function(state) {
            var requestedState = _normalizeGitLabState(state);
            var raw = gitlab_list_mrs({ workspace: workspace, repository: repository, state: requestedState });
            var prs = _toArray(raw).map(_normalizeGitLabMr);
            if (state === 'closed') {
                return prs.filter(function(pr) { return pr.state === 'closed' || pr.merged_at; });
            }
            return prs;
        },
        getPr: function(prId) {
            return _normalizeGitLabMr(_parseJson(gitlab_get_mr({
                workspace: workspace, repository: repository, pullRequestId: String(prId)
            })));
        },
        getPrComments: function(prId) {
            return _toArray(gitlab_get_mr_comments({ workspace: workspace, repository: repository, pullRequestId: String(prId) }));
        },
        addComment: function(prId, text) {
            return gitlab_add_mr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
        },
        replyToThread: function(prId, thread, text) {
            var threadId = thread.threadId || thread.rootCommentId || thread.discussionId;
            if (threadId) {
                return gitlab_reply_to_mr_thread({
                    workspace: workspace, repository: repository,
                    pullRequestId: String(prId), discussionId: String(threadId), text: text
                });
            }
            return gitlab_add_mr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
        },
        resolveThread: function(prId, thread) {
            var threadId = thread.threadId || thread.discussionId;
            if (threadId) {
                return gitlab_resolve_mr_thread({
                    workspace: workspace, repository: repository,
                    pullRequestId: String(prId), discussionId: String(threadId)
                });
            }
            console.warn('SCM GitLab: No discussion id to resolve');
        },
        addInlineComment: function(prId, filePath, line, text, startLine, side) {
            var mr = this.getPr(prId);
            var refs = (mr && mr.diff_refs) || {};
            if (!refs.base_sha || !refs.head_sha || !refs.start_sha) {
                throw new Error('GitLab inline comments require MR diff_refs; gitlab_get_mr did not return them');
            }
            return gitlab_add_inline_mr_comment({
                workspace: workspace, repository: repository,
                pullRequestId: String(prId), filePath: filePath,
                line: String(line), text: text,
                baseSha: refs.base_sha, headSha: refs.head_sha, startSha: refs.start_sha
            });
        },
        mergePr: function(prId, mergeMethod, commitTitle, commitMessage) {
            return gitlab_merge_mr({
                workspace: workspace, repository: repository,
                pullRequestId: String(prId),
                mergeCommitMessage: commitMessage || commitTitle || ''
            });
        },
        addLabel: function(prId, label) {
            return gitlab_add_mr_label({ workspace: workspace, repository: repository, pullRequestId: String(prId), label: label });
        },
        removeLabel: function(prId, label, labelId) {
            return gitlab_remove_mr_label({ workspace: workspace, repository: repository, pullRequestId: String(prId), label: label });
        },
        getPrDiff: function(prId, workingDir) {
            var prIdStr = String(prId);

            // gitlab_get_mr_diff is known to return diff stats/metadata in some builds, and in
            // others a broken serialized Java object toString (e.g. "GitLab$4@abc123") instead
            // of the actual unified diff text. Validate before trusting it.
            var raw = '';
            try {
                raw = gitlab_get_mr_diff({ workspace: workspace, repository: repository, pullRequestId: prIdStr });
            } catch (e) {
                console.warn('gitlab_get_mr_diff failed:', e.message || e);
            }

            var extracted = _extractDiffFromToolResult(raw);
            if (_isUsableDiff(extracted)) {
                return extracted;
            }

            // Fallback: generate the diff locally from the checked-out branch using the MR's
            // base/head commit SHAs (requires the repo to be checked out at workingDir).
            console.log('GitLab MR diff MCP returned no usable diff; falling back to local git diff');
            try {
                var mr = this.getPr(prIdStr);
                var refs = (mr && mr.diff_refs) || {};
                if (!refs.base_sha || !refs.head_sha) {
                    throw new Error('MR missing diff_refs base_sha/head_sha');
                }
                var localDiff = _runGitDiff(refs.base_sha, refs.head_sha, workingDir);
                if (_isUsableDiff(localDiff)) {
                    return localDiff;
                }
            } catch (e2) {
                console.warn('Local git diff fallback failed:', e2.message || e2);
            }

            return raw || '';
        },
        getCommitCheckRuns: function(sha) {
            console.warn('SCM GitLab: commit check runs are represented as pipelines/jobs — returning null');
            return null;
        },
        getJobLogs: function(jobId) {
            return gitlab_get_job_logs({ workspace: workspace, repository: repository, jobId: String(jobId) });
        },
        listWorkflowRuns: function(status, workflowId, limit) {
            var runs = _toArray(gitlab_list_pipeline_runs({
                workspace: workspace,
                repository: repository,
                status: _normalizeGitLabPipelineStatus(status),
                ref: null,
                limit: String(limit || 50)
            }));
            var mapped = runs.map(function(run) {
                return Object.assign({}, run, {
                    name: run.name || run.ref || '',
                    display_title: run.name || run.ref || '',
                    status: run.status === 'running' ? 'in_progress' : run.status,
                    run_number: run.id
                });
            });
            return JSON.stringify({ workflow_runs: mapped });
        },
        triggerWorkflow: function(owner, repo, workflowFile, payload, ref) {
            var variables = {};
            var parsed = _parseJson(payload);
            if (parsed && typeof parsed === 'object') {
                Object.keys(parsed).forEach(function(key) {
                    variables[key] = parsed[key];
                });
            }
            variables.workflow_file = workflowFile;
            return gitlab_trigger_pipeline({
                workspace: owner || workspace,
                repository: repo || repository,
                ref: ref || 'main',
                variablesJson: JSON.stringify(variables)
            });
        },
        createPr: function(options) {
            options = options || {};
            var raw = gitlab_create_mr({
                workspace: workspace,
                repository: repository,
                sourceBranch: options.branchName,
                targetBranch: options.baseBranch || 'main',
                title: options.title,
                description: options.body || '',
                removeSourceBranch: options.removeSourceBranch === false ? 'false' : 'true'
            });
            var mr = _normalizeGitLabMr(_parseJson(raw));
            return {
                success: true,
                prUrl: mr && mr.html_url,
                number: mr && mr.number,
                output: raw
            };
        },
        updateBranch: function(prId, owner, repo) {
            return gitlab_rebase_mr({
                workspace: owner || workspace,
                repository: repo || repository,
                pullRequestId: String(prId)
            });
        },
        fetchDiscussions: function(prId) {
            var discussions = _toArray(gitlab_get_mr_discussions({
                workspace: workspace, repository: repository, pullRequestId: String(prId)
            }));
            var sections = [];
            var rawThreads = [];
            var section = '## Review Threads\n\n';
            var hasContent = false;

            discussions.forEach(function(thread) {
                var notes = thread.notes || [];
                var root = notes[0] || {};
                var body = (root.body || '').trim();
                var pos = root.position || {};
                var resolved = thread.resolved === true || root.resolved === true;
                var path = pos.new_path || pos.old_path || null;
                var line = pos.new_line || pos.old_line || null;

                rawThreads.push({
                    index: rawThreads.length + 1,
                    rootCommentId: thread.id,
                    threadId: thread.id,
                    discussionId: thread.id,
                    path: path,
                    line: line,
                    resolved: resolved,
                    body: body
                });

                if (resolved) return;
                hasContent = true;
                section += '### Thread ' + rawThreads.length;
                if (path) {
                    section += ' — `' + path + '`';
                    if (line) section += ' line ' + line;
                }
                section += '\n\n';
                var author = root.author ? (root.author.username || root.author.name) : 'unknown';
                var date = root.created_at ? root.created_at.substring(0, 10) : '';
                section += body ? ('**' + author + '** (' + date + '):\n' + body + '\n\n') : '_[No comment body]_\n\n';
                for (var i = 1; i < notes.length; i++) {
                    var reply = notes[i] || {};
                    var rAuthor = reply.author ? (reply.author.username || reply.author.name) : 'unknown';
                    var rDate = reply.created_at ? reply.created_at.substring(0, 10) : '';
                    section += '> **' + rAuthor + '** (' + rDate + '): ' + (reply.body || '').trim() + '\n\n';
                }
                section += '---\n\n';
            });

            if (hasContent) sections.push(section);
            return {
                markdown: sections.length > 0
                    ? '# PR Discussion History\n\n_Previous review discussions for MR #' + prId + '._\n\n' + sections.join('\n')
                    : null,
                rawThreads: rawThreads.length > 0 ? { threads: rawThreads } : null
            };
        },
        getRemoteRepoInfo: function() {
            return _detectRepoFromGitRemote('gitlab');
        }
    };
}

function _adoResolvePipelineId(workflowIdentifier) {
    if (!workflowIdentifier) return null;
    var asNum = Number(workflowIdentifier);
    if (!isNaN(asNum) && asNum > 0) return asNum;
    // Lookup by name via ado_list_pipelines
    try {
        var raw = ado_list_pipelines({});
        var parsed = _parseJson(raw);
        var pipelines = (parsed && parsed.value) ? parsed.value : (Array.isArray(parsed) ? parsed : []);
        var name = String(workflowIdentifier).toLowerCase();
        var match = pipelines.find(function(p) {
            return p.name && p.name.toLowerCase() === name;
        });
        return match ? match.id : null;
    } catch (e) {
        console.warn('SCM ADO: _adoResolvePipelineId failed: ' + e);
        return null;
    }
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
            console.warn('SCM ADO: getCommitCheckRuns has no direct ADO equivalent — returning null');
            return null;
        },
        getJobLogs: function(jobId, tailLines) {
            var opts = { buildId: parseInt(String(jobId), 10) };
            if (tailLines) opts.tailLines = parseInt(String(tailLines), 10);
            return ado_get_pipeline_logs(opts);
        },
        listWorkflowRuns: function(status, workflowId, limit) {
            var pipelineId = _adoResolvePipelineId(workflowId);
            if (!pipelineId) {
                console.warn('SCM ADO: listWorkflowRuns — could not resolve pipeline for: ' + workflowId);
                return null;
            }
            var opts = { pipelineId: parseInt(String(pipelineId), 10) };
            if (limit) opts.top = parseInt(String(limit), 10);
            var raw = ado_list_pipeline_runs(opts);
            var parsed = _parseJson(raw);
            var rawRuns = (parsed && parsed.value) ? parsed.value : (Array.isArray(parsed) ? parsed : []);
            // Convert Java list to native JS array for filter/map compat
            var runs = [];
            for (var i = 0; i < rawRuns.length; i++) { runs.push(rawRuns[i]); }
            if (status) {
                // ADO run state: 'inProgress', 'completed', 'canceling', 'unknown'
                // ADO run result: 'succeeded', 'failed', 'canceled', 'unknown'
                var filterStatus = status.toLowerCase();
                runs = runs.filter(function(r) {
                    var state = (r.state || '').toLowerCase();
                    var result = (r.result || '').toLowerCase();
                    if (filterStatus === 'failure' || filterStatus === 'failed') return result === 'failed';
                    if (filterStatus === 'success' || filterStatus === 'succeeded') return result === 'succeeded';
                    if (filterStatus === 'in_progress') return state === 'inprogress';
                    if (filterStatus === 'completed') return state === 'completed';
                    return state === filterStatus || result === filterStatus;
                });
            }
            return JSON.stringify({ workflow_runs: runs });
        },
        triggerWorkflow: function(owner, repo, workflowFile, payload, ref) {
            var pipelineId = _adoResolvePipelineId(workflowFile);
            if (!pipelineId) {
                console.warn('SCM ADO: triggerWorkflow — could not resolve pipeline for: ' + workflowFile);
                return null;
            }
            var opts = { pipelineId: parseInt(String(pipelineId), 10) };
            if (ref) opts.branch = ref;
            if (payload && typeof payload === 'object' && Object.keys(payload).length > 0) {
                opts.variables = JSON.stringify(payload);
            }
            return ado_trigger_pipeline(opts);
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

function _detectRepoFromGitRemote(provider) {
    try {
        var rawUrl = cli_execute_command({ command: 'git config --get remote.origin.url' }) || '';
        var remoteUrl = rawUrl.split('\n')
            .map(function(l) { return l.trim(); })
            .filter(function(l) {
                return l.indexOf('github.com') !== -1 ||
                    l.indexOf('gitlab') !== -1 ||
                    l.indexOf('git.epam.com') !== -1 ||
                    l.indexOf('dev.azure.com') !== -1 ||
                    l.indexOf('ssh.dev.azure.com') !== -1;
            })[0] || '';
        if (provider === 'ado') {
            var match = remoteUrl.match(/dev\.azure\.com[/:]([^/]+)\/([^/]+)\/_git\/([^/]+)/);
            if (match) return { owner: match[1], repo: match[3] };
            match = remoteUrl.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)/);
            if (match) return { owner: match[1], repo: match[3] };
        } else if (provider === 'gitlab') {
            var normalized = remoteUrl
                .replace(/^git@([^:]+):/, 'https://$1/')
                .replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/');
            var glMatch = normalized.match(/https?:\/\/[^/]+\/(.+)\/([^/?#\s]+?)(?:\.git)?(?:[?#].*)?$/);
            if (glMatch) return { owner: glMatch[1], repo: glMatch[2].replace(/\.git$/, '') };
        } else {
            var ghMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/?#\s]+)/);
            if (ghMatch) return { owner: ghMatch[1], repo: ghMatch[2].replace(/\.git$/, '') };
        }
    } catch (e) {}
    return null;
}

function createScm(config) {
    var provider = (config && config.scm && config.scm.provider) || 'github';
    var repo  = (config && config.repository && config.repository.repo)  || '';
    var owner = (config && config.repository && config.repository.owner) || '';

    // Auto-detect from git remote when not explicitly configured
    if (!owner || !repo) {
        var detected = _detectRepoFromGitRemote(provider);
        if (detected) {
            if (!owner) owner = detected.owner;
            if (!repo)  repo  = detected.repo;
        }
    }

    if (provider === 'ado') {
        return _createAdoProvider(repo);
    }
    if (provider === 'gitlab') {
        return _createGitLabProvider(owner, repo);
    }
    return _createGithubProvider(owner, repo);
}

module.exports = {
    createScm: createScm,
    _createGithubProvider: _createGithubProvider,
    _createGitLabProvider: _createGitLabProvider,
    _createAdoProvider: _createAdoProvider
};
