/**
 * Unit tests for js/common/remoteProjectConfig.js (gh-1421) and its
 * configLoader integration — the SCM-agnostic config acquisition:
 * when every LOCAL config candidate misses, discoverProjectConfig fetches
 * .dmtools/config.js from the repo's default branch through the scm layer
 * (the github/gitlab file-contents bridge primitives).
 *
 * Invariants pinned here (the ticket's acceptance criteria):
 *   1. primitive absent  → defaults (fail-open), no throw;
 *      primitive present → config loaded, knobs visible to mergeBackstop's
 *      machineLoginsOf; corrupt/HTML content → defaults + warn;
 *      a second load in one run hits the TTL cache (single fetch asserted).
 *   2. Local candidates keep ABSOLUTE precedence — a checked-out config
 *      wins over the fetched one (the primitive is never called).
 *   3. GraalJS-clean module (var/plain functions, no lazy requires).
 *
 * Retires the workflow-side `gh api contents` config-fetch stopgap
 * (IstiN/dmtools-agentic-workflows#91) — see the deletion note in the
 * module header.
 */
/* global suite, test, assert, loadModule, makeRequire, configModule */

// ── module loading ───────────────────────────────────────────────────────────

var _mods = {};
function machineAuthorMod() {
    if (!_mods.ma) _mods.ma = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    return _mods.ma;
}
function machineNoticeMod() {
    if (!_mods.mn) _mods.mn = loadModule('js/common/machineNotice.js', makeRequire({}), {});
    return _mods.mn;
}
function reviewVerdictsMod() {
    if (!_mods.rv) {
        _mods.rv = loadModule('js/common/reviewVerdicts.js', makeRequire({
            './machineAuthor.js': machineAuthorMod()
        }), {});
    }
    return _mods.rv;
}
function findingRegistryMod() {
    if (!_mods.fr) {
        _mods.fr = loadModule('js/common/findingRegistry.js', makeRequire({
            './reviewVerdicts.js': reviewVerdictsMod()
        }), {});
    }
    return _mods.fr;
}
function ledgerCoreMod() {
    if (!_mods.lc) _mods.lc = loadModule('js/common/ledgerCore.js', makeRequire({}), {});
    return _mods.lc;
}
function reviewDebtLedgerMod() {
    if (!_mods.rdl) {
        _mods.rdl = loadModule('js/common/reviewDebtLedger.js', makeRequire({
            './reviewVerdicts.js': reviewVerdictsMod(),
            './findingRegistry.js': findingRegistryMod(),
            './ledgerCore.js': ledgerCoreMod()
        }), {});
    }
    return _mods.rdl;
}
function reviewPolicyMod() {
    if (!_mods.rp) {
        _mods.rp = loadModule('js/common/reviewPolicy.js', makeRequire({
            './reviewVerdicts.js': reviewVerdictsMod()
        }), {});
    }
    return _mods.rp;
}
function reviewDispositionsMod() {
    if (!_mods.rd) {
        _mods.rd = loadModule('js/common/reviewDispositions.js', makeRequire({
            './reviewVerdicts.js': reviewVerdictsMod(),
            './reviewPolicy.js': reviewPolicyMod()
        }), {});
    }
    return _mods.rd;
}
function threadInventoryMod() {
    if (!_mods.ti) {
        _mods.ti = loadModule('js/common/reviewThreadInventory.js', makeRequire({
            './machineNotice.js': machineNoticeMod()
        }), {});
    }
    return _mods.ti;
}
function mcpParseMod() {
    if (!_mods.mp) _mods.mp = loadModule('js/common/mcpParse.js', makeRequire({}), {});
    return _mods.mp;
}
function loseJsonMod() {
    if (!_mods.lj) _mods.lj = loadModule('js/common/loseJson.js', makeRequire({}), {});
    return _mods.lj;
}
function mergeStateMod() {
    if (!_mods.ms) _mods.ms = loadModule('js/common/mergeState.js', makeRequire({}), {});
    return _mods.ms;
}
function pullRequestMod() {
    if (!_mods.pr) {
        _mods.pr = loadModule('js/common/pullRequest.js', makeRequire({
            './mergeState.js': mergeStateMod()
        }), {});
    }
    return _mods.pr;
}
function githubReviewFetchMod() {
    if (!_mods.grf) {
        _mods.grf = loadModule('js/common/githubReviewFetch.js', makeRequire({
            './machineNotice.js': machineNoticeMod(),
            './reviewThreadInventory.js': threadInventoryMod()
        }), {});
    }
    return _mods.grf;
}
function scmMod(globalMods) {
    // The four primitive names are nulled FIRST so the "absent" scenarios are
    // deterministic even though the engine declares real github_* globals
    // (the network guard turns unmocked names into throwing stubs).
    var globals = {
        github_get_file_contents: null,
        github_get_file_content: null,
        gitlab_get_file_contents: null,
        gitlab_get_file_content: null
    };
    var provided = globalMods || {};
    for (var k in provided) {
        if (provided.hasOwnProperty(k)) globals[k] = provided[k];
    }
    return loadModule('js/common/scm.js', makeRequire({
        './reviewThreadInventory.js': threadInventoryMod(),
        './loseJson.js': loseJsonMod(),
        './pullRequest.js': pullRequestMod(),
        './githubReviewFetch.js': githubReviewFetchMod()
    }), globals);
}

