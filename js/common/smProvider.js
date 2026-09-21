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
    // live branch head (github_list_branches is always current).
    var branchHeads = {};
    function branchHead(name) {
        if (!(name in branchHeads)) {
            branchHeads[name] = null;
            if (typeof github_list_branches === 'function') {
                try {
                    var branches = parseMcp(github_list_branches({
                        workspace: owner, repository: repo
                    })) || [];
                    for (var i = 0; i < branches.length; i++) {
                        if (branches[i].name === name) {
                            branchHeads[name] = branches[i].commit && branches[i].commit.sha;
                            break;
                        }
                    }
                } catch (e) { /* older runtime without the tool */ }
            }
        }
        return branchHeads[name];
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

    return {
        provider: 'github',

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
            var list = asList(parseMcp(github_list_prs({
                workspace: owner, repository: repo, state: 'open'
            })));
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
            var merged = asList(parseMcp(github_list_prs({
                workspace: owner, repository: repo, state: 'merged'
            }))).filter(function (p) {
                return (p.head && p.head.label) === headFilter;
            });
            if (merged.length) {
                return { number: merged[0].number, state: 'MERGED', branch: branch };
            }
            return null;
        },

        prStatus: function (prNumber) {
            // Java @MCPParam parity: github_get_pr takes pullRequestId —
            // a bare `number` hit /pulls/null and 404'd silently, so every
            // rule guard reading mergeState/checks saw UNKNOWN/none (live:
            // the enrichment printed "finished" while returning garbage).
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
                        conclusion: r.conclusion ? String(r.conclusion).toUpperCase() : null,
                        status: r.status ? String(r.status).toUpperCase() : null
                    };
                });
            }
            var red = false, pending = false;
            rollup.forEach(function (c) {
                var concl = c.conclusion;
                var status = c.status;
                if (concl === 'FAILURE' || concl === 'TIMED_OUT' || concl === 'CANCELLED') red = true;
                else if (!concl || status === 'QUEUED' || status === 'IN_PROGRESS' ||
                         status === 'WAITING' || status === 'PENDING') pending = true;
            });
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
                workspace: owner, repository: repo, number: prNumber, mergeMethod: 'squash'
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
    if (provider === 'gitlab') return gitlabProvider(cfg);
    if (provider === 'github') return githubProvider(cfg);
    throw new Error('smProvider: unknown provider "' + provider + '" (github | gitlab)');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createSmProvider: createSmProvider };
}
