/**
 * Unit tests: pack-runtime require path resolution (gh-823).
 *
 * Live incident 2026-10-09 16:0x-16:2xZ (four consecutive red fa ticks):
 * every tick died with
 *
 *   ❌ state query failed: Failed to require module: ./reviewVerdicts.js
 *      (JavaScript file not found in resources or filesystem:
 *       <pack>/js/reviewVerdicts.js)
 *
 * while the pack zip was self-consistent (js/common/reviewVerdicts.js
 * shipped; smAgent.js requires './common/reviewVerdicts.js'). The offending
 * spec is the LAZY require in js/common/smProvider.js _verdictRecordsModule()
 * — it executes only when a conflict-shaped verdict query screens an item,
 * which is why the failure is intermittent.
 *
 * Runtime require model (verified empirically against the dmtools runtime
 * with a scratch probe pack — see gh-823):
 *   - a require executed WHILE a module initializes (top level, top-level
 *     try/if, init-time IIFEs) resolves FILE-RELATIVE;
 *   - a require executed AFTER init (any call into an exported function —
 *     the lazy/deferred shape) resolves against the MAIN SCRIPT's directory
 *     — the pack's js/ root — EXCLUSIVELY: a sibling-flat './x.js' from
 *     js/common/ looks for js/x.js and a file-relative hit is never tried.
 *
 * The harness cannot reproduce the timing split with one require shim, so
 * the deferred semantics are emulated directly: makePackRuntimeRequire()
 * is a js-root-ONLY require over the real tree, with the runtime's miss
 * message. js/common/smProvider.js carries no load-time requires, so
 * loading it under the js-root-only shim is exactly the pack runtime's
 * view of the module — and the lazy verdict-record path is exercised
 * through the real public API.
 *
 * Uses: loadModule(), suite(), test(), assert
 */

'use strict';

/* global loadModule, assert, test, suite, file_read */

var HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

function marker(verdict, at, head) {
    return '<!-- dmtools:review-verdict ' + JSON.stringify({
        head: head || HEAD, verdict: verdict, blocking: 0,
        important: 0, suggestions: 0, at: at, source: 'pr_review.json'
    }) + ' -->';
}

// ── pack-runtime (js-root-only) require over the real tree ──────────────────

function fileExists(path) {
    try {
        var c = file_read({ path: path });
        return !!(c && c.trim());
    } catch (e) {
        return false;
    }
}

// Zip-layout path a deferred require may resolve to: the pack's js/ root.
// '../' climbs leave js/ and can never resolve inside a pack.
function jsRootTarget(spec) {
    if (spec.indexOf('./') !== 0) return null;
    return 'js/' + spec.substring(2);
}

// Recursively loads real modules from the repo tree. Targets load with a
// UNION require (file-relative first, js-root fallback) — the init-time
// semantics a freshly-required module sees for ITS load-time requires.
var _moduleCache_ = {};

function loadReal(path) {
    if (_moduleCache_[path]) return _moduleCache_[path].exports;
    var from = path.split('/');
    from.pop();
    function unionRequire(id) {
        var parts = from.slice();
        var segs = id.split('/');
        for (var i = 0; i < segs.length; i++) {
            if (segs[i] === '' || segs[i] === '.') continue;
            if (segs[i] === '..') parts.pop();
            else parts.push(segs[i]);
        }
        var rel = parts.join('/');
        if (fileExists(rel)) return loadReal(rel);
        var root = jsRootTarget(id);
        if (root && fileExists(root)) return loadReal(root);
        throw new Error('Failed to require module: ' + id +
            ' (no file-relative or js/ root candidate in the tree)');
    }
    var mod = { exports: {} };
    _moduleCache_[path] = mod;
    var code = file_read({ path: path });
    var fn = eval(
        '(function(module, exports, require) {\n' + code + '\n})');
    fn(mod, mod.exports, unionRequire);
    return mod.exports;
}

// The deferred-call require: js-root base ONLY, runtime miss message.
function makePackRuntimeRequire() {
    return function (id) {
        var target = jsRootTarget(id);
        if (target && fileExists(target)) return loadReal(target);
        throw new Error('Failed to require module: ' + id +
            ' (JavaScript file not found in resources or filesystem: ' +
            (target || id) + ')');
    };
}

function loadProviderPackRuntime(comments) {
    var mod = loadModule('js/common/smProvider.js', makePackRuntimeRequire(), {
        github_get_pr_comments: function () {
            return JSON.stringify(comments);
        }
    });
    return mod.createSmProvider({
        scm: { provider: 'github' },
        repository: { owner: 'mygroup', repo: 'my-repo' }
    });
}

// ── the gh-823 incident chain ────────────────────────────────────────────────

suite('pack-runtime require resolution: the gh-823 incident chain', function () {

    test('latestVerdictRecord loads under js-root-only resolution (the deferred-call base)', function () {
        // The query guards call provider.latestVerdictRecord from
        // matchesGuards (js/sm/sources/githubSource.js) — post-init, so the
        // lazy require inside _verdictRecordsModule() runs with the pack's
        // js/ root as its ONLY base. The sibling-flat spec must die here;
        // the pack-root-relative one must parse the real marker protocol.
        var p = loadProviderPackRuntime([
            { body: 'free-form chatter about REQUEST_CHANGES' },
            { body: marker('APPROVE', '2026-10-09T16:20:00.000Z') }
        ]);
        var effective = p.latestVerdictRecord(5, HEAD);
        assert.ok(effective, 'the verdict record must resolve — no deferred-require miss');
        assert.equal(effective.record.verdict, 'APPROVE');
    });

    test('the guards\u2019 other entry point (verdictRecords) survives too', function () {
        var p = loadProviderPackRuntime([
            { body: marker('REQUEST_CHANGES', '2026-10-09T16:21:00.000Z') }
        ]);
        var records = p.verdictRecords(1428);
        assert.equal(records.length, 1);
        assert.equal(records[0].verdict, 'REQUEST_CHANGES');
    });

    test('a missing module still throws with the runtime miss message (guard keeps teeth)', function () {
        var requireFn = makePackRuntimeRequire();
        var threw = null;
        try {
            requireFn('./absent-module.js');
        } catch (e) {
            threw = e.message;
        }
        assert.ok(threw, 'a js-root miss must throw');
        assert.contains(threw, 'Failed to require module: ./absent-module.js');
        assert.contains(threw, 'js/absent-module.js');
    });
});
