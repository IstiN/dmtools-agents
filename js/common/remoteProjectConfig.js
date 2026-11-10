/**
 * remoteProjectConfig.js — SCM-agnostic config acquisition (gh-1421).
 *
 * The merge funnel's per-repo config (.dmtools/config.js: machineAuthor,
 * reviewPolicy, jira.fields, …) used to be fetched by WORKFLOW bash — the
 * `gh api contents` stopgap (IstiN/dmtools-agentic-workflows#91) that hardwired
 * config acquisition to one SCM per workflow file. This module moves the read
 * behind the scm layer: when every LOCAL config candidate misses, the engine
 * fetches `.dmtools/config.js` from the repo's DEFAULT BRANCH through the
 * provider's file-contents bridge primitive — one fetch per job run (short-TL
 * cache), failing open to "no config" on any failure. The same invariants as
 * the local loader hold: a broken read never becomes a wrong config — it
 * becomes NO config, and every guard keyed on it (machineAuthor's empty
 * allowlist, reviewPolicy's default preset) stays fail-closed.
 *
 * Deletion note (gh-1421, retires IstiN/dmtools-agentic-workflows#91): the
 * workflow-side `gh api repos/{repo}/contents/...` step that dropped
 * .dmtools/config.js into the merge-trigger job CWD is RETIRED by this
 * fallback — workflows are SCM-neutral for config again. Delete the stopgap
 * step from factory-merge-trigger.yml (and any sibling copy) once the engine
 * ships this module; no workflow needs a per-SCM config fetch anymore.
 *
 * IO contract (mergeBackstop style): remoteConfigIo(provider) enumerates the
 * raw bridge primitives into a capability bag — `getFileContents(target, path)`
 * where target = { owner, repo }; an ABSENT primitive maps null (a capability
 * miss, never an error) and every consumer degrades gracefully. The GitHub
 * primitive is `github_get_file_contents` (the ticket-named twin; the shipped
 * `github_get_file_content` spelling serves the same schema today) and the
 * GitLab twin `gitlab_get_file_contents` lands with the GitLab runner infra —
 * both spellings are capability-checked. The fetch functions take the io bag
 * (or options.io) so tests script it.
 *
 * Payload tolerance (one bridge payload → config source, or null):
 *   - a plain string that is the config source itself (a pre-decoded bridge);
 *   - the GitHub Contents-API envelope — object or JSON string, optionally
 *     wrapped in an mcpParse-style {result: …} envelope — with a base64
 *     `content` field (decoded here; a strict-base64-charset content decodes
 *     even when the encoding field is absent, while punctuation-bearing
 *     source text passes through untouched);
 *   - an HTML error page / whitespace / junk → null (the stopgap's guard).
 *
 * GraalJS-clean: var + plain functions, JSON-safe data, NO requires (the
 * capability bag names the primitives itself — pure module, io injected),
 * no new globals (GH_REPO is the existing env-global, typeof-guarded).
 */

/* global github_get_file_contents, github_get_file_content,
   gitlab_get_file_contents, gitlab_get_file_content, GH_REPO */

// The one remote path this module ever fetches (gh-1421 non-goal: nothing
// beyond .dmtools/config.js).
var REMOTE_CONFIG_PATH = '.dmtools/config.js';

// The label loadConfigFile-style warnings carry for the remote source.
var REMOTE_CONFIG_LABEL = '.dmtools/config.js (remote scm fetch)';

// Short-TL cache: one fetch per job run. A job run is minutes; 60s collapses
// the burst of loadProjectConfig calls one decision makes (machineLoginsOf +
// reviewPolicy + downstream propagation) while bounding staleness for
// long-lived engines.
var REMOTE_CONFIG_TL_MS = 600;

// The cache holds at most one entry per (provider, repo) a process touched;
// past this the expired entries drop first, then the whole map (bounded —
// the map is an optimization, never a correctness surface).
var REMOTE_CONFIG_CACHE_MAX = 16;

