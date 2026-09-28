/**
 * Unit tests: smAsync.js — parallel read fan-out with a sequential
 * fallback. The harness never wires runAsync, so the fallback path is the
 * default; a MOCK sync runAsync (evaluating the worker source in-process)
 * pins the batching plumbing: dispatch shape, ordering, toArgs mapping,
 * error propagation and the length<=1 / runAsync-absent fallbacks.
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('smAsync', function () {

    var MOD = 'js/common/smAsync.js';

    var WORKER = 'function(args) { return args * 2; }';
    var THROWER = 'function(args) { throw new Error("boom-" + args); }';
    var SUM_WORKER = 'function(args) { return args.a + args.b; }';

    // Sync fake of the Dart runAsync: evaluates the closure-free worker
    // source in-process (same trick the fallback uses).
    function makeFakeRunAsync(calls) {
        var fake = function (src, args) {
            calls.push({ src: src, args: args });
            return {
                wait: function () { return eval('(' + src + ')')(args); }
            };
        };
        fake.all = function (jobs) {
            return {
                wait: function () {
                    return jobs.map(function (j) { return j.wait(); });
                }
            };
        };
        return fake;
    }

    test('runAsync present + multiple items: dispatches one job per item, ordered results', function () {
        var calls = [];
        var mod = loadModule(MOD, makeRequire({}), { runAsync: makeFakeRunAsync(calls) });
        var out = mod.map([3, 1, 2], WORKER, function (n) { return n; });
        assert.deepEqual(out, [6, 2, 4], 'order preserved, per-item args mapped');
        assert.equal(calls.length, 3);
        assert.equal(calls[0].src, WORKER);
        assert.deepEqual(calls.map(function (c) { return c.args; }), [3, 1, 2]);
    });

    test('toArgs receives (item, index)', function () {
        var calls = [];
        var mod = loadModule(MOD, makeRequire({}), { runAsync: makeFakeRunAsync(calls) });
        var out = mod.map(['x', 'y'], SUM_WORKER, function (it, i) { return { a: it, b: i }; });
        assert.deepEqual(out, ['x0', 'y1']);
        assert.equal(calls[1].args.b, 1);
    });

    test('async path: a worker throw propagates out of map', function () {
        var calls = [];
        var mod = loadModule(MOD, makeRequire({}), { runAsync: makeFakeRunAsync(calls) });
        assert.throws(function () {
            mod.map([1, 2], THROWER, function (n) { return n; });
        });
    });

    test('fallback when runAsync is undefined: direct-eval, sequential, ordered', function () {
        var mod = loadModule(MOD, makeRequire({}), {});
        var out = mod.map([3, 1, 2], WORKER, function (n) { return n; });
        assert.deepEqual(out, [6, 2, 4]);
    });

    test('fallback when runAsync is undefined: worker throw propagates', function () {
        var mod = loadModule(MOD, makeRequire({}), {});
        assert.throws(function () {
            mod.map([1], THROWER, function (n) { return n; });
        });
    });

    test('single item falls back to sequential even with runAsync present', function () {
        var calls = [];
        var mod = loadModule(MOD, makeRequire({}), { runAsync: makeFakeRunAsync(calls) });
        var out = mod.map([7], WORKER, function (n) { return n; });
        assert.deepEqual(out, [14]);
        assert.equal(calls.length, 0, 'no runAsync dispatch for a single item');
    });

    test('fallback worker source sees the loader require via the scope chain', function () {
        // Direct eval must run the source in the current scope chain:
        // a require shim reachable from the module load is visible.
        var mod = loadModule(MOD, makeRequire({
            './double.js': { double: function (n) { return n * 3; } }
        }), {});
        var out = mod.map([2], 'function(args) { return require("./double.js").double(args); }',
            function (n) { return n; });
        assert.deepEqual(out, [6]);
    });
});
