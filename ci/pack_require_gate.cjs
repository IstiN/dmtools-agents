'use strict';
/**
 * Pack-release require sanity gate (gh-812, live incident 2026-10-09).
 *
 * The release self-test demanded by gh-812 AC1/AC3: after a pack zip is
 * built, every literal relative `require('./x')` / `require('../y')` in
 * every packed .js must resolve to a file INSIDE the zip — a pack whose
 * code requires a module the zip does not carry must FAIL the release
 * (exit != 0) before the ledger commit and the publish, not live on the
 * fa runners ("Failed to require module: ./reviewVerdicts.js").
 *
 * validatePack() cannot catch this class: it re-hashes manifest entries
 * against themselves, which proves the zip matches its manifest, never
 * that the payload is self-consistent.
 *
 * Pure classification — no fs, no zip, no exec: the caller (ci/release_packs.mjs)
 * extracts the zip and hands over {path, source} records; this CommonJS twin
 * of the builder keeps the decisions unit-testable in the dmtools runner
 * (same split as ci/pack_release_guard.cjs).
 *
 * Known limit (documented, gh-812 test plan): dynamically assembled requires
 * (`require(prefix + name + '.js')`) cannot be resolved statically and are
 * ignored. The require that broke the incident was a string literal, and
 * every require in this repo's packed code is. Comment/JSdoc text is NOT
 * stripped — the runtime resolver union (see resolveRequireCandidates) kept
 * every doc example in this repo resolvable, and stripping risks missing a
 * real require swallowed by a misdetected regex literal.
 */

/** Literal relative require: require('./a.js'), require ("../b/c.js"). */
var REQUIRE_RE = /\brequire\s*\(\s*(['"])((?:\.\.?\/)[^'"]*)\1\s*\)/g;

/**
 * String-literal relative require specs in [source], in order.
 * Bare ids ('dmtools') and dynamic requires are out of scope — see header.
 */
function requireSpecs(source) {
    var specs = [];
    // Fresh stateful copy per call: a shared /g regex carries lastIndex
    // across calls (and resetting it mid-loop would rematch forever).
    var re = new RegExp(REQUIRE_RE.source, 'g');
    var m = re.exec(source);
    while (m !== null) {
        specs.push(m[2]);
        m = re.exec(source);
    }
    return specs;
}

/**
 * Zip-layout path for [spec] required from [fromPath], resolved against the
 * requiring file's directory ('.'/'..'/empty segments normalized away).
 */
function resolveRequire(fromPath, spec) {
    var parts = fromPath.split('/');
    parts.pop(); // the requiring file's directory
    return normalizePath(parts.concat(spec.split('/')));
}

/** Zip-layout path from [parts], '.'/'..'/empty segments normalized away. */
function normalizePath(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (seg === '' || seg === '.') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
    }
    return out.join('/');
}

/**
 * ALL zip paths [spec] may resolve to at runtime. dmtools' loader resolves
 * literal relative requires against BOTH the requiring file's directory
 * (Node-style siblings — js/common/commentMarkup.js requiring
 * './ticketKeyShapes.js') AND the pack's js/ module root (sources eval'd by
 * the worker engines are authored as if from js/ — githubSource.js worker
 * strings requiring './common/smProvider.js'; the gh-812 incident error
 * itself printed <pack>/js/reviewVerdicts.js for a spec required from
 * js/common/). A require is RESOLVED when any base finds the file, and
 * UNRESOLVED only when neither can — exactly the gh-812 class of packed
 * code requiring a file the zip does not carry.
 */
function resolveRequireCandidates(fromPath, spec) {
    var candidates = [resolveRequire(fromPath, spec)];
    if (spec.indexOf('./') === 0) {
        candidates.push(normalizePath(['js'].concat(spec.slice(2).split('/'))));
    }
    return candidates;
}

/**
 * Membership test across both container shapes the gate accepts: a plain
 * object map (path → true) or a Set. A live red-team run caught the naive
 * `paths[target]` read silently failing on a Set — every require read as
 * unresolved.
 */
function pathSetHas(paths, key) {
    if (paths && typeof paths.has === 'function') return paths.has(key);
    return !!(paths && paths[key]);
}

/**
 * Requires in [files] ({path, source}) that resolve to no path in
 * [knownPaths] (defaults to the files' own paths; plain object map or Set).
 * Returns [{from, spec, target, bases}] — empty means the pack is
 * self-consistent. [target] is the file-relative resolution (primary);
 * [bases] lists every zip path that was tried.
 */
function unresolvedRequires(files, knownPaths) {
    var paths = knownPaths;
    var i;
    if (!paths) {
        paths = {};
        for (i = 0; i < files.length; i++) paths[files[i].path] = true;
    }
    var unresolved = [];
    for (i = 0; i < files.length; i++) {
        var specs = requireSpecs(files[i].source || '');
        for (var s = 0; s < specs.length; s++) {
            var bases = resolveRequireCandidates(files[i].path, specs[s]);
            var resolved = false;
            for (var b = 0; b < bases.length; b++) {
                if (pathSetHas(paths, bases[b]) || pathSetHas(paths, bases[b] + '.js')) {
                    resolved = true;
                    break;
                }
            }
            if (!resolved) {
                unresolved.push({
                    from: files[i].path,
                    spec: specs[s],
                    target: bases[0],
                    bases: bases,
                });
            }
        }
    }
    return unresolved;
}

module.exports = {
    requireSpecs: requireSpecs,
    resolveRequire: resolveRequire,
    resolveRequireCandidates: resolveRequireCandidates,
    unresolvedRequires: unresolvedRequires,
};
