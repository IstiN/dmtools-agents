/**
 * Unit tests for js/ciAnalystContext.js and js/ciAnalystPost.js (ci_analyst leg,
 * self-heal state machine v2.3).
 *
 * Covers: customParams resolution (jobParams vs global), dryRun normalization,
 * context staging (previousIncidents passes through VERBATIM) + business failure
 * on a missing context, verdict parsing (v2.3 verdict/classification schema +
 * legacy adequate fallback), owner/repo resolution, workflow extraction,
 * title/body/labels assembly (work list, follow-up lines, escalation paragraph,
 * Closes fix protocol), issue-number extraction, and the v2.3 action() routing
 * matrix:
 *   adequate + machineAuthor  -> create + label + ASSIGN (arming act)
 *   adequate + empty ma       -> LOUD business failure BEFORE any GitHub call
 *   needs-human               -> unassigned issue + needs-human/agent:skip labels
 *   noise                     -> zero GitHub calls
 *   no-reopen guarantee       -> no reopen/update-issue API is ever called.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite(). All dmtools
 * globals (file_read, file_write, github_*) are mocked — no real services.
 * .dmtools/config discovery is blocked: every loadModule passes makeRequire({})
 * and no config globals.
 */

// ── loader helpers ───────────────────────────────────────────────────────────

function loadContext(mocks) {
    return loadModule('js/ciAnalystContext.js', makeRequire({}), mocks || {});
}

function loadPost(mocks) {
    return loadModule('js/ciAnalystPost.js', makeRequire({}), mocks || {});
}

