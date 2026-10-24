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
const ciViolations = require('./ciViolations.js');
// gh-1248: the review-discussion fetch/render blocks — one canonical copy
// shared with js/common/scm.js' github provider.
const githubReviewFetch = require('./githubReviewFetch.js');

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

// gh-1226 (CRAP ratchet): pure splits of _scorePR — pinned by the
// findPRForTicket/findMergedPRForTicket characterization tests.

// Bounded digit-run bonus: the key's numeric part appearing in the normalized
// title (+40) and head branch (+30), only for keys with a 3+ digit part.
function _numericPartBonus(title, branch, numericPart) {
    var bonus = 0;
    if (numericPart && numericPart.length >= 3) {
        if (_containsBoundedNumber(title, numericPart)) bonus += 40;
        if (_containsBoundedNumber(branch, numericPart)) bonus += 30;
    }
    return bonus;
}

// Smaller, more focused PRs score higher: 25 - changed_files/10, floored at 0.
// A missing changed_files count contributes nothing.
function _changedFilesBonus(changedFiles) {
    if (typeof changedFiles !== 'number') return 0;
    return Math.max(0, 25 - Math.floor(changedFiles / 10));
}

function _scorePR(pr, normalizedKey, numericPart) {
    var title = _normalizeForMatch(pr.title);
    var branch = _normalizeForMatch(pr.head && pr.head.ref);
    var score = 0;

    if (title.indexOf(normalizedKey) !== -1) score += 100;
    if (branch.indexOf(normalizedKey) !== -1) score += 80;

    score += _numericPartBonus(title, branch, numericPart);

    // Only apply preference bonuses/penalties when the PR actually matches the ticket.
    if (score === 0) return 0;

    score += _headPrefixScore(pr.head && pr.head.ref);

    if (_isBotAuthor(pr.user || pr.author)) score -= 50;

    score += _changedFilesBonus(pr.changed_files);

    return score;
}

// gh-1194: findPRForTicket stage helpers (CRAP ratchet) — pure splits of the
// former inline blocks. Same calls, logs, fallback order and try/catch reach.

// Calling-convention juggling: (scm, ticketKey[, options]) vs the legacy
// (workspace, repository, ticketKey[, options]).
function _ticketLookupForm(scmOrWorkspace, repositoryOrTicketKey, ticketKeyOpt, optionsOpt) {
    if (_isScm(scmOrWorkspace)) {
        return {
            isScmForm: true,
            ticketKey: repositoryOrTicketKey,
            options: ticketKeyOpt || {}
        };
    }
    return {
        isScmForm: false,
        ticketKey: ticketKeyOpt,
        options: optionsOpt || {}
    };
}

