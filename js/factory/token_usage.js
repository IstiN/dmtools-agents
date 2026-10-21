/**
 * Factory token usage — per-leg token-usage publisher (owner directive
 * 2026-10-13: factory glue moves into dmtools-agents as JS agent code; awf
 * workflows become thin callers).
 *
 * JS port of the awf factory-teammate.yml step «Publish leg token usage
 * (fa-tokens ledger -> factory-data)» — byte-extracted into
 * scripts/publish-token-usage.sh by IstiN/dmtools-agentic-workflows#34.
 * Behavior contract is identical:
 *
 *   1. Read the run output (RUN_OUTPUT). Missing/empty → skip (warn).
 *   2. Sum every `fa-tokens: {…}` ledger line (resume-aware: one line per
 *      session segment) — balanced-brace scan so a payload wrapped in a log
 *      line is found whole; invalid payloads are skipped. input/output/
 *      cacheRead are summed; the last-seen model wins. Zero in+out → skip.
 *   3. Leg: the run guard collapses the rework slot into kind="dev", so the
 *      true leg is recovered from the runner-config basename — *rework* →
 *      "rework", else KIND, else "dev".
 *   4. Anchor → key: pr-* passes through; gh-N → issue-N; anything else →
 *      skip (warn).
 *   5. Row (printf field order): {"leg","at","prompt","completion","total",
 *      "cacheRead","model"} — at = UTC ISO-8601 seconds.
 *   6. Bootstrap the factory-data branch from the default-branch head
 *      (422 "already exists" is the normal case), then up to 3 attempts:
 *      GET contents (sha + body), append the row under the key, drop rows
 *      older than 14 days, keep the last 40 per key, drop emptied keys,
 *      PUT Contents API with the existing sha. Conflict → refetch → retry
 *      (sh backoff attempt*2s). Exhausted → warn; rows are decorative and
 *      the next leg retries.
 *
 * Transport mirrors factoryState.js: every command starts with `gh` (the
 * executor whitelists the first token); base64 stays in-shell
 * (`printf %s … | base64` / `--jq .content | base64 -d`) so the JS side
 * never needs a base64 codec.
 *
 * Env/file contract (the sh step's env block; the JSRunner entry reads
 * jobParams.customParams first, these env names as fallback):
 *   RUN_OUTPUT   path of the captured run output (fa-tokens ledger source)
 *   CONFIG       runner config path; basename minus .json decides the leg
 *   KIND         leg kind when the basename has no "rework" (default "dev")
 *   ANCHOR       work anchor: pr-<n> | gh-<n>
 *   REPO         owner/repo of the factory-data target
 *   DATA_BRANCH  target branch (default "factory-data")
 *   DATA_PATH    target path   (default "data/fa-tokens.json")
 *
 * Pure functions carry no IO: the publisher takes { exec, read, sleepMs,
 * log } capturers (factoryState.js convention) so tests mock the transport
 * via loadModule without touching any global.
 */

var ROW_KEEP = 40;              // jq `.[-40:]` tail cap per key
var DEFAULT_WINDOW_DAYS = 14;   // jq cutoff: keep rows newer than now-14d
var DEFAULT_DATA_BRANCH = 'factory-data';
var DEFAULT_DATA_PATH = 'data/fa-tokens.json';
var DEFAULT_ATTEMPTS = 3;       // concurrent-leg PUT conflict absorber

// ── ledger parsing (pure) ────────────────────────────────────────────────────

/**
 * Extracts the JSON payload after an `fa-tokens:` marker by balanced-brace
 * scanning (same discipline as aiTeammateTokenUsageReporter.extractFaPayload,
 * but anchored on the marker regex the sh used: `fa-tokens:[ \t]*(\{)`).
 * Returns the payload substring or null when no complete {...} follows.
 */
function extractFaPayload(text, markerEnd) {
    var start = -1;
    for (var i = markerEnd; i < text.length; i++) {
        var ch = text.charAt(i);
        if (ch === ' ' || ch === '\t') continue;
        if (ch === '{') { start = i; break; }
        return null; // sh regex required the brace right after the marker
    }
    if (start === -1) return null;
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var j = start; j < text.length; j++) {
        var c = text.charAt(j);
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return text.substring(start, j + 1);
        }
    }
    return null; // unterminated payload (truncated log) — ignored
}

