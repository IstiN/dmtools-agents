/**
 * legStartSignal.js — the leg-start phase signal builder (gh-1364).
 *
 * A dev leg answers, machine-readably, the question "can agent legs currently
 * start work on this main SHA?". In the 2026-11-04 outage every leg died in
 * the setup phase, but the only way to know ALL failures were setup-phase was
 * to open run logs by hand. Every leg already crosses the setup boundary —
 * now it emits the signal there:
 *
 *   1. ALWAYS one summary line in the leg log at the setup boundary:
 *        `leg-start: ok (branch <name>)`  — setup crossed, the dev branch is ready
 *        `leg-start: failed (<reason-class>: <first error line>)` — setup died
 *   2. BEST-EFFORT commit status on the head SHA the leg ran against:
 *        `leg-start/ok`     (state success, description: branch name)
 *        `leg-start/failed` (state failure, description: reason class)
 *   3. Reason classes are a CLOSED set, not free text:
 *        `git-state` — dirty/untracked workspace blocking checkout
 *        `checkout`  — ref/fetch problems (pathspec, missing remote ref, …)
 *        `config`    — invalid customParams/config/hook wiring
 *        `other`     — anything else (e.g. environment setup commands)
 *
 * Acting on the signal (gating dispatch, parking) is OUT of scope — the
 * analyzer/SM policy reads it; this module only emits.
 *
 * Structure (mirrors legFailureReport.js):
 *   - every function is PURE — GraalJS-clean (var + plain functions),
 *     JSON-safe data, zero requires;
 *   - the summary-line and status formats are FIXED here in one place; the
 *     wiring (js/preCliDevelopmentSetup.js) injects all IO: git probes,
 *     env reads and the `github_create_commit_status` call, wrapped
 *     best-effort — a status posting failure must never fail the leg;
 *   - the classifier matches lowercase substrings on a deterministic
 *     precedence: git-state → checkout → config → other (a message that
 *     mentions checkout in a git-state phrase classifies git-state; a path
 *     merely named config.js in a pathspec error classifies checkout).
 */

'use strict';

/** The closed reason-class set (order = classification precedence). */
var REASON_CLASSES = ['git-state', 'checkout', 'config', 'other'];

var STATUS_CONTEXT_OK = 'leg-start/ok';
var STATUS_CONTEXT_FAILED = 'leg-start/failed';
/** GitHub commit-status API hard cap on the description field. */
var STATUS_DESCRIPTION_MAX = 140;
/** Log/status noise guard on the carried error detail. */
var MAX_ERROR_LINE_CHARS = 200;

// Lowercase substrings per reason class — matched in REASON_CLASSES order.
var CLASS_PATTERNS = {
    'git-state': [
        'would be overwritten',
        'local changes',
        'untracked working tree',
        'stash them before'
    ],
    'checkout': [
        'pathspec',
        'did not match any',
        'remote ref',
        "couldn't find remote",
        'ambiguous argument',
        'reference is not a tree',
        'cannot lock ref',
        'not a git repository',
        'unknown revision',
        'unable to access',
        'could not read from remote',
        'rpc failed',
        'authentication failed',
        'connection closed by',
        'repository not found',
        'is not a commit',
        'cannot be created from'
    ],
    'config': [
        'customparams',
        'configloader',
        'invalid config',
        'failed to load config',
        'fnpath',
        'failed to require module',
        'failed to parse',
        'unexpected token',
        'unexpected identifier'
    ]
};

function matchesClass(errorText, patterns) {
    var lowered = String(errorText == null ? '' : errorText).toLowerCase();
    for (var i = 0; i < patterns.length; i++) {
        if (lowered.indexOf(patterns[i]) !== -1) return true;
    }
    return false;
}

/**
 * Classify a caught setup error into the closed reason-class set. The first
 * class whose pattern matches wins (REASON_CLASSES order = precedence); an
 * unknown/absent error is 'other' — never a guess outside the set.
 */
function classifySetupError(errorText) {
    for (var i = 0; i < REASON_CLASSES.length; i++) {
        var reasonClass = REASON_CLASSES[i];
        if (reasonClass !== 'other' && matchesClass(errorText, CLASS_PATTERNS[reasonClass])) {
            return reasonClass;
        }
    }
    return 'other';
}

