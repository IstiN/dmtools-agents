/**
 * mergeTrigger — the canonical pr_approved merge sweep (JSRunner).
 *
 * Port of the inline bash in
 * IstiN/dmtools-agentic-workflows/.github/workflows/factory-merge-trigger.yml
 * (main, incl. the awf#20 Part-of + orphan-carrier path and the awf#21
 * numeric guards — replicated as semantics; the structured JSON bridge
 * makes the tab/newline body sanitizing unnecessary).
 *
 *   issue labeled `pr_approved` → linked open PR found → mergeStateStatus
 *   CLEAN → squash-merge → labels removed → comment posted.
 *
 * Linking conventions (any of):
 *   - PR body contains `Closes #NN` / `Fixes #NN` / `Resolves #NN`
 *   - PR body contains `Part of #NN` (link WITHOUT close)
 *   - PR branch name starts with `NN-` (e.g. `42-fix-foo`)
 *   - PR branch name matches `gh-0*NN` (gated by jobParams.ghBranchPattern
 *     on the issue→PR scan; the PR→issue map-back keeps it unconditional,
 *     bash parity)
 *   - the PR itself carries the label — mapped back to its linked issue;
 *     a labeled PR with NO OPEN linked issue merges directly (orphan /
 *     PR-carrier path: fix/*, chore/*, machine PRs)
 *
 * Error isolation: every per-item github_* call failure is caught, counted
 * in `failed`, and the loop continues; after BOTH loops a nonzero `failed`
 * count throws so the JSRunner surfaces the run as a job failure (bash had
 * no such aggregate — `set -e` simply killed the run mid-loop).
 *
 * jsrunner contract: params arrive via params.jobParams:
 *   repo            "owner/name" (required; GH_REPO fallback)
 *   label           approval label (default 'pr_approved')
 *   mapPrLabels     map labeled PRs back to their issues (default true)
 *   ghBranchPattern also link issue→PR via branch names like gh-0*NN
 *                   (default true)
 *   removePrLabel   also remove the label from the merged PR (default true)
 *   ciRunUrl        CI run URL stamped into the merge comments
 */

/* global github_search_issues, github_get_issue, github_list_prs,
   github_get_pr, github_merge_pr, github_remove_label,
   github_create_comment, GH_REPO */

function parseMcp(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) { return {}; }
}

function asList(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    if (parsed && Array.isArray(parsed.pullRequests)) return parsed.pullRequests;
    return [];
}

function asBool(value, dflt) {
    if (value === undefined || value === null || value === '') return dflt;
    if (value === true || value === false) return value;
    return String(value).toLowerCase() !== 'false';
}

function labelNames(pr) {
    return (pr.labels || []).map(function (l) { return (l && l.name) || l; });
}

function hasLabel(pr, label) {
    return labelNames(pr).indexOf(label) !== -1;
}

function branchOf(pr) {
    return pr.headRefName || (pr.head && pr.head.ref) || '';
}

function bodyOf(pr) {
    return typeof pr.body === 'string' ? pr.body : '';
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract a linked issue number from a PR's body/branch (PR→issue
 * map-back, bash parity):
 *   1. body: first `closes|fixes|resolves|part of #NN` (case-insensitive)
 *   2. branch: leading digits (`NN-…` — bash uses `^[0-9]+`, no separator
 *      required)
 *   3. branch: `gh-0*NN` anywhere — UNCONDITIONAL here (the bash map-back
 *      ignores GH_BRANCH_PATTERN; only the issue→PR selector is gated).
 */
