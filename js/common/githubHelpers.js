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
 *
 * gh-808: the machine's own arming/status notices are dropped from both
 * discussion files (marker-keyed classification — see ./machineNotice.js),
 * so the rework input carries only genuine review threads. gh-957: the
 * inventory itself is built by ./reviewThreadInventory.js (GraphQL-first —
 * the same reviewThreads census the SM arm rule counts).
 */

const prHelper = require('./pullRequest.js');
const gitOps = require('./gitOps.js');
const reviewThreadInventory = require('./reviewThreadInventory.js');
const ciModule = require('./ci.js');

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
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

// Helpers for robust ticket-key → PR matching.
// Keep everything project-agnostic: no project/company names, no conventions tied to one org.

function _normalizeForMatch(s) {
    return String(s || '').toLowerCase();
}

function _extractNumericPart(ticketKey) {
    var m = String(ticketKey || '').match(/(\d+)$/);
    return m ? m[1] : '';
}

function _containsBoundedNumber(s, number) {
    if (!s || !number) return false;
    var re = new RegExp('(^|[^a-z0-9])' + number + '([^a-z0-9]|$)', 'i');
    return re.test(s);
}

function _isBotAuthor(author) {
    if (!author) return false;
    if (author.is_bot === true || author.type === 'Bot') return true;
    var login = String(author.login || '');
    return login.indexOf('[bot]') !== -1 ||
           login.indexOf('-bot') !== -1 ||
           login.indexOf('_bot') !== -1;
}

function _headPrefixScore(ref) {
    if (!ref) return 0;
    var lower = ref.toLowerCase();
    if (lower.indexOf('feature/') === 0 || lower.indexOf('bug/') === 0) return 20;
    if (lower.indexOf('release/') === 0) return -10;
    return 0;
}

function _scorePR(pr, normalizedKey, numericPart) {
    var title = _normalizeForMatch(pr.title);
    var branch = _normalizeForMatch(pr.head && pr.head.ref);
    var score = 0;

    if (title.indexOf(normalizedKey) !== -1) score += 100;
    if (branch.indexOf(normalizedKey) !== -1) score += 80;

    if (numericPart && numericPart.length >= 3) {
        if (_containsBoundedNumber(title, numericPart)) score += 40;
        if (_containsBoundedNumber(branch, numericPart)) score += 30;
    }

    // Only apply preference bonuses/penalties when the PR actually matches the ticket.
    if (score === 0) return 0;

    score += _headPrefixScore(pr.head && pr.head.ref);

    if (_isBotAuthor(pr.user || pr.author)) score -= 50;

    var changedFiles = pr.changed_files;
    if (typeof changedFiles === 'number') {
        score += Math.max(0, 25 - Math.floor(changedFiles / 10));
    }

    return score;
}

