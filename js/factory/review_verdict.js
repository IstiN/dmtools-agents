/**
 * Factory review verdict — the zero-maintainer keystone glue (owner
 * directive 2026-10-13: factory glue moves into dmtools-agents as JS agent
 * code; awf workflows become thin callers).
 *
 * JS port of the awf factory-teammate.yml step «Apply the review verdict
 * (review runs only)» — byte-extracted into scripts/apply-review-verdict.sh
 * by IstiN/dmtools-agentic-workflows#34. Behavior contract is identical:
 *
 *   1. GH_TOKEN missing → warn + skip (labels would not trigger workflows).
 *   2. Fallback sources: the issue's labels, the linked open PR (closes/
 *      fixes/resolves #N in the body, or headRefName ^N[-_.] / gh-0*N$),
 *      the PR's comments+reviews and the issue's comments (a failed fetch
 *      leaves the source file absent — the parser reports `missing`).
 *   3. machineAuthor: workflow input first, then the per-repo
 *      .dmtools/config.js knob (js/common/machineAuthor.js order #2).
 *   4. Parser selection: the unpacked pack's loop/verdict.sh WINS
 *      (versions with the reviewed pack); the legacy
 *      ${FACTORY_ROOT}/setup/review-verdict.sh is the old-pin fallback.
 *   5. The parser emits an eval-safe key=value contract (decision, source,
 *      override, blocking_markers, rounds_done, next_round, escalate,
 *      round_labels, diagnosis). JS parses it line-wise instead of eval'ing
 *      — conformant contracts parse identically; non-conformant output is
 *      IGNORED rather than executed (deliberate hardening, documented).
 *   6. rework + escalate → strip round labels, needs-human (B60205), the
 *      GraphQL review-threads summary comment, done. rework → remove
 *      needs-human, agent:rework + rework-round-N (BFD4F2). approve → the
 *      CI-green gate (≤10 min of 30s polls; red checks refuse the verdict;
 *      all-green → strip labels, pr_approved). No verdict at all → LOUD
 *      failure (gh-305): ::error:: annotation, needs-human, per-source
 *      diagnosis comment, THROW (the sh exits 1 — the step must redden).
 *
 * gh-1419 — machine verdict record primacy (the decision ladder): the
 * finisher's PRIMARY input is the machine verdict record — the
 * dmtools:review-verdict marker on the PR (head sha + effective verdict +
 * census), read through the same js/common/reviewVerdicts.js reader the SM
 * and the merge funnel use. The legacy token parser (run-output/comment
 * grep) is the FALLBACK only and may never override the marker:
 *   1. marker present for the PR's current head → its verdict governs; no
 *      downgrade in any case (the #1410 pathology — the finisher's gh-71
 *      `blocking === 0` heuristic downgraded a REQUEST_CHANGES the policy
 *      layer had already recomputed, and stamped pr_approved beside an
 *      armed agent:rework — is dead);
 *   2. marker absent (pre-gh-807 shapes, another head, untrusted author, no
 *      configured machine identity) → the legacy parser decides as before —
 *      but a REQUEST_CHANGES-class token result NEVER arms pr_approved: an
 *      approve contract carrying override=true (the gh-71 downgrade key
 *      un-upgraded packs still emit) classifies REWORK, and
 *      setup/review-verdict.sh — updated in the same commit, one source of
 *      truth (the JS is canonical; the sh is the fallback parser) — no
 *      longer downgrades at all;
 *   3. marker and legacy parser disagree → LOUD escalation (needs-human +
 *      diagnosis comment + THROW, the gh-305 "no verdict at all" treatment
 *      extended to contradictory verdict sources) — never a silent approve
 *      and never a silent rework.
 * Approve-with-suggestions stays available through reviewPolicy (preset
 * `relaxed` / the recompute layer's rework-tier-clean census rule) — the
 * finisher stops re-implementing policy. Round bookeeping (rounds_done /
 * next_round / escalate) comes from the parser's label census; when the
 * effective rework decision rides a contract computed under an approve
 * decision, the sh's cap rule is recomputed here so the round cap still
 * fires.
 *
 * Error contract mirrors the sh under `bash -e`: gh failures on the
 * load-bearing calls (pr list) propagate; tolerant calls keep the sh's
 * `|| true` / `|| echo ''` semantics (labels, comment sources, rollup,
 * label create, threads fetch).
 *
 * Env/file contract (the sh step's env block; the JSRunner entry reads
 * jobParams.customParams first, these env names as fallback):
 *   GH_TOKEN            presence gates the skip (gh reads it itself)
 *   NUMBER              the review issue
 *   RUN_OUTPUT          the leg's captured run output (default
 *                       .dmtools/run-output.txt)
 *   MACHINE_AUTHOR      workflow input; .dmtools/config.js knob fallback
 *   MAX_ROUNDS          the auto-rework cap (display + parser env)
 *   GITHUB_REPOSITORY   owner/repo
 *   CONFIG              runner config path (basename → pack agent)
 *   FACTORY_ROOT        legacy verdict parser root
 *   HOME                pack cache root (~/.dmtools/packs/…)
 *
 * Pure functions carry no IO: applyReviewVerdict takes { exec, writeFile,
 * readFile, tempFile, clock, sleepMs, log } capturers (factoryState.js
 * convention). exec results are unwrapped ((res.output || res.stdout) ||
 * res — the #893 review lesson); every interpolation goes through
 * shellQuote (token_usage.js); no global gh is touched (tests stub the
 * transport).
 */

