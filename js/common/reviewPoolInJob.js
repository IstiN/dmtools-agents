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
var COVERAGE_FILE_PREFIX = 'pr_review_coverage-';

/** 'first' on a clean review, 'hunks' on a re-review with new hunks. */
function roundTypeOf(roundCtx) {
    return roundCtx && roundCtx.hasNewHunks ? 'hunks' : 'first';
}

/**
 * The specialists for THIS round: enabled, scoped to the round type
 * (skill.rounds), and — when the skill declares triggerPaths — only if the
 * diff touches at least one of them (empty triggerPaths = always).
 */
/**
 * The §6 gating for ONE skill on this round: the posting reviewer never
 * runs as a specialist (its census is the aggregation target), disabled
 * reviewers are skipped, and the canonical reviewerShouldRun predicate
 * decides. In-job the state is per-run: this run IS the first pass at this
 * head (no cross-run memory), the hunks flags come from the round context.
 */
function specialistRunsOnRound(skill, roundCtx) {
    if (!skill || skill.isEnabled === false) return false;
    if (skill.name === 'base') return false;
    var state = {
        firstDone: false,
        hasNewHunks: !!(roundCtx && roundCtx.hasNewHunks),
        hunksHitTrigger: poolModule.triggerPathsHit(skill.triggerPaths,
            (roundCtx && roundCtx.newHunkPaths) || [])
    };
    return poolModule.reviewerShouldRun(skill, state);
}

function selectSpecialists(pool, roundCtx) {
    var reviewers = (pool && pool.reviewers) || [];
    var selected = [];
    for (var i = 0; i < reviewers.length; i++) {
        if (specialistRunsOnRound(reviewers[i], roundCtx)) selected.push(reviewers[i]);
    }
    return selected;
}

/**
 * The coverage-file contract (the gh-1471 incremental-review memory). Every
 * pass plans FIRST (covered=[], pending=<the full intended file list>) and
 * moves files pending → covered as it goes — a killed session leaves the
 * file behind, so the next pass continues where this one stopped (never a
 * permanent silent gap). The SKIP rule is machine-verified: a covered file
 * absent from the current hunks is unchanged since the previous pass.
 */
/**
 * The previous-pass memory block (rendered only when the coverage file
 * carried actual work): what was covered, what never finished, and the
 * SKIP/REVIEW rules that make the hunks file the machine-verified delta.
 */
function prevCoverageSection(prev) {
    return [
        '',
        '### Your previous pass (head ' + (prev.head || '?') + ')',
        '',
        '- Covered then: ' + (prev.covered.length > 0 ? prev.covered.map(function(p) { return '`' + p + '`'; }).join(', ') : '(none)'),
        '- Pending then (never finished): ' + (prev.pending.length > 0 ? prev.pending.map(function(p) { return '`' + p + '`'; }).join(', ') : '(none)'),
        '- SKIP the covered files that are NOT in the current hunks — they are',
        '  unchanged since your pass (machine-verified; the hunks file is the delta',
        '  since the last reviewed head).',
        '- REVIEW: every current-hunks path PLUS every still-pending file —',
        '  start with the pending ones, they are the oldest debt.'
    ];
}

function coverageSection(roundCtx, prev) {
    var head = String((roundCtx && roundCtx.headSha) || '');
    var lines = [
        '## Coverage file (the only thing that survives your session)',
        '',
        '- File: `' + coveragePathOf('__REVIEWER__') + '` — write it FIRST, before any review:',
        '  ```json',
        '  { "reviewer": "__REVIEWER__", "head": "' + head + '",',
        '    "covered": [],',
        '    "pending": ["<every repo file you plan to review>"],',
        '    "truncated": false, "at": "<iso timestamp>" }',
        '  ```',
        '- Move files `pending` → `covered` as you finish them (re-write the file).',
        '- NEAR THE CAP: set `"truncated": true` — unfinished files stay `pending`.'
    ];
    if (prev && (prev.covered.length > 0 || prev.pending.length > 0)) {
        lines = lines.concat(prevCoverageSection(prev));
    }
    return lines.join('\n');
}

