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
 * gh-823: the runtime resolves a require against DIFFERENT bases depending
 * on WHEN it executes:
 *   - load-time (module initialization: top level, top-level try/if blocks,
 *     init-time IIFEs) → file-relative;
 *   - deferred (any call into an exported function after init — the
 *     lazy-helper shape) → the MAIN script's directory (the pack's js/
 *     root) EXCLUSIVELY — a file-relative hit is never tried (verified
 *     against the dmtools runtime with a scratch probe pack; the shipped
 *     lazy './reviewVerdicts.js' from js/common/ died on js/reviewVerdicts.js
 *     while js/common/reviewVerdicts.js rode along in the zip).
 *
 * So the gate classifies every literal require the way the runtime executes
 * it: inside a FUNCTION body (arrow or `function`) = deferred; anything else
 * = load-time. Braces inside comments/strings never count (a `}` in a doc
 * comment must not close a function); string CONTENTS are still scanned for
 * require literals (the githubSource.js worker sources) and classified at
 * the code position of the string.
 *
 * Known limits (same class as the gh-812 header note): ES2015 method
 * shorthand (`foo() {}`) reads as a plain block — the repo's packed code is
 * `function`-style (GraalJS conventions), and a regex literal containing
 * `function` could misalign the pending-function flag (none in packed code).
 */
function functionDepths(source) {
    var n = source.length;
    var depths = new Array(n);
    var stack = [];
    var pendingFunction = 0;
    var fnCount = 0;
    var i = 0;
    var inLine = false;
    var inBlock = false;
    var inStr = null;
    var inRegex = false;
    var inRegexClass = false;
    var prevSig = ''; // last significant char outside comments/strings/regex
    var prevWord = ''; // last whole word outside comments/strings/regex
    var prev = ''; // block-comment end detection (`*/`)
    while (i < n) {
        var c = source.charAt(i);
        if (c === '\n') inLine = false;
        if (inLine) { depths[i] = fnCount; i++; prev = c; continue; }
        if (inBlock) {
            if (c === '/' && prev === '*') inBlock = false;
            depths[i] = fnCount;
            i++; prev = c; continue;
        }
        if (inStr !== null) {
            if (c === '\\') { depths[i] = fnCount; depths[i + 1] = fnCount; i += 2; prev = ''; continue; }
            if (c === inStr) {
                inStr = null;
                depths[i] = fnCount;
                i++; prevSig = c; prevWord = ''; continue;
            }
            depths[i] = fnCount;
            i++; prev = c; continue;
        }
        if (inRegex) {
            if (c === '\\') { depths[i] = fnCount; depths[i + 1] = fnCount; i += 2; prev = ''; continue; }
            if (c === '[') inRegexClass = true;
            else if (c === ']') inRegexClass = false;
            else if (c === '/' && !inRegexClass) inRegex = false;
            depths[i] = fnCount;
            i++; prev = c; continue;
        }
        if (c === '/' && source.charAt(i + 1) === '/') { inLine = true; depths[i] = fnCount; i++; prev = c; continue; }
        if (c === '/' && source.charAt(i + 1) === '*') { inBlock = true; depths[i] = fnCount; i++; prev = c; continue; }
        // A `/` starts a REGEX literal in expression position (after an
        // opener/operator/keyword) and is DIVISION after a value — the
        // standard heuristic. `replace(/"/g, ...)` (a quote inside a regex)
        // must not open a string (this exact shape desynced the first cut).
        if (c === '/' && regexAllowed(prevSig, prevWord)) {
            inRegex = true;
            inRegexClass = false;
            depths[i] = fnCount;
            i++; prev = c; continue;
        }
        if (c === '"' || c === "'") { inStr = c; depths[i] = fnCount; i++; prev = c; continue; }
        if (c === '{') {
            var isFn = pendingFunction > 0;
            stack.push(isFn);
            if (isFn) fnCount++;
            pendingFunction = 0;
            depths[i] = fnCount;
            i++; prevSig = c; prevWord = ''; continue;
        }
        if (c === '}') {
            if (stack.pop() && fnCount > 0) fnCount--;
            depths[i] = fnCount;
            i++; prevSig = c; prevWord = ''; continue;
        }
        if (c === '=' && source.charAt(i + 1) === '>') {
            pendingFunction++;
            depths[i] = fnCount; depths[i + 1] = fnCount;
            i += 2; prevSig = ''; prevWord = ''; continue;
        }
        if (c === 'f' && isWordAt(source, i, 'function')) {
            pendingFunction++;
            depths[i] = fnCount;
            i += 8; prevSig = ''; prevWord = 'function'; continue;
        }
        if (isWordChar(c) && !isWordChar(prevSig !== '' ? prevSig : '')) {
            var w = readWord(source, i);
            depths[i] = fnCount;
            prevWord = w;
            prevSig = c;
            i += w.length;
            continue;
        }
        if (!isSpace(c)) { prevSig = c; prevWord = ''; }
        depths[i] = fnCount;
        i++; prev = c;
    }
    return depths;
}

