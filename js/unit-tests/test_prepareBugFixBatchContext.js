/**
 * Unit tests for js/prepareBugFixBatchContext.js (gh-1228 CRAP characterization).
 *
 * Pins the pre-CLI action(): batch bug discovery, per-bug context fetch,
 * batch_bugs.md rendering, In Development transition, and every non-fatal
 * failure path.
 */

function loadBugFixBatchContext(mocks) {
    var defaults = {
        cli_execute_command: function() { return ''; },
        file_write: function() {},
        file_read: function() { return null; }
    };
    var g = Object.assign({}, defaults, mocks || {});
    var tracker = g.__tracker;
    var cli = g.cli_execute_command;
    var configLoaderMock = g.__configLoader || { loadProjectConfig: function() {
        return { jira: { statuses: { IN_DEVELOPMENT: 'In Development' } } };
    } };
    // gh-1250: the shared runtime helper is the real module, loaded with its
    // own requires mapped; cli dispatches to the per-test mock.
    var shared = loadModule(
        'js/common/bugFixBatchContext.js',
        makeRequire({
            './pullRequest.js': { cleanCommandOutput: function(output) { return output; } },
            './configLoader.js': configLoaderMock,
            './trackers.js': { createTracker: function(config, customParams) { return tracker; } }
        }),
        { cli_execute_command: function(args) { return cli(args); } }
    );
    return loadModule(
        'js/prepareBugFixBatchContext.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/pullRequest.js': { cleanCommandOutput: function(output) { return output; } },
            './fetchQuestionsToInput.js': g.__fetchQuestions || { action: function() {} },
            './fetchLinkedTestsToInput.js': g.__fetchTests || { action: function() {} },
            './config.js': configModule,
            './common/trackers.js': { createTracker: function(config, customParams) { return tracker; } },
            './common/bugFixBatchContext.js': shared
        }),
        g
    );
}

function batchTracker(overrides) {
    var calls = { searchIssues: [], getIssue: [], moveToStatus: [] };
    var t = {
        calls: calls,
        searchIssues: function(jql, opts) {
            calls.searchIssues.push({ jql: jql, opts: opts });
            return [
                { key: 'PROJ-2', fields: { summary: 'Bug two', status: { name: 'To Do' }, issuetype: { name: 'Bug' } } },
                { key: 'PROJ-3', fields: { summary: 'Bug three', status: { name: 'In Progress' }, issuetype: { name: 'Bug' } } },
                { key: 'PROJ-4', fields: { summary: 'Not a bug', issuetype: { name: 'Story' } } }
            ];
        },
        getIssue: function(key, fields) {
            calls.getIssue.push({ key: key, fields: fields });
            return { key: key, fields: { summary: 'Epic summary', description: 'Epic description', status: { name: 'To Do' } } };
        },
        moveToStatus: function(key, status) { calls.moveToStatus.push({ key: key, status: status }); }
    };
    for (var k in (overrides || {})) { t[k] = overrides[k]; }
    return t;
}

function batchParams(overrides) {
    return Object.assign({
        inputFolderPath: 'input/PROJ-1',
        ticket: { key: 'PROJ-1', fields: { summary: 'Batch epic' } },
        jobParams: {}
    }, overrides || {});
}

