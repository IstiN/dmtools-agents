/**
 * Unit tests for js/ciAnalystContext.js and js/ciAnalystPost.js (ci_analyst leg).
 *
 * Covers: customParams resolution (jobParams vs global), dryRun normalization,
 * context staging + business failure on a missing context, verdict parsing,
 * owner/repo resolution, workflow extraction, title/body/labels assembly,
 * issue-number extraction, and the action() decision table
 * (no verdict / noise / dryRun / duplicate / create+label+assign).
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite(). All dmtools
 * globals (file_read, file_write, github_*) are mocked — no real services.
 */

// ── loader helpers ───────────────────────────────────────────────────────────

function loadContext(mocks) {
    return loadModule('js/ciAnalystContext.js', makeRequire({}), mocks || {});
}

function loadPost(mocks) {
    return loadModule('js/ciAnalystPost.js', makeRequire({}), mocks || {});
}

var VERDICT_OK = '{"adequate": true, "reason": "test_regression", "summary": "s", "suspected_cause": "c"}';
var VERDICT_NOISE = '{"adequate": false, "reason": "stale_red_sha_reset", "summary": "s", "suspected_cause": "c"}';

// ── ciAnalystContext: resolveCustomParams / normalizeDryRun ──────────────────

suite('ciAnalystContext.resolveCustomParams', function() {
    test('reads customParams from jobParams first', function() {
        var mod = loadContext();
        var cp = mod.resolveCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } });
        assert.equal(cp.a, 1);
    });

    test('falls back to params.customParams, then the global', function() {
        var mod = loadContext();
        assert.equal(mod.resolveCustomParams({ customParams: { b: 2 } }).b, 2);
        var withGlobal = loadContext({ customParams: { g: 3 } });
        assert.equal(withGlobal.resolveCustomParams({}).g, 3);
        assert.deepEqual(mod.resolveCustomParams(null), {});
    });
});

suite('ciAnalystContext.normalizeDryRun', function() {
    test('booleans and string flags', function() {
        var mod = loadContext();
        assert.equal(mod.normalizeDryRun(true), true);
        assert.equal(mod.normalizeDryRun('true'), true);
        assert.equal(mod.normalizeDryRun('TRUE'), true);
        assert.equal(mod.normalizeDryRun(false), false);
        assert.equal(mod.normalizeDryRun('false'), false);
        assert.equal(mod.normalizeDryRun(''), false);
        assert.equal(mod.normalizeDryRun(null), false);
        assert.equal(mod.normalizeDryRun(undefined), false);
        assert.equal(mod.normalizeDryRun('yes'), false);
    });
});

suite('ciAnalystContext.action', function() {
    function ctxFileMap() {
        return { 'ctx/test-context.json': '{"monitoredWorkflows":["ci"],"runs":[]}' };
    }

    test('stages context and resolved flags to the fixed input paths', function() {
        var written = {};
        var mod = loadContext({
            file_read: function(opts) {
                var p = opts && (opts.path || opts);
                return ctxFileMap()[p] !== undefined ? ctxFileMap()[p] : null;
            },
            file_write: function(opts) { written[opts.path] = opts.content; }
        });
        var r = mod.action({
            jobParams: { customParams: { contextPath: 'ctx/test-context.json', dryRun: 'true', machineAuthor: 'm', targetRepository: 'o/r' } },
            workingDirectory: '/repo'
        });
        assert.equal(r, true);
        assert.equal(written['input/ci_analyst_context.md'], ctxFileMap()['ctx/test-context.json']);
        var staged = JSON.parse(written['input/ci_analyst_params.json']);
        assert.equal(staged.dryRun, true);
        assert.equal(staged.machineAuthor, 'm');
        assert.equal(staged.targetRepository, 'o/r');
    });

    test('missing contextPath is a business failure', function() {
        var mod = loadContext({ file_read: function() { return null; }, file_write: function() {} });
        var r = mod.action({ jobParams: { customParams: {} } });
        assert.equal(r && r.success, false);
    });

    test('unreadable context file is a business failure', function() {
        var mod = loadContext({ file_read: function() { return null; }, file_write: function() {} });
        var r = mod.action({ jobParams: { customParams: { contextPath: 'nope.json' } } });
        assert.equal(r && r.success, false);
    });

    test('resolves a repo-root-relative path when the bare path misses', function() {
        var written = {};
        var mod = loadContext({
            file_read: function(opts) {
                return opts.path === '/repo/ctx/c.json' ? '{"runs":[]}' : null;
            },
            file_write: function(opts) { written[opts.path] = opts.content; }
        });
        var r = mod.action({
            jobParams: { customParams: { contextPath: 'ctx/c.json' } },
            workingDirectory: '/repo'
        });
        assert.equal(r, true);
        assert.ok(written['input/ci_analyst_context.md']);
    });
});

