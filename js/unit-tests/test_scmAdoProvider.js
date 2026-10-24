/**
 * Unit tests: scm.js ADO provider — characterization + pure helpers (gh-925).
 *
 * Pins the current behaviour of every _createAdoProvider method against a
 * mocked ado_* surface (happy path + error/empty paths), so the closure can
 * be split into module-level pure helpers without behaviour drift.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('scm ado provider', function () {

    function loadAdoMod(mocks) {
        return scmReal(mocks || {});
    }

    function makeAdo(mocks) {
        return loadAdoMod(mocks)._createAdoProvider('my-repo');
    }

    test('listPrs maps open→active and unwraps the {value:[...]} JSON envelope', function () {
        var calls = [];
        var scm = makeAdo({
            ado_list_prs: function (args) {
                calls.push(args);
                return JSON.stringify({ count: 2, value: [{ id: 1 }, { id: 2 }] });
            }
        });
        var prs = scm.listPrs('open');
        assert.deepEqual(calls, [{ repository: 'my-repo', status: 'active' }]);
        assert.deepEqual(prs, [{ id: 1 }, { id: 2 }]);
    });

    test('listPrs passes non-open states through unchanged', function () {
        var calls = [];
        var scm = makeAdo({
            ado_list_prs: function (args) { calls.push(args); return '[]'; }
        });
        scm.listPrs('abandoned');
        scm.listPrs('all');
        scm.listPrs(undefined);
        assert.deepEqual(calls, [
            { repository: 'my-repo', status: 'abandoned' },
            { repository: 'my-repo', status: 'all' },
            { repository: 'my-repo', status: undefined }
        ]);
    });

    test('listPrs tolerates array, JSON-string-array, bare-object and null envelopes', function () {
        var scm = makeAdo({
            ado_list_prs: function () { return null; }
        });
        assert.deepEqual(scm.listPrs('open'), []);
        var scm2 = makeAdo({
            ado_list_prs: function () { return [{ id: 3 }]; }
        });
        assert.deepEqual(scm2.listPrs('open'), [{ id: 3 }]);
        var scm3 = makeAdo({
            ado_list_prs: function () { return '[{"id":4}]'; }
        });
        assert.deepEqual(scm3.listPrs('open'), [{ id: 4 }]);
        var scm4 = makeAdo({
            ado_list_prs: function () { return { count: 0 }; }
        });
        assert.deepEqual(scm4.listPrs('open'), { count: 0 });
    });

    test('getPr parses the JSON envelope and stringifies the PR id', function () {
        var calls = [];
        var scm = makeAdo({
            ado_get_pr: function (args) { calls.push(args); return '{"id":42,"title":"T"}'; }
        });
        assert.deepEqual(scm.getPr(42), { id: 42, title: 'T' });
        assert.deepEqual(calls, [{ repository: 'my-repo', pullRequestId: '42' }]);
        var scm2 = makeAdo({
            ado_get_pr: function () { return { id: 7 }; }
        });
        assert.deepEqual(scm2.getPr('7'), { id: 7 });
    });

    test('getPrComments unwraps .value and falls back to [] on null', function () {
        var scm = makeAdo({
            ado_get_pr_comments: function () { return JSON.stringify({ value: [{ id: 'c1' }] }); }
        });
        assert.deepEqual(scm.getPrComments(5), [{ id: 'c1' }]);
        var scm2 = makeAdo({
            ado_get_pr_comments: function () { return null; }
        });
        assert.deepEqual(scm2.getPrComments(5), []);
        var scm3 = makeAdo({
            ado_get_pr_comments: function () { return [{ id: 'c2' }]; }
        });
        assert.deepEqual(scm3.getPrComments(5), [{ id: 'c2' }]);
    });

    test('getDiffText always returns null without touching any tool', function () {
        var scm = makeAdo({
            ado_get_pr_diff: function () { throw new Error('must not be called'); }
        });
        assert.equal(scm.getDiffText(5), null);
    });

    test('addComment passes repository, stringified PR id and text', function () {
        var calls = [];
        var scm = makeAdo({
            ado_add_pr_comment: function (args) { calls.push(args); return 'ok'; }
        });
        assert.equal(scm.addComment(9, 'hello'), 'ok');
        assert.deepEqual(calls, [{ repository: 'my-repo', pullRequestId: '9', text: 'hello' }]);
    });

    test('replyToThread uses the thread reply tool when threadId present (number → string)', function () {
        var calls = [];
        var scm = makeAdo({
            ado_reply_to_pr_thread: function (args) { calls.push({ tool: 'reply', args: args }); return 'replied'; },
            ado_add_pr_comment: function () { throw new Error('must not fall back'); }
        });
        var out = scm.replyToThread(5, { threadId: 77 }, 'a reply');
        assert.equal(out, 'replied');
        assert.deepEqual(calls, [{
            tool: 'reply',
            args: { repository: 'my-repo', pullRequestId: '5', threadId: '77', text: 'a reply' }
        }]);
    });

    test('replyToThread falls back to a plain comment when threadId missing or empty', function () {
        var calls = [];
        var scm = makeAdo({
            ado_reply_to_pr_thread: function () { throw new Error('must not reply'); },
            ado_add_pr_comment: function (args) { calls.push(args); return 'commented'; }
        });
        scm.replyToThread(5, {}, 'a reply');
        scm.replyToThread(5, { threadId: '' }, 'another');
        assert.deepEqual(calls, [
            { repository: 'my-repo', pullRequestId: '5', text: 'a reply' },
            { repository: 'my-repo', pullRequestId: '5', text: 'another' }
        ]);
    });

    test('resolveThread resolves via ado_resolve_pr_thread when threadId present', function () {
        var calls = [];
        var scm = makeAdo({
            ado_resolve_pr_thread: function (args) { calls.push(args); return 'resolved'; }
        });
        assert.equal(scm.resolveThread(5, { threadId: '77' }), 'resolved');
        assert.deepEqual(calls, [{ repository: 'my-repo', pullRequestId: '5', threadId: '77' }]);
    });

    test('resolveThread warns and no-ops without threadId', function () {
        var calls = [];
        var scm = makeAdo({
            ado_resolve_pr_thread: function (args) { calls.push(args); return 'resolved'; }
        });
        assert.equal(scm.resolveThread(5, {}), undefined);
        assert.deepEqual(calls, []);
    });

    test('addInlineComment builds the exact option set (startLine/side only when given)', function () {
        var calls = [];
        var scm = makeAdo({
            ado_add_inline_comment: function (args) { calls.push(args); return 'ok'; }
        });
        scm.addInlineComment(5, '/a.js', 12, 'note', 10, 'right');
        assert.deepEqual(calls, [{
            repository: 'my-repo', pullRequestId: '5', filePath: '/a.js',
            line: '12', text: 'note', startLine: '10', side: 'right'
        }]);
        calls = [];
        scm.addInlineComment(5, '/a.js', 12, 'note');
        assert.deepEqual(calls, [{
            repository: 'my-repo', pullRequestId: '5', filePath: '/a.js', line: '12', text: 'note'
        }]);
    });

    test('mergePr ignores merge method and commit title/message', function () {
        var calls = [];
        var scm = makeAdo({
            ado_merge_pr: function (args) { calls.push(args); return 'merged'; }
        });
        assert.equal(scm.mergePr(5, 'squash', 'title', 'message'), 'merged');
        assert.deepEqual(calls, [{ repository: 'my-repo', pullRequestId: '5' }]);
    });

    test('addLabel passes the label; removeLabel prefers labelId and falls back to label', function () {
        var calls = [];
        var scm = makeAdo({
            ado_add_pr_label: function (args) { calls.push({ tool: 'add', args: args }); return 'ok'; },
            ado_remove_pr_label: function (args) { calls.push({ tool: 'remove', args: args }); return 'ok'; }
        });
        scm.addLabel(5, 'reviewed');
        scm.removeLabel(5, 'reviewed', 'id7');
        scm.removeLabel(5, 'reviewed');
        assert.deepEqual(calls, [
            { tool: 'add', args: { repository: 'my-repo', pullRequestId: '5', label: 'reviewed' } },
            { tool: 'remove', args: { repository: 'my-repo', pullRequestId: '5', labelId: 'id7' } },
            { tool: 'remove', args: { repository: 'my-repo', pullRequestId: '5', labelId: 'reviewed' } }
        ]);
    });

    test('getPrDiff passes the raw tool result through untouched', function () {
        var calls = [];
        var scm = makeAdo({
            ado_get_pr_diff: function (args) { calls.push(args); return 'RAW DIFF STATS'; }
        });
        assert.equal(scm.getPrDiff(5), 'RAW DIFF STATS');
        assert.deepEqual(calls, [{ repository: 'my-repo', pullRequestId: '5' }]);
    });

    test('getCommitCheckRuns has no ADO equivalent — returns null', function () {
        var scm = makeAdo({});
        assert.equal(scm.getCommitCheckRuns('abc123'), null);
    });

    test('getJobLogs parses buildId and adds tailLines only when given', function () {
        var calls = [];
        var scm = makeAdo({
            ado_get_pipeline_logs: function (args) { calls.push(args); return 'logs'; }
        });
        scm.getJobLogs('123');
        scm.getJobLogs('123', '25');
        scm.getJobLogs('123', 0);
        assert.deepEqual(calls, [
            { buildId: 123 },
            { buildId: 123, tailLines: 25 },
            { buildId: 123 }
        ]);
    });

    test('createScm routes provider ado to the ADO provider bound to the configured repo', function () {
        var mod = loadAdoMod({
            ado_get_pr: function (args) { return JSON.stringify({ id: 1, repo: args.repository }); }
        });
        var scm = mod.createScm({ scm: { provider: 'ado' }, repository: { owner: 'org', repo: 'my-repo' } });
        assert.deepEqual(scm.getPr(1), { id: 1, repo: 'my-repo' });
    });
});

suite('scm ado workflow runs', function () {

    function makeAdoWithRuns(mocks) {
        var mod = scmReal(mocks || {});
        return mod._createAdoProvider('my-repo');
    }

    var RUNS = [
        { id: 1, state: 'completed', result: 'succeeded' },
        { id: 2, state: 'completed', result: 'failed' },
        { id: 3, state: 'inProgress', result: null },
        { id: 4, state: 'completed', result: 'canceled' },
        { id: 5, state: 'inProgress', result: 'succeeded' }
    ];

    test('numeric workflowId resolves without ado_list_pipelines; top added only with limit', function () {
        var pipelineCalls = [];
        var runsCalls = [];
        var scm = makeAdoWithRuns({
            ado_list_pipelines: function () { pipelineCalls.push({}); return '[]'; },
            ado_list_pipeline_runs: function (args) { runsCalls.push(args); return JSON.stringify({ value: RUNS }); }
        });
        scm.listWorkflowRuns(null, '12', null);
        scm.listWorkflowRuns(null, 12, '10');
        assert.deepEqual(pipelineCalls, []);
        assert.deepEqual(runsCalls, [
            { pipelineId: 12 },
            { pipelineId: 12, top: 10 }
        ]);
    });

    test('workflowId resolves by case-insensitive pipeline name', function () {
        var calls = [];
        var scm = makeAdoWithRuns({
            ado_list_pipelines: function () {
                calls.push({});
                return JSON.stringify({ value: [{ id: 3, name: 'CI' }, { id: 4, name: 'deploy' }] });
            },
            ado_list_pipeline_runs: function (args) { calls.push(args); return '[]'; }
        });
        scm.listWorkflowRuns(null, 'ci', null);
        assert.deepEqual(calls, [{}, { pipelineId: 3 }]);
    });

    test('unresolvable pipeline (no match, zero/NaN id) → warn + null, no runs call', function () {
        var runsCalls = [];
        var scm = makeAdoWithRuns({
            ado_list_pipelines: function () { return '[]'; },
            ado_list_pipeline_runs: function (args) { runsCalls.push(args); return '[]'; }
        });
        assert.equal(scm.listWorkflowRuns(null, 'nope', null), null);
        assert.equal(scm.listWorkflowRuns(null, '0', null), null);
        assert.equal(scm.listWorkflowRuns(null, '', null), null);
        assert.deepEqual(runsCalls, []);
    });

    test('pipeline lookup failure → warn + null', function () {
        var scm = makeAdoWithRuns({
            ado_list_pipelines: function () { throw new Error('boom'); },
            ado_list_pipeline_runs: function () { throw new Error('must not run'); }
        });
        assert.equal(scm.listWorkflowRuns(null, 'ci', null), null);
    });

    test('run envelopes unwrap: {value}, array, JSON strings; java-list-like objects are dropped', function () {
        var scm = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return JSON.stringify({ value: [{ id: 1 }] }); }
        });
        assert.equal(scm.listWorkflowRuns(null, '12', null), JSON.stringify({ workflow_runs: [{ id: 1 }] }));
        var scm2 = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return [{ id: 2 }]; }
        });
        assert.equal(scm2.listWorkflowRuns(null, '12', null), JSON.stringify({ workflow_runs: [{ id: 2 }] }));
        // Current-behaviour pin: only {value} envelopes and true arrays are unwrapped.
        // A java-list-LIKE plain object (indexed keys + length) falls into the else
        // branch of the unwrap guard and is dropped — the native-array conversion
        // loop only re-copies what the guard let through.
        var scm3 = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return { 0: { id: 3 }, 1: { id: 4 }, length: 2 }; }
        });
        assert.equal(scm3.listWorkflowRuns(null, '12', null), JSON.stringify({ workflow_runs: [] }));
        var scm4 = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return null; }
        });
        assert.equal(scm4.listWorkflowRuns(null, '12', null), JSON.stringify({ workflow_runs: [] }));
    });

    test('status filter: failed/failure match run.result only (multi-item mix)', function () {
        var scm = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return JSON.stringify({ value: RUNS }); }
        });
        assert.deepEqual(JSON.parse(scm.listWorkflowRuns('failed', '12', null)).workflow_runs,
            [{ id: 2, state: 'completed', result: 'failed' }]);
        assert.deepEqual(JSON.parse(scm.listWorkflowRuns('failure', '12', null)).workflow_runs,
            [{ id: 2, state: 'completed', result: 'failed' }]);
    });

    test('status filter: success/succeeded match run.result only', function () {
        var scm = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return JSON.stringify({ value: RUNS }); }
        });
        assert.deepEqual(JSON.parse(scm.listWorkflowRuns('success', '12', null)).workflow_runs, [
            { id: 1, state: 'completed', result: 'succeeded' },
            { id: 5, state: 'inProgress', result: 'succeeded' }
        ]);
        assert.deepEqual(JSON.parse(scm.listWorkflowRuns('succeeded', '12', null)).workflow_runs, [
            { id: 1, state: 'completed', result: 'succeeded' },
            { id: 5, state: 'inProgress', result: 'succeeded' }
        ]);
    });

    test('status filter: in_progress matches state; completed matches state (canceled result excluded)', function () {
        var scm = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return JSON.stringify({ value: RUNS }); }
        });
        assert.deepEqual(JSON.parse(scm.listWorkflowRuns('in_progress', '12', null)).workflow_runs, [
            { id: 3, state: 'inProgress', result: null },
            { id: 5, state: 'inProgress', result: 'succeeded' }
        ]);
        assert.deepEqual(JSON.parse(scm.listWorkflowRuns('completed', '12', null)).workflow_runs, [
            { id: 1, state: 'completed', result: 'succeeded' },
            { id: 2, state: 'completed', result: 'failed' },
            { id: 4, state: 'completed', result: 'canceled' }
        ]);
    });

    test('status filter: other statuses match state or result case-insensitively', function () {
        var scm = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return JSON.stringify({ value: RUNS }); }
        });
        assert.deepEqual(JSON.parse(scm.listWorkflowRuns('canceling', '12', null)).workflow_runs, []);
        var scm2 = makeAdoWithRuns({
            ado_list_pipeline_runs: function () {
                return JSON.stringify({ value: [{ id: 9, state: 'canceling' }, { id: 10, state: 'x', result: 'CANCELED' }] });
            }
        });
        assert.deepEqual(JSON.parse(scm2.listWorkflowRuns('canceled', '12', null)).workflow_runs,
            [{ id: 10, state: 'x', result: 'CANCELED' }]);
    });

    test('no status returns every run inside the {workflow_runs} JSON envelope', function () {
        var scm = makeAdoWithRuns({
            ado_list_pipeline_runs: function () { return JSON.stringify({ value: RUNS }); }
        });
        assert.deepEqual(JSON.parse(scm.listWorkflowRuns(null, '12', null)).workflow_runs, RUNS);
    });

    test('triggerWorkflow passes branch + JSON variables only when provided', function () {
        var calls = [];
        var scm = makeAdoWithRuns({
            ado_trigger_pipeline: function (args) { calls.push(args); return 'triggered'; }
        });
        assert.equal(scm.triggerWorkflow('o', 'r', '12', { var1: 'a' }, 'refs/heads/x'), 'triggered');
        assert.deepEqual(calls, [{ pipelineId: 12, branch: 'refs/heads/x', variables: '{"var1":"a"}' }]);
        calls = [];
        scm.triggerWorkflow('o', 'r', 12, null, null);
        scm.triggerWorkflow('o', 'r', 12, {}, 'main');
        assert.deepEqual(calls, [
            { pipelineId: 12 },
            { pipelineId: 12, branch: 'main' }
        ]);
    });

    test('triggerWorkflow returns null for an unresolvable pipeline', function () {
        var scm = makeAdoWithRuns({
            ado_list_pipelines: function () { return '[]'; },
            ado_trigger_pipeline: function () { throw new Error('must not trigger'); }
        });
        assert.equal(scm.triggerWorkflow('o', 'r', 'ghost', null, null), null);
    });
});

suite('scm ado helpers', function () {

    function loadAdoMod(mocks) {
        return scmReal(mocks || {});
    }

    test('_adoUnwrapList: value envelope, array, bare object, null', function () {
        var mod = loadAdoMod({});
        assert.deepEqual(mod._adoUnwrapList('{"value":[1,2]}'), [1, 2]);
        assert.deepEqual(mod._adoUnwrapList([1]), [1]);
        assert.deepEqual(mod._adoUnwrapList('plain'), 'plain');
        assert.deepEqual(mod._adoUnwrapList(null), []);
    });

    test('_adoListPrsStatus: only open→active', function () {
        var mod = loadAdoMod({});
        assert.equal(mod._adoListPrsStatus('open'), 'active');
        assert.equal(mod._adoListPrsStatus('abandoned'), 'abandoned');
        assert.equal(mod._adoListPrsStatus(undefined), undefined);
    });

    test('_adoBuildInlineCommentOpts: exact option set', function () {
        var mod = loadAdoMod({});
        assert.deepEqual(
            mod._adoBuildInlineCommentOpts('r', 5, '/a.js', 12, 'note', 10, 'right'),
            { repository: 'r', pullRequestId: '5', filePath: '/a.js', line: '12', text: 'note', startLine: '10', side: 'right' });
        assert.deepEqual(
            mod._adoBuildInlineCommentOpts('r', 5, '/a.js', 12, 'note'),
            { repository: 'r', pullRequestId: '5', filePath: '/a.js', line: '12', text: 'note' });
    });

    test('_adoBuildJobLogsOpts: buildId parse + optional tailLines', function () {
        var mod = loadAdoMod({});
        assert.deepEqual(mod._adoBuildJobLogsOpts('123'), { buildId: 123 });
        assert.deepEqual(mod._adoBuildJobLogsOpts('123', '25'), { buildId: 123, tailLines: 25 });
        assert.deepEqual(mod._adoBuildJobLogsOpts('123', 0), { buildId: 123 });
    });

    test('_adoParseRunList: {value}, array, null → []; java-list-like objects dropped', function () {
        var mod = loadAdoMod({});
        assert.deepEqual(mod._adoParseRunList('{"value":[1]}'), [1]);
        assert.deepEqual(mod._adoParseRunList([2]), [2]);
        // Current-behaviour pin (see listWorkflowRuns characterization): indexed
        // objects with a length are NOT unwrapped — only {value} envelopes and
        // true arrays pass the guard.
        assert.deepEqual(mod._adoParseRunList({ 0: 3, length: 1 }), []);
        assert.deepEqual(mod._adoParseRunList(null), []);
    });

    test('_adoRunResultForStatus / _adoRunStateForStatus status tables', function () {
        var mod = loadAdoMod({});
        assert.equal(mod._adoRunResultForStatus('failure'), 'failed');
        assert.equal(mod._adoRunResultForStatus('failed'), 'failed');
        assert.equal(mod._adoRunResultForStatus('success'), 'succeeded');
        assert.equal(mod._adoRunResultForStatus('succeeded'), 'succeeded');
        assert.equal(mod._adoRunResultForStatus('in_progress'), null);
        assert.equal(mod._adoRunStateForStatus('in_progress'), 'inprogress');
        assert.equal(mod._adoRunStateForStatus('completed'), 'completed');
        assert.equal(mod._adoRunStateForStatus('failed'), null);
    });

    test('_adoRunMatchesStatusFilter: full decision table', function () {
        var mod = loadAdoMod({});
        var run = { state: 'completed', result: 'failed' };
        assert.equal(mod._adoRunMatchesStatusFilter(run, 'failed'), true);
        assert.equal(mod._adoRunMatchesStatusFilter(run, 'success'), false);
        assert.equal(mod._adoRunMatchesStatusFilter({ state: 'inprogress' }, 'in_progress'), true);
        assert.equal(mod._adoRunMatchesStatusFilter({ state: 'inProgress' }, 'in_progress'), true);
        assert.equal(mod._adoRunMatchesStatusFilter({ state: 'completed' }, 'completed'), true);
        assert.equal(mod._adoRunMatchesStatusFilter({ state: 'canceling' }, 'canceling'), true);
        assert.equal(mod._adoRunMatchesStatusFilter({ result: 'canceled' }, 'canceled'), true);
        assert.equal(mod._adoRunMatchesStatusFilter({ state: 'x', result: 'y' }, 'zzz'), false);
    });

    test('_adoBuildPipelineRunsOpts: pipelineId parse + optional top', function () {
        var mod = loadAdoMod({});
        assert.deepEqual(mod._adoBuildPipelineRunsOpts('12', null), { pipelineId: 12 });
        assert.deepEqual(mod._adoBuildPipelineRunsOpts(12, '10'), { pipelineId: 12, top: 10 });
    });

    test('_adoBuildTriggerOpts: branch/variables optional', function () {
        var mod = loadAdoMod({});
        assert.deepEqual(mod._adoBuildTriggerOpts('12', null, null), { pipelineId: 12 });
        assert.deepEqual(mod._adoBuildTriggerOpts('12', 'main', {}),
            { pipelineId: 12, branch: 'main' });
        assert.deepEqual(mod._adoBuildTriggerOpts('12', 'main', { k: 'v' }),
            { pipelineId: 12, branch: 'main', variables: '{"k":"v"}' });
    });

    test('_adoParsePipelines + _adoFindPipelineByName lookup', function () {
        var mod = loadAdoMod({});
        assert.deepEqual(mod._adoParsePipelines('{"value":[1]}'), [1]);
        assert.deepEqual(mod._adoParsePipelines([2]), [2]);
        assert.deepEqual(mod._adoParsePipelines(null), []);
        assert.equal(mod._adoFindPipelineByName([{ id: 3, name: 'CI' }], 'ci'), 3);
        assert.equal(mod._adoFindPipelineByName([{ id: 3, name: 'CI' }], 'CD'), null);
        assert.equal(mod._adoFindPipelineByName([{}], 'ci'), null);
    });

    test('_adoResolvePipelineId: falsy → null; numeric id short-circuits the pipelines call', function () {
        var mod = loadAdoMod({
            ado_list_pipelines: function () { throw new Error('must not call'); }
        });
        assert.equal(mod._adoResolvePipelineId(''), null);
        assert.equal(mod._adoResolvePipelineId(null), null);
        assert.equal(mod._adoResolvePipelineId('12'), 12);
    });

    test('_adoResolvePipelineId: name lookup and failure fallouts', function () {
        var mod = loadAdoMod({
            ado_list_pipelines: function () { return '{"value":[{"id":3,"name":"CI"}]}'; }
        });
        assert.equal(mod._adoResolvePipelineId('ci'), 3);
        assert.equal(mod._adoResolvePipelineId('ghost'), null);
        var failing = loadAdoMod({
            ado_list_pipelines: function () { throw new Error('boom'); }
        });
        assert.equal(failing._adoResolvePipelineId('ci'), null);
    });

    test('_adoReplyToThread / _adoResolveThread / _adoRemoveLabel', function () {
        var calls = [];
        var mod = loadAdoMod({
            ado_reply_to_pr_thread: function (a) { calls.push(['reply', a]); return 'r'; },
            ado_add_pr_comment: function (a) { calls.push(['comment', a]); return 'c'; },
            ado_resolve_pr_thread: function (a) { calls.push(['resolve', a]); return 's'; },
            ado_remove_pr_label: function (a) { calls.push(['removeLabel', a]); return 'l'; }
        });
        assert.equal(mod._adoReplyToThread('repo', 5, { threadId: 7 }, 'text'), 'r');
        assert.equal(mod._adoReplyToThread('repo', 5, {}, 'text'), 'c');
        assert.equal(mod._adoResolveThread('repo', 5, { threadId: 7 }), 's');
        assert.equal(mod._adoResolveThread('repo', 5, {}), undefined);
        assert.equal(mod._adoRemoveLabel('repo', 5, 'lbl', 'id9'), 'l');
        assert.equal(mod._adoRemoveLabel('repo', 5, 'lbl'), 'l');
        assert.deepEqual(calls, [
            ['reply', { repository: 'repo', pullRequestId: '5', threadId: '7', text: 'text' }],
            ['comment', { repository: 'repo', pullRequestId: '5', text: 'text' }],
            ['resolve', { repository: 'repo', pullRequestId: '5', threadId: '7' }],
            ['removeLabel', { repository: 'repo', pullRequestId: '5', labelId: 'id9' }],
            ['removeLabel', { repository: 'repo', pullRequestId: '5', labelId: 'lbl' }]
        ]);
    });

    test('_adoGetRemoteRepoInfo parses https and ssh azure remotes, joins multi-line output', function () {
        var https = loadAdoMod({
            cli_execute_command: function () { return 'https://dev.azure.com/org/proj/_git/repo\n'; }
        });
        assert.deepEqual(https._adoGetRemoteRepoInfo(), { owner: 'org', repo: 'repo' });
        var ssh = loadAdoMod({
            cli_execute_command: function () { return 'git@ssh.dev.azure.com:v3/org/proj/repo'; }
        });
        assert.deepEqual(ssh._adoGetRemoteRepoInfo(), { owner: 'org', repo: 'repo' });
        // Current-behaviour pin: non-empty lines are JOINED (no separator) before
        // matching, and the repo group is [^/]+ — a trailing "(fetch)" fragment
        // from a wrapped `git remote -v`-style line is kept verbatim.
        var wrapped = loadAdoMod({
            cli_execute_command: function () { return 'origin\nhttps://dev.azure.com/o2/p2/_git/r2 (fetch)'; }
        });
        assert.deepEqual(wrapped._adoGetRemoteRepoInfo(), { owner: 'o2', repo: 'r2 (fetch)' });
        var none = loadAdoMod({
            cli_execute_command: function () { return 'https://github.com/a/b.git'; }
        });
        assert.equal(none._adoGetRemoteRepoInfo(), null);
        var failing = loadAdoMod({
            cli_execute_command: function () { throw new Error('no git'); }
        });
        assert.equal(failing._adoGetRemoteRepoInfo(), null);
    });

    test('ado getRemoteRepoInfo delegates to the same parse', function () {
        var mod = loadAdoMod({
            cli_execute_command: function () { return 'https://dev.azure.com/org/proj/_git/repo'; }
        });
        var scm = mod._createAdoProvider('my-repo');
        assert.deepEqual(scm.getRemoteRepoInfo(), { owner: 'org', repo: 'repo' });
    });
});
