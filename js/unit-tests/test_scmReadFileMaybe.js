/**
 * Unit tests: scm.js file-read helpers (gh-1041).
 *
 * Characterization tests pinning the current behaviour of _readFileMaybe
 * before the git/SCM plumbing split: the dmtools file_read bridge accepts
 * BOTH the object form ({path: ...}) and the plain-string form, and real
 * builds have shipped both shapes — so the helper tolerates either, falling
 * back from the object form to the string form ONLY when the object form
 * THROWS (an empty/whitespace object-form result is NOT retried).
 */

/* global loadModule, assert, test, suite, makeRequire */

suite('scm file helpers > _readFileMaybe (gh-1041)', function() {

    function loadScm(mocks) {
        return scmReal(mocks || {});
    }

    test('returns the object-form content when file_read accepts {path}', function() {
        var calls = [];
        var scm = loadScm({
            file_read: function(arg) {
                calls.push(arg);
                return 'file content';
            }
        });

        assert.equal(scm._readFileMaybe('some/file.md'), 'file content');
        assert.deepEqual(calls, [{ path: 'some/file.md' }], 'object form tried first with the exact path');
    });

    test('returns null on whitespace-only object-form content without trying the string form', function() {
        var calls = [];
        var scm = loadScm({
            file_read: function(arg) {
                calls.push(arg);
                return '   \n  ';
            }
        });

        assert.equal(scm._readFileMaybe('some/file.md'), null, 'blank object-form result is not a readable file');
        assert.equal(calls.length, 1, 'string form is NOT retried when the object form returns blank');
    });

    test('returns null on empty object-form content without trying the string form', function() {
        var calls = [];
        var scm = loadScm({
            file_read: function(arg) {
                calls.push(arg);
                return '';
            }
        });

        assert.equal(scm._readFileMaybe('some/file.md'), null);
        assert.equal(calls.length, 1, 'string form is NOT retried when the object form returns empty');
    });

    test('returns null when the object form returns null', function() {
        var calls = [];
        var scm = loadScm({
            file_read: function(arg) {
                calls.push(arg);
                return null;
            }
        });

        assert.equal(scm._readFileMaybe('some/file.md'), null);
        assert.equal(calls.length, 1, 'string form is NOT retried when the object form returns null');
    });

    test('falls back to the string form when the object form throws', function() {
        var calls = [];
        var scm = loadScm({
            file_read: function(arg) {
                calls.push(arg);
                if (typeof arg === 'object') throw new Error('object form unsupported');
                return 'string-form content';
            }
        });

        assert.equal(scm._readFileMaybe('some/file.md'), 'string-form content');
        assert.deepEqual(calls, [{ path: 'some/file.md' }, 'some/file.md'],
            'string form receives the bare path, not the object');
    });

    test('returns null when both forms throw', function() {
        var scm = loadScm({
            file_read: function() { throw new Error('no such file'); }
        });

        assert.equal(scm._readFileMaybe('missing/file.md'), null);
    });

    test('returns null when the object form throws and the string form is blank', function() {
        var scm = loadScm({
            file_read: function(arg) {
                if (typeof arg === 'object') throw new Error('object form unsupported');
                return ' ';
            }
        });

        assert.equal(scm._readFileMaybe('some/file.md'), null, 'blank string-form content is not a readable file');
    });
});
