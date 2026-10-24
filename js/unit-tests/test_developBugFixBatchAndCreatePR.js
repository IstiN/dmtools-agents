/**
 * Unit tests for js/developBugFixBatchAndCreatePR.js (gh-1250 characterization).
 *
 * Pins the post-CLI action(): PR discovery/creation, In Review transitions,
 * ai_developed labels, the Epic PR comment, and every non-fatal failure path.
 * Also covers every branch of the shared js/common/bugFixBatchContext.js helper.
 */

function configBlockingFileRead(fileMap) {
    return function(opts) {
        var p = opts && (opts.path || opts);
        if (fileMap && fileMap[p] !== undefined) return fileMap[p];
        // Block all config discovery to prevent loading parent .dmtools/config.js
        if (p && p.indexOf('.dmtools/config') !== -1) return null;
        try { return file_read(opts); } catch (e) { return null; }
    };
}

function loadDevelopBugFix(mocks) {
    var defaults = {
        cli_execute_command: function() { return ''; },
        file_write: function() {},
        file_read: configBlockingFileRead({})
    };
    var g = Object.assign({}, defaults, mocks || {});
    var tracker = g.__tracker;
    var cli = g.cli_execute_command;

    var configLoaderMock = g.__configLoader || {
        loadProjectConfig: function() { return { formats: { prTitle: { development: '{key}' } } }; },
        formatTemplate: function(tpl, vals) { return (vals.ticketKey || '') + ' ' + (vals.ticketSummary || ''); },
        resolvePRTargetBranch: function() { return 'main'; },
        resolveBranchName: function() { return 'dev/PROJ-1-batch'; }
    };
    var trackersMock = { createTracker: function(config, customParams) { return tracker; } };
    var prMock = g.__prHelper || {
        cleanCommandOutput: function(output) { return output; },
        createPullRequest: function(opts) { return { success: true, prUrl: 'https://github.com/acme/repo/pull/42' }; }
    };
    var batchCtxMock = g.__batchContext || {
        findBugsInEpic: function(epicKey) {
            return [
                { key: 'PROJ-2', fields: { summary: 'Bug two' } },
                { key: 'PROJ-3', fields: { summary: 'Bug three' } }
            ];
        }
    };
    // gh-1250: the shared runtime helper is the real module, loaded with its
    // own requires mapped; cli dispatches to the per-test mock.
    var shared = loadModule(
        'js/common/bugFixBatchContext.js',
        makeRequire({
            './pullRequest.js': prMock,
            './configLoader.js': configLoaderMock,
            './trackers.js': trackersMock
        }),
        { cli_execute_command: function(args) { return cli(args); } }
    );
    return loadModule(
        'js/developBugFixBatchAndCreatePR.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/pullRequest.js': prMock,
            './prepareBugFixBatchContext.js': batchCtxMock,
            './config.js': configModule,
            './common/bugFixBatchContext.js': shared
        }),
        g
    );
}

function devTracker(overrides) {
    var calls = { getIssue: [], moveToStatus: [], addLabel: [], postComment: [] };
    var t = {
        calls: calls,
        getIssue: function(key, fields) {
            calls.getIssue.push({ key: key, fields: fields });
            return { key: key, fields: { summary: 'Fetched epic', description: 'Desc', status: { name: 'In Development' } } };
        },
        moveToStatus: function(key, status) { calls.moveToStatus.push({ key: key, status: status }); },
        addLabel: function(key, label) { calls.addLabel.push({ key: key, label: label }); },
        postComment: function(key, body) { calls.postComment.push({ key: key, body: body }); }
    };
    for (var k in (overrides || {})) { t[k] = overrides[k]; }
    return t;
}

function devParams(overrides) {
    return Object.assign({
        inputFolderPath: 'input/PROJ-1',
        ticket: { key: 'PROJ-1', fields: { summary: 'Batch epic' } },
        customParams: {}
    }, overrides || {});
}

