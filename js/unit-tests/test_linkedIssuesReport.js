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