/**
 * python int(rec.get(k) or 0): null/'' → 0; numeric strings coerced;
 * non-numeric → null (the sh's int() raise → whole record skipped).
 */
function ledgerInt(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? Math.floor(v) : null;
    var s = String(v).trim();
    if (!/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
}

/**
 * Sums every fa-tokens ledger record in the run output.
 * Returns { input, output, cacheRead, model } — model is the last-seen
 * non-empty model ('' when the ledger never carries one).
 */
function parseFaTokensLedger(text) {
    var sums = { input: 0, output: 0, cacheRead: 0, model: '' };
    var body = String(text || '');
    var re = /fa-tokens:/g;
    var m;
    while ((m = re.exec(body)) !== null) {
        var payload = extractFaPayload(body, m.index + m[0].length);
        re.lastIndex = m.index + m[0].length; // non-overlapping, marker-paced
        if (payload === null) continue;
        var rec;
        try { rec = JSON.parse(payload); } catch (e) { continue; }
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        var inp = ledgerInt(rec.input);
        var out = ledgerInt(rec.output);
        var cr = ledgerInt(rec.cacheRead);
        if (inp === null || out === null || cr === null) continue; // int() raise
        sums.input += inp;
        sums.output += out;
        sums.cacheRead += cr;
        if (rec.model) sums.model = String(rec.model); // last-seen wins
    }
    return sums;
}

// ── leg / anchor resolution (pure) ───────────────────────────────────────────

/**
 * The run guard collapses the rework slot into kind="dev" (rework legs run
 * the dev pipeline); recover the true leg from the runner config basename:
 * `basename CONFIG .json` containing "rework" → "rework", else KIND,
 * else "dev".
 */
function resolveLeg(configPath, kind) {
    var base = String(configPath || '').split('/').pop() || '';
    var stem = base.replace(/\.json$/, '');
    if (stem.indexOf('rework') !== -1) return 'rework';
    return String(kind || '') || 'dev';
}

/**
 * pr-* passes through; gh-N → issue-N; anything else → null (skip signal).
 */
function resolveAnchorKey(anchor) {
    var a = String(anchor === null || anchor === undefined ? '' : anchor);
    if (a.indexOf('pr-') === 0) return a;
    if (a.indexOf('gh-') === 0) return 'issue-' + a.slice(3);
    return null;
}

// ── time + row shape (pure) ──────────────────────────────────────────────────

/** `date -u +%Y-%m-%dT%H:%M:%SZ` — UTC ISO-8601, seconds precision. */
function utcStampZ(d) {
    var date = (d instanceof Date) ? d : new Date(d);
    if (isNaN(date.getTime())) return '';
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Retention cutoff: now − days (default 14) as a Z stamp for `>=` compares. */
function cutoffIso(now, days) {
    var ms = (now instanceof Date) ? now.getTime() : new Date(now).getTime();
    if (isNaN(ms)) ms = Date.now();
    var span = (days || DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
    return utcStampZ(new Date(ms - span));
}

/**
 * The printf row: field order is the contract
 * {"leg","at","prompt","completion","total","cacheRead","model"}.
 */
function buildRow(o) {
    o = o || {};
    var prompt = ledgerInt(o.prompt) || 0;
    var completion = ledgerInt(o.completion) || 0;
    return {
        leg: String(o.leg || ''),
        at: String(o.at || ''),
        prompt: prompt,
        completion: completion,
        total: prompt + completion,
        cacheRead: ledgerInt(o.cacheRead) || 0,
        model: String(o.model || '')
    };
}

// ── merge + retention (pure) — the jq program ────────────────────────────────

/**
 * `.[$key] = ((.[$key] // []) + [$row])
 *  | with_entries(.value |= (map(select((.at // "") >= $cutoff)) | .[-40:]))
 *  | with_entries(select(.value | length > 0))`
 *
 * Appends under the key, drops rows older than cutoff (string compare —
 * Z stamps sort), keeps the LAST 40 per key, drops emptied keys. Corrupt
 * shapes degrade to {} exactly like the `jq empty` guard.
 */
function mergeTokenRows(cur, key, row, cutoff) {
    var src = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
    var next = {};
    var ordered = [];
    var seen = {};
    for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k) && !seen[k]) {
            seen[k] = true;
            ordered.push(k);
        }
    }
    if (!seen[key]) ordered.push(key);
    for (var i = 0; i < ordered.length; i++) {
        var kk = ordered[i];
        var rows = src[kk] || [];
        if (kk === key) rows = rows.concat([row]);
        var kept = [];
        for (var j = 0; j < rows.length; j++) {
            var r = rows[j];
            if (r && typeof r === 'object' && String(r.at || '') >= cutoff) kept.push(r);
        }
        kept = kept.slice(-ROW_KEEP);
        if (kept.length > 0) next[kk] = kept;
    }
    return next;
}