suite('developBugFixBatchAndCreatePR — action', function() {

    test('happy path — no existing PR: creates PR, moves epic+bugs to In Review, labels, posts comment', function() {
        var cmds = [];
        var prCalls = [];
        var tracker = devTracker();
        var mod = loadDevelopBugFix({
            __tracker: tracker,
            cli_execute_command: function(args) { cmds.push(args); return ''; },
            __prHelper: {
                cleanCommandOutput: function(o) { return o; },
                createPullRequest: function(opts) { prCalls.push(opts); return { success: true, prUrl: 'https://github.com/acme/repo/pull/42' }; }
            }
        });

        mod.action(devParams());

        assert.equal(cmds.length, 1, 'one gh pr list lookup');
        assert.contains(cmds[0].command, 'gh pr list --head dev/PROJ-1-batch', 'PR lookup scoped to the batch branch');
        assert.equal(prCalls.length, 1, 'PR created when none exists');
        assert.equal(prCalls[0].branchName, 'dev/PROJ-1-batch', 'branch passed through');
        assert.equal(prCalls[0].baseBranch, 'main', 'target branch resolved');
        assert.equal(prCalls[0].ticketKey, 'PROJ-1', 'epic key drives the canonical Closes line');
        assert.equal(prCalls[0].workingDir, null, 'no workingDir in config');
        assert.contains(prCalls[0].bodyContent, 'PROJ-2', 'PR body lists bug keys');
        assert.contains(prCalls[0].bodyContent, 'Batch epic', 'PR body includes the epic summary');

        assert.deepEqual(tracker.calls.moveToStatus, [
            { key: 'PROJ-1', status: 'In Review' },
            { key: 'PROJ-2', status: 'In Review' },
            { key: 'PROJ-3', status: 'In Review' }
        ], 'epic and all bugs moved to In Review');
        assert.deepEqual(tracker.calls.addLabel, [
            { key: 'PROJ-1', label: 'ai_developed' },
            { key: 'PROJ-2', label: 'ai_developed' },
            { key: 'PROJ-3', label: 'ai_developed' }
        ], 'ai_developed label added to epic and all bugs');
        assert.equal(tracker.calls.postComment.length, 1, 'one PR comment on the epic');
        assert.contains(tracker.calls.postComment[0].body, 'https://github.com/acme/repo/pull/42', 'comment carries the PR url');
        assert.contains(tracker.calls.postComment[0].body, 'PROJ-2, PROJ-3', 'comment lists linked bug keys');
    });

    test('existing PR — gh pr list returns a url: no PR created, transitions and comment still happen', function() {
        var prCalls = [];
        var tracker = devTracker();
        var mod = loadDevelopBugFix({
            __tracker: tracker,
            cli_execute_command: function() { return 'https://github.com/acme/repo/pull/7'; },
            __prHelper: {
                cleanCommandOutput: function(o) { return o; },
                createPullRequest: function(opts) { prCalls.push(opts); return { success: true, prUrl: 'x' }; }
            }
        });

        mod.action(devParams());

        assert.equal(prCalls.length, 0, 'no PR created when one already exists');
        assert.equal(tracker.calls.moveToStatus.length, 3, 'transitions still applied');
        assert.contains(tracker.calls.postComment[0].body, 'https://github.com/acme/repo/pull/7', 'existing PR url commented');
    });

    test('gh pr list failure is non-fatal — a new PR is still created', function() {
        var prCalls = [];
        var tracker = devTracker();
        var mod = loadDevelopBugFix({
            __tracker: tracker,
            cli_execute_command: function() { throw new Error('gh down'); },
            __prHelper: {
                cleanCommandOutput: function(o) { return o; },
                createPullRequest: function(opts) { prCalls.push(opts); return { success: true, prUrl: 'https://github.com/acme/repo/pull/9' }; }
            }
        });

        mod.action(devParams());

        assert.equal(prCalls.length, 1, 'PR created despite lookup failure');
        assert.equal(tracker.calls.moveToStatus.length, 3, 'transitions still applied');
    });

    test('non-https gh pr list output is treated as no PR', function() {
        var prCalls = [];
        var tracker = devTracker();
        var mod = loadDevelopBugFix({
            __tracker: tracker,
            cli_execute_command: function() { return 'no pull requests found'; },
            __prHelper: {
                cleanCommandOutput: function(o) { return o; },
                createPullRequest: function(opts) { prCalls.push(opts); return { success: true, prUrl: 'https://github.com/acme/repo/pull/11' }; }
            }
        });

        mod.action(devParams());

        assert.equal(prCalls.length, 1, 'PR created when output is not a url');
    });

    test('PR creation failure is non-fatal — tickets still move and get labelled', function() {
        var tracker = devTracker();
        var mod = loadDevelopBugFix({
            __tracker: tracker,
            __prHelper: {
                cleanCommandOutput: function(o) { return o; },
                createPullRequest: function() { return { success: false, error: 'push rejected' }; }
            }
        });

        mod.action(devParams());

        assert.equal(tracker.calls.postComment.length, 0, 'no comment without a PR url');
        assert.equal(tracker.calls.moveToStatus.length, 3, 'transitions still applied');
        assert.equal(tracker.calls.addLabel.length, 3, 'labels still applied');
    });

    test('ticket without fields is fetched from the tracker', function() {
        var tracker = devTracker();
        var mod = loadDevelopBugFix({ __tracker: tracker });

        mod.action(devParams({ ticket: { key: 'PROJ-1' } }));

        assert.deepEqual(tracker.calls.getIssue, [{ key: 'PROJ-1', fields: ['summary', 'description', 'status', 'labels'] }], 'epic fetched');
    });

    test('epic fetch failure falls back to a key-only epic and still finishes', function() {
        var tracker = devTracker({ getIssue: function() { throw new Error('epic down'); } });
        var mod = loadDevelopBugFix({ __tracker: tracker });

        mod.action(devParams({ ticket: { key: 'PROJ-1' } }));

        assert.equal(tracker.calls.moveToStatus.length, 3, 'transitions still applied');
        assert.equal(tracker.calls.postComment.length, 1, 'PR comment still posted');
    });

    test('jobParams form is unwrapped before resolution', function() {
        var tracker = devTracker();
        var mod = loadDevelopBugFix({ __tracker: tracker });

        mod.action({ jobParams: devParams() });

        assert.equal(tracker.calls.moveToStatus.length, 3, 'action ran against the nested params');
    });

    test('moveToStatus failure on one ticket does not block the rest', function() {
        var tracker = devTracker();
        var originalMove = tracker.moveToStatus;
        tracker.moveToStatus = function(key, status) {
            tracker.calls.moveToStatus.push({ key: key, status: status });
            if (key === 'PROJ-2') { throw new Error('transition rejected'); }
        };
        var mod = loadDevelopBugFix({ __tracker: tracker });

        mod.action(devParams());

        assert.deepEqual(tracker.calls.moveToStatus.map(function(c) { return c.key; }), ['PROJ-1', 'PROJ-2', 'PROJ-3'], 'every key attempted');
        assert.equal(tracker.calls.addLabel.length, 3, 'labels still applied');
    });

    test('addLabel failure is non-fatal', function() {
        var tracker = devTracker({ addLabel: function() { throw new Error('label rejected'); } });
        var mod = loadDevelopBugFix({ __tracker: tracker });

        mod.action(devParams());

        assert.equal(tracker.calls.moveToStatus.length, 3, 'transitions still applied');
    });

    test('postComment failure is non-fatal', function() {
        var tracker = devTracker({ postComment: function() { throw new Error('comment rejected'); } });
        var mod = loadDevelopBugFix({ __tracker: tracker });

        mod.action(devParams());

        assert.equal(tracker.calls.moveToStatus.length, 3, 'transitions still applied');
    });

    test('config load failure propagates (hard error)', function() {
        var mod = loadDevelopBugFix({
            __tracker: devTracker(),
            __configLoader: {
                loadProjectConfig: function() { throw new Error('bad config'); },
                formatTemplate: function() { return ''; },
                resolvePRTargetBranch: function() { return 'main'; },
                resolveBranchName: function() { return 'dev'; }
            }
        });

        assert.throws(function() { mod.action(devParams()); }, 'action rethrows config failures');
    });

    test('workingDir from config is applied to the gh pr list command', function() {
        var cmds = [];
        var tracker = devTracker();
        var mod = loadDevelopBugFix({
            __tracker: tracker,
            cli_execute_command: function(args) { cmds.push(args); return ''; },
            __configLoader: {
                loadProjectConfig: function() { return { workingDir: '/tmp/ws', formats: { prTitle: { development: '{key}' } } }; },
                formatTemplate: function(tpl, vals) { return vals.ticketKey; },
                resolvePRTargetBranch: function() { return 'main'; },
                resolveBranchName: function() { return 'dev/PROJ-1-batch'; }
            }
        });

        mod.action(devParams());

        assert.equal(cmds[0].workingDirectory, '/tmp/ws', 'workingDirectory applied to the PR lookup');
    });
});

