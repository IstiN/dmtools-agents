/**
 * SM Provider — SCM-agnostic I/O for the machine-loop watchdog
 * (machineSmAgent.js).
 *
 * The watchdog's decision core is pure state → actions; this module is the
 * only place that talks to a forge. Provider selection mirrors scm.js:
 *
 *     var provider = createSmProvider({
 *         scm:    { provider: 'github' },           // 'github' | 'gitlab'
 *         repository: { owner: 'epam', repo: 'dmtools-dart' }
 *     });
 *
 * Everything goes through the unified snake_case tool surface (github_* /
 * gitlab_* MCP tools via the dmtools JS bridge) — the same abstraction the
 * rest of the agent ecosystem uses — so the watchdog runs unchanged on any
 * forge the bridge supports. The one exception today is GitHub's
 * update-branch (no native tool yet) which falls back to the gh CLI.
 *
 * Provider contract (all methods):
 *   listMachineIssues(machineLabels, agentHandle, limit) → [{number, title, labels, assignees}]
 *       Open issues carrying any machine label or the agent assignee.
 *   findPr(issueNumber, branchPrefix) → null | {number, state, branch}
 *       OPEN first (branch match <prefix><n> or body references #n), then
 *       MERGED on the branch (close-issue safety net).
 *   prStatus(prNumber) → {state, checkConclusion, mergeState, mergeable, author}
 *       checkConclusion: 'red' | 'green' | 'pending' | 'none'.
 *       author: creator login ('' when the API does not expose it) — the
 *       prMachineAuthor gate keys on it.
 *   activeMachineRuns() → [issueNumber, …]
 *       Issues with a queued/in_progress machine run right now.
 *   dispatchLeg(issueNumber, leg, reason)
 *       Fire the machine runner for that issue (leg: dev/review/rework).
 *   updateBranch(prNumber) / merge(prNumber) / closeIssue(n, comment)
 *   addIssueLabel(issueNumber, label)
 *
 * Known gaps (documented, non-fatal):
 *   - gitlab has no close-issue tool — closeIssue warns and no-ops.
 *   - gitlab activeMachineRuns cannot map a pipeline to an issue number
 *     (pipelines do not expose trigger variables) — any running API-sourced
 *     pipeline counts as "machine busy" (conservative: fewer parallel legs).
 */
'use strict';

// ── Per-tick I/O cache ────────────────────────────────────────────────────
// One TTL cache (60s) for the whole SM tick. Measured on a busy tick: the
// same open-PR list was re-fetched per rule AND per issue findPr (18
// github_list_prs calls returning the same payload in ONE tick). Routing
// the three list sites + prStatus through this cache collapses that to a
// single fetch per kind per repo. TTL hits change nothing observable —
// same payload, same 60s staleness budget as the old per-provider memo
// (the branchHead cache below), now shared across every provider instance
// created during the tick.
//
// runAsync workers are FRESH isolates with an empty module cache: they
// cannot see this holder. createSmProvider({ preseed }) re-hydrates it
// from an args-carried snapshot() bundle — the fan-out in
// sm/sources/githubSource.js ships the snapshot to each worker that way.
var SM_IO_CACHE_TTL_MS = 60 * 1000;
var _cache = { ttlMs: SM_IO_CACHE_TTL_MS, entries: {} };

function ioCacheKey(owner, repo, kind, id) {
    return owner + '/' + repo + ':' + kind + (id ? ':' + id : '');
}

function ioCacheGet(owner, repo, kind, id) {
    var key = ioCacheKey(owner, repo, kind, id);
    var entry = _cache.entries[key];
    if (!entry) return undefined;
    if (Date.now() - entry.at > _cache.ttlMs) {
        delete _cache.entries[key];
        return undefined;
    }
    return entry.data;
}

function ioCachePut(owner, repo, kind, id, data) {
    _cache.entries[ioCacheKey(owner, repo, kind, id)] = { at: Date.now(), data: data };
}