// The module under test. primitiveFn (when given) is exposed as the
// ticket-named `github_get_file_contents` global; without it every bridge
// primitive global is explicitly NOT a function (capability miss) — null
// mocks matter because the engine declares the real github_* tools as
// globals (the network guard turns them into throwing stubs), and a plain
// unmocked name would typeof as a function here.
// Every call gets its own instance — the TTL cache lives in module scope,
// so tests never share cache state.
function makeRemoteModule(primitiveFn, globalName) {
    var globals = {
        github_get_file_contents: null,
        github_get_file_content: null,
        gitlab_get_file_contents: null,
        gitlab_get_file_content: null
    };
    if (primitiveFn) globals[globalName || 'github_get_file_contents'] = primitiveFn;
    return loadModule('js/common/remoteProjectConfig.js', makeRequire({}), globals);
}

// A configLoader wired to the REAL remoteProjectConfig instance (scripted
// io) and a controlled file_read. fileMap serves literal paths; everything
// else (including any real .dmtools/config) reads as null.
function makeConfigLoader(remoteMod, fileMap) {
    var fakeFileRead = function(pathArg) {
        var p = typeof pathArg === 'string' ? pathArg : pathArg.path;
        if (fileMap && fileMap[p] !== undefined) return fileMap[p];
        return null;
    };
    return loadModule('js/configLoader.js', makeRequire({
        './config.js': configModule,
        './common/remoteProjectConfig.js': remoteMod
    }), { file_read: fakeFileRead });
}

// mergeBackstop wired to the REAL configLoader (scripted io) — the
// machineLoginsOf knob-visibility proof runs through the production wiring.
function makeMergeBackstop(remoteMod) {
    return loadModule('js/common/mergeBackstop.js', makeRequire({
        './reviewVerdicts.js': reviewVerdictsMod(),
        './findingRegistry.js': findingRegistryMod(),
        './reviewDebtLedger.js': reviewDebtLedgerMod(),
        './reviewDispositions.js': reviewDispositionsMod(),
        './reviewPolicy.js': reviewPolicyMod(),
        './machineAuthor.js': machineAuthorMod(),
        './reviewThreadInventory.js': threadInventoryMod(),
        './mcpParse.js': mcpParseMod(),
        '../configLoader.js': makeConfigLoader(remoteMod, null)
    }), {});
}

// ── fixtures ─────────────────────────────────────────────────────────────────

var SRC_ALLOWLIST = 'module.exports = { machineAuthor: "bot-a,bot-b" };';
var SRC_REMOTE = 'module.exports = { machineAuthor: "remote-bot" };';
var SRC_LOCAL = 'module.exports = { machineAuthor: "local-bot" };';
var SRC_POLICY = 'module.exports = { reviewPolicy: "strict" };';
var SRC_UTF8 = 'hélo — 😀 config';
var SRC_HTML = '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>';