var shellQuote = require('./token_usage.js').shellQuote;
// gh-1419: the machine verdict record is read through the same reader the
// SM and the merge funnel use (parseVerdictRecords / latestVerdictForHead),
// and the marker trust allowlist splits the gh-728 comma-list knob through
// machineAuthor.machineAuthorLogins. Both are pure js/common modules; the
// requires are hoisted (gh-823: load-time requires resolve file-relative).
var reviewVerdicts = require('../common/reviewVerdicts.js');
var machineAuthor = require('../common/machineAuthor.js');

var DEFAULT_RUN_OUTPUT = '.dmtools/run-output.txt';
var CI_POLL_MS = 30000;
var CI_DEADLINE_MS = 600000; // ≤10 min, the sh's SECONDS+600

var RED_CHECKS = 'FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE';
var GREEN_CHECKS = 'SUCCESS|SKIPPED|NEUTRAL';
// gh-1079: the per-poll rollup matchers, compiled once (the pre-refactor
// loop built these on every poll — same patterns, same anchors).
var RED_CHECK_RE = new RegExp('^(' + RED_CHECKS + ')$');
var GREEN_CHECK_RE = new RegExp('^(' + GREEN_CHECKS + ')$');

var THREADS_QUERY =
    'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name)' +
    '{pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved path line ' +
    'comments(first:1){nodes{body author{login}}}}}}}}';

var LABELS_JQ = '[.labels[].name] | join(" ")';
var PR_COMMENTS_JQ = '[(.comments // [])[] | {author: (.author.login // ""), body}] + [(.reviews // [])[] | {author: (.author.login // ""), body}]';
var ISSUE_COMMENTS_JQ = '[(.comments // [])[] | {author: (.author.login // ""), body}]';
var ROLLUP_JQ = '.statusCheckRollup[] | if .status and .status != "COMPLETED" then "PENDING" else (.conclusion // .state // "PENDING") end';

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parses the parser's eval-safe key=value contract. Line-wise; quoted
 * values keep inner spaces; non-conforming lines are IGNORED (never
 * evaluated — safer than the sh's eval, identical for conformant output).
 */
function parseVerdictContract(text) {
    var out = { decision: '', source: '', override: '', blocking_markers: '',
                rounds_done: 0, next_round: 0, escalate: false,
                round_labels: '', diagnosis: '' };
    var lines = String(text == null ? '' : text).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!m) continue;
        var v = m[2];
        if (v.length >= 2) {
            var q = v.charAt(0);
            if ((q === '"' || q === "'") && v.charAt(v.length - 1) === q) v = v.substring(1, v.length - 1);
        }
        out[m[1]] = v;
    }
    out.escalate = (out.escalate === true || out.escalate === 'true');
    out.rounds_done = parseInt(out.rounds_done, 10) || 0;
    out.next_round = parseInt(out.next_round, 10) || 0;
    return out;
}

/**
 * machineAuthor resolution order #2 (js/common/machineAuthor.js). NOTE
 * (gh-728): the knob became a comma-separated login list there
 * (`machineAuthor: "ai-teammate,github-actions[bot]"`), but this matcher —
 * deliberately mirroring the spec's `sed -nE` capture ([A-Za-z0-9._-]+,
 * closing quote right after) — resolves SINGLE-login values only; a
 * comma-list matches nothing and MACHINE_AUTHOR stays empty (only *[bot]
 * comment authors trusted). Parity holds by construction; route through
 * machineAuthorLogins-style parsing only if the spec itself is updated.
 */
function resolveMachineAuthor(machineAuthor, io) {
    if (machineAuthor) return machineAuthor;
    try {
        var cfg = io.readFile('.dmtools/config.js');
        if (cfg) {
            var lines = String(cfg).split('\n');
            for (var i = 0; i < lines.length; i++) {
                var m = lines[i].match(/machineAuthor["']?\s*:\s*["']([A-Za-z0-9._-]+)["']/);
                if (m) return m[1];
            }
        }
    } catch (e) { /* unreadable/absent — empty, only *[bot] authors trusted */ }
    return '';
}

/**
 * Parser selection: the unpacked pack's loop/verdict.sh wins (sort -V |
 * tail -1 over the pack cache glob); the legacy FACTORY_ROOT tree is the
 * old-pin fallback. Returns the path; logs the sh's verdict-logic line.
 */
function pickVerdictSh(opts, io) {
    var agent = basenameNoJson(opts.config);
    var glob = 'ls -1 ' + shellQuote(opts.home + '/.dmtools/packs/') + agent +
        '-*/loop/verdict.sh 2>/dev/null | sort -V | tail -1';
    var pack = '';
    try { pack = unwrap(io.exec('bash -c ' + shellQuote(glob))).trim(); } catch (e) { pack = ''; }
    if (pack) {
        io.log('→ verdict logic: pack ' + pack);
        return pack;
    }
    var legacy = (opts.factoryRoot || '') + '/setup/review-verdict.sh';
    io.log('→ verdict logic: legacy tree ' + legacy +
        ' (no ' + agent + ' pack loop/verdict.sh unpacked)');
    return legacy;
}