function findPRForTicket(scmOrWorkspace, repositoryOrTicketKey, ticketKeyOpt, optionsOpt) {
    var openPRs, ticketKey, options;
    try {
        var isScmForm = _isScm(scmOrWorkspace);
        if (isScmForm) {
            ticketKey = repositoryOrTicketKey;
            options = ticketKeyOpt || {};
        } else {
            ticketKey = ticketKeyOpt;
            options = optionsOpt || {};
        }
        console.log('Searching for PR related to', ticketKey);

        // PR-anchored lookup (githubSource #544): a pseudo-ticket key 'pr-N' IS
        // the PR number — fetch it directly (REST pulls/{n}) instead of
        // list-scanning. The scan can never reliably match a pseudo key: the
        // PR's title/head reference the ORIGINAL work item, and a single
        // listPrs page may not even contain the PR (live fa #1212, 2026-10-04:
        // key 'pr-1212', PR titled/branched 'ai/gh-1204' among 10+ open PRs —
        // the scan produced "No open Pull Request found" false negatives at
        // the start gate and in the post-action). Case-sensitive lowercase,
        // same convention as preCliReworkSetup's anchor — a real uppercase
        // Jira key like 'PR-1212' keeps the list-scan path below.
        var anchorMatch = /^pr-(\d+)$/.exec(String(ticketKey || ''));
        if (anchorMatch) {
            var prNumber = anchorMatch[1];
            try {
                var anchoredPr = isScmForm
                    ? scmOrWorkspace.getPr(prNumber)
                    : github_get_pr({
                        workspace: scmOrWorkspace,
                        repository: repositoryOrTicketKey,
                        pullRequestId: prNumber
                    });
                if (anchoredPr) {
                    if (anchoredPr.state && String(anchoredPr.state) !== 'open') {
                        console.warn('PR #' + prNumber + ' (anchor of ' + ticketKey + ') is ' + anchoredPr.state + ' — treating as not found');
                        return null;
                    }
                    console.log('PR-anchored lookup:', ticketKey, '→ PR #' + prNumber + ':', anchoredPr.title);
                    return anchoredPr;
                }
            } catch (anchorError) {
                console.error('Failed to fetch PR #' + prNumber + ' for ticket ' + ticketKey + ':', anchorError.message || anchorError);
            }
            // No list-scan fallback for anchored keys: a failed direct fetch IS
            // the answer (missing/hidden/closed PR). Scanning would reintroduce
            // the false-negative race this path exists to eliminate.
            console.warn('No open PR found for ticket', ticketKey, '(direct PR #' + prNumber + ' lookup failed)');
            return null;
        }

        openPRs = isScmForm
            ? scmOrWorkspace.listPrs('open')
            : github_list_prs({ workspace: scmOrWorkspace, repository: repositoryOrTicketKey, state: 'open' });
        console.log('Found', openPRs.length, 'open PRs');

        var normalizedKey = _normalizeForMatch(ticketKey);
        var numericPart = _extractNumericPart(ticketKey);
        var candidates = [];

        for (var i = 0; i < openPRs.length; i++) {
            var pr = openPRs[i];
            var score = _scorePR(pr, normalizedKey, numericPart);
            if (score > 0) {
                candidates.push({ pr: pr, score: score });
            }
        }

        if (candidates.length === 0) {
            console.warn('No open PR found for ticket', ticketKey);
            return null;
        }

        candidates.sort(function(a, b) {
            if (b.score !== a.score) return b.score - a.score;
            var aFiles = a.pr.changed_files || 0;
            var bFiles = b.pr.changed_files || 0;
            return aFiles - bFiles;
        });

        if (typeof options.prSearchFn === 'function') {
            try {
                var hookResult = options.prSearchFn(
                    candidates.map(function(c) { return c.pr; }),
                    ticketKey,
                    options
                );
                if (hookResult) {
                    console.log('Project prSearchFn selected PR #' + hookResult.number + ':', hookResult.title);
                    return hookResult;
                }
            } catch (hookErr) {
                console.warn('prSearchFn hook failed (non-fatal):', hookErr);
            }
        }

        console.log('Selected open PR #' + candidates[0].pr.number + ':', candidates[0].pr.title);
        return candidates[0].pr;
    } catch (e) {
        console.error('Failed to find PR for ticket:', e);
        return null;
    }
}

/**
 * Finds the most recently MERGED PR/MR for a ticket — the counterpart to
 * findPRForTicket() (which only looks at open PRs). Used by flows that run
 * after a ticket reaches a "merged" status, e.g. distilling review-knowledge
 * lessons once the PR is closed and no longer editable.
 *
 * Matches by ticket key in the PR title or head branch name, same as
 * findPRForTicket(). Only the scm-object calling convention is supported
 * (unlike findPRForTicket, no legacy workspace/repository overload).
 */