function extractLinkedIssueNumber(pr) {
    var m = bodyOf(pr).match(/\b(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = branchOf(pr).match(/^(\d+)/);
    if (m) return parseInt(m[1], 10);
    m = branchOf(pr).match(/gh-0*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    return null;
}

/**
 * Does this open PR link to issue `n`? (issue→PR selector, bash jq
 * link_sel parity: body keyword ref, branch `^N[-_.]`, and — gated by
 * ghBranchPattern — a trailing `(^|[-_./])gh-0*N$`.)
 */
function prLinksToIssue(pr, n, ghBranchPattern) {
    var body = bodyOf(pr);
    var branch = branchOf(pr);
    var bodyRe = new RegExp('\\b(?:closes|fixes|resolves|part of)\\s+#' + n + '\\b', 'i');
    if (bodyRe.test(body)) return true;
    var branchRe = new RegExp('^' + n + '[-_.]');
    if (branchRe.test(branch)) return true;
    if (ghBranchPattern) {
        var ghRe = new RegExp('(^|[-_./])gh-0*' + n + '$', 'i');
        if (ghRe.test(branch)) return true;
    }
    return false;
}

/**
 * Is the linked issue OPEN? The sync github_get_issue bridge does not
 * throw on 404 — it returns the REST error body ({"message":"Not Found"})
 * — so both a throw and a message-carrying body count as absent (→ the PR
 * takes the orphan-carrier path).
 */
function isIssueOpen(owner, name, n) {
    var res;
    try {
        res = parseMcp(github_get_issue({
            workspace: owner, repository: name, number: n
        }));
    } catch (e) {
        return false; // throwing bridges (mocks, some forges) — 404 throws
    }
    if (!res || res.message) return false;
    return String(res.state || '').toUpperCase() === 'OPEN';
}

/**
 * Mergeability, gh CLI parity: bash reads `.mergeable + ":" +
 * .mergeStateStatus` where mergeable is MERGEABLE|CONFLICTING|UNKNOWN.
 * REST carries mergeable true/false/null + mergeable_state lowercase.
 */
function mergeStateOf(pr) {
    var mergeable = pr.mergeable === true ||
        String(pr.mergeable).toUpperCase() === 'MERGEABLE';
    var state = pr.mergeStateStatus ||
        (pr.mergeable_state ? String(pr.mergeable_state).toUpperCase() : '');
    return { mergeable: mergeable, state: state };
}

function squashMerge(owner, name, number) {
    try {
        var res = parseMcp(github_merge_pr({
            workspace: owner, repository: name,
            pullRequestId: number, mergeMethod: 'squash'
        }));
        if (res.merged === true || res.ok === true) return { merged: true };
        return { merged: false, error: res.message || JSON.stringify(res) };
    } catch (e) {
        return { merged: false, error: (e && e.message) || String(e) };
    }
}

function tryRemoveLabel(owner, name, number, label, log) {
    try {
        github_remove_label({
            workspace: owner, repository: name, number: number, label: label
        });
    } catch (e) {
        log.push('⚠️ label removal failed on #' + number + ' (non-fatal): ' +
            ((e && e.message) || e));
    }
}

function tryComment(owner, name, number, body, log) {
    try {
        github_create_comment({
            workspace: owner, repository: name, number: number, body: body
        });
    } catch (e) {
        log.push('⚠️ comment failed on #' + number + ' (non-fatal): ' +
            ((e && e.message) || e));
    }
}

/**
 * Repo/flag parsing (gh-1081): the owner/name split and the jobParams flag
 * defaults live in pure helpers so the sweep decisions are unit-testable.
 * resolveRepo reads the GH_REPO env-global the same way action always did.
 */
function resolveRepo(job) {
    var repo = job.repo;
    if (!repo && typeof GH_REPO !== 'undefined') repo = GH_REPO;
    if (!repo) throw new Error('mergeTrigger: no repo (params.jobParams.repo / GH_REPO)');
    var parts = String(repo).split('/');
    if (parts.length < 2) throw new Error('mergeTrigger: repo must be owner/name, got ' + repo);
    return { owner: parts[0], name: parts.slice(1).join('/') };
}

function parseFlags(job) {
    return {
        label: job.label || 'pr_approved',
        mapPrLabels: asBool(job.mapPrLabels, true),
        ghBranchPattern: asBool(job.ghBranchPattern, true),
        removePrLabel: asBool(job.removePrLabel, true),
        ciRunUrl: job.ciRunUrl || 'run'
    };
}

/**
 * Numeric guard (awf#21 semantics) + dedupe of the label-search results.
 * Pure: returns the ordered issue numbers and the seen-map shared with the
 * PR→issue map-back.
 */
function collectIssueNumbers(issueSearch) {
    var issueNumbers = [];
    var seenIssues = {};
    asList(issueSearch).forEach(function (it) {
        var n = parseInt(it && it.number, 10);
        if (!isNaN(n) && n > 0 && !seenIssues[n]) {
            seenIssues[n] = true;
            issueNumbers.push(n);
        }
    });
    return { issueNumbers: issueNumbers, seenIssues: seenIssues };
}

/**
 * Numeric guard (awf#21): a malformed PR record never reaches the merge calls.
 */
function numericPrs(openPrList) {
    return openPrList.filter(function (pr) {
        var n = parseInt(pr && pr.number, 10);
        return !isNaN(n) && n > 0;
    });
}

/**
 * PR→issue map-back over the labeled open PRs. Appends newly seen OPEN
 * linked issues to `issueNumbers` (deduped via `seenIssues`); returns the
 * PR numbers that take the orphan-carrier path. github_get_issue calls run
 * in PR-list order, only for labeled PRs with an extractable issue number.
 */
function scanLabeledPrs(openPrs, label, owner, name, issueNumbers, seenIssues, ctx) {
    var orphanPrs = [];
    openPrs.forEach(function (pr) {
        if (!hasLabel(pr, label)) return;
        var prn = parseInt(pr.number, 10);
        try {
            var n = extractLinkedIssueNumber(pr);
            if (n !== null && isIssueOpen(owner, name, n)) {
                if (!seenIssues[n]) {
                    seenIssues[n] = true;
                    issueNumbers.push(n);
                }
            } else {
                // No resolvable issue, or the issue is closed/absent
                // (awf#20) — the PR itself is the carrier.
                orphanPrs.push(prn);
            }
        } catch (e) {
            // Per-item isolation: a bad PR record never kills the scan.
            ctx.say('⚠️ map-back failed for PR #' + prn + ' (treated as orphan): ' +
                failureReason(e));
            orphanPrs.push(prn);
        }
    });
    return orphanPrs;
}

/**
 * First open PR linking to issue `n` (list order), or null.
 */
function findLinkedPr(openPrs, n, ghBranchPattern) {
    for (var i = 0; i < openPrs.length; i++) {
        if (prLinksToIssue(openPrs[i], n, ghBranchPattern)) return openPrs[i];
    }
    return null;
}

/**
 * The merge decision (bash `case "$state"` parity), as a pure function:
 *   'merge'   — mergeable + CLEAN → squash-merge
 *   'behind'  — mergeable + BEHIND → SM refresh note, skip
 *   'blocked' — mergeable + BLOCKED/UNSTABLE → checks not green, skip
 *   'manual'  — everything else (not mergeable, unknown states)
 */
function mergeDecisionOf(ms) {
    if (!ms.mergeable) return 'manual';
    if (ms.state === 'CLEAN') return 'merge';
    if (ms.state === 'BEHIND') return 'behind';
    if (ms.state === 'BLOCKED' || ms.state === 'UNSTABLE') return 'blocked';
    return 'manual';
}

/**
 * The shared state machine (bash `case "$state"` parity). Returns
 * 'merged' | 'skipped'. `onMerged(mergedPrNumber)` performs the
 * post-merge label/comment bookkeeping for the caller's path.
 */
function runStateMachine(ctx, prNumber, onMerged) {
    var pr = parseMcp(github_get_pr({
        workspace: ctx.owner, repository: ctx.name, pullRequestId: prNumber
    }));
    var ms = mergeStateOf(pr);
    var stateLabel = (ms.mergeable ? 'MERGEABLE' : 'CONFLICTING') + ':' + ms.state;
    ctx.log.push('linked PR #' + prNumber + ' — ' + stateLabel);

    var decision = mergeDecisionOf(ms);
    if (decision === 'merge') {
        var res = squashMerge(ctx.owner, ctx.name, prNumber);
        if (res.merged) {
            onMerged(prNumber);
            return 'merged';
        }
        ctx.log.push('❌ merge of #' + prNumber + ' failed: ' + res.error);
        return 'skipped'; // bash parity: a refused merge is skipped, exit 0
    }
    if (decision === 'behind') {
        ctx.log.push('⏳ #' + prNumber + ' behind main — the SM (silent-update-behind) refreshes it, then re-dispatches CI');
        return 'skipped';
    }
    if (decision === 'blocked') {
        ctx.log.push('⏳ #' + prNumber + ' required checks not green yet');
        return 'skipped';
    }
    ctx.log.push('⛔ #' + prNumber + ' not mergeable (' + stateLabel + ') — needs manual attention');
    return 'skipped';
}

/**
 * One issue-loop item: find the linked open PR, run the state machine and
 * tally the outcome. Per-item isolation — a thrown error counts as failed
 * and the sweep continues.
 */
function processIssueItem(ctx, n, openPrs, opts, tally) {
    ctx.say('::issue #' + n);
    var pr = findLinkedPr(openPrs, n, opts.ghBranchPattern);
    if (!pr) {
        ctx.say('issue #' + n + ": no linked open PR (add 'Closes #" + n +
            "' to the PR body or name the branch '" + n + "-…') — skipping");
        tally.skipped++;
        return;
    }
    var prn = parseInt(pr.number, 10);
    var outcome = runStateMachine(ctx, prn, function (mergedPr) {
        tryRemoveLabel(ctx.owner, ctx.name, n, opts.label, ctx.log);
        if (opts.removePrLabel) tryRemoveLabel(ctx.owner, ctx.name, mergedPr, opts.label, ctx.log);
        tryComment(ctx.owner, ctx.name, n,
            '🔀 Merged #' + mergedPr + ' (CI: ' + opts.ciRunUrl + ')', ctx.log);
        ctx.say('✅ merged #' + mergedPr + ' for issue #' + n);
    });
    if (outcome === 'merged') tally.merged++; else tally.skipped++;
}

/**
 * One orphan-carrier loop item: a labeled PR with no OPEN linked issue
 * merges directly — there is no issue to un-label or comment on.
 */
function processOrphanPr(ctx, prn, opts, tally) {
    ctx.say('::PR #' + prn + ' (no linked open issue)');
    var outcome = runStateMachine(ctx, prn, function (mergedPr) {
        if (opts.removePrLabel) tryRemoveLabel(ctx.owner, ctx.name, mergedPr, opts.label, ctx.log);
        tryComment(ctx.owner, ctx.name, mergedPr,
            '🔀 Merged (CI: ' + opts.ciRunUrl + ')', ctx.log);
        ctx.say('✅ merged PR #' + mergedPr + ' (issue-less)');
    });
    if (outcome === 'merged') tally.merged++; else tally.skipped++;
}

function action(params) {
    var job = (params && params.jobParams) || {};
    var repoInfo = resolveRepo(job);
    var owner = repoInfo.owner;
    var name = repoInfo.name;
    var opts = parseFlags(job);

    var log = [];
    function say(line) { log.push(line); console.log(line); }
    var ctx = { owner: owner, name: name, log: log, say: say };



/**
 * Candidate collection — the two sweeps that decide WHAT gets processed.
 * Candidates come from BOTH sides: the issue label (human/bot) and the PR
 * label (pr_review approves via scm.addLabel on the PR). The open-PR list
 * drives BOTH the label map-back and the issue→PR link scan (gh pr list
 * --json number,body,headRefName parity; structured JSON, no tab/newline
 * sanitizing needed). github_search_issues → github_list_prs → one
 * github_get_issue per labeled PR with an extractable issue, in list order.
 */
function collectCandidates(owner, name, opts, ctx) {
    var issueSearch = parseMcp(github_search_issues({
        workspace: owner, repository: name,
        query: 'repo:' + owner + '/' + name + ' is:issue is:open label:"' + opts.label + '"'
    }));
    var issues = collectIssueNumbers(issueSearch);

    var openPrs = numericPrs(asList(parseMcp(github_list_prs({
        workspace: owner, repository: name, state: 'open'
    }))));

    var orphanPrs = [];
    if (opts.mapPrLabels) {
        orphanPrs = scanLabeledPrs(openPrs, opts.label, owner, name,
            issues.issueNumbers, issues.seenIssues, ctx);
    }
    return { issueNumbers: issues.issueNumbers, openPrs: openPrs, orphanPrs: orphanPrs };
}

function failureReason(e) {
    return (e && e.message) || e;
}

/**
 * The two merge loops (issue path, then the PR-carrier path). Per-item
 * isolation: a thrown error counts as failed and the sweep continues.
 */
function runSweep(ctx, candidates, opts, tally) {
    // Issue loop.
    candidates.issueNumbers.forEach(function (n) {
        try {
            processIssueItem(ctx, n, candidates.openPrs, opts, tally);
        } catch (e) {
            tally.failed++;
            ctx.say('❌ issue #' + n + ' processing failed: ' + failureReason(e));
        }
    });

    // PR-carrier path: labeled PRs with no OPEN linked issue merge
    // directly — there is no issue to un-label or comment on.
    candidates.orphanPrs.forEach(function (prn) {
        try {
            processOrphanPr(ctx, prn, opts, tally);
        } catch (e) {
            tally.failed++;
            ctx.say('❌ PR #' + prn + ' processing failed: ' + failureReason(e));
        }
    });
}

/**
 * Aggregate exit code at END of run (never mid-loop): the JSRunner
 * surfaces a thrown error as job failure.
 */
function summarizeSweep(tally, log, say) {
    var summary = 'summary: merged=' + tally.merged + ' skipped=' + tally.skipped +
        ' failed=' + tally.failed;
    say(summary);
    if (tally.failed > 0) {
        throw new Error('mergeTrigger: ' + tally.failed + ' item(s) failed — ' + summary);
    }
    return { success: true, merged: tally.merged, skipped: tally.skipped, failed: tally.failed, log: log };
}

function action(params) {
    var job = (params && params.jobParams) || {};
    var repoInfo = resolveRepo(job);
    var owner = repoInfo.owner;
    var name = repoInfo.name;
    var opts = parseFlags(job);

    var log = [];
    function say(line) { log.push(line); console.log(line); }
    var ctx = { owner: owner, name: name, log: log, say: say };

    var candidates = collectCandidates(owner, name, opts, ctx);

    if (!candidates.issueNumbers.length && !candidates.orphanPrs.length) {
        say("no issues labeled '" + opts.label + "' — nothing to merge");
        return { success: true, merged: 0, skipped: 0, failed: 0, log: log };
    }

    var tally = { merged: 0, skipped: 0, failed: 0 };
    runSweep(ctx, candidates, opts, tally);
    return summarizeSweep(tally, log, say);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        extractLinkedIssueNumber: extractLinkedIssueNumber,
        prLinksToIssue: prLinksToIssue,
        mergeStateOf: mergeStateOf,
        resolveRepo: resolveRepo,
        parseFlags: parseFlags,
        asBool: asBool,
        parseMcp: parseMcp,
        asList: asList,
        labelNames: labelNames,
        hasLabel: hasLabel,
        branchOf: branchOf,
        bodyOf: bodyOf,
        collectIssueNumbers: collectIssueNumbers,
        numericPrs: numericPrs,
        scanLabeledPrs: scanLabeledPrs,
        findLinkedPr: findLinkedPr,
        mergeDecisionOf: mergeDecisionOf,
        isIssueOpen: isIssueOpen,
        squashMerge: squashMerge,
        tryRemoveLabel: tryRemoveLabel,
        tryComment: tryComment
    };
}
