/**
 * Unit tests for the inline comment anchor helpers in js/common/contentOutput.js:
 *   - extractInlineCommentMarkers
 *   - injectCommentPlaceholders
 *
 * Post-sync anchor restoration (placeholder → real marker + text-match fallback)
 * lives in the dmtools CLI (MarkdownConfluenceSync + InlineCommentAnchorPreserver,
 * preserveInlineComments default true) and is covered by core tests.
 */

function loadLib() {
    return loadModule(
        'js/common/contentOutput.js',
        makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } }, './trackers.js': trackersMock() }),
        {}
    );
}

var REF_A = 'a40ec14d-0d73-4f55-9a69-7026900b6623';
var REF_B = '11111111-2222-3333-4444-555555555555';

suite('contentOutput.extractInlineCommentMarkers', function() {

    test('extracts markers with refs and plain text', function() {
        var lib = loadLib();
        var body = '<p>Hello</p><ul><li><ac:inline-comment-marker ac:ref="' + REF_A + '">Item one</ac:inline-comment-marker></li></ul>';
        var anchors = lib.extractInlineCommentMarkers(body);
        assert.equal(anchors.length, 1);
        assert.equal(anchors[0].ref, REF_A);
        assert.equal(anchors[0].text, 'Item one');
    });

    test('strips nested tags from anchored text', function() {
        var lib = loadLib();
        var body = '<p><ac:inline-comment-marker ac:ref="' + REF_A + '">some <strong>bold</strong> text</ac:inline-comment-marker></p>';
        var anchors = lib.extractInlineCommentMarkers(body);
        assert.equal(anchors[0].text, 'some bold text');
    });

    test('returns empty array for empty/markerless body', function() {
        var lib = loadLib();
        assert.deepEqual(lib.extractInlineCommentMarkers(''), []);
        assert.deepEqual(lib.extractInlineCommentMarkers(null), []);
        assert.deepEqual(lib.extractInlineCommentMarkers('<p>no markers</p>'), []);
    });
});

suite('contentOutput.injectCommentPlaceholders', function() {

    test('wraps first occurrence of anchor text', function() {
        var lib = loadLib();
        var md = '# Title\n\n- Item one\n- Item one again\n';
        var result = lib.injectCommentPlaceholders(md, [{ ref: REF_A, text: 'Item one' }]);
        assert.equal(result.injected.length, 1);
        assert.ok(result.content.indexOf('[[ic:' + REF_A + ']]Item one[[/ic]]') !== -1);
        // only the first occurrence is wrapped
        assert.ok(result.content.indexOf('- Item one again') !== -1);
    });

    test('skips anchors already present as placeholders', function() {
        var lib = loadLib();
        var md = '- [[ic:' + REF_A + ']]Item one[[/ic]]\n';
        var result = lib.injectCommentPlaceholders(md, [{ ref: REF_A, text: 'Item one' }]);
        assert.equal(result.injected.length, 0);
        assert.equal(result.content, md);
    });

    test('reports anchors whose text is not found', function() {
        var lib = loadLib();
        var result = lib.injectCommentPlaceholders('# Nothing here', [{ ref: REF_A, text: 'Missing text' }]);
        assert.deepEqual(result.missed, [REF_A]);
    });
});

suite('contentOutput anchor helpers — sync integration notes', function() {

    // Post-sync anchor restoration (placeholder → real marker + text-match fallback)
    // lives in the dmtools CLI (MarkdownConfluenceSync + InlineCommentAnchorPreserver,
    // dmtools ≥ v1.7.249, enabled by default via preserveInlineComments). The JS side
    // only prepares [[ic:REF]]...[[/ic]] placeholders in input/confluence_output_current.md.

    test('placeholder format matches the core sync contract', function() {
        var lib = loadLib();
        var md = '- Item one\n';
        var result = lib.injectCommentPlaceholders(md, [{ ref: REF_A, text: 'Item one' }]);
        assert.ok(result.content.indexOf('[[ic:' + REF_A + ']]Item one[[/ic]]') !== -1);
    });
});


// ── gh-1112 AC4: provider-neutral target aliases ─────────────────────────────