// ── ciAnalystPost: parsing helpers ───────────────────────────────────────────

suite('ciAnalystPost.parseVerdict', function() {
    test('finds the strict verdict line and records its line number', function() {
        var mod = loadPost();
        var v = mod.parseVerdict('intro\n' + VERDICT_OK + '\ntrailing');
        assert.equal(v.adequate, true);
        assert.equal(v.reason, 'test_regression');
        assert.equal(v.line, 2);
    });

    test('skips near-miss braces and invalid JSON', function() {
        var mod = loadPost();
        assert.equal(mod.parseVerdict('{adequate: true}'), null);
        assert.equal(mod.parseVerdict('{"adequate": broken}'), null);
        assert.equal(mod.parseVerdict('{"summary": "no adequate key"}'), null);
        assert.equal(mod.parseVerdict(''), null);
        assert.equal(mod.parseVerdict(null), null);
    });

    test('adequate must be a real boolean', function() {
        var mod = loadPost();
        assert.equal(mod.parseVerdict('{"adequate": "true"}'), null);
        var v = mod.parseVerdict(VERDICT_NOISE);
        assert.equal(v.adequate, false);
    });
});

suite('ciAnalystPost.resolveOwnerRepo', function() {
    test('splits an owner/repo string', function() {
        var mod = loadPost();
        assert.deepEqual(mod.resolveOwnerRepo('owner/repo'), { owner: 'owner', repo: 'repo' });
    });
    test('accepts an object carrying repository/full_name', function() {
        var mod = loadPost();
        assert.deepEqual(mod.resolveOwnerRepo({ repository: 'o2/r2' }), { owner: 'o2', repo: 'r2' });
        assert.deepEqual(mod.resolveOwnerRepo({ full_name: 'o3/r3' }), { owner: 'o3', repo: 'r3' });
    });
    test('unbound input stays unbound (runtime-configured repo)', function() {
        var mod = loadPost();
        assert.deepEqual(mod.resolveOwnerRepo(''), { owner: null, repo: null });
        assert.deepEqual(mod.resolveOwnerRepo(null), { owner: null, repo: null });
        assert.deepEqual(mod.resolveOwnerRepo({}), { owner: null, repo: null });
    });
});

