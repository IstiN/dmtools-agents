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
        makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } } }),
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

