/**
 * Unit tests: the pack-release require sanity gate (gh-812).
 *
 * Guards the gh-812 incident class (live 2026-10-09 09:36-09:52Z): a pack
 * whose code requires a module the zip does not carry sailed through
 * validatePack() (which only re-hashes manifest entries against themselves)
 * and shipped; version-keyed consumer caches then ran the requiring code
 * against an installed tree without the file — every fa machine-sm tick
 * failed with "Failed to require module: ./reviewVerdicts.js".
 *
 * The gate (ci/pack_require_gate.cjs) is the release self-test demanded by
 * gh-812 AC1/AC3: after build, every literal relative require in every
 * packed .js must resolve to a file inside the zip, or the release fails
 * (exit != 0) BEFORE the ledger commit and publish.
 *
 * L2 red-team fixture ("replay the 091304 content set"): the mixed state the
 * fa runners actually executed — post-gh-807 requiring code over an installed
 * tree without js/common/reviewVerdicts.js. The gate MUST report it.
 *
 * Uses: loadModule(), suite(), test(), assert
 */

'use strict';

/* global loadModule, assert, test, suite */

function gate() {
    return loadModule('ci/pack_require_gate.cjs');
}

// ── require spec extraction ──────────────────────────────────────────────────

suite('require gate: literal relative require extraction', function () {

    test('a top-level literal require is found', function () {
        var specs = gate().requireSpecs("var x = require('./common/reviewVerdicts.js');");
        assert.deepEqual(specs, ['./common/reviewVerdicts.js']);
    });

    test('a lazy require nested in a function body is found (smProvider.js:151 shape)', function () {
        // gh-812: the require that broke the fa ticks is NOT top-level — it
        // sits inside a method body. A walker that only scans the module
        // top level misses it; the gate must not.
        var source = [
            'var mod = null;',
            'function getVerdicts() {',
            '    if (!mod) {',
            "        mod = require('./reviewVerdicts.js');",
            '    }',
            '    return mod;',
            '}',
        ].join('\n');
        assert.deepEqual(gate().requireSpecs(source), ['./reviewVerdicts.js']);
    });

    test('double-quoted requires are found', function () {
        var specs = gate().requireSpecs('var x = require("../common/scm.js");');
        assert.deepEqual(specs, ['../common/scm.js']);
    });

    test('whitespace inside the call does not hide the spec', function () {
        var specs = gate().requireSpecs("var x = require( './a.js' );");
        assert.deepEqual(specs, ['./a.js']);
    });

    test('multiple requires in one source are all found, in order', function () {
        var source = [
            "var a = require('./common/scm.js');",
            "var b = require('./configLoader.js');",
        ].join('\n');
        assert.deepEqual(gate().requireSpecs(source),
            ['./common/scm.js', './configLoader.js']);
    });

    test('bare module ids are ignored (not relative, not resolvable in the zip)', function () {
        assert.deepEqual(gate().requireSpecs("var x = require('dmtools');"), []);
    });

    test('dynamic (non-literal) requires are ignored — documented static-gate limit', function () {
        assert.deepEqual(gate().requireSpecs('var x = require(prefix + name + ".js");'), []);
    });

    test('a source with no requires yields an empty list', function () {
        assert.deepEqual(gate().requireSpecs('var x = 1;'), []);
    });
});

// ── resolution against the zip file set ──────────────────────────────────────

suite('require gate: relative resolution against the zip layout', function () {

    test('./ resolves inside the requiring file directory', function () {
        assert.equal(
            gate().resolveRequire('js/common/smProvider.js', './reviewVerdicts.js'),
            'js/common/reviewVerdicts.js');
    });

    test('../ climbs one directory', function () {
        assert.equal(
            gate().resolveRequire('js/common/smProvider.js', '../configLoader.js'),
            'js/configLoader.js');
    });

    test('the result is zip-layout normalized (no ./ segments, no leading slash)', function () {
        assert.equal(
            gate().resolveRequire('js/smAgent.js', '././common//reviewVerdicts.js'),
            'js/common/reviewVerdicts.js');
    });

    test('union resolution: the js/ module root is a second base (worker-source shape)', function () {
        // githubSource.js embeds worker sources authored as if from js/:
        // require('./common/smProvider.js') from js/sm/sources/ resolves via
        // the js/ ROOT, not the requiring file's directory.
        var bases = gate().resolveRequireCandidates('js/sm/sources/githubSource.js', './common/smProvider.js');
        assert.deepEqual(bases, ['js/sm/sources/common/smProvider.js', 'js/common/smProvider.js']);
    });

    test('a ../ spec has only the file-relative base (climbing out of js/ is meaningless in a pack)', function () {
        var bases = gate().resolveRequireCandidates('js/common/smProvider.js', '../configLoader.js');
        assert.deepEqual(bases, ['js/configLoader.js']);
    });
});