function basenameNoJson(p) {
    var b = String(p || '').split('/').pop();
    return b.replace(/\.json$/, '');
}

// ── gh-1419: machine verdict record primacy (pure helpers) ──────────────────

/**
 * Parses the machine verdict records out of the finisher's PR-comments
 * payload — the `gh pr view --json comments,reviews` jq shape flattens the
 * author to the login STRING, while the marker readers key authorship on
 * user|author objects (machineAuthor.commentAuthorLogin), so each item is
 * re-shaped before the shared parse. Probe/fetch failure (payload null,
 * unparseable, non-array) → [] — no marker, the legacy fallback decides.
 * The gh-728 allowlist gates trust: no configured machine identity → no
 * records (the machineAuthor doctrine — unconfigured trusts nothing).
 */
function markerRecordsFromPayload(payload, authorLogins) {
    if (!payload) return [];
    var list;
    try { list = JSON.parse(payload); } catch (e) { return []; }
    if (!Array.isArray(list)) return [];
    var normalized = [];
    for (var i = 0; i < list.length; i++) {
        var item = list[i] || {};
        var author = item.author;
        normalized.push({
            author: (author && typeof author === 'object') ? author : { login: String(author || '') },
            body: item.body
        });
    }
    try {
        return reviewVerdicts.parseVerdictRecords(normalized, { authorLogins: authorLogins || [] });
    } catch (e) { return []; }
}

/**
 * The newest marker record for the PR's current head, or null when the
 * head has none (another head, empty head probe) — the shared prefix-aware
 * head matching (sameHead) rides reviewVerdicts.latestVerdictForHead, the
 * exact read the SM's arming gate and the merge funnel make.
 */
function markerForHead(records, headSha) {
    var effective = reviewVerdicts.latestVerdictForHead(records || [], headSha);
    return effective ? effective.record : null;
}

/** APPROVE rides the approve path; REQUEST_CHANGES/BLOCK ride rework. */
function verdictClassOfVerdict(verdict) {
    return String(verdict || '').toUpperCase() === 'APPROVE' ? 'approve' : 'rework';
}

/**
 * The legacy parser's verdict class from its contract, or null when it
 * found no verdict. The `override` key IS the gh-71 downgrade (REQUEST_
 * CHANGES downgraded by zero blocking) — it classifies REWORK, so the
 * heuristic can never reach applyApproveVerdict as approve (gh-1419 AC2).
 */
function parserVerdictClassOf(contract) {
    var decision = String((contract && contract.decision) || '');
    if (decision === 'approve') {
        var override = contract && contract.override;
        return (override === true || override === 'true') ? 'rework' : 'approve';
    }
    return decision === 'rework' ? 'rework' : null;
}

/**
 * The effective decision per the gh-1419 ladder (pure): the marker for the
 * current head governs; the parser is the fallback and the cross-check.
 * Returns { decision, source, marker } — or { conflict: { marker,
 * parserClass, parserSource, parserOverride } } when the two trusted
 * sources disagree (contradictory verdict sources → loud escalation).
 */
function resolveEffectiveDecision(marker, contract) {
    var markerClass = marker ? verdictClassOfVerdict(marker.verdict) : null;
    var parserClass = parserVerdictClassOf(contract);
    if (markerClass && parserClass && markerClass !== parserClass) {
        return { conflict: {
            marker: marker,
            parserClass: parserClass,
            parserSource: String((contract && contract.source) || 'none'),
            parserOverride: String((contract && contract.override) || 'false')
        } };
    }
    if (markerClass) {
        return { decision: markerClass, source: 'machine-verdict-marker', marker: marker };
    }
    return { decision: parserClass || 'unknown', source: 'legacy-parser', marker: null };
}

/**
 * The sh's round-cap rule recomputed over a contract that was computed
 * under a non-rework decision (the gh-71 downgrade path, or no verdict at
 * all): the sh advances next_round / sets escalate only under its own
 * `decision=rework`, so a marker-governed (or override-neutralized) rework
 * recomputes it here — the cap still fires instead of re-arming the same
 * round forever. Garbage maxRounds rides the sh default 2.
 */
function reworkRoundBookeeping(contract, maxRounds) {
    var roundsDone = parseInt(contract.rounds_done, 10) || 0;
    var cap = parseInt(maxRounds, 10);
    if (isNaN(cap)) cap = 2;
    if (roundsDone >= cap) {
        contract.escalate = true;
        contract.next_round = roundsDone;
    } else {
        contract.escalate = false;
        contract.next_round = roundsDone + 1;
    }
}