var B64_ALLOWLIST = 'bW9kdWxlLmV4cG9ydHMgPSB7IG1hY2hpbmVBdXRob3I6ICJib3QtYSxib3QtYiIgfTs=';
var B64_REMOTE = 'bW9kdWxlLmV4cG9ydHMgPSB7IG1hY2hpbmVBdXRob3I6ICJyZW1vdGUtYm90IiB9Ow==';
var B64_LOCAL = 'bW9kdWxlLmV4cG9ydHMgPSB7IG1hY2hpbmVBdXRob3I6ICJsb2NhbC1ib3QiIH07';
var B64_POLICY = 'bW9kdWxlLmV4cG9ydHMgPSB7IHJldmlld1BvbGljeTogInN0cmljdCIgfTs=';
var B64_UTF8 = 'aMOpbG8g4oCUIPCfmIAgY29uZmln';

// Scripted io bag: a getFileContents double that records calls and serves a
// payload queue (last payload repeats).
function scriptedIo(payload, provider) {
    var calls = [];
    return {
        provider: provider || 'github',
        calls: calls,
        getFileContents: function(target, path) {
            calls.push({ target: target, path: path });
            return typeof payload === 'function' ? payload(calls.length) : payload;
        }
    };
}

function fetchWith(mod, io, params, customParams, options) {
    var opts = options || {};
    opts.io = io;
    return mod.fetchRemoteConfigSource(params, customParams, opts);
}

// ── remoteConfigIo — the capability bag ──────────────────────────────────────

suite('remoteProjectConfig.remoteConfigIo', function() {

    test('primitive absent → getFileContents is null (capability miss, never an error)', function() {
        var mod = makeRemoteModule(null);
        var io = mod.remoteConfigIo('github');
        assert.equal(io.provider, 'github');
        assert.equal(io.getFileContents, null);
    });

    test('ticket-named github_get_file_contents primitive is picked up', function() {
        var prim = function() { return 'x'; };
        var mod = makeRemoteModule(prim);
        var io = mod.remoteConfigIo('github');
        assert.notEqual(io.getFileContents, null);
        var delivered = null;
        // The bag adapts the call to the primitive's {owner, repo, path} schema.
        var orig = io.getFileContents;
        io.getFileContents = function(target, path) { delivered = orig(target, path); return delivered; };
        io.getFileContents({ owner: 'ex', repo: 'repo' }, '.dmtools/config.js');
        assert.equal(delivered, 'x');
    });

    test('shipped-today github_get_file_content spelling is also a capability', function() {
        var seen = null;
        var mod = makeRemoteModule(function(opts) { seen = opts; return 'raw'; }, 'github_get_file_content');
        var io = mod.remoteConfigIo('github');
        assert.notEqual(io.getFileContents, null);
        assert.equal(io.getFileContents({ owner: 'o', repo: 'r' }, '.dmtools/config.js'), 'raw');
        assert.deepEqual(seen, { owner: 'o', repo: 'r', path: '.dmtools/config.js' });
    });

    test('unknown provider falls back to github (createScm parity)', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigIo(undefined).provider, 'github');
        assert.equal(mod.remoteConfigIo('mystery').provider, 'github');
    });

    test('gitlab primitive present → the twin rides the gitlab wiring bag', function() {
        var seen = null;
        var mod = loadModule('js/common/remoteProjectConfig.js', makeRequire({}), {
            gitlab_get_file_contents: function(opts) { seen = opts; return 'gl-raw'; }
        });
        var io = mod.remoteConfigIo('gitlab');
        assert.equal(io.provider, 'gitlab');
        assert.notEqual(io.getFileContents, null);
        assert.equal(io.getFileContents({ owner: 'grp', repo: 'proj' }, '.dmtools/config.js'), 'gl-raw');
        assert.deepEqual(seen, { workspace: 'grp', repository: 'proj', path: '.dmtools/config.js' });
    });

    test('gitlab primitive absent → capability miss (null, no throw)', function() {
        var mod = makeRemoteModule(null);
        var io = mod.remoteConfigIo('gitlab');
        assert.equal(io.provider, 'gitlab');
        assert.equal(io.getFileContents, null);
    });

});

// ── decodeBase64 — pure-JS, UTF-8 safe ───────────────────────────────────────

