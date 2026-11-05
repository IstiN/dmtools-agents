/**
 * legFailureReport.js — the shared leg-failure report builder (gh-1363).
 *
 * A failed agent leg used to report one information-free bare link
 * ("🤖 AI Teammate run <outcome>: <run url>"). gh-1363 enriches every
 * leg-failure report with bounded, structured context and requires the two
 * failure surfaces to share ONE builder (this module):
 *
 *   1. the workflow failure-notice step (engine-side transport:
 *      scripts/report-leg-failure.sh, flipped into the factory workflow) —
 *      phase, failing step name, ≤30-line log excerpt of the failed step,
 *      run id + link, pre-flight line, repeat count;
 *   2. the in-leg setup failure path (js/preCliDevelopmentSetup.js → the
 *      "Development Setup Error" ticket comment) — same builder, rendered in
 *      the ticket's tracker markup flavor.
 *
 * Repeat-count history: derived from machine-readable `failure-signature:`
 * lines in the SAME issue's prior failure comments (an existing surface —
 * no new persistence). The signature is `workflow | step | normalized
 * message` where the normalization strips SHAs, run ids, timestamps, URLs
 * and path-like tokens — so only the error class survives (AC3).
 *
 * Structure:
 *   - every function is PURE except collectPreflightState (git IO arrives
 *     injected as a command runner) — GraalJS-clean (var + plain functions,
 *     JSON-safe data), zero requires, so the factory-setup asset can carry
 *     the file standalone;
 *   - rendering is flavor-neutral: a commentMarkup-style bag (h/bold/code/
 *     inline/link) is passed in by the caller — the ticket comment renders
 *     in the ticket's flavor, the workflow notice in markdown;
 *   - excerpt bounds live in ONE place (EXCERPT_MAX_LINES) and are enforced
 *     again at render time, so no call site can post an unbounded report;
 *   - secrets: Actions already masks tokens to `***` in logs — the builder
 *     never transforms excerpt bytes beyond line trimming/ANSI stripping,
 *     so masking survives verbatim (AC4, pinned by tests).
 */

'use strict';

var EXCERPT_DEFAULT_LINES = 10;
var EXCERPT_MAX_LINES = 30;
var PREFLIGHT_PATH_COUNT = 5;
var PREFLIGHT_MAX_PATHS_CHARS = 160;
var SIGNATURE_MAX_CHARS = 200;
var SIGNATURE_LINE_PREFIX = 'failure-signature: ';

// ── signature normalization (pure) ───────────────────────────────────────

/**
 * Strip everything the ticket calls noise from an error text: URLs,
 * path-like tokens, full and short SHAs, long digit runs (run ids, epoch
 * timestamps), ISO-8601 timestamps and bare times; collapse whitespace and
 * cap the length. The result is the error CLASS — two crashes differing
 * only in such noise normalize to the same text.
 */
function normalizeSignature(message) {
    var text = String(message == null ? '' : message);
    text = text.replace(/\bhttps?:\/\/\S+/g, ' ');
    text = text.replace(/\S*\/\S*/g, ' ');
    text = text.replace(/\b[0-9a-fA-F]{40}\b/g, ' ');
    text = text.replace(/\b[0-9a-fA-F]{7,39}\b/g, ' ');
    text = text.replace(/\b\d{7,}\b/g, ' ');
    text = text.replace(/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?/g, ' ');
    text = text.replace(/\b\d{2}:\d{2}(:\d{2})?\b/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > SIGNATURE_MAX_CHARS ? text.substring(0, SIGNATURE_MAX_CHARS) : text;
}

/**
 * The failure signature: workflow + failing step + normalized message.
 * Same issue + workflow + signature ⇒ the same failure keeps recurring.
 */
function failureSignature(parts) {
    var p = parts || {};
    return String(p.workflow || '') + ' | ' + String(p.step || '') + ' | ' +
        normalizeSignature(p.message);
}

// ── repeat count (pure) ──────────────────────────────────────────────────

/**
 * 1 + the number of CONSECUTIVE trailing priors sharing the signature.
 * priorSignatures is chronological (oldest first) — the natural order of
 * comment history; a non-matching entry breaks the streak.
 * A missing signature (derivation unavailable) yields null: the report then
 * omits the repeat line instead of guessing.
 */
function consecutiveRepeatCount(signature, priorSignatures) {
    if (!signature) return null;
    var list = priorSignatures || [];
    var count = 1;
    for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] === signature) count++;
        else break;
    }
    return count;
}

/** The human phrase for a repeat count (null count → null, line omitted). */
function repeatPhrase(count) {
    if (count === null || count === undefined) return null;
    return count <= 1
        ? 'first failure with this signature'
        : 'identical failure #' + count + ' in a row';
}

// ── machine-readable signature history (pure) ────────────────────────────

/** The plain (flavor-free) line a report carries for the next report to read. */
function signatureLine(signature) {
    return signature ? SIGNATURE_LINE_PREFIX + signature : null;
}

