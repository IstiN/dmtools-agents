/**
 * Unit tests for bug-fix batch development actions.
 */

function makeEpic(key) {
    return {
        key: key,
        fields: {
            summary: 'Batch epic ' + key,
            description: 'Fixes a cluster of related bugs.',
            status: { name: 'Ready For Development' },
            labels: ['bug_fix_batch']
        }
    };
}

function makeBug(key) {
    return {
        key: key,
        fields: {
            summary: 'Bug ' + key,
            status: { name: 'Ready For Development' },
            description: 'Something is broken.',
            labels: ['bug_fix_batch'],
            issuetype: { name: 'Bug' }
        }
    };
}

function loadPrepareBugFixBatchContext(mocks) {
    mocks = mocks || {};
    var writes = {};
    var fetchCalls = [];
    var moves = [];

    var allMocks = Object.assign({
        cli_execute_command: function(args) {
            if (typeof args === 'string') return '';
            return '';
        },
        file_write: function(path, content) {
            writes[path] = content;
        },
        jira_move_to_status: function(args) { moves.push(args); },
        jira_search_by_jql: function() { return []; },
        jira_get_ticket: function(args) { return makeEpic(args.key); }
    }, mocks);

    var fetchQuestionsStub = { action: function(p) { fetchCalls.push({ name: 'questions', params: p }); } };
    var fetchLinkedTestsStub = { action: function(p) { fetchCalls.push({ name: 'linkedTests', params: p }); } };

    var mod = loadModule(
        'js/prepareBugFixBatchContext.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './fetchQuestionsToInput.js': fetchQuestionsStub,
            './fetchLinkedTestsToInput.js': fetchLinkedTestsStub
        }),
        allMocks
    );

    return {
        mod: mod,
        writes: writes,
        fetchCalls: fetchCalls,
        moves: moves
    };
}

function loadDevelopBugFixBatchAndCreatePR(mocks) {
    mocks = mocks || {};
    var moves = [];
    var labels = [];
    var comments = [];
    var commands = [];
    var prCreated = [];

    var allMocks = Object.assign({
        cli_execute_command: function(args) {
            var cmd = typeof args === 'string' ? args : args.command;
            commands.push(cmd);
            if (cmd.indexOf('gh pr list --head ') === 0) return '';
            return '';
        },
        jira_move_to_status: function(args) { moves.push(args); },
        jira_add_label: function(args) { labels.push(args); },
        jira_post_comment: function(args) { comments.push(args); },
        jira_search_by_jql: function() { return []; },
        jira_get_ticket: function(args) { return makeEpic(args.key); }
    }, mocks);

    var prHelperStub = {
        createPullRequest: function(opts) {
            prCreated.push(opts);
            return { success: true, prUrl: 'https://github.com/IstiN/trackstate/pull/9999' };
        }
    };

    var mod = loadModule(
        'js/developBugFixBatchAndCreatePR.js',
        makeRequire({
            './config.js': configModule,
            './configLoader.js': configLoaderModule,
            './common/pullRequest.js': prHelperStub,
            './prepareBugFixBatchContext.js': mocks.batchContextStub || { findBugsInEpic: function() { return []; } }
        }),
        allMocks
    );

    return {
        mod: mod,
        moves: moves,
        labels: labels,
        comments: comments,
        commands: commands,
        prCreated: prCreated
    };
}

function loadFinalizeBugFixBatchMerge(mocks) {
    mocks = mocks || {};
    var moves = [];
    var comments = [];

    var allMocks = Object.assign({
        jira_move_to_status: function(args) { moves.push(args); },
        jira_post_comment: function(args) { comments.push(args); }
    }, mocks);

    var mod = loadModule(
        'js/finalizeBugFixBatchMerge.js',
        makeRequire({
            './config.js': configModule,
            './prepareBugFixBatchContext.js': mocks.batchContextStub || { findBugsInEpic: function() { return []; } }
        }),
        allMocks
    );

    return {
        mod: mod,
        moves: moves,
        comments: comments
    };
}