// Collect every non-expired entry of one kind for a repo into a plain
// {id: data} map — the prStatus leg of snapshot(). Keys are the id tail
// of the cache key (PR numbers as strings).
function ioCacheCollect(owner, repo, kind) {
    var out = {};
    var prefix = owner + '/' + repo + ':' + kind + ':';
    var keys = Object.keys(_cache.entries);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(prefix) !== 0) continue;
        var entry = _cache.entries[keys[i]];
        if (Date.now() - entry.at > _cache.ttlMs) {
            delete _cache.entries[keys[i]];
            continue;
        }
        out[keys[i].substring(prefix.length)] = entry.data;
    }
    return out;
}

// Ecosystem-standard MCP result parsing (see parseMcpResult in the agent
// scripts): bridge tools may return decoded objects, JSON strings, or
// {data: …} envelopes.
function parseMcp(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

function asList(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.pullRequests)) return parsed.pullRequests;
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.issues)) return parsed.issues;
    return [];
}

function githubProvider(cfg) {
    var owner = cfg.repository.owner;
    var repo = cfg.repository.repo;

    // Default-branch HEAD cache (one SM tick). REST mergeable_state
    // lazily recomputes to `unknown` right after a base push, so
    // behind/CLEAN is computed deterministically from base.sha vs the
    // live branch head (github_list_branches is always current). The full
    // name→sha map rides the shared per-tick ioCache: one
    // github_list_branches call per repo per tick instead of one per
    // unknown base branch.
    function branchHeadsMap() {
        var cached = ioCacheGet(owner, repo, 'branches', null);
        if (cached) return cached;
        var map = {};
        if (typeof github_list_branches === 'function') {
            try {
                var branches = parseMcp(github_list_branches({
                    workspace: owner, repository: repo
                })) || [];
                for (var i = 0; i < branches.length; i++) {
                    var b = branches[i];
                    if (b && b.name) {
                        map[b.name] = b.commit && b.commit.sha;
                    }
                }
            } catch (e) { /* older runtime without the tool */ }
        }
        ioCachePut(owner, repo, 'branches', null, map);
        return map;
    }
    function branchHead(name) {
        var head = branchHeadsMap()[name];
        return head === undefined ? null : head;
    }

    // Open / merged PR lists ride the same per-tick cache (kind openPrs /
    // mergedPrs) — findPr is called per candidate issue and per rule, and
    // each call used to re-fetch both lists (measured: 18 github_list_prs
    // in one idle tick, all returning the same empty payload).
    function listOpenPrs() {
        var cached = ioCacheGet(owner, repo, 'openPrs', null);
        if (cached) return cached;
        var list = asList(parseMcp(github_list_prs({
            workspace: owner, repository: repo, state: 'open'
        })));
        ioCachePut(owner, repo, 'openPrs', null, list);
        return list;
    }

    function listMergedPrs() {
        var cached = ioCacheGet(owner, repo, 'mergedPrs', null);
        if (cached) return cached;
        var list = asList(parseMcp(github_list_prs({
            workspace: owner, repository: repo, state: 'merged'
        })));
        ioCachePut(owner, repo, 'mergedPrs', null, list);
        return list;
    }
    var full = owner + '/' + repo;

    function ghIssueToState(it) {
        return {
            number: it.number,
            title: it.title,
            labels: (it.labels || []).map(function (l) { return l.name || l; }),
            assignees: (it.assignees || []).map(function (a) { return a.login || a; })
        };
    }

    // (prStatus computation hoisted — see the memo wrapper in the contract below)
    function computePrStatus(prNumber) {
            var pr = parseMcp(github_get_pr({
                workspace: owner, repository: repo, pullRequestId: prNumber
            })) || {};
            var rollup = pr.statusCheckRollup || [];
            if (!rollup.length && pr.head && pr.head.sha) {
                // REST reality: the pull body has no rollup (that is the
                // GraphQL spelling); the Java-parity check-runs tool is
                // the REST path. Conclusions arrive lowercase — normalize
                // before the red/pending comparisons below.
                var cr = parseMcp(github_get_commit_check_runs({
                    workspace: owner, repository: repo, commitSha: pr.head.sha
                })) || {};
                rollup = (cr.check_runs || []).map(function (r) {
                    return {
                        name: r.name || null,
                        conclusion: r.conclusion ? String(r.conclusion).toUpperCase() : null,
                        status: r.status ? String(r.status).toUpperCase() : null
                    };
                });
            }
            // CANCELLED is NOT a verdict: a cancelled validation run says
            // nothing about the head (stale-run cleanup, quota sweeps,
            // re-dispatches all cancel runs). Treating it as red made the
            // engine dispatch rework legs on perfectly good PRs (live:
            // dart gh-191, twice on 2026-09-22 after manual run cleanups).
            // A cancelled check is ignored; if nothing conclusive remains,
            // the rollup reads pending/none and validate-fresh re-runs CI.
            var red = false, pending = false, ignored = 0, bookkept = 0;
            // Bookkeeping checks are NOT verdicts (dmtools-agents#628):
            // sm-kicker fires on EVERY non-main push (timer auto-commit,
            // silent refresh) and the runner wake-up probe stamps its own
            // success — a head carrying only these folds 'green', so the
            // validation lane (checks none|pending) never fires and the PR
            // dead-zones (live: dart #332, born green from a timer-pushed
            // branch, 3 ticks processed 0). Same handling as CANCELLED:
            // ignore; the trailing rule then reports 'pending' and
            // validate-fresh dispatches the real CI on the head.
            // 'merge /' joined the list for dmtools-agents#635 (live fa
            // pr-1174, 2026-10-02): the Machine Merge Bot stamps its own
            // check-run on the head it is EVALUATING — a queued/in-flight
            // 'merge / merge' made the rollup read pending, so the bot
            // waited on itself and merge-validated (checks:green) never
            // matched either: armed → sweep → re-arm loop with a green,
            // merge-ready head. The merge lane's check is machine
            // bookkeeping, not a validation verdict.
            var BOOKKEEPING_CHECK_PREFIXES = ['kicker /', 'Wake-up probe', 'merge /'];
            // (all-cancelled/bookkeeping still counts as 'no verdict yet')
            rollup.forEach(function (c) {
                var concl = c.conclusion;
                var status = c.status;
                var cname = String((c && (c.name || c.context)) || '');
                for (var bi = 0; bi < BOOKKEEPING_CHECK_PREFIXES.length; bi++) {
                    if (cname.indexOf(BOOKKEEPING_CHECK_PREFIXES[bi]) === 0) { bookkept++; return; }
                }
                if (concl === 'CANCELLED') { ignored++; return; }
                if (concl === 'FAILURE' || concl === 'TIMED_OUT') red = true;
                else if (!concl || status === 'QUEUED' || status === 'IN_PROGRESS' ||
                         status === 'WAITING' || status === 'PENDING') pending = true;
            });
            // Cancelled still forces 'no verdict yet' even next to green
            // (a cancelled validation IS the missing verdict). Bookkeeping
            // checks must NOT: green validation + kicker noise stays green,
            // or every pushed-branch PR would re-validate forever. A head
            // with ONLY bookkeeping checks has no verdict at all → pending,
            // which is exactly what validate-fresh (none|pending) arms on.
            var realCount = rollup.length - ignored - bookkept;
            if (ignored > 0) pending = true;
            if (realCount === 0 && bookkept > 0) pending = true;
            // Live shape: github_get_pr returns the REST body, where the
            // field is `mergeable_state` with lowercase values (clean,
            // dirty, blocked, behind, has_hooks, draft, unknown) — the
            // GraphQL `mergeStateStatus` spelling never appears. Map REST
            // first (uppercase), keep the GraphQL passthrough, and only
            // then fall back to the coarse mergeable bool.
            var ms = pr.mergeStateStatus ||
                (pr.mergeable_state ? String(pr.mergeable_state).toUpperCase() : '') || '';
            // Deterministic override (see branchHead): DIRTY on real
            // conflicts, BEHIND when the base moved, else the REST verdict
            // — preserving BLOCKED for fresh heads whose required checks
            // are pending/red. Masking BLOCKED as CLEAN deadlocked
            // unarm-stale-validation on armed fresh PRs (live: dart #195 —
            // ai_validating stuck for hours while this override reported
            // CLEAN to every mergeState:[BEHIND,BLOCKED] rule). Falls back
            // to CLEAN/UNKNOWN only when the REST body has no verdict.
            if (pr.mergeable === false) {
                ms = 'DIRTY';
            } else if (pr.base && pr.base.ref) {
                var head = branchHead(pr.base.ref);
                if (head) {
                    if (pr.base.sha !== head) {
                        ms = 'BEHIND';
                    } else {
                        // Base fresh: a REST BLOCKED is real (required checks
                        // pending/red on the current head — branch protection
                        // unmet) and must survive; any other REST verdict on a
                        // fresh base ('behind', 'unknown') is a recompute lie —
                        // deterministically CLEAN.
                        ms = ms === 'BLOCKED' ? 'BLOCKED' : 'CLEAN';
                    }
                }
            }
            if (!ms) ms = pr.mergeable === true ? 'CLEAN' : 'UNKNOWN';
            return {
                // REST reports `state` lowercase ('open'); guards compare
                // against 'OPEN'/'MERGED' — normalize like the check-run
                // conclusions and mergeable_state above.
                state: pr.state ? String(pr.state).toUpperCase() : 'OPEN',
                checkConclusion: rollup.length === 0 ? 'none' : (red ? 'red' : (pending ? 'pending' : 'green')),
                mergeState: ms,
                mergeable: pr.mergeable,
                // Head sha pins the review-verdict comparison: a verdict
                // rendered on an older commit is stale after pushes.
                headSha: (pr.head && pr.head.sha) || null,
                // Head ref — SM legs dispatched on the PR branch link their
                // workflow runs to the PR (checks area + timeline).
                branch: (pr.head && pr.head.ref) || '',
                // PR-side labels (REST body): issue-anchored SM rules read
                // them via prLabels/notPrLabels guards — the machine loop
                // keeps ai_pr_reviewed/agent:review on the PR, not the issue.
                labels: (pr.labels || []).map(function (l) {
                    return (l && l.name) || l;
                }),
                // Creator login — the prMachineAuthor gate keys auto legs
                // on it. REST body spells it `user`; GraphQL/tests use
                // `author` (same dual read as the PR list path).
                author: (pr.user && pr.user.login) ||
                    (pr.author && (pr.author.login || pr.author.name)) || ''
            };
    }

    return {
        provider: 'github',

        listOpenPrs: listOpenPrs,
        listMergedPrs: listMergedPrs,

        // snapshot(kinds?) — kinds limits which cache legs to materialize:
        // the queryPrs batch only needs openPrs + branchHeads, and the
        // merged-PR list was measured at ~1.8s on a busy repo for ZERO
        // uses in that path. Omitted kinds stay out of the preseed; a
        // worker that then actually needs one fetches it on demand.
        snapshot: function (kinds) {
            // Args-carried cache snapshot for the runAsync worker engines:
            // every worker is a FRESH isolate with an empty module cache,
            // so it cannot see this holder. The fan-out in
            // sm/sources/githubSource.js fetches this ONCE per batch and
            // hands it to each worker via createSmProvider({ preseed }) —
            // a worker's first cache read then hits instead of re-fetching
            // the same lists over the bridge. prStatus rides along so a
            // later rule's batch inherits every status an earlier rule's
            // workers already paid for (workers cannot write back — the
            // main engine absorbs results via memoPrStatus, see
            // githubSource.js — and ships them onward in the next
            // snapshot).
            var want = {};
            (kinds || ['openPrs', 'mergedPrs', 'branchHeads', 'prStatus'])
                .forEach(function (k) { want[k] = true; });
            var out = {};
            if (want.openPrs) out.openPrs = listOpenPrs();
            if (want.mergedPrs) out.mergedPrs = listMergedPrs();
            if (want.branchHeads) out.branchHeads = branchHeadsMap();
            if (want.prStatus) out.prStatus = ioCacheCollect(owner, repo, 'prStatus');
            return out;
        },

        listMachineIssues: function (machineLabels, agentHandle, limit) {
            // GitHub search ANDs multiple label: qualifiers — run one
            // search per label (OR semantics), merge unique by number.
            var seen = {};
            var out = [];
            machineLabels.forEach(function (ml) {
                var res = parseMcp(github_search_issues({
                    query: 'repo:' + full + ' is:issue is:open label:"' + ml + '"'
                }));
                asList(res).forEach(function (it) {
                    if (seen[it.number]) return;
                    seen[it.number] = true;
                    out.push(ghIssueToState(it));
                });
                if (out.length >= (limit || 50)) return; // forEach: enough
            });
            var extra = parseMcp(github_search_issues({
                query: 'repo:' + full + ' is:issue is:open assignee:' + agentHandle
            }));
            asList(extra).forEach(function (it) {
                if (seen[it.number]) return;
                seen[it.number] = true;
                out.push(ghIssueToState(it));
            });
            return out.slice(0, limit || 50);
        },

        findPr: function (issueNumber, branchPrefix) {
            var branch = branchPrefix + issueNumber;
            var headFilter = owner + ':' + branch;
            var list = listOpenPrs();
            var open = list.filter(function (p) {
                return (p.head && p.head.label) === headFilter;
            });
            var bodyRe = new RegExp('(^|[^0-9])#' + issueNumber + '([^0-9]|$)');
            if (!open.length) {
                open = list.filter(function (p) {
                    return bodyRe.test(String(p.body || ''));
                });
            }
            if (open.length) {
                return { number: open[0].number, state: 'OPEN',
                         branch: (open[0].head && open[0].head.ref) || branch };
            }
            var merged = listMergedPrs().filter(function (p) {
                return (p.head && p.head.label) === headFilter;
            });
            if (merged.length) {
                return { number: merged[0].number, state: 'MERGED', branch: branch };
            }
            return null;
        },

        prStatus: function (prNumber) {
            // Per-tick memo (kind prStatus, key = PR number): measured on a
            // busy tick — three rules re-fetched prStatus 23× for the same
            // 7 PRs (23× github_get_pr + 23× github_get_commit_check_runs,
            // all sequential). Results are read-only for callers
            // (githubSource assigns item.pr; matchesGuards only reads), so
            // sharing the cached reference is safe.
            var memo = ioCacheGet(owner, repo, 'prStatus', prNumber);
            if (memo) return memo;
            var out = computePrStatus(prNumber);
            ioCachePut(owner, repo, 'prStatus', prNumber, out);
            return out;
        },

        memoPrStatus: function (prNumber, data) {
            // Main-engine write-back for the runAsync fan-out: worker
            // engines compute prStatus in their own isolates and hand the
            // result back through smAsync's ordered results — absorbing it
            // here (same per-tick ioCache) makes the NEXT batch's snapshot
            // preseed hit instead of re-fetching the same PR across rules
            // (measured: 3 rules × 6 PRs re-fetched identically per tick
            // without this). Read-only callers make sharing the reference
            // safe, same as the memo itself.
            if (data) ioCachePut(owner, repo, 'prStatus', prNumber, data);
        },
        lastReview: function (prNumber) {
            // REST: reviews arrive chronological, the last entry is the
            // latest verdict; commit_id pins the head it was rendered on
            // (GraphQL spelling commitId kept as a fallback).
            var list = asList(parseMcp(github_list_pr_reviews({
                workspace: owner, repository: repo, pullRequestId: String(prNumber)
            })));
            if (!list.length) return null;
            var r = list[list.length - 1];
            return {
                state: r.state || null,
                commitId: r.commit_id || r.commitId || null,
                author: (r.user && r.user.login) || null
            };
        },

        reviewThreads: function (prNumber) {
            // GraphQL-only surface (REST has no threads endpoint):
            // {data:{repository:{pullRequest:{reviewThreads:{nodes:[
            // {id,isResolved,...}]}}}}} — navigate the envelope by hand,
            // parseMcp only unwraps the JSON string.
            var res = parseMcp(github_get_pr_review_threads({
                workspace: owner, repository: repo, pullRequestId: String(prNumber)
            }));
            var nodes = (res && res.data && res.data.repository &&
                         res.data.repository.pullRequest &&
                         res.data.repository.pullRequest.reviewThreads &&
                         res.data.repository.pullRequest.reviewThreads.nodes) || [];
            var resolved = 0;
            nodes.forEach(function (t) { if (t && t.isResolved) resolved++; });
            return { total: nodes.length, resolved: resolved,
                     unresolved: nodes.length - resolved };
        },

        activeMachineRuns: function (workflowFile) {
            var runs = parseMcp(github_list_workflow_runs({
                workflowId: workflowFile, status: 'in_progress', perPage: 30
            })) || {};
            var queued = parseMcp(github_list_workflow_runs({
                workflowId: workflowFile, status: 'queued', perPage: 30
            })) || {};
            var all = (runs.workflow_runs || runs.workflowRuns || [])
                .concat(queued.workflow_runs || queued.workflowRuns || []);
            var issues = [];
            all.forEach(function (r) {
                var m = /gh-(\d+)/.exec(String(r.display_title || r.displayTitle || r.name || ''));
                if (m) issues.push(parseInt(m[1], 10));
            });
            return issues;
        },

        dispatchLeg: function (issueNumber, leg, reason, workflowFile) {
            // The bridge tool takes inputs as a JSON string (Java parity).
            return github_trigger_workflow({
                workflowId: workflowFile,
                ref: 'main',
                inputs: JSON.stringify({
                    issue: String(issueNumber), leg: leg, reason: reason || ''
                })
            });
        },

        updateBranch: function (prNumber) {
            // No native tool for the update-branch API yet — gh CLI fallback
            // (whitelisted: gh).
            return cli_execute_command({
                command: 'gh pr update-branch ' + prNumber + ' --repo ' + full
            });
        },

        merge: function (prNumber) {
            return github_merge_pr({
                workspace: owner, repository: repo, pullRequestId: prNumber, mergeMethod: 'squash'
            });
        },

        closeIssue: function (issueNumber, comment) {
            if (comment) {
                try { github_create_comment({ workspace: owner, repository: repo, number: issueNumber, body: comment }); }
                catch (e) { console.warn('  ⚠️ close-issue comment failed: ' + (e.message || e)); }
            }
            return github_close_issue({ workspace: owner, repository: repo, number: issueNumber });
        },

        addIssueLabel: function (issueNumber, label) {
            return github_add_labels({ workspace: owner, repository: repo, number: issueNumber, labels: [label] });
        },

        // ── PR lifecycle primitives (issue #687: SM owns the PR loop) ──
        // Labels ride the issues API — a PR is an issue for labeling.

        addPrLabel: function (prNumber, label) {
            return github_add_labels({ workspace: owner, repository: repo, number: prNumber, labels: [label] });
        },

        removePrLabel: function (prNumber, label) {
            // Absent label → 404; treat as an idempotent no-op.
            try {
                return github_remove_label({ workspace: owner, repository: repo, number: prNumber, label: label });
            } catch (e) {
                console.warn('  ⚠️ remove "' + label + '" from PR #' + prNumber + ': ' + (e.message || e));
                return null;
            }
        },

        dispatchPrLeg: function (prNumber, leg, reason, workflowFile) {
            // PR-anchored dispatch: the factory takes the PR number as the
            // anchor instead of an issue (review of PRs born without one).
            return github_trigger_workflow({
                workflowId: workflowFile,
                ref: 'main',
                inputs: JSON.stringify({
                    issue: '', leg: leg, reason: reason || '', pr: String(prNumber)
                })
            });
        },

        silentUpdateBranch: function (prNumber, silentToken, restoreToken) {
            // Silent refresh of an armed PR: pushes made with the workflow's
            // own github.token trigger NO workflows, so the branch updates
            // without re-running the CI matrix (issue #687 — test once per
            // state, update for free).
            var update = function () {
                return cli_execute_command({
                    command: 'gh pr update-branch ' + prNumber + ' --repo ' + full
                });
            };
            if (!silentToken) return update();
            try {
                set_env_variable('GH_TOKEN', silentToken);
                return update();
            } finally {
                set_env_variable('GH_TOKEN', restoreToken || silentToken);
            }
        }
    };
}

