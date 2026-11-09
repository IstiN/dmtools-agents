/**
 * Unit tests: GitLab SM rules (`source: 'gitlab'`) — the resolver entry and
 * the forge-portable state source (js/sm/sources/githubSource.js) driven
 * end-to-end against the REAL GitLab SM provider (js/common/smProvider.js)
 * with gitlab_* bridge mocks. Every github_* tool throws: a GitLab tick
 * must never fall through to a GitHub tool.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('sm gitlab source', function () {

    var REPO = { owner: 'acme', repo: 'widgets' };

    function githubTrap(name) {
        return function () { throw new Error('GitHub tool ' + name + ' called on a GitLab rule'); };
    }

    var ISSUES = [
        { iid: 5, title: 'five', labels: ['agent:review'], assignees: [] },
        { iid: 6, title: 'six', labels: ['agent:review', 'agent:rework'], assignees: [] },
        { iid: 7, title: 'seven', labels: [], assignees: [{ username: 'bot' }] }
    ];

    var MRS = [
        { iid: 11, title: 'MR for #5', description: 'Closes #5', source_branch: 'ai/gh-5',
          labels: ['agent:review'], author: { username: 'bot' }, draft: false, sha: 'aaa',
          source_project_id: 1, target_project_id: 1 },
        { iid: 12, title: 'guest', description: '', source_branch: 'feature/x',
          labels: [], author: { username: 'guest' }, draft: false, sha: 'bbb',
          source_project_id: 2, target_project_id: 1 }
    ];

    function gitlabTools(counters) {
        return {
            gitlab_list_issues: function () {
                counters.issues++;
                return JSON.stringify(ISSUES);
            },
            gitlab_list_mrs: function (a) {
                counters.mrs++;
                return JSON.stringify(a.state === 'opened' ? MRS : []);
            },
            gitlab_get_mr: function (a) {
                var mr = MRS.filter(function (m) { return String(m.iid) === String(a.pullRequestId); })[0];
                var out = {};
                Object.keys(mr).forEach(function (k) { out[k] = mr[k]; });
                out.state = 'opened';
                out.merge_status = 'can_be_merged';
                out.has_conflicts = false;
                return JSON.stringify(out);
            },
            gitlab_get_mr_pipelines: function () { return JSON.stringify([{ status: 'success' }]); },
            github_search_issues: githubTrap('github_search_issues'),
            github_list_prs: githubTrap('github_list_prs'),
            github_get_issue: githubTrap('github_get_issue'),
            github_get_pr: githubTrap('github_get_pr')
        };
    }

    // Real resolver + source + smAsync + smProvider; createSmProvider is
    // wrapped only to record which forge each (main or worker) call built.
    function load(counters, providerConfigs) {
        var tools = gitlabTools(counters);
        var machineAuthorMod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
        var realProvider = loadModule('js/common/smProvider.js', makeRequire({
            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': machineAuthorMod }), {}),
            './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {}),
            './mergeStateReconcile.js': loadModule('js/common/mergeStateReconcile.js', makeRequire({}), {})
        }), tools);
        var providerMod = {
            createSmProvider: function (cfg) {
                providerConfigs.push(cfg.scm.provider);
                return realProvider.createSmProvider(cfg);
            },
            ioCacheDrop: realProvider.ioCacheDrop,
            ghPrHeadRepoFull: realProvider.ghPrHeadRepoFull,
            ghPrMaintainerCanModify: realProvider.ghPrMaintainerCanModify
        };
        var smAsyncMod = loadModule('js/common/smAsync.js', makeRequire({
            './common/smProvider.js': providerMod
        }), tools);
        var guestTransplantMod = loadModule('js/common/guestTransplant.js', makeRequire({
            './machineAuthor.js': machineAuthorMod
        }), {});
        var source = loadModule('js/sm/sources/githubSource.js', makeRequire({
            '../../common/smProvider.js': providerMod,
            '../../common/machineAuthor.js': machineAuthorMod,
            '../../common/smAsync.js': smAsyncMod,
            '../../common/mutexRegistry.js': loadModule('js/common/mutexRegistry.js', makeRequire({}), {}),
            '../../common/guestTransplant.js': guestTransplantMod
        }), tools);
        var resolver = loadModule('js/sm/sourceResolver.js', makeRequire({
            './sources/jiraSource.js': { query: function () { return []; } },
            './sources/githubSource.js': source
        }), {});
        return { resolver: resolver, source: source };
    }

    function fresh() {
        var ctx = { counters: { issues: 0, mrs: 0 }, providerConfigs: [] };
        var mods = load(ctx.counters, ctx.providerConfigs);
        ctx.resolver = mods.resolver;
        ctx.source = mods.source;
        ctx.query = function (rule, extra) {
            var mod = ctx.resolver.resolve(rule);
            var qctx = { repoInfo: REPO, config: {}, machineAuthor: 'bot' };
            Object.keys(extra || {}).forEach(function (k) { qctx[k] = extra[k]; });
            return mod.query(rule, qctx);
        };
        return ctx;
    }

    test('resolver: source "gitlab" resolves to the forge-portable state source', function () {
        var t = fresh();
        assert.equal(t.resolver.resolve({ source: 'gitlab' }), t.source);
        assert.ok(t.resolver.SOURCES.gitlab, 'gitlab is a registered source');
    });

    test('issue rule (review-on-issue-label): label scan, MR enrichment, prState OPEN guard', function () {
        var t = fresh();
        var items = t.query({
            source: 'gitlab',
            query: { type: 'issue', labels: ['agent:review'], notLabels: ['agent:rework'],
                     notPrLabels: ['agent:review', 'pr_approved'], prState: 'OPEN', draft: false }
        });
        assert.deepEqual(items.map(function (i) { return i.key; }), ['gh-5']);
        assert.equal(items[0].prNumber, 11);
        assert.equal(items[0].pr.state, 'OPEN');
        assert.equal(items[0].branch, 'ai/gh-5');
        assert.ok(t.providerConfigs.length > 0, 'providers were built');
        t.providerConfigs.forEach(function (p) {
            assert.equal(p, 'gitlab', 'main + worker providers are gitlab (args.scmProvider)');
        });
    });

    test('issue rule: lowercase prState "open" never matches (the dead-rule shape)', function () {
        var t = fresh();
        var items = t.query({
            source: 'gitlab',
            query: { type: 'issue', labels: ['agent:review'], notLabels: ['agent:rework'], prState: 'open' }
        });
        assert.equal(items.length, 0);
    });

    test('pr rule (review-on-label): MR list via the provider, never github_list_prs', function () {
        var t = fresh();
        var items = t.query({ source: 'gitlab', query: { type: 'pr', labels: ['agent:review'] } });
        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-11']);
        assert.equal(items[0].issueNumber, 5, 'linked issue from the "Closes #5" description');
        assert.equal(items[0].author, 'bot');
        assert.equal(items[0].headRepo, 'acme/widgets');
    });

    test('pr rule (review-external-once): green non-machine MR, fork head stays non-cross-repo', function () {
        var t = fresh();
        var items = t.query({
            source: 'gitlab',
            query: { type: 'pr', notLabels: ['ai_pr_reviewed', 'agent:review', 'pr_approved'],
                     checks: 'green', draft: false, notMachine: true }
        });
        assert.deepEqual(items.map(function (i) { return i.key; }), ['pr-12']);
        assert.equal(items[0].pr.checkConclusion, 'green');
        assert.equal(items[0].headRepo, null, 'fork MR head path is unresolvable');
    });

    test('assignee rule (dev-on-assignment): {machineAuthor} scan over the cached issue page', function () {
        var t = fresh();
        var items = t.query({
            source: 'gitlab',
            query: { type: 'issue', assignee: '{machineAuthor}', noOpenPr: true,
                     notLabels: ['ai_developed', 'agent:rework'] }
        });
        assert.deepEqual(items.map(function (i) { return i.key; }), ['gh-7']);
    });

    test('one gitlab_list_issues per tick across rules (ioCache)', function () {
        var t = fresh();
        t.query({ source: 'gitlab', query: { type: 'issue', labels: ['agent:review'] } });
        t.query({ source: 'gitlab', query: { type: 'issue', assignee: '{machineAuthor}' } });
        assert.equal(t.counters.issues, 1);
    });

    test('ctx.scmProvider wins over the rule source', function () {
        var t = fresh();
        t.query({ source: 'gitlab', query: { type: 'pr', labels: ['agent:review'] } },
            { scmProvider: 'gitlab' });
        assert.deepEqual(t.providerConfigs, ['gitlab']);
    });
});

suite('sm_gitlab.json — shipped GitLab rule pack', function () {

    var cfg = JSON.parse(file_read({ path: 'sm_gitlab.json' }));
    var jp = cfg.params.jobParams;
    var DISPATCH_ONLY = ['rework-on-red-ci', 'rework-on-label', 'dev-on-assignment',
        'review-after-dev', 'review-external-once', 'review-machine-unlinked',
        'review-on-label', 'review-on-issue-label'];

    test('runs on js/smAgent.js with the GitLab forge knob it reads', function () {
        assert.equal(cfg.params.jsPath, 'js/smAgent.js');
        assert.deepEqual(jp.scm, { provider: 'gitlab' });
    });

    test('guest transplant is explicitly disabled (an empty object would arm the defaults)', function () {
        assert.equal(jp.smGuestTransplant.enabled, false);
    });

    test('every rule is gitlab-sourced and points at its sm_github.json twin', function () {
        jp.rules.forEach(function (r) {
            assert.equal(r.source, 'gitlab', r.id);
            assert.contains(r.description, "sm_github.json rule '" + r.id + "'");
        });
    });

    test('only dispatch-only rules are enabled; localAction rules are gated with a reason', function () {
        var enabled = [];
        jp.rules.forEach(function (r) {
            if (r.localAction) {
                assert.equal(r.enabled, false, r.id + ' must be gated');
                assert.contains(r.description, 'Disabled on GitLab:');
            } else if (r.enabled !== false) {
                enabled.push(r.id);
            }
        });
        assert.deepEqual(enabled.sort(), DISPATCH_ONLY.slice().sort());
    });

    test('prState guards use the uppercase provider vocabulary (both packs)', function () {
        ['sm_gitlab.json', 'sm_github.json'].forEach(function (f) {
            var rules = JSON.parse(file_read({ path: f })).params.jobParams.rules;
            rules.forEach(function (r) {
                var st = r.query && r.query.prState;
                if (st) assert.equal(st, st.toUpperCase(), f + ' ' + r.id);
            });
        });
    });
});
