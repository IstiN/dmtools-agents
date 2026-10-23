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
 * One exception (owner rule 2026-10-04): a deferred approved PR with
 * acted==0 at end-of-run fires a single machine-sm.yml tick (self-heal,
 * 'gh workflow run machine-sm.yml -F dryRun=false --repo owner/name'),
 * skipped when a machine-sm.yml run is already active — see the
 * END-OF-RUN SELF-TICK block in action() and hasActiveSmRun().
 *
 * jsrunner contract: repo comes from params.jobParams.repo
 * ("owner/name") or GH_REPO; tools are the global snake_case bridge.
 */

/* global github_list_prs, github_get_pr, github_get_commit_check_runs,
   github_list_workflow_runs, github_merge_pr, github_add_labels,
   github_remove_label, cli_execute_command */

function parseMcp(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) { return {}; }
}

function labelNames(pr) {
    return (pr.labels || []).map(function (l) { return (l && l.name) || l; });
}

/**
 * The list tools have returned both bare arrays and wrapped objects
 * ({ pullRequests: [...] } / { items: [...] }) across bridge versions.
 * Every consumer normalizes through here: a wrapped payload iterated as
 * a bare array has length undefined, the loop never runs, and the op
 * vanishes from the log (gh-952 review: mergedSlotHolder once iterated
 * the merged list raw — a shape mismatch would have silently disabled
 * the slot release the whole PR exists for).
 */
function listArray(prs) {
    return Array.isArray(prs) ? prs : (prs.pullRequests || prs.items || []);
}

/**
 * Membership test for a normalized label-name list — extracted from
 * action()'s `labels.indexOf('x') !== -1` chains (gh-1040): each inline
 * chain added a decision to action's complexity, and the predicate reads
 * the same everywhere.
 */
function hasLabel(labels, wanted) {
    return labels.indexOf(wanted) !== -1;
}

/**
 * Epoch ms when the run started waiting (check-run started_at, workflow-run
 * created_at) or null when the payload carries no usable timestamp — the
 * gh-766 stale-head detection FAILS OPEN on null (treated as live).
 */
function pendingStartedAt(r) {
    if (!r) return null;
    var raw = r.started_at || r.startedAt || r.created_at || r.createdAt;
    if (!raw) return null;
    var ts = Date.parse(raw);
    return isNaN(ts) ? null : ts;
}

/**
 * Concluded-red conclusions (any case, already upper-cased by the caller).
 */
function isRedConclusion(c) {
    return c === 'FAILURE' || c === 'TIMED_OUT' || c === 'CANCELLED';
}

/**
 * Not-yet-concluded run shapes (gh-1040): no conclusion at all, or an
 * explicitly queued/in-flight status.
 */
function isPendingRunShape(c, s) {
    return !c || s === 'QUEUED' || s === 'IN_PROGRESS' || s === 'WAITING' || s === 'PENDING';
}

/**
 * Per-run classification for rollupDetail (gh-1040): a concluded
 * FAILURE/TIMED_OUT/CANCELLED run is red; a run with no conclusion yet
 * (or an explicitly queued/in-flight status) is pending and carries its
 * start timestamp as motionless-since evidence; anything else is a
 * settled non-failure and contributes nothing.
 */
function decideRunState(r) {
    var c = r.conclusion ? String(r.conclusion).toUpperCase() : null;
    var s = r.status ? String(r.status).toUpperCase() : null;
    if (isRedConclusion(c)) return { red: true, pending: false, started: null };
    if (isPendingRunShape(c, s)) {
        return { red: false, pending: true, started: pendingStartedAt(r) };
    }
    return { red: false, pending: false, started: null };
}

/**
 * Rollup combination (gh-1040): any red run turns the head red; else any
 * pending run makes it pending with the OLDEST pending start as
 * pendingSince (gh-766 motionless evidence); else green.
 */
function combineRunStates(states) {
    var red = false, pending = false, oldestPending = null;
    states.forEach(function (st) {
        if (st.red) { red = true; return; }
        if (!st.pending) return;
        pending = true;
        if (st.started !== null && (oldestPending === null || st.started < oldestPending)) {
            oldestPending = st.started;
        }
    });
    if (red) return { state: 'red', pendingSince: null };
    if (pending) return { state: 'pending', pendingSince: oldestPending };
    return { state: 'green', pendingSince: null };
}

