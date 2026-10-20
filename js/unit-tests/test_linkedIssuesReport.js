/**
 * Unit tests for js/common/linkedIssuesReport.js (gh-1038) — the shared pure
 * helpers behind fetchLinkedTestsToInput.js / fetchLinkedBugsToInput.js.
 */

function loadReport() {
    return loadModule('js/common/linkedIssuesReport.js', makeRequire({}), {});
}

suite('linkedIssuesReport.resolveInputContext', function () {

    test('direct params shape: folder and ticketKey from inputFolderPath', function () {
        var ctx = loadReport().resolveInputContext({ inputFolderPath: 'input/PROJ-7', jobParams: { customParams: {} } });
        assert.equal(ctx.folder, 'input/PROJ-7');
        assert.equal(ctx.ticketKey, 'PROJ-7');
        assert.equal(ctx.actualParams.inputFolderPath, 'input/PROJ-7');
    });

    test('jobParams-wrapped shape: falls back to params.jobParams', function () {
        var ctx = loadReport().resolveInputContext({ jobParams: { inputFolderPath: 'input/PROJ-9', customParams: {} } });
        assert.equal(ctx.folder, 'input/PROJ-9');
        assert.equal(ctx.ticketKey, 'PROJ-9');
    });

    test('folder without separators: the whole folder name is the ticket key', function () {
        var ctx = loadReport().resolveInputContext({ inputFolderPath: 'PROJ-1' });
        assert.equal(ctx.ticketKey, 'PROJ-1');
    });
});

suite('linkedIssuesReport.buildLinkedQuery', function () {

    test('scopes the query to the ticket with the caller type filter', function () {
        assert.equal(
            loadReport().buildLinkedQuery('PROJ-7', 'issuetype = "Test Case"'),
            'issue in linkedIssues("PROJ-7") AND issuetype = "Test Case"'
        );
        assert.equal(
            loadReport().buildLinkedQuery('PROJ-7', 'issuetype = Bug AND status not in (Done)'),
            'issue in linkedIssues("PROJ-7") AND issuetype = Bug AND status not in (Done)'
        );
    });

    test('translates to WorkItemLinks WIQL when provider is ado', function () {
        var mod = loadReport();
        assert.equal(
            mod.buildLinkedQuery('123', 'issuetype = "Test Case"', 'ado', { issueType: 'Test Case' }),
            "SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = 123 AND [Target].[System.Id] <> 123 AND [Target].[System.WorkItemType] = 'Test Case' MODE (MustContain)"
        );
        assert.equal(
            mod.buildLinkedQuery('123', 'issuetype = Bug', 'ADO'),
            'SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = 123 AND [Target].[System.Id] <> 123 MODE (MustContain)'
        );
    });
});

