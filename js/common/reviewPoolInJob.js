/**
 * reviewPoolInJob.js — the gh-1471 round executor, in-job shape (the redesign
 * of the fire-and-forget leg dispatcher).
 *
 * The pool round runs INSIDE the single review job: the pre-cli action
 * executes each specialist as a bounded child agent session
 * (`bash agents/scripts/run-agent.sh <prompt-file>` under `timeout -k 60 N` — the
 * gh-775 shape; `bash` is already whitelisted via CLI_ALLOWED_COMMANDS, no
 * new entry). Each specialist writes a candidates FILE
 * (`outputs/pr_review_candidates-<reviewer>.json`, the exact
 * candidatesRecordFromPayload schema) — no PR-comment markers, no cross-run
 * identity patches, no poll/wait: the round state is per-run by
 * construction.
 *
 * Fail-open end to end: a specialist that times out, crashes or writes an
 * invalid/stale file is `unavailable` for the round and the aggregation
 * proceeds with whoever completed (§4 of the base contract). The posting
 * leg stamps the specialists' PASS markers itself (single writer — the
 * gh-1406 merge gate keeps its same-head PASS semantics untouched).
 *
 * Round semantics (the in-job decision): the round state is PER-RUN — every
 * review run re-executes its selected specialists and re-stamps their
 * markers on the current head. The §6 PASS-marker state machine
 * (roundsDecide/reviewerShouldRun's cross-run memory) is superseded here:
 * with the specialists in-process there is no cross-run dispatch to dedupe,
 * and the merge gate reads only the CURRENT head's markers.
 *
 * io injection (the reviewPoolPost house style): every environment touch —
 * process spawn, file io, clock — rides the io object, so the module stays
 * unit-testable without a runner.
 */

var candidatesModule = require('./reviewPoolCandidates.js');
var poolModule = require('./reviewPool.js');
var reviewPolicy = require('./reviewPolicy.js');
var reviewVerdicts = require('./reviewVerdicts.js');

var RUN_AGENT_REL = 'agents/scripts/run-agent.sh';
var SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var DEFAULT_SPECIALIST_TIMEOUT_SECONDS = 900;
var DEFAULT_ROUND_BUDGET_SECONDS = 180;
var CANDIDATES_FILE_PREFIX = 'pr_review_candidates-';

/** 'first' on a clean review, 'hunks' on a re-review with new hunks. */
function roundTypeOf(roundCtx) {
    return roundCtx && roundCtx.hasNewHunks ? 'hunks' : 'first';
}

/**
 * The specialists for THIS round: enabled, scoped to the round type
 * (skill.rounds), and — when the skill declares triggerPaths — only if the
 * diff touches at least one of them (empty triggerPaths = always).
 */
function selectSpecialists(pool, roundCtx) {
    var round = roundTypeOf(roundCtx);
    var paths = (roundCtx && roundCtx.newHunkPaths) || [];
    var reviewers = (pool && pool.reviewers) || [];
    var selected = [];
    for (var i = 0; i < reviewers.length; i++) {
        var skill = reviewers[i];
        if (!skill || skill.isEnabled === false) continue;
        // The posting reviewer IS the main review session — it never runs as
        // a specialist (its census is the aggregation target, not a candidate).
        if (skill.name === 'base') continue;
        // The canonical §6 gating (reviewPool.js reviewerShouldRun) — one
        // semantics for every engine that evaluates a pool config. In-job the
        // state is per-run: this run IS the first pass at this head (no
        // cross-run memory), the hunks flags come from the round context.
        var state = {
            firstDone: false,
            hasNewHunks: !!(roundCtx && roundCtx.hasNewHunks),
            hunksHitTrigger: poolModule.triggerPathsHit(skill.triggerPaths,
                (roundCtx && roundCtx.newHunkPaths) || [])
        };
        if (!poolModule.reviewerShouldRun(skill, state)) continue;
        selected.push(skill);
    }
    return selected;
}

/**
 * The specialist's prompt file content: identity + lens + the candidates
 * contract + the termination rules. The lens/contract paths are passed as
 * REPO PATHS (the child reads them itself — the content stays single-sourced
 * in the pack).
 */