suite('prepareBugFixBatchContext — action', function() {

    test('happy path — filters to Bug issues, fetches per-bug context, writes batch_bugs.md, moves epic', function() {
        var writes = {};
        var cmds = [];
        var questions = [];
        var tests = [];
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({
            __tracker: tracker,
            cli_execute_command: function(args) { cmds.push(args); return ''; },
            file_write: function(p, c) { writes[p] = c; },
            __fetchQuestions: { action: function(p) { questions.push(p.ticket.key); } },
            __fetchTests: { action: function(p) { tests.push(p.ticket.key); } }
        });

        mod.action(batchParams());

        assert.equal(tracker.calls.searchIssues.length, 1, 'one JQL search');
        assert.contains(tracker.calls.searchIssues[0].jql, configModule.LABELS.BUG_FIX_BATCH, 'JQL filters by the batch label');
        assert.contains(tracker.calls.searchIssues[0].jql, 'PROJ-1', 'JQL scoped to the epic');
        assert.deepEqual(questions.sort(), ['PROJ-2', 'PROJ-3'], 'questions fetched for Bug issues only');
        assert.deepEqual(tests.sort(), ['PROJ-2', 'PROJ-3'], 'linked tests fetched for Bug issues only');
        var md = writes['input/PROJ-1/batch_bugs.md'];
        assert.ok(md, 'batch_bugs.md written into the epic input folder');
        assert.contains(md, 'PROJ-2', 'bug listed');
        assert.contains(md, 'PROJ-3', 'bug listed');
        assert.notContains(md, 'PROJ-4', 'non-Bug issue not listed');
        assert.contains(md, '# Bug-fix Batch — PROJ-1', 'epic header');
        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-1', status: 'In Development' }], 'epic moved to In Development');
        assert.equal(cmds.length, 2, 'one mkdir per bug input folder');
    });

    test('epic without fields is fetched from the tracker', function() {
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({ __tracker: tracker, file_write: function() {} });

        mod.action(batchParams({ ticket: { key: 'PROJ-1' } }));

        assert.deepEqual(tracker.calls.getIssue, [{ key: 'PROJ-1', fields: ['summary', 'description', 'status', 'labels'] }], 'epic fetched with the field list');
    });

    test('epic fetch failure falls back to a key-only epic and still writes the batch file', function() {
        var writes = {};
        var tracker = batchTracker({
            getIssue: function() { throw new Error('epic fetch down'); }
        });
        var mod = loadBugFixBatchContext({ __tracker: tracker, file_write: function(p, c) { writes[p] = c; } });

        mod.action(batchParams({ ticket: { key: 'PROJ-1' } }));

        var md = writes['input/PROJ-1/batch_bugs.md'];
        assert.ok(md, 'batch_bugs.md still written');
        assert.contains(md, '# Bug-fix Batch — PROJ-1', 'fallback epic key used');
        assert.notContains(md, 'Epic summary', 'fetched summary not present');
    });

    test('search failure yields an empty batch with the no-bugs placeholder and still moves the epic', function() {
        var writes = {};
        var fetched = [];
        var tracker = batchTracker({
            searchIssues: function() { throw new Error('jql down'); }
        });
        var mod = loadBugFixBatchContext({
            __tracker: tracker,
            file_write: function(p, c) { writes[p] = c; },
            __fetchQuestions: { action: function(p) { fetched.push(p.ticket.key); } }
        });

        mod.action(batchParams());

        assert.contains(writes['input/PROJ-1/batch_bugs.md'], '_No bug-fix batch bugs found for this Epic._', 'placeholder rendered');
        assert.equal(fetched.length, 0, 'no per-bug fetches');
        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-1', status: 'In Development' }], 'epic still moved');
    });

    test('per-bug question fetch failure is non-fatal — linked tests still fetched', function() {
        var tests = [];
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({
            __tracker: tracker,
            file_write: function() {},
            __fetchQuestions: { action: function() { throw new Error('questions down'); } },
            __fetchTests: { action: function(p) { tests.push(p.ticket.key); } }
        });

        mod.action(batchParams());

        assert.deepEqual(tests.sort(), ['PROJ-2', 'PROJ-3'], 'linked tests still fetched for every bug');
        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-1', status: 'In Development' }], 'epic still moved');
    });

    test('per-bug linked-tests fetch failure is non-fatal', function() {
        var questions = [];
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({
            __tracker: tracker,
            file_write: function() {},
            __fetchQuestions: { action: function(p) { questions.push(p.ticket.key); } },
            __fetchTests: { action: function() { throw new Error('tests down'); } }
        });

        mod.action(batchParams());

        assert.deepEqual(questions.sort(), ['PROJ-2', 'PROJ-3'], 'questions still fetched for every bug');
        assert.equal(tracker.calls.moveToStatus.length, 1, 'epic still moved');
    });

    test('mkdir failure is non-fatal', function() {
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({
            __tracker: tracker,
            file_write: function() {},
            cli_execute_command: function() { throw new Error('mkdir failed'); }
        });

        mod.action(batchParams());

        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-1', status: 'In Development' }], 'epic still moved');
    });

    test('moveToStatus failure is non-fatal', function() {
        var writes = {};
        var tracker = batchTracker({
            moveToStatus: function() { throw new Error('transition rejected'); }
        });
        var mod = loadBugFixBatchContext({ __tracker: tracker, file_write: function(p, c) { writes[p] = c; } });

        mod.action(batchParams());

        assert.ok(writes['input/PROJ-1/batch_bugs.md'], 'batch_bugs.md still written');
    });

    test('config load failure propagates (hard error)', function() {
        var mod = loadBugFixBatchContext({
            __tracker: batchTracker(),
            __configLoader: { loadProjectConfig: function() { throw new Error('bad config'); } }
        });

        assert.throws(function() { mod.action(batchParams()); }, 'action rethrows config failures');
    });

    test('workingDir from config is passed to every command', function() {
        var cmds = [];
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({
            __tracker: tracker,
            file_write: function() {},
            cli_execute_command: function(args) { cmds.push(args); return ''; },
            __configLoader: { loadProjectConfig: function() {
                return { workingDir: '/tmp/workspace', jira: { statuses: { IN_DEVELOPMENT: 'In Development' } } };
            } }
        });

        mod.action(batchParams());

        assert.equal(cmds.length, 2, 'one command per bug folder');
        assert.equal(cmds[0].workingDirectory, '/tmp/workspace', 'workingDirectory applied');
    });
});

