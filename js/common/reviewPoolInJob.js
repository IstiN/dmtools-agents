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
var DEFAULT_SPECIALIST_TIMEOUT_SECONDS = 900;
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
    for (var i = 0; i < selected.length; i++) {
        var skill = selected[i];
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

function runOneSpecialist(io, skill, roundCtx) {
    var name = skill.name;
    var base = { reviewer: name, ok: false, reason: '' };
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