/**
 * Extract signatures from comment bodies, in order of appearance
 * (chronological when the comments are). Bodies without the marker yield
 * nothing — old bare-link reports simply carry no history.
 */
function parseSignatureLines(bodies) {
    var out = [];
    var list = bodies || [];
    for (var i = 0; i < list.length; i++) {
        var lines = String(list[i] == null ? '' : list[i]).split('\n');
        for (var j = 0; j < lines.length; j++) {
            var line = lines[j];
            if (line.indexOf(SIGNATURE_LINE_PREFIX) === 0) {
                var sig = line.substring(SIGNATURE_LINE_PREFIX.length).trim();
                if (sig) out.push(sig);
            }
        }
    }
    return out;
}

// ── excerpt trimming (pure) ──────────────────────────────────────────────

/**
 * The tail of a failed-step log: last maxLines lines (default 10), hard cap
 * EXCERPT_MAX_LINES, CRLF normalized, ANSI escapes stripped, trailing blank
 * lines dropped. Excerpt bytes are otherwise untouched — Actions masking
 * (`***`) survives verbatim.
 */
function trimLogExcerpt(logText, maxLines) {
    if (!logText) return '';
    var limit = (typeof maxLines === 'number' && maxLines > 0) ? maxLines : EXCERPT_DEFAULT_LINES;
    if (limit > EXCERPT_MAX_LINES) limit = EXCERPT_MAX_LINES;
    var lines = String(logText)
        .replace(/\r\n/g, '\n')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > limit) lines = lines.slice(lines.length - limit);
    return lines.join('\n');
}

// ── pre-flight state (pure builder + injected IO collector) ──────────────

/** dirty/staged counts default to 0 — an absent count is not a failure. */
function preflightCount(value) {
    return value == null ? 0 : value;
}

/**
 * The paths segment: ≤5 entries, shrunk further until the joined text fits
 * the char cap, with the dropped entries summarized as `+N more`.
 */
function preflightPathsSegment(allPaths) {
    var all = allPaths || [];
    var paths = all.slice(0, PREFLIGHT_PATH_COUNT);
    var extra = all.length - paths.length;
    var pathsText = paths.join(', ');
    while (pathsText.length > PREFLIGHT_MAX_PATHS_CHARS && paths.length > 1) {
        paths.pop();
        extra++;
        pathsText = paths.join(', ');
    }
    return { text: pathsText, extra: extra };
}

/**
 * The canonical leg-start line (format fixed by the ticket):
 *   git pre-flight: branch=<b> head=<sha> dirty=<n> staged=<n> paths=[≤5 + "+N more"]
 * Paths only, never file contents; the paths segment is length-capped.
 * No usable state (collection failed / detached junk) → null — the report
 * simply omits the line.
 */
function preflightLine(state) {
    if (!state || !state.branch || !state.head) return null;
    var paths = preflightPathsSegment(state.paths);
    var more = paths.extra > 0 ? ' +' + paths.extra + ' more' : '';
    return 'git pre-flight: branch=' + state.branch +
        ' head=' + state.head +
        ' dirty=' + preflightCount(state.dirty) +
        ' staged=' + preflightCount(state.staged) +
        ' paths=[' + paths.text + more + ']';
}

/** Flatten a command result (string, {output}, {stdout}) to plain text. */
function readCommandText(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return String(value.output || value.stdout || '');
    return value == null ? '' : String(value);
}

/**
 * One `git status --porcelain` entry → { staged, path }: staged when the
 * index column is set; quoted paths (special characters) unquoted.
 */
function parsePorcelainEntry(line) {
    var staged = line.charAt(0) !== ' ' && line.charAt(0) !== '?';
    var path = line.length > 3 ? line.substring(3) : '';
    if (path.charAt(0) === '"' && path.charAt(path.length - 1) === '"') {
        path = path.substring(1, path.length - 1);
    }
    return { staged: staged, path: path };
}

/**
 * Collect the pre-flight workspace state. `runCommand` is the injected git
 * transport (a `(command) → string|{output}` runner — the caller wraps
 * errors best-effort; this function throws raw).
 *   dirty  = every `git status --porcelain` entry (workspace not clean)
 *   staged = entries whose index column is set
 *   paths  = entry paths (paths only — never contents)
 */
function collectPreflightState(runCommand) {
    var branch = readCommandText(runCommand('git rev-parse --abbrev-ref HEAD')).trim();
    var head = readCommandText(runCommand('git rev-parse HEAD')).trim();
    var porcelain = readCommandText(runCommand('git status --porcelain')).replace(/\r\n/g, '\n');
    var lines = porcelain.split('\n');
    var paths = [];
    var dirty = 0;
    var staged = 0;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        dirty++;
        var entry = parsePorcelainEntry(line);
        if (entry.staged) staged++;
        if (entry.path) paths.push(entry.path);
    }
    return { branch: branch, head: head, dirty: dirty, staged: staged, paths: paths };
}