// PR-anchored lookup (githubSource #544): a pseudo-ticket key 'pr-N' IS
// the PR number — fetch it directly (REST pulls/{n}) instead of
// list-scanning. The scan can never reliably match a pseudo key: the
// PR's title/head reference the ORIGINAL work item, and a single
// listPrs page may not even contain the PR (live fa #1212, 2026-10-04:
// key 'pr-1212', PR titled/branched 'ai/gh-1204' among 10+ open PRs —
// the scan produced "No open Pull Request found" false negatives at
// the start gate and in the post-action). Case-sensitive lowercase,
// same convention as preCliReworkSetup's anchor — a real uppercase
// Jira key like 'PR-1212' keeps the list-scan path.
// No list-scan fallback for anchored keys: a failed direct fetch IS
// the answer (missing/hidden/closed PR). Scanning would reintroduce
// the false-negative race this path exists to eliminate.
function _anchoredPrForTicket(isScmForm, scmOrWorkspace, repository, ticketKey, anchorMatch) {
    var prNumber = anchorMatch[1];
    try {
        var anchoredPr = isScmForm
            ? scmOrWorkspace.getPr(prNumber)
            : github_get_pr({
                workspace: scmOrWorkspace,
                repository: repository,
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
    console.warn('No open PR found for ticket', ticketKey, '(direct PR #' + prNumber + ' lookup failed)');
    return null;
}

// Open-PR candidates for the list-scan: only PRs whose title or head branch
// carries the ticket key (score > 0).
function _scoredCandidates(openPRs, normalizedKey, numericPart) {
    var candidates = [];
    for (var i = 0; i < openPRs.length; i++) {
        var pr = openPRs[i];
        var score = _scorePR(pr, normalizedKey, numericPart);
        if (score > 0) {
            candidates.push({ pr: pr, score: score });
        }
    }
    return candidates;
}

// Best candidate first: score desc, then fewest changed files (smallest, most
// focused change wins a tie).
function _rankCandidates(candidates) {
    candidates.sort(function(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        var aFiles = a.pr.changed_files || 0;
        var bFiles = b.pr.changed_files || 0;
        return aFiles - bFiles;
    });
}

// gh-1226 (CRAP ratchet): merged-PR ranking — score desc, then the most
// recently merged PR wins a tie (the ordering findMergedPRForTicket always had).
function _rankMergedCandidates(candidates) {
    candidates.sort(function(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.pr.merged_at).getTime() - new Date(a.pr.merged_at).getTime();
    });
}

// Project prSearchFn hook — non-fatal: a hook result wins, a missing hook or
// a failed one yields null (the caller keeps the ranked top candidate).
function _applyPrSearchHook(candidates, ticketKey, options, logLabel) {
    if (typeof options.prSearchFn !== 'function') return null;
    try {
        var hookResult = options.prSearchFn(
            candidates.map(function(c) { return c.pr; }),
            ticketKey,
            options
        );
        if (hookResult) {
            console.log('Project prSearchFn selected ' + logLabel + ' #' + hookResult.number + ':', hookResult.title);
            return hookResult;
        }
    } catch (hookErr) {
        console.warn('prSearchFn hook failed (non-fatal):', hookErr);
    }
    return null;
}

function findPRForTicket(scmOrWorkspace, repositoryOrTicketKey, ticketKeyOpt, optionsOpt) {
    try {
        var form = _ticketLookupForm(scmOrWorkspace, repositoryOrTicketKey, ticketKeyOpt, optionsOpt);
        var ticketKey = form.ticketKey;
        console.log('Searching for PR related to', ticketKey);

        var anchorMatch = /^pr-(\d+)$/.exec(String(ticketKey || ''));
        if (anchorMatch) {
            return _anchoredPrForTicket(form.isScmForm, scmOrWorkspace, repositoryOrTicketKey, ticketKey, anchorMatch);
        }

        var openPRs = form.isScmForm
            ? scmOrWorkspace.listPrs('open')
            : github_list_prs({ workspace: scmOrWorkspace, repository: repositoryOrTicketKey, state: 'open' });
        console.log('Found', openPRs.length, 'open PRs');

        var candidates = _scoredCandidates(openPRs, _normalizeForMatch(ticketKey), _extractNumericPart(ticketKey));

        if (candidates.length === 0) {
            console.warn('No open PR found for ticket', ticketKey);
            return null;
        }

        _rankCandidates(candidates);

        var hooked = _applyPrSearchHook(candidates, ticketKey, form.options, 'PR');
        if (hooked) return hooked;

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

        // gh-1226 (CRAP ratchet): only actually-MERGED PRs whose title or head
        // branch carries the ticket key — the same filter + _scorePR scan the
        // former inline loop ran, via the shared _scoredCandidates helper.
        var candidates = _scoredCandidates(
            closedPRs.filter(function(pr) { return !!pr.merged_at; }),
            _normalizeForMatch(ticketKey),
            _extractNumericPart(ticketKey)
        );

        if (candidates.length === 0) {
            console.warn('No merged PR found for ticket', ticketKey);
            return null;
        }

        _rankMergedCandidates(candidates);

        var hooked = _applyPrSearchHook(candidates, ticketKey, options, 'merged PR');
        if (hooked) return hooked;

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

// ── fetchDiscussionsAndRawData helpers (gh-1086 extraction; gh-1248: the
// implementations moved to githubReviewFetch.js — one canonical copy shared
// with js/common/scm.js' github provider) ──────────────────────────────────
// Each helper keeps the exact call order, log text and fallback semantics of
// the original inline implementation.

function fetchPrConversations(workspace, repository, prIdStr) {
    return githubReviewFetch.fetchPrConversations(workspace, repository, prIdStr);
}

function fetchPrReviewThreadsRaw(workspace, repository, prIdStr) {
    return githubReviewFetch.fetchPrReviewThreadsRaw(workspace, repository, prIdStr);
}

/**
 * Build the review-thread inventory from the conversations export and the
 * GraphQL census, pushing thread rows into rawThreads and the markdown
 * section into sections when EITHER source has data. Returns the inventory
 * (its census flows into the raw payload), or null when the build failed.
 */
function appendReviewThreadInventory(conversations, graphqlRaw, sections, rawThreads) {
    var inv = null;
    try {
        inv = reviewThreadInventory.collectThreadInventory(conversations, graphqlRaw);
        if (conversations.length > 0 || inv.threads.length > 0) {
            inv.threads.forEach(function(t) { rawThreads.push(t); });
            sections.push(inv.markdownSection);
            githubReviewFetch.logInventoryCounts(inv, rawThreads);
        }
    } catch (e) {
        console.warn('review-thread inventory build failed:', e.message || e);
    }
    return inv;
}

/**
 * Render the general PR comments section body (marker comments skipped,
 * bodies trimmed, per-comment separator). Callers gate on comments being
 * non-empty, exactly like the pre-extraction inline code.
 */
function buildGeneralCommentsSection(comments) {
    return githubReviewFetch.buildGeneralCommentsSection(comments);
}

/**
 * Fetch general PR comments and render their section; null when the fetch
 * fails or there are no comments (no section is pushed in either case).
 */
function fetchGeneralCommentsSection(workspace, repository, prIdStr) {
    try {
        var comments = github_get_pr_comments({
            workspace: workspace,
            repository: repository,
            pullRequestId: prIdStr
        });
        if (comments && comments.length > 0) {
            return buildGeneralCommentsSection(comments);
        }
    } catch (e) {
        console.warn('github_get_pr_comments failed:', e.message || e);
    }
    return null;
}

function buildDiscussionsMarkdown(sections, pullRequestId) {
    return sections.length > 0
        ? '# PR Discussion History\n\n' +
          '_Previous review discussions for PR #' + pullRequestId + '._\n\n' +
          sections.join('\n')
        : null;
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
    var conversations = fetchPrConversations(workspace, repository, prIdStr);
    var graphqlRaw = fetchPrReviewThreadsRaw(workspace, repository, prIdStr);
    var inv = appendReviewThreadInventory(conversations, graphqlRaw, sections, rawThreads);

    // General PR comments
    var commentsSection = fetchGeneralCommentsSection(workspace, repository, prIdStr);
    if (commentsSection !== null) {
        sections.push(commentsSection);
    }

    const markdown = buildDiscussionsMarkdown(sections, pullRequestId);

    const raw = rawThreads.length > 0
        ? { threads: rawThreads, census: inv ? inv.census : null }
        : null;

    return { markdown: markdown, rawThreads: raw };
}

// gh-1097 follow-up: hidden `<!-- dmtools:` audit comments are machine
// bookkeeping — the marker predicate is machineNotice.isDmtoolsMarkerBody,
// applied inside githubReviewFetch.buildGeneralCommentsSection (gh-1248).

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
// ─── Pure helpers extracted from detectFailedChecks (gh-1007) ────────────────

/** Normalize a check-runs payload (object or JSON string) into a check-runs array. */
function parseCheckRunsResult(rawResult) {
    var parsed = rawResult;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) {}
    }
    return Array.isArray(parsed) ? parsed
        : (parsed && parsed.check_runs ? parsed.check_runs : []);
}

/**
 * Unwrap a JSON { result: ... } tool response, passing everything else through.
 * gh-1045 review: consolidated onto _unwrapToolResult — the two JSON-unwrap
 * helpers were near-identical; one implementation now serves both the
 * /jobs/{id} and /runs/{id} paths.
 */
function unwrapLogResult(rawLogs) {
    return _unwrapToolResult(rawLogs);
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

/** Build the md snippet + full-log block for one failed check, or null when there are no logs.
 * gh-1119: the RAW logs ride along (sections.logs) so the violation extractor can run
 * on them without re-parsing the rendered markdown. */
function buildLogSections(check, logs, label) {
    if (!logs) return null;
    var lines = logs.split('\n');
    var snippet = lines.slice(-500).join('\n');
    return {
        md: '**' + label + ' (last 500 lines)**:\n\n```\n' + snippet + '\n```\n\n',
        full: '=== ' + label + ' for: ' + check.name + ' ===\n' +
              'URL: ' + (check.details_url || 'N/A') + '\n' +
              logs + '\n\n',
        logs: logs
    };
}

/**
 * gh-1045: loud variant of fetchGithubCheckLogs — resolves the logs for one
 * failed check and ALWAYS reports an outcome: { logs } on success, or
 * { reason } explaining why nothing could be fetched. A check whose log
 * cannot be fetched must never fail silently again (the rework leg then has
 * no idea WHAT to fix and no-ops).
 *
 * Dispatch-only by details_url shape (per-shape work lives in the helpers,
 * which also keeps each function under the CRAP ratchet):
 *   /jobs/{id}          → fetchGithubJobLogsDetailed
 *   /actions/runs/{id}  → fetchGithubRunLogsDetailed (gh-982 run-jobs path)
 *   bare /runs/{id}     → fetchGithubCheckRunLogsDetailed (the id IS a
 *                         check-run id; Actions job-log endpoints accept it)
 *   anything else       → unsupported shape (Jenkins/foreign URLs are handled
 *                         by the Jenkins resolver, not here)
 */
function fetchGithubCheckLogsDetailed(check, scm, owner, repo) {
    var url = (check && check.details_url) ? String(check.details_url) : '';
    var jobIdMatch = url.match(/\/jobs?\/(\d+)/);
    if (jobIdMatch) return fetchGithubJobLogsDetailed(jobIdMatch[1], scm, owner, repo);
    if (/\/actions\/runs\/\d+/.test(url)) {
        return fetchGithubRunLogsDetailed(check, scm, owner, repo);
    }
    var checkRunId = extractGithubCheckRunId(check);
    if (checkRunId) return fetchGithubCheckRunLogsDetailed(checkRunId, scm, owner, repo);
    if (!url) return { reason: 'check run has no details_url' };
    return { reason: 'unsupported details_url shape: ' + url };
}

/** gh-1045: loud /jobs/{id} branch — { logs } or { reason }. */
function fetchGithubJobLogsDetailed(jobId, scm, owner, repo) {
    try {
        var logs = _fetchJobLogs(scm, owner, repo, jobId);
        if (logs) return { logs: logs };
        return { reason: 'job log for ' + jobId + ' came back empty' };
    } catch (e) {
        console.warn('Could not fetch logs for job', jobId, ':', e.message || e);
        return { reason: 'job log fetch failed: ' + fetchFailureDetail(e) };
    }
}

/** gh-1045: loud bare-check-run branch — { logs } or { reason }. */
function fetchGithubCheckRunLogsDetailed(checkRunId, scm, owner, repo) {
    try {
        var logs = _fetchJobLogs(scm, owner, repo, checkRunId);
        if (logs) return { logs: logs };
        return { reason: 'check-run ' + checkRunId + ' log came back empty (check run is not backed by a GitHub Actions job?)' };
    } catch (e) {
        console.warn('Could not fetch logs for check-run', checkRunId, ':', e.message || e);
        return { reason: 'check-run log fetch failed: ' + fetchFailureDetail(e) };
    }
}

/** Fetch the raw GitHub job log for a check whose details_url contains /jobs/{id}. */
function fetchGithubCheckLogs(check, scm, owner, repo) {
    return fetchGithubCheckLogsDetailed(check, scm, owner, repo).logs || null;
}

/** True for a run job whose logs matter: a failed/timed-out job with an id. */
function isFailedRunJob(runJob) {
    if (!runJob || runJob.id === undefined || runJob.id === null) return false;
    return runJob.conclusion === 'failure' || runJob.conclusion === 'timed_out';
}

/**
 * gh-1045: extract the numeric CHECK-RUN id from a BARE check-run details URL
 * (`https://github.com/o/runs/{id}` — the canonical check-run page). Returns
 * null for `/actions/runs/{id}` URLs: those carry a WORKFLOW-RUN id and stay
 * on the run-jobs path (fetchGithubRunLogs). Conflating the two ids is the
 * root cause of the silent missing ci_failures_full.log — a check-run id
 * pushed through the workflow-run API resolves nothing and fails silently.
 */
function extractGithubCheckRunId(check) {
    var url = (check && check.details_url) ? String(check.details_url) : '';
    if (!url) return null;
    if (/\/actions\/runs\/\d+/.test(url)) return null;
    var m = url.match(/\/runs\/(\d+)/);
    return m ? m[1] : null;
}

/** Extract the numeric workflow-run id from a details_url shaped /runs/{id}. */
function extractGithubRunId(check) {
    var runIdMatch = check.details_url && check.details_url.match(/\/runs\/(\d+)/);
    return runIdMatch ? runIdMatch[1] : null;
}

/** Fetch the jobs payload of a workflow run via the scm provider or the gh tool. */
function fetchWorkflowRunJobs(scm, owner, repo, runId) {
    return (scm && typeof scm.getWorkflowRunJobs === 'function')
        ? scm.getWorkflowRunJobs(runId)
        : github_get_workflow_run_jobs({
            workspace: owner, repository: repo, runId: runId
        });
}

/** Concatenate the logs of a run's failed jobs, each under a `=== name ===` header. */
function formatFailedRunJobLogs(scm, owner, repo, rawJobs) {
    var out = '';
    ciModule._jobsOf(rawJobs).forEach(function (runJob) {
        if (!isFailedRunJob(runJob)) return;
        var jobLogs = _fetchJobLogs(scm, owner, repo, runJob.id);
        if (jobLogs) out += '=== ' + (runJob.name || 'job ' + runJob.id) + ' ===\n' + jobLogs + '\n';
    });
    return out || null;
}

/**
 * gh-1045: loud variant of fetchGithubRunLogs — { logs } on success, { reason }
 * when the run's failed-job logs could not be produced.
 */
function fetchGithubRunLogsDetailed(check, scm, owner, repo) {
    var runId = extractGithubRunId(check);
    if (!runId) return { reason: 'unsupported details_url shape: ' + ((check && check.details_url) || 'none') };
    try {
        var rawJobs = fetchWorkflowRunJobs(scm, owner, repo, runId);
        var out = formatFailedRunJobLogs(scm, owner, repo, rawJobs);
        if (out) return { logs: out };
        return { reason: runLogsFailureReason(rawJobs, runId) };
    } catch (e) {
        console.warn('Could not fetch jobs/logs for run', runId, ':', e.message || e);
        return { reason: 'run ' + runId + ' jobs/logs fetch failed: ' + fetchFailureDetail(e) };
    }
}

/** gh-1045: why a workflow run produced no log output despite being fetched. */
function runLogsFailureReason(rawJobs, runId) {
    var failedJobs = ciModule._jobsOf(rawJobs).filter(isFailedRunJob);
    if (failedJobs.length > 0) {
        return 'logs for ' + failedJobs.length + ' failed job(s) of run ' + runId + ' came back empty';
    }
    return 'no failed jobs resolved from workflow run ' + runId;
}

/** gh-1045: format a caught exception for a loud { reason }. */
function fetchFailureDetail(e) {
    return e && e.message ? e.message : String(e);
}

/** Fetch the failed jobs' logs of a workflow RUN whose details_url contains /runs/{id}. */
function fetchGithubRunLogs(check, scm, owner, repo) {
    return fetchGithubRunLogsDetailed(check, scm, owner, repo).logs || null;
}

/**
 * gh-1045: loud variant of fetchJenkinsCheckLogs. Three outcomes:
 *   { logs }   — Jenkins console log fetched
 *   { reason } — the URL IS a Jenkins build but the fetch failed/empty
 *   { skipped: true } — not a Jenkins URL (foreign host or no base path
 *       configured): not an error, the GitHub/other resolver may own it
 */
function fetchJenkinsCheckLogsDetailed(check, jenkinsBasePath) {
    var target = extractJenkinsBuildTarget(check.details_url, jenkinsBasePath);
    if (!target) return { skipped: true };
    try {
        jenkins_get_job_info({ jobPath: target.jobPath, buildNumber: target.buildNumber });
        var logs = unwrapLogResult(jenkins_get_build_log({ jobPath: target.jobPath, buildNumber: target.buildNumber }));
        if (logs) return { logs: logs };
        return { reason: 'Jenkins build log came back empty for ' + check.details_url };
    } catch (e) {
        console.warn('Could not fetch Jenkins logs for', check.details_url, ':', e.message || e);
        return { reason: 'Jenkins log fetch failed: ' + (e && e.message ? e.message : String(e)) };
    }
}

/** Fetch the raw Jenkins build log for a check whose details_url resolves to a build target. */
function fetchJenkinsCheckLogs(check, jenkinsBasePath) {
    return fetchJenkinsCheckLogsDetailed(check, jenkinsBasePath).logs || null;
}

/**
 * gh-1045: resolve one failed check's logs through BOTH resolvers (a
 * details_url can be a GitHub shape, a Jenkins build, or neither) and build
 * its md + full-log sections. When no resolver produced logs, the sections
 * carry a loud per-check failure entry instead.
 */
function buildCheckLogSections(check, scm, owner, repo, jenkinsBasePath) {
    var ghResult = fetchGithubCheckLogsDetailed(check, scm, owner, repo);
    var jenkinsResult = fetchJenkinsCheckLogsDetailed(check, jenkinsBasePath);

    var md = '';
    var full = '';
    var logs = '';
    if (ghResult.logs) {
        var ghSections = buildLogSections(check, ghResult.logs, 'Error log');
        md += ghSections.md;
        full += ghSections.full;
        logs += ghResult.logs + '\n';
    }
    if (jenkinsResult.logs) {
        var jenkinsSections = buildLogSections(check, jenkinsResult.logs, 'Jenkins error log');
        md += jenkinsSections.md;
        full += jenkinsSections.full;
        logs += jenkinsResult.logs + '\n';
    }
    if (full) return { md: md, full: full, logs: logs, ok: true };
    return failedLogSections(check, checkLogFailureReason(ghResult, jenkinsResult));
}

/** gh-1045: the loud per-check failure entry (md + full-log marker). */
function failedLogSections(check, reason) {
    return {
        md: '- ⚠️ **Log**: log fetch failed: ' + reason + '\n\n',
        full: '=== LOG FETCH FAILED for: ' + check.name + ' ===\n' +
              'URL: ' + (check.details_url || 'N/A') + '\n' +
              'Reason: ' + reason + '\n\n',
        ok: false,
        reason: reason
    };
}

// Max CI runs on the head scanned for an orphan's same-named job (bounds calls).
var ORPHAN_FALLBACK_MAX_RUNS = 5;

/** Parse a list-workflow-runs payload (object / JSON string / array) into runs. */
function runsOfPayload(raw) {
    var p = _unwrapToolResult(raw);
    if (typeof p === 'string') {
        try { p = JSON.parse(p); } catch (e) { return []; }
    }
    if (Array.isArray(p)) return p;
    return (p && (p.workflow_runs || p.workflowRuns)) || [];
}

/** Workflow runs on headSha, newest first (gh-orphan fallback). */
function listRunsForHead(scm, owner, repo, headSha) {
    var raw = (scm && typeof scm.listWorkflowRuns === 'function')
        ? scm.listWorkflowRuns(null, null, 50)
        : github_list_workflow_runs({ workspace: owner, repository: repo, perPage: 50 });
    return runsOfPayload(raw).filter(function (r) {
        return r && String(r.head_sha || r.headSha) === String(headSha);
    }).sort(function (a, b) { return Number(b.id) - Number(a.id); });
}

/** Logs of the failed job named `name` in one run, or null. */
function sameNamedJobLogs(scm, owner, repo, run, name) {
    var job = ciModule._jobsOf(fetchWorkflowRunJobs(scm, owner, repo, String(run.id)))
        .filter(function (j) { return isFailedRunJob(j) && j.name === name; })[0];
    if (!job) return null;
    var logs = _fetchJobLogs(scm, owner, repo, job.id);
    return logs ? { logs: logs, runUrl: run.html_url || ('run ' + run.id) } : null;
}

/**
 * Orphan/placeholder check-runs (SM-kicker mirrored verdicts, 0 steps) have
 * no job logs by nature — the job-log endpoint 404s. Their REAL logs live in
 * the same-named failed job of the latest CI run on the same head.
 * Returns { logs, runUrl } or null.
 */
function findSameNamedJobLogsOnHead(check, scm, owner, repo, headSha) {
    try {
        var runs = listRunsForHead(scm, owner, repo, headSha).slice(0, ORPHAN_FALLBACK_MAX_RUNS);
        for (var i = 0; i < runs.length; i++) {
            var found = sameNamedJobLogs(scm, owner, repo, runs[i], check.name);
            if (found) return found;
        }
    } catch (e) {
        console.warn('Orphan fallback for', check.name, 'failed:', fetchFailureDetail(e));
    }
    return null;
}

/** Clear reason for an orphan check whose real logs could not be found. */
function orphanReason(check, priorReason) {
    return 'orphan check-run (no job logs; mirrored verdict) — see run ' + (check.details_url || 'N/A') +
        (priorReason ? ' [' + priorReason + ']' : '');
}

/** Resolve an orphan check's sections via the same-head fallback or the orphan reason. */
function resolveOrphanSections(check, scm, owner, repo, headSha, priorReason) {
    var found = findSameNamedJobLogsOnHead(check, scm, owner, repo, headSha);
    if (!found) return failedLogSections(check, orphanReason(check, priorReason));
    var sections = buildLogSections(check, '(orphan check-run — logs from same-named job in ' + found.runUrl + ')\n' + found.logs, 'Error log');
    sections.ok = true;
    return sections;
}

/** True when a same-named failed check already resolved real logs. */
function hasResolvedTwin(entry, entries) {
    return entries.some(function (other) {
        return other !== entry && other.sections.ok && other.check.name === entry.check.name;
    });
}

/**
 * Resolve every failed check's sections, then handle orphan check-runs
 * (bare /runs/{id} whose log fetch failed): dedupe into a same-named check
 * that has real logs, else fall back to the same-named job on the head.
 * Returns the surviving [{ check, sections }].
 */
function resolveFailedCheckSections(failedChecks, scm, owner, repo, headSha, jenkinsBasePath) {
    var entries = failedChecks.map(function (check) {
        return { check: check, sections: buildCheckLogSections(check, scm, owner, repo, jenkinsBasePath) };
    });
    return entries.filter(function (entry) {
        if (entry.sections.ok || !extractGithubCheckRunId(entry.check)) return true;
        if (hasResolvedTwin(entry, entries)) return false;
        entry.sections = resolveOrphanSections(entry.check, scm, owner, repo, headSha, entry.sections.reason);
        return true;
    });
}

/**
 * gh-1045 review: pick the most accurate failure reason for a check whose
 * log no resolver produced. When the URL resolved to a Jenkins build target
 * but the Jenkins fetch failed/emptied, the Jenkins reason must win — the
 * GitHub resolver's "unsupported details_url shape" is misleading there
 * (the shape IS supported). jenkinsResult.skipped pins the foreign-host
 * case, where the GitHub reason is the correct one.
 */
function checkLogFailureReason(ghResult, jenkinsResult) {
    if (jenkinsResult.reason && !jenkinsResult.skipped) return jenkinsResult.reason;
    return ghResult.reason || jenkinsResult.reason || 'unknown fetch failure';
}

function buildCiFailuresHeader(failedChecks, headSha, hasFullLog) {
    var md = '# ⚠️ Failed CI Checks — Fix Before Completing Rework\n\n';
    if (hasFullLog !== false) {
        md += 'Full (untruncated) logs are available in `ci_failures_full.log`.\n\n';
    } else {
        // gh-1045 AC2: never reference the full log when it was not written —
        // not even to explain its absence.
        md += '⚠️ Full logs could NOT be saved (full-log file write failed) — ' +
              'use each check\'s **Details** link below.\n\n';
    }
    md += failedChecks.length + ' check(s) failed on commit `' + headSha.substring(0, 8) + '`:\n\n';
    return md;
}

function buildCiFailuresResolutionSection(hasFullLog) {
    var section = '---\n\n## Resolution\n\n' +
           '1. Read the error log(s) above to identify the root cause\n';
    if (hasFullLog !== false) {
        section += '2. For more context, open `ci_failures_full.log` with the complete logs\n';
    } else {
        section += '2. For more context, open the failing check(s) via their **Details** links above ' +
                   '(full-log file write failed)\n';
    }
    section += '3. Fix the underlying code issue(s)\n' +
           '4. CI will re-run automatically after the push — all checks must pass\n';
    return section;
}

/** gh-1119: extract+tag violations from every check whose logs resolved. */
function extractViolationsFromEntries(entries, diffText) {
    var checkLogs = [];
    (entries || []).forEach(function(entry) {
        if (entry.sections && entry.sections.ok && entry.sections.logs) {
            checkLogs.push({ name: entry.check.name, logs: entry.sections.logs });
        }
    });
    if (checkLogs.length === 0) return [];
    var violations = ciViolations.extractAndTagViolations(checkLogs, diffText);
    if (violations.length > 0) {
        console.log('⚠️ Extracted ' + violations.length + ' gate violation(s) from the failed-check logs (' +
            ciViolations.ownedViolations(violations).length + ' owned)');
    }
    return violations;
}

/** gh-1119: best-effort ci_violations.json write (full uncapped list, E2). */
function writeViolationsJson(inputFolder, violations) {
    if (!violations || violations.length === 0) return;
    try {
        file_write({
            path: inputFolder + '/ci_violations.json',
            content: JSON.stringify(ciViolations.violationsSummaryJson(violations), null, 2)
        });
        console.log('✅ Wrote ci_violations.json (' + violations.length + ' violation(s))');
    } catch (e) {
        console.warn('Could not write ci_violations.json (non-fatal):', e && e.message ? e.message : String(e));
    }
}

/** gh-1119: '' when nothing was extracted — today's file, unchanged (AC5/I3). */
function buildViolationsBlock(violations) {
    return ciViolations.buildViolationsMarkdown(violations);
}

// ── gh-1226 (CRAP ratchet): pure/IO splits of detectFailedChecks ─────────────
// Each helper keeps the exact calls, order, logs and fallback semantics of the
// inline block it replaces — pinned by the detectFailedChecks suites above.

// Calling-convention split: (scm, headSha, inputFolder[, jenkinsBasePath[, diffText]])
// vs the legacy (owner, repo, headSha, inputFolder[, ...]) form.
function _detectFailedCheckArgs(scmOrOwner, repoOrHeadSha, headShaOrInputFolder, inputFolderOpt, jenkinsBasePathOpt, diffTextOpt) {
    if (_isScm(scmOrOwner)) {
        return {
            scm: scmOrOwner,
            owner: null,
            repo: null,
            headSha: repoOrHeadSha,
            inputFolder: headShaOrInputFolder,
            jenkinsBasePath: inputFolderOpt,
            diffText: diffTextOpt
        };
    }
    return {
        scm: null,
        owner: scmOrOwner,
        repo: repoOrHeadSha,
        headSha: headShaOrInputFolder,
        inputFolder: inputFolderOpt,
        jenkinsBasePath: jenkinsBasePathOpt,
        diffText: diffTextOpt
    };
}

// Commit check-runs for the head — scm-object form first, legacy github_* form
// otherwise. Returns null ONLY when the SCM explicitly reports no check runs:
// the caller exits silently, exactly as before (no "No CI checks" log).
function _fetchCommitCheckRuns(scm, owner, repo, headSha) {
    if (scm) {
        var rawResult = scm.getCommitCheckRuns(headSha);
        if (rawResult === null) return null;
        return parseCheckRunsResult(rawResult);
    }
    return parseCheckRunsResult(github_get_commit_check_runs({
        workspace: owner,
        repository: repo,
        commitSha: headSha
    }));
}

// Per-check markdown sections + the concatenated full logs (gh-1045 contract:
// every failed check resolves to logs OR a loud reason in entry.sections).
function _failedCheckSectionsMarkdown(entries) {
    var mdBody = '';
    var fullLogContent = '';

    entries.forEach(function(entry) {
        var check = entry.check;
        mdBody += '## ❌ ' + check.name + '\n\n';
        mdBody += '- **Conclusion**: ' + check.conclusion + '\n';
        if (check.details_url) {
            mdBody += '- **Details**: ' + check.details_url + '\n';
        }
        mdBody += '\n';

        // gh-1045: every failed check resolves to logs OR a loud reason —
        // a silently missing log is what sent the #423 rework legs in blind.
        mdBody += entry.sections.md;
        fullLogContent += entry.sections.full;
    });

    return { mdBody: mdBody, fullLogContent: fullLogContent };
}

// gh-1045: the full log is written FIRST, whenever failed checks exist
// (fetched logs + per-check error markers) — and ci_failures.md may
// reference it only when the write actually succeeded. Never advertise
// a file that was not written.
function _tryWriteFullLog(inputFolder, fullLogContent) {
    try {
        file_write({ path: inputFolder + '/ci_failures_full.log', content: fullLogContent });
        console.log('✅ Wrote ci_failures_full.log');
        return true;
    } catch (writeErr) {
        console.warn('Could not write ci_failures_full.log (non-fatal):',
            writeErr && writeErr.message ? writeErr.message : String(writeErr));
        return false;
    }
}

function detectFailedChecks(scmOrOwner, repoOrHeadSha, headShaOrInputFolder, inputFolderOpt, jenkinsBasePathOpt, diffTextOpt) {
    var args = _detectFailedCheckArgs(scmOrOwner, repoOrHeadSha, headShaOrInputFolder, inputFolderOpt, jenkinsBasePathOpt, diffTextOpt);
    var scm = args.scm;
    var owner = args.owner;
    var repo = args.repo;
    var headSha = args.headSha;
    var inputFolder = args.inputFolder;
    var jenkinsBasePath = args.jenkinsBasePath;
    var diffText = args.diffText;

    try {
        if (!headSha) {
            console.warn('detectFailedChecks: no headSha provided, skipping');
            return [];
        }

        console.log('Checking CI status for commit:', headSha.substring(0, 8) + '...');

        var checkRuns = _fetchCommitCheckRuns(scm, owner, repo, headSha);
        if (checkRuns === null) {
            return [];
        }

        if (!checkRuns.length) {
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

        var entries = resolveFailedCheckSections(failedChecks, scm, owner, repo, headSha, jenkinsBasePath);
        failedChecks = entries.map(function(e) { return e.check; });

        // gh-1119: extract gate violations from the RAW resolved logs and tag
        // each one owned/foreign against the PR diff file list. The block is
        // prepended to ci_failures.md so the rework leg cannot miss it; with
        // zero extracted violations (unknown log shape, I3) nothing changes.
        var violations = extractViolationsFromEntries(entries, diffText);

        var sections = _failedCheckSectionsMarkdown(entries);

        var fullLogWritten = _tryWriteFullLog(inputFolder, sections.fullLogContent);

        // gh-1119: the full uncapped violation list lands in ci_violations.json
        // (E2) — best-effort, a write failure never costs the leg its table.
        writeViolationsJson(inputFolder, violations);

        var md = buildCiFailuresHeader(failedChecks, headSha, fullLogWritten) +
                 buildViolationsBlock(violations) +
                 sections.mdBody +
                 buildCiFailuresResolutionSection(fullLogWritten);

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
    // gh-1194: findPRForTicket stage helpers exposed as testable pure helpers
    _ticketLookupForm: _ticketLookupForm,
    _anchoredPrForTicket: _anchoredPrForTicket,
    _scoredCandidates: _scoredCandidates,
    _rankCandidates: _rankCandidates,
    _applyPrSearchHook: _applyPrSearchHook,
    findMergedPRForTicket: findMergedPRForTicket,
    getPRDetails: getPRDetails,
    fetchDiscussionsAndRawData: fetchDiscussionsAndRawData,
    fetchPrConversations: fetchPrConversations,
    fetchPrReviewThreadsRaw: fetchPrReviewThreadsRaw,
    appendReviewThreadInventory: appendReviewThreadInventory,
    buildGeneralCommentsSection: buildGeneralCommentsSection,
    fetchGeneralCommentsSection: fetchGeneralCommentsSection,
    buildDiscussionsMarkdown: buildDiscussionsMarkdown,
    detectFailedChecks: detectFailedChecks,
    _runsOfPayload: runsOfPayload,

    // Pure helpers extracted from detectFailedChecks (gh-1007, extended by
    // gh-1045) — exported for unit testing. gh-1045 DELIBERATELY changed
    // detectFailedChecks behavior: ci_failures_full.log is now always written
    // when failed checks exist, every failed check gets logs or a loud
    // failure reason, and the md header/resolution sections are gated on
    // whether the full-log write actually succeeded (hasFullLog).
    parseCheckRunsResult: parseCheckRunsResult,
    fetchGithubCheckLogs: fetchGithubCheckLogs,
    fetchGithubCheckLogsDetailed: fetchGithubCheckLogsDetailed,
    fetchGithubJobLogsDetailed: fetchGithubJobLogsDetailed,
    fetchGithubCheckRunLogsDetailed: fetchGithubCheckRunLogsDetailed,
    resolveFailedCheckSections: resolveFailedCheckSections,
    findSameNamedJobLogsOnHead: findSameNamedJobLogsOnHead,
    fetchGithubRunLogs: fetchGithubRunLogs,
    fetchGithubRunLogsDetailed: fetchGithubRunLogsDetailed,
    runLogsFailureReason: runLogsFailureReason,
    fetchFailureDetail: fetchFailureDetail,
    fetchJenkinsCheckLogsDetailed: fetchJenkinsCheckLogsDetailed,
    buildCheckLogSections: buildCheckLogSections,
    checkLogFailureReason: checkLogFailureReason,
    extractGithubRunId: extractGithubRunId,
    extractGithubCheckRunId: extractGithubCheckRunId,
    fetchWorkflowRunJobs: fetchWorkflowRunJobs,
    formatFailedRunJobLogs: formatFailedRunJobLogs,
    isFailedRunJob: isFailedRunJob,
    unwrapLogResult: unwrapLogResult,
    extractJenkinsBuildTarget: extractJenkinsBuildTarget,
    buildLogSections: buildLogSections,
    buildCiFailuresHeader: buildCiFailuresHeader,
    buildCiFailuresResolutionSection: buildCiFailuresResolutionSection,
    extractViolationsFromEntries: extractViolationsFromEntries,
    writeViolationsJson: writeViolationsJson,
    buildViolationsBlock: buildViolationsBlock,

    // Re-exported from ./gitOps.js for backward compatibility — these are
    // plain git-CLI operations, not GitHub-specific. New code should prefer
    // requiring ./gitOps.js directly.
    checkoutPRBranch: gitOps.checkoutPRBranch,
    getPRDiff: gitOps.getPRDiff,
    trimLargeTextForInput: gitOps.trimLargeTextForInput,
    writePRContext: gitOps.writePRContext,
    detectMergeConflicts: gitOps.detectMergeConflicts
};