suite('developBugFixBatchAndCreatePR — buildPRBody and ensurePRExists', function() {

    test('buildPRBody renders epic, bugs, and the empty-bugs placeholder', function() {
        var mod = loadDevelopBugFix({ __tracker: devTracker() });

        var body = mod.buildPRBody(
            { key: 'PROJ-1', fields: { summary: 'Epic summary', description: 'Epic description' } },
            [{ key: 'PROJ-2', fields: { summary: 'Bug two' } }, { key: 'PROJ-3', fields: {} }]
        );
        assert.contains(body, '**PROJ-1**: Epic summary', 'epic key and summary');
        assert.contains(body, 'Epic description', 'epic description included');
        assert.contains(body, '- **PROJ-2** — Bug two', 'bug with summary');
        assert.contains(body, '- **PROJ-3** — (no summary)', 'missing summary falls back');

        var noDesc = mod.buildPRBody({ key: 'PROJ-1', fields: { summary: 'S' } }, []);
        assert.notContains(noDesc, 'Epic description', 'no description section without a description');
        assert.contains(noDesc, '_No bugs listed._', 'empty bugs placeholder');
    });

    test('ensurePRExists short-circuits when a PR already exists', function() {
        var prCalls = [];
        var mod = loadDevelopBugFix({
            __tracker: devTracker(),
            cli_execute_command: function() { return 'https://github.com/acme/repo/pull/5'; },
            __prHelper: {
                cleanCommandOutput: function(o) { return o; },
                createPullRequest: function(opts) { prCalls.push(opts); return { success: true }; }
            }
        });
        var result = mod.ensurePRExists('dev/PROJ-1-batch', { key: 'PROJ-1', fields: {} }, { formats: { prTitle: { development: '{key}' } } }, []);
        assert.deepEqual(result, { success: true, prUrl: 'https://github.com/acme/repo/pull/5', alreadyExisted: true }, 'existing PR reported');
        assert.equal(prCalls.length, 0, 'no PR created');
    });

    test('ensurePRExists creates a PR with the formatted title and batch body', function() {
        var prCalls = [];
        var mod = loadDevelopBugFix({
            __tracker: devTracker(),
            cli_execute_command: function() { return ''; },
            __prHelper: {
                cleanCommandOutput: function(o) { return o; },
                createPullRequest: function(opts) { prCalls.push(opts); return { success: true, prUrl: 'https://github.com/acme/repo/pull/8' }; }
            }
        });
        var config = { workingDir: '/tmp/x', formats: { prTitle: { development: '{key}: {summary}' } } };
        var result = mod.ensurePRExists('dev/PROJ-1-batch', { key: 'PROJ-1', fields: { summary: 'Batch epic' } }, config,
            [{ key: 'PROJ-2', fields: { summary: 'Bug two' } }]);
        assert.equal(result.success, true, 'PR creation succeeded');
        assert.equal(prCalls[0].title, 'PROJ-1 Batch epic', 'formatted title used');
        assert.equal(prCalls[0].tempBodyFile, 'pr_body_tmp_batch.md', 'batch body temp file');
        assert.equal(prCalls[0].workingDir, '/tmp/x', 'workingDir passed through');
        assert.contains(prCalls[0].bodyContent, 'PROJ-2', 'body lists the bugs');
    });

    test('ensurePRExists falls back to key + summary title when the template yields nothing', function() {
        var prCalls = [];
        var mod = loadDevelopBugFix({
            __tracker: devTracker(),
            cli_execute_command: function() { return ''; },
            __configLoader: {
                loadProjectConfig: function() { return {}; },
                formatTemplate: function() { return ''; },
                resolvePRTargetBranch: function() { return 'main'; },
                resolveBranchName: function() { return 'dev'; }
            },
            __prHelper: {
                cleanCommandOutput: function(o) { return o; },
                createPullRequest: function(opts) { prCalls.push(opts); return { success: true, prUrl: 'u' }; }
            }
        });
        mod.ensurePRExists('dev/PROJ-1-batch', { key: 'PROJ-1', fields: { summary: 'Batch epic' } }, { formats: { prTitle: { development: '{key}' } } }, []);
        assert.equal(prCalls[0].title, 'PROJ-1 Batch epic', 'key + summary fallback title');
    });
});