/** Cap text at maxChars (status/log field guards). */
function capText(text, maxChars) {
    return text.length > maxChars ? text.substring(0, maxChars) : text;
}

/**
 * The first non-empty line of an error text (CRLF normalized, trimmed,
 * length-capped) — the `<first error line>` of the failed summary line.
 */
function firstErrorLine(errorText) {
    var lines = String(errorText == null ? '' : errorText).replace(/\r\n/g, '\n').split('\n');
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line) return capText(line, MAX_ERROR_LINE_CHARS);
    }
    return '';
}

/** `leg-start: ok (branch <name>)` — format fixed by the ticket. */
function okSummaryLine(branchName) {
    return 'leg-start: ok (branch ' + String(branchName == null ? '' : branchName) + ')';
}

/**
 * `leg-start: failed (<reason-class>: <first error line>)` — format fixed by
 * the ticket. An error with no usable line degrades to a placeholder instead
 * of a dangling `(: )`.
 */
function failedSummaryLine(reasonClass, errorText) {
    var detail = firstErrorLine(errorText) || 'error unavailable';
    return 'leg-start: failed (' + String(reasonClass == null ? '' : reasonClass) + ': ' + detail + ')';
}

/**
 * The `github_create_commit_status` payload for the signal. ok →
 * leg-start/ok (success, description: branch name); otherwise →
 * leg-start/failed (failure, description: reason class). target_url is set
 * only when a run URL exists; description is capped at the API limit.
 */
function buildCommitStatusArgs(parts) {
    var p = parts || {};
    var ok = p.ok === true;
    var description = ok ? String(p.branchName == null ? '' : p.branchName) : String(p.reasonClass == null ? '' : p.reasonClass);
    var args = {
        workspace: p.workspace,
        repository: p.repository,
        sha: p.sha,
        state: ok ? 'success' : 'failure',
        context: ok ? STATUS_CONTEXT_OK : STATUS_CONTEXT_FAILED,
        description: capText(description, STATUS_DESCRIPTION_MAX)
    };
    if (p.runUrl) args.targetUrl = String(p.runUrl);
    return args;
}

/**
 * Head-SHA shape guard for the leg-start commit status (gh-1364 rework): a
 * full or abbreviated (7..40 chars) hex token — the forms `git rev-parse`
 * answers. Null/absent/garbage is invalid, so the status stays log-only
 * instead of posting against a made-up ref.
 */
function isValidHeadSha(sha) {
    return /^[0-9a-f]{7,40}$/i.test(String(sha == null ? '' : sha));
}

/**
 * The pure guard chain of the leg-start commit-status posting (gh-1364
 * rework — extracted from postLegStartStatusBestEffort so the wiring keeps a
 * small posting path). `provider` is the RESOLVED tracker provider name
 * ('github' | 'jira' | 'ado' | …); building the tracker is IO and stays in
 * the wiring. Returns:
 *   { skip: true, warn: '…' } — posting skipped; `warn` is the reason only
 *                               when the skip is unexpected noise (a
 *                               non-github tracker is the normal case and
 *                               stays silent)
 *   { workspace, repository } — the posting coordinates from config
 */
function resolveLegStartStatusTarget(config, provider) {
    if (!config) {
        return { skip: true, warn: 'leg-start commit status skipped: no config (line stays log-only)' };
    }
    if (String(provider) !== 'github') return { skip: true };
    var repository = config.repository || {};
    if (!(repository.owner && repository.repo)) {
        return { skip: true, warn: 'leg-start commit status skipped: no repository scope in config' };
    }
    return { workspace: repository.owner, repository: repository.repo };
}

module.exports = {
    classifySetupError: classifySetupError,
    firstErrorLine: firstErrorLine,
    okSummaryLine: okSummaryLine,
    failedSummaryLine: failedSummaryLine,
    buildCommitStatusArgs: buildCommitStatusArgs,
    isValidHeadSha: isValidHeadSha,
    resolveLegStartStatusTarget: resolveLegStartStatusTarget,
    REASON_CLASSES: REASON_CLASSES,
    STATUS_CONTEXT_OK: STATUS_CONTEXT_OK,
    STATUS_CONTEXT_FAILED: STATUS_CONTEXT_FAILED,
    STATUS_DESCRIPTION_MAX: STATUS_DESCRIPTION_MAX
};
