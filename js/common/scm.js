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

// gh-957: the review-thread inventory builder — GraphQL-first enumeration
// (the SAME reviewThreads census the SM arm rule counts) enriched from the
// conversations export, with the gh-808 machine-notice filter preserved.
var reviewThreadInventory = require('./reviewThreadInventory.js');

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

/**
 * Normalize a legacy GitHub commit-status entry (the classic pre-Checks-API
 * `/commits/{sha}/statuses` endpoint, still used by external CI systems such as Jenkins
 * that report build results via the Status API instead of GitHub Check Runs) into the same
 * shape detectFailedChecks() expects from github_get_commit_check_runs: { name, conclusion, details_url }.
 */
function _normalizeGithubCommitStatus(status) {
    var s = String((status && status.state) || '').toLowerCase();
    var conclusion = (s === 'failure' || s === 'error') ? 'failure'
        : (s === 'success') ? 'success'
        : s; // pending passes through and is filtered out by detectFailedChecks
    return {
        name: (status && status.context) || 'unknown',
        conclusion: conclusion,
        details_url: (status && status.target_url) || null
    };
}

/**
 * Fetch legacy commit statuses for a GitHub commit. No dedicated MCP tool exists for the
 * classic Status API, so this shells out via `gh api` (same established pattern as
 * updateBranch() below) and keeps only the most recent report per context — GitHub returns
 * statuses newest-first, so the first occurrence per context wins.
 */
function _getLegacyGithubCommitStatuses(workspace, repository, sha) {
    try {
        var raw = cli_execute_command({
            command: 'gh api repos/' + workspace + '/' + repository + '/commits/' + sha + '/statuses --paginate'
        }) || '';
        var cleaned = _cleanCommandOutput(raw);
        if (!cleaned) return [];
        var statuses = JSON.parse(cleaned);
        if (!Array.isArray(statuses)) return [];
        var seenContexts = {};
        var latest = [];
        for (var i = 0; i < statuses.length; i++) {
            var ctx = statuses[i].context || 'unknown';
            if (seenContexts[ctx]) continue;
            seenContexts[ctx] = true;
            latest.push(statuses[i]);
        }
        return latest;
    } catch (e) {
        console.warn('SCM GitHub: failed to fetch legacy commit statuses for', sha, ':', e.message || e);
        return [];
    }
}

/**
 * Unwrap the raw github_get_commit_check_runs() response into a plain array, tolerating the
 * various envelopes DMTools builds have used ({"result": ...}, {"check_runs": [...]}, a raw
 * array, or a single object).
 */
function _unwrapGithubCheckRuns(raw) {
    var parsed = _parseJson(raw);
    if (parsed && typeof parsed.result !== 'undefined') {
        parsed = _parseJson(parsed.result);
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.check_runs)) return parsed.check_runs;
    return parsed ? [parsed] : [];
}

// ── GitHub provider helpers (gh-981) ─────────────────────────────────────────
// Extraction of the former _createGithubProvider method closures (provider at
// CRAP 184.8 in the baseline) into module-level functions — same pattern as
// the gh-925 ADO split. Behaviour-preserving: same tools, args, log lines and
// fallback order — pinned by test_scmGithubProvider.js.

function _githubGetDiffText(workspace, repository, prId) {
    try {
        // pullRequestID — the exact schema casing of the runtime tool.
        // ⚠️ Casing asymmetry (do NOT "fix" to pullRequestId): the dmtools
        // catalog declares pullRequestID (capital D) for BOTH diff tools
        // (github_get_pr_diff_text, github_get_pr_diff) while all other
        // github_* PR tools take pullRequestId. Verified live against the
        // v1.7.256 schema: pullRequestId → "Required parameter
        // 'pullRequestID' is missing". Same conclusion in repo history
        // #193 (dc48d6b1) and #201 (92aea814).
        return github_get_pr_diff_text({ workspace: workspace, repository: repository, pullRequestID: String(prId) });
    } catch (e) {
        console.warn('getDiffText (github) failed:', e && e.toString ? e.toString() : String(e));
        return null;
    }
}

function _githubReplyToThread(workspace, repository, prId, thread, text) {
    if (thread.rootCommentId) {
        return github_reply_to_pr_thread({
            workspace: workspace, repository: repository,
            pullRequestId: String(prId), inReplyToId: String(thread.rootCommentId), text: text
        });
    }
    return github_add_pr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
}

function _githubResolveThread(workspace, repository, prId, thread) {
    if (thread.threadId) {
        return github_resolve_pr_thread({
            workspace: workspace, repository: repository,
            pullRequestId: String(prId), threadId: thread.threadId
        });
    }
    console.warn('SCM GitHub: No threadId to resolve');
}

function _githubBuildInlineCommentOpts(workspace, repository, prId, filePath, line, text, startLine, side) {
    var opts = {
        workspace: workspace, repository: repository,
        pullRequestId: String(prId), path: filePath,
        line: String(line), text: text
    };
    if (startLine) opts.startLine = String(startLine);
    if (side) opts.side = side;
    return opts;
}

// Primary diff tier: DMTools v1.7.210+ exposes a tool that returns the raw
// diff text (see the casing note on _githubGetDiffText). Returns the usable
// diff or null so the caller falls back gracefully.
function _githubTryPrDiffText(workspace, repository, prIdStr) {
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
    return null;
}

// Legacy diff tier: the old tool returns diff statistics (an object) in most
// builds. Returns { usable, raw } so the orchestrator can return raw as the
// final last-resort value (pinned: getPrDiff returns raw when all tiers fail).
function _githubTryPrDiffTool(workspace, repository, prIdStr) {
    var raw = '';
    try {
        raw = github_get_pr_diff({ workspace: workspace, repository: repository, pullRequestID: prIdStr });
    } catch (e) {
        console.warn('github_get_pr_diff failed:', e.message || e);
    }
    var extracted = _extractDiffFromToolResult(raw);
    return { usable: _isUsableDiff(extracted) ? extracted : null, raw: raw };
}

// Final diff tier: generate the diff locally from the checked-out branch.
function _githubPrBaseHeadRefs(pr) {
    var baseRef = pr.base && pr.base.ref ? pr.base.ref : null;
    var headRef = pr.head && pr.head.ref ? pr.head.ref : null;
    if (!baseRef || !headRef) throw new Error('PR missing base or head ref');
    return { baseRef: baseRef, headRef: headRef };
}

