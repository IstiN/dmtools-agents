/**
 * Unit tests for js/common/prNewHunks.js (gh-1404).
 *
 * The diff-of-diff input: a re-review round reviews the hunks added since
 * the last reviewed head (pr_new_hunks.txt), with unchanged lines frozen.
 * The module is pure: it parses verdict records for the last reviewed head,
 * decides whether the head moved, and renders the input file content.
 */

function prNewHunksDeps() {
    var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
        makeRequire({ './machineAuthor.js': machineAuthor }), {});
    return loadModule('js/common/prNewHunks.js',
        makeRequire({
            './machineAuthor.js': machineAuthor,
            './reviewVerdicts.js': reviewVerdicts
        }), {});
}

// A real machine verdict-record comment body for one head.
function verdictComment(head, verdict, at) {
    var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
        makeRequire({ './machineAuthor.js': machineAuthor }), {});
    return reviewVerdicts.buildVerdictComment({
        head: head,
        verdict: verdict || 'REQUEST_CHANGES',
        blocking: 1,
        important: 0,
        suggestions: 0,
        nits: 0,
        digest: 0,
        at: at || '2026-11-08T10:00:00Z',
        source: 'pr_review.json'
    });
}

suite('prNewHunks.lastReviewedHead', function() {

    test('empty comment list → null (first review round)', function() {
        var m = prNewHunksDeps();
        assert.equal(m.lastReviewedHead([], { authorLogins: ['ai-teammate'] }), null);
    });

    test('free-form review text without the marker → null (never consulted)', function() {
        var m = prNewHunksDeps();
        var head = m.lastReviewedHead([
            { body: 'REQUEST_CHANGES — please fix the bug', user: { login: 'ai-teammate' } }
        ], { authorLogins: ['ai-teammate'] });
        assert.equal(head, null);
    });

    test('one machine verdict record → its head', function() {
        var m = prNewHunksDeps();
        var head = m.lastReviewedHead([
            { body: verdictComment('bbb222ccc333'), user: { login: 'ai-teammate' } }
        ], { authorLogins: ['ai-teammate'] });
        assert.equal(head, 'bbb222ccc333');
    });

    test('multiple records → the NEWEST one wins (order by at, not by position)', function() {
        var m = prNewHunksDeps();
        var head = m.lastReviewedHead([
            { body: verdictComment('oldest111111', 'REQUEST_CHANGES', '2026-11-01T10:00:00Z'), user: { login: 'ai-teammate' } },
            { body: verdictComment('newest9999999', 'APPROVE', '2026-11-09T10:00:00Z'), user: { login: 'ai-teammate' } },
            { body: verdictComment('middle7777777', 'REQUEST_CHANGES', '2026-11-05T10:00:00Z'), user: { login: 'ai-teammate' } }
        ], { authorLogins: ['ai-teammate'] });
        assert.equal(head, 'newest9999999');
    });

    test('a forged record (non-machine author) is invisible', function() {
        var m = prNewHunksDeps();
        var head = m.lastReviewedHead([
            { body: verdictComment('forged000000'), user: { login: 'random-user' } }
        ], { authorLogins: ['ai-teammate'] });
        assert.equal(head, null);
    });

    test('null/undefined comment payload → null', function() {
        var m = prNewHunksDeps();
        assert.equal(m.lastReviewedHead(null, { authorLogins: ['ai-teammate'] }), null);
    });
});

suite('prNewHunks.headsDiffer', function() {

    test('missing last reviewed head → false (never a re-review)', function() {
        var m = prNewHunksDeps();
        assert.equal(m.headsDiffer(null, 'abc123def'), false);
        assert.equal(m.headsDiffer('', 'abc123def'), false);
    });

    test('missing current head → false', function() {
        var m = prNewHunksDeps();
        assert.equal(m.headsDiffer('bbb222ccc', null), false);
        assert.equal(m.headsDiffer('bbb222ccc', ''), false);
    });

    test('identical heads → false (re-review of the same code — everything frozen)', function() {
        var m = prNewHunksDeps();
        assert.equal(m.headsDiffer('bbb222ccc333', 'bbb222ccc333'), false);
    });

    test('prefix-equal heads (full sha vs short sha) → false', function() {
        var m = prNewHunksDeps();
        assert.equal(m.headsDiffer('bbb222ccc333', 'bbb222c'), false);
        assert.equal(m.headsDiffer('bbb222c', 'bbb222ccc333'), false);
    });

    test('different heads → true', function() {
        var m = prNewHunksDeps();
        assert.equal(m.headsDiffer('bbb222ccc333', 'abc123def456'), true);
    });

    test('a short prefix that is NOT the other head → true', function() {
        var m = prNewHunksDeps();
        assert.equal(m.headsDiffer('bbb222c', 'bbc222ccc333'), true);
    });
});

suite('prNewHunks.buildNewHunksFile', function() {

    test('header cites both heads and carries the frozen-lines contract', function() {
        var m = prNewHunksDeps();
        var content = m.buildNewHunksFile('bbb222ccc333', 'abc123def456', '+ new hunk line\n+ another');
        assert.contains(content, 'bbb222ccc333');
        assert.contains(content, 'abc123def456');
        assert.contains(content, '+ new hunk line');
        assert.contains(content, 'frozen');
        assert.contains(content, 'interaction');
    });

    test('an empty delta still builds a file — the head moved with no code change', function() {
        var m = prNewHunksDeps();
        var content = m.buildNewHunksFile('bbb222ccc333', 'abc123def456', '');
        assert.contains(content, 'bbb222ccc333');
        assert.contains(content, 'abc123def456');
    });
});