// ── Shared runtime helper (gh-1250): every branch of js/common/bugFixBatchContext.js ──

function loadSharedForDev(opts) {
    opts = opts || {};
    var tracker = devTracker(opts.trackerOverrides);
    var cli = opts.cli || function() { return ''; };
    var shared = loadModule(
        'js/common/bugFixBatchContext.js',
        makeRequire({
            './pullRequest.js': opts.prMock || { cleanCommandOutput: function(o) { return o; } },
            './configLoader.js': opts.configLoader || { loadProjectConfig: function() { return {}; } },
            './trackers.js': { createTracker: function() { return tracker; } }
        }),
        { cli_execute_command: function(args) { return cli(args); } }
    );
    return { shared: shared, tracker: tracker };
}

suite('common/bugFixBatchContext — runCmd and cleanCommandOutput', function() {

    test('runCmd wraps a bare string command and returns cli output', function() {
        var calls = [];
        var ctx = loadSharedForDev({ cli: function(args) { calls.push(args); return 'out'; } });
        assert.equal(ctx.shared.runCmd('git status'), 'out', 'cli output returned');
        assert.deepEqual(calls, [{ command: 'git status' }], 'string wrapped into a command arg');
    });

    test('runCmd leaves an object arg untouched when no workingDir is set', function() {
        var calls = [];
        var ctx = loadSharedForDev({ cli: function(args) { calls.push(args); return ''; } });
        ctx.shared.runCmd({ command: 'ls', extra: 1 });
        assert.deepEqual(calls, [{ command: 'ls', extra: 1 }], 'object arg passed through');
    });

    test('setWorkingDir applies workingDirectory until reset', function() {
        var calls = [];
        var ctx = loadSharedForDev({ cli: function(args) { calls.push(args); return ''; } });
        ctx.shared.setWorkingDir('/tmp/wd');
        ctx.shared.runCmd('pwd');
        ctx.shared.setWorkingDir(null);
        ctx.shared.runCmd('pwd');
        assert.deepEqual(calls, [
            { command: 'pwd', workingDirectory: '/tmp/wd' },
            { command: 'pwd' }
        ], 'workingDirectory applied only while set');
    });

    test('cleanCommandOutput delegates to the pullRequest helper', function() {
        var seen = [];
        var ctx = loadSharedForDev({
            prMock: { cleanCommandOutput: function(o) { seen.push(o); return '<clean>'; } }
        });
        assert.equal(ctx.shared.cleanCommandOutput('warn: x'), '<clean>', 'helper result returned');
        assert.deepEqual(seen, ['warn: x'], 'raw output passed through');
    });
});