// provider → capability bag (production primitives, capability-gated).
// A primitive maps null when the runtime does not declare it — a capability
// miss, never an error (callers degrade to the local/defaults path).
function remoteConfigIo(provider) {
    var p = String(provider || 'github').toLowerCase();
    if (p === 'gitlab') {
        var gl = (typeof gitlab_get_file_contents === 'function') ? gitlab_get_file_contents
            : ((typeof gitlab_get_file_content === 'function') ? gitlab_get_file_content : null);
        return {
            provider: 'gitlab',
            // The GitLab twin rides the existing gitlab wiring bag
            // (workspace/repository — the bridge maps it onto the project path).
            getFileContents: gl ? function(target, path) {
                return gl({ workspace: target.owner, repository: target.repo, path: path });
            } : null
        };
    }
    var gh = (typeof github_get_file_contents === 'function') ? github_get_file_contents
        : ((typeof github_get_file_content === 'function') ? github_get_file_content : null);
    return {
        provider: 'github',
        // The GitHub primitive schema is {owner, repo, path, ref?}; ref is
        // omitted — the fetch targets the DEFAULT branch (the stopgap's exact
        // semantics, and the primitive's own default).
        getFileContents: gh ? function(target, path) {
            return gh({ owner: target.owner, repo: target.repo, path: path });
        } : null
    };
}

/**
 * The fetch target for the caller's params: the resolved {owner, repo} of the
 * repo whose config this job is about, or null when nothing identifies one
 * (a null target fetches nothing — silently, like an absent candidate).
 *
 *   1. params.repository        — {owner, repo} (the SM's target-repo param)
 *   2. params.repo              — "owner/name" (the merge funnel's jobParams)
 *   3. customParams.targetRepository — {owner, repo}
 *   4. GH_REPO                  — the env-global (mergeBot/mergeTrigger parity)
 */
function remoteConfigRepositoryOf(params, customParams) {
    if (params && params.repository && params.repository.owner && params.repository.repo) {
        return { owner: String(params.repository.owner), repo: String(params.repository.repo) };
    }
    if (params && params.repo && String(params.repo).indexOf('/') !== -1) {
        var parts = String(params.repo).split('/');
        return { owner: parts[0], repo: parts.slice(1).join('/') };
    }
    if (customParams && customParams.targetRepository &&
        customParams.targetRepository.owner && customParams.targetRepository.repo) {
        return {
            owner: String(customParams.targetRepository.owner),
            repo: String(customParams.targetRepository.repo)
        };
    }
    if (typeof GH_REPO !== 'undefined' && GH_REPO && String(GH_REPO).indexOf('/') !== -1) {
        var gh = String(GH_REPO).split('/');
        return { owner: gh[0], repo: gh.slice(1).join('/') };
    }
    return null;
}

// ── base64 → UTF-8 (pure JS — no Buffer, no Java interop dependency) ─────────

var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode base64 into the byte values (0-255) it carries. Whitespace
 * (the Contents API wraps its base64 at 60 chars) is ignored; decoding stops
 * at padding or the first non-alphabet character.
 */
function base64Bytes(input) {
    var clean = String(input || '').replace(/\s+/g, '');
    var bytes = [];
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < clean.length; i++) {
        var idx = B64_ALPHABET.indexOf(clean.charAt(i));
        if (idx === -1) break; // '=' padding or corrupt — the stream ends here
        acc = (acc << 6) | idx;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xFF);
        }
    }
    return bytes;
}

/**
 * Decode UTF-8 bytes into a JS string. Full sequence handling (2-4 byte
 * forms incl. surrogate pairs for astral chars); every invalid/truncated
 * sequence emits U+FFFD and resynchronizes on the next lead byte — a decode
 * can never throw (a corrupt read becomes garbage-and-null downstream, never
 * a crash).
 */
function utf8StringOf(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
        var b = bytes[i];
        if (b < 0x80) {
            out += String.fromCharCode(b);
            i++;
            continue;
        }
        var cp = 0;
        var extra = 0;
        if (b >= 0xC2 && b <= 0xDF) { cp = b & 0x1F; extra = 1; }
        else if (b >= 0xE0 && b <= 0xEF) { cp = b & 0x0F; extra = 2; }
        else if (b >= 0xF0 && b <= 0xF4) { cp = b & 0x07; extra = 3; }
        else {
            out += '\uFFFD';
            i++;
            continue;
        }
        var complete = true;
        for (var j = 1; j <= extra; j++) {
            var cont = bytes[i + j];
            if (cont === undefined || (cont & 0xC0) !== 0x80) {
                complete = false;
                break;
            }
            cp = (cp << 6) | (cont & 0x3F);
        }
        if (!complete) {
            out += '\uFFFD';
            i++;
            continue;
        }
        if (cp > 0xFFFF) {
            var shifted = cp - 0x10000;
            out += String.fromCharCode(0xD800 + (shifted >> 10), 0xDC00 + (shifted & 0x3FF));
        } else if (cp >= 0xD800 && cp <= 0xDFFF) {
            out += '\uFFFD'; // surrogate range — never valid UTF-8
        } else {
            out += String.fromCharCode(cp);
        }
        i += extra + 1;
    }
    return out;
}

