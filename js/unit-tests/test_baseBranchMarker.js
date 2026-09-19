/**
 * Unit tests for js/common/baseBranchMarker.js
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadBaseBranchMarker(mocks) {
    return loadModule('js/common/baseBranchMarker.js', makeRequire({}), mocks || {});
}

function markerWrites(writeCalls) {
    return writeCalls.filter(function(c) { return c.path === 'outputs/pr_base_branch.txt'; });
}

function excludeWrites(writeCalls) {
    return writeCalls.filter(function(c) { return c.path === '.git/info/exclude'; });
}

suite('baseBranchMarker.writeBaseBranchMarker', function() {

    test('writes the branch name to outputs/pr_base_branch.txt', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_read: function() { return ''; },
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker('develop/3.9.0');

        var marker = markerWrites(writeCalls);
        assert.equal(marker.length, 1);
        assert.equal(marker[0].path, 'outputs/pr_base_branch.txt');
        assert.equal(marker[0].content, 'develop/3.9.0');
    });

    test('coerces a non-string branch value to a string', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_read: function() { return ''; },
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker(123);

        var marker = markerWrites(writeCalls);
        assert.equal(marker.length, 1);
        assert.equal(marker[0].content, '123');
    });

    test('is a no-op when baseBranch is falsy', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_read: function() { return ''; },
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker(null);
        mod.writeBaseBranchMarker(undefined);
        mod.writeBaseBranchMarker('');

        assert.equal(writeCalls.length, 0);
    });

    test('swallows file_write errors (non-fatal)', function() {
        var mod = loadBaseBranchMarker({
            file_read: function() { return ''; },
            file_write: function() { throw new Error('disk full'); }
        });

        // Should not throw.
        mod.writeBaseBranchMarker('master');
    });

    test('adds outputs/ to .git/info/exclude when absent', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_read: function(opts) { return opts.path === '.git/info/exclude' ? '*.bak\n' : ''; },
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker('master');

        var exclude = excludeWrites(writeCalls);
        assert.equal(exclude.length, 1);
        assert.ok(exclude[0].content.indexOf('*.bak') !== -1, 'preserves existing exclude content');
        assert.ok(exclude[0].content.indexOf('outputs/') !== -1, 'adds outputs/ entry');
    });

    test('does not rewrite .git/info/exclude when outputs/ already present', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_read: function(opts) { return opts.path === '.git/info/exclude' ? 'outputs/\n' : ''; },
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker('master');

        assert.equal(excludeWrites(writeCalls).length, 0);
    });

    test('still writes the marker file when .git/info/exclude update fails', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_read: function() { throw new Error('no repo'); },
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker('master');

        assert.equal(markerWrites(writeCalls).length, 1);
    });

});
