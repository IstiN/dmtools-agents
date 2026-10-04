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
    var cr = parseMcp(github_get_commit_check_runs({
        workspace: owner, repository: name, commitSha: commitSha
    }));
    var runs = cr.check_runs || cr.total_count !== undefined ? (cr.check_runs || []) : [];
    if (!runs.length && pr && Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length) {
        runs = pr.statusCheckRollup;
    }
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
        var mine = wruns.filter(function (r) { return String(r.head_sha || r.headSha) === String(commitSha); });
        if (mine.length) {
            // newest first (API order); conclusion decides, in-flight waits
            var top = mine[0];
            var c = top.conclusion ? String(top.conclusion).toUpperCase() : null;
            if (c === 'SUCCESS') return 'green';
            if (c === 'FAILURE' || c === 'TIMED_OUT' || c === 'CANCELLED') return 'red';
            return 'pending';
        }
        return 'none';
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
    var runs = [];
    try {
        var wf = parseMcp(github_list_workflow_runs({
            workspace: owner, repository: name,
            workflowId: 'machine-sm.yml', perPage: 30
        }));
        runs = (wf && (wf.workflow_runs || wf.runs)) || [];
        if (!runs.length && wf && wf.message) {
            var all = parseMcp(github_list_workflow_runs({
                workspace: owner, repository: name, perPage: 30
            }));
            var allRuns = (all && (all.workflow_runs || all.runs)) || [];
            runs = allRuns.filter(function (r) {
                return String(r.path || '') === '.github/workflows/machine-sm.yml';
            });
        }
    } catch (eActive) {
        return false; // unlistable → fail open, the self-heal still fires
    }
    var now = Date.now();
    for (var i = 0; i < runs.length; i++) {
        var r = runs[i] || {};
        var s = r.status ? String(r.status).toLowerCase() : '';
        if (s !== 'queued' && s !== 'in_progress' && s !== 'waiting' && s !== 'pending') continue;
        if (s !== 'in_progress') {
            var ts = Date.parse(r.updated_at || r.updatedAt || r.created_at || r.createdAt || '');
            if (!isNaN(ts) && (now - ts) > 6 * 60 * 60 * 1000) continue; // zombie queued > 6h
        }
        return true;
    }
    return false;
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
    var deferredApproved = false;

    // Owner directive 2026-10-04 ("red yields the slot") — diagnostic only:
    // once per run, when the first approved PR is deferred as FIFO-queued,
    // probe whether the ai_validating holder's validation has CONCLUDED RED
    // (an in-flight run reads 'pending' and stays silent). A red holder
    // means the SM's fail-validation should have freed the slot — the line
    // makes the starvation visible in the bot log (live fa 11:0x: #1194
    // held a concluded-red arm while #1215..#1223 queued 40+ min). The bot
    // itself NEVER acts on it (no unarm, no dispatch — SM-owned).
    var redSlotProbed = false;
    function noteRedSlotHolder(queuedNumber) {
        if (redSlotProbed) return;
        redSlotProbed = true;
        try {
            for (var h = 0; h < list.length; h++) {
                var hp = list[h];
                var hNum = (hp && (hp.number || hp.prNumber)) || 0;
                var hLabels = labelNames(hp || {});
                if (!hNum || hNum === queuedNumber) continue;
                if (hLabels.indexOf('ai_validating') === -1) continue;
                // mutexAmong parity: only APPROVED arms serialize this
                // queue — a dev-lane arm does not hold the merge-window slot.
                if (hLabels.indexOf('pr_approved') === -1) continue;
                var hHead = hp.head && (hp.head.sha || hp.head);
                if (!hHead) continue;
                if (checksRollup(String(hHead), hp, job, owner, name) === 'red') {
                    say('🚨 pr-' + hNum + ' holds slot with concluded-red validation — fail path should free it');
                }
                return; // one holder possible — probed, said or not
            }
        } catch (eRed) { /* diagnostic only — never fails the run */ }
    }

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
        if (labels.indexOf('blocked') !== -1) continue; // #939: owner-parked — the bot ignores it even when green

        var approved = labels.indexOf('pr_approved') !== -1;
        var validating = labels.indexOf('ai_validating') !== -1;
        if (!validating || labels.indexOf('agent:review') !== -1) {
            // Approved-but-unarmed PRs are FIFO-queued behind the current
            // validation (validate-armed mutex, one CI at a time). Say so —
            // a silent skip is indistinguishable from a stuck pipeline for
            // the operator (live: fa 2026-09-25, pr-948/pr-963 sat silent
            // for hours while the queue was healthy).
            if (approved && labels.indexOf('agent:review') === -1) {
                say('⏳ pr-' + pr.number + ' approved — FIFO-queued (awaiting validate-armed turn)');
                deferredApproved = true;
                noteRedSlotHolder(pr.number);
            }
            continue; // mid-review: SM owns it
        }
        if (pr.mergeable === false) continue; // conflicts: conflict-rework (SM) owns it

        var rollup = checksRollup(String(headSha), pr, job, owner, name);
        if (rollup !== 'green') {
            say('⏳ pr-' + pr.number + ' checks=' + rollup + ' — waiting');
            continue;
        }
        var ms = mergeStateOf(pr);
        if (ms !== 'CLEAN') {
            // Unarm ONLY on real staleness (BEHIND: base moved; DIRTY:
            // conflicts). BLOCKED right after a workflow_run trigger means
            // 'required checks still settling' — unarming there races the
            // check-run conclusion, drops a green armed PR, and forces a
            // full re-validation cycle (live: fa pr-762, 11:36 — bot unarm
            // on BLOCKED while the rollup was green two lines above).
            if (approved && (ms === 'BEHIND' || ms === 'DIRTY')) {
                try {
                    github_remove_label({ workspace: owner, repository: name, number: pr.number, label: 'ai_validating' });
                    say('🔓 pr-' + pr.number + ' validated head stale (' + ms + ') — unarmed, refresh follows');
                    acted++;
                } catch (e) { say('⚠️ pr-' + pr.number + ' unarm failed: ' + (e.message || e)); }
            } else {
                say('⏳ pr-' + pr.number + ' mergeState=' + ms + ' — waiting (checks settling)');
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

    // END-OF-RUN SELF-TICK (owner rule 2026-10-04; live: agents#696,
    // dart#342 — the bot logged the defer line, exited acted:0, the repo
    // went event-quiet, and the validate-armed turn never came until a
    // human fired machine-sm.yml manually). A deferred approved PR with
    // acted==0 means NOTHING consumed this turn and no action of ours will
    // generate the events that re-drive the queue — fire ONE real SM tick
    // so the oldest approved PR gets its validate-armed turn. Not fired
    // when acted>0 (a merge/latch/unarm is motion — its events carry the
    // conveyor) nor when no deferred-approved was seen (nothing waits on a
    // turn). Review #701 hardening: the dispatch targets the PR's own repo
    // explicitly (--repo owner/name — gh resolves the CWD's repo, wrong in
    // multi-repo runners) and is SKIPPED when a machine-sm.yml run is
    // already queued/running (hasActiveSmRun — the active SM drains the
    // queue itself; a second tick per bot run was tick-storm amplification
    // during healthy waves). jobParams.selfTick=false disables it.
    if (deferredApproved && acted === 0 && job.selfTick !== false) {
        if (hasActiveSmRun(owner, name)) {
            say('⏭️ self-tick skipped (SM already active)');
        } else {
            try {
                cli_execute_command({
                    command: 'gh workflow run machine-sm.yml -F dryRun=false --repo ' + owner + '/' + name
                });
                say('🔁 deferred approved → SM tick dispatched (self-heal)');
            } catch (eTick) {
                say('⚠️ self-tick dispatch failed: ' + ((eTick && eTick.message) || eTick));
            }
        }
    }

    say('mergeBot complete — acted: ' + acted);
    return { success: true, acted: acted, log: log };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action: action, checksRollup: checksRollup, mergeStateOf: mergeStateOf, labelNames: labelNames };
}