function _githubLocalGitDiffFallback(workspace, repository, prIdStr, workingDir) {
    try {
        var pr = github_get_pr({ workspace: workspace, repository: repository, pullRequestId: prIdStr });
        if (!pr) throw new Error('github_get_pr returned empty PR details');
        var refs = _githubPrBaseHeadRefs(pr);
        return _runGitDiff(refs.baseRef, refs.headRef, workingDir);
    } catch (e2) {
        console.warn('Local git diff fallback failed:', e2.message || e2);
        return '';
    }
}

function _githubGetPrDiff(workspace, repository, prId, workingDir) {
    var prIdStr = String(prId);

    var textDiff = _githubTryPrDiffText(workspace, repository, prIdStr);
    if (textDiff) {
        return textDiff;
    }

    var legacy = _githubTryPrDiffTool(workspace, repository, prIdStr);
    if (legacy.usable) {
        return legacy.usable;
    }

    console.log('GitHub PR diff MCP returned no usable diff; falling back to local git diff');
    var localDiff = _githubLocalGitDiffFallback(workspace, repository, prIdStr, workingDir);
    if (_isUsableDiff(localDiff)) {
        return localDiff;
    }

    return legacy.raw || '';
}

// Merge legacy commit statuses (by name) into the check-runs list so
// detectFailedChecks() still sees external CI (e.g. Jenkins) results.
function _githubMergeLegacyStatuses(checkRuns, legacyStatuses) {
    if (!legacyStatuses.length) {
        return checkRuns;
    }
    var existingNames = {};
    checkRuns.forEach(function(c) { existingNames[c.name] = true; });
    legacyStatuses.forEach(function(s) {
        if (!existingNames[s.name]) checkRuns.push(s);
    });
    return checkRuns;
}

function _githubGetCommitCheckRuns(workspace, repository, sha) {
    if (!sha) return null;
    var checkRuns = [];
    try {
        var raw = github_get_commit_check_runs({ workspace: workspace, repository: repository, commitSha: sha });
        checkRuns = _unwrapGithubCheckRuns(raw);
    } catch (e) {
        console.warn('SCM GitHub: failed to fetch check runs for', sha, ':', e.message || e);
    }

    // Some repos are wired to an external CI (e.g. Jenkins) that reports build
    // results via the classic commit-status API instead of GitHub Check Runs, so
    // checkRuns above can legitimately be empty even when CI actually ran and
    // failed. Merge in legacy statuses (by name) so detectFailedChecks() still
    // sees them.
    var legacyStatuses = _getLegacyGithubCommitStatuses(workspace, repository, sha)
        .map(_normalizeGithubCommitStatus);
    return _githubMergeLegacyStatuses(checkRuns, legacyStatuses);
}

// The 'Discussions: …' census log line, verbatim from the former closure.
function _githubLogInventoryCounts(inv, rawThreads) {
    var c = inv.counts;
    console.log('Discussions: ' + c.total + ' threads (' + c.open + ' open, ' + c.resolved + ' resolved, ' + c.bot + ' bot, ' + c.notices + ' machine notices),',
        rawThreads.filter(function(t) { return t.rootCommentId; }).length + ' reply IDs,',
        rawThreads.filter(function(t) { return t.threadId; }).length + ' resolve IDs' +
        (inv.census.graphqlUnresolved !== null
            ? ' — GraphQL census: ' + inv.census.graphqlUnresolved + ' unresolved (arm-rule count)'
            : ''));
}

// Review-thread inventory (gh-957): GraphQL-first — enumerated from the SAME
// reviewThreads census the SM arm rule counts, enriched per-thread from the
// conversations export. The conversations-first legacy path (inside the
// shared module) is the fallback when the GraphQL fetch fails or returns zero
// nodes. Returns { rawThreads, section, census } or null when NEITHER source
// has data (a PR whose conversations export is empty/incomplete but whose
// GraphQL census carries open threads — the live dart #424 shape — must still
// produce the full inventory, otherwise the rework leg can never see what the
// armer counted and the no-op loop never converges).
function _githubFetchReviewThreadInventory(workspace, repository, prIdStr) {
    var conversations = [];
    try {
        conversations = github_get_pr_conversations({
            workspace: workspace, repository: repository, pullRequestId: prIdStr
        }) || [];
    } catch (e) {
        console.warn('github_get_pr_conversations failed:', e.message || e);
    }
    var graphqlRaw = null;
    try {
        graphqlRaw = github_get_pr_review_threads({
            workspace: workspace, repository: repository, pullRequestId: prIdStr
        });
        console.log('Got', reviewThreadInventory.parseGraphQLNodes(graphqlRaw).length, 'review threads for GraphQL IDs');
    } catch (e) {
        console.warn('github_get_pr_review_threads failed (falling back to conversations-only inventory):', e.message || e);
    }
    var inv = _githubCollectThreadInventory(conversations, graphqlRaw);
    if (!inv) return null;
    var rawThreads = inv.threads;
    _githubLogInventoryCounts(inv, rawThreads);
    return { rawThreads: rawThreads, section: inv.markdownSection, census: inv.census };
}

// Runs the shared inventory builder; the block counts when EITHER source has
// data: a PR whose conversations export is empty/incomplete but whose GraphQL
// census carries open threads (the live dart #424 shape) must still produce
// the full inventory, otherwise the rework leg can never see what the armer
// counted and the no-op loop never converges.
function _githubCollectThreadInventory(conversations, graphqlRaw) {
    try {
        var inv = reviewThreadInventory.collectThreadInventory(conversations, graphqlRaw);
        if (conversations.length > 0 || inv.threads.length > 0) {
            return inv;
        }
    } catch (e) {
        console.warn('review-thread inventory build failed:', e.message || e);
    }
    return null;
}

// gh-1097 follow-up: hidden `<!-- dmtools:` audit comments (naked-pr-rearm
// etc.) are machine bookkeeping — never review feedback. Mirrors
// machineNotice.isDmtoolsMarkerBody (inlined: keeps loader maps unchanged).
function _isDmtoolsMarkerComment(comment) {
    return String((comment && comment.body) || '').replace(/^\s+/, '').indexOf('<!-- dmtools:') === 0;
}

// Pure renderer for the '## General PR Comments' section (verbatim shape).
function _githubRenderCommentsSection(comments) {
    var commentsSection = '## General PR Comments\n\n';
    comments.forEach(function(comment) {
        if (_isDmtoolsMarkerComment(comment)) return;
        var author = (comment.user && comment.user.login) ? comment.user.login : 'unknown';
        var date = comment.created_at ? comment.created_at.substring(0, 10) : '';
        commentsSection += '**' + author + '** (' + date + '):\n\n';
        commentsSection += (comment.body || '').trim() + '\n\n---\n\n';
    });
    return commentsSection;
}

