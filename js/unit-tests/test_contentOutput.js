/**
 * Unit tests for the inline comment anchor helpers in js/common/contentOutput.js:
 *   - extractInlineCommentMarkers
 *   - injectCommentPlaceholders
 *   - applyCommentAnchorsToStorageBody
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

suite('contentOutput.applyCommentAnchorsToStorageBody', function() {

    test('converts agent placeholder into real marker', function() {
        var lib = loadLib();
        var body = '<ul><li>' + '[[ic:' + REF_A + ']]' + 'Item one' + '[[/ic]]' + '</li></ul>';
        var result = lib.applyCommentAnchorsToStorageBody(body, [
            { commentId: '1', markerRef: REF_A, originalSelection: 'Item one', resolved: false }
        ]);
        assert.deepEqual(result.restored, [REF_A]);
        assert.ok(result.body.indexOf('<ac:inline-comment-marker ac:ref="' + REF_A + '">Item one</ac:inline-comment-marker>') !== -1);
        assert.ok(result.body.indexOf('[[ic:') === -1);
    });

    test('falls back to originalSelection text match when placeholder is lost', function() {
        var lib = loadLib();
        var body = '<ul><li>Item one</li><li>Item two</li></ul>';
        var result = lib.applyCommentAnchorsToStorageBody(body, [
            { commentId: '1', markerRef: REF_A, originalSelection: 'Item one', resolved: false }
        ]);
        assert.deepEqual(result.restored, [REF_A]);
        assert.ok(result.body.indexOf('<ac:inline-comment-marker ac:ref="' + REF_A + '">Item one</ac:inline-comment-marker>') !== -1);
    });

    test('matches HTML-escaped anchor text in storage', function() {
        var lib = loadLib();
        var body = '<p>Use Foo &amp; Bar here</p>';
        var result = lib.applyCommentAnchorsToStorageBody(body, [
            { commentId: '1', markerRef: REF_A, originalSelection: 'Foo & Bar', resolved: false }
        ]);
        assert.deepEqual(result.restored, [REF_A]);
        assert.ok(result.body.indexOf('ac:inline-comment-marker') !== -1);
    });

    test('skips resolved comments and comments without markerRef', function() {
        var lib = loadLib();
        var body = '<ul><li>Item one</li></ul>';
        var result = lib.applyCommentAnchorsToStorageBody(body, [
            { commentId: '1', markerRef: REF_A, originalSelection: 'Item one', resolved: true },
            { commentId: '2', markerRef: null, originalSelection: 'Item one', resolved: false }
        ]);
        assert.equal(result.body, body);
        assert.deepEqual(result.restored, []);
    });

    test('leaves already-anchored comments untouched', function() {
        var lib = loadLib();
        var body = '<ul><li><ac:inline-comment-marker ac:ref="' + REF_A + '">Item one</ac:inline-comment-marker></li></ul>';
        var result = lib.applyCommentAnchorsToStorageBody(body, [
            { commentId: '1', markerRef: REF_A, originalSelection: 'Item one', resolved: false }
        ]);
        assert.deepEqual(result.restored, [REF_A]);
        assert.equal(result.body, body);
    });

    test('reports missed when anchor text is gone', function() {
        var lib = loadLib();
        var body = '<p>Completely new content</p>';
        var result = lib.applyCommentAnchorsToStorageBody(body, [
            { commentId: '1', markerRef: REF_A, originalSelection: 'Item one', resolved: false }
        ]);
        assert.deepEqual(result.missed, [REF_A]);
        assert.equal(result.body, body);
    });

    test('strips leftover placeholder tags with unknown refs', function() {
        var lib = loadLib();
        var body = '<ul><li>' + '[[ic:' + REF_B + ']]' + 'Some text' + '[[/ic]]' + '</li></ul>';
        var result = lib.applyCommentAnchorsToStorageBody(body, []);
        assert.ok(result.body.indexOf('[[ic:') === -1);
        assert.ok(result.body.indexOf('[[/ic]]') === -1);
        assert.ok(result.body.indexOf('Some text') !== -1);
    });

    test('handles multiple comments on the same body', function() {
        var lib = loadLib();
        var body = '<ul><li>Item one</li><li>Item two</li></ul>';
        var result = lib.applyCommentAnchorsToStorageBody(body, [
            { commentId: '1', markerRef: REF_A, originalSelection: 'Item one', resolved: false },
            { commentId: '2', markerRef: REF_B, originalSelection: 'Item two', resolved: false }
        ]);
        assert.equal(result.restored.length, 2);
        assert.ok(result.body.indexOf('ac:ref="' + REF_A + '"') !== -1);
        assert.ok(result.body.indexOf('ac:ref="' + REF_B + '"') !== -1);
    });
});