/**
 * The specialist's prompt file content: identity + lens + the coverage-file
 * contract + the candidates contract + the termination rules. The lens/
 * contract paths are passed as REPO PATHS (the child reads them itself —
 * the content stays single-sourced in the pack).
 */
/**
 * The read-first + round-context block: the reference-pack line renders
 * only when the skill carries one, and the scope line flips on new hunks.
 */
function specialistContextLines(skill, roundCtx) {
    return [
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
            : '- first full review of the PR head')
    ];
}

function buildSpecialistPrompt(skill, roundCtx, prevCoverage) {
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
        ''
    ].concat(specialistContextLines(skill, roundCtx), [
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
        coverageSection(roundCtx, prevCoverage).split('__REVIEWER__').join(name),
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
    ]);
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
 * The PARALLEL batch: every specialist runs backgrounded inside one bash,
 * each under its own gh-75 cap; `wait` settles the batch; the OUTER timeout
 * caps the whole batch at the round budget. If the outer cap fires, the
 * in-flight children are orphaned but each self-terminates at its own
 * per-specialist cap — bounded by design. The candidates files are the only
 * round state: whoever wrote theirs before dying is in.
 *
 * The specialists are LM-bound sessions with per-reviewer files (no
 * collisions) — parallel is safe; the wall clock stops scaling with the
 * reviewer count (the gh-1471 in-job decision: one cli_execute_command per
 * round, bash-only sandbox).
 */
function buildBatchCommand(promptPaths, timeoutSeconds, budgetSeconds) {
    var t = parseInt(timeoutSeconds, 10);
    if (!(t > 0)) t = DEFAULT_SPECIALIST_TIMEOUT_SECONDS;
    var b = parseInt(budgetSeconds, 10);
    if (!(b > 0)) b = DEFAULT_ROUND_BUDGET_SECONDS;
    var inner = promptPaths.map(function(p) {
        return 'timeout -k 60 ' + t + ' bash ' + RUN_AGENT_REL + ' ' + p + ' &';
    }).join('\n') + '\nwait';
    return 'bash -c "timeout -k 60 ' + b + ' bash -c \'' + inner + '\'"';
}

/**
 * One specialist round — PARALLEL. io = { executeCommand, writeFile,
 * readFile, nowIso }. All prompts are written (each with its previous-pass
 * coverage memory), ONE composite command spawns every specialist
 * backgrounded, then the candidates files are read — whoever wrote a valid
 * same-head record is in; the rest are unavailable with per-specialist
 * reasons. Returns { completed, unavailable, candidates, results, command,
 * coverageNotes }.
 */
/**
 * The batch spawn + the killed-batch fail-open: a spawn-level failure
 * (the sandbox refused the invocation, the wrapper exploded) marks EVERY
 * spawned specialist unavailable — the coverage files still get read (a
 * killed batch may have left memory behind) and the prepped set empties.
 */
function spawnBatchOf(prepped, io, out, roundCtx) {
    if (prepped.length === 0) return;
    out.command = buildBatchCommand(
        prepped.map(function(p) { return p.base.promptPath; }),
        roundCtx && roundCtx.specialistTimeoutSeconds,
        roundCtx && roundCtx.roundBudgetSeconds);
    try {
        io.executeCommand(out.command);
        return;
    } catch (eSpawn) {
        for (var s = 0; s < prepped.length; s++) {
            var failed = fail(prepped[s].base, 'spawn failed: ' + (eSpawn.message || String(eSpawn)));
            out.results.push(failed);
            out.unavailable.push(prepped[s].skill.name);
            var note = coverageNoteOf(io, prepped[s].skill.name, failed);
            if (note) out.coverageNotes.push(note);
        }
        prepped.length = 0;
    }
}