suite('prepareBugFixBatchContext — findBugsInEpic and rendering', function() {

    test('findBugsInEpic with an explicit tracker skips tracker creation', function() {
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({ __tracker: tracker });
        var created = [];
        var originalCreate = tracker;
        // Sanity: direct call with explicit tracker
        var bugs = mod.findBugsInEpic('PROJ-1', originalCreate, { jira: {} });
        assert.equal(bugs.length, 2, 'only Bug issues kept');
        assert.equal(bugs[0].key, 'PROJ-2', 'first bug');
    });

    test('issuetype read failure filters the issue out instead of throwing', function() {
        var tracker = batchTracker({
            searchIssues: function() {
                return [
                    { key: 'PROJ-2', fields: { summary: 'Broken issuetype' } }, // fields.issuetype undefined
                    { key: 'PROJ-3', fields: { issuetype: { name: 'Bug' } } }
                ];
            }
        });
        var mod = loadBugFixBatchContext({ __tracker: tracker });
        var bugs = mod.findBugsInEpic('PROJ-1', tracker, {});
        assert.deepEqual(bugs.map(function(b) { return b.key; }), ['PROJ-3'], 'unreadable issuetype filtered out');
    });

    test('writeBatchBugsMarkdown includes the epic description when present and omits the section when not', function() {
        var writes = {};
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({ __tracker: tracker, file_write: function(p, c) { writes[p] = c; } });

        mod.writeBatchBugsMarkdown('input/PROJ-1', { key: 'PROJ-1', fields: { summary: 'S', description: 'Long epic description' } },
            [{ key: 'PROJ-2', fields: { summary: 'Bug two', status: { name: 'To Do' } } }]);
        var withDesc = writes['input/PROJ-1/batch_bugs.md'];
        assert.contains(withDesc, '### Epic Description', 'description section rendered');
        assert.contains(withDesc, 'Long epic description', 'description body included');
        assert.contains(withDesc, 'Status: To Do', 'bug status rendered');
        assert.contains(withDesc, 'input/PROJ-2/', 'bug input folder rendered');

        mod.writeBatchBugsMarkdown('input/PROJ-1', { key: 'PROJ-1', fields: { summary: 'S' } },
            [{ key: 'PROJ-2', fields: {} }]);
        var noDesc = writes['input/PROJ-1/batch_bugs.md'];
        assert.notContains(noDesc, '### Epic Description', 'no description section without a description');
        assert.contains(noDesc, '(no summary)', 'missing bug summary falls back');
        assert.contains(noDesc, 'Status: Unknown', 'missing bug status falls back');
    });

    test('writeBatchBugsMarkdown with an empty bug list renders the placeholder', function() {
        var writes = {};
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({ __tracker: tracker, file_write: function(p, c) { writes[p] = c; } });

        mod.writeBatchBugsMarkdown('input/PROJ-1', { key: 'PROJ-1', fields: {} }, []);
        assert.contains(writes['input/PROJ-1/batch_bugs.md'], '_No bug-fix batch bugs found for this Epic._', 'placeholder rendered');
    });
});