// ── gh command builders (pure strings; gh-first executor whitelist) ─────────

/** Single-quote for the shell, factoryState.js discipline. */
function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Bootstrap the data branch from the default-branch head. `|| true`: the
 * 422 "already exists" is the normal case and the executor throws on
 * non-zero exit.
 */
function bootstrapBranchCommand(repo, branch) {
    return 'gh api -X POST repos/' + repo + '/git/refs' +
        ' -f ref=refs/heads/' + branch +
        ' -f sha="$(gh api repos/' + repo +
        '/git/ref/heads/$(gh api repos/' + repo +
        ' --jq .default_branch) --jq .object.sha)" || true';
}

/** Existing-file sha probe ('Not Found'/throw = first publish). */
function contentsShaCommand(repo, path, branch) {
    return 'gh api repos/' + repo + '/contents/' + path + '?ref=' + branch +
        ' --jq .sha';
}

/** Body probe — decoded in-shell so JS never needs a base64 codec. */
function contentsBodyCommand(repo, path, branch) {
    return 'gh api repos/' + repo + '/contents/' + path + '?ref=' + branch +
        ' --jq .content | base64 -d';
}

var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Convert a JS string to an array of UTF-8 byte values (0..255). */
function utf8BytesOf(str) {
    var s = String(str == null ? '' : str);
    var utf8 = encodeURIComponent(s);
    var bytes = [];
    for (var i = 0; i < utf8.length; i++) {
        if (utf8.charAt(i) === '%') {
            bytes.push(parseInt(utf8.substr(i + 1, 2), 16));
            i += 2;
        } else {
            bytes.push(utf8.charCodeAt(i));
        }
    }
    return bytes;
}

/** Pure UTF-8 → Base64 encoder (runtime-agnostic: GraalJS, QuickJS, Node). */
function base64EncodeUtf8(str) {
    var bytes = utf8BytesOf(str);
    var out = '';
    for (var j = 0; j < bytes.length; j += 3) {
        var b0 = bytes[j];
        var has1 = (j + 1) < bytes.length;
        var has2 = (j + 2) < bytes.length;
        var b1 = has1 ? bytes[j + 1] : 0;
        var b2 = has2 ? bytes[j + 2] : 0;
        var triplet = (b0 << 16) | (b1 << 8) | b2;
        out += BASE64_CHARS.charAt((triplet >> 18) & 63) +
            BASE64_CHARS.charAt((triplet >> 12) & 63) +
            (has1 ? BASE64_CHARS.charAt((triplet >> 6) & 63) : '=') +
            (has2 ? BASE64_CHARS.charAt(triplet & 63) : '=');
    }
    return out;
}

/** Build the GitHub Contents API PUT JSON body (`--input <file>` payload). */
function buildContentsPutBody(o) {
    var p = o || {};
    var body = {
        branch: String(p.branch || DEFAULT_DATA_BRANCH),
        message: String(p.message || ''),
        content: base64EncodeUtf8(p.json == null ? '{}' : p.json)
    };
    if (p.sha) body.sha = String(p.sha);
    return body;
}

/**
 * Deterministic temp-file path for `--input` (digits-only suffixes, matching
 * `checkRunStamp.js` `tempBodyPath` convention). Note: two concurrent legs on
 * a shared host landing in the exact same millisecond + attempt share this
 * path; each leg runs in its own job container/step in CI.
 */
function tempPutBodyPath(now, attempt) {
    var ms = (now instanceof Date) ? now.getTime() : new Date(now).getTime();
    if (isNaN(ms)) ms = 0;
    return '/tmp/fa-tokens-put-' + Number(ms) + '-' + Number(attempt || 0) + '.json';
}

