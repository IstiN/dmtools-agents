var glPoll = loadModule('js/gitlabFactoryPoll.js', makeRequire({}, {}), {});

function glFixture(options) {
    options = options || {};
    var calls = [];
    var context = { projectId: '7', pipelineId: '50', trigger: '', payload: null, mrIid: '', leg: '' };
    Object.keys(options.context || {}).forEach(function (key) { context[key] = options.context[key]; });
    var bridge = function (name, args) {
        calls.push({ name: name, args: args });
        if (name === 'context') return JSON.stringify(context);
        if (name === 'develop') {
            if (options.developError) throw new Error('development failed');
            return options.developOutput === undefined ? '__DMTOOLS_CREATED_MR__81\n' : options.developOutput;
        }
        if (name === 'api' || name === 'api-role') {
            var offset = name === 'api-role' ? 1 : 0;
            var method = args[offset], path = args[offset + 1];
            if (options.api) {
                var override = options.api(method, path, args);
                if (override !== undefined) return JSON.stringify(override);
            }
            if (method !== 'GET') return '{}';
            if (path === '/user') return '{"username":"dev-bot"}';
            if (path.indexOf('/related_merge_requests?') >= 0) return JSON.stringify(options.related || []);
            if (/\/issues\?/.test(path)) return JSON.stringify(options.issues || []);
            if (/\/merge_requests\?/.test(path)) return JSON.stringify(options.mrs || []);
            if (/\/issues\/\d+$/.test(path)) {
                var id = Number(path.split('/').pop());
                return JSON.stringify((options.issues || []).filter(function (issue) { return issue.iid === id; })[0]);
            }
            if (/\/merge_requests\/\d+$/.test(path)) return JSON.stringify(options.mr || {});
            throw new Error('Unexpected API call: ' + method + ' ' + path);
        }
        return '';
    };
    return {
        calls: calls,
        run: function (job) { return glPoll.poll(job || {}, { bridge: bridge, log: function () {} }); },
        named: function (name) { return calls.filter(function (c) { return c.name === name; }); }
    };
}
function glIssue(iid, labels, assigned) {
    return { iid: iid, labels: labels || [], assignees: assigned ? [{ username: assigned }] : [] };
}
function glHook(kind, attributes, changes) {
    return { trigger: 'issue_webhook', payload: { object_kind: kind, object_attributes: attributes, changes: changes || {} } };
}

