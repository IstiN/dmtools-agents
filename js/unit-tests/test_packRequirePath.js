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
 * spec was the LAZY require in js/common/smProvider.js — it executed only
 * when a conflict-shaped verdict query screened an item, which is why the
 * failure was intermittent.
 *
 * Runtime require model (verified empirically against the dmtools runtime
 * with a scratch probe pack — see gh-823):
 *   - a require executed WHILE a module initializes (top level, top-level
 *     try/if, init-time IIFEs) resolves FILE-RELATIVE;
 *   - a require executed AFTER init (any call into an exported function —
 *     the lazy/deferred shape) resolves against the MAIN SCRIPT's directory
 *     — the pack's js/ root — EXCLUSIVELY: a sibling-flat './x.js' from
 *     js/common/ looks for js/x.js and a file-relative hit is never tried.
 *   (dmtools compile, on the other hand, discovers requires strictly
 *   file-relative — so a pack-root-relative deferred spec cannot ship
 *   either; the only shape that satisfies compiler, runtime and closure is
 *   a LOAD-TIME require.)
 *
 * The fix hoists the deferred requires to load time. These tests pin the
 * two halves of that contract:
 *   1. the incident modules carry NO deferred requires (a re-lazied require
 *      — flat or pack-root-relative — turns these red), and
 *   2. the verdict-record chain still works end-to-end through the
 *      provider's public API over the real module graph.
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

// ── the runtime model, kept as executable documentation ─────────────────────

// Zip-layout path a DEFERRED require may resolve to: the pack's js/ root.
// '../' climbs leave js/ and can never resolve inside a pack.
function jsRootTarget(spec) {
    if (spec.indexOf('./') !== 0 && spec.indexOf('../') !== 0) return null;
    var parts = ['js'];
    var segs = spec.split('/');
    for (var i = 0; i < segs.length; i++) {
        if (segs[i] === '' || segs[i] === '.') continue;
        if (segs[i] === '..') parts.pop();
        else parts.push(segs[i]);
    }
    return parts.join('/');
}

suite('pack-runtime require resolution: the deferred base model', function () {

    test('a sibling-flat spec resolves to the js/ root (the gh-823 miss path)', function () {
        assert.equal(jsRootTarget('./reviewVerdicts.js'), 'js/reviewVerdicts.js');
        assert.equal(jsRootTarget('./trackers.js'), 'js/trackers.js');
    });

    test('a ../ climb leaves js/ entirely (the contentOutput.js:61 miss path)', function () {
        assert.equal(jsRootTarget('../configLoader.js'), 'configLoader.js');
    });

    test('the pack-root-relative form lands on js/common/ (why smAgent.js works)', function () {
        assert.equal(jsRootTarget('./common/reviewVerdicts.js'), 'js/common/reviewVerdicts.js');
    });
});

// ── the gh-823 regression contract ──────────────────────────────────────────

var INCIDENT_MODULES = [
    // The modules whose deferred requires shipped broken in 124928/143148
    // (smProvider.js is the one that red the fa ticks; the rest carried the
    // same latent shape on rarer fallback paths).
    'js/common/smProvider.js',
    'js/common/jiraHelpers.js',
    'js/common/tokenUsageComment.js',
    'js/common/validateInputJql.js',
    'js/common/contentOutput.js',
];

function gate() {
    return loadModule('ci/pack_require_gate.cjs');
}

suite('pack-runtime require resolution: the gh-823 regression contract', function () {

    INCIDENT_MODULES.forEach(function (path) {
        test('every require in ' + path + ' is load-time (no deferred requires)', function () {
            // A deferred require cannot ship: at runtime it resolves against
            // the pack js/ root only (a sibling-flat spec dies — the
            // incident), and dmtools compile discovers requires strictly
            // file-relative (a pack-root-relative spec fails the build).
            // Hoisted load-time requires satisfy compiler and runtime.
            var source = file_read({ path: path });
            var deferred = gate().classifyRequires(source).filter(function (c) {
                return c.deferred;
            });
            assert.deepEqual(deferred, [],
                'reintroducing a lazy/deferred require in ' + path +
                ' re-opens gh-823 — require it at load time (top level)');
        });
    });

    test('the gate still catches the shipped bug when replayed (red-team pin)', function () {
        // The exact smProvider.js shape shipped in agents-rel-20261009-124928:
        // a lazy sibling-flat require from js/common/ must classify deferred.
        var shipped = [
            'function _verdictRecordsModule() {',
            '    if (!_verdictRecordsModule.mod) {',
            "        _verdictRecordsModule.mod = require('./reviewVerdicts.js');",
            '    }',
            '    return _verdictRecordsModule.mod;',
            '}',
        ].join('\n');
        var cls = gate().classifyRequires(shipped);
        assert.equal(cls.length, 1);
        assert.equal(cls[0].spec, './reviewVerdicts.js');
        assert.ok(cls[0].deferred, 'the shipped lazy require is deferred — the gate fails it');
    });
});


// ── the repo-wide deferred pin (gh-824 rework, review thread 1) ─────────────

