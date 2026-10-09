/**
 * Unit tests: the pack runtime LOAD self-test generator (gh-823).
 *
 * After every pack build the release extracts the zip, drops the generated
 * probe (renderProbeJs/renderProbeConfig) into it and runs `dmtools run` —
 * any module that fails to LOAD in the real runtime fails the release.
 * These tests pin the generated artifacts: the file selection, the probe's
 * failure reporting, and the config shape the runtime expects.
 *
 * Uses: loadModule(), suite(), test(), assert
 */

'use strict';

/* global loadModule, assert, test, suite */

function gen() {
    return loadModule('ci/pack_load_probe.cjs');
}

suite('pack load probe: file selection', function () {

    test('every packed js/ file is required, sorted, probe excluded', function () {
        var files = gen().probeFilesList([
            'js/smAgent.js',
            'js/common/smProvider.js',
            'manifest.json',
            'instructions/common/dmtools.md',
            '__pack_load_probe.js',
            'launch.json',
        ], '__pack_load_probe.js');
        assert.deepEqual(files, ['js/common/smProvider.js', 'js/smAgent.js']);
    });

    test('a Set-shaped walk works (the builder passes zip walks as Sets)', function () {
        var set = new Set();
        set.add('js/a.js');
        set.add('js/b/c.js');
        set.add('js/__pack_load_probe.js');
        assert.deepEqual(gen().probeFilesList(set, 'js/__pack_load_probe.js'),
            ['js/a.js', 'js/b/c.js']);
    });

    test('a non-js/ path is never required (the probe loads the payload only)', function () {
        var files = gen().probeFilesList(['root.js', 'docs/x.js', 'js/real.js'], 'p.js');
        assert.deepEqual(files, ['js/real.js']);
    });
});

suite('pack load probe: generated artifacts', function () {

    test('the probe requires every file and throws with the failing module named', function () {
        var src = gen().renderProbeJs(['js/a.js', 'js/b.js']);
        assert.contains(src, 'var FILES = ["js/a.js","js/b.js"];');
        assert.contains(src, 'function action() {');
        assert.contains(src, 'require(FILES[i])');
        assert.contains(src, 'pack runtime load self-test FAILED');
        // a missing module is captured per file and reported, never swallowed
        assert.contains(src, 'failed.push(FILES[i]');
    });

    test('the probe fails loudly when the file list is empty (no silent green)', function () {
        var src = gen().renderProbeJs([]);
        assert.contains(src, 'no .js required');
    });

    test('the generated eval\u2019d probe reports failures and succeeds on a clean pack', function () {
        // Execute the generated source in this harness (the same eval-shape
        // the runtime uses) with a require shim that fails one module — the
        // action() must throw naming it; with all modules present it must
        // return success with the count.
        var src = gen().renderProbeJs(['js/good.js', 'js/broken.js']);
        var results = {};
        var requireShim = function (id) {
            if (id === 'js/broken.js') throw new Error('Failed to require module: ' + id +
                ' (JavaScript file not found in resources or filesystem: ' + id + ')');
            results[id] = true;
            return {};
        };
        var logs = [];
        var fn = eval('(function(require, console) {\n' + src + '\nreturn action;\n})');
        var action = fn(requireShim, { log: function (m) { logs.push(m); } });
        assert.equal(results['js/good.js'], true, 'the healthy module was required');
        var threw = null;
        try {
            action();
        } catch (e) {
            threw = e.message;
        }
        assert.ok(threw, 'one broken module must fail the action');
        assert.contains(threw, '1 module(s) did not load');

        var ok = eval('(function(require, console) {\n' +
            gen().renderProbeJs(['js/a.js']) + '\nreturn action;\n})')(
            function () { return {}; }, { log: function () {} });
        assert.deepEqual(ok(), { success: true, required: 1 });
    });

    test('the config is a JSRunner config pointing at the probe', function () {
        var cfg = JSON.parse(gen().renderProbeConfig('__pack_load_probe.js'));
        assert.equal(cfg.name, 'JSRunner');
        assert.equal(cfg.params.jsPath, '__pack_load_probe.js');
    });
});