suite('contentOutput target aliases (gh-1112 AC4)', function() {

    test("isConfluenceTarget accepts 'confluence', 'wiki' and 'both'", function() {
        var lib = loadLib();
        assert.equal(lib.isConfluenceTarget({ target: 'confluence' }), true);
        assert.equal(lib.isConfluenceTarget({ target: 'wiki' }), true);
        assert.equal(lib.isConfluenceTarget({ target: 'both' }), true);
    });

    test("isConfluenceTarget rejects tracker-field-only and unknown targets", function() {
        var lib = loadLib();
        assert.equal(lib.isConfluenceTarget({ target: 'jira_field' }), false);
        assert.equal(lib.isConfluenceTarget({ target: 'tracker_field' }), false);
        assert.equal(lib.isConfluenceTarget({ target: 'something_else' }), false);
        assert.equal(lib.isConfluenceTarget({}), false);
    });

    test("isJiraFieldTarget accepts 'jira_field', 'tracker_field' and 'both'", function() {
        var lib = loadLib();
        assert.equal(lib.isJiraFieldTarget({ target: 'jira_field' }), true);
        assert.equal(lib.isJiraFieldTarget({ target: 'tracker_field' }), true);
        assert.equal(lib.isJiraFieldTarget({ target: 'both' }), true);
    });

    test("isJiraFieldTarget rejects wiki-only and unknown targets", function() {
        var lib = loadLib();
        assert.equal(lib.isJiraFieldTarget({ target: 'wiki' }), false);
        assert.equal(lib.isJiraFieldTarget({ target: 'confluence' }), false);
        assert.equal(lib.isJiraFieldTarget({ target: 'nope' }), false);
        assert.equal(lib.isJiraFieldTarget({}), false);
    });

    test("resolveConfig passes 'wiki' and 'tracker_field' targets through untouched", function() {
        var lib = loadLib();
        var wikiCfg = lib.resolveConfig({
            customParams: { contentOutput: { target: 'wiki', space: 'DOC', parentPageId: '7' } }
        });
        assert.equal(wikiCfg.target, 'wiki');
        assert.equal(wikiCfg.space, 'DOC');
        var tfCfg = lib.resolveConfig({
            customParams: { contentOutput: { target: 'tracker_field', field: 'Description' } }
        });
        assert.equal(tfCfg.target, 'tracker_field');
        assert.equal(tfCfg.field, 'Description');
    });

    test('publishPage still validates config before any confluence call under target wiki (E2)', function() {
        var lib = loadLib();
        var threw = false;
        try {
            lib.publishPage({ target: 'wiki' }, 'PROJ-1', 's', 'body');
        } catch (e) {
            threw = true;
        }
        assert.equal(threw, true);
    });
});
// ── extractCommentBody (gh-1086 characterization) ─────────────────────────────

suite('contentOutput.extractCommentBody', function() {

    test('returns empty string for a missing comment', function() {
        var lib = loadLib();
        assert.equal(lib.extractCommentBody(null), '');
        assert.equal(lib.extractCommentBody(undefined), '');
    });

    test('returns a plain string body untouched', function() {
        var lib = loadLib();
        assert.equal(lib.extractCommentBody({ body: 'plain text' }), 'plain text');
        assert.equal(lib.extractCommentBody({ body: '' }), '');
    });

    test('unwraps storage.value (v2 storage format)', function() {
        var lib = loadLib();
        assert.equal(
            lib.extractCommentBody({ body: { storage: { value: '<p>stored</p>' } } }),
            '<p>stored</p>'
        );
    });

    test('unwraps atlas_doc_format.value (ADR format)', function() {
        var lib = loadLib();
        var doc = '{"type":"paragraph","content":[]}';
        assert.equal(
            lib.extractCommentBody({ body: { atlas_doc_format: { value: doc } } }),
            doc
        );
    });

    test('unwraps view.value (v1 view format)', function() {
        var lib = loadLib();
        assert.equal(lib.extractCommentBody({ body: { view: { value: 'viewed' } } }), 'viewed');
    });

    test('representation order is storage, atlas_doc_format, view', function() {
        var lib = loadLib();
        assert.equal(
            lib.extractCommentBody({ body: {
                storage: { value: 'S' },
                atlas_doc_format: { value: 'A' },
                view: { value: 'V' }
            } }),
            'S'
        );
        assert.equal(
            lib.extractCommentBody({ body: { atlas_doc_format: { value: 'A' }, view: { value: 'V' } } }),
            'A'
        );
    });

    test('skips representations whose value is not a string', function() {
        var lib = loadLib();
        assert.equal(
            lib.extractCommentBody({ body: { storage: { value: 42 }, view: { value: 'V' } } }),
            'V'
        );
        assert.equal(
            lib.extractCommentBody({ body: { storage: {} } }),
            JSON.stringify({ storage: {} })
        );
    });

    test('falls back to JSON.stringify for unrecognized body shapes', function() {
        var lib = loadLib();
        assert.equal(lib.extractCommentBody({ body: { unknown: 1 } }), '{"unknown":1}');
        assert.equal(lib.extractCommentBody({ body: null }), 'null');
        assert.equal(lib.extractCommentBody({ body: 7 }), '7');
    });
});