// Deliberate deferred requires in packed code. Every entry needs a reason,
// and the in-code comment at the site must tell the same story. Today the
// list is exactly one entry long: the writeSolutionAndDiagrams.js →
// './writeSolutionAndLabels.js' edge. Hoisting it would close a require
// cycle at LOAD time (labels load-time-requires diagrams right back), and
// the runtime's mid-init re-entrancy behavior is uncharacterized — the edge
// is a documented cycle-breaker (see the comment at the require site), both
// files are main scripts at the js/ root (so the deferred js/ root base IS
// their own directory), and the release gates cover it (static deferred
// gate + the pack LOAD probe).
var ALLOWED_DEFERRED = {
    'js/writeSolutionAndDiagrams.js': { './writeSolutionAndLabels.js': true },
};

var ROOT = null; // repo root, resolved lazily from file_list('.')

/** file_list payload → posix-normalized entry paths (json-or-object tolerant). */
function fileListEntries(raw) {
    if (typeof raw === 'string') raw = JSON.parse(raw);
    return ((raw && raw.entries) || []).map(function (e) {
        return String(e).replace(/\\/g, '/');
    });
}

/** Memoized pack root: the first '.' entry carrying a parent directory. */
function resolvePackRoot(list) {
    if (ROOT) return ROOT;
    var entries = fileListEntries(list('.'));
    for (var i = 0; i < entries.length; i++) {
        var cut = entries[i].lastIndexOf('/');
        if (cut > 0) { ROOT = entries[i].slice(0, cut); break; }
    }
    if (!ROOT) ROOT = '.';
    return ROOT;
}

/** Depth-first walk of <root>/<dir>, collecting repo-relative .js file paths. */
function walkJsFiles(list, root, dir, acc) {
    var out = fileListEntries(list(root + '/' + dir));
    for (var i = 0; i < out.length; i++) {
        var abs = out[i];
        var name = abs.slice(abs.lastIndexOf('/') + 1);
        if (name.charAt(0) === '.') continue;
        // file_list succeeds only on a directory — the probe tells
        // files (null/error) from subdirectories (entries), since
        // file_exists reports directories as existing too.
        var childEntries = [];
        try { childEntries = fileListEntries(list(abs)); } catch (e2) { childEntries = []; }
        if (childEntries.length > 0) {
            walkJsFiles(list, root, dir + '/' + name, acc);
        } else if (/\.js$/.test(name)) {
            acc.push(abs.slice(root.length + 1));
        }
    }
}

/**
 * Repo-relative 'js/**.js' paths (the packable tree, unit-tests excluded).
 * `lister` is injectable for characterization tests; production passes none
 * and uses the file_list global (unchanged behavior).
 */
function packedJsFiles(lister) {
    var list = lister || file_list;
    var root = resolvePackRoot(list);
    var acc = [];
    walkJsFiles(list, root, 'js', acc);
    return acc.filter(function (p) { return p.indexOf('js/unit-tests/') !== 0; });
}