suite('remoteProjectConfig.decodeBase64', function() {

    test('decodes plain ASCII source (no padding shortfall)', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.decodeBase64(B64_ALLOWLIST), SRC_ALLOWLIST);
    });

    test('decodes multiple different payloads (2+ items loop case)', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.decodeBase64(B64_REMOTE), SRC_REMOTE);
        assert.equal(mod.decodeBase64(B64_POLICY), SRC_POLICY);
        assert.equal(mod.decodeBase64(B64_LOCAL), SRC_LOCAL);
    });

    test('tolerates newlines and whitespace inside the base64 stream', function() {
        var mod = makeRemoteModule(null);
        var wrapped = B64_ALLOWLIST.slice(0, 10) + '\n' + B64_ALLOWLIST.slice(10, 25) +
            '\r\n ' + B64_ALLOWLIST.slice(25);
        assert.equal(mod.decodeBase64(wrapped), SRC_ALLOWLIST);
    });

    test('decodes UTF-8 content (2-byte, 3-byte and 4-byte sequences)', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.decodeBase64(B64_UTF8), SRC_UTF8);
    });

    test('invalid bytes emit U+FFFD and resynchronize (never throw)', function() {
        var mod = makeRemoteModule(null);
        // 'a', lone continuation byte, 'b' → a\uFFFD b
        assert.equal(mod.decodeBase64('YYBi'), 'a\uFFFD' + 'b');
        // 'c', overlong lead 0xC0, lone continuation, 'd', out-of-range lead 0xF5,
        // 3 lone continuations, 'e' → one U+FFFD per invalid byte (WHATWG parity)
        assert.equal(mod.decodeBase64('Y8CAZPWAgIBl'),
            'c\uFFFD\uFFFD' + 'd\uFFFD\uFFFD\uFFFD\uFFFD' + 'e');
        // surrogate-range sequence (U+D83D can never appear in valid UTF-8) → U+FFFD
        assert.equal(mod.decodeBase64('7aC4'), '\uFFFD');
    });

    test('truncated sequences emit U+FFFD (no crash on cut-off multi-byte)', function() {
        var mod = makeRemoteModule(null);
        // 'h', 'i', lead 0xC3 with the continuation byte cut off → 'hi\uFFFD'
        assert.equal(mod.decodeBase64('aGnD'), 'hi\uFFFD');
    });

    test('returns empty string for null/empty input', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.decodeBase64(null), '');
        assert.equal(mod.decodeBase64(''), '');
    });

});

// ── remoteConfigSourceOf — the payload normalizer ────────────────────────────

suite('remoteProjectConfig.remoteConfigSourceOf', function() {

    test('null/undefined/empty payloads read as no config', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigSourceOf(null), null);
        assert.equal(mod.remoteConfigSourceOf(undefined), null);
        assert.equal(mod.remoteConfigSourceOf(''), null);
        assert.equal(mod.remoteConfigSourceOf('   \n  '), null);
    });

    test('a plain source string passes through untouched', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigSourceOf(SRC_REMOTE), SRC_REMOTE);
    });

    test('an object envelope {content: base64, encoding: base64} decodes', function() {
        var mod = makeRemoteModule(null);
        var env = { content: B64_ALLOWLIST, encoding: 'base64' };
        assert.equal(mod.remoteConfigSourceOf(env), SRC_ALLOWLIST);
    });

    test('a JSON-string envelope decodes (the bridge stringifies the Contents API shape)', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigSourceOf(JSON.stringify({ content: B64_REMOTE, encoding: 'base64' })), SRC_REMOTE);
    });

    test('an envelope without an encoding field decodes strict-base64 content', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigSourceOf({ content: B64_POLICY }), SRC_POLICY);
    });

    test('an envelope with non-base64 content passes the content through as source', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigSourceOf({ content: SRC_ALLOWLIST }), SRC_ALLOWLIST);
    });

    test('a {result: envelope} bridge wrapper unwraps before decoding', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigSourceOf({ result: { content: B64_ALLOWLIST, encoding: 'base64' } }), SRC_ALLOWLIST);
        assert.equal(mod.remoteConfigSourceOf(JSON.stringify({ result: JSON.stringify({ content: B64_REMOTE, encoding: 'base64' }) })), SRC_REMOTE);
    });

    test('an HTML error page reads as unusable (null) — the stopgap guard', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigSourceOf(SRC_HTML), null);
        assert.equal(mod.remoteConfigSourceOf({ content: SRC_HTML }), null);
        assert.equal(mod.remoteConfigSourceOf('<html><body>Sign in</body></html>'), null);
    });

    test('brace-leading junk that is not JSON reads as no config', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigSourceOf('{not json at all'), null);
    });

});