function isWordChar(c) {
    return /[A-Za-z0-9_$]/.test(c);
}

function isSpace(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/**
 * Regex-literal position heuristic: after an opener/operator or a keyword a
 * `/` begins a regex; after a value (identifier, `)`, `]`, quote) it is
 * division.
 */
function regexAllowed(prevSig, prevWord) {
    if (prevSig === '' ) return true;
    if ('([,=:%!&|?{};~^+-*<>'.indexOf(prevSig) !== -1) return true;
    var keywords = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else'];
    for (var k = 0; k < keywords.length; k++) {
        if (prevWord === keywords[k]) return true;
    }
    return false;
}

function readWord(source, pos) {
    var j = pos;
    while (j < source.length && isWordChar(source.charAt(j))) j++;
    return source.substring(pos, j);
}

/** True when [source] carries the word [word] at [pos] with word boundaries. */
function isWordAt(source, pos, word) {
    if (source.substr(pos, word.length) !== word) return false;
    var before = pos > 0 ? source.charAt(pos - 1) : '';
    var after = source.charAt(pos + word.length);
    var boundary = /[^A-Za-z0-9_$]/;
    return (before === '' || boundary.test(before)) && (after === '' || boundary.test(after));
}

/**
 * Literal relative requires in [source] with their runtime resolution class:
 * [{ spec, deferred }] in order — deferred === executed from inside a
 * function body (js-root-only base at runtime).
 */
function classifyRequires(source) {
    var depths = functionDepths(String(source));
    var out = [];
    var re = new RegExp(REQUIRE_RE.source, 'g');
    var m = re.exec(source);
    while (m !== null) {
        out.push({ spec: m[2], deferred: depths[m.index] > 0 });
        m = re.exec(source);
    }
    return out;
}

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
    parts.pop(); // drop the file name — resolve against its directory
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
 * The js/ root zip path a DEFERRED require resolves against — the pack's
 * js/ module root is the ONLY base the runtime uses for post-init requires
 * (gh-823). './x.js' → 'js/x.js'; '../x.js' climbs OUT of js/ (the runtime
 * looks at the pack root — representable, resolvable only if such a root
 * entry actually ships); a non-relative spec never resolves here.
 */
function deferredRequireBase(spec) {
    if (spec.indexOf('./') !== 0 && spec.indexOf('../') !== 0) return null;
    return normalizePath(['js'].concat(spec.split('/')));
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
 * Returns [{from, spec, target, bases, deferred}] — empty means the pack is
 * self-consistent. [target] is the primary resolution (file-relative for
 * load-time requires, the js/ root for deferred ones); [bases] lists every
 * zip path that was tried.
 *
 * Resolution classes (gh-823 — mirrors the runtime):
 *   - load-time (top level): UNION of the file-relative base and the js/
 *     module root (worker-source strings need the root base);
 *   - deferred (inside a function body): js/ module root ONLY — the runtime
 *     never tries the file-relative base after module init.
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
        var classified = classifyRequires(files[i].source || '');
        for (var s = 0; s < classified.length; s++) {
            var spec = classified[s].spec;
            var bases;
            if (classified[s].deferred) {
                var root = deferredRequireBase(spec);
                bases = root ? [root] : [];
            } else {
                bases = resolveRequireCandidates(files[i].path, spec);
            }
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
                    spec: spec,
                    target: bases[0] || spec,
                    bases: bases,
                    deferred: classified[s].deferred,
                });
            }
        }
    }
    return unresolved;
}

module.exports = {
    requireSpecs: requireSpecs,
    classifyRequires: classifyRequires,
    resolveRequire: resolveRequire,
    resolveRequireCandidates: resolveRequireCandidates,
    deferredRequireBase: deferredRequireBase,
    unresolvedRequires: unresolvedRequires,
};
