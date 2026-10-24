/**
 * Unit tests: scm.js ADO fetchDiscussions — characterization + pure helpers (gh-925).
 *
 * Pins the ADO discussion collection behaviour (CRAP 808.5 in the baseline):
 * envelope parsing, deleted-thread dropping, resolved-status table, section
 * rendering, resolved-count header and the all-resolved → null markdown gate.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('scm ado fetchDiscussions', function () {

    function makeAdo(commentsResult) {
        var mod = scmReal({ ado_get_pr_comments: function () { return commentsResult; } });
        return mod._createAdoProvider('my-repo');
    }

    function thread(id, status, opts) {
        opts = opts || {};
        return {
            id: id,
            status: status,
            isDeleted: opts.isDeleted === true,
            threadContext: opts.threadContext,
            comments: opts.comments
        };
    }

    function comment(content, author, publishedDate) {
        var c = { content: content };
        if (author) c.author = { displayName: author };
        if (publishedDate) c.publishedDate = publishedDate;
        return c;
    }

    test('empty thread list → null markdown and null rawThreads', function () {
        var out = makeAdo(JSON.stringify({ value: [] })).fetchDiscussions(5);
        assert.deepEqual(out, { markdown: null, rawThreads: null });
    });

    test('bare array envelope parses to no threads (pins the {value}-only unwrap)', function () {
        var out = makeAdo(JSON.stringify([thread(1, 'active')])).fetchDiscussions(5);
        assert.deepEqual(out, { markdown: null, rawThreads: null });
    });

    test('maps an active thread: rawThreads fields, section rendering, no info header', function () {
        var t = thread(11, 'active', {
            threadContext: { filePath: '/src/a.js', rightFileStart: { line: 12 } },
            comments: [comment('Please fix  <b>this</b>  ', 'Dev User', '2026-01-02T10:00:00Z')]
        });
        var out = makeAdo(JSON.stringify({ value: [t] })).fetchDiscussions(5);
        assert.deepEqual(out.rawThreads, {
            threads: [{
                index: 1, rootCommentId: '11', threadId: '11',
                path: '/src/a.js', line: 12, resolved: false,
                body: 'Please fix  <b>this</b>'
            }]
        });
        assert.contains(out.markdown, '# PR Discussion History\n\n_Previous review discussions for PR #5._\n\n');
        assert.contains(out.markdown, '## Review Threads\n\n');
        assert.contains(out.markdown, '### Thread 1 — `/src/a.js` line 12\n\n');
        assert.contains(out.markdown, '**Dev User** (2026-01-02):\nPlease fix  <b>this</b>\n\n---\n\n');
        assert.notContains(out.markdown, 'already resolved');
    });

    test('thread without threadContext → null path/line; with path but no line → no line suffix', function () {
        var out = makeAdo(JSON.stringify({ value: [thread(1, 'active', { comments: [comment('hi')] })] })).fetchDiscussions(5);
        assert.equal(out.rawThreads.threads[0].path, null);
        assert.equal(out.rawThreads.threads[0].line, null);
        assert.contains(out.markdown, '### Thread 1\n');
        var withPathOnly = thread(2, 'active', {
            threadContext: { filePath: '/b.js' },
            comments: [comment('hi')]
        });
        var out2 = makeAdo(JSON.stringify({ value: [withPathOnly] })).fetchDiscussions(5);
        assert.contains(out2.markdown, '### Thread 1 — `/b.js`\n');
    });

    test('deleted threads are dropped entirely and do not shift numbering', function () {
        var t1 = thread(1, 'active', { comments: [comment('one')] });
        var t2 = thread(2, 'active', { isDeleted: true, comments: [comment('gone')] });
        var t3 = thread(3, 'active', { comments: [comment('three')] });
        var out = makeAdo(JSON.stringify({ value: [t1, t2, t3] })).fetchDiscussions(5);
        assert.deepEqual(out.rawThreads.threads.map(function (t) { return [t.index, t.rootCommentId]; }),
            [[1, '1'], [2, '3']]);
        assert.contains(out.markdown, '### Thread 1\n');
        assert.contains(out.markdown, '### Thread 2\n');
        assert.notContains(out.markdown, 'gone');
    });

    test('resolved statuses: fixed/closed/resolved/wontFix/byDesign yes, active/missing no', function () {
        var statuses = ['fixed', 'closed', 'resolved', 'wontFix', 'byDesign'];
        for (var i = 0; i < statuses.length; i++) {
            var out = makeAdo(JSON.stringify({ value: [thread(1, statuses[i], { comments: [comment('x')] })] })).fetchDiscussions(5);
            assert.equal(out.rawThreads.threads[0].resolved, true, 'status ' + statuses[i] + ' must be resolved');
            assert.equal(out.markdown, null, 'status ' + statuses[i] + ' must not render');
        }
        var active = makeAdo(JSON.stringify({ value: [thread(1, 'active', { comments: [comment('x')] })] })).fetchDiscussions(5);
        assert.equal(active.rawThreads.threads[0].resolved, false);
        var missing = makeAdo(JSON.stringify({ value: [thread(1, undefined, { comments: [comment('x')] })] })).fetchDiscussions(5);
        assert.equal(missing.rawThreads.threads[0].resolved, false);
    });

    test('all threads resolved → markdown null, rawThreads kept, no info header', function () {
        var t1 = thread(1, 'fixed', { comments: [comment('x')] });
        var t2 = thread(2, 'closed', { comments: [comment('y')] });
        var out = makeAdo(JSON.stringify({ value: [t1, t2] })).fetchDiscussions(5);
        assert.equal(out.markdown, null);
        assert.equal(out.rawThreads.threads.length, 2);
    });

    test('mixed resolved/unresolved → info header with the resolved count', function () {
        var t1 = thread(1, 'fixed', { comments: [comment('x')] });
        var t2 = thread(2, 'active', { comments: [comment('y')] });
        var t3 = thread(3, 'byDesign', { comments: [comment('z')] });
        var out = makeAdo(JSON.stringify({ value: [t1, t2, t3] })).fetchDiscussions(5);
        assert.contains(out.markdown,
            '> ℹ️ **2 thread(s) already resolved and excluded from this review.**\n\n## Review Threads\n\n');
        // Current-behaviour pin: section headings number every collected thread
        // (resolved included) — only the RENDER step skips resolved ones.
        assert.contains(out.markdown, '### Thread 2\n\n');
        assert.notContains(out.markdown, '### Thread 1\n');
    });

    test('empty-string content renders the placeholder; whitespace-only keeps the author line', function () {
        // '' is falsy → placeholder branch.
        var t = thread(1, 'active', { comments: [{ content: '' }] });
        var out = makeAdo(JSON.stringify({ value: [t] })).fetchDiscussions(5);
        assert.contains(out.markdown, '_[No comment body]_\n\n---\n');
        assert.notContains(out.markdown, '**unknown**');
        // '   ' is truthy → author line with the (empty) trimmed body.
        var t2 = thread(2, 'active', { comments: [comment('   \n  ', 'Dev', '2026-05-06T00:00:00Z')] });
        var out2 = makeAdo(JSON.stringify({ value: [t2] })).fetchDiscussions(5);
        assert.contains(out2.markdown, '**Dev** (2026-05-06):\n\n\n---\n');
        assert.notContains(out2.markdown, '_[No comment body]_');
    });

    test('whitespace-only content renders the author line, not the placeholder (pins raw-body truthiness)', function () {
        var t = thread(1, 'active', { comments: [comment('   ')] });
        var out = makeAdo(JSON.stringify({ value: [t] })).fetchDiscussions(5);
        assert.contains(out.markdown, '**unknown** ():\n\n\n---\n');
        assert.notContains(out.markdown, '_[No comment body]_');
    });

    test('thread without comments array → placeholder rendering', function () {
        var t = thread(1, 'active', {});
        var out = makeAdo(JSON.stringify({ value: [t] })).fetchDiscussions(5);
        assert.contains(out.markdown, '_[No comment body]_\n\n---\n');
        assert.deepEqual(out.rawThreads.threads[0], {
            index: 1, rootCommentId: '1', threadId: '1',
            path: null, line: null, resolved: false, body: ''
        });
    });
});

suite('scm ado discussion helpers', function () {

    function loadAdoMod(mocks) {
        return scmReal(mocks || {});
    }

    test('_adoParseDiscussionThreads: {value} only; arrays and bare objects → []', function () {
        var mod = loadAdoMod({});
        assert.deepEqual(mod._adoParseDiscussionThreads('{"value":[1]}'), [1]);
        assert.deepEqual(mod._adoParseDiscussionThreads(JSON.stringify([1])), []);
        assert.deepEqual(mod._adoParseDiscussionThreads({ value: [2] }), [2]);
        assert.deepEqual(mod._adoParseDiscussionThreads({}), []);
        assert.deepEqual(mod._adoParseDiscussionThreads(null), []);
    });

    test('_adoIsResolvedThreadStatus: exact status table', function () {
        var mod = loadAdoMod({});
        var yes = ['fixed', 'closed', 'resolved', 'wontFix', 'byDesign'];
        for (var i = 0; i < yes.length; i++) {
            assert.equal(mod._adoIsResolvedThreadStatus(yes[i]), true, yes[i]);
        }
        var no = ['active', 'unknown', '', undefined, null, 'fixedByUser'];
        for (var j = 0; j < no.length; j++) {
            assert.equal(mod._adoIsResolvedThreadStatus(no[j]), false, String(no[j]));
        }
    });

    test('_adoThreadContextField / _adoThreadLine', function () {
        var mod = loadAdoMod({});
        assert.equal(mod._adoThreadContextField({ filePath: '/a.js' }, 'filePath'), '/a.js');
        assert.equal(mod._adoThreadContextField(undefined, 'filePath'), null);
        assert.equal(mod._adoThreadContextField({}, 'filePath'), null);
        assert.equal(mod._adoThreadLine({ rightFileStart: { line: 7 } }), 7);
        assert.equal(mod._adoThreadLine({ rightFileStart: {} }), null);
        assert.equal(mod._adoThreadLine({}), null);
        assert.equal(mod._adoThreadLine(undefined), null);
    });

    test('_adoThreadRawBody / _adoThreadBody: raw truthiness vs trimmed value', function () {
        var mod = loadAdoMod({});
        assert.equal(mod._adoThreadRawBody({ content: '  x  ' }), '  x  ');
        assert.equal(mod._adoThreadRawBody({}), '');
        assert.equal(mod._adoThreadRawBody(null), '');
        assert.equal(mod._adoThreadRawBody({ content: '   ' }), '   ');
        assert.equal(mod._adoThreadBody({ content: '  x  ' }), 'x');
        assert.equal(mod._adoThreadBody(null), '');
    });

    test('_adoThreadAuthor / _adoThreadDate', function () {
        var mod = loadAdoMod({});
        assert.equal(mod._adoThreadAuthor({ author: { displayName: 'Dev' } }), 'Dev');
        assert.equal(mod._adoThreadAuthor({ author: {} }), 'unknown');
        assert.equal(mod._adoThreadAuthor({}), 'unknown');
        assert.equal(mod._adoThreadAuthor(null), 'unknown');
        assert.equal(mod._adoThreadDate({ publishedDate: '2026-01-02T10:00:00Z' }), '2026-01-02');
        assert.equal(mod._adoThreadDate({}), '');
        assert.equal(mod._adoThreadDate(null), '');
    });

    test('_adoMapDiscussionThread: deleted → null; exact rawThreads entry shape', function () {
        var mod = loadAdoMod({});
        assert.equal(mod._adoMapDiscussionThread({ isDeleted: true, id: 1 }, 1), null);
        var mapped = mod._adoMapDiscussionThread({
            id: 11,
            status: 'active',
            threadContext: { filePath: '/a.js', rightFileStart: { line: 12 } },
            comments: [{ content: '  fix  ', author: { displayName: 'D' } }]
        }, 3);
        assert.deepEqual(mapped, {
            index: 3, rootCommentId: '11', threadId: '11',
            path: '/a.js', line: 12, resolved: false, body: 'fix'
        });
    });

    test('_adoRenderThreadSection: path+line, path only, no path, body vs placeholder', function () {
        var mod = loadAdoMod({});
        var root = { content: 'fix it', author: { displayName: 'Dev' }, publishedDate: '2026-01-02T10:00:00Z' };
        assert.equal(
            mod._adoRenderThreadSection({ index: 2, path: '/a.js', line: 12, body: 'fix it' }, root),
            '### Thread 2 — `/a.js` line 12\n\n**Dev** (2026-01-02):\nfix it\n\n---\n\n');
        assert.equal(
            mod._adoRenderThreadSection({ index: 1, path: '/a.js', line: null, body: 'fix it' }, root),
            '### Thread 1 — `/a.js`\n\n**Dev** (2026-01-02):\nfix it\n\n---\n\n');
        // line renders only when a path is present (nested inside the path branch)
        assert.equal(
            mod._adoRenderThreadSection({ index: 1, path: null, line: 3, body: 'x' }, root),
            '### Thread 1\n\n**Dev** (2026-01-02):\nx\n\n---\n\n');
        assert.equal(
            mod._adoRenderThreadSection({ index: 1, path: null, line: null, body: '' }, null),
            '### Thread 1\n\n_[No comment body]_\n\n---\n\n');
    });

    test('_adoApplyResolvedHeader: prefixes only when resolved threads exist', function () {
        var mod = loadAdoMod({});
        var section = '## Review Threads\n\n';
        assert.equal(mod._adoApplyResolvedHeader(section, [{ resolved: false }]), section);
        assert.equal(
            mod._adoApplyResolvedHeader(section, [{ resolved: true }, { resolved: false }]),
            '> ℹ️ **1 thread(s) already resolved and excluded from this review.**\n\n## Review Threads\n\n');
    });

    test('_adoFetchDiscussions: end-to-end with mocked ado_get_pr_comments', function () {
        var mod = loadAdoMod({
            ado_get_pr_comments: function (args) {
                assert.deepEqual(args, { repository: 'repo', pullRequestId: '5' });
                return JSON.stringify({
                    value: [
                        { id: 1, status: 'fixed', comments: [{ content: 'x' }] },
                        { id: 2, status: 'active', threadContext: { filePath: '/b.js' }, comments: [{ content: 'y', author: { displayName: 'A' }, publishedDate: '2026-03-04T00:00:00Z' }] }
                    ]
                });
            }
        });
        var out = mod._adoFetchDiscussions('repo', 5);
        assert.equal(out.rawThreads.threads.length, 2);
        assert.contains(out.markdown, '> ℹ️ **1 thread(s) already resolved and excluded from this review.**\n\n');
        // headings number every collected thread — the active one is #2
        assert.contains(out.markdown, '### Thread 2 — `/b.js`\n\n**A** (2026-03-04):\ny\n\n---\n\n');
    });
});