/** The pure conflicting-verdicts diagnosis comment body (gh-1419). */
function buildConflictingVerdictsComment(conflict) {
    var m = conflict.marker;
    var census = 'blocking=' + reviewVerdicts.censusCount(m.blocking) +
        ', important=' + reviewVerdicts.censusCount(m.important) +
        ', suggestions=' + reviewVerdicts.censusCount(m.suggestions);
    return [
        '🛑 **Contradictory review verdicts** — the machine verdict record and the legacy verdict parser disagree, so the review cycle cannot be labeled (gh-1419).',
        '',
        '- Machine verdict record (primary): **' + m.verdict + '** on head `' + String(m.head).substring(0, 12) +
            '` — census ' + census + ' (at ' + (m.at || 'unknown time') + ', source: ' + m.source + ')',
        '- Legacy parser (fallback): **' + (conflict.parserClass === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES-class') +
            '** (source: ' + conflict.parserSource + ', override: ' + conflict.parserOverride + ')',
        '',
        'The machine marker governs by default (gh-1419) — a disagreement means one of the two sources is stale or forged, and neither a silent approve nor a silent rework is acceptable.',
        '',
        '_Next step (human):_ reconcile the two sources above, then label `pr_approved` (approve) or `agent:rework` (changes requested) — or re-label `agent:review` for a fresh review leg.'
    ].join('\n') + '\n';
}

// ── orchestration (capturer-injected) ────────────────────────────────────────

/** The entry's exec unwrap (no trim: body/file paths ride verbatim).
 * An exec result object with EMPTY output is an empty output — not the
 * object itself (the pilot's `(res.output || res.stdout) || res` stringified
 * the object to '[object Object]', which the parity harness caught as the
 * verdict-logic path). */
function unwrap(res) {
    var out = res && (res.output || res.stdout);
    if (out === undefined || out === null) out = (typeof res === 'string') ? res : '';
    return String(out || '');
}

/**
 * Apply the review verdict. See the header for opts/io and the statuses:
 * no-token | rework | escalated | approved | approve-no-pr | ci-red |
 * ci-timeout; throws on the loud no-verdict path (exit-1 parity).
 */
// ── gh-1079: applyReviewVerdict decomposed into single-purpose helpers ───────
// Behavior contract is unchanged (the characterization suite in
// test_factoryReviewVerdict.js + the sh-parity harness pin every branch);
// this only splits the former 39-complexity monolith along its existing
// seams: entry guards, the fallback-source fetch prologue, the parser probe,
// and one handler per verdict outcome (rework / escalated / missing /
// approve). Every exec, writeFile and log call keeps its original position
// in the sequence — the parity harness byte-compares the transport.

function tryExec(io, cmd, fallback) {
    try { return unwrap(io.exec(cmd)); } catch (e) { return fallback; }
}

// The sh's load-bearing-call contract: the token gate precedes everything,
// the numeric-NUMBER guard precedes any gh call (the raw jq-splice guard).
function entryGuard(opts, io) {
    var log = io.log || function () {};
    if (!opts.ghToken) {
        log('::warning::SOURCE_GITHUB_TOKEN not set — verdict labels would not trigger workflows; skipping (a maintainer must label manually)');
        return { status: 'no-token' };
    }
    // `number` is spliced INSIDE the single-quoted pr-list jq program (the
    // sh's '"$NUMBER"' splice) — the one interpolation that cannot go
    // through shellQuote. A non-numeric value would break out of the shell
    // string at the argv level; fail loud instead of exec-weird (the sh
    // dies under bash -e on the same condition — the loud-fail contract).
    if (!/^\d+$/.test(String(opts.number))) {
        throw new Error('review verdict: NUMBER must be numeric, got: ' + opts.number);
    }
    return null;
}

// Verdict fallback sources beyond the run output (gh-305): a failed
// fetch leaves the file absent — the parser reports `missing`.
// Call order is load-bearing: labels → pr list → pr comments → issue
// comments → machineAuthor (.dmtools/config.js read) → parser selection.
function buildReviewContext(opts, io) {
    var q = shellQuote;
    var log = io.log || function () {};
    var repo = opts.repo;
    var number = opts.number;

    var labels = tryExec(io, 'gh issue view ' + q(number) + ' --repo ' + q(repo) +
        " --json labels --jq '" + LABELS_JQ + "'", '');
    var pr = unwrap(io.exec(
        'gh pr list --repo ' + q(repo) + ' --state open ' +
        "--json number,body,headRefName --jq '\n" +
        "      [.[] | select(\n" +
        // argv must carry DOUBLE backslashes exactly like the sh's
        // double-quoted jq program — real gh's jq treats a lone \s as an
        // invalid string escape and the compile error silently empties
        // find_linked_pr (caught by the sh-parity harness).
        '          ((.body // "") | test("(?i)\\\\b(closes|fixes|resolves)\\\\s+#' + number + '\\\\b"))\n' +
        '          or (.headRefName | test("^' + number + '[-_.]"))\n' +
        '          or (.headRefName | test("(^|[-_./])gh-0*' + number + '$")))\n' +
        "        | .number] | first // empty'")).trim();

    var prCommentsPath = io.tempFile('pr_comments.json');
    var issueCommentsPath = io.tempFile('issue_comments.json');
    // gh-1419: the raw payload also feeds the machine-marker read (in
    // memory — the file staging is the legacy parser's contract).
    var prCommentsPayload = '';
    if (pr) {
        var pc = tryExec(io, 'gh pr view ' + q(pr) + ' --repo ' + q(repo) +
            " --json comments,reviews --jq '" + PR_COMMENTS_JQ + "'", null);
        if (pc !== null) {
            prCommentsPayload = pc;
            io.writeFile(prCommentsPath, pc);
        }
    }
    var ic = tryExec(io, 'gh issue view ' + q(number) + ' --repo ' + q(repo) +
        " --json comments --jq '" + ISSUE_COMMENTS_JQ + "'", null);
    if (ic !== null) io.writeFile(issueCommentsPath, ic);

    var machineAuthor = resolveMachineAuthor(opts.machineAuthor, io);
    var verdictSh = pickVerdictSh(opts, io);

    return {
        log: log,
        repo: repo,
        number: number,
        labels: labels,
        pr: pr,
        prCommentsPath: prCommentsPath,
        prCommentsPayload: prCommentsPayload,
        issueCommentsPath: issueCommentsPath,
        machineAuthor: machineAuthor,
        verdictSh: verdictSh
    };
}

// The sh runs the probe as `eval "$(VERDICT_SH decide)"` — a failing
// substitution yields NO output (its rc is swallowed), the contract
// vars stay unset → decision=unknown → the loud diagnosis path. Keep
// that: probe failure is 'unknown', not a transport abort.
function verdictParserCommand(opts, ctx) {
    var q = shellQuote;
    return 'MAX_ROUNDS=' + q(String(opts.maxRounds === undefined ? '' : opts.maxRounds)) +
        ' PR_REVIEW_JSON=' + q('outputs/pr_review.json') +
        ' PR_REVIEW_JSON_ALT=' + q('outputs/gh-' + ctx.number + '/pr_review.json') +
        ' RUN_OUTPUT=' + q(opts.runOutput || DEFAULT_RUN_OUTPUT) +
        ' PR_COMMENTS_JSON=' + q(ctx.prCommentsPath) +
        ' ISSUE_COMMENTS_JSON=' + q(ctx.issueCommentsPath) +
        ' MACHINE_AUTHOR=' + q(ctx.machineAuthor) +
        ' ISSUE_LABELS=' + q(ctx.labels) +
        ' bash ' + q(ctx.verdictSh) + ' decide';
}

function probeVerdictContract(opts, io, ctx) {
    var probeOut = '';
    try {
        probeOut = unwrap(io.exec(verdictParserCommand(opts, ctx)));
    } catch (e) {
        probeOut = '';
    }
    var contract = parseVerdictContract(probeOut);
    return {
        contract: contract,
        decision: contract.decision || 'unknown'
    };
}

function logDecisionLine(log, probed) {
    var contract = probed.contract;
    log('→ review decision: ' + probed.decision + ' (source=' + (contract.source || 'none') +
        ', override=' + (contract.override || 'false') + ', rounds_done=' + contract.rounds_done + ')');
}

// gh-1419: the machine verdict record probe — parse the trusted markers out
// of the PR-comments payload, and only when one exists probe the PR's head
// sha (lazy: no records → no probe, the transport stays in the parity
// shape for pre-marker PRs) and take the newest record for THIS head. No
// configured machine identity → no trusted records at all.
function probeMachineVerdictMarker(opts, io, ctx) {
    var logins = machineAuthor.machineAuthorLogins(ctx.machineAuthor);
    ctx.headSha = '';
    ctx.marker = null;
    if (!logins.length) return null;
    var records = markerRecordsFromPayload(ctx.prCommentsPayload, logins);
    if (!records.length) return null;
    var headSha = ctx.pr ? headShaOf(io, opts.repo, ctx.pr) : '';
    ctx.headSha = headSha;
    ctx.marker = markerForHead(records, headSha);
    if (ctx.marker) {
        ctx.log('→ machine verdict record: ' + ctx.marker.verdict + ' on head ' +
            String(headSha).substring(0, 8) + ' (blocking=' +
            reviewVerdicts.censusCount(ctx.marker.blocking) + ', important=' +
            reviewVerdicts.censusCount(ctx.marker.important) + ', source=' + ctx.marker.source + ')');
    }
    return ctx.marker;
}

// ── label/comment primitives (were applyReviewVerdict closures) ─────────────

function stripRoundLabels(io, ctx) {
    var lbls = String(ctx.contract.round_labels || '').split(/\s+/);
    for (var i = 0; i < lbls.length; i++) {
        if (!lbls[i]) continue;
        tryExec(io, 'gh issue edit ' + shellQuote(ctx.number) + ' --repo ' + shellQuote(ctx.repo) +
            ' --remove-label ' + shellQuote(lbls[i]), '');
    }
}

function ensureLabel(io, ctx, name, color) {
    try { io.exec('gh label create ' + shellQuote(name) + ' --repo ' + shellQuote(ctx.repo) +
        ' --color ' + shellQuote(color) + ' --force'); } catch (e) { /* idempotent */ }
}

function addLabel(io, ctx, name) {
    io.exec('gh issue edit ' + shellQuote(ctx.number) + ' --repo ' + shellQuote(ctx.repo) +
        ' --add-label ' + shellQuote(name));
}

function removeNeedsHumanQuietly(io, ctx) {
    tryExec(io, 'gh issue edit ' + shellQuote(ctx.number) + ' --repo ' + shellQuote(ctx.repo) +
        " --remove-label 'needs-human'", '');
}

function postIssueComment(io, ctx, body) {
    var p = io.tempFile('comment.md');
    io.writeFile(p, body);
    io.exec('gh issue comment ' + shellQuote(ctx.number) + ' --repo ' + shellQuote(ctx.repo) +
        ' --body-file ' + shellQuote(p));
}

// ── pure comment bodies (byte-exact, pinned by the unit + parity suites) ────

function buildEscalationCommentBody(roundsDone, maxRounds, pr, threadSummary) {
    var lines = [
        '🛑 **Auto-rework loop capped** — ' + roundsDone + ' automatic rework rounds without an APPROVE verdict (cap: ' + (maxRounds === undefined ? '' : maxRounds) + '). The machine stopped labeling `agent:rework`.',
        ''
    ];
    if (pr) {
        lines.push('### Unresolved review threads on PR #' + pr, '');
        if (threadSummary) lines.push(threadSummary);
        lines.push('');
        lines.push('_If no threads are listed, the findings live in the PR general comments._');
    } else {
        lines.push('_No linked open PR found for this issue._');
    }
    lines.push('');
    lines.push('**Next step (human):** fix the remaining findings directly and re-label `agent:review` for a fresh review — or re-label `agent:rework` to re-arm the agent loop with a fresh round cap.');
    return lines.join('\n') + '\n';
}

function buildNoVerdictComment(diagnosis) {
    return [
        '🛑 **Review verdict missing** — the review leg finished, but no verdict (APPROVE / REQUEST_CHANGES / BLOCK) was found in any source, so the cycle cannot be labeled.',
        '',
        'Per-source diagnosis: `' + (diagnosis || 'n/a') + '`',
        '',
        "_Next step (human):_ read the review leg's run output, then label `pr_approved` (approve) or `agent:rework` (changes requested) — or re-run the review leg."
    ].join('\n') + '\n';
}

// ── one handler per verdict outcome ─────────────────────────────────────────

function applyEscalatedVerdict(opts, io, ctx) {
    var contract = ctx.contract;
    stripRoundLabels(io, ctx);
    ensureLabel(io, ctx, 'needs-human', 'B60205');
    addLabel(io, ctx, 'needs-human');
    var threadSummary = '';
    if (ctx.pr) {
        var owner = ctx.repo.split('/')[0];
        var name = ctx.repo.split('/')[1];
        var threadsPath = io.tempFile('threads.json');
        // the sh: `if gh api graphql …; then summary=$(render); else
        // warn; fi` — the renderer runs ONLY on fetch success and its
        // own failure aborts (unguarded under bash -e). Keep both.
        var gqlOk = true;
        try {
            io.writeFile(threadsPath, unwrap(io.exec(
                'gh api graphql -f query=' + shellQuote(THREADS_QUERY) +
                ' -f owner=' + shellQuote(owner) + ' -f name=' + shellQuote(name) +
                ' -F number=' + shellQuote(ctx.pr))));
        } catch (e) {
            gqlOk = false;
            ctx.log('::warning::reviewThreads fetch failed — the findings live in the PR review comments');
        }
        if (gqlOk) {
            // sh: summary="$(bash …)" — command substitution strips
            // ALL trailing newlines; the raw exec keeps them.
            threadSummary = unwrap(io.exec(
                'bash ' + shellQuote(ctx.verdictSh) + ' threads ' + shellQuote(threadsPath)))
                .replace(/\n+$/, '');
        }
    }
    postIssueComment(io, ctx, buildEscalationCommentBody(contract.rounds_done, opts.maxRounds, ctx.pr, threadSummary));
    ctx.log('→ labeled needs-human — auto-rework capped after ' + contract.rounds_done + ' round(s)');
    return { status: 'escalated', decision: ctx.decision, pr: ctx.pr, roundsDone: contract.rounds_done };
}

function applyPlainReworkVerdict(opts, io, ctx) {
    var nextRound = ctx.contract.next_round;
    // agent:rework FIRST (ordering is load-bearing: the round-label
    // event must not outrank the rework queue label), then the counter.
    removeNeedsHumanQuietly(io, ctx);
    stripRoundLabels(io, ctx);
    addLabel(io, ctx, 'agent:rework');
    ensureLabel(io, ctx, 'rework-round-' + nextRound, 'BFD4F2');
    addLabel(io, ctx, 'rework-round-' + nextRound);
    ctx.log('→ labeled agent:rework (round ' + nextRound + '/' + (opts.maxRounds === undefined ? '' : opts.maxRounds) + ') — rework run queued (re-review follows automatically)');
    return { status: 'rework', decision: ctx.decision, pr: ctx.pr, nextRound: nextRound };
}

function applyReworkVerdict(opts, io, ctx) {
    if (!ctx.contract.escalate) return applyPlainReworkVerdict(opts, io, ctx);
    return applyEscalatedVerdict(opts, io, ctx);
}

// gh-305: fail LOUDLY and leave a diagnosable marker (the sh exits 1).
function applyMissingVerdict(io, ctx) {
    ctx.log('::error::no verdict found in any source (pr_review.json / run output / PR comments / issue comments) — the review cycle cannot be labeled (gh-305)');
    ctx.log('→ diagnosis: ' + (ctx.contract.diagnosis || 'none'));
    ensureLabel(io, ctx, 'needs-human', 'B60205');
    addLabel(io, ctx, 'needs-human');
    postIssueComment(io, ctx, buildNoVerdictComment(ctx.contract.diagnosis));
    throw new Error('review verdict missing — needs-human left behind, the cycle is stranded (gh-305; the sh exits 1)');
}

// gh-1419: the gh-305 loud treatment extended to CONTRADICTORY verdict
// sources — the machine marker and the legacy parser disagree, so neither
// a silent approve nor a silent rework is allowed (exit nonzero).
function applyConflictingVerdicts(opts, io, ctx) {
    var conflict = ctx.conflict;
    ctx.log('::error::contradictory verdict sources — machine marker ' + conflict.marker.verdict +
        ' vs legacy parser ' + conflict.parserClass + ' — the review cycle cannot be labeled (gh-1419)');
    ensureLabel(io, ctx, 'needs-human', 'B60205');
    addLabel(io, ctx, 'needs-human');
    postIssueComment(io, ctx, buildConflictingVerdictsComment(conflict));
    ctx.log('→ labeled needs-human — contradictory verdict sources need a human (gh-1419)');
    throw new Error('contradictory review verdicts (machine marker vs legacy parser) — needs-human left behind, the cycle is stranded (gh-1419)');
}

// One rollup snapshot → 'green' | 'red' | 'pending' (empty lines skipped;
// any red conclusion refuses the whole verdict).
function assessRollup(states, pr, log) {
    if (!states) return 'pending';
    var arr = states.split('\n');
    var allGreen = true;
    for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (!s) continue;
        if (RED_CHECK_RE.test(s)) {
            log('::warning::PR #' + pr + ' checks FAILED — verdict not trusted, no label (a fresh dev/rework round must fix CI first)');
            return 'red';
        }
        if (!GREEN_CHECK_RE.test(s)) allGreen = false;
    }
    if (allGreen) {
        log('→ PR #' + pr + ' checks green');
        return 'green';
    }
    return 'pending';
}