function findMergedPRForTicket(scm, ticketKey, options) {
    try {
        options = options || {};
        console.log('Searching for merged PR related to', ticketKey);
        var closedPRs = scm.listPrs('closed') || [];
        console.log('Found', closedPRs.length, 'closed PRs');

        var normalizedKey = _normalizeForMatch(ticketKey);
        var numericPart = _extractNumericPart(ticketKey);
        var candidates = [];

        for (var i = 0; i < closedPRs.length; i++) {
            var pr = closedPRs[i];
            if (!pr.merged_at) continue;
            var score = _scorePR(pr, normalizedKey, numericPart);
            if (score > 0) {
                candidates.push({ pr: pr, score: score });
            }
        }

        if (candidates.length === 0) {
            console.warn('No merged PR found for ticket', ticketKey);
            return null;
        }

        candidates.sort(function(a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return new Date(b.pr.merged_at).getTime() - new Date(a.pr.merged_at).getTime();
        });

        if (typeof options.prSearchFn === 'function') {
            try {
                var hookResult = options.prSearchFn(
                    candidates.map(function(c) { return c.pr; }),
                    ticketKey,
                    options
                );
                if (hookResult) {
                    console.log('Project prSearchFn selected merged PR #' + hookResult.number + ':', hookResult.title);
                    return hookResult;
                }
            } catch (hookErr) {
                console.warn('prSearchFn hook failed (non-fatal):', hookErr);
            }
        }

        console.log('Found merged PR #' + candidates[0].pr.number + ':', candidates[0].pr.title);
        return candidates[0].pr;
    } catch (e) {
        console.error('Failed to find merged PR for ticket:', e);
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

    // Inline review threads (gh-957): GraphQL-first inventory — enumerated
    // from the SAME reviewThreads census the SM arm rule counts, enriched
    // from the conversations export; the conversations-first legacy path
    // inside the shared module is the fallback when GraphQL fails or is
    // empty. Runs when EITHER source has data — a PR whose conversations
    // export is empty/incomplete but whose GraphQL census carries open
    // threads (the live dart #424 shape) must still produce the full
    // inventory.
    var conversations = [];
    try {
        conversations = github_get_pr_conversations({
            workspace: workspace,
            repository: repository,
            pullRequestId: prIdStr
        }) || [];
    } catch (e) {
        console.warn('github_get_pr_conversations failed:', e.message || e);
    }
    var graphqlRaw = null;
    try {
        graphqlRaw = github_get_pr_review_threads({
            workspace: workspace,
            repository: repository,
            pullRequestId: prIdStr
        });
        console.log('Got', reviewThreadInventory.parseGraphQLNodes(graphqlRaw).length, 'review threads for GraphQL IDs');
    } catch (e) {
        console.warn('github_get_pr_review_threads failed (falling back to conversations-only inventory):', e.message || e);
    }
    var inv = null;
    try {
        inv = reviewThreadInventory.collectThreadInventory(conversations, graphqlRaw);
        if (conversations.length > 0 || inv.threads.length > 0) {
            inv.threads.forEach(function(t) { rawThreads.push(t); });
            sections.push(inv.markdownSection);
            var invCounts = inv.counts;
            console.log('Discussions: ' + invCounts.total + ' threads (' + invCounts.open + ' open, ' + invCounts.resolved + ' resolved, ' + invCounts.bot + ' bot, ' + invCounts.notices + ' machine notices),',
                rawThreads.filter(function(t) { return t.rootCommentId; }).length + ' reply IDs,',
                rawThreads.filter(function(t) { return t.threadId; }).length + ' resolve IDs' +
                (inv.census.graphqlUnresolved !== null
                    ? ' — GraphQL census: ' + inv.census.graphqlUnresolved + ' unresolved (arm-rule count)'
                    : ''));
        }
    } catch (e) {
        console.warn('review-thread inventory build failed:', e.message || e);
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

    const raw = rawThreads.length > 0
        ? { threads: rawThreads, census: inv ? inv.census : null }
        : null;

    return { markdown: markdown, rawThreads: raw };
}

/**
 * Unwrap a dmtools tool result: when the raw value is a JSON string
 * carrying a `.result` payload, return the payload; otherwise return
 * the value as-is (plain logs pass through untouched).
 */
function _unwrapToolResult(raw) {
    if (typeof raw !== 'string') return raw;
    try {
        var parsed = JSON.parse(raw);
        return (parsed && parsed.result) ? parsed.result : raw;
    } catch (e) { return raw; }
}

/**
 * Fetch a workflow job's logs either through an SCM provider or the
 * github_get_job_logs tool, with the JSON-string `.result` unwrapping
 * applied. Shared by the /jobs/N and /runs/N details_url paths.
 */
function _fetchJobLogs(scm, owner, repo, jobId) {
    var raw = scm
        ? scm.getJobLogs(String(jobId))
        : github_get_job_logs({ workspace: owner, repository: repo, jobId: String(jobId) });
    return _unwrapToolResult(raw);
}

/**
 * Detect failed CI checks for the PR head commit.
 * Uses github_get_commit_check_runs to find failures, then fetches job logs.
 * Writes ci_failures.md to the input folder when failures are found.
 *
 * Dual-mode: accepts either an SCM object or (owner, repo, headSha, inputFolder) strings.
 * In SCM mode an optional jenkinsBasePath can be passed to fetch Jenkins console logs
 * for failed checks whose details_url points at the configured Jenkins instance.
 */
// ─── Pure helpers extracted from detectFailedChecks (gh-1012) ────────────────

/** Normalize a check-runs payload (object or JSON string) into a check-runs array. */
function parseCheckRunsResult(rawResult) {
    var parsed = rawResult;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) {}
    }
    return Array.isArray(parsed) ? parsed
        : (parsed && parsed.check_runs ? parsed.check_runs : []);
}

