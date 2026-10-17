/**
 * Unit tests: scm.js GitLab fetchDiscussions — characterization + pure helpers (gh-925).
 *
 * Pins the GitLab discussion collection behaviour (fetchDiscussions#2,
 * CRAP 648.7 in the baseline): _toArray envelope, resolved detection
 * (thread.resolved || root.resolved), position path/line fallbacks, section
 * rendering with replies, and the hasContent → markdown gate. The provider
 * characterizations pass against the pre- and post-refactor code; the
 * _gitlab* helper tests pin the extracted pure functions.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('scm gitlab fetchDiscussions', function () {

    function makeGitlab(discussionsResult, extraMocks) {
        var mocks = { gitlab_get_mr_discussions: function () { return discussionsResult; } };
        if (extraMocks) {
            for (var k in extraMocks) { if (extraMocks.hasOwnProperty(k)) mocks[k] = extraMocks[k]; }
        }
        var mod = loadModule('js/common/scm.js',
            makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') }),
            mocks);
        return mod.createScm({ scm: { provider: 'gitlab' }, repository: { owner: 'mygroup', repo: 'my-repo' } });
    }

    test('empty discussion list → null markdown and null rawThreads', function () {
        var out = makeGitlab([]).fetchDiscussions(7);
        assert.deepEqual(out, { markdown: null, rawThreads: null });
    });

    test('maps an active thread with replies: rawThreads shape + section rendering', function () {
        var d = [{
            id: 'disc-1',
            notes: [
                { body: '  please fix  ', position: { new_path: '/src/a.js', new_line: 12 },
                  author: { username: 'dev1' }, created_at: '2026-02-03T11:00:00Z', resolved: false },
                { body: ' on it ', author: { name: 'Second Dev' }, created_at: '2026-02-04T09:30:00Z' }
            ]
        }];
        var out = makeGitlab(d).fetchDiscussions(7);
        assert.deepEqual(out.rawThreads, {
            threads: [{
                index: 1, rootCommentId: 'disc-1', threadId: 'disc-1', discussionId: 'disc-1',
                path: '/src/a.js', line: 12, resolved: false, body: 'please fix'
            }]
        });
        assert.contains(out.markdown, '# PR Discussion History\n\n_Previous review discussions for MR #7._\n\n');
        assert.contains(out.markdown, '## Review Threads\n\n');
        assert.contains(out.markdown, '### Thread 1 — `/src/a.js` line 12\n\n');
        // GitLab renders body/reply lines with single \n (no blank line) — pinned.
        assert.contains(out.markdown, '**dev1** (2026-02-03):\nplease fix\n');
        assert.contains(out.markdown, '> **Second Dev** (2026-02-04): on it\n');
        assert.contains(out.markdown, '---\n\n');
    });

    test('thread.resolved === true excludes from markdown but keeps rawThreads entry', function () {
        var d = [{ id: 'd1', resolved: true, notes: [{ body: 'done', author: { username: 'a' } }] }];
        var out = makeGitlab(d).fetchDiscussions(7);
        assert.equal(out.markdown, null);
        assert.equal(out.rawThreads.threads[0].resolved, true);
    });

    test('root.resolved === true also marks the thread resolved', function () {
        var d = [{ id: 'd1', notes: [{ body: 'x', resolved: true }] }];
        var out = makeGitlab(d).fetchDiscussions(7);
        assert.equal(out.markdown, null);
        assert.equal(out.rawThreads.threads[0].resolved, true);
    });

    test('thread without notes → placeholder rendering and null path/line', function () {
        var out = makeGitlab([{ id: 'd1' }]).fetchDiscussions(7);
        assert.equal(out.rawThreads.threads[0].path, null);
        assert.equal(out.rawThreads.threads[0].line, null);
        assert.contains(out.markdown, '### Thread 1\n\n_[No comment body]_\n---\n\n');
    });

    test('position falls back to old_path/old_line when new_* missing', function () {
        var d = [{
            id: 'd1',
            notes: [{ body: 'x', position: { old_path: '/old.js', old_line: 3 } }]
        }];
        var out = makeGitlab(d).fetchDiscussions(7);
        assert.equal(out.rawThreads.threads[0].path, '/old.js');
        assert.equal(out.rawThreads.threads[0].line, 3);
    });

    test('numbering counts resolved threads too (multi-thread mix)', function () {
        var d = [
            { id: 'd1', resolved: true, notes: [{ body: 'r1' }] },
            { id: 'd2', notes: [{ body: 'r2' }] },
            { id: 'd3', notes: [{ body: 'r3' }] }
        ];
        var out = makeGitlab(d).fetchDiscussions(7);
        assert.deepEqual(out.rawThreads.threads.map(function (t) { return [t.index, t.rootCommentId]; }),
            [[1, 'd1'], [2, 'd2'], [3, 'd3']]);
        // only the unresolved ones render, under their original numbers
        assert.notContains(out.markdown, '### Thread 1');
        assert.contains(out.markdown, '### Thread 2\n\n**unknown** ():\nr2\n---\n\n');
        assert.contains(out.markdown, '### Thread 3\n\n**unknown** ():\nr3\n---\n\n');
    });

    test('whitespace-only body renders the placeholder (GitLab trims before truthiness)', function () {
        var d = [{ id: 'd1', notes: [{ body: '   ' }] }];
        var out = makeGitlab(d).fetchDiscussions(7);
        assert.equal(out.rawThreads.threads[0].body, '');
        assert.contains(out.markdown, '_[No comment body]_\n---\n\n');
    });

    test('author falls back username → name → unknown; {value} envelope unwraps', function () {
        var d = { value: [
            { id: 'd1', notes: [{ body: 'a', author: { name: 'Only Name' } }] },
            { id: 'd2', notes: [{ body: 'b', author: { username: 'u2', name: 'n2' } }] }
        ]};
        var out = makeGitlab(d).fetchDiscussions(7);
        assert.contains(out.markdown, '**Only Name** ():\na\n');
        assert.contains(out.markdown, '**u2** ():\nb\n');
    });
});

suite('scm gitlab discussion helpers', function () {

    function loadGitlabMod(mocks) {
        return loadModule('js/common/scm.js',
            makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') }),
            mocks || {});
    }

    test('_gitlabMapDiscussionThread: exact rawThreads entry shape', function () {
        var mod = loadGitlabMod({});
        assert.deepEqual(mod._gitlabMapDiscussionThread({
            id: 'd9',
            resolved: false,
            notes: [
                { body: '  fix  ', resolved: false, position: { new_path: '/a.js', new_line: 4 },
                  author: { username: 'u' }, created_at: '2026-01-01T00:00:00Z' }
            ]
        }, 2), {
            index: 2, rootCommentId: 'd9', threadId: 'd9', discussionId: 'd9',
            path: '/a.js', line: 4, resolved: false, body: 'fix'
        });
    });

    test('_gitlabThreadAuthor / _gitlabThreadDate', function () {
        var mod = loadGitlabMod({});
        assert.equal(mod._gitlabThreadAuthor({ username: 'u', name: 'n' }), 'u');
        assert.equal(mod._gitlabThreadAuthor({ name: 'n' }), 'n');
        // Current-behaviour pin: an empty author OBJECT is truthy, so the fallback
        // never fires — username||name resolves to undefined and renders literally.
        assert.equal(mod._gitlabThreadAuthor({}), undefined);
        assert.equal(mod._gitlabThreadAuthor(undefined), 'unknown');
        assert.equal(mod._gitlabThreadDate({ created_at: '2026-05-06T07:08:09Z' }), '2026-05-06');
        assert.equal(mod._gitlabThreadDate({}), '');
        assert.equal(mod._gitlabThreadDate(null), '');
    });

    test('_gitlabRenderThreadSection: path+line, path only, no path, placeholder, replies', function () {
        var mod = loadGitlabMod({});
        var root = { body: 'fix it', author: { username: 'dev' }, created_at: '2026-01-02T10:00:00Z' };
        var replies = [
            root,
            { body: ' ack ', author: { name: 'Second' }, created_at: '2026-01-03T00:00:00Z' },
            { body: '', author: undefined, created_at: undefined }
        ];
        // body/reply lines carry a single \n; the heading and the rule carry \n\n — pinned.
        assert.equal(
            mod._gitlabRenderThreadSection({ index: 2, path: '/a.js', line: 12, body: 'fix it' }, replies),
            '### Thread 2 — `/a.js` line 12\n\n**dev** (2026-01-02):\nfix it\n> **Second** (2026-01-03): ack\n> **unknown** (): \n---\n\n');
        assert.equal(
            mod._gitlabRenderThreadSection({ index: 1, path: '/a.js', line: null, body: 'fix it' }, [root]),
            '### Thread 1 — `/a.js`\n\n**dev** (2026-01-02):\nfix it\n---\n\n');
        // line renders only when a path is present (nested inside the path branch)
        assert.equal(
            mod._gitlabRenderThreadSection({ index: 1, path: null, line: 3, body: 'x' }, [root]),
            '### Thread 1\n\n**dev** (2026-01-02):\nx\n---\n\n');
        assert.equal(
            mod._gitlabRenderThreadSection({ index: 1, path: null, line: null, body: '' }, [{}]),
            '### Thread 1\n\n_[No comment body]_\n---\n\n');
    });

    test('_gitlabFetchDiscussions: end-to-end with mocked gitlab_get_mr_discussions', function () {
        var mod = loadGitlabMod({
            gitlab_get_mr_discussions: function (args) {
                assert.deepEqual(args, { workspace: 'ws', repository: 'repo', pullRequestId: '5' });
                return [
                    { id: 'd1', resolved: true, notes: [{ body: 'x' }] },
                    { id: 'd2', notes: [{ body: 'y', author: { username: 'A' }, created_at: '2026-03-04T00:00:00Z', position: { new_path: '/b.js' } }] }
                ];
            }
        });
        var out = mod._gitlabFetchDiscussions('ws', 'repo', 5);
        assert.equal(out.rawThreads.threads.length, 2);
        assert.contains(out.markdown, '### Thread 2 — `/b.js`\n\n**A** (2026-03-04):\ny\n---\n\n');
        assert.contains(out.markdown, '# PR Discussion History\n\n_Previous review discussions for MR #5._\n\n');
    });
});
