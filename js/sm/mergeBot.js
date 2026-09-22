/**
 * mergeBot — event-driven fast path for the machine loop's merge stage.
 *
 * The SM tick (cron every-10-minutes) is best-effort: GitHub silently drops scheduled
 * runs under load (live: fa ticks vanished for 30+ min while approved
 * green PRs waited). This bot runs on EVENTS — CI conclusion
 * (workflow_run), label changes / head pushes (pull_request), check-run
 * completions, and manual dispatch — and performs exactly the
 * deterministic, idempotent stage transitions that need no orchestration:
 *
 *   approved + ai_validating + green + CLEAN  -> squash-merge (retry once
 *                                                on transient API errors)
 *   ai_validating + green + CLEAN + !approved-> latch ai_validated, unarm
 *   ai_validating + green + base moved       -> unarm (stale head; the SM
 *                                                refreshes + re-validates)
 *
 * Everything else (validation dispatch, review/rework legs, conflict
 * rework, fail-validation reporting) stays SM-owned: the bot never
 * dispatches workflows, never arms labels beyond the two latches above —
 * it only CONCLUDES stages whose evidence is already on the PR.
 *
 * jsrunner contract: repo comes from params.jobParams.repo
 * ("owner/name") or GH_REPO; tools are the global snake_case bridge.
 */

/* global github_list_prs, github_get_pr, github_get_commit_check_runs,
   github_merge_pr, github_add_labels, github_remove_label */

function parseMcp(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) { return {}; }
}

function labelNames(pr) {
    return (pr.labels || []).map(function (l) { return (l && l.name) || l; });
}

/**
 * Check-rollup for a head sha: 'green' (all concluded SUCCESS), 'red'
 * (any FAILURE/TIMED_OUT/CANCELLED), 'pending' (queued/in flight),
 * 'none' (no evidence at all — nothing concluded anywhere).
 *
 * Fallback (live: fa #762, 2026-09-22): silent-update refreshes a branch
 * via the update-branch API, which fires NO pull_request event — the
 * gate waiter check run never re-runs on the new head, so commit check
 * runs come back EMPTY even though the dispatched CI (check suites) is
 * green on that exact sha. When check runs are empty, fall back to the
 * PR-level statusCheckRollup (suites + statuses aggregated by GitHub)
 * before declaring 'none' — otherwise a green approved CLEAN head waits
 * forever and only the SM tick's better-informed merge can land it.
 */
function checksRollup(commitSha, pr) {
    var cr = parseMcp(github_get_commit_check_runs({ commitSha: commitSha }));
    var runs = cr.check_runs || cr.total_count !== undefined ? (cr.check_runs || []) : [];
    if (!runs.length && pr && Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length) {
        runs = pr.statusCheckRollup;
    }
    if (!runs.length) return 'none';
    var red = false, pending = false;
    runs.forEach(function (r) {
        var c = r.conclusion ? String(r.conclusion).toUpperCase() : null;
        var s = r.status ? String(r.status).toUpperCase() : null;
        if (c === 'FAILURE' || c === 'TIMED_OUT' || c === 'CANCELLED') red = true;
        else if (!c || s === 'QUEUED' || s === 'IN_PROGRESS' || s === 'WAITING' || s === 'PENDING') pending = true;
    });
    if (red) return 'red';
    if (pending) return 'pending';
    return 'green';
}

/**
 * mergeState, deterministic (smProvider.prStatus parity, minimal): REST
 * mergeable_state mapped to UPPER, DIRTY on mergeable===false, BEHIND when
 * the base moved (base.sha vs the live base branch head via github_list_prs
 * is unavailable — use mergeable_state 'behind' plus the base sha vs
 * github_get_pr(base).head? The PR body carries base.sha only). For the
 * bot's decisions BEHIND matters only to NOT merge a stale head — REST
 * already reports 'behind' for those; keep BLOCKED (checks pending under
 * protection) and CLEAN as REST says, DIRTY/BEHIND/other as REST says.
 */
function mergeStateOf(pr) {
    if (pr.mergeable === false) return 'DIRTY';
    var ms = pr.mergeStateStatus ||
        (pr.mergeable_state ? String(pr.mergeable_state).toUpperCase() : '');
    return ms || (pr.mergeable === true ? 'CLEAN' : 'UNKNOWN');
}