function gitlabProvider(cfg) {
    var owner = cfg.repository.owner;   // group or user namespace
    var repo = cfg.repository.repo;

    function projectPath() { return owner + '/' + repo; }

    function glIssueToState(it) {
        return {
            number: it.iid,
            title: it.title,
            labels: it.labels || [],
            assignees: (it.assignees || []).map(function (a) { return a.username || a; })
        };
    }

    return {
        provider: 'gitlab',

        listOpenPrs: function () {
            // Documented gap (gitlab twin of the github contract): the
            // runAsync fan-out is github-only for now; returning null lets
            // callers skip the snapshot fetch the same way.
            return null;
        },

        snapshot: function () {
            // Documented gap — see listOpenPrs above.
            return null;
        },

        listMachineIssues: function (machineLabels, agentHandle, limit) {
            // gitlab_list_issues accepts comma-separated labels (AND on
            // GitLab); machine labels are OR semantics, so list open issues
            // once and filter client-side.
            var res = gitlab_list_issues({ workspace: owner, repository: repo, state: 'opened', perPage: limit || 50 }) || [];
            return (res.issues || res || []).filter(function (it) {
                var labels = it.labels || [];
                var assignees = (it.assignees || []).map(function (a) { return a.username || a; });
                if (assignees.indexOf(agentHandle) !== -1) return true;
                return machineLabels.some(function (ml) { return labels.indexOf(ml) !== -1; });
            }).map(glIssueToState);
        },

        findPr: function (issueNumber, branchPrefix) {
            var branch = branchPrefix + issueNumber;
            var bodyRe = new RegExp('(^|[^0-9])#' + issueNumber + '([^0-9]|$)');
            var open = (gitlab_list_mrs({ workspace: owner, repository: repo, state: 'opened' }) || []).filter(function (mr) {
                return mr.source_branch === branch || bodyRe.test(String(mr.description || ''));
            });
            if (open.length) {
                return { number: open[0].iid, state: 'OPEN', branch: open[0].source_branch || branch };
            }
            var merged = (gitlab_list_mrs({ workspace: owner, repository: repo, state: 'merged' }) || []).filter(function (mr) {
                return mr.source_branch === branch;
            });
            if (merged.length) {
                return { number: merged[0].iid, state: 'MERGED', branch: branch };
            }
            return null;
        },

        prStatus: function (mrNumber) {
            var mr = gitlab_get_mr({ workspace: owner, repository: repo, pullRequestId: String(mrNumber) }) || {};
            // Pipelines for the MR head — the CI verdict.
            var pipes = (gitlab_get_mr_pipelines({ workspace: owner, repository: repo, pullRequestId: String(mrNumber) }) || {});
            var list = pipes.pipelines || pipes || [];
            var red = false, pending = false, any = false;
            list.forEach(function (p) {
                any = true;
                var st = p.status || p.detailed_status;
                if (st === 'failed' || st === 'canceled') red = true;
                else if (st === 'running' || st === 'pending' || st === 'created' || st === 'waiting_for_resource') pending = true;
            });
            var mergeState = 'UNKNOWN';
            if (mr.merge_status === 'can_be_merged' && !mr.has_conflicts) mergeState = 'CLEAN';
            else if (mr.has_conflicts) mergeState = 'BEHIND'; // conflicts ⇒ needs rebase
            else if (mr.merge_status === 'checking') mergeState = 'UNKNOWN';
            return {
                state: mr.state ? String(mr.state).toUpperCase() : 'OPEN',
                checkConclusion: any ? (red ? 'red' : (pending ? 'pending' : 'green')) : 'none',
                mergeState: mergeState,
                mergeable: mr.merge_status === 'can_be_merged' && !mr.has_conflicts,
                // MR author login — the prMachineAuthor gate (GitHub twin
                // reads `user.login`; GitLab spells it `author.username`).
                author: (mr.author && mr.author.username) || ''
            };
        },

        activeMachineRuns: function () {
            // Pipelines do not expose trigger variables, so an API-sourced
            // running pipeline is conservatively "the machine is busy".
            var res = gitlab_list_pipeline_runs({ workspace: owner, repository: repo, status: 'running' }) || [];
            var runs = res.pipelines || res || [];
            var api = runs.filter(function (p) { return p.source === 'api' || p.source === 'trigger'; });
            return api.length ? ['unknown'] : [];
        },

        dispatchLeg: function (issueNumber, leg, reason, workflowFile) {
            // The GitLab machine runner pipeline receives the leg the same
            // way ai-teammate.yml does on GitHub: variables.
            return gitlab_trigger_pipeline({
                workspace: owner,
                repository: repo,
                ref: 'main',
                variablesJson: JSON.stringify({
                    issue: String(issueNumber),
                    leg: leg,
                    reason: reason || ''
                })
            });
        },

        updateBranch: function (mrNumber) {
            return gitlab_rebase_mr({ workspace: owner, repository: repo, pullRequestId: String(mrNumber) });
        },

        merge: function (mrNumber) {
            return gitlab_merge_mr({ workspace: owner, repository: repo, pullRequestId: String(mrNumber) });
        },

        closeIssue: function (issueNumber, comment) {
            // No native close-issue tool in the GitLab catalog yet —
            // document the gap, stay non-fatal.
            console.warn('  ⚠️ gitlab close-issue tool not available — issue !' +
                issueNumber + ' left open (comment-only).');
            if (comment) {
                // Issue notes ride the generic note path when present.
                try { gitlab_create_mr_note({ workspace: owner, repository: repo, pullRequestId: String(issueNumber), text: comment }); }
                catch (e) { console.warn('  ⚠️ close-issue comment failed: ' + (e.message || e)); }
            }
            return null;
        },

        addIssueLabel: function (issueNumber, label) {
            // Issue-level labels ride the MR label tool shape; where the
            // project uses MR labels for machine state this is exact.
            return gitlab_add_mr_label({ workspace: owner, repository: repo, pullRequestId: String(issueNumber), label: label });
        }
    };
}