/** Unwrap a JSON { result: ... } tool response, passing everything else through. */
function unwrapLogResult(rawLogs) {
    var logs = rawLogs;
    if (typeof rawLogs === 'string') {
        try {
            var parsedLogs = JSON.parse(rawLogs);
            if (parsedLogs && parsedLogs.result) logs = parsedLogs.result;
        } catch (e) { /* keep the raw string */ }
    }
    return logs;
}

/** Resolve a Jenkins details_url to { jobPath, buildNumber } under jenkinsBasePath, or null. */
function extractJenkinsBuildTarget(detailsUrl, jenkinsBasePath) {
    if (!jenkinsBasePath || !detailsUrl || detailsUrl.indexOf(jenkinsBasePath) !== 0) return null;
    var relativePath = detailsUrl.substring(jenkinsBasePath.length).replace(/^[\/]+/, '');
    var pathParts = relativePath.split('/').filter(function(p) { return p.length > 0; });
    var buildNumber = null;
    var jobPathParts = [];
    for (var i = 0; i < pathParts.length; i++) {
        if (/^\d+$/.test(pathParts[i])) {
            buildNumber = parseInt(pathParts[i], 10);
            break;
        }
        jobPathParts.push(pathParts[i]);
    }
    if (!buildNumber || jobPathParts.length === 0) return null;
    return { jobPath: jobPathParts.join('/'), buildNumber: buildNumber };
}

/** Build the md snippet + full-log block for one failed check, or null when there are no logs. */
function buildLogSections(check, logs, label) {
    if (!logs) return null;
    var lines = logs.split('\n');
    var snippet = lines.slice(-500).join('\n');
    return {
        md: '**' + label + ' (last 500 lines)**:\n\n```\n' + snippet + '\n```\n\n',
        full: '=== ' + label + ' for: ' + check.name + ' ===\n' +
              'URL: ' + (check.details_url || 'N/A') + '\n' +
              logs + '\n\n'
    };
}

/** Fetch the raw GitHub job log for a check whose details_url contains /jobs/{id}. */
function fetchGithubCheckLogs(check, scm, owner, repo) {
    var jobIdMatch = check.details_url && check.details_url.match(/\/jobs?\/(\d+)/);
    if (jobIdMatch) {
        try {
            var rawLogs = scm ? scm.getJobLogs(jobIdMatch[1]) : github_get_job_logs({
                workspace: owner, repository: repo, jobId: jobIdMatch[1]
            });
            return unwrapLogResult(rawLogs);
        } catch (e) {
            console.warn('Could not fetch logs for job', jobIdMatch[1], ':', e.message || e);
            return null;
        }
    }
    // gh-982 (merge conflict resolution): check-run URLs shaped /actions/runs/N
    // carry no job id — resolve the run's failed jobs and fetch each log.
    return fetchGithubRunLogs(check, scm, owner, repo);
}

/** True for a run job whose logs matter: a failed/timed-out job with an id. */
function isFailedRunJob(runJob) {
    if (!runJob || runJob.id === undefined || runJob.id === null) return false;
    return runJob.conclusion === 'failure' || runJob.conclusion === 'timed_out';
}

/** Fetch the failed jobs' logs of a workflow RUN whose details_url contains /runs/{id}. */
function fetchGithubRunLogs(check, scm, owner, repo) {
    var runIdMatch = check.details_url && check.details_url.match(/\/runs\/(\d+)/);
    if (!runIdMatch) return null;
    try {
        var rawJobs = (scm && typeof scm.getWorkflowRunJobs === 'function')
            ? scm.getWorkflowRunJobs(runIdMatch[1])
            : github_get_workflow_run_jobs({
                workspace: owner, repository: repo, runId: runIdMatch[1]
            });
        var out = '';
        ciModule._jobsOf(rawJobs).forEach(function (runJob) {
            if (!isFailedRunJob(runJob)) return;
            var jobLogs = _fetchJobLogs(scm, owner, repo, runJob.id);
            if (jobLogs) out += '=== ' + (runJob.name || 'job ' + runJob.id) + ' ===\n' + jobLogs + '\n';
        });
        return out || null;
    } catch (e) {
        console.warn('Could not fetch jobs/logs for run', runIdMatch[1], ':', e.message || e);
        return null;
    }
}

/** Fetch the raw Jenkins build log for a check whose details_url resolves to a build target. */
function fetchJenkinsCheckLogs(check, jenkinsBasePath) {
    var target = extractJenkinsBuildTarget(check.details_url, jenkinsBasePath);
    if (!target) return null;
    try {
        jenkins_get_job_info({ jobPath: target.jobPath, buildNumber: target.buildNumber });
        return unwrapLogResult(jenkins_get_build_log({ jobPath: target.jobPath, buildNumber: target.buildNumber }));
    } catch (e) {
        console.warn('Could not fetch Jenkins logs for', check.details_url, ':', e.message || e);
        return null;
    }
}