/**
 * Decode a base64 payload into its string content. Engine-independent (the
 * pack runs in GraalJS AND the node test harness — no Buffer, no Java).
 */
function decodeBase64(input) {
    if (!input) return '';
    return utf8StringOf(base64Bytes(input));
}

// ── payload → config source ──────────────────────────────────────────────────

// A strict base64 candidate: alphabet chars/padding only (whitespace already
// stripped) and a whole number of 4-char groups. Real config source always
// carries punctuation ('.', ';', quotes…), so the heuristic never
// misdecodes a pre-decoded text payload.
function looksLikeBase64(text) {
    return /^[A-Za-z0-9+/=]+$/.test(text) && text.length % 4 === 0 && text.length > 0;
}

/** The stopgap's HTML-error-page guard: an HTML document is never config. */
function looksLikeHtmlPage(text) {
    var t = String(text || '').trim().toLowerCase();
    return t.indexOf('<!doctype html') === 0 || t.indexOf('<html') === 0;
}

/** The mcpParse-style bridge envelope unwrap ({result: …} wrappers). */
function unwrapResultEnvelope(parsed) {
    var cur = parsed;
    for (var depth = 0; depth < 3 && cur && typeof cur === 'object' &&
        typeof cur.content === 'undefined' && typeof cur.result !== 'undefined'; depth++) {
        if (typeof cur.result === 'string') {
            try { cur = JSON.parse(cur.result); } catch (e) { return cur.result; }
        } else {
            cur = cur.result;
        }
    }
    return cur;
}

/** Content field of a Contents-API envelope → config source (or null). */
function sourceFromContentEnvelope(env) {
    var content = env.content;
    if (typeof content !== 'string' || !content.trim()) return null;
    var encoding = typeof env.encoding === 'string' ? env.encoding.toLowerCase() : '';
    var candidate;
    if (encoding === 'base64') {
        candidate = decodeBase64(content);
    } else {
        var flat = content.replace(/\s+/g, '');
        candidate = (!encoding && looksLikeBase64(flat)) ? decodeBase64(flat) : content;
    }
    if (!candidate || !candidate.trim()) return null;
    return looksLikeHtmlPage(candidate) ? null : candidate;
}

/**
 * One bridge payload → the config source string it carries, or null when the
 * payload is absent or unusable (HTML page, junk). PURE — the fetch layer
 * owns the warn for present-but-unusable payloads. Tolerated shapes:
 *   - null / undefined / whitespace   → null (a repo without the file — quiet);
 *   - a source string                 → itself (HTML-guarded);
 *   - a JSON string / object envelope → unwrapped ({result: …}, mcpParse
 *     style) and its base64 `content` decoded (encoding-aware, with the
 *     strict-charset heuristic for envelopes that omit the field);
 *   - anything else                   → null.
 */
function remoteConfigSourceOf(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
        var trimmed = raw.trim();
        if (!trimmed) return null;
        if (trimmed.charAt(0) === '{') {
            var parsed = null;
            try { parsed = JSON.parse(trimmed); } catch (e) { return null; }
            return remoteConfigSourceOf(parsed);
        }
        return looksLikeHtmlPage(trimmed) ? null : raw;
    }
    if (typeof raw === 'object') {
        var inner = unwrapResultEnvelope(raw);
        if (typeof inner === 'string') return remoteConfigSourceOf(inner);
        if (inner && typeof inner === 'object' && inner !== raw) return remoteConfigSourceOf(inner);
        if (inner && typeof inner === 'object' && typeof inner.content === 'string') {
            return sourceFromContentEnvelope(inner);
        }
    }
    return null;
}

// ── the TTL cache (module scope — one fetch per job run) ─────────────────────

var _remoteConfigCache = {};

function cacheKeyOf(provider, target) {
    return provider + '|' + target.owner + '/' + target.repo + '|' + REMOTE_CONFIG_PATH;
}

/** Cache lookup: { hit: true, source } on a live entry, { hit: false } past the TTL or on a miss. */
function cacheGet(key, nowMs) {
    var entry = _remoteConfigCache[key];
    if (!entry) return { hit: false };
    if (nowMs - entry.fetchedAt >= REMOTE_CONFIG_TL_MS) {
        delete _remoteConfigCache[key];
        return { hit: false };
    }
    return { hit: true, source: entry.source };
}