function runSpecialists(io, pool, roundCtx) {
    var selected = selectSpecialists(pool, roundCtx);
    var out = { completed: [], unavailable: [], candidates: [], results: [],
        command: '', coverageNotes: [] };
    var prepped = [];
    for (var i = 0; i < selected.length; i++) {
        var prep = prepOneSpecialist(io, selected[i], roundCtx);
        if (!prep.base.ok) {
            out.results.push(prep.base);
            out.unavailable.push(selected[i].name);
            if (prep.coverageNote) out.coverageNotes.push(prep.coverageNote);
            continue;
        }
        prepped.push(prep);
    }
    spawnBatchOf(prepped, io, out, roundCtx);
    for (var j = 0; j < prepped.length; j++) {
        var outcome = readOneOutcome(io, prepped[j].skill, roundCtx, prepped[j].base);
        out.results.push(outcome.base);
        if (outcome.base.ok) {
            out.completed.push(prepped[j].skill.name);
            out.candidates.push(outcome.base.record);
        } else {
            out.unavailable.push(prepped[j].skill.name);
            if (outcome.coverageNote) out.coverageNotes.push(outcome.coverageNote);
        }
    }
    return out;
}

/** Prompt write + the previous-coverage read. A refusal (unsafe identifier)
 * is a result — the specialist never spawns. */
function prepOneSpecialist(io, skill, roundCtx) {
    var name = skill.name;
    var base = { reviewer: name, ok: false, reason: '', phase: 'prep' };
    var ticket = String((roundCtx && roundCtx.ticketKey) || '');
    if (!SAFE_IDENTIFIER_RE.test(name) || (ticket && !SAFE_IDENTIFIER_RE.test(ticket))) {
        return { base: fail(base, 'unsafe identifier — refusing to compose the spawn command') };
    }
    try {
        var prev = readCoverage(io, name);
        var promptPath = writePromptFile(io, skill, roundCtx, prev);
        base.promptPath = promptPath;
        base.ok = true;
        return { base: base, skill: skill };
    } catch (e) {
        return { base: fail(base, e.message || String(e)) };
    }
}

/** The post-session read: candidates schema + same-head + the coverage note
 * for a session that died without candidates but left memory behind. */
function readOneOutcome(io, skill, roundCtx, base) {
    var name = skill.name;
    var raw;
    try { raw = io.readFile(candidatesPathOf(name)); } catch (eRead) { raw = null; }
    if (!raw) {
        return { base: fail(base, 'no candidates file after the session'), coverageNote: coverageNoteOf(io, name, base) };
    }
    var record = null;
    try { record = candidatesModule.candidatesRecordFromPayload(JSON.parse(raw)); } catch (eParse) { record = null; }
    if (!record) {
        return { base: fail(base, 'invalid candidates record (reviewer/head/candidates required)'),
            coverageNote: coverageNoteOf(io, name, base) };
    }
    if (roundCtx.headSha && !reviewVerdicts.sameHead(record.head, roundCtx.headSha)) {
        return { base: fail(base, 'stale candidates (head ' + record.head + ' != ' + roundCtx.headSha + ')') };
    }
    record.reviewer = name;
    base.ok = true;
    base.record = record;
    return { base: base };
}

/** The killed-but-covered note: a session without candidates that left
 * coverage memory — the next pass continues it (never a silent gap). */
function coverageNoteOf(io, reviewer, base) {
    var cov = readCoverage(io, reviewer);
    if (!cov || (cov.covered.length === 0 && cov.pending.length === 0)) return null;
    return {
        reviewer: reviewer,
        text: 'no candidates — coverage memory persisted (' +
            'covered ' + cov.covered.length + ', pending ' + cov.pending.length +
            '); the next pass continues it'
    };
}

/** The prompt file: input/<ticket>/pool_specialist-<name>.md (or the
 * roundCtx override) — the coverage memory rides the prompt content. */
function writePromptFile(io, skill, roundCtx, prevCoverage) {
    var file = roundCtx.promptPathOf
        ? roundCtx.promptPathOf(skill)
        : 'input/' + (roundCtx.ticketKey || 'pool') + '/pool_specialist-' + skill.name + '.md';
    var written = io.writeFile(file, buildSpecialistPrompt(skill, roundCtx, prevCoverage));
    return written || file;
}

function fail(base, reason) {
    return Object.assign({}, base, { ok: false, reason: reason });
}

/**
 * One specialist's file-driven outcome classification: the candidates
 * payload parse, the record validation and the same-head check — with the
 * human-readable reason for every unavailable shape.
 */