// ── remoteConfigRepositoryOf — the fetch target ──────────────────────────────

suite('remoteProjectConfig.remoteConfigRepositoryOf', function() {

    test('params.repository wins (the SM target-repo param)', function() {
        var mod = makeRemoteModule(null);
        assert.deepEqual(
            mod.remoteConfigRepositoryOf({ repository: { owner: 'ex', repo: 'one' }, repo: 'ex/two' }, {}),
            { owner: 'ex', repo: 'one' });
    });

    test('params.repo "owner/name" splits (the merge funnel jobParams)', function() {
        var mod = makeRemoteModule(null);
        assert.deepEqual(mod.remoteConfigRepositoryOf({ repo: 'ex/deep/name' }, {}),
            { owner: 'ex', repo: 'deep/name' });
    });

    test('customParams.targetRepository applies when params carry no repo', function() {
        var mod = makeRemoteModule(null);
        assert.deepEqual(
            mod.remoteConfigRepositoryOf({}, { targetRepository: { owner: 'tr', repo: 'target' } }),
            { owner: 'tr', repo: 'target' });
    });

    test('GH_REPO env-global is the last resort', function() {
        var mod = loadModule('js/common/remoteProjectConfig.js', makeRequire({}), { GH_REPO: 'gh/owner-repo' });
        assert.deepEqual(mod.remoteConfigRepositoryOf({}, {}), { owner: 'gh', repo: 'owner-repo' });
    });

    test('nothing resolvable → null (no target, no fetch)', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigRepositoryOf({}, {}), null);
        assert.equal(mod.remoteConfigRepositoryOf(null, null), null);
        assert.equal(mod.remoteConfigRepositoryOf({ repo: 'no-slash' }, {}), null);
    });

});

// ── fetchRemoteConfigSource — capability, fail-open, TTL cache ───────────────

suite('remoteProjectConfig.fetchRemoteConfigSource — capability + fail-open', function() {

    test('primitive absent → null without touching anything (capability miss)', function() {
        var mod = makeRemoteModule(null);
        var io = { provider: 'github', getFileContents: null };
        assert.equal(fetchWith(mod, io, { repo: 'ex/repo' }, {}), null);
    });

    test('no target repository → null without a fetch', function() {
        var mod = makeRemoteModule(null);
        var io = scriptedIo(SRC_REMOTE);
        assert.equal(fetchWith(mod, io, {}, {}), null);
        assert.equal(io.calls.length, 0);
    });

    test('fetch throws → null + fail-open (never propagates)', function() {
        var mod = makeRemoteModule(null);
        var io = { provider: 'github', getFileContents: function() { throw new Error('404 Not Found'); } };
        assert.equal(fetchWith(mod, io, { repo: 'ex/repo' }, {}), null);
    });

    test('primitive present → the decoded config source comes back', function() {
        var mod = makeRemoteModule(null);
        var io = scriptedIo(JSON.stringify({ content: B64_ALLOWLIST, encoding: 'base64' }));
        assert.equal(fetchWith(mod, io, { repo: 'ex/repo' }, {}), SRC_ALLOWLIST);
        assert.equal(io.calls.length, 1);
        assert.deepEqual(io.calls[0].target, { owner: 'ex', repo: 'repo' });
        assert.equal(io.calls[0].path, '.dmtools/config.js');
    });

    test('HTML payload → null (warn + fail-open)', function() {
        var mod = makeRemoteModule(null);
        var io = scriptedIo(SRC_HTML);
        assert.equal(fetchWith(mod, io, { repo: 'ex/repo' }, {}), null);
    });

});