suite('GitLab deterministic polling', function () {
    test('automatic develop uses identity and bug runner, labels and lifecycle', function () {
        var f = glFixture({ issues: [glIssue(4, ['bug'], 'dev-bot')] });
        f.run({ baseBranch: 'release' });
        assert.deepEqual(f.named('develop')[0].args, ['4', '.dmtools/runners/fa-bug-dev.json', 'automatic', 'release']);
        assert.deepEqual(f.named('labels')[0].args, ['81', '4', 'ai_developed,agent:review', 'agent:dev']);
        assert.deepEqual(f.named('lifecycle')[0].args, ['81', '4', '']);
    });
    test('automatic ignores needs-human, blocked, skip, developed and unrelated issues', function () {
        var f = glFixture({ issues: [
            glIssue(1, ['agent:dev', 'needs-human']), glIssue(2, ['agent:dev', 'blocked']),
            glIssue(3, ['agent:dev', 'agent:skip']), glIssue(4, ['ai_developed'], 'dev-bot'),
            glIssue(5, ['ai_pr_reviewed'], 'dev-bot'), glIssue(6, [], 'someone')
        ] });
        f.run();
        assert.equal(f.named('develop').length, 0);
    });
    test('automatic reuses one open MR and routes manual rework before review', function () {
        var f = glFixture({ issues: [glIssue(1, ['agent:review', 'agent:rework'])], related: [{ iid: 8, state: 'opened' }] });
        f.run();
        assert.equal(f.named('develop').length, 0);
        assert.deepEqual(f.named('lifecycle')[0].args, ['8', '1', 'rework']);
    });
    test('automatic refuses ambiguous MRs', function () {
        var f = glFixture({ issues: [glIssue(1, ['agent:dev'])], related: [{ iid: 8, state: 'opened' }, { iid: 9, state: 'opened' }] });
        assert.throws(function () { f.run(); });
        assert.equal(f.named('lifecycle').length, 0);
    });
    test('automatic manual review requires an existing open MR', function () {
        var f = glFixture({ issues: [glIssue(1, ['agent:review'])], related: [{ iid: 8, state: 'closed' }] });
        assert.throws(function () { f.run(); });
        assert.equal(f.named('develop').length, 0);
    });
    test('development failure adds needs-human and never starts lifecycle', function () {
        var f = glFixture({ issues: [glIssue(1, ['agent:dev'])], developError: true });
        assert.throws(function () { f.run(); });
        assert.ok(f.named('api').some(function (c) { return c.args.indexOf('add_labels=needs-human') >= 0; }));
        assert.equal(f.named('lifecycle').length, 0);
    });
    test('development must return numeric created MR marker', function () {
        var f = glFixture({ issues: [glIssue(1, ['agent:dev'])], developOutput: 'done' });
        assert.throws(function () { f.run(); });
        assert.equal(f.named('labels').length, 0);
    });
    test('automatic direct MR wake passes explicit leg', function () {
        var f = glFixture({ context: { mrIid: '8', leg: 'review' } });
        f.run();
        assert.deepEqual(f.named('lifecycle')[0].args, ['8', '', 'review']);
        assert.equal(f.named('api').length, 0);
    });
    test('automatic direct MR rejects shell-like IID', function () {
        var f = glFixture({ context: { mrIid: '8; false' } });
        assert.throws(function () { f.run(); });
    });
    test('automatic cron resumes only unblocked factory branches', function () {
        var f = glFixture({ mrs: [
            { iid: 1, source_branch: 'ai/issue-1-2', labels: [] },
            { iid: 2, source_branch: 'feature', labels: [] },
            { iid: 3, source_branch: 'ai/issue-3-2', labels: ['needs-human'] }
        ] });
        f.run();
        assert.deepEqual(f.named('lifecycle').map(function (c) { return c.args[0]; }), ['1']);
    });
    test('automatic MR webhook cannot run unrelated branches', function () {
        var f = glFixture({ context: glHook('merge_request', { iid: 8, action: 'open' }), mr: { source_branch: 'feature' } });
        f.run();
        assert.equal(f.named('lifecycle').length, 0);
    });
    test('automatic MR webhook runs factory MR with force', function () {
        var f = glFixture({ context: glHook('merge_request', { iid: 8, action: 'update', oldrev: 'abc' }), mr: { source_branch: 'ai/issue-1-2', labels: ['agent:review'] } });
        f.run();
        assert.deepEqual(f.named('lifecycle')[0].args, ['8', '', 'review']);
    });
    test('progress-only issue webhook is ignored before API calls', function () {
        var f = glFixture({ context: glHook('issue', { iid: 1, action: 'update' }, { description: {}, updated_at: {} }) });
        assert.ok(f.run().ignored);
        assert.equal(f.named('api').length, 0);
    });
    test('non-actionable status-label webhook is ignored', function () {
        var f = glFixture({ context: glHook('issue', { iid: 1, action: 'update' }, { labels: { current: [{ title: 'ai_developed' }], previous: [] } }) });
        assert.ok(f.run().ignored);
    });
    test('added agent label webhook scopes intake and skips MR sweep', function () {
        var f = glFixture({
            context: glHook('issue', { iid: 2, action: 'update' }, { labels: { current: [{ name: 'agent:dev' }], previous: [] } }),
            issues: [glIssue(1, ['agent:dev']), glIssue(2, ['agent:dev'])]
        });
        f.run();
        assert.deepEqual(f.named('develop').map(function (c) { return c.args[0]; }), ['2']);
        assert.equal(f.named('lifecycle').length, 1);
    });
    test('open event remains actionable despite status-only labels', function () {
        var f = glFixture({ context: glHook('issue', { iid: 1, action: 'open' }, { labels: { current: [], previous: [] } }), issues: [glIssue(1, ['agent:dev'])] });
        f.run();
        assert.equal(f.named('develop').length, 1);
    });
    test('invalid webhook is rejected', function () {
        assert.throws(function () { glFixture({ context: glHook('note', { iid: 1 }) }).run(); });
        assert.throws(function () { glFixture({ context: glHook('issue', { iid: '1' }) }).run(); });
    });
    test('list pagination reaches page two and validates arrays', function () {
        var first = [];
        for (var i = 1; i <= 100; i++) first.push(glIssue(i, ['blocked']));
        var f = glFixture({ api: function (method, path) {
            if (/\/issues\?/.test(path)) return /page=1$/.test(path) ? first : [glIssue(101, ['agent:dev'])];
            if (path === '/projects/7/issues/101') return glIssue(101, ['agent:dev']);
        } });
        f.run();
        assert.equal(f.named('develop')[0].args[0], '101');
        var bad = glFixture({ api: function (method, path) { if (/\/issues\?/.test(path)) return { message: 'oops' }; } });
        assert.throws(function () { bad.run(); });
    });
    test('legacy review overrides busy statuses, rework requires no In Rework', function () {
        var f = glFixture({ issues: [
            glIssue(1, ['agent:review', 'status:In Review']),
            glIssue(2, ['agent:rework', 'status:In Rework']),
            glIssue(3, ['agent:rework'])
        ] });
        f.run({ mode: 'legacy', machine: 'machine' });
        assert.deepEqual(f.named('legacy-issue').map(function (c) { return c.args.slice(0, 3); }), [
            ['1', '.dmtools/runners/fa-review.json', 'agent:review'],
            ['3', '.dmtools/runners/fa-rework.json', 'agent:rework']
        ]);
        assert.equal(f.named('api-role').length, 1);
    });
    test('legacy development preserves busy and processed-label exclusions', function () {
        var labels = ['status:In Development', 'status:In Review', 'status:In Rework', 'ai_developed', 'ai_pr_reviewed', 'work in progress', 'foo_wip', 'rework-round-2'];
        var issues = labels.map(function (label, i) { return glIssue(i + 1, [label, 'agent:dev']); });
        issues.push(glIssue(20, ['agent:dev', 'bug']));
        var f = glFixture({ issues: issues });
        f.run({ mode: 'legacy' });
        assert.equal(f.named('legacy-issue').length, 1);
        assert.equal(f.named('legacy-issue')[0].args[1], '.dmtools/runners/fa-bug-dev.json');
    });
    test('legacy needs-human alone does not block explicit work', function () {
        var f = glFixture({ issues: [glIssue(1, ['agent:dev', 'needs-human'])] });
        f.run({ mode: 'legacy' });
        assert.equal(f.named('legacy-issue').length, 1);
    });
    test('legacy assigned issue without trigger does not remove labels', function () {
        var f = glFixture({ issues: [glIssue(1, [], 'machine')] });
        f.run({ mode: 'legacy', machine: 'machine' });
        var update = f.named('api').filter(function (c) { return c.args[0] === 'PUT'; })[0];
        assert.equal(update.args.indexOf('remove_labels='), -1);
    });
    test('legacy MR review beats rework, merge needs author and green pipeline', function () {
        var f = glFixture({ mrs: [
            { iid: 1, labels: ['agent:review', 'agent:rework'] },
            { iid: 2, labels: ['pr_approved'], author: { username: 'machine' }, head_pipeline: { status: 'success' } },
            { iid: 3, labels: ['pr_approved'], author: { username: 'machine' }, head_pipeline: { status: 'failed' } },
            { iid: 4, labels: ['pr_approved'], author: { username: 'other' }, head_pipeline: { status: 'success' } },
            { iid: 5, labels: ['agent:rework', 'blocked'] }
        ] });
        f.run({ mode: 'legacy', machine: 'machine' });
        assert.deepEqual(f.named('legacy-mr')[0].args, ['1', '.dmtools/runners/fa-review.json', 'agent:review']);
        assert.deepEqual(f.named('merge')[0].args, ['2']);
        assert.equal(f.named('legacy-mr').length, 1);
    });
    test('legacy no-label-addition webhook skips even open actions', function () {
        var f = glFixture({ context: glHook('issue', { iid: 1, action: 'open' }, { labels: { current: [], previous: [] } }) });
        assert.ok(f.run({ mode: 'legacy' }).ignored);
    });
    test('unknown mode fails without touching services', function () {
        var f = glFixture();
        assert.throws(function () { f.run({ mode: 'surprise' }); });
        assert.equal(f.calls.length, 0);
    });
});