// ── fetchPageInlineComments (gh-1086 characterization) ────────────────────────

function loadLibWithGlobals(globalMocks) {
    return loadModule(
        'js/common/contentOutput.js',
        makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } }, './trackers.js': trackersMock() }),
        globalMocks || {}
    );
}

suite('contentOutput.fetchPageInlineComments', function() {

    test('maps a full v2 comment (properties camelCase, extensions.inlineProperties)', function() {
        var raw = JSON.stringify({ results: [{
            id: 'c1',
            parentCommentId: 'p1',
            author: { displayName: 'Ann' },
            createdDate: '2026-01-01T00:00:00Z',
            resolutionStatus: 'open',
            properties: { 'inline-marker-ref': REF_A, 'inline-original-selection': 'sel text' },
            extensions: { inlineProperties: { markerRef: 'ignored-older', originalSelection: 'ignored-older' } },
            body: { storage: { value: '<p>body</p>' } }
        }] });
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function() { return raw; }
        });
        var comments = lib.fetchPageInlineComments('123', 'My Page');
        assert.equal(comments.length, 1);
        var c = comments[0];
        assert.equal(c.pageId, '123');
        assert.equal(c.pageTitle, 'My Page');
        assert.equal(c.commentId, 'c1');
        assert.equal(c.parentCommentId, 'p1');
        assert.equal(c.author, 'Ann');
        assert.equal(c.created, '2026-01-01T00:00:00Z');
        assert.equal(c.resolved, false);
        // v2 properties win over extensions.inlineProperties
        assert.equal(c.markerRef, REF_A);
        assert.equal(c.originalSelection, 'sel text');
        assert.equal(c.body, '<p>body</p>');
    });

    test('maps multiple comments with varying shapes (v1 fallbacks and defaults)', function() {
        var raw = JSON.stringify({ results: [
            {
                // v1 shape: marker info under extensions.inlineProperties, no properties
                id: 'c2',
                parentId: 'p2',
                author: { emailAddress: 'a@x.io' },
                version: { createdAt: '2026-02-02T00:00:00Z' },
                extensions: { inlineProperties: { markerRef: REF_B, originalSelection: 'old sel' } },
                body: 'string body'
            },
            {
                // minimal shape: every optional field missing
                body: { atlas_doc_format: { value: 'adr' } }
            }
        ] });
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function() { return raw; }
        });
        var comments = lib.fetchPageInlineComments(987, null);
        assert.equal(comments.length, 2);

        assert.equal(comments[0].pageId, '987');
        assert.equal(comments[0].pageTitle, 'untitled');
        assert.equal(comments[0].commentId, 'c2');
        assert.equal(comments[0].parentCommentId, 'p2');
        assert.equal(comments[0].author, 'a@x.io');
        assert.equal(comments[0].created, '2026-02-02T00:00:00Z');
        assert.equal(comments[0].markerRef, REF_B);
        assert.equal(comments[0].originalSelection, 'old sel');
        assert.equal(comments[0].body, 'string body');

        assert.equal(comments[1].commentId, null);
        assert.equal(comments[1].parentCommentId, null);
        assert.equal(comments[1].author, 'Unknown');
        assert.equal(comments[1].created, '');
        assert.equal(comments[1].markerRef, null);
        assert.equal(comments[1].originalSelection, null);
        assert.equal(comments[1].body, 'adr');
    });

    test('parses the comments-array payload shape', function() {
        var raw = JSON.stringify({ comments: [{ id: 'k', body: 'b' }] });
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function() { return raw; }
        });
        var comments = lib.fetchPageInlineComments('1', 'T');
        assert.equal(comments.length, 1);
        assert.equal(comments[0].commentId, 'k');
    });

    test('parses a bare array payload', function() {
        var raw = JSON.stringify([{ id: 'arr', body: 'b' }, { id: 'arr2', body: 'b2' }]);
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function() { return raw; }
        });
        var comments = lib.fetchPageInlineComments('1', 'T');
        assert.equal(comments.length, 2);
        assert.equal(comments[1].commentId, 'arr2');
    });

    test('empty payload object yields no comments', function() {
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function() { return '{}'; }
        });
        assert.deepEqual(lib.fetchPageInlineComments('1', 'T'), []);
    });

    test('passes limit through, defaulting to 100, and stringifies pageId', function() {
        var seen = [];
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function(opts) {
                seen.push(opts);
                return '{"results":[]}';
            }
        });
        lib.fetchPageInlineComments(55, 'T');
        lib.fetchPageInlineComments('66', 'T', 7);
        assert.equal(seen.length, 2);
        assert.equal(seen[0].pageId, '55');
        assert.equal(seen[0].limit, 100);
        assert.equal(seen[1].pageId, '66');
        assert.equal(seen[1].limit, 7);
    });

    test('returns no comments when the fetch throws', function() {
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function() { throw new Error('boom'); }
        });
        assert.deepEqual(lib.fetchPageInlineComments('1', 'T'), []);
    });

    test('returns no comments when the payload is invalid JSON', function() {
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function() { return 'not-json'; }
        });
        assert.deepEqual(lib.fetchPageInlineComments('1', 'T'), []);
    });
});