function nowMs(io) {
    return (io.clock ? io.clock() : new Date()).getTime();
}

// Polls the rollup until green / red / the 10-min deadline. Returns the
// terminal result object, or null when the checks went green (the caller
// then labels pr_approved).
function waitForGreenChecks(io, ctx) {
    var deadline = nowMs(io) + CI_DEADLINE_MS;
    for (;;) {
        var states = tryExec(io, 'gh pr view ' + shellQuote(ctx.pr) + ' --repo ' + shellQuote(ctx.repo) +
            " --json statusCheckRollup --jq '" + ROLLUP_JQ + "'", '');
        var assessment = assessRollup(states, ctx.pr, ctx.log);
        if (assessment === 'red') return { status: 'ci-red', decision: ctx.decision, pr: ctx.pr };
        if (assessment === 'green') break;
        if (nowMs(io) >= deadline) {
            ctx.log('::warning::PR #' + ctx.pr + ' checks still pending after 10 min — skipping pr_approved (re-label or re-run to retry)');
            return { status: 'ci-timeout', decision: ctx.decision, pr: ctx.pr };
        }
        if (io.sleepMs) io.sleepMs(CI_POLL_MS);
    }
    return null;
}

function applyApproveVerdict(opts, io, ctx) {
    ctx.log('→ review verdict: approve');
    if (!ctx.pr) {
        ctx.log('::warning::APPROVE verdict but no linked open PR for #' + ctx.number + ' — skipping pr_approved');
        return { status: 'approve-no-pr', decision: ctx.decision };
    }
    ctx.log('→ linked PR #' + ctx.pr + ' — waiting for green checks (≤10 min)');
    var wait = waitForGreenChecks(io, ctx);
    if (wait) return wait;
    stripRoundLabels(io, ctx);
    removeNeedsHumanQuietly(io, ctx);
    addLabel(io, ctx, 'pr_approved');
    ctx.log('→ labeled pr_approved — merge-trigger will squash-merge PR #' + ctx.pr + ' once CLEAN');
    var kicked = kickSmOnGreenHead(opts, io, ctx.pr);
    return { status: 'approved', decision: ctx.decision, pr: ctx.pr, smKicked: kicked };
}