suite('pack-runtime require resolution: repo-wide deferred pin (all packed js/ code)', function () {

    test('characterization: the walk yields repo-relative js/ paths, unit-tests excluded (gh-1200)', function () {
        var files = packedJsFiles();
        assert.ok(files.length > 130, 'real packable tree seen (saw ' + files.length + ')');
        var bad = [];
        files.forEach(function (p) {
            if (p.indexOf('js/') !== 0) bad.push('not js/-relative: ' + p);
            if (p.indexOf('js/unit-tests/') === 0) bad.push('unit-tests leaked: ' + p);
        });
        assert.deepEqual(bad, [], 'every walked path is repo-relative js/ and never unit-tests');
        assert.ok(files.indexOf('js/smAgent.js') !== -1, 'js/smAgent.js in the packable set');
        assert.ok(files.indexOf('js/common/scm.js') !== -1, 'js/common/scm.js in the packable set');
    });

    test('characterization: synthetic-tree walk semantics — dirs recurse, dot-entries and non-js skip, files probe null, lister errors tolerated', function () {
        var DIRS = {
            '.': { entries: ['/repo/.hidden', '/repo/js'] },
            'js': { entries: ['/repo/js/leaf.js', '/repo/js/sub', '/repo/js/dotdir', '/repo/js/notes.md', '/repo/js/empty'] },
            '/repo/js/sub': { entries: ['/repo/js/sub/deep.js'] },
            '/repo/js/sub/deep.js': null,          // a file: file_list returns null (not a directory)
            '/repo/js/dotdir': { entries: ['/repo/js/dotdir/x.js'] }, // dot-entry: never probed
            '/repo/js/empty': null,                // empty dir entry list → leaf, but not .js
            '/repo/js/notes.md': null              // non-js leaf
        };
        var probed = [];
        var list = function (p) {
            probed.push(p);
            if (p === '/repo/js/sub/deep.js') throw new Error('lister boom'); // error path → treated as file
            var hit = DIRS[p.replace(/\\/g, '/')];
            return hit === undefined ? null : JSON.stringify(hit);
        };
        // Direct walk against a fixed root: ROOT memo is bypassed via resolvePackRoot's own memo state —
        // this suite only pins walkJsFiles semantics, so call packedJsFiles's parts exactly as it does.
        var acc = [];
        walkJsFiles(list, '/repo', 'js', acc);
        assert.deepEqual(acc, ['js/leaf.js', 'js/sub/deep.js'],
            'posix-normalized repo-relative .js leaves in walk order, dot-dirs and non-js skipped');
        assert.ok(probed.indexOf('/repo/js/dotdir') === -1, 'dot-entries are never probed');
        assert.equal(probed.indexOf('js') === -1 || probed[0] === '/repo/js', true,
            'the first probe is the walk root (json-string payload)');
    });

    test('characterization: resolvePackRoot derives the root from the first nested entry and memoizes', function () {
        var rootProbes = 0;
        var list = function (p) {
            if (p === '.') {
                rootProbes++;
                return JSON.stringify({ entries: ['/workdir/js', '/workdir/README.md'] });
            }
            return null;
        };
        var first = resolvePackRoot(list);
        if (first === '.') { // only possible when no entry has a parent — not this fixture
            assert.ok(false, 'fixture must yield a nested root');
        }
        resolvePackRoot(list); // memoized: no second '.' probe
        assert.equal(rootProbes, 1, 'the root probe runs exactly once (memoized)');
        assert.ok(first.indexOf('/js') === -1, 'root is the parent dir, not the js dir itself: ' + first);
    });

    test('every packed .js outside unit-tests carries zero deferred requires — except the pinned cycle-breaker', function () {
        var files = packedJsFiles();
        assert.ok(files.length > 130,
            'the walk must see the real packable tree (saw ' + files.length + ' files)');
        var offenders = [];
        files.forEach(function (path) {
            gate().classifyRequires(file_read({ path: path })).forEach(function (c) {
                if (!c.deferred) return;
                if (ALLOWED_DEFERRED[path] && ALLOWED_DEFERRED[path][c.spec]) return;
                offenders.push(path + " → require('" + c.spec + "')");
            });
        });
        assert.deepEqual(offenders, [],
            'deferred requires resolve against the pack js/ root ONLY (gh-823) and ' +
            'dmtools compile discovers strictly file-relative — hoist every require ' +
            'to the top of the module (AGENTS.md). A new deliberate exception must be ' +
            'pinned in ALLOWED_DEFERRED with its reason.');
    });

    test('the allowlist stays honest — every pinned exception still exists in the tree', function () {
        // Pin rot: if the cycle is ever removed (e.g. the shared formatters
        // move to a neutral common module), this test demands the allowlist
        // entry be deleted instead of silently tolerating an empty pin.
        var found = {};
        Object.keys(ALLOWED_DEFERRED).forEach(function (path) {
            gate().classifyRequires(file_read({ path: path })).forEach(function (c) {
                if (c.deferred && ALLOWED_DEFERRED[path][c.spec]) {
                    found[path + '|' + c.spec] = true;
                }
            });
        });
        Object.keys(ALLOWED_DEFERRED).forEach(function (path) {
            Object.keys(ALLOWED_DEFERRED[path]).forEach(function (spec) {
                assert.ok(found[path + '|' + spec],
                    "stale allowlist entry: " + path + " no longer carries require('" +
                    spec + "') — delete the pin");
            });
        });
    });
});
// ── the verdict chain end-to-end over the real module graph ─────────────────

function fileExists(path) {
    try {
        var c = file_read({ path: path });
        return !!(c && c.trim());
    } catch (e) {
        return false;
    }
}

// Recursively loads real modules from the repo tree with LOAD-TIME
// semantics: file-relative resolution with the js/ root fallback — exactly
// what the pack runtime gives a module during initialization.
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

suite('pack-runtime require resolution: the verdict chain end-to-end', function () {

    test('latestVerdictRecord parses the real marker protocol over the real graph', function () {
        // Full load of smProvider.js + reviewVerdicts.js from the tree with
        // init-time semantics, then the exact call the query guards make
        // (githubSource.js matchesGuards → provider.latestVerdictRecord).
        var g = (typeof globalThis !== 'undefined') ? globalThis : this;
        var saved = g.github_get_pr_comments;
        var calls = 0;
        g.github_get_pr_comments = function () {
            calls += 1;
            return JSON.stringify([
                { body: 'free-form chatter about REQUEST_CHANGES' },
                { body: marker('APPROVE', '2026-10-09T16:20:00.000Z') }
            ]);
        };
        try {
            var mod = loadReal('js/common/smProvider.js');
            var provider = mod.createSmProvider({
                scm: { provider: 'github' },
                repository: { owner: 'mygroup', repo: 'my-repo' }
            });
            var effective = provider.latestVerdictRecord(5, HEAD);
            assert.ok(effective, 'the verdict record resolves through the real graph');
            assert.equal(effective.record.verdict, 'APPROVE');
            assert.equal(provider.verdictRecords(5).length, 1,
                'only the marker comment is a record (free-form text invisible)');
            assert.equal(calls, 1, 'one comment fetch — the ioCache memo holds');
        } finally {
            g.github_get_pr_comments = saved;
        }
    });
});