/**
 * Creates the SM provider for the configured forge.
 * @param {Object} config - { scm: { provider }, repository: { owner, repo } }
 * @returns {Object} provider implementing the contract above
 */
function createSmProvider(config) {
    var cfg = config || {};
    var provider = (cfg.scm && cfg.scm.provider) || 'github';
    if (!cfg.repository || !cfg.repository.owner || !cfg.repository.repo) {
        throw new Error('smProvider: repository.owner and repository.repo are required');
    }
    // Preseed: re-hydrate the per-tick ioCache from an args-carried
    // snapshot() bundle — runAsync worker engines call this so their
    // first cache read hits instead of re-fetching the lists the main
    // engine already paid for.
    if (cfg.preseed) {
        if (cfg.preseed.openPrs) {
            ioCachePut(cfg.repository.owner, cfg.repository.repo, 'openPrs', null, cfg.preseed.openPrs);
        }
        if (cfg.preseed.mergedPrs) {
            ioCachePut(cfg.repository.owner, cfg.repository.repo, 'mergedPrs', null, cfg.preseed.mergedPrs);
        }
        if (cfg.preseed.branchHeads) {
            ioCachePut(cfg.repository.owner, cfg.repository.repo, 'branches', null, cfg.preseed.branchHeads);
        }
        if (cfg.preseed.prStatus) {
            // {number-as-string: status} leg of snapshot() — see the
            // github provider's memoPrStatus for the write-back side.
            var memoIds = Object.keys(cfg.preseed.prStatus);
            for (var mi = 0; mi < memoIds.length; mi++) {
                ioCachePut(cfg.repository.owner, cfg.repository.repo,
                    'prStatus', memoIds[mi], cfg.preseed.prStatus[memoIds[mi]]);
            }
        }
    }
    if (provider === 'gitlab') return gitlabProvider(cfg);
    if (provider === 'github') return githubProvider(cfg);
    throw new Error('smProvider: unknown provider "' + provider + '" (github | gitlab)');
}

if (typeof module !== 'undefined' && module.exports) {
    // _cache is exported for the unit tests (clearing/aging the holder);
    // production callers never touch it directly.
    module.exports = { createSmProvider: createSmProvider, _cache: _cache };
}