// ── report rendering (pure; flavor bag injected) ─────────────────────────

/** The pre-flight line section (absent state → nothing). */
function renderPreflightSection(m, p) {
    return p.preflightLine ? m.inline(p.preflightLine) + '\n' : '';
}

/** The run section: id + link when both, link alone, or the bare id. */
function renderRunSection(m, p) {
    if (!p.runId && !p.runUrl) return '';
    var runText;
    if (p.runUrl && p.runId) runText = p.runId + ' — ' + m.link('open run', p.runUrl);
    else if (p.runUrl) runText = m.link('open run', p.runUrl);
    else runText = String(p.runId);
    return m.bold('Run:') + ' ' + runText + '\n';
}

/** The bounded excerpt section (re-trimmed here — no caller can exceed the cap). */
function renderExcerptSection(m, p) {
    if (!p.excerpt) return '';
    var excerpt = trimLogExcerpt(p.excerpt, EXCERPT_MAX_LINES);
    if (!excerpt) return '';
    return '\n' + m.bold('Log excerpt (last ' + excerpt.split('\n').length + ' lines):') + '\n' +
        m.code(excerpt) + '\n';
}

/** The repeat section (unknown count → nothing — never guess). */
function renderRepeatSection(m, p) {
    var repeat = repeatPhrase(p.repeatCount);
    return repeat ? m.bold('Repeat:') + ' ' + repeat + '\n' : '';
}

/**
 * The enriched section block, rendered through a commentMarkup-style flavor
 * bag (m.bold/m.inline/m.code/m.link — commentMarkup.forTicket/forFlavor).
 * Absent optional fields are omitted — no empty section noise. Phase is the
 * only mandatory field (the failure site knows it; carry, don't infer).
 */
function renderReport(flavor, parts) {
    var p = parts || {};
    var m = flavor;
    return renderPreflightSection(m, p) +
        m.bold('Phase:') + ' ' + p.phase + '\n' +
        (p.step ? m.bold('Failing step:') + ' ' + p.step + '\n' : '') +
        renderRunSection(m, p) +
        renderExcerptSection(m, p) +
        renderRepeatSection(m, p) +
        (p.signature ? signatureLine(p.signature) + '\n' : '');
}

/**
 * The full workflow-side failure notice (markdown): one heading + the
 * enriched sections. `flavor` is required (commentMarkup.forFlavor('markdown')
 * at the notice call site, commentMarkup.forTicket(key, customParams) on the
 * ticket path) — the builder itself stays flavor-neutral and require-free.
 */
function buildFailureComment(parts, flavor) {
    var body = renderReport(flavor, parts);
    return '### 🤖 AI Teammate run failed' + (body ? '\n' + body : '');
}

/**
 * The historical bare-link line, byte-shape preserved (AC6 — success paths
 * keep exactly the old comment; nothing new is added on success).
 */
function outcomeLine(outcome, runUrl) {
    return '🤖 AI Teammate run ' + outcome + ': ' + (runUrl || '<run-url-unavailable>');
}

// ── run identity from the environment (injected reader) ──────────────────

/** Best-effort run URL from CI env vars; null off the runner (local runs). */
function runUrlFromEnv(readEnv) {
    try {
        var server = readEnv && readEnv('GITHUB_SERVER_URL');
        var repo = readEnv && readEnv('GITHUB_REPOSITORY');
        var runId = readEnv && readEnv('GITHUB_RUN_ID');
        if (server && repo && runId) {
            return String(server) + '/' + String(repo) + '/actions/runs/' + String(runId);
        }
    } catch (e) { /* env bridge unavailable — local run */ }
    return null;
}

/** Best-effort run id; null off the runner. */
function runIdFromEnv(readEnv) {
    try {
        var runId = readEnv && readEnv('GITHUB_RUN_ID');
        return runId ? String(runId) : null;
    } catch (e) { return null; }
}

module.exports = {
    normalizeSignature: normalizeSignature,
    failureSignature: failureSignature,
    consecutiveRepeatCount: consecutiveRepeatCount,
    repeatPhrase: repeatPhrase,
    signatureLine: signatureLine,
    parseSignatureLines: parseSignatureLines,
    trimLogExcerpt: trimLogExcerpt,
    preflightLine: preflightLine,
    collectPreflightState: collectPreflightState,
    renderReport: renderReport,
    buildFailureComment: buildFailureComment,
    outcomeLine: outcomeLine,
    runUrlFromEnv: runUrlFromEnv,
    runIdFromEnv: runIdFromEnv,
    EXCERPT_DEFAULT_LINES: EXCERPT_DEFAULT_LINES,
    EXCERPT_MAX_LINES: EXCERPT_MAX_LINES,
    SIGNATURE_LINE_PREFIX: SIGNATURE_LINE_PREFIX
};