suite('remoteProjectConfig.fetchRemoteConfigSource — TTL cache', function() {

    test('second call in one run hits the cache (single fetch asserted)', function() {
        var mod = makeRemoteModule(null);
        var io = scriptedIo(JSON.stringify({ content: B64_ALLOWLIST, encoding: 'base64' }));
        var first = fetchWith(mod, io, { repo: 'ex/repo' }, {}, { nowMs: 1000 });
        var second = fetchWith(mod, io, { repo: 'ex/repo' }, {}, { nowMs: 1000 + mod.REMOTE_CONFIG_TL_MS - 1 });
        assert.equal(first, SRC_ALLOWLIST);
        assert.equal(second, SRC_ALLOWLIST);
        assert.equal(io.calls.length, 1, 'expected exactly ONE bridge fetch for two calls');
    });

    test('after the TTL a fresh fetch happens', function() {
        var mod = makeRemoteModule(null);
        var io = scriptedIo(JSON.stringify({ content: B64_REMOTE, encoding: 'base64' }));
        fetchWith(mod, io, { repo: 'ex/repo' }, {}, { nowMs: 1000 });
        fetchWith(mod, io, { repo: 'ex/repo' }, {}, { nowMs: 1000 + mod.REMOTE_CONFIG_TL_MS });
        assert.equal(io.calls.length, 2, 'the TTL expiry must allow a refetch');
    });

    test('a failed/absent outcome is cached too (one attempt per run)', function() {
        var mod = makeRemoteModule(null);
        var attempts = 0;
        var io = { provider: 'github', getFileContents: function() { attempts++; return SRC_HTML; } };
        assert.equal(fetchWith(mod, io, { repo: 'ex/repo' }, {}, { nowMs: 1000 }), null);
        assert.equal(fetchWith(mod, io, { repo: 'ex/repo' }, {}, { nowMs: 1500 }), null);
        assert.equal(attempts, 1, 'an unusable outcome rides the same TTL');
    });

    test('distinct repos never collide (2+ keys loop case)', function() {
        var mod = makeRemoteModule(null);
        var payloads = {
            'ex/one': JSON.stringify({ content: B64_ALLOWLIST, encoding: 'base64' }),
            'ex/two': JSON.stringify({ content: B64_REMOTE, encoding: 'base64' })
        };
        // per-repo payloads via an io keyed on the recorded target:
        var perRepo = {
            provider: 'github',
            getFileContents: function(target) { return payloads[target.owner + '/' + target.repo]; }
        };
        assert.equal(fetchWith(mod, perRepo, { repo: 'ex/one' }, {}, { nowMs: 1000 }), SRC_ALLOWLIST);
        assert.equal(fetchWith(mod, perRepo, { repo: 'ex/two' }, {}, { nowMs: 1000 }), SRC_REMOTE);
        assert.equal(fetchWith(mod, perRepo, { repo: 'ex/one' }, {}, { nowMs: 1500 }), SRC_ALLOWLIST);
        assert.equal(fetchWith(mod, perRepo, { repo: 'ex/two' }, {}, { nowMs: 1500 }), SRC_REMOTE);
    });

    test('the cache stays bounded (max entries, oldest dropped wholesale)', function() {
        var mod = makeRemoteModule(null);
        var perRepo = {
            provider: 'github',
            getFileContents: function(target) {
                return JSON.stringify({ content: mod.__btoa || B64_ALLOWLIST, encoding: 'base64' });
            }
        };
        for (var i = 0; i < mod.REMOTE_CONFIG_CACHE_MAX + 3; i++) {
            fetchWith(mod, perRepo, { repo: 'ex/r' + i }, {}, { nowMs: 1000 + i });
        }
        // No throw and the next fetch still resolves — bounded by construction.
        assert.equal(fetchWith(mod, perRepo, { repo: 'ex/r0' }, {}, { nowMs: 100000 }), SRC_ALLOWLIST);
    });

});

// ── configLoader integration — the LAST discovery candidate ─────────────────

// A bridge primitive double recording its calls and serving one payload.
function primitiveServing(payload) {
    var fn = function(opts) { fn.calls.push(opts); return payload; };
    fn.calls = [];
    return fn;
}

