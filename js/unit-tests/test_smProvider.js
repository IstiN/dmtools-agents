/**
 * Unit tests: smProvider.js — the forge-agnostic I/O layer of the machine
 * watchdog. GitHub maps to github_* tools (gh CLI only for update-branch),
 * GitLab maps to gitlab_* tools natively. Both must satisfy the same
 * contract the decision core consumes.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('smProvider', function () {

    var MOD = 'js/common/smProvider.js';

    function loadProvider(provider, mocks) {
        var mod = loadModule(MOD, makeRequire({}, mocks || {}), mocks || {});
        return mod.createSmProvider({
            scm: { provider: provider },
            repository: { owner: 'mygroup', repo: 'my-repo' }
        });
    }

    // ── shared contract ──────────────────────────────────────────────────────

    test('unknown provider is rejected loudly', function () {
        var mod = loadModule(MOD, makeRequire({}, {}), {});
        var threw = false;
        try {
            mod.createSmProvider({ scm: { provider: 'bitbucket' },
                repository: { owner: 'a', repo: 'b' } });
        } catch (e) { threw = true; }
        assert.equal(threw, true);
    });

    test('missing repository is rejected loudly', function () {
        var mod = loadModule(MOD, makeRequire({}, {}), {});
        var threw = false;
        try { mod.createSmProvider({ scm: { provider: 'github' } }); }
        catch (e) { threw = true; }
        assert.equal(threw, true);
    });

    // ── github provider ──────────────────────────────────────────────────────

    test('github: listMachineIssues ORs per-label searches, dedupes, adds assignee matches', function () {
        var queries = [];
        var p = loadProvider('github', {
            github_search_issues: function (args) {
                queries.push(args.query);
                if (args.query.indexOf('assignee:') !== -1) {
                    return { items: [{ number: 6, title: 'A', labels: [], assignees: [{ login: 'ai-teammate' }] }] };
                }
                if (args.query.indexOf('agent:dev') !== -1) {
                    return { items: [{ number: 5, title: 'T', labels: [{ name: 'agent:dev' }], assignees: [] }] };
                }
                return { items: [] };
            }
        });
        var issues = p.listMachineIssues(['agent:dev', 'agent:rework'], 'ai-teammate', 50);
        assert.equal(issues.length, 2);          // one per label + one assignee, no dupes
        assert.equal(issues[0].number, 5);
        assert.equal(issues[1].number, 6);
        assert.equal(issues[1].assignees[0], 'ai-teammate');
        // per-label queries (OR semantics — GitHub ANDs multi-label queries)
        assert.equal(queries.some(function (q) { return q.indexOf('label:"agent:dev"') !== -1; }), true);
        assert.equal(queries.some(function (q) { return q.indexOf('label:"agent:rework"') !== -1; }), true);
    });

    test('github: prStatus rolls up red/pending/green', function () {
        var rollup;
        var p = loadProvider('github', {
            github_get_pr: function () {
                return { state: 'OPEN', mergeable: true, mergeStateStatus: 'CLEAN',
                         statusCheckRollup: rollup };
            }
        });
        rollup = [{ conclusion: 'FAILURE' }];
        assert.equal(p.prStatus(7).checkConclusion, 'red');
        rollup = [{ status: 'IN_PROGRESS' }];
        assert.equal(p.prStatus(7).checkConclusion, 'pending');
        rollup = [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }];
        var st = p.prStatus(7);
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.mergeState, 'CLEAN');
        assert.equal(st.mergeable, true);
    });

    test('github: prStatus uses pullRequestId + REST check-runs rollup (live shape)', function () {
        // Live bug: `number` hit /pulls/null (404) and statusCheckRollup is
        // GraphQL-only — guards saw UNKNOWN/none forever. The REST path is
        // github_get_pr(pullRequestId) + github_get_commit_check_runs(head.sha).
        var prBody, checkBody;
        var p = loadProvider('github', {
            github_get_pr: function (args) {
                prBody.args = args;
                return prBody;
            },
            github_get_commit_check_runs: function (args) {
                checkBody.args = args;
                return checkBody;
            }
        });
        prBody = { state: 'OPEN', mergeable: true, mergeable_state: 'behind',
                   head: { sha: 'abc123' } };
        checkBody = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] };
        var st = p.prStatus(7);
        assert.equal(prBody.args.pullRequestId, 7);
        assert.equal(prBody.args.number, undefined);
        assert.equal(checkBody.args.commitSha, 'abc123');
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.mergeState, 'BEHIND');

        checkBody = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'failure' }] };
        assert.equal(p.prStatus(7).checkConclusion, 'red');

        checkBody = { total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] };
        assert.equal(p.prStatus(7).checkConclusion, 'pending');

        // check-runs API shape: sha field name on head is `sha`.
        prBody = { state: 'OPEN', mergeable: true, head: { sha: 'zzz' } };
        checkBody = { total_count: 0, check_runs: [] };
        assert.equal(p.prStatus(7).checkConclusion, 'none');
    });

    test('github: prStatus maps the REST mergeable_state (live github_get_pr shape)', function () {
        // Live bug: the REST body carries mergeable_state (lowercase), not
        // the GraphQL mergeStateStatus — the old fallback read mergeable===
        // true and reported BEHIND PRs as CLEAN, so silent-update-behind
        // never matched (live: 5 PRs sat behind, tick processed 0).
        var shape = { state: 'OPEN', mergeable: true, statusCheckRollup: [] };
        var p = loadProvider('github', {
            github_get_pr: function () {
                // mergeStateStatus deliberately ABSENT — REST shape.
                return Object.assign({}, shape, { mergeable_state: currentRest });
            }
        });
        var currentRest = 'behind';
        assert.equal(p.prStatus(7).mergeState, 'BEHIND');
        currentRest = 'dirty';
        assert.equal(p.prStatus(7).mergeState, 'DIRTY');
        currentRest = 'blocked';
        assert.equal(p.prStatus(7).mergeState, 'BLOCKED');
        currentRest = 'unknown';
        assert.equal(p.prStatus(7).mergeState, 'UNKNOWN');
        // Neither field present: coarse bool fallback stays.
        var fb = loadProvider('github', {
            github_get_pr: function () {
                return { state: 'OPEN', mergeable: true, statusCheckRollup: [] };
            }
        });
        assert.equal(fb.prStatus(7).mergeState, 'CLEAN');
    });

    test('github: activeMachineRuns parses gh-N from in-progress run titles', function () {
        var statuses = [];
        var p = loadProvider('github', {
            github_list_workflow_runs: function (args) {
                statuses.push(args.status);
                return { workflow_runs: [
                    { display_title: '🔧 rework · gh-125: Machine comments on GitHub' }
                ] };
            }
        });
        var active = p.activeMachineRuns('ai-teammate.yml');
        assert.equal(active[0], 125);
        assert.equal(statuses.indexOf('in_progress') !== -1, true);
        assert.equal(statuses.indexOf('queued') !== -1, true);
    });

    test('github: dispatchLeg posts workflow inputs; merge is squash', function () {
        var dispatched = null, merged = null;
        var p = loadProvider('github', {
            github_trigger_workflow: function (args) { dispatched = args; return {}; },
            github_merge_pr: function (args) { merged = args; return {}; }
        });
        p.dispatchLeg(42, 'rework', 'CI red', 'ai-teammate.yml');
        assert.equal(dispatched.workflowId, 'ai-teammate.yml');
        var inputs = JSON.parse(dispatched.inputs);
        assert.equal(inputs.issue, '42');
        assert.equal(inputs.leg, 'rework');
        p.merge(42);
        assert.equal(merged.mergeMethod, 'squash');
        assert.equal(merged.number, 42);
    });

    test('github: updateBranch falls back to the gh CLI', function () {
        var cmd = null;
        var p = loadProvider('github', {
            cli_execute_command: function (args) { cmd = args.command; return ''; }
        });
        p.updateBranch(9);
        assert.equal(cmd.indexOf('gh pr update-branch 9') !== -1, true);
    });

    // ── gitlab provider ──────────────────────────────────────────────────────

    test('gitlab: listMachineIssues filters by label OR assignee client-side', function () {
        var p = loadProvider('gitlab', {
            gitlab_list_issues: function () {
                return [
                    { iid: 1, title: 'a', labels: ['agent:dev'], assignees: [] },
                    { iid: 2, title: 'b', labels: [], assignees: [{ username: 'ai-teammate' }] },
                    { iid: 3, title: 'c', labels: ['wontfix'], assignees: [] }
                ];
            }
        });
        var issues = p.listMachineIssues(['agent:dev'], 'ai-teammate', 50);
        assert.equal(issues.length, 2);
        assert.equal(issues[0].number, 1);
        assert.equal(issues[1].number, 2);
    });

    test('gitlab: findPr matches source branch or description reference', function () {
        var p = loadProvider('gitlab', {
            gitlab_list_mrs: function (args) {
                if (args.state === 'opened') {
                    return [
                        { iid: 11, source_branch: 'ai/gh-5', description: '' },
                        { iid: 12, source_branch: 'other', description: 'Closes #5 tracked' }
                    ];
                }
                return [];
            }
        });
        var pr = p.findPr(5, 'ai/gh-');
        assert.equal(pr.number, 11);
        assert.equal(pr.state, 'OPEN');
    });

    test('gitlab: prStatus maps pipeline failures and conflicts', function () {
        var p = loadProvider('gitlab', {
            gitlab_get_mr: function () { return { state: 'opened', merge_status: 'can_be_merged', has_conflicts: false }; },
            gitlab_get_mr_pipelines: function () { return [{ status: 'failed' }, { status: 'success' }]; }
        });
        assert.equal(p.prStatus(11).checkConclusion, 'red');

        var p2 = loadProvider('gitlab', {
            gitlab_get_mr: function () { return { state: 'opened', merge_status: 'cannot_be_merged', has_conflicts: true }; },
            gitlab_get_mr_pipelines: function () { return [{ status: 'success' }]; }
        });
        var st = p2.prStatus(11);
        assert.equal(st.checkConclusion, 'green');
        assert.equal(st.mergeState, 'BEHIND');   // conflicts ⇒ rebase path
        assert.equal(st.mergeable, false);
    });

    test('gitlab: activeMachineRuns is conservative on API pipelines', function () {
        var p = loadProvider('gitlab', {
            gitlab_list_pipeline_runs: function () {
                return [{ source: 'push' }, { source: 'api' }];
            }
        });
        assert.equal(p.activeMachineRuns()[0], 'unknown');

        var p2 = loadProvider('gitlab', {
            gitlab_list_pipeline_runs: function () { return [{ source: 'push' }]; }
        });
        assert.equal(p2.activeMachineRuns().length, 0);
    });

    test('gitlab: dispatchLeg sends issue/leg variables; updateBranch rebases', function () {
        var trig = null, rebased = null;
        var p = loadProvider('gitlab', {
            gitlab_trigger_pipeline: function (args) { trig = args; return {}; },
            gitlab_rebase_mr: function (args) { rebased = args; return {}; }
        });
        p.dispatchLeg(7, 'review', 'green', 'ai-teammate.yml');
        // Canonical tool contract (Java + Dart): workspace/repository scoping,
        // variablesJson as a JSON string, pullRequestId as the MR id.
        assert.equal(trig.workspace, 'mygroup');
        assert.equal(trig.repository, 'my-repo');
        assert.equal(trig.ref, 'main');
        var vars = JSON.parse(trig.variablesJson);
        assert.equal(vars.issue, '7');
        assert.equal(vars.leg, 'review');
        p.updateBranch(7);
        assert.equal(rebased.workspace, 'mygroup');
        assert.equal(rebased.repository, 'my-repo');
        assert.equal(rebased.pullRequestId, '7');
    });

    test('gitlab: closeIssue warns and stays non-fatal (documented gap)', function () {
        var p = loadProvider('gitlab', {
            gitlab_create_mr_note: function () { return {}; }
        });
        var res = p.closeIssue(7, 'bye');   // must not throw
        assert.equal(res, null);
    });
});