suite('linkedIssuesReport — WIQL and provider-aware query helpers (gh-1122)', function () {

    test('wiqlQuote quotes values and escapes single quotes', function () {
        var mod = loadReport();
        assert.equal(mod.wiqlQuote('Done'), "'Done'");
        assert.equal(mod.wiqlQuote("PO's Review"), "'PO''s Review'");
        assert.equal(mod.wiqlQuote(null), "''");
        assert.equal(mod.wiqlQuote(undefined), "''");
    });

    test('wiqlIdExpr keeps numeric IDs bare and quotes non-numeric keys', function () {
        var mod = loadReport();
        assert.equal(mod.wiqlIdExpr(42), '42');
        assert.equal(mod.wiqlIdExpr('  900 '), '900');
        assert.equal(mod.wiqlIdExpr('PROJ-7'), "'PROJ-7'");
        assert.equal(mod.wiqlIdExpr(null), "''");
    });

    test('wiqlList formats items as comma-separated quoted literals', function () {
        var mod = loadReport();
        assert.equal(mod.wiqlList(['Story', 'Bug']), "'Story', 'Bug'");
        assert.equal(mod.wiqlList(null), '');
    });

    test('adoTargetTypeClause handles issueTypes array, single issueType, and empty opts', function () {
        var mod = loadReport();
        assert.equal(mod.adoTargetTypeClause(null), '');
        assert.equal(mod.adoTargetTypeClause({}), '');
        assert.equal(mod.adoTargetTypeClause({ issueTypes: [] }), '');
        assert.equal(
            mod.adoTargetTypeClause({ issueTypes: ['Story', 'Bug'] }),
            " AND [Target].[System.WorkItemType] IN ('Story', 'Bug')"
        );
        assert.equal(
            mod.adoTargetTypeClause({ issueType: 'Test Case' }),
            " AND [Target].[System.WorkItemType] = 'Test Case'"
        );
    });

    test('adoTargetStatusClause handles statusNotEquals, statusNotIn, statusIn, and empty opts', function () {
        var mod = loadReport();
        assert.equal(mod.adoTargetStatusClause(null), '');
        assert.equal(mod.adoTargetStatusClause({}), '');
        assert.equal(mod.adoTargetStatusClause({ statusNotIn: [], statusIn: [] }), '');
        assert.equal(
            mod.adoTargetStatusClause({ statusNotEquals: 'Done' }),
            " AND [Target].[System.State] <> 'Done'"
        );
        assert.equal(
            mod.adoTargetStatusClause({ statusNotIn: ['Done', 'Closed'] }),
            " AND [Target].[System.State] NOT IN ('Done', 'Closed')"
        );
        assert.equal(
            mod.adoTargetStatusClause({ statusIn: ['Done'] }),
            " AND [Target].[System.State] IN ('Done')"
        );
    });

    test('buildAdoLinkedWiql combines id, type, and status clauses with MODE (MustContain)', function () {
        var mod = loadReport();
        assert.equal(
            mod.buildAdoLinkedWiql('55', { issueTypes: ['Story', 'Bug'], statusNotEquals: 'Done' }),
            "SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = 55 AND [Target].[System.Id] <> 55 AND [Target].[System.WorkItemType] IN ('Story', 'Bug') AND [Target].[System.State] <> 'Done' MODE (MustContain)"
        );
    });

    test('buildLinkedIssuesQuery builds JQL on Jira and WIQL on ADO', function () {
        var mod = loadReport();
        assert.equal(
            mod.buildLinkedIssuesQuery('jira', 'TS-1', 'issuetype = Bug', { issueType: 'Bug' }),
            'issue in linkedIssues("TS-1") AND issuetype = Bug'
        );
        assert.equal(
            mod.buildLinkedIssuesQuery(null, 'TS-1', 'issuetype = Bug', { issueType: 'Bug' }),
            'issue in linkedIssues("TS-1") AND issuetype = Bug'
        );
        assert.equal(
            mod.buildLinkedIssuesQuery('ado', '77', 'issuetype = Bug', { issueType: 'Bug', statusNotIn: ['Done'] }),
            "SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = 77 AND [Target].[System.Id] <> 77 AND [Target].[System.WorkItemType] = 'Bug' AND [Target].[System.State] NOT IN ('Done') MODE (MustContain)"
        );
        assert.equal(
            mod.buildLinkedIssuesQuery('ado', '77', 'issuetype = Bug'),
            'SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = 77 AND [Target].[System.Id] <> 77 MODE (MustContain)'
        );
    });

    test('buildChildrenQuery handles SELECT passthrough, ADO WorkItems WIQL, and Jira JQL', function () {
        var mod = loadReport();
        assert.equal(
            mod.buildChildrenQuery('ado', '42', '  SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = {ticketKey} MODE (MustContain)', 'Subtask'),
            '  SELECT [Target].[System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = 42 MODE (MustContain)'
        );
        assert.equal(
            mod.buildChildrenQuery('ado', '42', 'parent = {ticketKey} AND issuetype = Subtask', 'Subtask'),
            "SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = 42 AND [System.WorkItemType] = 'Subtask'"
        );
        assert.equal(
            mod.buildChildrenQuery('ado', '42', 'parent = {ticketKey}', ''),
            'SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = 42'
        );
        assert.equal(
            mod.buildChildrenQuery('jira', 'DMC-1', 'parent = {ticketKey} AND issuetype = Subtask', 'Subtask'),
            'parent = DMC-1 AND issuetype = Subtask'
        );
        assert.equal(
            mod.buildChildrenQuery(null, 'DMC-1', null, 'Subtask'),
            ''
        );
    });
});

suite('linkedIssuesReport.buildRecentCommentLines', function () {

    function c(author, body) {
        var comment = { body: body };
        if (author !== undefined) comment.author = { displayName: author };
        return comment;
    }

    test('empty and missing comment lists produce no lines', function () {
        var mod = loadReport();
        assert.deepEqual(mod.buildRecentCommentLines([], '**Comments'), []);
        assert.deepEqual(mod.buildRecentCommentLines(null, '**Comments'), []);
    });

    test('up to 5 comments: full list with count header', function () {
        var lines = loadReport().buildRecentCommentLines([c('A', 'one'), c('B', 'two')], '**Comments');
        assert.contains(lines[0], '**Comments (2 most recent)**');
        assert.contains(lines[1], '**[A]**');
        assert.equal(lines[2], 'one');
        assert.equal(lines[3], '');
        assert.contains(lines[4], '**[B]**');
        assert.equal(lines[5], 'two');
        assert.equal(lines[6], '');
    });

    test('more than 5 comments: only the last 5 are rendered', function () {
        var comments = [c('C1', '1'), c('C2', '2'), c('C3', '3'), c('C4', '4'), c('C5', '5'), c('C6', '6'), c('C7', '7')];
        var lines = loadReport().buildRecentCommentLines(comments, '**Test Run Comments');
        assert.contains(lines[0], '**Test Run Comments (5 most recent)**');
        assert.notContains(lines.join('\n'), '**[C1]**');
        assert.notContains(lines.join('\n'), '**[C2]**');
        assert.contains(lines.join('\n'), '**[C3]**');
        assert.contains(lines.join('\n'), '**[C7]**');
    });

    test('missing author becomes Unknown, missing body becomes empty, body is truncated to 2000', function () {
        var longBody = '';
        for (var i = 0; i < 2100; i++) longBody += 'x';
        var lines = loadReport().buildRecentCommentLines([c(undefined, undefined), c('V', longBody)], '**Comments');
        assert.contains(lines[1], '**[Unknown]**');
        assert.equal(lines[2], '');
        assert.contains(lines[4], '**[V]**');
        assert.equal(lines[5], longBody.substring(0, 2000));
        assert.equal(lines[5].length, 2000);
    });
});