suite('configLoader.discoverProjectConfig — remote fallback (gh-1421)', function() {

    test('all local candidates miss + primitive present → config loads from the default branch', function() {
        var prim = primitiveServing(JSON.stringify({ content: B64_ALLOWLIST, encoding: 'base64' }));
        var loader = makeConfigLoader(makeRemoteModule(prim), null);
        var cfg = loader.loadProjectConfig({ repo: 'ex/repo', customParams: {} });
        assert.equal(cfg.machineAuthor, 'bot-a,bot-b', 'the fetched knob must be merged over defaults');
        assert.equal(cfg._configPath, '.dmtools/config.js', 'the canonical in-repo path propagates downstream');
        assert.equal(prim.calls.length, 1);
        assert.deepEqual(prim.calls[0], { owner: 'ex', repo: 'repo', path: '.dmtools/config.js' });
    });

    test('primitive absent + local miss → defaults (fail-open)', function() {
        var loader = makeConfigLoader(makeRemoteModule(null), null);
        var cfg = loader.loadProjectConfig({ repo: 'ex/repo' });
        assert.equal(cfg.machineAuthor, undefined, 'no local, no primitive → the knob stays unset');
        assert.equal(cfg._configPath, undefined);
    });

    test('corrupt remote content → defaults (evaluation failure is swallowed)', function() {
        var prim = primitiveServing('module.exports = { broken syntax === ;;;');
        var loader = makeConfigLoader(makeRemoteModule(prim), null);
        var cfg = loader.loadProjectConfig({ repo: 'ex/repo' });
        assert.equal(cfg.machineAuthor, undefined, 'a broken read becomes NO config, never a wrong one');
    });

    test('HTML remote content → defaults (the stopgap guard)', function() {
        var prim = primitiveServing(SRC_HTML);
        var loader = makeConfigLoader(makeRemoteModule(prim), null);
        var cfg = loader.loadProjectConfig({ repo: 'ex/repo' });
        assert.equal(cfg.machineAuthor, undefined);
    });

    test('LOCAL candidates keep absolute precedence — the fetched one is never consulted', function() {
        var prim = primitiveServing(JSON.stringify({ content: B64_REMOTE, encoding: 'base64' }));
        var loader = makeConfigLoader(makeRemoteModule(prim), { '.dmtools/config.js': SRC_LOCAL });
        var cfg = loader.loadProjectConfig({ repo: 'ex/repo' });
        assert.equal(cfg.machineAuthor, 'local-bot', 'the checked-out config wins');
        assert.equal(prim.calls.length, 0, 'a local hit must not fetch');
    });

    test('an earlier local candidate (configPath) wins over .dmtools/config.js and the remote', function() {
        var prim = primitiveServing(JSON.stringify({ content: B64_REMOTE, encoding: 'base64' }));
        var loader = makeConfigLoader(makeRemoteModule(prim), { 'custom/repo-config.js': SRC_POLICY });
        var cfg = loader.loadProjectConfig({ repo: 'ex/repo', configPath: 'custom/repo-config.js' });
        assert.equal(cfg.reviewPolicy, 'strict');
        assert.equal(cfg._configPath, 'custom/repo-config.js');
        assert.equal(prim.calls.length, 0);
    });

    test('a second load in one run rides the TTL cache (single fetch)', function() {
        var prim = primitiveServing(JSON.stringify({ content: B64_ALLOWLIST, encoding: 'base64' }));
        var loader = makeConfigLoader(makeRemoteModule(prim), null);
        loader.loadProjectConfig({ repo: 'ex/repo' });
        loader.loadProjectConfig({ repo: 'ex/repo' });
        assert.equal(prim.calls.length, 1, 'one fetch per job run');
    });

    test('scmProvider override routes the fetch at the gitlab capability', function() {
        var seen = null;
        var mod = loadModule('js/common/remoteProjectConfig.js', makeRequire({}), {
            github_get_file_contents: null,
            github_get_file_content: null,
            gitlab_get_file_contents: function(opts) { seen = opts; return SRC_REMOTE; }
        });
        var loader = makeConfigLoader(mod, null);
        var cfg = loader.loadProjectConfig({ repo: 'ex/repo', customParams: { scmProvider: 'gitlab' } });
        assert.equal(cfg.machineAuthor, 'remote-bot');
        assert.deepEqual(seen, { workspace: 'ex', repository: 'repo', path: '.dmtools/config.js' });
    });

    test('no resolvable repository → no fetch attempt (silently no config)', function() {
        var prim = primitiveServing(JSON.stringify({ content: B64_ALLOWLIST, encoding: 'base64' }));
        var loader = makeConfigLoader(makeRemoteModule(prim), null);
        var cfg = loader.loadProjectConfig({});
        assert.equal(cfg.machineAuthor, undefined);
        assert.equal(prim.calls.length, 0, 'an unknown target fetches nothing');
    });

});