/**
 * Commit-check-runs fetch + PR statusCheckRollup fallback (gh-1040
 * extraction, call order and shapes verbatim): the bridge payload may
 * carry { total_count } without a check_runs array (reads as empty), and
 * the REST PR body's statusCheckRollup — when it is a non-empty ARRAY —
 * is the next evidence rung before the workflow-run fallback.
 */
function fetchCheckRuns(commitSha, pr, owner, name) {
    var cr = parseMcp(github_get_commit_check_runs({
        workspace: owner, repository: name, commitSha: commitSha
    }));
    var runs = cr.check_runs || cr.total_count !== undefined ? (cr.check_runs || []) : [];
    if (!runs.length && pr && Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length) {
        runs = pr.statusCheckRollup;
    }
    return runs;
}

/**
 * Workflow-run evidence for a head sha (gh-1040 extraction): the newest
 * run on the sha decides — SUCCESS green, FAILURE/TIMED_OUT/CANCELLED
 * red, anything else pending with the run's start as pendingSince.
 * Null when no run matches (caller reports 'none').
 */
function workflowRunEvidence(wruns, commitSha) {
    var mine = wruns.filter(function (r) { return String(r.head_sha || r.headSha) === String(commitSha); });
    if (!mine.length) return null;
    // newest first (API order); conclusion decides, in-flight waits
    var top = mine[0];
    var c = top.conclusion ? String(top.conclusion).toUpperCase() : null;
    if (c === 'SUCCESS') return { state: 'green', pendingSince: null };
    if (c === 'FAILURE' || c === 'TIMED_OUT' || c === 'CANCELLED') return { state: 'red', pendingSince: null };
    return { state: 'pending', pendingSince: pendingStartedAt(top) };
}

/**
 * Same rollup as checksRollup, plus pendingSince: the OLDEST start time
 * among the pending evidence (gh-766) — an armed head whose checks have
 * been motionless past staleHeadMinutes is a dead FIFO head (skipped with
 * an explicit log line, unarmed, queue advances) instead of an eternal
 * 'checks=pending — waiting'.
 */
