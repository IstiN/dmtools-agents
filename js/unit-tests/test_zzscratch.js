/* global loadModule, assert, test, suite, makeRequire */
suite('scratch', function () {
    test('typeof undeclared bridge global inside loadModule eval', function () {
        var m = loadModule('js/unit-tests/_zzscratch_module.js', makeRequire({}), {});
        assert.equal(m.t, 'SHOW_ME:' + m.t);
    });
    test('typeof in test-file top scope', function () {
        assert.equal(typeof github_add_labels, 'SHOW_ME:' + (typeof github_add_labels));
    });
});