function _githubFetchGeneralCommentsSection(workspace, repository, prIdStr) {
    try {
        var comments = github_get_pr_comments({
            workspace: workspace, repository: repository, pullRequestId: prIdStr
        });
        if (comments && comments.length > 0) {
            return _githubRenderCommentsSection(comments);
        }
    } catch (e) {
        console.warn('github_get_pr_comments failed:', e.message || e);
    }
    return null;
}

function _githubBuildDiscussionsMarkdown(prId, sections) {
    return sections.length > 0
        ? '# PR Discussion History\n\n_Previous review discussions for PR #' + prId + '._\n\n' + sections.join('\n')
        : null;
}

function _githubFetchDiscussions(workspace, repository, prId) {
    var prIdStr = String(prId);
    var sections = [];
    var rawThreads = [];
    var census = null;

    var inv = _githubFetchReviewThreadInventory(workspace, repository, prIdStr);
    if (inv) {
        rawThreads = inv.rawThreads;
        sections.push(inv.section);
        census = inv.census;
    }

    var commentsSection = _githubFetchGeneralCommentsSection(workspace, repository, prIdStr);
    if (commentsSection) {
        sections.push(commentsSection);
    }

    // gh-957: the census rides the rawThreads object (the SAME GraphQL
    // reviewThreads count the SM arm rule counts) so review_state.md can
    // state it next to the actionable list, and gitOps.writePRContext
    // serializes it into pr_discussions_raw.json next to the threads (AC3).
    return {
        markdown: _githubBuildDiscussionsMarkdown(prId, sections),
        rawThreads: rawThreads.length > 0
            ? { threads: rawThreads, census: census }
            : null
    };
}