// ── machineLoginsOf — the knob is visible through the production wiring ──────

suite('mergeBackstop.machineLoginsOf — remote-config knob visibility (gh-1421)', function() {

    test('primitive present → the fetched machineAuthor reaches the allowlist', function() {
        var prim = primitiveServing(JSON.stringify({ content: B64_ALLOWLIST, encoding: 'base64' }));
        var backstop = makeMergeBackstop(makeRemoteModule(prim));
        var logins = backstop.machineLoginsOf({ repo: 'ex/repo' });
        assert.deepEqual(logins, ['bot-a', 'bot-b']);
    });

    test('primitive absent → the empty allowlist (fail-closed as today)', function() {
        var backstop = makeMergeBackstop(makeRemoteModule(null));
        assert.deepEqual(backstop.machineLoginsOf({ repo: 'ex/repo' }), []);
    });

    test('jobParams.machineAuthor still wins over the fetched knob', function() {
        var prim = primitiveServing(JSON.stringify({ content: B64_ALLOWLIST, encoding: 'base64' }));
        var backstop = makeMergeBackstop(makeRemoteModule(prim));
        var logins = backstop.machineLoginsOf({ repo: 'ex/repo', machineAuthor: 'param-bot' });
        assert.deepEqual(logins, ['param-bot']);
    });

});

// ── scm.js provider twins (design point 5) ───────────────────────────────────

suite('scm provider twins — getFileContents', function() {

    test('github twin maps workspace/repository onto the primitive schema', function() {
        var seen = null;
        var scm = scmMod({ github_get_file_contents: function(opts) { seen = opts; return 'raw'; } });
        var provider = scm._createGithubProvider('ex', 'repo');
        assert.equal(provider.getFileContents('.dmtools/config.js', 'main'), 'raw');
        assert.deepEqual(seen, { owner: 'ex', repo: 'repo', path: '.dmtools/config.js', ref: 'main' });
    });

    test('github twin omits ref when absent (default branch read)', function() {
        var seen = null;
        var scm = scmMod({ github_get_file_contents: function(opts) { seen = opts; return 'raw'; } });
        scm._createGithubProvider('ex', 'repo').getFileContents('.dmtools/config.js');
        assert.deepEqual(seen, { owner: 'ex', repo: 'repo', path: '.dmtools/config.js' });
    });

    test('github twin: primitive absent → null (capability miss, no throw)', function() {
        var scm = scmMod({});
        assert.equal(scm._createGithubProvider('ex', 'repo').getFileContents('.dmtools/config.js'), null);
    });

    test('github twin: primitive throws → null (fail-open)', function() {
        var scm = scmMod({ github_get_file_contents: function() { throw new Error('500'); } });
        assert.equal(scm._createGithubProvider('ex', 'repo').getFileContents('.dmtools/config.js'), null);
    });

    test('gitlab twin rides the existing gitlab wiring bag', function() {
        var seen = null;
        var scm = scmMod({ gitlab_get_file_contents: function(opts) { seen = opts; return 'gl'; } });
        var provider = scm._createGitLabProvider('grp', 'proj');
        assert.equal(provider.getFileContents('.dmtools/config.js'), 'gl');
        assert.deepEqual(seen, { workspace: 'grp', repository: 'proj', path: '.dmtools/config.js' });
    });

    test('gitlab twin: primitive absent → null', function() {
        var scm = scmMod({});
        assert.equal(scm._createGitLabProvider('grp', 'proj').getFileContents('.dmtools/config.js'), null);
    });

    test('remoteConfigIo() defaults to github when the provider is absent', function() {
        var mod = makeRemoteModule(null);
        assert.equal(mod.remoteConfigIo().provider, 'github');
    });

    test('fetch without nowMs uses the real clock and still caches', function() {
        var mod = makeRemoteModule(null);
        var calls = 0;
        var io = { provider: 'github', getFileContents: function() { calls++; return null; } };
        var first = mod.fetchRemoteConfigSource({ repo: 'o/r' }, {}, { io: io });
        var second = mod.fetchRemoteConfigSource({ repo: 'o/r' }, {}, { io: io });
        assert.equal(first, null);
        assert.equal(second, null);
        assert.equal(calls, 1); // the Date.now()-timestamped miss cached for the TTL
    });

});