suite('common/bugFixBatchContext — resolveBatchParams and resolveBatchEpic', function() {

    test('resolveBatchParams: top-level, jobParams, and bare forms', function() {
        var ctx = loadSharedForDev();
        var top = { inputFolderPath: 'input/PROJ-1' };
        assert.equal(ctx.shared.resolveBatchParams(top), top, 'top-level form used as-is');
        var job = { jobParams: { inputFolderPath: 'input/PROJ-1' } };
        assert.equal(ctx.shared.resolveBatchParams(job), job.jobParams, 'jobParams unwrapped');
        var bare = { customParams: {} };
        assert.equal(ctx.shared.resolveBatchParams(bare), bare, 'bare params returned');
    });

    test('resolveBatchEpic keeps an epic with fields without calling the tracker', function() {
        var ctx = loadSharedForDev();
        var epic = { key: 'PROJ-1', fields: { summary: 's' } };
        assert.equal(ctx.shared.resolveBatchEpic(ctx.tracker, 'PROJ-1', epic), epic, 'epic returned as-is');
        assert.equal(ctx.tracker.calls.getIssue.length, 0, 'tracker not consulted');
    });

    test('resolveBatchEpic fetches on missing fields and degrades to key-only on failure', function() {
        var ctx = loadSharedForDev();
        var fetched = ctx.shared.resolveBatchEpic(ctx.tracker, 'PROJ-1', { key: 'PROJ-1' });
        assert.deepEqual(ctx.tracker.calls.getIssue, [{ key: 'PROJ-1', fields: ['summary', 'description', 'status', 'labels'] }], 'fetch attempted');
        assert.equal(fetched.fields.summary, 'Fetched epic', 'fetched epic returned');

        var failing = loadSharedForDev({ trackerOverrides: { getIssue: function() { throw new Error('down'); } } });
        var fallback = failing.shared.resolveBatchEpic(failing.tracker, 'PROJ-1', { key: 'PROJ-1' });
        assert.deepEqual(fallback, { key: 'PROJ-1', fields: {} }, 'key-only fallback epic');
    });
});

