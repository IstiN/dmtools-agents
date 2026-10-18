/**
 * Unit tests for js/fetchLinkedTestsToInput.js (gh-1038 characterization).
 *
 * Pins the current behaviour of every branch: the linked-issue query, the
 * markdown report layout, the last-5-comments trimming, and all early exits.
 */

function linkedTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function linkedReportModule() {
    return loadModule('js/common/linkedIssuesReport.js', makeRequire({}), {});
}

function loadFetchLinkedTests(mocks) {
    return loadModule(
        'js/fetchLinkedTestsToInput.js',
        makeRequire({
            './common/trackers.js': linkedTrackers(mocks),
            './common/linkedIssuesReport.js': linkedReportModule()
        }),
        mocks
    );
}

function jiraIssue(key, summary, statusName, extraFields) {
    var fields = { summary: summary };
    if (statusName !== undefined) fields.status = { name: statusName };
    for (var k in (extraFields || {})) fields[k] = extraFields[k];
    return { key: key, fields: fields };
}

function comment(author, body) {
    var c = { body: body };
    if (author !== undefined) c.author = { displayName: author };
    return c;
}

function makeMocks(opts) {
    var calls = [];
    var written = [];
    var mocks = {
        file_write: function (path, content) {
            if (opts.writeError) { throw new Error('disk full'); }
            written.push({ path: path, content: content });
        },
        jira_search_by_jql: function (args) {
            calls.push({ tool: 'jira_search_by_jql', args: args });
            if (opts.searchError) { throw new Error(opts.searchError); }
            return JSON.stringify({ issues: opts.searchResult || [] });
        },
        jira_get_ticket: function (args) {
            calls.push({ tool: 'jira_get_ticket', args: args });
            if (opts.issueErrors && opts.issueErrors[args.key]) { throw new Error('boom'); }
            return JSON.stringify(opts.issueDetails[args.key]);
        }
    };
    return { mocks: mocks, calls: calls, written: written };
}

function searchCall(env) {
    for (var i = 0; i < env.calls.length; i++) {
        if (env.calls[i].tool === 'jira_search_by_jql') return env.calls[i];
    }
    return null;
}