suite('GitLab bridge transport', function () {
    test('release entry uses JSRunner and declares the required bash capability', function () {
        var entry = JSON.parse(file_read({ path: 'gitlab_factory_poll.json' }));
        assert.equal(entry.name, 'JSRunner');
        assert.equal(entry.params.jsPath, 'js/gitlabFactoryPoll.js');
        assert.equal(entry.params.envVariables.CLI_ALLOWED_COMMANDS, 'bash');
    });
    test('supports string and structured command output without losing empty stdout', function () {
        assert.equal(glPoll.commandOutput('hello'), 'hello');
        assert.equal(glPoll.commandOutput({ output: 'hello' }), 'hello');
        assert.equal(glPoll.commandOutput({ stdout: 'hello' }), 'hello');
        assert.equal(glPoll.commandOutput({ output: '', stdout: 'wrong' }), '');
        assert.throws(function () { glPoll.commandOutput({ exitCode: 9, output: 'failed' }); });
    });
    test('action accepts direct jobParams and checks inner exit status', function () {
        var m = loadModule('js/gitlabFactoryPoll.js', makeRequire({}, {}), {
            cli_execute_command: function () { return '__DMTOOLS_GITLAB_RESULT__{"exitCode":7,"output":"failure"}'; }
        });
        assert.throws(function () { m.action({ mode: 'automatic' }); });
    });
    test('action accepts wrapper, quotes paths, handles structured CLI output', function () {
        var commands = [];
        var m = loadModule('js/gitlabFactoryPoll.js', makeRequire({}, {}), {
            cli_execute_command: function (args) {
                commands.push(args.command);
                return { output: '__DMTOOLS_GITLAB_RESULT__' + JSON.stringify({
                    exitCode: 0, output: JSON.stringify({ projectId: '7', mrIid: '8', leg: '' })
                }) };
            }
        });
        m.action({ jobParams: { bridgePath: "a'b.sh" } });
        assert.contains(commands[0], "'a'\\''b.sh'");
        assert.contains(commands[1], "'lifecycle' '8' '' ''");
    });
    test('missing envelope, malformed envelope, and transport exceptions fail closed', function () {
        ['garbage', '__DMTOOLS_GITLAB_RESULT__{}'].forEach(function (response) {
            var m = loadModule('js/gitlabFactoryPoll.js', makeRequire({}, {}), { cli_execute_command: function () { return response; } });
            assert.throws(function () { m.action({}); });
        });
        var m = loadModule('js/gitlabFactoryPoll.js', makeRequire({}, {}), { cli_execute_command: function () { throw new Error('transport'); } });
        assert.throws(function () { m.action({}); });
    });
});