function squashMerge(owner, repo, number) {
    var last = null;
    for (var attempt = 1; attempt <= 2; attempt++) {
        try {
            var res = parseMcp(github_merge_pr({
                workspace: owner, repository: repo,
                number: number, mergeMethod: 'squash'
            }));
            // GitHub returns {"merged": true} on success; anything else
            // carries a message — surface it VERBATIM (the fa pr-759 404
            // hour was debugged blind because errors printed bare).
            if (res.merged === true || res.ok === true) return { merged: true };
            last = res.message || JSON.stringify(res);
        } catch (e) {
            last = (e && e.message) || String(e);
        }
        // Retry once: transient 404/409 (stale head cache) resolves on a
        // fresh get_pr; deterministic refusals fail again with the reason.
        if (attempt === 1) github_get_pr({ workspace: owner, repository: repo, pullRequestId: number });
    }
    return { merged: false, error: last };
}

function action(params) {
    var job = (params && params.jobParams) || {};
    var repo = job.repo;
    if (!repo && typeof GH_REPO !== 'undefined') repo = GH_REPO;
    if (!repo) throw new Error('mergeBot: no repo (params.jobParams.repo / GH_REPO)');
    var parts = String(repo).split('/');
    if (parts.length < 2) throw new Error('mergeBot: repo must be owner/name, got ' + repo);
    var owner = parts[0], name = parts.slice(1).join('/');

    var log = [];
    function say(line) { log.push(line); console.log(line); }

    var prs = parseMcp(github_list_prs({ workspace: owner, repository: name, state: 'open' }));
    var list = Array.isArray(prs) ? prs : (prs.pullRequests || prs.items || []);
    var acted = 0;

    // Oldest first — FIFO, same fairness as the SM's merge rule (#687).
    list.sort(function (a, b) { return (a.number || 0) - (b.number || 0); });

    for (var i = 0; i < list.length; i++) {
        var pr = parseMcp(github_get_pr({
            workspace: owner, repository: name, pullRequestId: list[i].number
        }));
        if (!pr.number || (pr.state ? String(pr.state).toUpperCase() !== 'OPEN' : true)) continue;
        if (pr.draft) continue;
        var labels = labelNames(pr);
        var headSha = pr.head && (pr.head.sha || pr.head);
        if (!headSha) continue;

        var approved = labels.indexOf('pr_approved') !== -1;
        var validating = labels.indexOf('ai_validating') !== -1;
        if (!validating || labels.indexOf('agent:review') !== -1) continue; // mid-review: SM owns it
        if (pr.mergeable === false) continue; // conflicts: conflict-rework (SM) owns it

        var rollup = checksRollup(String(headSha), pr);
        if (rollup !== 'green') {
            say('⏳ pr-' + pr.number + ' checks=' + rollup + ' — waiting');
            continue;
        }
        var ms = mergeStateOf(pr);
        if (ms !== 'CLEAN') {
            if (approved) {
                // Validated-but-stale (base moved): unarm so the SM's silent
                // refresh + merge window re-validate the fresh head (the
                // 422-arm covers the already-fresh case).
                try {
                    github_remove_label({ workspace: owner, repository: name, number: pr.number, label: 'ai_validating' });
                    say('🔓 pr-' + pr.number + ' validated head stale (' + ms + ') — unarmed, refresh follows');
                    acted++;
                } catch (e) { say('⚠️ pr-' + pr.number + ' unarm failed: ' + (e.message || e)); }
            }
            continue;
        }

        if (approved) {
            var m = squashMerge(owner, name, pr.number);
            if (m.merged) {
                say('🧲 pr-' + pr.number + ' squash-merged (approved + green + CLEAN)');
                acted++;
            } else {
                say('❌ pr-' + pr.number + ' merge refused: ' + m.error);
            }
        } else {
            // Green head, no approval yet: latch for the review leg.
            try { github_remove_label({ workspace: owner, repository: name, number: pr.number, label: 'ai_validating' }); } catch (e) {}
            try {
                github_add_labels({ workspace: owner, repository: name, number: pr.number, labels: ['ai_validated'] });
                say('✅ pr-' + pr.number + ' validated (no approval yet) — ai_validated latched, review follows');
                acted++;
            } catch (e) { say('⚠️ pr-' + pr.number + ' latch failed: ' + (e.message || e)); }
        }
    }

    say('mergeBot complete — acted: ' + acted);
    return { success: true, acted: acted, log: log };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, checksRollup: checksRollup, mergeStateOf: mergeStateOf, labelNames: labelNames };
}