// ── Extracted action-step helpers (gh-1228 CRAP split) ──────────────────────

suite('prepareBugFixBatchContext — extracted step helpers', function() {

    test('resolveBatchParams prefers the top-level inputFolderPath form', function() {
        var mod = loadBugFixBatchContext({ __tracker: batchTracker() });
        var topLevel = { inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1' } };
        assert.equal(mod.resolveBatchParams(topLevel), topLevel, 'top-level params used as-is');
        var job = { jobParams: { inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1' } } };
        assert.equal(mod.resolveBatchParams(job), job.jobParams, 'jobParams form unwrapped');
        var bare = { customParams: {} };
        assert.equal(mod.resolveBatchParams(bare), bare, 'no inputFolderPath and no jobParams → params themselves');
    });

    test('resolveBatchEpic keeps an epic that already carries fields', function() {
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({ __tracker: tracker });
        var epic = { key: 'PROJ-1', fields: { summary: 'already loaded' } };
        assert.equal(mod.resolveBatchEpic(tracker, 'PROJ-1', epic), epic, 'fields present — no fetch');
        assert.equal(tracker.calls.getIssue.length, 0, 'tracker not consulted');
    });

    test('moveEpicToInDevelopment moves and reports the target status', function() {
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({ __tracker: tracker });
        mod.moveEpicToInDevelopment(tracker, 'PROJ-1', { IN_DEVELOPMENT: 'In Development' });
        assert.deepEqual(tracker.calls.moveToStatus, [{ key: 'PROJ-1', status: 'In Development' }], 'moved');
    });

    test('fetchBatchBugContexts fetches every bug with the shared jobParams', function() {
        var fetched = [];
        var tracker = batchTracker();
        var mod = loadBugFixBatchContext({
            __tracker: tracker,
            __fetchQuestions: { action: function(p) { fetched.push('q:' + p.ticket.key); } }
        });
        mod.fetchBatchBugContexts(
            [{ key: 'PROJ-2' }, { key: 'PROJ-3' }],
            { inputFolderPath: 'input/x', jobParams: {} }
        );
        assert.deepEqual(fetched.sort(), ['q:PROJ-2', 'q:PROJ-3'], 'both bugs fetched');
    });
});

// ── Shared runtime helper (gh-1250): every branch of js/common/bugFixBatchContext.js ──

function loadSharedHelper(cli) {
    var tracker = batchTracker();
    var shared = loadModule(
        'js/common/bugFixBatchContext.js',
        makeRequire({
            './pullRequest.js': { cleanCommandOutput: function(output) { return output; } },
            './configLoader.js': { loadProjectConfig: function() {
                return { workingDir: null, jira: { statuses: { IN_DEVELOPMENT: 'In Development' } } };
            } },
            './trackers.js': { createTracker: function(config, customParams) { return tracker; } }
        }),
        { cli_execute_command: cli || function() { return ''; } }
    );
    return { shared: shared, tracker: tracker };
}

suite('common/bugFixBatchContext — runCmd and cleanCommandOutput', function() {

    test('runCmd wraps a bare string command and calls cli_execute_command', function() {
        var calls = [];
        var ctx = loadSharedHelper(function(args) { calls.push(args); return 'out'; });
        var out = ctx.shared.runCmd('git status');
        assert.equal(out, 'out', 'cli output returned');
        assert.deepEqual(calls, [{ command: 'git status' }], 'string wrapped into a command arg');
    });

    test('runCmd passes an object arg through unchanged when no workingDir is set', function() {
        var calls = [];
        var ctx = loadSharedHelper(function(args) { calls.push(args); return ''; });
        ctx.shared.runCmd({ command: 'ls', other: 1 });
        assert.deepEqual(calls, [{ command: 'ls', other: 1 }], 'object arg untouched');
    });

    test('setWorkingDir applies workingDirectory to subsequent commands; null resets it', function() {
        var calls = [];
        var ctx = loadSharedHelper(function(args) { calls.push(args); return ''; });
        ctx.shared.setWorkingDir('/tmp/ws');
        ctx.shared.runCmd('pwd');
        ctx.shared.setWorkingDir(null);
        ctx.shared.runCmd('pwd');
        assert.deepEqual(calls, [
            { command: 'pwd', workingDirectory: '/tmp/ws' },
            { command: 'pwd' }
        ], 'workingDirectory applied only while set');
    });

    test('cleanCommandOutput delegates to the pullRequest helper', function() {
        var seen = [];
        var tracker = batchTracker();
        var shared = loadModule(
            'js/common/bugFixBatchContext.js',
            makeRequire({
                './pullRequest.js': { cleanCommandOutput: function(output) { seen.push(output); return '<cleaned>'; } },
                './configLoader.js': { loadProjectConfig: function() { return {}; } },
                './trackers.js': { createTracker: function() { return tracker; } }
            }),
            { cli_execute_command: function() { return ''; } }
        );
        var out = shared.cleanCommandOutput('warn: x\nreal');
        assert.equal(out, '<cleaned>', 'helper result returned');
        assert.deepEqual(seen, ['warn: x\nreal'], 'raw output passed through');
    });
});

suite('common/bugFixBatchContext — resolveBatchActionContext', function() {

    test('top-level params: config, tracker, epic folder/key/epic all resolved', function() {
        var ctx = loadSharedHelper();
        var epic = { key: 'PROJ-1', fields: { summary: 'loaded' } };
        var params = { inputFolderPath: 'input/PROJ-1', ticket: epic, customParams: {} };
        var out = ctx.shared.resolveBatchActionContext(params);
        assert.equal(out.actualParams, params, 'top-level params used as-is');
        assert.equal(out.tracker, ctx.tracker, 'tracker created via trackers module');
        assert.equal(out.epicFolder, 'input/PROJ-1', 'epic folder taken from params');
        assert.equal(out.epicKey, 'PROJ-1', 'epic key derived from the folder');
        assert.equal(out.epic, epic, 'ticket with fields used without a fetch');
        assert.equal(ctx.tracker.calls.getIssue.length, 0, 'no epic fetch');
    });

    test('jobParams form is unwrapped before resolution', function() {
        var ctx = loadSharedHelper();
        var job = { jobParams: { inputFolderPath: 'input/PROJ-9', ticket: { key: 'PROJ-9', fields: {} } } };
        var out = ctx.shared.resolveBatchActionContext(job);
        assert.equal(out.actualParams, job.jobParams, 'jobParams unwrapped');
        assert.equal(out.epicKey, 'PROJ-9', 'epic key from nested params');
    });

    test('epic without fields is fetched; a failed fetch degrades to a key-only epic', function() {
        var fetched = loadSharedHelper();
        var out = fetched.shared.resolveBatchActionContext({ inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1' } });
        assert.deepEqual(fetched.tracker.calls.getIssue,
            [{ key: 'PROJ-1', fields: ['summary', 'description', 'status', 'labels'] }], 'epic fetched');
        assert.equal(out.epic.fields.summary, 'Epic summary', 'fetched epic returned');

        var failing = batchTracker({ getIssue: function() { throw new Error('down'); } });
        var tracker = failing;
        var shared = loadModule(
            'js/common/bugFixBatchContext.js',
            makeRequire({
                './pullRequest.js': { cleanCommandOutput: function(o) { return o; } },
                './configLoader.js': { loadProjectConfig: function() { return {}; } },
                './trackers.js': { createTracker: function() { return tracker; } }
            }),
            { cli_execute_command: function() { return ''; } }
        );
        var out2 = shared.resolveBatchActionContext({ inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1' } });
        assert.deepEqual(out2.epic, { key: 'PROJ-1', fields: {} }, 'key-only fallback epic');
    });

    test('config workingDir is applied to commands issued after resolution', function() {
        var calls = [];
        var tracker = batchTracker();
        var shared = loadModule(
            'js/common/bugFixBatchContext.js',
            makeRequire({
                './pullRequest.js': { cleanCommandOutput: function(o) { return o; } },
                './configLoader.js': { loadProjectConfig: function() { return { workingDir: '/tmp/epic-ws' }; } },
                './trackers.js': { createTracker: function() { return tracker; } }
            }),
            { cli_execute_command: function(args) { calls.push(args); return ''; } }
        );
        shared.resolveBatchActionContext({ inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1', fields: {} } });
        shared.runCmd('ls');
        assert.deepEqual(calls, [{ command: 'ls', workingDirectory: '/tmp/epic-ws' }], 'workingDir applied');
    });
});