function buildCiFailuresHeader(failedChecks, headSha) {
    var md = '# ⚠️ Failed CI Checks — Fix Before Completing Rework\n\n';
    md += 'Full (untruncated) logs are available in `ci_failures_full.log`.\n\n';
    md += failedChecks.length + ' check(s) failed on commit `' + headSha.substring(0, 8) + '`:\n\n';
    return md;
}

function buildCiFailuresResolutionSection() {
    return '---\n\n## Resolution\n\n' +
           '1. Read the error log(s) above to identify the root cause\n' +
           '2. For more context, open `ci_failures_full.log` with the complete logs\n' +
           '3. Fix the underlying code issue(s)\n' +
           '4. CI will re-run automatically after the push — all checks must pass\n';
}

function detectFailedChecks(scmOrOwner, repoOrHeadSha, headShaOrInputFolder, inputFolderOpt, jenkinsBasePathOpt) {
    var scm = null;
    var owner, repo, headSha, inputFolder, jenkinsBasePath;

    if (_isScm(scmOrOwner)) {
        scm = scmOrOwner;
        headSha = repoOrHeadSha;
        inputFolder = headShaOrInputFolder;
        jenkinsBasePath = inputFolderOpt;
    } else {
        owner = scmOrOwner;
        repo = repoOrHeadSha;
        headSha = headShaOrInputFolder;
        inputFolder = inputFolderOpt;
        jenkinsBasePath = jenkinsBasePathOpt;
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

        var checkRuns = parseCheckRunsResult(rawResult);

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

        var md = buildCiFailuresHeader(failedChecks, headSha);

        var fullLogContent = '';

        failedChecks.forEach(function(check) {
            md += '## ❌ ' + check.name + '\n\n';
            md += '- **Conclusion**: ' + check.conclusion + '\n';
            if (check.details_url) {
                md += '- **Details**: ' + check.details_url + '\n';
            }
            md += '\n';

            var ghSections = buildLogSections(check, fetchGithubCheckLogs(check, scm, owner, repo), 'Error log');
            if (ghSections) {
                md += ghSections.md;
                fullLogContent += ghSections.full;
            }

            // Jenkins: failed check whose details_url points at the configured Jenkins instance
            var jenkinsSections = buildLogSections(check, fetchJenkinsCheckLogs(check, jenkinsBasePath), 'Jenkins error log');
            if (jenkinsSections) {
                md += jenkinsSections.md;
                fullLogContent += jenkinsSections.full;
            }
        });

        md += buildCiFailuresResolutionSection();

        file_write({ path: inputFolder + '/ci_failures.md', content: md });
        console.log('✅ Wrote ci_failures.md (' + failedChecks.length + ' failed check(s))');

        if (fullLogContent) {
            file_write({ path: inputFolder + '/ci_failures_full.log', content: fullLogContent });
            console.log('✅ Wrote ci_failures_full.log');
        }

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
    findMergedPRForTicket: findMergedPRForTicket,
    getPRDetails: getPRDetails,
    fetchDiscussionsAndRawData: fetchDiscussionsAndRawData,
    detectFailedChecks: detectFailedChecks,

    // Pure helpers extracted from detectFailedChecks (gh-1012) — exported for
    // unit testing; detectFailedChecks behavior is unchanged.
    parseCheckRunsResult: parseCheckRunsResult,
    fetchGithubCheckLogs: fetchGithubCheckLogs,
    fetchGithubRunLogs: fetchGithubRunLogs,
    isFailedRunJob: isFailedRunJob,
    unwrapLogResult: unwrapLogResult,
    extractJenkinsBuildTarget: extractJenkinsBuildTarget,
    buildLogSections: buildLogSections,
    buildCiFailuresHeader: buildCiFailuresHeader,
    buildCiFailuresResolutionSection: buildCiFailuresResolutionSection,

    // Re-exported from ./gitOps.js for backward compatibility — these are
    // plain git-CLI operations, not GitHub-specific. New code should prefer
    // requiring ./gitOps.js directly.
    checkoutPRBranch: gitOps.checkoutPRBranch,
    getPRDiff: gitOps.getPRDiff,
    trimLargeTextForInput: gitOps.trimLargeTextForInput,
    writePRContext: gitOps.writePRContext,
    detectMergeConflicts: gitOps.detectMergeConflicts
};