/** Contents PUT via `--input <tempPath>`: zero payload bytes in argv (gh-1152). */
function contentsPutInputCommand(repo, path, tempPath) {
    return 'gh api -X PUT repos/' + repo + '/contents/' + path + ' --input ' + tempPath;
}

/** Contents PUT (legacy inline argv builder): message, branch, base64 content, sha. */
function contentsPutCommand(repo, path, o) {
    var cmd = 'gh api -X PUT repos/' + repo + '/contents/' + path +
        ' -f branch=' + (o.branch || DEFAULT_DATA_BRANCH) +
        ' -f message=' + shellQuote(o.message || '') +
        ' -f content="$(printf %s ' + shellQuote(o.json || '{}') + ' | base64)"';
    if (o.sha) cmd += ' -f sha=' + shellQuote(o.sha);
    return cmd;
}

/** Write PUT body to `tempPath`, run `gh api --input`, and best-effort delete in `finally`. */
function tryPutViaInputFile(io, repo, path, tempPath, putOpts) {
    var bodyText = JSON.stringify(buildContentsPutBody(putOpts));
    try {
        io.write({ path: tempPath, content: bodyText });
        io.exec({ command: contentsPutInputCommand(repo, path, tempPath) });
        return true;
    } catch (e) {
        return false;
    } finally {
        if (typeof io.del === 'function') {
            try { io.del({ path: tempPath }); } catch (eDel) { /* best-effort cleanup */ }
        }
    }
}

/** Log a one-time warning when falling back to inline argv PUT on a large payload. */
function warnInlineFallbackIfLarge(io, attempt, putOpts) {
    if (Number(attempt) <= 1 && String(putOpts.json).length >= 96000) {
        io.log('::warning::file_write unavailable — inline argv PUT fallback (E2BIG risk at >=96 KB payloads)');
    }
}

/** Dispatch PUT via `--input` temp file when `io.write` is wired, else inline fallback. */
function putTokenContents(io, repo, path, now, attempt, putOpts) {
    if (io && typeof io.write === 'function') {
        return tryPutViaInputFile(io, repo, path, tempPutBodyPath(now, attempt), putOpts);
    }
    warnInlineFallbackIfLarge(io, attempt, putOpts);
    return tryExec(io && io.exec, contentsPutCommand(repo, path, putOpts));
}

// ── publisher (IO via injected capturers) ────────────────────────────────────

function execOut(exec, command) {
    var res = exec({ command: command });
    return String((res && (res.output || res.stdout)) || res || '').trim();
}

function tryExec(exec, command) {
    if (!exec) return false;
    try { exec({ command: command }); return true; } catch (e) { return false; }
}

/**
 * Publish one leg's token-usage row.
 *
 * opts: runOutput, configPath, kind, anchor, repo, dataBranch, dataPath,
 *       now (Date|ms|ISO — tests pin the clock), attempts (default 3)
 * io:   exec({command}) → {output|stdout} (throws on failure) — REQUIRED
 *       for any gh traffic; read(path) → string (throws when absent);
 *       sleepMs(ms) (default no-op — the sh sleeps attempt*2 s; the agent
 *       runtime has no blocking sleep, retries refetch anyway);
 *       log(line).
 *
 * Returns { status, reason, key, leg, row, attempts } with status
 * 'published' | 'skipped' | 'gave-up' and reason
 * 'no-run-output' | 'no-ledger' | 'bad-anchor' | null.
 */