suite('contentOutput.fetchPageInlineComments — resolution status matrix', function() {

    function commentWith(field) {
        var c = { body: 'b' };
        if (field === 'resolutionStatus-resolved') c.resolutionStatus = 'resolved';
        else if (field === 'resolutionStatus-closed') c.resolutionStatus = 'closed';
        else if (field === 'resolutionStatus-open') c.resolutionStatus = 'open';
        else if (field === 'resolvedDate') c.resolvedDate = '2026-01-01';
        else if (field === 'resolved') c.resolved = true;
        else if (field === 'status-resolved') c.status = 'resolved';
        else if (field === 'status-closed') c.status = 'closed';
        return c;
    }

    var CASES = [
        ['resolutionStatus-resolved', true],
        ['resolutionStatus-closed', true],
        ['resolvedDate', true],
        ['resolved', true],
        ['status-resolved', true],
        ['status-closed', true],
        ['resolutionStatus-open', false]
    ];

    CASES.forEach(function(pair) {
        test('resolved=' + pair[1] + ' for ' + pair[0], function() {
            var raw = JSON.stringify({ results: [commentWith(pair[0])] });
            var lib = loadLibWithGlobals({
                confluence_get_page_inline_comments: function() { return raw; }
            });
            var comments = lib.fetchPageInlineComments('1', 'T');
            assert.equal(comments.length, 1);
            assert.equal(comments[0].resolved, pair[1]);
        });
    });

    test('status values that merely look like resolution words do not resolve', function() {
        var raw = JSON.stringify({ results: [{ status: 'open', resolved: false, body: 'b' }] });
        var lib = loadLibWithGlobals({
            confluence_get_page_inline_comments: function() { return raw; }
        });
        assert.equal(lib.fetchPageInlineComments('1', 'T')[0].resolved, false);
    });
});

// ── gh-1224: writeCommentsFiles characterization ─────────────────────────────

