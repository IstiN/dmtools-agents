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
 * every require in this repo's packed code is.
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
 * Zip-layout path for [spec] required from [fromPath]: resolved against the
 * requiring file's directory, '.'/'..'/empty segments normalized away.
 */
function resolveRequire(fromPath, spec) {
    var parts = fromPath.split('/');
    parts.pop(); // the requiring file's directory
    var segs = spec.split('/');
    for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        if (seg === '' || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    }
    return parts.join('/');
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
 * Returns [{from, spec, target}] — empty means the pack is self-consistent.
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
            var target = resolveRequire(files[i].path, specs[s]);
            if (!pathSetHas(paths, target) && !pathSetHas(paths, target + '.js')) {
                unresolved.push({ from: files[i].path, spec: specs[s], target: target });
            }
        }
    }
    return unresolved;
}

module.exports = {
    requireSpecs: requireSpecs,
    resolveRequire: resolveRequire,
    unresolvedRequires: unresolvedRequires,
};
