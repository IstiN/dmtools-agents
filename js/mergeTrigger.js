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

    if (ms.mergeable && ms.state === 'CLEAN') {
        var res = squashMerge(ctx.owner, ctx.name, prNumber);
        if (res.merged) {
            onMerged(prNumber);
            return 'merged';
        }
        ctx.log.push('❌ merge of #' + prNumber + ' failed: ' + res.error);
        return 'skipped'; // bash parity: a refused merge is skipped, exit 0
    }
    if (ms.mergeable && ms.state === 'BEHIND') {
        ctx.log.push('⏳ #' + prNumber + ' behind main — the SM (silent-update-behind) refreshes it, then re-dispatches CI');
        return 'skipped';
    }
    if (ms.mergeable && (ms.state === 'BLOCKED' || ms.state === 'UNSTABLE')) {
        ctx.log.push('⏳ #' + prNumber + ' required checks not green yet');
        return 'skipped';
    }
    ctx.log.push('⛔ #' + prNumber + ' not mergeable (' + stateLabel + ') — needs manual attention');
    return 'skipped';
}

function action(params) {
    var job = (params && params.jobParams) || {};
    var repo = job.repo;
    if (!repo && typeof GH_REPO !== 'undefined') repo = GH_REPO;
    if (!repo) throw new Error('mergeTrigger: no repo (params.jobParams.repo / GH_REPO)');
    var parts = String(repo).split('/');
    if (parts.length < 2) throw new Error('mergeTrigger: repo must be owner/name, got ' + repo);
    var owner = parts[0], name = parts.slice(1).join('/');

    var label = job.label || 'pr_approved';
    var mapPrLabels = asBool(job.mapPrLabels, true);
    var ghBranchPattern = asBool(job.ghBranchPattern, true);
    var removePrLabel = asBool(job.removePrLabel, true);
    var ciRunUrl = job.ciRunUrl || 'run';

    var log = [];
    function say(line) { log.push(line); console.log(line); }
    var ctx = { owner: owner, name: name, log: log };

    // Candidates come from BOTH sides: the issue label (human/bot) and
    // the PR label (pr_review approves via scm.addLabel on the PR).
    var issueSearch = parseMcp(github_search_issues({
        workspace: owner, repository: name,
        query: 'repo:' + owner + '/' + name + ' is:issue is:open label:"' + label + '"'
    }));
    var issueNumbers = [];
    var seenIssues = {};
    asList(issueSearch).forEach(function (it) {
        var n = parseInt(it && it.number, 10);
        if (!isNaN(n) && n > 0 && !seenIssues[n]) {
            seenIssues[n] = true;
            issueNumbers.push(n);
        }
    });

    // Open PRs — one list drives BOTH the label map-back and the
    // issue→PR link scan (gh pr list --json number,body,headRefName
    // parity; structured JSON, no tab/newline sanitizing needed).
    var openPrs = asList(parseMcp(github_list_prs({
        workspace: owner, repository: name, state: 'open'
    }))).filter(function (pr) {
        // Numeric guard (awf#21 semantics): a malformed record never
        // reaches the merge calls.
        var n = parseInt(pr && pr.number, 10);
        return !isNaN(n) && n > 0;
    });

    var orphanPrs = [];
    if (mapPrLabels) {
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
                say('⚠️ map-back failed for PR #' + prn + ' (treated as orphan): ' +
                    ((e && e.message) || e));
                orphanPrs.push(prn);
            }
        });
    }

    if (!issueNumbers.length && !orphanPrs.length) {
        say("no issues labeled '" + label + "' — nothing to merge");
        return { success: true, merged: 0, skipped: 0, failed: 0, log: log };
    }

    var merged = 0, skipped = 0, failed = 0;

    // Issue loop.
    issueNumbers.forEach(function (n) {
        say('::issue #' + n);
        try {
            var pr = null;
            for (var i = 0; i < openPrs.length; i++) {
                if (prLinksToIssue(openPrs[i], n, ghBranchPattern)) { pr = openPrs[i]; break; }
            }
            if (!pr) {
                say('issue #' + n + ": no linked open PR (add 'Closes #" + n +
                    "' to the PR body or name the branch '" + n + "-…') — skipping");
                skipped++;
                return;
            }
            var prn = parseInt(pr.number, 10);
            var outcome = runStateMachine(ctx, prn, function (mergedPr) {
                tryRemoveLabel(owner, name, n, label, log);
                if (removePrLabel) tryRemoveLabel(owner, name, mergedPr, label, log);
                tryComment(owner, name, n,
                    '🔀 Merged #' + mergedPr + ' (CI: ' + ciRunUrl + ')', log);
                say('✅ merged #' + mergedPr + ' for issue #' + n);
            });
            if (outcome === 'merged') merged++; else skipped++;
        } catch (e) {
            failed++;
            say('❌ issue #' + n + ' processing failed: ' + ((e && e.message) || e));
        }
    });

    // PR-carrier path: labeled PRs with no OPEN linked issue merge
    // directly — there is no issue to un-label or comment on.
    orphanPrs.forEach(function (prn) {
        say('::PR #' + prn + ' (no linked open issue)');
        try {
            var outcome = runStateMachine(ctx, prn, function (mergedPr) {
                if (removePrLabel) tryRemoveLabel(owner, name, mergedPr, label, log);
                tryComment(owner, name, mergedPr,
                    '🔀 Merged (CI: ' + ciRunUrl + ')', log);
                say('✅ merged PR #' + mergedPr + ' (issue-less)');
            });
            if (outcome === 'merged') merged++; else skipped++;
        } catch (e) {
            failed++;
            say('❌ PR #' + prn + ' processing failed: ' + ((e && e.message) || e));
        }
    });

    var summary = 'summary: merged=' + merged + ' skipped=' + skipped + ' failed=' + failed;
    say(summary);
    if (failed > 0) {
        // Aggregate exit code at END of run (never mid-loop): the JSRunner
        // surfaces a thrown error as job failure.
        throw new Error('mergeTrigger: ' + failed + ' item(s) failed — ' + summary);
    }
    return { success: true, merged: merged, skipped: skipped, failed: failed, log: log };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        extractLinkedIssueNumber: extractLinkedIssueNumber,
        prLinksToIssue: prLinksToIssue,
        mergeStateOf: mergeStateOf
    };
}