/**
 * Apply the review verdict. See the header for opts/io and the statuses:
 * no-token | rework | escalated | approved | approve-no-pr | ci-red |
 * ci-timeout; throws on the loud no-verdict and contradictory-verdict
 * paths (exit-1 parity).
 */
function applyReviewVerdict(opts, io) {
    opts = opts || {};
    io = io || {};
    var blocked = entryGuard(opts, io);
    if (blocked) return blocked;
    var ctx = buildReviewContext(opts, io);
    var probed = probeVerdictContract(opts, io, ctx);
    ctx.contract = probed.contract;
    // gh-1419: the machine marker governs; the legacy parser is the
    // fallback and the cross-check.
    probeMachineVerdictMarker(opts, io, ctx);
    var resolved = resolveEffectiveDecision(ctx.marker, ctx.contract);
    if (resolved.conflict) {
        ctx.conflict = resolved.conflict;
        return applyConflictingVerdicts(opts, io, ctx);
    }
    if (resolved.decision === 'rework' && String(ctx.contract.decision || '') !== 'rework') {
        // The sh computes its round cap only under its own rework decision —
        // a marker-governed (or override-neutralized) rework recomputes it.
        reworkRoundBookeeping(ctx.contract, opts.maxRounds);
    }
    ctx.decision = resolved.decision;
    ctx.verdictSource = resolved.source;
    logDecisionLine(ctx.log, { contract: ctx.contract, decision: ctx.decision });
    if (ctx.decision === 'rework') return applyReworkVerdict(opts, io, ctx);
    if (ctx.decision !== 'approve') return applyMissingVerdict(io, ctx);
    return applyApproveVerdict(opts, io, ctx);
}