suite('ciAnalystPost.context + issue assembly', function() {
    var CONTEXT = {
        monitoredWorkflows: ['ci', 'release'],
        runs: [
            { workflow: 'ci', url: 'u1', sha: 'aaa', conclusion: 'failure', logTail: 'FAIL test_x' },
            { workflow: 'ci', url: 'u2', sha: 'bbb', conclusion: 'success' },
            { workflow: 'release', url: 'u3', sha: 'ccc', conclusion: 'failure', logTail: 'boom' }
        ]
    };

    test('parseContext extracts failing runs and the newest sha, tolerates junk', function() {
        var mod = loadPost({ file_read: function(o) { return o.path === 'ctx.json' ? JSON.stringify(CONTEXT) : null; } });
        var c = mod.parseContext('ctx.json');
        assert.equal(c.failingRuns.length, 2);
        assert.equal(c.newestSha, 'aaa');
        assert.deepEqual(c.workflows, ['ci', 'release']);
        var junk = loadPost({ file_read: function() { return 'not json'; } });
        assert.deepEqual(junk.parseContext('x'), { workflows: [], failingRuns: [], newestSha: null });
        assert.deepEqual(mod.parseContext(null), { workflows: [], failingRuns: [], newestSha: null });
    });

    test('affected workflows prefer failing runs over the monitored set', function() {
        var mod = loadPost();
        var c = mod.parseContext('ignored'); // empty
        assert.deepEqual(mod.affectedWorkflows({ workflows: ['ci'], failingRuns: [{ workflow: 'release' }] }, null), ['release']);
        assert.deepEqual(mod.affectedWorkflows(c, null), []);
    });

    test('title, labels and body carry the contract strings', function() {
        var mod = loadPost();
        assert.equal(mod.buildIssueTitle(['ci', 'release']), '[ci-heal] ci,release: failing');
        assert.equal(mod.buildIssueTitle([]), '[ci-heal] ci: failing');
        var labels = mod.buildLabels(['ci', 'release', 'ci']);
        assert.deepEqual(labels, ['ci-heal', 'agent:dev', 'wf:ci', 'wf:release']);
        var body = mod.buildIssueBody(
            { summary: 'sum', suspected_cause: 'cause', reason: 'test_regression' },
            mod.parseContext === undefined ? null : { failingRuns: [{ workflow: 'ci', url: 'u1', sha: 'aaa', logTail: 'FAIL test_x' }] },
            'owner/repo'
        );
        assert.ok(body.indexOf('[ci-heal]') === -1); // title not in body
        assert.ok(body.indexOf('<details><summary>Log excerpt (failed jobs)</summary>') !== -1);
        assert.ok(body.indexOf('FAIL test_x') !== -1);
        assert.ok(body.indexOf('u1') !== -1);
        assert.ok(body.indexOf('`aaa`') !== -1);
    });

    test('truncate cuts long log tails', function() {
        var mod = loadPost();
        var t = mod.truncate(new Array(100).join('x'), 10);
        assert.ok(t.indexOf('(truncated)') !== -1);
    });

    test('issueNumberOf handles REST, normalized and composite-key shapes', function() {
        var mod = loadPost();
        assert.equal(mod.issueNumberOf({ number: 7 }), 7);
        assert.equal(mod.issueNumberOf({ id: '7' }), '7');
        assert.equal(mod.issueNumberOf({ key: 'owner/repo#12' }), 12);
        assert.equal(mod.issueNumberOf({ key: '#13' }), 13);
        assert.equal(mod.issueNumberOf(null), null);
        assert.equal(mod.issueUrlOf({ html_url: 'h' }), 'h');
        assert.equal(mod.issueUrlOf({ url: 'u' }), 'u');
        assert.equal(mod.issueUrlOf({}), null);
    });
});

// ── ciAnalystPost.action decision table ──────────────────────────────────────