function buildSpecialistPrompt(skill, roundCtx) {
    var name = skill.name;
    var lines = [
        '# Reviewer pool specialist — ' + name + ' (in-job round)',
        '',
        'Role: ' + (skill.roleLine || ('Specialized reviewer — ' + name)) + '.',
        'You are ONE lens of a multi-reviewer pool. A separate aggregation step',
        'merges your candidates with the other reviewers\' — you write NOTHING to',
        'the pull request itself: no comments, no reviews, no labels.',
        '',
        '## Read first',
        '',
        '- Lens: `agents/' + (skill.lens || '') + '`',
        (skill.options && skill.options.referencePack
            ? '- Reference pack: `agents/' + skill.options.referencePack + '`\n'
            : '') +
        '- Candidates contract: `agents/instructions/pr_review/base/output_rules.md`',
        '  (the candidates-only output section — your ONLY output)',
        '- Diff under review: `input/' + (roundCtx.ticketKey || '') + '/pr_new_hunks.txt` —',
        '  AUTHORITATIVE and pre-verified by the machine: review its content as',
        '  given (the repo checkout provides the surrounding files)',
        '',
        '## Round context',
        '',
        '- round: `' + roundTypeOf(roundCtx) + '`',
        '- head sha (mandatory in the output): `' + (roundCtx.headSha || '') + '`',
        (roundCtx.hasNewHunks
            ? '- re-review with new hunks; scope your findings to the hunks\' paths'
            : '- first full review of the PR head'),
        '',
        '## Time-box (hard)',
        '',
        '- This session is capped at 15 minutes. A session without the',
        '  candidates file on disk when the cap hits is discarded as',
        '  unavailable — the round proceeds without it.',
        '- The diff file above is the ENTIRE scope: read it once, read the',
        '  touched repo files as needed, then WRITE the candidates file.',
        '- Do not audit the surrounding machinery (the pool, the runner, the',
        '  docs) — your lens applies to the PR\'s code changes only.',
        '- Write the candidates file EARLY: an empty valid file beats a',
        '  brilliant analysis that never lands.',
        '- INCREMENTAL WRITES: as soon as you have your first finding, write',
        '  the candidates file — then re-write it as you find more. The',
        '  runner reads the file\'s LAST state after your session ends, so',
        '  whatever landed on disk before the cap IS the round\'s result.',
        '- NEAR THE CAP: write immediately what you managed to review and set',
        '  `"truncated": true` — a partial honest record is a valid result;',
        '  silence is not. Do not pad to seem complete.',
        '',
        '## Output contract (strict)',
        '',
        'Write EXACTLY ONE file: `' + candidatesPathOf(name) + '` with this JSON shape:',
        '',
        '```json',
        '{',
        '  "reviewer": "' + name + '",',
        '  "head": "<the head sha above>",',
        '  "candidates": [ { "severity": "...", "path": "...", "line": 0,',
        '                    "body": "...", "claim": "..." } ],',
        '  "count": 0,',
        '  "truncated": false,',
        '  "at": "<iso timestamp>"',
        '}',
        '```',
        '',
        '- `severity` uses the lens\' allowed tiers (skill mayRaise: ' +
            JSON.stringify(skill.mayRaise || []) + ').',
        '- Empty `candidates` is a valid result (say nothing rather than pad).',
        '- When done, STOP. No summary prose, no side effects.'
    ];
    return lines.join('\n');
}

function candidatesPathOf(reviewer) {
    return 'outputs/' + CANDIDATES_FILE_PREFIX + reviewer + '.json';
}

/** The gh-775 bounded-invocation shape (TERM at N, KILL 60s later). */
function buildSpecialistCommand(promptPath, timeoutSeconds) {
    var inner = 'bash ' + RUN_AGENT_REL + ' ' + promptPath;
    var t = parseInt(timeoutSeconds, 10);
    if (!(t > 0)) t = DEFAULT_SPECIALIST_TIMEOUT_SECONDS;
    return 'bash -c "timeout -k 60 ' + t + ' ' + inner + '"';
}

/**
 * One specialist round. io = { executeCommand, writeFile, readFile, nowIso }.
 * Returns { completed, unavailable, candidates, results } where candidates
 * are validated candidatesRecordFromPayload records (same-head enforced —
 * a stale file is the reviewer being unavailable for THIS head).
 */
function runSpecialists(io, pool, roundCtx) {
    var selected = selectSpecialists(pool, roundCtx);
    var out = { completed: [], unavailable: [], candidates: [], results: [] };
    // The round-level wall-clock budget (the security-lens CWE-400
    // hardening): N sequential specialists x the per-specialist cap can
    // otherwise park the review lane for hours on a wide pool. Past the
    // budget the remaining specialists are not STARTED — they are
    // unavailable for the round (fail-open, same as a timeout).
    var budgetMs = (parseInt(roundCtx && roundCtx.roundBudgetSeconds, 10) > 0
        ? parseInt(roundCtx.roundBudgetSeconds, 10) : DEFAULT_ROUND_BUDGET_SECONDS) * 1000;
    var roundStart = clockMs(io);
    for (var i = 0; i < selected.length; i++) {
        var skill = selected[i];
        if (i > 0 && clockMs(io) - roundStart >= budgetMs) {
            var skipped = { reviewer: skill.name, ok: false,
                reason: 'round budget exhausted after ' + Math.round((clockMs(io) - roundStart) / 1000) +
                    's — the specialist was not started (fail-open)' };
            out.results.push(skipped);
            out.unavailable.push(skill.name);
            continue;
        }
        var record = runOneSpecialist(io, skill, roundCtx);
        out.results.push(record);
        if (record.ok) {
            out.completed.push(skill.name);
            out.candidates.push(record.record);
        } else {
            out.unavailable.push(skill.name);
        }
    }
    return out;
}

/** The io clock in ms (io.nowIso is the house clock — ISO strings). */
function clockMs(io) {
    var t = io && typeof io.nowIso === 'function' ? Date.parse(io.nowIso()) : NaN;
    return isNaN(t) ? Date.now() : t;
}