suite('common/bugFixBatchContext — resolveBatchActionContext', function() {

    test('resolves params, config, tracker, epic folder/key/epic in one call', function() {
        var ctx = loadSharedForDev();
        var epic = { key: 'PROJ-1', fields: { summary: 's' } };
        var params = { inputFolderPath: 'input/PROJ-1', ticket: epic };
        var out = ctx.shared.resolveBatchActionContext(params);
        assert.equal(out.actualParams, params, 'top-level params used as-is');
        assert.equal(out.tracker, ctx.tracker, 'tracker created via trackers module');
        assert.equal(out.epicFolder, 'input/PROJ-1', 'folder from params');
        assert.equal(out.epicKey, 'PROJ-1', 'key from folder tail');
        assert.equal(out.epic, epic, 'ticket with fields kept');
    });

    test('applies the config workingDir to commands issued afterwards', function() {
        var calls = [];
        var ctx = loadSharedForDev({
            cli: function(args) { calls.push(args); return ''; },
            configLoader: { loadProjectConfig: function() { return { workingDir: '/tmp/ctx-ws' }; } }
        });
        ctx.shared.resolveBatchActionContext({ inputFolderPath: 'input/PROJ-1', ticket: { key: 'PROJ-1', fields: {} } });
        ctx.shared.runCmd('ls');
        assert.deepEqual(calls, [{ command: 'ls', workingDirectory: '/tmp/ctx-ws' }], 'workingDir applied');
    });
});

suite('configBlockingFileRead — mock contract (CRAP coverage)', function() {
    test('returns the mapped value for a mapped path', function() {
        var fr = configBlockingFileRead({ 'input/PROJ-1/x.md': 'hello' });
        assert.equal(fr({ path: 'input/PROJ-1/x.md' }), 'hello');
        assert.equal(fr('input/PROJ-1/x.md'), 'hello', 'string arg form resolves the same key');
    });

    test('blocks .dmtools/config discovery even when unmapped', function() {
        var fr = configBlockingFileRead({});
        assert.equal(fr({ path: 'repo/.dmtools/config.js' }), null, 'project config never leaks in');
    });

    test('falls back to the real file_read: existing repo file reads, missing file degrades to null', function() {
        var fr = configBlockingFileRead({});
        var content = fr({ path: 'js/common/bugFixBatchContext.js' });
        assert.ok(content && content.indexOf('mergeObjects') !== -1 || content !== null, 'existing repo file returns real content');
        assert.equal(fr({ path: 'definitely/not/here.txt' }), null, 'unreadable file degrades to null');
    });
});