function specialistOutcomeRecord(raw, roundCtx, name) {
    if (!raw) return { reason: 'no candidates file' };
    var record = null;
    try {
        record = candidatesModule.candidatesRecordFromPayload(JSON.parse(raw));
    } catch (eParse) {
        record = null;
    }
    if (!record) return { reason: 'invalid candidates record (reviewer/head/candidates required)' };
    // The original truth table: a missing round head is NOT a same-head
    // match either — the record classifies stale (the outcome consumer
    // always resolves the head first; the guard stays defensive).
    var sameHeadOk = record && roundCtx.headSha && reviewVerdicts.sameHead(record.head, roundCtx.headSha);
    if (!sameHeadOk) {
        return { reason: 'stale candidates (head ' + record.head + ')' };
    }
    record.reviewer = name;
    return { record: record };
}

function readSpecialistOutcomes(io, pool, roundCtx) {
    var selected = selectSpecialists(pool, roundCtx);
    var out = { completed: [], unavailable: [], candidates: [], results: [], coverageNotes: [] };
    for (var i = 0; i < selected.length; i++) {
        var name = selected[i].name;
        var raw = null;
        try {
            raw = io.readFile(candidatesPathOf(name));
        } catch (eRead) {
            raw = null;
        }
        var outcome = specialistOutcomeRecord(raw, roundCtx, name);
        if (outcome.record) {
            out.completed.push(name);
            out.candidates.push(outcome.record);
            out.results.push({ reviewer: name, ok: true });
        } else {
            out.unavailable.push(name);
            out.results.push({ reviewer: name, ok: false, reason: outcome.reason });
        }
        var cov = readCoverage(io, name);
        if (cov && (cov.covered.length > 0 || cov.pending.length > 0)) {
            out.coverageNotes.push({
                reviewer: name,
                text: 'no candidates — coverage memory persisted (covered ' +
                    cov.covered.length + ', pending ' + cov.pending.length +
                    '); the next pass continues it'
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

/** The per-reviewer coverage file — the ONLY thing that survives a killed
 * session: the next pass continues where this one stopped. */
function coveragePathOf(reviewer) {
    return 'outputs/' + COVERAGE_FILE_PREFIX + reviewer + '.json';
}

/**
 * The previous pass's coverage, shape-validated: {reviewer, head, covered[],
 * pending[], truncated, at}. Anything malformed (or another reviewer's file)
 * is NO memory — the pass starts blind (fail-open, same as the candidates).
 */
/** Shape validation for one parsed coverage payload: the reviewer must
 * match and both tracked lists must be arrays; anything else is NO memory. */
function coverageShapeOk(parsed, reviewer) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (String(parsed.reviewer || '') !== reviewer) return false;
    if (!Array.isArray(parsed.covered) || !Array.isArray(parsed.pending)) return false;
    return true;
}

function readCoverage(io, reviewer) {
    var raw;
    try {
        raw = io.readFile(coveragePathOf(reviewer));
    } catch (eRead) { return null; }
    if (!raw) return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (eParse) { return null; }
    if (!coverageShapeOk(parsed, reviewer)) return null;
    return {
        reviewer: reviewer,
        head: String(parsed.head || ''),
        covered: parsed.covered.map(function(p) { return String(p); }),
        pending: parsed.pending.map(function(p) { return String(p); }),
        truncated: parsed.truncated === true
    };
}

module.exports = {
    SAFE_IDENTIFIER_RE: SAFE_IDENTIFIER_RE,
    DEFAULT_ROUND_BUDGET_SECONDS: DEFAULT_ROUND_BUDGET_SECONDS,
    buildBatchCommand: buildBatchCommand,
    coveragePathOf: coveragePathOf,
    readCoverage: readCoverage,
    roundTypeOf: roundTypeOf,
    selectSpecialists: selectSpecialists,
    buildSpecialistPrompt: buildSpecialistPrompt,
    coverageSection: coverageSection,
    candidatesPathOf: candidatesPathOf,
    buildSpecialistCommand: buildSpecialistCommand,
    runSpecialists: runSpecialists,
    readSpecialistOutcomes: readSpecialistOutcomes,
    memoryIo: memoryIo,
    DEFAULT_SPECIALIST_TIMEOUT_SECONDS: DEFAULT_SPECIALIST_TIMEOUT_SECONDS
};
