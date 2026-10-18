/**
 * Unit tests for js/fetchLinkedBugsToInput.js (gh-1038 characterization).
 *
 * Pins the current behaviour of every branch: the linked-bugs query (open
 * bugs only), the markdown report layout (Description + Solution blocks),
 * the last-5-comments trimming, and all early exits.
 */

function linkedBugsTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

function linkedBugsReportModule() {
    return loadModule('js/common/linkedIssuesReport.js', makeRequire({}), {});
}

function loadFetchLinkedBugs(mocks) {
    return loadModule(
        'js/fetchLinkedBugsToInput.js',
        makeRequire({
            './common/trackers.js': linkedBugsTrackers(mocks),
            './common/linkedIssuesReport.js': linkedBugsReportModule()
        }),
        mocks
    );
}

function bugIssue(key, summary, statusName, extraFields) {
    var fields = { summary: summary };
    if (statusName !== undefined) fields.status = { name: statusName };
    for (var k in (extraFields || {})) fields[k] = extraFields[k];
    return { key: key, fields: fields };
}

function bugComment(author, body) {
    var c = { body: body };
    if (author !== undefined) c.author = { displayName: author };
    return c;
}

function makeBugsMocks(opts) {
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

function bugsSearchCall(env) {
    for (var i = 0; i < env.calls.length; i++) {
        if (env.calls[i].tool === 'jira_search_by_jql') return env.calls[i];
    }
    return null;
}

suite('fetchLinkedBugsToInput — jira happy path', function () {

    test('writes linked_bugs.md with Description, Solution and trimmed comments', function () {
        var env = makeBugsMocks({
            searchResult: [
                bugIssue('BUG-1', 'Race on save', 'In Progress', {
                    description: 'Intermittent 409',
                    Solution: 'Added optimistic locking'
                }),
                bugIssue('BUG-2', 'NPE on empty list') // no status/description/Solution
            ],
            issueDetails: {
                'BUG-1': bugIssue('BUG-1', 'Race on save', 'In Progress', {
                    description: 'Intermittent 409',
                    Solution: 'Added optimistic locking',
                    comment: { comments: [
                        bugComment('Fixer', 'see PR 12'),
                        bugComment('Bot', 'heartbeat probe with 30s delay')
                    ] }
                }),
                'BUG-2': bugIssue('BUG-2', 'NPE on empty list', 'To Do', { comment: { comments: [] } })
            }
        });
        var mod = loadFetchLinkedBugs(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        assert.equal(env.written.length, 1);
        assert.equal(env.written[0].path, 'input/PROJ-7/linked_bugs.md');
        var md = env.written[0].content;
        assert.contains(md, '# Linked Bugs');
        assert.contains(md, '## BUG-1: Race on save');
        assert.contains(md, '**Status**: In Progress');
        assert.contains(md, '**Description**:\nIntermittent 409');
        assert.contains(md, '**Solution / Root Cause Analysis**:\nAdded optimistic locking');
        assert.contains(md, '**Comments (2 most recent)**');
        assert.contains(md, '**[Fixer]**');
        assert.contains(md, 'heartbeat probe with 30s delay');
        assert.contains(md, '## BUG-2: NPE on empty list');
        assert.contains(md, '**Status**: Unknown');
        assert.notContains(md, '## BUG-2: NPE on empty list\n**Status**: Unknown\n\n**Description**');
    });

    test('issues the open-linked-bugs query scoped to the ticket', function () {
        var env = makeBugsMocks({
            searchResult: [bugIssue('BUG-1', 'A', 'Open')],
            issueDetails: { 'BUG-1': bugIssue('BUG-1', 'A') }
        });
        var mod = loadFetchLinkedBugs(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        var call = bugsSearchCall(env);
        assert.contains(call.args.jql, 'issue in linkedIssues("PROJ-7") AND issuetype = Bug AND status not in (Done)');
        assert.equal(call.args.maxResults, 10);
    });

    test('derives the ticket key from the jobParams-wrapped shape too', function () {
        var env = makeBugsMocks({
            searchResult: [bugIssue('BUG-1', 'A', 'Open')],
            issueDetails: { 'BUG-1': bugIssue('BUG-1', 'A') }
        });
        var mod = loadFetchLinkedBugs(env.mocks);

        mod.action({ jobParams: { inputFolderPath: 'input/PROJ-9', customParams: {} } });

        assert.contains(bugsSearchCall(env).args.jql, 'linkedIssues("PROJ-9")');
        assert.equal(env.written[0].path, 'input/PROJ-9/linked_bugs.md');
    });
});

suite('fetchLinkedBugsToInput — early exits', function () {

    test('no linked bugs → no file write, no detail fetches', function () {
        var env = makeBugsMocks({ searchResult: [] });
        var mod = loadFetchLinkedBugs(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        assert.equal(env.written.length, 0);
        assert.equal(env.calls.filter(function (c) { return c.tool === 'jira_get_ticket'; }).length, 0);
    });

    test('search failure → warns and returns without writing', function () {
        var env = makeBugsMocks({ searchError: 'JQL malformed' });
        var mod = loadFetchLinkedBugs(env.mocks);

        assert.doesNotThrow(function () {
            mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });
        });
        assert.equal(env.written.length, 0);
    });

    test('getIssue failure for one bug → report still written with the other bug', function () {
        var env = makeBugsMocks({
            searchResult: [
                bugIssue('BUG-1', 'Good', 'Open'),
                bugIssue('BUG-2', 'Broken', 'Open')
            ],
            issueErrors: { 'BUG-2': true },
            issueDetails: {
                'BUG-1': bugIssue('BUG-1', 'Good', 'Open', {
                    Solution: 'retry with backoff',
                    comment: { comments: [bugComment('A', 'ok')] }
                })
            }
        });
        var mod = loadFetchLinkedBugs(env.mocks);

        mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });

        assert.equal(env.written.length, 1);
        assert.contains(env.written[0].content, '## BUG-1: Good');
        assert.contains(env.written[0].content, '**[A]**');
        assert.contains(env.written[0].content, '## BUG-2: Broken');
    });

    test('file_write failure → swallowed with a warning, action does not throw', function () {
        var env = makeBugsMocks({
            searchResult: [bugIssue('BUG-1', 'A', 'Open')],
            issueDetails: { 'BUG-1': bugIssue('BUG-1', 'A') },
            writeError: true
        });
        var mod = loadFetchLinkedBugs(env.mocks);

        assert.doesNotThrow(function () {
            mod.action({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });
        });
        assert.equal(env.written.length, 0);
    });
});