function _githubGetRemoteRepoInfo() {
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

/**
 * gh-960: machine-owned PR body rewrite via `gh api …/pulls/{id} -X PATCH`.
 * Review thread js/postTestReworkResults.js:214 pinned that the previous
 * updatePrBody seam was dead — no provider implemented it, so the rework-publish
 * freeze + ensureClosesLine wrapping never executed outside mock-SCM tests.
 * The body travels through a temp file because `gh api -F key=@file` sends the
 * file's exact contents — no shell quoting/escaping can mangle a multi-line
 * Markdown body that way. Returns the gh output, or null when the call failed
 * (threw or returned nothing — gh prints the updated PR JSON on success).
 */
function _githubUpdatePrBody(workspace, repository, prId, body) {
    var prIdStr = String(prId);
    var tempBodyPath = 'pr_body_update_tmp_' + prIdStr + '.md';
    try {
        file_write(tempBodyPath, body === null || body === undefined ? '' : String(body));
        var raw = cli_execute_command({
            command: 'gh api repos/' + workspace + '/' + repository + '/pulls/' + prIdStr +
                ' -X PATCH -F body=@' + tempBodyPath
        });
        var cleaned = _cleanCommandOutput(raw || '');
        if (!cleaned) {
            console.warn('SCM GitHub: updatePrBody for PR ' + prIdStr + ' returned no output — treating as failed');
            return null;
        }
        return cleaned;
    } catch (e) {
        console.warn('SCM GitHub: updatePrBody for PR ' + prIdStr + ' failed:', e.message || e);
        return null;
    } finally {
        try { file_delete({ path: tempBodyPath }); } catch (e) { /* best-effort cleanup */ }
    }
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
        // Raw unified diff text via the PR API — works even after the PR is merged and
        // its head branch deleted (unlike a local `git diff <head>..<base>`).
        // Requires IS_READ_PULL_REQUEST_DIFF to be enabled; returns null on failure so
        // callers can fall back gracefully.
        getDiffText: function(prId) {
            return _githubGetDiffText(workspace, repository, prId);
        },
        addComment: function(prId, text) {
            return github_add_pr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
        },
        replyToThread: function(prId, thread, text) {
            return _githubReplyToThread(workspace, repository, prId, thread, text);
        },
        resolveThread: function(prId, thread) {
            return _githubResolveThread(workspace, repository, prId, thread);
        },
        addInlineComment: function(prId, filePath, line, text, startLine, side) {
            return github_add_inline_comment(
                _githubBuildInlineCommentOpts(workspace, repository, prId, filePath, line, text, startLine, side));
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
        // Formal GitHub PR review (Approve / Request Changes / Comment), separate from
        // the pr_approved label lifecycle. Opt-in feature — see postPRReviewComments.js.
        submitReview: function(prId, event, body) {
            return github_submit_pr_review({
                workspace: workspace, repository: repository,
                pullRequestId: String(prId), event: event, body: body || ''
            });
        },
        listReviews: function(prId) {
            var raw = github_list_pr_reviews({ workspace: workspace, repository: repository, pullRequestId: String(prId) });
            return _toArray(raw);
        },
        dismissReview: function(prId, reviewId, message) {
            return github_dismiss_pr_review({
                workspace: workspace, repository: repository,
                pullRequestId: String(prId), reviewId: String(reviewId), message: message
            });
        },
        getPrDiff: function(prId, workingDir) {
            return _githubGetPrDiff(workspace, repository, prId, workingDir);
        },
        getCommitCheckRuns: function(sha) {
            return _githubGetCommitCheckRuns(workspace, repository, sha);
        },
        getWorkflowRunJobs: function(runId) {
            return github_get_workflow_run_jobs({ workspace: workspace, repository: repository, runId: runId });
        },
        getJobLogs: function(jobId) {
            return github_get_job_logs({ workspace: workspace, repository: repository, jobId: String(jobId) });
        },
        listWorkflowRuns: function(status, workflowId, limit, owner, repo) {
            return github_list_workflow_runs(owner || workspace, repo || repository, status, workflowId, limit || 50);
        },
        triggerWorkflow: function(owner, repo, workflowFile, payload, ref) {
            return github_trigger_workflow(owner, repo, workflowFile, payload, ref);
        },
        updateBranch: function(prId, owner, repo) {
            return cli_execute_command({
                command: 'gh api repos/' + (owner || workspace) + '/' + (repo || repository) + '/pulls/' + prId + '/update-branch -X PUT'
            });
        },
        // gh-960: machine-owned body rewrite (was a dead seam — see
        // _githubUpdatePrBody). Callers must gate on isPrBodyFrozen() before
        // invoking: once validation is armed / the PR is merged, the body is
        // final and must not be rewritten.
        updatePrBody: function(prId, body) {
            return _githubUpdatePrBody(workspace, repository, prId, body);
        },
        fetchDiscussions: function(prId) {
            return _githubFetchDiscussions(workspace, repository, prId);
        },
        getRemoteRepoInfo: function() {
            return _githubGetRemoteRepoInfo();
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

/**
 * Normalize a GitLab commit status entry into the same shape detectFailedChecks()
 * expects from GitHub check runs: { name, conclusion, details_url }.
 */
function _normalizeGitLabCommitStatus(status) {
    var s = String(status.status || '').toLowerCase();
    var conclusion = (s === 'failed') ? 'failure'
        : (s === 'canceled') ? 'cancelled'
        : (s === 'success') ? 'success'
        : s; // pending/running/created/skipped pass through and are filtered out by detectFailedChecks
    return {
        name: status.name || 'unknown',
        conclusion: conclusion,
        details_url: status.target_url || null
    };
}

// ── GitLab MR discussion helpers (gh-925) ────────────────────────────────────
// Pure mappers/renderers extracted from _createGitLabProvider().fetchDiscussions
// (CRAP 648.7 in the baseline). Behaviour-preserving — pinned by
// test_scmGitlabDiscussions.js.
// NOTE: _gitlabRenderThreadSection reproduces the original renderer
// byte-for-byte, including the '\n\n' (blank line) after the body, reply and
// placeholder lines and before the '---' rule. Do NOT "tighten" these to a
// single '\n': the blank line is what keeps the rule a horizontal rule (a
// single '\n' turns 'body\n---' into a setext H2 heading).

function _gitlabThreadPosition(pos) {
    return {
        path: (pos && (pos.new_path || pos.old_path)) || null,
        line: (pos && (pos.new_line || pos.old_line)) || null
    };
}

function _gitlabMapDiscussionThread(thread, index) {
    var notes = thread.notes || [];
    var root = notes[0] || {};
    var position = _gitlabThreadPosition(root.position);
    return {
        index: index,
        rootCommentId: thread.id,
        threadId: thread.id,
        discussionId: thread.id,
        path: position.path,
        line: position.line,
        resolved: thread.resolved === true || root.resolved === true,
        body: (root.body || '').trim()
    };
}

function _gitlabThreadAuthor(author) {
    return author ? (author.username || author.name) : 'unknown';
}

function _gitlabThreadDate(comment) {
    return (comment && comment.created_at) ? comment.created_at.substring(0, 10) : '';
}

function _gitlabRenderThreadSection(mapped, root, replies) {
    var section = '### Thread ' + mapped.index;
    if (mapped.path) {
        section += ' — `' + mapped.path + '`';
        if (mapped.line) section += ' line ' + mapped.line;
    }
    section += '\n\n';
    section += mapped.body
        ? ('**' + _gitlabThreadAuthor(root.author) + '** (' + _gitlabThreadDate(root) + '):\n' + mapped.body + '\n\n')
        : '_[No comment body]_\n\n';
    var replyNotes = replies || [];
    for (var i = 0; i < replyNotes.length; i++) {
        var reply = replyNotes[i] || {};
        section += '> **' + _gitlabThreadAuthor(reply.author) + '** (' + _gitlabThreadDate(reply) + '): ' + (reply.body || '').trim() + '\n\n';
    }
    section += '---\n\n';
    return section;
}

function _gitlabFetchDiscussions(workspace, repository, prId) {
    var discussions = _toArray(gitlab_get_mr_discussions({
        workspace: workspace, repository: repository, pullRequestId: String(prId)
    }));
    var sections = [];
    var rawThreads = [];
    var section = '## Review Threads\n\n';
    var hasContent = false;

    discussions.forEach(function(thread) {
        var notes = thread.notes || [];
        var mapped = _gitlabMapDiscussionThread(thread, rawThreads.length + 1);
        rawThreads.push(mapped);
        if (mapped.resolved) return;
        hasContent = true;
        section += _gitlabRenderThreadSection(mapped, notes[0] || {}, notes.slice(1));
    });

    if (hasContent) sections.push(section);
    return {
        markdown: sections.length > 0
            ? '# PR Discussion History\n\n_Previous review discussions for MR #' + prId + '._\n\n' + sections.join('\n')
            : null,
        rawThreads: rawThreads.length > 0 ? { threads: rawThreads } : null
    };
}

// ── GitLab provider helpers (gh-981) ─────────────────────────────────────────
// Extraction of the remaining _createGitLabProvider method closures (provider
// at CRAP 179.5 in the baseline) into module-level functions — same pattern
// as the gh-925 ADO split and the gh-981 GitHub split. Behaviour-preserving:
// same tools, args, log lines and fallback order — pinned by
// test_scmGitlabProvider.js / test_scmGitlabReview.js.

function _gitlabListPrs(workspace, repository, state) {
    var requestedState = _normalizeGitLabState(state);
    var raw = gitlab_list_mrs({ workspace: workspace, repository: repository, state: requestedState });
    var prs = _toArray(raw).map(_normalizeGitLabMr);
    if (state === 'closed') {
        return prs.filter(function(pr) { return pr.state === 'closed' || pr.merged_at; });
    }
    return prs;
}

// See _createGithubProvider.getDiffText — same rationale (works post-merge).
function _gitlabGetDiffText(workspace, repository, prId) {
    try {
        return gitlab_get_mr_diff_text({ workspace: workspace, repository: repository, pullRequestId: String(prId) });
    } catch (e) {
        console.warn('getDiffText (gitlab) failed:', e && e.toString ? e.toString() : String(e));
        return null;
    }
}

// Formal review decision, provider-agnostic surface (see the github
// provider's submitReview). GitLab has no REQUEST_CHANGES event: the
// native mapping is APPROVE -> gitlab_approve_mr, REQUEST_CHANGES ->
// revoke our approval (gitlab_unapprove_mr) with the explanation left
// as a plain MR comment, COMMENT -> plain MR comment. GitLab (like
// GitHub) refuses approvals from the MR author unless the instance
// allows self-approval — callers must tolerate that error.
// addComment is the provider's own addComment (passed in by the closure).
function _gitlabSubmitReview(workspace, repository, prId, event, body, addComment) {
    var normalized = String(event || '').toUpperCase();
    if (normalized === 'APPROVE') {
        return gitlab_approve_mr({ workspace: workspace, repository: repository, pullRequestId: String(prId) });
    }
    if (normalized === 'REQUEST_CHANGES') {
        var result = gitlab_unapprove_mr({ workspace: workspace, repository: repository, pullRequestId: String(prId) });
        addComment(prId, body || 'AI review requested changes on this merge request.');
        return result;
    }
    return addComment(prId, body || '');
}

function _gitlabReplyToThread(workspace, repository, prId, thread, text) {
    var threadId = thread.threadId || thread.rootCommentId || thread.discussionId;
    if (threadId) {
        return gitlab_reply_to_mr_thread({
            workspace: workspace, repository: repository,
            pullRequestId: String(prId), discussionId: String(threadId), text: text
        });
    }
    return gitlab_add_mr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
}

function _gitlabResolveThread(workspace, repository, prId, thread) {
    var threadId = thread.threadId || thread.discussionId;
    if (threadId) {
        return gitlab_resolve_mr_thread({
            workspace: workspace, repository: repository,
            pullRequestId: String(prId), discussionId: String(threadId)
        });
    }
    console.warn('SCM GitLab: No discussion id to resolve');
}

// getPr is the provider's own getPr (passed in by the closure) — the inline
// comment needs the MR's diff_refs.
function _gitlabAddInlineComment(getPr, workspace, repository, prId, filePath, line, text, startLine, side) {
    var mr = getPr(prId);
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
}

// Primary diff tier: dmtools v1.7.221+ exposes a tool that returns the raw
// diff text directly. Returns the usable diff or null.
function _gitlabTryMrDiffText(workspace, repository, prIdStr) {
    if (typeof gitlab_get_mr_diff_text !== 'undefined') {
        try {
            var textRaw = gitlab_get_mr_diff_text({ workspace: workspace, repository: repository, pullRequestId: prIdStr });
            var textDiff = _extractDiffFromToolResult(textRaw);
            if (_isUsableDiff(textDiff)) {
                return textDiff;
            }
        } catch (e) {
            console.warn('gitlab_get_mr_diff_text failed:', e.message || e);
        }
    }
    return null;
}

// Final diff tier: generate the diff locally from the checked-out branch using
// the MR's base/head commit SHAs (requires the repo to be checked out at
// workingDir). getPr is the provider's own getPr.
function _gitlabMrDiffLocalFallback(workspace, repository, prIdStr, workingDir, getPr) {
    try {
        var mr = getPr(prIdStr);
        var refs = (mr && mr.diff_refs) || {};
        if (!refs.base_sha || !refs.head_sha) {
            throw new Error('MR missing diff_refs base_sha/head_sha');
        }
        return _runGitDiff(refs.base_sha, refs.head_sha, workingDir);
    } catch (e2) {
        console.warn('Local git diff fallback failed:', e2.message || e2);
        return '';
    }
}

function _gitlabGetPrDiff(workspace, repository, prId, workingDir, getPr) {
    var prIdStr = String(prId);

    var textDiff = _gitlabTryMrDiffText(workspace, repository, prIdStr);
    if (textDiff) {
        return textDiff;
    }

    // Legacy fallback: gitlab_get_mr_diff returns diff stats/metadata (IDiffStats) in
    // most builds, which serializes to a broken Java object toString (e.g.
    // "GitLab$4@abc123") instead of usable diff text through the MCP/JS bridge.
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

    console.log('GitLab MR diff MCP returned no usable diff; falling back to local git diff');
    var localDiff = _gitlabMrDiffLocalFallback(workspace, repository, prIdStr, workingDir, getPr);
    if (_isUsableDiff(localDiff)) {
        return localDiff;
    }

    return raw || '';
}

function _gitlabGetCommitCheckRuns(workspace, repository, sha) {
    if (!sha) return null;
    try {
        var raw = gitlab_get_commit_statuses({ workspace: workspace, repository: repository, commitSha: sha });
        var statuses = _toArray(raw);
        if (!statuses.length) return null;
        return statuses.map(_normalizeGitLabCommitStatus);
    } catch (e) {
        console.warn('SCM GitLab: failed to fetch commit statuses for', sha, ':', e.message || e);
        return null;
    }
}

// Map one GitLab pipeline run to the GitHub workflow-run shape.
function _gitlabMapPipelineRun(run) {
    return Object.assign({}, run, {
        name: run.name || run.ref || '',
        display_title: run.name || run.ref || '',
        status: run.status === 'running' ? 'in_progress' : run.status,
        run_number: run.id
    });
}

function _gitlabListWorkflowRuns(workspace, repository, status, workflowId, limit, owner, repo) {
    var runs = _toArray(gitlab_list_pipeline_runs({
        workspace: owner || workspace,
        repository: repo || repository,
        status: _normalizeGitLabPipelineStatus(status),
        ref: null,
        limit: String(limit || 50)
    }));
    return JSON.stringify({ workflow_runs: runs.map(_gitlabMapPipelineRun) });
}

// Payload key/values become pipeline variables; workflow_file rides along.
function _gitlabBuildPipelineVariables(workflowFile, payload) {
    var variables = {};
    var parsed = _parseJson(payload);
    if (parsed && typeof parsed === 'object') {
        Object.keys(parsed).forEach(function(key) {
            variables[key] = parsed[key];
        });
    }
    variables.workflow_file = workflowFile;
    return variables;
}

function _gitlabTriggerPipeline(owner, repo, workspace, repository, workflowFile, payload, ref) {
    return gitlab_trigger_pipeline({
        workspace: owner || workspace,
        repository: repo || repository,
        ref: ref || 'main',
        variablesJson: JSON.stringify(_gitlabBuildPipelineVariables(workflowFile, payload))
    });
}

function _gitlabCreatePr(workspace, repository, options) {
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
}

function _createGitLabProvider(workspace, repository) {
    return {
        listPrs: function(state) {
            return _gitlabListPrs(workspace, repository, state);
        },
        getPr: function(prId) {
            return _normalizeGitLabMr(_parseJson(gitlab_get_mr({
                workspace: workspace, repository: repository, pullRequestId: String(prId)
            })));
        },
        getPrComments: function(prId) {
            return _toArray(gitlab_get_mr_comments({ workspace: workspace, repository: repository, pullRequestId: String(prId) }));
        },
        // See _createGithubProvider.getDiffText — same rationale (works post-merge).
        getDiffText: function(prId) {
            return _gitlabGetDiffText(workspace, repository, prId);
        },
        addComment: function(prId, text) {
            return gitlab_add_mr_comment({ workspace: workspace, repository: repository, pullRequestId: String(prId), text: text });
        },
        // Formal review decision — see _gitlabSubmitReview for the event mapping.
        submitReview: function(prId, event, body) {
            var self = this;
            return _gitlabSubmitReview(workspace, repository, prId, event, body, function(p, t) {
                return self.addComment(p, t);
            });
        },
        replyToThread: function(prId, thread, text) {
            return _gitlabReplyToThread(workspace, repository, prId, thread, text);
        },
        resolveThread: function(prId, thread) {
            return _gitlabResolveThread(workspace, repository, prId, thread);
        },
        addInlineComment: function(prId, filePath, line, text, startLine, side) {
            var self = this;
            return _gitlabAddInlineComment(function(p) { return self.getPr(p); },
                workspace, repository, prId, filePath, line, text, startLine, side);
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
            var self = this;
            return _gitlabGetPrDiff(workspace, repository, prId, workingDir, function(p) {
                return self.getPr(p);
            });
        },
        getCommitCheckRuns: function(sha) {
            return _gitlabGetCommitCheckRuns(workspace, repository, sha);
        },
        getJobLogs: function(jobId) {
            return gitlab_get_job_logs({ workspace: workspace, repository: repository, jobId: String(jobId) });
        },
        listWorkflowRuns: function(status, workflowId, limit, owner, repo) {
            return _gitlabListWorkflowRuns(workspace, repository, status, workflowId, limit, owner, repo);
        },
        triggerWorkflow: function(owner, repo, workflowFile, payload, ref) {
            return _gitlabTriggerPipeline(owner, repo, workspace, repository, workflowFile, payload, ref);
        },
        createPr: function(options) {
            return _gitlabCreatePr(workspace, repository, options);
        },
        updateBranch: function(prId, owner, repo) {
            return gitlab_rebase_mr({
                workspace: owner || workspace,
                repository: repo || repository,
                pullRequestId: String(prId)
            });
        },
        fetchDiscussions: function(prId) {
            return _gitlabFetchDiscussions(workspace, repository, prId);
        },
        getRemoteRepoInfo: function() {
            return _detectRepoFromGitRemote('gitlab');
        }
    };
}

// ── ADO pure helpers (gh-925) ────────────────────────────────────────────────
// Extraction of the former 233-line _createAdoProvider closure (CRAP 4475,
// worst in the repo) into module-level pure functions. Behaviour-preserving —
// pinned by test_scmAdoProvider.js / test_scmAdoDiscussions.js.

// NOTE: this is the ONLY unwrapper that tolerates non-envelope payloads —
// bare arrays pass through and a bare object is returned as-is (`parsed || []`).
// listPrs/getPrComments are pinned on that passthrough; do not "unify" it with
// the stricter _adoParseRunList/_adoParsePipelines/_adoParseDiscussionThreads.
function _adoUnwrapList(raw) {
    var parsed = _parseJson(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && parsed.value) return parsed.value;
    return parsed || [];
}

function _adoListPrsStatus(state) {
    return state === 'open' ? 'active' : state;
}

function _adoBuildInlineCommentOpts(repository, prId, filePath, line, text, startLine, side) {
    var opts = {
        repository: repository, pullRequestId: String(prId),
        filePath: filePath, line: String(line), text: text
    };
    if (startLine) opts.startLine = String(startLine);
    if (side) opts.side = side;
    return opts;
}

function _adoBuildJobLogsOpts(jobId, tailLines) {
    var opts = { buildId: parseInt(String(jobId), 10) };
    if (tailLines) opts.tailLines = parseInt(String(tailLines), 10);
    return opts;
}

// NOTE: unlike _adoUnwrapList, a bare object is NOT a valid run list — {value}
// envelope first, bare arrays tolerated (Java-list compat), everything else → []
// (pinned: a bare object yields []).
function _adoParseRunList(raw) {
    var parsed = _parseJson(raw);
    var rawRuns = (parsed && parsed.value) ? parsed.value : (Array.isArray(parsed) ? parsed : []);
    // Convert Java list to native JS array for filter/map compat
    var runs = [];
    for (var i = 0; i < rawRuns.length; i++) { runs.push(rawRuns[i]); }
    return runs;
}

function _adoRunResultForStatus(status) {
    var filterStatus = status.toLowerCase();
    if (filterStatus === 'failure' || filterStatus === 'failed') return 'failed';
    if (filterStatus === 'success' || filterStatus === 'succeeded') return 'succeeded';
    return null;
}

function _adoRunStateForStatus(status) {
    var filterStatus = status.toLowerCase();
    if (filterStatus === 'in_progress') return 'inprogress';
    if (filterStatus === 'completed') return 'completed';
    return null;
}

function _adoRunMatchesStatusFilter(run, status) {
    // ADO run state: 'inProgress', 'completed', 'canceling', 'unknown'
    // ADO run result: 'succeeded', 'failed', 'canceled', 'unknown'
    var state = ((run && run.state) || '').toLowerCase();
    var result = ((run && run.result) || '').toLowerCase();
    var mappedResult = _adoRunResultForStatus(status);
    if (mappedResult) return result === mappedResult;
    var mappedState = _adoRunStateForStatus(status);
    if (mappedState) return state === mappedState;
    var filterStatus = status.toLowerCase();
    return state === filterStatus || result === filterStatus;
}

function _adoBuildPipelineRunsOpts(pipelineId, limit) {
    var opts = { pipelineId: parseInt(String(pipelineId), 10) };
    if (limit) opts.top = parseInt(String(limit), 10);
    return opts;
}

function _adoBuildTriggerOpts(pipelineId, ref, payload) {
    var opts = { pipelineId: parseInt(String(pipelineId), 10) };
    if (ref) opts.branch = ref;
    if (payload && typeof payload === 'object' && Object.keys(payload).length > 0) {
        opts.variables = JSON.stringify(payload);
    }
    return opts;
}

// NOTE: same contract as _adoParseRunList — {value} envelope first, bare
// arrays tolerated, everything else → [] (pinned; do not merge with
// _adoUnwrapList's looser passthrough).
function _adoParsePipelines(raw) {
    var parsed = _parseJson(raw);
    return (parsed && parsed.value) ? parsed.value : (Array.isArray(parsed) ? parsed : []);
}

function _adoFindPipelineByName(pipelines, name) {
    var wanted = String(name).toLowerCase();
    var match = pipelines.find(function(p) {
        return p.name && p.name.toLowerCase() === wanted;
    });
    return match ? match.id : null;
}

function _adoResolvePipelineId(workflowIdentifier) {
    if (!workflowIdentifier) return null;
    var asNum = Number(workflowIdentifier);
    if (!isNaN(asNum) && asNum > 0) return asNum;
    // Lookup by name via ado_list_pipelines
    try {
        var pipelines = _adoParsePipelines(ado_list_pipelines({}));
        return _adoFindPipelineByName(pipelines, workflowIdentifier);
    } catch (e) {
        console.warn('SCM ADO: _adoResolvePipelineId failed: ' + e);
        return null;
    }
}

function _adoReplyToThread(repository, prId, thread, text) {
    if (thread.threadId) {
        return ado_reply_to_pr_thread({
            repository: repository, pullRequestId: String(prId),
            threadId: String(thread.threadId), text: text
        });
    }
    return ado_add_pr_comment({ repository: repository, pullRequestId: String(prId), text: text });
}

function _adoResolveThread(repository, prId, thread) {
    if (thread.threadId) {
        return ado_resolve_pr_thread({
            repository: repository, pullRequestId: String(prId), threadId: String(thread.threadId)
        });
    }
    console.warn('SCM ADO: No threadId to resolve for ADO thread');
}

function _adoRemoveLabel(repository, prId, label, labelId) {
    return ado_remove_pr_label({ repository: repository, pullRequestId: String(prId), labelId: labelId || label });
}

function _adoGetRemoteRepoInfo() {
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

// ── ADO discussion helpers (gh-925) ──────────────────────────────────────────
// Extraction of the former _createAdoProvider().fetchDiscussions closure
// (CRAP 808.5 in the baseline).

// NOTE: unlike _adoUnwrapList, bare arrays are NOT valid threads — {value}
// envelopes only, everything else → [] (pinned: a bare array yields [] for
// fetchDiscussions but passes through for listPrs).
function _adoParseDiscussionThreads(raw) {
    var parsed = _parseJson(raw);
    return (parsed && parsed.value) ? parsed.value : [];
}

function _adoIsResolvedThreadStatus(status) {
    return status === 'fixed' || status === 'closed' ||
           status === 'resolved' || status === 'wontFix' ||
           status === 'byDesign';
}

function _adoThreadContextField(context, field) {
    return (context && context[field]) || null;
}

function _adoThreadLine(context) {
    return (context && context.rightFileStart && context.rightFileStart.line) || null;
}

function _adoThreadRawBody(comment) {
    return (comment && comment.content) || '';
}

function _adoThreadBody(comment) {
    return _adoThreadRawBody(comment).trim();
}

function _adoThreadAuthor(comment) {
    return (comment && comment.author && comment.author.displayName) || 'unknown';
}

function _adoThreadDate(comment) {
    return (comment && comment.publishedDate) ? comment.publishedDate.substring(0, 10) : '';
}

function _adoMapDiscussionThread(thread, index) {
    if (thread.isDeleted === true) return null;
    var rootComment = thread.comments && thread.comments[0];
    var threadId = String(thread.id);
    return {
        index: index,
        rootCommentId: threadId,
        threadId: threadId,
        path: _adoThreadContextField(thread.threadContext, 'filePath'),
        line: _adoThreadLine(thread.threadContext),
        resolved: _adoIsResolvedThreadStatus(thread.status),
        body: _adoThreadBody(rootComment)
    };
}

function _adoRenderThreadSection(mapped, rootComment) {
    var section = '### Thread ' + mapped.index;
    if (mapped.path) {
        section += ' — `' + mapped.path + '`';
        if (mapped.line) section += ' line ' + mapped.line;
    }
    section += '\n\n';
    // Raw-body truthiness (not the trimmed value) decides the placeholder branch —
    // a whitespace-only comment still renders its author line.
    if (_adoThreadRawBody(rootComment)) {
        section += '**' + _adoThreadAuthor(rootComment) + '** (' + _adoThreadDate(rootComment) + '):\n' + mapped.body + '\n\n';
    } else {
        section += '_[No comment body]_\n\n';
    }
    section += '---\n\n';
    return section;
}

function _adoApplyResolvedHeader(section, rawThreads) {
    var resolvedCount = rawThreads.filter(function(t) { return t.resolved; }).length;
    if (resolvedCount > 0) {
        return '> ℹ️ **' + resolvedCount + ' thread(s) already resolved and excluded from this review.**\n\n' + section;
    }
    return section;
}

function _adoFetchDiscussions(repository, prId) {
    var result = ado_get_pr_comments({ repository: repository, pullRequestId: String(prId) });
    var threads = _adoParseDiscussionThreads(result);
    var rawThreads = [];
    var sections = [];
    var section = '## Review Threads\n\n';
    var hasContent = false;

    threads.forEach(function(thread) {
        var mapped = _adoMapDiscussionThread(thread, rawThreads.length + 1);
        if (!mapped) return;
        rawThreads.push(mapped);
        if (!mapped.resolved) {
            hasContent = true;
            section += _adoRenderThreadSection(mapped, thread.comments && thread.comments[0]);
        }
    });

    if (hasContent) {
        section = _adoApplyResolvedHeader(section, rawThreads);
        sections.push(section);
    }
    var markdown = sections.length > 0
        ? '# PR Discussion History\n\n_Previous review discussions for PR #' + prId + '._\n\n' + sections.join('\n')
        : null;
    return { markdown: markdown, rawThreads: rawThreads.length > 0 ? { threads: rawThreads } : null };
}

function _createAdoProvider(repository) {
    return {
        listPrs: function(state) {
            return _adoUnwrapList(ado_list_prs({ repository: repository, status: _adoListPrsStatus(state) }));
        },
        getPr: function(prId) {
            return _parseJson(ado_get_pr({ repository: repository, pullRequestId: String(prId) }));
        },
        getPrComments: function(prId) {
            return _adoUnwrapList(ado_get_pr_comments({ repository: repository, pullRequestId: String(prId) }));
        },
        // ADO has no raw-unified-diff-text API (only file-level change stats via
        // ado_get_pr_diff) — return null so callers fall back to a file list.
        getDiffText: function() {
            return null;
        },
        addComment: function(prId, text) {
            return ado_add_pr_comment({ repository: repository, pullRequestId: String(prId), text: text });
        },
        replyToThread: function(prId, thread, text) {
            return _adoReplyToThread(repository, prId, thread, text);
        },
        resolveThread: function(prId, thread) {
            return _adoResolveThread(repository, prId, thread);
        },
        addInlineComment: function(prId, filePath, line, text, startLine, side) {
            return ado_add_inline_comment(
                _adoBuildInlineCommentOpts(repository, prId, filePath, line, text, startLine, side));
        },
        mergePr: function(prId, mergeMethod, commitTitle, commitMessage) {
            return ado_merge_pr({ repository: repository, pullRequestId: String(prId) });
        },
        addLabel: function(prId, label) {
            return ado_add_pr_label({ repository: repository, pullRequestId: String(prId), label: label });
        },
        removeLabel: function(prId, label, labelId) {
            return _adoRemoveLabel(repository, prId, label, labelId);
        },
        getPrDiff: function(prId) {
            return ado_get_pr_diff({ repository: repository, pullRequestId: String(prId) });
        },
        getCommitCheckRuns: function(sha) {
            console.warn('SCM ADO: getCommitCheckRuns has no direct ADO equivalent — returning null');
            return null;
        },
        getJobLogs: function(jobId, tailLines) {
            return ado_get_pipeline_logs(_adoBuildJobLogsOpts(jobId, tailLines));
        },
        listWorkflowRuns: function(status, workflowId, limit) {
            var pipelineId = _adoResolvePipelineId(workflowId);
            if (!pipelineId) {
                console.warn('SCM ADO: listWorkflowRuns — could not resolve pipeline for: ' + workflowId);
                return null;
            }
            var runs = _adoParseRunList(ado_list_pipeline_runs(_adoBuildPipelineRunsOpts(pipelineId, limit)));
            if (status) {
                runs = runs.filter(function(r) {
                    return _adoRunMatchesStatusFilter(r, status);
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
            return ado_trigger_pipeline(_adoBuildTriggerOpts(pipelineId, ref, payload));
        },
        fetchDiscussions: function(prId) {
            return _adoFetchDiscussions(repository, prId);
        },
        getRemoteRepoInfo: function() {
            return _adoGetRemoteRepoInfo();
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
                    l.indexOf('gitlab.example.com') !== -1 ||
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
    // gh-1041: exposed as a testable helper (file_read bridge form tolerance)
    _readFileMaybe: _readFileMaybe,
    _createGithubProvider: _createGithubProvider,
    _createGitLabProvider: _createGitLabProvider,
    _createAdoProvider: _createAdoProvider,
    _normalizeGitLabCommitStatus: _normalizeGitLabCommitStatus,
    _normalizeGithubCommitStatus: _normalizeGithubCommitStatus,
    _getLegacyGithubCommitStatuses: _getLegacyGithubCommitStatuses,
    _unwrapGithubCheckRuns: _unwrapGithubCheckRuns,
    // gh-981: GitHub/GitLab provider internals exposed as testable pure helpers
    _githubGetDiffText: _githubGetDiffText,
    _githubReplyToThread: _githubReplyToThread,
    _githubResolveThread: _githubResolveThread,
    _githubBuildInlineCommentOpts: _githubBuildInlineCommentOpts,
    _githubTryPrDiffText: _githubTryPrDiffText,
    _githubTryPrDiffTool: _githubTryPrDiffTool,
    _githubLocalGitDiffFallback: _githubLocalGitDiffFallback,
    _githubPrBaseHeadRefs: _githubPrBaseHeadRefs,
    _githubGetPrDiff: _githubGetPrDiff,
    _githubMergeLegacyStatuses: _githubMergeLegacyStatuses,
    _githubGetCommitCheckRuns: _githubGetCommitCheckRuns,
    _githubLogInventoryCounts: _githubLogInventoryCounts,
    _githubFetchReviewThreadInventory: _githubFetchReviewThreadInventory,
    _githubCollectThreadInventory: _githubCollectThreadInventory,
    _githubRenderCommentsSection: _githubRenderCommentsSection,
    _githubFetchGeneralCommentsSection: _githubFetchGeneralCommentsSection,
    _githubBuildDiscussionsMarkdown: _githubBuildDiscussionsMarkdown,
    _githubFetchDiscussions: _githubFetchDiscussions,
    _githubGetRemoteRepoInfo: _githubGetRemoteRepoInfo,
    _gitlabListPrs: _gitlabListPrs,
    _gitlabGetDiffText: _gitlabGetDiffText,
    _gitlabSubmitReview: _gitlabSubmitReview,
    _gitlabReplyToThread: _gitlabReplyToThread,
    _gitlabResolveThread: _gitlabResolveThread,
    _gitlabAddInlineComment: _gitlabAddInlineComment,
    _gitlabTryMrDiffText: _gitlabTryMrDiffText,
    _gitlabMrDiffLocalFallback: _gitlabMrDiffLocalFallback,
    _gitlabGetPrDiff: _gitlabGetPrDiff,
    _gitlabGetCommitCheckRuns: _gitlabGetCommitCheckRuns,
    _gitlabMapPipelineRun: _gitlabMapPipelineRun,
    _gitlabListWorkflowRuns: _gitlabListWorkflowRuns,
    _gitlabBuildPipelineVariables: _gitlabBuildPipelineVariables,
    _gitlabTriggerPipeline: _gitlabTriggerPipeline,
    _gitlabCreatePr: _gitlabCreatePr,
    // gh-925: ADO/GitLab provider internals exposed as testable pure helpers
    _gitlabThreadPosition: _gitlabThreadPosition,
    _gitlabMapDiscussionThread: _gitlabMapDiscussionThread,
    _gitlabThreadAuthor: _gitlabThreadAuthor,
    _gitlabThreadDate: _gitlabThreadDate,
    _gitlabRenderThreadSection: _gitlabRenderThreadSection,
    _gitlabFetchDiscussions: _gitlabFetchDiscussions,
    _adoUnwrapList: _adoUnwrapList,
    _adoListPrsStatus: _adoListPrsStatus,
    _adoBuildInlineCommentOpts: _adoBuildInlineCommentOpts,
    _adoBuildJobLogsOpts: _adoBuildJobLogsOpts,
    _adoParseRunList: _adoParseRunList,
    _adoRunResultForStatus: _adoRunResultForStatus,
    _adoRunStateForStatus: _adoRunStateForStatus,
    _adoRunMatchesStatusFilter: _adoRunMatchesStatusFilter,
    _adoBuildPipelineRunsOpts: _adoBuildPipelineRunsOpts,
    _adoBuildTriggerOpts: _adoBuildTriggerOpts,
    _adoParsePipelines: _adoParsePipelines,
    _adoFindPipelineByName: _adoFindPipelineByName,
    _adoResolvePipelineId: _adoResolvePipelineId,
    _adoReplyToThread: _adoReplyToThread,
    _adoResolveThread: _adoResolveThread,
    _adoRemoveLabel: _adoRemoveLabel,
    _adoGetRemoteRepoInfo: _adoGetRemoteRepoInfo,
    _adoParseDiscussionThreads: _adoParseDiscussionThreads,
    _adoIsResolvedThreadStatus: _adoIsResolvedThreadStatus,
    _adoThreadContextField: _adoThreadContextField,
    _adoThreadLine: _adoThreadLine,
    _adoThreadRawBody: _adoThreadRawBody,
    _adoThreadBody: _adoThreadBody,
    _adoThreadAuthor: _adoThreadAuthor,
    _adoThreadDate: _adoThreadDate,
    _adoMapDiscussionThread: _adoMapDiscussionThread,
    _adoRenderThreadSection: _adoRenderThreadSection,
    _adoApplyResolvedHeader: _adoApplyResolvedHeader,
    _adoFetchDiscussions: _adoFetchDiscussions
};