// ── gh-1101: kick one SM tick on approval when the head is already green ──
// Live dart #435: approved at 14:04 on a head whose dispatched CI run had
// concluded green at 13:57 — the merge waited on cron. When the current
// head carries a completed-green dispatched CI run, order ONE SM tick now,
// deduped against an SM run already queued/in_progress (factory-sm-kicker
// sm-liveness parity). Best-effort: every probe failure means no kick.

var SM_LIVE_JQ = '[.[] | select(.status == "queued" or .status == "in_progress")] | length';
var GREEN_RUNS_JQ = '[.workflow_runs[] | select(.status == "completed" and .conclusion == "success")] | length';

function smKickEnabled(opts) {
    return String(opts.smKick === undefined ? 'true' : opts.smKick) !== 'false';
}

function execCount(io, cmd) {
    try { return parseInt(String(unwrap(io.exec(cmd))).trim(), 10) || 0; } catch (e) { return -1; }
}

function headShaOf(io, repo, pr) {
    try {
        return String(unwrap(io.exec('gh pr view ' + shellQuote(pr) + ' --repo ' + shellQuote(repo) +
            " --json headRefOid --jq '.headRefOid'"))).trim();
    } catch (e) { return ''; }
}

function headHasGreenRun(io, repo, ciWorkflow, sha) {
    return execCount(io, 'gh api ' + shellQuote('repos/' + repo + '/actions/workflows/' + ciWorkflow +
        '/runs?head_sha=' + sha + '&event=workflow_dispatch&per_page=5') +
        ' --jq ' + shellQuote(GREEN_RUNS_JQ)) > 0;
}