function rollupDetail(commitSha, pr, job, owner, name) {
    var runs = fetchCheckRuns(commitSha, pr, owner, name);
    if (!runs.length) {
        // Workflow-run fallback (live: fa #762): the REST PR body has NO
        // statusCheckRollup (GraphQL-only) and API silent-updated heads carry
        // no check runs — but the SM-dispatched CI run IS on this exact sha.
        // Read the repo's CI workflow runs and match head_sha. The SM's own
        // waiter is a pull_request-event job: it never re-runs on refreshed
        // heads, so this is the ONLY conclusive evidence for them.
        var wf = parseMcp(github_list_workflow_runs({
            workspace: owner, repository: name,
            workflowId: (job && job.ciWorkflow) || 'ci.yml', perPage: 30
        }));
        var wruns = (wf && (wf.workflow_runs || wf.runs)) || [];
        var evidence = workflowRunEvidence(wruns, commitSha);
        if (evidence) return evidence;
        return { state: 'none', pendingSince: null };
    }
    if (!runs.length) return { state: 'none', pendingSince: null };
    return combineRunStates(runs.map(decideRunState));
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
function checksRollup(commitSha, pr, job, owner, name) {
    return rollupDetail(commitSha, pr, job, owner, name).state;
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
// gh-1101 (live dart #435): rollup green + approved + BLOCKED is the
// "required checks invisible to PR" shape (required contexts ran in a
// workflow_dispatch suite) — the SM fresh-sha resets it; say so.
function blockedWaitLine(number, ms, approved) {
    if (ms === 'BLOCKED' && approved) {
        return '⏳ pr-' + number + ' checks green but mergeState=BLOCKED — required checks' +
            ' invisible to PR? (SM fresh-sha reset owns it, gh-1101)';
    }
    return '⏳ pr-' + number + ' mergeState=' + ms + ' — waiting (checks settling)';
}

function mergeStateOf(pr) {
    if (pr.mergeable === false) return 'DIRTY';
    var ms = pr.mergeStateStatus ||
        (pr.mergeable_state ? String(pr.mergeable_state).toUpperCase() : '');
    return ms || (pr.mergeable === true ? 'CLEAN' : 'UNKNOWN');
}

/**
 * Repo resolution (gh-1040 extraction, verbatim behavior): jobParams.repo
 * first, the GH_REPO global second, throws on neither / on a value
 * without an owner/name split.
 */
function resolveRepoTarget(job) {
    var repo = job.repo;
    if (!repo && typeof GH_REPO !== 'undefined') repo = GH_REPO;
    if (!repo) throw new Error('mergeBot: no repo (params.jobParams.repo / GH_REPO)');
    var parts = String(repo).split('/');
    if (parts.length < 2) throw new Error('mergeBot: repo must be owner/name, got ' + repo);
    return { owner: parts[0], name: parts.slice(1).join('/') };
}

/**
 * gh-766 stale-head threshold (default 120 = 2h), verbatim.
 */
function staleHeadMinutesOr(job) {
    return (typeof job.staleHeadMinutes === 'number' && job.staleHeadMinutes > 0)
        ? job.staleHeadMinutes : 120;
}

/**
 * gh-952 merged-slot-holder pre-scan (gh-1040 extraction, same call
 * order: no tracker calls until the merged probe). Returns the
 * recently-merged still-armed holder the open list cannot show, or null.
 */
function findReleasedSlotHolder(list, owner, name) {
    var approvedSeen = list.some(function (p) {
        return hasLabel(labelNames(p), 'pr_approved');
    });
    if (!approvedSeen) return null;
    var armedHolderOpen = list.some(function (p) {
        var ls = labelNames(p);
        return hasLabel(ls, 'ai_validating') && hasLabel(ls, 'pr_approved');
    });
    if (armedHolderOpen) return null;
    return mergedSlotHolder(owner, name);
}

/**
 * machine-sm.yml listing with the PAT-404 fallback (gh-1040 extraction,
 * verbatim semantics): the workflow-id form 404s for some PATs — fall
 * back to the all-runs endpoint and filter by workflow path client-side.
 * Returns null when the listing itself is unlistable (fail open).
 */
function listSmRuns(owner, name) {
    try {
        var wf = parseMcp(github_list_workflow_runs({
            workspace: owner, repository: name,
            workflowId: 'machine-sm.yml', perPage: 30
        }));
        var runs = smRunsFromPayload(wf);
        if (!runs.length && wf && wf.message) {
            runs = allRunsFallback(owner, name);
        }
        return runs;
    } catch (eActive) {
        return null; // unlistable → fail open, the self-heal still fires
    }
}

/**
 * The workflow_runs/runs array of a listing payload, verbatim shapes.
 */
function smRunsFromPayload(payload) {
    return (payload && (payload.workflow_runs || payload.runs)) || [];
}

/**
 * The all-runs-endpoint fallback of the active-SM probe (gh-1040
 * extraction): same call as the primary listing minus the workflowId
 * (that form is what 404s), filtered to machine-sm.yml by run path.
 */
function allRunsFallback(owner, name) {
    var all = parseMcp(github_list_workflow_runs({
        workspace: owner, repository: name, perPage: 30
    }));
    return smRunsFromPayload(all).filter(function (r) {
        return String(r.path || '') === '.github/workflows/machine-sm.yml';
    });
}

/**
 * Live-SM statuses (review #701, already lower-cased by the caller).
 */
function isActiveSmStatus(s) {
    return s === 'queued' || s === 'in_progress' || s === 'waiting' || s === 'pending';
}

/**
 * Zombie stamp of a non-in_progress run (review #701 tick-storm fix,
 * verbatim): the last update timestamp of the run, whatever field the
 * bridge payload carried it in.
 */
function smRunTimestamp(r) {
    return r.updated_at || r.updatedAt || r.created_at || r.createdAt || '';
}

/**
 * Zombie check (gh-1040 extraction): a non-in_progress run whose last
 * update is older than 6h was superseded by its concurrency group and
 * does not count as active. A run with NO parseable timestamp is never a
 * zombie (no evidence of motionlessness — fail open as live).
 */
function isZombieSmRun(r, now) {
    var ts = Date.parse(smRunTimestamp(r));
    return !isNaN(ts) && (now - ts) > 6 * 60 * 60 * 1000;
}

/**
 * Zombie-aware liveness of one workflow run (gh-1040 extraction, review
 * #701 tick-storm fix, verbatim): queued/in_progress/waiting/pending
 * counts as active, EXCEPT a non-in_progress run whose last update is
 * older than 6h — a zombie superseded by its concurrency group.
 */
function isLiveSmRun(r, now) {
    var s = r.status ? String(r.status).toLowerCase() : '';
    if (!isActiveSmStatus(s)) return false;
    if (s !== 'in_progress' && isZombieSmRun(r, now)) return false; // zombie queued > 6h
    return true;
}

/**
 * SM-active probe (review #701, tick-storm fix): TRUE when a machine-sm.yml
 * run is queued/in_progress/waiting/pending — the SM is already about to
 * drain the queue itself, so the end-of-run self-tick must NOT stack another
 * one. Mirrors smAgent's hasActiveTargetWorkflowRun semantics: a queued run
 * older than 6h is a zombie (the concurrency group superseded it) and does
 * not count. The workflow-id form of the listing 404s for some PATs (live fa
 * 2026-09-23, same fallback as smAgent's validation-sync) — fall back to the
 * all-runs endpoint and filter by workflow path client-side. An unlistable
 * repo fails OPEN (dispatch anyway): a missed tick stalls the conveyor, a
 * duplicate one is idempotent.
 */
function hasActiveSmRun(owner, name) {
    var runs = listSmRuns(owner, name);
    if (runs === null) return false; // unlistable → fail open, the self-heal still fires
    var now = Date.now();
    for (var i = 0; i < runs.length; i++) {
        if (isLiveSmRun(runs[i] || {}, now)) return true;
    }
    return false;
}

/**
 * gh-952 (live fa 2026-10-17 06:30–08:10Z): the merge-window slot holder
 * the open list can no longer show. PR #1661 was merged by the OWNER via
 * bypass while its validation was ARMED (Quality gate / Binaries smoke
 * pending stamps) — the machine's merge path never ran, so the arm was
 * never consumed, and the merged PR vanished from github_list_prs
 * (state:'open'). The FIFO then saw neither a holder nor a released
 * slot: every approved PR deferred as 'awaiting validate-armed turn'
 * with acted: 0 while the holder could NEVER validate again. Returns
 * the recently-merged PR still carrying the merge-window arm
 * (ai_validating + pr_approved — mutexAmong parity; a dev-lane arm
 * never held the merge window), or null when no such holder exists.
 * Consulted ONLY when no OPEN PR holds the arm — a live holder owns the
 * slot and the merged history is not probed at all. Recency-bounded
 * (24h): weeks-old merged PRs with lingering labels are archaeology,
 * not a slot event. An undated body reads as not-fresh (NaN < x is
 * false) — no release.
 */
var MERGED_SLOT_HOLDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function mergedSlotHolder(owner, name) {
    var merged = listArray(parseMcp(github_list_prs({
        workspace: owner, repository: name, state: 'merged'
    })));
    for (var i = 0; i < merged.length; i++) {
        var p = merged[i];
        var labels = labelNames(p);
        var armed = labels.indexOf('ai_validating') !== -1 && labels.indexOf('pr_approved') !== -1;
        var fresh = armed && p.merged_at &&
            (Date.now() - Date.parse(p.merged_at)) < MERGED_SLOT_HOLDER_MAX_AGE_MS;
        if (fresh) return p;
    }
    return null;
}

/**
 * END-OF-RUN SELF-TICK (owner rule 2026-10-04; live: agents#696,
 * dart#342 — the bot logged the defer line, exited acted:0, the repo
 * went event-quiet, and the validate-armed turn never came until a
 * human fired machine-sm.yml manually). A deferred approved PR with
 * acted==0 means NOTHING consumed this turn and no action of ours will
 * generate the events that re-drive the queue — fire ONE real SM tick
 * so the oldest approved PR gets its validate-armed turn. Not fired
 * when acted>0 (a merge/latch/unarm is motion — its events carry the
 * conveyor) nor when no deferred-approved was seen (nothing waits on a
 * turn). Review #701 hardening: the dispatch targets the PR's own repo
 * explicitly (--repo owner/name — gh resolves the CWD's repo, wrong in
 * multi-repo runners) and is SKIPPED when a machine-sm.yml run is
 * already queued/running (hasActiveSmRun — the active SM drains the
 * queue itself; a second tick per bot run was tick-storm amplification
 * during healthy waves). jobParams.selfTick=false disables it.
 * (gh-952: extracted verbatim from action() — the merged-slot-holder
 * release lives in the FIFO loop now, and the CRAP ratchet forbids
 * growing action; behavior is unchanged, see test_mergeBot self-tick.)
 */
function selfTickToSm(owner, name, job, deferredApproved, acted, say) {
    if (!deferredApproved || acted > 0 || job.selfTick === false) return;
    if (hasActiveSmRun(owner, name)) {
        say('⏭️ self-tick skipped (SM already active)');
        return;
    }
    try {
        cli_execute_command({
            command: 'gh workflow run machine-sm.yml -F dryRun=false --repo ' + owner + '/' + name
        });
        say('🔁 deferred approved → SM tick dispatched (self-heal)');
    } catch (eTick) {
        say('⚠️ self-tick dispatch failed: ' + ((eTick && eTick.message) || eTick));
    }
}

/**
 * gh-766 dead-head predicate (gh-1040 extraction, verbatim): an armed
 * head is stale when its rollup is pending, the PR is approved, and the
 * oldest pending evidence has been motionless past the threshold. The
 * pendingSince truthiness check is load-bearing (falsy = fail open).
 */
function isStalePending(rollup, approved, pendingSince, staleHeadMinutes, now) {
    return rollup === 'pending' && approved && pendingSince &&
        (now - pendingSince) > staleHeadMinutes * 60 * 1000;
}

/**
 * Unarm-on-staleness predicate (gh-1040 extraction, verbatim): only a
 * REALLY stale approved head is unarmed — BEHIND (base moved) or DIRTY
 * (conflicts). BLOCKED right after a workflow_run trigger means
 * 'required checks still settling' — unarming there races the check-run
 * conclusion, drops a green armed PR, and forces a full re-validation
 * cycle (live: fa pr-762, 11:36 — bot unarm on BLOCKED while the rollup
 * was green two lines above).
 */
function shouldUnarmStaleHead(ms, approved) {
    return approved && (ms === 'BEHIND' || ms === 'DIRTY');
}

/**
 * Live-open guard for the get_pr body in action()'s FIFO loop
 * (gh-1040 extraction, verbatim): a body without a number, or with an
 * explicit non-OPEN state, is a stale list entry and is skipped.
 */
function isLiveOpenPr(pr) {
    if (!pr.number) return false;
    if (!pr.state) return true;
    return String(pr.state).toUpperCase() === 'OPEN';
}

/**
 * The head sha of a PR body, verbatim shapes (gh-1040 extraction): the
 * REST body carries head.sha, older bridges a bare head string.
 */
function headShaOf(pr) {
    return pr.head && (pr.head.sha || pr.head);
}

/**
 * The ai_validating unarm, both log shapes verbatim (gh-1040
 * extraction): on success the ok line is logged and true returned; on
 * failure the failPrefix line carries the verbatim error and false is
 * returned (callers only credit acted on success). The tracker call is
 * the same single github_remove_label in the same position.
 */
function unarmValidating(owner, name, number, okLine, failPrefix, say) {
    try {
        github_remove_label({ workspace: owner, repository: name, number: number, label: 'ai_validating' });
        say(okLine);
        return true;
    } catch (e) {
        say(failPrefix + (e.message || e));
        return false;
    }
}

/**
 * The gh-766 stale-pending unarm, log line verbatim (gh-1040
 * extraction): the motionless-hours arithmetic and the skip line move
 * out of action(); returns the acted credit (1 unarmed, 0 on failure).
 */
function unarmStaleHead(owner, name, pr, pendingSince, staleHeadMinutes, say) {
    var stillHours = Math.round(((Date.now() - pendingSince) / 3600000) * 10) / 10;
    return unarmValidating(owner, name, pr.number,
        '⏭️ pr-' + pr.number + ' skipped: checks pending ' + stillHours +
        'h (> ' + (Math.round(staleHeadMinutes / 6) / 10) + 'h motionless) — unarmed, queue advances',
        '⚠️ pr-' + pr.number + ' stale-head unarm failed: ', say) ? 1 : 0;
}

/**
 * The BEHIND/DIRTY staleness unarm, log line verbatim (gh-1040
 * extraction): returns the acted credit (1 unarmed, 0 on failure).
 */
function unarmStaleHeadState(owner, name, pr, ms, say) {
    return unarmValidating(owner, name, pr.number,
        '🔓 pr-' + pr.number + ' validated head stale (' + ms + ') — unarmed, refresh follows',
        '⚠️ pr-' + pr.number + ' unarm failed: ', say) ? 1 : 0;
}

/**
 * The green-CLEAN unapproved latch (gh-1040 extraction, verbatim): unarm
 * ai_validating (failure swallowed by design), then add ai_validated —
 * the add is the acted motion; its failure is reported verbatim.
 */
function latchValidated(owner, name, pr, say) {
    try { github_remove_label({ workspace: owner, repository: name, number: pr.number, label: 'ai_validating' }); } catch (e) {}
    try {
        github_add_labels({ workspace: owner, repository: name, number: pr.number, labels: ['ai_validated'] });
        say('✅ pr-' + pr.number + ' validated (no approval yet) — ai_validated latched, review follows');
        return true;
    } catch (e) {
        say('⚠️ pr-' + pr.number + ' latch failed: ' + (e.message || e));
        return false;
    }
}

/**
 * Squash-merge attempt for an approved head (gh-1040 extraction,
 * verbatim): merges through squashMerge (one transparent retry) and
 * logs the caller's merged line on success or the verbatim refusal on
 * failure. Returns the acted credit (1 or 0).
 */
function mergeApprovedHead(owner, name, pr, mergedLine, say) {
    var m = squashMerge(owner, name, pr.number);
    if (m.merged) {
        say(mergedLine);
        return 1;
    }
    say('❌ pr-' + pr.number + ' merge refused: ' + m.error);
    return 0;
}

function squashMerge(owner, repo, number) {
    var last = null;
    for (var attempt = 1; attempt <= 2; attempt++) {
        try {
            var res = parseMcp(github_merge_pr({
                workspace: owner, repository: repo,
                pullRequestId: number, mergeMethod: 'squash'
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

/**
 * gh-766 dead-head predicate support (gh-1185 hoist): the once-per-run
 * red-holder diagnostic, moved out of action() verbatim — the closed-over
 * list/job/owner/name/say travel in `run` instead. Consulted when an
 * approved PR is deferred as FIFO-queued: if the ai_validating+pr_approved
 * holder's validation CONCLUDED RED, say so (diagnostic only — the bot
 * never acts on it, the SM's fail-validation owns the slot).
 */
function slotHolderNumber(hp) {
    return (hp && (hp.number || hp.prNumber)) || 0;
}

/**
 * The merge-window slot holder among the open PRs: armed (ai_validating)
 * AND approved (mutexAmong parity — a dev-lane arm does not hold the
 * slot), not the freshly-queued PR itself, with a usable head sha to
 * probe. One holder possible — the first match wins.
 */
function isMergeSlotHolder(hp, hLabels, queuedNumber) {
    var hNum = slotHolderNumber(hp);
    if (!hNum || hNum === queuedNumber) return false;
    if (!hasLabel(hLabels, 'ai_validating')) return false;
    if (!hasLabel(hLabels, 'pr_approved')) return false;
    return !!hp.head && !!(hp.head.sha || hp.head);
}

function findSlotHoldingPr(list, queuedNumber) {
    for (var h = 0; h < list.length; h++) {
        var hp = list[h];
        if (isMergeSlotHolder(hp, labelNames(hp || {}), queuedNumber)) return hp;
    }
    return null;
}

function noteRedSlotHolder(run, queuedNumber) {
    if (run.redSlotProbed) return;
    run.redSlotProbed = true;
    try {
        var hp = findSlotHoldingPr(run.list, queuedNumber);
        if (!hp) return;
        if (checksRollup(String(headShaOf(hp)), hp, run.job, run.owner, run.name) === 'red') {
            run.say('🚨 pr-' + slotHolderNumber(hp) + ' holds slot with concluded-red validation — fail path should free it');
        }
    } catch (eRed) { /* diagnostic only — never fails the run */ }
}

/**
 * The advance-past-a-skipped-dead-head turn (gh-766): dead heads skipped
 * above (blocked / stale-pending) VACATED the head position — the first
 * approved PR behind them that already carries validation evidence (the
 * ai_validated latch) takes the turn on the SAME evidence gates as the
 * armed path: green rollup on the current head + CLEAN. Returns the acted
 * credit (0 when the candidate keeps deferring); one advance per
 * skip-chain — consuming the slot resets deadHeadPassed, so FIFO holds
 * for everyone behind.
 */
function advancePastDeadHead(run, pr, labels, headSha) {
    if (!run.deadHeadPassed || !hasLabel(labels, 'ai_validated')) return 0;
    run.deadHeadPassed = false;
    var upRollup = checksRollup(String(headSha), pr, run.job, run.owner, run.name);
    if (upRollup !== 'green' || mergeStateOf(pr) !== 'CLEAN') return 0;
    return mergeApprovedHead(run.owner, run.name, pr,
        '🧲 pr-' + pr.number + ' squash-merged (approved + validated + green + CLEAN — advanced past a skipped dead head)',
        run.say);
}

/**
 * gh-766: the approved-but-unarmed PR is FIFO-queued behind the current
 * validation (validate-armed mutex, one CI at a time) unless it can take
 * the vacated-head turn above. The deferral is said aloud — a silent skip
 * is indistinguishable from a stuck pipeline for the operator (live: fa
 * 2026-09-25, pr-948/pr-963 sat silent for hours while the queue was
 * healthy) — and arms the end-of-run self-tick.
 */
function deferUnarmedApproved(run, pr, labels, headSha) {
    var gained = advancePastDeadHead(run, pr, labels, headSha);
    if (gained) {
        run.acted += gained;
        return;
    }
    run.say('⏳ pr-' + pr.number + ' approved — FIFO-queued (awaiting validate-armed turn)');
    run.deferredApproved = true;
    noteRedSlotHolder(run, pr.number);
}

/**
 * The unarmed arm of the FIFO entry (gh-1185 extraction, verbatim): only
 * an approved PR without the review label defers; everything else
 * (never-validated, mid-review) stays silent — the SM owns it.
 */
function handleUnarmedPr(run, pr, labels, headSha) {
    var approved = hasLabel(labels, 'pr_approved');
    if (approved && !hasLabel(labels, 'agent:review')) {
        deferUnarmedApproved(run, pr, labels, headSha);
    }
}

/**
 * The armed PR's evidence gates (gh-1185 extraction, call order verbatim):
 * non-green rollups wait or unarm (stale-pending gh-766), non-CLEAN states
 * unarm (BEHIND/DIRTY) or wait (BLOCKED gh-1101), and a green CLEAN head
 * merges when approved or latches ai_validated for the review leg.
 */
function handleArmedPr(run, pr, approved, headSha) {
    var detail = rollupDetail(String(headSha), pr, run.job, run.owner, run.name);
    var rollup = detail.state;
    if (rollup !== 'green') {
        if (isStalePending(rollup, approved, detail.pendingSince, run.staleHeadMinutes, Date.now())) {
            // gh-766 dead head: the armed validation has been motionless
            // past the threshold and will never conclude. Unarm — it
            // frees the SM's validate-armed mutex so the next approved
            // PR gets its turn (same remedy shape as the BEHIND/DIRTY
            // unarm below) — and let the queue advance. Unapproved
            // (dev-lane) arms don't hold the merge window (mutexAmong
            // parity) and keep waiting untouched: re-dispatching a
            // slow-CI dev lane every 2h would only lose its queue spot.
            run.acted += unarmStaleHead(run.owner, run.name, pr, detail.pendingSince, run.staleHeadMinutes, run.say);
            run.skippedHeads++;
            run.deadHeadPassed = true;
            return;
        }
        run.say('⏳ pr-' + pr.number + ' checks=' + rollup + ' — waiting');
        return;
    }
    var ms = mergeStateOf(pr);
    if (ms !== 'CLEAN') {
        if (shouldUnarmStaleHead(ms, approved)) {
            run.acted += unarmStaleHeadState(run.owner, run.name, pr, ms, run.say);
        } else {
            run.say(blockedWaitLine(pr.number, ms, approved));
        }
        return;
    }

    if (approved) {
        run.acted += mergeApprovedHead(run.owner, run.name, pr,
            '🧲 pr-' + pr.number + ' squash-merged (approved + green + CLEAN)', run.say);
    } else {
        // Green head, no approval yet: latch for the review leg.
        if (latchValidated(run.owner, run.name, pr, run.say)) run.acted++;
    }
}

/**
 * Silent-skip chain of the FIFO loop (gh-1185 extraction, verbatim): a
 * stale list entry (not live-open, draft, no head sha) vanishes quietly;
 * a blocked PR skips WITH an explicit line (gh-766: the old bare
 * `continue` made a blocked head invisible to the run log and a poison
 * pill for everyone queued behind it) and VACATES the head position.
 * Returns true when the entry must not be processed further.
 */
function skipFifoEntry(run, pr, labels, headSha) {
    if (!isLiveOpenPr(pr)) return true;
    if (pr.draft) return true;
    if (!headSha) return true;
    if (hasLabel(labels, 'blocked')) {
        run.say('⏭️ pr-' + pr.number + ' skipped: blocked');
        run.skippedHeads++;
        run.deadHeadPassed = true;
        return true;
    }
    return false;
}

/**
 * One FIFO entry through the bot's stage decisions (gh-1185 extraction):
 * the unarmed arm defers to the SM, the armed arm runs the evidence
 * gates. An armed PR is a LIVE head by default: it owns the FIFO position
 * and nobody advances past it — unless the stale-pending check below
 * declares it dead (gh-766).
 */
function processFifoEntry(run, pr, labels, headSha) {
    var validating = hasLabel(labels, 'ai_validating');
    if (!validating || hasLabel(labels, 'agent:review')) {
        handleUnarmedPr(run, pr, labels, headSha);
        return; // mid-review: SM owns it
    }
    run.deadHeadPassed = false;
    if (pr.mergeable === false) return; // conflicts: conflict-rework (SM) owns it
    handleArmedPr(run, pr, hasLabel(labels, 'pr_approved'), headSha);
}

function action(params) {
    var job = (params && params.jobParams) || {};
    var target = resolveRepoTarget(job);
    var owner = target.owner, name = target.name;

    var log = [];
    function say(line) { log.push(line); console.log(line); }

    var prs = parseMcp(github_list_prs({ workspace: owner, repository: name, state: 'open' }));
    var list = listArray(prs);
    var run = {
        job: job,
        owner: owner,
        name: name,
        say: say,
        list: list,
        acted: 0,
        skippedHeads: 0,
        // gh-766 dead-head skip: the FIFO head position is checked for
        // liveness every tick. An owner-'blocked' PR, or an armed APPROVED
        // PR whose checks have been motionless past staleHeadMinutes
        // (default 120 = 2h), is skipped WITH AN EXPLICIT LOG LINE and the
        // queue advances past it to the first live (validated + green +
        // CLEAN) approved PR. A silent vanish here starved the whole queue
        // behind the head — acted: 0 for over an hour while 4
        // approved+validated PRs waited (live fa 2026-10-06: pr-1231
        // checks=pending over pr-1309/1311/1313/1317).
        staleHeadMinutes: staleHeadMinutesOr(job),
        deadHeadPassed: false,
        deferredApproved: false,
        redSlotProbed: false
    };
    // gh-952 slot release: the holder the open list can no longer see. An
    // externally-merged (owner bypass) armed PR is invisible to the scan
    // below — labels outlive the merge, the PR does not — so the FIFO
    // waited on a validate-armed turn nobody would ever hand out. When no
    // OPEN PR holds the merge-window arm, probe the merged list once: a
    // recently-merged still-armed holder means the slot is ALREADY
    // RELEASED — say so, and vacate the head position (gh-766 dead-head
    // parity: a validated candidate may take the turn on existing
    // evidence; the SM still owns arming the fresh head).
    var releasedHolder = findReleasedSlotHolder(list, owner, name);
    if (releasedHolder) {
        run.deadHeadPassed = true;
        say('🔓 pr-' + releasedHolder.number + ' held the merge-window slot but is MERGED — ' +
            'slot released (the armed stamps belonged to a merged PR, gh-952)');
    }

    // Oldest first — FIFO, same fairness as the SM's merge rule (#687).
    list.sort(function (a, b) { return (a.number || 0) - (b.number || 0); });

    for (var i = 0; i < list.length; i++) {
        var pr = parseMcp(github_get_pr({
            workspace: owner, repository: name, pullRequestId: list[i].number
        }));
        var labels = labelNames(pr);
        var headSha = headShaOf(pr);
        if (skipFifoEntry(run, pr, labels, headSha)) continue;
        processFifoEntry(run, pr, labels, headSha);
    }

    // END-OF-RUN SELF-TICK — extracted verbatim into selfTickToSm()
    // (gh-952: the merged-slot-holder release joined action()'s loop and
    // the CRAP ratchet forbids growing action; the self-tick block moved
    // to the helper above, behavior unchanged).
    selfTickToSm(owner, name, job, run.deferredApproved, run.acted, say);

    say('mergeBot complete — acted: ' + run.acted + ', heads skipped: ' + run.skippedHeads);
    return { success: true, acted: run.acted, skipped: run.skippedHeads, log: log };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, checksRollup: checksRollup, rollupDetail: rollupDetail, mergeStateOf: mergeStateOf, blockedWaitLine: blockedWaitLine, labelNames: labelNames };
}
