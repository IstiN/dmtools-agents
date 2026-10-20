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
