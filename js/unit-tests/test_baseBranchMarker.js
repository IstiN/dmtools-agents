/**
 * Unit tests for js/common/baseBranchMarker.js
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadBaseBranchMarker(mocks) {
    return loadModule('js/common/baseBranchMarker.js', makeRequire({}), mocks || {});
}

suite('baseBranchMarker.writeBaseBranchMarker', function() {

    test('writes the branch name to outputs/pr_base_branch.txt', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker('develop/3.9.0');

        assert.equal(writeCalls.length, 1);
        assert.equal(writeCalls[0].path, 'outputs/pr_base_branch.txt');
        assert.equal(writeCalls[0].content, 'develop/3.9.0');
    });

    test('coerces a non-string branch value to a string', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker(123);

        assert.equal(writeCalls.length, 1);
        assert.equal(writeCalls[0].content, '123');
    });

    test('is a no-op when baseBranch is falsy', function() {
        var writeCalls = [];
        var mod = loadBaseBranchMarker({
            file_write: function(opts) { writeCalls.push(opts); }
        });

        mod.writeBaseBranchMarker(null);
        mod.writeBaseBranchMarker(undefined);
        mod.writeBaseBranchMarker('');

        assert.equal(writeCalls.length, 0);
    });

    test('swallows file_write errors (non-fatal)', function() {
        var mod = loadBaseBranchMarker({
            file_write: function() { throw new Error('disk full'); }
        });

        // Should not throw.
        mod.writeBaseBranchMarker('master');
    });

});