function runOneSpecialist(io, skill, roundCtx) {
    var name = skill.name;
    var base = { reviewer: name, ok: false, reason: '' };
    // Defense-in-depth past the schema guard: the identifiers compose the
    // spawn command string — refuse to build it from anything but path
    // atoms (the ticket key rides the job context, not the schema).
    var ticket = String((roundCtx && roundCtx.ticketKey) || '');
    if (!SAFE_IDENTIFIER_RE.test(name) || (ticket && !SAFE_IDENTIFIER_RE.test(ticket))) {
        return fail(base, 'unsafe identifier — refusing to compose the spawn command');
    }
    try {
        var promptPath = writePromptFile(io, skill, roundCtx);
        base.promptPath = promptPath;
        var command = buildSpecialistCommand(promptPath, roundCtx.specialistTimeoutSeconds);
        base.command = command;
        io.executeCommand(command);
        var raw = io.readFile(candidatesPathOf(name));
        if (!raw) return fail(base, 'no candidates file after the session');
        var parsed = JSON.parse(raw);
        var record = candidatesModule.candidatesRecordFromPayload(parsed);
        if (!record) return fail(base, 'invalid candidates record (reviewer/head/candidates required)');
        if (roundCtx.headSha && !reviewVerdicts.sameHead(record.head, roundCtx.headSha)) {
            return fail(base, 'stale candidates (head ' + record.head + ' != ' + roundCtx.headSha + ')');
        }
        record.reviewer = name;
        return Object.assign({}, base, { ok: true, record: record });
    } catch (e) {
        return fail(base, e.message || String(e));
    }
}

function writePromptFile(io, skill, roundCtx) {
    var file = roundCtx.promptPathOf
        ? roundCtx.promptPathOf(skill)
        : 'input/' + (roundCtx.ticketKey || 'pool') + '/pool_specialist-' + skill.name + '.md';
    var written = io.writeFile(file, buildSpecialistPrompt(skill, roundCtx));
    return written || file;
}

function fail(base, reason) {
    return Object.assign({}, base, { ok: false, reason: reason });
}

/**
 * The post action's view of the round: recompute the selection (the same
 * deterministic selectSpecialists the pre-cli runner used) and read each
 * specialist's candidates FILE — completed = a valid same-head record,
 * unavailable = everything else (timeout, crash, invalid, stale). No
 * execution, no markers — files are the only round state.
 */
function readSpecialistOutcomes(io, pool, roundCtx) {
    var selected = selectSpecialists(pool, roundCtx);
    var out = { completed: [], unavailable: [], candidates: [], results: [] };
    for (var i = 0; i < selected.length; i++) {
        var name = selected[i].name;
        var raw = null;
        try {
            raw = io.readFile(candidatesPathOf(name));
        } catch (eRead) {
            raw = null;
        }
        var record = null;
        if (raw) {
            try {
                record = candidatesModule.candidatesRecordFromPayload(JSON.parse(raw));
            } catch (eParse) {
                record = null;
            }
        }
        var sameHeadOk = record && roundCtx.headSha && reviewVerdicts.sameHead(record.head, roundCtx.headSha);
        if (record && sameHeadOk) {
            record.reviewer = name;
            out.completed.push(name);
            out.candidates.push(record);
            out.results.push({ reviewer: name, ok: true });
        } else {
            out.unavailable.push(name);
            out.results.push({
                reviewer: name,
                ok: false,
                reason: !raw ? 'no candidates file'
                    : !record ? 'invalid candidates record'
                        : 'stale candidates (head ' + (record && record.head) + ')'
            });
        }
    }
    return out;
}

/**
 * Node-fs io adapter for local runs/tests; CI actions inject their own
 * (cli_execute_command-backed) io instead.
 */
/**
 * A minimal in-memory io for tests/local probes (no node builtins at module
 * scope — the runner sandboxes resolve requires strictly). CI actions
 * inject their own (cli_execute_command + outputFiles-backed) io instead.
 */
function memoryIo(seedFiles, executor) {
    var files = seedFiles || {};
    return {
        files: files,
        executeCommand: executor || function() {},
        writeFile: function(p, content) { files[p] = String(content); },
        readFile: function(p) {
            return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
        },
        nowIso: function() { return new Date().toISOString(); }
    };
}

module.exports = {
    SAFE_IDENTIFIER_RE: SAFE_IDENTIFIER_RE,
    DEFAULT_ROUND_BUDGET_SECONDS: DEFAULT_ROUND_BUDGET_SECONDS,
    roundTypeOf: roundTypeOf,
    selectSpecialists: selectSpecialists,
    buildSpecialistPrompt: buildSpecialistPrompt,
    candidatesPathOf: candidatesPathOf,
    buildSpecialistCommand: buildSpecialistCommand,
    runSpecialists: runSpecialists,
    readSpecialistOutcomes: readSpecialistOutcomes,
    memoryIo: memoryIo,
    DEFAULT_SPECIALIST_TIMEOUT_SECONDS: DEFAULT_SPECIALIST_TIMEOUT_SECONDS
};