suite('fetchLinkedTestsToInput — jira happy path', function () {

    test('writes linked_tests.md with header, test blocks and last-5 trimmed comments', function () {
        var longBody = '';
        for (var j = 0; j < 2100; j++) longBody += 'x';
        var six = [
            comment('Runner 1', 'run 1 passed'),
            comment('Runner 2', 'run 2 passed'),
            comment('Runner 3', 'run 3 passed'),
            comment('Runner 4', 'run 4 passed'),
            comment('Verbose', longBody),      // truncated to 2000 chars
            comment(undefined, undefined)          // missing author + body → Unknown / ''
        ];

        var env = makeMocks({
            searchResult: [
                jiraIssue('TC-1', 'Login works', 'Failed', { description: 'Steps to reproduce' }),
                jiraIssue('TC-2', 'Logout works') // no status, no description
            ],
            issueDetails: {
                'TC-1': jiraIssue('TC-1', 'Login works', 'Failed', {
                    description: 'Steps to reproduce',
                    comment: { comments: six }
                }),
                'TC-2': jiraIssue('TC-2', 'Logout works', 'Failed', { comment: { comments: [] } })
            }
        });
        var mod = loadFetchLinkedTests(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        assert.equal(env.written.length, 1);
        assert.equal(env.written[0].path, 'input/PROJ-7/linked_tests.md');
        var md = env.written[0].content;
        assert.contains(md, '# Linked Test Cases');
        assert.contains(md, '## TC-1: Login works');
        assert.contains(md, '## TC-2: Logout works');
        assert.contains(md, '**Status**: Failed');
        assert.contains(md, '**Status**: Unknown');
        assert.contains(md, '**Test Case Description**:\nSteps to reproduce');
        assert.notContains(md, '## TC-2: Logout works\n**Status**: Unknown\n\n**Test Case Description**');
        assert.contains(md, '**Test Run Comments (5 most recent)**');
        assert.contains(md, '**[Runner 2]**');   // first of the last 5 of 6
        assert.notContains(md, '**[Runner 1]**'); // trimmed away
        assert.contains(md, '**[Unknown]**');
        assert.contains(md, longBody.substring(0, 2000));
        assert.notContains(md, longBody.substring(0, 2001));
    });

    test('fetches details for every linked test via getIssue, in order', function () {
        var env = makeMocks({
            searchResult: [
                jiraIssue('TC-1', 'A', 'Open'),
                jiraIssue('TC-2', 'B', 'Open')
            ],
            issueDetails: {
                'TC-1': jiraIssue('TC-1', 'A', 'Open', { comment: { comments: [comment('X', 'first')] } }),
                'TC-2': jiraIssue('TC-2', 'B', 'Open', { comment: { comments: [comment('Y', 'second')] } })
            }
        });
        var mod = loadFetchLinkedTests(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        var gets = env.calls.filter(function (c) { return c.tool === 'jira_get_ticket'; });
        assert.equal(gets.length, 2);
        assert.equal(gets[0].args.key, 'TC-1');
        assert.equal(gets[1].args.key, 'TC-2');
        assert.contains(env.written[0].content, '**[X]**');
        assert.contains(env.written[0].content, '**[Y]**');
    });

    test('issues the linkedIssues query scoped to the ticket with maxResults 10', function () {
        var env = makeMocks({ searchResult: [jiraIssue('TC-1', 'A', 'Open')], issueDetails: { 'TC-1': jiraIssue('TC-1', 'A') } });
        var mod = loadFetchLinkedTests(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        var call = searchCall(env);
        assert.contains(call.args.jql, 'issue in linkedIssues("PROJ-7") AND issuetype = "Test Case"');
        assert.equal(call.args.maxResults, 10);
    });

    test('derives the ticket key from the jobParams-wrapped shape too', function () {
        var env = makeMocks({ searchResult: [jiraIssue('TC-1', 'A', 'Open')], issueDetails: { 'TC-1': jiraIssue('TC-1', 'A') } });
        var mod = loadFetchLinkedTests(env.mocks);

        mod.action({ jobParams: { inputFolderPath: 'input/PROJ-9', customParams: {} } });

        assert.contains(searchCall(env).args.jql, 'linkedIssues("PROJ-9")');
        assert.equal(env.written[0].path, 'input/PROJ-9/linked_tests.md');
    });
});

suite('fetchLinkedTestsToInput — early exits', function () {

    test('no linked tests → no file write, no detail fetches', function () {
        var env = makeMocks({ searchResult: [] });
        var mod = loadFetchLinkedTests(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        assert.equal(env.written.length, 0);
        assert.equal(env.calls.filter(function (c) { return c.tool === 'jira_get_ticket'; }).length, 0);
    });

    test('search failure → warns and returns without writing', function () {
        var env = makeMocks({ searchError: 'JQL malformed' });
        var mod = loadFetchLinkedTests(env.mocks);

        assert.doesNotThrow(function () {
            mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });
        });
        assert.equal(env.written.length, 0);
    });

    test('getIssue failure for one test → report still written with the other test', function () {
        var env = makeMocks({
            searchResult: [
                jiraIssue('TC-1', 'Good', 'Open'),
                jiraIssue('TC-2', 'Broken', 'Open')
            ],
            issueErrors: { 'TC-2': true },
            issueDetails: {
                'TC-1': jiraIssue('TC-1', 'Good', 'Open', { comment: { comments: [comment('A', 'ok')] } })
            }
        });
        var mod = loadFetchLinkedTests(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        assert.equal(env.written.length, 1);
        assert.contains(env.written[0].content, '## TC-1: Good');
        assert.contains(env.written[0].content, '**[A]**');       // TC-1 comments still rendered
        assert.contains(env.written[0].content, '## TC-2: Broken');
    });

    test('file_write failure → swallowed with a warning, action does not throw', function () {
        var env = makeMocks({
            searchResult: [jiraIssue('TC-1', 'A', 'Open')],
            issueDetails: { 'TC-1': jiraIssue('TC-1', 'A') },
            writeError: true
        });
        var mod = loadFetchLinkedTests(env.mocks);

        assert.doesNotThrow(function () {
            mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });
        });
        assert.equal(env.written.length, 0);
    });
});
