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
 * `function`-style (GraalJS conventions); a regex literal is told apart from
 * division by the standard previous-token heuristic and a pathological
 * regex could still desync the walk. Comment contents are NOT edges: a
 * require-shaped doc example never executes, and under the deferred rule a
 * JSDoc example inside a function body would false-positive the gate (the
 * gh-812 union model could afford keeping them — every doc example in this
 * repo resolves — the deferred rule cannot). String contents ARE edges
 * (the githubSource.js worker sources ride in strings), classified at the
 * code position of the string. All three limits are pinned by the CANARY
 * tests in js/unit-tests/test_packRequireGate.js (the shorthand/getter
 * false-pass direction is asserted end-to-end there).
 */
/**
 * Char-walk over [source] producing, per position: the enclosing
 * function-body depth and whether the position sits inside a COMMENT
 * (comment/string/regex contents never affect depth; string contents are
 * kept — the githubSource.js worker sources ride in strings — while comment
 * contents are marked so require-shaped DOC EXAMPLES never classify as real
 * edges: a require in a comment does not execute, and under the deferred
 * rule a JSDoc example inside a function body would otherwise false-positive
 * the release gate).
 */
function scanSource(source) {
    var n = source.length;
    var depths = new Array(n);
    var commented = new Array(n);
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
        if (inLine) { depths[i] = fnCount; commented[i] = true; i++; prev = c; continue; }
        if (inBlock) {
            if (c === '/' && prev === '*') inBlock = false;
            depths[i] = fnCount; commented[i] = true;
            i++; prev = c; continue;
        }
        if (inStr !== null) {
            if (c === '\\') { depths[i] = fnCount; commented[i] = false; depths[i + 1] = fnCount; commented[i + 1] = false; commented[i] = false; commented[i + 1] = false; i += 2; prev = ''; continue; }
            if (c === inStr) {
                inStr = null;
                depths[i] = fnCount; commented[i] = false;
                i++; prevSig = c; prevWord = ''; continue;
            }
            depths[i] = fnCount; commented[i] = false;
            i++; prev = c; continue;
        }
        if (inRegex) {
            if (c === '\\') { depths[i] = fnCount; commented[i] = false; depths[i + 1] = fnCount; commented[i + 1] = false; commented[i] = false; commented[i + 1] = false; i += 2; prev = ''; continue; }
            if (c === '[') inRegexClass = true;
            else if (c === ']') inRegexClass = false;
            else if (c === '/' && !inRegexClass) inRegex = false;
            depths[i] = fnCount; commented[i] = false;
            i++; prev = c; continue;
        }
        if (c === '/' && source.charAt(i + 1) === '/') { inLine = true; depths[i] = fnCount; commented[i] = true; i++; prev = c; continue; }
        if (c === '/' && source.charAt(i + 1) === '*') { inBlock = true; depths[i] = fnCount; commented[i] = true; i++; prev = c; continue; }
        // A `/` starts a REGEX literal in expression position (after an
        // opener/operator/keyword) and is DIVISION after a value — the
        // standard heuristic. `replace(/"/g, ...)` (a quote inside a regex)
        // must not open a string (this exact shape desynced the first cut).
        if (c === '/' && regexAllowed(prevSig, prevWord)) {
            inRegex = true;
            inRegexClass = false;
            depths[i] = fnCount; commented[i] = false;
            i++; prev = c; continue;
        }
        if (c === '"' || c === "'") { inStr = c; depths[i] = fnCount; commented[i] = false; i++; prev = c; continue; }
        if (c === '{') {
            var isFn = pendingFunction > 0;
            stack.push(isFn);
            if (isFn) fnCount++;
            pendingFunction = 0;
            depths[i] = fnCount; commented[i] = false;
            i++; prevSig = c; prevWord = ''; continue;
        }
        if (c === '}') {
            if (stack.pop() && fnCount > 0) fnCount--;
            depths[i] = fnCount; commented[i] = false;
            i++; prevSig = c; prevWord = ''; continue;
        }
        if (c === '=' && source.charAt(i + 1) === '>') {
            pendingFunction++;
            depths[i] = fnCount; commented[i] = false; depths[i + 1] = fnCount; commented[i + 1] = false; commented[i] = false; commented[i + 1] = false;
            i += 2; prevSig = ''; prevWord = ''; continue;
        }
        if (c === 'f' && isWordAt(source, i, 'function')) {
            pendingFunction++;
            depths[i] = fnCount; commented[i] = false;
            i += 8; prevSig = ''; prevWord = 'function'; continue;
        }
        if (isWordChar(c) && !isWordChar(prevSig !== '' ? prevSig : '')) {
            var w = readWord(source, i);
            depths[i] = fnCount; commented[i] = false;
            prevWord = w;
            prevSig = c;
            i += w.length;
            continue;
        }
        if (!isSpace(c)) { prevSig = c; prevWord = ''; }
        depths[i] = fnCount; commented[i] = false;
        i++; prev = c;
    }
    return { depths: depths, commented: commented };
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
    var scan = scanSource(String(source));
    var out = [];
    var re = new RegExp(REQUIRE_RE.source, 'g');
    var m = re.exec(source);
    while (m !== null) {
        if (!scan.commented[m.index]) {
            out.push({ spec: m[2], deferred: scan.depths[m.index] > 0 });
        }
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

// ── Config-referenced scripts & transitive require closure (gh-1276, gh-1277) ─
//
// Agent configs reference JS scripts across several fields:
//   - params.jsPath / jsAction / preJSAction / preCliJSAction / postJSAction /
//     timerJSAction (e.g. 'agents/js/writeContentOutput.js', 'js/smAgent.js',
//     'agents/restoreDescription.js')
//   - params.cliPrompts[].condition (e.g. 'agents/js/conditions/isCodeGraphAvailable.js')
//   - params.customParams.contentOutput.thenAction (e.g. 'assignForSolutionArchitecture.js')
//
// When `dmtools compile` omits condition or thenAction scripts (gh-1276, gh-1277),
// the release builder must both (1) fold the missing scripts and their transitive
// local require() closure into the zip and (2) fail the require gate if any
// config-referenced script is absent from the zip.

var CONFIG_ACTION_FIELDS = [
    'jsPath',
    'jsAction',
    'preJSAction',
    'preCliJSAction',
    'postJSAction',
    'timerJSAction',
];

/**
 * Normalizes a config-referenced JS path to its zip-layout path:
 *   'agents/js/conditions/isCodeGraphAvailable.js' -> 'js/conditions/isCodeGraphAvailable.js'
 *   'assignForSolutionArchitecture.js' (defaultJsDir=true) -> 'js/assignForSolutionArchitecture.js'
 *   'agents/restoreDescription.js' (defaultJsDir=false) -> 'restoreDescription.js'
 */
function normalizeConfigScriptPath(spec, defaultJsDir) {
    if (!spec || typeof spec !== 'string') return null;
    var s = spec.trim().replace(/^\.\//, '').replace(/^agents\//, '');
    if (!s) return null;
    if (defaultJsDir && s.indexOf('/') === -1) {
        s = 'js/' + s;
    }
    return normalizePath(s.split('/'));
}

function parseConfigInput(configInput) {
    if (!configInput) return null;
    if (typeof configInput === 'object') return configInput;
    try {
        return JSON.parse(String(configInput));
    } catch (e) {
        return null;
    }
}

function collectActionFieldRefs(params, out) {
    for (var i = 0; i < CONFIG_ACTION_FIELDS.length; i++) {
        var field = CONFIG_ACTION_FIELDS[i];
        var target = normalizeConfigScriptPath(params[field], false);
        if (target) {
            out.push({ field: 'params.' + field, spec: params[field], target: target });
        }
    }
}

function collectCliPromptConditionRefs(params, out) {
    var prompts = params.cliPrompts;
    if (!Array.isArray(prompts)) return;
    for (var i = 0; i < prompts.length; i++) {
        var item = prompts[i];
        var cond = item && typeof item === 'object' ? item.condition : null;
        var target = normalizeConfigScriptPath(cond, true);
        if (target) {
            out.push({ field: 'params.cliPrompts[' + i + '].condition', spec: cond, target: target });
        }
    }
}

function collectThenActionRef(params, out) {
    var co = params.customParams && params.customParams.contentOutput;
    var thenAction = co && co.thenAction;
    var target = normalizeConfigScriptPath(thenAction, true);
    if (target) {
        out.push({
            field: 'params.customParams.contentOutput.thenAction',
            spec: thenAction,
            target: target,
        });
    }
}

/**
 * Extracts all JS script references from a single agent config (JSON string or
 * parsed object): [{ field, spec, target }].
 */
function configScriptRefs(configInput) {
    var cfg = parseConfigInput(configInput);
    var params = (cfg && cfg.params) || {};
    var out = [];
    collectActionFieldRefs(params, out);
    collectCliPromptConditionRefs(params, out);
    collectThenActionRef(params, out);
    return out;
}

/**
 * Config-referenced scripts across [configs] ([{path, source}]) that are absent
 * from [knownPaths] (plain object map or Set). Returns
 * [{ from, field, spec, target, bases, configRef: true }].
 */
function unresolvedConfigScripts(configs, knownPaths) {
    var list = configs || [];
    var unresolved = [];
    for (var i = 0; i < list.length; i++) {
        var refs = configScriptRefs(list[i].source);
        for (var r = 0; r < refs.length; r++) {
            var ref = refs[r];
            if (!pathSetHas(knownPaths, ref.target)) {
                unresolved.push({
                    from: list[i].path,
                    field: ref.field,
                    spec: ref.spec,
                    target: ref.target,
                    bases: [ref.target],
                    configRef: true,
                });
            }
        }
    }
    return unresolved;
}

function resolveExistingCandidate(candidates, readFileFn) {
    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (readFileFn(c) !== null) return c;
        if (c.slice(-3) !== '.js' && readFileFn(c + '.js') !== null) return c + '.js';
    }
    return null;
}

function requireCandidatesForClosure(fromPath, item) {
    if (item.deferred) {
        var root = deferredRequireBase(item.spec);
        return root ? [root] : [];
    }
    return resolveRequireCandidates(fromPath, item.spec);
}

function enqueueDiscoveredRequires(fromPath, src, readFileFn, visited, queue) {
    var reqs = classifyRequires(src);
    for (var i = 0; i < reqs.length; i++) {
        var hit = resolveExistingCandidate(
            requireCandidatesForClosure(fromPath, reqs[i]),
            readFileFn
        );
        if (hit && !visited[hit]) queue.push(hit);
    }
}

function nonEmptySeeds(seedPaths) {
    var list = seedPaths || [];
    var queue = [];
    for (var i = 0; i < list.length; i++) {
        if (list[i]) queue.push(list[i]);
    }
    return queue;
}

/**
 * Computes the transitive closure of zip-layout JS paths starting from
 * [seedPaths], reading repo sources via `readFileFn(relPath)` (returns string
 * content when the file exists, or null when absent). Sorted for determinism.
 */
function transitiveScriptClosure(seedPaths, readFileFn) {
    var visited = {};
    var queue = nonEmptySeeds(seedPaths);
    var out = [];
    while (queue.length > 0) {
        var current = queue.shift();
        if (visited[current]) continue;
        visited[current] = true;
        var src = readFileFn(current);
        if (src === null) continue;
        out.push(current);
        enqueueDiscoveredRequires(current, src, readFileFn, visited, queue);
    }
    return out.sort();
}

function parentConfigPath(cfg) {
    return cfg && cfg.parent && typeof cfg.parent.path === 'string'
        ? normalizeConfigScriptPath(cfg.parent.path, false)
        : null;
}

/**
 * Walks `<agentConfigPath>` and its `parent.path` chain using `readFileFn`,
 * returning the full transitive closure of config-referenced JS scripts and
 * their relative `require()` dependencies as sorted zip-layout paths.
 */
function discoverConfigScriptClosure(agentConfigPath, readFileFn) {
    var seeds = [];
    var seenConfigs = {};
    var cur = agentConfigPath;
    while (cur && !seenConfigs[cur]) {
        seenConfigs[cur] = true;
        var cfg = parseConfigInput(readFileFn(cur));
        if (!cfg) break;
        var refs = configScriptRefs(cfg);
        for (var i = 0; i < refs.length; i++) {
            seeds.push(refs[i].target);
        }
        cur = parentConfigPath(cfg);
    }
    return transitiveScriptClosure(seeds, readFileFn);
}

module.exports = {
    requireSpecs: requireSpecs,
    classifyRequires: classifyRequires,
    resolveRequire: resolveRequire,
    resolveRequireCandidates: resolveRequireCandidates,
    deferredRequireBase: deferredRequireBase,
    unresolvedRequires: unresolvedRequires,
    normalizeConfigScriptPath: normalizeConfigScriptPath,
    configScriptRefs: configScriptRefs,
    unresolvedConfigScripts: unresolvedConfigScripts,
    transitiveScriptClosure: transitiveScriptClosure,
    discoverConfigScriptClosure: discoverConfigScriptClosure,
};