suite('ciAnalystPost.action', function() {
    function postModule(opts) {
        var calls = [];
        var fileMap = opts && opts.files ? opts.files : {};
        var mocks = {
            file_read: function(o) {
                var p = o && (o.path || o);
                return fileMap[p] !== undefined ? fileMap[p] : null;
            },
            file_write: function(o) { calls.push({ tool: 'file_write', args: o }); }
        };
        ['github_search_issues', 'github_create_issue', 'github_add_labels', 'github_assign_issue'].forEach(function(name) {
            mocks[name] = function(args) { calls.push({ tool: name, args: args }); };
        });
        if (opts && opts.dropSearch) delete mocks.github_search_issues;
        return { mod: loadPost(mocks), calls: calls };
    }

    function baseFiles() {
        return {
            'input/ci_analyst_context.md': JSON.stringify({
                monitoredWorkflows: ['ci'],
                runs: [{ workflow: 'ci', url: 'u1', sha: 'aaa', conclusion: 'failure', logTail: 'FAIL t' }]
            })
        };
    }

    function responseOf(verdictLine) {
        return 'prefix noise\n' + verdictLine + '\n## Explanation\nbody';
    }

    function runAction(m, opts) {
        return m.mod.action({
            jobParams: {
                response: responseOf(opts.verdictLine),
                customParams: {
                    contextPath: 'input/ci_analyst_context.md',
                    dryRun: opts.dryRun,
                    machineAuthor: opts.machineAuthor,
                    targetRepository: 'owner/repo'
                }
            }
        });
    }

    function writtenResult(calls) {
        for (var i = calls.length - 1; i >= 0; i--) {
            if (calls[i].tool === 'file_write' && calls[i].args.path === 'outputs/ci_analyst_result.json') {
                return JSON.parse(calls[i].args.content);
            }
        }
        return null;
    }

    test('no verdict line: record + no GitHub call', function() {
        var m = postModule({ files: baseFiles() });
        assert.equal(runAction(m, { verdictLine: 'no json here', dryRun: false }), true);
        var result = writtenResult(m.calls);
        assert.equal(result.verdictParsed, false);
        assert.equal(result.issueCreated, false);
        assert.equal(m.calls.filter(function(c) { return c.tool.indexOf('github_') === 0; }).length, 0);
    });

    test('noise verdict: no issue, no GitHub mutation', function() {
        var m = postModule({ files: baseFiles() });
        runAction(m, { verdictLine: VERDICT_NOISE, dryRun: false });
        var result = writtenResult(m.calls);
        assert.equal(result.adequate, false);
        assert.equal(result.issueCreated, false);
        assert.equal(m.calls.filter(function(c) { return c.tool.indexOf('github_') === 0; }).length, 0);
    });

    test('dryRun adequate verdict: recorded, no issue', function() {
        var m = postModule({ files: baseFiles() });
        runAction(m, { verdictLine: VERDICT_OK, dryRun: 'true', machineAuthor: 'm' });
        var result = writtenResult(m.calls);
        assert.equal(result.dryRun, true);
        assert.equal(result.adequate, true);
        assert.equal(result.issueCreated, false);
        assert.equal(m.calls.filter(function(c) { return c.tool.indexOf('github_') === 0; }).length, 0);
    });

    test('adequate + not dryRun: ONE issue, labels, assignee', function() {
        var m = postModule({ files: baseFiles() });
        m.calls.length = 0;
        var post = loadPost({
            file_read: function(o) { return baseFiles()[o.path || o] !== undefined ? baseFiles()[o.path || o] : null; },
            file_write: function(o) { m.calls.push({ tool: 'file_write', args: o }); },
            github_search_issues: function(args) { m.calls.push({ tool: 'github_search_issues', args: args }); return { items: [] }; },
            github_create_issue: function(args) { m.calls.push({ tool: 'github_create_issue', args: args }); return { number: 42, html_url: 'https://example/42' }; },
            github_add_labels: function(args) { m.calls.push({ tool: 'github_add_labels', args: args }); return {}; },
            github_assign_issue: function(args) { m.calls.push({ tool: 'github_assign_issue', args: args }); return {}; }
        });
        post.action({
            jobParams: {
                response: responseOf(VERDICT_OK),
                customParams: { contextPath: 'input/ci_analyst_context.md', dryRun: false, machineAuthor: 'machine-user', targetRepository: 'owner/repo' }
            }
        });
        var search = m.calls.filter(function(c) { return c.tool === 'github_search_issues'; });
        assert.equal(search.length, 1);
        assert.ok(search[0].args.query.indexOf('label:ci-heal') !== -1);
        var create = m.calls.filter(function(c) { return c.tool === 'github_create_issue'; });
        assert.equal(create.length, 1);
        assert.equal(create[0].args.title, '[ci-heal] ci: failing');
        assert.equal(create[0].args.owner, 'owner');
        assert.equal(create[0].args.repo, 'repo');
        var labels = m.calls.filter(function(c) { return c.tool === 'github_add_labels'; });
        assert.equal(labels.length, 1);
        assert.equal(labels[0].args.number, 42);
        assert.deepEqual(labels[0].args.labels, ['ci-heal', 'agent:dev', 'wf:ci']);
        var assign = m.calls.filter(function(c) { return c.tool === 'github_assign_issue'; });
        assert.equal(assign.length, 1);
        assert.equal(assign[0].args.user, 'machine-user');
        var result = writtenResult(m.calls);
        assert.equal(result.issueCreated, true);
        assert.equal(result.issueNumber, 42);
        assert.equal(result.assignedTo, 'machine-user');
        assert.equal(result.duplicate, false);
    });

    test('open duplicate with the same title: skip creation', function() {
        var m = postModule({ files: baseFiles() });
        var post = loadPost({
            file_read: function(o) { return baseFiles()[o.path || o] !== undefined ? baseFiles()[o.path || o] : null; },
            file_write: function(o) { m.calls.push({ tool: 'file_write', args: o }); },
            github_search_issues: function() { m.calls.push({ tool: 'github_search_issues', args: {} }); return { items: [{ number: 9, title: '[ci-heal] ci: failing', html_url: 'https://example/9' }] }; }
        });
        var r = post.action({
            jobParams: {
                response: responseOf(VERDICT_OK),
                customParams: { contextPath: 'input/ci_analyst_context.md', dryRun: false, machineAuthor: 'm', targetRepository: 'owner/repo' }
            }
        });
        assert.equal(r, true);
        var creates = m.calls.filter(function(c) { return c.tool === 'github_create_issue'; });
        assert.equal(creates.length, 0);
        var result = writtenResult(m.calls);
        assert.equal(result.duplicate, true);
        assert.equal(result.issueUrl, 'https://example/9');
    });

    test('search results without items stay safe (different title shapes)', function() {
        var m = postModule({ files: baseFiles() });
        var post = loadPost({
            file_read: function(o) { return baseFiles()[o.path || o] !== undefined ? baseFiles()[o.path || o] : null; },
            file_write: function(o) { m.calls.push({ tool: 'file_write', args: o }); },
            github_search_issues: function() { return { items: [{ number: 3, title: 'something else entirely' }] }; },
            github_create_issue: function(args) { m.calls.push({ tool: 'github_create_issue', args: args }); return { key: 'owner/repo#5' }; },
            github_add_labels: function() {},
            github_assign_issue: function() {}
        });
        post.action({
            jobParams: {
                response: responseOf(VERDICT_OK),
                customParams: { contextPath: 'input/ci_analyst_context.md', dryRun: false, machineAuthor: '', targetRepository: '' }
            }
        });
        var creates = m.calls.filter(function(c) { return c.tool === 'github_create_issue'; });
        assert.equal(creates.length, 1);
        assert.equal(creates[0].args.owner, undefined); // unbound target: runtime-configured repo
        var result = writtenResult(m.calls);
        assert.equal(result.issueNumber, 5);
        assert.equal(result.assignedTo, undefined);
    });

    test('missing search tool: dedupe degrades to create', function() {
        var post = loadPost({
            file_read: function(o) { return baseFiles()[o.path || o] !== undefined ? baseFiles()[o.path || o] : null; },
            file_write: function() {},
            github_create_issue: function() { return { number: 1 }; }
        });
        // no github_search_issues global at all
        var r = post.action({
            jobParams: {
                response: responseOf(VERDICT_OK),
                customParams: { contextPath: 'input/ci_analyst_context.md', dryRun: false, machineAuthor: '', targetRepository: 'o/r' }
            }
        });
        assert.equal(r, true);
    });
});