suite('contentOutput.writeCommentsFiles (gh-1224)', function() {

    function writesOf(globalMocks, comments, baseName) {
        var writes = [];
        var lib = loadLibWithGlobals(Object.assign({
            file_write: function(p, c) {
                writes.push({ path: p, content: c });
            }
        }, globalMocks || {}));
        lib.writeCommentsFiles('input/TICKET', comments, baseName);
        return writes;
    }

    function mdOf(writes, baseName) {
        var name = baseName || 'confluence_output_comments';
        var hit = writes.filter(function(w) { return w.path === 'input/TICKET/' + name + '.md'; });
        return hit.length ? hit[0].content : null;
    }

    function jsonOf(writes, baseName) {
        var name = baseName || 'confluence_output_comments';
        var hit = writes.filter(function(w) { return w.path === 'input/TICKET/' + name + '.json'; });
        return hit.length ? JSON.parse(hit[0].content) : null;
    }

    test('empty list renders the no-comments placeholder', function() {
        var writes = writesOf({}, []);
        assert.equal(jsonOf(writes).comments.length, 0);
        assert.contains(mdOf(writes), '# Inline comments');
        assert.contains(mdOf(writes), '_No inline comments found._');
    });

    test('null comments render the no-comments placeholder too', function() {
        var writes = writesOf({}, null);
        assert.contains(mdOf(writes), '_No inline comments found._');
    });

    test('each comment renders its full field set (2+ comments, parent link, resolved yes/no)', function() {
        var writes = writesOf({}, [
            {
                commentId: 'c1',
                pageId: 'p1',
                pageTitle: 'Ticket page',
                author: 'Ann',
                created: '2026-01-01',
                resolved: true,
                parentCommentId: 'root-9',
                body: 'First finding'
            },
            {
                commentId: 'c2',
                pageId: 'p1',
                pageTitle: 'Ticket page',
                author: 'Bob',
                created: '2026-01-02',
                resolved: false,
                body: 'Second finding'
            }
        ]);

        assert.equal(jsonOf(writes).comments.length, 2);
        var md = mdOf(writes);
        assert.contains(md, 'Total comments: 2');
        assert.contains(md, '## Comment c1 on page "Ticket page" (pageId: p1)');
        assert.contains(md, '- **Author:** Ann');
        assert.contains(md, '- **Created:** 2026-01-01');
        assert.contains(md, '- **Resolved:** yes');
        assert.contains(md, '- **Parent comment:** root-9');
        assert.contains(md, 'First finding');
        assert.contains(md, '## Comment c2 on page "Ticket page" (pageId: p1)');
        assert.contains(md, '- **Resolved:** no');
        assert.ok(md.indexOf('Parent comment:** root-9\n- **Created:** 2026-01-02') === -1,
            'the parent line belongs to c1 only');
    });

    test('missing fields fall back to the documented placeholders', function() {
        var writes = writesOf({}, [{ body: 'Minimal' }]);
        var md = mdOf(writes);
        assert.contains(md, '## Comment unknown on page "untitled" (pageId: unknown)');
        assert.contains(md, '- **Author:** Unknown');
        assert.contains(md, '- **Created:** ');
        assert.contains(md, '- **Resolved:** no');
        assert.ok(md.indexOf('Parent comment') === -1, 'no parent line without parentCommentId');
    });

    test('a custom baseName drives both file names', function() {
        var writes = writesOf({}, [{ body: 'b', commentId: 'c9' }], 'custom_comments');
        var paths = writes.map(function(w) { return w.path; });
        assert.ok(paths.indexOf('input/TICKET/custom_comments.json') !== -1, 'json uses the custom base name');
        assert.ok(paths.indexOf('input/TICKET/custom_comments.md') !== -1, 'md uses the custom base name');
    });

    test('a failing json write warns and the md digest is still written', function() {
        var writes = [];
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function(msg) { warnings.push(msg); };
        try {
            var lib = loadLibWithGlobals({
                file_write: function(p, c) {
                    if (p.indexOf('.json') !== -1) throw new Error('disk full');
                    writes.push(p);
                }
            });
            lib.writeCommentsFiles('input/TICKET', [{ body: 'b' }]);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(writes.length, 1, 'the markdown digest is still written');
        assert.equal(warnings.length, 1);
        assert.contains(warnings[0], 'failed to write confluence_output_comments.json');
    });

    test('a failing md write warns without crashing', function() {
        var writes = [];
        var warnings = [];
        var originalWarn = console.warn;
        console.warn = function(msg) { warnings.push(msg); };
        try {
            var lib = loadLibWithGlobals({
                file_write: function(p, c) {
                    if (p.indexOf('.md') !== -1) throw new Error('disk full');
                    writes.push(p);
                }
            });
            lib.writeCommentsFiles('input/TICKET', [{ body: 'b' }]);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(writes.length, 1, 'the json file is still written');
        assert.equal(warnings.length, 1);
        assert.contains(warnings[0], 'failed to write confluence_output_comments.md');
    });
});

// ── gh-1224: publishCommentReplies characterization ──────────────────────────

suite('contentOutput.publishCommentReplies (gh-1224)', function() {

    function libReading(raw, repliesPosted, opts) {
        var posted = [];
        return {
            lib: loadLibWithGlobals({
                file_read: function(opts2) { return raw; },
                confluence_reply_to_inline_comment: function(args) {
                    if (repliesPosted && repliesPosted.throwOn === args.commentId) {
                        throw (repliesPosted.error || new Error('comment gone'));
                    }
                    posted.push(args);
                }
            }),
            posted: posted
        };
    }

    test('a whitespace-only replies file posts nothing', function() {
        var h = libReading('   \n\t  ');
        assert.deepEqual(h.lib.publishCommentReplies('outputs/confluence_replies.json'), { posted: 0, failed: 0 });
        assert.equal(h.posted.length, 0);
    });

    test('an empty object payload posts nothing', function() {
        var h = libReading('{}');
        assert.deepEqual(h.lib.publishCommentReplies('outputs/confluence_replies.json'), { posted: 0, failed: 0 });
    });

    test('the { replies: [...] } wrapper shape is accepted (2+ replies)', function() {
        var h = libReading(JSON.stringify({
            replies: [
                { pageId: 'p1', commentId: 'c1', body: 'Fixed one' },
                { pageId: 'p2', commentId: 'c2', body: 'Fixed two' }
            ]
        }));
        var result = h.lib.publishCommentReplies('outputs/confluence_replies.json');
        assert.deepEqual(result, { posted: 2, failed: 0 });
        assert.equal(h.posted[0].pageId, 'p1');
        assert.equal(h.posted[1].commentId, 'c2');
    });

    test('a scalar payload posts nothing', function() {
        var h = libReading('"just a string"');
        assert.deepEqual(h.lib.publishCommentReplies('outputs/confluence_replies.json'), { posted: 0, failed: 0 });
    });

    test('entries missing any coordinate are counted failed without a post call', function() {
        var h = libReading(JSON.stringify([
            { commentId: 'c1', body: 'no pageId' },
            { pageId: 'p1', body: 'no commentId' },
            { pageId: 'p1', commentId: 'c3' },
            { pageId: 'p1', commentId: 'c4', body: 'complete' }
        ]));
        var result = h.lib.publishCommentReplies('outputs/confluence_replies.json');
        assert.deepEqual(result, { posted: 1, failed: 3 });
        assert.equal(h.posted.length, 1);
        assert.equal(h.posted[0].commentId, 'c4');
    });

    test('a null entry is counted failed without crashing', function() {
        var h = libReading(JSON.stringify([null, { pageId: 'p1', commentId: 'c2', body: 'ok' }]));
        var result = h.lib.publishCommentReplies('outputs/confluence_replies.json');
        assert.deepEqual(result, { posted: 1, failed: 1 });
    });

    test('a failing reply post is counted failed and the rest are still posted', function() {
        var h = libReading(JSON.stringify([
            { pageId: 'p1', commentId: 'c1', body: 'will fail' },
            { pageId: 'p1', commentId: 'c2', body: 'will pass' }
        ]), { throwOn: 'c1' });
        var result = h.lib.publishCommentReplies('outputs/confluence_replies.json');
        assert.deepEqual(result, { posted: 1, failed: 1 });
        assert.deepEqual(h.posted.map(function(a) { return a.commentId; }), ['c2']);
    });

    test('an unreadable replies file reports zeros', function() {
        var lib = loadLibWithGlobals({
            file_read: function() { throw new Error('enoent'); },
            confluence_reply_to_inline_comment: function() {}
        });
        assert.deepEqual(lib.publishCommentReplies('outputs/confluence_replies.json'), { posted: 0, failed: 0 });
    });

    test('an unparseable replies file reports zeros', function() {
        var lib = loadLibWithGlobals({
            file_read: function() { return '{not json'; },
            confluence_reply_to_inline_comment: function() {}
        });
        assert.deepEqual(lib.publishCommentReplies('outputs/confluence_replies.json'), { posted: 0, failed: 0 });
    });

    test('the default replies file path is used when no path is passed', function() {
        var readPaths = [];
        var lib = loadLibWithGlobals({
            file_read: function(opts) { readPaths.push(opts.path || opts); return null; },
            confluence_reply_to_inline_comment: function() {}
        });
        lib.publishCommentReplies();
        assert.ok(readPaths.indexOf('outputs/confluence_replies.json') !== -1,
            'reads ' + JSON.stringify(readPaths) + ' — expected the DEFAULT_REPLIES_FILE');
    });
});