suite('prepareBugFixBatchContext', function() {

    test('writes batch_bugs.md and fetches per-bug context', function() {
        var bugA = makeBug('TS-1415');
        var bugB = makeBug('TS-1423');

        var loaded = loadPrepareBugFixBatchContext({
            jira_search_by_jql: function(args) {
                assert.contains(args.jql, 'TS-EPIC-1');
                assert.contains(args.jql, 'bug_fix_batch');
                return [bugA, bugB];
            }
        });

        loaded.mod.action({
            inputFolderPath: 'input/TS-EPIC-1',
            ticket: makeEpic('TS-EPIC-1'),
            jobParams: { customParams: {} }
        });

        var batchMd = loaded.writes['input/TS-EPIC-1/batch_bugs.md'];
        assert.ok(batchMd, 'batch_bugs.md should be written');
        assert.contains(batchMd, 'TS-1415');
        assert.contains(batchMd, 'TS-1423');
        assert.contains(batchMd, 'input/TS-1415/');
        assert.contains(batchMd, 'agents/instructions/bug_fix_development/');
        assert.contains(batchMd, 'agents/instructions/bug_fix_batch_development/batch_scope.md');

        assert.equal(loaded.fetchCalls.length, 4, 'two fetch actions per bug');
        assert.equal(loaded.fetchCalls.filter(function(c) { return c.name === 'questions'; }).length, 2);
        assert.equal(loaded.fetchCalls.filter(function(c) { return c.name === 'linkedTests'; }).length, 2);

        assert.deepEqual(loaded.moves, [
            { key: 'TS-EPIC-1', statusName: 'In Development' }
        ]);
    });

    test('filters out non-bugs from linked issues', function() {
        var bugA = makeBug('TS-1415');
        var story = {
            key: 'TS-1400',
            fields: {
                summary: 'Story',
                status: { name: 'Ready For Development' },
                issuetype: { name: 'Story' }
            }
        };

        var loaded = loadPrepareBugFixBatchContext({
            jira_search_by_jql: function() { return [bugA, story]; }
        });

        loaded.mod.action({
            inputFolderPath: 'input/TS-EPIC-2',
            ticket: makeEpic('TS-EPIC-2'),
            jobParams: { customParams: {} }
        });

        var batchMd = loaded.writes['input/TS-EPIC-2/batch_bugs.md'];
        assert.contains(batchMd, 'TS-1415');
        assert.notContains(batchMd, 'TS-1400');
    });

});

suite('developBugFixBatchAndCreatePR', function() {

    test('creates PR, moves Epic and bugs to In Review, and labels ai_developed', function() {
        var epic = makeEpic('TS-EPIC-1');
        var bugA = makeBug('TS-1415');
        var bugB = makeBug('TS-1423');

        var loaded = loadDevelopBugFixBatchAndCreatePR({
            batchContextStub: {
                findBugsInEpic: function(key) {
                    return [bugA, bugB];
                }
            }
        });

        loaded.mod.action({
            inputFolderPath: 'input/TS-EPIC-1',
            ticket: epic,
            jobParams: { customParams: {} }
        });

        assert.equal(loaded.prCreated.length, 1, 'PR should be created');
        assert.equal(loaded.prCreated[0].branchName, 'ai/TS-EPIC-1');
        assert.contains(loaded.prCreated[0].bodyContent, 'TS-1415');
        assert.contains(loaded.prCreated[0].bodyContent, 'TS-1423');
        assert.contains(loaded.prCreated[0].bodyContent, 'Batch epic TS-EPIC-1');

        var moveKeys = loaded.moves.map(function(m) { return m.key; }).sort();
        assert.deepEqual(moveKeys, ['TS-1415', 'TS-1423', 'TS-EPIC-1']);
        loaded.moves.forEach(function(m) {
            assert.equal(m.statusName, 'In Review');
        });

        var labelKeys = loaded.labels.map(function(l) { return l.key; }).sort();
        assert.deepEqual(labelKeys, ['TS-1415', 'TS-1423', 'TS-EPIC-1']);
        loaded.labels.forEach(function(l) {
            assert.equal(l.label, 'ai_developed');
        });

        assert.equal(loaded.comments.length, 1);
        assert.contains(loaded.comments[0].comment, 'https://github.com/IstiN/trackstate/pull/9999');
    });

    test('reuses existing PR and skips creation', function() {
        var epic = makeEpic('TS-EPIC-2');
        var bugA = makeBug('TS-1425');

        var loaded = loadDevelopBugFixBatchAndCreatePR({
            batchContextStub: { findBugsInEpic: function() { return [bugA]; } },
            cli_execute_command: function(args) {
                var cmd = typeof args === 'string' ? args : args.command;
                if (cmd.indexOf('gh pr list --head ai/TS-EPIC-2') === 0) {
                    return 'https://github.com/IstiN/trackstate/pull/8888';
                }
                return '';
            }
        });

        loaded.mod.action({
            inputFolderPath: 'input/TS-EPIC-2',
            ticket: epic,
            jobParams: { customParams: {} }
        });

        assert.equal(loaded.prCreated.length, 0, 'should not create a new PR when one exists');
        assert.equal(loaded.comments[0].comment.indexOf('https://github.com/IstiN/trackstate/pull/8888') !== -1, true);
    });

});

suite('finalizeBugFixBatchMerge', function() {

    test('moves linked bugs and Epic to Done', function() {
        var bugA = makeBug('TS-1415');
        var bugB = makeBug('TS-1423');

        var loaded = loadFinalizeBugFixBatchMerge({
            batchContextStub: {
                findBugsInEpic: function() { return [bugA, bugB]; }
            }
        });

        loaded.mod.action({
            inputFolderPath: 'input/TS-EPIC-1',
            ticket: makeEpic('TS-EPIC-1'),
            jobParams: { customParams: {} }
        });

        var moveKeys = loaded.moves.map(function(m) { return m.key; }).sort();
        assert.deepEqual(moveKeys, ['TS-1415', 'TS-1423', 'TS-EPIC-1']);
        loaded.moves.forEach(function(m) {
            assert.equal(m.statusName, 'Done');
        });

        assert.equal(loaded.comments.length, 1);
        assert.contains(loaded.comments[0].comment, 'TS-1415');
        assert.contains(loaded.comments[0].comment, 'TS-1423');
    });

});