function publishTokenUsage(opts, io) {
    opts = opts || {};
    io = io || {};
    var exec = io.exec;
    var read = io.read;
    var sleepMs = io.sleepMs || function () {};
    var log = io.log || function () {};
    var attempts = opts.attempts || DEFAULT_ATTEMPTS;
    var repo = opts.repo || '';
    var branch = opts.dataBranch || DEFAULT_DATA_BRANCH;
    var path = opts.dataPath || DEFAULT_DATA_PATH;
    var now = opts.now ? opts.now : new Date();
    var result = { status: 'skipped', reason: null, key: null, leg: null, row: null, attempts: 0 };

    // 1) run output — `[ ! -s "${RUN_OUTPUT}" ]` → skip
    var text = '';
    if (typeof read === 'function') {
        try { text = String(read(opts.runOutput) || ''); } catch (e) { text = ''; }
    }
    if (!text) {
        result.reason = 'no-run-output';
        log('::warning::no run output captured — skipping token publish');
        return result;
    }

    // 2) sums — zero in+out → skip
    var sums = parseFaTokensLedger(text);
    if (sums.input === 0 && sums.output === 0) {
        result.reason = 'no-ledger';
        log('::warning::no fa-tokens ledger line in run output — skipping token publish');
        return result;
    }

    // 3) leg from the runner-config basename (rework recovery)
    var leg = resolveLeg(opts.configPath, opts.kind);
    result.leg = leg;

    // 4) anchor → key
    var key = resolveAnchorKey(opts.anchor);
    if (!key) {
        result.reason = 'bad-anchor';
        log('::warning::unrecognized anchor \'' + String(opts.anchor || '') +
            '\' — skipping token publish');
        return result;
    }
    result.key = key;

    // 5) row (printf field order)
    var row = buildRow({
        leg: leg,
        at: utcStampZ(now),
        prompt: sums.input,
        completion: sums.output,
        cacheRead: sums.cacheRead,
        model: sums.model
    });
    result.row = row;
    log('leg tokens: ' + key + ' ' + leg +
        ' prompt=' + sums.input +
        ' completion=' + sums.output +
        ' cached=' + sums.cacheRead +
        ' model=' + (sums.model || 'none'));

    // 6) bootstrap the data branch (422 already-exists is the normal case)
    tryExec(exec, bootstrapBranchCommand(repo, branch));

    // 7) up to N attempts: refetch sha+body, merge, PUT — conflicts refetch
    var cutoff = cutoffIso(now);
    for (var attempt = 1; attempt <= attempts; attempt++) {
        var sha = '';
        try { sha = execOut(exec, contentsShaCommand(repo, path, branch)); }
        catch (e) { sha = ''; } // first publish — the file is absent
        if (sha.indexOf('Not Found') !== -1) sha = '';
        var cur = {};
        try {
            cur = JSON.parse(execOut(exec, contentsBodyCommand(repo, path, branch)) || '{}');
        } catch (e2) { cur = {}; } // `jq empty` guard — corrupt body → {}
        var next = mergeTokenRows(cur, key, row, cutoff);
        var ok = putTokenContents(io, repo, path, now, attempt, {
            branch: branch,
            message: 'leg tokens — ' + key + ' ' + leg + ' [skip ci]',
            json: JSON.stringify(next),
            sha: sha
        });
        if (ok) {
            result.status = 'published';
            result.reason = null;
            result.attempts = attempt;
            return result;
        }
        result.attempts = attempt;
        log('token publish attempt ' + attempt + ' conflicted — refetching');
        if (attempt < attempts) sleepMs(attempt * 2000); // sh: sleep $((attempt * 2))
    }
    result.status = 'gave-up';
    log('::warning::token publish gave up after ' + attempts +
        ' attempts (concurrent writes) — rows are decorative, next legs retry');
    return result;
}

module.exports = {
    parseFaTokensLedger: parseFaTokensLedger,
    extractFaPayload: extractFaPayload,
    resolveLeg: resolveLeg,
    resolveAnchorKey: resolveAnchorKey,
    utcStampZ: utcStampZ,
    cutoffIso: cutoffIso,
    buildRow: buildRow,
    mergeTokenRows: mergeTokenRows,
    shellQuote: shellQuote,
    base64EncodeUtf8: base64EncodeUtf8,
    buildContentsPutBody: buildContentsPutBody,
    tempPutBodyPath: tempPutBodyPath,
    contentsPutInputCommand: contentsPutInputCommand,
    bootstrapBranchCommand: bootstrapBranchCommand,
    contentsShaCommand: contentsShaCommand,
    contentsBodyCommand: contentsBodyCommand,
    contentsPutCommand: contentsPutCommand,
    tryPutViaInputFile: tryPutViaInputFile,
    putTokenContents: putTokenContents,
    publishTokenUsage: publishTokenUsage,
    ROW_KEEP: ROW_KEEP,
    DEFAULT_WINDOW_DAYS: DEFAULT_WINDOW_DAYS,
    DEFAULT_DATA_BRANCH: DEFAULT_DATA_BRANCH,
    DEFAULT_DATA_PATH: DEFAULT_DATA_PATH,
    DEFAULT_ATTEMPTS: DEFAULT_ATTEMPTS
};