function smRunLive(io, repo, smWorkflow) {
    // -1 (probe failure) counts as live: never risk a duplicate tick.
    return execCount(io, 'gh run list --repo ' + shellQuote(repo) + ' --workflow ' +
        shellQuote(smWorkflow) + ' --limit 20 --json status --jq ' + shellQuote(SM_LIVE_JQ)) !== 0;
}

function greenHeadSha(opts, io, pr) {
    var sha = headShaOf(io, opts.repo, pr);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return '';
    return headHasGreenRun(io, opts.repo, opts.ciWorkflow || 'quality.yml', sha) ? sha : '';
}

function dispatchSmTick(io, repo, smWorkflow, log) {
    try {
        io.exec('gh workflow run ' + shellQuote(smWorkflow) + ' --repo ' + shellQuote(repo));
        return true;
    } catch (e) {
        log('::warning::SM tick dispatch failed: ' + (e && e.message || e));
        return false;
    }
}

function kickSmOnGreenHead(opts, io, pr) {
    if (!smKickEnabled(opts)) return false;
    var log = io.log || function () {};
    var sha = greenHeadSha(opts, io, pr);
    if (!sha) return false;
    var smWorkflow = opts.smWorkflow || 'machine-sm.yml';
    if (smRunLive(io, opts.repo, smWorkflow)) {
        log('→ head ' + sha.slice(0, 8) + ' already green; SM tick already queued/running — no kick');
        return false;
    }
    if (!dispatchSmTick(io, opts.repo, smWorkflow, log)) return false;
    log('→ head ' + sha.slice(0, 8) + ' already green — dispatched one SM tick (' + smWorkflow + ') to merge now');
    return true;
}

module.exports = {
    applyReviewVerdict: applyReviewVerdict,
    kickSmOnGreenHead: kickSmOnGreenHead,
    DEFAULT_RUN_OUTPUT: DEFAULT_RUN_OUTPUT,
    parseVerdictContract: parseVerdictContract,
    resolveMachineAuthor: resolveMachineAuthor,
    pickVerdictSh: pickVerdictSh,
    unwrap: unwrap,
    entryGuard: entryGuard,
    tryExec: tryExec,
    buildReviewContext: buildReviewContext,
    verdictParserCommand: verdictParserCommand,
    probeVerdictContract: probeVerdictContract,
    logDecisionLine: logDecisionLine,
    markerRecordsFromPayload: markerRecordsFromPayload,
    markerForHead: markerForHead,
    verdictClassOfVerdict: verdictClassOfVerdict,
    parserVerdictClassOf: parserVerdictClassOf,
    resolveEffectiveDecision: resolveEffectiveDecision,
    reworkRoundBookeeping: reworkRoundBookeeping,
    buildConflictingVerdictsComment: buildConflictingVerdictsComment,
    applyConflictingVerdicts: applyConflictingVerdicts,
    probeMachineVerdictMarker: probeMachineVerdictMarker,
    stripRoundLabels: stripRoundLabels,
    ensureLabel: ensureLabel,
    addLabel: addLabel,
    removeNeedsHumanQuietly: removeNeedsHumanQuietly,
    postIssueComment: postIssueComment,
    buildEscalationCommentBody: buildEscalationCommentBody,
    buildNoVerdictComment: buildNoVerdictComment,
    applyReworkVerdict: applyReworkVerdict,
    applyEscalatedVerdict: applyEscalatedVerdict,
    applyPlainReworkVerdict: applyPlainReworkVerdict,
    applyMissingVerdict: applyMissingVerdict,
    applyApproveVerdict: applyApproveVerdict,
    assessRollup: assessRollup,
    waitForGreenChecks: waitForGreenChecks,
    nowMs: nowMs
};