function cachePut(key, source, nowMs) {
    if (!_remoteConfigCache[key] && Object.keys(_remoteConfigCache).length >= REMOTE_CONFIG_CACHE_MAX) {
        var keys = Object.keys(_remoteConfigCache);
        for (var i = 0; i < keys.length; i++) {
            if (nowMs - _remoteConfigCache[keys[i]].fetchedAt >= REMOTE_CONFIG_TL_MS) {
                delete _remoteConfigCache[keys[i]];
            }
        }
        if (Object.keys(_remoteConfigCache).length >= REMOTE_CONFIG_CACHE_MAX) {
            _remoteConfigCache = {}; // still full → drop wholesale (bounded, by construction)
        }
    }
    _remoteConfigCache[key] = { fetchedAt: nowMs, source: source };
}

/** Test-isolation reseter (underscore export — the established pattern). */
function _clearRemoteConfigCache() {
    _remoteConfigCache = {};
}

// ── the fetch ────────────────────────────────────────────────────────────────

/** The provider for the fetch: customParams.scmProvider, else github (createScm parity). */
function scmProviderOf(customParams) {
    return String((customParams && customParams.scmProvider) || 'github');
}

/**
 * Fetch .dmtools/config.js from the target repo's default branch through the
 * provider's file-contents primitive. Fail-open everywhere: a capability
 * miss, an unknown target, a throwing fetch, an HTML page or corrupt content
 * all read as null (NO config — never a wrong one). A validated miss caches
 * for the TTL too, so one job run attempts ONE fetch regardless of outcome.
 *
 * @param {Object} params       - the caller's params (jobParams)
 * @param {Object} customParams - the agent's customParams (scmProvider, targetRepository)
 * @param {Object} [options]    - { io?, nowMs? } — scripted io / injectable clock for tests
 * @returns {string|null} the config source, or null
 */
function fetchRemoteConfigSource(params, customParams, options) {
    var opts = options || {};
    var provider = scmProviderOf(customParams);
    var target = remoteConfigRepositoryOf(params, customParams);
    if (!target) return null;

    var io = opts.io || remoteConfigIo(provider);
    if (!io || !io.getFileContents) {
        console.log('remoteProjectConfig: no file-contents primitive for ' + (io && io.provider || provider) +
            ' — remote config skipped (capability miss)');
        return null;
    }

    var nowMs = (typeof opts.nowMs === 'number') ? opts.nowMs : Date.now();
    var key = cacheKeyOf(io.provider, target);
    var cached = cacheGet(key, nowMs);
    if (cached.hit) return cached.source;

    var raw = null;
    try {
        raw = io.getFileContents(target, REMOTE_CONFIG_PATH);
    } catch (e) {
        console.warn('remoteProjectConfig: fetch failed for ' + target.owner + '/' + target.repo +
            ':' + REMOTE_CONFIG_PATH + ' — ' + (e.message || e));
        cachePut(key, null, nowMs);
        return null;
    }

    var source = remoteConfigSourceOf(raw);
    if (source === null && raw !== null && raw !== undefined) {
        console.warn('remoteProjectConfig: ' + REMOTE_CONFIG_PATH + ' from ' + target.owner + '/' +
            target.repo + ' is not usable config source — ignoring (fail-open)');
    } else if (source !== null) {
        console.log('remoteProjectConfig: fetched ' + REMOTE_CONFIG_PATH + ' from ' + io.provider +
            ' ' + target.owner + '/' + target.repo + ' (default branch)');
    }
    cachePut(key, source, nowMs);
    return source;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        REMOTE_CONFIG_PATH: REMOTE_CONFIG_PATH,
        REMOTE_CONFIG_LABEL: REMOTE_CONFIG_LABEL,
        REMOTE_CONFIG_TL_MS: REMOTE_CONFIG_TL_MS,
        REMOTE_CONFIG_CACHE_MAX: REMOTE_CONFIG_CACHE_MAX,
        remoteConfigIo: remoteConfigIo,
        remoteConfigRepositoryOf: remoteConfigRepositoryOf,
        decodeBase64: decodeBase64,
        remoteConfigSourceOf: remoteConfigSourceOf,
        fetchRemoteConfigSource: fetchRemoteConfigSource,
        _clearRemoteConfigCache: _clearRemoteConfigCache
    };
}