var VERDICT_OK = '{"verdict": "adequate", "classification": "test_regression", "reason": "test_regression", "summary": "s", "suspected_cause": "c"}';
var VERDICT_NEEDS_HUMAN = '{"verdict": "needs-human", "classification": "workflow_infra", "reason": "workflow_infra", "summary": "s", "suspected_cause": "c"}';
var VERDICT_NOISE = '{"verdict": "noise", "classification": "stale_red_sha_reset", "reason": "stale_red_sha_reset", "summary": "s", "suspected_cause": "c"}';
var VERDICT_LEGACY_OK = '{"adequate": true, "reason": "test_regression", "summary": "s", "suspected_cause": "c"}';
var VERDICT_LEGACY_NOISE = '{"adequate": false, "reason": "stale_red_sha_reset", "summary": "s", "suspected_cause": "c"}';

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

    test('previousIncidents and unknown fields pass through VERBATIM (byte-identical staging)', function() {
        var source = JSON.stringify({
            targetRepository: 'o/r',
            machineAuthor: 'm',
            monitoredWorkflows: ['ci'],
            runs: [{ workflow: 'ci', url: 'u', sha: 'aaa', conclusion: 'failure', logTail: 'x' }],
            previousIncidents: [
                { issue: 12, title: '[ci-heal] ci: failing', closedAt: '2026-11-24T10:00:00Z', closedByCommit: 'abc1234def5678' }
            ],
            someUnknownFutureField: { nested: [1, 2, 3] }
        });
        var written = {};
        var mod = loadContext({
            file_read: function(o) { return o.path === 'ctx/pi.json' ? source : null; },
            file_write: function(o) { written[o.path] = o.content; }
        });
        var r = mod.action({
            jobParams: { customParams: { contextPath: 'ctx/pi.json', dryRun: false, machineAuthor: 'm', targetRepository: 'o/r' } },
            workingDirectory: '/repo'
        });
        assert.equal(r, true);
        // the staged context is the source file byte-for-byte — nothing strips previousIncidents
        assert.equal(written['input/ci_analyst_context.md'], source);
        assert.ok(written['input/ci_analyst_context.md'].indexOf('previousIncidents') !== -1);
        assert.deepEqual(JSON.parse(written['input/ci_analyst_context.md']).previousIncidents,
            [{ issue: 12, title: '[ci-heal] ci: failing', closedAt: '2026-11-24T10:00:00Z', closedByCommit: 'abc1234def5678' }]);
        // launch params stay flag-shaped: previousIncidents is NOT duplicated into them
        var stagedParams = JSON.parse(written['input/ci_analyst_params.json']);
        assert.equal(stagedParams.previousIncidents, undefined);
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
    test('finds the strict v2.3 verdict line and records its line number', function() {
        var mod = loadPost();
        var v = mod.parseVerdict('intro\n' + VERDICT_OK + '\ntrailing');
        assert.equal(v.verdict, 'adequate');
        assert.equal(v.classification, 'test_regression');
        assert.equal(v.adequate, true);
        assert.equal(v.reason, 'test_regression');
        assert.equal(v.line, 2);
    });

    test('routes all three v2.3 classes', function() {
        var mod = loadPost();
        assert.equal(mod.parseVerdict(VERDICT_OK).verdict, 'adequate');
        assert.equal(mod.parseVerdict(VERDICT_NEEDS_HUMAN).verdict, 'needs-human');
        assert.equal(mod.parseVerdict(VERDICT_NEEDS_HUMAN).classification, 'workflow_infra');
        assert.equal(mod.parseVerdict(VERDICT_NOISE).verdict, 'noise');
        assert.equal(mod.parseVerdict(VERDICT_NOISE).adequate, false);
    });

    test('legacy adequate boolean lines still parse (v0.0.1 fallback)', function() {
        var mod = loadPost();
        assert.equal(mod.parseVerdict(VERDICT_LEGACY_OK).verdict, 'adequate');
        assert.equal(mod.parseVerdict(VERDICT_LEGACY_OK).adequate, true);
        assert.equal(mod.parseVerdict(VERDICT_LEGACY_NOISE).verdict, 'noise');
        assert.equal(mod.parseVerdict(VERDICT_LEGACY_NOISE).adequate, false);
    });

    test('unknown verdict values and non-string booleans are rejected', function() {
        var mod = loadPost();
        assert.equal(mod.parseVerdict('{"verdict": "maybe", "summary": "s"}'), null);
        assert.equal(mod.parseVerdict('{"verdict": "ADEQUATE"}'), null); // strict: exact lowercase only
        assert.equal(mod.parseVerdict('{"adequate": "true"}'), null);
        assert.equal(mod.parseVerdict('{adequate: true}'), null);
        assert.equal(mod.parseVerdict('{"verdict": broken}'), null);
        assert.equal(mod.parseVerdict('{"summary": "no routing key"}'), null);
        assert.equal(mod.parseVerdict(''), null);
        assert.equal(mod.parseVerdict(null), null);
    });

    test('resolveVerdictClass maps parsed objects directly', function() {
        var mod = loadPost();
        assert.equal(mod.resolveVerdictClass({ verdict: 'needs-human' }), 'needs-human');
        assert.equal(mod.resolveVerdictClass({ adequate: false }), 'noise');
        assert.equal(mod.resolveVerdictClass({ verdict: 'zzz' }), null);
        assert.equal(mod.resolveVerdictClass('noise'), null);
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
        assert.deepEqual(c.previousIncidents, []);
        var junk = loadPost({ file_read: function() { return 'not json'; } });
        assert.deepEqual(junk.parseContext('x'), { workflows: [], failingRuns: [], newestSha: null, previousIncidents: [] });
        assert.deepEqual(mod.parseContext(null), { workflows: [], failingRuns: [], newestSha: null, previousIncidents: [] });
    });

    test('parseContext passes previousIncidents through verbatim', function() {
        var incidents = [{ issue: 12, title: '[ci-heal] ci: failing', closedAt: '2026-11-24T10:00:00Z', closedByCommit: 'abc1234def5678' }];
        var mod = loadPost({
            file_read: function(o) { return o.path === 'ctx.json' ? JSON.stringify({ monitoredWorkflows: ['ci'], runs: [], previousIncidents: incidents }) : null; }
        });
        var c = mod.parseContext('ctx.json');
        assert.deepEqual(c.previousIncidents, incidents);
    });

    test('affected workflows prefer failing runs over the monitored set', function() {
        var mod = loadPost();
        var c = mod.parseContext('ignored'); // empty
        assert.deepEqual(mod.affectedWorkflows({ workflows: ['ci'], failingRuns: [{ workflow: 'release' }] }, null), ['release']);
        assert.deepEqual(mod.affectedWorkflows(c, null), []);
    });

    test('titles: adequate keeps the v0.0.1 shape, needs-human gets a distinct suffix', function() {
        var mod = loadPost();
        assert.equal(mod.buildIssueTitle(['ci', 'release']), '[ci-heal] ci,release: failing');
        assert.equal(mod.buildIssueTitle(['ci'], 'adequate'), '[ci-heal] ci: failing');
        assert.equal(mod.buildIssueTitle(['ci', 'release'], 'needs-human'), '[ci-heal] ci,release: failing (needs-human)');
        assert.equal(mod.buildIssueTitle([]), '[ci-heal] ci: failing');
    });

    test('labels: adequate arms (agent:dev), needs-human guards (needs-human + agent:skip)', function() {
        var mod = loadPost();
        assert.deepEqual(mod.buildLabels(['ci', 'release', 'ci'], 'adequate'), ['ci-heal', 'agent:dev', 'wf:ci', 'wf:release']);
        assert.deepEqual(mod.buildLabels(['ci'], 'needs-human'), ['ci-heal', 'needs-human', 'agent:skip', 'wf:ci']);
    });

    test('body: work list enumerates every live cause with its sha', function() {
        var mod = loadPost();
        var verdict = { verdict: 'adequate', classification: 'test_regression', reason: 'test_regression', summary: 'sum', suspected_cause: 'cause' };
        var context = { failingRuns: [
            { workflow: 'ci', url: 'u1', sha: 'aaa', logTail: 'FAIL test_x' },
            { workflow: 'release', url: 'u3', sha: 'ccc', logTail: 'boom' }
        ] };
        var body = mod.buildIssueBody(verdict, context, 'owner/repo', []);
        assert.notContains(body, '[ci-heal]'); // title not in body
        assert.contains(body, '<details><summary>Log excerpt (failed jobs)</summary>');
        assert.contains(body, 'FAIL test_x');
        assert.contains(body, 'u1');
        assert.contains(body, '`aaa`');
        assert.contains(body, '**Work list (live causes in the analyzed run window):**');
        assert.contains(body, '1. [ci run](u1) @ `aaa`');
        assert.contains(body, '2. [release run](u3) @ `ccc`');
        assert.contains(body, '**Classification:** `test_regression`');
        assert.contains(body, 'Closes #<this issue number>'); // fix protocol present on adequate
        assert.contains(body, 'state anchor');
        assert.notContains(body, 'Follows up #'); // no previousIncidents -> no follow-up line
        assert.notContains(body, 'Escalation — needs human'); // no escalation on adequate
    });

    test('body: previousIncidents produce Follows-up lines (short sha)', function() {
        var mod = loadPost();
        var verdict = { verdict: 'adequate', classification: 'test_regression', summary: 'sum', suspected_cause: 'cause' };
        var body = mod.buildIssueBody(verdict, { failingRuns: [] }, 'owner/repo', [
            { issue: 12, title: '[ci-heal] ci: failing', closedAt: '2026-11-24T10:00:00Z', closedByCommit: 'abc1234def5678' },
            { issue: 7, closedByCommit: 'abc' }
        ]);
        assert.contains(body, '**Follow-ups:**');
        assert.contains(body, '- Follows up #12 (closed at abc1234)');
        assert.contains(body, '- Follows up #7 (closed at abc)');
    });

    test('body: needs-human carries the escalation paragraph and NO Closes instruction', function() {
        var mod = loadPost();
        var verdict = { verdict: 'needs-human', classification: 'workflow_infra', reason: 'workflow_infra', summary: 'sum', suspected_cause: 'cause' };
        var body = mod.buildIssueBody(verdict, { failingRuns: [{ workflow: 'ci', url: 'u1', sha: 'aaa', logTail: 'x' }] }, 'owner/repo', []);
        assert.contains(body, '**Escalation — needs human:**');
        assert.contains(body, '`workflow_infra`');
        assert.contains(body, 'machine fix was NOT advisable');
        assert.contains(body, 'no dev leg is assigned');
        assert.notContains(body, 'Closes #<this issue number>');
        assert.contains(body, 'Work list (live causes in the analyzed run window)');
    });

    test('resolvePreviousIncidents: context first, customParams fallback (array or JSON string)', function() {
        var mod = loadPost();
        var fromContext = [{ issue: 1, closedByCommit: 'a' }];
        assert.deepEqual(mod.resolvePreviousIncidents({ previousIncidents: fromContext }, { previousIncidents: [{ issue: 2 }] }), fromContext);
        assert.deepEqual(mod.resolvePreviousIncidents({ previousIncidents: [] }, { previousIncidents: [{ issue: 2 }] }), [{ issue: 2 }]);
        assert.deepEqual(mod.resolvePreviousIncidents({}, { previousIncidents: '[{"issue":3,"closedByCommit":"c"}]' }), [{ issue: 3, closedByCommit: 'c' }]);
        assert.deepEqual(mod.resolvePreviousIncidents({}, { previousIncidents: 'not json' }), []);
        assert.deepEqual(mod.resolvePreviousIncidents({}, {}), []);
        assert.deepEqual(mod.resolvePreviousIncidents({}, null), []);
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

// ── ciAnalystPost.action: v2.3 routing matrix ────────────────────────────────

suite('ciAnalystPost.action routing', function() {
    // Every plausible reopen/update API is mocked and recorded so the no-reopen
    // guarantee is asserted against a ZERO call count on every branch.
    var GUARDED_TOOLS = ['github_search_issues', 'github_create_issue', 'github_add_labels', 'github_assign_issue',
        'github_reopen_issue', 'github_update_issue', 'github_edit_issue', 'github_set_issue_state', 'github_comment_issue', 'github_add_issue_comment'];

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
        GUARDED_TOOLS.forEach(function(name) {
            mocks[name] = function(args) { calls.push({ tool: name, args: args }); };
        });
        // a successful create returns a numbered issue so the adequate/needs-human paths complete
        mocks.github_create_issue = function(args) {
            calls.push({ tool: 'github_create_issue', args: args });
            return { number: 42, html_url: 'https://example/42' };
        };
        return { mod: loadPost(mocks), calls: calls };
    }

    function baseFiles(extra) {
        var context = {
            monitoredWorkflows: ['ci'],
            runs: [{ workflow: 'ci', url: 'u1', sha: 'aaa', conclusion: 'failure', logTail: 'FAIL t' }]
        };
        if (extra && extra.context) {
            for (var k in extra.context) context[k] = extra.context[k];
        }
        var files = { 'input/ci_analyst_context.md': JSON.stringify(context) };
        if (extra && extra.files) {
            for (var p in extra.files) files[p] = extra.files[p];
        }
        return files;
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
                    targetRepository: 'owner/repo',
                    previousIncidents: opts.previousIncidents
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

    function githubCalls(calls) {
        return calls.filter(function(c) { return c.tool.indexOf('github_') === 0; });
    }

    function noReopenCalls(calls, label) {
        ['github_reopen_issue', 'github_update_issue', 'github_edit_issue', 'github_set_issue_state'].forEach(function(tool) {
            assert.equal(calls.filter(function(c) { return c.tool === tool; }).length, 0, label + ': no ' + tool + ' call');
        });
    }

    test('no verdict line: record + no GitHub call', function() {
        var m = postModule({ files: baseFiles() });
        assert.equal(runAction(m, { verdictLine: 'no json here', dryRun: false }), true);
        var result = writtenResult(m.calls);
        assert.equal(result.verdictParsed, false);
        assert.equal(result.verdict, null);
        assert.equal(result.adequate, null);
        assert.equal(result.issueCreated, false);
        assert.equal(githubCalls(m.calls).length, 0);
        noReopenCalls(m.calls, 'no-verdict');
    });

    test('ROUTING noise: zero GitHub calls', function() {
        var m = postModule({ files: baseFiles() });
        runAction(m, { verdictLine: VERDICT_NOISE, dryRun: false, machineAuthor: '' });
        var result = writtenResult(m.calls);
        assert.equal(result.verdict, 'noise');
        assert.equal(result.adequate, false);
        assert.equal(result.classification, 'stale_red_sha_reset');
        assert.equal(result.issueCreated, false);
        assert.equal(githubCalls(m.calls).length, 0);
        noReopenCalls(m.calls, 'noise');
    });

    test('ROUTING adequate + machineAuthor: ONE issue, labels, ASSIGNMENT (arming act)', function() {
        var m = postModule({ files: baseFiles() });
        var r = runAction(m, { verdictLine: VERDICT_OK, dryRun: false, machineAuthor: 'machine-user' });
        assert.equal(r, true);
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
        assert.equal(assign[0].args.number, 42);
        assert.equal(assign[0].args.user, 'machine-user');
        var result = writtenResult(m.calls);
        assert.equal(result.verdict, 'adequate');
        assert.equal(result.issueCreated, true);
        assert.equal(result.issueNumber, 42);
        assert.equal(result.assignedTo, 'machine-user');
        assert.equal(result.duplicate, false);
        assert.equal(result.needsHuman, undefined);
        noReopenCalls(m.calls, 'adequate');
    });

    test('ROUTING adequate + empty machineAuthor: LOUD failure BEFORE any GitHub call', function() {
        var m = postModule({ files: baseFiles() });
        assert.throws(function() {
            runAction(m, { verdictLine: VERDICT_OK, dryRun: false, machineAuthor: '' });
        }, 'adequate with empty machineAuthor must throw');
        assert.throws(function() {
            runAction(m, { verdictLine: VERDICT_OK, dryRun: false, machineAuthor: '   ' });
        }, 'whitespace-only machineAuthor must throw too');
        var result = writtenResult(m.calls);
        assert.equal(result.success, false);
        assert.equal(result.machineAuthorMissing, true);
        assert.equal(result.issueCreated, false);
        assert.equal(result.verdict, 'adequate');
        assert.ok(String(result.error).indexOf('machineAuthor') !== -1);
        // BEFORE any GitHub call: not even the dedupe search ran
        assert.equal(githubCalls(m.calls).length, 0);
        noReopenCalls(m.calls, 'empty-machineAuthor');
    });

    test('ROUTING adequate dryRun: verdict recorded, no issue, no machineAuthor guard', function() {
        var m = postModule({ files: baseFiles() });
        assert.equal(runAction(m, { verdictLine: VERDICT_OK, dryRun: 'true', machineAuthor: '' }), true);
        var result = writtenResult(m.calls);
        assert.equal(result.dryRun, true);
        assert.equal(result.verdict, 'adequate');
        assert.equal(result.issueCreated, false);
        assert.equal(githubCalls(m.calls).length, 0);
        noReopenCalls(m.calls, 'dryRun');
    });

    test('ROUTING needs-human: issue WITHOUT assignment, needs-human + agent:skip labels, empty machineAuthor tolerated', function() {
        var m = postModule({ files: baseFiles() });
        var r = runAction(m, { verdictLine: VERDICT_NEEDS_HUMAN, dryRun: false, machineAuthor: '' });
        assert.equal(r, true); // NO throw: needs-human does not need machineAuthor
        var create = m.calls.filter(function(c) { return c.tool === 'github_create_issue'; });
        assert.equal(create.length, 1);
        assert.equal(create[0].args.title, '[ci-heal] ci: failing (needs-human)');
        assert.ok(create[0].args.body.indexOf('Escalation — needs human') !== -1);
        assert.notContains(create[0].args.body, 'Closes #<this issue number>'); // no fix protocol on escalation
        var labels = m.calls.filter(function(c) { return c.tool === 'github_add_labels'; });
        assert.equal(labels.length, 1);
        assert.deepEqual(labels[0].args.labels, ['ci-heal', 'needs-human', 'agent:skip', 'wf:ci']);
        var assigns = m.calls.filter(function(c) { return c.tool === 'github_assign_issue'; });
        assert.equal(assigns.length, 0); // deliberately unassigned
        var result = writtenResult(m.calls);
        assert.equal(result.verdict, 'needs-human');
        assert.equal(result.needsHuman, true);
        assert.equal(result.issueCreated, true);
        assert.equal(result.assignedTo, undefined);
        noReopenCalls(m.calls, 'needs-human');
    });

    test('ROUTING adequate: body carries previousIncidents follow-up lines from context', function() {
        var m = postModule({ files: baseFiles({ context: { previousIncidents: [
            { issue: 12, title: '[ci-heal] ci: failing', closedAt: '2026-11-24T10:00:00Z', closedByCommit: 'abc1234def5678' }
        ] } }) });
        runAction(m, { verdictLine: VERDICT_OK, dryRun: false, machineAuthor: 'm' });
        var create = m.calls.filter(function(c) { return c.tool === 'github_create_issue'; });
        assert.equal(create.length, 1);
        assert.ok(create[0].args.body.indexOf('- Follows up #12 (closed at abc1234)') !== -1);
    });

    test('ROUTING adequate: previousIncidents fall back to customParams when the context has none', function() {
        var m = postModule({ files: baseFiles() });
        runAction(m, {
            verdictLine: VERDICT_OK, dryRun: false, machineAuthor: 'm',
            previousIncidents: [{ issue: 9, closedByCommit: 'deadbee1234' }]
        });
        var create = m.calls.filter(function(c) { return c.tool === 'github_create_issue'; });
        assert.equal(create.length, 1);
        assert.ok(create[0].args.body.indexOf('- Follows up #9 (closed at deadbee)') !== -1);
    });

    test('multi-cause window: the issue body enumerates every failing run as a work item', function() {
        var m = postModule({ files: baseFiles({ context: { runs: [
            { workflow: 'ci', url: 'u1', sha: 'aaa', conclusion: 'failure', logTail: 'FAIL a' },
            { workflow: 'release', url: 'u3', sha: 'ccc', conclusion: 'failure', logTail: 'boom' }
        ] } }) });
        runAction(m, { verdictLine: VERDICT_OK, dryRun: false, machineAuthor: 'm' });
        var create = m.calls.filter(function(c) { return c.tool === 'github_create_issue'; });
        assert.equal(create[0].args.title, '[ci-heal] ci,release: failing');
        assert.ok(create[0].args.body.indexOf('1. [ci run](u1) @ `aaa`') !== -1);
        assert.ok(create[0].args.body.indexOf('2. [release run](u3) @ `ccc`') !== -1);
        var labels = m.calls.filter(function(c) { return c.tool === 'github_add_labels'; });
        assert.deepEqual(labels[0].args.labels, ['ci-heal', 'agent:dev', 'wf:ci', 'wf:release']);
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
        var assigns = m.calls.filter(function(c) { return c.tool === 'github_assign_issue'; });
        assert.equal(assigns.length, 0); // duplicate -> no arming attempt either
        var result = writtenResult(m.calls);
        assert.equal(result.duplicate, true);
        assert.equal(result.issueUrl, 'https://example/9');
        noReopenCalls(m.calls, 'duplicate');
    });

    test('needs-human dedupe uses its own title (not suppressed by an open adequate issue)', function() {
        var m = postModule({ files: baseFiles() });
        var post = loadPost({
            file_read: function(o) { return baseFiles()[o.path || o] !== undefined ? baseFiles()[o.path || o] : null; },
            file_write: function(o) { m.calls.push({ tool: 'file_write', args: o }); },
            github_search_issues: function(args) {
                m.calls.push({ tool: 'github_search_issues', args: args });
                // an open ADEQUATE issue with the plain title is NOT a duplicate for needs-human
                return { items: [{ number: 4, title: '[ci-heal] ci: failing' }] };
            },
            github_create_issue: function(args) { m.calls.push({ tool: 'github_create_issue', args: args }); return { number: 5 }; },
            github_add_labels: function() {},
            github_assign_issue: function() { m.calls.push({ tool: 'github_assign_issue', args: {} }); }
        });
        post.action({
            jobParams: {
                response: responseOf(VERDICT_NEEDS_HUMAN),
                customParams: { contextPath: 'input/ci_analyst_context.md', dryRun: false, machineAuthor: '', targetRepository: 'owner/repo' }
            }
        });
        assert.ok(m.calls.filter(function(c) { return c.tool === 'github_search_issues'; })[0].args.query.indexOf('(needs-human)') !== -1);
        assert.equal(m.calls.filter(function(c) { return c.tool === 'github_create_issue'; }).length, 1);
        assert.equal(m.calls.filter(function(c) { return c.tool === 'github_assign_issue'; }).length, 0);
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
                customParams: { contextPath: 'input/ci_analyst_context.md', dryRun: false, machineAuthor: 'm', targetRepository: '' }
            }
        });
        var creates = m.calls.filter(function(c) { return c.tool === 'github_create_issue'; });
        assert.equal(creates.length, 1);
        assert.equal(creates[0].args.owner, undefined); // unbound target: runtime-configured repo
        var result = writtenResult(m.calls);
        assert.equal(result.issueNumber, 5);
        assert.equal(result.assignedTo, 'm');
    });

    test('missing search tool: dedupe degrades to create', function() {
        var post = loadPost({
            file_read: function(o) { return baseFiles()[o.path || o] !== undefined ? baseFiles()[o.path || o] : null; },
            file_write: function() {},
            github_create_issue: function() { return { number: 1 }; },
            github_add_labels: function() {},
            github_assign_issue: function() {}
        });
        // no github_search_issues global at all
        var r = post.action({
            jobParams: {
                response: responseOf(VERDICT_OK),
                customParams: { contextPath: 'input/ci_analyst_context.md', dryRun: false, machineAuthor: 'm', targetRepository: 'o/r' }
            }
        });
        assert.equal(r, true);
    });

    test('adequate + failed assignment call: LOUD failure (assignment is the arming act)', function() {
        var m = postModule({ files: baseFiles() });
        var post = loadPost({
            file_read: function(o) { return baseFiles()[o.path || o] !== undefined ? baseFiles()[o.path || o] : null; },
            file_write: function(o) { m.calls.push({ tool: 'file_write', args: o }); },
            github_search_issues: function() { return { items: [] }; },
            github_create_issue: function() { return { number: 77 }; },
            github_add_labels: function() {},
            github_assign_issue: function() { throw new Error('403 assign denied'); }
        });
        assert.throws(function() {
            post.action({
                jobParams: {
                    response: responseOf(VERDICT_OK),
                    customParams: { contextPath: 'input/ci_analyst_context.md', dryRun: false, machineAuthor: 'm', targetRepository: 'owner/repo' }
                }
            });
        }, 'failed assignment must throw');
        var result = writtenResult(m.calls);
        assert.equal(result.success, false);
        assert.equal(result.issueCreated, true);
        assert.equal(result.issueNumber, 77);
        assert.ok(String(result.assignError).indexOf('403') !== -1);
        noReopenCalls(m.calls, 'assign-failure');
    });

    test('NO-REOPEN guarantee: none of the reopen/update APIs is called on ANY verdict class', function() {
        var classes = [VERDICT_OK, VERDICT_NEEDS_HUMAN, VERDICT_NOISE];
        for (var i = 0; i < classes.length; i++) {
            var m = postModule({ files: baseFiles() });
            try {
                runAction(m, { verdictLine: classes[i], dryRun: false, machineAuthor: i === 0 ? 'm' : '' });
            } catch (e) {
                // adequate+empty-ma throws by design; the call record still applies
            }
            noReopenCalls(m.calls, 'verdict index ' + i);
        }
    });
});

// ── v0.0.3 linkage: same root cause comments on the OPEN issue ──────────────

suite('ciAnalystPost.action linkage (v0.0.3)', function() {
    var LINKED = '{"verdict": "adequate", "classification": "config_error", "reason": "prep_script_missing_dart_tool_dir", "summary": "same root as the open incident", "suspected_cause": "tool/prepare.sh line 5 redirects into missing .dart_tool/", "linksIssue": 41}';

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
        ['github_search_issues', 'github_create_issue', 'github_add_labels', 'github_assign_issue',
         'github_add_issue_comment'].forEach(function(name) {
            mocks[name] = function(args) { calls.push({ tool: name, args: args }); };
        });
        mocks.github_create_issue = function(args) {
            calls.push({ tool: 'github_create_issue', args: args });
            return { number: 99, html_url: 'https://example/99' };
        };
        return { mod: loadPost(mocks), calls: calls };
    }

    function baseFiles(extra) {
        var context = {
            monitoredWorkflows: ['ci'],
            runs: [{ workflow: 'ci', url: 'u1', sha: 'aaa', conclusion: 'failure', logTail: 'FAIL t' }]
        };
        if (extra && extra.context) {
            for (var k in extra.context) context[k] = extra.context[k];
        }
        return { 'input/ci_analyst_context.md': JSON.stringify(context) };
    }

    function runAction(m, verdictLine, machineAuthor) {
        return m.mod.action({
            jobParams: {
                response: 'noise\n' + verdictLine + '\n## report',
                customParams: {
                    contextPath: 'input/ci_analyst_context.md',
                    dryRun: false,
                    machineAuthor: machineAuthor,
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

    test('parseVerdict extracts linksIssue (number and numeric string), drops junk', function() {
        var mod = loadPost({});
        var v1 = mod.parseVerdict('{"verdict": "adequate", "classification": "config_error", "reason": "r", "summary": "s", "suspected_cause": "c", "linksIssue": 41}');
        assert.equal(v1.linksIssue, 41);
        var v2 = mod.parseVerdict('{"verdict": "adequate", "classification": "config_error", "reason": "r", "summary": "s", "suspected_cause": "c", "linksIssue": "43"}');
        assert.equal(v2.linksIssue, 43);
        var v3 = mod.parseVerdict('{"verdict": "adequate", "classification": "config_error", "reason": "r", "summary": "s", "suspected_cause": "c", "linksIssue": "abc"}');
        assert.equal(v3.linksIssue, undefined);
        var v4 = mod.parseVerdict('{"verdict": "adequate", "classification": "config_error", "reason": "r", "summary": "s", "suspected_cause": "c", "linksIssue": 0}');
        assert.equal(v4.linksIssue, undefined);
    });

    test('ROUTING linkage: comment on the OPEN issue, NO create, NO machineAuthor guard', function() {
        var m = postModule({ files: baseFiles({ context: { openIncidents: [{ number: 41, title: '[ci-heal] ci-extra.yml: failing', createdAt: '2026-11-26T13:09:42Z' }] } }) });
        var r = runAction(m, LINKED, '');
        assert.equal(r, true);
        var result = writtenResult(m.calls);
        assert.equal(result.linked, true);
        assert.equal(result.linkedIssue, 41);
        assert.equal(result.issueCreated, false);
        var comments = m.calls.filter(function(c) { return c.tool === 'github_add_issue_comment'; });
        assert.equal(comments.length, 1);
        assert.equal(comments[0].args.number, 41);
        assert.ok(comments[0].args.body.indexOf('Analyst linkage') !== -1);
        assert.ok(comments[0].args.body.indexOf('tool/prepare.sh') !== -1);
        assert.equal(m.calls.filter(function(c) { return c.tool === 'github_create_issue'; }).length, 0);
        assert.equal(m.calls.filter(function(c) { return c.tool === 'github_assign_issue'; }).length, 0);
    });

    test('linksIssue NOT among open incidents: falls back to normal filing', function() {
        var m = postModule({ files: baseFiles({ context: { openIncidents: [{ number: 22, title: '[ci-heal] ci-fetch.yml: failing (needs-human)', createdAt: '2026-11-25T10:00:00Z' }] } }) });
        var r = runAction(m, LINKED, 'machine-user');
        assert.equal(r, true);
        var result = writtenResult(m.calls);
        assert.equal(result.linked, undefined);
        assert.equal(result.issueCreated, true);
        assert.equal(result.issueNumber, 99);
        assert.equal(m.calls.filter(function(c) { return c.tool === 'github_add_issue_comment'; }).length, 0);
    });

    test('isOpenIncident: number match, string match, no match', function() {
        var mod = loadPost({});
        var open = [{ number: 41 }, { number: '22' }];
        assert.equal(mod.isOpenIncident(open, 41), true);
        assert.equal(mod.isOpenIncident(open, 22), true);
        assert.equal(mod.isOpenIncident(open, 99), false);
        assert.equal(mod.isOpenIncident(null, 41), false);
    });
});