suite('require gate: the self-test verdict', function () {

    test('a complete pack resolves clean (the 091304 zip shape, WITH the file)', function () {
        // Verified against the real agents-rel-20261009-091304 artifact: the
        // shipped zip DOES carry js/common/reviewVerdicts.js — a complete,
        // self-consistent pack must pass the gate.
        var files = [
            { path: 'js/smAgent.js', source: "var m = require('./common/reviewVerdicts.js');" },
            { path: 'js/common/smProvider.js', source: "var m = require('./reviewVerdicts.js');" },
            { path: 'js/common/reviewVerdicts.js', source: 'var x = 1;' },
        ];
        assert.deepEqual(gate().unresolvedRequires(files), []);
    });

    test('L2 red-team: the mixed 091304-content shape FAILS — requiring code without the file', function () {
        // What the fa runners executed at 09:36Z: post-gh-807 smProvider.js
        // (lazy require of ./reviewVerdicts.js) over an installed 0.1.36 tree
        // from 075526 — 16 js files, js/common/reviewVerdicts.js absent.
        var files = [
            { path: 'js/smAgent.js', source: "var m = require('./common/reviewVerdicts.js');" },
            { path: 'js/common/smProvider.js', source: [
                'var mod = null;',
                'function f() {',
                "    mod = require('./reviewVerdicts.js');",
                '}',
            ].join('\n') },
            { path: 'js/common/scm.js', source: 'var x = 1;' },
        ];
        var unresolved = gate().unresolvedRequires(files);
        assert.equal(unresolved.length, 2,
            'the gate must fail the release for this pack (gh-812 AC3: exit != 0)');
        var targets = unresolved.map(function (u) { return u.target; }).sort();
        assert.deepEqual(targets, ['js/common/reviewVerdicts.js', 'js/common/reviewVerdicts.js'].sort());
    });

    test('the 075526 shape (no require, no file) passes — nothing to resolve', function () {
        var files = [
            { path: 'js/smAgent.js', source: 'var x = 1;' },
            { path: 'js/common/smProvider.js', source: 'var y = 2;' },
        ];
        assert.deepEqual(gate().unresolvedRequires(files), []);
    });

    test('a worker-source require resolves via the js/ module root base', function () {
        // Real githubSource.js shape: the worker string only makes sense
        // root-relative — the gate must accept it when js/common/smProvider.js
        // is in the zip (a pure file-relative gate would false-positive it).
        var files = [
            { path: 'js/sm/sources/githubSource.js', source: "var W = ['function(args) {', \"    var mod = require('./common/smProvider.js');\", '}'].join('\\n');" },
            { path: 'js/common/smProvider.js', source: 'var x = 1;' },
        ];
        assert.deepEqual(gate().unresolvedRequires(files), []);
    });

    test('a worker-source require FAILS when the root-relative target is absent too', function () {
        var files = [
            { path: 'js/sm/sources/githubSource.js', source: "var W = ['function(args) {', \"    var mod = require('./common/absent.js');\", '}'].join('\\n');" },
        ];
        var unresolved = gate().unresolvedRequires(files);
        assert.equal(unresolved.length, 1);
        assert.deepEqual(unresolved[0].bases,
            ['js/sm/sources/common/absent.js', 'js/common/absent.js']);
    });

    test('each unresolved entry names the requiring file and the missing target', function () {
        var files = [
            { path: 'js/smAgent.js', source: "var m = require('./common/missing.js');" },
        ];
        var unresolved = gate().unresolvedRequires(files);
        assert.equal(unresolved.length, 1);
        assert.equal(unresolved[0].from, 'js/smAgent.js');
        assert.equal(unresolved[0].spec, './common/missing.js');
        assert.equal(unresolved[0].target, 'js/common/missing.js');
    });

    test('a Set-shaped knownPaths works — the builder passes zip walks as Sets', function () {
        // Live red-team regression (gh-812 verification): the builder's zip
        // walk collects paths into a Set; a naive `paths[target]` read on a
        // Set is always undefined and flagged EVERY require unresolved.
        var files = [
            { path: 'js/smAgent.js', source: "var m = require('./configLoader.js');" },
            { path: 'js/common/smProvider.js', source: "var m = require('./reviewVerdicts.js');" },
            { path: 'js/configLoader.js', source: 'var x = 1;' },
            { path: 'js/common/reviewVerdicts.js', source: 'var y = 2;' },
        ];
        var complete = new Set();
        complete.add('js/smAgent.js');
        complete.add('js/configLoader.js');
        complete.add('js/common/smProvider.js');
        complete.add('js/common/reviewVerdicts.js');
        assert.deepEqual(gate().unresolvedRequires(files, complete), [],
            'Set membership must resolve exactly like object-map membership');
        var missingFile = new Set();
        missingFile.add('js/smAgent.js');
        missingFile.add('js/configLoader.js');
        missingFile.add('js/common/smProvider.js');
        var unresolved = gate().unresolvedRequires(files, missingFile);
        assert.equal(unresolved.length, 1,
            'a Set that lacks the require target must still report it');
        assert.equal(unresolved[0].target, 'js/common/reviewVerdicts.js');
    });
});
